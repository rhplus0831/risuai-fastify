# Data And Events

Last audited: 2026-08-30.
Targeted source check: 2026-09-08 (connected readers and atomic IGP completion).

Fastify owns authoritative application state. The browser reads authenticated
REST resources and sends revision-checked commands or explicit server-owned
mutation requests; its durable outbox and recovery drafts are non-authoritative.

## Stores

| Store            | Location                                                                                           | Role                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite           | `data/risu.db`                                                                                     | Authoritative schema/revision/lineage plus normalized domain and operational tables.                                                        |
| Asset bytes      | `data/assets/<sha256>.<ext>`                                                                       | Content-addressed supported asset payloads; metadata lives in SQLite `assets`.                                                              |
| Inlay catalog    | SQLite `inlay_catalog`                                                                             | Revisioned names, dimensions, and aliases keyed to immutable `assets` rows; the browser keeps a separate read projection.                   |
| Backups          | `data/backups/<id>/`                                                                               | Database snapshot, manifest, assets, and legacy storage when present; restore uses an explicit table allowlist.                             |
| Legacy `db.json` | `data/db.json`                                                                                     | Import-only input: valid snapshots commit/checkpoint before rename; invalid envelopes quarantine, while malformed JSON stops startup.       |
| Legacy storage   | `data/save/<hex-key>`                                                                              | Compatibility bytes for `/api/v1/storage/*`; guarded writes do not bump the domain revision.                                                |
| Auth files       | `data/__password`, `data/__known_public_key_hashes.json`, `data/__known_session_token_hashes.json` | Single-user password, registered browser-key hashes, and optional session-token hashes.                                                     |
| Web Push keys    | `data/__web_push_vapid_keys.json`                                                                  | Generated VAPID keypair when keys are not supplied by environment; subscription rows live in SQLite.                                        |
| Resource cache   | Browser IndexedDB `risu-resource-cache-v1`                                                         | Disposable authenticated-hash read cache; never offline or authoritative state.                                                             |
| Mutation outbox  | Browser IndexedDB `risu-pending-mutations-v1`                                                      | Crash-recovery journal with AES-GCM-encrypted intent payloads plus plaintext scope/order metadata and receipt-ACK rows; never server truth. |
| Recovery drafts  | Browser `sessionStorage` and IndexedDB `risu-recovery-drafts-v1`                                   | Lineage/writer-scoped composer and module-editor drafts; editing recovery only, not mutation intent or proof of acceptance.                 |

Primary boundaries: `server/fastify/src/db.ts` owns
schema/migrations/revision, `server/fastify/src/repository.ts` owns domain
load/write/resource-read/import/applyImport/assets/backups,
`server/fastify/src/messageStore.ts` owns message tables, and
`server/fastify/src/commands/mutations.ts` owns command transactions. Messages
live in `messages` with `(chat_id, seq)` ordering and `uid` as the message id.
Active chat reads filter `alternate = 0`; reroll alternates use `alternate = 1`
plus negative sequence positions. Regenerate preserves displaced/new candidates
as alternates, while send/continue clears the reroll buffer for the appended
path. Per-chat `hypaV3Data` lives in `chat_hypa_v3`.

`CURRENT_SCHEMA_VERSION` and the ordered `MIGRATIONS` table in
`server/fastify/src/db.ts` are the schema source of truth. Migration ordering,
uniqueness, retry safety, and current-version behavior are guarded by
`server/fastify/__tests__/migrationFoundation.test.ts` and
`server/fastify/__tests__/db.test.ts`.

Migration 38 removes the two observed JSON encodings of MessagePack's undefined
marker from `localStopStrings` in global settings and legacy/model/prompt
presets, including embedded legacy collections. The repair runs transactionally
without changing the domain revision. Import normalization and SQLite backup
restore apply the same repair; deleting the field restores inheritance while
preserving explicit `null` and string arrays. The narrow predicate lives in
`packages/shared-core/src/localStopStrings.ts`. Preset and settings commands
reject other malformed stop-string values before saving them; generation input
validation remains strict and does not repair data on reads.

