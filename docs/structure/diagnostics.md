# Diagnostics

Consolidated from targeted source checks on 2026-09-12 covering the client
collector, browser upload, support-read protocol, credential lifecycle, journal
retention/recovery, and remote helper.
Targeted source check: 2026-09-22 (connection-recovery reasons and read-back).

Use this guide for the bounded diagnostics channel and its operational
authority. Raw request/generation traces and startup telemetry remain in
[Development And Observability](development-and-observability.md). Display
pipeline implementation and display-performance interpretation live in
[Intermediate Display](intermediate-display.md#measurement-boundaries).
Request History is a separate, content-bearing product surface documented in
[Providers And Models](providers-and-models.md#llm-request-history).

## Manual Client Diagnostics

`RISU_CLIENT_DIAGNOSTICS=1` enables a content-free recent-event viewer in
Settings → Advanced → Diagnostics. If the variable is unset,
`RISU_API_TRACE_MODE=agent` or `human` also enables it;
`RISU_CLIENT_DIAGNOSTICS=0` explicitly disables it even in trace mode. This
flag does not enable protocol-metric console output or full-prompt sidecars.

Authenticated bootstrap advertises `clientDiagnostics: { version: 1 }`.
Authenticated, read-only `GET /api/v1/diagnostics` returns at most 300 server
events with `Cache-Control: no-store`; it does not require active-writer
ownership. Disabled servers return an empty disabled response. The in-memory
server collector resets on restart. It records HTTP status and timing, runtime
errors, warning/error logger calls, and selected correlated protocol metrics.
It generates `X-Request-UID` even when body-capable tracing is off.

Browser capture starts before bootstrap and retains a bounded pending queue
until the server opt-in arrives. Missing or unsupported opt-in discards the
queue. Enabled capture records fetch status, time to response headers, request
UID, network failures, global errors/rejections, console warnings/errors,
connectivity, startup events, generation recovery, and connection-recovery
reasons. It keeps 300 entries in memory and best-effort tab-scoped
`sessionStorage`, revalidates them after reload, and clears them on auth loss
or server opt-out. Fetch capture never reads or clones response bodies,
including streams.

The viewer supports download, clipboard copy, and selectable report text. If a
server read fails, the report retains browser and previously loaded server
events and marks the refresh unavailable. `packages/protocol/src/diagnostics.ts`
owns the exact-key projection. Capture excludes raw messages, prompts, bodies,
credentials, headers, URLs, domain IDs, plugin/Lua values, free-form log
arguments, and error messages. Sanitized stacks retain only application
file/line/column coordinates. Export adds only app version, coarse browser/OS
families, connectivity, viewport size, and export time.

## Connection Recovery Reasons

The session store records that `lifecycle` or `connection` changed
(`ownership` and `reconnect` stages) but not why. `recovery` entries, recorded
through `src/ts/server/recoveryDiagnostics.ts`, add the decision point. Each
carries a `reason` from the closed `BROWSER_RECOVERY_REASONS` list in
`packages/protocol/src/diagnostics.ts`, the `lifecycle` and `connection` it
observed, `visible` (`document.visibilityState`), `online`
(`navigator.onLine`), and where relevant the recovery `lease` kind,
`attemptCount`, a scheduled `delayMs`, an observed `durationMs` such as the age
of the last event frame, `suspensionEvidence`, and `exclusive` (tab identity
at startup, or explicit versus automatic promotion). Every value is an
enumeration, boolean, or bounded number; there is no free text.

Reason families follow the recovery paths in
[Durable Mutations And Recovery](durable-mutations-and-recovery.md#event-invalidation-and-recovery):
`page-*` and `browser-*` for the physical lifecycle listeners, including
Chromium `freeze`/`resume`; `startup-*` for role resolution after a reload,
which is how a discarded tab returns; `foreground-*` and `probe-*` for the
foreground dispatcher and the writer ownership probe; `network-probe-*` for
the silent reachability probe a visible page runs while `navigator.onLine` is
false, whose `ok` outcome with `online: false` proves the flag stale (a
genuinely offline streak journals only its first cycle and the answer);
`stream-*` for the writer event stream, including the heartbeat watchdog;
`resume-*` for writer resume, including every refusal that settles the page as
a reader and `resume-preference-unavailable` for the transient failure that
retries instead; `reader-*` for connected-reader refresh and stream recovery;
`promotion-*` for automatic and explicit Use this device, including
`promotion-retry-scheduled` when a reader defers acquisition behind an
unreadable preference; `lease-retired` when one recovery replaces another; and
`outbox-lock-*` when the durable outbox waits more than five seconds for its
cross-tab Web Lock. Recording never changes the recovery
itself.

Because Settings is closed on writer loss and unavailable while reading, the
panel cannot be opened from a stuck state on the affected device. With
`RISU_CLIENT_DIAGNOSTICS=1` and `RISU_BROWSER_DIAGNOSTICS=1` the phone uploads
its entries within seconds, and any authenticated client can read them back
with `GET /api/v1/diagnostics?version=2&limit=200`, for example from the
desktop Settings → Advanced → Diagnostics report. Browser `recovery` events
appear in v2 as `category: 'browser'`, `stage: 'recovery'` with the same
fields; the v1 response carries the `recovery` entry as recorded.
`server/fastify/browser-smoke/mobileBackgroundReturnMatrix.spec.ts` asserts the
reasons and that read-back path under emulated Android suspension.

## Remote Support Authority

Remote reads require all of the following:

- `RISU_CLIENT_DIAGNOSTICS=1` for collection;
- `RISU_SUPPORT_DIAGNOSTICS=1` for the support route;
- `RISU_SUPPORT_DIAGNOSTICS_VERIFIER` naming a private verifier file outside
  the repository, data directory, and static root; and
- a dedicated bearer credential presented to
  `GET /api/v1/support/diagnostics` or `GET /api/v1/support/diagnostics/state` over verified HTTPS.

The verifier directory must be private, the file mode must be 0600, and
symlinked paths are rejected. Missing, invalid, revoked, or expired credentials
fail closed. Application auth, reader/writer status, an uninitialized server,
and development auth bypass do not grant support access. The support token is
never added to application auth or bootstrap.

Provision credentials locally:

```sh
# Create private directories first, then choose fixed operator-owned paths.
export RISU_SUPPORT_DIAGNOSTICS_VERIFIER=/private/operator/directory/verifier.json
export RISU_DIAGNOSTICS_REMOTE_CONFIG=/private/transfer/directory/production.json
export RISU_DIAGNOSTICS_REMOTE_ORIGIN=https://your-risu-host.example
pnpm diagnostics:credential mint
```

The command writes an exclusive mode-0600 client config containing a random
32-byte hex token and fixed HTTPS origin. The verifier stores only SHA-256
digests, random credential IDs, and bounded lifecycle times. Transfer the
plaintext config through an operator-controlled secure channel, keep it outside
Git, and remove the transfer copy. Create a separate credential per
environment. Server-side authority remains the access boundary for users with
unrestricted shell access.

Default expiry is 30 days, the hard maximum is 90 days, and a verifier accepts
at most 16 credentials. `pnpm diagnostics:credential rotate <credential-id>`
requires a new exclusive output-config path and allows at most 24 hours of
old-token overlap;
`pnpm diagnostics:credential revoke <credential-id>` takes effect on subsequent
reads. Remove an abandoned verifier `.lock` only after confirming that no
lifecycle command is running.

The route policy is `diagnostics-read`, separate from ordinary application
`required`. All traffic in the diagnostic namespace, including rejected
methods, bodies, and subpaths, is excluded from automatic request logging and
raw tracing. The journal route reads only the sanitized collector. The state route reads the
closed operational projections described below. Neither reads Request History,
trace files, logs, bodies, assets, backups, or content-bearing domain JSON.

## Protocol Versions And Provenance

The standing channel is an allowlist of operational facts. It excludes secret
material and user/provider-controlled prompt, preset, input-hook, memory,
translation, lorebook, character/module, chat-message, built-prompt, request,
and response text based on provenance rather than field names. Correlation uses
random request IDs and secret-keyed opaque operation/attempt references; the
channel does not export plain content fingerprints.

- Version 1 preserves the original exact envelope, known journal fields,
  validated build identity, process identity, capture bounds, availability,
  loss, truncation, and pagination. It excludes browser uploads and rich-only
  fields.
- Version 2 adds exact deployment, HTTP, runtime, display, generation, prompt,
  provider, persistence, script, browser, and compatible legacy families. It
  also adds stamped provenance, pending work, operation continuity, and browser
  clock semantics.
- Version 3 preserves the exact v2 event and may add at most 32 exact typed
  facts. Facts are bounded booleans, counts, durations, size buckets, opaque
  references, or application-relative source locations; arbitrary text, URLs,
  headers, objects, and arrays are forbidden. Facts are revalidated at journal
  admission, restart restoration, read, and export. V1/v2 projection strips
  them, and browser uploads cannot attach them.

- Version 4 preserves the v3 envelope and adds only closed `rejection-code`,
  `error-name`, `validation-domain`, `validation-owner`, `validation-rule`,
  `value-kind`, `field` (16 lowercase hex), `provider-adapter`, and `http-status`
  (integer 100–599) facts. Rejection codes reuse the generated rejection register;
  error names and validation classifications reuse the existing diagnostic enums.
  V3 reads retain only boolean, count, duration-ms, size-bucket, reference, and
  location facts, while v1/v2 continue stripping all facts. Browser uploads still
  cannot attach facts. Admission and restart restoration validate the complete
  v4 fact set. The 32-fact and 4 KiB record limits remain: overflow removes the
  last location fact first, then the last remaining fact until the record fits.

V4 failure instrumentation uses stable fact ids:

- The shared generation HTTP response boundary and both generation SSE error
  emitters attach `rejection.code` (and `rejection.code.N` for additional distinct
  closed codes), using the same detection as rejection counters: `error`,
  `reason`, `code`, `failureCode`, or `operation.failureCode`.
- Generation settings preflight rejection, prompt/assembly failure, mapped
  assembly HTTP errors, and durable startup failure attach the response's closed
  code plus `error.name` and trusted `error.location.N` when an error is available.
  Decoder failures also attach `validation.domain`, `validation.owner`,
  `validation.rule`, `validation.value-kind`, and optional `validation.field`.
- Provider terminal failures attach `provider.adapter`, `provider.status` for
  HTTP errors, and the error facts for caught exceptions.
- Memory embedding batch planning/execution/commit/scope failures, memory
  summarization batch/scope failures, memory and BardWiki worker handler/tick/
  retention failures, failed generation-effect settlements, and finalization
  retry decoding/quarantine/persistence/cleanup/bookkeeping failures attach error
  facts through a database-scoped event or the existing correlated event.
- Lua load/dispatch and propagated execution exceptions attach error facts to
  their existing `script` failure event. Post-generation derivation failures and
  inline persistence failures also retain the original error facts.
- Logger warn/error `console` entries with an error attach `error.name` and
  trusted `error.location.N`. Runtime errors and unhandled rejections also attach
  `error.name` and keep their existing `runtime.location.N` ids.

Unknown thrown values use `UnknownError`; custom Error names follow the existing
closed error-name projection. No error message, parser input, provider body,
Lua output, name, id, or absolute path is added to a fact. Paths are retained only
as the already-defined application source coordinates. Invalid or duplicate
producer facts are dropped individually without suppressing their event. When a
finalization reports both a primary error and a bookkeeping error, the latter
uses `error.1.name` and `error.1.location.N` to avoid duplicate ids.

V3/V4 server error locations require a trusted 40–64 character lowercase
hexadecimal build identity and a matching current process/build instance. An
explicit valid `RISU_BUILD_ID` is trusted. Otherwise source-checkout
deployments derive the identity once at startup from Git `HEAD`, but locations
are trusted only when the tracked working tree is clean. A dirty checkout still
reports its head while withholding locations. Error messages, absolute paths,
plugin/eval frames, and locations from old, dirty, or unknown builds remain
absent. Browser timestamps and request associations are client assertions with
unknown skew; server receive sequence orders retained records. Missing
measurements stay absent.

Display failures and display-performance summaries are server-only v2 event
families. Browser uploads cannot publish them. Their failure taxonomy and
measurement boundaries are documented in
[Intermediate Display](intermediate-display.md#diagnostic-events).

## Journal Retention And Recovery

When collection and either support reads or browser upload are enabled, safe
records are stored in `<data-dir>/diagnostics/journal.sqlite` by a dedicated
worker. The directory is mode 0700 and files are mode 0600. Its independent
`correlation.key` creates opaque operation/attempt references; neither the key
nor its domain-ID mapping is exported. Startup rejects path overlap with asset,
save, backup, or static roots, including retained diagnostic files after
collection is disabled. Protected reads and metadata-owned backup copies also
reject unsafe symlink traversal.

Retention is bounded to 24 hours, 10,000 events, 8 MiB of retained JSON, 4 KiB
per record, and 256 queued/in-flight records. SQLite is capped at 16 MiB with
DELETE rollback journaling. The worker serializes requests, writes at most 32
records per batch, maintains count/byte/expiry state incrementally, and returns
removal deltas rather than rescanning the complete sequence on every append.
Startup revalidates every record and prunes invalid, old, over-count, and
over-byte rows before exposing evidence.

Cold initialization has a 30-second deadline, appends five seconds,
maintenance/reset 15 seconds, and shutdown one second. Transient worker, I/O,
or lock failures restart the worker after bounded 250 ms, one second, and five
second delays. Reads return `storage-unavailable` during recovery. Uncertain
in-flight records count as loss instead of being replayed; queued unsent
records resume after restore. Invalid/full storage, invalid worker protocol, or
an exhausted retry budget remains unavailable until process restart.

Collection never writes domain tables or waits in generation, command
acceptance, recovery, or writer transitions. Authoritative data replacement
changes the journal epoch, clears prior records/provenance and collector state,
and invalidates cursors and stale operation contexts. Operation references
survive restart only when the private key survives; failures report
`process-only` continuity.

## Browser Upload

`RISU_BROWSER_DIAGNOSTICS=1` separately advertises
`browserDiagnostics: { version: 1 }` through ordinary authenticated bootstrap;
collection must also be enabled. Support reads may remain disabled.
`POST /api/v1/diagnostics/browser` accepts authenticated readers and writers
without acquiring ownership. A support bearer is not application auth and
cannot upload.

The server validates complete exact batches before storing any record: at most
32 events, 64 KiB per request, and 4 KiB per stamped record. It assigns receive
time and provenance. Clients cannot submit server event families, server
origin, or trusted operation IDs. Unknown or content-bearing fields reject the
batch without echoing them.

The publisher retains at most 256 pending events for five minutes with bounded
retry/backoff. Auth loss, opt-out, and data/session changes abort stale work and
clear the context. Tab/event identities support reload-safe deduplication;
distinct tabs remain distinct. Diagnostic transport is excluded from capture,
preventing recursive upload-failure events. New clients disable the older
startup publisher while rich upload is active; old client/server pairs preserve
manual and startup behavior.

Authenticated manual reads negotiate
`GET /api/v1/diagnostics?version=2&limit=200` and merge local history with
uploaded evidence by source/event identity. V2 reports browser `available` only
for matching evidence; `none` means enabled without a match and
`not-supported` means upload is unavailable. Older servers fall back to their
exact v1 response.

## Remote Queries And Investigation

Filters are version, from/to epoch milliseconds, limit, generated request UID,
opaque operation reference, category, and cursor. The default time window is
the last hour and the maximum is 24 hours. Limit defaults to 50 and is capped at
200; continuation accepts only cursor and version. Immutable sequence pages
expire after five minutes and are bounded to 32 snapshots, 2,000 events, and
2 MiB per snapshot. Responses are
capped at 512 KiB, access at 30 reads per minute per IP, and request time at ten
seconds. V1 has no operation references and returns no matching records for an
operation-reference filter. There are no raw, free-text, file, destination,
header, or query-language overrides.

Every outcome uses `Cache-Control: no-store`. Expected error classes are 401
unauthorized, 400 invalid query, 429 rate limited, 503 disabled or storage
unavailable, 409 collection disabled, 410 cursor expired, and 500 internal
error. Errors use fixed categories and never echo filters or credentials.
Successful empty windows return 200 with no entries.
Restart invalidates cursor snapshots; retained journal evidence and sequence
numbers remain available within their ordinary limits.

In the development environment, the helper tries `~/.config/production.json`
when `RISU_DIAGNOSTICS_REMOTE_CONFIG` is unset. Set the variable to use a
different private transferred config:

```sh
export RISU_DIAGNOSTICS_REMOTE_CONFIG=/private/development/directory/production.json
pnpm diagnostics:remote --state
pnpm diagnostics:remote --investigate
pnpm diagnostics:remote --investigate --requestUid=<generated-request-uid>
pnpm diagnostics:remote --investigate --operationRef=<opaque-operation-reference>
pnpm diagnostics:remote --investigate --version=4
pnpm diagnostics:remote --version=4 --category=generation
pnpm diagnostics:remote --investigate --version=2
pnpm diagnostics:remote --version=2 --category=display-performance --requestUid=<generated-request-uid>
pnpm diagnostics:remote --version=2 --cursor=<returned-cursor>
```

Start without a category filter, then follow the returned correlation groups.
`--investigate` prefers v4, falls back to v3, then v2 only when an older server
rejects a version with `invalid-query`. Explicit `--version=4` and `--version=3`
start at that version; `--version=2` makes no fallback attempt. It follows
cursor-only continuations for at most 20 snapshot pages
and emits one JSON value after full validation. `collection.complete` means
cursor traversal completed; it does not override truncation, dropped, rejected,
or pruned loss counters. Without `--investigate`, the helper retains the
single-page raw-envelope behavior.

`util/diagnostics-remote.ts` accepts only the finite flags above. It verifies
TLS, rejects redirects and unexpected content types, bounds compressed and
expanded responses, and validates each exact response before retention.
Failures print a fixed category; failed investigations never print partial
pages or remote HTML, headers, stacks, or arbitrary bodies.

Remote evidence can locate a known failure class in a correlated operation. It
cannot explain content-dependent failures whose inputs are deliberately absent,
or events that were never instrumented. Use a separately authorized
reproduction with synthetic or operator-approved data for those cases.

Interpret provider dispatch, response headers, and terminal outcome as separate
evidence. A disconnect after dispatch is ambiguous and does not prove that
replay is safe. Upstream stream-gap timing measures awaited provider reads and
excludes local consumer work; an absent measurement means the stage was not
observed, not that it took zero time.

### State Snapshot

`GET /api/v1/support/diagnostics/state` returns the independent exact
`SupportDiagnosticsStateResponseSchema` version 1. `pnpm diagnostics:remote --state`
fetches it over the same verified TLS transport, validates the complete response,
and prints one JSON value. This mode accepts no other flags. The endpoint accepts
no query parameters (including an empty query delimiter). It has the journal
route's support credential requirement, diagnostics collection gate, no-store
policy, 30 reads/minute/IP limit, ten-second reply timer, bounded audit ring,
fixed errors, and 512 KiB response cap. It requires no active writer and does not
acquire ownership. Existing journal v1/v2/v3/v4 responses are unchanged.

The grouped sections contain:

- `identity` and `deployment`: build/process identity, build source, location
  trust, optional dirty/commit time, and process start time.
- `process` and `config`: memory, uptime, numeric Node version components,
  diagnostic/trace/occupancy flags, numeric limits, default/custom hub and Realm
  classifications, and a proxy-trust kind.
- `database` and `journal`: schema/revision, page/freelist counts, database/WAL/SHM
  sizes, journal availability, epoch, retention limits, retained/pending events,
  loss counters, and reference continuity. Journal failure remains visible in a
  successful state read; it does not hide the other operational sections.
- `generation` and `occupancy`: active jobs and leases with HMAC chat/operation/
  attempt references, total counts and explicit truncation above 200 items,
  stream/client/buffer counts, indexed live-operation counts, effect statuses,
  and finalization queue statuses. Released occupancy rows are counted only.
- `writer` and `workers`: durable/runtime writer presence and epochs, connected
  session count, worker enabled/running/processing flags, indexed memory/BardWiki
  job statuses, and maintenance state/version getters.
- `rejections`: process-lifetime `sinceStartedAt` and sparse `byCode` counters.
  Keys are exactly the `kind: code` values in the
  [generation rejection register](generation-rejection-register.md), generated
  into `packages/protocol/src/generationRejectionCodes.ts` and checked by
  `pnpm check:server`. Each shared generation HTTP response and terminal SSE
  emission counts each distinct closed code once. Returned operation failure
  projections also count, so repeated observations can increment a code; these
  are response counts, not unique-operation counts. Framework/auth middleware
  failures and background transitions with no emitted response are not counted.
  Counters reset on process restart, survive data replacement, saturate at the
  maximum safe integer, and never retain messages or unknown codes.

Reads stay synchronous from the first database query to the last, without
occupancy reconciliation, writer registration, directory walks, or content
loading. Queue counts use existing status indexes; live operations use only
`generation_operations_one_live_chat`. There are no message counts or full
operation-table counts and no all-chat occupancy-pin queries. Counts can still
cost time proportional to the indexed status entries; the reply timer cannot
interrupt synchronous SQLite work. No host name, OS release, absolute path,
URL value, proxy configuration value, session token, raw domain id, plain content
hash, secret, or user/provider text is exported. Schema validation rejects
unknown fields or strings before send; failures return `internal-error` only.

Resolve an opaque reference locally on the server host:

```sh
pnpm diagnostics:resolve --data-dir /absolute/path/to/data --ref <32-hex-reference>
pnpm diagnostics:resolve --data-dir /absolute/path/to/data --ref <32-hex-reference> --kind chat
```

Kinds are `chat`, `character`, `preset`, `profile`, `operation`, and `attempt`.
The resolver reads the private correlation key and copies SQLite database,
WAL, and rollback-journal files into private temporary staging. It verifies a
stable copy interval and integrity, then enumerates ids from a read-only copy;
it never opens the source files with SQLite or creates source WAL/SHM files.
It prints `{ "kind": "chat", "id": "..." }` for a match, `not-found` otherwise,
or the fixed `resolve-error` category on failure. The matching id is local
operator output and must not be copied into the standing channel.

Existing reference HMACs use the database lineage as their history epoch.
The journal's separate random pagination epoch is read and validated, and its
lineage digest must match the copied application database. References therefore
remain compatible across restart and become unresolvable after history/key
replacement or removal of candidate ids. Persisted attempt candidates include
job ids and finalization generation ids; random transient attempts and
process-only references without the retained key cannot be resolved. The
resolver may need a quieter interval if the source changes during all three
copy attempts. Restart the server after deploying changed source.

## Local Production Size Dump

For configuration-size failures or startup/hydration investigations, an operator
can run `util/dump-generation-diagnostics.ts` from the deployed source checkout:

```sh
pnpm exec tsx util/dump-generation-diagnostics.ts \
  --data-dir /absolute/path/to/data \
  --character-id CHARACTER_ID --chat-id CHAT_ID \
  --output /tmp/risu-generation-diagnostic.json
```

The command opens `risu.db` read-only with SQLite `query_only` in a consistent
read transaction. It does not start the app, run migrations, repair data, acquire
writer ownership, or call providers. No server restart is needed. Repository
reads that attempt a repair are reported as errors rather than permitted to
write. The output file is created exclusively with mode 0600; use a new filename
for another run.

The report includes current code revision, canonical effective-configuration
bytes versus the limit, ranked field sizes, selected persisted-row sizes,
character hydration, and database-backed bootstrap projection probes. Optional
`--writer-session-id` selects the recovery session; otherwise probes use the
persisted general writer. Optional `--request-uid` labels the report only and
does not fetch request logs. This is current persisted-state evidence, not an
exact replay of the failed request or browser startup. Auth, live jobs, and
browser execution are outside its scope.

Values, credentials, message text, names, IDs, exception messages, and unknown
object keys are omitted. Paths retain source-defined schema field names;
unknown keys get positional labels. Nested byte counts overlap and should not
be summed. Raw JSON row profiling is capped at 64 MiB, field output at 160
entries, and traversal depth at six; truncation is explicit. Application probes
still load their normal database inputs and can use significant memory on a
large database. The former tooling unit suite was removed in Phase 5 because it
did not gate the product suite; generation-side diagnostics remain covered at
the real Fastify boundary by `server/fastify/__tests__/diagnosticsGeneration.test.ts`.

## Offline Generation Rejection Replay

From the repository root (tokenizers use `public/token`), operators can replay
current persisted generation guards without starting Fastify:

```sh
pnpm replay:generation -- --data-dir /absolute/path/to/data \
  --json /tmp/generation-replay.json
```

`util/generation-rejection-replay.ts` uses Node SQLite `backup()` to snapshot
`risu.db`, including committed WAL contents, into a private scratch directory.
SQLite never opens the original: even a read-only SQLite connection can create
WAL/SHM sidecars. The tool first stages the database and WAL/rollback journal
with file reads, checking inode, size, modification and change times across the
whole copy. It retries a changing source three times, then refuses with
`source_changed_during_snapshot`; rerun during a quiet interval. SQLite recovers
and checks the staged image before `backup()` builds the replay database. All loaders, settings repairs,
and migrations run on the copy; a schema newer than this checkout is refused.
The tool never writes application data to the original directory and never calls
LLM, image, embedding, or network providers. A refusing global `fetch` backstop
records hostnames; any attempt marks the run as a harness defect. Lua external
calls are intercepted before DNS, HTTPS, provider dispatch, or asset writes.

Each chat stops at its first failing stage, recording all stages attempted:
P inspects recovery pins and the current occupancy lease; B decodes normalized
preflight input and resolves settings; K captures, stores, fingerprints (8 MiB
manifest cap), and resolves the accepted configuration; C assembles that
configuration in `preview_prompt` with the copied memory database; D refreshes
bound credentials from the copy and resolves provider routing, including Ollama's
base URL guard. Unexpected errors and missing targets are `defer`, never ready.
Ajv explanations use the decoder's normalization and list all schema failures,
deduplicating array-index variants. The optional diagnostics journal snapshot
maps historical validation field hashes back to known schema fields.

`--data-dir` is required. `--chat` and `--character` filter chats, including
trashed characters. `--all-presets` probes stage B once per stored model/prompt
preset, retaining the other bindings of `--probe-chat` (default: first non-trashed
chat) and filling sidebar defaults like the client. These are independent probes,
not a preset cross product; baseline persona/other preset defects can block them.
Duplicate preset IDs are reported by positional group, without emitting IDs.
`--keep-scratch` retains the private copy and prints its location; otherwise it
is deleted. Scratch copies contain private data. `--json` creates a new report
with mode 0600 and refuses overwrite or a destination inside the source directory.

Stdout contains per-chat verdicts and aggregates; JSON retains full structured
details. Only character/chat IDs, schema field names/hashes, generic paths,
finite reason codes, counts, ages, and fetch hostnames leave the process. Array
indices collapse to `*`; user map keys become positional labels even if they
match a schema field name. No names, preset/profile IDs, sidebar keys, exception
messages, scripts, prompts, messages, or credentials are printed. Offending values
are limited to finite literal fields; arbitrary strings are still omitted. Server
and script output is suppressed during replay.

A ready result covers these offline stages only. The report enumerates checks
not replayed: HTTP/auth/writer and requester-specific occupancy admission,
send/continue/regenerate transforms and target checks, browser context/unsaved
edits, per-provider API keys and request builders, OpenRouter free-model lookup,
query embedding prefetch, asset/inlay bytes (no asset resolver), memory writes
and enqueue, real Agent outputs (before-main dispatch returns `{}`), after-main
steps, real Lua external results, per-attempt triggers/retries/fallbacks, historical
clock/randomness/request state, the client-capability-dependent history-trimming
confirmation, and post-generation finalization/effects. Lua request returns an
empty 503 response, LLM/axLLM/simpleLLM return successful `{}`, similarity returns an empty
list, and image generation returns an empty string; content-dependent branches
can therefore differ. History truncation and whether a persisting request would
need its confirmation check are recorded separately. BardWiki/Hypa use the real
read-only preview path, without waiting for background work. Omitting query
embeddings can change Hypa selection and token budgets compared with live
generation. Exit status is zero for a completed sweep (including rejected or
deferred chats), and nonzero for a harness defect or fatal failure. Historical empty
`thinkingType`, string lore activation percentages, and null template inner
formats accepted by today's decoder are not reported as defects.

## Rollback And Owners

To disable remote collection, turn off `RISU_SUPPORT_DIAGNOSTICS` and
`RISU_BROWSER_DIAGNOSTICS`, then revoke the support credential. Keep
`RISU_CLIENT_DIAGNOSTICS=1` if the manual workflow should remain available.
Stop the server before removing the diagnostics directory. Unsupported newer
journal formats fail closed and must not be downgraded in place. Removing the
telemetry directory does not require changes to chats, presets, revisions, or
writer state.

Primary owners are:

- `packages/protocol/src/diagnostics.ts` and
  `packages/protocol/src/remoteDiagnostics.ts` for exact wire contracts;
- `server/fastify/src/clientDiagnostics.ts`,
  `server/fastify/src/remoteDiagnostics.ts`,
  `server/fastify/src/supportDiagnosticsAuth.ts`, and
  `server/fastify/src/diagnosticsJournal.ts` for collection, reads, auth, and
  storage;
- `src/ts/diagnostics.ts`, `src/ts/server/clientDiagnostics.ts`,
  `src/ts/server/recoveryDiagnostics.ts`, and
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte` for browser capture,
  connection-recovery reasons, transport, and UI; and
- `util/diagnostics-remote.ts` for bounded operator reads.

Focused coverage includes `server/fastify/__tests__/clientDiagnostics.test.ts`,
`server/fastify/__tests__/remoteDiagnostics.test.ts`,
`server/fastify/__tests__/supportDiagnosticsAuth.test.ts`,
`server/fastify/__tests__/diagnosticsJournal.test.ts`,
`server/fastify/browser-smoke/remoteDiagnostics.spec.ts`,
`server/fastify/browser-smoke/mobileBackgroundReturnMatrix.spec.ts`, and
`src/ts/diagnostics.dom.test.ts`. The diagnostics panel and operator-tool unit
suites were removed in Phase 5; the remote journey retains their end-to-end
boundary.

The size dump distinguishes the expanded effective configuration from the
version-2 manifest actually subject to admission's limit. It constructs that
manifest in a disposable in-memory SQLite database and reports dependency
counts/bytes by kind; the production database remains read-only.
