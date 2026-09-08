# Remote Diagnostics Status

Date: 2026-09-08

Stable scope: [plan](PLAN.md). Source owners: [inventory](inventory.md).

## Current Cursor

All five phases are locally accepted. The final complete `pnpm test:agent`
profile passed all seven lanes, and the built Chromium reader/upload/HTTPS
helper journey passed. The intact plan is archived here; current behavior and
operator setup live in the [observability guide](../../../docs/structure/development-and-observability.md#remote-support-diagnostics).
No production deployment, production connection, or real credential provisioning
was performed. See [final acceptance](#final-acceptance-and-handoff).

## Phase Router

| Phase                                     | Status   | Acceptance evidence                                                                                                 |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 0. Contract and inventory                 | Accepted | Four successful Luna reviews reconciled; finite contract recorded                                                   |
| 1. Remote access                          | Accepted | Separate verifier, live-route denial matrix, real HTTPS helper and fixed errors                                     |
| 2. Diagnostic depth and durability        | Accepted | Exact v2 families, bounded worker journal, scoped provider/persistence/Lua evidence and actual HTTPS recovery proof |
| 3. Browser evidence                       | Accepted | Exact ingestion, publisher lifecycle, rich state/plugin facts, manual merge and real built Chromium/HTTPS proof     |
| 4. Verification and operational readiness | Accepted | Combined failure/privacy/access proof, operator guide, final aggregate and browser journey                          |

## Decisions and Scope

- 2026-09-08: The user wants richer debugging evidence while keeping chat and
  prompt preset text inaccessible to the agent. Extend the existing sanitized
  Diagnostics channel; raw request/history/generation/Lua artifacts remain
  outside agent access.
- 2026-09-08: Add on-demand production retrieval from the development
  environment with a separately provisioned diagnostics-only credential. Use
  a random bearer token over HTTPS with server-side digest storage. Preserve
  manual export as fallback; no per-read manual export workflow is required.
- 2026-09-08: Use a stable plan, mutable status, and five bounded phases. Phase 1
  must be useful with existing server events before later evidence expansion.
- 2026-09-08: The initial request produced the planning package. The subsequent
  implementation request authorized completing all five phases; production
  deployment, real credential provisioning, and production access remain outside
  this local acceptance task.
- Default field policy excludes original text, content hashes, raw domain IDs,
  arbitrary labels, and previews. Retain approved counts/categories and
  generated diagnostic correlation references only.

## Planning Verification Ledger

| Scope                       | Result                                                                                                                                                    | Limit                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Planning source review      | Existing collector, schemas, auth, traces, metric adapter, and browser-local storage inspected at the opening source                                      | Static local evidence; remote version/configuration unverified          |
| Parallel source cross-check | Two Luna reviews succeeded; auth/route and browser/instrumentation findings reconciled against source                                                     | Read-only planning input; no implementation acceptance                  |
| Current documentation       | `pnpm check:docs` passed for 49 current documents                                                                                                         | The default set excludes active plan directories                        |
| Plan package                | [Explicit plan/index check](phases/README.md#plan-document-validation) passed for all 10 documents; explicit Prettier check and `git diff --check` passed | Documentation integrity only; no feature tests or production checks run |

Record completed slices here with source/commit when available, affected
boundaries, exact commands/results, acceptance criteria satisfied, residual
limits, and the next action. Update stable contracts in the plan and phase
documents when a decision changes them; do not duplicate execution logs there.

## Implementation Decisions and Evidence

- The implementation request authorizes feature work; the planning-only scope
  above is historical. No production connection, deployment, or real access
  provisioning is needed for local acceptance.
- Four read-only Luna reviews completed successfully (auth/trace,
  journal/correlation, browser contracts, coverage producers). Source confirmed
  separate app auth, trace capture before validation, explicit route limits,
  UID eviction/background gaps, and sentinel-zero timing in bootstrap and prompt
  assembly. Browser worker suggestions for manual-only upload and content-digest
  identity were rejected: the approved plan requires opted-in automatic uploads
  and independent generated event identities.
- Phase 0 freezes authority, schema negotiation, retention/query/queue limits,
  credential placement/lifecycle, and first source/test owners. Journal snapshot
  pages use sequence ordering and bounded immutable snapshots; no clock-causality
  claim. No phase implementation is accepted solely from the source review.

Closed locally. Deployment and real credential provisioning are separate
operator actions; use the current guide linked above for setup and rollback.

### Phase 1 credential and read slices

- Credential lifecycle committed as `8baed4751`; 31 focused synthetic tests and
  targeted strict TypeScript passed. No real credentials provisioned.
- Independent support GET, v1 envelope, finite shared query parser, immutable
  cursor pages, 300-event volatile source, fixed errors/access outcomes, and
  diagnostic namespace trace/log exclusions implemented. Auth denial derives
  from every registered protected route; deliberate public behavior is retained.
- `pnpm test -- server/fastify/__tests__/remoteDiagnostics.test.ts`: 6 passed.
  Protocol grammar/privacy: 3 passed. Reviewed route catalog: 5 passed.
  Existing route protection, collector, tracing, and config suites: 55 passed.
  `pnpm exec tsc -p server/fastify/tsconfig.json --noEmit` passed.
- Architecture inventory update contains only the reviewed 108→109 route/policy
  counts; inventory validation passed. Current docs (49), explicit plan docs
  (10), and relevant Prettier checks passed.
- Validation exposed and fixed delayed HTTP collection behind asynchronous raw
  trace writes and a rate-limit error mapping that initially returned 500.
  The denial test now enumerates live routes rather than abstract route families.
- HTTPS helper tests are complete in a separate pending slice. The cross-layer
  aggregate remains required after implementation/self-review and will be run
  on the completed final feature, together with final-source combined proof.

### Phase 1 helper acceptance

- Read integration committed `6d264ef0c`; real helper and HTTPS tests committed
  `06cb0ac72`. The helper's full 29-test suite passed, followed by two additional
  focused regressions (unavailable server and unverified source coordinates).
  Targeted strict utility TypeScript and Prettier passed.
- Phase 1 bounded server-only retrieval is locally accepted. Configuration stays
  opt-in; no production hostname or secret was used. Source coverage remains
  explicitly volatile/server-only at this phase. Phase 2 begins with exact v2
  families, correlation/timer fixes, and dedicated bounded persistence.

### Phase 2 implementation and focused evidence

- Exact v2 families, version negotiation, operation scope and measurement fixes:
  `3069ecf89`. Journal: `df65ef641`. Generation/persistence/recovery:
  `6a8dbca18`. Provider transport: `c24d6a061`. Lua hooks: `dc008fe50`.
  Runtime integration before startup recovery: `23907ebb2`.
- Protocol families: 16 focused tests; scoped context: 4. Journal: 21, including
  native-worker restart, strict restoration/purge, retention/deduplication,
  locked/full/corrupt/stalled storage, queue bounds and finite close.
- Provider instrumentation: 20 focused tests and 428 existing adapter/dispatch
  tests. Generation/recovery: 282 tests including five fetched-evidence
  integrations. Lua: 13 diagnostic, 64 runtime, and one ownership test.
  Targeted Fastify TypeScript and formatting passed at these slices.
- Runtime integration checks: 15 collector/context/remote tests, then three
  dedicated runtime regressions proving correlation after 2,001 later requests,
  lineage/cursor fencing, and unchanged application success/revisions when
  diagnostic storage is unavailable. Reset reads report unavailable until the
  worker acknowledges the new epoch; pending count alone does not mean ready.
- Synthetic 1,024-record journal profiles took 15/32 ms for bounded admission
  and 116/124 ms total with zero drops/rejections. Lowered count/byte limits
  retained 200 records/52,425 bytes and 91 records/64,908 bytes respectively.
  These are local workload observations, not production latency guarantees.
- Startup initially lost synchronous recovery while loading the private key;
  the runtime now registers immediately and buffers at most 256 safe records
  while key loading is bounded to one second. Application recovery never waits.
- The real provider/HTTPS-helper journey exposed a distinct partial-failure
  recovery operation-reference mismatch; the fix is committed as `65d7f5a37`. Recovery now uses the authoritative
  job-to-operation association for diagnostics while preserving persistence
  semantics. Seven generation regressions and the actual HTTPS journey pass.

### Phase 3 bounded decisions and work

- Tightened the initial browser defaults from 50 to 32 events per batch and
  from 300 to 256 pending, matching journal admission limits. Retained local
  report history remains 300; cadence/age/attempts remain 5 seconds/5 minutes/3.
- Browser upload has separate bootstrap opt-in and ordinary reader auth. The
  manual panel negotiates v2 and merges by generated source/event identity;
  old responses and offline selectable-text export remain supported.
- Manual report merge/schema compatibility: 3 focused tests. Existing panel:
  4 tests. Manual/server read and collector: 12 tests. Fastify TypeScript passed.
  Ingestion, publisher lifecycle, and actual browser proof are recorded below.

### Phase 3 focused acceptance evidence

- Shared batch contract `0346dc547`, ingress `4f741baf6`, and bounded browser
  plugin contract `8eb0435a2`. Server reader/admission/restart/privacy: 8 tests;
  browser protocol: 5; route protection: 17; Phase 12 inventory: 4; route
  catalog: 5; import boundaries: 2. Protocol/server TypeScript passed.
- Publisher `f433661f1`: 27 lifecycle, 29 bootstrap, 8 auth, and 5 existing
  collector DOM tests. Includes pre-bootstrap capture, frontend build identity,
  opt-out/auth loss, stale cancellation, finite backoff/expiry, malformed stored
  deadlines, reload/duplicate-tab identities, queue/batch limits, and no loops.
- Browser state producers `aabfc448c`: 438 focused ownership, hydration, cache,
  stale-response and durable-outbox tests. Outbox age preserves original
  admission time through replacements; existing rows use their prior update time.
  Browser V3 output listener summary `21c0ddb47`: 6 focused callback/privacy/
  cancellation/session tests, with unmeasured host/content changes omitted.
- Manual server negotiation `965194a5f` and merged reports `22b2ccb03` preserve
  old responses, local/offline export and selectable text. The 3 report, 4 panel,
  and 12 server/manual collector tests pass.
- Initial real Chromium journey passed: a foreign writer stays latched while
  an authenticated reader records network/runtime failures, uploads them, and
  retrieves matching browser/server request UIDs via the actual verified HTTPS
  helper. Plain/Base64/hex content and credential canaries are absent and domain
  revision/writer state is unchanged. Latest source rebuilt with `pnpm build:smoke`; the strengthened journey
  passed again (25.6 seconds), including a fresh upload after reload, retained
  event deduplication, and fetched aborted-network evidence.

### Phase 4 combined proof and final review

- Actual helper/provider/recovery/Lua journey `0c1a18584` passed. It uses a local
  SSE provider disconnect after partial content, a SQLite trigger rejecting the
  assistant commit, restart with successful recovery, and the real credential
  and HTTPS CLI path. Fetched evidence alone identifies provider dispatch/failure,
  original request/operation/attempt, failed commit and recovery, without provider
  replay. Serialized journal rows and helper decoded/error output contain no
  original or known encoded canaries. Rejected diagnostic transport is tested
  while body-capable tracing/full-prompt flags are enabled.
- Provider gaps now include rejected read waits (`237808327`); 20 diagnostics
  tests pass. Root frontend type checking required explicit done-state narrowing
  (`cb31b6640`). Three unrelated existing static-test inference errors were fixed
  with string-array annotations (`99a93e5fd`); 53 existing static tests passed.
- Artifact review found real static child/index symlink exposure despite root
  placement validation. Resolved-target protection `24d0bd8ee` and proof
  `ba8dfc234` pass: 3 artifact and 12 existing static tests plus server TypeScript.
  Tests cover legacy storage/assets/static, server snapshot files/tables,
  `.risu`, ZIP bundle and binary exports, private nested/index symlinks, and
  retained ordinary public symlink behavior.
- Journal format guard `d3d1f4d71`: 23 focused tests, including byte-preserving
  refusal of newer versions and exact validation before stamping old unversioned
  stores. Browser and support features remain separately disabled by default.
- Final privacy review identified malformed encoded diagnostic URLs rejected
  before Fastify onRequest hooks. Fixed router error `1f1507d80` and tolerant ASCII namespace classification
  preserve fixed/no-store diagnostic errors before normal hooks. Protocol and
  actual HTTPS regressions `c4a7e631c` pass. Review also caught a double decode
  in static target validation; the literal-filename correction and encoded
  symlink regression passed in `245da208e`.
- Current docs validation (49) and explicit plan/index validation (10), Prettier,
  and whitespace checks pass at this documentation update. Final cross-layer
  aggregate and archive results are recorded in final acceptance below.
- Final file-boundary commits: canonical root overlap and retained/off protection
  `9f7364f51`, resolved-target guards for asset GET/HEAD and legacy reads
  `8c4dcd22a`, metadata asset copy/fallback symlink rejection `414f4538e`, and
  exact regressions `fff7f452e`. Artifact boundary (8), backup worker (20), and
  asset/storage/remote diagnostics (60) tests pass, as does server TypeScript.
  Ordinary public aliases remain readable. Generic nested save/extras symlinks
  are retained without following their targets; metadata asset sources fail
  before copying. Retained diagnostics stay protected with collection disabled.

### Final aggregate corrections

- The first aggregate passed all 718 frontend files (9,181 tests, 3 skipped),
  the frontend typecheck with zero errors/warnings, documentation/topology, and
  the smoke build. It exposed the browser upload route's two stale inventory
  counts, an outdated off-state static-placement expectation, and the standalone
  journal test's three-second cold subprocess envelope under 235 server forks.
- Reviewed inventory changes were exactly shared catalog and server policy
  counts 109→110, with no runtime edges or other manifest changes (`546857132`).
  The retained-file test now rejects unsafe placement after disablement and
  accepts disabled collection without artifacts (`d68e52253`, 8 tests pass).
  The journal harness allows ten seconds for Node/TypeScript cold startup
  (`a9251beae`, 23 tests pass); production one-second request/close deadlines
  and stalled-worker assertions are unchanged.
- The newly reachable browser-smoke typecheck exposed a fixture environment
  inference error. Explicit `NodeJS.ProcessEnv` in `ea0052996` preserves behavior;
  the complete `pnpm check:server` now passes protocol/shared-core checks,
  architecture inventory, Fastify, and browser-smoke typechecking.
- Final-production-source built Chromium/HTTPS proof passes (27.7 seconds,
  29.3 seconds total). Authenticated reader uploads, actual helper retrieval,
  failure/request correlation, reload deduplication, canary exclusion, and
  unchanged writer/revision state all pass. The subsequent fixture type
  annotation does not change execution.
- Explicit Prettier validation of every changed source/document file and
  `git diff --check` pass. The final complete aggregate also passes as recorded
  below; archive checks cover the moved documents explicitly.

### Final acceptance and handoff

- Final implementation source: `ea0052996`. `pnpm test:agent` exited 0 in
  3 minutes 28.5 seconds. All seven lanes passed: server/browser-smoke typechecks
  (including protocol, shared core, and architecture inventory), topology,
  current documentation, frontend tests, frontend check, server tests, and the
  smoke build. Frontend: 718 files, 9,181 passed/3 skipped. Server: 235 files,
  4,356 passed/2 skipped. Frontend checking reported zero errors and warnings.
- `pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/remoteDiagnostics.spec.ts`
  passed the focused real Chromium/HTTPS journey on the final production source.
  The aggregate rebuilt that unchanged production source successfully afterward.
- Current documentation validation covers 49 files. The explicit archived
  plan/index validation covers 11 documents, including both active/archive
  indexes. Explicit Prettier checks cover all changed source/documents and the
  intact archive; whitespace checks pass.
- All phases are accepted using fresh disposable synthetic data, local HTTPS
  credentials, and mock providers. Combined failures are identifiable using
  fetched evidence alone; exact contracts and decoded/serialized canary checks
  exclude content and credentials. Dedicated support authority, rejected
  transport privacy, file/backup isolation, application revisions/writer state,
  v1/manual compatibility, bounded loss, and failure isolation have recorded proof.
- No known implementation work remains. Production deployment/configuration,
  reverse-proxy TLS behavior, real workload overhead, and real incident coverage
  remain unverified. No production access or real secrets were used.
  `pnpm test:all` was not requested or run; its full compatibility, coverage,
  scale, performance, and full-browser lanes remain with the user/CI.
- The intact planning package moved from the active-plan directory to this
  archive after local acceptance. Current architecture/test/operator guides own
  shipped behavior. Support reads and browser uploads remain separately opt-in;
  disabling them preserves the manual Diagnostics workflow and domain data.
