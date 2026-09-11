# Server Resources And Hydration

Last audited: 2026-08-31.
Targeted source check: 2026-09-05 (display paint-cache ownership).
Targeted source check: 2026-09-08 (connected-reader startup and generation reads).
Targeted source check: 2026-09-10 (role-first unified workspace).
Targeted source check: 2026-09-10 (revision-identical writer reconnect reuse).
Targeted source check: 2026-09-11 (ownership-first foreground recovery).

This guide owns the Fastify-to-browser read boundary: bootstrap resources,
root and targeted REST reads, hash-verified cache substitution, lazy body
hydration, settings/feature projections, and their endpoint contracts. Durable
commands, event recovery, explicit owner mutation lifecycles, and active-writer
handling live in
[Durable Mutations And Recovery](durable-mutations-and-recovery.md). Start from
the [architecture index](README.md) for adjacent ownership.

## Bootstrap And Initial Resources

`src/ts/bootstrap.ts` coordinates startup, while
`src/ts/startupReadiness.ts` publishes monotonic milestones and the narrow
capabilities consumed by the shell and protocol adapters:

- Connected startup always resolves a page identity, discovers ownership through authenticated read-only
  bootstrap, and installs a coherent shell for initialized state. An exclusive
  page may conditionally acquire an unowned server or resume its own writer;
  a foreign owner remains authoritative even while disconnected, so other pages
  stay connected readers. Discovery failure does not silently request takeover.
- Connected acquisition sends the discovered writer epoch and database lineage
  as preconditions. A stale discovery returns `409 active_writer_changed`; a
  connected foreign writer additionally returns `409 active_writer_connected`
  until the user confirms disconnection. **Use this device** is the explicit
  reader acquisition path. Pending-mutation ownership is considered only after
  the current page has acquired and authenticated writer recovery.
- A successful writer bootstrap is deliberately runtime-only metadata:
  initialization state, revision/schema version, database lineage, durable
  writer epoch, the pre-takeover writer verdict, asset base URL, generation and
  display-source protocol projections, running generation jobs, writer-scoped
  finalization/effect recovery, startup telemetry configuration, and running plus
  bounded recent terminal message/greeting translations. It does not carry
  durable application data.
- An authorized writer with `initialized: false` attempts
  `POST /api/v1/commands/state/initialize`. A connected page that cannot establish
  exclusive identity requires the explicit setup action before acquisition;
  readers waiting on another owner do not initialize. The server re-runs the classifier in
  the command transaction and accepts only genuinely empty state; conflicting
  prior-install evidence fails closed. The winning client reuses the runtime
  metadata and accepted revision it already has, while a client that lost an
  initialization race retries bootstrap read-only.
- After bootstrap/initialization, startup establishes the shared draft-recovery
  scope, prepares the mutation outbox against the writer session and database
  lineage, flushes durable server-receipt acknowledgements, and replays pending
  intents. Same-session rows survive a writer-epoch reclaim. Transient and
  genuine stale-writer failures retain encrypted intents. Same-lineage
  foreign-writer rows remain dormant, while old-lineage rows are discarded
  during preparation. Only retained or unreadable rows owned by the current
  writer and lineage block root-resource hydration; terminal disposal and
  notices are contract-specific.
- `loadInitialServerResources()` now reads only
  `GET /api/v1/resources/shell`. Version 1 contains one outer revision, an exact
  allowlist of initial theme/language/account/sidebar settings, and the version 1
  character-summary envelope at that same revision. It excludes collections,
  credentials, selected character/chat detail, prompt bodies, and the inlay
  catalog. Strictly validated summaries become marker-bearing compatibility
  shells with message-free chat identity stubs; detail, messages, per-chat Hypa
  V3 data, lore, and reroll alternates remain lazy.
- Initial writer acquisition and Reader promotion read and apply one post-replay
  shell. That authoritative projection replaces any retained reader summary/detail
  state, installs the known-server and applied-event cursors, and starts command
  reconciliation. An established same-owner writer reconnect may retain its
  coherent projection only when replay attempted no pending intent and the verified
  bootstrap revision exactly equals both client revision cursors; any mismatch uses
  the normal shell replacement path. Startup or reconnect then records runtime/job
  projections, starts owner-mutation and hydration lifecycles, and subscribes to
  `/api/v1/events` from the applied revision. Only an accepted event subscription
  publishes `writer-ready`.
