# Phase 04 — Resource Hydration, Invalidation, and Navigation

State: **Not started; follows phase 03.** Use [the common audit method](../PLAN.md#audit-method).
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

Assessment: not started. Findings: none confirmed. Validation: not run.
Populate H1–H6 with evidence and phase 01/03 coverage links. Planning gaps to
assess: browser-visible cache corruption fallback, simultaneous stale body
loads, partial event-gap refresh failure, and idle-warmup request counts.
Completion follows [the common rules](../PLAN.md#phase-completion-and-handoff).
