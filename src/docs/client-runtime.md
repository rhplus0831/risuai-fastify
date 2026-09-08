# Client Runtime Guide

Last audited: 2026-08-31.
Targeted source check: 2026-09-08 (connected-reader startup, role transitions, and display isolation).

This file covers browser TypeScript coordinators that influence visible Svelte
UI. For component ownership and UI triage, start with the
[Svelte UI index](README.md).

The runtime is Fastify-backed. The browser loads durable settings, collections,
character rows, and the standalone inlay catalog through REST resources,
renders Svelte UI from reactive resource state, sends command mutations to
Fastify, listens for invalidation events, and fetches large bodies such as chat
messages on demand.

## Client TypeScript Areas

| Path                                                                                                                                                                                                               | Runtime ownership                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ts/server/`                                                                                                                                                                                                   | Fastify browser adapters: runtime bootstrap, encrypted pending-mutation outbox/replay, REST resource reads, explicit resource owners/invalidation, commands, hydration, events, active writer, provider/media operations, assets, backups, Realm import, owner mutation lifecycles, push notifications, stale-operation guards, diagnostics, smoke hooks. |
| `src/ts/clientSession.ts`, `src/ts/connectedClientStartup.ts`                                                                                                                                                      | Per-page identity, read/write capabilities, ownership discovery, and fenced promotion/recovery.                                                                                                                                                                                                                                                           |
| `src/ts/storage/`                                                                                                                                                                                                  | Server-backed auth/storage compatibility, resource-database accessors, `.risu` helpers, backup helpers, and auto-storage selection.                                                                                                                                                                                                                       |
| `src/ts/process/`                                                                                                                                                                                                  | `sendChat`, server-backed generation bridge, durable reattach, files/MCP/memory/embedding/post-generation helpers, retained parity helpers.                                                                                                                                                                                                               |
| `src/ts/process/request/`                                                                                                                                                                                          | Provider/server-routing classifiers, chat/completion/memory request adapters, SSE parsing, message patch helpers.                                                                                                                                                                                                                                         |
| `src/ts/model/`, `src/ts/horde/`                                                                                                                                                                                   | Browser model registry, profile UI/integration, and provider catalog adapters. Neutral profile records/resolution live in `packages/shared-core/`; see [Providers And Models](../../docs/structure/providers-and-models.md).                                                                                                                              |
| `src/ts/plugins/`                                                                                                                                                                                                  | Browser plugin loading/runtime and Plugin V3 API host. Fastify stores plugin records but does not execute plugins.                                                                                                                                                                                                                                        |
| `src/ts/process/mcp/`                                                                                                                                                                                              | Browser MCP clients, internal tools, Risu access tools, and plugin MCP clients.                                                                                                                                                                                                                                                                           |
| `src/ts/media/`, `src/ts/parser/`, `src/ts/gui/`, `src/ts/setting/`, `src/ts/translator/`, `src/ts/network/`, `src/ts/kei/`, `src/ts/util/`                                                                        | Focused helper domains that feed visible UI and tests.                                                                                                                                                                                                                                                                                                    |
| `src/ts/stores.svelte.ts`, `src/ts/globalApi.svelte.ts`, `src/ts/characters.ts`, `src/ts/characterCards.ts`, `src/ts/characterFolderOpening.ts`, `src/ts/hotkey.ts`, `src/ts/lite.ts`, `src/ts/observer.svelte.ts` | Cross-cutting browser stores, compatibility helpers, character/card and folder-opening utilities, hotkeys, lite mode, and observers.                                                                                                                                                                                                                      |

Retained compatibility and parity helpers still exist under `src/ts/process/`,
but they are not a selectable browser-local runtime. `src/ts/platform.ts`
hard-codes Fastify mode.

### Server-owned operation adapters

Browser code must use the fixed authenticated Fastify adapters when an operation
needs stored credentials or a server-owned upstream contract:

`src/ts/server/providerOperations.ts`, `embeddingOperations.ts`,
`imageGeneration.ts`, `openAITranscription.ts`, `tts.ts`, and
`mcpOAuthRefresh.ts` are the browser boundaries. `src/ts/process/tts.ts` also
cancels superseded/stopped requests and ignores late audio before playback.
Endpoint, credential, provider, limit, and result contracts belong in
[Providers And Models](../../docs/structure/providers-and-models.md#server-owned-provider-and-media-operations).

## Startup Sequence

`src/main.ts` is the thin entry boundary. It records the entry milestone,
installs required baseline globals/polyfills through `src/ts/polyfill.ts`, and
uses `src/ts/entryStartup.ts` to dynamically import `src/appStartup.ts`. Entry
or preload failures stay on the localized preloader/reload surface owned by
`src/ts/entryLoadError.ts`.

`src/appStartup.ts` installs the router, push-notification listeners,
viewport/root-scroll coordinators, language property-read subscriptions, and
shared completion-audio context unlocking before mounting `App.svelte`. It then optionally installs the Fastify browser
smoke hook, calls `loadData()`, initializes hotkeys and likely-route warming,
and removes the preloading element.

`src/ts/startupReadiness.ts` owns the startup coordinator and measurement
timeline. It publishes a Svelte-readable snapshot plus `canRenderShell`,
`canApplyRoutes`, `canMutate`, `pluginsReady`, and `canGenerate` selectors,
attempt/failure diagnostics, and completed-step state. Successful startup steps
are retained across retries, so a plugin or later-runtime failure does not
repeat writer recovery, pending-mutation replay, resource loading, event
subscription, or another completed runtime step. `App.svelte`, commands, and
generation operations consume the narrow capabilities directly.

Connected-reader startup is enabled by default.
`VITE_FAST_BOOTSTRAP_OBSERVER=FALSE` selects the conservative writer-first
fallback through `src/ts/observerShellFlag.ts`.

`loadData()` in `src/ts/bootstrap.ts` performs the visible startup work:

1. Start best-effort startup telemetry. Connected startup resolves a per-page
   identity through `connectedTabIdentity.ts`. Read-only bootstrap discovers
   the database lineage and current writer without adopting the response
   revision as command authority. A tab with exclusive ownership of its local
   identity may conditionally acquire an unowned server or resume its own
   writer; a foreign writer remains the owner even when disconnected. Without
   tab exclusivity, automatic acquisition stays disabled; setting up a genuinely
   empty server requires explicit confirmation.
2. For a reader, `installConnectedReaderProjection()` loads the coherent shell,
   waits for its selected locale, publishes `observer-ready`, and starts
   `connectedReaderSync.ts`. Reader startup then settles without outbox replay,
   writer plugins, or generation-effect recovery. For a writer, acquisition is
   fenced by the discovered lineage and writer epoch, and the following steps
   run under the accepted recovery operation. The conservative fallback
   instead adopts a sole pending-mutation writer identity before writer bootstrap,
   with takeover confirmation when another writer is connected. The
   accepted writer response supplies operation/job, finalization/effect,
   translation, and protocol projections for recovery.
3. If bootstrap reports `initialized: false`, issue the initialization command.
   The server's transactional classifier accepts only genuinely empty state and
   rejects conflict state. The winning client reuses the returned revision;
   only a client that lost the initialization race refetches read-only bootstrap
   metadata.
4. Initialize the shared lineage/writer-scoped draft-recovery scope, then
   prepare the encrypted pending-mutation outbox for the authenticated writer
   epoch and database lineage, flush saved receipt acknowledgements, and replay
   its dependency-ordered commands. Secure contexts use a non-extractable
   WebCrypto key; plain-HTTP contexts use a separately stored raw AES key and
   the fallback cipher. Startup stops if retryable or unreadable rows remain.
5. Load `GET /api/v1/resources/shell` into the explicit settings and character
   owners. The exact version-1 response contains one
   revision, allowlisted initial visual/account/sidebar settings, and the
   versioned character-summary projection at that same revision. It excludes
   collections, provider credentials, selected detail, prompt bodies, chats,
   and inlays. When a reader projection was already visible, this post-replay
   read must replace it at an equal or newer revision.
6. Seed selected-character identity from the summary projection, reset body and
   lorebook hydration, install the known-server and applied-event revision
   cursors, configure command reconciliation, apply the shell's visual settings,
   and publish `observer-ready` if a coherent read view was not already visible.
   Marker-bearing summaries remain distinct from full character rows.
7. Seed generation operations/jobs, writer-scoped generation-finalization and
   pending-effect state, and separate message/greeting translation recovery;
   install owner-mutation lifecycle flushing and the hydration runtimes, then subscribe to server
   events from the coherently applied shell revision. Writer recovery requires
   its own accepted subscription; an earlier reader stream cannot satisfy it.
   Only the current recovery operation can complete writer readiness and enable
   ordinary commands and persistence-capable route effects.
8. Route application resolves `RESOURCE_SURFACE_MANIFEST` and loads the current
   route's settings groups, collections, standalone settings, selected detail,
   chat, and prompt owner through `routeResourceLoader.ts`. A newer navigation
   aborts the older generation, compatible concurrent requirements share one
   request, and failure remains local to a route Retry surface.
9. Initialize the push coordinator and reconcile both enabled and disabled
   notification states.
10. Load plugins and start plugin runtime synchronization.
11. Reconcile recovered generation effects, then hydrate the selected character
    detail, active chat, and selected prompt owner declared by the chat-generation
    runtime surface. Publish `chat-ready`; `canGenerate` becomes true only when
    these dependencies and plugins are coherent. If retained-route restoration
    changes the character, chat or prompt owner while hydration is pending,
    reevaluate that target before granting readiness. Unchanged-target failures
    stay gated, and superseded sessions stop evaluating. A localized generation-recovery
    failure keeps the shell available and exposes app-level actions to retry only
    the failed recovery step or permanently skip its remaining client effects so
    generation can continue. Skipping does not remove the persisted reply or
    composer drafts. Selection changes rerun fenced hydration, and a specific
    character/chat failure remains localized.
12. Update error handling and show one-time nightly or insecure-origin warnings.
    Reselect the persisted character, install store/module effects and DOM
    observers, register dynamic models, reconcile the projected notification
    state, and publish `background-ready`. RisuRealm terms are requested only at
    the Realm download boundary.

`backgroundReady()` is the coordinator-owned completion selector for optional
startup work. It consumes the semantic signal rather than the ordered telemetry
phase, so a localized earlier optional-capability failure cannot keep the
bootstrap loop open. It is not a visible-rendering or route-application gate;
those consumers continue to use `canRenderShell` and `canApplyRoutes`.
Visible startup bugs often sit at the boundary between coordinator
capabilities, `selectedCharID`, resource application, route application, lazy
body reads, and CSS variable updates.

A coherent locale-ready shell may render while automatic writer acquisition or
initial recovery is unresolved. `canUseClientReaderContent()` keeps character
detail, transcript body, display, and greeting work behind a separate content
gate, so the preview cannot show a prospective writer's raw text before its
display runtime is ready. The session records actual authenticated reading or
writing disposition before publishing it, retains that readiness through later
promotion and interrupted recovery, and resets it on authentication/session or
lineage replacement. Shell readiness and mutation authority remain separate.

If the initial shell or locale read fails before projection readiness,
`bootstrap.ts` retains the unresolved startup operation, presents the error,
and retries that startup boundary after acknowledgement. It does not silently
settle the prospective writer as a permanent reader. Authentication loss, a
superseding session, or a fatal bootstrap error while acknowledgement is
pending prevents the old retry from continuing.

For a managed reader, `canRenderShell` and `canApplyRoutes` expose the coherent
read view and local navigation. `App.svelte` separately gates writer route
application, so those read capabilities never enable persisted selection,
`canMutate`, or `canGenerate`. Watching generation uses the independent reader
viewer described in [Generation Client](generation-client.md#connected-reader-observation).

`ObserverShell.svelte` exposes **Use this device** for explicit promotion.
`promoteConnectedReader()` shares one attempt, refreshes ownership, and submits
acquisition against the exact discovered lineage and writer epoch. Disconnect
confirmation, when required, retains that same precondition. The read stream
and local route remain usable while confirmation is pending. Writer recovery
must reconcile retained commands, replace the resource projection, and establish
writer events before mutation capability opens; plugins, generation effects,
and chat dependencies still gate `canGenerate`. A current operation's cancellation
or recovery failure returns to reading only while authenticated under the same
lineage. Superseded attempts cannot change a newer operation's role. Remaining
intent stays retained, and reader refresh never submits it. The latest local
route is consumed only after authorized route application succeeds for the
current writer.

A foreign writer event revokes write authority synchronously, captures local
drafts, and stops authority-bearing work before the UI returns to reading.
Reader reconnect performs discovery and resource reads rather than acquiring
the writer. Authentication loss clears the visible projection and local route
intent; lineage replacement fences old work and installs a new read projection.
Neither event makes saved drafts into server authority.

## Server Resources And Durable Mutations

The browser renders from explicit settings, collection, character,
chat/transcript, lorebook, prompt-template, and standalone feature owners in
`src/ts/server/resourceState.svelte.ts` and adjacent owner modules. The inlay
catalog in `src/ts/server/inlayCatalog.ts` is a standalone root projection.
Large chat, lorebook, legacy-preset, and prompt-template bodies hydrate only
when a workflow needs them. The authoritative-state invariant is canonical in
[Project Structure](../../STRUCTURE.md#repository-wide-invariants), while
[Server Resources And Hydration](../../docs/structure/server-resources-and-bridges.md)
owns endpoint, cache, and hydration contracts. Event reconciliation, the
mutation queue, and durable outbox behavior belong in
[Durable Mutations And Recovery](../../docs/structure/durable-mutations-and-recovery.md).

There is no production aggregate database facade. Reactive callers subscribe to
the specific owner fields they render, and owner-specific projection epochs
fence stale reads and rollbacks without turning unrelated updates into a global
invalidation. `composeResourceDatabaseSnapshot()` creates a detached snapshot
only for interchange, browser-smoke diagnostics, and test adapters.

The main client boundaries are:

| Path                                                                                                                                   | Responsibility                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/ts/server/resourceReads.ts`, `resourceCache.ts`                                                                                   | Root/targeted reads and the disposable authenticated-hash cache.                                           |
| `src/ts/server/connectedReaderSync.ts`, `readerTranscriptProjection.svelte.ts`, `readerDisplayResources.ts`                            | Reader event reconciliation, certified display/transcript projections, and read-only display dependencies. |
| `src/ts/server/shellHydration.ts`, `src/ts/server/routeResourceLoader.ts`, `packages/shared-core/src/resourceManifest.ts`              | Atomic root shell application and manifest-driven route/runtime resources.                                 |
| `src/ts/server/hydrationReads.ts`, `chatMessageHydration.svelte.ts`, `characterShellHydration.svelte.ts`, `promptTemplateHydration.ts` | Lazy owner-body and shell hydration.                                                                       |
| `src/ts/server/commands.ts`, `events.ts`, `resourceInvalidation.ts`, `resourceRefresh.ts`                                              | Serialized commands, SSE reconciliation, targeted reads, and full recovery.                                |
| `src/ts/server/pendingMutationOutbox.ts`, `durableMutationDispatch.ts`, `pendingMutationReplay.ts`                                     | Encrypted crash-recovery intents and pre-hydration replay.                                                 |
| `src/ts/server/greetingTranslations.svelte.ts`                                                                                         | Character-scoped greeting projection, refresh, manual translation, and job recovery.                       |
| `src/ts/server/ownerMutationLifecycle.ts`, `pendingOwnerMutationRegistry.ts`                                                           | Registers and flushes loaded explicit owners at structural and lifecycle boundaries.                       |
| `src/ts/server/settingsOwner.svelte.ts`, `lorebookOwner.svelte.ts`, `scriptDefinitionOwner.svelte.ts`                                  | Owner-scoped drafts, narrow command dispatch, projection fencing, and field/row rollback.                  |

