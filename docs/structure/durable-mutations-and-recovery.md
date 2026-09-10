# Durable Mutations And Recovery

Last audited: 2026-08-31.
Targeted source check: 2026-09-05 (module-folder event invalidation).
Targeted source check: 2026-09-08 (connected-reader recovery and IGP receipts).
Targeted source check: 2026-09-10 (in-place no-change writer recovery).

This guide owns browser-to-Fastify mutation durability and reconciliation:
encrypted outbox intent, the serialized command queue, compact optimistic
effects, command-event invalidation/recovery, explicit owner mutation
lifecycles, active-writer loss, and protocol diagnostics. Bootstrap resources,
cache validation, read endpoints, and hydration workflows remain in
[Server Resources And Hydration](server-resources-and-bridges.md).

Important files:

| Path                                                      | Role                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/ts/server/pendingMutationOutbox.ts`                  | Encrypted intent rows, scope/order indexes, and durable receipt acknowledgements.               |
| `src/ts/server/durableMutationDispatch.ts`                | Stages intent, classifies dispatch/replay outcomes, and settles accepted work.                  |
| `src/ts/server/pendingMutationReplay.ts`                  | Replays current-scope work after bootstrap and before resource hydration.                       |
| `src/ts/server/commands.ts`                               | Global mutation queue, response decoding, local effects, and reconciliation batches.            |
| `src/ts/server/events.ts`                                 | Authenticated reader/writer SSE transport, replay cursor, and frame decoding.                   |
| `src/ts/server/connectedReaderSync.ts`                    | Reader-only ownership checks, event reconciliation, reconnect, and memory/BardWiki observation. |
| `src/ts/server/resourceInvalidation.ts`                   | Event-to-endpoint planning, targeted reads, revision fences, and resource application.          |
| `src/ts/server/resourceRefresh.ts`                        | Coalesced complete refresh for gaps, restores, and broad recovery.                              |
| `src/ts/server/lifecycleRecovery.ts`                      | Shared visibility/page-show/online/focus recovery dispatcher.                                   |
| `src/ts/server/resourceState.svelte.ts`                   | Explicit resource owners, per-owner projection epochs, and acknowledgement fences.              |
| `src/ts/server/persistenceActivity.svelte.ts`             | Saving signal for commands and current-writer outbox work.                                      |
| `src/ts/server/draftRecoveryScope.ts`                     | Lineage/writer scope for non-authoritative editing recovery.                                    |
| `src/lib/ChatScreens/DefaultChatScreen.composerDrafts.ts` | Bounded transcript composer recovery in `sessionStorage`.                                       |
| `src/ts/server/moduleEditorDraftStore.ts`                 | Encrypted bounded IndexedDB recovery for module-editor drafts.                                  |

## Durable Mutation Recovery, Command Queue, And Local Acknowledgements

Do not conflate the persistence and acknowledgement artifacts:

| Artifact                             | Storage / protection                                   | Authority and startup effect                                                                                                      |
| ------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Disposable resource cache            | IndexedDB; SHA-256 reverified after authenticated read | Never authoritative or offline state; corruption/misses fall back to full reads.                                                  |
| Durable mutation intent              | IndexedDB; AES-GCM payload plus plaintext scope/order  | Non-authoritative pending command work; current-scope unresolved rows replay before hydration and can block hydration.            |
| Composer recovery draft              | Bounded `sessionStorage`; plaintext                    | Lineage/writer-scoped editing recovery only; not a command, receipt, or proof of acceptance.                                      |
| Module-editor recovery draft         | Separate bounded AES-GCM IndexedDB                     | Lineage/writer-scoped editing recovery with rebase/copy/discard UI; not outbox intent.                                            |
| Server mutation receipt              | SQLite; lineage-scoped mutation id                     | Authoritative idempotency record returned on replay; acknowledged after the accepted browser intent is durably removed.           |
| Compact local-effect acknowledgement | Command response plus client projection fences         | May advance already-visible optimistic state without a GET; durable nowhere and distinct from both the intent and server receipt. |

Durable helpers stage before network dispatch (and before a debounced control
waits to send). Semantic owner keys and explicit dependency keys preserve
predecessor order across commands; Web Locks coordinate tabs when available and
same-tab locks provide the local fallback. Same-writer-session and
database-lineage stage requests are cross-tab serialized before encryption; the
scope's committed-order counter advances atomically with visibility of the
complete encrypted row. Browsers without Web Locks retain same-page FIFO order,
while an IndexedDB compare-and-swap prevents a lower order from appearing after
a higher committed row across tabs. Only the allowlisted command shapes in
`pendingMutationOutbox.ts` are eligible. Secure contexts store a non-extractable
WebCrypto key; insecure contexts use a separately stored raw AES-GCM key and
tagged envelopes. If IndexedDB or secure random generation is unavailable, the
outbox cannot provide crash recovery. IndexedDB/key-persistence failure can
fall back to ordinary transport; unavailable secure randomness can fail staging
before dispatch.

Staging captures each mutable request body once as owned JSON; recursively frozen
JSON bodies can be reused. Request limits, allowlisted paths, and canonical body
shape are validated before persistence. Projection-target extraction reads that
owned snapshot without another body copy. Exact placeholder replacement reuses
the same normalization boundary even when it must stage a fresh successor.
Encrypted-envelope serialization remains a separate required operation.

Every ordinary browser command domain shares the same server revision, so
`src/ts/server/commands.ts` serializes high-level mutations through one global
queue. `runServerCommandSequence()` keeps a multi-step optimistic mutation in
one queue unit: each accepted response advances the base-revision cursor before
the next command factory runs, unrelated mutations cannot interleave, and a
first failure rolls back before the accepted earlier events are released.

Accepted response events and matching own-session SSE echoes are accumulated by
revision and reconciled once after the queued work drains. A response-supplied
local effect can advance the applied-resource cursor without a GET only when it
is the next contiguous revision and its event type, resource, and stable owner
ids match. Message effects also validate the chat-body projection epoch. Effects
that depend on an unchanged optimistic target carry the
relevant settings-group, collection, character-row/lorebook, lorebook-page, or
prompt-owner projection epoch and reject tainted targets.

The acknowledgement path covers settings patches; character, selection,
order, chat-structure, chat-message, and message-translation mutations; plugin
storage and plugin/module collections; prompt items and split/legacy presets; Agent
Preset, persona, translator-preset, loadout, lorebook, and script-definition
edits. Each helper canonicalizes only the accepted fields or fences an exact
optimistic owner, retaining any newer queued edit. Missing/unsafe response data,
an epoch change, a revision gap, or a foreign event falls back to authoritative
resource invalidation. A complete refresh advances the destructive-refresh
token before applying its first slice, so even a partial failed apply cannot
later acknowledge stale optimism.

The destructive all-chat reset uses `dispatchResetChatsWithOutcome()` in
`src/ts/chatCommands.ts`. It first flushes registered owner mutations, stages
the allowlisted character-owned `PUT` intent, applies one optimistic replacement
chat, and retains or rolls back that projection according to the normal
`accepted`/`queued`/`failed` outcome. The low-level `resetChatsCommand()`
intentionally supplies no compact local effect; its `chats.reset` event
therefore reconciles through the authoritative
`/api/v1/characters/:characterId` row. `src/ts/chatCommands.test.ts` guards the
outcome/rollback path and `src/ts/server/commands.test.ts` guards the wire
contract.

Chat organization capture is operation-scoped: identities/order/assignments for
reordering, attempted rows for creation/fork, and removed target rows for
delete/reset. Surviving row objects and histories are not copied. Removed rows
are retained by reference until owned rollback, preserving detached pending
edits; reset/delete capture the character projection epoch before any awaited
owner flush. Import capture never reads existing transcripts and retains the
accepted-prefix/failed-suffix settlement boundary.

Mutation-facing UI must distinguish `accepted`, `queued`, and `failed` helper
outcomes. `queued` means recoverable local intent was retained, not that the
server accepted it; callers should keep newer drafts, surface the outcome, and
must not close an editor or announce success merely because dispatch began.

Direct chat/folder metadata UI operations capture only supplied fields before
the optimistic write. Their stable owner IDs, previous values, and attempted
values feed the same durable dispatch and per-owner pending-attempt rebase
machinery as metadata watchers. Failed or terminally rejected queued attempts
restore only still-owned fields; newer drafts, background message changes,
and authoritative projection changes remain intact.
The app-wide saving icon is the normal transient feedback channel: it stays
active through command reconciliation and while the current writer still owns
staged outbox work, then lingers for 500 ms to avoid flicker. Per-control status
surfaces retain failures and action-specific busy/disabled semantics rather
than duplicating generic saving/queued rows. The persisted `showSavingIcon`
field defaults to `true` but remains an opt-out without a current settings UI.

## Event Invalidation And Recovery

`src/ts/server/events.ts` subscribes to `/api/v1/events` with the applied
resource revision as `sinceRevision` and `Last-Event-ID`. The separate known
server revision can advance from a command response, asset upload, generation,
or Realm completion without making an unapplied event look complete. Clean
closes and stream errors reconnect with exponential backoff plus jitter, capped
at 30 seconds. A malformed command frame forces a complete resource refresh
before reconnect. Every frame resets a 60-second silence watchdog;
visibility/page-show/online/focus recovery reconnects immediately. The writer
transport retriggers current-scope outbox replay after reconnect. A foreign
writer frame demotes a managed writer into connected reading; only explicit
**Use this device** requests acquisition. `connectedReaderSync.ts` uses the same
authenticated frame parser without writer headers, with its own bounded
backoff, watchdog, ownership/lineage checks, and read-only reconciliation. It
never replays mutations. Server writer/memory frames are live-only; only command
events are persisted and replayed.

An established writer loses mutation and generation authority synchronously when
its transport is interrupted, but its coherent writer DOM remains mounted and
inert while recovery is pending. After conditional ownership verification and
outbox reconciliation, a no-change reconnect skips shell replacement only when
the bootstrap, known-command, and applied-resource revisions are identical and
replay attempted no intent. A newer revision, replayed intent, changed ownership,
or changed lineage retains the authoritative hydration/demotion path.

`refreshInvalidatedServerResources()` sorts and normalizes a single event or a
coalesced event batch, then converts each resource key into concrete reads:

- Valid grouped settings events read `/api/v1/settings/:group`; broader
  settings-like resources still read `/api/v1/settings`.
- Collection events read only the needed `/api/v1/collections/:name` entries.
- Module-folder events are split across settings and collection owners; use
  [Module Organization](plugins-and-mcp.md#module-organization) for the
  `moduleFolders`/`moduleOrganization` read plan and mutation owners.
- Character selection and order read their narrow resources; only broad
  character events read `/api/v1/characters`. Row-scoped character, script,
  trigger, chat-metadata, and chat-folder events read
  `/api/v1/characters/:id`.
- Message and transcript events read the affected full chat body. A single
  `generation.persisted` event uses `generationMessageId` to read only the
  changed suffix; ambiguous coalesced generations safely fall back to one full
  chat read. Single-chat invalidation retains authoritative reroll alternates.
- Character lorebook events read the single or bulk lorebook endpoint.
- Greeting-translation events read
  `/api/v1/characters/:characterId/greeting-translations` at or beyond the event
  revision.
- Legacy preset row events fetch only the changed hydrated body. Membership
  events read the shell collection plus only the affected bodies at one common
  revision, preserving already-hydrated unchanged rows and concurrent local
  fields.
- Prompt-item events refresh their explicit modern prompt-preset owner (or the
  top-level compatibility collection); prompt-preset selection/update/delete
  events refresh the selected owner when ownership may have changed.
- Inlay-catalog events read `/api/v1/inlay-assets`; catalog entries are a
  standalone projection.
- BardWiki settings/document/confirmation/import/rebuild publication events
  refresh only the affected chat summary or currently hydrated document.
  Bounded live `bardwiki.job` progress updates the operational projection
  without advancing the domain revision; reconnect snapshots and targeted
  resource reads recover missed progress.
- Asset events require no application-data read; the applied revision still
  advances.
- Broad `state`/`lorebook` events, unknown resources, missing required owner
  ids, and event revision gaps use a complete
  settings/collections/characters/inlay-catalog refresh.

Model-profile and provider-credential events target the `models` group;
well-formed Agent, Agent Preset, and Agent-use events target `agents`.

Targeted responses must be at least as new as the invalidating event. Per-slice,
per-collection, character-list, character-row, hydrated-body, and prompt-owner
revisions stop older responses from overwriting newer resident state. Pending
plugin-storage operations are replayed over an incoming authoritative storage
map until their command promises finish. Chat-generation-settings also keeps a
pending-value guard so an older authoritative character row cannot replace a
newer edit while its serialized save is in flight.

Generic settings, collection, character-list, and character-row reads also
capture their owner projection epochs and resident JSON at request start. A
response is left unapplied when either fence changes while it is in flight, so
an optimistic owner edit cannot be rewound merely because its cached server
revision has not advanced yet. Complete refreshes use the same per-slice fence:
unaffected slices still refresh, while a concurrently edited slice and its
unsettled durable intent remain available for dispatch or next-bootstrap
replay. Projection replacement alone is never treated as proof that a staged
mutation was accepted; mutation-id settlement is the acknowledgement signal.

After a complete refresh, chat identities reset because character rows are
message-free, lorebook identities reset/reseed separately, and greeting
projections clear. The active chat is fetched again, selected-character identity
is preserved by stable id when possible, generation reattach is retriggered,
and generation/message/greeting job metadata refreshes through read-only
bootstrap.

Generation finalization keeps a queued or stalled projection as the bounded
refresh owner until every recovered effect has reached a terminal ledger state.
If strict transcript hydration clears that provisional row before a transient
effect claim becomes available, the refresh restores only the missing trigger;
it never overwrites a newer projection. When an authoritative bootstrap retires
a generation job, terminal transcript reconciliation retries only rejected chat
hydrations once. This handles a stale response displaced by a newer transcript
projection while repeated failures still publish the recovery warning.

Server replay is backed by SQLite `command_events` and retained for
`COMMAND_EVENT_HISTORY_LIMIT` revisions. After the writer frame and connected
comment, every successful connection receives an initial `memory_snapshot`
frame before command replay; `memoryJobEvents.ts` and `bardWikiJobEvents.ts` use
it to seed current Hypa V3 and BardWiki job/progress state. The server subscribes
to live command events before replay, queues live events that arrive during the
replay flush, then switches to live delivery. Heartbeats and live memory-event
fanout begin only after replay succeeds, and slow-consumer overflow tears down
the stream. Memory progress is not replayed and does not invalidate database
resources. The full SSE ordering contract is in
[Data And Events](data-and-events.md#sse-and-streaming).

## Explicit Resource Owners And Projection Fences

Production browser code has no aggregate mutable `Database` proxy. Settings,
collections, character rows, chats/transcripts, lorebooks, prompt templates, and
standalone feature projections expose explicit read/application/mutation
helpers. UI code updates optimistic state through its owning command or draft
helper; REST hydration and event reconciliation apply responses through the
same owners.

Each owner maintains only the revision, projection epoch, hydration state, and
acknowledgement taint needed for its scope. Settings groups, collections,
character rows/lorebooks, prompt-template owners, chats, and message bodies can
therefore reject stale responses and stale rollback without waking unrelated
consumers. Prompt-template drafts combine owner fences with hydration state and
cached command-revision reconciliation.

`composeResourceDatabaseSnapshot()` deliberately materializes a detached value
for interchange, browser-smoke diagnostics, and test adapters. It is not
reactive state, command authority, or a route for production mutations.

Compatibility chat mutations in `src/ts/chatCommands.ts` choose the narrowest
safe message command: append, single-message update, prefix truncate, single
delete, or tail replacement after a known persisted anchor. Fully hydrated
shapes that cannot use a narrow form may replace the transcript. A list
containing server message placeholders is never broadly replaced.

`src/ts/server/chatGenerationSettingsResourceGuard.ts` handles one narrower
race. `dispatchSaveChatGenerationSettings()` registers the optimistic value
while its serialized save is pending, and a character-row resource apply keeps
that value until the save settles.

Tests for resource owners, hydration, event invalidation, or lifecycle changes
that affect rendered state should follow the visible-state policy in
`testing-and-operations.md`.

## Owner Mutation Lifecycles

| File                              | Role                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownerMutationLifecycle.ts`       | Flushes every registered, loaded owner on `pagehide` / hidden visibility with `keepalive`; it does not import feature owners into bootstrap.                                                                |
| `pendingOwnerMutationRegistry.ts` | Registers owner flush/reset callbacks for targeted structural calls, lifecycle durability, and database-ownership replacement.                                                                              |
| `settingsOwner.svelte.ts`         | Explicit group-owned drafts and patches through `PATCH /commands/settings/:group`, with equality-noop suppression, exact projection fences, durable receipts, and field-scoped rollback.                    |
| `lorebookOwner.svelte.ts`         | Stable-id global/character/chat/module lorebook upsert/delete/reorder planning with hydrated guards and unsafe-diff replacement fallback.                                                                   |
| `scriptDefinitionOwner.svelte.ts` | Explicit character/module definition owner mutations plus the global-script settings draft watcher; compact create/update/delete/reorder classification, projection fencing, and full-replacement fallback. |

