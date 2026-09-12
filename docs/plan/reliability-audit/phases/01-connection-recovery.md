# Phase 01 — Connection Recovery and Writer Promotion

State: **Complete.** Read [the plan](../PLAN.md) and [status](../status.md).
The inventory below was cross-checked against source and executed tests on
2026-09-12. Final validation passed; results and limits are recorded below.

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

Execution started 2026-09-12 at `dc96708c798b3653ca73b501227649acd0753dfb`
with a clean worktree. The runtime baseline remains
`e93a74236d3e66a928cdd44c4e6d73a086aae515`; intervening commits are documentation
only. Evidence below uses that checkout plus this phase's uncommitted changes:
SSE cleanup registration, recovery test extensions, and the mobile reader test
correction. Four independent read-only Luna explorations completed successfully
(coordinator, transport/server policy, drafts/UI, and browser harness). Their
suggestions were checked against source and runtime evidence in the parent task.

### Entry-path and real/mocked inventory

<!-- prettier-ignore -->
| Entry / owner | Contracts | Evidence boundary and disposition |
| --- | --- | --- |
| Cold `loadData()` → `resolveConnectedClientStartup()` | R8, R3 | Keep shared-caller, stale discovery/acquisition, and abandoned setup tests. Coordinator/session/readiness are real; bootstrap transport and tab identity are mocked. Real control-helper deadline/body tests supply the transport half. Cold startup remains outside immediate lease replacement. |
| Reader refresh after demotion, online, or lineage adoption (`refreshConnectedReader`) | R2, R3, R7 | Strengthen the existing offline/online held-bootstrap case to late success and failure. Keep held lineage cleanup/hydration tests. Real coordinator/session; resource/reader/transport helpers mocked. Browser promotion also exercises real replacement reader refresh before a fresh explicit switch. |
| Writer resume after stream close, offline/online, foreground/pageshow (`resumeConnectedWriter`) | R1–R5, R7 | Keep mobile SSE-close/offline/retired-bootstrap journeys, coordinator held hydration/preparation/startup cases, uncertain probe fallback and failed verification. Browser cases use real app/Fastify/SQLite and controlled transport/lifecycle faults. |
| Healthy/stale foreground writer ownership probe (`restartServerResourceEvents`) | R2–R4, R7 | Add held probe → retirement → completed replacement → late foreign ownership/error, followed by 120 seconds of clock advancement after full teardown. Keep healthy-focus and changed-owner cases. Coordinator/session/timers real; network/domain helpers mocked. |
| Explicit reader promotion (`promoteConnectedReader`) and failed acquisition | R1–R5 | Keep confirmation/cancel/conditional-race/public-promise cases. Add real browser composition at reader SSE admission, confirmed acquisition JSON, shell JSON, and writer SSE admission; each releases old success and failure only after B becomes usable. Add five coordinator failure-and-retry schedules. |
| Confirmed writer loss and scoped draft restoration | R1, R3, R6 | Keep A → B → A browser journey, real 423 rejection, originating Local edits dialog and restored composer. Session/draft tests retain actual capture ordering, AES-GCM and fake IndexedDB; mounted App/Workspace unit tests substitute child/runtime dependencies. Browser validates the assembled DOM. |
| Database-lineage replacement and cleanup | R2, R3, R6 | Keep coordinator pending discard/replacement and scoped storage tests. Execute the existing connected import-replacement browser journey with real Fastify/SQLite, held old PATCH and native 409, followed by explicit same-owner writer recovery. Broader import atomicity stays in phase 06. |
| Reader/writer SSE admission, replay, watchdog, and server teardown | R4, R7 | Keep actual transport tests with controlled fetch/streams/fake clocks, reader sync with mocked resource/transport helpers, and real Fastify/SQLite route tests. Add snapshot-read-failure cleanup and retry regression. |

The browser composition keeps the coordinator, client session, reader sync,
control parser, encrypted outbox preparation/receipt/replay, resource hydration,
language readiness, and event admission real. Its single selected network
response comes from the native server; only completion timing and abort
cooperation are replaced. Late failure is a deliberate transport exception.
The held SSE socket ignores abort by design and is disposed by the fault
fixture. Other requests use native fetch. The test additionally retains the
replacement's server `ServerResponse` identity and proves that it remains live
through a real committed message visible on both clients; an eventual reconnect
cannot hide old cleanup closing B's stream.