- Managed `canRenderShell` and `canApplyRoutes` admit a coherent authenticated
  read projection. Reader routing keeps its own stable character/chat intent and
  hydrates only the selected view; it does not persist the writer's selection.
  `canMutate` still requires current, live writer authority and `writer-ready`.
  `canGenerate` additionally requires plugins, generation recovery, selected
  character/chat detail, and the selected prompt-template owner to be coherent
  at `chat-ready`. Read-only transcript display uses the bounded
  `runtime:chat-display` resource surface rather than enabling writer runtimes.
  Background runtimes never become a global UI gate.
- During initial automatic acquisition, the workspace remains behind the loading
  boundary; it does not install a provisional reader projection. Established
  Readers retain content through later promotion and recovery.
  An initial shell or selected-locale failure before a coherent projection shows
  the startup error and retries that boundary after acknowledgement; it cannot
  silently settle as a Reader or claim successful writer startup.
- `RESOURCE_SURFACE_MANIFEST` assigns settings groups, collections, standalone
  settings, and detail projections to shared, route, runtime, and overlay
  surfaces with `render`, `interact`, `mutate`, `generate`, or `editor-prefill`
  purposes. Routes inherit only the shared shell plus their declared surface;
  optional runtimes use the same manifest without becoming render barriers.
- `prepareRouteResources()` loads pre-route requirements plus the exact routed
  chat window/prompt owner before URL state may persist, while
  `finishRouteResources()` revalidates the selected target and applies its
  compatibility projection. Once character detail identifies the owners, chat
  window and prompt-template bodies load concurrently, including during selected
  chat readiness. Both must settle successfully before readiness is granted.
  Startup reevaluates a target changed by retained-route restoration while these
  reads are pending; an old completion cannot certify the newer target or leave
  its selection change unobserved. Unchanged-target failures remain explicit.
  Requirement reads are deduplicated,
  minimum-revision fenced, and
  aborted when superseded by newer navigation. A route-local failure leaves the
  mounted shell and prior route content intact and exposes a compact Retry
  status. Intent prefetch uses the same request registry so matching navigation
  can join rather than restart it; bounded post-startup character warming remains
  idle-only and data-saver aware. Route component promises are independently
  memoized and joined by intent, navigation, and rendering; route stores do not
  switch until both pre-route resources and target code are ready. Only the root
  shell has a cross-field atomic barrier; granular route resources apply
  independently through their explicit owners and revision fences.
- `readerTranscriptProjection.svelte.ts` certifies navigation order/folders/pins,
  passive display settings, sanitized module metadata/activation links and transcript
  metadata from existing resource payloads
  before optimistic writer overlays. Shared reader views consume explicit IDs and
  these allowlists. Display-resource reads retain their session/revision/lineage
  fences; auth or lineage replacement clears reader display identities. Writer
  route prefetch/component warming never substitutes for reader display readiness.
- Reader event recovery belongs to `connectedReaderSync.ts`. It checks current
  ownership/lineage, subscribes without writer headers from the applied-resource
  cursor, and performs read-only targeted/full refreshes on events or replay
  gaps. Local navigation is restored by stable identity after replacement.
  Reconnect neither acquires a writer nor replays outbox work. Hypa/BardWiki
  operational snapshots and progress use their own stream/version fences.
- Foreground recovery does not treat an ordinary focus event as proof that a
  healthy, recently active SSE stream was suspended. Hidden, pagehide, offline,
  persisted pageshow, stale-stream, and disconnected evidence trigger one shared
  `GET /api/v1/ownership` probe per client-session generation. Unchanged
  ownership leaves a healthy stream alone, or reconnects a discarded reader
  stream from its applied event cursor without a bootstrap. Changed or uncertain
  ownership retains the full bootstrap recovery path. Generation bootstrap
  recovery is likewise limited to suspension-backed lifecycle signals.
