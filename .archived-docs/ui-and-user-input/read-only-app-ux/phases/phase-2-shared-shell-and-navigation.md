# Phase 2 — Shared Shell and Navigation

Depends on accepted [Phase 1](phase-1-reader-boundary-and-data.md). Read the
[plan](../PLAN.md) and [status](../status.md). Owners: UI-1, UI-2, DATA-1.

## Outcome

A connected reader uses the familiar responsive shell, Home/character grid,
sidebar, and chat lists with independent navigation and visible read-only status.

## Bounded Slices

1. Extract shell/navigation view boundaries with explicit data, selection,
   capabilities, and callbacks. Wire the writer adapter first and retain its
   existing behavior. Remove implicit mutable-owner rebinding and command fallbacks
   from shared views. Keep authoring dialogs/effects outside reader mounting.
2. Wire reader projection and local navigation into Home, character grid, sidebar,
   folders, pins, search, and chat lists. Preserve avatars, ordering, responsive
   layout, and loading/empty/deleted states. Provide the compact read-only indicator
   and explicit takeover action, with localized disabled-entry explanations.
3. Exercise keyboard, pointer, context-menu, drag/drop, mobile drawer, and direct-route
   flows. Keep folder expansion and unread state local; guard all existing list
   create/delete/reorder/import actions and every newly exposed callback/effect.

## Acceptance

- Two clients can browse different characters/chats using the familiar navigation;
  reader browsing never changes the writer's selected chat or shared metadata.
- The reader has usable Home/grid/list loading and empty states, back/forward,
  local folders, search, pins, keyboard focus, and mobile navigation.
- Settings/plugin launchers remain disabled; blocked routes and overlays cannot
  mount. Every shared control respects the Phase 1 policy at activation time.
- Writer list navigation, selection, folders, and authorized authoring controls
  behave as before. No shared view silently reads a mutable writer owner for readers.

Use the existing sidebar/chat-list behavioral suites and reader route tests.
Run a focused two-client browser slice with command/outbox and writer-selection
assertions once the shared navigation is mounted. Record viewport and source
details in status; transcript appearance is completed in Phase 3.
