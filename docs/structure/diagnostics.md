# Diagnostics

Consolidated from targeted source checks on 2026-09-12 covering the client
collector, browser upload, support-read protocol, credential lifecycle, journal
retention/recovery, and remote helper.

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
connectivity, startup events, and generation recovery. It keeps 300 entries in
memory and best-effort tab-scoped `sessionStorage`, revalidates them after
reload, and clears them on auth loss or server opt-out. Fetch capture never
reads or clones response bodies, including streams.

The viewer supports download, clipboard copy, and selectable report text. If a
server read fails, the report retains browser and previously loaded server
events and marks the refresh unavailable. `packages/protocol/src/diagnostics.ts`
owns the exact-key projection. Capture excludes raw messages, prompts, bodies,
credentials, headers, URLs, domain IDs, plugin/Lua values, free-form log
arguments, and error messages. Sanitized stacks retain only application
file/line/column coordinates. Export adds only app version, coarse browser/OS
families, connectivity, viewport size, and export time.

## Remote Support Authority

Remote reads require all of the following:

- `RISU_CLIENT_DIAGNOSTICS=1` for collection;
- `RISU_SUPPORT_DIAGNOSTICS=1` for the support route;
- `RISU_SUPPORT_DIAGNOSTICS_VERIFIER` naming a private verifier file outside
  the repository, data directory, and static root; and
- a dedicated bearer credential presented to
  `GET /api/v1/support/diagnostics` over verified HTTPS.

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
raw tracing. The route reads only the sanitized collector, never Request
History, trace files, logs, bodies, sidecars, assets, backups, or domain rows.

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

V3 server error locations require a valid 40–64 character lowercase
hexadecimal `RISU_BUILD_ID` and a matching current process/build instance.
Error messages, absolute paths, plugin/eval frames, and old or unknown build
locations remain absent. Browser timestamps and request associations are
client assertions with unknown skew; server receive sequence orders retained
records. Missing measurements stay absent.

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

In the development environment, set `RISU_DIAGNOSTICS_REMOTE_CONFIG` to the
private transferred config before querying:

```sh
export RISU_DIAGNOSTICS_REMOTE_CONFIG=/private/development/directory/production.json
pnpm diagnostics:remote --investigate
pnpm diagnostics:remote --investigate --requestUid=<generated-request-uid>
pnpm diagnostics:remote --investigate --operationRef=<opaque-operation-reference>
pnpm diagnostics:remote --investigate --version=2
pnpm diagnostics:remote --version=2 --category=display-performance --requestUid=<generated-request-uid>
pnpm diagnostics:remote --version=2 --cursor=<returned-cursor>
```

Start without a category filter, then follow the returned correlation groups.
`--investigate` prefers v3 and falls back once to v2 only when an older server
rejects v3. It follows cursor-only continuations for at most 20 snapshot pages
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
- `src/ts/diagnostics.ts`, `src/ts/server/clientDiagnostics.ts`, and
  `src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte` for browser capture,
  transport, and UI; and
- `util/diagnostics-remote.ts` for bounded operator reads.

Focused coverage includes `server/fastify/__tests__/clientDiagnostics.test.ts`,
`server/fastify/__tests__/remoteDiagnostics.test.ts`,
`server/fastify/__tests__/supportDiagnosticsAuth.test.ts`,
`server/fastify/__tests__/diagnosticsJournal.test.ts`,
`src/ts/diagnostics.dom.test.ts`,
`src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte.test.ts`, and
`util/diagnostics-remote.test.ts`.
