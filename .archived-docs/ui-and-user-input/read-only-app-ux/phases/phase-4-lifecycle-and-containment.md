# Phase 4 — Lifecycle and Action Containment

Depends on accepted [Phase 3](phase-3-transcript-and-passive-display.md). Read the
[plan](../PLAN.md) and [status](../status.md). Owners: LIFE-1 and all shared UI/data boundaries.

## Outcome

The integrated interface preserves reader guarantees through role changes,
recovery, connectivity loss, live generation, and deferred work. Earlier phases
already guard their own surfaces; this phase verifies cross-surface races.

## Bounded Slices

1. Integrate the shared view with existing promotion and writer-loss behavior.
   Preserve the latest valid reader route through confirmation/acquisition/recovery
   and cancellation/failure/races. Revoke actions synchronously on writer loss,
   capture drafts, stop writer work, and close restricted overlays before exposing
   the committed reader view. Keep mutation and generation readiness separate.
2. Exercise deferred event handlers, async imports, queued UI work, display parses,
   overlay restoration, and pending resource reads across demotion, auth loss, and
   database replacement. Prevent stale work from executing scripts, reopening
   Settings/plugins, mutating state, or replacing current confirmed display data.
3. Verify reconnect, replay gaps, target deletion, and live-generation reconciliation
   while navigating or changing role. Retain valid local reading position and
   ensure the reader cannot replay a former writer's queued domain intent.

## Acceptance

- Promotion success, cancellation, acquisition failure, and ownership races
  expose editing only after confirmed authority/recovery. Generation waits for
  its separate readiness condition, and the latest valid selection survives.
- Writer loss with active edits or queued work preserves retained drafts/intent
  while excluding unaccepted changes from the reader projection and preventing
  reader replay. Restricted overlays stay closed after reconnect.
- Auth loss clears protected content; database replacement and stale completion
  tests prove identity/lineage isolation. Current routes cannot be overwritten
  by old navigation or resource callbacks.
- Live send/regenerate, reconnect, and replay-gap scenarios reconcile to one
  persisted result. Reader navigation does not stop the writer's generation.
- Alternate activation paths produce no new domain writes/outbox entries and
  cannot execute the three excluded surfaces during any tested transition.

Use focused session/bootstrap/recovery, synchronization, stream, component, and
two-client browser evidence. Measure domain commands/outbox changes separately
from ordinary authenticated reads or operational traffic. Record failures and
repairs in status before accepting this phase.
