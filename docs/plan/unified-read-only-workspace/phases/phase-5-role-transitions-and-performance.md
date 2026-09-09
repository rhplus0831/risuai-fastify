# Phase 5: Role Transitions and Performance

## Outcome

Prove the unified path across promotion, demotion, reconnect, auth/lineage
changes, draft and generation lifecycles, then compare final startup/bundle/DOM
cost against the Phase 0 baseline.

## Preconditions

- Phases 0–4 are accepted and the complete unified UI remains behind the
  whole-path rollout boundary.
- All reader-visible surfaces have presentation and action-level containment.
- The Phase 0 environment, repetitions, thresholds, and artifact requirements
  are reproducible.

## Work

1. Exercise explicit reader promotion success, connected-writer confirmation,
   cancellation, denial, unavailable/interrupted transport, retained-work
   failure, retry, supersession, and ownership races.
2. Keep the outer workspace, reader route, valid projection, scroll/navigation
   state, and focus stable while promotion is pending. Remove the top-right
   action only after writer recovery and current authority are established.
3. Implement and verify the no-retroactive-last-interaction handoff. Preserve the
   current reader URL/display target without dispatching prior reader navigation
   as persisted selection; permit only a new writer-mode action to persist it.
4. Exercise writer loss before, during, and after mutation/generation work.
   Confirm synchronous draft capture, immediate authority revocation, stopped
   writer runtimes, closed restricted overlays, discarded optimistic appearance,
   and coherent reader refresh.
5. Exercise offline/online reconnect, server restart, replay-unavailable refresh,
   authentication loss/retry, database replacement, lineage change, direct
   routes, deleted/missing targets, and stale held responses/events.
6. Preserve live reader generation observation and exact terminal reconciliation
   through transfer. Reader navigation must not cancel, duplicate, claim, or
   persist writer generation effects.
7. Sample owned workspace/navigation/main-content rectangles on every animation
   frame across automatic role changes. Record layout-shift and long-task streams
   as supporting evidence and verify no mount-triggered shell movement.
8. Regenerate the Phase 0 small/large, cold/warm startup and bundle artifacts with
   the final unified cohort. Compare shell requests, payload/cache totals,
   readiness distributions, JavaScript transfer/decoded size, mount counts,
   long tasks, and transition evidence using the pre-ratified thresholds.
9. Inspect trace request UIDs for any regression, duplicate resource load, early
   mutation, or early generation. Do not weaken thresholds after observing the
   result; fix the implementation or formally replan.
10. Run the selected real-browser reader/writer journeys in isolated
    Fastify/SQLite fixtures and retain artifact/run identity in `status.md`.

## Acceptance

- Promotion, cancellation, failure, retry, supersession, writer loss, reconnect,
  auth loss, lineage replacement, and deleted/missing routes satisfy the plan's
  state and containment contracts.
- Reader route state is not replayed as `lastInteraction` or persisted selection
  without a new writer-mode action.
- Existing writer drafts and accepted/queued intent retain their originating
  scope; readers neither expose nor replay them.
- Live generation observation and transfer reconcile without duplicate messages,
  effect claims, cancellation, or reader mutation.
- Successful automatic writer and settled initial reader cases each perform one
  shell read. Explicit promotion retains its required post-replay read.
- Startup/bundle/mount/long-task results meet the thresholds frozen in Phase 0.
- Automatic role transitions retain stable owned shell geometry and produce no
  shell-reconstruction shift.
- Every measured case records zero mutation before writer-ready and zero
  generation before chat-ready.
- Required desktop/mobile, cold/warm, small/large, direct-route, and recovery
  browser cases pass on final source.

## Focused Verification

Run the affected lifecycle, startup, route, draft, outbox/replay, event,
replacement, reader-generation, component/DOM, layout-sampler, and telemetry
tests. Run `pnpm measure:fast-bootstrap` only when its full generated artifact is
required, plus the selected startup/recovery and connected-reader/writer
Playwright files. Run relevant type/build checks. Do not run `pnpm test:agent` or
`pnpm test:all`. Record all commands, attempts, artifact paths, and results in
`status.md`.

## Handoff

Phase 6 begins only with a complete final-source evidence set and no known
behavior or performance regression. Keep the old path available until cleanup
can remove it atomically with obsolete tests, flags, telemetry names, and docs.
