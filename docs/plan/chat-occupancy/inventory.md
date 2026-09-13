# Chat Occupancy Source and Proof Inventory

Planning source: `3c8f5aee1a48fcf35d1611323929f8197c142b6b`, inspected 2026-09-14.
Read [PLAN.md](PLAN.md) for intended behavior and [status](status.md) for progress.
This is a seed map; Phase 0 must resolve every in-scope entry to concrete
mutation/effect disposition and tests. Source symbols are navigation anchors,
not assertions that proposed occupancy behavior already exists.

## Source Boundaries

- **B01 — General owner and occupancy authority.**
  [activeWriter.ts](../../../server/fastify/src/activeWriter.ts),
  [databaseLineage.ts](../../../server/fastify/src/databaseLineage.ts),
  [db.ts](../../../server/fastify/src/db.ts), and
  [routeManifest.ts](../../../server/fastify/src/routeManifest.ts).
  One owner tuple and manifest-driven guard currently exist. Add separate chat
  authority without opening the generic command family. Primary proof owners:
  `activeWriter.test.ts`, `routeProtection.test.ts`, `migrationFoundation.test.ts`
  in `server/fastify/__tests__/`; new occupancy-focused coverage as needed.
- **B02 — Discovery, subscriptions, and automatic owner acquisition.**
  [server bootstrap](../../../server/fastify/src/routes/bootstrap.ts),
  [ownership route](../../../server/fastify/src/routes/ownership.ts),
  [connectedClientStartup.ts](../../../src/ts/connectedClientStartup.ts),
  [automaticWriterAcquisition.ts](../../../src/ts/server/automaticWriterAcquisition.ts),
  [clientSession.ts](../../../src/ts/clientSession.ts), and
  [bootstrap.ts](../../../src/ts/bootstrap.ts).
  Separate owner/occupancy observation and revalidation; current owner changes
  demote the whole page. Include duplicate-tab identity, foreground acquisition,
  SSE origin/cursor behavior, and scoped readiness in the Phase 0 map.
- **B03 — Reader UI, selection, and chat commands.**
  [App.svelte](../../../src/App.svelte),
  [DefaultChatScreen.svelte](../../../src/lib/ChatScreens/DefaultChatScreen.svelte),
  [readerRouteIntent.ts](../../../src/ts/readerRouteIntent.ts),
  [chatCommands.ts](../../../src/ts/chatCommands.ts), and
  [characterCommands.ts](../../../src/ts/characterCommands.ts).
  Reader navigation is already local, while normal mutation admission is global.
  Inventory UI handlers, shortcuts, slash commands, drops, editor flushes, and
  optimistic changes as well as network routes. Keep ordinary owner editing.
- **B04 — Send preflight and general maintenance.**
  [sendChatContext.ts](../../../src/ts/process/sendChatContext.ts) and
  [index.svelte.ts](../../../src/ts/process/index.svelte.ts).
  `setupSendChatContext` combines `lastInteraction` with message-ID repair;
  `sendChat` waits for configuration/persona/definition persistence. Split the
  required chat preparation from owner-only work. Existing focused proof:
  [sendChatContext tests](../../../src/ts/process/__tests__/sendChatContext.test.ts).
- **B05 — Accepted sends and revision ordering.**
  [server generation operations](../../../server/fastify/src/routes/generationOperations.ts),
  [operation store](../../../server/fastify/src/generationOperations.ts),
  [browser generation operations](../../../src/ts/server/generationOperations.ts),
  [command mutations](../../../server/fastify/src/commands/mutations.ts), and
  [browser commands](../../../src/ts/server/commands.ts).
  `acceptSubmitTransaction` atomically appends and registers the operation;
  `generation_operations_one_live_chat` excludes overlapping live operations.
  Browser generation submit retries revision conflicts up to three times;
  generic commands do not promise automatic retry. Preserve idempotency and
  transaction checks while introducing occupant authority.