Reader navigation and passive appearance share the same certification boundary.
Resource/receipt consumers copy allowlisted order, folders, pins and visual
settings before applying optimistic writer overlays. Shared presentation has no
independent rollout flag and does not start writer route warming, composer
recovery or plugins. Restricted route/overlay/script actions check current
authority, while explicit takeover retains only valid local reading intent.

Reader transcripts use the separately certified projection in
`readerTranscriptProjection.svelte.ts`, populated from authoritative resource
and command results before optimistic writer overlays are reapplied. It retains
only the display character/chat/persona fields and certified message bodies.
`ReaderTranscript.svelte` may retain a same-route read snapshot through a failed
refresh, fenced by authentication, lineage, and chat incarnation. Local drafts,
pending outbox rows, and transient generation text do not enter that snapshot.

If a component shows stale or missing data, confirm whether the data is:

- absent from the settings/collections/characters/inlay-catalog response by design;
- waiting on a chat, lorebook, character row, legacy preset, or prompt-template
  endpoint;
- hidden by a route/store condition;
- optimistically changed but awaiting command confirmation;
- retained for replay after a retryable command failure, or rolled back after a
  terminal/non-durable failure;
- superseded by an SSE-triggered targeted read or full resource refresh.

Chat/message compatibility writes in `src/ts/chatCommands.ts` classify a list
change into the narrowest safe command: append, single-message update, prefix
truncate, single delete, or tail replacement after a known persisted anchor.
Fully hydrated incompatible edits can fall back to full replacement, but a
placeholder-bearing transcript is not broadly replaced. At send time,
`src/ts/process/sendChatContext.ts` assigns ids locally to missing rows in a
fully loaded transcript, but persists those backfilled ids only when they form a
contiguous suffix following a persisted anchor. Other shapes remain local for
that send.

