/**
 * Auth helpers.
 *
 * Everything here runs server-side after variable resolution, so credentials exist in
 * plaintext only for the duration of the send. Nothing returned from this module is echoed to
 * the client without passing through maskDeep() first.
 */

import crypto from 'crypto';

export class AuthValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthValueError';
  }
}

/**
 * Ranges worth naming, because a character from one of these is almost always a paste
 * accident rather than a deliberate choice — and the Latin lookalikes are invisible.
 */
const SCRIPTS = [
  [0x0400, 0x04ff, 'Cyrillic'],
  [0x0370, 0x03ff, 'Greek'],
  [0x2010, 0x2027, 'typographic punctuation (a dash or quote substituted by a word processor)'],
  [0x2030, 0x205e, 'typographic punctuation (a dash or quote substituted by a word processor)'],
  [0x00a0, 0x00a0, 'a non-breaking space'],
];

/**
 * Reject a credential that cannot be sent, before the platform does it for us.
 *
 * HTTP header values are ByteStrings — nothing above U+00FF. The platform's own error for this
 * says "Cannot convert argument to a ByteString because the character at index 14 has a value
 * of 1058", which tells the user nothing and, being about a credential, puts a fragment of a
 * secret into a message that travels to the browser.
 *
 * The replacement names the field and describes the offending character's *script* without
 * printing it: "a Cyrillic letter" is what makes a homoglyph findable, and is not the value.
 * The position is included because a 40-character key is otherwise unsearchable by eye.
 */
function assertSendable(value, field) {
  const text = String(value ?? '');

  // Every offending character, not just the first. A word processor that substituted one
  // lookalike usually substituted its neighbours too, and reporting them one send at a time
  // turns a single paste mistake into a guessing game.
  const faults = [];

  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    if (code >= 0x20 && code <= 0xff) continue;

    if (code < 0x20 || code === 0x7f) {
      const named =
        code === 0x0a ? 'a line break' : code === 0x09 ? 'a tab' : 'a control character';
      faults.push(`position ${i + 1} (${named})`);
      continue;
    }

    const script = SCRIPTS.find(([from, to]) => code >= from && code <= to)?.[2];
    faults.push(`position ${i + 1}${script ? ` (${script})` : ''}`);
  }

  if (!faults.length) return;

  throw new AuthValueError(
    `The ${field} contains ${faults.length} character${faults.length === 1 ? '' : 's'} that ` +
      `cannot be sent in an HTTP header: ${faults.join(', ')}. ` +
      'This normally means the value was copied from a document, a PDF or a rendered web page, ' +
      'which substitutes lookalike characters and can carry a line break along with it. Copy ' +
      'the value again from a plain-text source rather than editing the characters out. The ' +
      'value itself is not shown here because it is a credential.',
  );
}

/**
 * Apply an auth config to a request in place.
 *
 * @param {object} auth      resolved auth config (no {{placeholders}} left)
 * @param {Headers} headers  mutated with any auth headers
 * @param {URL} url          mutated for query-parameter auth
 * @returns {Promise<{warnings: string[]}>}
 */