- **B06 — Generation and shared script writes.**
  [generationChat.ts](../../../server/fastify/src/routes/generationChat.ts),
  [generationJobs.ts](../../../server/fastify/src/generationJobs.ts), and
  [luaRuntime.ts](../../../server/fastify/src/prompt/luaRuntime.ts).
  `persistAssemblyMutations` and generation finalization can write chat state
  and character fields. Inventory configured agents, memory, translation, and
  hooks for actual write scope. Detached server work needs accepted-operation
  authority independent of browser presence and current general-owner epoch.
- **B07 — Completion, effects, and job recovery.**
  [generationEffects.ts](../../../server/fastify/src/generationEffects.ts),
  [effect routes](../../../server/fastify/src/routes/generationEffects.ts),
  [generationFinalizationRetry.ts](../../../server/fastify/src/generationFinalizationRetry.ts),
  [generationEffectLedger.ts](../../../src/ts/process/generationEffectLedger.ts),
  [recoveredGenerationEffects.ts](../../../src/ts/process/recoveredGenerationEffects.ts),
  and [reattach.ts](../../../src/ts/process/reattach.ts).
  Pending effects/finalizations are currently projected to the general writer.
  Enumerate IGP, plugin output, generated translation, notification, TTS,
  completion sound, and emotion/image state; no unclassified pending effect.
- **B08 — Durable intent, receipts, and drafts.**
  [pendingMutationOutbox.ts](../../../src/ts/server/pendingMutationOutbox.ts),
  [pendingMutationReplay.ts](../../../src/ts/server/pendingMutationReplay.ts),
  [commandMutationReceipts.ts](../../../server/fastify/src/commandMutationReceipts.ts),
  and [composer drafts](../../../src/lib/ChatScreens/DefaultChatScreen.composerDrafts.ts).
  Current scope includes session, owner epoch, and lineage. Add selective chat
  admission without adopting dormant owner/foreign-session work. Use existing
  outbox reader, cross-tab, and replay tests plus generation recovery evidence.
- **B09 — Indirect writes and destructive maintenance.**
  [command routes](../../../server/fastify/src/routes/commands.ts),
  [repository.ts](../../../server/fastify/src/repository.ts),
  [maintenanceCoordinator.ts](../../../server/fastify/src/maintenanceCoordinator.ts),
  and [assets/save guide](../../structure/assets-and-saves.md).
  Character deletion/reset, chat/folder reorder, fork, recovery/import, restore,
  background writers, and broad row/table replacement can affect another chat.
  Do not treat `MaintenanceCoordinator` alone as proof that every ordinary
  command and generation write participates in its exclusive boundary.
- **B10 — Protocol, docs, and verification routing.**
  [protocol package](../../../packages/protocol/README.md),
  [generation client guide](../../../src/docs/generation-client.md),
  [data/events guide](../../structure/data-and-events.md),
  [mutation recovery guide](../../structure/durable-mutations-and-recovery.md),
  [browser state test guide](../../tests/browser-state-sync-and-recovery.md), and
  [test-quality guidance](../../TEST-GUIDELINE.md).
  Add occupancy negotiation/contracts to their actual owners; update manifests,
  exports, bootstrap/event consumers, and documentation together.

## Required Behavioral Proof

These IDs are acceptance obligations, not tests already run. Phase 0 assigns
each to concrete existing or planned server/browser tests and phase ownership.

- **T01 — Different chats.** Two distinct authenticated sessions send to distinct
  occupied chats with overlapping provider work; each user/result appears once
  in the correct transcript. Include owner plus chat-only and two chat-only
  senders with a separate owner. Exercise same-base revision conflict/retry.
- **T02 — Same chat exclusion.** Simultaneous claims have one winner. A losing
  chat-only session and the general owner cannot edit/send/cancel the winner's
  chat. Missing, wrong-target, forged, expired, or stale occupancy is rejected;
  changing an operation/message ID cannot bypass target resolution.
- **T03 — General-write containment.** Chat-only navigation and send cause no
  `lastInteraction`, persisted selection, character, settings, module, or plugin
  storage mutation. Verify server state and optimistic UI, not just hidden
  controls. Configured script/effect paths obey the same boundary.
