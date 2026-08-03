/**
 * Code export tests. Run: npm run test:codegen
 *
 * The load-bearing assertion is the same in every target: a snippet is meant to be pasted
 * somewhere — a terminal, a file, a chat message — so a real credential must not be in it
 * unless it was explicitly asked for.
 */
import vm from 'node:vm';
import { test, assert, assertEqual, summarise } from './util.js';
import { generate, TARGETS } from '../server/codegen/index.js';
import { buildScope } from '../server/vars.js';
import { encrypt } from '../server/crypto.js';

console.log('codegen: reqlab-rest');

const SECRET = 'sk-live-must-never-be-emitted';

const scope = buildScope({
  envVars: [
    { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
    { key: 'apiToken', value: encrypt(SECRET), secret: true, enabled: true },
  ],
});

const request = {
  name: 'Create payment',
  method: 'POST',
  url: '{{baseUrl}}/v1/payments',
  params: [{ key: 'expand', value: 'customer', enabled: true }],
  headers: [{ key: 'X-Idempotency-Key', value: 'abc-123', enabled: true }],
  body: { type: 'json', content: '{"amount":100,"currency":"GBP","live":true}' },
  auth: { type: 'bearer', token: '{{apiToken}}' },
  assertions: [],
  captures: [],
};

/* ---------------------------------------------------------------- *
 * The guarantee, across every target
 * ---------------------------------------------------------------- */

for (const target of TARGETS) {
  await test(`${target}: never emits a real secret by default`, () => {
    const { code, secrets } = generate(request, scope, target);
    assert(!code.includes(SECRET), `${target} leaked the token`);
    assertEqual(secrets[0], 'API_TOKEN', 'reports the env var it expects');
    assert(code.includes('API_TOKEN'), 'references the env var in the snippet');
  });

  await test(`${target}: resolves non-secret variables`, () => {
    const { code } = generate(request, scope, target);
    assert(
      code.includes('https://api.example.com/v1/payments'),
      `${target} did not resolve baseUrl`,
    );
    assert(code.includes('expand=customer'), `${target} dropped the query parameter`);
  });
}

await test('inlineSecrets is opt-in, and says so', () => {
  const { code, notes } = generate(request, scope, 'curl', { inlineSecrets: true });
  assert(code.includes(SECRET), 'the real value should appear when explicitly requested');
  assert(
    notes.some((n) => n.includes('Do not commit')),
    'and the snippet should carry a warning',
  );
});

/* ---------------------------------------------------------------- *
 * Per-target shape
 * ---------------------------------------------------------------- */

await test('curl: shell-quotes and expands the variable', () => {
  const { code } = generate(request, scope, 'curl');
  assert(code.startsWith('curl -X POST'), 'method');
  assert(code.includes("-H 'X-Idempotency-Key: abc-123'"), 'header');
  assert(code.includes('-d '), 'body');

  // Asserted as a whole line, not a substring: a broken escaping order produces
  // '\''"$API_TOKEN"'\' which still *contains* the expected fragment while being a
  // different, broken command. A substring check passed straight through that bug.
  const authLine = code.split('\n').find((line) => line.includes('Authorization'));
  assertEqual(
    authLine.trim(),
    `-H 'Authorization: Bearer '"$API_TOKEN" \\`,
    'the shell variable must sit outside the quotes, unescaped',
  );
});

await test('fetch: valid JS with process.env interpolation', () => {
  const { code } = generate(request, scope, 'fetch');
  assert(code.includes('await fetch('), 'uses fetch');
  assert(code.includes('${process.env.API_TOKEN}'), 'env interpolation');
  assert(code.includes('method: "POST"'), 'method');
  // Compile-only: a snippet that does not parse is worse than no snippet. vm.Script
  // compiles and throws on a syntax error without ever running the body — deliberately not
  // new Function(), which reads like (and can become) execution of generated text.
  new vm.Script(`(async () => { ${code} })`);
});

await test('tanstack: useQuery for reads, useMutation for writes', () => {
  const read = generate({ ...request, method: 'GET', body: { type: 'none' } }, scope, 'tanstack');
  assert(read.code.includes('useQuery'), 'GET becomes a query');
  assert(read.code.includes('useCreatePayment'), 'hook named from the request');

  const write = generate(request, scope, 'tanstack');
  assert(write.code.includes('useMutation'), 'POST becomes a mutation');
});

await test('axios: emits a config object with the body as data', () => {
  const { code } = generate(request, scope, 'axios');
  assert(code.includes("import axios from 'axios'"), 'import');
  assert(code.includes('method: "post"'), 'lowercased method');
  assert(code.includes('data: {'), 'json body inlined as an object');
});

await test('python: body literal is indented to match its call', () => {
  const { code } = generate(request, scope, 'python');
  const lines = code.split('\n');
  const start = lines.findIndex((l) => l.includes('json='));
  // Continuation lines of the dict must be indented past the `json=` line, or the snippet
  // reads as broken even though Python accepts it.
  const continuation = lines[start + 1];
  assert(
    continuation.startsWith('        '),
    `dict body should be indented, got: ${JSON.stringify(continuation)}`,
  );
});

await test('python: uses os.environ and converts JSON literals', () => {
  const { code } = generate(request, scope, 'python');
  assert(code.includes('import requests'), 'import');
  assert(code.includes("os.environ['API_TOKEN']"), 'env lookup');
  assert(code.includes('True'), 'JSON true became Python True');
  assert(!code.includes('true'), 'and no JSON literal survived');
});

/* ---------------------------------------------------------------- *
 * Awkward cases
 * ---------------------------------------------------------------- */

await test('basic auth with a secret stays symbolic rather than fake-encoded', () => {
  const withBasic = {
    ...request,
    auth: { type: 'basic', username: 'admin', password: '{{apiToken}}' },
  };
  const { code } = generate(withBasic, scope, 'curl');
  assert(!code.includes(SECRET), 'no plaintext');
  assert(
    !/Basic [A-Za-z0-9+/]{20,}=*/.test(code),
    'must not emit base64 that looks like a real credential but encodes a placeholder',
  );
  assert(code.includes('base64 of'), 'explains what to encode instead');
});

await test('oauth2 explains the token exchange instead of pretending', () => {
  const withOauth = {
    ...request,
    auth: {
      type: 'oauth2-cc',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'id',
      clientSecret: '{{apiToken}}',
      clientAuth: 'header',
    },
  };
  const { code, notes } = generate(withOauth, scope, 'fetch');
  assert(code.includes('OAuth2'), 'the snippet says where the token goes');
  assert(
    notes.some((n) => n.includes('token exchange')),
    'and a note explains the missing step',
  );
});

await test('a quote in the body does not break the curl snippet', () => {
  const tricky = {
    ...request,
    body: { type: 'json', content: `{"note":"it's fine"}` },
  };
  const { code } = generate(tricky, scope, 'curl');
  assert(code.includes(`'\\''`), 'single quote is shell-escaped');
});

await test('an unknown target is rejected', () => {
  let threw = false;
  try {
    generate(request, scope, 'cobol');
  } catch {
    threw = true;
  }
  assert(threw, 'should refuse');
});

summarise('codegen');
