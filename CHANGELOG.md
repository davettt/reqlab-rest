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
- Deterministic import of OpenAPI 3 and Swagger 2 specs (JSON or YAML) — every operation becomes a request, server templates resolve from their defaults, path parameters become variables, query and header parameters land in the right place, request bodies are sampled from schemas with recursive `$ref` handled, security schemes become auth configuration, and the documented success status becomes an assertion
- Deterministic import of Postman v2 collections — folders, all body modes, query parameters and auth
- Deterministic import of HAR captures — deduplicated to one request per method and path, with browser-managed headers stripped
- Credentials found in a Postman or HAR export are replaced with an empty secret variable rather than imported, so someone else's live token is never planted in your project
- `POST /api/import/preview` and `POST /api/import/apply` — import is a two-step preview then apply, so nothing is written until the proposed requests have been reviewed
- Import by URL, restricted to http and https with a size cap and timeout
- `tests/import.js` and a `test:import` script — 17 tests covering all three formats, including a recursive `$ref`, a templated server, and the credential-stripping guarantee
- `js-yaml` dependency, for YAML OpenAPI specs
- Import dialog in the sidebar: paste a document or give a URL, see exactly what would be created, deselect anything unwanted, then apply. Nothing is written until the preview is accepted
- Import warnings are deduplicated, so a security scheme that cannot be auto-configured produces one line rather than one per operation
- Code export: copy any request as curl, JS fetch, a TanStack Query hook, axios, or Python requests, from a "Code" button in the request editor
- Secrets are rendered as environment-variable references in each target's idiom rather than inlined, so a copied snippet never carries a real credential. Including the real values is an explicit per-copy choice, and the snippet then says not to commit it
- Basic auth containing a secret stays symbolic rather than emitting base64 of a placeholder that would look like a real credential, and OAuth2 explains the token exchange instead of pretending a single request suffices
- `POST /api/codegen` endpoint
- `tests/codegen.js` and a `test:codegen` script — 21 tests, including a check that no target emits a real secret by default
- PWA icons: 192px and 512px PNGs plus an Apple touch icon, generated from the SVG and referenced from the manifest and index.html
- AI import for written API documentation, as an opt-in fallback when a document is prose rather than a spec. Bring your own Anthropic or OpenAI key; structured formats never contact a model
- Settings dialog for the AI provider, model tier and API keys. Keys are encrypted at rest with the machine key, and the settings endpoint only reports whether a provider is configured, never the value
- Model output is validated against the same schema as a hand-written request; a proposal that fails validation is skipped with a warning rather than repaired, and every AI import is labelled as inferred
- A secret value proposed by the model is discarded rather than stored, since documentation examples sometimes contain a real leaked key
- When importing documentation from a URL, the page's own origin is used as the baseUrl fallback and the source URL is included in the prompt, so requests are usable rather than pointing at an empty variable
- Any variable left without a value is named in the import warnings
- `tests/ai.js` and a `test:ai` script — 13 tests with the provider call stubbed, covering malformed proposals, credential echo, and the baseUrl fallback. A test asserts the model IDs match build-policy/registry.json
- Rename and delete environments from the environment bar. Deleting confirms inline and names what will be lost, including how many variables; if the deleted environment was the selected one, another is selected rather than leaving none, which would silently unresolve every variable
- Rename and delete projects from the sidebar. Deleting spells out that it takes the project's requests, environments and stored secrets with it
- Creating an environment offers one-click development / staging / production names, since environments are deployment targets holding the same variables with different values
- Imported parameters carry their documented accepted values and description. A parameter with a closed set of values (for example outputFormat accepting JSON or XML) renders as a dropdown with an "Other…" escape hatch, instead of a free-text box
- Optional parameters are now imported from AI documentation import as well as from OpenAPI, unchecked rather than omitted, so an endpoint's options are visible without being sent
- A credential documented as an ordinary parameter or header is moved to the Auth tab on import, where the query-string exposure warning lives. Matching is conservative and excludes pagination names such as page_token and next_cursor; an explicit security scheme from a spec always wins, and anything moved is reported so it can be undone
- Filler values from AI import (such as <UNKNOWN>, YOUR_API_KEY or REPLACE_ME) become {{variable}} references with the variable created, rather than being sent literally
- A request imported with no endpoint path — only the base URL — is flagged in the import warnings, since it otherwise fails looking like a network fault
- Verification lab, reachable from the header: runs checks against a project's saved requests and produces a report to hand to whoever built the API
- Contract conformance suite — compares live responses against an OpenAPI spec: undocumented statuses, missing required fields, wrong types, values outside documented enums, non-nullable nulls, unparseable dates, wrong content types, missing Location on 201, and camelCase/snake_case drift across responses
- Negative testing suite — generated failure paths (missing and malformed credentials, malformed JSON, wrong field types, wrong content type, oversized bodies, unsupported methods) checking for correct status codes, a consistent error shape, and six classes of leaked internals including stack traces, filesystem paths and SQL
- Authorisation suite — replays requests as a second user and unauthenticated to find IDOR, plus hygiene checks for plain http, credentials in the query string, wildcard CORS on authenticated endpoints, and missing protective headers
- Self-contained HTML report with no external assets, each finding carrying the exact request and response that produced it, and a terse markdown summary for pasting into a ticket or chat
- A finding model shared by every suite: severity, plain-English "what happened" and "why it matters", expected versus actual, and evidence
- `POST /api/verify` plus endpoints to list past runs and re-download a stored report in either format
- `tests/verify.js` and a `test:verify` script — 21 tests asserting in both directions against the fixture's planted defects: every broken endpoint is flagged and every correct twin is left alone
- An OpenAPI spec for the test fixture, describing what a correct implementation would do
- Contract conformance now flags fields the API returns that the documentation does not describe, reported as minor: either the documentation has fallen behind, or the endpoint is returning more than it intends to and internal data is leaking. Skipped where the spec permits additional properties
- Stored verification runs are capped at 20 per project, oldest pruned. Each run holds the request and response evidence for every finding, so an unbounded history would grow local_data steadily
- Contract conformance accepts a specification by URL as well as pasted text, in JSON or YAML, using the same parsers as import. Most specifications are published at a URL in YAML, so "paste the JSON" was an awkward requirement
- Contract conformance reports coverage: requests the specification does not describe are named in the report as not covered, and a specification matching none of the requests is reported as a major finding with the likely causes. Previously unmatched requests were skipped silently, which made an untested endpoint indistinguishable from one that passed
- A document that is not an OpenAPI or Swagger specification — a documentation web page, for instance — is rejected with an explanation instead of silently matching nothing
- Contract conformance finds the specification from a documentation URL. It tries the URL as given, then reads the page and up to four of its same-origin scripts for a specification URL — documentation viewers such as Swagger UI name the spec in an initialiser script rather than the HTML — and finally tries the conventional paths on that origin such as /openapi.json and /v3/api-docs
- Import from a documentation URL now runs the same spec discovery the verification lab uses: it checks the URL itself, then the page and its same-origin scripts, then conventional spec paths (e.g. /openapi.json), and parses any OpenAPI/Swagger/Postman/HAR it finds deterministically before falling back to the AI (server/routes/import.js, server/verify/spec.js)

