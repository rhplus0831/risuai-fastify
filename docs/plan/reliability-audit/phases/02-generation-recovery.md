# Phase 02 — Generation Submission and Recovery

State: **Not started; follows phase 01.** Use [the common audit method](../PLAN.md#audit-method).
This is a bounded outline; complete its coverage matrix at phase entry.

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

Assessment: not started. Findings: none confirmed. Validation: not run.
Populate the common matrix for G1–G7 with test dispositions and actual evidence.
Known planning limits: compatibility browser coverage and repeated restart/effect
receipt loss require assessment; in-process harness restart does not prove an
external process crash. Close only under [the plan's completion rules](../PLAN.md#phase-completion-and-handoff).
