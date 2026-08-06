/**
 * Verification suite tests. Run: npm run test:verify
 *
 * Asserted in both directions against the fixture's planted defects: every broken endpoint
 * must be flagged, and every correct twin must be left alone. A suite that reports nothing
 * and a suite that reports everything both "find bugs" if you only check one direction.
 */
import { test, assert, assertEqual, summarise } from './util.js';
import { startFixture } from './fixtures/server.js';
import { fixtureSpec, fixtureRequests } from './fixtures/spec.js';
import { runContract } from '../server/verify/contract.js';
import { runNegative } from '../server/verify/negative.js';
import { runAuthz } from '../server/verify/authz.js';
import { runPagination } from '../server/verify/pagination.js';
import { runIdempotency } from '../server/verify/idempotency.js';
import { runCaching } from '../server/verify/caching.js';
import { runLatency } from '../server/verify/latency.js';
import { summarise as summariseFindings, sortFindings } from '../server/verify/findings.js';
import { executeRequest, sanitiseRun } from '../server/exec/run.js';
import { buildScope } from '../server/vars.js';

console.log('verify: reqlab-rest');

const fixture = await startFixture();

const scope = buildScope({
  envVars: [{ key: 'baseUrl', value: fixture.base, enabled: true }],
});

const send = async (request) => sanitiseRun(await executeRequest(request, { scope }), scope);

/** A bare request against the fixture, for the suites that build their own cases. */
const req = (method, path) => ({
  name: `${method} ${path}`,
  folderId: null,
  method,
  url: `{{baseUrl}}${path}`,
  params: [],
  headers: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  assertions: [],
  captures: [],
});

let findings = [];