- Pagination suite — walks every page of any request that returns a list and checks the boundaries: a record returned on two pages, records unreachable when the total says otherwise, a total that moves while paging, a page size the endpoint ignores, a cursor that never terminates, and what comes back for a page past the end. Read-only, so it needs no acknowledgement
- Idempotency suite — repeats each PUT and DELETE and compares the results, catching a PUT that increments rather than sets and a delete that errors the second time. A create is only repeated when it already carries an Idempotency-Key, since sending one twice otherwise just creates two records. Fields that move on every call are excluded from the comparison, so a changing `updatedAt` is not reported as a lack of idempotency
- Caching suite — checks each GET for an ETag or Last-Modified, confirms a conditional re-request actually returns 304 rather than the full body again, catches an ETag that changes when the content has not, and flags an authenticated response marked publicly cacheable, which lets a shared proxy serve one user's data to another
- Latency suite — times each GET over a dozen sequential requests and compares the percentiles against a saved baseline. Only safe methods are repeated, so a write is reported as not timed rather than sent twelve times, and the first response is discarded because it pays for DNS, TCP and TLS. A regression must be both proportionally and absolutely large to be reported, so noise on a fast endpoint does not fill the report
- Latency baselines stored per project. The first run is saved automatically, since there is nothing to compare it against; after that, promoting a run is deliberate — a baseline that silently updated itself every run would never show a slowdown that arrived gradually. `GET`/`POST /api/verify/:projectId/baseline`
- Workflow scenarios — ordered runs where each step is one of the project's saved requests and each step's captures feed the next step's variables, so create → read it back → update → confirm works end to end. A failed step stops the run and the steps after it are reported as not run, never as passed. `server/routes/scenarios.js`, with CRUD, a run endpoint and stored run history
- Regression diffing — every scenario run is compared against the previous one. A changed status is reported by severity (working then failing is major; the reverse is information), and a changed response body is reported as information even when every assertion still passes, because a field that quietly changes shape or disappears breaks callers without failing a test
- `server/verify/diff.js` — the volatile-aware structural comparison the idempotency suite and the regression check both use. Timestamps, request ids, ETags and revision counters are excluded, because a diff that reports those is noise and noise teaches people to stop reading the diff
- Diff tab in the response pane, showing what changed since the last time that request was sent — the Phase 2 item that had not been built. Uses a display-only port of the server's diff in `src/lib/diff.ts`; the server module remains the authority for anything that reaches a report
- Scenarios panel in the header: build a scenario from the project's requests, reorder the steps, run it, and read the per-step outcome with what each step captured
- A correct `PUT /good/counter` twin in the fixture, so the idempotency suite is asserted in both directions. It returns a fresh `updatedAt` on every call, which is also what proves volatile fields are excluded from the comparison
- `tests/scenarios.js` and a `test:scenarios` script — 11 tests covering the capture chain, a failed step halting the run, regression diffing in both directions, and the diff's treatment of volatile fields, absent fields and non-JSON bodies