- Writer generation recovery treats SQLite `generation_operations`,
  `generation_operation_attempts`, and `generation_effects` as durable
  authority. Active jobs are live attachment hints and local activities are
  reader-observation state. Effect claims are writer-owned, lease-fenced, and settled by
  receipts; recovery retries durable/recomputed effects and permanently skips
  late ephemeral effects. Runtime read-only bootstrap probes are epoch-fenced and
  bounded; a foreground probe may supersede an older suspended request while
  preserving the last successfully applied projection on failure. While durable
  generation activity remains visible, a failed lifecycle probe receives three
  bounded foreground retries at 500 ms, 2 s, and 5 s; a newer lifecycle event,
  successful probe, settled activity, or teardown supersedes that retry chain.
  A current, accepted probe advances the known-server command cursor before
  transcript and effect reconciliation, while the applied-resource cursor
  remains event-owned.
  Terminal or expired jobs are not cleared until their affected transcript has
  been authoritatively hydrated, and the snapshot's finalization/effect
  projections are reconciled in the same recovery pass.
- Reader generation uses `readerGenerationObservation.ts` and
  `readerGenerationStream.ts` instead of the writer send/recovery pipeline. Only
  the selected chat's exact operation/attempt/job is attached. Reads and silent
  viewers have deadlines; retries are bounded, incomplete descriptors remain
  eligible for refresh, and terminal handoff verifies the persisted message
  identity. Hidden/offline state, selection changes, and teardown release the
  HTTP viewer without cancelling its job. No finalization retry, effect claim,
  translation submission, or completion callback is started by the reader viewer.
- Command success reconciliation and foreign command SSE events both flow
  through the same serialized resource path. Contiguous response-confirmed
  optimistic effects can advance their resource fences without a read;
  authoritative reads still apply in command-event order for every other event.

