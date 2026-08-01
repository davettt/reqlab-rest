import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { buildStale } from './buildCheck.js';
import { installShutdownFlush } from './store.js';
import { router as projectsRouter } from './routes/projects.js';
import { router as runRouter } from './routes/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT ?? 3016);

// Loopback only. This server executes arbitrary outbound HTTP on behalf of whoever can
// reach it, so it must never be exposed beyond this machine. See README "Security model".
const HOST = '127.0.0.1';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const app = express();
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Vite injects inline styles for the built CSS entry; scripts stay external.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Explicitly off: this app is only ever served over http on loopback, so upgrading
        // subresource requests to https can only break asset loading, never protect anything.
        upgradeInsecureRequests: null,
      },
    },
    // Reports are downloaded as standalone files, not framed.
    crossOriginEmbedderPolicy: false,
  }),
);

// Loopback origins only. Parsed rather than pattern-matched: a regex here has to be anchored
// exactly right or "localhost.attacker.example" slips through, and parsing cannot get that wrong.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const VITE_DEV_PORT = '5173';
const ALLOWED_ORIGIN_PORTS = new Set([String(PORT), VITE_DEV_PORT]);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header — a curl or same-origin request, not a cross-site one.
      if (!origin) return callback(null, true);
      try {
        const { protocol, hostname, port } = new URL(origin);
        const ok =
          (protocol === 'http:' || protocol === 'https:') &&
          LOOPBACK_HOSTS.has(hostname) &&
          // Only this server and the Vite dev server. Any other local process listening on
          // loopback is not part of this app and has no business calling its API.
          ALLOWED_ORIGIN_PORTS.has(port || (protocol === 'https:' ? '443' : '80'));
        return callback(null, ok);
      } catch {
        return callback(null, false);
      }
    },
  }),
);

app.use(
  '/api',
  rateLimit({
    windowMs: 60_000,
    limit: 2000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

app.use(express.json({ limit: '10mb' }));

app.get('/api/build-status', (_req, res) => {
  res.json({ stale: buildStale, version: pkg.version });
});

app.use('/api/projects', projectsRouter);
app.use('/api/run', runRouter);

// Must precede the SPA fallback: otherwise a typo'd or removed API route returns the HTML
// shell with status 200 in production, and the client parses it as a successful response.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'dist/index.html')));
}

// Generic errors to the client; details stay in the server log.
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  // Validation failures are the user's input, not a fault: report what was wrong with it.
  if (err?.name === 'ZodError') {
    const issues = (err.issues ?? []).map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    return res.status(400).json({ error: 'Invalid request', issues });
  }
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error('[reqlab-rest]', err);
  res.status(500).json({ error: 'Internal server error' });
});

installShutdownFlush();

app.listen(PORT, HOST, () => {
  console.log(`ReqLab REST v${pkg.version} listening on http://${HOST}:${PORT}`);
});
