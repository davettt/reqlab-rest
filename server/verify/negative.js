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
        errorShapes.push({
          endpoint: label(request),
          status,
          shape: shapeOf(body),
          // The case and the response are what make the finding actionable: "two shapes were
          // seen" tells the reader nothing they can go and look at.
          caseName: testCase.name,
          run,
        });
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
    name: `an unsupported method (${wrongMethodFor(request)})`,
    whatWeSent: `The endpoint was called with ${wrongMethodFor(request)} instead of ${request.method}.`,
    request: {
      ...request,
      method: wrongMethodFor(request),
      body: { type: 'none' },
      name: `${request.name} (${wrongMethodFor(request)})`,
    },
    // 404 is deliberately not accepted. The path came from this project, so it exists and
    // answers its documented method — telling a caller "Not Found" for a different method
    // says the endpoint is not there, which is a different and misleading fact.
    expected: [405, 501],
    whyItMatters: (status) =>
      status < 400
        ? 'The endpoint answered a method it does not document, which usually means the route ' +
          'is wired more broadly than intended.'
        : status === 404
          ? 'Defensible, but worth a decision rather than a default. Answering 404 refuses to ' +
            'confirm the path exists, which is deliberate hardening on an undocumented ' +
            'endpoint — but this path is published, so it conceals nothing from anyone reading ' +
            'the specification and only misleads an integrator, who checks their URL, their ' +
            'deployment and their credentials before noticing they used the wrong method. ' +
            '405 with an Allow header names the actual mistake. Note that 405 without Allow is ' +
            'worse than either: it confirms the path and still does not say what to use.'
          : `An unsupported method should be answered with 405, not ${status}.`,
  });

  return cases;
}

/**
 * Which method to send at an endpoint that does not document it.
 *
 * GET wherever possible: it is the mistake a real client actually makes, it reaches the
 * application's own routing, and it is safe by definition — if the API does happen to
 * implement GET on that path, reading is all that happens.
 *
 * TRACE only when the request is itself a GET, because then every alternative (POST, PUT,
 * DELETE) risks changing data on an endpoint we know nothing about. TRACE is the safe choice
 * there, at the cost of a weaker test: it is blocked at the edge by most proxies and WAFs —
 * correctly, since it enables cross-site tracing — so the answer usually comes from the
 * infrastructure rather than from the API.
 */
function wrongMethodFor(request) {
  return (request.method ?? 'GET').toUpperCase() === 'GET' ? 'TRACE' : 'GET';
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
  const byShape = new Map();
  for (const entry of errorShapes) {
    if (!byShape.has(entry.shape)) byShape.set(entry.shape, []);
    byShape.get(entry.shape).push(entry);
  }

  if (byShape.size <= 1) return;

  // Which shape is the odd one out: the one produced by the fewest cases is what the reader
  // needs to go and look at, and it is what the evidence should show.
  const ordered = [...byShape.entries()].sort((a, b) => b[1].length - a[1].length);
  const oddEntries = ordered[ordered.length - 1][1];

  const describe = ([shape, entries]) =>
    `${shape === 'non-json' ? 'not JSON at all' : shape} — ` +
    entries
      .slice(0, 3)
      .map((e) => `${e.status} from ${e.caseName}`)
      .join(', ') +
    (entries.length > 3 ? `, and ${entries.length - 3} more` : '');

  /**
   * A body that is not JSON is a different problem from a body with different keys.
   *
   * Different keys make a caller write a second branch. Something that is not JSON at all
   * makes their JSON parse throw, so the error they surface is a parse failure rather than
   * what the API said.
   *
   * But *where* the non-JSON came from changes what it means. A proxy answering at the edge —
   * nginx returning its own 405 page, a WAF blocking a method — is usually deliberate
   * hardening, and reporting it as an application defect sends the reader to the wrong team.
   * The API's own handler returning HTML is the serious version.
   */
  const nonJson = byShape.has('non-json');
  const fromEdge = nonJson && (byShape.get('non-json') ?? []).every(looksLikeInfrastructure);

  findings.push(
    finding({
      suite: SUITE,
      severity: nonJson && !fromEdge ? 'major' : 'minor',
      endpoint: null,
      title: fromEdge
        ? 'Some errors are answered by infrastructure, not by the API'
        : nonJson
          ? 'Some error responses are not JSON'
          : 'Error responses do not share a consistent shape',
      whatHappened:
        `${byShape.size} different error body shapes were seen. ` +
        ordered.map(describe).join('. ') +
        '.',
      whyItMatters: fromEdge
        ? 'The non-JSON responses carry a web-server error page rather than the API’s own ' +
          'envelope, which means something in front of the application answered first. That ' +
          'is often deliberate — blocking a method at the edge is sound hardening — so this ' +
          'is worth confirming rather than fixing outright. It only matters to a caller if ' +
          'they can reach it by accident; if the documentation promises the same error ' +
          'envelope on every request to the path, this is where that promise stops holding.'
        : nonJson
          ? 'A caller parsing the error body will throw on the responses that are not JSON, so ' +
            'the message their user sees is a parse failure rather than anything the API said. ' +
            'The application itself returned this, so it is the API’s own error handling that ' +
            'is inconsistent rather than a layer in front of it.'
          : 'Callers write one error handler. When the shape varies they either write several, ' +
            'or miss cases and surface a blank message to their users.',
      expected: 'one error shape',
      actual: `${byShape.size} shapes`,
      // The minority shape, which is the one worth opening.
      evidence: oddEntries[0]?.run ? evidenceFrom(oddEntries[0].run) : null,
    }),
  );
}

/** A default web-server error page: an HTML body, from something naming itself in `server`. */
function looksLikeInfrastructure(entry) {
  const headers = entry.run?.response?.headers ?? {};
  const contentType = String(headers['content-type'] ?? '');
  const server = String(headers.server ?? '');
  const body = String(entry.run?.response?.body ?? '');

  return (
    contentType.includes('html') &&
    (Boolean(server) || /<center>|<hr>|nginx|Apache|IIS|Envoy|cloudflare/i.test(body))
  );
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
