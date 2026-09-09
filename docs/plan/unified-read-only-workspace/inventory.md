# Unified Read-Only Workspace Inventory

Date: 2026-09-10

This inventory maps the source, behavior, test, documentation, rollout, and
measurement owners relevant to [PLAN.md](PLAN.md). It is a planning baseline,
not proof of shipped unified-workspace behavior. Recheck cited owners at the
start of each phase and record meaningful drift in [status](status.md).

## Current Architecture Summary

The current App has mutually exclusive loading, `ObserverShell`, Settings, grid,
and normal writer branches. `ObserverShell` combines reader controller,
navigation, local route intent, transcript selection, lifecycle status, and
promotion UI. The normal branch combines `Sidebar`, `ChatScreen`, and
`ConversationShell`.

Connected startup currently may install a coherent reader projection before an
automatic writer acquisition. Writer recovery then loads the authoritative
post-replay shell and establishes its event cursor. This ordering provides early
read visibility but creates a dedicated component handoff and can perform two
shell reads on the successful automatic-writer path.

The writer UI cannot be made reader-compatible through styling alone:

- `Sidebar.svelte` deliberately disables writer navigation and supplies no
  character rows without write access;
- `changeChar()` updates `lastInteraction`, optimistic selection, and dispatches
  a selection command;
- `ChatScreen.svelte` derives display ownership from `selectedCharID` and the
  writer-compatible resource projection;
- `DefaultChatScreen.svelte` owns composer drafts, input hooks, generation,
  plugin panels, modal entry points, and many mutable actions; and
- lower transcript owners already accept explicit read-only presentation and
  reader read-owner contexts, providing a safer extraction boundary.

## Primary Source Owners