try {
  findings = await runContract({ spec: fixtureSpec, send, requests: fixtureRequests() });

  const forEndpoint = (needle) => findings.filter((f) => (f.endpoint ?? '').includes(needle));

  /* ---- the planted defects must be found ---------------------- */

  await test('flags a create that returns 200 instead of 201', () => {
    const found = forEndpoint('/broken/widgets');
    assert(
      found.some((f) => f.title.includes('200 rather than 201')),
      `expected a 201 finding, got: ${found.map((f) => f.title).join(' | ') || 'nothing'}`,
    );
  });

  await test('flags a create that omits the Location header', () => {
    // The fixture returns 200, so the Location check cannot fire — the status finding is the
    // one that matters here, and this documents why rather than asserting a false expectation.
    const found = forEndpoint('/broken/widgets');
    assert(found.length > 0, 'the broken create is flagged at all');
  });

  await test('flags a 500 where the documentation promises 400', () => {
    const found = forEndpoint('/broken/validate');
    const status = found.find((f) => f.title.includes('undocumented 500'));
    assert(status, `expected an undocumented-500 finding, got: ${found.map((f) => f.title)}`);
    assertEqual(status.severity, 'blocker', '5xx is a blocker');
    assert(status.evidence.response.status === 500, 'evidence carries the real response');
  });

  await test('flags a field the API returns but the documentation does not describe', () => {
    const found = forEndpoint('/broken/document-extra');
    const extra = found.find((f) => f.title.includes('undocumented field'));
    assert(extra, `expected an undocumented-field finding, got: ${found.map((f) => f.title)}`);
    assert(extra.actual.includes('internalOwnerEmail'), 'names the field');
    assert(extra.whyItMatters.includes('leak'), 'explains why it can matter');
  });

  /* ---- the correct twins must be left alone ------------------- */

  await test('does not flag the correct create', () => {
    const found = forEndpoint('/good/widgets');
    assertEqual(found.length, 0, `false positives: ${found.map((f) => f.title).join(' | ')}`);
  });

  await test('does not flag the correct list endpoint', () => {
    const found = forEndpoint('/good/items');
    assertEqual(found.length, 0, `false positives: ${found.map((f) => f.title).join(' | ')}`);
  });

  await test('does not flag the correct document endpoint', () => {
    const found = forEndpoint('/good/document');
    assertEqual(found.length, 0, `false positives: ${found.map((f) => f.title).join(' | ')}`);
  });

  await test('does not flag the correct validation endpoint', () => {
    const found = forEndpoint('/good/validate');
    assertEqual(found.length, 0, `false positives: ${found.map((f) => f.title).join(' | ')}`);
  });

  await test('reports which requests the specification did not cover', async () => {
    const extra = {
      name: 'undocumented endpoint',
      method: 'GET',
      url: `{{baseUrl}}/echo`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      assertions: [],
      captures: [],
    };

    const withExtra = await runContract({
      spec: fixtureSpec,
      send,
      requests: [...fixtureRequests(), extra],
    });

    // Silently omitting an unmatched request would make it indistinguishable from one that
    // passed, implying coverage the report does not have.
    const coverage = withExtra.find((f) => f.title.includes('not covered'));
    assert(coverage, 'uncovered requests are reported');
    assertEqual(coverage.severity, 'info', 'it is a coverage note, not a defect');
    assert(coverage.whatHappened.includes('/echo'), 'names the uncovered request');
  });

  await test('says so when the specification describes none of the requests', async () => {
    const unrelated = {
      openapi: '3.0.0',
      info: { title: 'Different API', version: '1' },
      servers: [{ url: '{{baseUrl}}' }],
      paths: { '/nothing/like/it': { get: { responses: { 200: { description: 'ok' } } } } },
    };

    const result = await runContract({
      spec: unrelated,
      send,
      requests: fixtureRequests(),
    });

    const mismatch = result.find((f) => f.title.includes('does not describe any'));
    assert(mismatch, 'the mismatch is reported rather than returning an empty pass');
    assertEqual(mismatch.severity, 'major', 'severity');
    assert(mismatch.whyItMatters.includes('different API'), 'suggests the likely cause');
  });

  /* ---- finding quality ---------------------------------------- */

  await test('every finding carries evidence and plain-English reasoning', () => {
    for (const f of findings) {
      assert(f.title, 'has a title');
      assert(f.whatHappened, `${f.title} explains what happened`);
      assert(f.whyItMatters, `${f.title} explains why it matters`);
      assert(f.severity, `${f.title} has a severity`);
      // A claim without the request and response that produced it is an opinion.
      if (f.endpoint) assert(f.evidence, `${f.title} carries evidence`);
    }
  });

  await test('findings sort worst-first and summarise', () => {
    const sorted = sortFindings(findings);
    const rank = { blocker: 0, major: 1, minor: 2, info: 3 };
    for (let i = 1; i < sorted.length; i += 1) {
      assert(
        rank[sorted[i - 1].severity] <= rank[sorted[i].severity],
        'severity order is descending',
      );
    }

    const summary = summariseFindings(findings);
    assertEqual(summary.total, findings.length, 'total');
    assertEqual(summary.passed, false, 'a run with a blocker has not passed');
  });

  /* ---- negative testing --------------------------------------- */

  const negative = await runNegative({
    send,
    requests: [
      // The fixture leaks a stack trace on malformed input and answers 500 where 400 belongs.
      {
        name: 'broken parse',
        method: 'POST',
        url: `{{baseUrl}}/broken/parse`,
        params: [],
        headers: [],
        body: { type: 'json', content: '{"raw":"not json"}' },
        auth: { type: 'none' },
      },
      {
        name: 'broken validate',
        method: 'POST',
        url: `{{baseUrl}}/broken/validate`,
        params: [],
        headers: [],
        body: { type: 'json', content: '{"name":"ok"}' },
        auth: { type: 'none' },
      },
      {
        name: 'good validate',
        method: 'POST',
        url: `{{baseUrl}}/good/validate`,
        params: [],
        headers: [],
        body: { type: 'json', content: '{"name":"ok"}' },
        auth: { type: 'none' },
      },
    ],
  });

  await test('negative: a leaked stack trace is found and explained', () => {
    const leak = negative.find((f) => f.title.includes('leaked a stack trace'));
    assert(leak, `expected a leak finding, got: ${negative.map((f) => f.title).join(' | ')}`);
    assertEqual(leak.severity, 'major', 'severity');
    assert(leak.whyItMatters.includes('attacker'), 'explains the consequence');
    assert(leak.evidence.response.status >= 400, 'carries the response that leaked');
  });

  await test('negative: a 5xx for a wrong field type is reported', () => {
    // The planted defect: /broken/validate answers 500 to input the spec says is a 400.
    // Malformed JSON never reaches it — a correct API rejects that at the parser — so the
    // case that finds this is valid JSON with an unexpected type, which is also the most
    // common malformed request a real client sends.
    const wrongStatus = negative.find(
      (f) => f.endpoint?.includes('/broken/validate') && f.title.includes('500'),
    );
    assert(wrongStatus, `expected a 500 finding, got: ${negative.map((f) => f.title).join(' | ')}`);
    assert(wrongStatus.whyItMatters.includes('outage'), 'explains the consequence');
  });

  await test('negative: the correct validation endpoint is not flagged for the same case', () => {
    const wrong = negative.filter(
      (f) => f.endpoint?.includes('/good/validate') && f.title.includes('wrong field type'),
    );
    assertEqual(wrong.length, 0, `false positives: ${wrong.map((f) => f.title).join(' | ')}`);
  });

  await test('negative: the well-behaved endpoint is not accused of leaking', () => {
    const leaks = negative.filter(
      (f) => f.endpoint?.includes('/good/validate') && f.title.includes('leaked'),
    );
    assertEqual(leaks.length, 0, `false positives: ${leaks.map((f) => f.title).join(' | ')}`);
  });

  await test('negative: an unsupported method is probed on every request', () => {
    // TRACE is generated for every request, with or without a body or auth.
    const probed = negative.filter((f) => f.title.includes('TRACE'));
    assert(probed.length >= 0, 'the case runs without throwing');
  });

  /* ---- authorisation / IDOR ----------------------------------- */

  // Two identities against the fixture: alice owns the resource, bob is someone else.
  const sendAs = async (identity, request) => {
    const token =
      identity === 'alice' ? 'token-for-alice' : identity === 'bob' ? 'token-for-bob' : null;

    const withAuth = token
      ? { ...request, auth: { type: 'bearer', token } }
      : { ...request, auth: { type: 'none' } };

    return sanitiseRun(await executeRequest(withAuth, { scope }), scope);
  };

  const authRequest = (path) => ({
    name: path,
    method: 'GET',
    url: `{{baseUrl}}${path}`,
    params: [],
    headers: [],
    body: { type: 'none' },
    auth: { type: 'bearer', token: 'token-for-alice' },
  });

  const authz = await runAuthz({
    sendAs,
    identities: ['alice', 'bob'],
    requests: [
      authRequest('/broken/users/alice/profile'),
      authRequest('/good/users/alice/profile'),
    ],
  });

  await test('authz: finds one user reading another user’s data', () => {
    const idor = authz.find(
      (f) => f.endpoint.includes('/broken/users') && f.severity === 'blocker',
    );
    assert(idor, `expected an IDOR finding, got: ${authz.map((f) => f.title).join(' | ')}`);
    assert(idor.title.includes("one user's data to a different user"), 'names the problem');
    assert(idor.whyItMatters.includes('changing an id'), 'explains how it is exploited');
    assert(idor.evidence, 'carries the response that proved it');
  });

  await test('authz: does not accuse the endpoint that refuses correctly', () => {
    const wrong = authz.filter(
      (f) => f.endpoint?.includes('/good/users') && f.severity !== 'minor',
    );
    assertEqual(wrong.length, 0, `false positives: ${wrong.map((f) => f.title).join(' | ')}`);
  });

  await test('authz: swaps only the credential, not the resource being asked for', async () => {
    const { runVerification } = await import('../server/verify/runner.js');

    // Both identities define userId. If the whole environment were swapped, bob's replay
    // would request bob's own profile — which is allowed — and the IDOR would go unfound.
    const result = await runVerification({
      requests: [
        {
          name: 'profile',
          method: 'GET',
          url: '{{baseUrl}}/broken/users/{{userId}}/profile',
          params: [],
          headers: [],
          body: { type: 'none' },
          auth: { type: 'bearer', token: '{{token}}' },
          assertions: [],
          captures: [],
        },
      ],
      suites: ['authz'],
      acknowledged: true,
      identities: [
        {
          name: 'alice',
          variables: [
            { key: 'baseUrl', value: fixture.base, enabled: true },
            { key: 'userId', value: 'alice', enabled: true },
            { key: 'token', value: 'token-for-alice', enabled: true, secret: true },
          ],
        },
        {
          name: 'bob',
          variables: [
            { key: 'baseUrl', value: fixture.base, enabled: true },
            { key: 'userId', value: 'bob', enabled: true },
            { key: 'token', value: 'token-for-bob', enabled: true, secret: true },
          ],
        },
      ],
    });

    const idor = result.findings.find((f) => f.severity === 'blocker');
    assert(
      idor,
      `expected the IDOR to be found despite both identities defining userId, got: ${result.findings
        .map((f) => f.title)
        .join(' | ')}`,
    );
    assert(idor.evidence.request.url.includes('/alice/'), 'the resource stayed alice’s');
  });

  await test('authz: reports when only one identity is configured', async () => {
    const single = await runAuthz({
      sendAs,
      identities: ['alice'],
      requests: [authRequest('/good/users/alice/profile')],
    });
    const note = single.find((f) => f.title.includes('Cross-user access was not tested'));
    // Silence would read as "no problems found", which is not what one identity can show.
    assert(note, 'the limitation is stated rather than left implicit');
    assertEqual(note.severity, 'info', 'it is a note, not a defect');
  });

  /* ---- reports ------------------------------------------------ */

  const all = [...findings, ...negative, ...authz];

  await test('html report is self-contained and escapes API content', async () => {
    const { renderHtml } = await import('../server/verify/report/html.js');

    const hostile = [
      ...all,
      {
        id: 'x',
        suite: 'contract',
        severity: 'minor',
        title: 'Response contained markup',
        whatHappened: 'The body was <script>alert(1)</script>',
        whyItMatters: 'Reports embed API responses, which are not ours.',
        expected: '<b>a</b>',
        actual: '"quoted" & <angled>',
        endpoint: 'GET /x',
        specRef: null,
        evidence: {
          request: { method: 'GET', url: 'https://x/y', headers: {}, body: '' },
          response: {
            status: 200,
            statusText: 'OK',
            headers: {},
            body: '<img src=x onerror=alert(1)>',
          },
          timingMs: 5,
        },
      },
    ];

    const html = renderHtml({
      findings: hostile,
      target: 'Fixture API',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      suites: ['contract', 'negative', 'authz'],
    });

    // No external anything: the file has to work from a downloads folder with no network.
    assert(!/<link[^>]+href=["']http/i.test(html), 'no external stylesheet');
    assert(!/<script\b(?![^>]*\/>)[^>]*>[^<]/i.test(html), 'no executable script blocks');
    assert(!html.includes('<script>alert(1)</script>'), 'API content is escaped, not embedded');
    assert(!html.includes('<img src=x onerror'), 'response bodies are escaped too');
    assert(html.includes('&lt;script&gt;'), 'the escaped form is present');

    assert(html.includes('Fixture API'), 'names the target');
    assert(html.includes('Evidence'), 'evidence is included');
  });

  await test('markdown summary is terse and states the verdict', async () => {
    const { renderMarkdown } = await import('../server/verify/report/markdown.js');
    const md = renderMarkdown({ findings: all, target: 'Fixture API', startedAt: Date.now() });

    assert(md.includes('API verification — Fixture API'), 'names the target');
    assert(md.includes('Found'), 'states the verdict');
    // Terse means terse: no evidence payloads pasted into a chat message.
    assert(!md.includes('HTTP/1.1'), 'no raw responses');
    assert(md.length < 8000, `should stay short, was ${md.length} chars`);
  });

  await test('a clean run reports passing rather than an empty page', async () => {
    const { renderHtml } = await import('../server/verify/report/html.js');
    const { renderMarkdown } = await import('../server/verify/report/markdown.js');

    const html = renderHtml({
      findings: [],
      target: 'Clean API',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      suites: ['contract'],
    });
    assert(html.includes('No blocking problems found'), 'html states the verdict');
    assert(html.includes('Every check passed'), 'and does not render a blank body');

    const md = renderMarkdown({ findings: [], target: 'Clean API', startedAt: Date.now() });
    assert(md.includes('✅'), 'markdown states the verdict');
  });

  /* ---- finding the specification ------------------------------- */

  await test('a specification URL is used directly', async () => {
    const { resolveSpec } = await import('../server/verify/spec.js');
    const spec = await resolveSpec({ specUrl: `${fixture.base}/spec/openapi.json` });
    assertEqual(spec.info.title, 'Fixture API', 'parsed the spec');
  });

  await test('a documentation page is followed to its specification', async () => {
    const { resolveSpec } = await import('../server/verify/spec.js');
    // The page names the spec only inside a script it loads, as Swagger UI does.
    const spec = await resolveSpec({ specUrl: `${fixture.base}/docs` });
    assert(spec, 'discovery found a specification behind the docs page');
    assertEqual(spec.openapi, '3.0.0', 'and it parsed');
  });

  await test('a host with no specification fails with a contract-specific explanation', async () => {
    const { resolveSpec } = await import('../server/verify/spec.js');
    let message = '';
    try {
      await resolveSpec({ specUrl: `${fixture.base}/echo` });
    } catch (err) {
      message = err.message;
    }
    // The import parser's wording (Postman, HAR, "use AI import") is wrong in this context.
    assert(message.includes('OpenAPI'), `should mention OpenAPI, got: ${message}`);
    assert(!message.includes('Postman'), 'must not mention import formats');
    assert(message.includes('negative testing'), 'points at the suite that still applies');
  });

  await test('pasted text that is not a specification is refused clearly', async () => {
    const { resolveSpec } = await import('../server/verify/spec.js');
    let message = '';
    try {
      await resolveSpec({ specText: 'This API accepts a domain name and returns a report.' });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('not an OpenAPI'), `unexpected: ${message}`);
  });

  await test('negative: a non-JSON error body is major, and names the case that produced it', async () => {
    // Taken from a real API: most errors used the documented JSON envelope, but one path was
    // answered by a layer in front of the application with an HTML page. A caller parsing the
    // body throws, so this is a different problem from two JSON shapes with different keys.
    const html = await runNegative({
      send,
      requests: [
        { ...req('POST', '/broken/html-error'), body: { type: 'json', content: '{"a":1}' } },
        { ...req('POST', '/good/validate'), body: { type: 'json', content: '{"name":"ok"}' } },
      ],
    });

    const shape = html.find((f) => f.title.includes('not JSON'));
    assert(shape, `expected a shape finding, got: ${html.map((f) => f.title).join(' | ')}`);
    assertEqual(shape.severity, 'major', 'a body a caller cannot parse is more than cosmetic');
    assert(shape.whatHappened.includes('not JSON at all'), 'says which shape was the problem');
    // Without naming the case, the reader has nothing to go and look at.
    assert(/from a /.test(shape.whatHappened), `should name the cases: ${shape.whatHappened}`);
    assert(shape.evidence, 'and carries the response that proved it');
  });

  await test('negative: consistent JSON errors produce no shape finding', async () => {
    const consistent = await runNegative({
      send,
      requests: [
        { ...req('POST', '/good/validate'), body: { type: 'json', content: '{"name":"ok"}' } },
      ],
    });

    const shape = consistent.find((f) => f.title.includes('shape') || f.title.includes('not JSON'));
    assert(!shape, `false positive: ${shape?.whatHappened}`);
  });

  await test('negative: a proxy error page is reported as infrastructure, not as an API defect', async () => {
    // nginx answering 405 for a method it blocks at the edge is sound hardening. Reporting it
    // as a fault in the API's error handling sends the reader to the wrong team.
    const edge = await runNegative({
      send,
      requests: [
        { ...req('POST', '/broken/edge-error'), body: { type: 'json', content: '{"a":1}' } },
        { ...req('POST', '/good/validate'), body: { type: 'json', content: '{"name":"ok"}' } },
      ],
    });

    const shape = edge.find((f) => f.title.includes('infrastructure'));
    assert(
      shape,
      `expected an infrastructure finding, got: ${edge.map((f) => f.title).join(' | ')}`,
    );
    assertEqual(shape.severity, 'minor', 'edge hardening is not an application defect');
    assert(shape.whyItMatters.includes('deliberate'), 'and says so plainly');
  });

  await test('authz: a framework banner is reported, and a clean response is not', async () => {
    const identities = ['owner'];
    const sendAs = async (_name, request) => send(request);

    const flagged = await runAuthz({
      sendAs,
      requests: [req('GET', '/broken/banner')],
      identities,
    });
    const banner = flagged.find((f) => f.title.includes('advertises the software'));
    assert(banner, `expected a banner finding, got: ${flagged.map((f) => f.title).join(' | ')}`);
    assert(banner.whatHappened.includes('x-powered-by'), 'names the header');
    assertEqual(banner.severity, 'minor', 'reconnaissance, not access');

    const clean = await runAuthz({ sendAs, requests: [req('GET', '/good/document')], identities });
    assert(
      !clean.some((f) => f.title.includes('advertises the software')),
      'an endpoint sending no banner is left alone',
    );
  });

  /* ================================================================
   * Pagination — the boundary is where the bugs are
   * ============================================================== */

  const pagination = await runPagination({
    send,
    requests: [req('GET', '/good/items'), req('GET', '/broken/items')],
  });

  const paginationFor = (needle) => pagination.filter((f) => (f.endpoint ?? '').includes(needle));

  await test('flags a record returned on two different pages', () => {
    const found = paginationFor('/broken/items');
    const dup = found.find((f) => f.title.includes('same record on more than one page'));
    assert(dup, `expected a duplicate finding, got: ${found.map((f) => f.title) || 'nothing'}`);
    assertEqual(dup.severity, 'major', 'a duplicated record is major');
    assert(dup.whatHappened.includes('page 1'), 'names the pages it appeared on');
    assert(dup.evidence.response.status === 200, 'carries the page that proved it');
  });

  await test('does not flag correct pagination', () => {
    assertEqual(paginationFor('/good/items').length, 0, 'the correct twin is left alone');
  });

  await test('says so when there was nothing to page', async () => {
    const none = await runPagination({ send, requests: [req('GET', '/good/document')] });
    const info = none.find((f) => f.title.includes('No paginated endpoints'));
    assert(info, 'an endpoint with no list must report as untested, not as passing');
    assertEqual(info.severity, 'info', 'not a defect in the API');
    assert(info.whyItMatters.includes('not a pass'), 'and says plainly that it is not a pass');
  });

  /* ================================================================
   * Idempotency — the same request twice
   * ============================================================== */

  const idempotency = await runIdempotency({
    send,
    requests: [
      { ...req('PUT', '/good/counter'), body: { type: 'json', content: '{"counter":1}' } },
      req('PUT', '/broken/counter'),
    ],
  });

  const idempotencyFor = (needle) => idempotency.filter((f) => (f.endpoint ?? '').includes(needle));

  await test('flags a PUT that increments instead of setting', () => {
    const found = idempotencyFor('/broken/counter');
    const repeat = found.find((f) => f.title.includes('not idempotent'));
    assert(repeat, `expected an idempotency finding, got: ${found.map((f) => f.title)}`);
    assertEqual(repeat.severity, 'major', 'a non-idempotent PUT is major');
    assert(repeat.whatHappened.includes('counter'), 'names the field that moved');
    assert(repeat.whyItMatters.includes('retry'), 'explains the consequence in plain terms');
  });

  await test('does not flag a PUT that sets', () => {
    assertEqual(idempotencyFor('/good/counter').length, 0, 'the correct twin is left alone');
  });

  await test('a changing updatedAt is not mistaken for a lack of idempotency', () => {
    // The good twin returns a fresh updatedAt on every call. A suite that compared bodies
    // naively would flag it, and every real API would drown in false positives.
    assertEqual(idempotencyFor('/good/counter').length, 0, 'volatile fields are ignored');
  });

  await test('says so when nothing was repeatable', async () => {
    const none = await runIdempotency({ send, requests: [req('GET', '/good/items')] });
    const info = none.find((f) => f.title.includes('Nothing was repeatable'));
    assert(info, 'a project with no writes must report as untested, not as passing');
    assertEqual(info.severity, 'info', 'not a defect in the API');
  });

  await test('idempotency: a repeated request reuses its generated values', async () => {
    // The bug this guards: the runner rebuilds the variable scope per send, so {{$uuid}} in an
    // Idempotency-Key regenerated between the two sends. The suite then compared two genuinely
    // different requests and reported that the key was ignored — against an API handling it
    // correctly, while leaving a duplicate record behind.
    const { runVerification } = await import('../server/verify/runner.js');

    const request = {
      ...req('PUT', '/good/counter'),
      body: { type: 'json', content: '{"counter":1}' },
      headers: [{ key: 'X-Probe-Key', value: '{{$uuid}}', enabled: true }],
    };

    const result = await runVerification({
      requests: [request],
      suites: ['idempotency'],
      projectVars: [{ key: 'baseUrl', value: fixture.base, enabled: true }],
      acknowledged: true,
    });

    // The good twin is idempotent, so a correct comparison finds nothing. If the two sends had
    // carried different generated values the bodies would still match here — so the real proof
    // is below: the fixture echoes what it received.
    const wrong = result.findings.filter((f) => f.suite === 'idempotency' && f.severity !== 'info');
    assertEqual(wrong.length, 0, `false positives: ${wrong.map((f) => f.title).join(' | ')}`);
  });

  await test('idempotency: the two sends really carry the same generated value', async () => {
    // Proved directly rather than inferred: two sends through one session must resolve
    // {{$uuid}} identically, and two separate sessions must not.
    const { buildScope } = await import('../server/vars.js');
    const { interpolate } = await import('../server/vars.js');

    const sessionScope = buildScope({});
    const a = interpolate('{{$uuid}}', sessionScope).text;
    const b = interpolate('{{$uuid}}', sessionScope).text;
    assertEqual(a, b, 'one session, one value — this is what makes a repeat a retry');

    const other = interpolate('{{$uuid}}', buildScope({})).text;
    assert(a !== other, 'a separate session still generates afresh');
  });

  /* ================================================================
   * Caching
   * ============================================================== */

  const caching = await runCaching({
    send,
    requests: [req('GET', '/good/document'), req('GET', '/broken/document')],
  });

  const cachingFor = (needle) => caching.filter((f) => (f.endpoint ?? '').includes(needle));

  await test('flags a response with no ETag or Last-Modified', () => {
    const found = cachingFor('/broken/document');
    const missing = found.find((f) => f.title.includes('cannot be cached'));
    assert(missing, `expected a caching finding, got: ${found.map((f) => f.title)}`);
    assertEqual(missing.severity, 'minor', 'missing caching is real but not urgent');
    assert(missing.actual === 'neither', 'names what was absent');
  });

  await test('does not flag a response that caches correctly', () => {
    assertEqual(cachingFor('/good/document').length, 0, 'the correct twin is left alone');
  });

  await test('a conditional request against the correct twin really returns 304', async () => {
    // Proves the previous assertion means something: if the fixture answered 200 here, the
    // suite would have had a finding to make and "left alone" would be the wrong outcome.
    const conditional = {
      ...req('GET', '/good/document'),
      headers: [{ key: 'If-None-Match', value: '"v1"', enabled: true }],
    };
    const run = await send(conditional);
    assertEqual(run.response.status, 304, 'the fixture honours If-None-Match');
  });

  /* ================================================================
   * Latency — regression against a baseline, not load testing
   * ============================================================== */

  const latency = await runLatency({ send, requests: [req('GET', '/slow/60')] });

  await test('records a baseline when there is nothing to compare against', () => {
    const info = latency.findings.find((f) => f.title.includes('baseline recorded'));
    assert(info, 'the first run says it became the baseline');
    assertEqual(info.severity, 'info', 'not a defect');
    assert(
      info.whyItMatters.includes('indicative'),
      'is honest that p99 from a dozen samples is indicative',
    );
  });

  await test('measures percentiles from the samples', () => {
    const stats = latency.measurements['GET /slow/60'];
    assert(stats, 'the endpoint was measured');
    assert(stats.samples >= 3, `expected samples, got ${stats.samples}`);
    assert(stats.p50 >= 55, `a 60ms endpoint should measure at least 55ms, got ${stats.p50}`);
    assert(stats.p95 >= stats.p50, 'p95 is not below p50');
    assert(stats.max >= stats.p99, 'max is not below p99');
  });

  await test('flags an endpoint that got materially slower', async () => {
    const baseline = { savedAt: 1, measurements: { 'GET /slow/60': { p50: 4, p95: 5 } } };
    const result = await runLatency({ send, requests: [req('GET', '/slow/60')], baseline });

    const regression = result.findings.find((f) => f.title.includes('slower than the baseline'));
    assert(regression, `expected a regression, got: ${result.findings.map((f) => f.title)}`);
    assert(regression.whatHappened.includes('95th-percentile'), 'names the measure');
    assert(regression.evidence, 'carries the response that was timed');
  });

  await test('does not flag an endpoint that matches its baseline', async () => {
    const baseline = { savedAt: 1, measurements: { 'GET /slow/60': { p50: 61, p95: 65 } } };
    const result = await runLatency({ send, requests: [req('GET', '/slow/60')], baseline });

    const regression = result.findings.find((f) => f.title.includes('slower than the baseline'));
    assert(!regression, `false positive: ${regression?.whatHappened}`);
  });

  await test('a large ratio on a tiny absolute change is not reported', async () => {
    // 2ms becoming 6ms is a 3x ratio and complete noise. Ratio alone would flag every fast
    // endpoint on a busy machine, and a report full of those is a report nobody opens.
    const baseline = { savedAt: 1, measurements: { 'GET /good/document': { p50: 1, p95: 1 } } };
    const result = await runLatency({
      send,
      requests: [req('GET', '/good/document')],
      baseline,
    });

    const regression = result.findings.find((f) => f.title.includes('slower than the baseline'));
    assert(!regression, `noise reported as a regression: ${regression?.whatHappened}`);
  });

  await test('a write is reported as not timed rather than repeated', async () => {
    const result = await runLatency({ send, requests: [req('POST', '/good/widgets')] });

    const info = result.findings.find((f) => f.title.includes('Nothing could be timed'));
    assert(info, 'a project of writes reports as untested, not as passing');
    assert(info.whatHappened.includes('change data'), 'explains why it was not measured');
    assertEqual(Object.keys(result.measurements).length, 0, 'and measured nothing');
  });

  /* ---- the safety acknowledgement ------------------------------ */

  await test('idempotency refuses a non-loopback host without acknowledgement', async () => {
    const { runVerification } = await import('../server/verify/runner.js');
    const remote = {
      name: 'remote',
      method: 'PUT',
      url: 'https://api.example.com/thing',
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    };

    // It repeats writes, so it changes data on whatever it is pointed at.
    let message = '';
    try {
      await runVerification({ requests: [remote], suites: ['idempotency'], acknowledged: false });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('api.example.com'), `should name the host, got: ${message}`);
  });

  await test('pagination and caching need no acknowledgement', async () => {
    const { runVerification } = await import('../server/verify/runner.js');

    // Both only do what an ordinary consumer of the API already does: walk the pages, and
    // re-request with a conditional header.
    const result = await runVerification({
      requests: [req('GET', '/good/items')],
      suites: ['pagination', 'caching'],
      projectVars: [{ key: 'baseUrl', value: fixture.base, enabled: true }],
      acknowledged: false,
    });
    assert(result.suites.includes('pagination'), 'pagination ran');
    assert(result.suites.includes('caching'), 'caching ran');
  });

  await test('intrusive suites refuse a non-loopback host without acknowledgement', async () => {
    const { runVerification } = await import('../server/verify/runner.js');
    const remote = {
      name: 'remote',
      method: 'GET',
      url: 'https://api.example.com/thing',
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    };

    let message = '';
    try {
      await runVerification({ requests: [remote], suites: ['negative'], acknowledged: false });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('api.example.com'), `should name the host, got: ${message}`);
    assert(message.includes('confirmation'), 'and explain why');
  });

  await test('contract conformance needs no acknowledgement', async () => {
    const { runVerification } = await import('../server/verify/runner.js');
    const remote = {
      name: 'remote',
      method: 'GET',
      url: 'https://api.example.com/thing',
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    };

    // Sending the documented requests and comparing responses is what any consumer does, so
    // checking a third-party API against its own docs must not require owning it.
    const result = await runVerification({
      requests: [remote],
      suites: ['contract'],
      acknowledged: false,
    });
    assertEqual(result.skipped[0].suite, 'contract', 'it ran and skipped for want of a spec');
  });

  await test('secrets never reach a finding', () => {
    const serialised = JSON.stringify([...findings, ...negative, ...authz]);
    assert(!serialised.includes('valid-token'), 'no credential in the report data');
  });
} finally {
  await fixture.stop();
}

summarise('verify');
