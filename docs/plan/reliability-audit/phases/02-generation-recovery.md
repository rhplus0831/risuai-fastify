# Phase 02 — Generation Submission and Recovery

State: **Complete.** Use [the common audit method](../PLAN.md#audit-method).
The completed entry inventory and execution evidence are below.

## Scope and Source Map

Trace send, continue, regenerate, retry, cancel, retained-intent replay,
reattach/reload, and restart. Inventory supported compatibility endpoints and
their actual callers separately; determine reachable paths before prescribing
compatibility coverage. Preserve existing hard failures for unsupported shapes.

Guides: [generation client](../../../../src/docs/generation-client.md) and
[generation tests](../../../tests/prompting-generation-and-streaming.md).

<!-- prettier-ignore -->
| Boundary | Source owners | Existing tests |
| --- | --- | --- |
| Accepted operation, numbered attempts, retry/cancel | `server/fastify/src/generationOperations.ts`, `server/fastify/src/routes/generationOperations.ts` | `server/fastify/__tests__/generationOperations.test.ts`, `server/fastify/__tests__/generationOperationsStartup.test.ts` |
| Compatibility admission, job execution, finalization | `server/fastify/src/routes/generationChat.ts`, `server/fastify/src/generationJobs.ts`, `server/fastify/src/generationFinalizationRetry.ts` | `server/fastify/__tests__/generation.chat.test.ts`, `server/fastify/__tests__/generationFinalizationRetry.test.ts` |
| Client staging, recovery obligations, reattachment | `src/ts/server/generationOperations.ts`, `src/ts/process/generationRecoveryObligations.ts`, `src/ts/process/reattach.ts`, `src/ts/process/index.svelte.ts` | `src/ts/server/generationOperations.test.ts`, `src/ts/process/__tests__/generationRecoveryObligations.test.ts`, `src/ts/process/__tests__/generationRecoveryLifecycle.dom.test.ts` |
| Completion effects and visible settlement | `server/fastify/src/generationEffects.ts`, `src/ts/process/generationEffectLedger.ts` | `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts` plus affected effect-owner tests selected at entry |

The browser spec already exercises lost/malformed accepted responses, retry
response loss, targeted continuation, Stop, reload/restart, viewer loss, concurrent
chats, and queued finalization. Its submit helper faults the response after
`route.fetch()` has reached the real server. Reuse this acceptance proof.

## Required Acceptance and Candidate Schedules

<!-- prettier-ignore -->
| ID | Schedule | Observable acceptance |
| --- | --- | --- |
| G1 | Server commits send/targeted generation; response is lost or malformed; reconnect/reload follows. | Stable operation/attempt identity, one committed user append where applicable, no automatic duplicate submit, and eventual exact transcript settlement. |
| G2 | Recovery snapshot A starts; a newer obligation B is created; A returns empty or terminal. | Evidence covering A cannot clear B. A terminal observation remains unresolved until its required transcript reconciliation succeeds. |
| G3 | Retry reserves attempt B; old attempt A emits/returns; cancellation races before and after acceptance. | Exact-attempt fencing, idempotent supported retry, correct cancel-before-acceptance behavior, and honest visible stopped/retryable/failed state. |
| G4 | Continue/regenerate target changes before admission or delayed finalization. | Stale targets cannot overwrite newer transcript; user receives a recoverable outcome. |
| G5 | Chat A reconciliation fails while B succeeds; navigation changes during both. | Recovery, visible activity, target, and settlement remain independent for each chat. |
| G6 | Process-local job expires or server restarts during launch/finalization; effect receipt or snapshot delivery fails. | Durable state offers the supported recovery path without inferring provider completion from job absence; committed results and ledgered durable effects do not duplicate. |
| G7 | All required transcript/effect settlement succeeds; foreground/timers fire afterward. | Completed obligations stop retrying and idle foreground avoids unnecessary bootstrap. |

Classify durable, ephemeral, and recomputed effects before asserting repeat
behavior. A provider may already have processed an ambiguous attempt; assert
the application's supported retry/redispatch contract and observable invocation
count in the fixture, without promising universal exactly-once provider execution.

## Execution and Validation

Complete acceptance/identity first, then targeted modes and cancellation,
followed by restart/finalization/effects and remaining supported compatibility
paths. Map existing tests to G1–G7 and strengthen missing real interactions.
Keep modern/compatibility distinctions explicit; coverage on one endpoint is not
proof of the other. Use the smallest focused targets from the table and:

```sh
pnpm test -- server/fastify/browser-smoke/acceptedSendProtocol.spec.ts
```

Use [phase 01's browser command pattern](01-connection-recovery.md#validation-selection)
to reuse a fresh build when selecting several specs. Follow the common broader
validation rule for operation, outbox, event, or transcript contract changes.

## Execution Record

### Baseline and boundaries

- Execution began at `7ede21ee99b194598f4b761a9941a4bcfdae6c45` with a clean
  worktree. This revision commits Phase 01; its connection evidence is reused.
  The Phase 02 patch was subsequently committed as
  `a449e97908d41aed7f04442c260f0ce56194dd43` before Phase 03 began.
  No external production incident is claimed.
- Four independent read-only Luna workers assessed browser recovery, server
  operation admission, effects/restart, and compatibility/browser coverage. All
  succeeded. Parent review reconciled their candidates against current source
  and executable regressions; worker conclusions alone are not verification.
- Browser fixtures use real Chromium, Svelte application, native HTTP, Fastify,
  and disposable SQLite. Provider generation is deterministic and gated. Memory
  workers are disabled; their lifecycle belongs to Phase 05. Restarts close and
  reopen the app/registries on the same database and port inside the test process.

### Entry and evidence inventory

<!-- prettier-ignore -->
| Entry / ownership | Real evidence and injected boundaries | Disposition |
| --- | --- | --- |
| Composer send; DevTool, commands, multisend, plugin API accepted sends | `acceptedSendCoordinator.svelte.ts`, `serverBackedSendChat.ts`, and `server/generationOperations.ts`; browser composer exercises atomic append/operation/attempt, outbox and transcript. `rawGenerationCallerAllowlist.test.ts` checks sibling callers converge on the capability-gated coordinator. | Keep caller guards and native accepted-send journeys; strengthen completion-before-retry-recovery. |
| Continue and regenerate | Target-preserving protocol admission, exact operation stream, strict terminal hydration. Native `durableGeneration.test.ts` and `generation.chat.test.ts` cover stale targets, preflight and delayed persistence; browser Continue loss plus reroll/reload coverage. | Keep distinct target fences; extend lost-response browser case to Regenerate and assert canonical result identity. |
| Explicit Retry, retained-intent replay, Stop and dismiss | Numbered attempts and persisted retry IDs; cancellation tombstone/operation control; real route/SQLite retry and submit/cancel arrival races. Browser retries, stopped partials and mobile Stop; focused client staging/ownership fences. | Strengthen terminal retry receipt and keep pre/post-acceptance cancellation schedules. |
| Foreground and reload recovery | Real obligation, operation projection and reattach modules in DOM composition; network, outbox storage and hydration boundaries substituted. Browser loss/reload/expiry uses real outbox and resource hydration. | Add exact retry replay plus held terminal hydration/newer obligation; mixed A/B transcript reconciliation. |
| Effects | Server SQLite ledger, claims, leases, receipts; client ledger tests mock HTTP/auth and clock. Recovered-effects tests mock domain effects/hydration but retain coordinator and generation-scoped receipts. Browser IGP transfer keeps actual append/receipt transaction; held plugin receipt reaches native server first. | Strengthen hung controls/cleanup and independent chat settlement. |
| Restart/finalization | Native startup sweep and durable job suites, isolated journal faults, browser reload/expiry and app close/reopen. | Extend queued-finalization browser case to repeated restart before and after commit. |
| Compatibility durable chat | `/api/v1/generate/chat` supports send/continue/regenerate and job-addressed viewing/cancel; it creates protocol-0 durable operations. Real browser callers select it when capability v1 is absent. | Add native fallback send response-loss/reload journey; preserve route-level targeted/cancel/shape cases. |
| Inline preview/completion | Preview/preview_prompt use non-durable chat; `requestChatData` routes eligible requests through `/generate/completion` and preserves explicit unsupported-provider/body failures. Dedicated `/generate/preview-prompt` has no live browser adapter caller, per manifest. | Keep route/adapter tests; no invented durable retry or browser coverage for the unused dedicated preview endpoint. |

### Acceptance ledger

<!-- prettier-ignore -->
| ID | Required outcome and executed evidence | Result / limitation |
| --- | --- | --- |
| G1 | Existing real browser lost/malformed send acceptance, pending-before-acceptance, Continue, mid-stream/completed reload. Added lost Regenerate, completed Retry recovery, and compatibility initial-response loss/reload. Native tests preserve one user append and idempotent request replay. | Focused/browser regressions verify stable operation/result identity, exact transcript and provider counts. Compatibility POST is not automatically resubmitted. |
| G2 | Obligation unit tests protect capture/version/scope; lifecycle DOM case holds terminal retry hydration, creates a newer same-operation cancellation obligation, then releases hydration. | Old work settles only its captured obligations; new cancellation remains uncertain. Matching terminal evidence cannot bypass required hydration. |
| G3 | Native cancellation tombstone/submit race, stopping before dispatch, exact-attempt retry replay and stale advisory Stop; client old-attempt SSE/retry-response and writer-loss fences; desktop/Pixel stopped-partial browser journeys. | Retained Stop is acknowledged honestly; no duplicate user append, stale attempt state or success effects after cancellation. New retry receipt is exact, separate from stream descriptors. |
| G4 | Existing stale continue/regenerate target and delayed-finalization tests; browser lost targeted submissions and reroll persistence. | Fixed terminal Regenerate result identity; target, generated result and displayed transcript agree. Existing admission/persistence fences retained. |
| G5 | Existing concurrent-chat browser navigation; added real-module terminal A-fails/B-succeeds reconciliation and effect hydration/claim failure cases with generation-scoped receipts. | Successful B settles; A retains work and is the only chat rehydrated on retry. Native navigation/browser and faulted module evidence are complementary. |
| G6 | Native startup/expiry/journal suites, assembly-abort regression, explicit retry, browser job expiry, IGP accepted append across transfer, held committed receipt, repeated queued/settled restarts. | One application result/effect receipt per supported identity; actual external process crash and universal provider exactly-once execution are not claimed. |
| G7 | Existing bounded reattach/foreground tests; final browser truth requires no jobs/finalizations/effects/outbox. Held receipt release followed by foreground causes no new effect requests; focused lease/auth/control tests leave no timers. | Settled work stops retrying. Failed/uncertain work stays recoverable and is not mislabeled settled. |

### Findings and regression detection

<!-- prettier-ignore -->
| Finding | Reproduction / violated contract | Repair and adjacent-path review |
| --- | --- | --- |
| F1 — effect control waiter never settles | Hold claim fetch past 30 seconds: new test fails `settled: false`; receipt/body variants exercise the same boundary. A held control could retain the local in-flight effect and renewal work. G6/G7. | Bound auth, fetch and JSON together; abort on writer loss; fence late completion. Claims, receipts and renewal share the helper, with one renewal in flight and cancellation at settlement. A native committed receipt held beyond the deadline now releases the UI without a second effect dispatch. |
| F2 — one failed chat prevents later effect recovery | A hydration throws; old coordinator never calls B hydration. Regression fails with only `chat-a`. G5. | Continue through independent generations, retain unresolved entries, and remove only settled entries from the exact captured snapshot. Verify both hydration and claim failures; receipt fixtures now distinguish generation identity. |
| F3 — completed retry remains retained forever | Real Retry accepted, response lost, provider completes before foreground. Old browser reaches `completed` with `outbox: 1`; idempotent replay lacks a live `currentAttempt` and cannot satisfy identity. G1/G3/G7. | Retry route returns `acceptedRetryRequestId` after persisted acceptance/replay. Client validates it against the exact retained request, applies newest operation authority and transfers terminal work to strict hydration. Native replay after completion does not launch a third provider call. |
| F4 — pre-provider abort leaves durable live-chat claim | At real job `assembly_started`, inject the same unreasoned abort as registry deadline/GC and reject the await. Job becomes done but SQLite stays `owned_by_job`; regression expected `retryable`. G6. | Emit terminal settlement for aborted pre-provider assembly; no provider run is inferred. Follow-up send is admitted without restart. User Stop, provider-partial and deferred-persistence paths keep their distinct behavior. |
| F5 — Regenerate terminal result uses displaced row ID | Lost Regenerate acceptance recovers and persists the new row, but the browser terminal operation points to the prior target, so exact-result lookup fails. G1/G4. | Add optional terminal SSE `resultMessageId` from the durable operation and prefer it over the patch address. Keep older-server fallback, unchanged patch semantics, and old-attempt fences. Native browser now resolves the committed row. |

These are reproduced checkout defects under controlled fixtures, not assertions
about the source of an external incident. Tests failed against pre-fix behavior;
no historical-bug mutation is substituted for those reproductions.

A test-fixture timing issue also surfaced: targeted submission reports its error
dialog after activity cleanup. The browser helper now waits for that dialog
before dismissing it. Regenerate opens the candidate menu before New reroll, and
its result applies normal leading-whitespace trimming; the new test follows those
actual UI/processing contracts. Existing Continue assertions remain covered.

The first final combined browser run passed 25 cases; Pixel initial login hit the
unchanged 10-login/minute rate limit because all newly added browser contexts
shared loopback. The isolated lifecycle harness now models distinct devices with
per-page documentation-range forwarded client addresses and enables proxy trust
only in that fixture. Authentication, authorization and rate-limit policy remain
real and unchanged in production. The full selected browser matrix passed after
this fixture correction.

Worker candidates not accepted as additional defects:

- Failed effect receipts are terminal by server policy. A later claim returns
  `already_receipted`, which the client accepts as settled; no source-backed
  requirement permits automatically repeating a failed plugin/provider effect.
- Journal upsert with a reused generation ID and changed payload is an internal
  misuse candidate. Live generation jobs use fresh IDs and exact retained
  envelopes; no reachable duplicate-ID producer was established. No rewrite of
  the journal contract is justified by that hypothetical call.
- Compatibility stream addresses use unique job identity; modern attempt
  admission and cancellation are separately tested. Neither proof is presented
  as coverage of the other protocol's unsupported shapes.

### Validation record

Baseline at the execution revision: all 11 focused targets below passed, a fresh
`pnpm build:smoke` passed, and all 22 original browser journeys passed across
`acceptedSendProtocol.spec.ts`, `connectedReaderGeneration.spec.ts`, and
`rerollSwipePersistence.spec.ts`.

<!-- prettier-ignore -->
| Focused target (`pnpm test -- <path>`) | Baseline / strengthened result |
| --- | --- |
| `src/ts/server/generationOperations.test.ts` | 37 / 38 passed |
| `src/ts/process/__tests__/generationRecoveryObligations.test.ts` | 9 passed; final broader suite passed |
| `src/ts/process/__tests__/generationRecoveryLifecycle.dom.test.ts` | 5 / 7 passed |
| `src/ts/process/__tests__/reattach.test.ts` | 63 passed baseline |
| `server/fastify/__tests__/generationOperations.test.ts` | 5 passed baseline |
| `server/fastify/__tests__/generationOperationsStartup.test.ts` | 1 passed baseline |
| `server/fastify/__tests__/generation.chat.test.ts` | 185 passed baseline |
| `server/fastify/__tests__/generationFinalizationRetry.test.ts` | 6 passed baseline |
| `server/fastify/__tests__/generationEffects.test.ts` | 7 passed baseline |
| `src/ts/process/generationEffectLedger.svelte-node.test.ts` | 12 / 22 passed |
| `src/ts/process/recoveredGenerationEffects.svelte-node.test.ts` | 12 / 14 passed |
| `server/fastify/__tests__/durableGeneration.test.ts` | New abort regression failed old code; 79 passed with abort/retry changes |

Additional targeted browser executions passed the held-receipt, repeated-restart,
completed-retry, Regenerate-loss and compatibility-loss schedules. Final validation
passed on the runtime patch described above:

- `pnpm test:agent`: all seven lanes passed in 2m 44.8s. Frontend: 729 files,
  9,513 passed and three existing skips. Server: 232 files, 4,375 passed and three
  existing skips. The skips are outside required Phase 02 evidence. Svelte check
  reported zero errors/warnings; protocol, Fastify, browser, architecture,
  topology and current-doc checks passed. The smoke build passed in 20.9s.
- The final explicit browser selection: **26 passed** (20 lifecycle, five
  connected-reader generation, one reroll). It used the fresh build from
  `test:agent`, with no later frontend/runtime changes. Only the isolated
  forwarded-address fixture and documentation changed after the broader suite;
  its browser TypeScript check and the entire selected browser suite passed.
- Environment: Node v24.19.0, pnpm 11.23.0, Playwright 1.62.1,
  Chromium 151.0.7922.34; desktop and Pixel 7 emulation, disposable SQLite.
- Current-document validation passed 51 files; explicit nested plan/index
  validation passed nine files. Scoped TypeScript and plan Markdown Prettier
  checks and `git diff --check` passed. No required Phase 02 acceptance gap
  remains. The platform/depth limits below are deferred explicitly.

Final selection (use the fresh smoke build produced by the broader check):

```sh
pnpm test:agent
VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/acceptedSendProtocol.spec.ts \
  server/fastify/browser-smoke/connectedReaderGeneration.spec.ts \
  server/fastify/browser-smoke/rerollSwipePersistence.spec.ts
```

The broader suite is required because the fixes cross server operation lifecycle,
shared terminal SSE, browser outbox reconciliation and completion-effect owners.
`pnpm test:all` was not requested and was not run. Current documentation and
test guides were updated; no existing acceptance scenario was removed.

### Limits and handoff

Physical-device suspension/non-Chromium behavior reuses Phase 01's optional
platform follow-up. External-process crash/power-loss evidence is an optional
Phase 02 follow-up: run the same isolated restart/journal/receipt schedules in a
separate kill/relaunch harness and record process/platform details. In-process
close/reopen and synthetic aborts do not certify that behavior. Live-provider
billing or exactly-once invocation is outside the deterministic provider fixture.

Generation-related outbox identities are covered here; Phase 03 owns broader
mutation/optimistic-edit replay. Effect automation is covered through its ledger
and representative IGP composition; Phase 05 owns translation/memory/BardWiki
worker lifecycle. Phase 04 owns wider resource hydration beyond the strict
terminal reads verified here. Phase 03 is next: read
[its outline](03-outbox-and-optimistic-edits.md), inventory representative mutation
owners and their real/mocked boundaries, and reuse this operation/receipt evidence.
Recheck HEAD and current working changes before extending shared owners. No server
or test process is retained for the handoff.
