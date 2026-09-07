# Browser Smoke Effectiveness Status

Updated: 2026-09-08

## Execution Cursor

- State: Smoke Phases 0–2 and all reader Phases 0–5 accepted; Stage 3 smoke
  reconciliation and the remaining scenario review are active.
- Current implementation: production through `a703b9d4b`, browser through
  `60ac61bde`; reader final gates pass at clean `eb9673942` with 92/92 cases.
- Current scope: Phase 3 review and the eight-case focused cohort are complete.
  Its full gate is 91/92 because S05's direct fixture configuration races native
  chat selection. BSE-007 owns the bounded setup repair and repeated final gate.
- Next action: finish Phase 3 and its required full gate, then execute Phase 4
  verification, final findings and closeout.
- Confirmed gaps: BSE-001–006 retain their verified controls. New BSE-007 is a
  reproduced fixture ordering defect in accepted-send setup; its repair/control
  verification is pending. No new production wrong-chat send is established.
- Blockers: none. Reader default/FALSE rollout and archive are owned by the
  [accepted reader handoff](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md#phase-5-acceptance-and-stage-3-handoff-2026-09-08).
  Smoke Phase 3/4 acceptance remains separate.

Read [PLAN.md](PLAN.md) for scope and acceptance rules, [inventory](inventory.md)
for review coverage, and [findings](findings.md) for evidence and dispositions.

## Phase Router

| Phase                                                                       | State       | Next evidence required                                                                         |
| --------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| [0. Inventory and pilot](phases/phase-0-inventory-and-pilot.md)             | Accepted    | Evidence below; proceed to Phase 1                                                             |
| [1. Shared harnesses](phases/phase-1-shared-harnesses.md)                   | Accepted    | Shared controls, repair faults, agent and full-suite evidence below                            |
| [2. Critical journeys](phases/phase-2-critical-journeys.md)                 | Accepted    | Four contract faults, restored browsers and phase gates below                                  |
| [3. Remaining scenarios](phases/phase-3-remaining-scenarios.md)             | In progress | Final scenario/control dispositions, focused critical browser evidence and required full gate. |
| [4. Verification and closeout](phases/phase-4-verification-and-closeout.md) | Pending     | Final discovery, focused/aggregate/full-browser evidence, residuals                            |

## Verification Ledger

2026-09-07 coordination-policy update: `pnpm check:docs` passed for 49 current
documents; explicit validation passed for all 22 coordination, plan-bundle, and
active-index documents. Changed Markdown passed Prettier with the ignore
override and whitespace checks. This validates documentation only; no
implementation phase ended and `pnpm test:all` was not run for this policy edit.

| Scope                    | Source/date                                     | Result                                                                                                                                                                                             | Limit                                                                               |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Planning discovery       | Planning source, 2026-09-06                     | Playwright list mode found 69 default cases in 16 files; no collection errors                                                                                                                      | Discovery only; no browser tests executed                                           |
| Historical example check | Planning source, 2026-09-06                     | `pnpm test -- src/ts/characterCards.realmImport.test.ts`: 20 passed                                                                                                                                | Current component-level suite only; no historical failure rerun                     |
| Planning research        | Planning source, 2026-09-06                     | Independent read-only reviews of alert/transcript/persistence examples, browser controls, and prior workflow cross-checked against current source                                                  | Supports scope; does not close an audit finding                                     |
| Plan review              | Planning worktree, 2026-09-06                   | Two independent read-only reviews reconciled; clarified evidence ownership, phase acceptance, final-browser follow-up, and fault-path checks; retained artifact completeness as an unverified lead | Plan review only; no audit implementation performed                                 |
| Plan validation          | Planning worktree, 2026-09-06                   | Explicit link/path validation passed for all 11 plan/index documents; current documentation validation passed for 49 documents; explicit Prettier formatting/check and whitespace checks passed    | Documentation checks do not close implementation phases                             |
| Agent aggregate          | Planning source plus plan documents, 2026-09-06 | `pnpm test:agent` passed in 2m 21.2s: server/browser types, topology, current docs, frontend tests/check, server tests, and smoke build                                                            | No Playwright execution, specialized performance, or user/CI compatibility evidence |

For each execution slice append its source anchor, finding IDs, acceptance
summary, linked fault evidence, aggregate results, and residual limit. Detailed
fixtures, fault diffs, and per-experiment commands/results belong to the finding.
Never carry an earlier pass forward to a later changed implementation. The
implementing agent owns recording phase acceptance and executing `pnpm test:all`
at every phase end without additional user consent. Record final full-browser
evidence from that run as described in Phase 4; link matching CI evidence when
available.

## Decisions and Scope Changes

- 2026-09-06: Start with all existing browser smoke owners and their shared
  controls. Inspect adjacent layers only for a named browser contract or the
  four critical journeys. Do not reopen the prior repository-wide audit.
- 2026-09-06: Known Realm/transcript fixes are calibration examples, not open
  defects. Archived residuals are leads requiring current-source verification.
- 2026-09-06: Evidence of fault detection is required for material repairs;
  eliminating mocks or collecting a green run is not sufficient acceptance.
- 2026-09-06: Use the current Chromium lane and deterministic external boundaries.
  New browser engines, real devices, live services, and broad mutation tooling
  are outside the initial scope.
- 2026-09-07: The user explicitly requires the implementing agent to run
  `pnpm test:all` at the end of every phase without additional user consent,
  before acceptance or handoff. This supersedes the earlier user/CI-only command
  ownership for this workstream. Record final-source results and keep failed or
  unavailable required checks pending. All implementation phases remain pending.

Record future changes here with the affected contract, evidence, owner,
dependency, and revisit condition. Update stable scope in the plan when needed.

## Phase 0 Execution — 2026-09-07

Source `711b1d583` with documentation-only audit records. Node v24.19.0, pnpm
11.23.0, Playwright 1.62.1 and installed Chromium 151.0.7922.34. Disposable
loopback Fastify/SQLite harnesses and emitted smoke assets are available; no
application development server was needed. All pilot harnesses close themselves.

- Discovery command: `pnpm exec playwright test --config
playwright.fastify-smoke.config.ts --list` found **77 cases in 17 specs**,
  including eight new chat-entry cases. The inventory records full titles,
  meaningful matrices, ten local support owners, production hooks and per-caller
  roles. No runtime skip or test success is inferred from list mode.
- Independent parallel Luna reviews of scenario ownership, controls and pilot
  faults were reconciled against source. Worker proposals are source evidence;
  only the separately executed results below count as fault proof.
- [P0-C](findings.md#p0-c-realm-progress-to-confirmation-queue): real alert queue
  baseline/restoration **20/20 pass**; deleting the historical overlay-clear
  transition makes all four selected confirmation cases fail at the intended
  ask-presentation assertion.
- [P0-T](findings.md#p0-t-returning-transcript-rows-during-continuous-input):
  continuous/reversal baselines pass; cached-height fault fails readable/anchor
  assertions in both isolated repetitions; both clean-build restored repetitions
  pass (36.6s/30.6s, 1.2m overall).
- [P0-R](findings.md#p0-r-delayed-old-lineage-command-and-recovery-reload): all
  three visible-recovery baselines/restorations pass; omitting sidebar restore
  fails the final visible-state assertion after conflict/new-document/revision
  proof. Restored spec: **3/3 pass** in 6.6s.
- Documentation: `pnpm check:docs` **49 pass**; explicit
  `validateCurrentDocumentation` over coordination, active index and both bundles
  **22 pass**, with empty index specs/path exemptions; explicit Prettier ignore
  override and `git diff --check` pass. Recheck after final status edits.

The [inventory calibration](inventory.md#phase-0-calibration-and-remaining-slices)
sets bounded remaining slices and cost limits. No high-risk critical gap has
been waived; BSE-002/003 remain required Phase 2 work. Required phase-ending
`pnpm test:all` **passed all 13 lanes in 5m 59.3s**, including **77/77 browser
cases** (2.9m browser execution), current compatibility (18 checks), frontend
(8,113 plus 235 UI-coverage tests), server (4,100 tests), Realm scale, and
performance gates. Five existing ordinary-suite skips remain; the isolated
scale selector excludes its 29 unrelated cases by design. Opt-in transcript
cost/profile expansions and the separate pinned baseline differential were not
run. This verifies the final implementation source `711b1d583`; accompanying
audit documentation was revalidated after recording results. **Phase 0 accepted.** This phase contains no production/test implementation
change; the plan's implementation-batch `pnpm test:agent` applies when Phase 1
repairs land, while Phase 0 still requires the explicitly authorized full suite.

## Phase 1 Execution — 2026-09-07

Source: `2138c8897` (paint-frame repair) plus artifact helper/global-setup/unit
and owning guide/inventory changes. One bounded subagent implemented the artifact
repair; parent review, independent faults and real browser consumers are complete.

- [Shared-control dispositions](inventory.md#phase-1-shared-control-dispositions)
  retain every unchanged owner with per-caller roles and scope limits. No common
  writer/queue/UI transition was replaced by a test result; narrow direct setters
  and API/router actions retain explicit setup/action limits.
- [BSE-001](findings.md#bse-001-repair-and-fault-evidence): **67/67** unit pass;
  six isolated completeness/semantics/provenance/payload/publication faults fail
  at their intended assertions; restored complete unit **67/67 pass**. Real
  direct-link/recovery producer specs plus required merge **11/11 pass**, 39.7s.
- [BSE-004](findings.md#bse-004-paint-cache-observation-must-sample-every-held-phase):
  changed browser consumer passes, production cache-restore fault fails the
  pre-bundle appearance assertion, clean restored consumer **1/1 passes**, 3.7s.
- Strict server/browser TypeScript, code Prettier and whitespace passed after
  the artifact implementation. Current guides now distinguish successful
  required matrices from partial diagnostics and independent artifact families.
- `pnpm test:agent` **passed all seven lanes in 2m 22.9s**, including 8,348
  frontend and 4,164 server tests; five existing ordinary-suite skips remain.
- Required phase-ending `pnpm test:all` **passed all 13 lanes in 5m 39.1s**,
  including **77/77 browser cases** (2.7m), required current-run artifact merge,
  compatibility, coverage, scale and performance. No additional skips/exclusions;
  opt-in transcript cost/profile and the separate pinned differential retain
  their documented limits. This run covers the final Phase 1 implementation
  source described above, including all consumers of global setup.
- Final documentation checks: current guides **49 pass**, both plan bundles plus
  coordination/index **22 pass**; explicit Markdown Prettier and whitespace pass.
  **Phase 1 accepted.** No reader changes yet; smoke Phase 2 is the next slice.

## Phase 2c — Normal Send, Stream and Completed Reload

Starting source `4585333b4`; only the accepted-send browser spec and owning
evidence/guidance changed. The [BSE-003 experiment](findings.md#bse-003-completed-normal-send-identity-survives-full-reload)
proves the old test missed a deleted durable result-message ID and the unchanged
strengthened test detects it after a full completed reload. Fixed selected case
**1/1 pass**, injected production fault **1/1 fails** at the intended post-reload
identity assertion, old-test comparison **1/1 passes under the same fault**, and
restored full accepted-send spec **11/11 pass** in 26.4s. No production fix was
needed. The built frontend remains unchanged; the fault changes only the real
Fastify finalization route.

S01 now covers the entire normal composer → partial stream → completion → full
reload contract with exact user/reply/operation IDs in DOM, client, messages API
and bootstrap. The remaining accepted-send cases retain specific Retry, Stop,
viewer-loss, restart, concurrent-chat and queued-finalization coverage; reroll
and Debug Echo remain separate companion contracts. The 2c slice is verified;
Phase 2 stays in progress pending the other slices and its aggregate/full gate.

## Phase 2d — Stale Responses and Recovery

The [scenario dispositions](inventory.md#critical-contract-2d-stale-responses-and-recovery)
review real outbox admission/replay, response loss, event-gap refresh ordering,
writer takeover, imported lineage recovery, concurrent chats and queued
finalization. **2d slice verified** using the unchanged P0-R production-fault
proof and restored focused browser result, Phase 1's final full-browser execution
of those unchanged owners, and 2c's restored eleven-case accepted-send run.
No new code or test control was needed for this slice; no new execution is
claimed for this source-only review. Lower-layer stale/revision/outbox companions
remain explicitly narrower than the browser view-recovery oracle.

The current old-writer freeze is an existing contract, not the desired connected
reader behavior. Its replacement and new ownership/draft protections are required
at the reader handoff and Stage 3 reconciliation. Phase 2 is still in progress;
confirmation/transcript acceptance and the final phase gates remain.

## Phase 2b — Transcript Input and Rendering

The [transcript dispositions](inventory.md#critical-contract-2b-transcript-input-and-rendering)
cover real input/remount overlap, initial skeleton/display gates, newest-row
priority, logical identity, nonempty transient samples and resident bounds.
**2b slice verified** by the unchanged P0-T cached-height fault and two restored
repetitions, plus Phase 1's full-browser runs of the retained entry/startup and
residency cases. Production sources remain unchanged at this review; no new
execution is claimed. Direct geometry/scroll controls retain narrower algorithm
claims and do not replace real input. Unreviewed residency interactions remain
for Phase 3. Phase 2a implementation is the only active code slice; full Phase 2
acceptance still requires its browser fault proof and the phase-ending gates.

## Phase 2a — Real Operation Confirmation

[BSE-002](findings.md#bse-002-real-operation-browser-proof) adds two real UI Realm
import journeys with genuine CharX conversion, streamed progress, pending-token
confirmation, answer-specific storage/network consequences and reload. A bounded
subagent implemented the fixture; parent review and isolated production-fault
validation are complete. Fixed focused spec **2/2 pass**, removed production
progress clear **2/2 fail** at the 5s dialog-admission oracle after real SSE
proof, and restored clean build **2/2 pass** in 6.3s. Browser types/format pass.
The real-queue stale-result companion retains its narrower component scope.

**2a slice verified.** Together with 2b/2c/2d, every required critical contract
has relevant named fault detection and passing restored browser evidence at its
stated source. No high-risk gap was deferred. Final discovery now finds **79
cases in 18 specs**; S78/S79 and their inline controls are in the inventory.
Phase 2 remains pending final agent/full-suite validation, then Stage 1 hands
off to connected-reader Phase 0. Smoke Phases 3–4 stay unfinished during Stage 2.

## Phase 2 Acceptance and Stage 1 Handoff — 2026-09-07

Final implementation: `6f39fb8f0` plus the Realm browser spec and evidence/docs
committed with this record. No main-worktree production source was changed by
this stage; isolated faults were restored. The normal-send spec changed in
`e503af81f`, and the shared artifact/paint repairs are accepted Phase 1 changes.

- `pnpm test:agent`: **all seven lanes pass**, 2m 31.2s, five existing ordinary
  frontend/server skips. This builds smoke assets but does not run Playwright.
- Required phase-ending `pnpm test:all`: **all 13 lanes pass**, 5m 56.5s,
  including **79/79 browser cases** and the required current-run integration
  artifact merge. The browser lane (build plus execution) takes 3m 6.0s.
  Compatibility, coverage, scale and performance pass as well. No new skips;
  opt-in transcript cost/profile, physical devices/other engines and the separate
  pinned compatibility differential remain outside this execution.
- Current documentation **49 pass**; explicit coordination/index/both-bundle
  validation **22 pass**, with empty index specs/path exemptions. Changed
  Markdown passes Prettier with the ignore override and whitespace checks.

| Critical contract             | Accepted evidence                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a operation confirmation     | S78/S79 real UI/HTTP/CharX/SSE/queue/SQLite journeys; BSE-002 production progress-clear fault fails both bounded dialog assertions; both restored cases pass. Real-queue stale-result component companion retains its stated scope.                                                                        |
| 2b transcript input/remount   | S21/S22 real input and nonempty content/geometry observations; P0-T cached-height fault fails both repetitions and restoration passes. Current entry/startup/residency companions are reviewed with explicit controlled-geometry limits.                                                                   |
| 2c normal send/durable reload | S01 real composer/partial/terminal/completed reload with exact identities; BSE-003 omitted durable result-ID fault passes the old test and fails the strengthened post-reload assertion; restored full accepted-send spec passes.                                                                          |
| 2d stale response/recovery    | P0-R real held lineage-tagged request/import/conflict/new-document recovery and visible newer view choice; omitted restoration fails its final DOM oracle. Outbox identity, one revision/receipt, event-gap ordering, takeover and queued-finalization companions retain verified current-source evidence. |

**Phase 2 and Stage 1 accepted.** The receiving
[reader status](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md#stage-1-smoke-prerequisite)
links this prerequisite. No high-risk critical gap was deferred. All remaining
smoke scenario reviews, including S65–S72 and other still-pending inventory
rows, stay for Phase 3 after reader implementation. Stage 3 must reconcile
changed startup, ownership, recovery, navigation and generation-observation
behavior, rerun affected browser evidence, and repeat faults where the tested
transition/assertion changed; this handoff does not certify future reader code.

## Stage 2 Reader Handoff Maintenance — 2026-09-07

Reader Phase 2 changes startup, event composition, reader rendering and passive
writer demotion behind the default-disabled rollout flag. Its source is
`6003c596e` (production through `81efb67c3`). Smoke discovery grows from 79/18
to 80 cases/19 specs: S80 is added; S32/S60 retain their identities and receive
new mixed-client expectations. The bounded
[inventory reconciliation](inventory.md#reader-phase-2-smoke-reconciliation)
records their real paths, controls, oracles and remaining limits. Required
production-fault evidence belongs to the
[findings](findings.md#reader-phase-2-production-fault-evidence), and final
focused/aggregate phase evidence belongs to
[reader status](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md).

This update maintains Stage 1's affected evidence during implementation; it
accepts no smoke Phase 3/4 work. Resume the remaining scenario audit only after
the reader handoff completes. Preserve original-source limits for unaffected
critical checks and reconcile any later switching/viewer browser additions.

Reader Phase 2 is accepted at `9387d1464974` plus these evidence records. The
final `pnpm test:agent` and all 13 `pnpm test:all` lanes passed, including 80/80
browser cases. S22's added remount contract detects its declared production
cache-owner fault twice and passes both restored controls; BSE-005 is verified.
Unmanifested height/anchor candidates remain unqualified and the original P0-T
proof retains its earlier source limit. Reader Phase 3 continues the feature
work before this smoke audit resumes.

Reader Phase 3 adds S81–S83 at `7c3da2160`, bringing discovery to 83 cases in
20 specs. The actual UI switching/draft, held-generation survival and truly
empty unsupported-identity setup baseline passes. Three independent exact
production faults fail their intended post-action oracles; restoration and the
same clean-build controls pass 3/3. Their
[inventory](inventory.md#reader-phase-3-smoke-reconciliation) and
[findings](findings.md#reader-phase-3-production-fault-evidence) retain controls,
provenance and limits. Reader Phase 3 aggregate gates are recorded by its
status; smoke Phases 3–4 remain pending through the reader handoff.

Reader Phase 3 is accepted: `pnpm test:agent` passed in 2m 31.9s and all 13
`pnpm test:all` lanes passed in 5m 54.3s at `7c3da2160` plus its evidence docs,
including all 83 browser cases. The public flag remains disabled. Phase 4 now
adds live viewing; the smoke workstream continues to wait for reader Phase 5.

Reader Phase 4 adds S84–S88 and `connectedGenerationHarness.ts` at
`40b3eb516`, bringing the source universe to 88 cases, 21 specs and eleven
local TypeScript support owners. Its final five-case baseline passes in 49.2s
with no page errors or forbidden Reader calls. Earlier failed baselines remain
in the reader ledger with their production defects and test-contract causes.
The [inventory](inventory.md#reader-phase-4-smoke-reconciliation) classifies the
real provider, queued journal, response gate, per-dispatch role audit and
SQLite/DOM oracles. All six declared production-fault controls qualify and the shared
restored five-case run passes in 51.1s, recorded in [findings](findings.md#reader-phase-4-production-fault-evidence).
Reader Phase 4's aggregate gates and Phase 5 rollout remain pending; the smoke
workstream has not advanced to Phase 3.

Reader Phase 4 is accepted at `40b3eb516` plus its six evidence documents:
`pnpm test:agent` passes in 2m 34.9s and all 13 `pnpm test:all` lanes pass in
6m 4.9s, including all 88 browser cases. The five new journeys have complete
baseline, six qualified negative controls and a clean five-case restored run.
Phase 5 now owns final activation and combined acceptance; public default is
still disabled. Resume the remaining smoke review only after that handoff.

Reader Phase 5's corrected source `22da08cd1` passes all 28 affected cases,
the S32 legacy companion and the full 91-case TRUE cohort in 193.4s. Five
production faults qualify and the shared restored S80/S89/S90/S91 cohort passes
4/4 in 18.3s. The [findings](findings.md#reader-phase-5-production-fault-evidence)
record the exact unchanged-test failures and restoration. This closes the
previous integration browser failures, including three fixture shutdown hangs
whose product oracles had already passed; closing owned BrowserContexts fixes
the retained idle HTTP socket without changing product assertions or timeouts.

The authorized default is enabled in `70a8b18e1`, with ten passing flag tests;
`a394b1310` updates shipped and test guides. Normal/FALSE build verification and
the reader phase's final aggregate checks are still pending. Smoke Phases 3–4
continue to wait for accepted reader Phase 5 rather than inheriting its partial
rollout acceptance.

At `a394b1310`, normal no-override S89/S90/S91 pass 3/3; the actual compiled-FALSE
S90 variant passes 1/1 with its override removed before reload and exact retained
intent/ACK/newer-draft behavior. A fresh normal rebuild matches all 503 emitted
file hashes. [Profile proof](findings.md#reader-phase-5-default-and-fallback-build-proof)
records the environments and limits. Reader Phase 5 now has only its final
aggregate checks and acceptance/archive outstanding; this smoke workstream still
resumes Phase 3 after that accepted handoff.

Reader Phase 5's first final agent aggregate finds two stale inventory marker
entries after the expanded flag tests and guarded legacy setup helper. All
frontend/server tests, Svelte check, topology, docs and smoke build pass, but the
aggregate remains failed until the reviewed count/removal reconciliation and
final checks pass. This changes no browser assertion, production owner or rollout
behavior; [reader status](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md#final-aggregate-inventory-reconciliation)
retains the precise source, result and remaining gates.

Reader Phase 5's repeated agent aggregate passes at `90069ac9c`, but its required
full run is **89/91 browser cases** with all other twelve lanes passing. The
S47 startup route race has a committed App repair and new S92 browser companion;
S22's recurring readable-pause coverage gap has a bounded preparation repair
that preserves its original fourteen pauses and exact geometry/remount oracles.
The [repair record](findings.md#reader-phase-5-final-gate-repairs) retains the
failure and pending combined controls. Reader Phase 5 remains active; no Smoke
Phase 3/4 handoff or archive is accepted by these focused fixes.

At `60ac61bde`, the bounded repair campaign passes all seventeen positive browser
executions and qualifies all three expected negatives, with exact restored source
and normal emission. Actual compiled-FALSE replay/draft protection also passes.
[Renewed proof](findings.md#renewed-combined-controls-and-fallback) and
92-case/22-spec discovery reconcile the current reader additions. Reader Phase 5
now repeats its final aggregate gates; Smoke Phase 3/4 acceptance is still pending.

## Stage 3 Reader Completion Handoff — 2026-09-08

Received [accepted reader Phases 0–5](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md#phase-5-acceptance-and-stage-3-handoff-2026-09-08)
at `eb9673942`: final `test:agent` passes in 2m 21.3s and all thirteen required
`test:all` lanes pass in 7m 16.0s, including 92/92 browser cases. Normal connected
startup and actual compiled-FALSE intent/draft recovery pass; named faults and
restored controls apply to the final changed boundaries. S22's measured pause
and S92's held initial-handler navigation pass the full browser lane. No required
reader gap is deferred.

Resume Smoke Phase 3 with the prepared complete source review, current discovery
and all conditional/support owners. Only S38's universal lazy claim and S57's
persisted/pre-bootstrap repair claim require title corrections; assertions stay
unchanged. Reassess the four critical contracts with their final source and
limits, run the focused affected cohort, then the phase-ending full gate before
accepting Phase 3. The reader's passing full run is the prerequisite, not the
remaining smoke phases' required evidence.

## Phase 3 Review and Critical Reconciliation

At `f4dd0e236` plus this slice, every remaining registered scenario, meaningful
subjourney, conditional matrix and support owner has a retained, strengthened or
reclassified disposition in the [complete review](inventory.md#phase-3-complete-scenario-and-control-review).
Three read-only worker results and two manually completed timeout scopes were
checked against source; the mistaken S31 SPA-only interpretation is rejected
because `openChat` actually performs full `page.goto` navigation. No required
product defect is deferred.

Only two test titles change: S38 describes the 60 registered lazy boundaries;
S57 describes read normalization during built startup. Their assertions and
fixtures are byte-for-byte unchanged. Current browser guides receive the same
limits for registered lazy entries, manifest-derived direct links, cache metrics
and nonrepairing shell reads. Existing lower-risk scenarios retain their actual
UI/API/provider/browser-control boundaries rather than acquiring unrelated
mutation campaigns. The final hook map and twelve support/four screenshot owners
are reconciled with the 92-case universe.

The affected critical cohort is S01 normal send/completed reload, S22 continuous
reversal/readable pause, S77 conservative lineage recovery, S91 connected import
recovery, both Realm decisions, and the two renamed S38/S57 cases. Reuse the
passing Reader final normal build with unchanged application code and test bodies; keep
one worker and each spec's existing trace configuration. The original P0-T
geometry fault retains its source limit; the changed remount/route/Reader
transitions have the renewed BSE-005/BSE-006 and Reader Phase 5 fault/restored
proof. No production-fault repair is claimed for either title-only correction.
Focused execution, fresh discovery and the required Phase 3 full gate remain
pending before phase acceptance.

### Phase 3 Focused Proof and Final Gate

Fresh discovery after the two title corrections confirms **92 cases in 22
specs**, twelve TypeScript support files and four PNGs, with all 92 inventory
identities/source anchors matched and no collection errors. Direct/alias hook
references in all specs and the new helpers are reconciled; current scenario
rows contain no pending or partial review disposition.

At clean `1ba2670ae` (only title/documentation changes after the accepted reader
implementation), the declared eight-case cohort passes **8/8 in 1.0m** with one
worker and existing per-spec trace settings. S22 passes in 45.4s; both Realm
answers, normal send/completed reload, conservative and connected import recovery,
and both renamed narrow cases pass. Main reuses its own normal build from the
passing Reader final full gate; no build or production change intervenes. Its
503-file catalog and source/environment are preserved in
`/tmp/smoke-phase3-critical-source.json`; the log is
`/tmp/smoke-phase3-critical.log`. Cross-checkout byte identity is not assumed.
This focused cohort supplements the separately qualified production faults; it
does not rerun or relabel the unmanifested old geometry candidates.

`pnpm check:docs` passes all 49 current documents; explicit validation passes
24 active/archived plan, coordination and index documents. Prettier with the
ignore override and whitespace checks pass. Phase 3's implementing-agent
`pnpm test:all` now owns its final acceptance evidence at the completed review
source. No required check is transferred to the user.

### Phase 3 Full-Gate Failure: Native Selection Versus Fixture Setup

At clean `f430dc3a1`, the required `pnpm test:all` exits 1 in **6m 20.3s**:
**91/92 browser cases pass** and all twelve other lanes pass, including types,
topology, docs, 8,842 ordinary frontend tests, 241 UI tests, formatting, 18 current
compatibility cases, 4,228 server tests, the selected Realm scale case and six
performance cases. The existing three frontend/two server skips and scale filter
retain their scope. S05 fails before its actual server restart: visible row zero
contains S04's earlier `mobile reload request`, not S05's `restart request`.
The original full log/trace/build are preserved in
`/tmp/smoke-phase3-restart-case-failure`; no rerun replaces this failure.

Raw network bodies establish the cause. The fixture's direct generation-settings
PUT for `chat-restart` starts at 21,146.811ms with baseRevision 16 and commits
revision 17. The page's actual empty-patch `select:true` chat command starts at
21,152.166ms with the same baseRevision 16 and receives real HTTP 409/current 17.
Authoritative refresh restores the prior persisted mobile selection. Composer
fill/click occur later at 21,307.374/21,354.116ms; there is **no generation-operation
POST**. This is not a failed restart or proof of generation in the wrong chat.

One of two read-only Luna reviews completes; root manually closes the fixture
review timeout with trace bodies, all helper callers and import/selection source.
Writer/background readiness does not imply completed routing. App's inert route
content and exact send-target guards explain why a visible composer does not
prove valid target readiness. `importSnapshot.ts` explicitly resets imported
chat generation settings to `configured:false`, confirmed by actual pre-setup
character GETs, so deleting the required fixture PUT would be incorrect.

BSE-007's bounded repair must wait for the actual target URL/ready route, local
selected chat and authoritative persisted selection before the direct setup PUT,
plus completion of the relevant selection intent. It must accept an already-
selected initial chat and preserve concurrent-chat navigation, the existing PUT
retry and every original send/reload/restart/Stop/effect oracle. Implementation,
focused consumer proof, a named selection fault/restored control and repeated
Phase 3 full gate remain pending. Reader acceptance remains tied to its recorded
passing source; no product behavior change or new feature gap is inferred.

### Build Provenance Across Checkouts

A read-only audit explains why main's passing `eb9673942` build differs from the
qualified `60ac61bde` detached lab. The shared dependency symlink changes nine
Svelte slider/color-picker filename-derived CSS scopes. Main's newer findings
prose also adds the literal `row-298`, which Tailwind scans into one extra
22-byte rule, `.row-298{grid-row:298}`; no application/test source uses that
literal class. All 420 manifest entries and 414 textual manifest assets match
after only the documented dependency-path/chunk-hash/scope normalizations; global
index CSS has exactly that extra utility. Neither checkout has a local env file.

Thus documentation is a Tailwind build input. Application code and test bodies
were unchanged for the focused cohort, but cross-checkout byte identity is not
claimed. Its own 503-file main catalog is preserved; all same-checkout negative/
restored byte proofs remain valid. Required full gates rebuild current source and
current scanned documentation. The compact audit is
`/tmp/reader-cross-cwd-emission-audit-ukhdfuih/conclusion.json`. This finding does
not introduce a build-hygiene workstream or expand the behavioral claim.