Common requirements are to capture snapshots, suppress no-op updates, respect
the appropriate resource epoch or revision gate, debounce noisy edits, stage
durable intent before dispatch, send the narrowest field/row mutation available,
and update optimistic state only through explicit owner helpers before the
server response. Retryable failures retain the
encrypted intent and its optimistic projection for replay. Terminal rejection
rolls back only when the attempted value still owns the target; the
non-durable fallback uses the ordinary rollback path. Multi-command watcher
fan-outs still enter the shared command queue and reconcile their accepted event
batch once.

Script-definition replacement timers are module-owned and outlive the Svelte
watcher that detected the edit, so ordinary editor teardown does not shorten the
debounce. Lifecycle `pagehide`/hidden-visibility handling remains the explicit
keepalive flush boundary.

## Active Writer And Diagnostics

Active writer is server-side. Connected startup discovers ownership before
writer-intent bootstrap; conditional acquisition checks the discovered lineage
and writer epoch. A disconnected foreign writer remains an owner, so opening a
reader or reconnecting it cannot acquire that writer. A still-connected foreign
writer also requires the explicit disconnect handshake. Stale guarded mutations
receive `423 active_writer_stale`; local projection epochs are freshness fences,
not writer authority.

The default connected-reader path revokes writes and generation control
synchronously on writer loss while retaining authenticated reading and local
navigation. Mounted drafts are captured before teardown, and delayed commands,
callbacks, and effect receipts are fenced by the client-session generation.
Owner lifecycle flushes do not dispatch while read-only. Drafts and encrypted
outbox rows retain their originating session/lineage scope; promotion does not
transfer another client's drafts or adopt its pending intent.

