# Chat Occupancy Status

Updated: 2026-09-14.

## Execution Cursor

- State: planning package authored; implementation not started. No phase accepted.
- Planning source: `3c8f5aee1a48fcf35d1611323929f8197c142b6b`.
- Current work: planning handoff; document validation completed.
- Next action: execute Phase 0a, fixing the permission and occupancy lifecycle
  contract against the source inventory before choosing wire/storage details.
- Phase 0 acceptance still requires its work, `pnpm test:all`, independent
  GPT 6 Astra High review, finding resolution, and a phase commit.
- Runtime changes, full-suite execution, phase review, and phase commits: none.

## Read Routing

- [PLAN.md](PLAN.md): objective, product contract, scope, decisions, and gates.
- [Inventory](inventory.md): source boundaries and proof obligations.
- [Phase index](phases/README.md): ordered work and document validation commands.
- [Active plans](../README.md): project planning index.

## Phase Ledger

- **0 — Contract and inventory:** not started. Next evidence: decided lifecycle,
  complete interaction/effect dispositions, affected-mutation map, proof owners.
- **1 — Server occupancy and enforcement:** pending Phase 0 acceptance/commit.
- **2 — Chat-only interaction:** pending Phase 1 acceptance/commit.
- **3 — Recovery and completion:** pending Phase 2 acceptance/commit.
- **4 — Integrated verification and release:** pending Phase 3 acceptance/commit.

## Decisions and Open Work

Established requirements: one general owner; exclusive chat occupancy binding
all clients; chat-only sending/observation; no chat-only general writes such as
`lastInteraction`; independent general ownership and occupancy; full suite,
Astra High review, fixes/revalidation, and commit at every phase completion.

User decisions recorded on 2026-09-14: each chat-only device may occupy one chat;
navigation retains occupancy, observation does not switch it, and mutating another
chat requires an explicit switch. Reroll is required for the first chat-only
release, while continue and regenerate are deferred. A deletion, reset, or restore
whose scope contains an occupied chat rejects the entire operation and reports
the conflicting chats plus a safe release path.

The [Phase 0 decisions](PLAN.md#phase-0-decisions) remain implementation work.
The recorded product choices must now be mapped to exact source behavior. Lease
timing, remaining optional interactions/effects, non-destructive parent writes,
wire/storage details, and recovery mechanics remain to be decided from evidence.
No infrastructure blocker has been established.

The current automatic general-owner acquisition preference is preserved. Its
startup/foreground behavior must be tested independently of chat occupancy.

## Verification Ledger

- Source investigation: existing singleton owner, global command revision,
  bounded generation-submit retries, per-chat live-operation constraint,
  character maintenance, effect recovery, and existing concurrent-generation
  test inspected. This is planning evidence, not verification of chat occupancy.
- Earlier user-referenced tasks inspected: implementation followed by independent
  review and additional startup race tests. They do not certify this feature.
- Planning cross-check: two read-only Luna workers completed source-boundary and
  proof/scope investigations. Reconciled accepted-operation lifetime, indirect
  parent writes, role-independent occupancy, mixed-version behavior, selective
  replay, and effect restrictions into the package. Their recommendations are
  planning input, not the required Astra phase review. A worker's uncertainty
  about submit retries was resolved directly in browser `generationOperations`:
  `MAX_REVISION_RETRIES = 3` and its bounded revision-conflict branch exist.
- `pnpm check:docs`: passed for 51 current documents.
- Explicit package/index validation from the phase index, rerun after recording
  the user decisions: passed for 10 documents, with no link, anchor, literal-path,
  or index errors.
- Explicit Prettier formatting/check for the package and active-plan index,
  rerun after the decision update: passed. `git diff --check`: passed.
- `pnpm test:all`: not run for plan authoring; required before Phase 0 acceptance.
- GPT 6 Astra High phase review: not run; its gate follows the full-suite pass.

## Status Update Contract

After each bounded slice, update the next action and record changed boundaries,
source identity, focused evidence, failures, and unresolved work. At phase
acceptance add full-suite results, reviewer identity/reference, each finding's
resolution, evidence limits, and phase commit/handoff reference. A discovered
blocker changes the cursor; it never changes a failed check into a pass.
