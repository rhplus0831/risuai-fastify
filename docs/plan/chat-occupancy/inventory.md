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
  replay stale unaccepted intent, or discard a new occupant's edits.
- **T07 — Finalization and effects.** A browser disappearing after acceptance
  cannot lose the result; incompatible handoff waits. Lost effect receipts,
  claim expiry/reclaim, unsupported effects, and Stop have explicit terminal
  outcomes without duplicate mutations or permanently pending completion.
- **T08 — Role independence.** General-owner promotion/demotion leaves unrelated
  occupancy and chat-only authority intact. Test automatic owner acquisition on
  startup/foreground with its preference enabled and disabled, a connected
  owner, and a stale discovery response.
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
  chat-only mode without regressing their owner paths.

Existing [durable generation tests](../../../server/fastify/__tests__/durableGeneration.test.ts)
include concurrent generation in two chats, but that is not multiple-device
authorization proof. Extend the real-session browser harnesses around
[accepted sends](../../../server/fastify/browser-smoke/acceptedSendProtocol.spec.ts),
[reader generation](../../../server/fastify/browser-smoke/connectedReaderGeneration.spec.ts),
and [writer switching](../../../server/fastify/browser-smoke/connectedWriterSwitching.spec.ts).
Use deterministic provider gates and disposable data. UI/state/network mocks
support diagnosis; they do not replace the real cross-session acceptance proof.
