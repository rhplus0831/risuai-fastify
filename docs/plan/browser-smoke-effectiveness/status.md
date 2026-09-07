# Browser Smoke Effectiveness Status

Updated: 2026-09-07

## Execution Cursor

- State: Phases 0–1 accepted; Phase 2 critical journeys are next.
- Execution source: Phase 0 accepted at `7399389f9` (implementation `711b1d583`);
  Phase 1 changes are in progress on that source.
- Current scope: the four critical browser contracts; prioritize normal-send
  durable reload (2c) and stale-response recovery (2d).
- Next action: extend the normal composer journey through completed reload and
  exact durable identities, then finish recovery, confirmation and transcript proof.
- Confirmed gaps: BSE-002 (browser operation confirmation, Phase 2a) and BSE-003
  (completed normal-send reload, Phase 2c). BSE-001/004 are verified repairs.
- Blockers: none. Reader implementation and smoke Phases 2–4 remain pending.

Read [PLAN.md](PLAN.md) for scope and acceptance rules, [inventory](inventory.md)
for review coverage, and [findings](findings.md) for evidence and dispositions.

## Phase Router

| Phase                                                                       | State    | Next evidence required                                              |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| [0. Inventory and pilot](phases/phase-0-inventory-and-pilot.md)             | Accepted | Evidence below; proceed to Phase 1                                  |
| [1. Shared harnesses](phases/phase-1-shared-harnesses.md)                   | Pending  | Per-caller control classification and focused consumer proof        |
| [2. Critical journeys](phases/phase-2-critical-journeys.md)                 | Pending  | Four critical contracts with relevant fault detection               |
| [3. Remaining scenarios](phases/phase-3-remaining-scenarios.md)             | Pending  | Complete review dispositions and repaired confirmed gaps            |
| [4. Verification and closeout](phases/phase-4-verification-and-closeout.md) | Pending  | Final discovery, focused/aggregate/full-browser evidence, residuals |

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
