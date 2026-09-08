# Phase 0 — Contract and Inventory

Prerequisite: read the [plan](../PLAN.md), [status](../status.md), and
[inventory](../inventory.md). Creating this document does not satisfy this phase.

## Outcome

Make the shared-view boundary and every permitted/blocked entry concrete enough
to implement without moving writer ownership into reader presentation. Product
scope is fixed; resolve component interfaces and source dependencies from evidence.

Owners: UI-1, UI-2, DATA-1, UI-3, LIFE-1 in the inventory.

## Bounded Slices

1. Complete the route/action matrix for Home, character grid, sidebar/chat lists,
   transcript, composer, Settings, plugin/custom-GUI panels, and script controls.
   Include shortcuts, context menus, drag/drop, route warming, restored overlays,
   effects, and deferred callbacks. Mark each allowed-local or blocked action
   and its existing writer behavior. Cross-check broad source exploration with
   the project's read-only parallel research workflow.
2. Specify explicit shared-view data/selection/capability/callback interfaces and
   the two adapters. Identify the smallest extraction from the writer sidebar
   and chat chrome. Name owners for reader URL selection, local folder expansion,
   draft preservation, and render readiness. Map required folder, order, pin,
   and visual fields to confirmed resources and invalidation dependencies.
3. Define focused behavioral regressions and the first two-client browser slice.
   Select any temporary presentation-switch location and default without changing
   reader authority. Record dependencies, implementation decisions, and the next
   bounded slice in status; add a separate matrix artifact only if needed.

## Acceptance

- Every discovered entry has a reader policy, owner, and verification target;
  restricted direct routes are denied before authoring load/mount.
- Settings, plugin panels, and interactive scripts have no deferred compatibility
  milestone. Passive display transforms are distinguished from interactive execution.
- Shared presentation cannot fall back to writer stores or commands. The reader
  field map preserves confirmed-data isolation, lazy hydration, and session fences.
- Writer promotion/demotion, drafts, and live-generation owners are explicitly
  retained. The initial implementation slice and its proof are bounded.

Validate documentation and links. Run existing focused tests only to resolve a
specific uncertain behavior; a plan does not require the runtime aggregate.
