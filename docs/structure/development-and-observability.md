# Development And Observability

Last audited: 2026-08-27.
Targeted source check: 2026-09-08 (remote diagnostics, browser collection, and operator boundaries).

Use this guide for local/full-stack servers, request and generation tracing,
browser startup telemetry, startup and bundle verification,
built-SPA serving, browser support, and runtime environment variables. Package
scripts, test lanes, typechecks, formatting, CI, and deployment policy remain in
[Testing And Operations](testing-and-operations.md).

## Local Dev

Run API and client in separate terminals:

```sh
pnpm api:dev
pnpm dev
```

For agent-driven work where source edits should not restart the API
automatically, use:

```sh
pnpm api:dev:flag
touch .risu-api-restart
```

The flag runner removes stale flags on startup and deletes the flag after
consuming a restart request. `RISU_API_RESTART_FLAG=/path/to/file` changes the
sentinel path.

`pnpm analyze:db` accepts `.risu`, JSON/database JSON, and data directories
that contain `db.json`; when matching SQLite sidecars are present it copies
those too. It does not inspect a current SQLite-only `data/` directory without a
legacy JSON payload.

Vite proxies `/api` to `RISU_API_PROXY_TARGET` or `http://localhost:6002`.
Fastify defaults to `0.0.0.0:6002`. Vite dev changes only how the SPA bundle is
served; `src/ts/platform.ts` still makes the browser Fastify-backed.

`pnpm dev:agent` and `pnpm dev:human` run both Fastify and Vite through
`util/agent-dev.ts`; they set `RISU_API_TRACE_MODE` to `agent` or `human`,
respect `RISU_AGENT_DEV_HOST` / `RISU_AGENT_DEV_PORT` /
`RISU_AGENT_API_PORT`, default `RISU_AGENT_DEV_AUTH_BYPASS=TRUE` for
`dev:agent` and `FALSE` for `dev:human` unless overridden, default
`RISU_API_STATIC_ROOT=none`, default `VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS=TRUE`,
and proxy `/api` to the spawned API port.
The shared runner host defaults to `127.0.0.1` in agent mode because that mode
bypasses authentication. Human mode discovers its active Tailscale IPv4 address
with `tailscale ip -4` and binds only to that address, so public and LAN
interfaces remain closed. It falls back to `127.0.0.1` when Tailscale is
unavailable. Set `RISU_AGENT_DEV_HOST` explicitly to override either default.
The spawned API uses `tsx watch`, so API source edits restart it; use
`pnpm api:dev:flag` when you need edit-triggered restarts to be manual.
Vite scans all production TypeScript and Svelte modules for dependencies during
startup, including lazy routes and optional frontend features, while excluding
tests, fixtures, declarations, and test harnesses. The resulting pre-bundle is
cached under `node_modules/.vite/` for later `dev:agent` and `dev:human` runs.

In agent mode without an explicit `RISU_API_DATA_DIR`, the runner prepares
`data-agent/` before spawning Fastify. Default `clone` mode takes an online
SQLite snapshot and links or copies `assets/` and `save/`; it intentionally
omits auth files, backups, traces, and Web Push keys. `fresh` starts empty, while
`keep` reuses the existing sandbox. Human mode uses `data/` directly.

Stop `pnpm dev:agent` when done so frontend port `6418` and API port `6419`
are released for the next agent. Do the same for `pnpm dev:human` when using
the human trace ports.

Tracked utilities that are not package-script-backed include
`util/risuUserscript.user.js`, a manual browser/userscript bridge. Treat it as a
source helper, not generated output.

## Request And Generation Tracing

Request tracing writes under the active server data directory as
`trace/<mode>.jsonl`. The standard runners therefore use
`data-agent/trace/agent.jsonl` for `dev:agent` and `data/trace/human.jsonl` for
`dev:human`. While tracing is enabled, every response receives
`X-Request-UID`, but only API requests are appended to JSONL; search that UID in
the trace file to correlate a visible failure to one API call.
Each mode keeps the newest 5,000 entries and trims older entries, including
their gzip body sidecars. Entries include route pattern, caller hints, redacted
headers/query/body fields, and process/send timing. Text request/response bodies
up to 4 KiB are inlined; larger captured text bodies are written as `.gz`
sidecars under `<data-dir>/trace/bodies/<mode>/` with a preview when the
compressed sidecar is at most 10 MiB. Oversized compressed bodies, multipart,
binary, SSE, and stream bodies are recorded as omitted metadata.

Generation trace sidecars are separate and opt in only when protocol metrics are
enabled and `RISU_GENERATION_TRACE_FULL_PROMPT=1`. They write redacted
prompt-emission payloads and OpenAI/Gemini provider request bodies under
`<data-dir>/trace/generation/`, capped by
`RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES`.

