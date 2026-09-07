# Phase 5: Verification and Rollout

Dependency: Phases 0–4 accepted. Progress belongs in [status](../status.md).

## Outcome

Accept the combined behavior at a recorded source, apply the agreed rollout
default after required verification, and update the architecture guides. Earlier
phase evidence must still apply to the candidate implementation.

## Combined Acceptance Matrix

| Journey                 | Required proof                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh/returning startup | First-run initialization remains safe; a still-owning session recovers; a foreign-owner client opens read-only without stealing or repeated dialogs.        |
| Multiple readers        | One writer and at least two reader sessions receive committed changes; each reader keeps independent local navigation and issues no forbidden mutations.    |
| Explicit switching      | A → B → A and competing requests converge to server authority; the old writer keeps reading; only explicit user action requests takeover.                   |
| Pending work            | Unsent draft, staged intent, request in flight, accepted response loss, receipt cleanup, and replay failure preserve correct recovery and newer edits.      |
| Generation              | Partial output and persisted results converge; viewer loss does not cancel; switching does not duplicate control, finalization, or effects.                 |
| Connectivity/lifecycle  | SSE loss, heartbeat timeout, replay unavailable, server restart, focus/pageshow, and mobile-sized resume recover without takeover loops or leaked runtimes. |
| Replacement/security    | Authentication loss clears protected projections; lineage replacement rejects stale work; stale sessions remain unable to write through direct API calls.   |
| Reader UI               | Sidebar/direct-link/history navigation, history loading, copy, scroll anchors, keyboard focus, accessible status, and blocked authoring affordances work.   |
| Rollout compatibility   | Default and enabled builds behave as documented; mixed old/new sessions retain ownership protection; disabling the new feature has a defined recovery path. |

## Execution and Evidence

Include memory/BardWiki operational snapshots and live progress in the matrix:
supported reader displays converge after reconnect; gated controls and event
callbacks issue no rebuild/retry/cancel writes. Validate their stream/version
ordering separately from domain command revisions.

- Reconcile the boundary inventory against final source. Every required surface
  must have an implemented disposition and proof; deferred follow-up features
  cannot conceal incomplete reader behavior.
- Run focused tests for any newly changed boundary and the exact browser specs
  covering the matrix through `pnpm test -- <one-test-or-source-file>`.
  Assertions must observe actual rendered and persisted outcomes. Record which
  browser conditions are simulated and which mobile/browser variants were
  exercised; desktop viewport size alone is not real-device lifecycle evidence.
- Once implementation is complete, run `pnpm test:agent` and record its source
  and results. It builds smoke assets but does not execute Playwright. At the
  end of Phase 5, run `pnpm test:all` without additional user consent before
  acceptance, following the [per-phase policy](../PLAN.md#verification-and-completion).
  Record its final-source results, including full-browser and current
  compatibility evidence. Unexecuted required checks remain explicitly pending.
- Check bounded reader work: subscriptions, generation viewers, hydrated
  resources, and retry timers should track active reader needs and be released
  on teardown. Use deterministic counts and existing fixtures; investigate
  measured regressions without creating an unrelated performance workstream.

## Rollout, Documentation, and Closeout

- Apply the user-confirmed policy: keep the public feature disabled during
  implementation, then enable connected readers by default after all required
  feature evidence passes. Verify the resulting default and a documented
  fallback to the conservative writer flow without deleting drafts or pending
  intent; run the phase-ending `pnpm test:all` at that final configuration before
  acceptance. Record the flag's final disposition. Do not accumulate overlapping
  permanent observer flags or unowned old paths.
- Exercise the plan's mixed-version policy with a retained conservative client
  path or a legacy-handshake fixture, recording which was used. Old clients may
  still prompt/freeze and initiate their existing acquisition flow; verify new
  readers tolerate those writer changes and stale writes from either version
  remain rejected. Do not claim the new UX works in unchanged old bundles.
- Remove or retire obsolete offline-takeover UI, styles, and tests only when
  the new behavior owns their protection. Keep real network-interruption and
  auth-loss handling. Localization must cover the final statuses and action.
- Update `docs/structure/data-and-events.md`,
  `docs/structure/durable-mutations-and-recovery.md`,
  `docs/structure/server-resources-and-bridges.md`, relevant `src/docs` guides,
  and the affected `docs/tests` guides to match shipped behavior. Update
  `STRUCTURE.md` only if its navigation or invariant summary changes.
- Validate current docs and this plan explicitly, format changed files, and
  record residual limitations with an owner/revisit condition. Mark the
  workstream complete only when the in-scope contracts and required evidence
  are accepted. Archive it according to the plan's closeout policy.

## Exit Criteria

The product contract works across the combined matrix, the inventory has no
unresolved in-scope surface, all required evidence is tied to the final source,
rollout/fallback behavior is explicit, and current guides describe the actual
reader/writer lifecycle. Named-device discovery and draft transfer remain
clearly separate follow-up scope.
