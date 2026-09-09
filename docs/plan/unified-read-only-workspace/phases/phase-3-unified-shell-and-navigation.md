# Phase 3: Unified Shell and Navigation

## Outcome

Render settled readers inside the familiar normal workspace with one persistent
role-neutral shell, a top-right device action, local reader navigation,
restricted-route denial, and a back-only sidebar on chat routes.

## Preconditions

- Phase 2 role-first startup is accepted behind the whole-path rollout boundary.
- Reader and writer capabilities and local/persisted route ownership have stable
  tests.
- The current normal writer shell geometry and responsive behavior remain the
  visual reference.

## Work

1. Replace the new-path App-level ObserverShell branch with one workspace owner
   built around the existing role-neutral `ConversationShell` geometry.
2. Keep the outer workspace and its semantic geometry hooks stable while
   reader/writer navigation and route controllers change underneath it. Do not
   replay automatic sidebar entry/exit animation on role changes.
3. Extract shared navigation presentation with explicit characters, order,
   settings, selected IDs, pins, availability, disabled reasons, and callbacks.
   Adapt writer and reader controllers separately.
4. Preserve normal writer Sidebar behavior as an explicit regression baseline.
   Reader inputs use only certified projection values and local route state; no
   missing input may fall back to writer stores or commands.
5. Make Home, grid, pinned/recent routes, character selection, and chat selection
   available locally before a chat is entered. Keep search, folder expansion,
   drawer state, and list/grid presentation local and identity-scoped.
6. Disable Settings and Playground navigation, hover/focus preloading,
   shortcuts, restored states, and overlay entry. Reject direct restricted URLs
   before component import/resource preparation and show the localized in-shell
   access gate.
7. Audit Home/grid writer actions. Realm/import/add/edit/trash/restore/delete and
   other authoring controls are disabled or omitted for readers while safe local
   navigation and presentation controls remain available.
8. On a reader chat route, expose one Back control outside the restricted region
   and make every other sidebar control non-interactive. Ensure responsive drawer
   open/close, focus trap, Escape, and focus restoration remain coherent.
9. Add the top-right read-only/device action using the existing single-flight
   promotion operation. Implement live/busy/interrupted/offline/failed/cancelled
   status, accessible naming, localized announcements, safe-area placement, and
   focus restoration.
10. Remove the duplicate bottom takeover action from the new unified path while
    retaining it in the old rollback path until closeout.

## Acceptance

- Settled readers and writers use the same outer workspace geometry and normal
  visual identity; the new reader path does not mount `ObserverShell.svelte`.
- Exactly one visible, accessible Use-this-device action exists for an eligible
  reader and remains top-right across Home, grid, character, and chat routes.
- Reader character/chat navigation changes only the local route and creates no
  selection/last-interaction command, outbox row, or writer-store update.
- Settings and Playground cannot load through controls, intent prefetch,
  shortcuts, direct URLs, restored stores, overlays, or delayed callbacks.
- Home and grid retain safe browsing while every reader-authoring action is
  denied.
- Back is the only focusable/interactive sidebar action on a reader chat route.
- Desktop and responsive navigation retain canonical geometry, drawer state,
  keyboard behavior, focus containment/restoration, and Reduced Motion.
- Writer navigation and route behavior remains unchanged in focused and mounted
  DOM tests.

## Focused Verification

Run the affected App route-effect DOM, ConversationShell/geometry, Sidebar,
ReaderNavigation/shared-navigation, SideChatList, MainMenu, GridCatalog, router,
hotkey, and promotion-action tests. Add mounted accessibility assertions for
focusability and direct-route import denial. Run the selected desktop/mobile
reader browser journey when the new path first becomes visible. Record commands,
viewport/settings cases, and results in `status.md`.

## Handoff

Phase 4 begins only when the new reader shell/navigation path is safe and usable
without the transcript/composer refactor. Any temporary reader content adapter
must stay inside the same outer workspace and must not restore the obsolete
ObserverShell presentation.
