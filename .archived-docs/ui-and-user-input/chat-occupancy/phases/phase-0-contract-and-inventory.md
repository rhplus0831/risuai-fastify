# Phase 0: Contract and Inventory

Dependency: planning baseline. Source boundaries: B01-B10 in
[inventory](../inventory.md). Execution belongs in [status](../status.md).

## Outcome

An implementable owner/occupancy contract and complete bounded mutation/effect
map, with exact test owners for T01-T11. No runtime feature is enabled here.

## Work

### 0a. Permissions and lifecycle

- Recheck the planning source against the current checkout. Record any drift.
- Define claim, renewal, release, expiry, handoff, navigation-away, reload,
  duplicated-tab, server restart, and database replacement transitions. For
  each, name authoritative state, allowed requests, and stale-response behavior.
- Select occupancy storage, token/epoch, session identity, presence tracking,
  and recovery protocol separately from general-owner acquisition. Encode the
  decided one-chat limit, retained navigation occupancy, explicit mutation switch,
  and observation behavior; decide the behavior of existing background jobs.
- Define how accepted operations pin the chat until safe handoff, including
  stopping, finalization retry, uncertain acceptance, and unsupported effects.
- Specify the existing automatic owner preference's independent behavior; do
  not let owner changes invoke blanket occupant teardown.

### 0b. Mutation and feature dispositions

- Expand B01-B09 by actual entry points and physical writes. Include messages
  addressed by ID, operation/effect control, parent collections, imports,
  restores, old endpoints, plugins, and background work.
- Classify every interaction/effect named in the plan, including required
  chat-local message-ID repair versus forbidden `lastInteraction` maintenance.
  Treat Reroll as first-release required and continue/regenerate as deferred for
  chat-only mode while preserving existing owner behavior.
- Fix the source of generation configuration and its behavior if the owner edits
  shared inputs while another device's send is preparing or running.
- Define explicit unsupported behavior before broad write privileges are granted.
  Protect accepted transcript results and settle skipped/failed effect records.
- Determine additive protocol negotiation, inactive rollout behavior, older
  owner/client handling, and rollback/drain rules.
- Record whole-operation rejection and conflict/release feedback for deletion,
  reset, and restore affecting occupied chats; classify remaining parent writes.

### 0c. Proof and baseline

- Map T01-T11 to exact tests/harness owners, including new tests where none exist.
  Identify deterministic provider gates, real separate sessions, and persisted
  state assertions for general-write containment.
- Record intended rejection codes/envelopes and client handling for occupied,
  stale-occupancy, recovery-blocked, and unsupported cases.
- Identify the first Phase 1 slice and maintain the five-phase scope unless a
  documented dependency requires changing it. Capture a baseline for concrete
  uncertainties; avoid broad unrelated test/code audits.

## Exit Criteria

- No in-scope authority transition or mutation/effect family is unclassified.
- Occupancy fencing, durable-operation lifetime, owner independence, feature
  dispositions, and mixed-version behavior have implementable decisions.
- Every proof obligation has an owner and an appropriate observation boundary;
  concurrent jobs in one session are not treated as T01 completion.
- Plan/inventory changes pass their explicit document checks.

Then run the [mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate),
including `pnpm test:all`, GPT 6 Astra High review of the contract/test plan
against current source, fixes/revalidation, status acceptance, and phase commit.
Do not mark Phase 0 complete merely because these files exist.
