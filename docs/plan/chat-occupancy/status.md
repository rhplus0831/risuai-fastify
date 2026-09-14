# Chat Occupancy Status

Updated: 2026-09-14.

## Execution Cursor

- State: Phases 0 and 1 are accepted and committed. Phase 2 chat-only
  interaction is accepted and ready for its required commit. Phase 3 recovery
  and completion is next. The feature remains disabled until Phase 4.
- Planning source: `3c8f5aee1a48fcf35d1611323929f8197c142b6b`.
- Phase 0 baseline: `ec5765f4f`; the only drift from the planning source is the
  planning package itself. Runtime source remains the inspected baseline.
- Current work: Phase 3 closes scoped recovery, lifecycle, and completion-effect
  behavior on top of the accepted server and chat-only interaction foundations.
  New chat-only claims remain disabled in production until the Phase 4 release
  boundary.
- Phase 0 commit: `d03288053` (`docs: freeze chat occupancy contract`).
- Phase 1 commit: `8a11e00e2` (`feat: enforce server chat occupancy`).
- Next action: commit accepted Phase 2, then implement and prove the Phase 3
  recovery, lifecycle, and completion-effect matrix.

## Read Routing

- [PLAN.md](PLAN.md): objective, product contract, scope, decisions, and gates.
- [Inventory](inventory.md): source boundaries and proof obligations.
- [Phase index](phases/README.md): ordered work and document validation commands.
- [Active plans](../README.md): project planning index.

## Phase Ledger

- **0 — Contract and inventory:** accepted in `d03288053` after full-suite pass
  and independent GPT 6 Astra High closure review.
- **1 — Server occupancy and enforcement:** accepted and committed in
  `8a11e00e2` after the 7m33.3s full gate and clean eighth independent closure
  review.
- **2 — Chat-only interaction:** accepted at baseline `8a11e00e2`; required
  phase commit pending.
- **3 — Recovery and completion:** next after the Phase 2 commit.
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
  and converts the selected retained row to `chat_only`. Reclassification keeps
  the selected row's epoch: claim class is immutable admission provenance for
  accepted work, not part of the four-part authority tuple. Any pinned nonselected
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
  occupancy snapshot before replay. Snapshot and live `occupancy` frames carry a
  top-level database lineage even when empty; non-empty rows repeat the complete
  tuple. Per-chat epochs and database lineage reject stale delivery. Occupancy
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
- Phase 1 implementation cross-check: four read-only agents audited authority,
  protocol/SSE, generation/recovery scope, indirect mutations, and the T01-T10
  evidence map against baseline `d03288053`. Confirmed findings were fixed:
  normalization now preserves the selected tuple; empty snapshots carry lineage;
  recovery errors identify the actual blocked chat and safe release; stale-lineage
  rows cannot poison claims; failed partials retain exact operation scope and a
  truthful terminal failure; nonpinning effects settle for only their originating
  session; memory/BardWiki work uses the accepted fingerprinted configuration;
  and greeting translation plus import/restore staging recheck occupancy at the
  authoritative publication boundary. Alternate-greeting writes were narrowed
  so unrelated occupied rows remain byte-identical.
- Phase 1 focused evidence on the reconciled implementation: 25 server files
  passed together with 721 tests, including occupancy/service/routes, generation
  scope and durable submission, effects, memory/BardWiki workers, commands,
  maintenance/import/restore, migration, bootstrap/events, and route policy.
  Protocol occupancy tests passed 3/3; browser bootstrap passed 46/46; browser
  event parsing passed 18/18; `pnpm check:server` passed. New tests include the
  simultaneous one-winner claim, enabled-to-disabled drain, genuine pre-v40
  migration, real protocol-v1 Send/Reroll/Stop authority, selected-row
  normalization with accepted work, provider-failed partials, accepted-config
  barriers, late ephemeral settlement, and table-driven T09 rollback cases.
  These focused results do not by themselves accept the phase.
- Initial Phase 1 `pnpm test:all`: completed all 14 lanes in 7m 41.4s. Eleven
  lanes passed, while frontend had one fixture failure, server had 14 failures,
  and browser smoke had one failure. The failures exposed an omitted protocol
  runtime-inventory entry; exact technical-read-budget and persistence-owner
  fixture drift; a stale active-writer cancellation expectation; legacy-memory
  import correctly blocked by a real pending pin; diagnostics expecting a
  queued provider-failure partial to remain retryable after recovery; and Stop
  authority after active-writer handoff. They were investigated as gate
  failures rather than waived or relabelled.
- Phase 1 gate repairs: inventories now classify `chat_occupancies` and pin the
  updated schema digest; read budgets account for only the two transactional
  occupancy guard passes; stale-session cancellation still bypasses the global
  writer gate but reports the truthful missing-operation result; the legacy
  memory-import test proves atomic rejection while its old job pins the chat,
  then cancellation and successful retry; failed-partial diagnostics distinguish
  queued persistence from truthful recovered `terminal_failed`; and protocol
  cancellation permits the originating session or transactionally verified
  current-owner handoff for owner-class work while retaining exact-tuple foreign
  rejection for chat-only work.
