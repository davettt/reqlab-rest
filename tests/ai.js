/**
 * AI import tests. Run: npm run test:ai
 *
 * No API key and no network: the provider call is stubbed, because what needs testing is our
 * handling of what a model returns — including when it returns something wrong. A model that
 * proposes a malformed request, or echoes a credential it found in the docs, is the case that
 * matters, and you cannot reliably provoke that against a live API.
 */
import { test, assert, assertEqual, summarise } from './util.js';
import { htmlToText } from '../server/import/ai.js';
import { MODELS, PROVIDERS } from '../server/ai/providers.js';

console.log('ai: reqlab-rest');

/* ---------------------------------------------------------------- *
 * Model configuration
 * ---------------------------------------------------------------- */

await test('model ids match build-policy/registry.json', async () => {
  const fs = await import('fs');
  const registry = JSON.parse(fs.readFileSync('../build-policy/registry.json', 'utf8'));

  assertEqual(MODELS.anthropic.fast, registry.entries['anthropic-model-fast'].value);
  assertEqual(MODELS.anthropic.smart, registry.entries['anthropic-model-smart'].value);
  assertEqual(MODELS.openai.fast, registry.entries['openai-model-fast'].value);
  assertEqual(MODELS.openai.smart, registry.entries['openai-model-smart'].value);
  assertEqual(PROVIDERS.length, 2, 'two providers');
});

/* ---------------------------------------------------------------- *
 * Extraction, with the provider stubbed
 * ---------------------------------------------------------------- */

/** A canned model response, injected through importWithAi's `complete` seam. */
const stub = (response) => ({ complete: async () => response });

const config = { provider: 'anthropic', tier: 'smart', apiKey: 'test-key' };

await test('a well-formed proposal becomes a validated request', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'Some prose about a weather API.',
    config,
    stub({
      summary: 'Weather API',
      requests: [
        {
          name: 'Current weather',
          method: 'GET',
          url: '{{baseUrl}}/weather',
          params: [{ key: 'city', value: 'London' }],
          headers: [],
          authType: 'apiKey',
          authIn: 'query',
          authKey: 'appid',
        },
      ],
      variables: [
        { key: 'baseUrl', value: 'https://api.weather.example', secret: false },
        { key: 'apiKey', value: '', secret: true },
      ],
    }),
  );

  assertEqual(result.requests.length, 1, 'one request');
  assertEqual(result.requests[0].method, 'GET', 'method');
  assertEqual(result.requests[0].auth.type, 'apiKey', 'auth type');
  assertEqual(result.requests[0].auth.in, 'query', 'auth location');
  assertEqual(result.requests[0].auth.value, '{{apiKey}}', 'auth references a variable');
  assertEqual(result.source, 'ai', 'source');
});

await test('every AI import carries a "this was inferred" warning', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({ requests: [{ name: 'x', method: 'GET', url: '{{baseUrl}}/x' }], variables: [] }),
  );

  assert(
    result.warnings.some((w) => w.includes('inferred from prose')),
    'the user must be told the requests are a guess',
  );
});

await test('a secret value proposed by the model is discarded', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [{ name: 'x', method: 'GET', url: '{{baseUrl}}/x' }],
      variables: [
        // Real documentation sometimes contains a genuine leaked key in an example.
        { key: 'apiKey', value: 'sk-live-leaked-from-the-docs', secret: true },
        { key: 'baseUrl', value: 'https://api.example.com', secret: false },
      ],
    }),
  );

  const serialised = JSON.stringify(result);
  assert(!serialised.includes('sk-live-leaked-from-the-docs'), 'a proposed secret is never kept');
  assertEqual(result.variables.find((v) => v.key === 'apiKey').value, '', 'left empty');
  assertEqual(
    result.variables.find((v) => v.key === 'baseUrl').value,
    'https://api.example.com',
    'non-secret values are kept',
  );
});

await test('a malformed proposal is skipped with a warning, not repaired', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        { name: 'Good', method: 'GET', url: '{{baseUrl}}/ok' },
        { name: 'Bad', method: 'TELEPORT', url: '{{baseUrl}}/nope' },
      ],
      variables: [],
    }),
  );

  assertEqual(result.requests.length, 1, 'only the valid one survives');
  assertEqual(result.requests[0].name, 'Good', 'the good one');
  assert(
    result.warnings.some((w) => w.includes('Skipped')),
    'and the skip is reported rather than silent',
  );
});