| Concern                        | Current owners                                                                                                                                               | Planned pressure                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Browser mount and startup call | `src/appStartup.ts`, `src/App.svelte`                                                                                                                        | Keep lightweight loading/auth surfaces; replace ObserverShell branch with one workspace owner                                      |
| Role discovery and acquisition | `src/ts/connectedClientStartup.ts`, `src/ts/server/connectedTabIdentity.ts`, `src/ts/server/bootstrap.ts`                                                    | Determine writer/reader disposition before applying reader UI; preserve conditional acquisition preconditions                      |
| Startup orchestration          | `src/ts/bootstrap.ts`                                                                                                                                        | Skip early reader projection for successful automatic writers; install one projection for settled readers; preserve recovery order |
| Readiness/capabilities         | `src/ts/startupReadiness.ts`, `packages/protocol/src/startupTelemetry.ts`                                                                                    | Derive workspace presentation without collapsing render, route, mutation, plugin, and generation gates                             |
| Session authority              | `src/ts/clientSession.ts`, `src/ts/clientWriteOperation.ts`                                                                                                  | Expose the semantic established-reader versus initial-resolving distinction without a second role flag                             |
| Current observer composition   | `src/lib/ObserverShell.svelte`, `src/lib/ReaderTakeoverAction.svelte`                                                                                        | Extract retained reader controller/status/promotion responsibilities, then delete dedicated presentation                           |
| Shared shell and geometry      | `src/lib/ConversationShell.svelte`, `src/ts/gui/shellGeometry.ts`, `src/ts/stores.svelte.ts`                                                                 | Keep one role-neutral outer frame and explicit transition-cause behavior                                                           |
| Writer navigation              | `src/lib/SideBars/Sidebar.svelte`, `src/lib/SideBars/SideChatList.svelte`                                                                                    | Separate shared presentation from writer selection/organization controller; add back-only reader chat mode                         |
| Reader navigation              | `src/lib/SideBars/ReaderNavigation.svelte`, `src/lib/SideBars/readerNavigation.ts`, `src/ts/readerRouteScope.ts`                                             | Supply explicit committed rows/local callbacks to shared navigation presentation                                                   |
| Local reader route intent      | `src/ts/observerRouteIntent.ts`, `src/ts/router.ts`, App route effects                                                                                       | Rename/rehome ownership; prevent automatic post-promotion `lastInteraction` replay                                                 |
| Character selection            | `src/ts/characters.ts`, `src/ts/characterState.ts`, `src/ts/characterCommands.ts`                                                                            | Keep writer behavior; readers navigate by stable route ID without `changeChar()`                                                   |
| Chat selection/organization    | `src/ts/globalApi.svelte.ts`, `src/ts/chatCommands.ts`, `src/lib/SideBars/SideChatList.svelte`                                                               | Keep writer behavior; no reader `chatPage`, selection command, reorder, rename, create, import, export-reset, or delete path       |
| Home and grid                  | `src/lib/UI/MainMenu.svelte`, `src/lib/Others/GridCatalog.svelte`, `src/lib/SideBars/CharacterCatalogView.svelte`                                            | Reuse familiar views with local reader navigation and explicit denial of Realm/import/trash/edit operations                        |
| Writer chat composition        | `src/lib/ChatScreens/ChatScreen.svelte`, `src/lib/ChatScreens/DefaultChatScreen.svelte`                                                                      | Extract normal visual chrome; do not activate writer controller/effects for readers                                                |
| Reader transcript              | `src/lib/ReaderTranscript.svelte`, `src/ts/server/readerTranscriptProjection.svelte.ts`, reader hydration/display/generation modules                         | Retain certified read owners, lazy messages, passive display, and live observation under unified presentation                      |
| Shared transcript rows         | `src/lib/ChatScreens/Chats.svelte`, `src/lib/ChatScreens/Chat.svelte`, `src/lib/ChatScreens/ChatBody.svelte`, `src/lib/ChatScreens/chatReadOwnersContext.ts` | Continue explicit read-only propagation and denial of mutable/script/translation actions                                           |
| Writer draft recovery          | `src/ts/server/writerDraftRecovery.ts`, `src/lib/WriterDraftRecovery.svelte`, composer/editor registrations                                                  | Preserve synchronous demotion capture; never expose or create writer drafts for never-writer readers                               |
| Writer loss/reconnect          | `src/ts/server/activeWriterSession.ts`, connected reader synchronization in `src/ts/server/`                                                                 | Preserve immediate revocation, stopped writer work, refresh, auth/lineage fencing, and current-reader continuity                   |
| Commands/outbox                | `src/ts/server/commands.ts`, `src/ts/server/durableMutationDispatch.ts`, `src/ts/server/pendingMutationOutbox.ts`                                            | Remain hard authority boundary; add no presentation bypass                                                                         |
| Generation                     | `src/ts/process/index.svelte.ts`, `src/ts/process/request/serverChat.ts`, operation/reattach/effect owners                                                   | Keep generation gated beyond writer mutation readiness; readers observe only                                                       |
| Hotkeys and drag/drop          | `src/ts/hotkey.ts`, `src/App.svelte`, `src/ts/dragTypes.ts`                                                                                                  | Retain alternate-entry denial and add unified-workspace selector coverage                                                          |
| Restricted overlays            | App overlay stores/components, Settings, Playground, plugin and custom-GUI entry points                                                                      | Reject before prefetch/import/mount and close on writer loss                                                                       |
| Localization                   | `src/lang/en.ts`, `src/lang/ko.ts`                                                                                                                           | Move observer-named strings to stable read-only/device terminology and preserve parity                                             |

## Behavior and Entry-Point Matrix

