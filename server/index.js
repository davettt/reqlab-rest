import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { buildStale } from './buildCheck.js';

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

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header — a curl or same-origin request, not a cross-site one.
      if (!origin) return callback(null, true);
      try {
        const { protocol, hostname } = new URL(origin);
        const ok = (protocol === 'http:' || protocol === 'https:') && LOOPBACK_HOSTS.has(hostname);
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

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'dist/index.html')));
}

// Generic errors to the client; details stay in the server log.
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, _req, res, _next) => {
  console.error('[reqlab-rest]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`ReqLab REST v${pkg.version} listening on http://${HOST}:${PORT}`);
});
