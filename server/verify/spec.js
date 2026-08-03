/**
 * Finding the specification to verify against.
 *
 * People reach for the documentation URL, because that is the one they have. The machine-
 * readable specification is usually sitting next to it under a name they have never needed
 * to know, so this looks in three places before giving up — and says what it tried.
 */
import { fetchDocument, parseDocument } from '../import/index.js';

/** Where specifications are conventionally published, relative to an API or docs origin. */
const SPEC_PATHS = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/swagger.yaml',
  '/v3/api-docs',
  '/api-docs',
  '/api/openapi.json',
  '/.well-known/openapi.json',
];

/**
 * Turn whatever the caller supplied into a parsed specification.
 *
 * A URL is tried as given, and if it turns out to be a web page rather than a specification,
 * the conventional publication paths on the same origin are tried before giving up. People
 * reach for the documentation URL because that is the one they have; the spec is usually
 * sitting next to it under a name they have never needed to know.
 */
export async function resolveSpec(body) {
  if (body.spec) return body.spec;

  if (body.specUrl) return resolveSpecFromUrl(body.specUrl);

  if (!body.specText?.trim()) return null;
  return parseSpecText(body.specText, 'The pasted document');
}

export async function resolveSpecFromUrl(rawUrl) {
  const attempts = [];

  const tryUrl = async (url) => {
    attempts.push(url);
    try {
      const { text } = await fetchDocument(url);
      return parseSpecText(text, null);
    } catch {
      return null;
    }
  };

  // 1. The URL as given.
  const direct = await tryUrl(rawUrl);
  if (direct) return direct;

  // 2. If it was a web page, ask the page where its specification is. Documentation viewers
  //    (Swagger UI, Redoc) name the spec URL either in the HTML or in the initialiser script
  //    they load, which is far more reliable than guessing paths.
  const referenced = await specUrlsFromPage(rawUrl);
  for (const candidate of referenced) {
    const found = await tryUrl(candidate);
    if (found) return found;
  }

  let origin;
  try {
    origin = new URL(rawUrl).origin;
  } catch {
    origin = null;
  }

  if (origin) {
    for (const path of SPEC_PATHS) {
      const candidate = `${origin}${path}`;
      if (candidate === rawUrl) continue;
      const found = await tryUrl(candidate);
      if (found) return found;
    }
  }

  const err = new Error(
    `No OpenAPI or Swagger specification was found at ${rawUrl}, or at the usual places on ` +
      `${origin ?? 'that host'} (${SPEC_PATHS.slice(0, 4).join(', ')} and a few others). ` +
      'Contract conformance needs the machine-readable specification, not the documentation ' +
      'web page — if the API only publishes prose documentation, it has no contract to check ' +
      'against, and negative testing is the suite that still applies.',
  );
  err.status = 400;
  err.attempted = attempts;
  throw err;
}

/**
 * Extract specification URLs a documentation page points at.
 *
 * Looks in the page itself, then in up to a few same-origin scripts it loads — Swagger UI
 * puts the spec URL in swagger-initializer.js rather than the HTML, which is why the page
 * alone is not enough.
 */
async function specUrlsFromPage(pageUrl) {
  let html;
  try {
    html = (await fetchDocument(pageUrl)).text;
  } catch {
    return [];
  }
  if (!/<html|<!doctype/i.test(html)) return [];

  const found = new Set(specUrlsIn(html, pageUrl));
  if (found.size) return [...found];

  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => absolute(m[1], pageUrl))
    .filter((url) => url && sameOrigin(url, pageUrl))
    .slice(0, 4);

  for (const script of scripts) {
    try {
      const { text } = await fetchDocument(script);
      for (const url of specUrlsIn(text, pageUrl)) found.add(url);
    } catch {
      /* a script that will not load tells us nothing */
    }
    if (found.size) break;
  }

  return [...found];
}

/** URLs in a document that look like a specification. */
function specUrlsIn(text, baseUrl) {
  const pattern =
    /["'`]([^"'`\s]*(?:openapi|swagger|api-docs)[^"'`\s]*\.(?:json|yaml|yml)|[^"'`\s]*\/v\d\/api-docs)["'`]/gi;
  const urls = [];

  for (const match of text.matchAll(pattern)) {
    const absoluteUrl = absolute(match[1], baseUrl);
    if (absoluteUrl) urls.push(absoluteUrl);
  }
  return urls.slice(0, 5);
}

function absolute(candidate, baseUrl) {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Parse text as a specification, refusing anything that is not one. */
function parseSpecText(text, label) {
  let parsed;
  try {
    parsed = parseDocument(text);
  } catch {
    if (!label) return null;
    const err = new Error(
      `${label} is not an OpenAPI or Swagger specification. Contract conformance needs the ` +
        'machine-readable document — usually published at a path like /openapi.json.',
    );
    err.status = 400;
    throw err;
  }

  if (parsed.source !== 'openapi') {
    if (!label) return null;
    const err = new Error(
      `${label} was read as ${parsed.source}, not an OpenAPI specification. Contract ` +
        'conformance compares responses against an OpenAPI or Swagger document.',
    );
    err.status = 400;
    throw err;
  }

  return parsed.document;
}
