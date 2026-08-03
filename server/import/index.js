/**
 * Import dispatch.
 *
 * Structured formats are detected and parsed exactly — no model, no tokens, no invention.
 * Only genuinely unstructured input (prose documentation) is a candidate for the AI path,
 * which is offered as a suggestion here rather than run automatically: an AI pass costs money
 * and can be wrong, so it should never be the silent default when a parser would do.
 */
// js-yaml v4 ships named ESM exports; there is no default export.
import { load as loadYaml, JSON_SCHEMA } from 'js-yaml';
import { isOpenApi, parseOpenApi } from './openapi.js';
import { isHar, isPostman, parseHar, parsePostman } from './postman.js';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
    this.status = 400;
  }
}

/**
 * Parse a pasted document.
 *
 * @param {string} text raw JSON or YAML
 * @returns {{requests, variables, warnings, info, source}}
 */
export function parseDocument(text) {
  if (!text || !text.trim()) throw new ImportError('Nothing to import.');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
    throw new ImportError('That document is larger than 20 MB.');
  }

  const doc = parseStructured(text);

  if (!doc) {
    throw new ImportError(
      'This does not look like OpenAPI, Swagger, a Postman collection, or a HAR file. ' +
        'If it is written documentation rather than a spec, use the AI import instead.',
    );
  }

  // The parsed document travels with the result: contract verification needs the spec
  // itself, not only the requests derived from it.
  if (isOpenApi(doc)) return { ...parseOpenApi(doc), source: 'openapi', document: doc };
  if (isPostman(doc)) return { ...parsePostman(doc), source: 'postman' };
  if (isHar(doc)) return { ...parseHar(doc), source: 'har' };

  throw new ImportError(
    'The document parsed, but is not a format this recognises. Supported: OpenAPI 3, ' +
      'Swagger 2, Postman collections (v2), and HAR captures.',
  );
}

/** JSON first, then YAML. Both failing means the input is not a structured document. */
function parseStructured(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* not JSON — try YAML */
  }

  try {
    // js-yaml v4's `load` IS the safe loader — v3's `safeLoad` was renamed and the unsafe
    // variant is now the explicit `unsafeLoad`. JSON_SCHEMA narrows it further, excluding
    // YAML's implicit types so a spec cannot construct arbitrary objects while parsing.
    const doc = loadYaml(text, { schema: JSON_SCHEMA });
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a document by URL for import.
 *
 * Deliberately narrow: https/http only, bounded size, and no redirect to a non-http scheme.
 * This runs on the server, so an unbounded fetcher would be a request-forgery tool.
 */
export async function fetchDocument(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImportError(`"${rawUrl}" is not a valid URL.`);
  }

  // Deliberately NOT blocked: loopback, private and link-local addresses.
  //
  // An automated review flags this as SSRF. For a hosted service that would be right, but
  // this is a loopback-bound local tool whose whole purpose is sending HTTP where the user
  // points it — POST /api/run does exactly that with no restrictions at all, so refusing an
  // internal address here would remove a primary use case (importing a spec from your own
  // dev server, or an internal spec host) while blocking nothing an attacker who could reach
  // this port could not already do. The trust boundary is the 127.0.0.1 bind, documented in
  // the README, not a destination allowlist.
  //
  // Redirects ARE followed manually: a chain that silently changes scheme or wanders across
  // hosts should be bounded and visible, not delegated to fetch.
  const chain = [];

  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ImportError(`Only http and https URLs can be imported (got ${url.protocol}).`);
    }
    if (hop > MAX_REDIRECTS) {
      throw new ImportError(`That URL redirected more than ${MAX_REDIRECTS} times.`);
    }

    let res;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
        signal: AbortSignal.timeout(20_000),
        redirect: 'manual',
      });
    } catch (err) {
      throw new ImportError(`Could not fetch that URL: ${err.message}`);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next;
      try {
        next = new URL(res.headers.get('location'), url);
      } catch {
        throw new ImportError('That URL redirected somewhere invalid.');
      }
      chain.push(`${url} → ${next}`);
      url = next;
      continue;
    }

    if (!res.ok) throw new ImportError(`That URL returned HTTP ${res.status}.`);

    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_INPUT_BYTES) throw new ImportError('That document is larger than 20 MB.');

    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      throw new ImportError('That document is larger than 20 MB.');
    }
    return { text, redirects: chain };
  }
}

/** True when the text is prose rather than a structured document — the AI path's territory. */
export function looksUnstructured(text) {
  return parseStructured(text) === null;
}