| Surface/action                                  | Reader result                                                    | Required enforcement owner                                               |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Initial automatic writer candidate              | Loading until writer recovery is ready                           | Bootstrap/readiness plus App render gate                                 |
| Settled foreign-writer reader                   | Normal workspace in read-only mode                               | Client session, coherent reader projection, workspace adapter            |
| Home/pinned/recent character                    | Local route navigation                                           | Reader navigation controller; no selection command                       |
| Character grid/search/view modes                | Available locally                                                | Shared catalog presentation with reader callbacks                        |
| Character click                                 | Route-only; no `lastInteraction` or persisted selection          | Reader controller must not call `changeChar()`                           |
| Chat click before chat entry                    | Route-only; no `chatPage` or select-chat command                 | Reader controller with stable character/chat IDs                         |
| Sidebar while reader chat is open               | Only Go back is interactive                                      | Shared navigation access policy and separated Back control               |
| Settings/Playground buttons                     | Disabled with reason; no prefetch                                | Shared navigation and hotkey policy                                      |
| Direct Settings/Playground route                | In-shell write-access gate; no component/resource load           | App route admission before lazy imports                                  |
| Main-menu Realm/import/add paths                | Denied                                                           | Explicit surface capability plus existing operation guards               |
| Transcript scroll/copy/load more/read refresh   | Available where passive policy permits                           | Reader transcript/read owners                                            |
| Message edit/delete/reroll/translate/script/TTS | Denied                                                           | `Chat`/`ChatBody` presentation and action guards                         |
| Composer fields/menu/send/attachments/Draft/BTW | Visible normal chrome but non-interactive                        | Extracted composer presentation; writer controller not installed         |
| Global hotkeys and Ctrl-number paths            | Reader allowlist only                                            | `src/ts/hotkey.ts` plus action guards                                    |
| External file drop/import                       | Rejected before file processing/import                           | App `canMutate` and generation-fenced operation guards                   |
| Plugin panels/custom HTML actions               | Not mounted/executable                                           | App/plugin readiness and passive reader renderer                         |
| Use this device                                 | Explicit, single-flight promotion                                | Top-right action using connected promotion coordinator                   |
| Promotion cancellation/failure                  | Same reader route/content; focus restored                        | Promotion controller and reader projection retention                     |
| Promotion success                               | Writer UI only after recovery/event readiness                    | Client session, bootstrap, readiness; no reader `lastInteraction` replay |
| Writer loss                                     | Immediate read-only mode after draft capture and writer shutdown | Active-writer/session lifecycle and projection refresh                   |
| Auth loss                                       | Protected content removed; sign-in surface                       | Observer-projection cleanup successor and App auth gate                  |
| Lineage/database replacement                    | Old local identities fenced and refreshed                        | Projection lifecycle, caches, hydration, session generation              |

## Known Data and Interface Constraints

- The initial shell resource contains a coherent allowlist of display/navigation
  settings and character summaries; selected detail, messages, prompt bodies,
  credentials, and broad collections remain lazy.
- Reader navigation already accepts explicit characters, order, settings,
  selected IDs, pins, and callbacks. Writer `Sidebar` mostly consumes global
  stores and commands. Shared presentation should move toward the explicit
  interface rather than give reader data to writer globals.
- `ReaderTranscript` creates a scoped `ChatReadOwners` context and feeds the same
  lower `Chats`/`Chat` presentation used by writers with read-only capability.
  This is the preferred bridge for transcript visual unification.
- The writer composer is not currently a role-neutral component. Extracting its
  visual frame and control contract is safer than mounting all
  `DefaultChatScreen` effects and attempting to disable them afterward.
- Current App route effects consume observer route intent after promotion.
  Implementing the plan's no-retroactive-last-interaction contract requires an
  explicit display-target handoff or equivalent local route owner rather than
  the existing automatic persisted-selection path.

## Current Performance Baseline Inputs

| Evidence                                         | Current observation                                                                                                          | Limitation/action                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `fast-bootstrap-results/startup-matrix.json`     | Available ignored artifact contains two shell resource entries in every recorded small/large cold/warm automatic-writer case | Regenerate under Phase 0; ignored local output is not portable acceptance evidence      |
| `docs/structure/server-resources-and-bridges.md` | Documents early observer projection followed by authoritative post-replay writer shell                                       | Recheck implementation and trace exact request ownership                                |
| `src/App.svelte`                                 | Observer and writer workspaces are mutually exclusive branches                                                               | Instrument mount identity and transition cost before replacement                        |
| Prior shell-parity status                        | Provides rectangle/frame sampling and reports stable outer geometry after earlier work                                       | Reuse helper/oracles; this plan additionally targets component/resource transition cost |
| Startup telemetry and artifacts                  | Already record milestones, payload/cache totals, early mutation/generation counters, and observer rollout mode               | Extend or version only as needed for role-first cohort and request/mount evidence       |

Phase 0 must record the machine/runtime/browser configuration, fixture sizes,
cold/warm cache policy, repetition count, raw artifact locations, median/tail
comparison method, and numeric regression thresholds before implementation.

## Focused Test Owners

