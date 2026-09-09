# Phase 2: Role-First Bootstrap

## Outcome

Resolve the initial client role before mounting a workspace. Successful
automatic writers skip the early reader projection and perform one authoritative
post-replay shell read; settled readers still receive one coherent read
projection.

## Preconditions

- Phases 0 and 1 are accepted.
- The rollout path can select the complete current or complete role-first flow.
- Baseline request/timing/mount evidence and comparison thresholds are recorded.

## Work

1. Reorder connected startup so identity and read-only ownership discovery occur
   before reader projection application.
2. For an eligible exclusive/unowned or same-owner page, attempt conditional
   writer acquisition using the discovered epoch and database lineage before
   loading reader application data.
3. On successful acquisition, retain the existing recovery order and read only
   the authoritative post-replay shell before accepted event subscription and
   writer readiness.
4. For a foreign owner, lost acquisition race, explicit denial, or safe recovery
   fallback, settle an authenticated reader disposition and then install one
   coherent reader shell, locale, revision cursor, and synchronization stream.
5. Define the initial writer-recovery failure path when the server may still
   identify this session as writer. Do not expose reader content until a coherent
   readable disposition is explicitly established; do not silently abandon
   retained writer work or ownership.
6. Preserve authentication-required and empty-server setup flows, fatal retry
   behavior, superseded operation cancellation, browser page lifecycle, and
   conservative fallback until its planned retirement.
7. Publish reader/workspace readiness at the new semantic boundary. Retain
   telemetry compatibility or version the browser/server schema atomically if
   Phase 0 requires a new cohort field.
8. Assert request order/count, resource revisions, command/event cursors, and no
   pre-readiness mutation/generation for writer, reader, conflict, initialization,
   failure, and retry cases.
9. Keep the old ObserverShell presentation available behind the whole-path
   rollback branch; no partial new navigation/composer UI is exposed yet.

## Acceptance

- A successful automatic writer issues one shell read and never mounts or marks
  an established reader workspace.
- A settled initial reader issues one coherent shell read and cannot mutate or
  generate.
- A lost acquisition race refreshes ownership and settles correctly without
  takeover, mixed revisions, or duplicate subscriptions.
- Writer recovery failure either remains an honest loading/recovery state or
  establishes a coherent reader through the documented safe path; it never
  exposes stale/optimistic writer data as reader truth.
- Outbox preparation, receipt acknowledgement, pending replay, post-replay
  projection, cursors, event subscription, and readiness preserve their existing
  order.
- Authentication, setup, cancellation, retry, page lifecycle, and lineage tests
  remain green.
- Phase 0 performance thresholds and hard early-operation counters pass for the
  role-first cohort.

## Focused Verification

Run affected connected-startup, bootstrap, readiness, session, shell-resource,
event, outbox/replay, and startup-telemetry tests. Run the startup cache/request
measurement and only the browser startup/recovery journeys required by the
Phase 0 matrix. Use relevant protocol/server typechecks if telemetry contracts
change. Record exact artifact identities and results in `status.md`.

## Handoff

Phase 3 begins only when the role-first flow is behaviorally complete behind its
rollout boundary. Do not remove current ObserverShell files or smoke controls
until the unified UI and rollback evidence exist.