No test was removed. The earlier reader-refresh late-error case retains all its
assertions and gains a late-success variant with exact session equality. The
mobile navigation control count becomes the exact permitted labels: desktop
Go Back; mobile Close Menu and Go Back. The remaining authoring-denial, request,
clipboard, navigation, and focus checks are preserved.

### Contract evidence ledger

Names refer to actual tests in the owner files listed above; command results are
recorded below. Real browser results supplement helper tests rather than making
all mocked boundaries equivalent.

<!-- prettier-ignore -->
| ID | Executed oracle / failure schedule | Disposition / limits |
| --- | --- | --- |
| R1 | All three mobile recovery journeys: same composer identity/text/URL/document/lineage, inert and unusable while interrupted, restored capability and accepted server edit. `Use this device switches A to B to A in place while preserving reader routes and the originating draft`: visible Local edits text, restored composer, native stale-writer 423, durable messages and subsequent writer navigation. | Keep. Desktop plus Chromium Pixel 7 emulation; physical-device suspension is not claimed. |
| R2 | New `reader promotion replaces held … before late …` matrix covers four real boundaries × success/failure. Immediate abort is checked before retry; B is ready before old release; exact session, newer composer text, SQLite state, URL/document, and B's native stream survive late completion. Coordinator `supersedes an aborted reader refresh before its late …`, `replaces a suspended writer probe before its late …`, and existing retired writer preparation/hydration/startup/lineage cases cover the distinct entry owners. | Strengthen/add. Public promise settlement is asserted by coordinator tests including `starts fresh writer recovery while retired promotion startup is still unresolved`; pre-authorization browser action additionally clears `aria-busy`. Real representative boundaries compose the owners; isolated tests preserve remaining distinct pause points. |
| R3 | Existing uncertain ownership probe/conditional bootstrap failures remain recovering; malformed ownership helper cases fail closed. Failed acquisition never auto-takes over. Actual A → B → A takeover plus Fastify conditional race/connected confirmation/stale-lineage cases prove foreign authority revokes writes and scoped drafts survive. Reader auth-failure browser case clears protected browsing. | Keep. Timeout/malformed payload is controlled transport evidence, not a production incident reproduction. |
| R4 | New control-body matrix: ownership/reader/writer × HTTP 200/409 × caller cancel/30-second deadline; replacement succeeds while old JSON is held, late body changes neither revision nor configuration, and request timers clear. Existing fetch stalls and event admission/409-body deadline cases plus real held SSE admission cover transport cancellation. | Add/keep. Both control and event admission deadlines are 30 seconds. Established silent SSE is a separate 60-second watchdog, not a 30-second admission failure. |
| R5 | `keeps failed promotion during … gated and permits a successful explicit retry`: exceptions at prepare/receipt/replay/hydration/events never publish writing, return to live reading, and a fresh explicit attempt reaches mutation/generation readiness. Existing supersession matrix preserves five boundaries, retained/unreadable outbox behavior, failed event admission, and changed/failed startup target gating. | Add/keep. Real browser hydration/admission delays also prove no premature mutation UI. After authorization, foreground may resume the same writer; before authorization, another explicit promotion is required. |
| R6 | Real draft tests `does not delete a newer capture while an old discard waits behind storage`, `keeps a newer synchronous capture when an older load crosses demotion and repromotion`, aborted-commit and other-writer/lineage/auth cases. Browser A → B → A visibly exposes/restores originating text; new composition retains newer B text while A finishes and keeps A's draft scoped. | Keep. Fake IndexedDB and real crypto establish storage race/serialization; browser sessionStorage and visible recovery establish assembled restoration. Page-exit persistence remains best effort. |
| R7 | Healthy writer/reader focus avoids ownership/bootstrap/resource work; silent-stream watchdog and teardown tests advance deterministic clocks. New probe cases advance 120 seconds after stopping coordinator, deferred runtimes, and adopted resource events; no probe/subscription restarts. New Fastify snapshot-failure test proves HTTP 500 leaves zero command subscriptions twice and a fresh stream connects/closes normally. | Add/keep. Full teardown includes the adopted stream owner; stopping only the coordinator is not a claim that all page runtimes were stopped. Server heartbeat comments are permitted every 25 seconds. |
| R8 | `shares one coordinator attempt loop between concurrent startup callers`; held discovery/acquisition after a new session; `abandons a pending empty-server setup decision on pagehide`; `cannot initialize from a late acquisition after setup pagehide`. Combined with bounded real control transport and new stalled JSON matrix, late startup cannot initialize, prepare/replay, or authorize a superseded generation. | Keep/extend transport. No new immediate cold-start replacement guarantee. Persisted pageshow retains its reload policy; synthetic non-persisted pagehide/pageshow is not evidence of physical cold-page restoration. |