- Focused gate-repair evidence: protocol import boundary 2/2, command read
  narrowing 26/26, active writer 28/28, persistence structure 7/7, legacy memory
  import 7/7, diagnostics generation 7/7, durable generation 90/90, and the real
  connected-reader writer-transfer Stop browser case 1/1. `pnpm check`,
  `pnpm check:server`, `pnpm check:docs`, the explicit 10-document validator,
  repository `pnpm format:check`, and `git diff --check` pass on the repaired
  source.
- Repaired Phase 1 `pnpm test:all`: passed all 14 lanes in 7m 31.7s, including
  frontend 9,347 passed/3 skipped, server 4,482 passed/3 skipped, browser smoke
  149 passed, UI coverage, compatibility, typechecks, documentation, formatting,
  Realm scale, and performance gates. This passing run does not by itself accept
  Phase 1.
- First Phase 1 GPT 6 Astra High review: reviewed HEAD `d03288053`, tracked diff
  `7089bbf99ae9f0925df126710aada9a4176127ea59d5b1e3aaee70da2a6cd14c`,
  and all 11 new files under a sorted per-file checksum manifest whose SHA-256 is
  `75cf3fb55efab5eec9014452f19ea28e19e7d9e98871c55089d9960951985596`.
  The review remained read-only and did not approve Phase 1. It found seven
  actionable gaps: chat-only Lua image generation did not receive the asset-write
  restriction; a demoted holder of owner-class occupancy could admit fresh
  owner-scoped work; expired rows stopped protecting chats whose accepted work
  still pinned them; genuine pre-v40 operations and finalization journals lacked
  a legacy completion authority; general-owner transfer could authorize Stop of
  a foreign occupancy-scoped operation; abandoned operations and pending IGP
  effects had no bounded `occupancy_recovery_expired` reclaim path; and generated
  translation consulted mutable live configuration instead of the accepted
  snapshot. Focused fixes, a new full-suite pass, and an independent closure
  review are required.
- Phase 1 Astra repairs: every Lua bridge now carries the generated-asset scope
  and publication rechecks it; fresh owner-class admission verifies current
  general ownership while a demoted session must normalize its complete claim
  set; expired occupancies retain direct, broad, indirect, and manual protection
  while durable work pins them; exact-tuple reclaim reconciles stored results or
  journals without provider redispatch, terminalizes unrecoverable attempts as
  `occupancy_recovery_expired`, skips incompatible pending IGP, and advances the
  epoch atomically; only genuine legacy unoccupied operations retain owner-handoff
  Stop; v40 migration marks only genuine pre-occupancy operations for exact
  lineage/attempt legacy finalization without inventing scope; and generated
  translation resolves a fingerprint-checked accepted translator, preset, and
  provider snapshot while retaining live exact-message publication checks.
- Post-review focused evidence: Lua assembly/runtime/trigger suites passed
  143/143, 66/66, and 147/147; occupancy/recovery/enforcement integration passed
  8 files/52 tests; historical migration, retry, journal startup, durable
  generation, and structure suites passed 2/2, 6/6, 6/6, 1/1, 90/90, and 7/7;
  translation barrier/recovery owners passed 186/186 and 9/9; the legacy browser
  writer-transfer Stop case passed 1/1. A root combined 16-file run passed 715 of
  716 tests, with only the graceful-shutdown case exceeding its 15-second test
  timeout under concurrent integration load; its immediate isolated rerun passed
  within the unchanged timeout as part of all 90 durable-generation tests.
  `pnpm check`, `pnpm check:server`, documentation checks, repository Prettier,
  and `git diff --check` pass. The post-review full-suite gate remains pending.
- First post-review `pnpm test:all`: completed all 14 lanes in 7m 46.0s. Thirteen
  lanes passed, including all 4,493 server tests/3 skipped; browser smoke passed
  148 of 149 and timed out only in device-backup `refresh-failure`. Its trace
  shows every functional assertion and page close completed successfully; the
  isolated Fastify harness teardown then stalled in `app.close()`. The exact
  scenario passed immediately in isolation and five more times in parallel
  (2.8-5.4s each) on unchanged source. This run remains failed; a complete
  passing full-suite rerun is still required, and a repeated teardown stall will
  be repaired rather than waived.
