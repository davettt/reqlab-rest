/**
 * API tests: the route layer over a real server, talking to the fixture API.
 * Run: npm run test:api
 */
import { startServer, test, assert, assertEqual, summarise } from './util.js';
import { startFixture } from './fixtures/server.js';
import { readPath } from '../server/exec/assert.js';

console.log('api: reqlab-rest');

const server = await startServer();
const fixture = await startFixture();

const api = async (method, path, body) => {
  const res = await fetch(`${server.base}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

try {
  /* ---- path reader (pure, but load-bearing for assertions) ---- */

  await test('readPath walks objects, arrays and missing branches', () => {
    const doc = { data: { items: [{ id: 7 }, { id: 8 }] } };
    assertEqual(readPath(doc, 'data.items[1].id'), 8, 'indexed');
    assertEqual(readPath(doc, 'data.missing.deep'), undefined, 'missing is undefined, not a throw');
    assertEqual(readPath(doc, 'data.items[9].id'), undefined, 'out of range');
    assertEqual(readPath(doc, 'data.items[abc]'), undefined, 'malformed index rejected');
    // The path is user input, so it must not be able to walk into the prototype chain.
    assertEqual(readPath(doc, '__proto__'), undefined, 'prototype access refused');
    assertEqual(readPath(doc, 'constructor.name'), undefined, 'constructor access refused');
    assertEqual(
      readPath(doc, 'data.toString'),
      undefined,
      'inherited members are not own properties',
    );
  });

  /* ---- projects ---------------------------------------------- */

  let projectId;

  await test('create a project', async () => {
    const r = await api('POST', '/projects', { name: 'Payments API' });
    assertEqual(r.status, 201, 'status');
    assert(r.headers.get('location'), 'Location header on create');
    assertEqual(r.body.name, 'Payments API', 'name');
    projectId = r.body.id;
  });

  await test('reject an invalid project with field-level detail', async () => {
    const r = await api('POST', '/projects', { name: '' });
    assertEqual(r.status, 400, 'status');
    assert(r.body.issues?.length > 0, 'should say which field was wrong');
    assertEqual(r.body.issues[0].field, 'name', 'names the field');
  });

  await test('list projects', async () => {
    const r = await api('GET', '/projects');
    assert(
      r.body.projects.some((p) => p.id === projectId),
      'created project is listed',
    );
  });

  await test('a missing project is 404, not 500', async () => {
    assertEqual((await api('GET', '/projects/does-not-exist')).status, 404, 'status');
  });

  await test('a traversal id is rejected as a bad request', async () => {
    const res = await fetch(`${server.base}/api/projects/..%2F..%2Fetc`);
    assert(res.status === 400 || res.status === 404, `expected 400/404, got ${res.status}`);
  });

  /* ---- secrets ----------------------------------------------- */

  let environmentId;

  await test('a secret variable is never returned in plaintext', async () => {
    const r = await api('POST', `/projects/${projectId}/environments`, {
      name: 'staging',
      variables: [
        { key: 'baseUrl', value: fixture.base },
        // Deliberately the token the fixture accepts: if the secret survives the mask
        // round-trip the request 200s, and if it is wiped it 401s. A secret the fixture
        // rejects would 401 either way and the test would prove nothing.
        { key: 'token', value: 'valid-token', secret: true },
      ],
    });
    assertEqual(r.status, 201, 'status');
    environmentId = r.body.id;

    const token = r.body.variables.find((v) => v.key === 'token');
    assertEqual(token.value, '••••', 'masked on the way out');
    assert(!JSON.stringify(r.body).includes('valid-token'), 'no plaintext anywhere');
  });

  await test('saving a masked value preserves the stored secret', async () => {
    // This is what the UI does: read an environment, edit one field, send it all back.
    const read = await api('GET', `/projects/${projectId}/environments`);
    const environment = read.body.environments.find((e) => e.id === environmentId);

    const updated = await api('PATCH', `/projects/${projectId}/environments/${environmentId}`, {
      name: 'staging (renamed)',
      variables: environment.variables, // token is still the mask
    });
    assertEqual(updated.status, 200, 'status');

    // The proof is behavioural: the secret still works when used.
    const run = await api('POST', '/run', {
      projectId,
      environmentId,
      request: {
        name: 'check',
        method: 'GET',
        url: '{{baseUrl}}/auth/bearer',
        auth: { type: 'bearer', token: '{{token}}' },
      },
    });
    assertEqual(
      run.body.response.status,
      200,
      'the stored secret must survive a mask round-trip — a wiped secret would 401 here',
    );
  });

  /* ---- requests and running ---------------------------------- */

  let requestId;

  await test('save a request', async () => {
    const r = await api('POST', `/projects/${projectId}/requests`, {
      name: 'Echo',
      method: 'GET',
      url: '{{baseUrl}}/echo',
      params: [{ key: 'q', value: 'hello' }],
    });
    assertEqual(r.status, 201, 'status');
    requestId = r.body.id;
  });

  await test('run a saved request with an environment', async () => {
    const r = await api('POST', '/run', { projectId, requestId, environmentId });
    assertEqual(r.status, 200, 'status');
    assertEqual(r.body.response.status, 200, 'upstream status');
    assertEqual(JSON.parse(r.body.response.body).query.q, 'hello', 'params sent');
    assert(r.body.timing.totalMs >= 0, 'timing reported');
  });

  await test('run an unsaved request (send before saving)', async () => {
    const r = await api('POST', '/run', {
      projectId,
      environmentId,
      request: { name: 'ad hoc', method: 'GET', url: '{{baseUrl}}/status/418' },
    });
    assertEqual(r.body.response.status, 418, 'ran without being saved');
  });

  await test('a failed send is reported, not a 500', async () => {
    const r = await api('POST', '/run', {
      request: { name: 'nope', method: 'GET', url: 'http://127.0.0.1:1/x' },
    });
    assertEqual(r.status, 200, 'the failure is the result, not a server fault');
    assertEqual(r.body.failed, true, 'flagged as failed');
    assert(r.body.error.includes('Nothing is listening'), 'plain-language reason');
  });

  await test('run with neither a request nor a requestId is a 400', async () => {
    assertEqual((await api('POST', '/run', { projectId })).status, 400, 'status');
  });

  /* ---- assertions and captures -------------------------------- */

  await test('assertions are evaluated and reported', async () => {
    const r = await api('POST', '/run', {
      projectId,
      environmentId,
      request: {
        name: 'asserted',
        method: 'GET',
        url: '{{baseUrl}}/echo',
        assertions: [
          { type: 'status', operator: 'equals', expected: '200' },
          { type: 'jsonPath', target: 'method', operator: 'equals', expected: 'GET' },
          { type: 'status', operator: 'equals', expected: '500' },
        ],
      },
    });
    assertEqual(r.body.assertions.length, 3, 'all evaluated');
    assertEqual(r.body.passed, false, 'one failed, so the run failed');
    assert(r.body.assertions[2].summary.includes('expected'), 'failure explains itself');
  });

  await test('captured values feed the next request', async () => {
    const captured = await api('POST', '/run', {
      projectId,
      environmentId,
      request: {
        name: 'capture',
        method: 'GET',
        url: '{{baseUrl}}/echo',
        captures: [{ name: 'echoedPath', from: 'body', path: 'path' }],
      },
    });
    assertEqual(captured.body.captures[0].found, true, 'captured');
    assertEqual(captured.body.captures[0].value, '/echo', 'value');

    const used = await api('POST', '/run', {
      projectId,
      environmentId,
      request: { name: 'use', method: 'GET', url: '{{baseUrl}}/echo?was={{echoedPath}}' },
    });
    assertEqual(JSON.parse(used.body.response.body).query.was, '/echo', 'reused downstream');
  });

  await test('a captured secret is not echoed back', async () => {
    const r = await api('POST', '/run', {
      projectId,
      environmentId,
      request: {
        name: 'capture secret',
        method: 'GET',
        url: '{{baseUrl}}/echo',
        captures: [{ name: 'hidden', from: 'body', path: 'path', secret: true }],
      },
    });
    assertEqual(r.body.captures[0].found, true, 'captured');
    assertEqual(r.body.captures[0].value, '••••', 'masked in the report');
  });

  /* ---- history ------------------------------------------------ */

  await test('runs are recorded in history, newest first', async () => {
    const r = await api('GET', `/projects/${projectId}/history`);
    assert(r.body.history.length > 0, 'history recorded');
    assert(r.body.history[0].at >= r.body.history[r.body.history.length - 1].at, 'newest first');
  });

  /* ---- transfer between projects ------------------------------ */

  await test('copy a request and environment into another project', async () => {
    const target = (await api('POST', '/projects', { name: 'Target' })).body;

    const r = await api('POST', `/projects/${projectId}/transfer`, {
      targetProjectId: target.id,
      mode: 'copy',
      requestIds: [requestId],
      environmentIds: [environmentId],
    });
    assertEqual(r.status, 200, 'status');
    assertEqual(r.body.requests.length, 1, 'request copied');
    assertEqual(r.body.environments.length, 1, 'environment copied');

    const loaded = await api('GET', `/projects/${target.id}`);
    assertEqual(loaded.body.requests.length, 1, 'request present in target');
    assertEqual(loaded.body.environments.length, 1, 'environment present in target');

    // The secret must still work after the move, and still never be readable.
    const copiedEnv = loaded.body.environments[0];
    assertEqual(copiedEnv.variables.find((v) => v.key === 'token').value, '••••', 'still masked');

    const run = await api('POST', '/run', {
      projectId: target.id,
      environmentId: copiedEnv.id,
      request: {
        name: 'check',
        method: 'GET',
        url: '{{baseUrl}}/auth/bearer',
        auth: { type: 'bearer', token: '{{token}}' },
      },
    });
    assertEqual(run.body.response.status, 200, 'the copied secret still authenticates');

    // Copy leaves the original in place.
    const sourceStill = await api('GET', `/projects/${projectId}`);
    assert(
      sourceStill.body.environments.some((e) => e.id === environmentId),
      'copy must not remove the source environment',
    );

    await api('DELETE', `/projects/${target.id}`);
  });

  await test('move takes the environment out of the source project', async () => {
    const target = (await api('POST', '/projects', { name: 'MoveTarget' })).body;
    const spare = (
      await api('POST', `/projects/${projectId}/environments`, {
        name: 'disposable',
        variables: [{ key: 'x', value: '1' }],
      })
    ).body;

    await api('POST', `/projects/${projectId}/transfer`, {
      targetProjectId: target.id,
      mode: 'move',
      environmentIds: [spare.id],
    });

    const source = await api('GET', `/projects/${projectId}`);
    assert(!source.body.environments.some((e) => e.id === spare.id), 'gone from source');
    assertEqual(
      (await api('GET', `/projects/${target.id}`)).body.environments.length,
      1,
      'in target',
    );

    await api('DELETE', `/projects/${target.id}`);
  });

  await test('transferring into the same project is refused', async () => {
    const r = await api('POST', `/projects/${projectId}/transfer`, {
      targetProjectId: projectId,
      requestIds: [requestId],
    });
    assertEqual(r.status, 400, 'status');
  });

  /* ---- deletion ----------------------------------------------- */

  await test('deleting a project removes its requests too', async () => {
    assertEqual((await api('DELETE', `/projects/${projectId}`)).status, 204, 'deleted');
    assertEqual((await api('GET', `/projects/${projectId}`)).status, 404, 'project gone');
    assertEqual(
      (await api('GET', `/projects/${projectId}/requests/${requestId}`)).status,
      404,
      'request gone with it',
    );
  });
} finally {
  await fixture.stop();
  await server.stop();
}

summarise('api');
