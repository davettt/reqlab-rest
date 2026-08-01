# Changelog

## [Unreleased]

### Changed

- CI workflow synced with build-policy 2.6.2, which adds build, unit, smoke and integration test steps — CI previously verified only that the code was well-formed, never that it runs

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
- Tests covering the production API-404 behaviour, the non-advancing migration guard, per-variable decryption failures, and object-key masking
- Test covering CORS rejection of an unrelated local origin

### Changed

- CORS origin checking now parses the Origin header instead of pattern-matching it, so look-alike hosts such as `localhost.attacker.example` cannot pass
- `import-notation` disabled in the shared stylelint template, required for Tailwind v4's `@import 'tailwindcss'` syntax
- helmet's default `upgrade-insecure-requests` CSP directive is now explicitly disabled, since the app is only ever served over http on loopback and the directive could only break asset loading
- README no longer claims "no cloud" without qualification; it now states that AI import sends the supplied docs to the configured provider while everything else stays local
- CORS now additionally restricts the allowed origin port to this server's port and the Vite dev port, rather than accepting any port on loopback
- The run record separates first-hop request headers from `finalRequest`, so the reported headers stay consistent with the reported URL and body across redirects
- Minimum Node version raised to 22.12.0 in package.json and README

### Fixed

- Debounced writes no longer use an unref'd timer, which could let an idle process exit with a write still pending and silently lose the last edit
- Deferred writes in `server/store.js` no longer produce an unhandled promise rejection when a write fails; `save()` is fire-and-forget, so a failure previously crashed the server. Callers that await the returned promise still receive the error
- Unknown `/api` routes now return a JSON 404 in production instead of falling through to the SPA fallback and returning the HTML shell with status 200
- A schema migration step that fails to advance the version now throws instead of looping forever
- `backupTaken` is set only after the pre-migration backup completes, so a failed backup retries instead of letting migration proceed as though a snapshot exists
- A secret that cannot be decrypted (encrypted on another machine) no longer makes the entire environment unusable — the failure is recorded per variable and surfaced as a request warning only when that variable is referenced
- `maskDeep` now masks object keys as well as values
- `server/buildCheck.js` treats an unparseable `.last-build` marker as unknown rather than reporting the build as fresh, and a broken symlink or file removed mid-scan no longer aborts the whole mtime walk
- Tests no longer run against the real `local_data/` directory — each spawned server gets a throwaway data directory that is removed on stop; shutdown now waits for the process to exit after SIGKILL, and readiness probes are individually timed out
- OAuth2 client-credentials now validates the token URL before sending the client secret: https is allowed anywhere, plain http only against loopback, and other schemes are refused
- The OAuth2 token cache key now includes a hash of the client secret and the client-auth mode, so rotating a secret no longer reuses the old cached token
- An invalid header name or value now produces a clear, actionable error naming the header instead of an unhandled TypeError from `Headers.set`
- The synchronous shutdown write path now writes to a temp file and renames, matching the atomicity guarantee of every other write in the module
- Captured values can now carry a secret flag, so a token captured from a response is masked like any other secret
- Variable nesting deeper than the supported limit is now reported as unresolved instead of silently returning text that still contains placeholders
- `parseSetCookies` handles a cookie segment with no `=` instead of producing an empty name and a duplicated value
- `decryptWithPassphrase` rejects a missing passphrase explicitly rather than reporting it as a wrong passphrase or corrupt bundle
- Log messages no longer interpolate file paths into the format string, preventing log forging through crafted filenames