**Use this device** shares one current promotion promise, keeps the reader
projection available during confirmation, and then performs authorized outbox
preparation/replay, fresh shell hydration, and writer event attachment. Only
that successful recovery restores writes. Current cancelled/failed attempts
return to reading while authenticated under the same lineage; superseded
attempts cannot change a newer role. Interrupted writers revalidate their own
ownership before resuming, and become readers when another session has won.
Authentication loss clears reader route intent, optional hydration, disposable
cache state, authenticated projections, selection, and command/event revisions.
Database replacement or lineage change clears reader intent, hydration,
and cache identities while retaining the authenticated shell only until its
authoritative replacement is ready.

Reader generation observation is separate from writer `sendChat`/reattach and
effect recovery. It keeps one selected attempt viewer, bounded status/retry
work, and transient output outside the canonical transcript. Terminal output
hands off only after exact persisted identity is established by authoritative
hydration; a terminal with no retained result drops its projection after read
reconciliation. EOF is an observation failure. Detach never sends cancellation.
Readers cannot submit/retry generation, retry finalization, claim/settle effects,
or run mutation-bearing completion callbacks.

Recovered IGP loads its generation resources before deciding whether the prompt
is configured. Live and recovered IGP carry the exact claimed effect into the
durable message PATCH and await persistence before acknowledging completion.
The server commits the append and IGP receipt together, closing the accepted
PATCH/lost-receipt window across writer transfer; see
[the IGP transaction contract](data-and-events.md#revision-contract).
Other durable effects retain their own lease/idempotency requirements, and late
ephemeral effects remain skipped.

Read-only bootstrap, resource reads, event streams, generation viewer GETs,
terminal-snapshot GETs, and immutable asset reads do not require writer ownership. Legacy
storage `write`/`remove` calls do carry the active-writer session because they
mutate server-owned compatibility files. Browser writer-session handling lives
in `src/ts/server/activeWriterSession.ts`.

Server protocol metrics are opt-in with `RISU_PROTOCOL_METRICS=1` (also accepts
`true`, `yes`, or `on`). Browser protocol debug logs are opt-in with
`localStorage.setItem('risu:protocol-debug', '1')` or `'true'`. Browser
diagnostics include complete-resource-refresh reasons, hydration concurrency and
stale-drop counters, asset byte-read fanout counters, bounded
generation-recovery events and counters, and server event-stream frame/byte,
lifetime, and close-reason metrics. Memory job SSE and refresh paths
gate updates through ordering checks, record terminal jobs, and suppress stale
or non-active terminal refresh updates. Relevant files include
`server/fastify/src/protocolMetrics.ts`,
`src/ts/server/protocolDiagnostics.ts`, `src/ts/server/assets.ts`,
`chatMessageHydration.svelte.ts`, `memoryJobRefresh.ts`, and
`resourceRefresh.ts`. Generation recovery diagnostics contain only trigger,
recovery epoch, operation/attempt/job identifiers, state transitions,
disposition, and request UID; they never contain prompts, generated text,
credentials, or bodies.