- Second post-review `pnpm test:all`: completed all 14 lanes in 7m 35.0s.
  Thirteen lanes passed, including all 4,493 server tests/3 skipped and the
  previously stalled backup scenario; browser smoke again passed 148 of 149.
  The remaining old-lineage in-place recovery journey had a response/event
  ordering race: it released the stale command immediately after the import
  response, so under load the 409 could schedule the deliberately retained hard
  reload before the browser consumed the lineage-changing import event. The
  journey now waits for the replacement Reader generation and lineage before
  releasing the command, matching the stronger journey later in the same file.
  The original ordering reproduced once in 10 parallel repetitions; the fixed
  ordering passed 20/20 in parallel. A complete passing full-suite rerun and the
  independent closure review remain required.
- Third post-review `pnpm test:all`: completed all 14 lanes in 7m 31.9s.
  Thirteen lanes passed, including both formerly failing browser journeys and
  all 4,493 server tests/3 skipped; browser smoke passed 148 of 149. The sole
  failure was an unrelated durable-settings recovery assertion that inspected
  SQLite after local outbox staging but while the intercepted `route.fetch()`
  was visibly still completing the promised after-commit transaction. The test
  now awaits completion of the first injected transport boundary before it
  classifies server truth. All three fault variants passed 60/60 under parallel
  repetition after the repair. A complete passing full-suite rerun and the
  independent closure review remain required.
- Fourth post-review `pnpm test:all`: completed all 14 lanes in 7m 38.3s.
  Thirteen lanes passed, including the two ordering repairs and all 4,493
  server tests/3 skipped; browser smoke passed 148 of 149. A second
  import/restore variant completed every functional assertion and closed its
  page, then spent the remaining 57 seconds waiting for Fastify to drain a
  browser keep-alive/SSE connection. Because the same shared-harness shutdown
  stall had now repeated across two matrix variants, the harness close helper
  was hardened to close browser connections before awaiting Fastify's graceful
  hooks, consistent with existing restart harnesses. The writer-change variant
  then passed 30/30 in parallel with normal 2.6-4.6-second completion; its
  intentionally partial artifact run reported only the expected global merge
  incompleteness. A complete passing full-suite rerun and the independent
  closure review remain required.
- Final post-review Phase 1 `pnpm test:all`: passed all 14 lanes in 7m 36.4s,
  including frontend 9,347 passed/3 skipped, server 4,493 passed/3 skipped,
  browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  reviewed worktree is frozen pending the independent GPT 6 Astra High closure
  review; Phase 1 is not accepted until that review is clean.
- First Phase 1 closure review: GPT 6 Astra High independently verified baseline
  `d03288053`, tracked diff SHA-256
  `757457059523d7e84691b8c06cbda4d85ca68193418a393ef34eed164c12c210`,
  and the 14-file untracked manifest SHA-256
  `98729def0bb992e0ff64703a34d95bd5d548c496b7cb52a36c9cd513f25d8066`.
  It did not approve the phase. Production-path probes reproduced two P2 gaps:
  expired reclaim blanket-skipped a still-running server generated-translation
  effect and advanced its occupancy fence, losing the accepted translation; and
  strict accepted-snapshot validation rejected genuine migrated pre-v40
  translation effects whose historical rows cannot contain the new fields.
  The reviewer found the three browser infrastructure repairs sound and not
  assertion masking. Focused fixes, a new full-suite pass, and a fresh closure
  review are required.
- First-closure translation repairs: expired reclaim now preserves an exact
  completed-result `generated_translation` effect while still terminally
  disposing abandoned or inapplicable client effects. A claimed live server
  translation renews its effect lease until provider completion or failure, and
  publication revalidates the exact effect claim, operation, attempt, scope, and
  target. Historical translation fallback is restricted to a v40
  migration-marked pre-occupancy operation with null modern authority, its exact
  historical attempt/job, completed result, effect key, message generation, and
  target; current malformed records fail before provider dispatch. The genuine
  v39 fixture now recreates the historical effect schema. Eleven focused suites
  passed 344 tests, including recovery, effects, genuine migration, completion,
  durable generation, scope, startup, and translation owners. `pnpm
check:server`, focused Prettier, and `git diff --check` also pass. The required
  full-suite rerun and fresh closure review remain pending.
- First post-closure-repair `pnpm test:all`: completed all 14 lanes in 7m 39.1s.
  Thirteen lanes passed, including frontend 9,347 passed/3 skipped and browser
  smoke 149/149; server tests passed 4,495/3 skipped except the recurrent
  graceful-shutdown test exceeded its 15-second ceiling. Loaded reproduction
  found a real transport-drain defect: Fastify's default one-shot idle sweep can
  inspect the generation SSE while it is active; after the cancellation runner
  finishes, that socket becomes an idle keep-alive which `server.close()` then
  waits up to 72 seconds to expire, preventing `onClose` from reaching its
  runner-settlement and SQLite-close boundary. The initial repair set
  `forceCloseConnections: true`, which runs after `preClose` and releases all
  persistent transports before `onClose` drains detached runners. The unchanged
  shutdown assertion passed 50 focused repetitions before the repair, and that
  repair passed the 90-test durable-generation, 19-test shutdown-index, and
  9-test memory-worker suites together (118/118), followed by `pnpm
check:server`, focused Prettier, and `git diff --check`. A new complete
  full-suite pass was still required.
