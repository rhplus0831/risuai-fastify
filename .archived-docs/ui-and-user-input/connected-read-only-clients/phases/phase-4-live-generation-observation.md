# Phase 4: Live Generation Observation

Dependency: Phase 3 accepted. Progress belongs in [status](../status.md).

## Outcome and Owners

Connected readers can watch live output for the conversation they select.
Generation control, finalization retries, and writer-owned effects remain
restricted to the current writer. A role switch does not cancel a durable job
or duplicate its persisted result or effects.

Primary inventory owners: B09–B12. Read
[generation client](../../../../src/docs/generation-client.md) and
[streaming contracts](../../../../docs/structure/data-and-events.md#sse-and-streaming).

## Bounded Slices

### 4a. Observer-only job lifecycle

- Separate read-only bootstrap/status projection and stream attachment from
  generation submission and writer recovery. Current reattach calls into the
  send pipeline; audit that path before reusing it for permanent readers.
- Identify the exact durable operation, current attempt, and job under the
  database lineage. Ignore superseded projections and delayed frames from an
  older attempt, chat, role lifecycle, or database.
- Handle incomplete job projections and a missing stream descriptor explicitly.
  If attachment cannot begin, retain/restore observation eligibility or perform
  a bounded authoritative refresh; never consume the presented job and leave
  recovery permanently waiting. Verify the current branch before treating it
  as a reproduced defect.
- Attach only the selected eligible chat and keep retry/status work bounded.
  Switching away, closing a reader, or losing visibility detaches or suspends
  observation according to existing browser policy; it never sends cancellation.
- Reconcile terminal output against server-persisted transcript identity.
  Buffered replay, reconnect, and a terminal event racing with command SSE
  must not append duplicate messages or leave permanent busy state.

### 4b. Effects, translations, and role transitions

- Observers cannot submit/cancel/retry generation, retry persistence, claim/settle
  writer-owned effects, or run mutation-bearing completion callbacks. Keep
  server guard checks and lease/receipt idempotency even when UI is disabled.
- Separate display processing and translation/job observation from actions that
  start provider work, change script state, write plugin storage, or generate
  assets. Existing results remain visible; starting new work follows the reader
  action policy recorded in Phase 0.
- Preserve supported display behavior through the observer-safe runtime set.
  Do not enable the entire plugin/generation runtime merely to render output.
- On writer demotion, stop authority-bearing work and retain/restart only safe
  viewing. On promotion, reconcile current server operation/effect authority
  before resuming writer responsibilities. Late ephemeral completion actions
  must retain the existing skip/ownership policy.

## Exit Criteria and Proof

- A reader sees partial output and the final persisted result while another
  session owns the writer. Reader network observations contain no forbidden
  control/effect calls, and server effect/receipt state remains correct.
- A → B switching during streaming, cancellation, or finalization preserves
  the intended server outcome with no duplicated message or durable effect.
- Stream EOF, missed acceptance frame, terminal-state race, chat switching,
  reconnect, and database replacement recover to the current transcript/attempt.
- Missing stream metadata and a projection replaced during attachment recover
  without a stranded job, repeated submission, or indefinite busy state.
- Closing the reader leaves the job running. Repeated attachment and role
  changes do not accumulate viewers, timers, retries, or completion actions.

Extend reattach/generation-operation/effect tests and server durable-generation
tests selected from the inventory and test guide. Use deterministic streamed
provider fixtures in a real multi-session browser journey to prove visible
partial output and final convergence. No paid or production provider is needed.
