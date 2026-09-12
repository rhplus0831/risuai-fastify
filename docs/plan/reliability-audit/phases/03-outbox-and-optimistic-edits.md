# Phase 03 — Outbox Replay and Optimistic Edits

State: **Not started; follows phase 02.** Use [the common audit method](../PLAN.md#audit-method).
Complete the detailed owner/coverage matrix at entry.

## Scope and Source Map

Start with one settings/runtime edit through visible feedback, durable dispatch,
Fastify command/receipt, response loss, replay, and reconciliation. Then exercise
one draft-bearing editor, preferably the composer for retained visible text or
the module editor for encrypted baseline/rebase behavior. Add a representative
reorder/delete/multi-step owner only when it has a distinct unverified contract.

Guides: [durable mutations](../../../structure/durable-mutations-and-recovery.md),
[editing tests](../../../tests/domain-mutations-and-editing-bridges.md), and
[persistence tests](../../../tests/persistence-commands-and-events.md).

<!-- prettier-ignore -->
| Boundary | Source owners | Existing tests |
| --- | --- | --- |
| Stage, scope, dispatch marker, replay ordering | `src/ts/server/pendingMutationOutbox.ts`, `src/ts/server/durableMutationDispatch.ts`, `src/ts/server/pendingMutationReplay.ts` | `src/ts/server/pendingMutationOutbox.test.ts`, `src/ts/server/pendingMutationOutbox.crossTab.test.ts`, `src/ts/server/pendingMutationOutbox.reader.test.ts`, `src/ts/server/pendingMutationReplay.test.ts` |
| Receipt and accepted/retained/rejected outcomes | `src/ts/server/commands.ts`, `server/fastify/src/commandMutationReceipts.ts`, `server/fastify/src/commands/mutations.ts` | `src/ts/server/durableMutationDispatch.test.ts`, `src/ts/server/durableMutationTerminalRejection.test.ts`, `src/ts/server/commands.test.ts` |
| Rollback, projection, scope and newer drafts | `src/ts/server/staleStateGuards.ts`, `src/ts/server/writerDraftRecovery.ts`, `src/ts/server/moduleEditorDraftStore.ts`, `src/lib/ChatScreens/DefaultChatScreen.composerDrafts.ts` | Corresponding owner tests; `src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts` for visible restoration |
| Assembled persistence and replacement | Actual settings/editor UI owner selected at entry | `server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts`, `server/fastify/browser-smoke/visibleStateRecovery.spec.ts` |

Existing tests cover staging-before-send, cold recovery, replacement/CAS races,
stale role generations, parked receipt acknowledgements, terminal rejection,
and rollback fences. The browser recovery matrix already includes real
settings/runtime response-loss replay. Broader editor outcome coverage remains
an assessment task; select the precise UI owner and server route before editing.

## Required Acceptance and Candidate Schedules

<!-- prettier-ignore -->
| ID | Schedule | Observable acceptance |
| --- | --- | --- |
| O1 | Storage staging fails, transport fails before evidence, or server returns a malformed 2xx. | Visible outcome distinguishes failed persistence, retained queued intent, and proven acceptance; no false saved state. |
| O2 | Server commits; response is lost; reconnect/reload replays; receipt acknowledgement fails. | Stable mutation identity, one committed effect/revision for supported replay, eventual cleanup, and correct rendered value. |
| O3 | Predecessor is transient/terminal while a newer successor waits; replacement races a dispatch marker. | Required order is retained, successor intent is not silently deleted/overtaken, and explicit terminal rejection reconciles correctly. |
| O4 | Old response/rollback/receipt cleanup completes after demotion and repromotion, refresh, or newer edit. | No stale dispatch, deletion, rollback, readiness change, or overwrite of the current projection/draft. |
| O5 | Newer draft capture races old persistence/discard or auth/lineage change. | Latest eligible text is visibly recoverable; a different scope cannot inherit old edits. |
| O6 | Own SSE echo and HTTP receipt arrive in either order, including a revision gap. | Visible value/status converges to server truth; retained intent and receipt cleanup settle without repeat application or endless saving feedback. |

## Execution and Validation

Preserve real outbox, command, receipt, replay, and projection owners for the
selected workflow. Inject faults at IndexedDB/transport/server persistence
boundaries appropriate to the assertion. Reader and cross-tab cases test the
single-writer contract; they do not authorize a multi-writer redesign.

Use focused owner tests from the table and select the relevant browser cases:

```sh
pnpm test -- server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts
pnpm test -- server/fastify/browser-smoke/visibleStateRecovery.spec.ts
```

Use DOM values/status and durable receipt/revision observations together. Expand
only for a distinct mutation shape, acceptance proof, or draft lifecycle. Before
removing tests, map every distinct schedule to retained coverage. Apply the
common broader validation policy for shared command/outbox changes.

## Execution Record

Assessment: not started. Findings: none confirmed. Validation: not run.
Populate O1–O6 with the selected UI/server owners, named cases, mock boundaries,
changes, and executed evidence. Known gap: helper-level draft/rollback coverage
does not by itself prove every editor's visible outcome. Completion follows
[the common rules](../PLAN.md#phase-completion-and-handoff).
