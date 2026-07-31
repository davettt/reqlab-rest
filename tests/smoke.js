import { startServer, test, assert, assertEqual, summarise } from './util.js';

console.log('smoke: reqlab-rest');

const server = await startServer();

try {
  await test('GET /api/build-status returns version and staleness', async () => {
    const res = await fetch(`${server.base}/api/build-status`);
    assertEqual(res.status, 200, 'status');
    const body = await res.json();
    assert(typeof body.version === 'string' && body.version.length > 0, 'version missing');
    assertEqual(typeof body.stale, 'boolean', 'stale type');
  });

  await test('server binds loopback only', async () => {
    assert(server.log.includes('127.0.0.1'), 'startup log should report a 127.0.0.1 bind');
  });
} finally {
  await server.stop();
}

summarise('smoke');
