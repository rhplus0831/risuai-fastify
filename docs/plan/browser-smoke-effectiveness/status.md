# Browser Smoke Effectiveness Status

Updated: 2026-09-08

## Execution Cursor

- State: all Smoke Phases 0–4 and Reader Phases 0–5 accepted. Implementation
  and final verification are complete; archival is the remaining closeout action.
- Accepted implementation: writer-startup repair `f87624888`, passive diagnostics
  and native S81 control `7aad1bb37`, reviewed fixture inventory `985da9bc8`.
  Final agent and all thirteen full-suite lanes pass at clean `39356086c`.
  Focused normal/fault/restored/compiled-FALSE evidence applies at `985da9bc8`.
- Review universe: all 92 cases/22 specs, twelve support files and four PNGs have
  complete scenario/control dispositions; no pending or partial review owner.
- Confirmed gaps: BSE-001–009 have verified named controls. Earlier failed runs
  and unqualified candidate faults retain their explicit source limits.
- Next action: archive this intact bundle and the coordination record under
  performance/stability, repair links and indexes, and validate moved documents.
- Blockers and required verification gaps: none. The
  [Reader workstream](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md)
  and its affected startup/default/fallback maintenance are fully verified below.

Read [PLAN.md](PLAN.md) for scope and acceptance rules, [inventory](inventory.md)
for review coverage, and [findings](findings.md) for evidence and dispositions.

## Phase Router

| Phase                                                                       | State    | Next evidence required                                                                                                      |
| --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| [0. Inventory and pilot](phases/phase-0-inventory-and-pilot.md)             | Accepted | Evidence below; proceed to Phase 1                                                                                          |
| [1. Shared harnesses](phases/phase-1-shared-harnesses.md)                   | Accepted | Shared controls, repair faults, agent and full-suite evidence below                                                         |
| [2. Critical journeys](phases/phase-2-critical-journeys.md)                 | Accepted | Four contract faults, restored browsers and phase gates below                                                               |
| [3. Remaining scenarios](phases/phase-3-remaining-scenarios.md)             | Accepted | All scenario/control dispositions, qualified BSE-007 repair and all 13 full-suite lanes passed.                             |
| [4. Verification and closeout](phases/phase-4-verification-and-closeout.md) | Accepted | Final discovery/findings, both final gates, affected Reader proof and CI availability recorded; archive follows acceptance. |

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

