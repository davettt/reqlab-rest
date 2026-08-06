/**
 * The fixture API.
 *
 * Two jobs. First, it gives the execution engine something real to talk to — redirects,
 * auth, every body type, slow responses, malformed output — without depending on the
 * internet or on someone else's uptime.
 *
 * Second, and more importantly for later phases, parts of it are *deliberately broken in
 * known ways*, each paired with a correct twin. That is the only honest way to test a tool
 * whose entire output is judgements about other people's APIs: a verification suite that
 * reports nothing looks identical to one that does not work. Every planted defect is marked
 * BROKEN and documented with what a correct implementation would do.
 *
 * Run standalone: node tests/fixtures/server.js [port]
 */
import express from 'express';

export const PLANTED_DEFECTS = [
  { id: 'created-returns-200', route: 'POST /broken/widgets', expected: 201, actual: 200 },
  { id: 'missing-location-header', route: 'POST /broken/widgets', expected: 'Location header' },
  { id: 'stack-trace-leak', route: 'POST /broken/parse', expected: 'generic 400' },
  { id: 'server-error-for-bad-input', route: 'POST /broken/validate', expected: 400, actual: 500 },
  { id: 'idor', route: 'GET /broken/users/:id/profile', expected: 403 },
  { id: 'duplicate-across-pages', route: 'GET /broken/items', expected: 'stable pagination' },
  { id: 'non-idempotent-put', route: 'PUT /broken/counter', expected: 'same result on repeat' },
  { id: 'missing-etag', route: 'GET /broken/document', expected: 'ETag header' },
  {
    id: 'non-json-error',
    route: 'POST /broken/html-error',
    expected: 'the documented JSON error envelope',
  },
];