- Second post-closure-repair `pnpm test:all`: completed all 14 lanes in 7m
  55.9s. Twelve lanes passed, including browser smoke 149/149. The broad
  `forceCloseConnections` attempt correctly fixed the generation shutdown but
  broke the existing graceful maintenance contract by destroying a held backup
  before its 499 response. It was replaced with a narrow pre-close viewer drain:
  generation SSE clients expose a completion promise, the registry gracefully
  closes and awaits only those viewers, and Fastify's normal idle sweep then
  proceeds while ordinary maintenance requests keep draining. The unchanged
  generation-shutdown and held-backup assertions pass together; their full owner
  files plus shutdown-index and memory-worker suites pass 146/146. The other
  failed lane exposed an independent test-only race in translator-preset replay:
  two IndexedDB rows were visible before the async DELETE click handler had
  released its predecessor lock, so manual replay could observe a stale handle.
  The test now waits for both retained-feedback notifications, the established
  neighboring synchronization boundary. The exact case passed 100/100 before
  the repair and its 71-test owner file passes after it. A new complete
  full-suite pass is still required.
- Final post-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  36.5s, including frontend 9,347 passed/3 skipped, server 4,496 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. This passing
  source is frozen pending the fresh independent GPT 6 Astra High closure
  review; Phase 1 remains unaccepted until that review is clean.
- Second Phase 1 closure review: GPT 6 Astra High independently verified
  baseline `d03288053`, tracked diff SHA-256
  `6e823b7a9786b461ad5091a7b09f2aaab9728fcc4439ae0981694c64a713af01`,
  and the 14-file untracked manifest SHA-256
  `3f74910f8961d95482505e400a7ff6a9528ebc56768094301232ad957faf48da`.
  It inspected all 79 tracked diffs and all untracked files, remained read-only,
  and did not approve Phase 1. Two in-memory production-helper probes confirmed
  P2 gaps: a migration-marked v39 operation finalized or retried after upgrade
  creates a translation effect with a populated attempt number that the legacy
  accepted-configuration fallback rejects before provider dispatch; and
  recovery silently leaves a pending translation effect nonterminal when its
  target message has been deleted or is no longer an assistant row, permanently
  pinning release/reclaim. The review found no other actionable defect and found
  no assertion masking in the test-only race repairs. Focused fixes, a new full
  suite, and another fresh closure review are required.
- Second-closure repairs: the historical translation authority now permits a
  populated effect attempt only when the migration marker, null legacy
  scope/configuration, exact operation/attempt/job/effect key, completed result,
  message generation identity, target, and lineage all validate. Modern
  malformed rows remain fail-closed. Recovery claims and terminally skips a
  missing or non-assistant translation target as `target_missing` or
  `target_not_assistant` without provider dispatch or message mutation, releasing
  the durable pin so reclaim can proceed. Tests cover explicit historical retry,
  queued historical finalization, once-only translation across restart, both
  invalid target shapes, and successful reclaim. The legacy migration,
  occupancy recovery, generation effects, generation chat, durable generation,
  generation operations, and migration foundation suites passed 306 tests;
  `pnpm check:server`, focused Prettier, and `git diff --check` passed. The new
  full-suite pass and fresh closure review remain required.
- Final second-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  55.1s, including frontend 9,347 passed/3 skipped, server 4,498 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh GPT 6 Astra High closure review; Phase 1 is
  not accepted until that review is clean.
- Third Phase 1 closure review: GPT 6 Astra High independently verified baseline
  `d03288053`, all 79 tracked diffs at SHA-256
  `10b75249f32efb66b9f3ba68de84425517bf2d7fe3cb4fe1fa2af310cb9b76d6`,
  and the 14-file untracked manifest SHA-256
  `a8759691a8805bc52b70732e57f78a7c129eac15da3e51dcf6735b63914eb2b2`.
  It independently passed the historical migration, occupancy recovery, and
  generation-effect suites, approved both latest translation repairs, and found
  no additional defect in earlier authority, heartbeat/publication, reclaim,
  shutdown-drain, or test-synchronization repairs. It did not approve Phase 1:
  in-memory production-helper probes confirmed that initial Hypa chunk planning
  drops modern operation/attempt/scope provenance and therefore consumes mutable
  live configuration, while a genuine migration-marked v39 retry persists a
  linked Hypa follow-up without scope that fails as
  `generation_job_lineage_missing` before provider dispatch. Focused fixes, a
  new full suite, and another fresh closure review are required.
