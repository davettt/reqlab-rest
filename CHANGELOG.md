# Changelog

## [0.1.0] - 2026-07-31

### Added

- ReqLab REST project scaffold: Vite + React + TypeScript + Express 5 server, pm2 port 3016
- Express server with helmet, explicit CSP, CORS anchored to localhost, and rate-limiting on /api
- Build-policy integration: CI/CD workflows, husky hooks, quality-gate scripts (validate, quality, sast, secrets, licenses, deps:check, test:smoke, test:integration)
- Stale-build detection via /api/build-status endpoint
- React app shell with server version and build-staleness reporting
- TypeScript strict mode, ESLint (typescript-eslint, react-hooks, eslint-plugin-security), Tailwind v4
- Hermetic test harness and integration tests covering security headers, CORS boundary validation, and rate-limit behavior
- PWA manifest and SVG favicon
- README with setup, security model, and data/secrets sections
- MIT license
- `server/crypto.js` — secret encryption at rest: AES-256-GCM under a machine-derived key (`enc:` prefix) for local storage, and scrypt + AES-256-GCM under a user passphrase (`encp:` prefix) for portable export bundles; plaintext values auto-migrate
- `server/store.js` — persistence layer for local_data/: atomic writes (temp file + fsync + rename), per-path debounced and coalesced writes, read-your-writes, append-only history logs with trimming, schema-version migrations with automatic pre-migration backups (last 10 kept), and a downgrade guard that refuses to load data written by a newer build
- `server/vars.js` — {{variable}} resolution with project < environment < capture precedence, nested variable support, and value-based secret masking
- `server/exec/run.js` — server-side request execution on undici with per-phase timing (DNS, connect, TTFB, download), manual redirect following that records the hop chain and drops credential headers on cross-origin redirects, response body size caps, and run sanitisation that masks credential-bearing headers by name as well as by value
- `server/exec/bodies.js` — JSON, text, XML, form-urlencoded, multipart, GraphQL and binary request bodies
- `server/exec/auth.js` — bearer, basic, API key (header or query) and OAuth2 client-credentials auth with in-memory token caching
- `tests/unit.js` and a `test:unit` script — 34 tests covering encryption, storage, variable resolution and body building

### Changed

- CORS origin checking now parses the Origin header instead of pattern-matching it, so look-alike hosts such as `localhost.attacker.example` cannot pass
- `import-notation` disabled in the shared stylelint template, required for Tailwind v4's `@import 'tailwindcss'` syntax
- helmet's default `upgrade-insecure-requests` CSP directive is now explicitly disabled, since the app is only ever served over http on loopback and the directive could only break asset loading

### Fixed

- Debounced writes no longer use an unref'd timer, which could let an idle process exit with a write still pending and silently lose the last edit
