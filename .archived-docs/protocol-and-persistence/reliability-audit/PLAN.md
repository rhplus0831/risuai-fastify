# Reliability Lifecycle Audit

Created: 2026-09-12.

Start at [status](status.md) for execution state and the next action. This plan
defines intended audit work; current source and the
[architecture index](../../../docs/structure/README.md) remain authoritative for shipped
behavior. The planning request does not start runtime implementation.

## Objective

Make important user workflows detectably correct under interruption, ambiguous
server acceptance, overlapping attempts, and late asynchronous completion.
Improve what existing tests prove, repair demonstrated implementation defects,
and verify observable results through the assembled application. Count verified
contracts and failure sequences; test totals are not a completion measure.

The initiating discussion was the Codex task **Define app bug auditing method**,
ID `01a09406-8756-78c1-98d5-12024d13ca3e`. Its two historical bug families concern
generation recovery/bootstrap traffic and mobile connection recovery/disabled
controls. Those histories motivate audit candidates; they do not establish new
defects in this checkout or show that every earlier fix caused a regression.

## Document Ownership

<!-- prettier-ignore -->
| Document | Owns |
| --- | --- |
| This plan | Objective, scope, method, phase dependencies, validation policy, completion rules. |
| [status.md](status.md) | Current phase, concise progress, blockers, decisions affecting scope, verification summary, exact next action. |
| Phase documents below | Acceptance and coverage matrix, findings, test dispositions, implementation changes, detailed evidence, remaining gaps for that workflow. |

Keep detailed findings in their owning phase and link them from status. Update
status after a meaningful checkpoint or handoff. Record source revision and any
relevant uncommitted changes when a phase starts or resumes; recheck affected
evidence after source drift. Archive the package under the appropriate
`.archived-docs/` topic and update the active-plan index when finished or retired.

## Scope and Constraints

- Audit complete operations: entry path, stable identity, retained intent,
  server acceptance, reconciliation, and visible completion. Include the owners
  that must continue work when a component or connection disappears.
