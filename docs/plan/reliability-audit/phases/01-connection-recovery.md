# Phase 01 — Connection Recovery and Writer Promotion

State: **Not started.** Read [the plan](../PLAN.md) and [status](../status.md).
The source/test inventory below was inspected for planning on 2026-09-12; runtime
acceptance remains unverified.

## Scope and Entry Paths

Finish writer reconnect first, then reader-to-writer promotion, using the same
retirement and readiness criteria. Map cold startup, foreground/pageshow,
offline/online, stream close/watchdog, explicit promotion, failed acquisition,
confirmed writer loss, and database-lineage replacement. Exercise startup and
replacement where they share the recovery contract; wider cache/navigation work
belongs to [04](04-resource-hydration.md).

R2's immediate retirement/replacement guarantee applies to foreground recovery
leases: reader refresh, writer resume, writer probe, and explicit promotion.
Cold startup shares `loadDataInFlight` and currently does not pass a caller
cancellation signal through its ownership/bootstrap chain. Its distinct R8
contract is bounded control requests, generation/currentness rejection, and no
late authorization. Immediate cold-start replacement would require a separate
behavior/design decision; this plan does not assume it is an existing guarantee.

Primary guides: [client startup](../../../../src/docs/client-runtime.md),
[durable recovery](../../../structure/durable-mutations-and-recovery.md), and
[browser recovery tests](../../../tests/browser-state-sync-and-recovery.md).

<!-- prettier-ignore -->
| Boundary | Source owners | Existing test starting points |
| --- | --- | --- |
| Startup, recovery lease, promotion, writer-startup transfer | `src/ts/bootstrap.ts`: `beginConnectedRecoveryLease`, `retireConnectedRecoveryLease`, `promoteConnectedReader`; `src/ts/connectedClientStartup.ts` | `src/ts/bootstrap.test.ts`, `src/ts/connectedClientStartup.test.ts` |
| Session and capability publication | `src/ts/clientSession.ts`, `src/ts/startupReadiness.ts`, `src/ts/server/activeWriterSession.ts` | `src/ts/clientSession.test.ts`, `src/ts/startupReadiness.test.ts`, `src/ts/server/activeWriterSession.test.ts` |
| Ownership/bootstrap control requests and stream admission | `src/ts/server/bootstrap.ts`, `src/ts/server/events.ts` | `src/ts/server/bootstrap.svelte-node.test.ts`, `src/ts/server/events.test.ts` |
| Reader synchronization, applied cursor, watchdog | `src/ts/server/connectedReaderSync.ts` | `src/ts/server/connectedReaderSync.test.ts` |
| Draft capture before demotion and scoped restoration | `src/ts/server/writerDraftRecovery.ts`, `src/ts/server/draftRecoveryScope.ts` | `src/ts/server/writerDraftRecovery.test.ts` |
| Session/readiness to presentation and route authority | `src/ts/workspaceAccess.ts`: `getWorkspaceAccessSnapshot`; `src/App.svelte` | `src/ts/workspaceAccess.test.ts`, `src/App.routeEffect.dom.test.ts` |
| Rendered connection/takeover outcome | `src/lib/Workspace.svelte`, `src/lib/DeviceAccessAction.svelte`, `src/lib/ChatScreens/DefaultChatScreen.svelte` | `server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts`, `server/fastify/browser-smoke/connectedWriterSwitching.spec.ts`, `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`; `src/lib/Workspace.svelte.test.ts`, `src/lib/DeviceAccessAction.svelte.test.ts` |

Trace actual hydration, outbox preparation/replay, generation reattachment,
language loading, and runtime teardown invoked by the coordinator. They are
part of the awaited chain even when a helper's own HTTP call is bounded. Inspect
the Fastify bootstrap/ownership/event route owners reached by the browser
harness before asserting acquisition or writer-header semantics: start with
`server/fastify/src/routes/bootstrap.ts`, `server/fastify/src/routes/events.ts`,
`server/fastify/src/activeWriter.ts`, and `server/fastify/src/databaseLineage.ts`.
Their focused checks include `server/fastify/__tests__/bootstrap.test.ts`,
`server/fastify/__tests__/events.test.ts`, and
`server/fastify/__tests__/activeWriter.test.ts`.

## Starting Evidence and Limits

Source already assigns recovery leases and checks generation/currentness before
publication. Coordinator tests cover promotion sequencing, supersession during
prepare/receipt/replay/hydration/events, hidden promotion cancellation, and
replacement while retired startup remains pending. Preserve those cases.

`src/ts/bootstrap.test.ts` mocks bootstrap, reader synchronization, resources,
events, outbox, and runtime helpers. Its ordering assertions need a boundary
inventory to establish which real interactions remain unproven.
`src/ts/server/events.test.ts` already includes stalled connection and stalled
409-body cases; these are candidates for reuse through composition, not an
instruction to duplicate them.

The three journeys in `mobileWriterConnectionRecovery.spec.ts` begin as a
writer: stream closure, temporary offline state, and hidden recovery replaced
before the old bootstrap settles. They assert retained composer/draft, restored
capability, stable navigation, and request/reload behavior. Inspect
`connectedWriterSwitching.spec.ts` alongside them for promotion coverage; the
mobile recovery file alone does not establish a complete reader-promotion A/B
schedule. Chromium device emulation does not prove physical suspension.

## Required Acceptance Matrix

