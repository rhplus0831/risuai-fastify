# Phase 3: Recovery and Completion

Dependency: Phase 2 accepted and committed. Primary boundaries: B02, B05-B09.
Read [PLAN.md](../PLAN.md) and [status](../status.md).

## Outcome

Occupied chat work remains correct across connection/role changes, lost
responses, release/handoff, and server restart. Completion effects have explicit
authorized or terminal unsupported outcomes; no cross-scope replay is admitted.

## Work

### 3a. Scoped pending intent and recovery

- Separate general-owner recovery from chat-operation recovery in outbox and
  readiness gates. Preserve dormant general/foreign-session records and drafts.
- Revalidate lineage, target chat, occupancy epoch, and origin before replay.
  Reconcile accepted operation IDs/receipts before resubmitting; never rewrite
  an old token and replay stale unaccepted intent without the agreed checks.
- Handle lost acceptance/Stop responses and late callbacks while preserving
  newer drafts, optimistic edits, and the current occupant's projection.
- Recover observer subscriptions and local selection without granting authority.

### 3b. Occupancy lifecycle and accepted work

- Implement the complete agreed foreground, suspension, offline, expiry,
  duplicated-tab, navigation-away, reload, and restart paths in the browser.
- Preserve occupancy across navigation and observation, and recover or reject an
  explicit cross-chat mutation switch without duplicating accepted send/Reroll
  work or transferring stale authority.
- Keep accepted server operations pinned through finalization. An explicit
  Stop/handoff waits for acknowledged safe settlement; connection loss is not
  cancellation. Recover stalled finalization without leaving chats permanently
  unavailable or permitting overlapping incompatible work.
- General-owner promotion/demotion and automatic acquisition must not stop
  otherwise-authorized occupied-chat work or unlock someone else's chat.
- Auth loss, deletion/replacement, and lineage change retire authority promptly;
  unrelated general-owner role changes do not use that same global reset.

### 3c. Completion ownership

- Scope bootstrap finalizations and effect claim/renew/receipt operations to
  their actual chat/operation and accepted mutation permissions.
- Finish every Phase 0 effect disposition: permitted effects execute safely;
  unsupported effects report and settle without replay under a more powerful
  owner's authority. Preserve required idempotency and IGP atomicity where used.
- Verify generated translation, memory/agents, and optional browser effects
  cannot reintroduce shared writes or leave an unresolvable pending ledger.

## Evidence and Exit Criteria

- T05-T08 cover simultaneous claim/release, stale renewal, same-session
  reacquisition, delayed responses, suspended pages, role transfer, and replay.
- Accepted results persist after the sending browser disappears; handoff never
  permits incompatible pending work to overwrite the new occupant.
- Lost effect receipts and expired claims do not duplicate mutations; skipped
  effects are terminal and visible where relevant.
- T10 verifies auth/lineage/restart boundaries, including destructive operations
  interacting with pending sends. T03 holds through recovered scripts/effects.
- Run real multi-session fault journeys as well as focused state/store tests;
  retain exact source and artifact identities in status.

Finish with the [mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate)
and commit. No Phase 3 acceptance with an unclassified effect or known replay gap.