Post-generation Lua flow tracing also uses `RISU_PROTOCOL_METRICS=1`. When
`editOutput` or `onOutput` Lua runs after provider completion, the server emits
`generation_lua_post_generation_trace`. The metric line stays metadata-only:
run counts, `editOutput` text changed, transcript changed, Lua `log()` count,
`LLM`/`axLLM` attempted/blocked/completed/failed counts, and `setChat` changed
counts. Its `bodySidecar` points at a compressed JSON file under
`<data-dir>/trace/generation/` with the detailed chat body before/after each
phase, `editOutput` text before/after, and captured Lua `log()` values. Use this
when debugging whether post-generation Lua ran, whether `setChat` changed the
assistant row, or whether low-level LLM calls were blocked.
Lua sidecars require protocol metrics but not the full-prompt flag; they use the
same compressed-size cap. These files can retain redacted user prompt/chat
content and should not be shared casually.

## Remote Support Diagnostics

Remote access is explicitly enabled with `RISU_SUPPORT_DIAGNOSTICS=1` and
`RISU_SUPPORT_DIAGNOSTICS_VERIFIER=/private/operator/directory/verifier.json`.
Collection also requires `RISU_CLIENT_DIAGNOSTICS=1`. The verifier must be outside
the repository, data directory, and static root. Its directory must be private,
its file mode 0600, and symlinked paths are rejected. Missing, invalid, revoked,
or expired credentials fail closed. The dedicated bearer credential never
enters the ordinary application auth registry or bootstrap. Readers/writers,
uninitialized servers, and development auth bypass do not grant support access.

Operator provisioning uses the local `pnpm diagnostics:credential` script:

```sh
# Create private directories first, then choose fixed operator-owned paths.
export RISU_SUPPORT_DIAGNOSTICS_VERIFIER=/private/operator/directory/verifier.json
export RISU_DIAGNOSTICS_REMOTE_CONFIG=/private/transfer/directory/production.json
export RISU_DIAGNOSTICS_REMOTE_ORIGIN=https://your-risu-host.example
pnpm diagnostics:credential mint
```

The tool writes an exclusive mode-0600 config containing a random 32-byte hex
token and the fixed HTTPS origin; it prints only a fixed success category. The
verifier retains only SHA-256 digests, random credential IDs, and bounded
lifecycle times. Move the plaintext config to the development environment over
an operator-controlled secure channel, keep it outside Git, and remove the
transfer copy. Provision a separate credential for each environment. A private
file reduces accidental exposure; it cannot hide its token from unrestricted
shell access. Server-side authority is the access boundary.

Default expiry is 30 days, with a hard 90-day maximum and at most 16 credentials.
Operators can inspect credential IDs and expiry metadata in the verifier without
printing plaintext credentials. To rotate, select a new exclusive output config
path and run `pnpm diagnostics:credential rotate <credential-id>`; old-token
overlap is at most 24 hours. `pnpm diagnostics:credential revoke <credential-id>`
revokes immediately for subsequent reads. Remove an abandoned `.lock` only after
confirming no lifecycle command is running. Disabling support reads does not
change application data, revisions, writer state, or the manual workflow below.

`GET /api/v1/support/diagnostics` accepts the token only in
`Authorization: Bearer`. Serve it through verified HTTPS. It reads only the
sanitized collector, never request history, raw trace files, logs, bodies,
sidecars, assets, backups, or domain records. All diagnostic namespace traffic,
including rejected bodies/methods/subpaths, is excluded from automatic request
logging and raw tracing; bounded access outcomes contain fixed categories only.
The route policy is `diagnostics-read`, separate from application `required`.
Existing deliberately public routes keep their public behavior.

The version-1 envelope remains exact and includes sequenced entries, validated build
identity (`RISU_BUILD_ID`, otherwise unknown), random process identity, capture
bounds, source availability, loss, truncation, and pagination. V1 projects known
server facts from the journal; it excludes browser uploads and rich-only fields.
Stack coordinates are omitted from all remote output. Request `version=2` for
exact deployment, HTTP, runtime, display, generation, prompt, provider, persistence,
script, browser, and compatible legacy event families. V2 adds stamped
provenance, pending work, operation continuity, and explicit browser clock
semantics. Journal loss counters describe server admission/retention; browser
delivery loss remains unknown, with client sequence gaps showing possible
omissions. No v2 payload is labeled v1. The ordinary version-1 manual report
stays intact.

Failed display-source batches emit one request-correlated, v2-only `display`
event. Its fixed fields distinguish revision, namespace, scoped persistence
load, strict decode, scope resolution, shared dependency, target preparation,
and postcondition failures. Strict generation-input failures additionally carry
only a finite owner category, validation rule, rejected value kind, and a
16-hex reference derived from the schema field name. The reference is intended
to be resolved against the deployed generation-input schema; the event never
contains the field name, JSON instance path, array index, persisted value, or
character/chat/message identifiers. Other failure kinds cannot carry validator
metadata, and browser uploads cannot publish this server-only family.

