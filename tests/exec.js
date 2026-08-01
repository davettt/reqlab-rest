/**
 * Execution-engine tests against the fixture API (tests/fixtures/server.js).
 * Run: npm run test:exec
 */
import { test, assert, assertEqual, summarise } from './util.js';
import { startFixture } from './fixtures/server.js';
import { executeRequest, sanitiseRun, HttpRequestError } from '../server/exec/run.js';
import { buildScope } from '../server/vars.js';
import { encrypt } from '../server/crypto.js';
import { clearTokenCache } from '../server/exec/auth.js';

console.log('exec: reqlab-rest');

const fixture = await startFixture();
const other = await startFixture(); // second origin, for cross-origin redirect tests
const emptyScope = buildScope({});

const run = (def, options) => executeRequest(def, { scope: emptyScope, ...options });

try {
  /* ---- basics ------------------------------------------------- */

  await test('GET returns status, headers and a parsed textual body', async () => {
    const r = await run({ method: 'GET', url: `${fixture.base}/echo` });
    assertEqual(r.response.status, 200, 'status');
    assertEqual(r.response.bodyEncoding, 'utf8', 'textual body');
    assertEqual(JSON.parse(r.response.body).method, 'GET', 'echoed method');
    assert(r.response.sizeBytes > 0, 'size recorded');
  });

  await test('timing records each phase', async () => {
    // Addressed by hostname on purpose: an IP literal skips resolution entirely, so dnsMs
    // would legitimately be null and the assertion would be testing nothing.
    const r = await run({ method: 'GET', url: `http://localhost:${fixture.port}/slow/120` });
    assert(r.timing.dnsMs !== null, 'dns measured');
    assert(r.timing.connectMs !== null, 'connect measured');
    assert(r.timing.ttfbMs >= 100, `ttfb should reflect the 120ms delay, got ${r.timing.ttfbMs}`);
    assert(r.timing.totalMs >= r.timing.ttfbMs, 'total covers ttfb');
  });

  await test('query parameters are appended, disabled ones skipped', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/echo`,
      params: [
        { key: 'a', value: '1' },
        { key: 'skip', value: 'x', enabled: false },
      ],
    });
    const echoed = JSON.parse(r.response.body).query;
    assertEqual(echoed.a, '1', 'param sent');
    assertEqual(echoed.skip, undefined, 'disabled param not sent');
  });

  await test('binary responses come back base64, not mangled text', async () => {
    const r = await run({ method: 'GET', url: `${fixture.base}/binary` });
    assertEqual(r.response.bodyEncoding, 'base64', 'encoding');
    assertEqual(Buffer.from(r.response.body, 'base64')[1], 0x50, 'PNG signature preserved');
  });

  await test('set-cookie is parsed into attributes', async () => {
    const r = await run({ method: 'GET', url: `${fixture.base}/cookies` });
    assertEqual(r.response.cookies.length, 2, 'both cookies');
    const session = r.response.cookies.find((c) => c.name === 'session');
    assertEqual(session.httpOnly, true, 'httpOnly');
    assertEqual(session.sameSite, 'Lax', 'sameSite');
  });

  await test('a large response is truncated at the cap rather than buffered forever', async () => {
    const r = await run({ method: 'GET', url: `${fixture.base}/echo` }, { maxBodyBytes: 10 });
    assertEqual(r.response.truncated, true, 'flagged as truncated');
    assert(r.response.sizeBytes <= 10, 'capped');
  });

  /* ---- bodies ------------------------------------------------- */

  await test('JSON body is sent with the right content type', async () => {
    const r = await run({
      method: 'POST',
      url: `${fixture.base}/echo/body`,
      body: { type: 'json', content: '{"hello":"world"}' },
    });
    const echoed = JSON.parse(r.response.body);
    assertEqual(echoed.contentType, 'application/json', 'content type');
    assertEqual(echoed.body.hello, 'world', 'round trip');
  });

  await test('form body is urlencoded', async () => {
    const r = await run({
      method: 'POST',
      url: `${fixture.base}/echo/body`,
      body: { type: 'form', fields: [{ key: 'a', value: '1' }] },
    });
    const echoed = JSON.parse(r.response.body);
    assert(echoed.contentType.includes('urlencoded'), 'content type');
    assertEqual(echoed.body.a, '1', 'round trip');
  });

  await test('an explicit content-type header wins over the body type', async () => {
    // Sending the wrong declared type on purpose is a legitimate negative test, so the
    // engine must not "helpfully" correct it.
    const r = await run({
      method: 'POST',
      url: `${fixture.base}/echo/body`,
      headers: [{ key: 'content-type', value: 'text/plain' }],
      body: { type: 'json', content: '{"a":1}' },
    });
    assertEqual(JSON.parse(r.response.body).contentType, 'text/plain', 'user header preserved');
  });

  /* ---- auth --------------------------------------------------- */

  await test('bearer auth', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/auth/bearer`,
      auth: { type: 'bearer', token: 'valid-token' },
    });
    assertEqual(r.response.status, 200, 'authorised');
  });

  await test('basic auth', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/auth/basic`,
      auth: { type: 'basic', username: 'user', password: 'pass' },
    });
    assertEqual(r.response.status, 200, 'authorised');
  });

  await test('api key in a header', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/auth/api-key`,
      auth: { type: 'apiKey', in: 'header', key: 'X-API-Key', value: 'secret-key' },
    });
    assertEqual(r.response.status, 200, 'authorised');
  });

  await test('api key in the query string warns about the exposure', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/auth/api-key`,
      auth: { type: 'apiKey', in: 'query', key: 'api_key', value: 'secret-key' },
    });
    assertEqual(r.response.status, 200, 'authorised');
    assert(
      r.warnings.some((w) => w.includes('query string')),
      'should warn that the key lands in logs',
    );
  });

  await test('oauth2 client credentials fetches a token and caches it', async () => {
    clearTokenCache();
    const auth = {
      type: 'oauth2-cc',
      tokenUrl: `${fixture.base}/oauth/token`,
      clientId: 'client-id',
      clientSecret: 'client-secret',
    };
    const before = JSON.parse(
      (await run({ method: 'GET', url: `${fixture.base}/oauth/token-count` })).response.body,
    ).count;

    await run({ method: 'GET', url: `${fixture.base}/echo`, auth });
    await run({ method: 'GET', url: `${fixture.base}/echo`, auth });

    const after = JSON.parse(
      (await run({ method: 'GET', url: `${fixture.base}/oauth/token-count` })).response.body,
    ).count;
    assertEqual(after - before, 1, 'two requests must share one token');
  });

  await test('rotating the client secret invalidates the cached token', async () => {
    clearTokenCache();
    const base = {
      type: 'oauth2-cc',
      tokenUrl: `${fixture.base}/oauth/token`,
      clientId: 'client-id',
    };
    const countOf = async () =>
      JSON.parse(
        (await run({ method: 'GET', url: `${fixture.base}/oauth/token-count` })).response.body,
      ).count;

    const before = await countOf();
    await run({
      method: 'GET',
      url: `${fixture.base}/echo`,
      auth: { ...base, clientSecret: 'client-secret' },
    });
    await run({
      method: 'GET',
      url: `${fixture.base}/echo`,
      auth: { ...base, clientSecret: 'rotated-secret' },
    });
    assert((await countOf()) - before === 2, 'a changed secret must re-fetch');
  });

  await test('oauth2 refuses to send the client secret over cleartext http', async () => {
    clearTokenCache();
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/echo`,
      auth: {
        type: 'oauth2-cc',
        tokenUrl: 'http://api.example.com/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
    assert(
      r.warnings.some((w) => w.includes('plain http')),
      'must refuse and say why',
    );
    assertEqual(r.request.headers.authorization, undefined, 'no auth header applied');
  });

  /* ---- redirects ---------------------------------------------- */

  await test('redirects are followed and each hop recorded', async () => {
    const r = await run({ method: 'GET', url: `${fixture.base}/redirect/3` });
    assertEqual(r.response.status, 200, 'final status');
    assertEqual(r.redirects.length, 3, 'hop chain');
    assert(r.redirects[0].from.endsWith('/redirect/3'), 'first hop recorded');
  });

  await test('a redirect loop stops at the limit instead of spinning', async () => {
    const r = await run(
      { method: 'GET', url: `${fixture.base}/redirect/loop` },
      { maxRedirects: 3 },
    );
    assert(
      r.warnings.some((w) => w.includes('Stopped after 3 redirects')),
      'should stop and say so',
    );
  });

  await test('303 turns a POST into a GET without a body', async () => {
    const r = await run({
      method: 'POST',
      url: `${fixture.base}/redirect/see-other`,
      body: { type: 'json', content: '{"a":1}' },
    });
    assertEqual(JSON.parse(r.response.body).method, 'GET', 'method downgraded');
  });

  await test('credentials are dropped when a redirect crosses origins', async () => {
    const r = await run({
      method: 'GET',
      url: `${fixture.base}/redirect/cross-origin?port=${other.port}`,
      auth: { type: 'bearer', token: 'valid-token' },
    });
    const echoedHeaders = JSON.parse(r.response.body).headers;
    assertEqual(echoedHeaders.authorization, undefined, 'the other origin must not receive it');
    assert(
      r.warnings.some((w) => w.includes('dropped')),
      'the drop must be reported, not silent',
    );
  });

  /* ---- errors ------------------------------------------------- */

  await test('a connection refusal is explained in plain language', async () => {
    let message = '';
    try {
      await run({ method: 'GET', url: 'http://127.0.0.1:1/nothing' });
    } catch (err) {
      assert(err instanceof HttpRequestError, 'typed error');
      message = err.message;
    }
    assert(message.includes('Nothing is listening'), `unexpected message: ${message}`);
  });

  await test('an unresolvable host is explained', async () => {
    let message = '';
    try {
      await run({ method: 'GET', url: 'http://does-not-exist.invalid/x' });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('Could not resolve'), `unexpected message: ${message}`);
  });

  await test('a timeout names the host and the limit', async () => {
    let message = '';
    try {
      await run({ method: 'GET', url: `${fixture.base}/slow/3000` }, { timeoutMs: 300 });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('did not respond'), `unexpected message: ${message}`);
  });

  await test('a non-http scheme is refused before anything is sent', async () => {
    let message = '';
    try {
      await run({ method: 'GET', url: 'file:///etc/passwd' });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('Unsupported scheme'), `unexpected message: ${message}`);
  });

  await test('an invalid header name fails clearly without echoing the name', async () => {
    let message = '';
    try {
      await run({
        method: 'GET',
        url: `${fixture.base}/echo`,
        headers: [{ key: 'bad header name', value: 'x' }],
      });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('not valid'), `unexpected message: ${message}`);
    assert(!message.includes('bad header name'), 'must not echo a possibly-secret header name');
  });

  /* ---- secrets ------------------------------------------------ */

  await test('secrets are sent but never appear in the sanitised run record', async () => {
    const scope = buildScope({
      envVars: [{ key: 'token', value: encrypt('super-secret-token-value'), secret: true }],
    });

    const raw = await executeRequest(
      {
        method: 'GET',
        url: `${fixture.base}/echo`,
        headers: [{ key: 'x-custom', value: 'Bearer {{token}}' }],
        auth: { type: 'bearer', token: '{{token}}' },
      },
      { scope },
    );

    // It really was sent — the fixture echoes what it received.
    assert(
      JSON.parse(raw.response.body).headers['x-custom'].includes('super-secret-token-value'),
      'the real secret must reach the server',
    );

    const safe = sanitiseRun(raw, scope);
    const serialised = JSON.stringify(safe);
    assert(
      !serialised.includes('super-secret-token-value'),
      'no plaintext secret may survive sanitisation, including the response echo',
    );
    assertEqual(safe.request.headers.authorization, 'Bearer ••••', 'auth header masked by name');
  });
} finally {
  await fixture.stop();
  await other.stop();
}

summarise('exec');
