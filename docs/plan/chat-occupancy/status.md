# Chat Occupancy Status

Updated: 2026-09-14.

## Execution Cursor

- State: Phase 0 implementation, validation, and independent review complete;
  phase commit pending.
- Planning source: `3c8f5aee1a48fcf35d1611323929f8197c142b6b`.
- Phase 0 baseline: `ec5765f4f`; the only drift from the planning source is the
  planning package itself. Runtime source remains the inspected baseline.
- Current work: Phase 0a-0c decisions and proof ownership recorded below and in
  [inventory](inventory.md); no chat-occupancy runtime feature is enabled. The
  gate also repaired pre-existing automatic-writer-acquisition browser fixtures
  and a duplicate reader-recovery race discovered by the mandatory full suite.
- Next action: commit Phase 0, then begin Phase 1 with schema/protocol and the
  isolated occupancy service behind the disabled rollout boundary.
- Phase 0 acceptance requires only its authorized phase commit; every preceding
  gate is complete.

## Read Routing

- [PLAN.md](PLAN.md): objective, product contract, scope, decisions, and gates.
- [Inventory](inventory.md): source boundaries and proof obligations.
- [Phase index](phases/README.md): ordered work and document validation commands.
- [Active plans](../README.md): project planning index.

## Phase Ledger

- **0 — Contract and inventory:** implementation, full-suite validation, and
  independent review complete; phase commit pending.
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

### Occupancy identity and lifecycle

- Schema version 40 adds `chat_occupancies`. A retained row is keyed by
  `chat_id` and carries the current database lineage, nullable occupant session,
  monotonically increasing epoch, claim class (`owner` or `chat_only`),
  claim/lease/update timestamps, and an optional release timestamp. Released
  rows remain as epoch tombstones. A partial unique index on a non-null
  `chat_only` occupant session enforces one chat-only claim per page session;
  owner-class claims are not session-unique so the current owner can keep its
  supported concurrent generation in different chats. The authoritative fence
  is `(databaseLineage, chatId, sessionId, occupancyEpoch)`; claim class is
  admission policy, while timestamps, writer epoch, global revision, and server
  instance identity are not authority.
- A claim uses `BEGIN IMMEDIATE`. It succeeds for an available target only when
  an authenticated current owner requests an owner-class claim, or a non-owner
  session has no other occupancy and requests a chat-only claim. It increments
  the target epoch and sets a 90-second server-time lease. Repeating a claim by
  the current unexpired occupant is idempotent and renews without changing the
  epoch or claim class. A chat-only claim in a second chat returns
  `chat_occupancy_switch_required`; it never changes either chat implicitly.
- Renew every 30 seconds while the page is live. Renewal requires the exact
  tuple and an unexpired lease. Release requires the exact tuple and increments
  the epoch while retaining a tombstone. Expired or stale renew/release requests
  cannot affect a newer occupant. Navigation, observation, visibility changes,
  stream detach, and general-owner promotion/demotion do not release or
  reclassify occupancy. A promoted page keeps its chat-only row and may add
  owner-class rows. A demoted page keeps owner-class rows so admitted work and
  explicit Stop/release can settle, but it cannot admit new conversational work
  or make a chat-only claim until one atomic normalization examines all rows for
  that session, releases every idle nonselected row regardless of claim class,
  and converts the selected retained row to `chat_only`. Any pinned nonselected
  row makes the entire normalization fail without mutation and with recovery
  guidance. Thus a chat-only A → promotion/add owner B → demotion/retain B path
  cannot leave A behind or violate the unique index.
- An explicit switch atomically verifies and releases the source tuple and
  claims the available target. It fails without changing either row when the
  source has pinned work, the target is unavailable, the tuple is stale, or the
  lineage changed. The existing page-exclusive Web Lock identity is required
  for claim/switch; a page that cannot prove exclusivity remains an observer and
  gets explicit unsupported-browser feedback. A legitimate reload retains the
  session and can renew; a duplicated tab receives a new session. Reacquisition
  after expiry always receives a new epoch, even for the same session.
