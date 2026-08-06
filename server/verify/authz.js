/**
 * Authorisation checks, and the security hygiene that sits alongside them.
 *
 * The central test is IDOR: take a request that reads one user's resource, send it with a
 * *different* user's credentials, and see what comes back. It is the most common serious API
 * bug, it is invisible to any single-identity test, and it is trivially exploitable once
 * someone notices resource ids are guessable.
 *
 * Requires two identities, because the whole point is comparing what each may see. With one,
 * only the unauthenticated probe and the hygiene checks run — and that is reported, so an
 * empty result is never mistaken for a clean bill of health.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'authz';

/**
 * @param {object} args
 * @param {Function} args.sendAs      async (identityName|null, request) => sanitised run
 * @param {object[]} args.requests    requests to probe
 * @param {string[]} args.identities  names of the configured identities (environments)
 */
export async function runAuthz({ sendAs, requests, identities }) {
  const findings = [];
  const [owner, other] = identities;

  if (identities.length < 2) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: 'Cross-user access was not tested',
        whatHappened:
          'Only one set of credentials is configured, so requests could not be replayed as a ' +
          'different user.',
        whyItMatters:
          'Reading another user’s data is the most common serious API bug, and it cannot be ' +
          'detected with a single identity. Add a second environment holding another user’s ' +
          'token to enable this check.',
        expected: 'two identities',
        actual: `${identities.length}`,
      }),
    );
  }

  for (const request of requests) {
    const baseline = await safeSend(sendAs, owner, request);
    if (!baseline) continue;

    // Only endpoints that returned something to their owner are worth probing: a 404 for the
    // owner tells us nothing about what another user can see.
    if (baseline.response.status >= 400) continue;

    await probeUnauthenticated({ findings, sendAs, request });
    if (other) await probeOtherUser({ findings, sendAs, request, baseline, other });

    checkHygiene({ findings, request, run: baseline });
  }

  return findings;
}

async function safeSend(sendAs, identity, request) {
  try {
    return await sendAs(identity, request);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- *
 * The probes
 * ---------------------------------------------------------------- */

async function probeUnauthenticated({ findings, sendAs, request }) {
  const run = await safeSend(sendAs, null, { ...request, auth: { type: 'none' } });
  if (!run) return;

  if (run.response.status >= 400) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'blocker',
      endpoint: label(request),
      title: `${label(request)} is readable without any credentials`,
      whatHappened:
        `The request was sent with its authentication removed and still returned ` +
        `${run.response.status}.`,
      whyItMatters:
        'Anyone who knows this URL can read the response, including people who have never ' +
        'signed in. If the data is not meant to be public, it is public now.',
      expected: '401 or 403',
      actual: String(run.response.status),
      evidence: evidenceFrom(run),
    }),
  );
}

async function probeOtherUser({ findings, sendAs, request, baseline, other }) {
  const run = await safeSend(sendAs, other, request);
  if (!run) return;

  if (run.response.status >= 400) return; // correctly refused

  // A 200 alone is not proof: a well-built endpoint may legitimately return that user's own
  // equivalent resource. It is a finding when the *same* content comes back, which means the
  // owner's resource was served to someone else.
  const sameBody = normalise(run.response.body) === normalise(baseline.response.body);

  findings.push(
    finding({
      suite: SUITE,
      severity: sameBody ? 'blocker' : 'major',
      endpoint: label(request),
      title: sameBody
        ? `${label(request)} returned one user's data to a different user`
        : `${label(request)} was accepted for a different user`,
      whatHappened: sameBody
        ? `The request was replayed with ${other}'s credentials, against the first user's ` +
          `resource, and returned the identical response.`
        : `The request was replayed with ${other}'s credentials and returned ` +
          `${run.response.status} rather than being refused. The body differed, so this may ` +
          'be correct if the endpoint scopes the resource to the caller.',
      whyItMatters: sameBody
        ? 'One user can read another user’s data by changing an id in the URL. This is the ' +
          'most commonly exploited API flaw, and it usually needs no tooling to find.'
        : 'Worth confirming the endpoint scopes to the caller rather than to the id in the ' +
          'request. If it scopes to the id, this is a data-exposure bug.',
      expected: '403 (or a resource belonging to the caller)',
      actual: String(run.response.status),
      evidence: evidenceFrom(run),
    }),
  );
}

