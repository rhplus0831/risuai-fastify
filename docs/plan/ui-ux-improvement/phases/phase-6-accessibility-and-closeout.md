# Phase 6 — Accessibility, Visual Evidence, and Closeout

Depends on accepted Phases [2](phase-2-destructive-safety-and-persistence.md), [3](phase-3-compact-navigation-and-actions.md), [4](phase-4-outcome-language-and-authoring.md), and [5](phase-5-guided-bardwiki-workspace.md). Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

The integrated improvements have measured accessibility and browser evidence, current documentation describes shipped behavior, and the planning package can be archived.

## Bounded Slices

1. Extend theme checks beyond primary text/background pairs to the reviewed muted text, control borders, focus indicators, selected state, disabled state, destructive state, and scrim combinations. Repair shared tokens only when a failing relationship is confirmed; preserve custom themes or supply a safe fallback/warning.
2. Run keyboard-only journeys across navigation drawer, rail overflow, chat/folder disclosure, action menus, Agent/Preset create/edit/delete/reorder, Hook edit/delete/retry, and BardWiki create/import/rebuild/activity. Verify logical order, visible focus, full names, state announcements, Escape ownership, and focus restoration.
3. Verify modal isolation for responsive navigation and all three reviewed drawers/workspaces: one top modal, inert/hidden background branches, nested-modal stacking, body scroll lock, no background hotkeys, and restoration after accept/cancel/failure.
4. Exercise 550×775, 655×691, desktop, reduced motion, long English/localized labels, and 200% browser reflow. Check for horizontal scrolling, clipped last items, nested scroll traps, hidden footer actions, overlapping menus, and loss of the mobile BardWiki return path.
5. Run the dedicated real-Chromium review journey against disposable agent data. Capture before/after screenshots and interaction assertions for the seven reviewed surfaces; record the exact source revision, viewport, command, artifact paths, and any browser-emulation limitation in [status](../status.md).
6. Self-review every report finding against the current UI. Close it as implemented, intentionally preserved, reference-only/retired, or evidence-backed follow-up. No high-impact finding may remain merely “not visible in a screenshot.”
7. Update `src/docs/svelte-navigation-ui.md`, `src/docs/svelte-settings-ui.md`, `src/docs/svelte-ui.md`, applicable structure/test guides, and `docs/UI-UX-GUIDELINE.md` only where shipped contracts changed. Run final validation, accept the phase, archive this package, and update indexes.

## Acceptance and Evidence

- All reviewed interactive controls have complete accessible names, at least 44×44 touch targets where compact/touch-oriented, visible focus, semantic state, and non-color-only status.
- Contrast relationships pass the agreed WCAG thresholds or have a documented, product-approved exception with an alternative cue.
- Browser evidence proves actual focus, inertness, menu/disclosure behavior, responsive geometry, reflow, save outcomes, deletion consequences, and recovery; screenshots supplement but do not replace interaction assertions.
- Focused tests pass on final source. `pnpm test:agent` passes once after implementation/self-review because multiple shared owners changed. The dedicated browser journey also passes explicitly.
- Current documentation, Prettier, and `git diff --check` pass. The status ledger contains all commands, results, limitations, and the final source revision.
- The accepted plan is moved to `.archived-docs/ui-and-user-input/`; `docs/plan/README.md` no longer lists it as active, and the appropriate archive indexes link to it.

Do not run `pnpm test:all` unless requested. Local browser evidence does not claim validation of the external production deployment.