SQLite includes settings; character, chat, message, and per-chat memory rows;
split collections; assets; command events and mutation receipts; the inlay
catalog; push subscriptions; Hypa V3 memory state; generation finalization
retries; greeting translations; durable LLM request history; lineage-scoped
generation operations and attempts; the generation-effect ledger; and BardWiki
state. Active stream viewers and job attachments remain process-local. Current
browser state is rebuilt from concrete REST resources rather than a cached
database projection.

Ordered collection tables keep their position primary keys. Generation-selected
lookups also use non-unique JSON-expression ID indexes on model presets, prompt
presets, personas, modules and Hypa presets, plus a module namespace index.
Non-unique indexes preserve existing duplicate-ID resolution rules. These are
derived, idempotently created structures; index creation does not advance the
domain revision or rewrite payloads.

`loadPersistedForGenerationPreflight()` supplies selected configuration plus
separate character/chat metadata. `loadPersistedForGenerationAssembly()` supplies
one selected character/chat and its transcript/Hypa state, selected collection
owners and only the required default-scaffold root template. Both return raw
unknown JSON for the generation domain's validation boundary. Speaker-name
snapshots include only IDs referenced by that target history. Pre-extraction
embedded characters have a named compatibility scope; the historical assembly
and display loaders remain separate owners.

Selected reads reuse at most 16 fixed SQLite query programs per connection,
without caching rows or configuration. SQLite retains the last bound parameters;
selectors exceeding 4,096 aggregate bytes therefore use an uncached program.
Each invocation binds its current target and reads authoritative data again,
including after accepted sends, ordinary writes and lineage replacement. A
connection-scoped weak map prevents sharing programs between databases. Cost
probes observe statement execution, so reuse cannot hide returned rows.

Prompt-template ownership follows the split-preset contract. Modern template
bodies are persisted as `promptPresets[].promptTemplate` inside
`prompt_presets.data_json` rows. The selected owner is projected through the
top-level compatibility value and SQLite `prompt_templates`. That table remains a
compatibility mirror for older command shapes, selected-owner
bridges, import/export, and code that still expects `Database.promptTemplate`.
Legacy `botPresets[].promptTemplate` is preserved for old save import/export,
prompt diff reads, and explicit extraction into modern prompt presets, but
normal preset selection/apply does not copy legacy bot-preset templates into the
active top-level collection.

## Revision Contract

Normal command mutations use optimistic concurrency:

1. Check a supplied durable mutation id for an existing receipt.
2. Read `baseRevision` when no receipt exists.
3. Compare it with `schema_version.revision`.
4. Load the needed SQLite-backed domain shape.
5. Mutate through server validators/helpers.
6. Write changed table families in one transaction.
7. Bump the revision exactly once.
8. Persist one command event and, when requested, its mutation receipt.
9. Commit, then emit the live event.

`risu-mutation-id` receipts are globally keyed within the current database
lineage, supplied in `risu-database-lineage`, so an accepted mutation remains
idempotent across active-writer session changes without crossing a destructive
import/restore boundary. The authenticated command pre-handler returns an
existing receipt before route validation or side effects; the transaction also
checks again to close concurrent races. The current active writer is still
required to submit a replay or acknowledge receipts. A receipt stores the
original revision, event, and response extras atomically with the domain
write; a replay emits no second event. Unacknowledged receipts are never
age- or count-pruned. After the browser has durably deleted an outbox intent, it
acknowledges `{ mutationId, requestCount, databaseLineage }` at
`POST /api/v1/commands/mutation-receipts/ack`. The base id and deterministic
`.1`, `.2`, … ids remain as replayable tombstones for 24 hours before lazy
cleanup, without changing the domain revision.

The server mutation receipt is distinct from the browser's durable mutation
intent. The normal durable path stages an encrypted intent before dispatch;
accepted work removes the intent and queues receipt acknowledgement atomically,
while transient failures retain it. IndexedDB/key-persistence failure can fall
back to non-durable dispatch, but unavailable secure randomness can fail staging
before any request is sent. Terminal validation, lineage, and mutation-ID
conflicts follow contract-specific disposal and recovery paths; only the
request-level permanent-rejection path guarantees a scope-naming notice.