Filters are version, from/to epoch milliseconds (maximum 24 hours, default last
hour), limit (default 50, maximum 200), generated requestUid/operationRef,
category, and cursor. V1 has no operation references and returns no matching
records for that filter. No raw/free-text/file/query-language options exist.
Continuation accepts only cursor and version. Immutable sequence pages expire
after 5 minutes and are bounded to 32 snapshots, 2,000 events/2 MiB per snapshot.
Concurrent recording does not move events between pages. Clocks do not establish
causal order. Responses are capped at 512 KiB; access is capped at 30 reads per
minute per IP and a 10-second request deadline.

Every outcome uses `Cache-Control: no-store`: 401 unauthorized, 400 invalid-query,
429 rate-limited, 503 disabled/storage-unavailable, 409 collection-disabled,
410 cursor-expired, and 500 internal-error. Successful empty windows return 200
with no entries. Errors contain fixed categories and never echo filters or
credential material. Restart invalidates cursor snapshots while retained journal
evidence and sequence numbers survive within the limits below.

In the development environment, set `RISU_DIAGNOSTICS_REMOTE_CONFIG` to the
private transferred config, then run:

```sh
pnpm diagnostics:remote --limit=50
pnpm diagnostics:remote --version=2 --requestUid=<generated-request-uid>
pnpm diagnostics:remote --version=2 --operationRef=<opaque-operation-reference>
pnpm diagnostics:remote --version=2 --cursor=<returned-cursor>
```

`util/diagnostics-remote.ts` accepts only the finite query flags above; it has no
per-request destination/header/output-file override. It verifies TLS, rejects
redirects and unexpected content types, bounds both compressed and expanded
responses to 512 KiB, and validates the complete exact schema before printing
one JSON envelope. Failures print only a fixed category to stderr. Remote HTML,
headers, stacks, and arbitrary error bodies never become fallback output.
`util/diagnostics-remote.test.ts` exercises the real CLI with temporary HTTPS
fixtures, including a trust chain, rejected TLS/redirects, compressed limits,
timeout, malformed schemas, and credential/content canaries.

Source owners are `server/fastify/src/remoteDiagnostics.ts`,
`server/fastify/src/supportDiagnosticsAuth.ts`, and the exact contract in
`packages/protocol/src/remoteDiagnostics.ts`. Focused authorization, paging,
privacy, limits, and lifecycle tests are in `remoteDiagnostics.test.ts` and
`supportDiagnosticsAuth.test.ts` under the server test directory.

### Retention, Correlation, And Failure Isolation

When collection and either support reads or browser upload are enabled, safe
records go to `<data-dir>/diagnostics/journal.sqlite` in a dedicated worker.
The private directory is mode 0700 and files are mode 0600. Its independent
random `correlation.key` creates opaque operation/attempt references; neither
the key nor its domain-ID mapping is exported. Static serving cannot encompass
this directory. Asset/legacy-storage routes and domain backup/export producers
use their own bounded roots and do not include it. Startup rejects canonical
path overlap with asset, save, backup, or static roots, including retained
diagnostic files after collection is disabled. Static and application file reads
also reject child symlinks resolving to diagnostics or the configured verifier;
unrelated public file symlinks remain usable. Metadata-owned asset backup copies
reject symlink sources before copying bytes.

Hard limits are 24 hours, 10,000 retained events, 8 MiB of retained JSON, 4 KiB
per record, and 256 queued/in-flight records. SQLite is capped at 16 MiB with
DELETE rollback journaling, which can temporarily require another bounded file.
The worker processes at most one request at a time, writes up to 32 records per
batch, and has a one-second request deadline. Startup revalidates every record,
purges invalid rows, and prunes age/count/bytes before exposing evidence.
Unavailable, corrupt, full, or stalled storage yields fixed unavailable/loss
outcomes. Collection never writes to domain tables or waits in generation,
command acceptance, recovery, or writer transitions. Close is bounded.

Server receive sequence orders retained records. Browser timestamp and request
associations are client assertions with unknown skew. Async operation scope
survives request-UID eviction and covers background finalization and restart
recovery. Operation references survive restart when the private key is retained;
key failures explicitly report `process-only` continuity. Authoritative data
replacement changes the journal epoch, clears old records/provenance and local
collector state, and invalidates cursors and stale operation contexts.