- Third-closure Hypa repairs: initial chunk planning now carries the accepted
  operation ID, attempt, and scope. A deterministic pending unscoped planner job
  may be adopted only before its first attempt and only when it has no existing
  provenance; claimed, retried, or already scoped work keeps its original
  authority. Genuine v39 retry follow-ups keep historical live configuration
  only when the migration marker, current lineage, exact persisted job
  instance/chat/operation/attempt relations, and null modern authority/config
  columns all validate. Modern linked null-scope jobs fail closed. Self-review
  removed an initially over-narrow generation-state fence: like modern scoped
  jobs, this exact historical authority lasts until the memory job is terminal,
  including provider failure and later operation settlement. Tests prove
  immutable modern configuration after owner edits, safe planner-job adoption,
  no authority rewrite, malformed modern rejection before dispatch, genuine
  historical retry execution, and a `retryable/retryable_failed` parent whose
  queued memory job still completes. The relevant planner, assembly,
  summarize/embed, repository/worker, migration, occupancy-generation,
  generation-operation, and durable-generation suites passed; the final focused
  rerun included 179 tests. `pnpm check:server`, Prettier, and `git diff --check`
  passed. A new full suite and fresh closure review remain required.
- Final third-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  43.4s, including frontend 9,347 passed/3 skipped, server 4,501 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh GPT 6 Astra High closure review; Phase 1 is
  not accepted until that review is clean.
- Fourth Phase 1 closure review: GPT 6 Astra High independently verified
  baseline `d03288053`, all 81 tracked diffs at SHA-256
  `5db09d98419abc7e6769dcb00d2870d58e15bebbfa18312fab104374118f593e`,
  and the 14-file untracked manifest SHA-256
  `f215d56f4166e02c5161d511f1ac249bb11432b6e0718685ada9feaa5c3d286f`.
  It found the planner, historical job-lifetime, translation, reclaim, and
  earlier repairs sound, but did not approve Phase 1. A production `MemoryWorker`
  probe confirmed one P2: contextual Voyage embedding validates only its first
  job before dispatch, allowing a later same-operation/attempt job with missing
  scope to reuse the configuration cache and contribute invalid text to the
  provider batch before its publication fence fails. Every member must validate
  before provider dispatch, and a mixed valid/malformed batch regression is
  required before a new full suite and fresh closure review.
- Fourth-closure contextual-embedding repair: every drained job is now
  individually validated before contextual model selection and planning,
  configuration-cache hits retain a per-job authority fence, and surviving
  members are revalidated immediately before provider dispatch after any
  rate-limit wait. Invalid members are excluded from provider text and group
  identity, then settled independently without blocking valid siblings. A
  production `MemoryWorker` regression proves that a same-operation/attempt
  sibling with missing scope never reaches Voyage, terminally fails as
  `generation_job_lineage_missing`, and leaves its valid sibling to embed and
  complete; the direct handler also rejects it without another provider call.
  The embed, memory worker/repository/summarize, generation occupancy, durable
  generation, and legacy migration suites passed 214 tests; `pnpm
check:server`, Prettier, and `git diff --check` passed. A new full suite and
  fresh closure review remain required.
- Final fourth-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  49.3s, including frontend 9,347 passed/3 skipped, server 4,502 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh GPT 6 Astra High closure review; Phase 1 is
  not accepted until that review is clean.
- Fifth Phase 1 closure review: GPT 6 Astra High independently verified baseline
  `d03288053`, all 81 tracked diffs at SHA-256
  `d688137f993754ed90c0ba40eda3cb7734ae0a6d5615cd9674b54b27d498092e`,
  and the 14-file untracked manifest SHA-256
  `f215d56f4166e02c5161d511f1ac249bb11432b6e0718685ada9feaa5c3d286f`.
  It approved the contextual Voyage repair and found no masking in the inspected
  test synchronization, but did not approve Phase 1. Three production API
  probes confirmed P2 gaps: an inline legacy provider failure can persist its
  partial after another session claims the chat because queued finalization
  loses compatibility authority; inline legacy generated translation can
  publish after a foreign claim because its completion path lacks the same
  compatibility guard; and prompt preview can delete/plan Hypa rows in a
  foreign-occupied chat because preview assembly performs memory mutations
  without occupancy enforcement. Focused fixes, a new full suite, and another
  fresh closure review are required.