- SSE connection presence is advisory. Reader event streams identify their page
  session, but disconnect never releases occupancy. Reconnect obtains a fresh
  occupancy snapshot before replay. Live `occupancy` frames carry a complete
  tuple; per-chat epochs and database lineage reject stale delivery. Occupancy
  transitions do not bump the domain revision or create command events, so the
  existing global committed-event sequence remains unchanged.
- Accepted generation records capture the exact occupancy tuple, admission kind,
  permission-scope version, and immutable allowlist in the acceptance
  transaction. That authority survives browser disconnect and owner role
  changes. Nonterminal operations, unfinished finalization, server translation,
  and transcript-mutating durable effects pin release/switch/reassignment.
  Explicit Stop must reach a terminal/reconciled state first.
- Automatic Hypa memory jobs and BardWiki `apply_turn`/`reconcile_receipt` jobs
  created by an admitted operation persist that operation's lineage, chat,
  attempt, occupancy tuple, and immutable scope. They pin occupancy from enqueue
  through terminal `completed`, `failed`, or `cancelled`, including provider
  analysis after generation finalization; each write rechecks the stored fences.
  Manual BardWiki rebuild/reconcile and memory-control work remains owner-only.
  Pending/running memory or BardWiki jobs created before protocol-v1 admission
  are legacy drain pins: rollout rejects a new occupancy on their chat until the
  bounded worker retry/recovery policy makes them terminal. Neither lease expiry
  nor handoff strips their authority. Restart recovers them before reclaim, and
  switch/release reports `chat_occupancy_recovery_blocked` while they remain
  nonterminal. This prevents BardWiki canonical-document or Hypa state writes
  from crossing reassignment.
- On restart, unexpired rows survive. Startup generation/finalization recovery
  runs before expired rows are made reclaimable. A live/finalizing operation
  remains pinned; an abandoned operation is first reconciled against the exact
  transcript and journal. When no result/finalization exists after the lease
  expires, reclaim terminalizes that non-live attempt as
  `occupancy_recovery_expired` without provider resubmission, preserves any
  accepted user row, skips remaining transcript-mutating client effects, and
  advances the occupancy epoch. This prevents immortal occupancy without
  guessing whether a provider ran.
- Staged intent for which operation lookup proves that acceptance never occurred
  never auto-replays after its occupancy expires, even when the same session
  later reacquires the chat. It remains dormant as `requires_resubmission`; the
  originating draft and diagnostic identity are preserved and the UI reports
  that it was not sent. Accepted-operation and effect-receipt reconciliation
  still runs first under stored authority. Only a new explicit Send/Reroll may
  create a new operation ID after re-reading the current transcript tail, base
  revision, effective configuration, and exact current occupancy. The old token,
  operation ID, and bounded-retry revision are never transplanted.
- Lineage rotation clears occupancy rows rather than restoring them. Old tuples,
  operations, callbacks, and effects fail the lineage fence. Auth loss stops
  renewals and local replay; expiry/recovery performs the server cleanup.

### Permission and configuration scope

- Both new owners and chat-only sessions use occupancy for send, Reroll, and
  Stop. Compatibility owner requests without the new protocol remain allowed on
  an unoccupied chat but never bypass a foreign occupancy. General owner
  administrative chat writes remain allowed only when the target is unoccupied
  or self-occupied and are rechecked in their transaction. Owner-class occupancy
  is per chat rather than per session, preserving concurrent owner operations in
  different chats; the one-chat restriction is only for chat-only admission.
- `chat_only_v1` admits the accepted user row, assistant result/cancelled partial,
  Reroll alternate/selection, required message-ID repair, target-chat transcript
  injections, chat script variables, chat `lastMemory`, chat-owned memory rows
  and follow-up jobs, atomic IGP edits of the generated assistant row, and
  server-owned generated-message translation. Prompt reads, Agent/Agent Preset
  provider work, and operational request history may consume the server-owned
  configuration snapshot but gain no application-write authority.