### Findings and detection

- **F1 — reproduced server subscription leak (R7), fixed.** The event route
  subscribed to command, memory, and writer events before preparing its initial
  snapshot, but installed response cleanup only after that snapshot succeeded.
  A real SQLite snapshot-read error returned HTTP 500 with one command listener
  still attached. The regression temporarily renames the memory-job table only
  in its disposable database, verifies zero listeners after two failed requests,
  restores the table, and verifies a successful native SSE connection and close.
  Before the fix, the new test failed with expected zero / actual one listener.
  After moving lifecycle cleanup registration before all subscriptions, all 26
  event tests passed. Normal close, replay rejection, and mid-handler overflow
  coverage remain. No production database was accessed or changed. The related
  review stops at event-route subscription/admission/teardown; job execution is
  phase 05.
- **F2 — reproduced pre-existing mobile test oracle mismatch, corrected.** The
  mobile read-only browser case failed at an active-control count of one because
  the responsive drawer legitimately renders Close Menu alongside Go Back.
  Source and the failure screenshot confirm both are navigation controls. The
  replacement assertion checks the exact allowed labels and retains the denial
  of all authoring controls. The corrected mobile journey passed.
- **D1 — controlled regression mutation (R2), detected after strengthening.**
  Temporarily omitting `lease.controller.abort()` and rebuilding initially let
  the new acquisition-body browser case pass after about 33 seconds: its polling
  allowed the control request's timeout to hide missing immediate cancellation.
  The test now checks abort immediately after hidden retirement. Against the
  same mutated build it fails with expected true / actual false before old
  response release. Source was restored in `finally`; final validation used
  a rebuilt unmutated frontend. This is a surrogate cancellation defect, not a
  replay of a historical production incident.
- Worker concerns were not accepted as defects without verification. The
  optional currentness expression in `runStartupStep` invokes a predicate and
  is not a tautology. Foreground work passes explicit owner/currentness;
  cold-start sharing has the separate R8 contract. Ancestor `inert` plus actual
  handler admission is intentional and is checked in Chromium. Recognizing a
  stale 423 without mutating a newer generation is response classification,
  not evidence of authority loss. No cold-start redesign was needed for R8.

### Commands and results

All initial checks below ran against the execution baseline. Focused commands
use one explicit target per invocation; these are the actual targets and their
last focused result before final validation:

<!-- prettier-ignore -->
| Command (`pnpm test --` plus target) | Result |
| --- | --- |
| `src/ts/bootstrap.test.ts` | Baseline 231 passed; extended 238 passed focused; final 239 passed in the broader lane. |
| `src/ts/server/bootstrap.svelte-node.test.ts` | Baseline 34 passed; extended 46 passed. |
| `src/ts/server/connectedReaderSync.test.ts` | 26 passed. |
| `src/ts/server/events.test.ts` | 17 passed. |
| `src/ts/connectedClientStartup.test.ts` | 18 passed. |
| `src/ts/clientSession.test.ts` | 15 passed. |
| `src/ts/startupReadiness.test.ts` | 15 passed. |
| `src/ts/server/activeWriterSession.test.ts` | 12 passed. |
| `src/ts/workspaceAccess.test.ts` | 6 passed. |
| `src/App.routeEffect.dom.test.ts` | 31 passed. |
| `src/lib/Workspace.svelte.test.ts` | 32 passed. |
| `src/lib/DeviceAccessAction.svelte.test.ts` | 2 passed. |
| `src/ts/server/writerDraftRecovery.test.ts` | 25 passed. |
| `src/lib/WriterDraftRecovery.svelte.test.ts` | 12 passed. |
| `src/ts/server/resourceInvalidation.test.ts` | 120 passed. |
| `src/ts/server/replacementDatabaseOwnership.svelte-node.test.ts` | 5 passed. |
| `src/ts/readerProjectionLifecycle.test.ts` | 3 passed. |
| `server/fastify/__tests__/bootstrap.test.ts` | 7 passed. |
| `server/fastify/__tests__/events.test.ts` | Baseline 25 passed; new regression failed on old code; fixed 26 passed. |
| `server/fastify/__tests__/activeWriter.test.ts` | 28 passed. |