| Risk                              | Primary focused evidence                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup role/readiness            | `src/ts/connectedClientStartup.test.ts`, `src/ts/bootstrap.test.ts`, `src/ts/startupReadiness.test.ts`, `src/ts/clientSession.test.ts`               |
| Observer removal/App admission    | `src/App.routeEffect.dom.test.ts`, current `src/lib/ObserverShell.svelte.test.ts` cases migrated to new owners                                       |
| Local route/no mutation           | `src/ts/observerRouteIntent.test.ts`, `src/ts/readerLocalMutations.svelte.test.ts`, router and character/chat selection tests                        |
| Navigation/accessibility          | `src/lib/SideBars/Sidebar.charList.test.ts`, `src/lib/SideBars/Sidebar.keyboard.dom.test.ts`, shared navigation/ReaderNavigation tests               |
| Grid/Home restrictions            | `src/lib/Others/GridCatalog.svelte.test.ts`, MainMenu-focused tests, App direct-route tests                                                          |
| Reader transcript/passive display | `src/lib/ReaderTranscript.svelte.test.ts`, `Chats`, `Chat`, `ChatBody`, parser/passive-HTML tests                                                    |
| Composer containment/drafts       | `src/lib/ChatScreens/DefaultChatScreen.composerDrafts.test.ts`, DefaultChatScreen DOM owner tests, and writer draft recovery suites                  |
| Command/outbox denial             | `src/ts/server/commands.clientSession.test.ts`, durable dispatch/outbox/replay suites                                                                |
| Writer loss/auth/lineage          | `src/ts/server/activeWriterSession.test.ts`, `src/ts/observerProjectionLifecycle.test.ts`, connected reader sync and replacement ownership suites    |
| Generation observation/denial     | reader generation observation, generation operation/reattach, send/generation guard tests                                                            |
| Real reader/writer behavior       | `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`, `connectedWriterSwitching.spec.ts`, `connectedReaderBrowsing.spec.ts`, startup/recovery matrix |
| Performance/bundle                | `pnpm verify:fast-bootstrap` constituent scripts selected under Crunch Mode, startup matrix, bundle-boundary reports, layout-frame sampler tests     |

Use the narrowest relevant file for each implementation slice. A moved owner
requires moving or adding behavioral proof; do not retain tests that only assert
obsolete ObserverShell names or DOM markers.

## Documentation, Rollout, and Cleanup Owners

| Concern                    | Owners to update when behavior ships                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Startup/resources          | `docs/structure/server-resources-and-bridges.md`, `src/docs/client-runtime.md`                                                  |
| Active writer and recovery | `docs/structure/data-and-events.md`, `docs/structure/durable-mutations-and-recovery.md`                                         |
| UI/render priority         | `src/docs/svelte-ui.md`                                                                                                         |
| Navigation                 | `src/docs/svelte-navigation-ui.md`                                                                                              |
| Transcript/composer        | `src/docs/svelte-chat-ui.md`, `src/docs/generation-client.md` where observation/handoff changes                                 |
| Startup observability      | `docs/structure/development-and-observability.md`, protocol/browser/server telemetry schemas and tests                          |
| Test discovery             | `docs/tests/app-navigation-and-chat.md`, `docs/tests/browser-state-sync-and-recovery.md`, other affected focused test guides    |
| Temporary seam inventory   | `util/client-resource-inventory.ts` and its checked-in baseline/matrix consumers                                                |
| Rollout/smoke controls     | `src/ts/observerShellFlag.ts`, its tests, browser-smoke harness and all override consumers                                      |
| Observer-named lifecycle   | `src/ts/observerShellLifecycle.svelte.ts`, `src/ts/observerProjectionLifecycle.ts`, active-writer/bootstrap consumers and tests |
| Final component cleanup    | `src/lib/ObserverShell.svelte`, `src/lib/ReaderTakeoverAction.svelte`, obsolete fixtures/selectors/tests                        |

Do not delete observer-named files mechanically until their non-presentation
projection/lifecycle responsibilities have explicit successor owners and passing
behavioral evidence. The unrelated DOM/runtime observer module is outside this
cleanup unless a separately justified change requires it.