Provider events distinguish dispatch, response headers, and terminal outcomes;
an ambiguous disconnect after dispatch does not establish safe replay. Timing
uses monotonic clocks. Byte sizes are buckets; first-token timing is measured
at the parsed provider boundary where supported. Stream gaps measure awaited
upstream reads, excluding local consumer work. Missing measurements stay absent.
Prompt events contain role/media/selection counts and token budget/truncation
facts. Persistence events distinguish journal, authoritative commit, cleanup,
retry, and recovery. Server Lua events count hooks and host permissions and
compare output/transcripts locally with fixed work budgets; unavailable
comparisons are explicit. Browser V3 output listeners emit only invoked/failed
counts and duration under client provenance; host-call counts and content-change
comparisons remain explicitly unmeasured. They never import Lua/plugin logs,
hashes, or sidecars.

To roll back remote collection, disable `RISU_SUPPORT_DIAGNOSTICS` and
`RISU_BROWSER_DIAGNOSTICS`, and revoke the support credential. Keep
`RISU_CLIENT_DIAGNOSTICS=1` for the original manual workflow. No chats, presets,
domain revisions, or writer state need changing. Stop the server before removing
the dedicated diagnostics directory. Unsupported newer journal formats fail
closed; do not attempt an in-place downgrade. Archive or remove that telemetry
directory under operator control if an older version must start fresh.

### Browser Upload

`RISU_BROWSER_DIAGNOSTICS=1` separately opts in to ordinary authenticated
bootstrap `browserDiagnostics: { version: 1 }`; collection must also be enabled.
Support reads may be disabled independently. `POST /api/v1/diagnostics/browser`
accepts ordinary authenticated readers and writers without acquiring ownership.
A support bearer is never app authentication and cannot upload. Complete exact
batches are validated before any storage: up to 32 events, 64 KiB per request,
and 4 KiB per stamped record. The server assigns receive time and provenance;
clients cannot submit server families, server origin, or trusted operation IDs.
Unknown or content-bearing fields reject the batch without echoing them.

The publisher buffers pre-bootstrap safe evidence, sends only after compatible
opt-in, and retains at most 256 pending events for five minutes with finite
retry/backoff. Auth loss, opt-out, and data/session changes abort stale work and
clear the pending context. Tab/event identities support reload-safe deduplication;
distinct tabs use separate identities. Diagnostic transport is excluded from
capture, so upload failures do not recursively create events. New clients
disable the older startup publisher while the richer upload is enabled; old
client/server combinations preserve the existing startup/manual behavior.

V2 reads report browser `available` only when matching uploaded evidence is
present; `none` means enabled without matching evidence and `not-supported`
means uploads are disabled/unsupported. Authenticated manual reads negotiate
`GET /api/v1/diagnostics?version=2&limit=200` and combine local history with
uploaded evidence by source/event identity. The panel preserves offline export,
clipboard and selectable-text fallback, marks partial/lost evidence, and falls
back to exact v1 responses from older servers.

## Client Diagnostics

`RISU_CLIENT_DIAGNOSTICS=1` enables a content-free recent-event viewer in
Settings → Advanced → Diagnostics, with text download, clipboard copy, and
selectable report text for mobile browsers without clipboard access. If the
variable is unset, `RISU_API_TRACE_MODE=agent` or `human` also enables it;
`RISU_CLIENT_DIAGNOSTICS=0` explicitly disables it even in trace mode. This
flag does not enable protocol metric console output or full-prompt sidecars.

Authenticated bootstrap advertises `clientDiagnostics: { version: 1 }`.
Authenticated, read-only `GET /api/v1/diagnostics` returns at most 300 server
events with `Cache-Control: no-store`; active-writer ownership is not required.
Disabled servers return an empty, disabled response. The server collector is
owned by the Fastify app and resets on restart. It records HTTP status/timing,
runtime errors, warning/error logger calls, and selected correlated protocol
metrics. It generates `X-Request-UID` even when body-capable tracing is off.
Metric subscriptions use app/history-scoped operation context where available,
with a bounded recognized-request fallback, and are removed on close.

Browser capture starts before bootstrap, retaining a bounded pending queue until
the server's opt-in arrives. Missing/unsupported opt-in discards it. Enabled
capture records fetch status/time-to-response-headers/request UID, network
failures, global errors/rejections, console warnings/errors, connectivity,
startup events, and generation recovery. It retains 300 entries in memory and
best-effort tab-scoped `sessionStorage`, revalidates them after reload, and clears
them on auth loss or server opt-out. Fetch capture never reads or clones response
bodies, including streams. Opening/refreshing/exporting the panel reads server
events; collection does not require DevTools or the panel to be open. If that
read fails, the report still includes browser events and previously loaded
server events, explicitly marked unavailable for refresh.

`packages/protocol/src/diagnostics.ts` owns the exact-key contract and projection.
Only fixed event/error/route identifiers, numeric timing/status fields, random
request UIDs, and application code coordinates are retained. Raw messages,
prompts, request/response bodies, credentials, headers, URLs, domain IDs,
plugin/Lua values, free-form log arguments, and error messages are excluded at
capture, not merely hidden in the viewer. Error stacks retain only application
file/line/column coordinates after removing the complete error message. Exports
re-project records and add only app version, coarse browser/OS families,
connectivity, viewport size, and export time. No settings, request-history rows,
or trace files are read by this feature. Existing Show Request Logs and Request
History remain separate content-bearing tools.

