# Phase 2: Critical Journeys

Dependency: the Phase 1 controls needed by the selected slice are accepted.
Progress belongs in [status](../status.md). Execute the four slices separately.

## Outcome

Four critical contracts have faithful trigger-to-outcome evidence and a
demonstration that a named behavior-changing fault is detected. Locate current
coverage first; missing journeys become findings, not assumed existing bugs.

## 2a. Blocking Confirmation

Starting owners: the alert scenarios in
`server/fastify/browser-smoke/fastifyBrowserSmoke.spec.ts`, their production
dialog/operation callers, and the Realm queue companion reviewed in Phase 0.

- Distinguish showing an alert directly to test its presentation from proving
  an import/operation can reach confirmation while progress is active.
- For the operation being claimed, drive its real entry path, observe that the
  confirmation becomes visible/actionable, and answer through the visible control.
- Check acceptance and rejection, pending-operation behavior, and a stale result
  when a newer operation owns the UI. Keep network data deterministic without
  replacing the confirmation queue or giving the test a result in advance.
- Reuse the real-queue component test for exact ownership details. If no browser
  owner covers the critical progress-to-confirmation journey, add one bounded
  journey and document how it connects to the narrower companion.

Acceptance: the browser journey can detect loss of the required presentation
transition, and the operation's continuation/cancellation matches the answer.

## 2b. Transcript During Input and Rendering

Starting owners: `server/fastify/browser-smoke/chatHistoryScroll.spec.ts`,
`transcriptResidency.spec.ts`, `chatStartupRendering.spec.ts`, and relevant
layout cases in `fastifyBrowserSmoke.spec.ts`.

- Exercise real input while page loading and body parsing/rendering overlap.
  Include remounts, reversals/pauses, and meaningful differences between pending
  and committed row heights where the contract requires them.
- Observe actual message content, stable row identity, visible position, and
  transient pending state. Establish nonempty/relevant samples before asserting
  that all samples satisfy the contract.
- Preserve current resident-row/interaction limits and supported desktop/mobile
  behavior. Chromium viewport/touch simulations do not certify real devices.
- Keep geometry unit tests for calculation coverage; do not substitute their
  injected measurements for the browser lifecycle being claimed.

Acceptance: a justified remount/registration/height-release fault fails a
relevant browser assertion. Restored behavior passes under the same workload;
the existing known regression need not be replaced if its evidence is adequate.

## 2c. Send, Stream, and Durable Reload

Starting owners: `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`,
`debugEchoLayoutStability.spec.ts`, `rerollSwipePersistence.spec.ts`, and the
generation portions of `fastifyBrowserSmoke.spec.ts`.

- Map the normal composer submission through actual request dispatch,
  incremental visible output, accepted completion, and a full reload that reads
  persisted content. A page-side direct generation fetch proves a different
  entry path; do not count it as composer submission.
- Control the external provider boundary to hold/release output deterministically.
  Keep generation state, event serialization, resource application, and storage
  behavior real where their integration is the claim.
- Check pending and completed UI plus durable content/identity. Verify the
  claimed cancellation/retry/reroll cases preserve the correct message and do not
  duplicate work; use companion API tests for exhaustive protocol permutations.

Acceptance: at least one appropriate persistence/finalization/rendering fault
breaks this complete journey at its expected assertion. Record separately which
abort, reroll, and transport variations the existing owners cover.

## 2d. Stale Responses and Recovery

Starting owners: `server/fastify/browser-smoke/visibleStateRecovery.spec.ts`,
`startupRecoveryIntegrationMatrix.spec.ts`, and recovery cases in
`acceptedSendProtocol.spec.ts`.

- Use real requests/outbox dispatch and controlled response loss or reordering.
  Follow the actual writer/lineage/revision handling; directly setting a recovered
  store value cannot prove recovery.
- Cover the critical claimed pending-to-settled/reload transition and inspect
  visible state together with durable identity, exactly-once effects, or stale
  update rejection as appropriate.
- Trace cross-tab takeover, imported lineage changes, and replay to existing
  scenarios. Preserve unsupported deep crash/quota/device conditions as explicit
  limits unless an in-scope failure needs a bounded supported control.

Acceptance: a meaningful stale-result/ownership/reconciliation fault fails the
named browser assertion. Restored behavior preserves newer intent and unrelated
data without false success or duplicate application.

## Phase Exit

Each contract has reviewed scenario records, explicit limits, relevant
fault-detection evidence, and passing restored focused browser results. Material
new tests or repairs each meet the plan's evidence rule. No open high-risk gap
in these four contracts can be closed by a source-only review, unrelated lower
layer pass, or the agent smoke build. Reconcile case ownership with Phase 3 so
partially reviewed large specs remain partial.
