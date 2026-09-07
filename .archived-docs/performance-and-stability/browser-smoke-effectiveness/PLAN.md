# Browser Smoke Effectiveness Plan

Date: 2026-09-06

Execution is in progress. Read [status.md](status.md) for the execution cursor
and verification history.

## Objective and Authority

Establish what the existing browser smoke tests actually prove, find where
fixtures or test controls bypass a relevant production transition, and repair
confirmed gaps with tests that detect the named faulty behavior.

This plan owns scope, invariants, phase dependencies, and completion criteria.
[Inventory](inventory.md) owns the reviewed browser scenarios and shared test
controls. [Findings](findings.md) owns detailed fault experiments, their command
results, decisions, and dispositions. [Phase documents](phases/README.md) define
bounded work. Only `status.md` owns the execution cursor, phase acceptance, and
aggregate verification summaries; it links to detailed findings rather than
duplicating their experiment logs. Current source and the
[architecture guides](../../../docs/structure/README.md) remain authoritative for shipped
behavior. A completed plan document does not mean its implementation is complete.

## Planning Evidence

Source anchor: `ac5a1cec1dc2e74354001fe7f86b372048e691fd`.

- Default Playwright discovery at this anchor found 69 registered cases in 16
  specs. The specs contain 8,553 lines; ten local TypeScript support files contain
  952 lines. Production hooks and helpers outside that directory are additional
  scope. These are sizing observations, not executions or completeness claims.
- The Realm fix `ac5a1cec1` replaced immediate successful confirmation in its
  component-level fixture with the actual alert queue. The old setup skipped
  the progress-to-confirmation transition that could hang. The current focused
  Realm suite passed 20 tests during planning; older revisions were not rerun.
- The transcript fix `82f888cad` added browser input overlapping paging and
  queued rendering. Nearby tests use fabricated geometry or directly assigned
  scroll positions. Those tests retain narrower value; their inputs do not
  establish that they cover the same browser lifecycle.
- Browser hooks combine observations, direct state changes, and real durable
  commands. Their suitability depends on the contract of each caller.
- `pnpm test:agent` builds the smoke client but does not execute Playwright.
  Browser behavior requires separate focused evidence.

