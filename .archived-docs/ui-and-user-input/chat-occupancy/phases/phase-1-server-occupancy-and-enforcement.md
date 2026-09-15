# Phase 1: Server Occupancy and Enforcement

Dependency: Phase 0 accepted and committed. Primary boundaries: B01, B02,
B05-B07, B09-B10. Read [PLAN.md](../PLAN.md) and [status](../status.md).

## Outcome

The server can admit one occupant per chat and reject foreign mutations at
every classified entry point. General owner authority and the default existing
client path remain intact. New behavior stays behind the agreed rollout boundary.

## Work

### 1a. Durable authority and protocol

- Implement the agreed migration and occupancy identity, atomic conditional
  claim/release/renewal, presence/expiry, and consistent discovery snapshots.
- Add the shared protocol, bootstrap/ownership projection, and event contracts.
  Preserve owner discovery and global committed-event ordering.
- Define truthful conflict/error responses and reject unsupported negotiated
  writes. Review registration, manifest policy, auth, and target resolution
  together; a broad `/commands` exemption is not acceptable.
- Cover initialization, idempotent migration, restart, lineage rotation, and
  same-session stale-epoch cases. Occupancy claims must not authorize stale tabs.

### 1b. Chat writes and accepted operations

- Enforce occupancy inside accepted-send and direct chat mutation transactions.
  Resolve message/job/operation/effect targets from persisted identity.
- Carry the admitted chat-only/general-owner mutation scope with durable work.
  Preserve operation idempotency and existing per-chat generation exclusion.
- Implement the minimum server side-effect restrictions needed before any
  chat-only request is accepted. Scope must not expand during later recovery.
- Coordinate release/handoff with accepted/stopping/finalizing operations.
  Do not discard an authorized result because a browser no longer has presence.

### 1c. Indirect writes

- Apply the Phase 0 mutation map to deletion/reset, folders/reorder, fork,
  imports/restore, background jobs, and broad repository writers.
- Reject deletion, reset, and restore atomically when any affected chat is
  occupied, returning the conflicting chats and safe release information.
- Recheck authority after asynchronous preparation and within publication
  transactions. Preserve unrelated owner writes without broad application locks.
- Verify old owner requests and legacy generation endpoints cannot bypass an
  occupancy merely because they do not know the new protocol.

## Evidence and Exit Criteria

- Server tests prove T01 admission/revision retry prerequisites, T02 exclusion,
  T03 shared-write prevention, T05 epoch races, and T09/T10 indirect/lineage rules.
- Two authenticated sessions can be admitted to different chats, but same-chat
  foreign writes fail even when the caller is the general owner.
- Accepted-operation persistence survives loss of browser presence. The agreed
  minimal effect restrictions are in place before enabling chat-only submission.
- Existing owner route policy, generation, maintenance, and migration tests pass.

Use the concrete test owners from Phase 0, including current server
`activeWriter`, `routeProtection`, `generationOperations`, `durableGeneration`,
and mutation/maintenance suites. Finish with the
[mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate) and commit.