Implementation owners are `server/fastify/src/clientDiagnostics.ts`,
`src/ts/diagnostics.ts`, `src/ts/server/clientDiagnostics.ts`, and
`src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte`. Focused tests are
`server/fastify/__tests__/clientDiagnostics.test.ts`,
`src/ts/diagnostics.dom.test.ts`, and
`src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte.test.ts`.

## Browser Startup Telemetry

Browser startup telemetry is an opt-in `browser_startup` protocol metric. Set
`RISU_PROTOCOL_METRICS=1` (or another documented truthy value) on a Fastify
instance to advertise `{ version: 1, sampleRate: 1 }` in its authenticated
bootstrap response. The browser starts a best-effort publisher before its first
startup attempt, but sends nothing unless that response opts in. A missing,
malformed, or unsupported configuration disables collection and clears the
pending queue. Version 1 is deliberately unsampled: `sampleRate: 1` means every
startup served by an opted-in instance is measured. Use deployment/server
cohorts for a bounded rollout; version 1 does not perform per-browser random
sampling.

The authenticated `POST /api/v1/telemetry/startup` route accepts at most 16 KiB
and 32 events per batch without requiring active-writer ownership. Before
opt-in, the browser retains at most 64 metadata events in memory. It removes a
batch before requesting auth or sending, uses `keepalive`, does not await the
request from the readiness path, and never retries a failed batch. There is no
startup-telemetry table or sidecar: Fastify emits validated events only through
the existing structured logger and in-process metric subscribers. The
application therefore has no durable raw-event retention of its own. A rollout
log sink must cap raw `browser_startup` retention at 14 days; derived aggregates
may be retained for at most 90 days. Record the sink owner and deletion policy
before using those aggregates for a rollout decision.

The v1 event contract contains only:

- `phase-ready`: stable milestone, monotonic duration from `entry`, bounded
  attempt count, and observer-shell rollout mode;
- `attempt-completed`: bounded attempt duration, attempt count, and rollout
  mode;
- `attempt-failed`: those attempt fields plus a stable failure code and
  milestone; and
- `diagnostic-failure`: a stable code and milestone for a localized capability
  failure that did not necessarily fail the startup attempt.

The server adds only schema version and the random request UID used to correlate
the fixed telemetry endpoint with request timing. Exact-key validation rejects
unknown or content-bearing fields. Character, chat, message, prompt,
plugin-storage, credential, account, and route-content values are not part of
the contract. Request tracing records the fixed route and timing but always
marks its request body `telemetry-metadata`; it never stores the body inline or
in a gzip sidecar. Auth headers retain the request tracer's normal redaction.

Aggregate `phase-ready.entryDurationMs` and
`attempt-completed.attemptDurationMs` as distributions grouped by schema
version, milestone, and `observerShellEnabled`. Track retry pressure from
`attemptCount`, fatal startup outcomes from `attempt-failed`, and localized
capability health from `diagnostic-failure`. Do not group by request UID or join
it to user/domain data. Compare small/large-database and observer flag-off/on
cohorts before rollout; a duration regression, rising retry count, or new fatal
failure rate blocks promotion even if background readiness eventually arrives.

### Startup failure-code taxonomy

| Code                                        | Meaning                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `writer-bootstrap-failed`                   | The writer bootstrap attempt could not establish its required observer/writer boundary. |
| `push-initialization-failed`                | Optional push-notification runtime initialization failed before background readiness.   |
| `plugin-initialization-failed`              | Plugin runtime initialization did not reach coherent plugin readiness.                  |
| `generation-recovery-failed`                | Startup could not reconcile or reattach the active generation projection.               |
| `selected-character-hydration-failed`       | The selected character detail needed for chat readiness could not be hydrated.          |
| `selected-chat-hydration-failed`            | The selected chat/message projection needed for chat readiness could not be hydrated.   |
| `selected-prompt-template-hydration-failed` | The selected prompt-template detail needed for generation could not be hydrated.        |
| `runtime-initialization-failed`             | Another optional background runtime failed before background readiness.                 |

Telemetry is diagnostic-only on both sides. Browser listener exceptions,
authentication failures, network errors, and rejected fetch promises are
caught or detached. Server logger/subscriber exceptions are isolated from the
204 response. None of these paths can grant, revoke, delay, or otherwise change
`canRenderShell`, `canApplyRoutes`, `canMutate`, or `canGenerate`.

## Startup And Bundle Verification

Use Node.js 24 or newer, install Chromium once with
`pnpm exec playwright install --with-deps chromium`, and run:

