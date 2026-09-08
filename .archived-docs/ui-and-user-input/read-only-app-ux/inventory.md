# Read-Only App UX Source Inventory

Read [PLAN.md](PLAN.md) for intended behavior and [status](status.md) for progress
and the reviewed source baseline. These entries are navigation aids, not a claim
that every callback has already been audited. Phase 0 completes the entry matrix
from current source before extraction begins.

## Source Boundaries

### UI-1 — App shell, routes, and entry policy

- [App.svelte](../../../src/App.svelte) selects the dedicated `ObserverShell`
  before the normal sidebar/chat branch and owns top-level authoring overlays.
- [ObserverShell](../../../src/lib/ObserverShell.svelte) owns the current reader
  shell; separate its presentation from reader state and lifecycle responsibilities.
- [Reader route scope](../../../src/ts/readerRouteScope.ts) admits Home, character
  grid, and character/chat browsing; preserve denial for other route kinds.
- [Router](../../../src/ts/router.ts), [character route handlers](../../../src/ts/routeHandlers/character.ts),
  and [global API](../../../src/ts/globalApi.svelte.ts) include writer selection
  paths. Reader navigation must bypass their mutation semantics.
- [Canonical route model](../../../packages/shared-core/src/routerRoute.ts)
  owns pure route definitions; the browser route-model file is a compatibility export.
- [Hotkeys](../../../src/ts/hotkey.ts) currently include `settings` in the reader
  hotkey allowlist. The new policy must deny it and audit other indirect entries.
- [App startup](../../../src/appStartup.ts) installs routing, shortcuts, and
  route warming; restricted routes must be gated before authoring prefetch.

### UI-2 — Shared navigation presentation and local state

- [Sidebar](../../../src/lib/SideBars/Sidebar.svelte) currently reads mutable
  character owners, ordering, and writer selection. Extract explicit view inputs
  and callbacks for both writer and reader adapters.
- [SideChatList](../../../src/lib/SideBars/SideChatList.svelte) rebinds an injected
  character to mutable resource ownership and persists folder expansion through
  optimistic metadata plus a command. Passing a reader clone alone is insufficient.
- [Character folder opening](../../../src/ts/characterFolderOpening.ts) and
  [unread state](../../../src/ts/process/chatUnread.svelte.ts) are relevant local
  presentation owners. The inspected unread marker operation is in-memory.
- [Navigation guide](../../../src/docs/svelte-navigation-ui.md) maps Home/grid,
  sidebar, selection, and list dependencies for the Phase 0 entry inventory.

### DATA-1 — Confirmed resources and projection

- [Reader transcript projection](../../../src/ts/server/readerTranscriptProjection.svelte.ts)
  allowlists confirmed display fields and excludes dirty writer fields. Extend
  it or add an adjacent navigation projection; retain ownership isolation.
- [Resource read client](../../../src/ts/server/resourceReads.ts) and
  [Fastify resource reads](../../../server/fastify/src/routes/resourceReads.ts)
  expose shell, character detail, and paginated messages. The shell already
  contains ordering/pinned summaries; verify each required folder/pin field's
  owner instead of assuming it is present in the reader projection.
- [Canonical resource manifest](../../../packages/shared-core/src/resourceManifest.ts)
  and [character summary contract](../../../packages/protocol/src/characterSummaryResource.ts)
  locate schema/resource dependencies if payload changes are needed.
- [Reader display resources](../../../src/ts/server/readerDisplayResources.ts)
  provide display-specific hydration without writer runtime startup.

### UI-3 — Transcript, appearance, and executable content

- [ReaderTranscript](../../../src/lib/ReaderTranscript.svelte) supplies explicit
  read owners and selected identity, shared messages/greetings, history loading,
  and reader generation observation. Preserve this controller initially.
- [Chat read owners](../../../src/lib/ChatScreens/chatReadOwners.svelte.ts) and
  [read-owner context](../../../src/lib/ChatScreens/chatReadOwnersContext.ts)
  bind reader data without using the writer's aggregate projection.
- [ChatScreen](../../../src/lib/ChatScreens/ChatScreen.svelte),
  [DefaultChatScreen](../../../src/lib/ChatScreens/DefaultChatScreen.svelte), and
  [display readiness](../../../src/lib/ChatScreens/chatDisplayReadiness.ts) combine
  layout with writer composer, recovery, and plugin dependencies. Extract view
  boundaries; do not inherit writer readiness for reader rendering.
