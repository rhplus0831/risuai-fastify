# Browser Smoke and Connected Readers Coordination Plan

Date: 2026-09-07

## Objective and Ownership

Complete both workstreams by establishing trustworthy browser regression
coverage, implementing connected read-only clients, then finishing the smoke
audit against the resulting behavior.

This single file owns execution order, handoffs, and combined completion.
The [smoke plan](browser-smoke-effectiveness/PLAN.md) and
[reader plan](connected-read-only-clients/PLAN.md) retain their scope,
implementation instructions, invariants, and acceptance criteria. Progress,
source anchors, verification, blockers, and handoff records belong in their
respective [smoke status](browser-smoke-effectiveness/status.md) and
[reader status](connected-read-only-clients/status.md). Keep detailed evidence
in each workstream's existing inventory/findings owners and cross-link it.
This file has no separate execution cursor, checklist, or evidence ledger.

## Execution Order

| Stage                            | Work                                                                                                                                                                                                                                                   | Handoff condition                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Establish regression coverage | Smoke [Phase 0](browser-smoke-effectiveness/phases/phase-0-inventory-and-pilot.md), [Phase 1](browser-smoke-effectiveness/phases/phase-1-shared-harnesses.md), then [Phase 2](browser-smoke-effectiveness/phases/phase-2-critical-journeys.md).        | All three phases accepted in smoke status, including all four critical contracts and their required fault-detection evidence; no open high-risk gap in those contracts. |
| 2. Implement connected readers   | Reader [phases 0–5](connected-read-only-clients/phases/README.md), following their internal dependencies through verification and rollout.                                                                                                             | All reader phases and completion criteria accepted in reader status, with required browser evidence and rollout disposition recorded.                                   |
| 3. Finish the smoke audit        | Reconcile the earlier smoke coverage with the reader changes, then complete smoke [Phase 3](browser-smoke-effectiveness/phases/phase-3-remaining-scenarios.md) and [Phase 4](browser-smoke-effectiveness/phases/phase-4-verification-and-closeout.md). | The full smoke plan meets its completion criteria at the final implementation source, including affected reader behavior and required full-browser evidence.            |

Within smoke Phase 2, prioritize send/stream/durable reload (2c) and stale
responses/recovery (2d) once their shared controls are accepted. Complete the
confirmation and transcript slices as well before the first handoff. Leave
smoke phases 3–4 unfinished while executing the reader plan.

## Resuming and Switching Workstreams

1. Read both status files and select the first unfinished stage above. Use
   recorded acceptance and its source limits to identify remaining work;
   planning checks or a pending next-phase entry do not establish completion.
   During Stage 2, required updates to earlier smoke evidence belong to that
   stage's work and the reconciliation below; do not restart the whole audit.
2. Read the selected plan and active phase, confirm current source/worktree
   state, and execute one bounded slice. Keep one implementation workstream
   active at a time and preserve each phase's own dependencies.
3. Record outcomes, evidence, and the next action in the owning status. At a
   handoff, link the accepted prerequisite evidence from the receiving status
   and record where the outgoing plan resumes. Continue through accepted
   handoffs without a separate routine approval request.
4. If a prerequisite fails, repair it before dependent work. Record blockers
   with an owner and concrete next action; retain incomplete verification as
   pending. Record evidence-driven sequence changes in the affected statuses
   and update this file if the agreed order changes. Preserve the underlying
   scope and acceptance requirements.

## Evidence Across the Handoffs

Reader implementation changes startup, writer loss, subscriptions, recovery,
and generation observation. Maintain affected tests as those changes land.
Replace obsolete expectations, such as the old writer entering frozen offline
mode, with proof of the intended reader behavior while retaining ownership,
draft, durability, and exactly-once protections. Apply the smoke plan's
fault-detection rules to material smoke-test additions or repairs made during
the feature work. Link reusable results instead of repeating identical checks.

At the start of Stage 3, reconcile added, changed, and removed scenarios and
shared controls with the smoke inventory. Reassess affected Stage 1 contracts,
rerun their focused browser evidence, and repeat fault demonstrations where
the tested transition or assertion changed. Retain unaffected reviews with
their source limits; an earlier pass cannot certify changed behavior. If final
smoke repairs affect the reader contract, revalidate its affected acceptance
checks and record the result in the owning statuses before combined completion.

## Verification and Completion

Follow each plan's validation rules and the current project test workflow.
The agent aggregate builds smoke assets but does not execute Playwright.
Keep full-browser and compatibility evidence with their existing user/CI
owners; missing required evidence leaves the relevant stage and overall goal
incomplete. Creating this coordination document accepts no implementation phase.

The combined goal is complete only when both plans satisfy their completion
criteria, required evidence applies to the final implementation, current guides
describe shipped behavior, and all required closeout actions are done. Follow
each plan's archive policy and repair this file's links when a workstream moves.
At combined closeout, archive this file with the smoke workstream, update the
archive index, and remove its link from the active-plan index.

For documentation edits, run `pnpm check:docs` and explicitly validate this file,
the active-plan index, and both plan bundles with `validateCurrentDocumentation`
from `util/current-documentation-validator.ts`: supply their Markdown paths in
`documentPaths`, with empty `indexSpecs` and `literalPathExemptions`. Include moved
documents and affected indexes when archiving. Format changed Markdown with the
Prettier ignore override and check whitespace.
