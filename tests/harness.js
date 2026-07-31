import { startServer, test, assert, assertEqual, summarise } from './util.js';

const mode = process.argv[2] ?? 'integration';

if (mode !== 'integration') {
  console.error(`Unknown harness mode: ${mode}. Supported: integration`);
  process.exit(1);
}

console.log('integration: reqlab-rest');

const server = await startServer();

try {
  await test('unknown API routes 404 without leaking internals', async () => {
    const res = await fetch(`${server.base}/api/does-not-exist`);
    assertEqual(res.status, 404, 'status');
    const text = await res.text();
    assert(!/at\s+\S+:\d+:\d+/.test(text), 'response should not contain a stack trace');
  });

  await test('security headers are set', async () => {
    const res = await fetch(`${server.base}/api/build-status`);
    assert(res.headers.get('content-security-policy'), 'CSP header missing');
    assertEqual(res.headers.get('x-powered-by'), null, 'x-powered-by should be removed');
  });

  await test('own-API rate limit advertises its budget', async () => {
    const res = await fetch(`${server.base}/api/build-status`);
    assert(
      res.headers.get('ratelimit') ?? res.headers.get('ratelimit-limit'),
      'no RateLimit header',
    );
  });

  await test('CORS origin is anchored to localhost', async () => {
    const evil = await fetch(`${server.base}/api/build-status`, {
      headers: { Origin: 'http://localhost.attacker.example' },
    });
    assertEqual(
      evil.headers.get('access-control-allow-origin'),
      null,
      'a look-alike origin must not be allowed',
    );

    const good = await fetch(`${server.base}/api/build-status`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assertEqual(
      good.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
      'localhost origin should be allowed',
    );
  });
} finally {
  await server.stop();
}

summarise('integration');