Baseline browser command, after `pnpm build:smoke`:

```sh
VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts \
  server/fastify/browser-smoke/connectedWriterSwitching.spec.ts
```

Result: six passed. The new eight-case promotion matrix subsequently passed
with the native replacement-stream oracle. The immediate-abort assertion added
by D1 also passed against the final unmutated build. The additional read-only/lineage run
(`readOnlyAppUx.spec.ts` and `visibleStateRecovery.spec.ts`) passed seven cases
and exposed F2; the corrected mobile case passed on its focused retry. Earlier
new-test setup corrections reflected actual authorization state and durable
post-acquisition ownership; they were not runtime regressions.

Final verification on the recorded baseline plus this phase's final patch:

- `pnpm test:agent`: **passed**, all seven lanes, 2m 49.5s. Protocol/shared-core,
  server/browser-smoke types, architecture inventory, topology, current docs,
  frontend types, and fresh smoke build passed. Svelte reported zero errors and
  zero warnings. Frontend: 729 files, 9,498 passed / three existing skipped.
  Server: 232 files, 4,374 passed / three existing skipped. Those conditional
  baseline/report/direct-only skips are outside the required Phase 01 evidence.
- The broader lane was required because SSE lifecycle is shared by readers,
  writers, event replay, and operational projections. `pnpm test:all` was not run.
- Final browser command below: **22 passed**, 1.2m, using the unmutated smoke
  build produced by the successful broader lane. No source/build input changed
  between that build and the journeys. Node 24.19.0, pnpm 11.23.0, Playwright
  1.62.1, Chromium 151.0.7922.34; desktop and Pixel 7 emulation, temporary SQLite
  and random-port Fastify, no human or production data.
- `pnpm check:docs`: **passed**, 51 current files. Explicit
  `validateCurrentDocumentation` with the plan/index's nine paths and empty
  index/exemption lists: **passed**. This explicit call covers nested plans.
  Scoped Prettier passed for all six changed TypeScript files and the two phase
  status/ledger Markdown files; `git diff --check` passed.

```sh
VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts \
  server/fastify/browser-smoke/connectedWriterSwitching.spec.ts \
  server/fastify/browser-smoke/readOnlyAppUx.spec.ts \
  server/fastify/browser-smoke/visibleStateRecovery.spec.ts
```

Runtime patch fingerprint (SHA-256 of `server/fastify/src/routes/events.ts`):
`18636ad2edef0e61c4cb587a5b5c203fa61a1a1a6eee2f20c2012886879a03b5`.
The temporary mutation left no change to `src/ts/bootstrap.ts`. Browser evidence
is attached by Playwright per journey; the ledger retains the commands, outcomes,
oracles, and limitations independently of disposable tool logs.

### Remaining limits and handoff

- Physical mobile suspension/BFCache/process death and browsers other than
  Chromium are unverified. Impact: platform-specific lifecycle behavior may
  differ. Owner: a Phase 01 device follow-up. Next action: run stream/offline/
  foreground/promotion journeys on a physical supported mobile device and record
  browser/OS; this optional depth gap does not certify those platforms.
- This phase does not reproduce an external production incident or certify all
  recovery combinations. Wider cache/navigation, durable mutation semantics,
  generation/effects, jobs, and import publication retain their named later
  phases. The native database-replacement journey proves the connection boundary
  only. Server-restart proof from other tests is not claimed as executed here.
- R1–R8 have executed evidence and no required acceptance gap or unresolved
  demonstrated in-scope defect remains. Phase 01 is closed. Next action: start
  phase 02's generation entry-path/real-mocked coverage assessment, reusing this
  connection evidence and recording the revision and working changes. Rerun
  affected evidence if the connection/session/transport owners drift.