- [Chats](../../../src/lib/ChatScreens/Chats.svelte),
  [Chat](../../../src/lib/ChatScreens/Chat.svelte),
  [ChatBody](../../../src/lib/ChatScreens/ChatBody.svelte),
  [custom HTML template](../../../src/lib/ChatScreens/ChatCustomHtmlTemplate.ts), and
  [background projection](../../../src/lib/ChatScreens/ChatScreenBackground.ts)
  are passive-display and action audit owners. `Chat` already disables recognized
  script buttons when writes are unavailable; verify all alternate invocations.
- [Plugin runtime](../../../src/ts/plugins/plugins.svelte.ts) and the
  [scripting guide](../../../docs/structure/prompt-assembly-and-scripting.md) locate
  plugin/custom-GUI lifecycle, Lua callbacks, and isolated display transforms.
  Readers must not execute interactive scripts or mount plugin panels.

### LIFE-1 — Session, recovery, and live observation

- [Client session](../../../src/ts/clientSession.ts) and
  [startup readiness](../../../src/ts/startupReadiness.ts) own read, mutation,
  recovery, and generation capabilities. Derive UI policy from these authorities.
- [Bootstrap](../../../src/ts/bootstrap.ts) owns promotion, confirmed writer
  acquisition, recovery, writer-loss draft capture, and runtime stop behavior.
- [Connected reader synchronization](../../../src/ts/server/connectedReaderSync.ts)
  owns read invalidation, replay gaps, and reconnect.
- [Reader generation observation](../../../src/ts/server/readerGenerationObservation.ts)
  and [stream](../../../src/ts/server/readerGenerationStream.ts) own live output;
  this state is distinct from the client session's lifecycle-generation counter.
- [Composer drafts](../../../src/lib/ChatScreens/DefaultChatScreen.composerDrafts.ts)
  and the [durable mutation/recovery guide](../../../docs/structure/durable-mutations-and-recovery.md)
  locate retained intent that must survive demotion without entering reader display.

## Focused Test Entry Points

Discover companion tests through the [test index](../../../docs/tests/README.md). Extend
existing behavioral suites where practical; these paths are starting points,
not a required command list to rerun after every slice.

| Boundary                    | Existing evidence owners                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader shell/routes/actions | [ObserverShell](../../../src/lib/ObserverShell.svelte.test.ts), [route scope](../../../src/ts/readerRouteScope.test.ts), [router](../../../src/ts/router.test.ts), [hotkey navigation](../../../src/ts/hotkey.navigation.test.ts), [local mutation denial](../../../src/ts/readerLocalMutations.svelte.test.ts)                                                                          |
| Navigation ownership        | [Sidebar keyboard](../../../src/lib/SideBars/Sidebar.keyboard.dom.test.ts), [Sidebar list](../../../src/lib/SideBars/Sidebar.charList.test.ts), [SideChatList](../../../src/lib/SideBars/SideChatList.svelte.test.ts)                                                                                                                                                                    |
| Committed display           | [Reader projection](../../../src/ts/server/readerTranscriptProjection.svelte.test.ts), [display resources](../../../src/ts/server/readerDisplayResources.svelte.test.ts), [resource API](../../../server/fastify/__tests__/resourceReads.test.ts)                                                                                                                                        |
| Transcript and scripting    | [ReaderTranscript](../../../src/lib/ReaderTranscript.svelte.test.ts), [chat ownership](../../../src/lib/ChatScreens/Chat.owner.test.ts), [custom HTML](../../../src/lib/ChatScreens/Chat.customHtml.test.ts), [script-button freshness](../../../src/lib/ChatScreens/chatButtonTriggerFreshness.test.ts), [read owners](../../../src/lib/ChatScreens/chatReadOwners.svelte-node.test.ts) |
| Session and stream          | [Client session](../../../src/ts/clientSession.test.ts), [readiness](../../../src/ts/startupReadiness.test.ts), [connected sync](../../../src/ts/server/connectedReaderSync.test.ts), [generation observation](../../../src/ts/server/readerGenerationObservation.test.ts), [generation stream](../../../src/ts/server/readerGenerationStream.test.ts)                                   |
| Actual browser journeys     | [Browsing](../../../server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts), [generation](../../../server/fastify/browser-smoke/connectedReaderGeneration.spec.ts), [rollout](../../../server/fastify/browser-smoke/connectedReaderRollout.spec.ts)                                                                                                                                |

## Implementation-Time Inventory Deliverables

Phase 0 records the completed matrix and decisions in status, with linked slice
artifacts only if needed. For every reachable surface, identify its visible
control, route/shortcut/overlay entry, data owner, effect or callback, reader
policy, writer behavior, and focused proof. For each additional display field,
record its confirmed source, invalidation dependency, and lineage/revision fence.
Use read-only parallel source cross-checks for broad exploration as required by
the local project guidance; keep dependent ownership edits sequential.
