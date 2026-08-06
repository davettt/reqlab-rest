/**
 * Caching: can a client avoid refetching something it already has?
 *
 * Conditional requests are the cheapest performance work available to an API — a validator on
 * the response and a freshness check on the way in turns a full payload into a 304 with an
 * empty body. They are also the most commonly skipped, because nothing breaks when they are
 * missing. The cost shows up as bandwidth and latency nobody attributes to the API.
 *
 * The suite is read-only: every probe is a GET the caller could already make. It runs against
 * successful GETs only, since a validator on an error response means nothing.
 *
 * There is a second, sharper reason to look at Cache-Control: an authenticated response marked
 * publicly cacheable can be stored by a shared proxy and served to a different user. That one
 * is a data-exposure bug wearing performance clothing.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'caching';

/**
 * @param {object} args
 * @param {Function} args.send      async (request) => sanitised run record
 * @param {object[]} args.requests  the requests to probe
 */
export async function runCaching({ send, requests }) {
  const findings = [];

  for (const request of requests) {
    if ((request.method ?? 'GET').toUpperCase() !== 'GET') continue;

    const run = await safeSend(send, request);
    if (!run || run.response.status < 200 || run.response.status >= 300) continue;

    const headers = run.response.headers ?? {};
    const etag = headers.etag ?? null;
    const lastModified = headers['last-modified'] ?? null;
    const cacheControl = headers['cache-control'] ?? null;

    checkValidatorPresent({ findings, request, run, etag, lastModified });
    checkPrivacy({ findings, request, run, cacheControl });

    if (etag) {
      await checkConditional({
        findings,
        send,
        request,
        header: 'If-None-Match',
        value: etag,
        validator: 'ETag',
      });
      await checkStableEtag({ findings, send, request, run, etag });
    } else if (lastModified) {
      await checkConditional({
        findings,
        send,
        request,
        header: 'If-Modified-Since',
        value: lastModified,
        validator: 'Last-Modified',
      });
    }
  }

  return findings;
}

/* ---------------------------------------------------------------- *
 * The checks
 * ---------------------------------------------------------------- */

function checkValidatorPresent({ findings, request, run, etag, lastModified }) {
  if (etag || lastModified) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: label(request),
      title: `${label(request)} cannot be cached`,
      whatHappened: 'The response carries neither an ETag nor a Last-Modified header.',
      whyItMatters:
        'A client has no way to ask "has this changed?", so it must download the whole ' +
        'response every time, even when nothing has changed. On a list or a document fetched ' +
        'repeatedly that is bandwidth and latency spent for nothing.',
      expected: 'an ETag or a Last-Modified header',
      actual: 'neither',
      evidence: evidenceFrom(run),
    }),
  );
}

/**
 * A conditional request that is ignored is worse than no validator at all: the client does the
 * extra round trip *and* still gets the full body, so it has paid for caching and received
 * none of it.
 */
async function checkConditional({ findings, send, request, header, value, validator }) {
  const conditional = {
    ...request,
    headers: [
      ...(request.headers ?? []).filter((h) => !equalsHeader(h.key, header)),
      { key: header, value, enabled: true },
    ],
  };

  const run = await safeSend(send, conditional);
  if (!run) return;

  if (run.response.status === 304) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: label(request),
      title: `${label(request)} ignores conditional requests`,
      whatHappened:
        `The response carries a ${validator}, but re-requesting with ${header} set to that ` +
        `value returned ${run.response.status} and the full body again, not 304.`,
      whyItMatters:
        'The validator is advertised and then not honoured, so a well-behaved client sends the ' +
        'conditional header on every request and never benefits from it. Either honour the ' +
        'header or stop sending the validator.',
      expected: '304 Not Modified',
      actual: String(run.response.status),
      evidence: evidenceFrom(run),
    }),
  );
}

/**
 * An ETag is a promise that the same content produces the same value. Frameworks that hash a
 * timestamp, a request id, or a freshly serialised date break that promise, and every
 * conditional request misses — invisibly, because the responses are all still correct.
 */
async function checkStableEtag({ findings, send, request, run, etag }) {
  const second = await safeSend(send, request);
  if (!second || second.response.status !== run.response.status) return;

  const secondEtag = second.response.headers?.etag ?? null;
  if (!secondEtag || secondEtag === etag) return;

  // Only a problem if the content did not actually change underneath us.
  if (String(second.response.body ?? '') !== String(run.response.body ?? '')) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: label(request),
      title: `${label(request)} changes its ETag when the content has not changed`,
      whatHappened:
        `Two identical requests returned the same body but different ETags: ${etag} then ` +
        `${secondEtag}.`,
      whyItMatters:
        'The ETag is supposed to identify the content. If it changes on every request, no ' +
        'conditional request ever matches, so caching is advertised but never actually works. ' +
        'The usual cause is hashing something request-specific, such as a timestamp, along ' +
        'with the body.',
      expected: 'the same ETag for the same content',
      actual: `${etag} then ${secondEtag}`,
      evidence: evidenceFrom(second),
    }),
  );
}

/**
 * Authenticated responses must not be publicly cacheable.
 *
 * `Cache-Control: public` on a response that varies by user tells every shared cache between
 * the API and the client that one user's response may be handed to the next caller.
 */
function checkPrivacy({ findings, request, run, cacheControl }) {
  if (!hasAuth(request)) return;

  const directives = String(cacheControl ?? '').toLowerCase();
  const isPublic = /\bpublic\b/.test(directives);
  const isProtected = /\b(private|no-store|no-cache)\b/.test(directives);

  if (!isPublic && isProtected) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: isPublic ? 'major' : 'minor',
      endpoint: label(request),
      title: isPublic
        ? `${label(request)} marks an authenticated response publicly cacheable`
        : `${label(request)} does not say whether an authenticated response may be cached`,
      whatHappened: isPublic
        ? `The endpoint requires credentials and returned Cache-Control: ${cacheControl}.`
        : `The endpoint requires credentials and returned ${
            cacheControl ? `Cache-Control: ${cacheControl}` : 'no Cache-Control header'
          }.`,
      whyItMatters: isPublic
        ? 'Any shared cache — a CDN, a corporate proxy — may store this response and serve it ' +
          'to a different user. The response is per-user, so that is one user reading ' +
          'another’s data, with no bug in the API code itself.'
        : 'Without an explicit directive, caches apply their own defaults to a response that ' +
          'varies by user. Say private or no-store and the ambiguity disappears.',
      expected: 'private or no-store',
      actual: cacheControl ?? 'no Cache-Control header',
      evidence: evidenceFrom(run),
    }),
  );
}

/* ---------------------------------------------------------------- *
 * Shared helpers
 * ---------------------------------------------------------------- */

async function safeSend(send, request) {
  try {
    return await send(request);
  } catch {
    return null;
  }
}

function equalsHeader(a, b) {
  return String(a ?? '').toLowerCase() === String(b).toLowerCase();
}

function hasAuth(request) {
  if ((request.auth?.type ?? 'none') !== 'none') return true;
  return (request.headers ?? []).some(
    (h) => h.enabled !== false && equalsHeader(h.key, 'authorization'),
  );
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
