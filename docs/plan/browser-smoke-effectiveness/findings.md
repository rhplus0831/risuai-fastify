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