- It excludes `lastInteraction`, persisted global/character/chat selection,
  character fields and local character lore, settings, modules, plugin storage,
  plugin-output callbacks, and generated asset writes. Forbidden optional script
  effects are suppressed with a warning and terminal ledger disposition; the
  accepted transcript/result remains. A plugin-provided generation path that
  cannot execute without general browser-plugin authority is rejected before
  provider dispatch.
- Acceptance resolves authoritative settings, character definition, chat
  generation settings, persona, preset/loadout, modules, scripts, memory policy,
  and provider profile from SQLite. It persists a bounded server-derived
  effective configuration snapshot/fingerprint with the operation. Later owner
  edits affect subsequent operations, not an accepted attempt or retry. A retry
  reuses the accepted snapshot and scope; neither promotion nor demotion expands
  or invalidates them.
- Notification, completion sound, and TTS playback are originating-session
  ephemeral effects and do not pin handoff; stale late recovery settles them as
  skipped under the existing time bound. Emotion/image recomputation and plugin
  output are skipped for chat-only v1. Generated translation is server-owned and
  IGP is exact-message scoped; both use the admitted operation scope and must
  settle before a conflicting handoff.
- Chat-only v1 visibly disables Continue, Regenerate, message edit/delete,
  manual translation/edit, chat creation/forking, attachments/uploads, chat
  generation settings, chat metadata/bookmarks, memory controls, Draft/BTW input
  hooks, slash commands, plugin callbacks, and manual emotion/image actions.
  Copy, scrolling, transcript hydration, local drafts, observation, and local
  TTS Stop remain available. Owner behavior is retained, subject to the foreign
  occupancy transaction check.

### Wire, rollout, and errors

- Add `chatOccupancyProtocol: { version: 1, enabled, leaseMs: 90000,
renewAfterMs: 30000 }` to bootstrap and a versioned authenticated occupancy
  snapshot/claim/renew/release/switch route family. Requests use the existing
  page session header plus lineage and a dedicated occupancy-epoch header. Chat
  target IDs on operation/effect/message control are resolved from stored
  identity and compared with route/body IDs.
- Chat-only writes require advertised enabled protocol v1 and an exact tuple;
  unsupported or missing versions fail closed. The rollout stays disabled until
  Phase 4. Rollback disables new claims/chat-only submits, continues renewal,
  Stop, settlement, and release for existing rows, and keeps foreign-occupancy
  protection until the durable rows drain. It requires no schema downgrade.
- `423 chat_occupied` reports the target and safe release guidance;
  `409 chat_occupancy_stale` returns the current public projection;
  `409 chat_occupancy_switch_required` reports current and target chats;
  `409 chat_occupancy_recovery_blocked` reports the target and blocking
  operation/effect identities; `409 chat_only_interaction_unsupported` reports
  the interaction; and `426 chat_occupancy_protocol_required` reports the
  supported version. Conflict responses never authorize optimistic success.
  Lineage, revision, operation-state, and active-writer errors retain their
  current envelopes.

No infrastructure blocker has been established. The full entry-point and proof
maps are in [inventory](inventory.md).

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
- Phase 0 implementation cross-check: eight read-only GPT 5.6 Luna workers at
  high effort audited authority/storage, wire rollout, browser identity,
  interactions, generation scope, parent writes, recovery, and T01-T11 proof
  ownership; all completed. A focused two-worker rerun recovered the detailed
  interaction/generation classifications after aggregate output truncation.
  Their cited claims were reconciled against the current source before the
  decisions above were recorded. This is implementation evidence, not the
  mandatory independent Astra review.
- `pnpm check:docs`: passed for 51 current documents.
- Explicit package/index validation from the phase index, rerun after recording
  the user decisions: passed for 10 documents, with no link, anchor, literal-path,
  or index errors.
- Explicit Prettier formatting/check for the package and active-plan index,
  rerun after the decision update: passed. `git diff --check`: passed.