### Added

- **Generated variables, resolved per send: `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`.** Written for the `Idempotency-Key` case, where a request needs a fresh value on every genuine send and typing one in by hand makes the saved request unusable. Two deliberate properties: one value per send rather than per occurrence, so the same `{{$uuid}}` in a header and in the body agree and the recorded run shows what was actually sent; and a variable defined with that name wins, which is how the retry path is tested — an idempotency key only means something if you can also send the same one twice on purpose
- A generated code snippet says when it has frozen a generated value into a literal. Unsaid, a snippet carrying a fixed `Idempotency-Key` looks correct and does the opposite of what the header is for: every run of it is read by the server as a retry of the first

### Changed

- **An imported JSON body now holds the required fields only.** A specification's example demonstrates the endpoint's full range, which is the opposite of what a request you are about to send wants: every optional field arrives holding an illustrative business code, and an API that resolves those codes against its own records rejects the lot. Values come from the example where it supplied one, so the body is the example narrowed rather than a fresh set of placeholders, and the omitted fields are named in the import warnings so nothing becomes invisible. A schema that requires nothing is left exactly as it was, since reducing it would produce `{}`

### Added

- The authorisation suite now flags a framework banner — `x-powered-by`, `x-aspnet-version` — on a response. Not a vulnerability on its own, but free reconnaissance: it narrows a prober's search from "some API" to a specific framework and often a specific version, and removing it is usually one line of configuration

### Fixed

- **The idempotency suite's repeat is now genuinely the same request.** The runner rebuilt the variable scope on every send, so a generated value — `{{$uuid}}` in an `Idempotency-Key`, the case this exists for — resolved differently between the two sends. The suite then compared two different requests, reported that the key was ignored against an API handling it correctly, and left a duplicate record behind. The repeat now runs through a sender whose scope is fixed for its lifetime, which is what makes it a retry rather than a new request

- **A 404 answering an unsupported method is now reported, as a judgement call rather than a defect.** Answering 404 refuses to confirm the path exists, which is deliberate hardening on an undocumented endpoint — but a path taken from a published specification conceals nothing, and only misleads an integrator, who checks their URL, their deployment and their credentials before noticing they used the wrong method. The finding states the trade-off rather than asserting one answer, and notes that a 405 without the `Allow` header RFC 9110 requires is worse than either