BSE-007's guard is committed in `ee04eacba`. It adds only read-only route/local/
SQLite/selection-outbox evidence before direct configuration and leaves every
original journey, boot/navigation helper and PUT/retry byte-identical. Browser
TypeScript, formatting and whitespace pass. The literal server selection-owner
write omission and frozen all-eleven baseline/negative/restored protocol are
recorded in [findings](findings.md#bse-007-implemented-guard-and-declared-verification).
The isolated campaign uses `6f50eb8e5`; main changes only documentation while it
runs. Final consumer/control and full-gate verification remain pending.

### BSE-007 Repair Proof and Repeated Phase Gate

At `6f50eb8e5`, the frozen campaign passes all eleven original lifecycle journeys
in both baseline (38.6s) and exact restored control (33.8s). S05's native selection
now accepts before direct configuration, with current revision rebasing; initial
already-selected startup and concurrent A → B → A → B configured shortcuts also
pass. One actual server selection-owner persistence omission qualifies: the real
request returns 200 and claims the target, the client remains on that ready/local
target with no pending selection, but all eighteen SQL observations retain the
prior target. The new guard fails before any fixture PUT or generation POST.
This verifies the independent prerequisite, not a production restart defect.

The [complete proof](findings.md#bse-007-qualified-selection-fault-and-restored-consumers)
records the literal fault, exact source hashes, request ordering, all original
consumer oracles and remaining scope. All 3,621 tracked lab inputs restore
exactly; its 503 intentionally fixed client assets remain byte-identical across
fresh server processes. There are 5,126 successful script URL receipts and zero
page errors. Current guides describe the read-only native-selection setup guard;
original tests and configuration retry are unchanged. BSE-007 has no remaining
focused repair work. The required `pnpm test:all` is repeated at the final test/
documentation candidate; the failed `f430dc3a1` run remains recorded.

## Phase 3 Acceptance — 2026-09-08

**Phase 3 is accepted at `d5b5e5ed7`.** The repeated implementing-agent
`pnpm test:all` passes all thirteen lanes in **6m 20.1s**, including **92/92
browser cases**; its browser lane takes 3m 29.9s with a fresh current build.
The previously failing S05 passes in 3.5s, S22 in 45.9s, and all original
send/reload/retry/Stop/effect, reader and remaining scenario oracles pass.
Types, topology, current docs, 8,842 ordinary frontend tests, 241 UI tests,
formatting, 18 current compatibility cases, 4,228 server tests, the selected
Realm scale case and six performance cases pass. Three existing frontend and
two server skips remain; the targeted scale selection excludes its other 29
cases. Svelte checking reports zero errors/warnings.

All scenario/subjourney/control and conditional owners have complete dispositions.
S38/S57 titles and current guides now match their actual narrow contracts.
BSE-007's all-eleven baseline/restored consumers and qualified selection-owner
fault close the fixture defect found by the first full gate. Root self-review,
current docs (49), explicit active/archived plan/index validation (24), Prettier
and whitespace checks pass. No required repair is deferred and no failed run
has been relabeled as a passing result. The complete full log is
`/tmp/smoke-phase3-final-test-all-restored.log`.

Phase 4 now reconciles final discovery/findings and runs its own required agent
and full gates. This acceptance supplies that prerequisite; it does not replace
Phase 4's explicit final validation or archival actions.

## Phase 4 Final Source and Finding Reconciliation

Fresh list-mode discovery at `173b8fb14` confirms **92 cases/22 specs**, twelve
local support files and four PNGs, without collection errors. A complete
bijection matches all current spec/title/source records and the direct/alias
hook map; no current owner is pending or partial. The only renamed identities
are S38/S57's scoped titles, with unchanged assertions. BSE-007 adds a read-only
setup prerequisite and preserves all eleven lifecycle bodies and existing
configuration retry. No case, subjourney or critical contract was removed.

Root reconciles the [compact final findings](findings.md#final-finding-dispositions)
against their named source, literal fault/reproduction commands, intended failed
assertion, restored control and limits. All four critical contracts retain the
required browser-fault evidence. Changed Reader, remount, route and selection
boundaries have their own qualified controls; unmanifested old geometry candidates
remain unqualified. There is no open high-risk gap or deferred required repair.

Focused evidence applies to the final application/test source: the eight-case
critical cohort, then all-eleven BSE-007 baseline/restored consumers, and all
92 cases in the accepted Phase 3 full gate. Phase 4 changes evidence records only,
so no additional scheduling or mutation campaign is justified. The required final
`pnpm test:agent` and phase-ending `pnpm test:all` are now run at a clean candidate.
Collect matching Quality `smoke` CI when available; its absence does not replace
or transfer these implementing-agent gates. Final acceptance/archive remain
pending until both gates pass and the completed records are validated.

### Phase 4 Agent-Gate Fixture Repair

The first final `pnpm test:agent` at `72a181f5d` exits 1 in **2m 20.4s**.
All other agent lanes pass, including 9,083 frontend tests, types, topology,
current docs, Svelte zero errors/warnings and smoke build. The server lane is
4,227 passed/one failed/two existing skips: `memoryWorker.test.ts`'s productive
multi-batch case expects `job-33` in its second batch but receives `job-9`.
The failed gate remains `/tmp/smoke-phase4-final-test-agent.log`; it does not
accept the final phase.

This is a separate unit-fixture ordering defect. SQLite supplies `created_at`
with its native clock (`db.ts:822`), independent of JavaScript fake timers;
`claimNextMemoryJob` sorts by `created_at, id`. Unpadded numeric IDs therefore
have a different order when inserts share a timestamp. Forcing equal timestamps
with the original IDs deterministically reproduces the exact `job-9` versus
`job-33` failure. The repair uses padded ordinal IDs and retains those explicit
timestamp ties. Every original batch-size, last-job, zero-delay productive tick,
idle timer, drained-backlog and stop assertion remains unchanged.

The focused full worker suite passes **24/24** after the repair; Prettier and
whitespace checks pass. Red/green logs are
`/tmp/smoke-phase4-memory-batch-tie-red.log` and
`/tmp/smoke-phase4-memory-batch-tie-green.log`. This changes only unit-test fixture
input, so browser/Reader behavior and the 92-case discovery remain unchanged.
No browser production-fault campaign is claimed or required for this separate
clock/ID fixture correction. Repeat final `test:agent`, then the required full
phase gate at the corrected final source.

### Phase 4 First Full-Gate Failure and Targeted Follow-Up

At clean `6ee9bf1b7`, repeated `pnpm test:agent` passes all seven lanes in
**2m 22.0s**. The required `pnpm test:all` then fails in **6m 16.6s**:
**90/92 browser cases pass**, with all twelve other lanes passing. Those lanes
include 8,842 ordinary frontend tests, 241 UI tests, 4,228 server tests, 18 current
compatibility cases, one selected Realm scale case and six performance cases;
the three frontend/two server skips and 29-case scale filter retain their scope.
Svelte reports zero errors/warnings. Original logs, traces and artifacts are
preserved under `/tmp/smoke-phase4-first-full-failure`; the earlier worker-fixture
failure remains separately recorded above. Neither failure accepts Phase 4.

- **BSE-008 / S51:** the large warm population sends no cached hashes for its
  six personas, yielding 36 hits/six misses instead of zero misses. Its cold
  personas response contains all six actual values. The test reloads immediately
  after background readiness, while authoritative resource delivery deliberately
  does not await optional IndexedDB persistence. `955eff041` adds a passive
  pending-write observation; `bb61dc8b3` waits for zero pending writes after
  capturing cold metrics and before the warm reload. It does not flush the
  cache, delay the measured readiness boundary, or change any original cache
  assertion. All 23 cache-delivery tests pass, including delivery while native
  cache maintenance remains held and eventual zero pending writes.
- **BSE-009 / S81:** A reacquires writer epoch three and the correct persisted
  selection, but `canGenerate` remains false for the full 30-second assertion.
  No page error or wrong-target generation occurs. A bounded subagent reproduces
  the lost readiness update: retained-route restoration changes B to A while B
  hydration is pending; the old read correctly returns false, then promotion
  installs synchronization with A already selected and misses that change.
  `f87624888` reevaluates changed semantic targets, preserves errors for unchanged
  targets and fences superseded sessions. Four focused regressions protect the
  lost selection update, changed prompt owner, stable failure and ownership
  supersession; all 217 bootstrap tests pass. Qualified browser fault/restored
  evidence and affected Reader revalidation are still required.

Both independent read-only Luna reviews time out; root manually closes the cache
source/trace review, and the implementation agent closes the writer source review
with deterministic red/green evidence. At diagnostic source `bb61dc8b3`, before
the production repair, three declared repetitions of each original failing
browser case pass **6/6 in 21.6s** with one worker. Those green scheduling samples
do not disprove the deterministic writer race or replace a qualified fault.
The new terminal writer artifact records coordinator, generation blockers,
session, route and revision through read-only hooks; all original journey
assertions remain intact. Browser/server/shared types and formatting pass.

The final matching Quality workflow query at `6ee9bf1b7` succeeds with no matching
run. There is no supplemental CI URL; required execution stays with the agent.
The final-source/finding reconciliation above is superseded only for these new
follow-ups. Both controls, final discovery, repeated required gates and archival
actions remain pending.

### BSE-008 Warm-Cache Prerequisite Verified

The [frozen cache campaign](findings.md#bse-008-warm-cache-requires-completed-optional-writes)
at `bb61dc8b3` passes both declared baseline repetitions and both exact restored
repetitions. Holding the actual admitted personas cache write indefinitely makes
both unchanged tests fail at the new bounded prerequisite: native background
readiness has completed, one real write remains pending, and no warm reload
occurs. With a finite 250ms delay, both fixed runs pass; removing only the wait
under the byte-identical delayed application makes both old tests fail their
original zero-warm-miss assertion. Small/large warm misses are one/six in both
old-test comparisons and zero in every fixed complete run.

All 3,621 tracked inputs restore exactly; all 503 restored assets match baseline,
and the two delayed applications match each other exactly. Across all five
stages, 3,910 successful script URL receipts and zero page errors are recorded.
This closes the cache prerequisite repair and retains the matrix's original
measurement limits. The writer-startup control, affected Reader verification
and repeated final gates remain pending; no full phase acceptance is inferred.

### BSE-009 Writer Startup and Reader Revalidation

The [qualified writer-startup campaign](findings.md#bse-009-writer-startup-must-follow-the-current-hydration-target)
at frozen `985da9bc8` passes **18/18 baseline** cases in 50.7s and **18/18 exact
restored** cases in 57.0s: two declared repetitions of S01, S51, S81–S83 and
S89–S92, with one worker and trace on. All three writer-switching consumers,
normal send/completed reload, native Reader restart, default/fallback drafts and
outbox, delayed initial route, cache populations and connected import recovery
are included. No old browser body or assertion was removed.

S81 now proves that the actual current-generation startup evaluation is awaiting
B's native chat response before it releases A's native character response.
The real retained A route then becomes visible and its SQLite selection is
accepted at revision three under A's writer epoch three, while that same B
evaluation remains pending and generation stays gated. Releasing B lets the
fixed startup reevaluate A and complete every original draft, writer, durable
message and no-reload oracle.

Removing only the post-chat/prompt and catch target-change retry guards causes
**both unchanged S81 repetitions to fail** at the original 30s generation-readiness
assertion. Native current A/B responses complete with HTTP 200; A retains its
ready route and SQLite ownership/selection, but reports only `chat-dependencies`
with `selected-chat-hydration-failed`. This recreates the lost update and is not
a generic suite timeout or a failed fixture admission. Passive per-evaluation
metadata remains identical under the fault and clears in `finally`.

An actual `VITE_FAST_BOOTSTRAP_OBSERVER=FALSE` build with the existing dedicated
fallback fixture also passes **2/2** in 9.1s. Each real encrypted outbox row has a
12-byte IV and 220-byte ciphertext. The same mutation ID replays once after the
UI edit's accepted response is lost; original/replay base revisions are one/two,
with one durable edit, one acknowledged receipt and one ACK. The newer scoped
composer draft remains at sequence two and absent from SQLite, with no runtime
observer override after fallback and no forbidden Reader request.

All 3,621 tracked lab inputs restore exactly; every one of the 503 restored
normal assets matches baseline. The compiled-FALSE catalog is distinct.
The four stages record 10,646 successful script URL receipts and zero page
errors. Route helper `delivered` flags denote successful `route.fulfill` calls;
raw traces independently prove current A/B HTTP completion. An older A read
cancels during promotion, as expected for a superseded Reader generation.

The four production regressions and metadata/overlap checks pass in 217
bootstrap plus 14 readiness tests. Final full `check:server` passes after root
review identifies exactly two new test-only `getDatabase` fixture reads:
bootstrap count 194→196 and matching inventory total 4,274→4,276. `985da9bc8`
changes only those two counts under the existing policy; no production consumer,
owner, dependency, seam or permission is broadened. The initial inventory-gate
failures remain in their logs and do not accept an incomplete typecheck.

Final discovery matches **92/92 inventory identities in 22 specs**, twelve local
TypeScript support files, four PNGs and twenty-four direct/alias hook owners.
All new passive observations and both native response controls are classified;
all scenario titles remain unchanged. Current guides now state the stable-target
startup contract and the separate warm-cache prerequisite. The next required
work is final clean-source `pnpm test:agent`, then `pnpm test:all`; no focused
repair or supplemental Reader browser work remains pending.

## Phase 4 Acceptance — 2026-09-08

**Phase 4 is accepted at clean `39356086c683331330d862420cfdf79e209cefce`.**
All implementation, scenario/control review, source reconciliation, qualified
fault/restored proof and affected Reader validation are complete. The final
candidate contains production/browser changes through `7aad1bb37` and the two
reviewed test-fixture inventory counts in `985da9bc8`; both final commands run
without intervening edits or process-level observer/fallback/worker/artifact
overrides.

- `pnpm test:agent`: all seven lanes pass in **2m 27.7s**, including 9,087
  frontend tests, 4,228 server tests, types, topology, current docs, Svelte and
  the fresh browser build.
- Required implementing-agent `pnpm test:all`: all thirteen lanes pass in
  **6m 11.4s**, including **92/92 browser cases** with the default four workers.
  The browser build/execution lane takes 3m 27.3s (3.2m Playwright execution),
  including the required current-run integration-artifact merge. S81 passes in
  7.1s, S51 in 3.2s and S22 in 46.9s; all original and strengthened oracles pass.
- The full run also passes 8,846 ordinary frontend tests, 241 UI-coverage tests,
  4,228 server tests, 18 current compatibility cases, the selected Realm scale
  case and all six performance cases. Formatting, protocol/shared/server/browser
  types, architecture inventory, topology and documentation pass. Svelte reports
  zero errors/warnings. Three existing frontend and two existing server skips
  remain; the scale selector excludes its other 29 cases by design.
- Both the 18-case restored normal cohort and two actual compiled-FALSE controls
  remain applicable to the unchanged application/test implementation. They
  revalidate affected Reader startup, generation, ownership, pending intent and
  draft protection; BSE-008/009 have no remaining required work. Earlier failed
  aggregates and unqualified candidate faults retain their explicit source and
  failure records.
- The exact-source Quality workflow query completes successfully with no
  matching CI run. No supplemental CI URL is available, and no required check
  is transferred to the user. Logs are
  `/tmp/smoke-phase4-corrected-final-test-agent.log` and
  `/tmp/smoke-phase4-corrected-final-test-all.log`; source/environment are recorded
  in `/tmp/smoke-phase4-corrected-final-gate-source.json`.

The accepted universe is 92 cases/22 specs, twelve support files, four PNGs and
all twenty-four hook owners. Every scenario/control is retained, strengthened
or accurately reclassified; BSE-001–009 are disposed and no high-risk critical
gap or required repair is deferred. Current guidance describes the actual
behavior and limits. The execution envelope remains built Chromium, disposable
Fastify/SQLite, explicit desktop/mobile/touch/network/lifecycle emulation and
local deterministic provider/Realm responses. Additional transcript cost/profile
matrices, physical devices/other engines, live services and the separate pinned
compatibility differential remain outside this default execution.

Current documentation validation passes all 49 documents; explicit validation
of both active/archived bundles, coordination and indexes passes all 24 documents
with empty index specifications and literal-path exemptions. Final acceptance
records are revalidated with Markdown's Prettier ignore override and whitespace
checks. Archive the intact smoke bundle and coordination record next, repair
links/indexes and revalidate the moved documents. That routine documentary
closeout does not extend the final behavioral evidence to another code change.
