# Phase 05 — Background Translation, Memory, and BardWiki Jobs

State: **Complete.** Use [the common audit method](../PLAN.md#audit-method).
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

Baseline: `86d07b1da7e39bff9f0ac0f9769f0697724c507c`, clean worktree at entry
on 2026-09-12. Phase 04 was committed before work began. No production data was
used. Three read-only Luna workers returned translation, memory and BardWiki
inventories; the separate browser-harness worker timed out. The parent inspected
the harness, routes, UI and deterministic provider wiring directly. Worker
inferences were checked against current source and executable schedules.

### Entry inventory and persistence contracts

- **Translation:** manual message/greeting commands in `routes/commands.ts`,
  raw translation/pipeline dispatch, separate process-local job registries,
  targeted command transactions, bootstrap job history, both client refresh
  owners, greeting projection and `Chat.svelte` terminal/translation controls.
  Generation completion shares the message owner; existing cap/eligibility and
  effect tests are retained from Phase 02. Committed output is durable; running
  translation and its ten-minute/128-entry terminal history are process-local.
  Disconnect intentionally does not cancel execution. There is no manual
  translation durable restart queue. Provider/storage failure supports an explicit
  new request; a capped automatic translation is not durable provider resumption.
- **Memory:** planner/follow-up entry, authoritative source invalidation,
  `memoryRepository.ts`, `MemoryWorker`, normal/contextual embed and summarize
  handlers, provider deadlines, operational routes/events, `memoryJobProjection`,
  `memoryJobRefresh`, Hypa modal jobs and summaries. Claims/attempts/backoff and
  terminal state are SQLite rows; process-local controllers own execution. Output
  transactions are idempotent independently of job completion. Active jobs poll;
  terminal client history is bounded, while the server sweeps retained terminals.
  Explicit cancellation is terminal; the operational API can enqueue a successor.
  Normal planner deduplication does not automatically undo a cancellation.
- **BardWiki:** explicit/automatic confirmation, apply-turn, rebuild and receipt
  reconciliation handlers, isolated worker/queue, source invalidation,
  staging/checkpoints, final document/version/link/receipt/event transaction,
  targeted resources and workspace controls. Retry/recovery and checkpoints are
  durable. Cancel remains terminal. Changed checkpoint sources require a fresh
  preview/build; retained old staging cannot authorize changed-source publication.
  Reconciliation preserves later manual Markdown and raises `needs_review` when
  safe inversion cannot be established. Job events are operational and can share a
  domain revision, so resource revision alone cannot order job snapshots.

The new native fixture exposes only an opt-in `memoryWorker` option on
`fastBootstrapHarness.ts`; normal smoke mode still supplies `false`. The selected
memory case enables the actual app-owned worker and default summarize handler.
Translation and BardWiki use their actual app-owned registries/workers and default
handlers. A local HTTP OpenAI-compatible provider controls output/settlement;
provider dispatch, auth, API, SQLite, SSE and the built SPA remain real. No new
production smoke hook was added. Started worker execution is observed at the
provider and durable output, and both Fastify/provider shutdown are awaited.
Focused worker tests additionally verify drain-before-close and stopped timers.

### J1–J7 acceptance and test disposition

All prior tests remain. The table names executable evidence, not just source
inspection. The final validation record below controls pass/completion claims.

<!-- prettier-ignore -->
| ID | Translation | Memory | BardWiki |
| --- | --- | --- | --- |
| J1 | Keep command-route supersession, source-edit and prior-translation fences in `commands.test.ts`; real provider/targeted persistence. | Add summary held-success/failure plus real `invalidateUnsummarizedMemoryForChat`; committed sibling survives while removed job/chunk cannot return. Keep content-addressed planner and source-mutation tests. | Keep checkpoint/source-change and receipt mutation matrix; strengthen failed-source recovery with a fresh build; add repeated rebuild after manual edit. |
| J2 | Add message/greeting deletion and abort-insensitive deadline schedules in `serverMessageTranslation.test.ts`; no late output, explicit retry completes. Client disconnect is intentionally detached, not cancellation. | Keep actual cancel signal and independent/contextual sibling tests; add deadlines that settle before ignored abort and permit the next job. | Add ignored-abort completion after cancel/delete; no documents/events publish, and a fresh build succeeds after cancellation. Keep apply-turn cancellation/source tests. |
| J3 | Add provider success followed by SQLite trigger failure, rollback and one explicit retry. Reopen SQLite and create fresh registries: output survives, job history does not. | Add committed summary then failed operational completion write, SQLite reopen, next attempt and exactly one provider/output. Keep worker restart/backoff and contextual transaction rollback. | Strengthen checkpoint test to close/reopen SQLite and construct a new worker/handler. Keep apply-turn pre/post-commit recovery. Native completion-write failure retries without another provider call or duplicate document. |
| J4 | Add held running snapshots after succeeded/failed state and retired refresh after new lifecycle settlement; native message/greeting controls and reload. | Add error/unavailable/thrown list failure then automatic terminal reconciliation. Native drops the actual terminal SSE frame, injects 503 and checks UI plus one durable summary/reload. | Add overlapping workspace/invalidation GETs with equal revision and newer completed job; native holds the earlier pending response across completed state. |
| J5 | Keep separate-target registry/source fences; duplicate ambiguous message IDs are rejected by the server, not a second supported writable target. | Strengthen deadline cases with a completed sibling and recreated same logical job/fresh instance before late success/failure; current rows/output remain unchanged. Keep independent/contextual sibling failures/cancellation. | Keep independent BardWiki/Hypa lane execution. Cross-job Hypa isolation is the selected J5 contract; overlapping server workers are outside the single-worker deployment. |
| J6 | Inapplicable: no staging/receipt inversion. | Inapplicable: no BardWiki staged publication; memory transaction/reopen evidence is under J3. | Keep hidden bounded staging, checkpoint/source fences, missing-only rebuild and safe receipt inversion/manual `needs_review`; add preserved manual prior event plus new derived identity. |
| J7 | Add current-lifecycle single-flight, late callback retirement, immediate timer removal and native settled bootstrap/provider counts; retain registry expiration/cap tests. | Retain worker idle cadence/retention/shutdown and projection bounds; add failed-list recovery followed by no further polling; native settled request count. | Add worker graceful drain and no scheduled work after stop. Retain event unsubscribe/session reset fences; native old snapshot cannot revive progress. |

### Confirmed findings and repairs

1. **Translation refresh could revive settled or replaced work (J4/J7).** The
   message and greeting pollers applied held responses after terminal changes or
   stop/start. Each now captures lifecycle and projection identity, permits one
   current read, and discards retired results/cleanup. Terminal publication removes
   the scheduled timer. All six new focused schedules failed on old code
   (`/tmp/phase05-translation-refresh-all-reproduction.log`) and pass after repair.
   The original Phase 04 browser build reproduced a busy Translate button and an
   extra greeting bootstrap (`/tmp/phase05-translation-browser-reproduction2.log`).
2. **Translation deadline depended on provider cooperation (J2).** Abort alone
   left callers/jobs running and allowed a late result toward persistence. The raw
   owner races cancellation, rechecks it before return and before further
   chunks/steps. The old-code regression failed before late release on the caller's
   unsettled state (`/tmp/phase05-translation-deadline-reproduction.log`). Final
   message/greeting success/failure, deletion, storage and reopen schedules pass.
3. **Memory provider deadlines did not settle ignored abort (J2/J5/J7).** Held
   embed/summarize work blocked the next dispatch. The shared deadline owner now
   bounds awaiting the provider, including contextual embedding calls, and removes
   its abort listener. Summary failure marking preserves its existing chunk-error
   behavior while checking the current instance. Clean old-code reproductions
   failed on unsettled worker state in `/tmp/phase05-embed-deadline-clean-reproduction.log`
   and `/tmp/phase05-summary-deadline-clean-reproduction.log`. Sibling and recreated
   instance schedules pass with late success/failure still outstanding.
4. **One failed list read stopped active memory reconciliation (J4/J7).** The
   refresh controller stopped its interval on network/error/unavailable, leaving a
   lost terminal event unresolved until manual action. It now retains the ordinary
   interval while active jobs remain and stops after terminal reconciliation.
   Focused old-code failure: `/tmp/phase05-memory-refresh-reproduction.log`.
   Native old-build failure after actual terminal-frame loss and 503:
   `/tmp/phase05-memory-browser-reproduction3.log`; rebuilt client passes.
5. **Rebuild collided with a manually edited prior event ID (J6).** Preserving
   the user-edited document prevented reuse but publication still tried to insert
   its primary key, leaving the job retrying. Occupied identities now produce a
   separate derived document; later rebuilds reuse it through the receipt. The
   regression failed with pending instead of completed on old code
   (`/tmp/phase05-bardwiki-manual-reproduction.log`) and passes through two further
   rebuilds with the exact manual document/version retained.
6. **BardWiki equal-revision reads could regress terminal state (J4).** Job
   transitions do not necessarily advance the domain revision. A per-chat read
   epoch now covers workspace and invalidation reads in addition to session/scope
   fences. Old-code focused failure: `/tmp/phase05-bardwiki-read-reproduction.log`.
   The native old build also restored Pending after Completed at the same revision
   (`/tmp/phase05-bardwiki-browser-reproduction2.log`).

### Candidate dispositions and scope limits

- A captured translator-settings variant is not silently reinterpreted as the new
  configuration: hashes/projection eligibility and job/source/prior-value fences
  remain authoritative. No change to settings-variant semantics was justified.
- Manual translation process restart is a limitation of its supported execution
  contract, not a durable queue silently promised by bootstrap. The audit proves
  committed-output reopen and explicit retry; it does not claim unfinished provider
  work resumes after process loss. Generation effect resumption is bounded by the
  Phase 02 contract and does not convert a capped detached translation into a queue.
- Logical-ID-only server callbacks were inspected. A concurrent old/new worker
  mutating the same recreated running row is outside the supported single-worker
  execution. Executed schedules recreate a job after deadline retirement and prove
  that old provider callbacks cannot match it; client instance/stream tests remain.
- A cancelled job is not automatically retried. Memory offers its explicit enqueue
  API, and BardWiki a fresh rebuild. A source-changed rebuild's old checkpoint
  remains invalid; the strengthened test verifies fresh-build recovery. Manual
  review obligations on old receipts are not discarded merely by declaring a
  rebuild complete. Existing receipt inversion/manual-review tests are retained.
- Contextual embedding shares a provider call so cancelling one job does not abort
  a valid sibling; the provider deadline bounds a fully obsolete call. Worker stop
  intentionally drains current work before SQLite closes. It is not a force-kill
  API. No claim is made for overlapping worker processes.

### Validation ledger

Baseline focused translation targets passed: message client refresh, greeting
projection, message registry, server translation and greeting store. Eight memory/
BardWiki targets also passed before edits; file/command/log mapping is in
`/tmp/phase05-baseline-results.json`. An initial multi-target `pnpm test --` command
was rejected by the one-target runner and rerun correctly per file; it did not
execute tests or reveal a runtime failure.

Focused final checks passed: client translation refresh (9), raw translation
(33), message/greeting server lifecycle (12), command routes (242), memory embed
(31), summary (29), memory refresh (17), BardWiki read (11), rebuild (8), and worker
(3). Retained registry/projection/worker/receipt baseline checks are supplemented
by the broad run below. No tests/assertions were removed.

`pnpm test:agent` passed all seven lanes on the final runtime patch in 2m 56.3s
(`/tmp/phase05-agent.log`): server/browser typechecks and architecture inventory,
test topology, 51 current documents, frontend check (zero errors/warnings),
**9,550 frontend tests** across 729 files, **4,396 server tests** across 232 files,
and the browser-smoke build. Each test suite retains three existing skips outside
required J1–J7 evidence. This broad run was warranted because provider awaiting,
job reconciliation and resource ordering change shared behavior across families.
No runtime or fixture correction was needed after this final validation began.

All **20 selected Chromium journeys passed** against that fresh build in 1.3m
(`/tmp/phase05-browser-final.log`): four new background-job journeys, one retained
BardWiki workspace journey, five connected-reader generation journeys and ten
resource-hydration journeys. The BardWiki journey passed completion-write retry
with one provider call, rejection of the older equal-revision pending snapshot,
manual editing, another successful rebuild with both documents intact, and reload.

```sh
pnpm test:agent
VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/backgroundJobRecovery.spec.ts \
  server/fastify/browser-smoke/bardWikiLifecycle.spec.ts \
  server/fastify/browser-smoke/connectedReaderGeneration.spec.ts \
  server/fastify/browser-smoke/resourceHydrationRecovery.spec.ts
```

Focused commands used `pnpm test -- <one test file>` for each named owner above;
the server raw-translation and command-route targets are
`server/fastify/__tests__/rawMessageTranslation.test.ts` and
`server/fastify/__tests__/commands.test.ts`. Final documentation validation covers
51 current files and nine explicit nested-plan/index files. Scoped Prettier and
`git diff --check` passed. `pnpm test:all` was not run.

Fixture corrections were kept distinct from defects: translation initially used
an incorrect composer selector and a profile provider that did not use the fixture
endpoint; the local custom API provider works. A reload/teardown race was corrected
by waiting for actual app readiness and closing the HTTP listener before its
connections. Memory offline simulation correctly closed the writer modal, so the
lost-event schedule instead drops just the terminal SSE frame at the HTTP response
boundary while retaining the real connection. BardWiki's details selector was
corrected before the successful old-read reproduction. Early memory regression
cleanup was fixed to drain the held test task before closing its database; clean
reproductions retain the same primary failure without teardown errors.

Only disposable SQLite/native browser fixtures are used. Reopen/reconstructed
workers are in-process restart evidence, not external crash/power-loss testing.
External provider service behavior, model quality, physical suspension,
non-Chromium platforms and the full performance matrix are outside this bounded
validation. No manual dev server was started. Phase 06 remains unstarted.

### Final handoff

J1–J7 are complete under each family's supported persistence and cancellation
contract. The six demonstrated in-scope findings are repaired; no required
acceptance gap remains. Phase 05 runtime/tests/docs are uncommitted on
`86d07b1da7e39bff9f0ac0f9769f0697724c507c`. Relevant checks must be rerun if those
sources change; ephemeral logs above supplement the checked-in cases and ledger.

Next phase: read [Phase 06](06-import-and-restore.md), recheck `git status --short`
and source at entry, then inventory import/restore replacement and publication
boundaries. Use isolated database lineage/publication fixtures and disposable
storage for that work. Phase 06 has not been started. Physical suspension and
non-Chromium verification belong to the optional device follow-up (repeat the
native recovery journeys there); external crash/power-loss depth belongs to the
optional process-recovery follow-up (stop/restart a disposable external server at
those boundaries). Neither is counted as verified by the in-process evidence.