Use the earlier
[test-effectiveness audit](../test-suite-effectiveness-audit/plan.md)
and its
[final residuals](../test-suite-effectiveness-audit/status.md#final-accepted-residuals)
as historical leads. Recheck every retained claim against current source; do not
import old gaps or completion totals as current findings. Reuse the stable-plan,
moving-status, bounded-phase structure from the
[maintainability workstream](../maintainability-and-performance/PLAN.md).

## Scope

The initial review universe is every current spec and local support file under
`server/fastify/browser-smoke`, the production smoke controls they use, and their
discovery/execution wiring. Track newly added, renamed, or removed owners during
execution in the inventory. Inspect production entry points and adjacent
component/API tests only as needed to establish or repair a browser contract.

Review at scenario level: a registered case can contain several journeys, and a
parameterized case can represent several materially different conditions.
Document relevant opt-in matrices separately from the default discovery count.
Also map the critical user journeys in Phase 2 to current evidence, so an absent
test cannot escape review by being absent from the inventory.

In scope:

- Trigger-to-outcome fidelity, fixture provenance, observable assertions, async
  ordering, isolation, shared helpers, and meaningful negative cases.
- Focused test/harness changes, correction of overstated evidence claims, and
  narrowly scoped production fixes for reproduced defects.
- Missing companion coverage where an existing browser claim crosses a boundary
  it does not exercise, or a Phase 2 critical journey has no faithful owner.
- Current test guidance and execution ownership needed to retain the evidence.

Outside the initial scope:

- Another repository-wide test inventory or test cleanup campaign.
- Blanket removal of mocks, conversion of all tests to browser tests, arbitrary
  coverage/mutation-score targets, or mechanical splitting of large specs.
- New browser engines, real-device infrastructure, live external-service calls,
  paid-provider testing, and a general mutation-testing platform.
- General application architecture or performance redesign.

Record adjacent concerns with an owner and revisit condition. Expand scope only
when evidence shows a change is necessary for a named in-scope contract; record
the rationale and dependency in status before proceeding. Routine phase gates
are evidence checks, not additional approval checkpoints.

## Review and Decision Rules

For each scenario record its contract, production trigger, fixture origin,
replaced boundaries, actual path exercised, visible/durable assertion, execution
lane, companion evidence, and disposition. Classify each test control as setup,
observation, fault injection, or the action under test; classifications may
differ between callers of the same helper.

Handcrafted values are acceptable when they create the relevant precondition.
They are insufficient when they supply the result or skip the transition being
claimed. A direct API call may provide strong API coverage without proving its
UI entry path. `app.inject()` executes real Fastify routes. A DOM geometry stub
can protect an algorithm without proving browser layout. Preserve these useful
contracts and state their limits accurately.

Prioritize user-visible loss/hangs, durable-state loss or duplication, stale
ownership, async remount/stream/recovery behavior, and shared controls with many
consumers. Search results and mock counts are review leads, not findings.

## Evidence Required for a Repair

1. Name the faulty production behavior and the assertion expected to detect it.
   Derive the expected outcome from the supported contract or incident, not the
   helper being tested. Identify an independent precondition/path observation
   proving the action reaches the claimed production transition, such as its
   actual request, queue admission, or visible user control.
2. Run the regression unchanged against the fixed behavior and record a pass.
3. In a disposable checkout, restore the relevant historical production hunk or
   introduce one justified, behavior-changing fault. Keep the regression test,
   fixture, runtime, and assertion unchanged. A controlled external fault is
   useful only when the application still executes the transition under review.
   The fault must change that transition; changing only a test-hook return value
   or an unrelated label is not proof that its production behavior is covered.
4. Record failure at the relevant assertion. Import/type failures, unrelated
   timeouts, or directly assigning the expected broken UI state do not qualify.
   For a hang, a bounded assertion that the expected transition never occurs
   can be the intended failure; a generic suite timeout cannot.
5. Restore the production behavior and confirm the same regression passes.
   For scheduling-sensitive cases, predeclare the repetition/observation method
   and distinguish reproducible product failure from noisy instrumentation.

Retain the source anchor, fault diff or exact historical hunk, fixture identity,
test title, command, expected/actual failure, and restored result in the finding.
Keep enough information in the repository to repeat the experiment without a
temporary directory or expiring CI artifact. Do not mutate the shared working
tree while other work is running.

Apply this evidence requirement to every material strengthened/new regression
and every claimed production fix. Unchanged lower-risk tests need documented
path/assertion review, not an exhaustive mutation campaign. At least one named
fault demonstration must protect each Phase 2 critical contract; companion
lower-layer proof alone cannot certify a browser-specific failure.

## Preserved Invariants

- Keep the built SPA, Chromium, Fastify routes, command/resource protocol, and
  SQLite real wherever the scenario claims their integration.
- Preserve the single-writer model, revision/lineage ordering, idempotency,
  accepted/queued/failed distinctions, scoped rollback, and unrelated data.
- Preserve responsive UI, supported navigation, accessibility, focus, visible
  rendering, and supported transcript interactions.
- Keep deterministic provider/network substitutes at the relevant external
  boundary. Preserve real queues, serialization, persistence, and user controls
  when those are the behavior being verified.
- Use disposable data. Production incident details must come from supplied or
  appropriately obtained production evidence; local dev logs are not assumed
  to reproduce reports from an external server.
- Keep production-only versus smoke-build differences explicit. Existing auth,
  worker/GC exclusions, and shortened refresh timing are not production evidence.
- Do not raise timeouts, loosen assertions, regenerate snapshots, or remove tests
  merely to obtain a pass. A necessary change must preserve the named contract
  and have recorded evidence. Cleanup and helper changes need consumer checks.

## Phases and Sizing

| Phase                                                                       | Outcome                                                                                             | Dependency                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [0. Inventory and pilot](phases/phase-0-inventory-and-pilot.md)             | Current scenario/control inventory, three pilot reviews, calibrated work slices                     | Source confirmation                   |
| [1. Shared harnesses](phases/phase-1-shared-harnesses.md)                   | Shared controls have accurate contracts and confirmed bypasses are repaired                         | Phase 0                               |
| [2. Critical journeys](phases/phase-2-critical-journeys.md)                 | Confirmation, transcript, generation durability, and stale-response recovery have faithful evidence | Phase 1 controls needed by each slice |
| [3. Remaining scenarios](phases/phase-3-remaining-scenarios.md)             | Every remaining browser scenario and support owner has a complete disposition                       | Phase 2                               |
| [4. Verification and closeout](phases/phase-4-verification-and-closeout.md) | Final discovery, execution evidence, findings, limits, and current guidance agree                   | Phases 0–3 accepted                   |

Execute one cohesive boundary per implementation slice. Parallel read-only
research can cross-check independent areas under project guidance; changes to
shared owners remain sequential. A reproduced urgent defect may be repaired
early with its focused evidence and a recorded sequencing change.

The implementing agent evaluates each phase's exit criteria and records
acceptance in status with the source anchor and linked inventory/finding evidence.
Advance the cursor only after those criteria pass. If evidence is incomplete,
record the next unresolved action and keep the phase pending or in progress;
no separate routine phase approval is required.

Initial planning estimate: roughly 4–8 engineer-days for audit and ordinary
repairs, not a prediction of agent wall time. Re-estimate after the pilot from
scenario complexity, confirmed gaps, browser execution cost, and shared-helper
dependencies. A shared harness redesign is a scope decision, not assumed work.

## Validation and Completion

Follow the current [test workflow](../../../docs/tests/README.md#running-the-suite).
During implementation use `pnpm test -- <one-test-or-source-file>` for a concrete
diagnostic; exact browser specs build and run the selected spec. Once an
implementation batch is complete, run `pnpm test:agent`. Documentation changes
also require `pnpm check:docs`.

By explicit user instruction dated 2026-09-07, at the end of every phase
(Phases 0–4), the implementing agent must run `pnpm test:all` without requesting
additional user consent. Run it after phase work and self-review, before phase
acceptance or handoff, and record the tested source, command, result, and
exclusions in status. Repair failures and establish a passing result at the
phase's final source; missing required evidence leaves the phase pending. This
overrides the default user/CI-only ownership for this workstream. The command
includes full browser execution and current compatibility; additional pinned
compatibility lanes retain their existing user/CI ownership. See the
[coordination policy](../browser-smoke-and-connected-readers.md#verification-and-completion).

The default documentation validator excludes active plans. Explicitly validate
this plan bundle and its active index with `validateCurrentDocumentation` from
`util/current-documentation-validator.ts`, supplying `documentPaths`,
`indexSpecs: []`, and `literalPathExemptions: []`. Format these Markdown files
explicitly because the repository's default Prettier ignore excludes them.

Closeout requires:

- Every inventoried scenario/control reviewed, including current conditional
  execution and required critical journeys; partial files remain visibly partial.
- Every confirmed required gap repaired with the evidence above, or a recorded
  scope amendment naming the retained gap, owner, impact, and revisit condition.
  Deferred work is never described as a completed repair.
- No open high-risk gap in the four Phase 2 contracts. If a new external
  prerequisite prevents proof, keep that phase and full closeout incomplete.
- Passing focused evidence for changed browser contracts and affected helper
  consumers, final agent aggregate evidence, and full browser-suite evidence at
  the final source from the agent's required `pnpm test:all` run. Without that
  full browser result, label the state implementation-complete/verification-pending.
- Current guidance accurately describes what tests execute and prove. Archive
  the complete workstream and repair its links/index only after these conditions
  are satisfied.
