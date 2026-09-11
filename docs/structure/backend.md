# Backend Map

Last audited: 2026-08-30.
Targeted source check: 2026-09-11 (incremental diagnostic journal retention and bounded worker recovery).

The backend is the Fastify server under `server/fastify`. This guide owns its
composition root, route policy, request-path boundaries, process-local jobs,
workers, timers, and static serving. Focused guides own the domain behavior
wired through those boundaries.

## Key Files

| Path                                                                                                           | Role                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/fastify/src/index.ts`                                                                                  | Process entrypoint: load config, call `buildApp()`, listen, handle shutdown signals.                                                                                                                                 |
| `server/fastify/src/app.ts`                                                                                    | Composition root for plugins, SQLite, auth, active writer, routes, workers, timers, optional static SPA.                                                                                                             |
| `server/fastify/src/config.ts`                                                                                 | Parses `RISU_API_*`, `TRUST_PROXY`, hub/Realm URLs, static root, trace mode, and agent auth bypass.                                                                                                                  |
| `server/fastify/src/db.ts`, `databaseLineage.ts`, `commandMutationReceipts.ts`                                 | SQLite migrations, `schema_version`, global revision, durable command-mutation receipts, database lineage, receipt acknowledgements, and durable writer ownership/epochs.                                            |
| `server/fastify/src/databaseInitialization.ts`                                                                 | Fail-closed first-run classifier: valid settings mean initialized; character/chat/message rows or revision/event history without settings mean conflict, never a fresh reseed.                                       |
| `server/fastify/src/databaseDefaults.ts`                                                                       | Canonical first-run and import-normalization defaults; keep persisted setting groups aligned with the browser ownership map and parity test.                                                                         |
| `server/fastify/src/repository.ts`                                                                             | Broad/scoped/exact domain loaders, REST resource/hydration readers, targeted row/table writers, legacy `db.json` import, `applyImport`, assets, backups.                                                             |
| `server/fastify/src/messageStore.ts`                                                                           | Chat `messages`, reroll alternates, and per-chat `chat_hypa_v3` rows.                                                                                                                                                |
| `server/fastify/src/chatGenerationSettingsStorage.ts`                                                          | Normalizes persisted chat-scoped generation settings on import/load.                                                                                                                                                 |
| `server/fastify/src/routes/resourceReads.ts`                                                                   | Authenticated settings/collection/character/inlay-catalog REST resources plus lazy chat, lorebook, legacy-preset, and prompt-template hydration reads.                                                               |
| `server/fastify/src/displaySourceService.ts`, `routes/displaySources.ts`                                       | Read-only, revision-fenced intermediate display processing with scoped loads, per-target isolation, aborts, a bounded process-local cache, and content-free failure-stage diagnostics.                              |
| `server/fastify/src/routes/startupTelemetry.ts`                                                                | Authenticated, metadata-only startup telemetry ingestion with a 16 KiB request cap; diagnostics never affect readiness.                                                                                              |
| `server/fastify/src/commands/mutations.ts`, `commands/events.ts`                                               | Revision-checked transaction lanes, durable command-event catalog/history, and live event fanout.                                                                                                                    |
| `server/fastify/src/auth.ts`, `http.ts`, `activeWriter.ts`, `providerSecrets.ts`                               | Single-user auth/session helpers, route auth assertion, active-writer guard, secret masking/resolution.                                                                                                              |
| `server/fastify/src/routeManifest.ts`                                                                          | Source of truth for route auth, active-writer, streaming, and exception classifications.                                                                                                                             |
| `server/fastify/src/routeRateLimits.ts`                                                                        | Per-route rate-limit presets.                                                                                                                                                                                        |
| `server/fastify/src/remoteDiagnostics.ts`, `server/fastify/src/supportDiagnosticsAuth.ts`                      | Dedicated support authority, bounded sanitized reads, immutable cursor pages, and operator-only credential lifecycle. See [Remote support diagnostics](development-and-observability.md#remote-support-diagnostics). |
| `server/fastify/src/clientDiagnostics.ts`                                                                      | App-scoped diagnostic collector, request/metric hooks, authenticated read route, and close cleanup; contract in `packages/protocol/src/diagnostics.ts`.                                                              |
| `server/fastify/src/protocolMetrics.ts`, `requestTrace.ts`                                                     | Opt-in protocol metrics, command table-write capture, and API request traces.                                                                                                                                        |
| `server/fastify/src/generationOperations.ts`, `routes/generationOperations.ts`                                 | SQLite-backed send/continue/regenerate operation and attempt state, atomic acceptance, projection fencing, cancellation, retry, and stream attachment.                                                               |
| `server/fastify/src/generationJobs.ts`, `generationFinalizationRetry.ts`                                       | Process-local chat runners, replay/reattach state, and SQLite-backed finalization retry rows.                                                                                                                        |
| `server/fastify/src/generationEffects.ts`, `routes/generationEffects.ts`                                       | Per-generation effect ledger plus authenticated claim, lease, receipt, and recovery reads.                                                                                                                           |
| `server/fastify/src/requestHistory.ts`, `routes/requestHistory.ts`                                             | Byte-bounded provider-attempt diagnostics, count/total-byte pruning, authenticated reads, and active-writer deletion.                                                                                                |
| `server/fastify/src/messageTranslationJobs.ts`, `greetingTranslationJobs.ts`                                   | Separate process-local registries for running and bounded recent terminal message/greeting translation recovery exposed through runtime bootstrap.                                                                   |
| `server/fastify/src/translation/`                                                                              | Google, DeepL, DeepLX, and LLM translation, translator pipelines, normalized greeting storage, and generated-message automatic follow-up.                                                                            |
| `server/fastify/src/pushNotifications.ts`                                                                      | Web Push VAPID key loading/generation, subscription persistence, and best-effort completion pushes.                                                                                                                  |
| `server/fastify/src/assetGc.ts`, `server/fastify/src/assetReferenceScan.ts`                                    | Periodic cooperative reference discovery and fenced asset reclamation; scanner shared with backup verification.                                                                                                      |
| `server/fastify/src/streamJobs.ts`, `streamBackpressure.ts`                                                    | Process-local proxy stream jobs and bounded stream writes for slow clients.                                                                                                                                          |
| `server/fastify/src/requestAbort.ts`, `server/fastify/src/requestTimeouts.ts`                                  | Generation abort propagation and proxy/stream-job timeout constants.                                                                                                                                                 |
| `server/fastify/src/providerOperations.ts`, `embeddingOperations.ts`, `tts.ts`                                 | Fixed, validated provider catalog/account/translation, remote embedding, and TTS operation boundaries with server-side credential resolution.                                                                        |
| `server/fastify/src/imageGeneration.ts`, `openAITranscription.ts`, `mcpOAuthRefresh.ts`                        | Bounded image generation, stored-key OpenAI transcription, and stored-credential MCP OAuth refresh operations.                                                                                                       |
| `server/fastify/src/generation/serverTools.ts`, `ollamaCloudToolProxy.ts`                                      | Bounded server-intent tool protocol translation and credential-safe Ollama Cloud transport for browser-owned tool loops.                                                                                             |
| `server/fastify/src/risuSave/`                                                                                 | `.risu`, bundle, local-backup, bounded-inflate, and asset-report codecs wired by save routes.                                                                                                                        |
| `server/fastify/src/realmImport/`                                                                              | Realm dynamic-card/`charx` conversion helpers used by Realm import routes.                                                                                                                                           |
| `server/fastify/src/prompt/agentPresetExecution.ts`, `packages/shared-core/src/agentPresetOutputReferences.ts` | Prepared-input and named-output-CBS Agent Preset prompting, shared reference expansion, provider dispatch, phase execution, failure handling, and diagnostics.                                                       |
| `server/fastify/src/commands/agentPresets.ts`                                                                  | Revisioned standalone Agent and Agent Preset/use create/update/duplicate/delete/reorder/default commands, reference validation, and delete cleanup.                                                                  |
| `server/fastify/src/commands/providerCredentials.ts`                                                           | Revisioned shared API-key/Vertex credential CRUD, masking-aware updates, reference validation, and deletion guards.                                                                                                  |
| `server/fastify/src/prompt/luaPostGenerationProgress.ts`                                                       | Live post-generation Lua progress frames for long `editOutput` / `onOutput` runs.                                                                                                                                    |

`buildApp()` is test-friendly. `BuildAppOptions` can inject generation chat
behavior, including provider dispatch, push notification service, viewer
heartbeat cadence, and finalization retry options; MCP OAuth refresh, OpenAI
transcription, provider-operation, embedding, TTS, and image-generation
execution; Realm import limits; memory worker behavior; command/memory event
sinks; and asset-GC behavior. Config parsing also includes streamed
device-backup import limits and generation trace sidecar controls.

## App Wiring

### Registration And Startup

`buildApp()` registers `@fastify/compress`, `@fastify/rate-limit` with
`global: false`, `@fastify/multipart`, `@fastify/websocket`, and optional
`@fastify/static`. It also installs raw parsers for supported asset content
types, uses a 600s request-receive timeout, and honors `LOG_LEVEL=silent` for
quiet logs.

Startup opens SQLite only after the missing-database guard accepts the data
directory, recovers interrupted restore swaps, runs legacy Hypa V3 backfill,
and atomically imports a valid legacy `data/db.json` when present. Prior-install
evidence without `risu.db` refuses startup unless
`RISU_API_ALLOW_MISSING_DATABASE=1`; invalid legacy envelopes are quarantined,
while malformed JSON remains in place and stops startup for operator repair.
It then reconciles persisted generation operations/effects, starts the memory
worker, creates command/memory event buses, creates proxy, generation,
message-translation, and greeting-translation registries, and starts its owned
worker/GC/retry timers. Startup also calls
`bootPromptVariables()` so server-side CBS/chat-var parsing is wired before
prompt assembly. When `RISU_API_TRACE_MODE` is `agent` or `human`, request
tracing adds `X-Request-UID` and writes API traces under
`data/trace/<mode>.jsonl` while keeping the newest 5,000 entries per mode. The
startup push service loads or generates VAPID keys before push routes accept
subscriptions.
Optional generation trace sidecars write redacted prompt-emission payloads and
OpenAI/Gemini provider request bodies under
`data/trace/generation/` only when protocol metrics and
`RISU_GENERATION_TRACE_FULL_PROMPT=1` are enabled. Post-generation Lua flow
diagnostics also use protocol metrics: `generation_lua_post_generation_trace`
records metadata for `editOutput`/`onOutput` runs and links a compressed
`bodySidecar` with chat/completion before-after bodies under
`data/trace/generation/`; these Lua sidecars do not require the full-prompt
flag. Shutdown ordering is described under
[Generation And Background Work](#generation-and-background-work).

### Route Protection And Diagnostics

`buildApp()` creates the client-diagnostics collector, installs its hooks,
passes its enablement to bootstrap, and registers its authenticated read route.
Entries are bounded in memory. Opted-in remote/browser collection additionally
uses `diagnosticsRuntime.ts`, `diagnosticContext.ts`, and the isolated
`diagnosticsJournal.ts` worker to retain exact safe events without domain writes
or blocking startup recovery. App/history scope carries request and opaque
operation/attempt associations into lazy streams and background work. Close
unsubscribes metrics, clears the collector, and bounds journal drain. Browser
ingestion uses ordinary app authentication without writer ownership; support
reads use an independent digest verifier. Configuration, browser capture/export, and the content-free contract
are owned by [Client Diagnostics](development-and-observability.md#client-diagnostics).

The active-writer guard is registered after health/auth/bootstrap/ownership and before
guarded routes, with route decisions driven by `routeManifest.ts`. Asset upload
routes also perform early auth/writer checks before body parsing. New routes
should be registered from `app.ts` and mirrored in `routeManifest.ts`.
Route protection is test-backed by
`server/fastify/__tests__/routeProtection.test.ts`, which derives route policy
from `app.printRoutes()` and the manifest and guards explicit wildcard/prefix
exceptions. Runtime active-writer enforcement uses `activeWriter.ts`: before any
writer is latched, guarded mutations are allowed; after a writer-intent
bootstrap latches ownership, stale or missing writer sessions receive
`423 active_writer_stale`. A foreign bootstrap must first confirm takeover when
the active writer still has an identified event stream open. Ownership and its
monotonic epoch live in `database_metadata`, so a server restart does not make
an older tab active.

Rate limits are opt-in per route. Current presets are setup `5/min`, login
`10/min`, auth crypto `60/min`, provider and embedding operations `60/min`,
OpenAI transcription `10/min`, image generation `10/min`, MCP OAuth refresh
`30/min`, TTS synthesis `60/min`, proxy fetch `120/min`, proxy stream-job create
`30/min`, imports `10/min`, asset existence checks `180/min`, and generation
submit `60/min`. Global rate limiting is disabled; `POST /api/v1/assets` and
`POST /api/v1/assets/bulk` currently have no route-specific rate limit.

## Route Family Index

Registrar filenames below are relative to `server/fastify/src/routes/` unless
an explicit path is given. `server/fastify/src/routeManifest.ts` owns exhaustive route policy;
this table groups entrypoints for navigation.

| Family                | Registrars                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health/auth/bootstrap | `health.ts`, `auth.ts`, `bootstrap.ts`, `ownership.ts`                                                                            | Health/status/setup/login, runtime bootstrap, and the authenticated no-store lineage/writer probe; writer-intent bootstrap latches the active writer, while the full response also carries revision, generation operation/job/finalization/effect recovery, and message/greeting translation state.                                                             |
| Resources/events      | `resourceReads.ts`, `events.ts`                                                                                                   | Root and targeted REST resources, greeting translations, the inlay catalog, bounded lazy/bulk hydration, replayable command SSE, and initial/live memory state.                                                                                                                                                                                                |
| Display processing    | `displaySources.ts`                                                                                                               | Revision-fenced, read-only intermediate display transforms; the browser owns final Markdown, sanitization, and DOM rendering.                                                                                                                                                                                                                                  |
| Startup telemetry     | `startupTelemetry.ts`                                                                                                             | Authenticated metadata-only browser startup events; payload failures are isolated from readiness and application state.                                                                                                                                                                                                                                        |
| Client diagnostics    | `server/fastify/src/clientDiagnostics.ts`                                                                                         | Authenticated, read-only recent-event snapshot; no active-writer requirement. See [Client Diagnostics](development-and-observability.md#client-diagnostics).                                                                                                                                                                                                   |
| Commands              | `commands.ts` plus `server/fastify/src/commands/`                                                                                 | First-run initialization plus revision-checked domain mutations, including shared provider credentials, standalone Agents/Agent Presets, and atomic character-owned chat reset. Hot paths accept sparse object/row/definition patches and return contract-specific canonical state or digest-backed receipts when optimistic state can be acknowledged safely. |
| Assets/saves/backups  | `assets.ts`, `save.ts`, `realmImport.ts`, `backups.ts`                                                                            | Content-addressed assets, `.risu`/bundle/local-backup import/export, Realm import, and snapshots. Detailed persistence contracts live in [Assets And Saves](assets-and-saves.md).                                                                                                                                                                              |
| Push notifications    | `pushNotifications.ts`                                                                                                            | Web Push VAPID lookup plus authenticated, 16 KiB-capped subscription create/delete. Endpoints must be credential-free HTTPS URLs; endpoint/key fields are bounded. Environment keys override the generated key file, initialization failure disables delivery, sends time out after 10 seconds, and 404/410 responses delete expired SQLite subscriptions.     |
| Provider/media ops    | `providerOperations.ts`, `embeddingOperations.ts`, `tts.ts`, `imageGeneration.ts`, `openAITranscription.ts`, `mcpOAuthRefresh.ts` | Authenticated, bounded provider/media operations and the MCP OAuth refresh route. MCP transport, credential, identity, and egress behavior is canonical in [Plugins And MCP](plugins-and-mcp.md).                                                                                                                                                              |
| Proxy/compatibility   | `proxy.ts`, `streamJobs.ts`, `hub.ts`, `legacyStorage.ts`                                                                         | Generic proxy/stream jobs, retained hub passthrough, `/api/v1/storage/*` compatibility bytes, and the public auth crypto helper.                                                                                                                                                                                                                               |
| Generation            | `generation.ts`, `generationChat.ts`, `generationOperations.ts`, `generationEffects.ts`                                           | Completion/preview, server-assembled chat generation, SQLite-backed operation acceptance/retry/cancel/stream attachment, and post-generation effect claims/receipts.                                                                                                                                                                                           |
| Memory                | `memoryJobs.ts`, `memoryReads.ts`, `bardWiki.ts`, `bardWikiJobs.ts`                                                               | Hypa queue/summary resources plus BardWiki targeted settings/document/version/receipt/vault reads and operational job cancel/retry. Revisioned BardWiki writes remain in the Commands family.                                                                                                                                                                  |
| Request history       | `requestHistory.ts`                                                                                                               | Authenticated summary/detail reads and active-writer deletion for byte-bounded provider-attempt diagnostics; pruning is operational state outside domain revisions.                                                                                                                                                                                            |

## Route-Side Contracts

The Commands family includes atomic onboarding at
`POST /api/v1/commands/onboarding`: one transaction patches the selected
model/prompt preset owners, their compatibility projections, applicable prompt
template storage, and allowlisted setup settings ending in
`didFirstSetup: true`. `server/fastify/__tests__/splitPresets.test.ts` guards
commit and rollback.

The character-owned all-chat reset is likewise one command transaction. It
requires one replacement chat with no message or Hypa V3 body, removes the
character's previous chat/message/memory rows, preserves the character's chat
folders, selects page `0`, and emits the `COMMAND_EVENT_CATALOG.chatsReset`
`characterRow` event. `server/fastify/__tests__/commands.test.ts` guards the
atomic write and rollback contract; the browser recovery path is documented in
[Durable Mutations And Recovery](durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements).

Owner deletion is also a command transaction, not client cleanup.
`server/fastify/src/commands/generationReferences.ts` rehomes or clears matching
chat-generation/loadout references for persona and model/prompt preset deletes;
alternate-greeting edits in `server/fastify/src/routes/commands.ts` remap
affected chat `fmIndex` values and return a cascade certificate;
`server/fastify/src/commands/modules.ts` removes module references from global
enablement, characters, chats, and loadouts. Guards are
`server/fastify/__tests__/generation.chat.test.ts`,
`server/fastify/__tests__/commands.test.ts`, and
`server/fastify/__tests__/commandMessageFreeCeiling.test.ts`.

`routeManifest.ts` classifies auth, active-writer, and streaming decisions;
it is not a literal endpoint inventory because command and hub routes are
classified by prefixes. Some registrars use plugin-local `instance.*` methods,
so use `app.printRoutes()` for route inventory audits. Manifest streaming types
include `sse`, `sse-optional`, `binary`, `websocket`, and `proxy`.
There is no generated OpenAPI/Swagger artifact or generated browser API client.
Cross-runtime contracts that have been migrated live as TypeBox schemas and
schema-derived types in `packages/protocol/`; route-only contracts remain in
handlers and hand-written browser adapters under `src/ts/server/` and
`src/ts/process/request/`.

Request-history capture is best-effort diagnostic work and never turns an
otherwise valid provider request into a generation failure.
`server/fastify/src/requestHistory.ts` bounds each stored text/JSON field,
records per-field byte loss under `requestHistoryTruncation`, and prunes the
newest retained prefix by both the configured row count and
`REQUEST_HISTORY_TOTAL_MAX_BYTES` (64 MiB). The table is deliberately outside
domain revisions.

Backup and restore routes call a repository service whose restore-ownership
policy is exhaustive: every production table must appear in either
`SQLITE_BACKUP_TABLES` or `SQLITE_BACKUP_EXCLUDED_TABLES`, enforced by
`server/fastify/__tests__/backups.test.ts`. `request_history` is explicitly
excluded from restoration as device-local telemetry, and the restore
transaction deletes its live rows while rotating database lineage. The online
SQLite snapshot still physically contains the table; exclusion describes what
is restored, not a secret-scrubbing guarantee for backup files. The complete
snapshot and restore contract belongs in
[Assets And Saves](assets-and-saves.md#backups).

The hub registrar retains a Realm listing compatibility rewrite. Query requests
to `/api/v1/hub/realm` are normalized into the legacy encoded `/realm/<args>`
path in `server/fastify/src/routes/hub.ts`, then forwarded with `?cache=30`.

### Server-Owned Provider And Media Boundary

These authenticated routes perform upstream work without writing returned
provider/media data into durable application state, so the work itself does not
require active-writer ownership. They accept
fixed operation discriminators and bounded, provider-specific inputs rather
than arbitrary upstream URLs, methods, or headers. Stored credentials resolve
inside Fastify, while request/result limits, deadlines, rate limits, sanitized
errors, and disconnect cancellation stay at the route/service boundary.

The family covers provider operations, embeddings, TTS, image generation, and
OpenAI transcription. It is distinct from the generic proxy family and does
not persist returned media/provider data. Provider attempts may write
operational request history.
[Providers And Models](providers-and-models.md#server-owned-provider-and-media-operations)
owns the operation/provider/result matrix and browser adapter map.

MCP OAuth refresh shares this registered route family; `requireAuth()` and its
`30/min` route rate limit apply. Its credential persistence, server identity,
lifecycle, and egress restrictions belong in
[Plugins And MCP](plugins-and-mcp.md).

Handlers call `requireAuth()` unless intentionally public. Public exceptions are
health, auth status/setup/login, `/api/v1/auth/crypto`, immutable asset reads,
asset existence probes, `GET /api/v1/push/vapid-public-key`, and hub
`GET`/`HEAD`/`OPTIONS` when no upstream override header is used.

## Mutations And Events

Normal domain writes go through `server/fastify/src/commands/mutations.ts`:
check `baseRevision`, load the narrowest safe domain shape, validate/mutate
through `server/fastify/src/commands/`, commit its SQLite writes and one event,
then bump the revision once. Scoped snapshots cannot be written back as a whole
database. Sparse commands and compact response proofs keep hot paths narrow;
protocol table-write metrics and command mutation-budget tests guard those write
sets.

[Data And Events](data-and-events.md) owns SQLite, revision, event, and targeted
write contracts. [Server Resources And Hydration](server-resources-and-bridges.md)
and [Durable Mutations And Recovery](durable-mutations-and-recovery.md)
owns browser command queuing, durable intents/receipts, optimistic
acknowledgements, invalidation, and hydration.

## Generation And Background Work

`server/fastify/src/routes/generationChat.ts` composes the live chat request:
the browser posts raw generation inputs, the route invokes
`server/fastify/src/prompt/`, dispatches the selected provider, streams the
locked SSE taxonomy, runs post-generation work, and finalizes persistence.
`/api/v1/generate/completion` is the lower-level completion boundary;
`/api/v1/generate/preview-prompt` assembles without provider dispatch.

The normal send/continue/regenerate protocol enters through
`routes/generationOperations.ts`. It atomically records a lineage- and
writer-scoped operation, accepts the user row when applicable, and reserves a
numbered attempt before attaching that attempt to a process-local runner.
Projection epochs plus operation/attempt/job identifiers fence status reads,
stream attachment, cancellation, and explicit retries. On startup,
`reconcileGenerationOperationsAtStartup()` turns interrupted ownership into an
honest retryable, abandoned, cancelled, or terminal state before routes start.
The older `/api/v1/generate/chat` boundary remains the lower-level chat runner
used by the operation protocol and compatibility callers. A durable operation
projection is authoritative across process restarts; its `jobId`, numbered
attempt, replay buffer, and terminal snapshot file are process-local observation
mechanisms. An expired job therefore requires operation/status plus exact
transcript reconciliation, not a generation-failure inference. A
`stale_generation_attempt` response either redirects to the exact current live
attempt or returns terminal/non-live operation authority for that same
reconciliation path.

Targeted regenerate operations can negotiate `regenerateTargetProjection: 1`.
Their replayable `info` frame carries the exact target/generation and
operation-attempt fence, while assembly omits the prompt-only target-removal
patch. Legacy operation requests retain the former removal-plus-synthetic-row
frames for compatibility. The finalization transaction remains the only owner
that replaces the authoritative regenerate target.

Prompt construction and scripting are canonical in
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md); provider and
profile behavior in [Providers And Models](providers-and-models.md); Agent and
Agent Preset phases in [Agents And Presets](agents-and-presets.md); and message,
greeting, and input-hook translation in
[Translation And Input Hooks](translation-and-input-hooks.md).

The chat route supports normal durable send/continue/regenerate jobs and an
inline non-durable SSE mode for tools and tests. `generationJobs.ts` owns
process-local detach, reattach, cancellation, replay, and terminal retention.
Durable replay compacts replaceable snapshots and token runs under hard 2 MiB
per-job and 16 MiB registry-wide frame-memory budgets. Semantic eviction emits
an additive `replay_gap`; complete terminal payloads spill to an ephemeral
authenticated file side channel when they cannot stay in the frame window, and
remain fetchable until the job's terminal retention expires.
Durable cancellation applies the editoutput-only interrupted-result pipeline to
any streamed-so-far text, persists that processed row mode-aware, then emits a
protected `done` with additive `outcome: 'cancelled'`. The token stream and
`done.result` remain raw; `done.postGeneration.finalText` is the exact persisted
snapshot. Older terminal frames without an outcome remain completed by default.

Successful persisted results create a `generationEffects.ts` ledger for IGP,
plugin output, automatic translation, notification, TTS, completion sound, and
emotion-image state. Effects are durable, ephemeral, or recomputed.
Authenticated routes provide idempotent claim, lease, and receipt handling:
expired durable claims may be reclaimed, while ephemeral effects are skipped
during late recovery. Startup reconciles pre-ledger completed operations, and
the completion-effect retry sweep resumes pending server-owned automatic
translation. Browser execution and late recovery are documented in
[Generation Client](../../src/docs/generation-client.md).
Shutdown does not terminalize an operation while that cancellation snapshot is
still being persisted. If a restart finds an unjournaled `stopping` operation,
it recovers it as retryable abandoned work rather than claiming cancellation
completed and losing the partial.
Provider failures before the first token retain no assistant row. Failures after
tokens use the same processed partial snapshot and keep it as a failed assistant
row instead of restoring the pre-generation transcript.
Before writing a result, finalization compares the live transcript with the
assembly-time target snapshot; a stale append/replace target is rejected rather
than overwriting newer chat state. Script-side chat-variable, character-field,
and local-lore mutations carry their own before-values: conflicting mutations
are dropped and reported by a warning frame while the generated message text is
still persisted. `generationFinalizationRetry.ts` records the same target
snapshot and mutations for retry, preserving the fence across restarts. A
`queued` wire disposition is permitted only after that complete SQLite journal
row is confirmed. Journal insertion failure is `unconfirmed`; terminal target
failure is `rejected`; and a result that committed before journal cleanup failed
finishes successfully with `committed_cleanup_pending`. Retry sweeps quarantine
restored continue/regenerate rows that lack an assembly snapshot as retained
`stalled_legacy` terminal history instead of replaying them.
Generation admission checks this journal inside the same write transaction as
operation acceptance. While a replayable finalization still owns a chat tail,
new protocol and legacy generations receive `generation_finalization_pending`;
the fence releases after commit or terminal failure. Cleanup-only journal rows
whose result already committed do not hold the fence.

Half-streaming is also a route/SSE contract. An `info` frame marks
`halfStreaming: true`; token frames keep their normal text delta and add
cumulative tokenizer-aware `generatedTokens` plus provider-dispatch
`elapsedMs`. This lets the browser keep progress live while deferring visible
provider text until the terminal frame. The browser coordinator is documented
in [Generation Client](../../src/docs/generation-client.md).
On Stop, server-backed streams keep the cancelling viewer attached through the
cancelled terminal and can recreate a half-stream placeholder already removed
by local cleanup; local-provider streams, which have no server terminal, flush
their buffered partial through client editoutput before cleanup.

`buildApp()` creates separate process-local registries for proxy streams,
durable generations, message translations, and greeting translations. The
proxy/generation registry GC interval is shared, while asset GC has its own
optional interval. SQLite-backed generation finalization retries sweep once at
startup and then every 5 seconds by default. Retry selection uses capped
exponential backoff; repeated transient failures remain retryable and become a
visible stalled state. Terminal rows, including quarantined `stalled_legacy`
history, are retained instead of being age-pruned.
`MemoryWorker.start()` and the separate `BardWikiWorker.start()` recover their
own interrupted running jobs, perform immediate terminal-retention sweeps, poll
on independent idle intervals, and later sweep terminal retention. The
BardWiki lane is chat-fair and cannot occupy the Hypa single-flight lane.
Shutdown first closes maintenance admission and signals cooperative cancellation
in `preClose`, while active HTTP requests can still clean up. `onClose` drains
maintenance leases before stopping workers/timers, removing registry jobs,
settling generation runners, and closing SQLite. An aborted copy keeps ownership
until every started filesystem operation, native copy-worker exit and cleanup finishes; GC also retains
its lease until scratch cleanup completes. Overlapping sweeps are skipped and
timer promise failures are logged. Cancelled backup
HTTP responses close their connection so keep-alive does not hold server drain
open. The data-directory coordinator is reopened only after the previous owner
has drained; see [Backups](assets-and-saves.md#backups).

Compatibility job-stream use is measured by the opt-in
`generation_compatibility_stream_attach` protocol metric, including whether the
job still existed and its operation ID when present. Client recovery events are
metadata-only and retain `X-Request-UID` for correlation with server traces;
request tracing remains a separate, body-capable diagnostic facility.

The Hypa V3 memory worker is constructed with summarize/embed handlers, starts
before routes, and exposes its queue/read surfaces through `memoryJobs.ts` and
`memoryReads.ts`. Prompt assembly may enqueue its work, but provider-backed
memory jobs run in the worker rather than the chat request. Memory selection,
provider, and prompt behavior belongs in the focused guides above.

The BardWiki worker uses `apply_turn`, `reconcile_receipt`, and `rebuild_chat`
handlers. Provider calls run outside revision transactions; final document,
version, provenance, manifest, receipt, revision, and command-event publication
is short and atomic. Its route, recovery, privacy, and lifecycle boundaries are
owned by [BardWiki Memory](bardwiki.md).

## Static SPA

`RISU_API_STATIC_ROOT` defaults to `<repo>/dist`. If it points to an existing
directory, Fastify serves `/` and non-API GET fallback from that built SPA.
Built `/assets/*` files get one-year immutable cache headers. Unhashed
`/token/**` tokenizer payloads get `public, max-age=2592000` (30 days), while
other static files revalidate with `public, max-age=0`. Empty string, `none`, or
`off` disable static serving. Non-API `GET` misses fall back to `index.html`;
`/api/*` and non-GET misses return JSON 404. Vite dev serves the SPA separately
while still running the same Fastify-backed browser runtime.