- Fifth-closure legacy/preview repairs: inline failed-partial finalization now
  persists its original compatibility lineage/session as a strict pair in the
  retry journal and transactionally revalidates it on immediate and recovered
  publication. Compatibility admission loss terminally rejects the journal;
  corrupt half-pairs and rows mixing compatibility with operation/scope
  authority fail closed. Inline generated translation uses the same
  compatibility fence at its transactional publication boundary. Both preview
  modes now consume a filtered in-memory Hypa snapshot while skipping orphan
  deletion, chunk/job planning writes, and follow-up enqueue. Production route
  regressions cover claim-during-provider failure, valid queued recovery,
  pinned and foreign-tuple retry behavior with no provider redispatch,
  claim-during-production translation plus its normal path, and all three
  standalone/chat preview variants across an embedding wait. The full
  generation-chat suite passed 194 tests; focused durable, finalization,
  migration, translation, and assembly suites passed 268 tests; compatibility
  structure passed 7 tests; `pnpm check:server`, Prettier, and `git diff
--check` passed. A new full suite and fresh closure review remain required.
- Final fifth-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 8m
  3.4s, including frontend 9,347 passed/3 skipped, server 4,512 passed/3 skipped,
  browser smoke 149/149, UI coverage, compatibility, typechecks, documentation,
  formatting, Realm scale, and performance gates. The exact source is frozen
  pending a fresh GPT 6 Astra High closure review; Phase 1 is not accepted until
  that review is clean.
- Sixth Phase 1 closure review: GPT 6 Astra High independently verified baseline
  `d03288053`, all 82 tracked diffs at SHA-256
  `3eab4a0eed7a9d195814eaee1c5cd158e1d2c0c5a22e3feeff5db97ca5c59338`,
  and the 14-file untracked manifest SHA-256
  `f215d56f4166e02c5161d511f1ac249bb11432b6e0718685ada9feaa5c3d286f`.
  It found no assertion masking and approved the fifth-closure repairs, but did
  not approve Phase 1. Two production API probes confirmed P2 gaps: real inline
  Hypa preparation can resume after a query-embedding wait and mutate cleanup,
  planning, and enqueue state after another session claims the chat; and the
  low-level job Stop route treats a migrated v39 operation with no generation
  scope as scoped, skips both control guards, and lets an unrelated reader abort
  it. Both paths need compatibility control fences and production regressions,
  followed by a new full suite and fresh closure review.
- Sixth-closure authority repairs: real inline Hypa preparation now revalidates
  the original compatibility or durable-operation authority after query
  embedding and holds one transaction across orphan cleanup, chunk planning,
  and follow-up enqueue; nested memory operations use savepoints and job
  notifications publish only after commit. A production race proves that a
  foreign claim acquired during embedding leaves every memory table unchanged,
  prevents provider dispatch and enqueue notification, while the normal path
  commits cleanup and work before notification. Low-level job Stop now applies
  the same scoped or historical control policy as operation cancellation,
  including database-lineage and genuine-v39 origin/current-owner checks.
  Migrated-retry tests prove both cancellation routes reject a foreign reader
  while preserving historical-origin and current-owner control. The complete
  generation-chat suite passed 196 tests, assembly/planner/repository suites
  passed 171 tests, the Stop/migration focused suites passed 290 tests, and
  `pnpm check:server`, Prettier, and `git diff --check` passed. A new full suite
  and fresh closure review remain required.
- First sixth-closure-repair full-gate attempt: 13 of 14 lanes passed, including
  frontend 9,347 passed/3 skipped and browser smoke 149/149. The server lane had
  4,515 passed/3 skipped and one timeout in the existing graceful-shutdown
  partial-persistence test. That exact test then passed alone, and its complete
  90-test file passed immediately afterward without a source change, identifying
  a load-sensitive test timeout rather than a reproduced product failure. The
  failed gate is not accepted; another complete passing run is required.
- Final sixth-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  52.3s, including frontend 9,347 passed/3 skipped, server 4,516 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh GPT 6 Astra High closure review; Phase 1 is
  not accepted until that review is clean.
- Seventh Phase 1 closure review: GPT 6 Astra High independently verified
  baseline `d03288053`, all 82 tracked diffs at SHA-256
  `11c0189969d1ec86fad869bdd8857828fe4d0ff909f1b8397b2c4ab18d2b17d8`,
  and the 14-file untracked manifest SHA-256
  `acb07b7b48ae1c29a562852132ec905f975472b398f6461ff86b6be783e01771`.
  It approved the sixth-closure Hypa transaction and v39 Stop policy and found
  no additional defect in earlier Voyage, finalization, translation, preview,
  provenance, reclaim, or effect repairs, but did not approve Phase 1. A real
  authenticated production-store probe confirmed one P2: the low-level Stop
  route substitutes a modern compatibility operation's creator session when
  the request omits `risu-writer-session`, so an unrelated authenticated reader
  can cancel the job despite being rejected when it supplies its real session.
  The route must require actual request identity whenever durable ownership
  exists, with omission and legitimate-controller regressions, then a new full
  suite and fresh closure review.