```sh
pnpm verify:fast-bootstrap
```

This command runs `measure:fast-bootstrap` first: a production
initial-preload/boundary build, a browser-smoke build, and the small/large
cold/warm startup matrix. It then runs the direct-link and recovery integration
matrix. Each browser journey gets a disposable authenticated Fastify instance,
temporary SQLite/data directory, request trace, and imported fixture; writer
identity, outbox state, cache state, and revisions do not leak between journeys.

The small fixture in `server/fastify/browser-smoke/fastBootstrapHarness.ts` is a
minimal deterministic character/chat database. The large fixture in
`test/fixtures/largeCorpusFixture.ts` is shared with client/server load-cost
tests and deliberately expands characters, chats, messages, collections,
lorebooks, and summary fields. Cold and warm browser/resource caches remain
separate populations. The integration matrix runs both fixtures with the
observer override disabled and enabled, derives direct-link cases from the
production route manifest, and uses isolated fixtures for replay, event-gap,
takeover, and failure-injection journeys. Direct links run in independently
isolated batches in `startupDirectLinks.spec.ts`; the remaining journeys stay
file-serial in `startupRecoveryIntegrationMatrix.spec.ts`. Each worker writes a
unique partial artifact stamped with the current Playwright run ID. Global
teardown requires matching run IDs, all expected startup/recovery/writer/runtime
scenario identities, valid result payloads, and manifest-correct route batches
before emitting the combined report. Failed or incomplete merges retain partial
diagnostics and remove previous final outputs; focused partial execution cannot
certify a complete matrix. Independent startup-matrix and locale artifacts keep
their own producer-invocation ownership.

The cache-population matrix records cold startup metrics before waiting for the
optional cache write lane to become idle. Only then does it measure the warm
reload. This passive fixture prerequisite does not make IndexedDB persistence
part of startup readiness or prove immediate-reload cache completeness.

Generated files are local evidence and are ignored by Git:

