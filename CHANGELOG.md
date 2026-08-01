# Changelog

## [Unreleased]

### Added

- Fixture API (`tests/fixtures/server.js`) — a local test API covering the execution engine's paths (all body types, four auth modes, redirect chains, slow and binary responses, cookies) plus endpoints deliberately broken in known ways, each paired with a correct twin, and three rate limiters with known parameters (fixed window, sliding window, token bucket) as ground truth for later verification suites
- `tests/exec.js` and a `test:exec` script — 26 tests exercising the request execution engine end to end against the fixture, including proof that a secret reaches the server while never appearing anywhere in the sanitised run record
- `server/model.js` — Zod schemas for projects, requests, environments and runs, plus the secret-handling rules: secrets are encrypted on write, returned only as a mask, and a masked value sent back on save preserves the stored secret rather than overwriting it
- `server/routes/projects.js` — CRUD for projects, requests and environments, with cascade delete and per-project run history
- `server/routes/run.js` — `POST /api/run`, which executes either a saved request or an unsaved one straight from the editor, resolves variables server-side, evaluates assertions, applies captures, and records history
- `server/exec/assert.js` — assertions (status, header, JSONPath, response time, body contains) and value capture for chaining requests, including secret-marked captures
- Zod validation errors are now returned as field-level detail with a 400 rather than a generic error
- `tests/api.js` and a `test:api` script — 18 tests covering CRUD, running saved and unsaved requests, assertions, captures, history and the secret masking boundary
- Three-pane user interface: sidebar with project selector and request list, request editor (method, URL, params, headers, body, auth, assertions), and a response pane with pretty-printed JSON, headers, cookies, a proportional timing waterfall and check results
- Unsaved edits are marked and are what actually get sent, so a request can be run before it is saved
- Zustand store and typed API client (`src/stores/appStore.ts`), shared types in `src/types/index.ts`
- Inline confirm/cancel for deleting a request, rather than a browser dialog
- `src/components/VariableEditor.tsx` — dedicated environment variable editor with a per-row secret toggle and explicit save
- Request tab in the response pane showing what was actually sent — method, URL, request headers and request body, plus the final hop when the request was redirected. Previously the Headers tab showed response headers only, so there was no way to confirm an auth header or a resolved variable went out as intended
- XML responses are now indented for display, alongside the existing JSON formatting
- Move or copy requests and environments between projects, from the request editor and the environment bar. Secrets are carried across still encrypted and are never decrypted in the process
- `POST /api/projects/:id/transfer` endpoint backing it, with copy and move modes
- XML endpoint added to the test fixture

### Changed

- CI workflow synced with build-policy 2.6.2, which adds build, unit, smoke and integration test steps — CI previously verified only that the code was well-formed, never that it runs
- The environment variable editor now has an explicit "+ Add variable" button instead of a trailing blank row, which read as an empty variable
- The Params and Headers tabs now state where their entries are sent — the URL query string and HTTP request headers respectively — since the tab name alone did not make that clear

### Fixed

- DNS timing was never measured — undici's connector does not forward a custom `lookup`, so the DNS phase of the timing waterfall was always null. Resolution is now timed explicitly before connecting, and stays null for IP literals where no resolution occurs
- Replaced a regular expression with nested quantifiers (a ReDoS shape) in the JSONPath reader with a linear scan, since the path comes from user input
- Response cookie values are no longer masked. `set-cookie` was being treated as a credential header, which rendered every cookie as `••••` and made the Cookies tab useless, while the same values remained visible in the response body. Secrets are still masked by value.
- A secret environment variable can now be marked secret before it is first saved. Previously the "treat as secret" toggle only appeared for variables that already existed, so a credential had to be stored in plaintext first and encrypted on a later save — meaning the real value was written to disk (and to any folder sync) at least once
- The environment variable editor no longer saves on every keystroke; edits are held locally until "Save variables" is pressed, so a partially typed credential is never written at all
- Secret values now render as password fields and clear on focus, so typing replaces the stored value instead of appending to the mask
- Fixed a React cascading-render pattern: the variable editor synced props via setState inside an effect, and now derives the state during render instead
- Unsaved request edits are no longer discarded. Switching between requests, or moving/copying to another project (which reloads the project), replaced the editor with the stored copy and silently threw away anything typed but not saved. Edits are now stashed per request and restored when you switch back, and move/copy no longer touches the editor at all

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
