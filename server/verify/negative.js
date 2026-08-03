/**
 * Negative testing: what the API does when a caller gets it wrong.
 *
 * This is where first implementations usually fail. The happy path gets built and tested; the
 * failure paths get whatever the framework does by default, which is often a 500 with a stack
 * trace in the body.
 *
 * Cases are generated from the request itself, so this works with or without a spec. Each one
 * asks a specific question: does the right status come back, is the error shape consistent,
 * and does the response leak anything it should not.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'negative';

/** Signs that an error response is exposing the inside of the server. */
const LEAK_PATTERNS = [
  { pattern: /\bat [\w$.]+ \(?[\w/\\.-]+:\d+:\d+/, what: 'a stack trace' },
  { pattern: /(\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)/, what: 'a filesystem path' },
  { pattern: /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,40}\bFROM\b/i, what: 'an SQL statement' },
  { pattern: /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b.*\d{2,5}/, what: 'an internal host or port' },
  { pattern: /node_modules|site-packages|vendor\/bundle/, what: 'a dependency path' },
  { pattern: /\b(psql|mysqli?|mongodb|redis):\/\//i, what: 'a database connection string' },
];

/**
 * @param {object} args
 * @param {Function} args.send      async (request) => sanitised run record
 * @param {object[]} args.requests  the requests to probe
 * @param {boolean} [args.hasAuth]  whether the requests carry credentials
 */
export async function runNegative({ send, requests }) {
  const findings = [];
  const errorShapes = [];

  for (const request of requests) {
    for (const testCase of casesFor(request)) {
      let run;
      try {
        run = await send(testCase.request);
      } catch {
        // A transport failure here is not a finding: the point is what the API answers, and
        // a case that could not be sent tells us nothing about that.
        continue;
      }

      const status = run.response.status;
      const body = run.response.bodyEncoding === 'utf8' ? run.response.body : '';

      // Every error response is checked for leakage, whatever its status.
      if (status >= 400) {
        checkLeakage({ findings, request, testCase, run, body });
        errorShapes.push({ endpoint: label(request), status, shape: shapeOf(body) });
      }

      if (!testCase.expected.includes(status)) {
        findings.push(
          finding({
            suite: SUITE,
            severity: severityFor(status, testCase),
            endpoint: label(request),
            title: `${label(request)} answered ${status} to ${testCase.name}`,
            whatHappened: `${testCase.whatWeSent} The API returned ${status}.`,
            whyItMatters: testCase.whyItMatters(status),
            expected: testCase.expected.join(' or '),
            actual: String(status),
            evidence: evidenceFrom(run),
          }),
        );
      }
    }
  }

  checkErrorShapeConsistency({ findings, errorShapes });
  return findings;
}

/* ---------------------------------------------------------------- *
 * Case generation
 * ---------------------------------------------------------------- */

function casesFor(request) {
  const cases = [];
  const hasAuth = (request.auth?.type ?? 'none') !== 'none';
  const hasJsonBody = request.body?.type === 'json' && request.body.content?.trim();

  if (hasAuth) {
    cases.push({
      name: 'a request with no credentials',
      whatWeSent: 'The request was sent with its authentication removed.',
      request: { ...request, auth: { type: 'none' }, name: `${request.name} (no auth)` },
      expected: [401, 403],
      whyItMatters: (status) =>
        status < 400
          ? 'The endpoint served an unauthenticated caller. Whatever it returned is readable ' +
            'by anyone who knows the URL.'
          : `${status} is not the conventional answer to a missing credential. Clients ` +
            'distinguish 401 (authenticate) from 403 (authenticated but not allowed), and ' +
            'anything else leaves them guessing.',
    });

    cases.push({
      name: 'a malformed credential',
      whatWeSent: 'The request was sent with a deliberately invalid token.',
      request: {
        ...request,
        auth: { type: 'bearer', token: 'not-a-real-token-000' },
        name: `${request.name} (bad token)`,
      },
      expected: [401, 403],
      whyItMatters: (status) =>
        status < 400
          ? 'An invalid credential was accepted, which means the credential is not being ' +
            'checked at all.'
          : `A rejected credential should produce 401 or 403, not ${status}.`,
    });
  }

  if (hasJsonBody) {
    cases.push({
      name: 'a malformed JSON body',
      whatWeSent: 'The request body was replaced with text that is not valid JSON.',
      request: {
        ...request,
        body: { type: 'json', content: '{"broken": ' },
        name: `${request.name} (malformed JSON)`,
      },
      expected: [400, 415, 422],
      whyItMatters: (status) =>
        status >= 500
          ? 'Unparseable input is the caller’s mistake, and answering 5xx reports it as the ' +
            'server’s. That hides real outages in the error rate and tells the caller nothing.'
          : `Malformed JSON should be rejected with 400 or 422, not ${status}.`,
    });

    cases.push({
      name: 'a field with the wrong type',
      whatWeSent:
        'The body was sent as valid JSON, but with a field changed to a different type ' +
        '(a string became a number, or vice versa).',
      request: {
        ...request,
        body: { type: 'json', content: mutateTypes(request.body.content) },
        name: `${request.name} (wrong field type)`,
      },
      expected: [200, 201, 202, 204, 400, 409, 422],
      whyItMatters: (status) =>
        status >= 500
          ? 'Valid JSON with an unexpected field type is the single most common malformed ' +
            'request a real client sends. Answering 5xx makes a caller mistake look like an ' +
            'outage, and usually means the value reached code that assumed its type.'
          : `An unexpected field type should be rejected with 400 or 422, not ${status}.`,
    });

    cases.push({
      name: 'a wrong content type',
      whatWeSent: 'The JSON body was sent declared as text/plain.',
      request: {
        ...request,
        headers: [
          ...(request.headers ?? []).filter((h) => h.key.toLowerCase() !== 'content-type'),
          { key: 'Content-Type', value: 'text/plain', enabled: true },
        ],
        name: `${request.name} (wrong content type)`,
      },
      expected: [400, 415, 422],
      whyItMatters: (status) =>
        status >= 500
          ? 'A wrong Content-Type is a client error; 415 exists precisely for it. A 5xx here ' +
            'turns a caller mistake into a server incident.'
          : `An unsupported media type should be 415 (or 400), not ${status}.`,
    });

    cases.push({
      name: 'an oversized body',
      whatWeSent: 'The request was sent with a body of about 2 MB.',
      request: {
        ...request,
        body: { type: 'json', content: JSON.stringify({ padding: 'x'.repeat(2_000_000) }) },
        name: `${request.name} (oversized)`,
      },
      expected: [400, 413, 422],
      whyItMatters: (status) =>
        status >= 500
          ? 'An oversized body should be refused with 413, not crash the handler. Unbounded ' +
            'request bodies are also a denial-of-service route.'
          : `An oversized body should be refused with 413, not ${status}.`,
    });
  }

  cases.push({
    name: 'an unsupported method',
    whatWeSent: `The endpoint was called with TRACE instead of ${request.method}.`,
    request: {
      ...request,
      method: 'TRACE',
      body: { type: 'none' },
      name: `${request.name} (TRACE)`,
    },
    expected: [404, 405, 501, 400],
    whyItMatters: (status) =>
      status < 400
        ? 'The endpoint answered a method it does not document, which usually means the route ' +
          'is wired more broadly than intended.'
        : `An unsupported method should be 405 (or 404), not ${status}.`,
  });

  return cases;
}

/**
 * Flip the type of the first primitive in a JSON body: string ↔ number.
 *
 * Deliberately a small mutation. Replacing the whole body tests nothing an empty body would
 * not, whereas one wrong field exercises the path where a value reaches code that assumed its
 * type — which is where the 500s live.
 */
function mutateTypes(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!parsed || typeof parsed !== 'object') return content;

  const flip = (value) => (typeof value === 'string' ? 12345 : 'unexpected-string');

  if (Array.isArray(parsed)) {
    if (!parsed.length) return content;
    return JSON.stringify([flip(parsed[0]), ...parsed.slice(1)]);
  }

  const key = Object.keys(parsed).find((k) => ['string', 'number'].includes(typeof parsed[k]));
  if (!key) return content;

  return JSON.stringify({ ...parsed, [key]: flip(parsed[key]) });
}

