# Browser Smoke Findings

Execution started at `711b1d583` on 2026-09-07. The three calibration experiments
below exercise previously repaired behavior; they are not new production bugs.
Confirmed coverage/artifact gaps have separate finding IDs. Apply the evidence
rules in [PLAN.md](PLAN.md) before closing a repair.

## Opening Review Leads

| Lead                        | Evidence and question                                                                                                                                      | Initial owner  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Shared controls             | Browser hooks mix direct store assignments and real command dispatch. Determine the role of each call against its scenario's claim.                        | Phase 1        |
| Input and layout simulation | Existing tests fabricate geometry, set scroll positions, and override browser APIs. Determine which claims need actual browser input/layout overlap.       | Phases 1–2     |
| Fixture-to-producer gaps    | Imported/handcrafted state can pre-complete authoring, omit sparse legacy values, or bypass serialization. Trace only the boundaries each scenario claims. | Phases 1–3     |
| Assertions and scheduling   | Snapshots, settled-only checks, and request interception may miss visible pending states or change the ordering under review.                              | Phases 1–3     |
| Historical residuals        | Prior browser fault/composition limits may have changed. Confirm current evidence before opening new work.                                                 | Phases 0 and 2 |

These are questions, not defects or removal recommendations. The repaired Realm
and transcript incidents are calibration examples; do not assign them new open
finding IDs merely to populate this register.