| Files under `fast-bootstrap-results/`      | Contents                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bundle-boundaries.json` / `.txt`          | Entry and immediate-startup closures, HTML-preload agreement, protected-boundary violations, and largest chunks.                    |
| `initial-preload.json` / `.txt`            | Initial JavaScript files, raw/gzip totals, largest file, and both budget comparisons.                                               |
| `startup-matrix.json` / `.txt`             | Small/large cold/warm milestones, payload/cache totals, early mutation/generation counts, request UIDs, and safe trace summaries.   |
| `fast-bootstrap-integration.json` / `.txt` | Observer flag-off/on timings, direct links, replay/event-gap results, takeover results, and optional-runtime failure/retry results. |

`util/initial-preload-budgets.json` is authoritative. The ratified hard gates are
921,600 bytes (900 KiB) total initial JavaScript gzip and 512,000 bytes (500
KiB) for the largest initial file. The report exits nonzero when either gate
fails. The boundary report independently fails when the HTML preload list
differs from the computed entry closure or when a protected database, export,
or optional-surface module re-enters that closure. Startup matrices additionally
require zero user mutation before `writer-ready` and zero generation before
`chat-ready`.

Interpret failures from the first failing layer:

1. For `build:initial-preload`, inspect `bundle-boundaries.txt` first for a
   closure mismatch or named module violation, then `initial-preload.txt` for the
   total/largest-file budget and per-file contribution. Do not loosen a budget
   without before/after artifacts and a named dependency.
2. For the startup matrix, compare cold only with cold and warm only with warm.
   Check milestone ordering/durations, resource payload/cache totals, and the two
   early-request counters. The JSON request UIDs and safe trace summaries identify
   the resource or bootstrap call responsible for a payload/timing change.
3. For integration failures, read the matching section of
   `fast-bootstrap-integration.txt`: startup behavior, direct links, recovery, writer,
   or optional runtime. The JSON retains
   exact revisions, command attempts, receipt acknowledgements, requested paths,
   capabilities, localized failure state, and Retry outcome. Playwright retains
   a trace on failure under `test-results/` when the browser/UI transition itself
   needs inspection.
4. In an agent or human dev session, take the response's `X-Request-UID` and run
   `rg "<uid>" data-agent/trace/*.jsonl` or
   `rg "<uid>" data/trace/*.jsonl`. Startup telemetry failures use the stable
   taxonomy above; route/content values are intentionally absent.

CI runs `pnpm build:initial-preload` in its dedicated initial-preload lane and
uploads both report families. The normal smoke lane discovers the integration
spec with the other browser owners and uploads the startup matrix,
`fast-bootstrap-integration.*`, and Playwright results. The explicit
`verify:fast-bootstrap` wrapper remains a local convenience that also
runs the standalone preload measurement first. Do not commit
`fast-bootstrap-results/`, `test-results/`, `dist/`, trace data, or temporary
fixture databases.

## Built SPA Serving

To serve a built SPA through Fastify:

```sh
pnpm build
pnpm api:start
```

`RISU_API_STATIC_ROOT` defaults to `<repo>/dist`; empty string, `none`, or `off`
disables Fastify static serving.

## Browser Support

The production client follows Vite's `baseline-widely-available` target as of
Vite 8: Chrome and Edge 111+, Firefox 114+, and Safari/iOS 16.4+. Vite applies
syntax transforms for this target but does not add runtime polyfills.

`src/ts/polyfill.ts` therefore checks only runtime features used by the client
and loads their focused `core-js` modules when a claimed runtime is incomplete.
Buffer, stream constructors, and mobile drag/drop are installed before the full
application module graph is evaluated; their implementations are downloaded
only when the corresponding native/global capability is absent or the platform
requires the drag/drop workaround.

## Environment Variables

Server:

| Variable                                           | Default                         | Notes                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RISU_API_HOST`                                    | `0.0.0.0`                       | Fastify listen host.                                                                                                                                                                            |
| `RISU_API_PORT`                                    | `6002`                          | Fastify listen port.                                                                                                                                                                            |
| `RISU_API_DATA_DIR`                                | `<repo>/data`                   | SQLite, asset bytes, backups, auth files, traces, and legacy import artifacts.                                                                                                                  |
| `RISU_API_ALLOW_MISSING_DATABASE`                  | unset                           | Set to `1` only to accept creating a fresh `risu.db` when the data directory contains evidence of a prior installation.                                                                         |
| `RISU_API_BODY_LIMIT`                              | `104857600`                     | JSON/body and multipart file limit.                                                                                                                                                             |
| `RISU_API_IMPORT_MAX_BYTES`                        | unlimited                       | Streamed device-backup import limit; positive byte count caps, `0`/`unlimited`/`none`/`infinity` opts out.                                                                                      |
| `RISU_API_AUTOMATIC_BACKUP_RETENTION`              | `3`                             | Positive count of automatic pre-import/pre-restore safety snapshots to retain; manual backups are never pruned.                                                                                 |
| `RISU_REALM_IMPORT_MAX_EXPANDED_BYTES`             | `325058560`                     | Expanded payload cap for streamed Realm `charx` imports and Realm-fetched asset totals.                                                                                                         |
| `RISU_API_TRACE_MODE`                              | unset                           | Enables API request tracing when `agent` or `human`; `0`/`false`/`off`/`none` disable it.                                                                                                       |
| `RISU_GENERATION_TRACE_FULL_PROMPT`                | unset                           | Set to `1` with protocol metrics enabled to write redacted prompt-emission and OpenAI/Gemini request sidecars.                                                                                  |
| `RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES` | `10485760`                      | Maximum compressed size for prompt/provider and post-generation Lua trace sidecars.                                                                                                             |
| `RISU_WEB_PUSH_VAPID_PUBLIC_KEY`                   | unset                           | Optional Web Push VAPID public key. If both keys are omitted, the server can generate and persist keys under `<data-dir>/__web_push_vapid_keys.json`; supplying only one key disables Web Push. |
| `RISU_WEB_PUSH_VAPID_PRIVATE_KEY`                  | unset                           | Optional Web Push VAPID private key. Must be supplied with the public key when using env-provided keys.                                                                                         |
| `RISU_WEB_PUSH_CONTACT`                            | `mailto:risuai@example.invalid` | Web Push contact subject used for VAPID details.                                                                                                                                                |
| `TRUST_PROXY`                                      | `false`                         | Fastify trust proxy setting; accepts boolean, integer, or string.                                                                                                                               |
| `RISU_API_STATIC_ROOT`                             | `<repo>/dist`                   | Static SPA root; empty, `none`, or `off` disables.                                                                                                                                              |
| `RISU_HUB_URL`                                     | `https://sv.risuai.xyz`         | Hub passthrough target.                                                                                                                                                                         |
| `RISU_REALM_URL`                                   | `https://realm.risuai.net`      | Realm character import target.                                                                                                                                                                  |
| `RISU_AGENT_DEV_AUTH_BYPASS`                       | disabled                        | Direct-server dev escape hatch; full-stack runners override it as described below.                                                                                                              |
| `LOG_LEVEL`                                        | `info`                          | Use `silent` to disable Fastify logger.                                                                                                                                                         |
| `RISU_CLIENT_DIAGNOSTICS`                          | follows API trace mode          | Enables the authenticated recent diagnostics viewer/export; explicit `0` disables it even in `agent`/`human` trace mode.                                                                        |
| `RISU_SUPPORT_DIAGNOSTICS`                         | disabled                        | Exact `1` enables separately authenticated support reads; requires collection and a protected verifier file.                                                                                    |
| `RISU_SUPPORT_DIAGNOSTICS_VERIFIER`                | unset                           | Absolute operator-owned verifier path outside repository/data/static roots.                                                                                                                     |
| `RISU_BROWSER_DIAGNOSTICS`                         | disabled                        | Exact `1` opts in to ordinary-auth browser upload when client collection is enabled.                                                                                                            |
| `RISU_BUILD_ID`                                    | `unknown`                       | Optional 40–64 lowercase hexadecimal build identity for safe server diagnostics.                                                                                                                |
| `RISU_PROTOCOL_METRICS`                            | unset                           | Enables structured protocol metrics and advertises v1 browser startup collection when `1`, `true`, `yes`, or `on`.                                                                              |

Local/dev:

| Variable                                 | Default                                                                                 | Notes                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `RISU_API_RESTART_FLAG`                  | `.risu-api-restart`                                                                     | Flag file watched by `pnpm api:dev:flag`.                                                                                                   |
| `RISU_AGENT_DEV_HOST`                    | `127.0.0.1` for `dev:agent`; active Tailscale IPv4 or loopback fallback for `dev:human` | Host used by the full-stack runner for both spawned processes.                                                                              |
| `RISU_AGENT_DEV_PORT`                    | `6418`                                                                                  | Frontend port for `pnpm dev:agent`; `pnpm dev:human` sets it to `6002`.                                                                     |
| `RISU_AGENT_API_PORT`                    | `6419`                                                                                  | Fastify port for `pnpm dev:agent`; `pnpm dev:human` sets it to `6001`.                                                                      |
| `RISU_AGENT_DEV_AUTH_BYPASS`             | `TRUE` for `dev:agent`, `FALSE` for `dev:human`                                         | Protected API routes ignore password auth when enabled.                                                                                     |
| `RISU_AGENT_DATA_MODE`                   | `clone`                                                                                 | Agent sandbox reset policy: `clone` snapshots selected state from `data/`, `fresh` starts empty, and `keep` reuses `data-agent/`.           |
| `RISU_TS_AGENT_TSSERVER_LOG`             | unset                                                                                   | Set to `1` or a path to capture verbose `pnpm ts:agent` tsserver logs.                                                                      |
| `RISU_TS_AGENT_TIMEOUT_MS`               | `30000`                                                                                 | Default tsserver request timeout for `pnpm ts:agent`; `--timeout-ms` overrides it.                                                          |
| `RISU_TS_AGENT_DEBUG`                    | unset                                                                                   | Echo tsserver stderr while debugging `pnpm ts:agent`.                                                                                       |
| `TSS_LOG`                                | `-level off`                                                                            | Low-level tsserver log arguments forwarded by `pnpm ts:agent`; prefer `RISU_TS_AGENT_TSSERVER_LOG` for the supported file-logging workflow. |
| `VITE_RISU_AGENT_DEV_IGNORE_REALM_TERMS` | `TRUE` in full-stack runners                                                            | Set by `pnpm dev:agent` / `pnpm dev:human`; ordinary Vite/build leaves it unset. `alertRealmTerms()` returns accepted when set.             |

Client/build:

| Variable                                                                         | Notes                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RISU_API_PROXY_TARGET`                                                          | Vite dev proxy target for `/api`; defaults to `http://localhost:6002`.                                                                                                                                                                                   |
| `VITE_FAST_BOOTSTRAP_OBSERVER`                                                   | Connected readers are enabled by default; exact `FALSE` selects the conservative writer-first fallback. This is a build-time setting: rebuild the SPA and reload clients. The flag itself does not clear originating drafts or encrypted pending intent. |
| `VITE_RISU_BUILD_ID`                                                             | Optional 40–64 lowercase hexadecimal frontend build identity; browser diagnostics explicitly report `unknown` if absent or malformed.                                                                                                                    |
| `VITE_FASTIFY_BROWSER_SMOKE`                                                     | Enables browser smoke hook and fixed smoke password setup/login.                                                                                                                                                                                         |
| `VITE_RISU_LITE`                                                                 | Enables lite-mode consumers in settings/theme/legacy mobile code; does not mount `LiteMain` or the legacy mobile shell.                                                                                                                                  |
| `VITE_AD_CLIENT`, `VITE_AD_CLIENT_MOBILE`, `VITE_AD_SLOT`, `VITE_AD_SLOT_MOBILE` | Ad UI configuration.                                                                                                                                                                                                                                     |

Test/audit summary variables include `RISU_TEST_INCLUDE_GATES`,
`UPDATE_FIXTURES`, `RISU_DIRECT_REALM_IMPORT_TEST`,
`RISU_COMMAND_METRIC_SUMMARY`,
`RISU_ASSET_BYTE_SUMMARY`, `RISU_EXPORT_MATERIALIZE_SUMMARY`, and
`RISU_GENERATION_METRIC_SUMMARY`.
