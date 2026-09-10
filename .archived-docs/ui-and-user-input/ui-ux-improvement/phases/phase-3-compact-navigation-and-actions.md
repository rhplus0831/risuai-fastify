# Phase 3 — Compact Navigation and Action Density

Depends on accepted [Phase 2](phase-2-destructive-safety-and-persistence.md). Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

At 550×775 and 655×691, the sidebar reads as a deliberate modal drawer, chat identity remains scannable, and routine, secondary, reorder, and destructive actions no longer compete in every row.

## Bounded Slices

1. Refine `resolveShellGeometry()` and the responsive writer presentation without changing the 1024px breakpoint. Preserve configured columns when they fit, guarantee a visible scrim target, and place a visible Close/Collapse action inside the drawer. Strengthen the scrim while retaining backdrop dismissal, Escape, focus trap, and inert main content.
2. Consolidate chat and folder secondary actions through `PopupList.svelte`. Keep row selection primary; keep only the minimum always-visible action/handle; place Edit, Export, organization actions, and Delete in a keyboard-operable menu with a separated danger section.
3. Make all responsive row/footer/menu targets at least 44×44 CSS pixels. Provide complete names through accessible text and focus/hover affordances while visible labels remain usefully truncated.
4. Strengthen nested branch/folder presentation with a visible disclosure indicator, indentation or connectors, semantic list/group structure, redundant selected/current cues, and clear empty-folder text. Preserve stable-ID Sortable and keyboard reorder helpers.
5. Add initials/name fallbacks for absent avatar imagery and visible rail overflow affordances: bottom padding, edge fade or persistent narrow scrollbar, and no partially clipped final item. Preserve full accessible names and generation/unread/warning priority.
6. Recheck writer and connected-reader adapters because they share `ConversationShell`, geometry, and presentation primitives. Do not introduce reader writes or change writer routing.

## Acceptance

- The two reviewed viewports show an obvious modal drawer, visible close action, reachable menu actions, and a clear continuation cue without horizontal clipping.
- Pointer, Tab, arrows, Home/End, Enter/Space, Escape, and focus restoration work through menus and disclosures.
- Delete cannot be activated accidentally beside reorder/edit and remains named and visually distinct.
- Full chat/avatar names are available on focus and hover; selected and nested state do not rely on color alone.
- Existing optimistic reorder, folder folding, route selection, generation badges, unread state, and reader isolation remain intact.

Use focused tests for `src/ts/gui/shellGeometry.ts`, `src/lib/ConversationShell.svelte`, `src/lib/SideBars/Sidebar.svelte`, `src/lib/SideBars/SideChatList.svelte`, `src/lib/SideBars/PinnedChatsRail.svelte`, and `src/lib/UI/PopupList.svelte`, followed by the compact browser cases.