The conservative startup path may adopt one unambiguous pending owner before
writer-intent bootstrap. Connected startup instead resolves an exclusive page
identity and discovers server ownership; foreign pending work does not grant
that page writer access. Once recovery is authorized, the browser prepares the
outbox with its local session id plus the returned writer epoch and database
lineage, flushes receipt acknowledgements, and replays current-scope work before
hydration. Same-lineage rows for other sessions remain dormant;
old-lineage rows are discarded during preparation. Retained or unreadable rows
for the current writer and lineage block hydration so authoritative reads cannot
replace unresolved local intent. Full browser mechanics belong in
[Durable Mutations And Recovery](durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements).

A ledgered IGP append also carries `igpEffect: { generationId, claimId }` on
`PATCH /api/v1/commands/messages/:messageId`. The data-only patch requires exact
text/chat preconditions and a generation precondition when the stored row has
generation metadata. Within the existing command transaction, the server checks
the current lineage, unexpired claimed IGP effect, and exact message/chat/
character identity, then commits the text and completed effect receipt together.
Either failure rolls both back. Losing the PATCH response or writer authority
cannot leave an accepted append available for another IGP claim. Command replay
returns its original mutation receipt; a later completed effect receipt for the
same IGP claim acknowledges the existing completion without another write.
Different claims or terminal statuses remain stale. This additional atomic
contract is specific to IGP, not a guarantee for arbitrary plugin effects.

Base-revision mismatches return `409 revision_conflict`; stale writer sessions
return `423 active_writer_stale`. Browser command helpers cache the latest
revision from bootstrap, command responses, and event reconciliation.

High-level browser mutations share one serialized transport lane so each request
uses the revision accepted by the preceding request. Accepted responses advance
the known-server cursor immediately, but response reconciliation is deferred
while later mutations are queued. Once the lane drains, success events are
ordered by revision. Verified contiguous local effects can advance their
resource slices without a GET; remaining events are coalesced into one
authoritative invalidation plan. Contiguous multi-revision batches may combine
targeted reads; an actual revision gap triggers one complete resource refresh.
The mutation promises settle only after that shared reconciliation. Explicitly
unqueued message and greeting translation operations reconcile immediately.
Revision-fenced external operations whose responses carry no command event,
including the read-only display-source bridge, may occupy the same revision lane
until their response revision has been ingested, without fabricating a command
success event. Display-source Lua state is per-target and never advances the
revision; the lane currently supplies base-revision ordering rather than a write
commit.

Server command transaction paths include targeted/scoped SQLite writers, message-free broad writes,
character-selection writes, and hydrated message mutations. They still share the
same invariant: one revision bump and one persisted command event per normal
command transaction.

Settings-, collection-, character-, and chat-scoped loaders omit unrelated
tables and asset/message scans, with broad fallback for legacy/pre-extraction or
unrepresentable rows. A scoped snapshot is never eligible for whole-database
write-back. Targeted repository writers update only the owning row/table inside
the mutation transaction; exact character/chat loaders and writers bypass
unrelated normalization, and row-level edits preserve unrelated rowids.

Normal character creation, including create-and-select with an optional empty
chat, uses a targeted append transaction. It validates order from settings and
character identities/trash status, checks duplicate IDs directly, and inserts
only the new character and optional chat plus the settings order/selection
update. It never deletes/reinserts existing chats, so BardWiki foreign-key
records, greeting translations, messages, and unrelated collections survive.
The HTTP preservation, physical-write, receipt replay, and atomic rollback
contract is guarded by `server/fastify/__tests__/characterCreationSafety.test.ts`.