/* ---------------------------------------------------------------- *
 * Hygiene — cheap checks worth doing while we are here
 * ---------------------------------------------------------------- */

function checkHygiene({ findings, request, run }) {
  const url = run.request?.url ?? '';
  const headers = run.response?.headers ?? {};

  if (url.startsWith('http://') && !isLoopback(url)) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'blocker',
        endpoint: label(request),
        title: `${label(request)} is served over plain http`,
        whatHappened: 'The request was made over http, not https.',
        whyItMatters:
          'Credentials and response data travel in the clear, readable and modifiable by ' +
          'anything on the network path.',
        expected: 'https',
        actual: 'http',
        evidence: evidenceFrom(run),
      }),
    );
  }

  // A credential in the query string is recorded by every proxy, load balancer and access log
  // between the client and the server.
  const queryCredential = findQueryCredential(url);
  if (queryCredential) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint: label(request),
        title: `${label(request)} sends its credential in the query string`,
        whatHappened: `The URL contains ${queryCredential}.`,
        whyItMatters:
          'Query strings are written to server logs, proxy logs and browser history, so the ' +
          'credential ends up stored in several places nobody is auditing. A header is not.',
        expected: 'the credential in a header',
        actual: 'in the query string',
        evidence: evidenceFrom(run),
      }),
    );
  }

  if (headers['access-control-allow-origin'] === '*' && hasAuth(request)) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint: label(request),
        title: `${label(request)} allows any origin`,
        whatHappened:
          'The response sets Access-Control-Allow-Origin: *, on an authenticated endpoint.',
        whyItMatters:
          'Any website can call this endpoint from a visitor’s browser. Combined with cookie ' +
          'authentication that is cross-site request forgery; with tokens it widens who can ' +
          'use a leaked one.',
        expected: 'a specific origin',
        actual: '*',
        evidence: evidenceFrom(run),
      }),
    );
  }

  // A framework banner is not a vulnerability on its own; it is free reconnaissance. It tells
  // anyone probing which stack to look up known issues for, and it is one line to remove.
  const banners = ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version'].filter(
    (h) => headers[h],
  );
  if (banners.length) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'minor',
        endpoint: label(request),
        title: `${label(request)} advertises the software it runs on`,
        whatHappened: `The response carries ${banners.map((h) => `${h}: ${headers[h]}`).join(', ')}.`,
        whyItMatters:
          'This tells anyone probing the API which stack to look up known vulnerabilities ' +
          'for, and narrows their search from "some API" to a specific framework and often a ' +
          'specific version. It grants no access by itself, and removing it is usually one ' +
          'line of configuration.',
        expected: 'no framework banner',
        actual: banners.join(', '),
        evidence: evidenceFrom(run),
      }),
    );
  }

  const missing = ['x-content-type-options', 'x-frame-options'].filter((h) => !headers[h]);
  if (missing.length === 2) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'minor',
        endpoint: label(request),
        title: `${label(request)} sets no protective response headers`,
        whatHappened: 'Neither X-Content-Type-Options nor X-Frame-Options was present.',
        whyItMatters:
          'These are one-line defaults that block content-type sniffing and framing. Their ' +
          'absence rarely causes a bug on its own, but it signals nobody has been through the ' +
          'response headers.',
        expected: 'X-Content-Type-Options and X-Frame-Options',
        actual: 'neither',
        evidence: evidenceFrom(run),
      }),
    );
  }
}

const QUERY_CREDENTIAL = /[?&](api[_-]?key|access[_-]?token|token|password|secret)=/i;

function findQueryCredential(url) {
  const match = url.match(QUERY_CREDENTIAL);
  return match ? match[1] : null;
}

function hasAuth(request) {
  return (request.auth?.type ?? 'none') !== 'none';
}

function isLoopback(url) {
  try {
    const { hostname } = new URL(url);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

/** Compare bodies ignoring whitespace, so formatting differences are not treated as content. */
function normalise(body) {
  return String(body ?? '').replace(/\s+/g, '');
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