- Phase 0 contract/inventory document validation: `pnpm check:docs` passed for
  51 current documents; the explicit package/index validator passed for 10
  documents; package Prettier check and `git diff --check` passed.
- Initial `pnpm test:all`: failed in browser smoke (25 failures) and format check
  (two files). Investigation traced the browser cascade to the preceding
  default-on disconnected-writer acquisition change: explicit-reader fixtures
  had not opted out, pure aggregate/sidebar POST reads were classified as
  mutations, two disabled ephemeral effects expected the less-specific
  `late_recovery` reason, and collapsed Input Hook cards were exercised without
  opening them. The run also exposed an online reader race where a new unfenced
  full refresh competed with the extant stream's minimum-revision gap recovery,
  plus a background-runtime test that faulted a Display resource shared with
  chat-generation readiness.
- Gate repairs: explicit-reader shared fixtures now set
  `autoAcquireDisconnectedWriter: false`; their read audits recognize the exact
  aggregate/sidebar cache-read routes; disabled sound/notification receipts
  assert `not_configured`; Input Hook browser flows open their collapsed card;
  an extant reader sync exclusively owns reconnect/gap recovery; and the
  background-runtime proof faults its background-only dynamic module. The two
  pre-existing Svelte formatting failures were normalized with Prettier.
- Focused repair evidence: `src/ts/bootstrap.test.ts` passed 245 tests; the
  eight previously failing browser cases passed serially; the older-snapshot
  recovery and background-runtime cases then passed individually; repository
  `pnpm format:check` and `git diff --check` passed.
- Final Phase 0 `pnpm test:all`: passed all 14 lanes in 7m 35.5s, including
  frontend 9,343 passed/3 skipped, server 4,420 passed/3 skipped, browser smoke
  149 passed, UI coverage, compatibility, typechecks, documentation, formatting,
  and performance gates.
- First GPT 6 Astra High phase review: reviewed HEAD `ec5765f4f` and diff
  `41095750438e6a98c09df22ac644ed892b2617d4242e441ee3a779cd494c75a3`
  read-only. It found three P2 contract gaps: the unconditional session-unique
  index regressed owner multi-chat generation; asynchronous Hypa/BardWiki work
  had no handoff disposition; and expired unaccepted intent had no exact recovery
  outcome. The owner/chat-only claim classes and explicit demotion normalization,
  memory-job drain pins, and dormant fresh-resubmission policy above resolve the
  findings. Reviewer closure remains pending.
- Post-fix Phase 0 `pnpm test:all`: passed all 14 lanes in 7m 34.7s, including
  frontend 9,343 passed/3 skipped, server 4,420 passed/3 skipped, browser smoke
  149 passed, UI coverage, compatibility, typechecks, documentation, formatting,
  and performance gates. The explicit 10-document plan validator, package
  Prettier check, and `git diff --check` also passed before the full suite.
- First closure review confirmed the memory-job and stale-intent findings were
  resolved and owner concurrency restored, then found a remaining P2 mixed-class
  normalization edge: selecting an owner-class row after demotion could leave a
  previously retained chat-only row. The all-session-row atomic normalization
  rule above and its T08 proof resolve that finding.
- Final GPT 6 Astra High closure review: no actionable Phase 0 findings remain.
  It verified diff
  `d8c25708599349499b95ec7610dcfc1094fe9e0990df0e02553fe0a852b38084`
  against HEAD `ec5765f4f`, confirmed all four dispositions and that the passing
  full-suite evidence remains applicable because the final correction was
  contract-only, and approved the Phase 0 boundary. The review was read-only and
  did not independently rerun tests. Runtime enforcement and actual
  multi-session proof remain explicitly assigned to later phases.

## Status Update Contract

After each bounded slice, update the next action and record changed boundaries,
source identity, focused evidence, failures, and unresolved work. At phase
acceptance add full-suite results, reviewer identity/reference, each finding's
resolution, evidence limits, and phase commit/handoff reference. A discovered
blocker changes the cursor; it never changes a failed check into a pass.