One specific artifact lead surfaced during plan review (now reproduced as
[BSE-001](#bse-001-required-integration-artifact-accepts-absent-recovery-evidence)):
`server/fastify/browser-smoke/fastBootstrapIntegrationArtifact.ts` initializes
empty recovery collections and validates them structurally as arrays, whereas
its direct-link merge checks expected cases. Phase 1 must determine whether a
required final artifact can consequently claim complete recovery evidence from
empty/partial results. Reproduce this with the actual invocation/merge contract
before promoting it; partial artifacts can be legitimate diagnostics, and this
observation does not show that a failed browser run was reported as passing.

## Finding Record

Assign stable IDs `BSE-001`, `BSE-002`, and so on when a review produces a
concrete finding. Each record contains:

1. Contract, risk, scenario IDs, production owner, and current source anchor.
2. Evidence classification: source-supported gap, reproduced missed fault,
   reproduced product defect, or inaccurate evidence claim. Distinguish an
   ineffective test from an actual current application bug.
3. Existing fixture/control, the exact boundary it skips, and why the present
   assertion fails to detect the named behavior.
4. Bounded repair, responsible phase, affected consumers, and dependencies.
5. Fault-detection experiment: fixture, independently specified expected outcome,
   observation proving the claimed production path was reached, unchanged test,
   production fault diff, commands, expected assertion failure, observed failure,
   and restored pass. Explain why the failure is caused by the named transition.
6. Focused and aggregate verification references, source anchor, and limitations.
7. Disposition and rationale: open, implementing, verified repair, retained
   with accurate scope, disproved, or deferred by recorded scope amendment.

Production defects receive distinct records/changes from harness cleanup.
Retaining a useful narrow test with corrected scope is a valid decision, but
does not supply missing critical browser coverage. Removed/merged cases require
an equivalent or stronger replacement for every named protected behavior and
a consumer/fixture/routing check. No numeric mock, coverage, or mutation score
determines the decision.

## Closure Rules

A material test repair is verified only with the plan's fault-detection evidence
and a passing restored run. A source-only review cannot be upgraded to an
executed reproduction. Every deferred record names impact, owner, revisit
condition, and the status amendment; deferred is not fixed. Open high-risk gaps
in Phase 2 prevent full closeout.

Keep compact reproduction evidence in this record. Add a linked finding-specific
file only when the fault diff or evidence becomes too large to review here.
Temporary logs and expired CI attachments cannot be the sole reproduction source.

## Phase 0 Calibration

All pilots use source `711b1d583` and unchanged tests/fixtures. The main worktree
was clean before documentation edits. Faults were applied only in a detached
disposable checkout created with `git worktree add --detach /tmp/risu-smoke-fault
711b1d583`. Dependencies were linked from the existing installation; pnpm 11's
project-location dependency verification was disabled **only for this disposable
checkout** with `pnpm --config.verify-deps-before-run=false`. This avoids pnpm
trying to replace a modules directory outside that checkout; dependency versions
are unchanged. Normal project runs use plain `pnpm`.

Browser prerequisites: Node v24.19.0, pnpm 11.23.0, Playwright 1.62.1, Chromium
151.0.7922.34. Each build uses `pnpm build:smoke`; selected execution uses
`pnpm exec playwright test -c playwright.fastify-smoke.config.ts` followed by the
spec/grep options below. Disposable SQLite/loopback harnesses are owned and
closed by the unchanged tests. No human database or external provider is used.

### P0-C: Realm progress-to-confirmation queue

Contract: an import reporting low-level access while progress/wait is visible
must admit the real queued confirmation; accepting retries with the pending
import token, rejecting does not retry or refresh. Source owners are
`src/ts/characterCards.ts`, `src/ts/alert.ts`, and
`src/ts/characterCards.realmImport.test.ts` (the four expansions of
`shows low-level confirmation after $presentation and handles confirmed=$confirmed`).

Precondition/path observation: the mocked **external import adapter** first
asserts real alert presentation is `progress` or `wait`; `downloadRisuHub`
receives the low-level result. The alert store/queue and owner resolution are
real. The test waits for `{ type: 'ask', msg: 'Low-level access?' }`, verifies no
second import/refresh before answering, then resolves the actual dialog owner.
This is component-level queue evidence, not a UI Realm browser import.

Fault (restored historical hunk from `ac5a1cec1`):

```diff
-      // Release the progress overlay so the queued confirmation can be shown.
-      alertStore.set({ type: 'none', msg: '' })
       const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
```

Commands/results:

- Baseline and restored: `pnpm test -- src/ts/characterCards.realmImport.test.ts`;
  **20/20 pass** in both runs (1.36s and 0.79s).
- Fault checkout: `pnpm --config.verify-deps-before-run=false exec vitest run
src/ts/characterCards.realmImport.test.ts -t 'shows low-level confirmation'`;
  **4/4 selected cases fail**, 16 excluded by selection, in 6.42s. All fail at
  the bounded `vi.waitFor` assertion at test line 472: the real presentation
  remains progress/wait instead of ask. This is the intended admission failure,
  not a suite timeout, import error, or supplied confirmation answer.

Disposition: retained, fault detection confirmed. No new production repair.

### P0-T: Returning transcript rows during continuous input

Contract: readable rows remain visible/anchored while real browser input
reverses and pauses across page loading and queued body remounts. Owner:
`server/fastify/browser-smoke/chatHistoryScroll.spec.ts`, exact title
`300-message history stays readable with rapid reversals and pauses among tall messages`
(S22); continuous-upward S21 is companion coverage. Production owner:
`src/lib/ChatScreens/Chats.svelte`, cached-height retention in
`measureTranscriptRow` (introduced by `82f888cad`).

Fixture/path: 300 imported rows, wrapping text, alternating static rich bodies,
7607px tall bodies every fifteenth row, and 150ms older-page response delay.
The test first proves 30 rendered history bodies, then sends actual CDP gestures
and wheel events while sampling live DOM IDs/content/geometry. It does not set
scrollTop or supply row measurements. Nonempty readable pause anchors and real
older-page requests prevent vacuous success. DOM trace is off by design.

Fault:

```diff
-    const measuredHeight = heights.measured(id)
+    const measuredHeight: number | undefined = undefined
```

This removes the returning row's cached-height hold; it leaves the fixture,
input, parse scheduler, height cache, observer and assertion untouched.
Predeclared method: one worker, two unchanged reversal repetitions, unprofiled
and trace-off; compare the same repeated workload after restoration.

Commands/results:

- Baseline build then `pnpm exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/chatHistoryScroll.spec.ts
server/fastify/browser-smoke/visibleStateRecovery.spec.ts --workers=1`:
  **5/5 pass**, including both history profiles (19.2s and 36.7s).
- Fault build then the same Playwright command with only the history spec,
  `-g 'rapid reversals' --workers=1 --repeat-each=2`: **2/2 fail**, at the
  intended readable-row pause assertions. Repetition 1: message 265 moves
  292.6875px, exceeding the 1px anchor bound (line 136). Repetition 2: message 262
  no longer stays visible (line 132). Neither failure is a generic timeout.
- Restore production source, rebuild, and repeat the identical two-repetition
  command: **2/2 pass**, 36.6s and 30.6s (1.2m including harness overhead).

Disposition: retained; real input detects the remount-height fault. This is
Chromium browser evidence, not a physical-device or production-latency claim.
The adjacent residency rapid-movement case assigns scroll positions and retains
its narrower coverage; it does not substitute for this pilot.

### P0-R: Delayed old-lineage command and recovery reload

Contract: a delayed receipt-tagged durable request crossing a RisuSave import
must enter actual lineage recovery, load the new authoritative state, and retain
the current history entry's sidebar choice. Owner:
`server/fastify/browser-smoke/visibleStateRecovery.spec.ts`, exact title
`the same-character sidebar view survives old-lineage recovery after import`
(S77). Production owner: `restoreCharacterSidebarViewMode` in `src/ts/router.ts`.
The router component/unit companion is `src/ts/router.test.ts`.

Fixture/path: real chat-row and character-tab clicks establish the view. The
settings smoke hook dispatches through the actual encrypted durable outbox and
holds the real runtime-settings request. A real import rotates lineage; release
causes `database_lineage_conflict`. Independent assertions verify the conflict
response, recovery navigation response, changed `performance.timeOrigin`, new
resource revision, two imported chats and the unchanged route, **before** the
visible sidebar oracle. This is the phase's permitted visible-state recovery
alternative; it is not evidence of generation acceptance or settings UI input.

Fault:

```diff
-  if (selectedCharacter?.chaId === route.chaId) botMakerMode.set(true)
+  // Fault: omit restoration of the same-entry sidebar view after hydration.
```

Baseline: the five-case command in P0-T passed all three visible-recovery cases.
Fault build followed by `pnpm exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/visibleStateRecovery.spec.ts -g 'old-lineage'
--workers=1` failed at line 221: `sidebarTabActive(..., 'character')` returned
false after all new-document/lineage/data assertions passed. This proves loss
of the retained view after actual recovery; no hook assigns the broken result.
Restored clean-build focused result: **3/3 pass** in 6.6s, including the
unchanged recovery case in 2.1s.

Disposition: retained; no product change required. Accepted-send response loss,
exactly-once generation, and writer transitions remain separate Phase 2 owners.

## BSE-001: Required integration artifact accepts absent recovery evidence

- Classification: reproduced inaccurate evidence claim; medium harness risk.
- Source: `711b1d583`; owner
  `server/fastify/browser-smoke/fastBootstrapIntegrationArtifact.ts`, consumers
  global setup/teardown, direct links, recovery integration, and
  `server/fastify/__tests__/fastBootstrapIntegrationArtifact.test.ts`.
- Reproduction: create a temporary output directory; write
  `emptyFastBootstrapRecoveryArtifact()` with `writeFastBootstrapRecoveryPartial`;
  write every `directLinkBatches(directLinkCases())` batch as complete with its
  expected case index/path but arbitrary route keys and empty surface/request
  arrays; call `mergeFastBootstrapArtifactOutputs({ outputDir, required: true })`.
  Actual result: accepted 44 direct links with **zero startup, recovery, writer,
  and optional-runtime entries**. The existing unit's first fixture uses this
  same empty recovery pattern and fabricated route keys.
- Removing batch 4 and repeating the required merge throws but still writes a
  final-named integration JSON/TXT file. A final-looking artifact therefore
  cannot certify completion by itself. This does not show that Playwright's
  exit status was falsely green after a failed test.
- Required repair, Phase 1: validate expected recovery identities and payloads,
  expected direct-link semantics, and current invocation provenance. Keep partial
  diagnostics useful while preventing their promotion to successful final
  evidence. Check all helper consumers and demonstrate unchanged repaired tests
  reject the original helper behavior. No production mutation is involved.
- Disposition: **verified repair**; Phase 1 aggregate and full-browser evidence passed in status. Startup
  and locale artifacts deliberately keep separate invocation ownership: the
  verification command runs measurement and integration in separate Playwright
  invocations. They are not consumed as required integration evidence.

### BSE-001 Repair and Fault Evidence

Implementation source: `2138c8897` plus the artifact helper/unit/global-setup
changes recorded with this finding. Phase 1 changes only test infrastructure.
Global setup creates a new run ID; partial writers stamp it and the merger
requires that independently supplied current ID. Schema version remains 1;
unstamped previous artifacts are diagnostic history, not current evidence.

The required artifact covers exactly small/large × flag-off/on startup, three
named recovery journeys, denial/takeover, four optional-runtime variants and all
44 manifest routes in their declared batches. Nested observations must satisfy
the scenario's actual outcome (including retained mutation identity, single
revision advance, acknowledgement, or route-local Retry as appropriate).
Failures preserve partials and remove final JSON/TXT; a successful TXT includes
its run ID. Focused partial runs return no combined success report.

`pnpm test -- server/fastify/__tests__/fastBootstrapIntegrationArtifact.test.ts`
passed **67/67** (implementing subagent); strict server and browser-smoke
TypeScript checks passed. The parent ran six separate justified helper faults
in the disposable checkout, restoring the helper between runs. Regression
fixture/test/global-setup files were copied unchanged from the fixed source.
The common command was `pnpm --config.verify-deps-before-run=false exec vitest
run --config server/fastify/vitest.config.ts
server/fastify/__tests__/fastBootstrapIntegrationArtifact.test.ts -t '<selection>'`.
These are artifact-integrity faults, not claims about faulty product behavior.

| Fault (exact helper edit)                                                                                         | Unchanged test selection                                                                                                             | Intended/observed failure                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Remove `checkRecoveryCompleteness(recovery, issues)` call.                                                        | `does not promote empty recovery evidence`                                                                                           | 1 selected failure: expected the required merge to throw; it accepted an empty recovery matrix.                                |
| Remove `checkDirectLinkSemantics(result, expectedCases[caseIndex]!, caseIndex, issues)` call.                     | The six `rejects fabricated direct-link` cases, `requires every declared route resource`, and `rejects using a redirect source key`. | 8 selected failures: fabricated route/path/surfaces/request metadata and incorrect redirect were accepted instead of rejected. |
| In `validateCurrentRun`, drop the `value.runId !== runId` condition, retaining only `if (!isRecord(value))`.      | Both `rejects stale run provenance` cases, both `rejects legacy evidence` cases, and `complete previous invocation`.                 | 5 selected failures: required merges did not reject stale/unstamped data; optional rerun returned an artifact instead of null. |
| Remove the `if (!value[field].every(validEntry))` guard and its error throw from recovery validation.             | `rejects empty telemetry when reading and writing partials`                                                                          | 1 selected failure: the partial writer accepted empty telemetry rather than throwing.                                          |
| Insert `writeFastBootstrapIntegrationArtifact(artifact, outputDir)` immediately before the required-issues throw. | `rejects a missing batch and removes a previously successful final`                                                                  | 1 selected failure: final JSON exists after the incomplete required merge.                                                     |
| Remove the `for (const name of [finalJsonName, finalTextName]) fs.rmSync(...)` cleanup at merge entry.            | Same missing-batch selection.                                                                                                        | 1 selected failure: previous successful final JSON survives rejection.                                                         |

Every failure was at the contract assertion (`toThrow`, `toBeNull`, or absence
of the final file), not compilation/import failure. Restore all six edits and
run the complete unchanged artifact unit: **67/67 pass**, 307ms. The fixture
writes real temporary partial files and calls the actual merge/write boundaries;
it never supplies a precomputed merge outcome.

Real browser consumers: `RISU_FAST_BOOTSTRAP_ARTIFACT_REQUIRED=true pnpm exec
playwright test -c playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/startupDirectLinks.spec.ts
server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts`:
**11/11 pass in 39.7s**, including required global teardown. Inspection of the
resulting current-run JSON confirms 4 startup, 3 recovery, 1 writer, 4 optional
runtime and 44 route records with one matching run ID. Final aggregate evidence
is linked from status; unchanged remaining specs exercise global setup again
in the phase-ending full suite.

## BSE-002: Alert presentation is not operation confirmation coverage

- Classification: source-supported critical coverage gap, owner Phase 2a.
- S33 calls `showAlert` directly and validates layout/focus/OK across viewports.
  P0-C proves the real queue at component level. Neither drives an operation's
  browser entry path from progress into blocking confirmation.
- Required repair: one bounded deterministic real-operation browser journey,
  including acceptance/rejection and no premature continuation, paired with the
  queue ownership companion. Demonstrate a production admission fault at the
  browser assertion. Preserve S33's presentation/accessibility contract.
- Disposition: **verified repair**; Phase 2 agent and full-browser gates passed in status.

### BSE-002 Real-Operation Browser Proof

Source: `6f39fb8f0` plus new
`server/fastify/browser-smoke/realmProgressConfirmation.spec.ts`. Two cases are
registered as `Realm import moves from actual download progress to low-level
confirmation and handles YES` / `...handles NO` (S78/S79). The existing alert
presentation/accessibility case S33 stays independent and useful.

Fixture provenance and actual path:

1. Import an empty initialized RisuSave fixture through real Fastify/SQLite.
   A local HTTP server supplies the external Realm catalog and a genuine
   `chara_card_v3` ZIP with its low-level flag and one PNG asset; conversion,
   staging, import routes, resource refresh and SQLite remain real.
2. Click the visible Realm opener, external-server warning, Realm menu, URL/ID
   import, input confirmation and Terms acceptance. No browser hook invokes the
   operation or substitutes its answer.
3. The external server sends half the CharX bytes and waits. The first real
   import POST returns 200/SSE, the visible download progress exceeds 5%, and
   request/body/storage assertions prove only one unapproved request and no
   character/assets or character refresh.
4. Release bytes. An observation-only wrapper copies original `reply.raw.write`
   bytes, forwarding the original arguments, encoding/callback, this binding
   and return value. The actual stream finishes with one low-level-access frame
   and a nonempty server token, with no done frame or durable import. This
   recorder replaces unavailable Chromium response-body diagnostics; it does
   not supply frames or alter application parsing/queue admission.
5. The actual low-level dialog must appear and expose enabled YES/NO controls.
   YES reuses the exact pending token in one retry, performs no second external
   download, creates one character/event and asset, navigates to its stable ID,
   and preserves imported fields through reload. NO sends no retry/import,
   leaves storage unchanged, permits opening/cancelling another visible input,
   and remains empty after reload.

Fixed focused command: `pnpm exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/realmProgressConfirmation.spec.ts --workers=1`:
**2/2 pass**, 7.5s. Strict browser TypeScript and Prettier pass.

Production fault in the disposable checkout, unchanged final regression/fixture:

```diff
       // Release the progress overlay so the queued confirmation can be shown.
-      alertStore.set({ type: 'none', msg: '' })
       const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
```

After `pnpm build:smoke` in that checkout, the same selected browser command
(with its previously documented pnpm dependency-verification option) produces
**2/2 failures at line 187**: the bounded 5s assertion says the real low-level
response must replace progress with actionable confirmation. All preceding real
POST/SSE/download-progress/token/no-import assertions pass. This is the intended
queue-admission hang, not a generic suite timeout or mocked confirmation return.
Restore the production line, rebuild and execute the unchanged two cases:
**2/2 pass**, YES 2.5s, NO 2.2s, 6.3s total.

Initial authoring runs exposed an opener accessible-name mismatch and Chromium's
unavailable completed fetch-SSE response body. Those were test instrumentation
issues, resolved before the fixed/fault/restored experiment; no application
failure is inferred from them. Progress and confirmation prevent launching a
second import through this visible UI. The existing real-queue component
companion P0-C covers a stale low-level server result arriving while a newer
import owns progress; no programmatic concurrency is mislabeled as a browser
entry journey. Phase 2's final frontend lane re-executes that unchanged companion.

## BSE-003: Completed normal-send identity survives full reload

- Classification: **reproduced missed fault**, owner Phase 2c. No current
  application persistence defect was found.
- Starting source `4585333b4`: S01 drives the real composer, observes a held
  provider's first chunk, reloads during generation, releases completion, and
  checks client/API content. It omitted a completed reload and terminal result
  identity. S46's completed reroll reload is a different entry path.
- Repair: S01 is now `send -> mid-stream and completed reloads retain one exact
reply`. After completion it captures the two authoritative message IDs and
  verifies the accepted user ID and assistant operation lineage. A second full
  reload, with a changed document time origin and no synthetic recovery events,
  must restore the same DOM IDs, client rows, authoritative rows, and completed
  operation's accepted/result IDs. The controlled provider must run exactly once.
- Path observation remains independent: real composer fill/click, running
  operation/job/accepted-user assertions with one visible partial reply, real
  terminal storage reads, then new-document bootstrap and normal ranged chat
  hydration. No hook supplies completion or the expected restored IDs.

Fault in `server/fastify/src/routes/generationChat.ts`, within the actual
transactional operation finalization call:

```diff
             terminalOutcome: args.operationLineage.terminalOutcome,
-            resultMessageId: write.messageId,
```

The assistant row and live stream still complete, but the durable operation
loses its link to that reply. The field is optional in the function signature,
so this is a behavior fault, not a type/import failure. Client assets are
unchanged; Playwright loads the changed Fastify route directly.

Commands at the fixed source and in the isolated checkout use `pnpm exec
playwright test -c playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/acceptedSendProtocol.spec.ts --workers=1`, with the
same disposable-checkout pnpm dependency-check option described under Phase 0.

- Strengthened baseline, `-g 'completed reloads'`: **1/1 pass**, 3.7s case/6.1s total.
- Same unchanged strengthened regression/fixture against the fault:
  **1/1 fails** after the completed reload at line 397,
  `operationForChat(...).toMatchObject(completedOperation)`, because
  `resultMessageId` is absent. Earlier visible-content, new-document, hydrated
  message-ID, and authoritative message-ID assertions pass.
- Additional comparison using the **unmodified old test file from `4585333b4`**
  and the same fault, `-g 'reload mid-generation'`: **1/1 passes**, 2.1s case/4.0s
  total. This is the missed fault; it is separate from the unchanged-test
  fixed/fault/restored experiment above.
- Restore the production field and strengthened test; execute all 11
  accepted-send cases. **11/11 pass in 26.4s** at the restored source.

Disposition: **verified repair**; Phase 2 agent and full-browser gates passed in status. Generation failure/retry, Stop, transport loss, concurrent chats, and
queued finalization keep their existing separate cases and deterministic
external-provider boundaries.

## BSE-004: Paint-cache observation must sample every held phase

- Classification: source-supported assertion gap, medium test-harness risk;
  no new application defect. Source: `7399389f9`; consumer S27 in
  `server/fastify/browser-smoke/displayPaintCache.spec.ts`.
- The sampler accumulated only mismatches. An empty observation set therefore
  satisfied its final `[]` assertion even when a held startup phase produced
  no sample. Existing computed-style checkpoints remain useful independently;
  they were not evidence of continuous sampling.
- Repair: count actual sampler invocations and, before releasing each held
  entry/shell/Display phase and after hydration, wait for a strictly newer sample
  and assert no mismatch. The barrier observes a real browser frame without
  assigning application layout or making a timing budget. One spec is affected.
- Fixed baseline using the already built matching SPA: `pnpm exec playwright
test -c playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/displayPaintCache.spec.ts --workers=1`:
  **1/1 pass** (2.4s case, 4.0s total).
- Production fault in the disposable checkout, unchanged strengthened test:

  ```diff
  -              document.documentElement.style.setProperty(property, value)
  +              // Fault: skip restoring validated cached display properties.
  ```

  This is the synchronous cache restore in `index.html`, before application
  entry. Build smoke assets, then run the same selected browser command. Actual:
  **1/1 fails** at the independent pre-bundle appearance assertion (line 135):
  background `#282a36` instead of cached `#f5f7fc`, font Arial instead of Georgia,
  and missing cached sidebar size. The preloader is visible and the smoke hook
  absent, proving the claimed pre-bundle transition. The test does not assign
  the expected or broken style, or rely on a generic timeout.

- Restored clean rebuild and identical focused execution: **1/1 pass** (2.3s
  case, 3.7s total). Phase aggregate validation remains in status.
  Limit: this fault proves paint restoration, while the new explicit frame
  barriers prevent vacuous sampler success; it does not claim every browser
  frame on physical devices is observed.
- Disposition: verified repair; Phase 1 aggregate and full-browser evidence passed in status.

## Reader Phase 2 Production-Fault Evidence

The Reader implementation materially adds S80 and changes S32/S60. Their current
fixture/control/oracle limits are in the
[inventory reconciliation](inventory.md#reader-phase-2-smoke-reconciliation).
These experiments verify the new browser assertions; they do not reopen the
accepted Stage 1 critical-contract repairs or claim later promotion/viewer work.

Source: `6003c596ecaa3a1a41ed864b2c1397f4abfd10e0`, with production through
`81efb67c3`. Final controls passed all nine selected cases: S80 plus the seven
startup-recovery cases (27.9s total), followed by S32 (4.3s total). The separate
`e8431655d` register update changes only three test-file reference counts and its
matching total; production/browser sources are identical.

Each fault was applied separately in a detached disposable checkout of that
commit. No test, fixture, assertion, hook result or server record was changed.
The checkout used the existing dependency installation and
`pnpm --config.verify-deps-before-run=false build:smoke` before each browser run.
All fault builds succeeded. Browser commands used the ordinary Chromium smoke
config, one worker, and the unchanged tests below. Restore each production file
before applying the next fault; restore both before the final control build.

Unchanged SHA-256 test identities, useful for reproducing the source pairing:

- S80 file: `16de60aa6c85bfd78d9a5a39e08113a844186b05ba91a18c5ea7e6fca4c6da9f`.
- S60 file: `8286c40642a29774d5263067b77579bfd44ed09669faf904137146e4609e9131`.
- S32 file: `3cc9c9344506b96ee82564721d8d962b10d4a539aaf310bed27250597f562711`.

### R2-F1: committed message projection

In `src/ts/server/connectedReaderSync.ts`, the actual reader invalidation hook:

```diff
-      applyChatMessages: applyServerChatMessagesResource,
+      applyChatMessages: () => true,
```

Command: `pnpm --config.verify-deps-before-run=false exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts --workers=1`.

The unchanged S80 regression failed at line 345: the exact live message was
absent after its 30-second bounded visible-text assertion. This is a production
projection fault that can acknowledge refresh without applying messages. The
request trace proves HTTP 200 for the real message append at revision 1. The
failure-finally SQLite snapshot independently contains
`connected-reader-live-message` in `connected-reader-chat-a`, with its exact
text and `message.appended` event attributed to Writer A. Reader mutations and
page errors were both empty. Startup and the accepted command path completed;
the failure is neither collection nor initialization failure.

### R2-F2: passive demotion resubscription

In `src/ts/bootstrap.ts`, remove only the reading branch at the end of the
lost-writer lifecycle subscriber:

```diff
       connectedReaderRefreshTimer = null
-      if (state.lifecycle === 'reading') void refreshConnectedReader()
```

Command: `pnpm --config.verify-deps-before-run=false exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/startupRecoveryIntegrationMatrix.spec.ts --workers=1
-g 'mixed-client journey denies pre-authority mutation and keeps the old writer connected after legacy takeover'`.

The unchanged S60 case failed at line 413: the demoted A resource projection
remained `streamGeminiThoughts=false` after C committed `true`. The named
five-second convergence predicate failed; case duration was 7.0s. The trace
contains C's real `PATCH /api/v1/commands/settings/runtime` with HTTP 200 and
revision 1. The preceding assertions establish explicit legacy takeover,
connected-reader role/route availability and denied A mutation. This fault
therefore exposes missing read synchronization despite successful demotion.

### R2-F3: subsequent foreign-writer frame

In `src/ts/server/connectedReaderSync.ts`, add the old teardown behavior only
when a later frame changes the observed writer:

```diff
         onWriterEvent: (writer) => {
           if (!current(sourceEpoch)) return
+          if (getClientSessionSnapshot().writer?.sessionId !== writer.sessionId) {
+            stop()
+            return
+          }
           if (observeClientWriter(writer) && current(sourceEpoch)) options.onWriterEvent?.(writer)
```

Command: `pnpm --config.verify-deps-before-run=false exec playwright test -c
playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/fastifyBrowserSmoke.spec.ts --workers=1
-g 'a connected reader keeps receiving updates through a legacy writer takeover'`.

The unchanged S32 case reached C's accepted character rename (HTTP 200), then
failed at line 628: `Open Updated Smoke Character` never became visible within
five seconds. The initial foreign-writer snapshot remains valid under this
fault; only the subsequent ownership frame stops the production reader service.
The legacy confirmation and old A's offline choice completed, so the failure
isolates continued reader updates through takeover.

### Restoration and limit

Both production files were restored to `6003c596e`, with a clean tracked
checkout and unchanged test hashes. The final smoke rebuild passed. One
single-worker command selected S80, S32 and S60 using the three file paths and
an alternation of their exact unique titles: **3/3 passed in 13.6s** (7.7s,
2.4s and 2.0s cases). No test/fixture/oracle change occurred between the
negative runs and the restored controls. The owning reader status records the
required aggregate gates separately.

These faults prove committed message application, demotion resubscription and
subsequent foreign-frame continuity. They do not prove explicit upgraded
promotion, pending-edit A → B → A behavior, live generation streaming or
exactly-once generation effects; the reader plan assigns those to Phases 3–4.
The existing Stage 1 send/confirmation/transcript faults retain their original
source and scope limits until Stage 3 reconciliation.

## BSE-005: Pause sampling misses readable anchors after hydration

- Classification: source-supported pause-coverage gap, reproduced in the
  required Reader Phase 2 full suite at `b7d3f88f1`. No production scroll defect
  was reproduced. Risk: a critical transcript test can fail its coverage guard
  even though its saved observations contain a stable readable pause.
- Scenario: S22, `300-message history stays readable with rapid reversals and
pauses among tall messages`, in `chatHistoryScroll.spec.ts`. Production
  cached-height behavior and its original fault remain owned by
  [P0-T](#p0-t-returning-transcript-rows-during-continuous-input).
- The full run passed 79/80 browser cases and all 12 other quality lanes.
  S22 failed only at line 139: `anchoredPauses` was zero. Every pause's first
  sample was empty or unreadable, but pause 3 first gained readable message 275
  at sample 12, then kept it readable at exactly the same top for 18 samples.
  There were no page errors. DOM trace remains off to avoid changing scheduling;
  the attached structured viewport observations provide the evidence.
- The unchanged case then passed two isolated repetitions, 37.5s and 32.0s,
  against the same emitted source. That rerun does not erase the recorded
  full-suite failure or establish a production fix.
- The initial selection-only proposal was rejected after both exploratory
  repetitions failed. Selecting a newly readable first row mid-pause can choose
  a different identity from the row captured by the app at the last scroll;
  one such upper row left view while the original lower anchor stayed fixed.
  Another run had no early enough candidate. Those exploratory runs overlapped
  a browser TypeScript check and do not certify a product defect. The original
  test was restored; no proposal was committed or subjected to a qualifying
  production-fault experiment.
- Source review confirms `captureResidencyAnchor` chooses the first geometric
  visible row and retains its identity across parser reconciliations. A test
  must not choose a surviving row by inspecting later outcomes, which would
  hide the visibility failure it is meant to catch. The scoped-context diff
  also leaves the writer's existing message owner and cloning path unchanged;
  no reader-code regression has been established in this flag-off scenario.
- The accepted workload retains the original sample-zero readable anchor rule.
  `38604f7f9` adds two fixed passes of the original seven real reversal gestures,
  separated by a return toward recent history. Both passes always run; each
  pause records 30 samples at 32ms cadence, and every original visibility/1px
  geometry check remains. `d75ecfe375` moves the unchanged nonempty coverage
  guard after the independent continuous-input and full-traversal assertions.
  No outcome-based retry or surviving-row filter is used.
- At `d75ecfe375`, the original P0-T cached-height omission produced one
  coverage-guard failure and one pass; a separate omission of
  `container.scrollTop += delta` in anchor reconciliation passed both runs.
  Neither candidate manifested the required geometry/readability fault, so
  neither is qualifying fault evidence. Their restored controls passed twice
  each. Build/worktree provenance was retained, but those older trace-off
  runs did not capture served-script response receipts. Evidence is under
  `/tmp/reader-phase2-transcript-guard-order-fault-evidence` and
  `/tmp/reader-phase2-transcript-anchor-restoration-fault-evidence`.
- `9387d1464974` adds a direct remount contract to the fixed return. The initial
  30 ordinary bodies are already readable; after the first seven gestures,
  message 298 must be absent from the DOM. A fixed real CDP return gesture and
  one real wheel event then require its original text and readable viewport
  intersection. Message 299 is always pinned and cannot prove an unmount; the
  discarded pinned-row trial is excluded. The subsequent second pass and all
  original geometry/history/residency checks remain unchanged.
- Final unprofiled, trace-off, single-worker baselines at `9387d1464974` passed
  **2/2 (44.3s, 44.5s)**. Both supplied the unmount/remount preconditions and
  retained 117 successful script URL/path/status receipts, with zero console or
  page errors. Browser TypeScript, formatting and whitespace checks passed
  after browser execution. The frozen test SHA256 is
  `66aef54cf98b5691387ac078d0f7a574dba6221d809506576df3620aeb20a624`;
  baseline evidence is `/tmp/reader-phase2-transcript-remount-receipts-baseline`.
- A separate predeclared production fault binds a cached parse promise to its
  first component's `ChatBodyParseOwnerReaders` object. Reuse by a new component
  then waits indefinitely instead of returning the cached result. This models
  stale component ownership stranding remounted content. The fault contains no
  fixture IDs/text or DOM writes. Its diagnostic marker records the reached
  branch and message ID; the independent DOM oracle still owns pass/fail.
  Qualification requires two direct message-298 remount failures after startup
  and proven unmount, the corresponding marker, the served fault chunk, then
  restoration/build and the same two passing controls. Startup-only or unrelated
  failures cannot qualify.
- The predeclared negatives both failed at the direct remount text assertion
  (20.0s, 19.3s), after initial readiness, seven real gestures, proven unmount
  and fixed return input. The body remained blank. Both recorded the specific
  `[chat-body-parse-owner-mismatch] transcript-residency-chat residency-message-298 298`
  marker, five older-page requests, no page errors, and an HTTP 200 receipt for
  `/assets/Chat-ChX9s9hZ.js`. The preserved fault chunk SHA256 is
  `c9510736a7a78d7889017d0517d4cd30dd21c4a589dbc84f965059b49b14c95b`.
  This is qualifying remount-readability fault detection; it does not relabel
  the unmanifested height/anchor candidates as detected geometry defects.
- The exact production source was restored and rebuilt. The unchanged two
  controls passed **2/2 (44.0s, 43.8s)**, receiving the restored chunk
  `/assets/Chat-DLvx2m3D.js` with SHA256
  `d27026b7eb3a406236f549b13ef4850e6d4bdb1c92c1fe90b05f358f7d1e1a59`;
  its fault marker is absent. Final controls complete the focused repair proof.
- Owner/disposition: Reader Phase 2 validation repair, **verified repair**.
  Final `pnpm test:agent` passed in 2m 26.6s and phase-ending `pnpm test:all`
  passed all 13 lanes in 5m 49.2s at `9387d1464974` plus the evidence records.
  All 80 browser cases passed, including S22 in 44.9s. These final gates close
  the recorded coverage gap; the original failed full run remains in the ledger.

The reviewed fault is confined to `src/lib/ChatScreens/ChatBodyParseMemo.ts` in
`/tmp/risu-transcript-pause-fault` at `9387d1464974`:

```diff
 const parseMemo = new Map<string, Promise<string>>()
+const parseMemoOwners = new WeakMap<Promise<string>, ChatBodyParseOwnerReaders>()
@@
     const cached = parseMemo.get(key)
     if (cached) {
+      if (parseMemoOwners.get(cached) !== input.owners) {
+        Reflect.apply(console.warn, console, [
+          '[chat-body-parse-owner-mismatch]',
+          input.chatId,
+          input.messageId,
+          input.chatID,
+        ])
+        return new Promise<string>(() => {})
+      }
       return refresh(parseMemo, key, cached)
@@
+    parseMemoOwners.set(promise, input.owners)
     rememberParseMemoEntry(key, promise)
```

The frozen test uses ordinary DOM text/visibility observations; it does not read
this owner map or infer success from its diagnostic marker. Detailed manifests,
logs, emitted chunks and observations are retained under
`/tmp/reader-phase2-transcript-remount-owner-fault-evidence`.

Build command in that disposable checkout: `pnpm
--config.verify-deps-before-run=false run build:smoke` (fault and restored builds
passed in 12.5s and 12.15s). The unchanged browser command for both pairs was:

```sh
pnpm --config.verify-deps-before-run=false exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/chatHistoryScroll.spec.ts \
  --grep 'rapid reversals and pauses among tall messages' \
  --repeat-each=2 --workers=1
```

The spec keeps trace off. The final manifest confirms the disposable checkout
is clean, all three relevant source files match `9387d1464974` and main, and no
owned build/browser job remains active. The dependency-verification override
applies only to the lab's shared `node_modules` link.

### BSE-005 recurrence during Reader Phase 5

The Phase 2 acceptance above is historical and retains its exact source and
remount-fault scope. At `90069ac9c`, the required full suite again reaches all
independent traversal/remount oracles but has zero readable sample-zero anchors
across its fourteen pauses. BSE-005's sampling acceptance is reopened. The
[final-gate repair record](#reader-phase-5-final-gate-repairs) describes the
bounded preparation correction and renewed proof; no later-readable survivor
selection or newly reproduced production geometry defect is implied.

## Reader Phase 3 Production-Fault Evidence

Source: `7c3da2160cbd1f8456ce3d8bc03727d6916b8de0`, production through
`783d48469`. The new S81–S83 boundaries and test controls are in the
[inventory](inventory.md#reader-phase-3-smoke-reconciliation). The final emitted
baseline passed 3/3 in 9.9s. An earlier terminal-attempt pointer correction is
retained in reader status and is excluded from production defect evidence.

All experiments ran in `/tmp/risu-writer-switching-fault`, a detached disposable
checkout with the existing dependency installation. Each exact hunk was
reviewed and declared before execution, applied alone and restored before the
next candidate. The same test and harness bytes were used throughout. No
assertion, fixture, selector, workload, hook response or durable row was changed.

Frozen SHA-256 identities:

- `connectedWriterSwitching.spec.ts`:
  `372287496b4c3ce42acd2c7d1d7ae9e1eecc916c6b9930472d4e5cddd03138a9`.
- `fastBootstrapHarness.ts`:
  `f09ca94035bea32b6401fed55d684c78517c4a0ca2f45532b30a5ab1a49dd978`.
- `src/ts/bootstrap.ts`:
  `674e180a1bda61f35d65e166033f58b4c84e52de75df17f02cbab3d637862629`.
- `server/fastify/src/streamJobs.ts`:
  `f51c3e08e7225afc69da51feeb7c1ce4b57cc90d231d3da74e672e1a26dc35d5`.

Before each negative and final restored run, the command
`pnpm --config.verify-deps-before-run=false run build:smoke` passed. Browser
commands used `pnpm --config.verify-deps-before-run=false exec playwright test
-c playwright.fastify-smoke.config.ts
server/fastify/browser-smoke/connectedWriterSwitching.spec.ts --workers=1`,
adding `--grep` with the corresponding exact full title from S81, S82 or S83
in the inventory. One deterministic negative was declared per case. The final
restored command omits `--grep` and runs all three. Traces were retained on
failure; there was no profiling or concurrent test/build workload.

### R3-F1: explicit promotion recovery

In `src/ts/bootstrap.ts`, only the explicit promotion branch after acquisition:

```diff
-    await recoverConnectedWriter(acquired.bootstrap, operation)
+    Reflect.apply(console.warn, console, ['[fault-explicit-writer-recovery-omitted]'])
```

S81 **fails in 31.6s** at line 317's writer-capability assertion: mutation and
generation stay disabled. Initial A writer/B reader startup, B's local route,
actual Use this device/confirmation and SQL B/epoch 2 all passed first. The
confirmed bootstrap was HTTP 200 with expected epoch 1 and matching lineage.
B logged the branch marker and received `/assets/bootstrap-CnGy9LCZ.js` with
HTTP 200, SHA-256
`8d53a38093672ed6f8021f4c668dc15ddb6ce8de63322b12d281f9a4da6b18df`.
This is an exact post-acquisition readiness failure, not failed startup.

### R3-F2: durable job cancelled by viewer detach

In `server/fastify/src/streamJobs.ts`, immediately after `job.clients.delete(client)`:

```diff
+    if (job.operationId && !job.done && !job.abortController.signal.aborted) {
+      console.warn('[fault-durable-viewer-detach-abort]', job.operationId, job.id)
+      job.abortController.abort(new Error('Durable job incorrectly cancelled when its viewer detached'))
+    }
```

S82 **fails in 2.8s** at line 816's post-transfer durable-operation assertion.
The provider was held with the exact operation `owned_by_job`, current attempt
1 and a matching running attempt/job before actual UI takeover. B completed
promotion and SQL reached its session/epoch 2. The same operation then became
`retryable`, lost its current-attempt pointer and had no result. The server
marker names that exact operation/job; before any release or context cleanup,
the provider snapshot reports one invocation and one abort. No cancellation
request occurred. This is the intended production detach defect, not a teardown
abort or a fabricated provider response.

### R3-F3: accepted explicit setup decision dropped

In `src/ts/bootstrap.ts`, only the final decision of the existing setup dialog:

```diff
-    return selection === '0' && !controller.signal.aborted && isClientSessionOperationCurrent(operation)
+    const confirmed = selection === '0' && !controller.signal.aborted && isClientSessionOperationCurrent(operation)
+    if (confirmed) Reflect.apply(console.warn, console, ['[fault-explicit-setup-consent-dropped]'])
+    return false
```

S83 **fails in 31.1s** at line 1058's `settingsIsObject` initialization poll.
Before the real setup click, SQL proved null owner, writer epoch/revision/
projection epoch zero, absent settings and zero rows across 43 durable tables.
The Web Locks override, fresh identity and preserved previous-session metadata
were established. The accepted-decision marker proves the actual button reached
the guarded true result. Afterwards SQL remained unchanged with no writer or
initialization request. The browser received `/assets/bootstrap-jiyYAg0x.js`
with HTTP 200, SHA-256
`79fb326118288d838da5cff3d2910e00768da3714818c18c857269a164621f87`.

### Restoration and source limits

Each negative met its declared preconditions and failed its intended oracle;
all page-error arrays are empty. The lab's tracked source is clean, and every
frozen file matches the commit and main worktree. A clean restored build and the
unchanged three cases **pass 3/3 in 10.0s** (3.7s, 3.7s, 977ms). Their received
restored bootstrap chunk is `/assets/bootstrap-D1RXEDTQ.js`, SHA-256
`54abbda8001966d7a8df168dc85ef826b00e240b3472d94b8f6f3ad3fe19079a`.
The restored generation has one provider call/zero aborts; setup has one
initialization event, epoch 1 and unchanged ownership after the expected foreign
409; switching ends at A/epoch 3 with only the two original document requests.

The manifest, exact commands, source hunks, chunk receipts, traces, SQL/provider
snapshots and restored proof are under
`/tmp/reader-phase3-writer-switching-fault-evidence`. These results establish
explicit recovery composition, durable job survival and consent-driven first
initialization. Live reader partial output, observer effects and final default
rollout remain later reader phases. Phase-ending aggregate acceptance belongs
in reader status; no smoke Phase 3/4 acceptance is implied.

## Reader Phase 4 Production Fault Evidence

Candidate source: `40b3eb516b87bd37bd083fc7eb53daec53f732da`.
The unchanged five-case baseline passes in 49.2s after a 14.88s clean build,
with no page errors or forbidden Reader calls. Its source/emission records are
under `/tmp/reader-phase4-five-baseline-final-hr9fcca2`; all 1,322 successful
script URLs match the frozen 503-file emission catalog. This establishes
URL-to-emission attribution, not independent network-response byte hashes.
Earlier 0/4, 3/5 and 4/5 baselines remain recorded in
[reader status](../connected-read-only-clients/status.md#phase-4-implementation-2026-09-07),
including the reproduced Stop, settings/IGP and atomic receipt defects and the
separate expected-alert/TTS assertion corrections.

The six exact production faults below were reviewed before execution. Each
uses one deterministic negative in a detached worktree, with unchanged tests,
helpers and configuration; source is restored byte-for-byte between faults.
A final clean build and the unchanged five-case run supply all restored
controls (S84 jointly controls F1/F2). Commands in the isolated worktree add
`--config.verify-deps-before-run=false` to use the existing dependency symlink
without dependency-manager installation. They do not change test semantics.

Frozen spec SHA-256:
`3fc93e3ea1763785848f4410037dca8f0781c959335c91e2da68a6639c7ffd45`.
Frozen helper SHA-256:
`3f5bec3723b916ace0dbb0499caf540adbbeafd92a51f3e9565db3caed7c6560`.
The literal protocol, exact argv, source hashes and expected faulty hashes are
in `/tmp/reader-phase4-fault-campaign-p0d1439n/protocol.json`. Root independently
verified each replacement occurs once and produces its declared hash. Client
branch markers use retained Reflect calls because the production build strips
direct console calls. Server faults retain exact source and executed log
markers. A failure counts only after its declared prerequisites; downstream
steps that were not reached are never credited.

### R4-F1: Reader live partial omitted

Owner: `src/ts/server/readerGenerationObservation.ts`. Target: S84.

```diff
--- a/src/ts/server/readerGenerationObservation.ts
+++ b/src/ts/server/readerGenerationObservation.ts
@@ -241,7 +241,8 @@
     } else if (event.type === 'token') {
       accumulator.text += event.content
       if (!accumulator.gap && !next.halfStreaming) {
-        next.text = (next.continueDisposition === 'extend' ? (next.continueBase ?? '') : '') + accumulator.text
+        Reflect.apply(console.warn, console, ['RISU_PHASE4_F1_READER_PARTIAL', source.identity.jobId])
+        next.text = null
       }
       if (event.generatedTokens !== undefined) next.generatedTokens = event.generatedTokens
       if (event.elapsedMs !== undefined) next.elapsedMs = event.elapsedMs
```

Reader live partial count fails after A visible partial, SQL owned_by_job/running, one accepted user/op/attempt/provider and no result/effects. Does not qualify terminal or authority assertions.

**R4-F1 negative qualified:** S84 fails in 33.0s at the unchanged helper's
Reader partial-count assertion (line 594: zero versus one). A's visible partial
and accepted user/operation/attempt/provider prerequisites passed. At failure,
SQL has the same running attempt/owned job and no canonical result or effect
rows; provider calls are one, aborts zero, and viewers two. B emitted the retained
job-scoped marker. The marker-bearing `/assets/ReaderTranscript-CBGxU-Xf.js`
received HTTP 200 and maps to emitted SHA-256
`7a6ced881b3f3d4a8c3db4341883a3cc3993d26a7042721b9f5d2787f9ff9aa4`.
Source inputs stayed unchanged, page errors are empty, and byte-for-byte
restoration with all frozen hashes matching precedes F2. This qualifies partial
detection only; the shared restored control passes as recorded below.

### R4-F2: Reader canonical generated row omitted

Owner: `src/ts/server/readerTranscriptProjection.svelte.ts`. Target: S84.

```diff
--- a/src/ts/server/readerTranscriptProjection.svelte.ts
+++ b/src/ts/server/readerTranscriptProjection.svelte.ts
@@ -313,9 +313,11 @@
       )?.messages
     : copied
   if (!merged) return
+  if (merged.some((message) => message.role === 'char' && message.generationInfo?.operationId))
+    Reflect.apply(console.warn, console, ['RISU_PHASE4_F2_READER_CANONICAL', chatId])
   messages.set(chatId, {
     characterId: owner.characterId,
-    messages: merged,
+    messages: merged.filter((message) => message.role !== 'char' || !message.generationInfo?.operationId),
     projectionEpoch,
     generation: messageGeneration,
     sessionGeneration: captureClientSessionGeneration(),
```

Reader canonical convergence / temporary projection retirement fails only after its held partial passed, provider release, SQL one exact completed reply/attempt/event and current writer A canonical final. Verify the precise failed Reader assertion from the trace; do not claim generic downstream failures.

**R4-F2 negative qualified:** S84 fails in 37.6s at the exact canonical
result-ID body assertion on Reader B (helper line 876). Both held partials passed;
SQL then contains one completed attempt, result and generation.persisted event,
and writer A's same result-ID text assertion passed (`0-trace` call 335).
Reader B's row is missing (`1-trace` call 362). The publication marker ran 19
times; `/assets/resourceState.svelte-Ug8BkjZa.js` has HTTP 200 receipts and emitted
SHA-256 `252bc6c3ed3e9c0e96a0b9ac5cb12da0e96de66e9267440dec0e2ce30078d8a6`.
Provider calls remain one, aborts zero, and page errors are empty. All frozen
inputs match after restoration before F3; the shared restored control passes as recorded below.

### R4-F3: Detached viewer registry membership retained

Owner: `server/fastify/src/streamJobs.ts`. Target: S85.

```diff
--- a/server/fastify/src/streamJobs.ts
+++ b/server/fastify/src/streamJobs.ts
@@ -845,7 +845,7 @@
   detach(jobId: string, client: JobClient): void {
     const job = this.jobs.get(jobId)
     if (!job) return
-    job.clients.delete(client)
+    console.info('RISU_PHASE4_F3_VIEWER_DETACH', jobId)
     if (job.done && job.clients.size === 0 && job.replayEvents === undefined) {
       this.cleanup(jobId)
     }
```

Viewers fail to become one after actual B Other Chat navigation/Reader URL, starting from two live viewers/Reader partial. Provider calls remain one/aborts zero and same SQL job remains running. Do not claim later close/reopen was reached.

**R4-F3 negative qualified:** S85 fails in 12.6s after both live partials/two viewers,
then B's actual Other Chat click, Reader route/chat scope and cleared generation
projection. The registry-viewer assertion (spec line 76) remains two instead of
one. SQL still has the same running attempt/owned operation; provider calls
are one, aborts zero and completion false. Executed server detach markers name
that exact job. Later close/reopen is not reached and is not credited to this
negative. Source is restored with all frozen hashes matching before F4; the
shared restored control passes as recorded below.

### R4-F4: Promoted Stop loses its optional cancellation guard

Owner: `src/ts/server/generationOperations.ts`. Target: S86.

```diff
--- a/src/ts/server/generationOperations.ts
+++ b/src/ts/server/generationOperations.ts
@@ -831,7 +831,8 @@
   operation: GenerationOperationProjection,
   previous?: GenerationOperationCancellation,
 ): ActiveChatTarget | undefined {
-  if (previous?.target) return previous.target
+  if (!previous) Reflect.apply(console.warn, console, ['RISU_PHASE4_F4_PROMOTED_STOP', operation.operationId])
+  if (previous!.target) return previous.target
   if (!operation.chatId && !operation.characterId) return undefined
   return {
     selectedCharID: -1,
```

Exact missing previous.target TypeError on actual current-writer B Stop; SQL never reaches stopping. Prerequisites: real A-to-B confirmation, SQL epoch2, B authorized recovery/ready controls, A Reader partial and same job/provider. The expected TypeError is named evidence, not a generic pageerror failure. Do not claim the later stopping transfer was reached.

**R4-F4 negative qualified:** S86 fails in 13.3s at spec line 145:
SQL remains `owned_by_job` instead of `stopping`. Real B confirmation and Stop
clicks completed after SQL epoch 2 and writer recovery/readiness; A's Reader
partial passed. The operation-scoped marker ran inside that Stop click. The
single B page error is the intended `Cannot read properties of undefined
(reading 'target')`; provider calls stay one, aborts zero, and no cancellation
request is accepted. The later stopping-state transfer is not reached. Source
and frozen input hashes match after restoration before F5. The marker-bearing
`/assets/database.svelte-Ds6Cc2t4.js` has HTTP 200 receipts and emitted SHA-256
`9def5e330f378c1159b5045edf39eb1e42db89e222e8ae3b1ef325d4515de07a`.
The shared restored control passes as recorded below.

### R4-F5: Recovered IGP settings omitted from narrow reads

Owner: `server/fastify/src/routes/resourceReads.ts`. Target: S87.

```diff
--- a/server/fastify/src/routes/resourceReads.ts
+++ b/server/fastify/src/routes/resourceReads.ts
@@ -1238,7 +1238,8 @@
   // cross-resource event invalidates that collection separately.
   // Legacy IGP configuration remains round-trip-owned; reading it for a
   // recovered effect does not introduce a generic settings mutation path.
-  const readOnlyKey = group === 'language' ? 'translatorPresetId' : group === 'advanced' ? 'igpPrompt' : null
+  if (group === 'advanced') console.info('RISU_PHASE4_F5_RECOVERED_IGP_CONFIG')
+  const readOnlyKey = group === 'language' ? 'translatorPresetId' : null
   const groupKeys = readOnlyKey ? [...SETTINGS_GROUP_KEYS[group], readOnlyKey] : SETTINGS_GROUP_KEYS[group]
   const keys = groupKeys.filter(
     (key) =>
```

Completed late_recovery IGP receipt fails as skipped/not_configured after real queued journal/finalizing attempt/provider done once, exact writer error OK acknowledgement, actual A-to-B transfer while queued and only then trigger removal. SQL canonical settings stay configured and base result persists once; no IGP provider/PATCH. Does not qualify atomic receipt loss.

**R4-F5 negative qualified:** S87 fails in 39.6s at the exact receipt assertion
(helper line 946), after passing its real queued-journal and
finalizing-attempt prerequisites, exact writer Error/OK acknowledgement, and
A→B transfer while the journal is still pending. Only after the failure trigger
is removed does the normal retry worker persist one base result. The exact
IGP receipt is `skipped/not_configured` instead of completed late recovery;
canonical SQL IGP settings are unchanged, while B's actual HTTP 200 advanced
settings response omits `igpPrompt`. No IGP completion request or message update
occurs. Server settings-read markers execute and page errors are empty. All
source/frozen hashes match after restoration before F6; the shared restored
control passes as recorded below.

### R4-F6: Accepted IGP append omits its atomic receipt

Owner: `server/fastify/src/generationEffects.ts`. Target: S88.

```diff
--- a/server/fastify/src/generationEffects.ts
+++ b/server/fastify/src/generationEffects.ts
@@ -533,6 +533,8 @@
     // require the same generation precondition as the ordinary text command.
     if (metadata.generationId !== undefined && input.expectedGenerationId !== input.generationId) return false
   }
+  console.info('RISU_PHASE4_F6_ATOMIC_IGP_RECEIPT', input.generationId, input.claimId)
+  return true
   const completed = settleGenerationEffect(db, {
     databaseLineage: input.databaseLineage,
     generationId: input.generationId,
```

Held real PATCH boundary fails IGP completed expectation as claimed, after real A/B roles/partial, provider terminal, live IGP claim/provider and accepted route.fetch PATCH with one SQL suffix/message.updated/command receipt. Browser has not received response. All transaction/lineage/lease/message guards remain. Actual subsequent transfers are downstream and must not be claimed reached on this negative.

**R4-F6 negative qualified:** S88 fails in 8.0s at spec line 444. The
actual held PATCH returns HTTP 200 with one real echo completion, one appended
suffix/message.updated and a stored command mutation receipt, but the held
independent SQL snapshot has IGP `claimed` instead of completed. The executed
server marker matches the exact generation and claim IDs. Normal response
release and the subsequent role transfers are not reached; cleanup-only release
is recorded separately. No page errors occur. All six faults are now restored
byte-for-byte, the detached source is clean and every frozen input matches.
The shared clean-build/five-case restored control passes as recorded below.

### Phase 4 restoration and limits

All six negatives qualify against their exact prerequisites and failed
assertions. The shared restored control passes **5/5 in 51.1s**, after a clean
12.32s build, at the same frozen source/test/helper hashes. The detached worktree
is clean, every frozen input matches the main source, and restored emitted
JavaScript contains none of the six fault markers. All five cases have nonempty
Reader dispatch audits, no forbidden Reader calls and no page errors. Viewer
counts reach zero at terminal completion; only the deliberate Stop journey
aborts its provider once.

S88 again completes both real role transfers, the late original PATCH response
and Reader Refresh with one IGP execution/PATCH transport, one appended suffix
and the same atomic completed receipt. The restored five cases jointly control
all six faults, with S84 controlling both partial and canonical publication.
Its 1,321 successful script URL receipts map to the frozen emission catalog;
network-response byte hashes are not claimed.

The final source/emission proofs, exact executed commands, individual
qualifications and raw artifacts are linked by
`/tmp/reader-phase4-fault-campaign-p0d1439n/campaign-summary.json`. These controls
establish the named observation, detach, Stop, configured-effect and atomic
receipt boundaries. Reader Phase 5 owns the final rollout and combined matrix;
the remaining smoke Phase 3 audit is still pending. Phase-ending aggregate
acceptance is recorded in reader status.

## Reader Phase 5 Production Fault Evidence

Source: `22da08cd11f400e8fa61e294ed87b32d339b7b03`. The corrected TRUE build
passes all 28 affected cases, the S32 companion and the full 91-case cohort
(193.4s). The full run requires and passes the integration-artifact merge.
The five faults below were declared before execution and applied separately
in a disposable detached checkout. Tests, fixture controls, dependencies and
browser configuration stayed unchanged. Every fault had one fresh TRUE build
and one selected negative run; no retry-until-green or additional matrix was
used. Each production file was restored byte-for-byte before the next fault.

| Fault / case | Independent path and state prerequisites                                                                                                                                                                                                                                      | Intended and observed failure                                                                                                                                                                                                                                  | Negative / restored case time      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| P5-F1 / S80  | Writer owns epoch one; B and C are distinct, live Readers. Real append is HTTP 200/revision one with its exact SQLite row/event. B's exact-text and revision assertions pass before C's.                                                                                      | Per-instance shared Reader revision deduplication suppresses C; its exact common-message DOM assertion at spec line 347 fails. Server marker identifies revision one.                                                                                          | 37.1s failure / 7.2s restored pass |
| P5-F2 / S89  | Initial writer/Reader startup and real Fastify/SQLite stop/rebuild pass with unchanged durable state. Reader timer marker executes; rebuilt server has one writer SSE and no Reader SSE.                                                                                      | The post-restart status assertion at spec line 150/helper line 148 remains interrupted for its bounded 30s instead of connected reading. No later edit/teardown assertion is claimed as reached.                                                               | 32.4s failure / 3.5s restored pass |
| P5-F3 / S90  | Actual UI edit commits once while its response is held; a native encrypted row and newer draft sequence are captured. The cleanup marker names that mutation with equal current/scope lineage and `managed=false`. Fallback writer startup and newer visible draft both pass. | Real current-lineage deletion leaves one original command attempt instead of at least two at line 378; no replay/ACK occurs. SQL retains one committed edit/event/unacknowledged receipt. The real discarded-changes alert is retained as a fault side effect. | 3.5s failure / 3.1s restored pass  |
| P5-F4 / S90  | Native intent and newer draft exist before reload. Actual fallback reaches writer-ready with empty queues; captured transport independently proves same-ID/body replay, one ACK and one SQL edit/event/receipt.                                                               | The read persisted draft is not restored into the composer; line 368 receives empty text instead of the newer draft. Later test-body receipt assertions are not reached; the stated receipt checks come independently from the captured artifacts.             | 8.5s failure / 3.1s restored pass  |
| P5-F5 / S91  | Real import produces a new lineage; the old held PATCH receives actual 409 after coherent Reader replacement. Actual Use this device sends conditional bootstrap 200, restores writing with editable composer/empty queues, and preserves owner/epoch one, SQL and document.  | Only then, the guarded route restoration omission leaves the saved character sidebar false at line 470. Original sidebar was true; executed marker identifies the matching route.                                                                              | 2.2s failure / 2.1s restored pass  |

Negative build times are 14.04/13.72/14.21/12.13/12.87s. The shared clean restored
build passes in 13.14s and its four cases pass **4/4 in 18.3s**. No emitted or
runtime fault marker remains; no page error occurs. Its 1,374 successful script
URLs map to the 503-file emitted catalog. Client-fault marker chunks have actual
successful served URL receipts; their emitted SHA-256 values and executed
markers were captured. URL attribution is not downloaded-response-byte hashing.
The following hashes and literal diffs, together with the Git source, preserve
reproduction independently of temporary artifacts.

| Fault | Production file                                | Baseline SHA-256                                                   | Fault SHA-256                                                      |
| ----- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| P5-F1 | `server/fastify/src/routes/events.ts`          | `e22528b79e8847b103eb94fa03225f0cd4eb9bbe025843f849916a805d12b0a0` | `a5512ff5d596a6722bf07219f0cc5ac2136a3b882dafc5c4ba793d8c72d10773` |
| P5-F2 | `src/ts/server/connectedReaderSync.ts`         | `bae104468e77ac2139575e376c2ecb822ea7a546bacd9dba804c856cc6751223` | `0d448dda40a3a18634c186f5d1ff66cb7ee7c7b54821cd88a75c05b62da7121c` |
| P5-F3 | `src/ts/server/pendingMutationOutbox.ts`       | `34161c73478217ceaacb2a9dc1775d14b13432006fa809fccac6d8ba7a49545c` | `dbe25b9317ec2c4f1902e9299fcf176f500a9478d9c5d382d776bccb855808f6` |
| P5-F4 | `src/lib/ChatScreens/DefaultChatScreen.svelte` | `aecde2a25a17c623679d0d13e49cb122991c297660aa810077cdf8afb9132f30` | `54923ba8b304e72eafe60f1cec2525b49976e923e7769979abf453352d8ec3d1` |
| P5-F5 | `src/ts/router.ts`                             | `84e40e58fb5cd16a5791826bc5fbd7018caaa0de42bb278a95b2213ded85283c` | `2db509e3900b7fea8d6f408f8025cfb32fee52ba39f94fb318827c197dc7c97b` |

The three affected browser specs are frozen at the following SHA-256 values;
all other harness/configuration/dependency inputs are fixed by the source commit.

- `server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts`: `2d30cbb274c4dc28fd97f1c051cb875f69c64ac16dcffa3668f77c4d052c4b2f`.
- `server/fastify/browser-smoke/connectedReaderRollout.spec.ts`: `7b3b765a1aefcacb5fd15ba2cf3a64c3f4d01696687bd95a87bfb02988fd8e8c`.
- `server/fastify/browser-smoke/visibleStateRecovery.spec.ts`: `2268b2bffe6d76a6ebd659dc9e33eedee131cb49ce85f6ec09fbfe6c63778846`.
- `server/fastify/browser-smoke/connectedReaderRolloutHarness.ts`: `a66bb56c940fc6871a4339385a6ab201c17868c29ff99235c44aea861beb0a09`.

Reproduce in a fresh detached worktree at the source above. Link the existing
matching `node_modules`, then use `pnpm --config.verify-deps-before-run=false`
only in that disposable checkout so pnpm does not replace the linked dependency
tree. Node v24.19.0, pnpm 11.23.0, Playwright 1.62.1 and Chromium 151.0.7922.34
are the recorded runtime. For each fault, apply only its literal diff below,
build with `VITE_FAST_BOOTSTRAP_OBSERVER=TRUE`, and execute its exact test title
with one worker and tracing. Do not set `RISU_READER_ROLLOUT_COMPILED_FALLBACK`.
The fixture remains the ordinary default-to-explicit-disabled fallback for S90;
actual compiled-FALSE verification is a later rollout check.

```sh
VITE_FAST_BOOTSTRAP_OBSERVER=TRUE pnpm --config.verify-deps-before-run=false build:smoke
VITE_FAST_BOOTSTRAP_OBSERVER=TRUE pnpm --config.verify-deps-before-run=false exec playwright test --config playwright.fastify-smoke.config.ts SPEC --grep 'EXACT TITLE' --workers=1 --trace=on
```

Replace `SPEC` and `EXACT TITLE` with the corresponding row below. Restore the
single changed production file from the recorded Git source between faults.
After all restorations, rebuild TRUE once and run S80, S89, S90 and S91 unchanged
with the same one-worker/trace settings as the shared restored control. A build,
setup or generic timeout failure cannot substitute for the stated assertion and
independent prerequisites.

| Fault | Spec                                                           | Exact title                                                                                                 |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P5-F1 | `server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts` | a mobile connected Reader follows committed updates and browses locally without taking write access         |
| P5-F2 | `server/fastify/browser-smoke/connectedReaderRollout.spec.ts`  | default connected Reader reconnects after an actual server restart without page reload or write takeover    |
| P5-F3 | `server/fastify/browser-smoke/connectedReaderRollout.spec.ts`  | conservative fallback reload replays one UI-saved command and preserves the newer unsent composer draft     |
| P5-F4 | `server/fastify/browser-smoke/connectedReaderRollout.spec.ts`  | conservative fallback reload replays one UI-saved command and preserves the newer unsent composer draft     |
| P5-F5 | `server/fastify/browser-smoke/visibleStateRecovery.spec.ts`    | connected-default import recovery preserves the character sidebar after explicit same-owner writer recovery |

### P5-F1: Shared Reader revision cursor

```diff
--- a/server/fastify/src/routes/events.ts
+++ b/server/fastify/src/routes/events.ts
@@ -109,6 +109,7 @@
   memoryEvents: MemoryEventBus,
   activeWriterState: ActiveWriterState,
 ): void {
+  let lastReaderCommandRevision: number | null = null
   app.get('/api/v1/events', { exposeHeadRoute: false }, async (req, reply) => {
     if (!(await requireAuth(authState, req, reply))) return

@@ -164,6 +165,13 @@
     unsubscribeCommand = commandEvents.subscribe((event) => {
       if (liveCommandDelivery) {
         if (!reply.raw.writableEnded) {
+          if (readActiveWriterSessionId(req) === null) {
+            if (lastReaderCommandRevision === event.revision) {
+              console.info('[reader-phase5-f1-shared-reader-revision]', event.revision)
+              return
+            }
+            lastReaderCommandRevision = event.revision
+          }
           sendFrame('command', formatCommandEvent(event))
         }
         return
```

### P5-F2: Omitted interrupted-reader reconnect

```diff
--- a/src/ts/server/connectedReaderSync.ts
+++ b/src/ts/server/connectedReaderSync.ts
@@ -145,7 +145,7 @@
     if (!current() || reconnectTimer || browserIsOffline()) return
     reconnectTimer = setTimeout(() => {
       reconnectTimer = null
-      void connect()
+      Reflect.apply(console.warn, console, ['[reader-phase5-f2-omitted-reconnect]', lineage, epoch])
     }, calculateConnectedReaderReconnectDelayMs(attempt++))
   }

```

### P5-F3: Current-lineage intent disposed during fallback

```diff
--- a/src/ts/server/pendingMutationOutbox.ts
+++ b/src/ts/server/pendingMutationOutbox.ts
@@ -574,7 +574,8 @@
     assertOutboxRecovery(generation)
     if (managed) adoptScope()
     for (const mutation of mutations) {
-      if (mutation.databaseLineage !== scope.databaseLineage) {
+      if (!managed || mutation.databaseLineage !== scope.databaseLineage) {
+        Reflect.apply(console.warn, console, ['[reader-phase5-f3-discard-current-lineage]', mutation.mutationId, mutation.databaseLineage, scope.databaseLineage, managed])
         mutationStore.delete(mutation.mutationId)
         discardedMutationIds.push(mutation.mutationId)
       }
```

### P5-F4: Persisted composer text not restored

```diff
--- a/src/lib/ChatScreens/DefaultChatScreen.svelte
+++ b/src/lib/ChatScreens/DefaultChatScreen.svelte
@@ -1184,7 +1184,8 @@

   function restoreComposerDraft(identity: string | null): void {
     const draft = identity ? readDefaultChatComposerDraft(identity) : undefined
-    messageInput = draft?.messageInput ?? ''
+    if (draft?.messageInput) Reflect.apply(console.warn, console, ['[reader-phase5-f4-omitted-composer-restore]', identity])
+    messageInput = ''
     messageInputTranslate = draft?.messageInputTranslate ?? ''
     fileInput = [...(draft?.fileInput ?? [])]
     draftText = draft?.draftText ?? ''
```

### P5-F5: Guarded character-sidebar restoration omitted

```diff
--- a/src/ts/router.ts
+++ b/src/ts/router.ts
@@ -409,7 +409,9 @@
 ): void {
   if (!isFresh() || !characterSidebarViewStateMatches(route)) return
   const selectedCharacter = selectedCharacterForSidebarRestore()
-  if (selectedCharacter?.chaId === route.chaId) botMakerMode.set(true)
+  if (selectedCharacter?.chaId === route.chaId) {
+    Reflect.apply(console.warn, console, ['[reader-phase5-f5-omitted-sidebar-restore]', routeKey(route)])
+  }
 }

 function selectedCharacterForSidebarRestore() {
```

The restored controls verify both Readers' common/independent updates and no
forbidden calls; server restart followed by a real edit and zero final native
SSE counts; exact fallback replay/receipt/newer draft; and a true character
sidebar after same-document, same-owner new-lineage promotion. S91 captures
actual import and conflict responses, conditional acquisition and downstream
reads. It does not capture raw `state.imported` SSE frame consumption; that
causal detail is inferred from production source and observed replacement.
Mobile profiles and lifecycle controls remain Chromium emulation. The restart
rebuilds a Fastify instance and reopens SQLite in the test process, not an OS
process kill. Deterministic local providers and native browser storage preserve
the named boundaries without certifying physical devices or external providers.

The Phase 5 integration repairs remain separately traceable in
[reader status](../connected-read-only-clients/status.md#phase-5-enabled-build-baseline-and-integration-repairs):
initial-preview display gating (`36f0d33ff`), writer reroll hydration after Reader
residency (`f24d781ae`), initial locale/shell retry (`a9e2ad06e`), per-sample
fixture ownership (`e8333ffa2`), and owned-context shutdown (`22da08cd1`). The
mounted/hydration/bootstrap regressions record actual pre-fix failures and
post-fix passes, while unchanged browser product oracles pass in the corrected
full cohort. S44 and S77 retain their conservative contracts, with connected
recovery separately owned by S80 and S91. No second-reader, restart, replay,
draft or sidebar fault result accepts the pending default/FALSE rollout builds
or the reader phase's final aggregate gates.

## Reader Phase 5 Default and Fallback Build Proof

Frozen source `a394b13101190c367c254e4cdcd3af6628b4f4e1` includes the default
change in `70a8b18e1`; no test, fixture or production source changes occur between
these profiles. The normal build unsets both rollout environment selectors and
passes S89/S90/S91 (3/3, Playwright 18.8s). Initial overrides are null in the two
rollout cases and S91's exact null assertion passes. The FALSE build runs only
S90 with its pre-existing compiled-fallback selector (1/1, 5.6s). Its initial
writer/Reader setup is deliberately enabled, then the writer removes that
override before actual reload. The resumed conservative writer has
`managed=false`, its original identity/lineage/epoch one, a same-ID/body replay,
one ACK, one SQL edit/event/receipt, empty native queues and the newer visible
draft. The Reader remains in its original document with no forbidden request.

| Profile            | Build process | Browser result                                                               | 503-file emitted catalog digest                                    |
| ------------------ | ------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Normal, flag unset | 15.55s        | S89/S90/S91: 3 passed                                                        | `1ec95446d85ccab71472476e4378591a89895e66a5cdddc0a042b1b45e9901df` |
| Explicit FALSE     | 13.19s        | S90 compiled fallback: 1 passed                                              | `397b0f5d1e9eceeb481fef50aa1f722b3bb5bc28d0cc44e3e2065c380fb5869d` |
| Restored normal    | 14.30s        | No extra browser repetition; every emitted file hash matches original normal | `1ec95446d85ccab71472476e4378591a89895e66a5cdddc0a042b1b45e9901df` |

The profile checkout freezes 2,473 inputs with digest
`6d51d036d5ad18f120d25d9096b431cdf29de41e40957ec98b41abea373c9e30`.
Normal/FALSE capture 702/343 successful script URL receipts and zero page errors;
all source inputs stay unchanged. The catalog digest summarizes captured emitted
file hashes, not downloaded network-body hashes. The native FALSE row has a
12-byte IV and 220-byte ciphertext before reload; sequence one/two drafts are
created through actual composer input. The post-reload command permits only
baseRevision rebasing and ACK changes only the original receipt's acknowledged
field. No fixture writes the expected pending row or draft on behalf of the UI.

Reproduce at that source with the same runtime/dependencies and detached-checkout
rules as the preceding fault campaign. Use the S89/S90/S91 exact titles from its
table for the normal three-case selection. The commands below show equivalent
unique title prefixes; no browser case or assertion changes between profiles.

```sh
env -u VITE_FAST_BOOTSTRAP_OBSERVER -u RISU_READER_ROLLOUT_COMPILED_FALLBACK pnpm --config.verify-deps-before-run=false build:smoke
env -u VITE_FAST_BOOTSTRAP_OBSERVER -u RISU_READER_ROLLOUT_COMPILED_FALLBACK pnpm --config.verify-deps-before-run=false exec playwright test --config playwright.fastify-smoke.config.ts server/fastify/browser-smoke/connectedReaderRollout.spec.ts server/fastify/browser-smoke/visibleStateRecovery.spec.ts --grep 'default connected Reader reconnects|conservative fallback reload replays|connected-default import recovery preserves' --workers=1 --trace=on
VITE_FAST_BOOTSTRAP_OBSERVER=FALSE pnpm --config.verify-deps-before-run=false build:smoke
VITE_FAST_BOOTSTRAP_OBSERVER=FALSE RISU_READER_ROLLOUT_COMPILED_FALLBACK=TRUE pnpm --config.verify-deps-before-run=false exec playwright test --config playwright.fastify-smoke.config.ts server/fastify/browser-smoke/connectedReaderRollout.spec.ts --grep 'conservative fallback reload replays' --workers=1 --trace=on
env -u VITE_FAST_BOOTSTRAP_OBSERVER -u RISU_READER_ROLLOUT_COMPILED_FALLBACK pnpm --config.verify-deps-before-run=false build:smoke
```

The final command restores the documented normal configuration; compare the
complete emitted file hash mapping with the first build. The final phase's
aggregate checks separately build and execute the normal full suite. The
mixed-client policy still relies on the retained conservative-handshake path,
not an unchanged historical bundle gaining the new Reader interface.

## Reader Phase 5 Final-Gate Repairs

Source: failed full gate `90069ac9c`; combined repairs `678876571`. The full run
passes 89/91 browser cases and all twelve other lanes. Its S47 trace and S22
structured samples are preserved in `/tmp/reader-phase5-final-all-failures` and
`/tmp/reader-phase5-s22-pause-audit-f95utidf`; the checked-in descriptions below
retain the causal boundaries independently of those temporary artifacts.

### BSE-006: Retained Reader route suppresses newer writer navigation

Classification: reproduced production route bug, repaired in `a703b9d4b`;
built-browser negative/restored proof is completed below. Risk: an authorized writer
navigates to Settings during initial route loading but remains on the character
view. Original S47 reaches `background-ready`, calls the real router, and never
requests Settings/Language assets. Its character-handler request spans
61,763.591–61,773.876ms; the startup milestone completes at 61,766.637ms and newer
navigation spans 61,772.157–61,786.596ms. The resulting URL loses its chat suffix.
Source and mounted pre-fix failures separately identify retained-intent priority
and obsolete completion as the route ownership defects.

The repair compares the actual URL's semantic route key with the retained intent,
consumes only the mismatched exact sequence and fences completion by effect
lifetime. Equivalent aliases and matching failed retries are preserved. All 72
App/router/intent focused tests pass. S92, added by `678876571`, holds the actual
manifest-resolved character-handler response, proves writing/canMutate/canGenerate
and initial `route.loading`, invokes production navigation and requires a visible
Language selector with Settings ready while that older response is still held.
After actual HTTP 200 delivery it retains Settings, capabilities and the same
document across two paint frames. That final observation does not claim exact
callback settlement; the mounted test's held promise proves the completion fence.

### BSE-005: Prepared readable pause at the real remount return

The failed run's fourteen sample-zero anchors are unreadable; seven pauses gain
readable rows later. Pause 11's message 241 is readable at zero drift from sample
1 through 29, but retrospective selection cannot count as a passing oracle.
Four source files match the earlier accepted BSE-005 bytes: the test, parse memo,
ChatBody and display scheduler. Earlier passing controls had only 1/2/3/1 initial
readable anchors and four to seven wholly unreadable pauses. These observations
establish recurring sampling coverage, not a newly regressed production delay or
geometry defect; no pause geometry assertion ran in this failed full run.

`d72f12a01` keeps both fixed seven-gesture passes, all fourteen original pause
arrays and continuous/traversal/direct remount oracles. At the existing return
after proven row-298 unmount, the final native input completes through CDP. A
five-second, 32ms bounded preparation captures the first geometric visible row
as soon as it is readable; that exact snapshot becomes sample zero before the
next 29 measured frames. Every measured frame requires the same identity,
visibility/readability and at most one-pixel drift. The preparation and measured
samples also retain the existing 76-resident-row bound. No later surviving-row
filter, per-gesture hydration wait, relaxed threshold or additional workload
matrix is introduced. The retained parser-owner fault still targets the earlier
direct row-298 remount text assertion, before this new pause; it cannot certify
new geometry-fault detection.

### Initial frozen combined verification protocol

The detached lab freezes all 2,473 production/test/configuration inputs at
`678876571`, digest
`3dae9bcfac1f9f1fb5608bf32aa94d567f613df78ee3e474643b64c47c4bbaa7`.
The S22 test SHA256 is
`03b1bad019e31f0150254ef7cf92be5fe92a47a014447ad7053cd9902f7f269a`;
the locale/S92 spec SHA256 is
`f8353dec1e6e5853cbc6e2310b1ab979dcdeed4cd876310a6451136e2377d8cc`.
No test, helper, fixture or configuration changes between baseline, negatives
and restored controls. Root independently checks the literal faults and hashes.

Normal stages unset `VITE_FAST_BOOTSTRAP_OBSERVER`,
`RISU_READER_ROLLOUT_COMPILED_FALLBACK`, `RISU_FAST_BOOTSTRAP_ARTIFACT_REQUIRED`
and `RISU_BROWSER_SMOKE_WORKERS`, with `VITE_FASTIFY_BROWSER_SMOKE=TRUE`.
Build using `pnpm --config.verify-deps-before-run=false build:smoke`; invoke
Playwright with the existing smoke config, one worker, and separate output
directories. Baseline runs all four selected-locale, four visible-recovery and
three switching cases with trace on, then S22 twice with trace off. The latter
retains structured viewport, runtime and successful script URL observations.

F1 applies exactly the earlier BSE-005 parser-owner hunk, source SHA256
`678627abd356b1f4846b93ebb768340935ca1cd7e076d6f874fcc7e2da2626c0`
to fault SHA256
`333fe90628be830cbb7ecb27f927961f5c1b905973807d5bf5c5ba0ee26f4ba3`.
After a fresh build, both S22 repetitions must reach initial thirty readable
rows, seven gestures, actual row-298 unmount and fixed return, then fail its
ordinary remount text assertion. Both require the exact row-298 runtime marker
and a successful response for the preserved emitted fault chunk. Preparation-
only or unrelated failures cannot qualify. Restore exact source before F2.

F2 changes only App's semantic mismatch branch, retaining effect cleanup:

```diff
     if (observerIntent && routeKey(observerIntent.route) !== routeKey(currentWriterRoute)) {
-      consumeObserverRouteIntent(observerIntent.sequence)
-      observerIntent = null
+      Reflect.apply(console.warn, console, [
+        '[reader-phase5-s92-retained-route-priority]',
+        routeKey(observerIntent.route),
+        routeKey(currentWriterRoute),
+      ])
     }
```

App SHA256 changes from
`964fb7fb1d4af84216a3cc14dbaa201b95144f2f1bc621c280996b95b63839d4`
to `45b47bfce575b12be524d2a1d1d13a7e101dcf14ef63538f146471b8c5d31d08`.
Fresh-build S92 must establish healthy writer/held initial handler, navigate to
the actual Settings URL and execute the marker with old character and new
`settings:10:` semantic keys. Its intended failure is the visible Language
selector before the handler is released. Trace ordering must distinguish cleanup
release from the failed assertion; a final `handlerReleased=true` alone cannot
qualify the fault. Require the successful served marker-chunk response. This
fault detects intent priority; it does not separately detect effect cleanup.

After restoring all source, a fresh normal build must match the entire baseline
emitted catalog; run S22 twice and S92 once unchanged. Build with exact
`VITE_FAST_BOOTSTRAP_OBSERVER=FALSE`, then run S90 once with
`RISU_READER_ROLLOUT_COMPILED_FALLBACK=TRUE`: remove the writer override before
real reload and require unmanaged fallback, same native encrypted command/
semantic body, one ACK and restored newer draft, with a clean Reader. A final
normal rebuild must match every baseline emitted file. Previous five feature
faults and Phase 4 controls retain their recorded scope. This bounded campaign
renews the changed App/S22 and default/fallback composition only; final agent
and required phase-ending full gates still own acceptance. Artifacts and exact
argv/environment manifests: `/tmp/reader-phase5-combined-repair-stieh7rl`.

The first combined baseline at `678876571` stops at **10/11 (29.0s)** after a
12.15s normal build. S92 passes Settings visibility/readiness with the handler
held, real response delivery, retained Settings and same-document checks, then
fails its incorrect final `canGenerate=true`. The held snapshot already shows
`canGenerate=false`: Settings sets `selectedCharID=-1`; the selected-target
subscription clears startup chat readiness. Mutation access and the same writer
remain usable. `60ac61bde` corrects the new case to require that Settings state
before and after release and retain the same writer authority. Initial chat
readiness and the held-handler navigation oracle are unchanged. All 2,473 inputs
remain frozen and 1,750 successful script URLs map to the 503-file catalog, with
no page errors or markers. No S22 or negative stage ran. Preserve this failure
and restart the declared campaign from the corrected test source.

### Renewed Combined Controls and Fallback

At corrected source `60ac61bde`, the fresh lab freezes 2,473 inputs, digest
`97ce3a01c4b89f4e1b130c0429e5b77fa79e094ea527dca94544a41774c2db03`.
Only the new S92 expectation changed from the failed `678876571` baseline; its
spec SHA256 is now
`117839a6164f8c276c485325178227785b1a7916a4360dc97dc158893be220ad`.
Both literal production faults and their source/fault hashes remain exactly as
predeclared above. Tests, helpers, fixtures and configuration remain frozen
through the campaign. Main receives documentation changes only.

| Stage                       | Fresh build process | Browser result                                                                                | Successful script URL receipts |
| --------------------------- | ------------------: | --------------------------------------------------------------------------------------------- | -----------------------------: |
| Normal baseline, flag unset |              13.13s | All eleven navigation/recovery/switching cases pass (29.5s); S22 passes twice (50.7s, 45.5s). |                          1,982 |
| F1, parser-owner fault      |              13.38s | Both S22 cases fail the intended direct remount text assertion (20.0s, 19.5s).                |                            232 |
| F2, retained route priority |              13.10s | S92 fails visible Language selector before handler release (6.7s).                            |                            116 |
| Restored normal control     |              14.35s | S22 passes twice (44.9s, 44.3s), then S92 passes (1.4s).                                      |                            355 |
| Actual compiled `FALSE`     |              15.33s | S90 fallback variant passes (3.0s case; 4.6s Playwright).                                     |                            343 |
| Final normal restoration    |              13.45s | No additional browser run; all 503 emitted files match baseline.                              |                              — |

There are **17 passing browser executions and three qualified expected negative
executions across two faults**, with zero page errors. All 3,028 successful script
URLs map to their preserved emitted catalogs; network response bodies were not
independently hashed. Both source faults are restored byte-for-byte, every lab
input matches its frozen source and the lab is clean. The completed compact
manifest is `/tmp/reader-phase5-combined-repair-ykatvwo7/campaign-summary.json`.

All four passing S22 executions retain fourteen original pauses of thirty
samples, plus the separate prepared thirty-frame pause. Each captures geometric
row 297 in its first preparation snapshot before further sampling; every measured
frame keeps that identity visible/readable at zero top drift. Maximum residency,
including preparation, is 31 against the unchanged 76-row bound. Original rapid
sample-zero anchors number 2/2 in the baseline and 3/1 after restoration. The
added pause therefore provides explicit measured coverage without replacing any
original observation or retrospectively selecting a survivor.

F1 reaches the direct row-298 text assertion at spec line 161 after initial thirty
readable bodies, the first seven gestures, actual unmount and both fixed native
return inputs. Both bodies remain whitespace. Each run records the exact
row-298 owner-mismatch marker and HTTP 200 for `/assets/Chat-DMwQseV9.js`, SHA256
`d7fea58d32a7042e6b25848dd3612c135fca47eec20719400374cd5a9ca23df9`.
Both have five older-page requests and no page errors. The new prepared pause is
not reached; this remains direct remount-readability fault detection.

F2 first establishes managed writing/live authority, mutation/generation readiness
and the actual held character-handler request. Production navigation changes the
URL to Settings; the runtime marker reports old character and new `settings:10:`
keys, but its Language selector is absent. The exact assertion fails at
8,294.524ms; handler continuation begins only at 8,295.292ms and the HTTP 200
response completes at 8,300.239ms during cleanup. Root independently checks this
ordering in the raw trace. The served marker chunk is
`/assets/appStartup-N4Rmfhw5.js`, SHA256
`0fc1aeb260f6e0f45d2796e94a06df698d54c7c38a870316733cd19b51437cd0`.
The restored S92 reaches visible/ready Settings while the handler remains held,
then retains the same document/writer and mutation-ready, generation-disabled
Settings state after actual delivery. Effect-cleanup fault coverage remains the
separate mounted held-promise test's scope.

The renewed FALSE variant removes the writer override before actual reload. It
becomes unmanaged with the same session, lineage and writer epoch one. A native
encrypted retained row (12-byte IV, 220-byte ciphertext) replays the same mutation
ID and semantic patch; only baseRevision rebases from one to two. Exactly one
HTTP 200 ACK settles that receipt; SQL has one edit event and one receipt, with
only acknowledgement changed. The newer sequence-two composer draft remains
visible/local and absent from durable messages; native/in-memory queues drain.
The Reader keeps its document, live reading and an empty queue, with zero
forbidden requests. This renews default/fallback composition after the App repair.

Baseline, restored control and final normal catalogs have identical 503-file
digest `bf124d52003221a23cf50f94f917ac7b2a9a8a3b4c776299a63ff554da66f8d0`.
FALSE differs at
`0743ef9726d05ee818ce5641fc553110268d3726e2f0e2bbcff6072150a38b5e`.
The following exact selections supplement the environments/stage ordering above;
build freshly after each fault or restoration, use distinct output directories,
and retain the same source/test/config hashes.

```sh
pnpm --config.verify-deps-before-run=false exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/selectedLocaleRuntime.spec.ts \
  server/fastify/browser-smoke/visibleStateRecovery.spec.ts \
  server/fastify/browser-smoke/connectedWriterSwitching.spec.ts \
  --workers=1 --trace=on

pnpm --config.verify-deps-before-run=false exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/chatHistoryScroll.spec.ts \
  --grep 'rapid reversals and pauses among tall messages' \
  --repeat-each=2 --workers=1 --trace=off

pnpm --config.verify-deps-before-run=false exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/selectedLocaleRuntime.spec.ts \
  --grep 'new writer navigation reaches Settings while the initial character route handler is delayed' \
  --workers=1 --trace=on

VITE_FAST_BOOTSTRAP_OBSERVER=FALSE \
  pnpm --config.verify-deps-before-run=false build:smoke
VITE_FAST_BOOTSTRAP_OBSERVER=FALSE RISU_READER_ROLLOUT_COMPILED_FALLBACK=TRUE \
  pnpm --config.verify-deps-before-run=false exec playwright test \
  -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/connectedReaderRollout.spec.ts \
  --grep 'conservative fallback reload replays one UI-saved command and preserves the newer unsent composer draft' \
  --workers=1 --trace=on
```

Final discovery at main `593b01eae` confirms **92 cases in 22 specs**, twelve
TypeScript support files and four PNG baselines, with no collection error. All
92 identities and current source anchors match the inventory. Its hook map now
includes all direct/local-alias references in specs and the two new support
helpers. Discovery and these qualified controls do not replace the still-required
final `test:agent` and phase-ending `test:all`; earlier failed gates remain
recorded. No additional production fault matrix is introduced.
