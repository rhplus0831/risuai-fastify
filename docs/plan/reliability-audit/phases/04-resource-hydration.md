# Phase 04 — Resource Hydration, Invalidation, and Navigation

State: **Complete; H1–H6 verified, no required evidence gap remains.** Use [the common audit method](../PLAN.md#audit-method).
Phase 01 owns hydration required for recovery/promotion; link its results here.

## Scope and Source Map

Start with empty-cache direct navigation to a selected character/chat: startup
shell, selected detail, transcript tail/range, prompt owner, and visible route
readiness. Extend to superseded navigation, cache verification, and reader event
gaps. Generation recovery is a separate readiness capability; do not introduce
a new dependency that unnecessarily blocks ordinary read-only navigation.

Guides: [resources](../../../structure/server-resources-and-bridges.md),
[client runtime](../../../../src/docs/client-runtime.md), and
[recovery tests](../../../tests/browser-state-sync-and-recovery.md).

<!-- prettier-ignore -->
| Boundary | Source owners | Existing tests |
| --- | --- | --- |
| Route selection/readiness and idle warming | `src/ts/server/routeResourceLoader.ts`, `src/ts/startupReadiness.ts` | `src/ts/server/routeResourceLoader.test.ts`, `src/ts/startupReadiness.test.ts` |
| Shell, transcript, and prompt owner hydration | `src/ts/server/characterShellHydration.svelte.ts`, `src/ts/server/chatMessageHydration.svelte.ts`, `src/ts/server/promptTemplateHydration.ts` | `src/ts/server/characterShellHydration.test.ts`, `src/ts/server/chatMessageHydration.test.ts`, `src/ts/server/promptTemplateHydration.test.ts` |
| Revisions, epochs, batch application, cache | `src/ts/server/resourceInvalidation.ts`, `src/ts/server/resourceState.svelte.ts`, `src/ts/server/resourceCache.ts` | `src/ts/server/resourceInvalidation.test.ts`, `src/ts/server/resourceCache.test.ts`, `src/ts/server/resourceCacheDelivery.svelte-node.test.ts` |
| Real route and reader recovery | Actual resource reads and route UI reached by the selected journey | `server/fastify/browser-smoke/startupDirectLinks.spec.ts`, `server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts`, `server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts` |

Current unit coverage already exercises session/selection/epoch rejection,
deduplication, timeout/retry, cache corruption, and verification/clear races.
Existing browser tests include direct links and refresh-before-reconnect after
an event gap. An aggregate request-path matrix does not independently verify
every hydrated value; record its exact oracle before claiming coverage.

## Required Acceptance and Candidate Schedules

<!-- prettier-ignore -->
| ID | Schedule | Observable acceptance |
| --- | --- | --- |
| H1 | Hold shell/detail or fail selected chat/prompt loading on direct navigation. | Loading/error/Retry and capability state reflect actual readiness; display paint cache cannot certify authoritative resource state. |
| H2 | Hold A detail/tail/prompt requests, navigate to B, finish B, then release A in reverse order. | B's route, visible transcript, prompt owner, and readiness stay current; A cannot publish stale terminal state. |
| H3 | Older range/targeted refresh races newer projection or same-batch sibling application. | Newer bodies/epochs win; valid sibling results remain applicable according to their captured scope, and unloaded ranges are not falsely certified. |
| H4 | Corrupt/miss a cached hash entry; or change auth/lineage while verification/persistence is held. | Authenticated full-read fallback yields correct visible data; old cache work cannot repopulate a new generation or block required resource delivery. |
| H5 | Event gap arrives while old refresh is pending; one authoritative read fails or is older than the event. | Current visible data is retained until valid convergence, retry remains available, and stream cursor/reconnect follows applied evidence. |
| H6 | Healthy focus or idle warming after selection/capability revocation. | Only justified reads occur; retired warming cannot fetch/apply against a new owner, and no reader request acquires writer authority. |

## Execution and Validation

Retain route loaders, actual resource reads, hydration/projection owners, and
DOM rendering for interaction checks. Use real Fastify resources and injected
HTTP/IndexedDB faults for browser evidence. Start from a clean cache and an
authenticated verified-cache fixture as separate conditions.

Run the relevant focused owners and selected browser specs from the table,
using [the explicit browser pattern](01-connection-recovery.md#validation-selection).
Read `server/fastify/browser-smoke/globalSetup.ts` and
`server/fastify/browser-smoke/fastBootstrapIntegrationArtifact.ts` before claiming
startup artifact/budget evidence; a selected spec is not the complete
fast-bootstrap verification matrix. No performance-budget redesign is planned.

## Execution Record

### Entry inventory and evidence boundaries

Started from clean commit `960a2f336dcab751692cdac0d87d04ac3377daa4` after
committing the completed Phase 03 work. Read the root/local instructions,
structure, common plan, resource/runtime guides and browser inventory. Four
independent read-only Luna explorations cross-checked route readiness, body
hydration, cache verification and event refresh. Parent source inspection and
executed tests determined findings; worker hypotheses alone were not evidence.

The bounded entry map is direct writer links and reader local navigation;
selected character detail and concurrent chat/prompt loading; active/ranged/bulk
body consumers; authenticated root/body cache transport; targeted and complete
invalidation from writer responses/events and reader replay; and lifecycle/idle
callbacks. Ownership extends through `App.svelte`, `startupReadiness.ts`,
`routeResourceLoader.ts`, the resource/projection owners, and rendered route or
Reader transcript state. This does not expand into job execution or destructive
publication, which remain Phases 05 and 06.

Focused tests keep the real loader/hydration/invalidation owners and their
resource projections, with controlled resource responses and clocks. Reader
queue tests control refresh responses to isolate serialization/cursor behavior;
real pre-apply snapshot behavior is checked separately in `resourceInvalidation.test.ts`.
Cache suites retain fake IndexedDB with real cache/crypto/transport delivery
logic. Native browser cases keep the built SPA, browser storage, auth, Fastify,
SQLite and SSE; injected HTTP bodies, held responses, offline transitions and
native cache edits supply faults. The harness disables unrelated memory workers.
Read-only smoke hooks navigate or inspect state; tests never assign the expected
visible transcript, setting or readiness result.

### Contract and test disposition ledger

<!-- prettier-ignore -->
| Contract | Retained and added evidence | Executed oracle and boundary |
| --- | --- | --- |
| H1 | Keep shell/route/readiness, prompt hydration and paint-cache coverage; add abort-insensitive detail timeout success/failure and two native failed-body direct links. | Detail caller settles with timeout before old dependency returns; Retry succeeds first and late work cannot replace it. Native chat/prompt failures show route error and usable shell, then Retry reveals the canonical transcript. Retained direct-link and display-paint journeys cover normal surfaces and non-authoritative early appearance. |
| H2 | Keep per-owner selection/session/epoch tests; add four native A→B schedules. | Hold A detail or both A chat/prompt bodies, render B while A is pending, release A success/failure in reverse order, and retain B route, visible transcript, prompt ID/template and readiness. Background A hydration may update its own valid owner; it cannot certify or overwrite B. |
| H3 | Keep overlap/disjoint range, minimum revision, partial-window and prompt-owner cases; add mixed-sibling bulk chat test. | A targeted newer chat body wins against its older held bulk result while the same batch's unaffected sibling applies. Existing range tests preserve unloaded bounds; unchanged prompt tests cover selected versus explicit background owners and independent compatibility projection. |
| H4 | Keep 37 cache and 23 delivery cases plus auth/lineage evidence from Phase 01; add two native corrupt/missing-entry reload journeys. | First prove warm authenticated hash substitution, then corrupt/delete that manifest's native entry and reload. The bad hash is omitted, authenticated full data supplies the correct visible setting. Controlled verification/clear and persistence/auth races still prove progress and old-generation rejection beyond the native reload schedule. |
| H5 | Keep reader applied-cursor and consistent/full/targeted refresh coverage; add reader/writer pre-apply floor cases and two queued-gap schedules; strengthen writer coalescing/replacement checks; add two native reader gap/failure/convergence journeys. | Real apply owner rejects revision 6 for event 8 before replacing resident values, then accepts 8. Held targeted refresh completes before gap 10; failed/older full reads cannot advance its cursor, and valid 10 converges. Native failed/older snapshots retain visible content before successful message catch-up and read-only reconnect. |
| H6 | Keep data-saver/idle cancellation and reader no-mutation coverage; add started-warmup retirement, idle/active observer focus cases, and native settled focus counts. | Demotion plus actual loader teardown aborts the old warmup; a new writer route finishes before late failure and stays ready. Healthy focus adds no observer bootstrap or viewer replacement; suspension still recovers. Native reader bootstrap/SSE carry no writer-intent header, no command is sent and SQLite ownership is unchanged; settled focus adds no bootstrap/ownership/full reads. |

[Phase 01 R1–R8](01-connection-recovery.md#execution-record) retain the native
lease/authority/replacement and paint-versus-readiness boundaries;
[Phase 03 O1–O6](03-outbox-and-optimistic-edits.md#execution-record) retain
optimistic/outbox ordering through full refresh. No prior test was removed or
weakened. The writer refresh/bootstrap expectation changes add the required
revision argument while preserving their original assertions.

### Confirmed findings and repairs

1. **Character-detail timeout could leave its caller pending.** The hydration
   owner aborted the transport and then kept awaiting it. Authentication occurs
   before the resource transport installs its cancellation listener, so a held
   dependency can ignore that abort. The new regression held an abort-insensitive
   resource response past the deadline and failed before repair because the
   public caller had not settled. The owner now races cancellation, cleans up
   its listener and retains existing owner/selection guards. Both late success
   and failure pass after a replacement has already completed. This precise
   stall reproduction is focused evidence; native direct-link Retry and held
   navigation cases verify adjacent assembled paths without claiming a native
   held-auth timeout reproduction.
2. **Full snapshot age was checked too late or not at all.** Targeted reads had
   event floors; a gap fallback did not pass that floor into complete apply.
   Reader code could reject an old revision after its slices replaced resident
   data, and writer fallback lacked the guard. The real-owner regression
   supplied consistent revision 6 against event 8 and failed before repair by
   returning success. Complete refresh now checks a supplied minimum before any
   slice apply; invalidation, reader replay-unavailable, writer replay/conflict
   and Realm fallback producers pass their known revision. Coalescing carries
   the maximum into follow-up reads; database replacement resets the old floor.
   Reader/writer apply, queue/cursor, coalescing and lower-revision replacement
   cases pass. Native gap cases verify retained DOM/cursor and eventual real
   convergence; they are integration checks, not an independent reproduction
   of the pre-apply defect (the pre-fix native run also retained its content).
3. **Healthy reader focus restarted generation discovery.** Resource SSE
   correctly ignored healthy focus, but the selected generation observer's
   unconditional lifecycle callback detached its viewer and issued bootstrap.
   The original built SPA issued one extra bootstrap for a coalesced four-focus
   burst in both native reader schedules. A focused idle regression independently
   failed with five bootstrap calls instead of one. The callback now preserves
   healthy scheduled observation; suspension and existing probe/stream/handoff
   failures still recover, and explicit Retry is unchanged. Both idle/active
   focused cases preserve healthy viewers and verify suspension recovery.

The old-code focused reproductions stopped at the first failing parameter under
`--bail=1`; this does not claim every parameter independently failed before the
fix. No mutation surrogate was used for these three findings.

Rejected candidates: selection changes need not cancel every valid background
chat/prompt read, provided owner application and visible compatibility remain
fenced; the native A/B schedules passed before runtime changes. A previously
verified in-memory immutable hash value can validly serve an authenticated hit
even if its disposable disk copy later changes; reload tests explicitly clear
that in-memory verification context before corrupt/missing admission checks.
A reader controller's post-refresh revision check alone did not establish
pre-apply safety, so the real apply owner was tested separately. Initial browser
fixture corrections used the actual manifest key, session lifecycle field,
smoke snapshot type and authority-bearing header boundaries; broad rejection
of session headers on pure cache reads would misclassify read-only traffic.

### Validation record

Baseline focused commands were `pnpm test -- <file>` for route loader (18),
character detail (15), chat hydration (104), prompt hydration (25), invalidation
(120), complete refresh (15), cache (37), cache delivery (23), and connected
reader sync (26). All passed before new regressions were added.

Post-fix focused commands passed: character detail 17, chat hydration 105,
invalidation 122, reader sync 28, complete refresh 15, route loader 19,
reader generation observation 35, and bootstrap 239. Chat hydration and route
loader were rerun successfully after their final fixture corrections. Unchanged cache/prompt
owners retain their baseline coverage. Browser TypeScript validation passed.
A fresh `pnpm build:smoke` built the current runtime; the selected native suite
runs explicitly with `VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test
-c playwright.fastify-smoke.config.ts`.

`pnpm test:agent` ran because complete-refresh revision propagation spans reader
and writer recovery, alongside character/observer lifecycle changes. Five lanes
passed initially: test topology, current docs (51 files), frontend tests
(**9,539 passed**, three existing skips; 729 files), server tests (**4,375 passed**,
three existing skips; 232 files), and a fresh browser-smoke build. The skips are
outside required H1–H6 evidence. The two typecheck lanes exposed new fixture
argument/route shapes and an inventory count; no further runtime changes were
required. The reviewed architecture baseline delta adds exactly two test-fixture
snapshot references in `resourceInvalidation.test.ts` (53→55; aggregate 4,276→4,278),
with no production consumer/policy change. Protocol, shared-core, architecture,
Fastify and corrected browser TypeScript checks passed. The final `pnpm check`
passed with zero errors/warnings. All seven validation lanes are satisfied; the
initial aggregate command itself reported failure before those corrections.

The final native selection uses the agent lane's fresh runtime build and these
six files: `resourceHydrationRecovery.spec.ts` (10), `startupDirectLinks.spec.ts`
(4 isolated batches covering 44 routes), `startupRecoveryIntegrationMatrix.spec.ts`
(7), `displayPaintCache.spec.ts` (1), `connectedReaderBrowsing.spec.ts` (1), and
`connectedReaderGeneration.spec.ts` (5), all under
`server/fastify/browser-smoke/`. **All 28 journeys passed** in the final combined run, including strengthened
snapshot-revision and durable-ownership assertions in the reader cases. The new
ten had also passed as a focused native run.

Current documentation (51 files), explicit nested plans/index (nine files),
scoped Prettier and whitespace checks passed. No `pnpm test:all` was requested
or run.

### Limits and handoff

The browser selection verifies functional recovery; it does not execute the
complete cache-population/performance-budget matrix. Global setup and the
integration artifact helper were read: selected runs write partial artifacts,
which are not a full fast-bootstrap certification. Synthetic focus/offline and
Chromium do not certify physical suspension, non-Chromium or external production
behavior. Native cache corruption uses reload; same-document held crypto and
persistence races use focused real-owner tests. Started-warmup retirement
explicitly includes loader teardown as the application performs it; it does not
claim a standalone role change cancels all loader work automatically.

No production data was touched, no new production test hooks were added, and no
manual development server was started. Phase 04 is complete with no unresolved
in-scope finding. Its patch was committed as
`86d07b1da7e39bff9f0ac0f9769f0697724c507c`. The current phase and next action are
owned by [status](../status.md).