function severityFor(status, testCase) {
  // Accepting something that should have been rejected is worse than rejecting it oddly.
  if (status < 400) return testCase.name.includes('credential') ? 'blocker' : 'major';
  if (status >= 500) return 'major';
  return 'minor';
}

/* ---------------------------------------------------------------- *
 * Leakage
 * ---------------------------------------------------------------- */

function checkLeakage({ findings, request, testCase, run, body }) {
  for (const { pattern, what } of LEAK_PATTERNS) {
    const match = body.match(pattern);
    if (!match) continue;

    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint: label(request),
        title: `${label(request)} leaked ${what} in an error response`,
        whatHappened:
          `Sending ${testCase.name} produced a ${run.response.status} whose body contains ` +
          `${what}: ${match[0].slice(0, 120)}`,
        whyItMatters:
          'Internal detail in an error response tells an attacker what the service is built ' +
          'from and where its code lives, and it reaches anyone who can provoke the error. ' +
          'Log the detail; return a generic message.',
        expected: 'a generic error message',
        actual: what,
        evidence: evidenceFrom(run),
      }),
    );
    return; // one leak finding per response is enough to act on
  }
}

/* ---------------------------------------------------------------- *
 * Error shape consistency
 * ---------------------------------------------------------------- */

/** A coarse fingerprint of an error body: which top-level keys it uses. */
function shapeOf(body) {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return 'non-object';
    return Object.keys(parsed).sort().join(',') || 'empty';
  } catch {
    return 'non-json';
  }
}

function checkErrorShapeConsistency({ findings, errorShapes }) {
  const shapes = new Set(errorShapes.map((e) => e.shape));
  if (shapes.size <= 1) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint: null,
      title: 'Error responses do not share a consistent shape',
      whatHappened: `${shapes.size} different error body shapes were seen: ${[...shapes].join(' / ')}.`,
      whyItMatters:
        'Callers write one error handler. When the shape varies by endpoint they either write ' +
        'several, or miss cases and surface a blank message to their users.',
      expected: 'one error shape',
      actual: `${shapes.size} shapes`,
    }),
  );
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
