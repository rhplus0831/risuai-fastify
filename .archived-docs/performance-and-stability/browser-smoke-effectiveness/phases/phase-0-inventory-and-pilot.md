# Phase 0: Inventory and Pilot

Dependency: current source confirmation. Progress belongs in
[status](../status.md).

## Outcome

Establish the real review universe and prove that the review method can
distinguish a useful controlled input from setup that skips a failing behavior.
Calibrate the remaining work before beginning broad remediation.

## Work

1. Record the source anchor, worktree state, Node/pnpm/browser versions, smoke
   configuration, and available disposable-test prerequisites. Reconcile the
   [inventory](../inventory.md) with current discovery. List mode does not execute
   tests; its expected-status fields do not mean tests passed.
2. Expand file rows into full test titles and meaningful subjourneys. Capture
   conditional skips, opt-in transcript workload expansion, route-manifest loops,
   desktop/mobile parameters, and shared fixtures. Do not multiply counts for
   repeated assertions that protect the same scenario.
3. Map smoke-hook and helper consumers. For each control identify whether the
   caller uses it as a precondition, observation, external fault, or the action
   being verified. Inventory smoke-build differences and shared mutable state.
4. Run three pilot reviews and bounded fault experiments from the table below.
   Record narrow known-good baselines before faults. Follow the plan's disposable
   checkout and unchanged-test rules; do not rely on historical commit messages
   as execution evidence.
5. Compare actual pilot effort, scenario complexity, and execution costs with
   the initial estimate. Assign bounded slices and dependencies to the remaining
   phases. Keep incomplete scenario/file reviews visibly partial.

## Pilot Selection

| Pilot                          | Starting evidence                                                                                                     | Required distinction                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmation queue calibration | `src/ts/characterCards.realmImport.test.ts`, `src/ts/alert.ts`, historical fix `ac5a1cec1`                            | Immediate successful confirmation skips queue admission. The current queue test must detect the restored faulty transition; this is component evidence, not a browser import journey. |
| Transcript input/remount       | `server/fastify/browser-smoke/chatHistoryScroll.spec.ts`, the relevant residency scenario, historical fix `82f888cad` | Actual input overlaps queued parsing/paging and observes real content/geometry. Directly assigning scroll position does not establish the same contract.                              |
| Accepted send/recovery         | One relevant case in `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts` or `visibleStateRecovery.spec.ts`    | Real application handling of a held/lost response plus visible/durable consequences; choose the exact case and justified production fault before editing.                             |

The first two are already repaired incidents used to calibrate the audit. Do not
reopen them as defects unless current evidence establishes one. The third pilot
must be selected from current source rather than an assumed historical gap.

## Execution and Exit

Use Playwright list mode for discovery and the focused runner for execution:

```sh
pnpm exec playwright test --config playwright.fastify-smoke.config.ts --list
pnpm test -- src/ts/characterCards.realmImport.test.ts
pnpm test -- server/fastify/browser-smoke/chatHistoryScroll.spec.ts
```

Select the recovery pilot through its exact spec path as well. Do not run the
full suite just to obtain an opening green count. At the end of Phase 0, run
`pnpm test:all` without additional user consent before accepting the phase, as
required by the [plan](../PLAN.md#validation-and-completion).

Exit requires a complete discovery/control map, three documented pilot reviews
with relevant fault-detection evidence, explicit evidence limits, confirmed
findings where warranted, and a revised slice/effort estimate. Planning counts
and the prior 20-test Realm pass alone do not satisfy this phase.