await test('an authorization header is not duplicated alongside the auth config', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'x',
          method: 'GET',
          url: '{{baseUrl}}/x',
          headers: [
            { key: 'Authorization', value: 'Bearer abc' },
            { key: 'Accept', value: 'application/json' },
          ],
          authType: 'bearer',
        },
      ],
      variables: [],
    }),
  );

  const headers = result.requests[0].headers.map((h) => h.key.toLowerCase());
  assert(!headers.includes('authorization'), 'auth lives in the auth config, not a header');
  assert(headers.includes('accept'), 'other headers are kept');
});

await test('baseUrl falls back to the origin the docs came from', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi('prose', config, {
    ...stub({
      // The model found endpoints but no base URL — the common case for docs that show
      // only paths, which is exactly what left requests unusable before.
      requests: [{ name: 'Reputation', method: 'GET', url: '{{baseUrl}}/api/v2' }],
      variables: [],
    }),
    sourceUrl: 'https://domain-reputation.whoisxmlapi.com/api/documentation/making-requests',
  });

  assertEqual(
    result.variables.find((v) => v.key === 'baseUrl').value,
    'https://domain-reputation.whoisxmlapi.com',
    'origin of the docs page is used',
  );
  assert(
    result.warnings.some((w) => w.includes('did not state a base URL')),
    'and the guess is disclosed',
  );
});

await test('a baseUrl the model did supply is not overwritten', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi('prose', config, {
    ...stub({
      requests: [{ name: 'x', method: 'GET', url: '{{baseUrl}}/x' }],
      variables: [{ key: 'baseUrl', value: 'https://api.stated-in-docs.com', secret: false }],
    }),
    sourceUrl: 'https://docs.example.com/page',
  });

  assertEqual(
    result.variables.find((v) => v.key === 'baseUrl').value,
    'https://api.stated-in-docs.com',
    'the documented value wins over the fallback',
  );
});

await test('other empty variables are named so they are not discovered mid-request', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [{ name: 'x', method: 'GET', url: '{{baseUrl}}/x/{{domainName}}' }],
      variables: [
        { key: 'baseUrl', value: 'https://api.example.com', secret: false },
        { key: 'domainName', value: '', secret: false },
      ],
    }),
  );

  assert(
    result.warnings.some((w) => w.includes('domainName')),
    'an empty variable is reported',
  );
});

await test('filler values become variables instead of being sent literally', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'Reputation',
          method: 'GET',
          url: '{{baseUrl}}/api/v2',
          params: [
            // What a model reaches for when the docs give no example. Sent literally, these
            // produce a confusing upstream error rather than an obviously-empty field.
            { key: 'domainName', value: '<UNKNOWN>' },
            { key: 'token', value: 'YOUR_API_KEY' },
            { key: 'mode', value: 'fast', optional: true, options: ['fast', 'full'] },
          ],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  const request = result.requests[0];
  const params = request.params;
  assertEqual(params.find((p) => p.key === 'domainName').value, '{{domainName}}', 'placeholder');
  assertEqual(params.find((p) => p.key === 'mode').value, 'fast', 'a real value is untouched');

  // "token" is a credential name, so it is promoted to the Auth tab rather than left as a
  // query parameter — the filler value having been turned into a variable first.
  assertEqual(
    params.find((p) => p.key === 'token'),
    undefined,
    'the credential no longer sits in params',
  );
  assertEqual(request.auth.type, 'apiKey', 'promoted to auth');
  assertEqual(request.auth.key, 'token', 'keeps the documented parameter name');
  assertEqual(request.auth.value, '{{token}}', 'keeps the variable reference');

  // The invented variables must exist, or the request fails with an unresolved placeholder.
  assert(
    result.variables.some((v) => v.key === 'domainName'),
    'the variable it now references was created',
  );
});

await test('optional parameters keep their options and stay unchecked', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'x',
          method: 'GET',
          url: '{{baseUrl}}/x',
          params: [
            { key: 'required', value: 'a' },
            {
              key: 'outputFormat',
              value: 'JSON',
              optional: true,
              options: ['JSON', 'XML'],
              description: 'Response output format.',
            },
          ],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  const optional = result.requests[0].params.find((p) => p.key === 'outputFormat');
  assertEqual(optional.enabled, false, 'optional stays unchecked');
  assertEqual(optional.options.join('|'), 'JSON|XML', 'accepted values carried');
  assertEqual(result.requests[0].params.find((p) => p.key === 'required').enabled, true);
});

