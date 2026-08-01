/**
 * Request execution.
 *
 * This runs on the server, which is what buys arbitrary headers, no CORS, real connection
 * timing, and secrets that never reach the browser. Redirects are followed manually so the
 * full hop chain can be shown, and so credentials can be dropped when a redirect crosses an
 * origin — a silent auth leak that most clients hide.
 */
import dns from 'dns';
import { Agent, buildConnector, request as undiciRequest } from 'undici';
import { buildBody, isTextualContentType } from './bodies.js';
import { applyAuth } from './auth.js';
import { interpolate, interpolateDeep, maskDeep, maskText } from '../vars.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

/** Header values that are credentials by nature — masked regardless of variable origin. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'api-key',
]);

/**
 * Execute a request definition.
 *
 * @returns {Promise<object>} a run record: resolved request, response, timing, redirect chain,
 *   and warnings. Values are raw (unmasked) — callers must sanitiseRun() before storing or
 *   returning them.
 */
export async function executeRequest(def, options = {}) {
  const {
    scope = new Map(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    dispatcher = null,
    signal = null,
  } = options;

  const startedAt = Date.now();
  const warnings = [];
  const missing = new Set();

  const varErrors = new Set();

  const collect = (result) => {
    result.missing.forEach((k) => missing.add(k));
    (result.errors ?? []).forEach((e) => varErrors.add(e));
    return result;
  };

  /* ---- resolve ------------------------------------------------- */

  const rawUrl = collect(interpolate(def.url ?? '', scope)).text.trim();
  if (!rawUrl) throw new HttpRequestError('No URL set for this request.');

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpRequestError(
      `"${rawUrl}" is not a valid URL. Include the scheme, e.g. https://api.example.com.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpRequestError(`Unsupported scheme "${url.protocol}" — use http or https.`);
  }

  for (const param of def.params ?? []) {
    if (!param.key || param.enabled === false) continue;
    url.searchParams.append(
      collect(interpolate(param.key, scope)).text,
      collect(interpolate(param.value ?? '', scope)).text,
    );
  }

  const headers = new Headers();
  for (const header of def.headers ?? []) {
    if (!header.key || header.enabled === false) continue;
    const name = collect(interpolate(header.key, scope)).text;
    const value = collect(interpolate(header.value ?? '', scope)).text;
    try {
      headers.set(name, value);
    } catch {
      // Deliberately does not echo the resolved name: it may have come from a secret
      // variable, and an error message is not a place a secret may surface.
      throw new HttpRequestError(
        'A request header is not valid. Header names cannot contain spaces or separators, ' +
          'and values cannot contain newlines.',
      );
    }
  }

  const resolvedBodyDef = collect(interpolateDeep(def.body ?? { type: 'none' }, scope)).value;
  const { payload, contentType, warnings: bodyWarnings } = buildBody(resolvedBodyDef);
  warnings.push(...bodyWarnings);
  if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);

  const resolvedAuth = collect(interpolateDeep(def.auth ?? { type: 'none' }, scope)).value;
  let authResult;
  try {
    authResult = await applyAuth(resolvedAuth, headers, url);
  } catch (err) {
    if (err instanceof HttpRequestError) throw err;
    throw new HttpRequestError(`Could not apply authentication: ${err.message}`, err);
  }
  warnings.push(...authResult.warnings);

  for (const err of varErrors) {
    warnings.push(`Variable could not be decrypted — ${err}`);
  }

  if (missing.size) {
    warnings.push(
      `Unresolved variable${missing.size > 1 ? 's' : ''}: ${[...missing].join(', ')}. ` +
        'The placeholder was sent literally.',
    );
  }

  const method = (def.method ?? 'GET').toUpperCase();

  /* ---- send, following redirects by hand ----------------------- */

  const redirects = [];
  const firstHopHeaders = new Headers(headers);
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = payload;
  let currentHeaders = headers;
  let response = null;

  for (let hop = 0; ; hop += 1) {
    response = await sendOnce({
      url: currentUrl,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
      timeoutMs,
      maxBodyBytes,
      dispatcher,
      signal,
    });

    const location = response.headers['location'];
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) break;

    if (hop >= maxRedirects) {
      warnings.push(`Stopped after ${maxRedirects} redirects.`);
      break;
    }

    let next;
    try {
      next = new URL(location, currentUrl);
    } catch {
      warnings.push(`Redirect target "${location}" is not a valid URL — stopping here.`);
      break;
    }

    redirects.push({
      from: currentUrl.toString(),
      to: next.toString(),
      status: response.status,
      method: currentMethod,
      timing: response.timing,
    });

    // Cross-origin redirect: drop credentials rather than forward them to a new host.
    if (next.origin !== currentUrl.origin) {
      const dropped = [...currentHeaders.keys()].filter((k) => SENSITIVE_HEADERS.has(k));
      if (dropped.length) {
        currentHeaders = new Headers(currentHeaders);
        dropped.forEach((k) => currentHeaders.delete(k));
        warnings.push(
          `Redirect crossed from ${currentUrl.origin} to ${next.origin}; dropped ` +
            `${dropped.join(', ')} so credentials are not sent to another host.`,
        );
      }
    }

    // 303, and 301/302 on POST, become GET without a body — matching browser behaviour.
    if (
      response.status === 303 ||
      (currentMethod === 'POST' && [301, 302].includes(response.status))
    ) {
      currentMethod = 'GET';
      currentBody = undefined;
      currentHeaders = new Headers(currentHeaders);
      currentHeaders.delete('content-type');
      currentHeaders.delete('content-length');
    }

    currentUrl = next;
  }

  return {
    startedAt,
    request: {
      method,
      url: url.toString(),
      // The headers actually sent on the first hop — kept consistent with url and body.
      // Credentials may have been dropped later, which finalRequest reflects.
      headers: headersToObject(firstHopHeaders),
      body: describeSentBody(resolvedBodyDef, payload),
    },
    finalRequest: {
      method: currentMethod,
      url: currentUrl.toString(),
      headers: headersToObject(currentHeaders),
    },
    response,
    redirects,
    timing: response.timing,
    warnings,
    missingVariables: [...missing],
  };
}

/* ---------------------------------------------------------------- *
 * One hop
 * ---------------------------------------------------------------- */

async function sendOnce({
  url,
  method,
  headers,
  body,
  timeoutMs,
  maxBodyBytes,
  dispatcher,
  signal,
}) {
  const timing = { dnsMs: null, connectMs: null, ttfbMs: null, downloadMs: null, totalMs: 0 };
  const t0 = performance.now();

  // A per-request agent instruments the connection phases. Callers doing repeated timing
  // (the latency suite) pass a shared dispatcher instead and accept reused connections.
  const agent = dispatcher ?? instrumentedAgent(timing, timeoutMs);

  let res;
  try {
    res = await undiciRequest(url, {
      method,
      headers: headersToObject(headers),
      body,
      dispatcher: agent,
      maxRedirections: 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal,
    });
  } catch (err) {
    if (!dispatcher) await agent.close().catch(() => {});
    throw translateNetworkError(err, url, timeoutMs);
  }

  timing.ttfbMs = round(performance.now() - t0);

  const { bytes, truncated } = await readCapped(res.body, maxBodyBytes);
  timing.downloadMs = round(performance.now() - t0 - timing.ttfbMs);
  timing.totalMs = round(performance.now() - t0);
  if (!dispatcher) await agent.close().catch(() => {});

  const responseHeaders = normaliseHeaders(res.headers);
  const contentType = responseHeaders['content-type'] ?? null;
  const textual = isTextualContentType(contentType);

  return {
    status: res.statusCode,
    statusText: statusText(res.statusCode),
    headers: responseHeaders,
    cookies: parseSetCookies(res.headers['set-cookie']),
    body: textual ? bytes.toString('utf8') : bytes.toString('base64'),
    bodyEncoding: textual ? 'utf8' : 'base64',
    sizeBytes: bytes.length,
    truncated,
    timing,
  };
}

function instrumentedAgent(timing, timeoutMs) {
  const baseConnect = buildConnector({ timeout: timeoutMs });

  return new Agent({
    connections: 1,
    pipelining: 0,
    connect(opts, callback) {
      const connectStart = performance.now();

      const lookup = (hostname, lookupOpts, cb) => {
        const dnsStart = performance.now();
        dns.lookup(hostname, lookupOpts, (...args) => {
          timing.dnsMs = round(performance.now() - dnsStart);
          cb(...args);
        });
      };

      baseConnect({ ...opts, lookup }, (err, socket) => {
        // Covers DNS + TCP + TLS; the DNS slice is subtracted in the UI waterfall.
        timing.connectMs = round(performance.now() - connectStart);
        callback(err, socket);
      });
    },
  });
}

async function readCapped(stream, maxBytes) {
  const chunks = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(chunk);
  }

  return { bytes: Buffer.concat(chunks), truncated };
}

/* ---------------------------------------------------------------- *
 * Errors — phrased for someone who is not debugging our code
 * ---------------------------------------------------------------- */

export class HttpRequestError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HttpRequestError';
    this.cause = cause;
  }
}

function translateNetworkError(err, url, timeoutMs) {
  const code = err.code ?? err.cause?.code;
  const host = url.host;

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new HttpRequestError(`Could not resolve "${host}" — check the hostname.`, err);
    case 'ECONNREFUSED':
      return new HttpRequestError(`Nothing is listening at ${host}.`, err);
    case 'ECONNRESET':
      return new HttpRequestError(`${host} closed the connection unexpectedly.`, err);
    case 'CERT_HAS_EXPIRED':
      return new HttpRequestError(`The TLS certificate for ${host} has expired.`, err);
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return new HttpRequestError(`${host} presented a self-signed TLS certificate.`, err);
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return new HttpRequestError(`${host} did not respond within ${timeoutMs / 1000}s.`, err);
    case 'UND_ERR_ABORTED':
    case 'ABORT_ERR':
      return new HttpRequestError('Request cancelled.', err);
    default:
      return new HttpRequestError(`Request to ${host} failed: ${err.message}`, err);
  }
}

/* ---------------------------------------------------------------- *
 * Shaping helpers
 * ---------------------------------------------------------------- */

function headersToObject(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) out[key] = value;
  return out;
}

function normaliseHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function parseSetCookies(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((raw) => {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    // A first segment with no '=' is malformed; treat the whole segment as the name rather
    // than slicing at -1, which would silently produce an empty name and duplicate the value.
    const cookie = {
      name: eq === -1 ? pair.trim() : pair.slice(0, eq).trim(),
      value: eq === -1 ? '' : pair.slice(eq + 1).trim(),
      httpOnly: false,
      secure: false,
    };
    for (const attr of attrs) {
      const [name, value] = attr.split('=');
      const key = name.trim().toLowerCase();
      if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'samesite') cookie.sameSite = value?.trim();
      else if (key === 'path') cookie.path = value?.trim();
      else if (key === 'domain') cookie.domain = value?.trim();
      else if (key === 'max-age') cookie.maxAge = Number(value);
      else if (key === 'expires') cookie.expires = value?.trim();
    }
    return cookie;
  });
}

function describeSentBody(bodyDef, payload) {
  if (payload === undefined) return { type: 'none', text: '' };
  if (typeof payload === 'string') return { type: bodyDef.type, text: payload };
  if (Buffer.isBuffer(payload)) {
    return { type: bodyDef.type, text: `<${payload.length} bytes of binary data>` };
  }
  return { type: bodyDef.type, text: '<multipart form data>' };
}

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusText(status) {
  return STATUS_TEXT[status] ?? '';
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

/* ---------------------------------------------------------------- *
 * Sanitisation — the last stop before a run record leaves the server
 * ---------------------------------------------------------------- */

/**
 * Mask every secret in a run record: values that came from secret variables, plus the value of
 * any header that is a credential by nature (Basic auth, for instance, base64-encodes the
 * secret, so value matching alone would miss it).
 */
export function sanitiseRun(run, scope) {
  const masked = maskDeep(run, scope);

  const maskHeaders = (headers) => {
    if (!headers) return headers;
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
      out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? maskCredential(value) : value;
    }
    return out;
  };

  if (masked.request) masked.request.headers = maskHeaders(masked.request.headers);
  if (masked.finalRequest) masked.finalRequest.headers = maskHeaders(masked.finalRequest.headers);
  if (masked.response) masked.response.headers = maskHeaders(masked.response.headers);
  if (masked.response?.cookies) {
    masked.response.cookies = masked.response.cookies.map((c) => ({
      ...c,
      value: maskCredential(c.value),
    }));
  }
  return masked;
}

/** Keeps the scheme visible ("Bearer ••••") so the UI can still show what kind of auth ran. */
function maskCredential(value) {
  if (typeof value !== 'string' || !value) return value;
  const match = value.match(/^(Bearer|Basic|Digest|Token)\s+(.+)$/i);
  return match ? `${match[1]} ••••` : '••••';
}

export { maskText };