export function createFixtureApp() {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag'); // set explicitly per route, so the caching tests mean something

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.text({ type: ['text/*', 'application/xml'] }));

  /* ================================================================
   * Correct endpoints — the execution engine's happy paths
   * ============================================================== */

  app.get('/echo', (req, res) => {
    res.json({
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
    });
  });

  app.all('/echo/body', (req, res) => {
    res.json({
      method: req.method,
      contentType: req.headers['content-type'] ?? null,
      body: req.body ?? null,
    });
  });

  app.get('/slow/:ms', (req, res) => {
    const ms = Math.min(Number(req.params.ms) || 0, 5000);
    setTimeout(() => res.json({ sleptMs: ms }), ms);
  });

  app.get('/status/:code', (req, res) => {
    res.status(Number(req.params.code) || 200).json({ code: Number(req.params.code) });
  });

  app.get('/binary', (_req, res) => {
    res.set('content-type', 'image/png');
    res.send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  // A documentation page that names its specification only in a loaded script — the shape
  // Swagger UI actually produces, and the reason reading the HTML alone is not enough.
  app.get('/docs', (_req, res) => {
    res
      .type('html')
      .send(
        '<!doctype html><html><head><title>API docs</title></head><body>' +
          '<div id="swagger-ui"></div><script src="/swagger-initializer.js"></script>' +
          '</body></html>',
      );
  });

  app.get('/swagger-initializer.js', (_req, res) => {
    res
      .type('application/javascript')
      .send('window.ui = SwaggerUIBundle({ url: "/spec/openapi.json", dom_id: "#swagger-ui" });');
  });

  app.get('/spec/openapi.json', (_req, res) => {
    res.json({
      openapi: '3.0.0',
      info: { title: 'Fixture API', version: '1.0.0' },
      paths: { '/echo': { get: { responses: { 200: { description: 'ok' } } } } },
    });
  });

  app.get('/xml', (_req, res) => {
    res.set('content-type', 'application/xml');
    res.send(
      '<?xml version="1.0"?><WhoisRecord><domainName>example.com</domainName>' +
        '<registrarName>Example Registrar</registrarName><createdDate>2001-01-01</createdDate>' +
        '<registrant><organization>Example Inc</organization></registrant></WhoisRecord>',
    );
  });

  app.get('/cookies', (_req, res) => {
    res.append('set-cookie', 'session=abc123; HttpOnly; Secure; SameSite=Lax; Path=/');
    res.append('set-cookie', 'theme=dark; Path=/; Max-Age=3600');
    res.json({ ok: true });
  });

  /* ---- redirects ---- */

  // Named redirect routes must be registered BEFORE '/redirect/:n', or the parameterised
  // route swallows them: Number('loop') is NaN, which fell through to a plain redirect and
  // silently made the loop and cross-origin tests assert nothing.
  app.get('/redirect/loop', (_req, res) => res.redirect(302, '/redirect/loop'));

  app.post('/redirect/see-other', (_req, res) => res.redirect(303, '/echo'));

  // Absolute redirect to another origin — used to prove credentials are dropped.
  app.get('/redirect/cross-origin', (req, res) => {
    res.redirect(302, `http://127.0.0.1:${req.query.port}/echo`);
  });

  app.get('/redirect/:n', (req, res) => {
    const n = Number(req.params.n) || 0;
    if (n <= 1) return res.redirect(302, '/echo');
    res.redirect(302, `/redirect/${n - 1}`);
  });

  /* ---- auth ---- */

  app.get('/auth/bearer', (req, res) => {
    const auth = req.headers.authorization ?? '';
    // Test fixture with a hardcoded token, never network-exposed; a constant-time compare
    // here would obscure what the test is doing for no security benefit.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (auth !== 'Bearer valid-token') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ ok: true, via: 'bearer' });
  });

  app.get('/auth/basic', (req, res) => {
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    if (req.headers.authorization !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ ok: true, via: 'basic' });
  });

  app.get('/auth/api-key', (req, res) => {
    const key = req.headers['x-api-key'] ?? req.query.api_key;
    if (key !== 'secret-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json({ ok: true, via: 'api-key' });
  });

  let tokenIssueCount = 0;
  app.post('/oauth/token', (req, res) => {
    const basic = 'Basic ' + Buffer.from('client-id:client-secret').toString('base64');
    const viaHeader = req.headers.authorization === basic;
    // Any non-empty secret is accepted: these tests are about the client's caching
    // behaviour, and a rejected rotation would issue no token and prove nothing.
    const viaBody = req.body?.client_id === 'client-id' && Boolean(req.body?.client_secret);
    const viaAnyBasic = (req.headers.authorization ?? '').startsWith('Basic ');

    if (!viaHeader && !viaBody && !viaAnyBasic) {
      return res.status(401).json({ error: 'invalid_client' });
    }

    tokenIssueCount += 1;
    res.json({ access_token: `issued-token-${tokenIssueCount}`, expires_in: 3600 });
  });

  app.get('/oauth/token-count', (_req, res) => res.json({ count: tokenIssueCount }));

  /* ---- correct twins for the planted defects ---- */

  const widgets = [];
  app.post('/good/widgets', (req, res) => {
    const widget = { id: `w${widgets.length + 1}`, ...req.body };
    widgets.push(widget);
    res.status(201).location(`/good/widgets/${widget.id}`).json(widget);
  });

  app.post('/good/validate', (req, res) => {
    if (typeof req.body?.name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    res.json({ ok: true });
  });

  app.get('/good/users/:id/profile', (req, res) => {
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    // Test fixture, as above.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (token !== `token-for-${req.params.id}`) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ id: req.params.id, email: `${req.params.id}@example.com` });
  });

  const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `item-${i + 1}` }));
  app.get('/good/items', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const start = (page - 1) * limit;
    res.json({ total: items.length, page, limit, data: items.slice(start, start + limit) });
  });

  // BROKEN: returns an internal field the documentation does not describe.
  app.get('/broken/document-extra', (_req, res) => {
    res.json({ body: 'hello', internalOwnerEmail: 'ops@example.com' });
  });

  app.get('/good/document', (_req, res) => {
    res.set('etag', '"v1"').set('cache-control', 'max-age=60').json({ body: 'hello' });
  });

  // PUT sets rather than increments, so repeating it gives the same answer — which is what
  // PUT is defined to do, and the twin that proves the idempotency suite is not just flagging
  // every write it sees.
  let goodCounter = 0;
  app.put('/good/counter', (req, res) => {
    goodCounter = Number(req.body?.counter ?? 1);
    res.json({ counter: goodCounter, updatedAt: new Date().toISOString() });
  });

  /* ================================================================
   * BROKEN endpoints — each defect is intentional. See PLANTED_DEFECTS.
   * ============================================================== */

  // BROKEN: returns 200 on create and omits Location. Correct: 201 + Location.
  app.post('/broken/widgets', (req, res) => {
    const widget = { id: `w${widgets.length + 1}`, ...req.body };
    widgets.push(widget);
    res.status(200).json(widget);
  });

  // BROKEN: leaks a stack trace on malformed input. Correct: generic 400.
  app.post('/broken/parse', (req, res) => {
    try {
      JSON.parse(req.body?.raw ?? 'not json');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // BROKEN: 500 for a client mistake. Correct: 400.
  app.post('/broken/validate', (req, res) => {
    if (typeof req.body?.name !== 'string') {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
    res.json({ ok: true });
  });

  // BROKEN: any bearer token reads any user. Correct: 403 unless the token matches.
  app.get('/broken/users/:id/profile', (req, res) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ id: req.params.id, email: `${req.params.id}@example.com` });
  });

  // BROKEN: off-by-one paging repeats the boundary record on every page after the first.
  app.get('/broken/items', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const start = Math.max(0, (page - 1) * limit - 1);
    res.json({ total: items.length, page, limit, data: items.slice(start, start + limit) });
  });

  // BROKEN: PUT increments. Correct: PUT sets, so a repeat gives the same result.
  let counter = 0;
  app.put('/broken/counter', (_req, res) => {
    counter += 1;
    res.json({ counter });
  });
  app.get('/broken/counter', (_req, res) => res.json({ counter }));

  // BROKEN: answers an error with an HTML page rather than the API's own JSON envelope —
  // the way a proxy, a load balancer or a framework's default handler does when it rejects a
  // request before the application sees it. A caller parsing the body throws.
  app.post('/broken/html-error', (_req, res) => {
    res
      .status(400)
      .type('html')
      .send('<!doctype html><html><body><h1>400 Bad Request</h1></body></html>');
  });

  // BROKEN: advertises its framework and version, the free reconnaissance most stacks emit
  // by default. Its correct twin is every other endpoint here, since the app disables the
  // header globally.
  app.get('/broken/banner', (_req, res) => {
    res.set('x-powered-by', 'Express').json({ ok: true });
  });

  // BROKEN, but differently: a web-server error page, the shape a proxy produces when it
  // answers before the application is reached. Distinguished from the case above because it
  // usually means deliberate edge hardening rather than a fault in the API's own handling.
  app.post('/broken/edge-error', (_req, res) => {
    res
      .status(405)
      .set('server', 'nginx')
      .type('html')
      .send(
        '<html><head><title>405 Not Allowed</title></head><body>' +
          '<center><h1>405 Not Allowed</h1></center><hr><center>nginx</center></body></html>',
      );
  });

  // BROKEN: no ETag or Cache-Control, so conditional requests cannot work.
  app.get('/broken/document', (_req, res) => res.json({ body: 'hello' }));

  /* ================================================================
   * Rate limiters with KNOWN parameters — ground truth for the profiler
   * ============================================================== */

  app.use('/limit/fixed-window', fixedWindow({ limit: 10, windowMs: 2000 }));
  app.use('/limit/sliding-window', slidingWindow({ limit: 10, windowMs: 2000 }));
  app.use('/limit/token-bucket', tokenBucket({ capacity: 10, refillPerSecond: 5 }));

  for (const path of ['/limit/fixed-window', '/limit/sliding-window', '/limit/token-bucket']) {
    app.get(path, (_req, res) => res.json({ ok: true }));
  }

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // A correct API answers malformed input with a generic 400. Without this, express.json()
  // throws before any handler runs and Express's default error page returns an HTML stack
  // trace — which would make every /good endpoint leak, and the correct twins would not be
  // correct. The /broken/parse endpoint leaks deliberately, inside its own handler.
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (err instanceof SyntaxError || err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

/* ---------------------------------------------------------------- *
 * Limiter implementations. Parameters are known, so the profiler's
 * inferences can be asserted against the truth rather than eyeballed.
 * ---------------------------------------------------------------- */

export function fixedWindow({ limit, windowMs }) {
  let windowStart = Date.now();
  let count = 0;

  return (_req, res, next) => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;

    const resetIn = Math.ceil((windowStart + windowMs - now) / 1000);
    res.set('x-ratelimit-limit', String(limit));
    res.set('x-ratelimit-remaining', String(Math.max(0, limit - count)));
    res.set('x-ratelimit-reset', String(resetIn));

    if (count > limit) {
      res.set('retry-after', String(resetIn));
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    next();
  };
}

export function slidingWindow({ limit, windowMs }) {
  const hits = [];

  return (_req, res, next) => {
    const now = Date.now();
    while (hits.length && hits[0] <= now - windowMs) hits.shift();

    res.set('x-ratelimit-limit', String(limit));
    res.set('x-ratelimit-remaining', String(Math.max(0, limit - hits.length)));

    if (hits.length >= limit) {
      const retryAfter = Math.ceil((hits[0] + windowMs - now) / 1000);
      res.set('retry-after', String(Math.max(1, retryAfter)));
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    hits.push(now);
    next();
  };
}

export function tokenBucket({ capacity, refillPerSecond }) {
  let tokens = capacity;
  let last = Date.now();

  return (_req, res, next) => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSecond);
    last = now;

    res.set('x-ratelimit-limit', String(capacity));
    res.set('x-ratelimit-remaining', String(Math.floor(Math.max(0, tokens))));

    if (tokens < 1) {
      res.set('retry-after', String(Math.ceil((1 - tokens) / refillPerSecond)));
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    tokens -= 1;
    next();
  };
}

/* ---------------------------------------------------------------- *
 * Standalone / programmatic start
 * ---------------------------------------------------------------- */

export function startFixture(port = 0) {
  return new Promise((resolve) => {
    const server = createFixtureApp().listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        base: `http://127.0.0.1:${actual}`,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// Run directly: node tests/fixtures/server.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]) || 4600;
  startFixture(port).then(({ base }) => console.log(`fixture API listening on ${base}`));
}
