# ReqLab REST

A light, local REST client with an API-verification lab.

Send and inspect requests like you would in Postman or Insomnia — then point the lab at an API
and get an evidence-backed answer to _"was this built correctly?"_: contract conformance, error
handling, authorisation, pagination, idempotency, caching, latency and rate limits, delivered as
a report you can hand to an engineer.

Runs entirely on your machine. No account, no cloud, no telemetry. MIT licensed.

> **Status: in development.** Phase 0 (project scaffold and server skeleton) is complete.
> The client and lab features listed below are being built phase by phase — see `CHANGELOG.md`
> for what actually ships today.

## Planned features

**Client**

- Projects → folders → requests, with per-project environments
- All the usual body types: JSON, form-urlencoded, multipart, raw, XML, GraphQL, binary
- Auth helpers: bearer, basic, API key, OAuth2 client credentials
- Response inspection: pretty JSON, raw, headers, cookies, timing waterfall, diff vs previous run
- Assertions and value capture for chaining requests
- Code export: curl, JS `fetch`, TanStack Query hook, Node axios, Python requests

**Lab**

- **Contract conformance** — live responses validated against an OpenAPI spec, plus a conventions
  audit (status-code usage, date formats, naming drift, error-envelope consistency)
- **Negative testing** — generated failure paths (bad auth, malformed bodies, wrong methods,
  oversized payloads) checking for correct status codes and no leaked internals
- **Authorisation / IDOR** — cross-user access probes with two tokens, plus security hygiene checks
- **Workflow scenarios** — ordered multi-step runs with captured values, diffed against a baseline
- **Behaviour** — pagination correctness, idempotency, latency percentiles, caching
- **Rate-limit profiler** — steady / burst / ramp modes that infer whether a limit is a fixed
  window, sliding window, or token bucket, and report it in plain English

**Import**

- OpenAPI 3 / Swagger 2 / Postman / HAR are parsed deterministically — no AI involved
- Unstructured docs (a URL or pasted text) go through an AI pass that proposes requests for you
  to accept or reject. Bring your own Anthropic or OpenAI key.

## Requirements

- Node.js 22 or newer
- pm2 (optional, for running it as a background local service)

## Setup

```bash
npm install
npm run build
npm start          # http://127.0.0.1:3016
```

Or as a managed pm2 service, from the parent directory:

```bash
pm2 start ecosystem.config.js --only reqlab-rest
```

For development with hot reload:

```bash
npm run dev        # Vite on 5173, API on 3016
```

## Configuration

No `.env` file is required to run. Optional:

| Variable   | Default | Purpose                                                      |
| ---------- | ------- | ------------------------------------------------------------ |
| `PORT`     | `3016`  | Port the server listens on                                   |
| `NODE_ENV` | unset   | Set to `production` to serve the built frontend from `dist/` |

AI provider keys are **not** configured through the environment — you enter them in the app's
settings and they are encrypted at rest (see below).

## Data and secrets

Everything lives in `local_data/`, which is gitignored and never leaves your machine:

```
local_data/
  projects/<projectId>/     # requests, environments, scenarios, run history
  settings.json             # AI provider config and encrypted keys
  backups/                  # automatic pre-migration snapshots
```

Secret environment variables and BYOK API keys are encrypted at rest with AES-256-GCM using a key
derived from your machine and user account. Two consequences worth knowing:

1. Copying `local_data/` to another machine will **not** decrypt the secrets. Use the app's
   export/import instead — export re-encrypts secrets under a passphrase you choose.
2. This protects a leaked or cloud-synced copy of the files. It does not protect against someone
   using your already-logged-in account.

Secrets are resolved on the server at request time and are masked (`••••`) everywhere the browser
can see them, including in the request preview and in generated reports.

## Security model

Requests are executed **by the server**, not the browser. That is what makes real timing data,
arbitrary headers, and CORS-free requests possible — but it also means the server will send an
HTTP request anywhere you point it.

Therefore the server **binds to `127.0.0.1` only**. Do not put it behind a reverse proxy, expose
the port, or run it on a shared machine you do not trust: anyone who can reach the port can make
your machine issue requests on their behalf. Destructive lab suites additionally require a
per-host acknowledgement that you own or are authorised to test the target.

## Licence

MIT — see [LICENSE](LICENSE).