- **T04 — Independent observation.** Foreign events and complete refreshes retain
  each device's selected chat, drafts, and optimistic rows. Observing or detaching
  a stream neither occupies the chat nor submits Stop/effect mutations.
- **T05 — Release and identity.** Renewal/release/claim races, duplicated tabs,
  legitimate reload, same-session reacquisition after an intervening occupant,
  and delayed callbacks cannot overwrite a newer occupancy.
- **T06 — Interrupted send.** Lost acceptance response, disconnect, suspension,
  retry exhaustion, and server restart preserve uncertain intent and accepted
  operations. Reconciliation does not duplicate messages/provider submission,
  replay stale unaccepted intent, or discard a new occupant's edits. Prove that
  an expired unaccepted operation becomes `requires_resubmission`, preserves its
  originating draft, and cannot reuse its ID/revision/token; only an explicit
  fresh action after current transcript/configuration/occupancy reads may submit.
- **T07 — Finalization and effects.** A browser disappearing after acceptance
  cannot lose the result; incompatible handoff waits. Lost effect receipts,
  claim expiry/reclaim, unsupported effects, and Stop have explicit terminal
  outcomes without duplicate mutations or permanently pending completion. Hold
  Hypa and BardWiki providers behind deterministic barriers across generation
  completion, attempted handoff, and restart; assert exact memory tables and
  canonical documents before and after the jobs terminalize.
- **T08 — Role independence.** General-owner promotion/demotion leaves unrelated
  occupancy and chat-only authority intact. Test automatic owner acquisition on
  startup/foreground with its preference enabled and disabled, a connected
  owner, and a stale discovery response. Prove an owner may occupy and generate
  concurrently in two chats; demotion retains both tuples and accepted work but
  blocks new chat-only intent until an explicit one-chat normalization succeeds.
  Include chat-only A → promotion/add owner B → demotion/retain B: a pin on A
  rejects the entire normalization, then after settlement the retry atomically
  releases A and converts only B without a mixed-class unique-index conflict.
- **T09 — Indirect owner writes.** Character/chat deletion, reset, folders/reorder,
  imports/restores, and background writes cannot alter a foreign-occupied chat.
  Deletion, reset, and restore reject the entire operation if any affected chat is
  occupied, identifying conflicts and the safe release path. Show unrelated owner
  operations remain usable and legitimate same-chat accepted server work can
  settle.
- **T10 — Auth, lineage, and rollout.** Auth loss, destructive lineage rotation,
  chat replacement/reused ID, unsupported/older client protocol, and rollback
  cannot resurrect stale authority, mutate a new database, or strand recovery.
- **T11 — Existing owner behavior and UI.** Preserve owner sending, authoring,
  current generation modes, and configured features outside declared changes.
  Verify required chat-only Reroll, retained navigation occupancy, explicit
  cross-chat mutation switching, conflict feedback, and usable composer/Stop
  controls in desktop and mobile web, with localized strings and no shell
  replacement regressions. Continue/regenerate remain visibly deferred for
  chat-only mode without regressing their owner paths. Include the existing
  same-session, different-chat concurrent-generation case in the owner regression
  matrix rather than treating it as multi-device authorization proof.

Existing [durable generation tests](../../../server/fastify/__tests__/durableGeneration.test.ts)
include concurrent generation in two chats, but that is not multiple-device
authorization proof. Extend the real-session browser harnesses around
[accepted sends](../../../server/fastify/browser-smoke/acceptedSendProtocol.spec.ts),
[reader generation](../../../server/fastify/browser-smoke/connectedReaderGeneration.spec.ts),
and [writer switching](../../../server/fastify/browser-smoke/connectedWriterSwitching.spec.ts).
Use deterministic provider gates and disposable data. UI/state/network mocks
support diagnosis; they do not replace the real cross-session acceptance proof.

## Phase 0 Mutation and Effect Disposition

The following map is the implementation boundary for Phases 1-3. “Owner” means
the existing general owner, still subject to a foreign-occupancy check. “Scoped”
means the exact accepted operation tuple and immutable `chat_only_v1` allowlist,
not generic command access.

