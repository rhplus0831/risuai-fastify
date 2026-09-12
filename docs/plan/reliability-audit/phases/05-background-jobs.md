# Phase 05 — Background Translation, Memory, and BardWiki Jobs

State: **Not started; follows phase 04.** Use [the common audit method](../PLAN.md#audit-method).
Finish each family below before expanding to the next.

## Scope and Source Map

Start with message/greeting translation, then a representative memory
embed/summarize workflow, then BardWiki rebuild/receipt reconciliation. Assess
distinct contracts in each family; shared worker structure alone cannot prove
equivalent lifecycle behavior. Broader provider conformance and memory-quality
evaluation are outside this lifecycle audit.

Guides: [translation](../../../structure/translation-and-input-hooks.md),
[BardWiki](../../../structure/bardwiki.md), and
[memory tests](../../../tests/memory-and-embeddings.md).

<!-- prettier-ignore -->
| Family | Source owners | Existing tests |
| --- | --- | --- |
| Process-local translation execution, persisted result | `server/fastify/src/translation/serverMessageTranslation.ts`, `server/fastify/src/translation/serverGreetingTranslation.ts`, `server/fastify/src/messageTranslationJobs.ts`, `server/fastify/src/greetingTranslationJobs.ts` | `server/fastify/__tests__/serverMessageTranslation.test.ts`, `server/fastify/__tests__/messageTranslationJobs.test.ts`; select greeting and browser consumer tests at entry |
| Durable memory jobs and process-local controllers | `server/fastify/src/memoryRepository.ts`, `server/fastify/src/memoryWorker.ts`, `server/fastify/src/memoryEmbedJobHandler.ts`, `server/fastify/src/memorySummarizeJobHandler.ts` | `server/fastify/__tests__/memoryWorker.test.ts`, `server/fastify/__tests__/memoryEmbedJobHandler.test.ts`, `server/fastify/__tests__/memorySummarizeJobHandler.test.ts` |
| Durable BardWiki jobs, staged rebuild, receipt reconciliation | `server/fastify/src/bardWikiJobs.ts`, `server/fastify/src/bardWikiRebuildHandler.ts`, `server/fastify/src/bardWikiReconcileHandler.ts` | `server/fastify/__tests__/bardWikiJobs.test.ts`, `server/fastify/__tests__/bardWikiRebuildHandler.test.ts`, `server/fastify/__tests__/bardWikiLifecycle.test.ts` |
| Client terminal projection/refresh and job controls | `src/ts/server/memoryJobProjection.svelte.ts`, `src/ts/server/memoryJobRefresh.ts`; trace translation/BardWiki consumers at entry | `src/ts/server/memoryJobProjection.test.ts`, `src/ts/server/memoryJobRefresh.test.ts`, `server/fastify/browser-smoke/bardWikiLifecycle.spec.ts` |

Worker cancellation, deadlines, sibling isolation, restart recovery, source
changes, and hidden staging already have focused coverage. The inspected
BardWiki browser journey covers controls/manual documents/reload; it does not
establish actual background-job completion. Find existing browser coverage for
each selected family before deciding whether a new journey is necessary.

## Required Acceptance and Candidate Schedules

<!-- prettier-ignore -->
| ID | Schedule | Observable acceptance |
| --- | --- | --- |
| J1 | Job A waits on provider; source changes or B replaces A; A finishes late. | Only the current eligible identity/source can persist; latest visible translation/job state remains correct. |
| J2 | Cancellation or target deletion wins before persistence; provider ignores abort. | Cancelled/obsolete work cannot publish completion or overwrite output; caller/worker cleanup leaves a supported next action. |
| J3 | Persistence fails after provider success; worker retries or application restarts. | Durable jobs follow their supported retry/recovery contract without duplicate committed output. Process-local translation jobs expose their actual restart limitation. |
| J4 | Durable terminal state commits but event/list response is lost; older refresh arrives later. | GET/reconnect/reload converges to authoritative terminal state, stale active updates cannot revive it, and progress UI settles. |
| J5 | One memory job/chat fails or cancels while a sibling succeeds. | Sibling results survive; logical job ID and instance identity prevent old callbacks from matching a recreated job. |
| J6 | BardWiki source changes after checkpoint, restart occurs before publish, or manual document edits precede reconciliation. | Staging stays invisible until valid atomic publication; receipt/document fences yield safe reconciliation or explicit review-required state without losing manual edits. |
| J7 | Jobs settle and old polling/stream callbacks continue. | Current visible state remains terminal and obsolete retries/subscriptions stop within the owner's retention/lifecycle policy. |

## Execution and Validation

First document each family's persistence, retry, terminal, event, and retention
contract. Compose real orchestration, registries, repositories, targeted
mutations, and client projection; inject provider/network/storage faults. Avoid
assuming that a real provider service is needed to prove lifecycle ordering.

For each selected user-visible family, require a real browser journey asserting
rendered completion/recovery together with durable output where applicable.
Ordinary smoke mode substitutes/disables some background activity, and
`server/fastify/browser-smoke/fastBootstrapHarness.ts` explicitly sets
`memoryWorker: false`. At phase entry, choose an isolated harness that explicitly
enables the selected real worker with a deterministic provider boundary. Add a
narrow opt-in harness capability only if existing fixtures cannot support it;
preserve default smoke behavior and record worker startup/shutdown evidence.
This proves the worker-to-UI composition, not an external provider service.
Strengthen an existing owner when possible. Run relevant focused tests above
and explicit selected Playwright specs; use broader validation when shared
worker/event/persistence behavior changes. Distinguish harness reopen/restart
from an actual external-process crash.

## Execution Record

Assessment: not started. Findings: none confirmed. Validation: not run.
Populate J1–J7 per family; record justified inapplicable criteria explicitly.
Open planning limits include provider-to-rendered-terminal browser coverage and
translation restart semantics. Completion follows
[the common rules](../PLAN.md#phase-completion-and-handoff).