- **The unsupported-method probe now sends `GET` rather than `TRACE` to anything that is not itself a `GET`.** TRACE is blocked at the edge by most proxies and WAFs — correctly, since it enables cross-site tracing — so the probe was testing the infrastructure's configuration rather than the API's routing, and no real client sends it. `GET` is the mistake a caller actually makes, reaches the application's own routing, and is safe by definition. TRACE is still used when the request under test is a `GET`, because every alternative there risks changing data on an endpoint nothing is known about
- A non-JSON error carrying a web-server error page is now reported as _infrastructure answering first_ at minor severity, rather than as a major fault in the API's error handling. A proxy returning its own 405 page is usually deliberate hardening; sending the reader to the application team for it wastes their time. The application itself returning a non-JSON error is still major, and both are asserted against their own planted defect in the fixture

- **An error response that is not JSON at all is now reported as major rather than minor, and the finding names the cases that produced each shape.** Two JSON bodies with different keys make a caller write a second branch; a body that is not JSON — an HTML page from a proxy, a plain-text gateway message — makes their parse throw, so the message their user sees is a parse failure rather than anything the API said. The finding previously said only that two shapes existed, which was not something a reader could act on: it now lists the status and the generated case behind each, and carries the odd one out as evidence. A matching planted defect was added to the fixture, so it is asserted in both directions

- **A credential containing a character that cannot be sent in an HTTP header now fails with an explanation instead of the platform's own wording.** Pasting a key from a document or a web page can substitute a lookalike — a Cyrillic `Т` for a Latin `T`, a typographic dash, a non-breaking space — and the result is invisible. The message now names the field and lists _every_ offending character with its position and the script it came from — a source that substituted one lookalike has usually substituted its neighbours too, and reporting them one send at a time turns a single paste mistake into a guessing game. A line break and a tab are named as such rather than as "a control character", since the reader has to recognise them in something they pasted. Checked across bearer tokens, basic auth, API keys and OAuth2 tokens; a query-string API key is left alone, since query values are percent-encoded and survive characters a header cannot carry
- The same path no longer repeats a platform error verbatim when authentication fails for any other reason. `Cannot convert argument to a ByteString because the character at index 14 has a value of 1058` describes a _credential_, so it put a fragment of a secret into a message that travels to the browser — which the equivalent header-handling code had always been careful not to do

- **The imported body no longer violates a schema that permits no entries.** The sampler ignored `maxItems`, so a reserved array capped at zero was imported holding a generated entry — for an API that documents a non-empty value as rejected, the tool produced exactly the payload the docs call invalid. `maxItems` and `minItems` are both honoured now
- **A required field the specification's own example leaves out is filled in from the schema and reported**, rather than imported verbatim and rejected on the first send, which reads as a fault in this tool rather than in the document. Only ever additive: a value the example does supply is never replaced
- The required fields of a request body are now listed in the import warnings, with conditional ones stated separately — `plant` is not required by the request, it becomes required once you choose to send a `plants` entry, and a flat list saying otherwise misleads. An array capped at zero entries is excluded, since its contents can never apply
- `const` is sampled as its only permitted value. OpenAPI 3.1 is JSON Schema 2020-12, where `const` fixes a single literal; it previously fell through to the type and produced a generic `"string"` where exactly one value is valid

- **An operation documenting more than one success status no longer imports a check that fails on a correct response.** The importer took the first 2xx it found, so a create documenting both `201 Created` and a `200` idempotent replay imported an assertion expecting 200 — which fails on every genuine first call. Where a spec documents several success statuses the check now asserts any 2xx, and names the codes in the import warnings so it can be narrowed by hand. A single documented status is still asserted exactly
- Importing a spec with several servers now says which one `baseUrl` was set to and lists the rest. It silently took the first, which is harmless until a spec happens to list production first — at which point an import points a testing tool at live data without a word
- An imported `Idempotency-Key` header is flagged in the warnings, since it arrives holding the spec's example value and reusing it tells the API "this is a retry": the second send replays the first response instead of creating anything

- **Renaming a secret variable no longer destroys it.** Variables were matched by name when a save came in, so renaming one produced a key matching nothing stored — indistinguishable from a brand-new empty secret — and the stored value was silently discarded. Variables now carry a server-assigned id and are matched on that first, so a rename, a reorder, or both in the same save all keep the value. Existing data is migrated on first read (schema v1 → v2), which only adds ids and never reads or rewrites a stored value; `store.js` snapshots `local_data/` beforehand as it does for any migration
- A masked secret that matches nothing stored is now refused with an explanation instead of being written as an empty value. Refusing a save is recoverable; silently discarding a credential the user cannot read back is not. This is the backstop that makes the class of bug above fail loudly rather than quietly

