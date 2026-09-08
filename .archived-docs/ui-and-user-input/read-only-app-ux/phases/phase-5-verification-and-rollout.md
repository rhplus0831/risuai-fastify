# Phase 5 — Verification and Rollout

Depends on accepted [Phase 4](phase-4-lifecycle-and-containment.md). Read the
[plan](../PLAN.md) and [status](../status.md). Owners: all inventory boundaries
and current architecture/test documentation.

## Outcome

Shared presentation becomes the normal connected-reader experience with recorded
desktop/mobile and lifecycle evidence, and duplicated dedicated layout is removed.

## Bounded Slices

1. Run the combined two-client journey against the actual shared view using
   disposable agent data and controlled generation fixtures. Cover desktop and
   mobile viewport/navigation, keyboard/focus, themes/backgrounds, list search and
   folders/pins, independent deep links/back-forward, history/copy, and streamed
   replies. Exercise blocked Settings/plugin/script entries through visible and
   alternate paths, plus takeover, demotion with drafts, reconnect/replay gaps,
   deletion, auth loss, and lineage replacement.
2. Review the resulting writer/reader ownership and action inventory. Make shared
   presentation the default after focused acceptance, remove the obsolete dedicated
   shell layout and temporary presentation-switch branches, and preserve reader
   controllers/synchronization/lifecycle tests. Recheck changed integration points.
   Update current shell/navigation/chat/runtime and test guides for shipped behavior.
3. After implementation and self-review are complete, run required final validation,
   resolve failures, and record final-source evidence. Archive the accepted planning
   package and update plan/archive indexes after all completion criteria are met.

## Acceptance and Evidence

- Actual two-client desktop/mobile runs prove familiar browsing, independent
  selection, passive display, live observation, and role transitions. Record exact
  browser commands, viewports, source revision, and meaningful limitations in status.
- Reader browsing and blocked activation create no domain writes or new outbox
  entries; reader operation does not alter writer selection. Confirm this with
  network/command and outbox assertions, not screenshots alone.
- Settings and plugin UI never mount for readers; interactive script callbacks
  never execute, including locally acting scripts and stale async continuations.
- The writer retains working navigation, composition, generation, and authorized
  Settings/plugin/script entry after readiness. Draft/recovery behavior survives
  writer loss and subsequent promotion.
- The reader-authority rollout remains independent of presentation. No temporary
  path exposes writer runtime to readers, and duplicate dedicated layout is gone.
- Focused tests and actual browser journeys pass on final implementation source.
  `pnpm test:agent` passes after implementation/self-review because shared routing,
  ownership, and lifecycle behavior span multiple areas. Its smoke build does not
  replace executing the browser journeys.
- Current docs and the explicit planning/archive index check, Prettier, and
  whitespace checks pass. All phase acceptance and residual limits are recorded
  in status before archival. Do not run `pnpm test:all` unless requested.

Local browser proof does not establish behavior on the external production
deployment. Record that limitation honestly; deployment is not a prerequisite
for completing this repository implementation plan.