| Family                                       | Current entry points                                                                  | Owner disposition                                                                                                                                  | Chat-only v1 disposition                                                              | Required enforcement                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Send                                         | `process/index.svelte.ts`, browser/server `generationOperations.ts`                   | Per-chat owner occupancy on new protocol, including concurrent owner sends in different chats; legacy owner allowed only when not foreign-occupied | Required, scoped                                                                      | Atomic tuple/revision/target validation with operation insert and accepted user row                                          |
| Reroll                                       | `DefaultChatScreen.svelte`, `rerollNavigation.svelte.ts`, mode `regenerate` operation | Preserved; occupancy required on new protocol                                                                                                      | Required as the only chat-only regenerate-shaped action                               | Exact assistant target, occupied chat, alternate/result finalization; UI must not expose general Regenerate                  |
| Stop                                         | `generationStop.svelte.ts`, generation operation cancel route                         | Preserved for own operation; no foreign cancel                                                                                                     | Required for originating admitted operation                                           | Resolve chat from operation, accept exact tuple or persisted cancellation authority, terminal reconciliation before release  |
| Continue / Regenerate                        | `DefaultChatScreen.svelte`, `sendChat`, generation operation modes                    | Preserved                                                                                                                                          | Visibly unavailable                                                                   | Client gate plus server `chat_only_interaction_unsupported`; no operation staged                                             |
| Message repair                               | `sendChatContext.ts`, message tail replacement command                                | Preserved                                                                                                                                          | Required only for missing-ID repair in send preparation                               | Chat-scoped narrow write under occupancy; no paired character update                                                         |
| Message edit/delete/disable/truncate/replace | `Chat.svelte`, `chatCommands.ts`, targeted message routes                             | Preserved on unoccupied/self-occupied chat                                                                                                         | Visibly unavailable                                                                   | Server resolves message ID to chat and blocks foreign occupancy even when a forged chat ID is supplied                       |
| Chat metadata/bookmarks/notes/scriptstate    | `chatCommands.ts`, chat PATCH/scriptstate routes                                      | Preserved on unoccupied/self-occupied chat                                                                                                         | Manual controls unavailable; accepted chat vars and `lastMemory` scoped               | Filter accepted mutation keys; reject owner transaction on foreign occupancy                                                 |
| Chat generation settings                     | `activeChatGenerationSettings.ts`, chat generation-settings route                     | Preserved on unoccupied/self-occupied chat                                                                                                         | Read effective snapshot; editor unavailable                                           | Server-derived snapshot at acceptance; no chat-only save/flush                                                               |
| Create/delete/reset/fork chats               | `chatCommands.ts`, character/chat create, delete, reset, and fork routes              | Create allowed; delete/reset whole-operation reject on any affected occupancy; fork allowed only as read-only snapshot of an unchanged source      | Unavailable                                                                           | Resolve complete affected set before transaction; fork writes only new unoccupied IDs and rechecks source identity           |
| Folders and reorder                          | `chatCommands.ts`, chat/folder reorder/create/update/delete routes                    | Pure order/create/rename may proceed only with byte-identical occupied chat rows; folder delete/move rejects affected occupancies                  | Unavailable                                                                           | Narrow writes or affected-chat rejection; no broad character-row writeback                                                   |
| Character delete / alternate greetings       | character delete and alternate-greeting command routes                                | Whole operation rejects when owned chats or remapped `fmIndex` chats are occupied                                                                  | Unavailable                                                                           | Return every conflicting chat; no partial cascade                                                                            |
| Persona/model/prompt/module deletes          | generation-reference and module cleanup commands                                      | Reject if cleanup would rewrite a foreign-occupied chat; otherwise preserve                                                                        | Unavailable                                                                           | Compute reference-affected chats before commit; unrelated definitions remain editable                                        |
| Settings/character/module/plugin storage     | corresponding command families                                                        | Preserved unless the command physically rewrites an occupied chat                                                                                  | Forbidden                                                                             | Active-writer guard remains; occupancy route exceptions cannot open command prefixes                                         |
| Restore/import/reset database                | backup/save/Realm/local import and repository swap paths                              | Whole operation rejects while any occupancy or pinned chat work exists                                                                             | Unavailable                                                                           | Recheck after staging, before publication; report conflicts and release/Stop path; lineage rotation clears occupancy         |
| Asset upload / attachments                   | asset routes and composer paste/drop/file handlers                                    | Preserved                                                                                                                                          | Visibly unavailable in v1                                                             | UI and server capability gate; existing immutable reads remain available                                                     |
| Translation                                  | translator UI/message commands and generated translation worker                       | Manual owner path preserved with occupancy check                                                                                                   | Manual translation unavailable; accepted generated-message translation scoped         | Bind worker/effect to operation/chat/message and snapshot; no unrelated message or settings write                            |
| Memory                                       | Hypa/BardWiki controls, prompt memory reads/follow-ups                                | Manual controls preserved with occupancy checks                                                                                                    | Configured reads/injection and chat-owned follow-up rows scoped; controls unavailable | Admitted jobs store operation/attempt/lineage/occupancy scope and pin through terminal state; legacy jobs drain before claim |
| Input hooks / slash commands                 | `inputHooks.ts`, composer command pipeline                                            | Preserved                                                                                                                                          | Visibly unavailable in v1                                                             | Gate before optimistic mutation or plugin dispatch; plain send remains available                                             |
| Low-level legacy generation                  | `/api/v1/generate/chat` and compatibility callers                                     | Allowed only for current general owner and an unoccupied/self-occupied target                                                                      | Never a chat-only bypass                                                              | Resolve target and check occupancy before assembly and again before persistence                                              |
| Background writers                           | finalization retry, memory/BardWiki workers, translation jobs, asset GC               | Existing operational work preserved; chat writes require stored accepted scope or no foreign occupancy                                             | Only stored scope may finish                                                          | Memory/BardWiki jobs and durable effects pin; recheck lineage/operation/attempt/target at every write boundary               |