Mutation-facing UI must consume the helper outcome instead of assuming that an
awaited dispatch means success. `queued` is retained local intent, not server
acceptance; keep the user's newer draft and surface `accepted`, `queued`, or
`failed` without prematurely closing the surface.

`src/ts/server/persistenceActivity.svelte.ts` aggregates in-flight mutations
and this writer's unacknowledged outbox rows. `SavePopupIcon.svelte` displays
that shared state when the retained `showSavingIcon` preference permits it.
Individual controls keep their disabled/busy state and failure feedback, while
queued outcomes use the shared indicator and notification flow instead of
mounting transient status rows throughout the UI.

### All-Chats Export Fence

The destructive reset coordinator is fenced to the exact transcript state that
was exported. `exportAllChats()` strictly hydrates every chat, serializes the
download, and returns a fence containing the chat set, each message count, and
the final message id and serialized-message hash. After both confirmations,
`src/lib/SideBars/SideChatList.svelte` calls
`matchesAllChatsExportFence()` against live state; any mismatch aborts before
`dispatchResetChatsWithOutcome()` applies its optimistic replacement.
User-facing export/reset semantics belong in
[Assets And Saves](../../docs/structure/assets-and-saves.md#chats-and-datasets),
and the controls belong in [Svelte Navigation UI](svelte-navigation-ui.md).

### Loadout Apply Sequencing

`src/ts/loadout.ts` applies selected loadout scopes only after flushing pending
owner writes. It fences the target, runs the required durable commands as one
ordered sequence, and rolls back or reapplies still-owned projections according
to accepted, queued, or failed outcomes;
`src/ts/server/loadoutCanonical.ts` validates canonical response state.
`characterIds` records recent character use only: applying a loadout does not
select or navigate to a character. Guards are `src/ts/loadout.test.ts` and
`src/lib/Others/LoadoutModal.svelte.test.ts`. The shared queue/outcome contract
is owned by
[Durable Mutations And Recovery](../../docs/structure/durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements).

## Draft Recovery Stores

Editing recovery is deliberately separate from the pending-mutation outbox.
These records are scoped to the current database lineage and writer session;
they are drafts, not durable commands, server receipts, or proof of acceptance.

- `DefaultChatScreen.composerDrafts.ts` keeps the five composer fields per
  transcript in `sessionStorage`. Records survive reload, use generation-fenced
  clearing, and are bounded to 50 entries, seven days, 256 KiB per record, and
  2 MiB total.
- `src/ts/server/moduleEditorDraftStore.ts` keeps module-editor drafts in a
  separate AES-GCM IndexedDB store. It is bounded to 20 records, 30 days,
  16 MiB per record, and 64 MiB total. `ModuleSettings.svelte` rebases a restored
  draft onto current canonical state and offers copy/export/discard recovery when
  the target disappeared.

`src/ts/server/writerDraftRecovery.ts` also captures registered mounted editor
and composer fields synchronously when writer authority is lost, retaining a
memory copy before asynchronous encrypted persistence. `WriterDraftRecovery.svelte`
exposes the saved local edits for comparison, copy/export, or explicit discard.
Demotion and reader refresh do not replay them or substitute them for committed
transcript text.

Only an accepted save for the exact draft generation clears its recovery row.
Queued, failed, or superseded work remains available so newer edits are not
discarded.

## Async Freshness And Import Guards

`src/ts/server/staleStateGuards.ts` is the shared helper for browser async work
that must not apply after the user changes selection, resource refreshes, or a
newer operation supersedes it. It provides latest-operation tokens,
destructive-refresh epochs, attempted-field/list rollback helpers, and dirty
draft merge helpers used by command bridges and UI import flows.

Specialized guards under `src/ts/server/` cover current import and fetch
surfaces:

- `biasImport.ts`, `colorSchemeImport.ts`, `naiVibeImport.ts`, and
  `seperateParametersImport.ts` parse imported JSON and apply it only when the
  selected prompt preset, display scheme, provider/model context, or parameter
  slot still matches the captured snapshot.
- `nanoGPTDashboardFetch.ts` prevents stale NanoGPT balance/subscription fetches
  from persisting subscription state after the API key changes.
- `characterAdditionalAssetUpload.ts`, `characterEmotionUpload.ts`,
  `characterFolderImageUpload.ts`, `characterNotificationImageUpload.ts`,
  `characterTtsAssetUpload.ts`,
  `moduleAssetUpload.ts`, `personaIconUpload.ts`, `promptPresetIconUpload.ts`,
  and `settingsMediaAssetUpload.ts` apply uploaded asset ids only if the current
  owner and field snapshots still match.

These guards are client-side freshness checks. Server persistence still happens
through asset upload routes, command helpers, or settings patches after the
freshness check passes.

## Push Notification Coordinator

The notification setting records the user's shared preference; device setup
failures never write it back to disabled. `src/ts/server/pushNotificationSetting.ts`
serializes browser/server subscription work through `src/ts/server/pushNotifications.ts`.
Startup and background recovery inspect existing permission without prompting.
Only explicit enable/retry actions request permission, synchronously before
awaiting hydration. Failed registration preserves the browser subscription for
the next attempt. Transient failures retry after 5 seconds with exponential
backoff capped at 60 seconds; the shared lifecycle recovery dispatcher also
rechecks on online/foreground signals. Permission and unsupported-browser
failures wait for a user action or lifecycle recheck. Intentional disable,
disposal, and writer loss prevent further automatic enablement.

`src/ts/server/pushNotificationState.ts` exposes a small shell-safe status store.
App lazily mounts `PushNotificationWarning.svelte` above route content, and the
notification setting uses the same warning and retry action. The warning stays
visible during retries and clears on successful setup or intentional disable.
The banner also offers **Hide on this browser**, persisted in localStorage by
`src/ts/gui/pushNotificationWarningPreference.ts`. Dismissal survives reloads and
is shared across tabs of the same origin/browser profile. Display settings can
restore the banner and always retain the inline warning and Retry action.
This presentation preference does not change shared notification enablement or
automatic setup retries. Reload revalidates the preserved notification preference
and recreates unresolved warnings unless the browser has dismissed the banner.
Unresolved cleanup endpoints
and local-subscription-inspection state persist in IndexedDB through
`src/ts/server/pushNotificationRetryStorage.ts`, then hydrate and retry after
reload. `public/service-worker.js` owns notification display plus the
focus/open and message/ack handshake. A mounted app routes in place through
`src/ts/server/pushNotifications.ts`; service-worker navigation/openWindow are
fallbacks when no client acknowledges. On initial load and whenever the app
returns to the foreground, the browser coordinator also closes chat-completion
notifications from the current device's service-worker registration.

The guard set is `src/ts/server/pushNotificationSetting.test.ts`,
`src/ts/server/pushNotificationRetryStorage.test.ts`,
`src/ts/server/pushNotifications.test.ts`,
`src/ts/server/serviceWorker.test.ts`, and
`src/lib/Setting/Pages/Display/NotificationToggle.svelte.test.ts`. The visible
states belong in [Svelte Settings UI](svelte-settings-ui.md); server
subscription persistence remains in
[Backend Map](../../docs/structure/backend.md#route-family-index).

## Active Writer Loss

A current SSE frame naming another writer, or a validated
`423 active_writer_stale` response, revokes authority through `clientSession.ts`
and `src/ts/server/activeWriterSession.ts`. Managed sessions synchronously capture
mounted drafts and fence old callbacks. `bootstrap.ts` stops writer runtimes
and replaces them with `connectedReaderSync.ts` and authoritative read
projections; losing write access does not permanently close reader networking.
The reader keeps local navigation and can observe the selected generation.
Managed startup never acquires a foreign writer just because its event
connection is absent. **Use this device** performs explicit conditional
acquisition and recovery against freshly discovered ownership.

With `VITE_FAST_BOOTSTRAP_OBSERVER=FALSE`, the conservative path retains its
refresh-or-stay flow. It closes writer resource/hydration/translation/reattach
services; staying offline freezes editable controls and adds the reload banner
while keeping text selectable. Refresh re-enters conservative writer bootstrap,
including connected-writer takeover confirmation when required.

Managed import/restore observation can replace the lineage in place, enter
reading even when the server still names the same writer session, and install
new authoritative resources without reloading the document. Still-valid local
routes remain available; explicit writer recovery restores their authoring
view. Once that transition advances the client generation, a delayed
old-lineage command response cannot trigger a reload or restore old state.
A lineage conflict belonging to the still-current generation, and unsafe
pending-mutation predecessor recovery, retain forced-reload paths; conservative
old-lineage command recovery uses those paths. Inspect `bootstrap.ts`,
`connectedReaderSync.ts`, `observerProjectionLifecycle.ts`, and the command's
captured generation before assuming every lineage change requires a reload.

## Generation Client

Durable send/continue/regenerate acceptance, streaming, cancellation, reattach,
terminal reconciliation, effect delivery, half-streaming, and completion audio
moved to the focused [Generation Client](generation-client.md) guide. Keep
startup, resources, drafts, writer loss, and adjacent runtime ownership here.

## Intermediate Display Bridge

Before final markup rendering, `ParseMarkdown()` keeps its first browser asset
pass and asks the negotiated display-source bridge to perform only the
intermediate `editdisplay` stages. `src/ts/server/displaySources.ts` batches
same-chat mounted rows, reports an ephemeral page id plus language and viewport,
and fences each result by request key, source hash, context fingerprint, target
identity, and projection epoch. `ChatBodyParseMemo` remains above this bridge,
so a browser memo hit performs no request and the existing last-good body stays
visible while a replacement is pending. Server-side Lua display state is
isolated per target: writes may influence the remainder of that target's
intermediate transform, but are discarded before another target runs and never
become chat authority. The current bridge still shares the global command
revision lane to fence each batch against its requested base revision and
ingests every chunk response revision before later mutations dispatch.

Batch scheduling registers same-namespace work before source and context hashes
settle, then waits for all registered preparations before starting the
zero-delay flush. Digest completion order therefore cannot split concurrently
requested same-chat rows into separate revision-lane operations.

Initial transcript mounting assigns the newest two messages critical priority
and the remaining mounted window background priority. The bridge sends the
critical group first and releases its parse/readiness promises before yielding
and entering the background group into the revision lane; targets inside either
group remain serialized because their execution budgets and runtime scope are
mutable. Changing the visible chat resolves queued obsolete work and aborts its
in-flight fetch. Fastify converts that disconnect into an `AbortSignal` for the
display stages, so an old chat cannot keep the new chat queued behind a full
transform batch.

With current write access, the full client `processScriptFull` path remains the
fallback for browser edit hooks, unsupported fuzzy dynamic assets, missing
protocol support, stale writer/revision/context, and network failure. Readers
use the same isolated server display bridge but fall back to readable source
with localized limited-display feedback; they never enter general client
scripts, plugin hooks, or provider effects. The display batch uses a read-only
POST independently of the GET-only generation viewer.

Growing generation prefixes are marked as streaming: pending duplicate
prefixes coalesce and server results bypass the shared stable-row LRU. Final
Markdown, CSS scoping, DOMPurify, blob URLs, metadata, and DOM activation remain
browser-owned.

## Rendered Markup Sanitization

The normal `ParseMarkdown()` path in `src/ts/parser/parser.svelte.ts` encodes
style blocks before Markdown rendering, then `trimMarkdown()` sanitizes the
rendered markup. Because `decodeStyle()` can reintroduce decoded CSS/markup, a
changed decoded result is passed through `DOMPurify.sanitize()` again with
`FORCE_BODY: true` before the string is returned for rendering. Keep this
second pass when changing the parser; the first sanitation pass alone does not
cover decoded output.

## Adjacent Runtime Owners

| Topic                                                        | Browser entrypoints                                                                                                                                                     | Canonical guide                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client diagnostics                                           | `src/ts/diagnostics.ts`, `src/ts/server/clientDiagnostics.ts`                                                                                                           | [Client Diagnostics](../../docs/structure/development-and-observability.md#client-diagnostics)                                                                                                                                 |
| Module folders and organization                              | `src/ts/moduleOrganization.ts`, `src/ts/moduleCommands.ts`                                                                                                              | [Module Organization](../../docs/structure/plugins-and-mcp.md#module-organization)                                                                                                                                             |
| Assets, inlay catalog, saves, backups, Realm, legacy storage | `src/ts/server/assets.ts`, `inlayCatalog.ts`, `backups.ts`, `realmImport.ts`; `src/ts/storage/backup.ts`, `fastifyStorage.ts`                                           | [Assets And Saves](../../docs/structure/assets-and-saves.md)                                                                                                                                                                   |
| Plugins, modules, MCP                                        | `src/ts/plugins/`, `src/ts/moduleActivation.ts`, `src/ts/process/modules.ts`, `src/ts/process/mcp/`; neutral parsing in `packages/shared-core/src/moduleIntegration.ts` | [Plugins And MCP](../../docs/structure/plugins-and-mcp.md)                                                                                                                                                                     |
| Providers, prompt assembly, and Agents                       | `src/ts/model/`, `src/ts/process/request/`, `src/ts/process/promptAssembly/`                                                                                            | [Providers And Models](../../docs/structure/providers-and-models.md), [Prompt Assembly And Scripting](../../docs/structure/prompt-assembly-and-scripting.md), [Agents And Presets](../../docs/structure/agents-and-presets.md) |
| Retired/browser-local surfaces                               | `src/ts/platform.ts`                                                                                                                                                    | [Generated Files And Legacy Caveats](../../docs/structure/generated-and-legacy.md)                                                                                                                                             |

`packages/shared-core/src/moduleIntegration.ts` parses and deduplicates the
comma-separated module references shared by prompt and Agent Presets.
`src/ts/process/modules.ts` combines the effective prompt-preset and Agent
Preset references with global, chat, and character module selections; the
reactive signature in `src/ts/stores.svelte.ts` reruns `moduleUpdate()` when
either preset selection or integration field changes. Prompt and Agent
precedence stays in the focused guides linked above.

## Runtime Risks For UI Work

- Direct mutation outside an explicit owner can be lost on a later REST refresh.
  Use the owning command, draft, or hydration helper.
- Character resources intentionally provide message-free chat rows and can
  provide lorebook stubs. Active chat messages and lorebooks hydrate later from
  their concrete endpoints.
- Writer route effects require App's `canApplyWriterRoutes`. Managed readers
  keep `canApplyRoutes` for local navigation without persisted selection;
  initial shell previews also defer automatic route repair until reader content
  is admitted.
- CSS variables are applied before the conservative `writer-ready` shell
  boundary. A theme bug may
  be runtime state, not component markup.
- Plugins can add visible menu items and buttons. Check plugin stores before
  assuming a component owns every visible control.
- Full-stack visible bugs often need `pnpm dev:agent` or browser smoke because
  unit tests with fetch mocks can miss auth, SSE, resource refresh, and asset URL
  wiring.

## Verification Pointers

Agents use the focused runner only when one exact test or one source file can
answer a concrete implementation question. The user/CI-owned full matrix is in
[Testing And Operations](../../docs/structure/testing-and-operations.md#tests-and-checks).

```sh
pnpm test -- <test-or-source-file>
```

For the protocol/shared-core architecture checks and the independent server and
browser-smoke TypeScript projects:

```sh
pnpm check:server
```
