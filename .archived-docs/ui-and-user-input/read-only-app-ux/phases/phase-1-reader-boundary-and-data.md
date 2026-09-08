# Phase 1 — Reader Boundary and Navigation Data

Depends on accepted [Phase 0](phase-0-contract-and-inventory.md). Read the
[plan](../PLAN.md) and [status](../status.md). Owners: UI-1, DATA-1, LIFE-1.

## Outcome

Establish the route/action policy and confirmed navigation inputs before shared
surfaces become reachable. Preserve the dedicated reader as a usable fallback.

## Bounded Slices

1. Derive reader UI capabilities from session and startup readiness. Deny Settings,
   plugin-panel, and interactive-script entries at their handlers and route/overlay
   boundaries. Remove Settings from the reader hotkey allowance. Add the localized
   direct-route gate and deny authoring warming/mounting. Apply these restrictions
   to the current reader fallback as well as the future shared view.
2. Add a committed navigation projection containing required ordering, folders,
   pins, labels, and audited display metadata from existing shell/detail resources.
   Preserve narrow allowlists, invalidation dependencies, revision/lineage fences,
   and lazy loading. If a payload gap exists, resolve it at its canonical schema
   and producer/consumer owners with focused contract coverage.
3. Establish the reader navigation adapter using stable local character/chat IDs
   and explicit callbacks. Handle valid deep links, back/forward, missing/deleted
   targets, and blocked routes without invoking writer selection or persisting
   folder expansion. Keep local state scoped to session/database identity.

## Acceptance

- Reader buttons, shortcuts, direct URLs, restored overlays, and late callbacks
  cannot enter Settings, plugin panels, or interactive execution. Direct rejection
  does not load authoring resources, trigger takeover, or corrupt reading selection.
- Projection tests prove that pending writer edits cannot appear as reader data,
  stale reads cannot win after role/lineage changes, and confirmed metadata updates
  invalidate the appropriate view.
- Navigation and local folder state produce no domain commands or outbox entries
  and leave the writer selection unchanged. The current reader still boots and browses.
- Writer routes and capabilities retain their existing authorized behavior.

Use focused route, hotkey, projection, session, and local-mutation suites from the
[inventory](../inventory.md). Verify denied entry behavior, not just disabled styling.
Record exact checks and remaining surface work in status.