<!-- prettier-ignore -->
| ID | Schedule / contract | Observable acceptance |
| --- | --- | --- |
| R1 | Interrupt an existing writer through stream close and offline/foreground; separately promote a connected reader. | Valid route/content and recoverable draft survive. UI mutation/generation controls follow their actual authority/readiness gates and become usable after successful recovery. A subsequent real edit reaches the server. |
| R2 | For reader refresh, writer resume/probe, or explicit promotion, hold A at ownership/bootstrap, reader setup, hydration, or writer stream setup; retire A; finish B; release A with success and failure. | A's caller settles without waiting for the held boundary. B completes while A is pending. A cannot change B's session, resources, route, drafts, readiness, streams, or error state; old cleanup cannot retire B. |
| R3 | Inject network timeout/malformed ownership separately from confirmed foreign ownership/stale-writer evidence. | Uncertainty remains recoverable and does not invent writer loss or acquisition. Confirmed loss revokes UI write authority, preserves scoped drafts, and follows the existing explicit takeover flow. |
| R4 | Stall fetch, response JSON (including 409), or stream admission; let the boundary ignore abort. | The public operation reaches its contract's cancellation/deadline outcome. Late responses cannot publish; cleanup requests cancellation without making replacement depend on cooperative transport cleanup. |
| R5 | Fail or supersede preparation, receipt cleanup, replay, hydration, or event setup during promotion. | No premature usable writer UI. Reader/retry behavior remains available where supported. The current attempt owns retry and eventual readiness; old attempts cannot publish success. |
| R6 | Capture a draft, lose authority, capture a newer valid draft, then finish an older persist/discard. | Newer draft remains recoverable; old writer/lineage drafts do not appear in a different scope. Restoration is established through visible text, with storage assertions for persistence claims. |
| R7 | Settle recovery; trigger ordinary focus; retire/stop an attempt and advance relevant timer windows. | Healthy focus avoids unnecessary bootstrap/hydration, permitted heartbeat traffic is distinguished, and retired reconnect/watchdog callbacks cannot restart or disturb active work. |
| R8 | Cold startup holds discovery/acquisition while its session generation changes or setup is abandoned; control request stalls or later succeeds. | Concurrent `loadData()` callers share the current attempt. Control requests obey their deadline; late responses cannot initialize, replay, publish writer readiness, or authorize the superseded session. Immediate replacement before that boundary settles is not required. |

R2/R4 use the timeout and lifecycle contracts defined by the current owners.
Record the deadline/clock being tested; avoid arbitrary wall-clock sleeps.
Cover representative pause points with real cooperating modules, using the
existing isolated helper tests for the remaining equivalent boundaries. Explain
that equivalence in the coverage matrix. Required distinct entry paths cannot
be dropped merely because writer reconnect passes.

## Execution Steps

1. Record the current revision and map each entry path to R1–R8, actual source
   owners, named tests, and mocked boundaries. Inspect both coordinator and
   transport tests. Run the smallest relevant baseline plus the existing writer
   reconnect and writer-switching journeys; record any pre-existing failures.
2. For the missing R2 interaction, retain the actual coordinator, session,
   reader sync, control transport, hydration, and event admission wherever they
   participate. Inject delays at external boundaries. Prove B completes before
   releasing A, then assert late success/failure/cleanup cannot damage B.
   Extend an existing composition/browser test when it already provides the
   necessary fixtures. Introduce a new composition test only if no existing
   owner can express that interaction faithfully.
3. Repair demonstrated defects. Trace the same ownership/cancellation contract
   through writer resume, promotion, failed promotion cleanup, and lineage
   replacement; check cold startup against its separate R8 contract. Keep
   changes bounded to the applicable contract. Test
   regression detection against the broken behavior where practical.
4. Complete R1–R8 evidence, run affected focused/browser checks and the broader
   lane if shared behavior changed, update current guides as needed, and record
   unresolved platform limits. Close this phase before generation work begins.

## Validation Selection

Use explicit file targets; the focused wrapper accepts one target per command.
Initial candidates, to select according to the completed coverage inventory:

```sh
pnpm test -- src/ts/bootstrap.test.ts
pnpm test -- src/ts/server/bootstrap.svelte-node.test.ts
pnpm test -- src/ts/server/connectedReaderSync.test.ts
pnpm test -- src/ts/server/events.test.ts
pnpm test -- server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts
pnpm test -- server/fastify/browser-smoke/connectedWriterSwitching.spec.ts
```

The focused browser command builds and executes that spec. To run multiple
selected browser specs against one fresh build:

```sh
pnpm build:smoke
VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts \
  server/fastify/browser-smoke/connectedWriterSwitching.spec.ts
```

Reuse `server/fastify/browser-smoke/fastBootstrapHarness.ts` and existing journey
fault helpers. The harness supplies temporary data and a random-port Fastify
server; Playwright's config uses Chromium. Ensure the configured browser is
available, release held routes in `finally`, close contexts/harnesses, and keep
failure traces. A browser-smoke API snapshot supplements DOM and durable
assertions; it must not be the sole oracle for restored controls or drafts.

## Execution Record

Assessment: not started. Findings: none confirmed. Runtime validation: not run.

On execution, record for each R ID the named tests, real/mocked boundaries,
disposition, actual command/result/revision, regression-detection evidence, and
limitations, following [the common matrix](../PLAN.md#1-establish-the-behavior-and-coverage-matrix).
Record any unresolved required criterion here and keep the phase open. Next
action: complete the entry-path/mocking inventory before choosing test changes.
