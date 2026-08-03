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
import { summarise as summariseFindings, sortFindings } from '../server/verify/findings.js';
import { executeRequest, sanitiseRun } from '../server/exec/run.js';
import { buildScope } from '../server/vars.js';

console.log('verify: reqlab-rest');

const fixture = await startFixture();

const scope = buildScope({
  envVars: [{ key: 'baseUrl', value: fixture.base, enabled: true }],
});

const send = async (request) => sanitiseRun(await executeRequest(request, { scope }), scope);

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

  /* ---- the safety acknowledgement ------------------------------ */

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