### Changed

- CI workflow synced with build-policy 2.6.2, which adds build, unit, smoke and integration test steps — CI previously verified only that the code was well-formed, never that it runs
- The environment variable editor now has an explicit "+ Add variable" button instead of a trailing blank row, which read as an empty variable
- The Params and Headers tabs now state where their entries are sent — the URL query string and HTTP request headers respectively — since the tab name alone did not make that clear
- Import by URL now follows redirects manually with a limit of five hops, re-checking the scheme at each hop, and reports the redirect chain in the preview so a spec URL that quietly redirects elsewhere is visible. Loopback and private addresses remain reachable on purpose: importing a spec from a local or internal host is a primary use case for a local tool, and the server already sends arbitrary requests by design
- Import now merges variables into the environment you already have, rather than creating a new environment every time. Existing values always win, so re-importing an API never wipes a key you have filled in. Creating a new environment is still available, but is now a deliberate choice in the import preview
- Verification refuses to run against a non-loopback host until the caller confirms they own or are authorised to test it, because the suites send malformed requests and replay them with other credentials
- A suite that cannot run is reported as skipped with the reason, never omitted, so "no findings" is never confused with "not tested"
- The ownership acknowledgement is now required only for the intrusive suites. Negative testing and the authorisation probes send malformed requests and requests with credentials removed or swapped, so they need it; contract conformance only sends the requests the documentation describes and compares the responses, which is what any consumer of the API does anyway, so checking whether an API matches its own published docs no longer requires owning it
- The Run button is disabled until the acknowledgement is ticked when an intrusive suite is selected, with the reason shown beside it, rather than allowing the click and having the server reject it. Both layers enforce it, since a disabled button is a courtesy rather than a control
- The authorisation suite is now labelled "can one user reach another user's data?" and explains insecure direct object reference (IDOR) in full rather than using the acronym alone
- Contract conformance now states what it actually does: it sends the project's saved requests and compares each response against a pasted specification, and only requests matching an operation in the spec are checked
- AI import now keeps documented example values inline in request bodies instead of turning them into empty variables. A body of {"title": "foo", "userId": 1} taken from the documentation is runnable as imported, where one made of empty placeholders could not be sent until the user invented values. Variables are reserved for what changes between environments or callers: the base URL, credentials, and identifiers in the path
- Identifiers in a path are converted to variables named after their resource, carrying the documented literal as the value — /comments/1 becomes /comments/{{commentId}} with commentId set to 1. This is done deterministically rather than left to the model, which was inconsistent about it within a single import. Version segments such as /v1/ and /api/2/ are left alone
- Identical requests from an AI import are deduplicated, keeping whichever description carried more detail
- Resource identifiers found in a documented path (e.g. /posts/{postId}) are now written into each request as literal values instead of becoming environment variables. An environment holds what changes between deployments — the base URL and credentials — whereas an id is per-request data; sharing one id across a project meant the GET, the PATCH and the DELETE all acted on the same record. The base URL and any secret still remain variables (server/import/ai.js)

### Fixed