- Seventh-closure Stop repair: low-level Stop no longer derives caller identity
  from the target operation or runtime job. An existing durable owner makes the
  request session header mandatory; the only headerless compatibility path is
  an ownerless database with a `legacy_owner` operation or operationless legacy
  job, using the fixed pre-writer `legacy` identity and the normal admission
  checks. Production regressions cover omitted and explicit foreign identities,
  current-owner and historical-origin control, migrated-v39 operations, and the
  bounded ownerless fallback. The focused generation-chat, durable-generation,
  and migration suites passed 293 tests; `pnpm check:server`, Prettier, and `git
diff --check` passed. A new full suite and fresh closure review remain
  required.
- Final seventh-closure-repair Phase 1 `pnpm test:all`: passed all 14 lanes in 7m
  33.3s, including frontend 9,347 passed/3 skipped, server 4,517 passed/3
  skipped, browser smoke 149/149, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh GPT 6 Astra High closure review; Phase 1 is
  not accepted until that review is clean.
- Eighth Phase 1 closure review: GPT 6 Astra High independently verified baseline
  `d03288053`, all 82 tracked diffs at SHA-256
  `921df4d4c238052bf73c35da89898e7b6578fe8d514b20a8e3250bbb42ec11f6`,
  and the 14-file untracked manifest SHA-256
  `d1fc0aa2ad56dec0a8c3a4ab06decf9c1ffa6ad707173dda1ee9443a432baaf5`.
  It inspected the complete planning package and frozen implementation, ran 285
  focused server tests, and approved Phase 1 with no actionable defect. It
  explicitly approved the request-identity Stop repair, both cancellation
  policies, inline Hypa atomicity, contextual Voyage member validation, and all
  earlier compatibility, provenance, finalization, translation, preview,
  reclaim, pinning, effect, and shutdown repairs. Evidence does not claim Phase
  2 browser interaction, physical-device behavior, external provider behavior,
  or release readiness. Phase 1 is accepted; rollout remains disabled.
- Phase 2 implementation: the client now owns a dedicated occupancy coordinator
  and transport, independent of general write capability, with bootstrap and
  revision-free SSE snapshots, exact session/lineage/epoch authority, Web Lock
  admission, 30-second renewal, claim/release/switch/normalization, and stale
  async-callback fencing. Reader UI exposes localized available, foreign,
  self-owned, pending, switch-required, and unsupported states. Self-owned
  chats provide Send, the required latest-response Reroll, and Stop on desktop
  and mobile; Continue, general Regenerate, editor, upload/drop, hook, plugin,
  and general mutation controls remain unavailable. Navigation-only drafts are
  isolated in session storage by lineage/session/chat and survive observation
  and refresh without entering general writer recovery.
- Phase 2 send/effect containment: generation-only durable intents use a
  separate isolated occupancy-scoped staging/replay path. Send context consumes
  authoritative configured settings while skipping character
  `lastInteraction`, owner editor flushes, general message repair, inlay upload,
  plugin runtime, and owner maintenance. Submission, revision retry, stream,
  terminal reconciliation, and Stop retain the captured authority; demoted
  owner-class claims cannot admit fresh work, while accepted work can settle.
  Blank IGP in immutable accepted configuration is terminally skipped as
  `skipped:not_configured`, configured IGP remains pending for its permitted exact
  message effect, and owner behavior is unchanged. Client/core/UI/send focused
  validation passed 351, 518, and 104 tests respectively; the server IGP slice
  passed 117 focused tests; client and server checks, Prettier, and diff checks
  passed.
- Phase 2 real-session browser proof: a new opt-in harness keeps production
  rollout disabled by default. Two repeated Chromium runs passed 4/4 tests
  using four distinct BrowserContexts (owner, emulated Pixel 7 chat-only,
  desktop chat-only, and observer) against real Fastify and SQLite. Evidence
  covers T01/T02/T03/T04/T08/T11: different-chat parallel operations with exact
  operation/session/epoch/claim-class and message IDs; one provider dispatch per
  operation; atomic same-chat claim exclusion; owner/loser edit, Send, and Stop
  rejection; byte-stable settings, characters including `lastInteraction`,
  modules, plugins, and storage; observer refresh/navigation/draft retention
  with no claim/Stop/effect requests; explicit cross-chat Switch; owner
  promotion/demotion independence; and desktop/mobile Send, Reroll, and Stop.
  This evidence uses controlled providers and Chromium emulation; it does not
  claim physical-device, browser-suspension, external-provider, restart, or
  configured-IGP recovery coverage assigned to later phases.
- First Phase 2 full-gate attempt: 13 of 14 lanes passed. Frontend passed 9,431
  tests/3 skipped, server passed 4,518 tests/3 skipped, and the new 4-test
  occupancy browser proof passed. Browser smoke otherwise exposed six shared
  reader compatibility regressions: five existing observer-generation journeys
  saw a disabled Stop node, and the unreleased reader composer's deferred row
  reduced one mobile waifu transcript below its established minimum height.
  The gate was not accepted. Stop now renders only for exact self-owned
  occupancy (including retained disabled-rollout work), and unsupported,
  disabled, or identity-unavailable readers omit only the extra deferred row;
  enabled chat-only states retain their full explicit controls. Focused reruns
  passed all five generation journeys, the mobile read-only journey, and 52
  component tests.
