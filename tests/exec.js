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

  await test('an unresolved variable in the URL names the variable, not "invalid URL"', async () => {
    let message = '';
    try {
      await run({ method: 'GET', url: '{{baseUrl}}/api/v2' });
    } catch (err) {
      message = err.message;
    }
    // The real cause is an empty or unselected environment; saying "not a valid URL" sends
    // people hunting for a typo instead.
    assert(message.includes('{{baseUrl}}'), `should name the variable, got: ${message}`);
    assert(message.includes('environment'), 'and point at the environment');
  });

  await test('a URL holding an unresolved variable is refused, not sent literally', async () => {
    let message = '';
    try {
      // This parses fine — braces percent-encode — so it used to be sent as a request for a
      // path called %7B%7BpostId%7D%7D, and the API answered with a confusing 404.
      await run({ method: 'GET', url: `${fixture.base}/posts/{{postId}}` });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('{{postId}}'), `should name the variable, got: ${message}`);
    assert(message.includes('environment'), 'and say where to set it');
  });

  await test('an unresolved variable in a JSON body is refused too', async () => {
    let message = '';
    try {
      // The imported POST /posts body is {"title":"{{title}}", ...}. Unset, the placeholders
      // stayed literal, broke the JSON, and were sent — surfacing as a parse complaint from
      // the API rather than "you have not set title".
      await run({
        method: 'POST',
        url: `${fixture.base}/echo/body`,
        body: { type: 'json', content: '{"title":"{{title}}","userId":{{userId}}}' },
      });
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('{{title}}'), `should name the variables, got: ${message}`);
    assert(message.includes('{{userId}}'), 'both of them');
  });

  await test('deliberately malformed JSON is still sendable', async () => {
    // Negative testing depends on this: broken input the user typed is a legitimate request,
    // unlike a placeholder that was never filled in.
    const r = await run({
      method: 'POST',
      url: `${fixture.base}/echo/body`,
      body: { type: 'json', content: '{"broken": ' },
    });
    assert(r.response.status >= 400, 'the server answered, so it was sent');
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
  /* ---------------------------------------------------------------- *
   * Credentials that cannot be put on the wire
   * ---------------------------------------------------------------- */

  await test('a homoglyph in an API key is explained, without showing the key', async () => {
    // The reported case: a Cyrillic Te (U+0422) pasted in place of a Latin T. The platform's own
    // error is "Cannot convert argument to a ByteString because the character at index 14 has a
    // value of 1058", which is unreadable and quotes part of a credential back to the browser.
    const request = {
      name: 'homoglyph',
      method: 'GET',
      url: `${fixture.base}/echo`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'apiKey', in: 'header', key: 'X-API-Key', value: 'abcdefghijklmn\u0422opqr' },
    };

    const run = await executeRequest(request, { scope: buildScope({}) }).catch((err) => err);

    assert(run instanceof Error, 'the send fails rather than going out mangled');
    assert(run.message.includes('API key'), `should name the field: ${run.message}`);
    assert(
      run.message.includes('Cyrillic'),
      'and identify the script, which is what makes it findable',
    );
    assert(run.message.includes('position 15'), 'and say where');

    // The point of the rewrite: the credential does not appear in the message.
    assert(!run.message.includes('abcdefghijklmn'), 'the key is not echoed');
    assert(!run.message.includes('1058'), 'nor a character code from it');
    assert(!run.message.includes('ByteString'), 'and the platform wording is gone');
  });

  await test('a newline pasted into a bearer token is named for what it is', async () => {
    const request = {
      name: 'newline',
      method: 'GET',
      url: `${fixture.base}/echo`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'bearer', token: 'tok\nen' },
    };

    const err = await executeRequest(request, { scope: buildScope({}) }).catch((e) => e);
    // "a line break" rather than "a control character": the reader has to recognise it in
    // something they pasted, and the category name does not help them do that.
    assert(err.message.includes('line break'), `unexpected: ${err.message}`);
    assert(err.message.includes('bearer token'), 'names the field');
  });

  await test('every unsendable character is reported, not just the first', async () => {
    // Taken from a real clipboard: two adjacent Cyrillic letters and a trailing line break.
    // A word processor that substituted one lookalike usually substituted its neighbours too,
    // and reporting them one send at a time turns one paste mistake into a guessing game.
    const request = {
      name: 'several',
      method: 'GET',
      url: `${fixture.base}/echo`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: {
        type: 'apiKey',
        in: 'header',
        key: 'X-API-Key',
        value: 'abcdefghijklmnТХpqrstuv\nmore',
      },
    };

    const err = await executeRequest(request, { scope: buildScope({}) }).catch((e) => e);

    assert(err.message.includes('3 characters'), `should count them: ${err.message}`);
    assert(err.message.includes('position 15'), 'the first');
    assert(err.message.includes('position 16'), 'the second, adjacent to it');
    assert(err.message.includes('line break'), 'and the line break');
    assert(!err.message.includes('abcdefghijklmn'), 'still without echoing the credential');
  });

  await test('a normal credential is unaffected', async () => {
    const request = {
      name: 'clean',
      method: 'GET',
      url: `${fixture.base}/auth/bearer`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'bearer', token: 'valid-token' },
    };

    const run = await executeRequest(request, { scope: buildScope({}) });
    assertEqual(run.response.status, 200, 'the check does not reject a good token');
  });

  await test('a non-ASCII API key in the query string is still allowed', async () => {
    // Query values are percent-encoded, so they survive characters a header cannot carry.
    // Rejecting them would refuse a request the transport handles perfectly well.
    const request = {
      name: 'query key',
      method: 'GET',
      url: `${fixture.base}/echo`,
      params: [],
      headers: [],
      body: { type: 'none' },
      auth: { type: 'apiKey', in: 'query', key: 'api_key', value: '\u0422odd' },
    };

    const run = await executeRequest(request, { scope: buildScope({}) });
    assertEqual(run.response.status, 200, 'sent without complaint');
  });
} finally {
  await fixture.stop();
  await other.stop();
}

summarise('exec');