await test('a credential listed both in auth and in params is not sent twice', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'Reputation',
          method: 'GET',
          url: '{{baseUrl}}/api/v2',
          // What the model actually returns for docs that show the key as a query
          // parameter: auth configured AND the same key repeated in params.
          authType: 'apiKey',
          authIn: 'query',
          authKey: 'apiKey',
          params: [
            { key: 'apiKey', value: '' },
            { key: 'domainName', value: 'example.com' },
          ],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  const request = result.requests[0];
  assertEqual(request.auth.type, 'apiKey', 'auth kept');
  assertEqual(
    request.params.find((p) => p.key === 'apiKey'),
    undefined,
    'the duplicate parameter is removed — otherwise an empty apiKey rides alongside the real one',
  );
  assertEqual(request.params.length, 1, 'the real parameter survives');
});

await test('a pagination token is NOT mistaken for a credential', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'List',
          method: 'GET',
          url: '{{baseUrl}}/items',
          params: [
            { key: 'page_token', value: 'abc' },
            { key: 'next_cursor', value: 'xyz' },
          ],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  const request = result.requests[0];
  // Moving a page cursor into the auth slot would break pagination in a way that is hard to
  // spot, so the credential match excludes them explicitly.
  assertEqual(request.auth.type, 'none', 'no auth was invented');
  assertEqual(request.params.length, 2, 'both parameters stay where they were');
});

await test('a path variable repeated as a query parameter is unticked and reported', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      // What the model produced for JSONPlaceholder: it conflated GET /posts/1 with
      // GET /comments?postId=1, producing /posts/{{postId}}?postId=...
      requests: [
        {
          name: 'Get post',
          method: 'GET',
          url: '{{baseUrl}}/posts/{{postId}}',
          params: [
            { key: 'postId', value: '1' },
            { key: 'unrelated', value: 'x' },
          ],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  const params = result.requests[0].params;
  assertEqual(params.find((p) => p.key === 'postId').enabled, false, 'the duplicate is unticked');
  assertEqual(params.find((p) => p.key === 'unrelated').enabled, true, 'others are untouched');
  assert(
    result.warnings.some((w) => w.includes('appears in the path')),
    'and the change is reported so it can be undone',
  );
});

await test('body example values are kept inline rather than turned into variables', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'Create post',
          method: 'POST',
          url: '{{baseUrl}}/posts',
          bodyJson: '{"title":"foo","body":"bar","userId":1}',
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  // A body carrying the documented example values is runnable as imported; one made of
  // empty {{variables}} cannot be sent until the user invents values for them.
  const body = result.requests[0].body.content;
  assert(!body.includes('{{'), `body should hold real values, got: ${body}`);
  assertEqual(JSON.parse(body).title, 'foo', 'the documented example survived');
});

await test('resource ids stay in the request, not the environment', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        { name: 'Get post', method: 'GET', url: '{{baseUrl}}/posts/{{postId}}' },
        { name: 'Delete post', method: 'DELETE', url: '{{baseUrl}}/posts/{{postId}}' },
        { name: 'Secured', method: 'GET', url: '{{baseUrl}}/me', authType: 'bearer' },
      ],
      variables: [
        { key: 'baseUrl', value: 'https://api.example.com' },
        { key: 'postId', value: '1' },
      ],
    }),
  );

  // An id in the environment would mean the GET and the DELETE always act on the same
  // record, and changing it for one silently changes what the other destroys.
  assertEqual(result.requests[0].url, '{{baseUrl}}/posts/1', 'id inlined');
  assertEqual(result.requests[1].url, '{{baseUrl}}/posts/1', 'each request carries its own');

  assert(
    !result.variables.some((v) => v.key === 'postId'),
    'the id is no longer an environment variable',
  );
  assert(
    result.variables.some((v) => v.key === 'baseUrl'),
    'the base URL still is — it changes between deployments',
  );
  assert(
    result.variables.some((v) => v.key === 'apiKey' && v.secret),
    'and so is the credential',
  );
});

await test('the same endpoint described twice becomes one request', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        { name: 'List comments', method: 'GET', url: '{{baseUrl}}/comments' },
        // The richer description wins, rather than whichever the model emitted first.
        {
          name: 'Comments by post',
          method: 'GET',
          url: '{{baseUrl}}/comments',
          params: [{ key: 'postId', value: '1' }],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  assertEqual(result.requests.length, 1, 'deduplicated');
  assertEqual(result.requests[0].params.length, 1, 'kept the one with parameters');
});

await test('a request with no endpoint path is flagged', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      // Model variance: the same docs sometimes yield {{baseUrl}}/api/v2 and sometimes just
      // {{baseUrl}}. The second fails in a way that looks like a network fault.
      requests: [{ name: 'x', method: 'GET', url: '{{baseUrl}}' }],
      variables: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    }),
  );

  assert(
    result.warnings.some((w) => w.includes('no endpoint path')),
    'the missing path is called out',
  );
});