### Generation effect ledger

| Effect                | Class today               | Chat-only v1                                                                         | Handoff behavior                                                                          |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| IGP                   | Durable browser effect    | Permit exact generated assistant-message edit using operation scope                  | Pins until receipted; on expired abandoned occupancy, terminally skip before reassignment |
| Plugin output         | Durable browser effect    | Terminally skip as `unsupported_chat_only_scope`                                     | Never pins after skip and never replays under later owner promotion                       |
| Generated translation | Durable server effect     | Permit exact generated message translation                                           | Pins until server receipt/failure; target and operation resolved from ledger              |
| Notification          | Ephemeral browser effect  | Permit only originating session/live or existing recent-alert recovery window        | Does not pin; stale recovery is skipped                                                   |
| TTS                   | Ephemeral browser effect  | Permit originating-session playback when provider path performs no application write | Does not pin; late recovery is skipped                                                    |
| Completion sound      | Ephemeral browser effect  | Permit originating session/live or existing recent-alert recovery window             | Does not pin; stale recovery is skipped                                                   |
| Emotion/image state   | Recomputed browser effect | Terminally skip in v1; manual action unavailable                                     | Does not pin and cannot create shared character/assets state                              |

Server prompt/script processing may read the accepted effective configuration and
perform prompt-local transforms. It may persist only accepted transcript data,
chat script variables, chat `lastMemory`, chat-owned memory work, generated
translation, and IGP. Character fields, local character lore, plugin storage,
module/settings changes, and generated asset publication are suppressed and
reported without rolling back an already accepted transcript result.

## Phase 0 Protocol and Proof Ownership