Sparse command contracts cover settings objects/global scripts, preset and
persona field patches, chat generation settings (including nested sidebar
toggles), prompt/lorebook rows, shared provider credentials, reusable
Agent/Agent Preset rows, and script/trigger definition mutations. Server
responses prefer acknowledged keys, canonical differences/deletions, and
value-free digest certificates; a contract-specific fallback may return full
canonical state when the certificate is unavailable.
Imported Agent-only lore entries can retain their author activation fields as a
compatibility exception; [Character Cards](assets-and-saves.md#character-cards)
owns that import and persistence contract. Portable exports neutralize those
fields on cloned output only, leaving this persisted compatibility state intact.
This compact local-effect acknowledgement is a third artifact, separate from
both the browser outbox intent and the server mutation receipt: it only certifies
that already-visible optimistic state can advance without a GET.
Chat-generation-settings acknowledgements prefer a matching base digest;
definition and persona acknowledgements certify collection/profile state. The
browser combines the acknowledgement with its client-only optimistic snapshot
and resource/projection epochs. Message effects also fence the chat-body
projection epoch. A local effect is applied only when its contract-specific
event, owner, revision, digest, and projection checks pass; malformed, stale,
tainted, missing, or non-contiguous acknowledgements fail closed to the normal
authoritative event read.

Two BardWiki read-only POSTs are deliberate eventless exceptions: rebuild
preview and vault-import dry run. The browser accepts them only when their
exact-key response, requested chat/policy or strategy, counts, action shapes,
and revision validate; malformed success bodies fail closed like other command
receipts.

Protocol-v1 accepted sends use that same rule outside the ordinary command
transport. The generation-operation response must carry a matching message
append event and revision. While that response is being applied, matching
own-session SSE echoes are buffered; a still-current optimistic chat-body
projection can advance through a typed append effect, while an invalid event,
projection-epoch change, or overlapping operation falls back into ordered
authoritative reconciliation. This prevents an event echo from replacing the
optimistic user row or launching a redundant hydration during stream setup.

`PUT /api/v1/commands/characters/:characterId/chats` is the atomic all-chat
reset contract. Its targeted character-row transaction deletes that
character's previous `chats`, `messages`, and `chat_hypa_v3` rows, inserts one
empty replacement chat, resets `chatPage` to `0`, preserves `chatFolders`,
bumps the revision once, and emits `chats.reset` with resource `characterRow`.
The response deliberately has no compact local-effect certificate, so normal
reconciliation rereads `/api/v1/characters/:characterId`. The server contract
is guarded by `server/fastify/__tests__/commands.test.ts`; browser command
decoding is guarded by `src/ts/server/commands.test.ts`.
The user-facing export, confirmation, and exact-export fence are owned by
[Assets And Saves](assets-and-saves.md#chats-and-datasets).

Command-event resources should be as narrow as practical. Default drafts live
in `COMMAND_EVENT_CATALOG`; composite constants and route-local overrides select
narrower or cross-resource keys where needed. Treat
`server/fastify/src/commands/events.ts` and
`src/ts/server/resourceInvalidation.ts` as the paired source of truth. The
complete event-to-read mapping and its broad-recovery fallback live in
[Event Invalidation And Recovery](durable-mutations-and-recovery.md#event-invalidation-and-recovery).

Character list and row responses omit message bodies and, when
`enableLorebookStubs` is true, character lorebooks. Resource application keeps
resident chat/lorebook bodies for surviving same-id rows during safe targeted
updates, but a complete refresh deliberately resets them to stubs and forces
lazy rehydration. Verified compact local-effect acknowledgements can locally
acknowledge settings, preset/persona patches, prompt/script/lorebook rows,
modules/plugins, characters/chats/messages, loadout operations, and chat-generation
settings without a GET. Domain-specific pending-value and projection-epoch
guards keep in-flight reads or older acknowledgements from replacing newer
optimistic edits.

## Server-Owned Exceptions

These paths still need explicit auth and active-writer decisions, but they are
not ordinary browser `/commands/*` resource endpoints:

- First-run `POST /api/v1/commands/state/initialize` creates default server
  state and does not accept a browser database payload.
- Direct `/api/v1/assets` and `/api/v1/assets/bulk` uploads write asset
  metadata/bytes outside the domain revision and emit no command event;
  duplicate uploads are idempotent. Bundle import commits staged assets with
  `state.imported`; Realm import can use separate `asset.created` transactions.
- Periodic asset GC deletes orphan asset metadata/files after the grace window
  without a revision bump or command event.
- Legacy storage write/remove mutates `data/save/<hex-key>` compatibility files
  under active-writer guard without a domain revision or command event.
- `.risu` import, bundle import, Realm import, and backup restore use
  repository/server-owned paths.
- Server generation can persist assembly-time transcript/metadata rewrites and
  scriptstate/input-trigger changes before provider dispatch. Input-trigger lore
  upserts are copied back to the working chat and written durably; legacy
  id-less local-lore entries and duplicate IDs receive fresh UUIDs before
  persistence.
  Final generation writes through a targeted command mutation and emits
  `generation.persisted`. Assembly and finalization scriptstate changes write
  only the target `chats` row alongside any affected `messages`, rather than
  rewriting unrelated database tables. Durable finalization attempts are queued
  in SQLite for retry with target snapshots, pending/terminal status, and
  retained terminal errors that the app prunes on later sweeps. Journal insert,
  authoritative commit, failure bookkeeping, and cleanup are separate phases:
  only a confirmed replayable row is reported as `queued`, while a committed
  message remains a successful result if cleanup needs a later sweep. Historical
  targeted rows with no snapshot are terminalized as `stalled_legacy`, retained,
  and never replayed. Active durable jobs themselves are process-local reattach
  state. Cancel and post-token failure use the same phase-aware boundary when
  persisting streamed-so-far text after the editoutput-only interrupted-result
  pass. Prompt and hook execution is owned by
  [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md).
- Raw message translation uses
  `POST /api/v1/commands/messages/:messageId/translate`: the server detaches the
  provider work from the browser request and persists through a targeted message
  command event only when both the source message and its previous translation
  still match. Bootstrap `activeMessageTranslations` includes running and
  bounded recent terminal recovery rows; retention is owned by
  [Backend Map](backend.md#generation-and-background-work).
- Generated-message automatic translation starts after the generation result is
  persisted and uses the same targeted translation mutation/job registry. The
  generation stream waits for settlement or the configured defer cap; a capped
  translation remains detached and appears in `activeMessageTranslations`.
  [Translation And Input Hooks](translation-and-input-hooks.md) owns the
  preset/pipeline and generated-message flow.
- Manual greeting translation uses a separate process-local job registry and
  normalized character-scoped rows. Requests and jobs carry the owning chat id
  so the effective chat-bound translator preset participates in the settings
  hash. Source/settings/previous-value fences guard persistence,
  `greetingTranslation.updated` drives targeted invalidation, and bootstrap
  exposes chat-scoped running plus bounded recent succeeded/failed work through
  `activeGreetingTranslations`.
- Memory job create/cancel writes durable memory-job state and emits memory
  events without a domain revision. Worker writes and direct summary
  `PATCH`/`DELETE` also update memory tables outside the domain revision; only
  job lifecycle emits live memory events.
- BardWiki settings, manual documents, exact-source confirmation, background
  publication, receipt invalidation, vault import, and rebuild publication use
  narrow revisioned commands/events. BardWiki job claims, progress, cancel,
  retry, restart recovery, and staging checkpoints are durable operational
  transitions outside the domain revision; only final domain publication bumps
  it. The complete boundary is in [BardWiki Memory](bardwiki.md).
- LLM request history is operational SQLite state outside the common-revision
  application snapshot. Provider work creates/finalizes rows best-effort;
  retention pruning and active-writer deletion neither bump the domain revision
  nor emit command events. The persisted data-group setting
  `requestHistoryLimit` bounds the table from 0 to 10,000 rows; `0` disables new
  records and prunes existing history. Captures are byte-bounded to 2 MiB for
  the prompt, 4 MiB for the response, 256 KiB for metadata, and 4 KiB for the
  source. Pruning keeps the newest prefix that satisfies both the row limit and
  the 64 MiB total byte budget.
- MCP OAuth refresh can persist a rotated refresh token through a targeted
  settings mutation while returning only the access token to the browser.
- The startup push service loads or generates VAPID keys; push notification
  subscription create/delete routes mutate operational Web Push rows without a
  domain revision. They authenticate before parsing a 16 KiB-capped body and
  accept only bounded, credential-free HTTPS subscription endpoints and keys.
  They are authenticated runtime state, not application resource state.
- Backup create/delete mutate backup files without a domain revision; restore
  replaces allowlisted repository state, clears live request history, rotates
  the database lineage, clears mutation receipts, and emits `state.restored`.
  [Assets And Saves](assets-and-saves.md#backups) owns the online snapshot, file
  swap, explicit included/excluded table policies, and allowlist-completeness
  contract.

## Auth And Active Writer

Auth is single-user and route-local. `server/fastify/src/auth.ts` stores
password/public-key/session-token state, `server/fastify/src/http.ts` exposes
`requireAuth()`, and route handlers call it manually unless intentionally
public. Browser auth assertions are sent in `risu-auth`; setup/login also issue a
24-hour `session.*` fallback token when `sessionAuth` is requested. Public-key
hashes and fallback session-token hashes are both LRU-capped on disk.
`server/fastify/src/routes/auth.ts` owns status/setup/login, while
`/api/v1/auth/crypto` is registered with legacy storage routes as a public
compatibility hashing helper. `GET /api/v1/push/vapid-public-key` is also public
so the browser can decide whether Web Push registration is available;
subscription create/delete routes remain authenticated.
`RISU_AGENT_DEV_AUTH_BYPASS` is an agent/dev escape hatch used by the full-stack
dev runner; `pnpm dev:agent` enables it by default, while `pnpm dev:human`
leaves password auth enabled by default.

The active-writer guard is separate. Read-only bootstrap reports durable
`writer: { sessionId, epoch }` and database lineage without registering a writer;
`risu-writer-observer-session` identifies a requesting session without acquiring
ownership. Writer-intent bootstrap and writer event streams use
`risu-writer-session`; reader event streams omit it and do not count as a
connected writer. Conditional acquisition supplies
`risu-expected-writer-epoch` and `risu-expected-database-lineage`. The server
checks both before registration and returns `409 active_writer_changed` if
discovery is stale. A still-connected foreign writer also requires the existing
`409 active_writer_connected` / `risu-disconnect-existing-writer: true`
confirmation handshake. Changing the writer advances the durable writer
epoch; guarded routes reject stale sessions with `423 active_writer_stale`,
including after restart.

Connected readers are enabled by default; an exact build-time
`VITE_FAST_BOOTSTRAP_OBSERVER=FALSE` selects the conservative fallback.
`src/ts/connectedClientStartup.ts` first discovers ownership. An exclusive page
may acquire an unowned server or conditionally resume its own writer; an
initialized server owned by another session opens for reading even when that
writer is disconnected. An observed writer frame never grants write access.
Explicit **Use this device** performs fresh discovery, conditional acquisition,
current-scope outbox recovery, post-replay hydration, and writer event attachment
before mutation capabilities return. Cancellation or a current failed switch
returns to reading while authentication and lineage remain valid; superseded
work cannot change a newer role.

Writer loss immediately revokes mutation and generation control, captures local
drafts, stops writer runtimes, and establishes connected reading. Reader
navigation and authenticated resource/event reads remain available; navigation
does not persist another selection or replay pending writes. Unsent drafts and
encrypted intents stay scoped to their originating local session and lineage.
Authentication loss clears protected projections immediately. Lineage changes
invalidate old request, transcript, and cache identities before replacement.

The explicit conservative fallback retains the older refresh-or-stay dialog:
refresh reclaims through its writer flow, while stay closes communication and
freezes the page with text still selectable and copyable. That compatibility
choice is separate from an interrupted connected reader, which reconnects using
authenticated reads. Changing the rollout flag does not itself delete local
drafts or pending intents, and server writer guards apply to both client modes.

`server/fastify/src/routeManifest.ts` is the source of truth for auth,
active-writer, streaming, public exceptions, and read-only POST decisions.

## Resource Persistence And Event Ordering

| Concern                                                              | Canonical source                           |
| -------------------------------------------------------------------- | ------------------------------------------ |
| Transaction, revision bump, receipt, commit, and live-emission order | `server/fastify/src/commands/mutations.ts` |
| Event drafts, persisted replay rows, and retention window            | `server/fastify/src/commands/events.ts`    |
| Browser interpretation of event resource keys                        | `src/ts/server/resourceInvalidation.ts`    |

A normal resource-changing command writes its SQLite rows, increments the global
revision once, and inserts one command event in the same transaction. The live
event is emitted only after commit. The event's resource key is an invalidation
scope, not an authoritative data payload; the browser must reconcile it against
the corresponding committed resource at that revision. Persisted command events
retain their revision order for reconnect replay, while revision-free
server-owned exceptions remain outside that ordering as listed above.
Generation-adjacent events may also carry `databaseLineage`, `operationId`,
`sourceMessageId`, and `jobId`. Command-response and SSE parsers retain only
string-valued identifiers; these fields fence recovery and routing and do not
turn the event into an authoritative resource body.

The canonical REST endpoint, bootstrap, common-revision read, hydration,
cache-cap, shell/body, and stale-response workflow belongs to
[Server Resources And Hydration](server-resources-and-bridges.md#read-and-hydration-endpoints).

## SSE And Streaming

`GET /api/v1/events` sends a `writer` frame with the current
`{ sessionId, epoch }` state (`sessionId` is null before the first writer is
latched), a connected comment, and a `memory_snapshot` frame with the current
Hypa and BardWiki stream/version/job projections. It then replays SQLite
`command_events` for cursor reconnects and streams live command-sink, memory,
BardWiki-job, and writer-change events. Writer and memory-snapshot frames have no
revision semantics and are never replayed. Clients subscribe with
`sinceRevision` or `Last-Event-ID`; replay gaps return
`409 event_replay_unavailable`, after which the browser performs a read-only
complete resource refresh before resubscribing. SQLite replay keeps a
1000-revision window and persists `origin_writer_session_id` for own-echo
suppression. The server emits 25-second heartbeat comments. The browser treats
60 seconds of silence as stale, restarts immediately on visibility/online
recovery, and the writer transport retriggers current-scope outbox replay after
reconnect. The live
command sink can also carry non-replay notifications such as export events at
the current revision. Hypa `memory.job` and BardWiki `bardwiki.job` progress
events are bounded, secret-free, and never replayed; the reconnect snapshot plus
targeted resources are authoritative.

Browser reconcile rules: process events serially, defer matching own-origin
events into the active command batch, skip revisions already covered by the
applied-resource cursor, use verified local effects for contiguous command
responses, and issue targeted REST reads for the remainder. Gaps, unknown
resources, replay misses, or invalidation failures fall back to a complete
settings/collections/characters/inlay-catalog refresh. The browser keeps
separate known-server and applied-resource revision cursors: mutation base
revisions and hydration
freshness use the known cursor, while SSE replay, gap detection, and
already-applied skips use only the applied cursor. An own-origin event that
arrives before its command response is retained and can be upgraded with the
response's compact local-effect acknowledgement. When targeted reconciliation
fails, the browser leaves the applied cursor unchanged and reconnects from it so
command-event replay retries the event instead of waiting for a later mutation.
Memory events update Hypa V3 and BardWiki job/progress UI directly without
advancing the applied domain revision.

Connected readers use `src/ts/server/connectedReaderSync.ts`: authenticated
ownership checks, an event subscription without writer headers, serialized
resource invalidation, and full read refresh after a revision gap or unavailable
replay. Their known-server and applied-resource cursors fence reads but grant no
mutation authority. Reconnect does not replay outbox work or acquire a writer.
Foreground recovery can replace an already-live reader stream without changing
the visible connection status; a failed replacement still publishes the
interrupted state.
Memory/Hypa/BardWiki snapshots and progress use their independent stream/version
ordering and never advance the command revision. Promotion still performs its
post-replay shell read and installs the writer subscription from that revision;
only successful writer recovery restores mutation readiness.

A selected reader watches generation through authenticated
`GET /api/v1/generation-operations/:operationId/stream?attemptNo=...&jobId=...&projectionEpoch=...`.
`readerGenerationObservation.ts` and `readerGenerationStream.ts` fence the
database lineage, operation, attempt, job, selected chat incarnation, and client
lifecycle. Protected replay from the same attempt may have older projection
epochs; terminal authority may advance them. Job-only replay-gap and terminal
snapshot wrappers are accepted only after a verified durable frame, and a
snapshot fetch must use the exact job's terminal-snapshot URL. Tokens remain a
temporary display projection. Authoritative messages establish the exact
persisted result before handoff; a terminal that retains no result removes the
overlay only after read reconciliation. EOF, hidden/offline suspension, chat
switching, or closing a reader detaches its HTTP viewer without cancelling the
durable job. Recovery is bounded and never invokes submission, cancellation,
persistence retry, or effects.

Chat generation SSE frame types are `stage`, `job_accepted`, `prompt`, `info`,
`message_patch`, `token`, `side_effect`, `agent_preset_progress`,
`post_generation_progress`, `warning`, `error`, and `done`.
`info.revision` or `done.postGeneration.revision` can advance the browser
revision cache after server-owned persistence. Durable jobs buffer protected
replay events (`prompt`, de-duplicated `info`, `message_patch`, `side_effect`,
de-duplicated `agent_preset_progress`, `post_generation_progress`, `warning`,
`error`, and `done`) with 512-event and 2 MiB soft trimming targets;
hard caps can eventually evict readiness frames after unprotected and
nonessential frames are exhausted. An additive `replay_gap` makes that loss
explicit; a canonical terminal snapshot can close the gap even when `prompt`
or `info` readiness was evicted. They emit viewer heartbeat comments and can
persist streamed-so-far text through processed interrupted-result finalization
retry paths. Bootstrap `activeGenerationJobs` exposes
running durable jobs, including mode and regenerate message id when relevant,
while `activeMessageTranslations` exposes running plus bounded recent terminal
manual or generated-message translation entries and `activeGreetingTranslations`
exposes running plus bounded recent terminal greeting jobs for completion polling.
`post_generation_progress` can describe either Lua work or the server-owned
automatic-translation wait. `done.postGeneration` carries the persisted message
id and may embed a succeeded, failed, or still-running translation result.
For a negotiated inline, non-replayable stream, `done.result` may be absent when
non-empty token frames already delivered the same completion. Successful
durable streams retain the terminal result so protected replay is self-contained;
the browser treats that result as the final cumulative raw snapshot after any
lossy replay window. `done.outcome` is additive: absence means completed for
older peers, while an explicitly cancelled durable job emits `cancelled` and
does not enter successful browser post-generation effects.

For negotiated targeted regenerate, `info.generationDisplayProjection`
contains version, mode, target message id, generation id, operation id, attempt
number, and projection epoch. It is transient presentation metadata, not a
message write. Prompt-only regenerate truncation is absent from that viewer's
`message_patch`; the authoritative replacement still arrives through committed
generation persistence and chat-resource reconciliation.

Other streaming/binary surfaces include optional completion SSE, optional Realm
progress SSE, proxy stream WebSocket attachment, asset bytes, `.risu`/bundle
export, and proxy/hub/storage binary passthrough. Command-event SSE, chat
generation SSE, and proxy stream/WebSocket writers use
`server/fastify/src/streamBackpressure.ts` to cap buffered bytes at 2 MiB for
slow clients; completion SSE and Realm progress SSE currently write directly to
`reply.raw`.

Realm import clients advertise `realmProgressDelta`: the first progress frame is
complete, while later frames can carry `percent` plus only changed fields.