await test('no extractable requests is an error, not an empty success', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  let message = '';
  try {
    await importWithAi('prose', config, stub({ requests: [], variables: [] }));
  } catch (err) {
    message = err.message;
  }
  assert(message.includes('No requests could be extracted'), `unexpected: ${message}`);
});

await test('empty input is refused before any call is made', async () => {
  const { importWithAi } = await import('../server/import/ai.js');
  let threw = false;
  try {
    await importWithAi('   ', config);
  } catch {
    threw = true;
  }
  assert(threw, 'should refuse');
});

/* ---------------------------------------------------------------- *
 * HTML stripping
 * ---------------------------------------------------------------- */

await test('html is reduced to readable prose', () => {
  const html = `
    <html><head><style>.x{color:red}</style><script>alert(1)</script></head>
    <body>
      <h1>Weather API</h1>
      <p>Call <code>GET /weather</code> with <b>city</b>.</p>
      <li>Requires an API key</li>
    </body></html>`;

  const text = htmlToText(html);
  assert(!text.includes('alert(1)'), 'script contents dropped');
  assert(!text.includes('color:red'), 'style contents dropped');
  assert(!text.includes('<'), 'no tags remain');
  assert(text.includes('GET /weather'), 'the useful content survives');
  assert(text.includes('Requires an API key'), 'list items survive');
});

await test('html entities are decoded', () => {
  assertEqual(htmlToText('<p>a &amp; b &lt;c&gt;</p>').trim(), 'a & b <c>');
});

await test('a path id repeated as a query parameter is unticked, whatever it is called', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        // The model names the same value twice over: postId in the path, id in the params.
        {
          name: 'Get post',
          method: 'GET',
          url: '{{baseUrl}}/posts/{{postId}}',
          params: [
            { key: 'id', value: '1' },
            { key: 'fields', value: 'title' },
          ],
        },
      ],
      variables: [
        { key: 'baseUrl', value: 'https://api.example.com' },
        { key: 'postId', value: '1' },
      ],
    }),
  );

  const params = result.requests[0].params;
  assertEqual(result.requests[0].url, '{{baseUrl}}/posts/1', 'the id is inlined into the path');

  // Sending ?id=1 alongside /posts/1 is at best redundant and at worst a different endpoint.
  assertEqual(params.find((p) => p.key === 'id').enabled, false, 'the duplicate is unticked');
  assertEqual(params.find((p) => p.key === 'fields').enabled, true, 'real parameters are kept');

  assert(
    result.warnings.some((w) => w.includes('appears in the path')),
    'and the user is told why it is unticked, rather than finding it unexplained',
  );
});

await test('an id copied from the path into Params is unticked, with no variable involved', async () => {
  const { importWithAi } = await import('../server/import/ai.js');

  // These are the shapes a real jsonplaceholder import produced: the model writes the docs'
  // example address literally, then lists the same id under parameters as well.
  const result = await importWithAi(
    'prose',
    config,
    stub({
      requests: [
        {
          name: 'Get post',
          method: 'GET',
          url: '{{baseUrl}}/posts/1',
          params: [{ key: 'id', value: '1', description: 'Post ID' }],
        },
        {
          name: 'Post comments',
          method: 'GET',
          url: '{{baseUrl}}/posts/1/comments',
          params: [{ key: 'id', value: '1', description: 'Post ID' }],
        },
        // The legitimate case, and the one that proves the check is not just unticking
        // everything: /comments?postId=1 is how the endpoint is actually addressed. The id
        // is nowhere in the path, so the parameter is the only thing making the request work.
        {
          name: 'Comments for a post',
          method: 'GET',
          url: '{{baseUrl}}/comments',
          params: [{ key: 'postId', value: '1', description: 'Post ID to filter comments' }],
        },
        // A parameter that happens to match a path segment but is not an identifier.
        {
          name: 'Filtered',
          method: 'GET',
          url: '{{baseUrl}}/posts',
          params: [{ key: 'status', value: 'posts' }],
        },
      ],
      variables: [{ key: 'baseUrl', value: 'https://jsonplaceholder.typicode.com' }],
    }),
  );

  const [post, comments, filter, status] = result.requests;

  assertEqual(post.params[0].enabled, false, '/posts/1 does not also need ?id=1');
  assertEqual(comments.params[0].enabled, false, 'the id is mid-path, but still duplicated');
  assertEqual(filter.params[0].enabled, true, '?postId=1 on /comments is the real parameter');
  assertEqual(status.params[0].enabled, true, 'a non-identifier is left alone');
});

summarise('ai');