| Path                                                                        | Role                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/ts/server/bootstrap.ts`                                                | Validates the small runtime bootstrap variants and the shared single-flight ownership probe.                                    |
| `src/ts/connectedClientStartup.ts`                                          | Discovers ownership and conditionally enters connected reader or authorized writer recovery.                                     |
| `src/ts/server/connectedReaderSync.ts`                                      | Reader event transport, revision reconciliation, ownership/lineage recovery, and operational snapshots.                          |
| `src/ts/server/readerTranscriptProjection.svelte.ts`                        | Certified reader navigation/display/transcript ownership and chat-incarnation fences.                                            |
| `src/ts/server/readerGenerationObservation.ts`, `readerGenerationStream.ts` | Selected generation observation and exact terminal transcript handoff without writer control.                                    |
| `src/ts/server/resourceReads.ts`                                            | Browser wrappers and response validation for settings, collections, characters, and the inlay catalog.                           |
| `src/ts/server/shellHydration.ts`                                           | Atomically preflights and applies the exact shell settings plus versioned character summaries at one revision.                   |
| `packages/shared-core/src/resourceManifest.ts`                              | Audited ownership manifest for shared, route, deferred-runtime, and first-use resource surfaces.                                 |
| `src/ts/server/routeResourceLoader.ts`                                      | Route/deferred-surface loading, deduplication, supersession, retry state, and idle character-detail prefetch.                    |
| `src/ts/server/resourceCache.ts`                                            | Disposable, non-authoritative SHA-256 manifests and verified IndexedDB values used only after authenticated hash confirmation.   |
| `src/ts/server/resourceState.svelte.ts`                                     | Explicit Svelte resource owners plus per-slice revisions, status, errors, projection epochs, and acknowledgement fences.         |
| `src/ts/server/hydrationReads.ts`                                           | Browser wrappers for chat, lorebook, legacy-preset, and prompt-template bodies.                                                  |
| `src/ts/server/chatMessageHydration.svelte.ts`                              | Active/ranged/bulk chat hydration and character-lorebook hydration.                                                              |
| `src/ts/server/characterShellHydration.svelte.ts`                           | Fetches a full character row when a consumer encounters a shell row.                                                             |
| `src/ts/server/promptTemplateHydration.ts`                                  | Fetches the template owned by a selected or explicitly requested prompt preset.                                                  |
| `src/ts/server/messageTranslationJobs.ts`                                   | Tracks detached manual or generated-message translation rows from bootstrap and refresh polling.                                 |
| `src/ts/server/greetingTranslations.svelte.ts`                              | Character-scoped greeting projection, source/settings fencing, manual translation, refresh, and job recovery.                    |
| `packages/shared-core/src/settingsGroups.ts`                                | Shared settings-group membership, including the browser `sidebar` projection.                                                    |
| `src/ts/process/serverGeneratedMessageTranslation.ts`                       | Applies translation results embedded in generation completion and seeds the shared translation-job state for running/failure UI. |
| `src/ts/process/generatedMessageTranslationEligibility.ts`                  | Prevents the older rendered-row auto trigger from duplicating server-owned generated-message translation.                        |
| `src/ts/server/inlayCatalog.ts`                                             | Standalone browser projection and revision-aware writes for inlay metadata.                                                      |
| `src/ts/server/displaySources.ts`                                           | Batches intermediate-display source reads and falls back when the advertised protocol is unavailable.                            |

Production code reads and updates the explicit settings, collection, character,
chat/transcript, lorebook, prompt-template, and standalone feature owners. There
is no production aggregate `Database` facade. A detached
`composeResourceDatabaseSnapshot()` materializer remains deliberately scoped to
interchange, browser-smoke diagnostics, and test adapters; it is not reactive
state or a persistence layer. All durable writes go through API commands.

## Read And Hydration Endpoints

All endpoints below require auth. Cache POSTs and bulk endpoints are read-only
POSTs and are classified that way in `server/fastify/src/routeManifest.ts`.

### Cache Protocol

For cache-capable resources, protocol v2 sends
`{cache:{version:2,hashes:{resource:[sha256,...]}}}`. Cache POST bodies have a
1 MiB route limit. Hash arrays are content inventories rather than positional
claims, so reordering does not resend an unchanged row. Fastify hashes the final
JSON wire value after any route-specific secret masking and shell/body
projection, and always returns the current resource revision. Every array
position is unambiguous: a hit is `{hash: sha256}` and a miss is `{value: json}`.
Whole-value resources use
the hash string for a hit and the complete JSON value for a miss. The browser
accepts a hit only when that hash's IndexedDB bytes re-hash correctly.
Missing/corrupt entries, unsupported POSTs, malformed cache responses,
unavailable IndexedDB, or unavailable Web Crypto fall back to the full GET.
The `risu-resource-cache-v1` database is disposable and non-authoritative;
cached data is never used offline or without an authenticated server response
confirming its hash. It is separate from the mutation outbox, whose retained
encrypted intents represent unsent local work and must not be cleared as a cache.

Validated root and hydration responses return independently of optional cache
persistence. Each response captures its cache generation before asynchronous
reads/authentication and transfers an owned JSON snapshot to the background
write lane. Delayed writes cannot observe later edits to the returned projection.
Cache clear, authentication/lineage invalidation, writer takeover/recovery, and
connection loss fence old reads, writes, opens, and pruning; stale responses cannot
populate a newer generation. Writer fencing retains disposable persistent rows
for authenticated reuse; clear also requests database deletion. Blocked deletion
disables cache admission until it completes without holding application recovery.

The single background lane admits at most 64 queued jobs, 32 MiB of serialized
value bodies, 8,192 value references and 1,024 manifests; keys are capped at
2,048 UTF-16 code units. Admission may skip
optional values under pressure. A fixed 50 ms timer coalesces maintenance and
queues it behind current work, so continuous arrivals cannot postpone it. A new
connection prunes before its first write; growth of 32 MiB / 8,192 values /
1,024 manifests forces another prune before the next write would exceed a bound.
Thus ordinary stored growth is bounded above the retained 64 MiB / 32,768 entry /
512 manifest limits and eventually converges to them. Each value remains capped
at 32 MiB. Byte counts describe serialized bodies, not JavaScript heap usage.
Queue accounting survives generation changes because suspended old work may
still own memory. No IndexedDB schema or cache wire-protocol version changes.

Display appearance has separate synchronous paint caches in `localStorage`:
`risu-custom-css-v1` for Custom CSS and `risu-display-settings-v1` for allowlisted
theme/layout, font, sizing, and motion settings plus resolved root CSS
properties. `src/ts/gui/displaySettingsCache.ts` owns the display cache;
`CustomCSSStore` in `src/ts/stores.svelte.ts` mirrors Custom CSS.
`index.html` restores the DOM appearance before visible content;
read-only paint helpers can retain deferred layout/size hints until Display
hydration. These values never seed a settings owner, grant readiness/mutation
capabilities, or bypass server reads. The validated shell immediately
reconciles shell-owned styles without waiting for the full Display group.
Partial shell reads retain deferred hints; a complete Display projection
replaces them, including clearing omitted keys. Unchanged style values avoid
DOM and storage rewrites. Cache/storage failures never block startup or
authoritative style updates.

Intermediate message display has a separate non-authoritative cache owned by
`server/fastify/src/displaySourceCache.ts`. It stores only completed,
side-effect-free `displaySource` text in up to four exact
page/viewport/writer namespaces and is bounded by global entry count, aggregate
UTF-8 bytes, and per-entry bytes. Namespace activation is LRU; capacity
retirement removes that namespace's completed entries, and an evicted in-flight
completion may finish but cannot repopulate it. Streaming prefixes explicitly
bypass reusable storage; other completed runs bypass it only when the caller
marks them uncacheable. Display scriptstate is isolated per target and
discarded, so it never creates a durable write-based cache bypass. This cache
creates no SQLite rows, revisions, backup data, or hydration fields.

The inlay catalog intentionally bypasses the hash cache. Its read joins
`inlay_catalog` metadata to authoritative `assets` metadata; revisioned PUT and
DELETE commands are documented in
[Assets And Saves](assets-and-saves.md#inlay-catalog).

### Shell And Resource Surface Contracts

`GET /api/v1/resources/shell` is the only initial application-data read. Its
version-1 response is exact-key validated and contains:

- one outer revision;
- the allowlisted values in `SERVER_SHELL_SETTINGS_KEYS`, with canonical defaults
  supplied for omitted or malformed values, partial `colorScheme` and
  `customTextTheme` records merged over their defaults, and legacy `pip`
  keepalive normalized to `sound`; and
- one version-1 character-summary envelope whose nested revision must equal the
  outer revision.

The same settings normalization feeds full settings, hash-cache, and settings-
group reads. A missing or malformed order becomes empty, and a selected-
character index outside the current summary range becomes `-1` rather than
pointing at a different or absent character.

`applyServerShellResource()` preflights both slices before applying either one,
records the shell as a partial settings projection, and advances the applied
resource cursor only after the complete shell is installed. The shell is not a
claim that unopened settings groups, collections, character detail, chats,
prompts, or inlays have loaded.

`RESOURCE_SURFACE_MANIFEST` is the browser-side ownership contract for everything
outside that root shell. Settings groups, collections, standalone legacy values,
and detail projections name their consuming surface and purpose. The resolver
composes shared application/settings/Playground surfaces with the current route;
chat generation, plugins, translations, background effects, and first-use
overlays remain independently schedulable surfaces. Tests require every declared
consumer path and route family to resolve and prevent route-only collections or
details from entering `shared:app-shell`.

`routeResourceLoader.ts` converts the resolved requirements to the narrow reads
below. It shares compatible concurrent requests, applies a request-start revision
floor, aborts the prior route generation, and rejects late selection-specific
results. Post-route chat and prompt targets finish only after route selection is
known. Route failure state belongs to the route surface and is retryable without
clearing the coherent shell.

Route loading and selected-shell hydration share one character hydration task
through application in `characterShellHydration.svelte.ts`. Selection changes
release the selected subscriber without cancelling a still-current route; a
cancelled route likewise leaves the selected subscriber intact. Row identity,
selection and request-start revision fences remain in force.
Other overlapping character detail reads share transport in `resourceReads.ts`
when the character, authentication and known revision match. The transport is
aborted only after every subscriber leaves, and completed reads are removed
immediately, so a later refresh still reads the server.

### Endpoint Index

| Data                                                  | Endpoint                                                                                            | Browser owner                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Database lineage and durable writer tuple             | `GET /api/v1/ownership`                                                                             | Foreground reader/writer ownership validation                        |
| Minimal coherent application shell                    | `GET /api/v1/resources/shell`                                                                       | `shellHydration.ts`, root startup                                    |
| One standalone legacy settings value                  | `GET /api/v1/resources/settings/:setting`                                                           | `routeResourceLoader.ts`, standalone setting state                   |
| Persisted settings fields                             | Cache `POST /api/v1/settings`; full `GET` fallback                                                  | `resourceReads.ts`, `settingsResourceState`                          |
| One settings group                                    | Cache `POST /api/v1/settings/:group`; full `GET` fallback                                           | Event-driven targeted invalidation                                   |
| Every split collection                                | Cache `POST /api/v1/collections`; full `GET` fallback                                               | `resourceReads.ts`, `collectionsResourceState`                       |
| One split collection                                  | Cache `POST /api/v1/collections/:name`; full `GET` fallback                                         | Event-driven targeted invalidation                                   |
| Legacy message-free character aggregate/order/current | Cache `POST /api/v1/characters/aggregate`; full `GET` fallback                                      | External compatibility route; no first-party production consumer.    |
| Version 1 character summaries/order/current           | Cache `POST /api/v1/characters`; full `GET` fallback                                                | `resourceReads.ts`, `charactersResourceState`                        |
| Inlay metadata catalog                                | `GET /api/v1/inlay-assets`                                                                          | `inlayCatalog.ts`                                                    |
| Character order only                                  | `GET /api/v1/characters/order`                                                                      | Character-order invalidation                                         |
| Character selection/interaction                       | `GET /api/v1/characters/:id/selection`                                                              | Character-selection invalidation                                     |
| One character row                                     | `GET /api/v1/characters/:id`                                                                        | Targeted invalidation and character-shell hydration                  |
| One character's greeting translations                 | `GET /api/v1/characters/:id/greeting-translations`                                                  | `greetingTranslations.svelte.ts`                                     |
| Full, tail, ranged, or generation-suffix chat body    | `GET /api/v1/chats/:id/messages` with optional `tail`, `start`/`limit`, or `generationMessageId`    | `hydrateActiveChat*()` and event invalidation                        |
| Many chat bodies                                      | `POST /api/v1/chats/messages/bulk`                                                                  | `ensureAllChatsHydrated()`                                           |
| Derived intermediate display text                     | `POST /api/v1/chats/:id/display-sources`                                                            | `displaySources.ts` negotiated batch/fallback client                 |
| Durable generation operation                          | `GET /api/v1/generation-operations/:operationId`                                                    | Authenticated operation/attempt authority                            |
| Exact operation viewer                                | `GET /api/v1/generation-operations/:operationId/stream?attemptNo=...&jobId=...&projectionEpoch=...` | Reader observation and writer reattach; no writer ownership required |
| Verified terminal replay snapshot                     | `GET /api/v1/generate/chat/:jobId/terminal-snapshot`                                                | Exact stream reference, bounded by job retention                     |
| Generation-effect status                              | `GET /api/v1/generation-effects/:generationId`                                                      | `generationEffectLedger.ts`, recovery                                |
| BardWiki chat summary/settings/index/receipts/jobs    | `GET /api/v1/bardwiki/chats/:chatId`                                                                | `bardWikiResource.ts`, lazy active-chat workspace                    |
| One BardWiki document and bounded versions            | `GET /api/v1/bardwiki/chats/:chatId/documents/:documentId`; `.../versions`                          | Lazy BardWiki document/version hydration                             |
| BardWiki receipt page and deterministic vault         | `GET /api/v1/bardwiki/chats/:chatId/receipts`; `.../export`                                         | BardWiki workspace/lifecycle adapter                                 |
| Generation-effect claim                               | `POST /api/v1/generation-effects/:generationId/:effectKind/claims`                                  | Active-writer live/recovered effect delivery                         |
| Generation-effect lease/receipt                       | `PUT /api/v1/generation-effects/:generationId/:effectKind/{lease,receipt}`                          | Claim renewal and exact settlement                                   |
| One character lorebook                                | Cache `POST /api/v1/characters/:id/lorebook`; full `GET` fallback                                   | `hydrateActiveCharacterLorebook()` and invalidation                  |
| Many character lorebooks                              | `POST /api/v1/characters/lorebooks/bulk`                                                            | `ensureAllCharacterLorebooksHydrated()`                              |
| One legacy bot-preset body                            | Cache `POST /api/v1/legacy-presets/:id`; full `GET` fallback                                        | `ensureBotPresetHydrated()`                                          |
| One prompt-preset template                            | Cache `POST /api/v1/prompt-presets/:id/template`; full `GET` fallback                               | `ensurePromptTemplateHydrated()`                                     |

### Hydration Workflows

Both bulk hydration endpoints accept at most 32 ids and 64 KiB request bodies.
The browser splits larger hydrate-all operations into 32-id batches while
preserving revision fences.

The active-chat fast path does not fetch the full transcript on every open.
`src/ts/server/chatMessageHydration.svelte.ts` asks for a tail window sized by
`chatLoadInitialPages` (30 messages by default), leaves placeholders for older
rows, and fills only newly visible ranges as the UI expands by
`chatLoadAdditionalPages` (15 by default). Export and other strict whole-chat
workflows call full or batched hydration explicitly. Stale-response drops,
hydration-generation resets, range stitching, reroll-alternate seeding, and
queued-generation-persistence acknowledgement stay scoped to the chat body.

Reader hydration can populate messages without seeding writer reroll state.
`pendingRerollHydrationEpochs` records that outstanding work against the chat body
projection epoch, including retained bodies across hydration resets and metadata
clones. A later authorized writer hydration refetches the alternates once before
using the resident-body fast path, then clears that entry. Reader events and bulk
reads cannot seed writer reroll candidates merely by making messages resident.

Ranged message application mutates a safe resident array in place: an appended
generation suffix does not copy the loaded prefix, unchanged rows retain object
identity, and malformed ranges fail back into the existing authoritative
recovery path. The generation-specific response omits `hypaV3Data` because a
plain `generation` event cannot own chat-wide Hypa state; events that do change
chat state use the broader `chatTranscript` resource. The browser distinguishes
that omission from an authoritative empty value with `hypaV3DataIncluded`.
Generation reads continue to include reroll alternates because send/continue
clear them and regenerate can replace or extend them atomically with the
message.

Modern prompt-template hydration is owner-specific. The selected preset body is
fetched before normal reconciliation begins; a background owner fetch updates
only that preset and cannot replace the selected compatibility projection.
`src/ts/server/promptTemplateHydration.ts` fences the hydration generation,
owner projection epoch, minimum revision, owner identity, and owner snapshot
before applying a response.

Greeting translations use their own character-scoped projection. The read
returns only rows valid for the current source text and translator-settings
hash. `src/ts/server/greetingTranslations.svelte.ts` additionally fences the
client settings signature and request epoch, then recovers running or recent
terminal jobs through read-only bootstrap polling.

### Collection And Cache Bounds

The collection names are `modules`, `plugins`, `modelPresets`,
`promptPresets`, `botPresets`, `promptTemplate`, `personas`, `loadouts`,
`loreBook`, `translatorPresets`, `hypaV3Presets`, and
`pluginCustomStorage`. Provider secrets are masked before settings,
collections, or character responses leave Fastify.

Settings and plugin custom storage use one whole-value hash. Array collections,
character rows, prompt-template rows, and lorebook rows use per-item hashes;
legacy presets use one hash for the complete masked body. Aggregate and targeted
`promptTemplate` collection projections have separate browser manifests because
the aggregate response can intentionally suppress the selected compatibility
body. In addition to the 1 MiB POST limit, the browser bounds each request
inventory and retains at most 512 current resource manifests with 8,192 hashes
per manifest. It keeps at most 32,768 unique content-addressed entries, pruning
unreferenced values and limiting their UTF-8 serialized JSON to 64 MiB globally
and 32 MiB per value. Those byte limits do not include IndexedDB metadata or
engine overhead.

## Settings Groups And Feature Projections

Settings-group ownership is mirrored between the browser and Fastify; the
dedicated read-only `agents` and `models` exceptions are parity-tested.
`agents` contains standalone Agents, Agent Presets, and the default-preset
pointer and is written by dedicated Agent and Agent Preset commands. `models`
contains exactly `providerCredentials`, `modelProfiles`, `modelRoleProfiles`,
and `modelRuntimeDefaults`, while writable `providers` is its superset;
because those projections overlap, applying either response advances both group
fences, while a models response preserves unrelated provider acknowledgement
taint. One providers read subsumes a simultaneous models invalidation. The
`language` read includes the command-owned `translatorPresetId` pointer.
`hypaV3Presets` is collection-owned even though memory settings commands can
change it, so the memory group response excludes it and its cross-resource event
reads the collection separately.

### Prompt Preset And Legacy Bodies

Modern `promptPresets[].promptTemplate` is the normal prompt-template owner.
Collection reads strip every modern preset template into a shell and, on the
aggregate initial read, suppress the duplicate selected top-level compatibility
body. The selected preset's template is fetched by id and copied into the
aggregate compatibility field for older consumers; fetching a background owner
updates only that preset. A selected modern prompt preset with no template owns
the disabled/missing state and must not fall through to stale top-level data.
Legacy `botPresets` likewise arrive as stable-id metadata shells and hydrate
through `ensureBotPresetHydrated*()` only when a legacy workflow needs their
settings body.

Character lorebook hydration is lazy only when experimental
`enableLorebookStubs` is enabled; the explicit lorebook owner tracks hydrated
characters so an absent stub is never persisted as a deletion.
