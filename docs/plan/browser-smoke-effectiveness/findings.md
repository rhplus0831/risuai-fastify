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
- Disposition: **open**, owner Phase 1. Additional startup/locale artifacts may
  survive local failed reruns; assess their invocation ownership before expanding
  cleanup. Detailed repair/fault evidence will be appended here.

## BSE-002: Alert presentation is not operation confirmation coverage

- Classification: source-supported critical coverage gap, owner Phase 2a.
- S33 calls `showAlert` directly and validates layout/focus/OK across viewports.
  P0-C proves the real queue at component level. Neither drives an operation's
  browser entry path from progress into blocking confirmation.
- Required repair: one bounded deterministic real-operation browser journey,
  including acceptance/rejection and no premature continuation, paired with the
  queue ownership companion. Demonstrate a production admission fault at the
  browser assertion. Preserve S33's presentation/accessibility contract.
- Disposition: **open**; prevents Stage 1 handoff until browser evidence passes.

## BSE-003: Pending generation reload does not prove completed-reply reload

- Classification: source-supported critical coverage gap, owner Phase 2c.
- S01 uses real composer/stream/authoritative message assertions and reloads
  **during** generation. Its terminal helper compares API/client content but does
  not reload a fully completed reply. S46 does reload a completed reroll, with a
  different entry path. These useful contracts do not prove the entire normal
  send → incremental output → completion → durable reload journey.
- Required repair: extend the normal send journey through a final full reload,
  keeping operation/message identity and no duplicate provider invocation.
  Demonstrate an appropriate persistence/finalization fault with unchanged test.
- Disposition: **open**; separate from any claim of a current persistence bug.
