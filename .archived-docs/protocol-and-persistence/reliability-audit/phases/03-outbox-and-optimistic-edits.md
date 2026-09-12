# Phase 03 — Outbox Replay and Optimistic Edits

State: **Complete; O1–O6 verified, no required evidence gap remains.** Use
[the common audit method](../PLAN.md#audit-method).

## Scope and Source Map

Start with one settings/runtime edit through visible feedback, durable dispatch,
Fastify command/receipt, response loss, replay, and reconciliation. Then exercise
one draft-bearing editor, preferably the composer for retained visible text or
the module editor for encrypted baseline/rebase behavior. Add a representative
reorder/delete/multi-step owner only when it has a distinct unverified contract.

Guides: [durable mutations](../../../../docs/structure/durable-mutations-and-recovery.md),
[editing tests](../../../../docs/tests/domain-mutations-and-editing-bridges.md), and
[persistence tests](../../../../docs/tests/persistence-commands-and-events.md).

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

### Entry and assessed boundaries

Executed on 2026-09-12 from clean commit
`a449e97908d41aed7f04442c260f0ce56194dd43`. The user-requested commit recorded the
completed Phase 02 patch there before this phase began. Phase 03 changes remain
in the worktree. Four independent read-only Luna investigations cross-checked
outbox ordering, command/receipt transport, draft owners, and native browser
coverage. Findings below were independently checked against source and reproduced
in the parent task; worker suggestions alone were not treated as defects.

<!-- prettier-ignore -->
| Entry / boundary | Selected concrete owners | Evidence and limits |
| --- | --- | --- |
| Rendered immediate settings edit | `src/lib/Setting/Pages/DisplaySettings.svelte`, `src/lib/Setting/SettingsSections.svelte`, `src/lib/Setting/Wrappers/SettingCheck.svelte`, `src/ts/setting/utils.ts`, settings owner, durable dispatch, `commands.ts`; `PATCH /api/v1/commands/settings/display` | Actual **Show Memory Limit** checkbox in eight new `server/fastify/browser-smoke/durableMutationRecovery.spec.ts` journeys. Built SPA, native IndexedDB/crypto, authenticated Fastify, disposable SQLite, and native SSE remain real. Network delivery/storage failures alone are controlled. |
| Runtime and debounced settings siblings | Existing startup recovery matrix's `streamGeminiThoughts` runtime patch; `src/ts/server/settingsOwner.svelte.ts` and draft acknowledgement | Retained native runtime helper journey plus settings-owner/durable tests. The new visible control deliberately uses the always-available display route rather than requiring a legacy model configuration. |
| Ordering, replacement, and multiple requests | `pendingMutationOutbox.ts`, `durableMutationDispatch.ts`, `pendingMutationReplay.ts`, `commands.ts` | Actual encrypted transactions and command/replay owners in terminal-rejection integration tests. Existing dispatch tests retain prompt owner/row/DELETE dependency, placeholder replacement, remote marker, transitive predecessor, and multi-request receipt protection. Queue-only and reader mocks are explicitly separate from native queue/lock proof. |
| Selected draft-bearing UI | `src/lib/ChatScreens/DefaultChatScreen.svelte`, composer draft store, writer recovery | Existing native A→B→A writer-switch journey verifies originating text and route recovery; mounted composer tests cover fresh-runtime text/files and chat isolation. Storage unit tests cover exact consume, writer/lineage, expiry, corruption, and quota. |
| Narrow encrypted draft sibling | `moduleEditorDraftStore.ts`, consumed by `src/lib/Setting/Pages/Module/ModuleSettings.svelte` | Added real-crypto/fake-IndexedDB held-decrypt races; store and mounted editor coverage remain separate. No claim that this phase ran a native module-editor recovery matrix. |
| Accepted mutation / server truth | `server/fastify/src/commandMutationReceipts.ts`, command mutations, `command_events`, settings and revision rows | Real SQLite commit/replay/ACK proof in native journeys; retained server receipt tests exercise transactional identity separately. Browser ACK-cleanup metadata is never treated as original acceptance proof. |

### Acceptance evidence

<!-- prettier-ignore -->
| ID | Executed evidence | Result |
| --- | --- | --- |
| O1 | New visible settings cases `lost-after-commit`, `malformed-after-commit`, and `before-acceptance` retain one stable intent and saving feedback. `failed local staging plus failed transport rolls back the visible setting and reports failure` asserts the modal, rollback after dismissing it, no outbox row, no server revision, and no receipt header on the empty-outbox fallback. Focused terminal and command suites cover explicit rejection and malformed receipts. | Passed; failed staging is not reported as queued, and ambiguous transport/body failure is not reported as saved. |
| O2 | Each retained native case reloads and replays the same mutation ID, holds ACK cleanup with 503, reloads again to release cleanup, and checks the rendered value, outbox/ACK rows, exactly one SQLite effect/event/revision, and idle saving feedback. Existing `durable recovery replays committed work whose response was lost` remains selected. | Passed; committed response loss deduplicates and later receipt cleanup does not repeat the edit. |
| O3 | New `retains a predecessor and blocks its successor when %s storage fails` covers marker, terminal-delete, and accepted-delete faults with both encrypted rows preserved, recovery in order, and an idle second pass. `does not send an unstaged replacement ahead of its surviving durable predecessor` aborts exact replacement. Existing dispatch tests retain transient/terminal predecessor, prompt DELETE, full successor, and remote-marker schedules. Native held ACK case overlaps live and replay queues. | Passed; failed storage does not release successors or enable an untracked newer write over retained intent. |
| O4 | `commands.clientSession.test.ts` retains old queued factory, late auth/receipt/423/conflict, and reconciliation demotion cases; adds auth/fetch/body/bootstrap/ACK deadlines and explicit cancellation with late release. Reader outbox tests retain generation/lineage transaction and exact accepted-cleanup fences. Settings owner/stale-state guards and the old-lineage/import visible sidebar journeys preserve current projection. Native held ACK asserts the newer checkbox value commits before old release and survives reload. | Passed; old work neither holds the queue forever nor overwrites the current edit or role. Exact cleanup of an already accepted old intent remains intentional. |
| O5 | Composer native `Use this device switches A to B to A in place while preserving reader routes and the originating draft`, composer mounted reload/chat isolation, composer exact-generation/writer/lineage tests, and writer draft recovery. New module store `fences a late decrypt %s while a newer draft becomes durable` covers success, failure, and scope change. | Passed for the selected composer workflow and narrower encrypted-store race; stale decrypt cannot publish A or delete B. |
| O6 | Native `the visible setting settles with SSE-before-HTTP` and `HTTP-before-SSE` hold real stream bytes/HTTP separately, assert value and saving/outbox state, then release and verify one revision/event. `a visible queued edit converges after a real revision gap and reload replay` advances the real server revision, observes 409 plus full encrypted settings refresh, then reloads and accepts the retained edit once. Existing `event-gap recovery performs an authoritative refresh before reconnecting` covers unavailable persisted event history. | Passed; correct visible value, accepted revision, empty recovery rows, and idle feedback converge. |

### Demonstrated findings and repairs

1. **Unbounded command control requests.** A held accepted response body kept the
   shared command queue pending indefinitely; the new regression failed against
   the old code (`settled` remained false). `commands.ts` now bounds authentication,
   fetch, and JSON together at 30 seconds for command, bootstrap revision, and
   receipt-ACK transport. Explicit cancellation settles even if transport ignores
   abort. Detached continuations cannot publish revisions or consume a later
   queue entry's receipt context. Existing late accepted exact settlement survives
   role loss; currentness still gates projection. Adjacent tests cover all seven
   other request boundaries and cancellation, not just the initial body stall.
2. **Storage failures falsely released replay successors.** Failed dispatch-marker
   persistence was classified as skipped, and failed terminal deletion was
   classified as discarded. Both new schedules failed before repair and allowed
   the successor request. Replay now classifies unavailable marker or row-removal
   storage as retained and blocks successors. Accepted-delete failure received
   matching adjacent coverage after the fix; it was not separately run against
   old source. Restoring storage drains both exact rows in order.
3. **Unsafe fallback after replacement failure.** An aborted replacement left the
   old durable intent intact while the newer edit was sent without durable
   identity; later replay could overwrite it. The new integration test failed
   before repair. Live/prepared fallback now requires a readable empty outbox,
   and a failed marker for an already persisted row retains that row without
   ordinary transport. A new attempt that never persisted reports unavailable,
   not queued. The pre-existing ordinary fallback test still passes when no
   older intent exists.
4. **Late encrypted draft read or cleanup displaced newer text.** Hold decrypt A,
   commit B to the same key, then release A with success, failure, or scope change:
   all three new tests failed against old source (old publication or deletion of
   B). Reads now recheck authenticated session, scope, and stored generation after
   decryption. Corruption/expiry/retention cleanup compares inspected generations
   within its write transaction and rechecks scope. Captured writes retain their
   intended originating scope after writer loss; the change does not turn them
   into server commands or discard admitted recovery writes.
5. **Live/replay lock-order deadlock.** After the deadline fix, the native held ACK
   case still failed: replay held a durable key lock while queued behind a live
   edit waiting for that same lock. The server remained one revision short after
   40 seconds. Replay now reserves the global command queue before taking locks
   and executes receipt replay inline in that reserved context. The same native
   case passes with the successor committed while the old ACK response remains
   held. This defect was exposed on the intermediate bounded-request patch; the
   original unbounded request had masked it.

The reader/cross-tab and prompt/translator UI command mocks were updated to the
new queue/inline boundary; their original schedules and assertions remain. The
translator fixture keeps external replay faults separate from a live predecessor
drain. No tests were removed. The native held-ACK journey provides the actual
queue/lock integration evidence.

Two test-oracle corrections were kept distinct from runtime findings: an open
error modal hides its background checkbox from the accessibility tree, so the
staging-failure case verifies the modal then dismisses it before checking rollback;
encrypted settings resource reads use POST, so the gap case counts the actual
full-settings POST rather than GET. The trace showed the refresh already occurred.

The first broader run exposed six fixture files requiring adjustment (60 reported
failures, many cascading after a held preset response was abandoned). Three mocks
omitted the new replay-queue export; chat-selection and send-error fixtures restored
fetch before their queued work settled; a preset debounce test counted all timers
and did not account for the new transport deadline. The fixes retain the mock
schedule, await the real command-queue barrier before restoring fetch, and compare
debounce timer changes relative to outstanding transport timers. The preset test
still proves the corrective request sends without advancing its debounce delay.
All six focused files subsequently passed; no additional runtime change was needed.

Worker suggestions were also checked for reachability. A zero-count successful
receipt ACK is valid when cleanup was already done or its receipt expired; it
does not indicate acceptance of an unknown command. Suspected newer typing during
module Save was not reproduced: its fieldset disables editing while Save is
pending and writer-loss capture deduplicates the same draft fingerprint. The
demonstrated module defect was the independent asynchronous store read/cleanup.
These hypotheses did not justify changing server ACK semantics or rewriting UI.

### Validation record

The clean-entry focused baseline passed all 13 selected targets: outbox 248,
cross-tab 6, reader 18, replay 14, dispatch 19, terminal rejection 10, commands 161,
durable settings 8, stale-state guards 14, composer store 10, module store 10,
writer recovery 25, and server receipts 12. The retained startup/visible browser
baseline passed 11 cases against the unchanged Phase 02 smoke build; it is
baseline evidence, not validation of later Phase 03 runtime edits.

<!-- prettier-ignore -->
| Final / focused command | Executed result |
| --- | --- |
| `pnpm test -- src/ts/server/commands.clientSession.test.ts` | 18 passed, including nine new request-lifetime/cancellation cases. |
| `pnpm test -- src/ts/server/durableMutationTerminalRejection.test.ts` | 14 passed after final replay queue change. |
| `pnpm test -- src/ts/server/pendingMutationOutbox.reader.test.ts` | 18 passed after updating the queue boundary mock. |
| `pnpm test -- src/ts/server/moduleEditorDraftStore.test.ts` | 13 passed, including all three previously failing decrypt races. |
| Focused command/dispatch/settings and composer owner runs | Commands 161, dispatch 19, settings owner 52, mounted composer 107, composer session/shell 9 passed; broader final run below checks the final shared patch. |
| `VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/durableMutationRecovery.spec.ts server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts server/fastify/browser-smoke/visibleStateRecovery.spec.ts` | **19 passed**, 58.2 seconds, against the freshly built final runtime patch. |
| `VITE_FASTIFY_BROWSER_SMOKE=TRUE pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/connectedWriterSwitching.spec.ts --grep 'Use this device switches A to B to A'` | **1 passed**, 6.2 seconds. Total selected native browser evidence: **20 passed**. |
| Fixture regressions from broader validation | Presets 139, chat selection 18, send errors 11, cross-tab 6, prompt UI 17, translator UI 71 passed after the test-boundary repairs above. |
| `pnpm test:agent` | Required because shared command transport, queue/locks, durable replay, and draft persistence cross UI owners. Six lanes passed; frontend fixtures initially failed as described above. Server suite: **4,375 passed**, three existing skips. All seven lanes are satisfied after the affected frontend reruns below; server/build lanes were not repeated for fixture-only changes. |
| `RISU_TEST_EXCLUDE_UI_MAP=true pnpm exec vitest run`, then the six explicit files in `vitest.ui-coverage-tests.ts` with `RISU_TEST_EXCLUDE_UI_MAP=false RISU_TEST_INCLUDE_GATES=false` | Final frontend coverage in two selections: **9,282 + 247 = 9,529 passed**, three existing skips; 723 + 6 files. No required phase test skipped. The first selection took 88.63 seconds; the remaining UI selection took 7.64 seconds. |
| `pnpm check` after fixture changes | Zero errors and zero warnings. Server/browser-smoke typecheck, topology, server tests, and smoke build passed in the broader run on the final runtime. |
| Current docs, explicit nested-plan validation, scoped formatting, whitespace | Passed: 51 current documents and nine explicit nested plan/index documents. Code and plan Prettier checks passed; current guides retain their existing compact tables under the repository Markdown ignore. |

Local investigation logs include `/tmp/phase03-command-stall-reproduction.log`,
`/tmp/phase03-storage-reproduction.log`, `/tmp/phase03-module-reproduction.log`,
`/tmp/phase03-browser-debug.log`, `/tmp/phase03-browser-final.log`, and
`/tmp/phase03-composer-browser-final.log`. These are ephemeral investigation
artifacts; the checked-in tests and named schedules are the durable evidence.

### Limits and handoff

The selected browser uses Chromium with Playwright 1.62.1, Node 24.19.0, and pnpm
11.23.0 through the repository's isolated Fastify harness. Native network
delivery, reload, storage, receipts, and SQLite state
were exercised; no production database or provider was involved. Focused tests
use controlled fetch/auth clocks or fake IndexedDB where stated. Native module
editor recovery, physical suspension/power loss, and non-Chromium behavior are
not certified. Composer supplies the required draft-bearing native journey;
a future module UI depth check should hold decryption while a new capture persists
and inspect recovered visible text. Physical/platform checks remain the optional
device follow-up already recorded in Phase 01, not missing O1–O6 evidence.

Broader hydration/cache/navigation belongs to Phase 04, background workers to
Phase 05, and destructive import/restore to Phase 06.
Phase 03 is complete with no unresolved in-scope finding. Its patch was committed
as `960a2f336dcab751692cdac0d87d04ac3377daa4` before Phase 04 began. The
[current status](../status.md) owns the execution cursor. Rebuild and rerun affected
evidence if later changes alter the shared command/outbox or draft boundaries.
No `pnpm test:all` was requested or run; no manually started dev server remains.