- DNS timing was never measured — undici's connector does not forward a custom `lookup`, so the DNS phase of the timing waterfall was always null. Resolution is now timed explicitly before connecting, and stays null for IP literals where no resolution occurs
- Replaced a regular expression with nested quantifiers (a ReDoS shape) in the JSONPath reader with a linear scan, since the path comes from user input
- Response cookie values are no longer masked. `set-cookie` was being treated as a credential header, which rendered every cookie as `••••` and made the Cookies tab useless, while the same values remained visible in the response body. Secrets are still masked by value.
- A secret environment variable can now be marked secret before it is first saved. Previously the "treat as secret" toggle only appeared for variables that already existed, so a credential had to be stored in plaintext first and encrypted on a later save — meaning the real value was written to disk (and to any folder sync) at least once
- The environment variable editor no longer saves on every keystroke; edits are held locally until "Save variables" is pressed, so a partially typed credential is never written at all
- Secret values now render as password fields and clear on focus, so typing replaces the stored value instead of appending to the mask
- Fixed a React cascading-render pattern: the variable editor synced props via setState inside an effect, and now derives the state during render instead
- Unsaved request edits are no longer discarded. Switching between requests, or moving/copying to another project (which reloads the project), replaced the editor with the stored copy and silently threw away anything typed but not saved. Edits are now stashed per request and restored when you switch back, and move/copy no longer touches the editor at all
- API key and secret variable fields are no longer `type="password"`. A password input made the browser offer to save the key to its own vault and sync it to the user's cloud account, contradicting the promise that keys stay encrypted on this machine. The fields are masked with CSS instead, and opt out of password managers
- After applying an import, the newly created or updated environment is selected. Previously the app selected the first environment in the project, which left an imported baseUrl unselected and every imported request failing with an unresolved variable
- A URL still containing an unresolved variable now names the variable and points at the environment, instead of reporting "is not a valid URL", which sent people looking for a typo
- AI imports no longer name the environment after the model's summary sentence, which produced names like "Domain Reputation API v2 - Single endpoint for evaluating domain and IP address reputation based on security data source". The suggested name is now the documentation host, with the summary shown as a description
- The environment selector no longer stretches the whole bar. A select sizes itself to its widest option, so one long environment name pushed the controls beside it off-screen; the selector is now width-bounded and truncates
- A credential appearing both in the auth configuration and again as a parameter is no longer sent twice; the duplicate is removed, which previously meant an empty apiKey rode alongside the real one
- Verification now refuses to run, rather than reporting a pass, when no request can be addressed — an unselected environment left every URL holding an unresolved variable, every send failed, and the run reported "passed" having tested nothing
- The contract suite no longer reports the same defect twice as both an undocumented status and a convention violation
- The contract suite no longer flags any POST returning 200 as needing 201; validate, search and action endpoints legitimately return 200, and only a contradiction of the documented status is reported
- The test fixture now handles malformed input with a generic 400 instead of Express's default HTML stack-trace page, so its correct endpoints are actually correct
- `test:verify` was missing from the test script chain, so the verification tests never ran as part of the suite or in quality gates
- The verification lab now uses the environment selected in the header by default, and states which environment its variables come from. The environment picker had only appeared when configuring identities for the authorisation suite, so running any other suite sent no environment, left every variable unresolved, and the run refused with "nothing was tested"
- The authorisation suite now swaps only the secret variables between identities, not the whole environment. If both environments defined a resource id, the replay asked for the second user's own resource, which is permitted, so the cross-user check silently passed while testing nothing. The resource is now held constant and only the credential changes
- The Lab and Settings header links now share identical styling. Lab was styled brighter, which implied it was the active page
- Supplying a documentation web page to contract conformance produced the import parser's error, which mentioned Postman collections, HAR files and AI import — none of which apply. The message is now contract-specific, says a machine-readable specification is needed, and notes that negative testing still applies to an API that only publishes prose documentation
- AI import left a redundant query parameter behind on requests where the path already carried the same id (e.g. GET {{baseUrl}}/posts/1 with an unticked-but-present id=1 in Params). The check originally only recognised a duplicate when a {{variable}} was involved, such as a path {{postId}} paired with a separate id parameter. However, the model often skips variables and copies the documentation's example address verbatim (GET {{baseUrl}}/posts/1) while still listing id: 1 in Params, causing requests to go out as /posts/1?id=1. The check now runs before path ids are inlined and compares parameter values against both variable names and literal path segments, guarded to fire only when both the parameter name reads like an identifier and its value is shaped like one; genuine filters such as /comments?postId=1 (where id appears nowhere in the path) remain enabled. The warning explaining the untick now fires. (server/import/ai.js)

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
- A request containing an unresolved variable is now refused instead of being sent with the placeholder left in it. In a URL that meant requesting a path called %7B%7BpostId%7D%7D; in a JSON body it produced invalid JSON. Both surfaced as a confusing complaint from the API rather than the real cause, which is an empty variable. The error names the variables and says where to set them. Deliberately malformed input that the user typed is still sendable, since negative testing depends on it
- AI import no longer lists a path variable as a query parameter as well. The model conflated endpoints such as GET /posts/1 and GET /comments?postId=1, producing /posts/{{postId}}?postId=... The duplicate query parameter is now unticked and reported so it can be re-enabled if an API genuinely takes the value twice
- Credentials referenced by an imported request's Auth tab ({{apiKey}}, {{username}}, {{password}}) were never added to the environment, so every imported authenticated request failed with an unresolved placeholder. They are now created as secret variables with an empty value, ready to be filled in (server/import/ai.js)