Protocol v1 is additive: bootstrap advertises `chatOccupancyProtocol`; the
occupancy route family returns full lineage/session/chat/epoch projections; live
SSE `occupancy` frames are snapshot hints and never consume domain revisions.
Only exact protocol-v1 clients can submit chat-only work. Older owners continue
to use the existing writer header, but transaction guards prevent writes to a
foreign-occupied chat. See [status](status.md#wire-rollout-and-errors) for the
lease, endpoint behavior, error vocabulary, drain, and rollback decisions.

| Proof | Phase owner                                                 | Focused owners                                                                                                                                            | Final observation boundary                                                                                                 |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| T01   | 1 prerequisites; 2 browser path; 4 matrix                   | new `chatOccupancy.test.ts`, `generationOperations.test.ts`, `durableGeneration.test.ts`, `acceptedSendProtocol.spec.ts`, `connectedGenerationHarness.ts` | Separate BrowserContexts, deterministic per-chat provider gates, exact SQLite messages/operations, one provider call each  |
| T02   | 1 server; 2 UI; 4 matrix                                    | new occupancy/indirect-write tests, command/message/generation operation suites, chat UI DOM tests                                                        | Atomic one-winner claim; forged/stale/foreign requests rejected at server and no optimistic success                        |
| T03   | 1 scope; 2 send; 3 effects; 4 matrix                        | `sendChatContext.test.ts`, prompt/finalization/effect suites, command budget metrics, connected reader generation smoke                                   | SQLite/settings/character/module/plugin snapshots unchanged plus no forbidden optimistic mutation                          |
| T04   | 2 observation; 3 reconnect; 4 matrix                        | `connectedReaderBrowsing.spec.ts`, `readerGenerationStream.test.ts`, reader sync/hydration tests                                                          | Selection/drafts/optimistic rows survive foreign events, full refresh, detach/reopen; no Stop/effect request               |
| T05   | 1 epoch; 2 switch; 3 lifecycle; 4 matrix                    | occupancy route tests, `connectedTabIdentity.test.ts`, `activeWriter.test.ts`, writer switching smoke                                                     | Deterministic renew/release/switch races, reload versus duplicate, suspension, restart, stale callbacks                    |
| T06   | 2 staging; 3 recovery; 4 faults                             | generation operation/recovery/reattach/outbox tests and accepted-send smoke                                                                               | Lost response/restart reconciliation; stale unaccepted intent stays dormant with its draft until explicit fresh submission |
| T07   | 1 pin prerequisites; 2 Stop/Reroll; 3 completion; 4 effects | generation effects, IGP commit, memory/BardWiki worker suites, finalization retry, durable generation, generation reader smoke                            | Browser loss and blocked memory providers across restart; handoff waits; exact memory/canonical state and terminal effects |
| T08   | 1 separation; 2 UI; 3 role changes; 4 matrix                | automatic acquisition, connected startup, client session, reader sync, durable generation, writer switching smoke                                         | Owner concurrent chats plus mixed-class promotion/demotion; pinned all-row normalization rejects atomically, then succeeds |
| T09   | 1 server; 3 delayed writers; 4 matrix                       | commands, maintenance coordinator/staging, backups/imports, new indirect-write occupancy tests                                                            | Whole deletion/reset/restore rejection with conflict IDs/guidance; unrelated owner writes succeed                          |
| T10   | 1 schema/guards; 3 recovery; 4 rollout                      | migration foundation, route protection, active writer, replacement DB, occupancy protocol tests                                                           | Auth/lineage/reused-ID/restart fences and enabled/disabled/older-client/drain behavior                                     |
| T11   | 2 UI; 4 regression                                          | reroll swipe, accepted send, reader generation, durable generation, UI/UX baseline, chat DOM tests                                                        | Existing same-owner concurrent chats plus desktop/mobile interactions; deferred controls unavailable only for chat-only    |

App-injection tests cannot prove mid-stream detach because Fastify injection
buffers responses. Browser proof must use a listening Fastify instance, built
SPA, separate BrowserContexts, disposable SQLite state, unmodified production
fetch, and the controlled-provider barriers in `acceptedSendProtocol.spec.ts`.
Mocks remain focused diagnostics and must assert observable state/transport, not
private call sequences. Physical-device suspension and external provider limits
must be reported honestly in the final ledger.

The first Phase 1 slice is schema/protocol plus the isolated occupancy service
and route-family tests. Command/generation enforcement follows only after the
authority primitive and fail-closed rollout capability are proven.
