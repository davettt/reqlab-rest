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
      'the Vite dev origin should be allowed',
    );

    // Another process on loopback is not part of this app.
    const otherLocalApp = await fetch(`${server.base}/api/build-status`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    assertEqual(
      otherLocalApp.headers.get('access-control-allow-origin'),
      null,
      'an unrelated local origin must not be allowed',
    );
  });
  await test('production: SPA fallback serves pages but never swallows API 404s', async () => {
    // The dev-mode 404 test above passes even when the SPA fallback is misordered, because
    // static serving is only mounted in production. This is the case that actually broke.
    const prod = await startServer({ env: { NODE_ENV: 'production' } });
    try {
      const api = await fetch(`${prod.base}/api/does-not-exist`);
      assertEqual(api.status, 404, 'unknown API route status');
      assert(
        (api.headers.get('content-type') ?? '').includes('json'),
        'must be a JSON error, not the HTML shell with status 200',
      );

      const page = await fetch(`${prod.base}/some/deep/route`);
      assertEqual(page.status, 200, 'deep link status');
      assert((page.headers.get('content-type') ?? '').includes('html'), 'deep link serves the app');
    } finally {
      await prod.stop();
    }
  });
} finally {
  await server.stop();
}

summarise('integration');