export async function applyAuth(auth, headers, url) {
  const warnings = [];
  const type = auth?.type ?? 'none';

  switch (type) {
    case 'none':
      break;

    case 'bearer':
      if (auth.token) {
        assertSendable(auth.token, 'bearer token');
        headers.set('authorization', `Bearer ${auth.token}`);
      }
      break;

    case 'basic': {
      // Base64 would happily encode anything, so these are checked for the user's benefit
      // rather than the transport's: a homoglyph here fails as a rejected login instead.
      assertSendable(auth.username ?? '', 'basic auth username');
      assertSendable(auth.password ?? '', 'basic auth password');

      const encoded = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString(
        'base64',
      );
      headers.set('authorization', `Basic ${encoded}`);
      break;
    }

    case 'apiKey': {
      const key = auth.key ?? '';
      const value = auth.value ?? '';
      if (!key) {
        warnings.push('API key auth is selected but no parameter name is set.');
        break;
      }
      assertSendable(key, 'API key parameter name');
      if (auth.in === 'query') {
        // A query value is percent-encoded, so it survives characters a header cannot carry.
        url.searchParams.set(key, value);
        warnings.push(
          'This request sends its API key in the query string, where it lands in server ' +
            'logs, proxies, and browser history. A header is safer.',
        );
      } else {
        assertSendable(value, 'API key');
        headers.set(key.toLowerCase(), value);
      }
      break;
    }

    case 'oauth2-cc': {
      const token = await clientCredentialsToken(auth, warnings);
      if (token) {
        assertSendable(token, 'OAuth2 access token');
        headers.set('authorization', `${auth.tokenPrefix ?? 'Bearer'} ${token}`);
      }
      break;
    }

    default:
      warnings.push(`Unknown auth type "${type}" — sending the request unauthenticated.`);
  }

  return { warnings };
}

/* ---------------------------------------------------------------- *
 * OAuth2 client credentials
 * ---------------------------------------------------------------- */

/** In-memory only: tokens are short-lived and must not outlive the process. */
const tokenCache = new Map();

const EXPIRY_SKEW_MS = 30_000;

function cacheKey(auth) {
  // The secret is part of the identity of a token: rotate it and the cached token must not
  // be reused. Hashed, never stored raw — this map would otherwise hold live credentials.
  const secretFingerprint = crypto
    .createHash('sha256')
    .update(auth.clientSecret ?? '')
    .digest('hex')
    .slice(0, 16);

  return [
    auth.tokenUrl,
    auth.clientId,
    auth.scope ?? '',
    auth.audience ?? '',
    auth.clientAuth ?? 'header',
    secretFingerprint,
  ].join('|');
}

/**
 * The client secret is about to be put on the wire, so the destination is checked first:
 * https anywhere, http only against loopback (local dev), nothing else.
 */
function validateTokenUrl(rawUrl, warnings) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    warnings.push(`The OAuth2 token URL "${rawUrl}" is not a valid URL.`);
    return null;
  }

  if (url.protocol === 'https:') return url;

  if (url.protocol === 'http:') {
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
    if (!loopback) {
      warnings.push(
        `Refusing to send the client secret to ${url.origin} over plain http — it would be ` +
          'readable by anything on the network path. Use https, or a loopback address for ' +
          'local development.',
      );
      return null;
    }
    return url;
  }

  warnings.push(`Unsupported scheme "${url.protocol}" for the OAuth2 token URL.`);
  return null;
}

async function clientCredentialsToken(auth, warnings) {
  if (!auth.tokenUrl || !auth.clientId) {
    warnings.push('OAuth2 client credentials needs both a token URL and a client ID.');
    return null;
  }

  const tokenUrl = validateTokenUrl(auth.tokenUrl, warnings);
  if (!tokenUrl) return null;

  const key = cacheKey(auth);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) params.set('scope', auth.scope);
  if (auth.audience) params.set('audience', auth.audience);

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (auth.clientAuth === 'body') {
    params.set('client_id', auth.clientId);
    params.set('client_secret', auth.clientSecret ?? '');
  } else {
    const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret ?? ''}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }

  let res;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    warnings.push(`Could not reach the token endpoint: ${err.message}`);
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    // The token endpoint's own error body is the most useful thing to surface here.
    warnings.push(`Token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    warnings.push('The token endpoint did not return JSON.');
    return null;
  }

  const token = payload.access_token;
  if (!token) {
    warnings.push('The token response contained no access_token.');
    return null;
  }

  const expiresInMs = Number(payload.expires_in ?? 3600) * 1000;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresInMs });
  return token;
}

/** Drop cached tokens — used when auth settings change or the user forces a re-auth. */
export function clearTokenCache() {
  tokenCache.clear();
}
