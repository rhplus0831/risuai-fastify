# Connected Read-Only Clients Status

Updated: 2026-09-07

## Execution Cursor

- State: Stage 1 smoke prerequisite accepted; reader Phase 0 is next.
- Planning source: `696aecef2dd22dc50ebeca47144cad2b8f5c68b0`.
- Current task scope: implement the coordinated connected-reader plan after the
  accepted smoke prerequisite. Reader phase acceptance has not started.
- Next implementation slice: [Phase 0](phases/phase-0-contract-and-inventory.md),
  confirm source and complete the mutation/runtime inventory and transition map.
- Production behavior: unchanged; the new connected-reader contract is proposed.
- Blockers: none. Phase 0 must resolve the implementation choices below before
  dependent feature edits begin.

Read [PLAN.md](PLAN.md) for stable behavior and invariants,
[inventory](inventory.md) for source owners and dispositions, and only the
active [phase](phases/README.md) for detailed execution instructions.

## Phase Router

| Phase                                                                                             | State   | Next evidence required                                                                  |
| ------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                             | Pending | Current boundary map, role transitions, draft preservation coverage, rollout choice.    |
| [1. Capabilities and mutation protection](phases/phase-1-capabilities-and-mutation-protection.md) | Pending | Read capability independent of write authority; mutation denial at actual entry points. |
| [2. Connected read-only browsing](phases/phase-2-connected-read-only-browsing.md)                 | Pending | Two sessions browse independently and converge on committed data without reader writes. |
| [3. Explicit writer switching](phases/phase-3-explicit-writer-switching.md)                       | Pending | UI-driven takeover/demotion; pending work, drafts, and stale-response race proof.       |
| [4. Live generation observation](phases/phase-4-live-generation-observation.md)                   | Pending | Streaming continuity; observers execute no writer-only actions or effects.              |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                         | Pending | Combined browser/aggregate evidence, rollout disposition, docs, and residuals.          |

## Verification Ledger

2026-09-07 coordination-policy update: shared documentation checks passed as
recorded in the [smoke verification ledger](../browser-smoke-effectiveness/status.md#verification-ledger).
This validates the policy edit only; no implementation phase ended and
`pnpm test:all` was not run for this edit.

| Scope                         | Source/date                                     | Result                                                                                                                                                                                   | Limit                                                                                                      |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Planning source review        | Planning source, 2026-09-06                     | Confirmed existing writer-loss teardown, event gating, partial observer shell, persisted navigation, and recovery owners.                                                                | Source assessment only; no production reproduction or new feature execution.                               |
| Parallel planning cross-check | Planning worktree, 2026-09-06                   | Two read-only source reviews cross-checked; confirmed observer SSE gap, routed persona writes, and distinct draft/outbox/effect ownership.                                               | Plan input only; no implementation phase accepted.                                                         |
| Plan validation               | Planning worktree, 2026-09-06                   | Explicit validation passed for all 11 plan/index documents; `pnpm check:docs` passed for 49 current documents; explicit Prettier and whitespace checks passed.                           | Document integrity only; implementation phases remain pending.                                             |
| Agent aggregate               | Planning source plus plan documents, 2026-09-06 | `pnpm test:agent` passed in 2m 16.2s: server/browser types, topology, current docs, frontend tests/check, server tests, and smoke build. Five tests were skipped by the existing suites. | Workspace baseline only; no Playwright execution, new feature behavior, or user/CI compatibility evidence. |

Plan review: two additional read-only reviews were reconciled against source.
The plan now specifies finite lifecycle capabilities, reader handling of writer
frames and replay/live transitions, bounded mutation inventory, operational
job events, incomplete generation metadata, and mixed-version behavior. These
are planning contracts, not reproduced defects or implemented fixes.

After each completed slice record the source/commit when available, changed
boundaries, exact commands and outcomes, acceptance evidence, and residual
limits. Link long evidence separately only when necessary. Keep the current
cursor at the top; do not duplicate it in the plan or phase files.

## Decisions and Scope

- 2026-09-06: Preserve one server-authorized writer and permit multiple
  authenticated connected readers. Explicit **Use this device** is the switch
  action; readers never acquire write access through focus/reload/reconnect.
- 2026-09-06: Reader selection is local. Preserve originating-client drafts;
  new observer edits and cross-device draft transfer are outside the initial
  feature. Live generation observation is required by Phase 4.
- 2026-09-06: Named-device lists, remote assignment, automatic navigation
  following, collaborative editing, and authoritative offline storage are
  follow-up work.
- 2026-09-06: This task prepares the documents. Implementation begins in a
  subsequent task at Phase 0; all implementation phases remain pending.
- 2026-09-07: The user confirmed the rollout default: keep the public feature
  disabled during implementation, then enable connected readers by default
  after all required feature evidence passes. Phase 5 verifies the final default
  and conservative-writer fallback, preserving drafts and pending intent.
- 2026-09-07: The user explicitly requires the implementing agent to run
  `pnpm test:all` at the end of every phase without additional user consent,
  before acceptance or handoff. This supersedes the earlier user/CI-only command
  ownership for this workstream. Record final-source results and keep failed or
  unavailable required checks pending. All implementation phases remain pending.

Record future scope or sequencing changes here with rationale, affected phase,
dependency, evidence, and remaining consequence. Update the plan and affected
phase when stable behavior or dependencies change.

## Phase 0 Implementation Decisions

These choices have acceptance criteria in Phase 0; they are not open-ended
product questions requiring another approval round.

1. Live role/connectivity owner and how existing startup capabilities consume it.
2. Reader selection ownership and interaction with shared selection projections.
3. Observer-safe runtime set, including plugin/display and operational routes.
4. How retained drafts/intent are separated from authoritative reader content;
   which current editors need additional demotion preservation.
5. Rollout flag ownership and old-client/protocol compatibility under the agreed
   disabled-during-implementation, enabled-after-verification default policy.

## Stage 1 Smoke Prerequisite

Received 2026-09-07: [smoke Phases 0–2 accepted](../browser-smoke-effectiveness/status.md#phase-2-acceptance-and-stage-1-handoff-2026-09-07),
including all four critical contracts, their required fault demonstrations and
restored browser proof, and the phase-ending agent-executed `pnpm test:all`
(**79/79 browser cases, all 13 lanes pass**). No high-risk critical gap remains
at the handoff source. See the smoke inventory/findings for exact source limits.

This accepts the prerequisite only; reader Phases 0–5 remain pending. Start
Phase 0 with current source confirmation, transition/entry-point/draft inventory
and the rollout decision. Keep connected readers disabled during implementation,
then apply the agreed enabled-by-default policy with fallback proof in Phase 5.
Maintain affected smoke tests as behavior changes; replace obsolete old-writer
freeze expectations while retaining ownership, draft, durability and exactly-once
protections. The smoke workstream resumes with Stage 3 reconciliation and its
remaining Phases 3–4 after reader completion.