- Preserve Fastify/SQLite authority, disposable browser caches, scoped drafts
  and outbox intent, the intentional single-writer design, and honest
  `accepted` / `queued` / `failed` outcomes. Follow
  [repository invariants](../../../STRUCTURE.md#repository-wide-invariants).
- Start with the existing fixes and tests. Retain useful unit coverage; revise
  or consolidate weak coverage only with an explicit preservation mapping. Add
  coverage when an important interaction has no adequate existing home.
- Implement changes tied to demonstrated contract violations. This plan does
  not mandate a framework migration, broad architectural rewrite, elimination
  of mocks, exhaustive review of every feature, or a new test-count target.
- A finding expands review to producers, consumers, sibling entry paths, and
  cleanup of the same contract. Record the boundary and stopping condition.
  Unrelated findings enter a separate backlog; do not silently expand a phase.
- Separate source-backed observations, inferred risks, reproduced defects, and
  executed verification. Existing tests inspected during planning have not
  thereby passed or proved complete coverage.

## Phase Order

Finish one workflow through audit, necessary fixes, test repair, and browser
verification before starting the next implementation phase. Later phases are
bounded outlines; complete their owner/coverage matrix when they begin.

<!-- prettier-ignore -->
| Phase | Workflow and dependency | Deliverable |
| --- | --- | --- |
| [01](phases/01-connection-recovery.md) | Connection recovery and writer promotion; first priority because failures disable normal use. | Verified attempt retirement/replacement, authority gating, retained drafts, and usable controls. |
| [02](phases/02-generation-recovery.md) | Generation submission and recovery; uses the connection lifecycle assessed in 01. | Acceptance/attempt identity and transcript/effect settlement verified across interruption. |
| [03](phases/03-outbox-and-optimistic-edits.md) | Outbox replay and optimistic edits; builds on authority and settlement boundaries from 01–02. | Retained intent, receipt/replay ordering, honest UI outcomes, and preservation of newer edits. |
| [04](phases/04-resource-hydration.md) | Resource hydration, invalidation, and navigation; extends the recovery fences from 01 and edit interactions from 03. | Verified stale-read isolation, authenticated cache reuse, and bounded settled traffic. |
| [05](phases/05-background-jobs.md) | Translation, memory, and BardWiki lifecycle; depends on generation/resource ownership from 02 and 04. | Representative job identity, terminal reconciliation, interruption, and idle behavior verified. |
| [06](phases/06-import-and-restore.md) | Import/restore boundaries; exercises lineage and lifecycle contracts established above. | Atomic publication and retirement of work tied to replaced/deleted state verified in isolated fixtures. |

Background jobs and import/restore have separate phases because their completion
and persistence contracts differ. Hydration needed to complete connection
recovery belongs in 01; phase 04 owns the wider cache/navigation audit. Shared
coverage should be linked and reused across phases. Reorder later phases only
with a recorded dependency or impact reason.

## Audit Method

### 1. Establish the behavior and coverage matrix

For each phase, enumerate supported entry paths and record:

<!-- prettier-ignore -->
| Field | Required content |
| --- | --- |
| Contract ID | Stable phase-local identifier, such as `R1`, for traceability. |
| Required behavior | Observable outcome and forbidden outcome, including ownership scope. |
| Source owners | Entry, coordination, transport/storage, state publication, cleanup, UI. |
| Existing evidence | Exact test/case or browser journey; real modules and mocked boundaries. |
| Failure schedule | Where work pauses/fails and what races with it. |
| Test disposition | Keep, strengthen, replace/consolidate, add, or explicit gap with reason. |
| Verification | Actual command, source revision, result, oracle, and limitation. |

Review the test's oracle as carefully as its mocks. A DOM value assigned by the
test, mocked success flag, or expected helper call may leave the actual feature
unverified. Prefer independently specified expected state, persisted results,
rendered controls, and request observations relevant to the contract.

### 2. Check correctness, progress, and settled behavior

- **Correctness:** stale work cannot overwrite current state; work stays within
  its chat, writer, database lineage, and operation/attempt; supported idempotent
  replay cannot duplicate a committed result; queued intent cannot look accepted.
- **Progress:** interruption has an explicit completion/recovery path. Where a
  lifecycle owns cancellation, it releases waiting callers and retired attempts
  cannot block replacements. Distinguish those leases from cold startup's shared
  attempt, bounded control requests, and currentness checks (phase 01). Error
  handling must cover the whole relevant workflow.
- **Settled behavior:** resolved obligations stop retrying; obsolete timers and
  subscriptions stop affecting current work; idle foreground activity avoids
  unnecessary bootstrap/resource requests.

Inspect `await`, response parsing, stream setup/read, timers, callbacks,
subscriptions, synchronous re-entry, and `finally` cleanup. At each boundary,
identify the current owner, validity evidence, cancellation behavior, successor,
and the exact resource that cleanup is allowed to retire.

### 3. Exercise hostile schedules with real interactions

Use existing deferred responses, controllable streams, fake timers, browser
routes, and isolated storage fixtures where suitable. Keep the cooperating
modules under review real; inject faults at the network, clock, or storage
boundary. Document necessary substitutions and what they cannot prove. Share a
helper only after multiple useful cases need the same mechanism.

The recurring schedule is **start A → hold a downstream step → suspend or
supersede A → finish B while A is pending → release A**. Assert both B's ability
to complete and immunity to A's late success, failure, and cleanup. Also exercise
lost accepted responses, stale snapshots covering newer submissions, stalled
error bodies, and independent owners with mixed reconciliation outcomes where
applicable. Start from historically demonstrated schedules; use generated event
sequences only for a bounded state machine with an independent oracle and
reproducible failing sequence.

### 4. Fix demonstrated defects and establish detection

For each finding record its reachable sequence, violated contract, affected
owners, evidence, fix, and related-path search. Where practical, show the test
fails against the previous broken behavior using an isolated checkout or a
temporary controlled mutation. Record whether that check reproduced the actual
old defect or only tested a surrogate. Do not disturb unrelated working changes.
If historical failure cannot be replayed, state the reason and the narrower
evidence available.

Consolidation requires a mapping from removed assertions/scenarios to surviving
coverage. Preserve distinct failure schedules even if they share a helper.

## Validation Policy

Follow [AGENTS.md](../../../AGENTS.md#test-workflow) and the canonical
[testing guide](../../../docs/structure/testing-and-operations.md). Phase documents name
candidate owners; select commands by the changes and contracts actually involved.

- For this planning change, run `pnpm check:docs`, explicitly validate all new
  nested plan documents if the default document set omits them, and run scoped
  formatting and whitespace checks. No runtime tests are required to create a plan.
- While implementing, prefer `pnpm test -- <one-test-or-source-file>` for the
  smallest relevant check. Baseline failures must be recorded separately from
  regressions caused by the phase.
- Run the selected browser journeys explicitly. `pnpm test:agent` includes a
  browser-smoke build; that is not execution of the Playwright journeys. Reuse a
  current build only when its inputs have not changed, and identify it in evidence.
- Run `pnpm test:agent` after implementation/self-review when shared behavior,
  contracts, dependencies/configuration, or a concrete unresolved integration
  risk meets the repository policy. Record the applicable reason. Do not run
  `pnpm test:all` unless the user explicitly requests it.
- Use isolated browser/SQLite fixtures. For manual full-stack checks use
  `pnpm dev:agent` and stop it afterward. If investigating an external production
  incident with support configuration available, begin with
  `pnpm diagnostics:remote --investigate`; local state does not reproduce
  production by default. Follow the existing bounded diagnostics contract.
- Simulated browser lifecycle events and mobile viewports do not establish
  physical-device suspension behavior. Record the browser/device and distinguish
  HTTP failure, app reload, real process restart, and simulated suspend evidence.

## Phase Completion and Handoff

A phase is complete only when its bounded entry-path inventory is assessed,
required acceptance criteria have executed evidence, demonstrated in-scope
defects are resolved, removed coverage retains equivalent protection, applicable
browser and broader checks are recorded, and current behavior/test documentation
is updated where needed. A source audit that finds no defect is valid; runtime
changes are not mandatory.

For every remaining gap record impact, why evidence is missing, a named owning
phase or follow-up, and the next verification action. A missing required
acceptance result or unresolved in-scope correctness/progress defect keeps the
phase open. Optional platform/depth gaps may be explicitly deferred with a
limited claim; they cannot be counted as verified behavior. A substantive scope
change must be visible in this plan and status.

At handoff record current revision, completed contracts, active findings, exact
next command/action, required fixtures, and test results that need rerunning
after source changes. Overall completion requires closure of all six bounded
phases and an honest final inventory of evidence and deferred limits; it does
not certify the entire application as bug-free.