- Final Phase 2 `pnpm test:all`: passed all 14 lanes in 7m47.4s, including
  frontend 9,432 passed/3 skipped, server 4,518 passed/3 skipped, browser smoke
  151/151, UI coverage, compatibility, typechecks, documentation, formatting,
  Realm scale, and performance gates. The exact source is frozen pending a
  fresh GPT 6 Astra High closure review; Phase 2 is not accepted until that
  review is clean.
- First Phase 2 closure review: GPT 6 Astra High independently matched baseline
  `8a11e00e2`, all 41 tracked diffs at SHA-256
  `5aaf2f0e653e5c6bd5ad854cb517cab8d9aa9343f6d54cf7d464beeb34484842`,
  and the 8-file untracked manifest SHA-256
  `de629ee7bc97f84bd2898e5e5c9587af40ba45e86000ec2383bdbee58c9e8458`.
  It inspected all Phase 2 changes, passed 403 focused tests, and found no
  assertion masking or additional Phase 2 defect, but did not approve the
  phase. A real built-browser/Fastify probe confirmed one P2: transport-uncertain
  Send remained durably staged while the reader showed stale claim feedback and
  re-enabled the same Send, because the coordinator collapsed `retained` into
  generic generation failure and the UI handled only definitive append failure.
- Retained-Send repair: the coordinator now returns a distinct `send_retained`
  outcome with the frozen operation and accepted-message identities plus the
  transport error/code, without firing accepted or failed callbacks. The reader
  preserves the draft, shows localized queued/uncertain feedback, refreshes
  observation, and disables Send/Reroll while the exact unchanged draft and
  occupancy authority remain retained; editing establishes an explicit fresh
  intent rather than reusing the old identity. Coordinator, rendered-reader,
  and composer suites passed 81 tests; `pnpm check`, Prettier, and `git
  diff --check` passed. Phase 3 retains responsibility for full
  lost-response/reload/expiry reconciliation.
- Post-review-repair Phase 2 `pnpm test:all`: passed all 14 lanes in 7m35.3s,
  including frontend 9,434 passed/3 skipped, server 4,518 passed/3 skipped,
  browser smoke 151/151, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh closure review.
- Second Phase 2 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `8a11e00e2`, the 41-path tracked diff SHA-256
  `a7a055227fd2b4b55b0f2193a152ff2bbfbeb7519336df3d4c55be45439df75c`,
  and the unchanged 8-file untracked manifest. It passed 426 focused tests and
  approved the retained-result identity, callbacks, draft preservation,
  observation refresh, exact-intent resubmission guard, owner compatibility,
  and browser proof quality, but did not approve Phase 2. One P2 wording defect
  remained: all locale packs described a lost-response Send or Reroll as
  definitely unaccepted even though the server may already have committed it.
- Retained-outcome wording repair: all seven locale packs now say that the
  request remains on the device and server acceptance is unconfirmed. An
  English regression forbids the earlier definitive nonacceptance wording.
  Runtime identity, staging, and admission behavior are unchanged.
- Final retained-outcome Phase 2 `pnpm test:all`: passed all 14 lanes in 7m39.9s,
  including frontend 9,435 passed/3 skipped, server 4,518 passed/3 skipped,
  browser smoke 151/151, UI coverage, compatibility, typechecks,
  documentation, formatting, Realm scale, and performance gates. The exact
  source is frozen pending a fresh closure review.
- Final Phase 2 closure review: a third fresh GPT 6 Astra High reviewer
  independently matched baseline `8a11e00e2`, all 41 tracked paths at SHA-256
  `be2300beda2401a19781f1da014ee1a2dbe4471df89dd76d2bdeb327622d59d4`,
  and the unchanged 8-file untracked manifest SHA-256
  `de629ee7bc97f84bd2898e5e5c9587af40ba45e86000ec2383bdbee58c9e8458`.
  It passed 450 focused tests across 10 suites, found no assertion masking or
  actionable Phase 2 defect, and accepted the phase. It specifically approved
  the retained-outcome language, frozen operation/message identity, draft
  preservation, exact-intent resubmission guard, scoped staging/admission,
  observer UI, accepted-work compatibility, and browser evidence. Phase 3 still
  owns role-change/reload Stop recovery, uncertain-intent reconciliation, and
  configured IGP completion; production rollout remains disabled.

## Status Update Contract

After each bounded slice, update the next action and record changed boundaries,
source identity, focused evidence, failures, and unresolved work. At phase
acceptance add full-suite results, reviewer identity/reference, each finding's
resolution, evidence limits, and phase commit/handoff reference. A discovered
blocker changes the cursor; it never changes a failed check into a pass.
