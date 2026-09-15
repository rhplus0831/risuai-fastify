# Chat Occupancy Status

Updated: 2026-09-15.

## Execution Cursor

- State: Phases 0 through 2 are accepted and committed. Phase 3 recovery and
  completion is accepted and awaiting its completion commit. The feature
  remains disabled until Phase 4.
- Planning source: `3c8f5aee1a48fcf35d1611323929f8197c142b6b`.
- Phase 0 baseline: `ec5765f4f`; the only drift from the planning source is the
  planning package itself. Runtime source remains the inspected baseline.
- Current work: Phase 3 has closed scoped recovery, lifecycle, and completion-
  effect behavior on top of the accepted server and chat-only interaction
  foundations. New chat-only claims remain disabled in production until the
  Phase 4 release boundary.
- Phase 0 commit: `d03288053` (`docs: freeze chat occupancy contract`).
- Phase 1 commit: `8a11e00e2` (`feat: enforce server chat occupancy`).
- Phase 2 commit: `bf32c875f` (`feat: add chat-only occupancy interaction`).
- Next action: commit the accepted Phase 3 boundary, record its revision, then
  begin Phase 4 integrated verification, coherent rollout, current
  documentation, and archival.

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
- **2 — Chat-only interaction:** accepted and committed in `bf32c875f`.
- **3 — Recovery and completion:** accepted at baseline `bf32c875f`; completion
  commit pending.
- **4 — Integrated verification and release:** pending the Phase 3 completion
  commit.

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
- Phase 3 scoped client recovery: chat-occupancy staging now reconciles stored
  Send, Reroll, and Stop identity against server operation truth before any
  replay and remains independent of general-owner readiness. Startup,
  reconnect, and occupancy changes validate lineage, chat, originating session,
  epoch, and interaction; accepted work and exact Stop tombstones settle,
  ambiguous or mismatched work stays dormant, and expired proven-unaccepted
  intent becomes `requires_resubmission` without transplanting its token or
  overwriting a newer draft/projection. Reload restores exact accepted Stop
  control, observers gain no authority, and browser effects recover through the
  stored operation scope rather than general plugin/write access. Eleven client
  suites passed 770 tests; `pnpm check` reports zero errors and warnings.
- Phase 3 lifecycle/restart recovery: compatibility admission now rejects every
  live occupancy and reconciles then atomically retires an expired row before
  unoccupied legacy admission. Expiry, same-session reacquisition, cross-chat
  normalization, delayed controls, and release/claim serialization preserve
  monotonically fenced epochs. Stop-before-submit carries the exact target and
  Send/Reroll scope, persists a scoped cancellation tombstone, and prevents a
  delayed old submit from appending after release or handoff. Restart recovery
  verifies result role, chat, alternate, attempt, job, and generation identity;
  database replacement terminally quarantines old-lineage operations,
  finalizations, effects, and memory/BardWiki jobs while preserving only exact
  committed data. Malformed journals are isolated and terminalized without
  blocking valid rows. Ten server lifecycle/recovery suites passed 231 tests;
  both client and server checks pass.
- Phase 3 completion ownership: a dedicated exact-scope atomic IGP commit route
  binds the authenticated originating session and claimed effect to its stored
  operation, attempt, chat, assistant message, accepted authority, and expected
  message generation. Transcript mutation, receipt, revision, and event commit
  together; a lost identical response replays its original result, while the
  generic receipt route cannot falsely complete a claimed IGP. Startup and
  restore reconciliation classify all seven effect dispositions, including
  partial pre-ledger state. Generated translation drains through downstream
  settlement and immutable accepted configuration; unsupported plugin/emotion
  work and invalid targets settle terminally without later owner replay.
  Focused IGP, effect, completion, durable-generation, translation,
  finalization, bootstrap, backup, migration, memory, BardWiki, protection, and
  server-backed Send suites pass, including durable generation 96/96 and IGP
  commit 37/37.
- Phase 3 real-session fault proof: the opt-in Chromium/Fastify/SQLite suite now
  passes 7/7 journeys covering T05-T08/T10. It exercises duplicate-tab
  isolation; deterministic freeze/offline expiry; same-session new-epoch
  reacquisition; stale renew/release; simultaneous release/claim; auth loss;
  lost Send and Stop responses across reload; no provider redispatch; newer
  draft preservation; role transfer; pinned handoff; destructive-import
  rejection; accepted result persistence after the sender disappears;
  configured IGP lost-receipt replay and duplicate-receipt idempotency; terminal
  unsupported effects; actual same-port Fastify restart; abandoned-attempt
  recovery; and lineage rotation. The evidence uses Chromium lifecycle
  emulation, graceful restart, and deterministic local providers rather than
  physical process eviction, kill-9, or external providers.
- First Phase 3 `pnpm test:all`: completed all 14 lanes in 7m43.3s. Eleven lanes
  passed, including typechecks, documentation, compatibility, build, UI
  coverage, formatting, scale, and performance. Frontend passed 9,346 tests/3
  skipped but two complete module mocks omitted the new recovery-handler export.
  Server passed 4,541 tests/3 skipped with seven failures: the new IGP mutation
  path was absent from the exact command-budget registry, five compatibility
  failed-partial/stale-assembly cases exposed recovery/admission integration
  regressions, and startup misclassified a persisted exact result as abandoned.
  Browser smoke passed 155/156; the original containment journey still treated
  all effect traffic as forbidden even though Phase 3 now deliberately recovers
  exact scoped effects. These are gate failures, not accepted evidence. Repairs
  must preserve the new recovery contract, update exact inventories/audits, and
  pass focused regressions before a complete rerun.
- Phase 3 full-gate repairs: the two complete client mocks now register the
  recovery callback and their 103 tests pass. Accepted compatibility writes use
  a dedicated transaction boundary that ignores only their own accepted-work
  pins while still fencing lineage, owner changes, and every intervening live or
  expired occupancy; assembly, failed-partial/finalization recovery, and
  generated translation use it. The persisted-result startup fixture now carries
  the exact modern attempt/job/generation identity required by production
  reconciliation. Twelve server suites pass 430 tests, including the full
  197-test generation-chat/startup slice. The IGP commit path has an explicit
  mutation-budget gate limited to its effect/message and optional
  transcript-derived invalidation tables, with an integration assertion for the
  exact emitted event and writes; its three owner suites pass 62 tests. Finally,
  the browser containment audit now accepts only effect calls whose route,
  method, body, claim, operation/chat/result identity, originating
  session/lineage, response status, and terminal ledger disposition all match;
  unknown effect routes and general/shared mutations remain failures. The full
  seven-journey browser file passes in 33.0s. Both typechecks, Prettier, and diff
  checks pass; a new complete gate remains required.
- Second Phase 3 `pnpm test:all`: completed all 14 lanes in 7m41.3s. Thirteen
  lanes passed, including frontend 9,449 tests/3 skipped and server 4,550
  tests/3 skipped. Browser smoke passed 155/156, including all seven Phase 3
  fault journeys. The sole failure was an existing hidden-mobile writer
  recovery journey that observed one character-lorebook resource request where
  an unchanged reconnect must only revalidate ownership and restart SSE. This
  may indicate a scoped-recovery startup integration regression; the gate
  remains failed pending root-cause repair, focused repetition, and a complete
  rerun.
- Hidden-mobile recovery investigation: the request was an auth-only,
  unchanged-revision cache-negotiated read from initial fire-and-forget lorebook
  hydration, not occupancy recovery or a mutation. Under full-gate load it could
  reach the network after the test began measuring replacement-recovery traffic.
  A smoke-only read signal now lets the journey prove the initial character
  shell and lorebook ownership mark have settled before measurement; the strict
  no-refresh reconnect assertion remains unchanged. The hidden-replacement case
  passed 12/12 with four workers, the full mobile recovery file passed 3/3, and
  368 relevant client tests plus both typechecks, smoke build, Prettier, and diff
  checks pass. Production startup/hydration behavior is unchanged. A complete
  gate rerun remains required.
- Final Phase 3 `pnpm test:all`: passed all 14 lanes in 7m46.4s, including
  frontend 9,449 tests/3 skipped, server 4,550 tests/3 skipped, browser smoke
  156/156, client and server typechecks, documentation, compatibility, smoke
  build, UI coverage, formatting, Realm scale, and performance gates. The exact
  passing source is frozen pending a fresh independent GPT 6 Astra High closure
  review; Phase 3 is not accepted until that review is clean.
- First Phase 3 closure review: GPT 6 Astra High independently matched baseline
  `bf32c875f`, all 59 tracked diffs at SHA-256
  `ff65c3ad5b398cd681a2b8f8130fb1604bd97dae38a36446c6332bdd7e69dbb9`,
  and the one-file untracked manifest SHA-256
  `6306cb93ed9a796af4d6ad96173c12beaf038d4cc52c003ce7316e53c1cb1fa5`.
  It inspected every change and rejected the phase with five P2 findings that
  the passing gate did not cover: configured IGP still traversed the general
  writer-only provider request gate; Stop lost before server receipt remained
  staged when its operation was running; owner-to-chat-only normalization
  invalidated recovery by comparing claim class rather than the unchanged
  four-part tuple; live and recovered IGP consumed mutable current settings
  instead of the accepted snapshot; and accepted compatibility publication
  became authorized again after an intervening foreign claim was released.
  Read-only source probes confirmed the first three findings, and an in-memory
  SQLite probe confirmed the compatibility fence hole. Production rollout
  remains disabled while all five are repaired and revalidated.
- First-review Phase 3 repairs: exact occupied Stop replay now redispatches a
  current staged cancellation when status still reports cancellable accepted
  work, while stale epochs and mismatched origins remain dormant. Accepted
  occupancy recovery compares the authoritative lineage/chat/session/epoch
  tuple across owner-to-chat-only normalization and keeps claim class solely as
  immutable admission provenance. Compatibility admission now captures the
  current occupancy epoch; assembly, finalization, failed-partial recovery, and
  generated translation revalidate it, queued journals persist it through
  migration and backup, and older incomplete rows fail closed. Configured IGP
  now executes through an exact claimed-effect provider endpoint that reads the
  accepted operation prompt, profile, credentials, and generation settings,
  grants no general write authority, and leaves the exact-message mutation to
  the atomic commit endpoint. Live and recovered client paths no longer use
  mutable current IGP configuration for occupied work. Completed projections
  that intentionally omit `currentAttempt` validate IGP against the persisted
  terminal message's exact lineage, operation, positive attempt,
  job/generation, result, and ledger identities. Focused client suites pass
  generation operations 59/59, recovered effects 19/19, IGP 12/12, and effect
  ledger 26/26; focused server suites pass generation chat 197/197, occupancy
  scope 11/11, generation effects 16/16, finalization retry 8/8, migration 6/6,
  and backups 56/56. Client and server checks and the reviewed cross-runtime
  inventory pass.
- Strengthened first-review browser proof: the real Chromium/Fastify/SQLite
  interaction file passes 8/8. A new pre-server Stop fault proves that the
  aborted first transport leaves the provider running and one encrypted exact
  outbox row; reload sends exactly one successful cancellation, drains the
  outbox, aborts the provider once, and preserves the newer draft and persisted
  transcript. The configured IGP journey now uses the production claim,
  accepted-snapshot provider execution, atomic commit, and receipt paths rather
  than fabricated output. It holds the claim while the owner clears the current
  provider output setting, loses commit and receipt responses after persistence,
  reloads, and proves one exact operation/claim/generation/message execution,
  accepted output, no draft loss, and no unrelated shared write. Existing
  post-server lost-Stop evidence remains. Browser evidence still uses Chromium
  emulation and deterministic local providers; `igpPrompt` itself is read-only
  in targeted settings, so mutable snapshot proof changes the provider output
  setting instead.
- Post-review Phase 3 `pnpm test:all`: completed all 14 lanes in 7m56.9s.
  Twelve lanes passed, including frontend 9,456 tests/3 skipped, browser smoke
  157/157, both typechecks, documentation, compatibility, build, UI coverage,
  Realm scale, and performance. The server lane passed 4,552 tests/3 skipped
  but its closed SQLite schema inventory rejected the newly reviewed
  `generation_finalization_retries.compatibility_occupancy_epoch` column because
  the pinned digest was not advanced. The format lane found two unformatted
  files from the repair. The schema digest now records the exact new column,
  its focused seven-test ownership suite passes, and both files were formatted;
  the complete format check passes. The gate remains failed and cannot support
  acceptance until a full rerun succeeds.
- Final post-review Phase 3 `pnpm test:all`: passed all 14 lanes in 7m46.7s,
  including frontend 9,456 passed/3 skipped, server 4,553 passed/3 skipped,
  browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The exact repaired source is frozen pending a fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Second Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 69 tracked diffs at SHA-256
  `1ee72bdcbda0ee018677abfba9278486da9af0ee543755b8b168fcb4a28d58fc`,
  and the one-file untracked manifest SHA-256
  `dfb196157de0393ff0dea218b6591f95991c1f4c534b1214f63e77c5b2ed8c7a`.
  It confirmed the prior five repairs and found no assertion masking, but
  rejected the phase with one P2: the claimed IGP provider endpoint expanded
  `{{lastmessage}}`, `{{lastcharmessage}}`, and history against the accepted
  pre-generation database snapshot, so a post-generation hook could consume the
  user input or previous assistant instead of the exact assistant result it was
  extending. A production-parser probe confirmed the difference. Accepted
  settings, definition, profile, and provider configuration must remain frozen,
  while prompt expansion receives an operation-bound terminal transcript with
  correct Reroll treatment. Live and recovered provider-input assertions are
  required before a complete gate rerun and fresh closure review. Production
  rollout remains disabled.
- Second-review IGP repair: claimed provider execution now overlays only an
  exact operation-bound terminal transcript onto the immutable accepted
  configuration before prompt expansion. Send proves the accepted transcript
  plus one exact terminal assistant; Reroll proves the same accepted identities
  with its exact assistant target replaced. Both retain lineage, attempt, job,
  generation, ledger, result-message, and occupancy fences. Server provider-input
  regressions cover live Send and recovered Reroll and pass 17/17. The production
  Chromium journey now sends a dynamic `{{lastmessage}}`/
  `{{lastcharmessage}}` prompt through a deterministic OpenAI-compatible
  provider, proves both resolve to the generated assistant while the accepted
  model/profile/credential survive owner clearing, excludes the accepted user
  and prior assistant from the body, and retains the lost commit/receipt reload
  and exactly-once evidence. Its focused journey passes 1/1; server typechecks,
  smoke build, Prettier, and diff checks pass. A complete gate rerun remains
  required before another closure review.
- Final second-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m57.4s, including frontend 9,456 passed/3 skipped, server 4,554 passed/3
  skipped, browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The exact source is frozen pending a third fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Third Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 69 tracked diffs at SHA-256
  `f2730e84a66dc55878db37699499f73fd615e383c40739c0455c81b1a3b12b0e`,
  and the unchanged one-file untracked manifest SHA-256
  `dfb196157de0393ff0dea218b6591f95991c1f4c534b1214f63e77c5b2ed8c7a`.
  It confirmed all earlier repairs and found no additional assertion masking,
  but rejected the phase with one P2 interaction: terminal IGP binding required
  the accepted pre-assembly IDs plus exactly one assistant, while permitted
  server `onInput`/`addChat` transforms can insert scoped transcript rows after
  acceptance and before the terminal result. Production assembly and extracted
  binding probes proved that otherwise exact configured IGP was then rejected
  as `generation_effect_target_stale`. Binding must use the operation's
  authorized post-assembly transcript rather than arbitrary current history,
  while retaining immutable accepted configuration and exact terminal,
  occupancy, attempt, job, generation, ledger, and result fences. Combined live
  and recovered trigger-plus-IGP provider-input regressions are required before
  a complete gate rerun and fresh closure review. Production rollout remains
  disabled.
- Third-review IGP repair: effect creation now atomically persists a SHA-256
  fingerprint of the exact authorized post-assembly terminal active transcript.
  Claimed IGP provider execution overlays a terminal transcript only when it
  matches that fingerprint and the existing occupancy, operation, attempt, job,
  generation, ledger, result-message, and Send/Reroll target fences; it no
  longer assumes that the accepted snapshot IDs remain an unchanged prefix.
  Legitimate trigger-injected rows therefore survive while later unrelated
  transcript mutation fails before provider dispatch. Server provider-input
  regressions cover live transformed Send, recovered Reroll, immutable accepted
  configuration, and stale-transcript rejection; effect 18/18, database 33/33,
  and backup 56/56 suites pass. The real Chromium IGP journey now runs an
  accepted `onInput` Lua `addChat` transform, proves the exact four-row SQLite
  transcript and generated-assistant macro/index provider input, excludes the
  accepted user, prior assistant, and inserted row from that provider input,
  and retains owner-setting clearing plus lost commit/receipt reload and
  exactly-once evidence. Its focused journey passes 1/1; server typechecks,
  smoke build, Prettier, and diff checks pass. A complete gate rerun remains
  required before another closure review.
- First third-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m00.0s. Thirteen lanes passed, including frontend 9,456 passed/3 skipped,
  browser smoke 157/157, both typechecks, documentation, compatibility, smoke
  build, UI coverage, formatting, Realm scale, and performance. The server lane
  passed 4,554 functional tests/3 skipped but its closed SQLite schema inventory
  rejected the new `generation_effects.terminal_transcript_fingerprint` column
  because the pinned digest still named the pre-column shape. The digest now
  records the exact emitted schema. This gate remains failed; focused schema
  verification and a complete rerun are required.
- Second third-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  7m51.8s after the schema digest's focused 7/7 pass. Thirteen lanes passed,
  including frontend 9,456 passed/3 skipped, browser smoke 157/157, both
  typechecks, documentation, compatibility, smoke build, UI coverage,
  formatting, Realm scale, and performance. The server lane passed 4,554
  tests/3 skipped but the existing durable-generation case that waits for an
  acknowledged stopping runner to persist its partial before graceful shutdown
  reached its 15-second timeout under full-suite load. This is a gate failure;
  the exact case must pass focused repetition and any real regression must be
  repaired before another complete rerun.
- Graceful-stop timeout follow-up: the exact timed-out case passed five
  consecutive isolated executions, then the complete durable-generation file
  passed 96/96 in 13.64s. The IGP fingerprint path is not exercised by that
  shutdown case, and no reproducible source defect was found. The failed gate
  remains recorded; a complete rerun is still required.
- Final third-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m54.9s, including frontend 9,456 passed/3 skipped, server 4,555 passed/3
  skipped, browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The exact source is frozen pending a fourth fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Fourth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 69 tracked diffs at SHA-256
  `968033f9de8ab84906c5a4bf34d28299fb205b145e7d825486f4fa416029e096`,
  and the unchanged one-file untracked manifest SHA-256
  `dfb196157de0393ff0dea218b6591f95991c1f4c534b1214f63e77c5b2ed8c7a`.
  It confirmed all earlier repairs and found no additional assertion masking,
  but rejected the phase with one P2 composition defect: the exact
  post-assembly fingerprint hashed the full terminal message JSON, while the
  authorized server-generated translation path can persist only the
  `translation` metadata after ledger creation and before live or recovered IGP
  execution. A production-helper probe proved that this valid update changed
  the binding from true to false and caused `generation_effect_target_stale`.
  The canonical binding must permit only explicitly authorized generated
  translation metadata while retaining rejection of text, order, role,
  identity, alternate, disabled, generation, operation, attempt, job, ledger,
  occupancy, and unrelated JSON changes. Combined live Send and recovered
  Reroll translation-plus-IGP provider, result, and receipt regressions are
  required before a complete gate rerun and fresh closure review. Production
  rollout remains disabled.
- Fourth-review IGP repair: the canonical transcript fingerprint retains exact
  active order/full JSON and durable Reroll alternates, but permits the terminal
  target's translation only when its SHA-256 exactly matches the same
  operation/attempt/scope's `generated_translation` ledger row settled as
  `completed/server`. Changed, removed, other-message, unreceipted translation
  and every unrelated transcript/identity/alternate change remain stale.
  Server regressions cover live Send and recovered Reroll through translation
  receipt, IGP provider input, atomic commit, and completed acknowledgement, plus
  the negative mutation matrix; effect 19/19, database 33/33, and backup 56/56
  suites pass. The real Chromium journey now runs accepted generated translation
  before the transformed configured IGP, proves exact SQLite translation metadata
  and exact server ledger identity, preserves raw generated-assistant macros,
  excludes translated/user/prior/trigger-row text, proves atomic IGP clears the
  stale translation, and retains lost commit/receipt reload exactly-once
  evidence. It passed twice; latest 1/1. Server typechecks, smoke build, Prettier,
  and diff checks pass. A complete gate rerun remains required before another
  closure review.
- First fourth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  7m56.1s. Thirteen lanes passed, including frontend 9,456 passed/3 skipped,
  browser smoke 157/157, both typechecks, documentation, compatibility, smoke
  build, UI coverage, formatting, Realm scale, and performance. The server lane
  passed 4,555 functional tests/3 skipped but its closed SQLite schema inventory
  rejected the new generated-translation receipt metadata column because the
  pinned digest still named the earlier fingerprint schema. The digest now
  records the exact emitted schema. This gate remains failed; focused schema
  verification and a complete rerun are required.
- Final fourth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m58.5s, including frontend 9,456 passed/3 skipped, server 4,556 passed/3
  skipped, browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The exact repaired source is frozen pending a fifth fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Fifth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 69 tracked diffs at SHA-256
  `2cdabe654d051216f9bb15e9c97efa7aa8d1086cb7d110880182f8762b2095ee`,
  and the sole untracked file at SHA-256
  `b0b3ccb2fbdabc06583f3e595fa7ca39f72ec198499950e6c2159ab3ce45219e`
  with sorted content-manifest SHA-256
  `6306cb93ed9a796af4d6ad96173c12beaf038d4cc52c003ce7316e53c1cb1fa5`.
  It rejected the phase with two P2 findings proven through read-only production
  Fastify/SQLite probes. First, terminal IGP binding incorrectly equated a
  Reroll's displaced accepted assistant/`targetMessageId` with the distinct new
  generation result/effect message ID; the existing recovered fixture reused
  one ID and masked the real lifecycle. Second, the binding admitted only Send
  and Reroll, so exact `owner_occupancy` Continue effects were rejected as stale
  with zero provider dispatch. Binding must independently fence Reroll's old
  target and new result, and must cover both supported owner Continue result
  dispositions without enabling chat-only Continue. Live and recovered
  production-lifecycle provider-input, result, commit, and receipt regressions
  are required before a complete gate rerun and fresh closure review. Production
  rollout remains disabled.
- Fifth-review IGP repair: Reroll now binds the immutable accepted displaced
  assistant to `operation.targetMessageId`, requires that old target to differ
  from the new result/effect message ID, and independently verifies the terminal
  result. Exact `owner_occupancy` Continue is now supported without admitting
  chat-only Continue: extend requires operation target/result/effect identity to
  be the preserved assistant and self-verifies accepted-operation authority
  before allowing its retained metadata, while append requires the accepted
  assistant exactly once before the fresh terminal result. The masked unit
  Reroll fixture now uses the production message replacement helper with
  distinct IDs. Four real-listener cases exercise live and restart-recovered
  Reroll plus both Continue dispositions through actual acceptance/finalization,
  server-generated translation where applicable, accepted IGP profile/key/model
  and dynamic terminal input, atomic message commit, translation clearing, and
  idempotent receipt. The complete effect and durable-generation files pass
  119/119; server typechecks, focused Prettier, and diff checks pass. A complete
  gate rerun remains required before another closure review. One attempted
  direct root Vitest invocation selected only the frontend project and exited
  because both server paths were excluded; the repository focused-test wrapper
  then selected the server project correctly and independently passed 19/19 and
  100/100.
- Final fifth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m47.5s, including frontend 9,456 passed/3 skipped, server 4,560 passed/3
  skipped, browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The exact repaired source is frozen pending a sixth fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Sixth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 69 tracked diffs at SHA-256
  `bc31803ad26628eefe2f974a8aeed7f36d2b1e4bd8737abd388975cab2aef368`,
  and the unchanged sole untracked file/content-manifest identities. It
  confirmed the fifth-review server repairs and every earlier repair, but
  rejected the phase with one P2: the live and recovered browser IGP paths still
  required a Continue-extend assistant's `generationInfo` to name the current
  effect generation, although production correctly preserves the accepted
  assistant ID and its prior generation metadata. A read-only production-function
  probe made live origin validation false and recovered generation resolution
  undefined; the current client IGP suite still passed 12/12, demonstrating its
  coverage gap. The browser must carry exact Continue-extend
  operation/result/effect authority through resolution, evaluation, and commit
  without weakening its other fences. Live and reload/recovered client
  regressions for both Continue dispositions are required. Production rollout
  remains disabled.
- Sixth-review client IGP repair: the browser now carries a fail-closed typed
  Continue-extend authority across live terminal target construction, reload
  recovery resolution, IGP evaluation, atomic commit, and local application.
  It binds protocol v1, exact completed operation, operation attempt, job,
  preserved target/result/effect message identity, `owner_occupancy` scope, and
  an exact snapshot of the assistant's retained prior `generationInfo`.
  Continue append, Send, and Reroll retain their normal fresh-generation fence;
  forged chat-only Continue remains rejected before transport. Bootstrap now
  preserves pending-effect `operationAttemptNo`. Real production-function
  regressions cover live/recovered Continue extend and append, completed
  projections with and without `currentAttempt`, provider result, atomic commit,
  receipt acknowledgement, local data application, and retained metadata.
  Focused suites pass 17/17 IGP, 21/21 recovered effects, 36/36 terminal target,
  47/47 bootstrap, and 27/27 route-backed Send. Client and server checks,
  Prettier, and diff checks pass. One initial invalid focused-test alias and one
  test-reference/mock-environment error were corrected before these passes. A
  complete gate rerun remains required before another closure review.
- First sixth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m16.1s. Thirteen lanes passed, including frontend 9,456 passed/3 skipped,
  browser smoke 157/157, both typechecks, documentation, compatibility, smoke
  build, UI coverage, formatting, Realm scale, and performance. The server lane
  passed 4,559 tests/3 skipped, but the existing durable-generation case waiting
  for an acknowledged stopping runner to persist its partial before graceful
  shutdown again reached its 15-second timeout under full-suite load. This is a
  gate failure; the exact case and complete file must pass focused repetition,
  and any reproducible defect must be repaired before a full rerun.
- Graceful-stop timeout follow-up: the exact case passed five consecutive
  isolated executions in 3.66–4.02s, then the complete durable-generation file
  passed 100/100 in 14.09s. The repaired browser Continue authority is not
  exercised by this shutdown timing case, and no reproducible source defect was
  found. The failed gate remains recorded; a complete rerun is still required.
- Second sixth-review-repair Phase 3 `pnpm test:all`: the graceful-stop case
  cleared, but the server lane reported a native backup-copy cancellation as
  system error `-122`; the following Realm scale lane returned 500 and the
  browser suite then failed broadly as its disposable servers could not start or
  complete. The already-failed run was stopped. Read-only inspection found
  `/tmp` at 19 GiB/81%, almost entirely 677 stale Codex-owned Vite `ssr` cache
  directories accumulated across repeated gates. Removing only those disposable
  caches reduced `/tmp` to 467 MiB/2%. The complete backup-copy file then passed
  20/20 and the exact 7,001-asset Realm scale case passed 1/1. No product-source
  defect was reproduced. This gate remains failed; a complete clean-environment
  rerun is required.
- Third sixth-review-repair Phase 3 `pnpm test:all`: with the disposable cache
  pressure removed, Realm scale passed, but the frontend durable-mutation case
  that verifies a shared failure waits for an earlier same-key lock flickered
  once and the server graceful-stop case again exhausted the shared 15-second
  default. The already-failed run was stopped while browser smoke was still in
  progress, so it provides no complete-gate evidence. This gate remains failed.
- Graceful-stop full-load stabilization: the single integration case now has a
  30-second per-test scheduling budget while retaining every provider,
  cancellation, shutdown, SQLite, partial-result, and terminal-operation
  assertion. It had passed five isolated executions before the budget change;
  afterward it passed another five consecutive executions in 3.80–4.69s and
  the complete durable-generation file passed 100/100 in 16.26s. The wider
  budget addresses full-suite scheduling contention rather than weakening the
  behavior under proof. Independent focused repetition of the lock-ordering
  case and file is still being checked before the complete gate rerun.
- Lock-ordering stabilization: an independent read-only audit found no
  production race or leaked queue state after 200 repetitions of the exact
  case, 50 repetitions of the complete 19-test file, and another 200 complete
  file repetitions. Same-key staging, predecessor persistence, dispatch-lock
  cleanup, local claim cleanup, IndexedDB reset, Vitest file isolation, and
  invalidation of fire-and-forget refresh work all remain bounded. The fragile
  one-second polling assertion was replaced by a deferred signal emitted by the
  mocked first request itself, retaining the ordering assertions without a
  scheduler-dependent deadline. The complete file passes 19/19.
- Fourth sixth-review-repair Phase 3 `pnpm test:all`: server/browser typecheck,
  topology, documentation, compatibility-register validation, frontend
  typecheck, and the smoke build passed. The frontend lane passed 9,464 tests/3
  skipped except for the existing shared-core Fastify-import ownership scan,
  whose synchronous recursive parse took about 5.5 seconds under full load and
  exceeded the generic 5-second test timeout. The already-failed run was
  stopped before the remaining lanes completed. The ownership scan now has a
  15-second per-test budget without changing its exhaustive import assertions;
  its complete 94-test file passes in 5.19s. This gate remains failed and a
  complete rerun is required.
- Final sixth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m58.0s, including frontend 9,465 passed/3 skipped, server 4,560 passed/3
  skipped, browser smoke 157/157, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. This exact passing tree is ready to be frozen for a fresh
  independent GPT 6 Astra High closure review; Phase 3 remains unaccepted until
  that review is clean.
- Seventh Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 73 tracked diffs at SHA-256
  `8e90ab3a0404276e70b72cdfd70bacf92c43cc93f5c83f3a7e959556391e1647`,
  the two untracked file hashes, and sorted content-manifest SHA-256
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`.
  It rechecked every earlier rejection repair and cleared a suspected second
  chat-only IGP path through a real two-send Chromium/Fastify/SQLite probe, but
  rejected the phase with two P2 findings. First, the actual owner UI Continue
  entry omitted its exact live occupancy tuple and the client rejected one if
  supplied, so the legitimate compatibility fence returned 426 before a second
  provider dispatch even though downstream Continue/IGP helpers were correct.
  Second, cancellation arriving before Send acceptance created an exact
  `unbound`/`cancel_requested` server tombstone that Stop recovery recognized,
  but the sibling staged Send treated as an origin mismatch and retained
  forever after reload. Both were reproduced with production client/server paths
  and disposable Chromium/Fastify/SQLite state. Owner Continue needs real
  entry-to-admission append/extend completion and recovery proof while chat-only
  Continue stays unavailable. Exact cancellation-first tombstones must settle
  the sibling Send without dispatch, tuple transplantation, or overwriting a
  newer draft, while stale/mismatched tombstones remain fail-closed. Production
  rollout remains disabled.
- Seventh-review repair: the live `sendChat` entry now captures the exact current
  owner occupancy tuple for Continue and owner Regenerate, and preserves exact
  mode/interaction identity through staging, scoped outbox recovery, and
  cancellation. Chat-only Continue/Regenerate remain rejected. A real
  DefaultChatScreen/Fastify/SQLite browser journey claims as owner and invokes
  the actual Continue menu twice: extend retains the assistant ID and prior
  `generationInfo`, then reload plus append creates a distinct result; both
  requests carry the exact owner session/epoch and reach the provider. The
  browser journey passes 1/1, client generation-operation tests pass 64/64,
  pending-outbox tests pass 254/254, related client tests pass 7,104/3 skipped,
  and the configured IGP matrix passes 4/4. Exact current scoped
  `unbound`/`cancel_requested` tombstones now also settle the sibling Send and
  Stop rows without POST/PUT; identity mismatches and stale tuples remain
  retained. A separate real IndexedDB/Fastify reload journey proves the aborted
  submit never reaches the server, cancellation creates the tombstone, reload
  drains the outbox, provider calls/aborts stay at zero, only the seed transcript
  remains, and a newer draft survives. Client/server checks, smoke build,
  focused Prettier, and diff checks pass. A complete gate rerun and fresh
  closure review remain required.
- Final seventh-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m17.7s, including frontend 9,471 passed/3 skipped, server 4,560 passed/3
  skipped, browser smoke 158/158, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. This exact passing tree is ready to be frozen for an
  eighth fresh independent GPT 6 Astra High closure review; Phase 3 remains
  unaccepted until that review is clean.
- Eighth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 73 tracked diffs at SHA-256
  `cd1553ecf348ae4d0f9bc82607b2239e01b6a53ad9ff2ca4cd328fc68ab90287`,
  both untracked file hashes, and sorted content-manifest SHA-256
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`.
  It confirmed the seventh-review repairs for unchanged-role paths but rejected
  their composition with owner-to-chat-only normalization in two P2 findings.
  Accepted Send/Stop status reconciliation still compared immutable accepted
  `occupancyClaimClass` with the normalized current class, despite an unchanged
  four-part tuple, stranding lost-acceptance Send and pre-server-lost Stop.
  Separately, fresh-admission validation filtered queued accepted owner
  Continue/Regenerate and their Stop rows before status lookup after
  normalization, so neither recovery nor newly requested control could reach
  the server. Accepted recovery/control must bind the four-part tuple and retain
  immutable admission provenance separately, while new chat-only
  Continue/Regenerate stays prohibited. Required regressions cover actual
  normalization plus reload/outbox settlement, exactly-once cancellation, no
  generation redispatch, newer-draft preservation, Continue/Regenerate lost
  responses and Stop, and malformed/stale/tombstone mismatches. Production
  rollout remains disabled.
- Eighth-review repair: accepted recovery now compares the stable database
  lineage/chat/session/epoch tuple while validating `admissionKind` and
  `occupancyClaimClass` separately as immutable server provenance. Outbox
  validation distinguishes fresh admission from recovery/control: a normalized
  page can enumerate and reconcile accepted owner Send, Continue, Regenerate,
  and their exact Stops, while fresh chat-only Continue/Regenerate remain
  prohibited. An explicit Stop also lazily rebinds accepted work projected
  before normalization to the now-current same tuple; it cannot transplant a
  stale tuple or redispatch the operation/provider. Client operation tests pass
  73/73 and outbox tests pass 257/257, including Continue extend/append,
  Regenerate, malformed provenance, stale epochs, lost acceptance, and exactly
  one cancellation. Real Chromium/Fastify/SQLite normalization journeys pass
  2/2 and 4/4 repeated: accepted owner Send settles after reload with one
  provider call, and actual owner UI Continue reaches a partial before
  demotion/normalization, loses Stop before server receipt, then reloads to one
  successful cancellation/provider abort with no generation redispatch and the
  newer draft intact. Client/server checks, smoke build, focused Prettier, and
  the full diff check pass. A complete gate rerun and fresh closure review are
  still required; production rollout remains disabled.
- First eighth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m32.5s. Thirteen lanes passed, including frontend tests, all 159 browser
  journeys, both typechecks, documentation, compatibility, smoke build, UI
  coverage, formatting, Realm scale, and performance. The server lane passed
  4,559 tests/3 skipped, but the graceful-shutdown integration that holds
  acknowledged user-cancel persistence reached its 30-second ceiling under
  full-suite load for the second time despite repeated isolated completion in
  roughly four seconds. This is a gate failure. The recurring stall must be
  located and repaired without weakening its partial-persistence, terminal
  operation, and pre-SQLite-close assertions before another complete rerun.
- Graceful-shutdown lifecycle repair: the failing case now uses the Fastify
  harness already created for that test instead of starting a second complete
  app with duplicate workers, timers, sockets, and SQLite handles at peak suite
  load. It also consumes and verifies the complete 202 cancellation
  acknowledgement before beginning shutdown, so the DELETE lifecycle cannot
  compete with the SSE viewer that `preClose` must drain. The test has returned
  to the normal 15-second deadline while retaining exact cancelled-partial,
  terminal-operation, and pre-database-close assertions. It passes 20/20
  repeated executions, and the complete durable-generation file passes 100/100
  in 15.37s. Server checks, Prettier, and the full diff check pass. A complete
  gate rerun is still required.
- Second eighth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m25.0s. The graceful-shutdown repair held under the same load and the server
  lane passed 4,560 tests/3 skipped in 50.9s. Twelve other lanes also passed,
  but browser smoke reported 158/159 because the repeated-restart queued
  finalization journey did not observe its rendered
  `data-generation-persistence-state="queued"` marker within 15 seconds after a
  restart. The captured accessibility tree subsequently contained the exact
  visible queued-warning text, so the failure boundary is being checked for a
  client projection/render synchronization race rather than treated as a pass.
  Its authoritative queued row, retry behavior, and terminal exactly-once
  assertions must remain intact before another complete rerun.
- Repeated-restart finalization-state repair: the failed trace proved the fourth
  check, after the second server restart, had truthfully advanced the retry row
  from `queued` to `stalled` at the documented three-failure threshold. It was
  still pending/retryable and the captured DOM carried the exact stalled
  attribute and warning. The browser helper now accepts only `queued` or
  `stalled` while retryable, requires exact state agreement among the rendered
  reply-row attribute, browser lifecycle projection, and authenticated server
  bootstrap, and explicitly requires `stalled` after the repeated-restart loop
  before clearing the injected write failure. Transcript authority, one
  provider call, finalizing operation, zero active jobs/outbox rows, one journal
  row, eventual terminal settlement, effect ledger, and repeated settled-state
  restart assertions remain unchanged. The exact journey passes 3/3 serially
  plus a final 1/1 run; browser-smoke typecheck, Prettier, and the full diff
  check pass. A complete gate rerun is still required.
- Final eighth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m35.0s, including frontend 9,483 passed/3 skipped, server 4,560 passed/3
  skipped, browser smoke 159/159, client and server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance gates. The repaired graceful-shutdown and repeated-restart
  finalization journeys both passed under the complete-suite load. This exact
  passing tree is ready to be frozen for a ninth fresh independent GPT 6 Astra
  High closure review; Phase 3 remains unaccepted until that review is clean.
- Ninth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 74 tracked diffs at SHA-256
  `50dc5abe9e4634b452422e98568397f05eb6de501959917400bfd0bd4cda80e5`,
  both untracked file hashes, and sorted content-manifest SHA-256
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`.
  It cleared its initial authority-transition recovery hypothesis through the
  existing reattach/bootstrap paths, but rejected the phase with one P2 owner
  behavior composition defect. The supported owner completion path persists
  `runInlayScreen` output before IGP; converting an emotion marker changed the
  terminal transcript fingerprint even though the exact accepted-operation
  binding remained valid. A read-only production-store/API probe then claimed
  the IGP effect but received 409 `generation_effect_target_stale` on
  completion. The binding must compose with exactly authorized owner inlay
  finalization without permitting arbitrary transcript edits, and combined live
  plus recovered owner inlay/IGP coverage must prove provider input, atomic
  append/commit, and receipt idempotency. Production rollout remains disabled.
- Ninth-review repair: modern owner inlay finalization now carries exact
  generation and operation identity into the existing message compare-and-set.
  In the same transaction, the server validates the immutable accepted
  `owner_occupancy` scope, accepted character inlay mode, unchanged terminal
  transcript, and the exact supported emotion or image-inlay transformation;
  image replacements must reference existing server-owned image assets. It then
  persists the message and advances every matching effect-ledger terminal
  fingerprint atomically. Arbitrary text, missing assets, legacy or chat-only
  scopes, and stale authority cannot use this path. Legacy owner commands retain
  their previous shape. The complete durable-generation file passes 100/100; a
  live/restart-recovered Reroll and Continue lifecycle matrix passes 4/4 with
  exact provider input, translation composition, atomic IGP commit replay, and
  receipt idempotency. Server effect tests pass 21/21, atomic IGP tests 37/37,
  browser terminal handling 36/36, and inlay serialization 3/3. Client/server
  checks, Prettier, and the full diff check pass. A complete gate rerun and fresh
  closure review remain required; production rollout remains disabled.
- First ninth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m39.8s. Thirteen lanes passed, including frontend 9,484 passed/3 skipped,
  server 4,562 passed/3 skipped, client/server typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance. Browser smoke passed 158/159; the large
  T01/T03/T04/T08/T11 multi-session journey timed out waiting for the second
  completed operation in one chat and observed one. Every other occupancy,
  normalization, Stop, recovery, configured-IGP, restart, and finalization
  browser journey passed. The trace must establish whether the second operation
  was rejected, retained, or only missed by the current synchronization before
  another complete gate rerun; this failed run is not acceptance evidence.
- Owner Continue browser synchronization repair: the failing trace and an exact
  unchanged reproduction proved both concurrent initial operations completed;
  the missing row was the later owner Continue, whose menu click landed about
  90 ms after the terminal operation read while the browser still reconciled a
  stale-attempt response and effect claims/receipts. The intentional
  `currentChatOwnsGeneration` re-entry guard returned before staging, so there
  was no Continue POST or server disposition to lose. The helper now waits for
  the visible, enabled owner Send control as the real local send-ready signal,
  then requires the exact successful Continue admission before polling SQLite.
  The fixed journey passes 1/1 and 4/4 serial repeats; the other normalized-owner
  Continue consumer passes 1/1. Server/browser-smoke typechecks, Prettier, and
  the full diff check pass. A complete gate rerun remains required.
- Second ninth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m32.7s. Thirteen lanes passed, including frontend 9,484 passed/3 skipped,
  server 4,562 passed/3 skipped, both typechecks, documentation, compatibility,
  smoke build, UI coverage, formatting, Realm scale, and performance. Browser
  smoke passed 157/159. The main T01/T03/T04/T08/T11 journey clicked owner
  Continue but did not observe a successful Continue admission, and the new
  configured chat-only IGP journey found no persisted translation metadata on
  the terminal result before IGP. Both exact traces are under independent
  diagnosis; this failed run is not acceptance evidence and production rollout
  remains disabled.
- Final owner Continue synchronization repair: database completion and the
  enabled Send control can precede the prior operation's sequential recovered
  effect pass, during which the global generation-readiness fence remains
  transiently closed. The browser journey now waits for the exact prior
  generation's final, already-receipted `emotion_image_state` recovery claim
  before one Continue click; it does not retry the user action. The repaired
  main journey and the configured-IGP journey pass 8/8 together with two
  workers. Browser typechecking, Prettier, and the full diff check pass.
- Automatic generated-translation ownership repair: parallel stress proved a
  real cross-client race in which the visible observer's automatic translation
  could replace the server-owned generated translation's registry token,
  leaving the durable effect failed with `Message translation is no longer
current`. Automatic browser requests are now explicitly marked. Fastify
  rejects only a marked request with 409
  `generated_translation_server_owned` when the exact accepted operation,
  terminal transcript, and pending/claimed/completed server-owned translation
  binding still match; the UI treats that expected yield silently. Explicit
  manual translation retains last-writer-wins behavior. The route regression
  proves no provider, registry, or message mutation occurs on the yield, the
  browser proof asserts one marked 409 and one durable provider call, and
  focused generation-effect 22/22 plus command-adapter 161/161 suites pass.
  Both typechecks, smoke build, Prettier, and the full diff check pass. A fresh
  complete gate rerun and closure review remain required; rollout is disabled.
- Third ninth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m35.1s. Twelve lanes passed, including server 4,563 passed/3 skipped, both
  typechecks, documentation, compatibility, smoke build, UI coverage,
  formatting, Realm scale, and performance. Frontend tests found one stale
  mock export/expectation for the new silent automatic-translation yield.
  Browser smoke passed 158/159; the main occupancy journey crossed the exact
  recovered-effect barrier and entered the real Continue `preparing` state,
  but its generic five-second successful-admission poll expired under
  full-suite load before prompt preparation produced the POST. The trace showed
  no rejection or repeated click. This failed run is not acceptance evidence.
- Final gate-load synchronization repair: the Continue helper retains the
  exact prior-generation recovery barrier and single user click, while using
  the same bounded 30-second budget as the other prompt preparation/admission
  waits. The repaired main journey passes 8/8 with two workers. The frontend
  mock now exports the shared server-owned error constant, the ordinary
  automatic provider-failure test still proves one visible failure and no
  retry, and a separate regression proves the exact server-owned yield is
  silent and sent with `automatic: true`; the complete file passes 87/87.
  Prettier and the full diff check pass. A complete gate rerun and fresh closure
  review remain required; production rollout remains disabled.
- Final ninth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m23.2s. Frontend passed 9,485 tests/3 skipped, server passed 4,563 tests/3
  skipped, and browser smoke passed all 159 journeys, including the main
  owner/chat-only matrix and configured translation-to-IGP recovery journey
  under complete-suite load. Both typechecks, documentation, compatibility,
  smoke build, UI coverage, formatting, Realm scale, and performance gates also
  passed. This exact tree is ready for a tenth fresh independent GPT 6 Astra
  High closure review. Phase 3 remains unaccepted and rollout remains disabled
  until that review is clean.
- Tenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer independently
  matched baseline `bf32c875f`, all 81 tracked diffs at SHA-256
  `fc9e260e0744b37586192c2225b6ffd06df2b822908567dc8cfb521f70f562d9`,
  both untracked file hashes, and combined changed-content manifest SHA-256
  `fb48a934b5c27d9caac97c3279a7d4afb6d1890e2625672cb4ec073eac4228c4`.
  It revisited the nine preceding closure findings and found no regression in
  their repairs, but rejected Phase 3 with one new P2 composition gap. A
  deterministic production Fastify/SQLite probe held an accepted generated
  translation provider after its effect was claimed; authenticated bootstrap
  exposed pending IGP, whose late-recovery claim, provider completion, and
  atomic commit all succeeded before translation settled. Releasing the
  provider then left IGP completed but generated translation permanently failed
  because IGP had changed its exact source. The server must preserve IGP as
  pending/recoverable while its exact generated-translation prerequisite is
  pending or claimed, and deterministic reload/recovery plus live
  post-deferral-cap coverage must prove eventual ordered completion. The
  reviewer accepted the final one-click Continue synchronization and found no
  other blocker. Production rollout remains disabled.
- Tenth-review translation-to-IGP ordering repair: modern exact-sibling IGP
  claims now remain pending while generated translation is pending or claimed,
  including an expired claim that startup recovery can reclaim. Production
  translation persistence completes its durable receipt inside the same
  targeted message transaction, so the resulting `message.updated` event cannot
  wake IGP against a still-unreceipted translation. A successfully applied
  message-update event requests one scoped occupancy recovery; failed
  translation remains recoverable through the existing occupancy-renewal path,
  with no new polling loop. A deterministic real Fastify/SQLite regression
  holds the accepted chat-only translation provider beyond its one-second
  notification defer cap, reloads bootstrap, expires the translation lease,
  proves late-recovery IGP remains unclaimed with
  `generated_translation_prerequisite_pending`, then releases translation and
  completes both effects once with two total provider calls. Focused generation
  effects pass 23/23, connected-reader sync 30/30, bootstrap 246/246, and the
  related frontend run 7,119 passed/3 skipped. Server and client typechecks,
  Prettier, and the full diff check pass. A complete gate rerun and eleventh
  fresh independent closure review remain required; production rollout remains
  disabled.
- First tenth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes in
  8m22.5s. Thirteen lanes passed, including frontend 9,486 passed/3 skipped,
  server 4,564 passed/3 skipped, both typechecks, documentation,
  compatibility, smoke build, UI coverage, formatting, Realm scale, and
  performance. Browser smoke passed 158/159. The main
  T01/T03/T04/T08/T11 journey completed and receipted the prior owner
  generation, accepted and acknowledged the Continue action's
  `lastInteraction` persistence, but did not issue a Continue operation before
  the 30-second bound. This failed run is not acceptance evidence; rollout
  remains disabled.
- Post-translation Continue/readiness repair: parallel browser reproduction
  established that the durable character command and receipt ACK settled, the
  occupancy lineage/session/epoch and live lease remained exact, and the
  generation operation intentionally rejected admission because
  `chat-dependencies` was false. The full-resource invalidation path revoked
  readiness before starting a forced selected-character hydration at its end;
  under load that forced request aborted the exact in-flight hydration awaited
  by readiness, which then recorded
  `selected-character-hydration-failed` with no target change to retry it. Full
  invalidation now starts one minimum-revision selected-character hydration
  before requesting readiness reevaluation, so the evaluation subscribes to
  that request instead of being superseded. The browser barrier now also
  requires every exact prior-generation effect to be terminal and the existing
  generation-readiness diagnostic to be ready before its single Continue
  click. The focused bootstrap suite passes 246/246, client typecheck has zero
  errors/warnings, smoke build passes, and the exact browser journey passes
  10/10 concurrently where the pre-fix tree failed 4/10 and 2/4 with confirmed
  `chat-dependencies`/`selected-character-hydration-failed` diagnostics. A
  complete gate rerun and eleventh fresh independent closure review remain
  required; production rollout remains disabled.
- Final tenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m32.3s. Frontend passed 9,486 tests/3 skipped, server passed 4,564 tests/3
  skipped, and browser smoke passed all 159 journeys, including the repaired
  one-click owner Continue path under complete-suite load. Both typechecks,
  documentation, compatibility, smoke build, UI coverage, formatting, Realm
  scale, and performance gates also passed. This exact tree is ready for an
  eleventh fresh independent GPT 6 Astra High closure review. Phase 3 remains
  unaccepted and rollout remains disabled until that review is clean.
- Eleventh Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 81 tracked diffs at SHA-256
  `3245b077e2f14eb275ef8dd4f71436abcbb065c467088f3a8bb035457afea568`,
  both untracked file hashes, the two-file manifest
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`,
  and combined changed-content manifest
  `00f658998e6cc167e93c40e56494b046418546d2ce18a07737d37d173bca37a8`.
  It rejected Phase 3 with two P2 recovery compositions. First, a targeted
  invalidation immediately following a full invalidation can supersede the
  selected-character hydration awaited by readiness; the replacement read can
  succeed while the unchanged target remains permanently not ready with
  `selected-character-hydration-failed`. Second, after same-tuple owner to
  chat-only normalization, a proven-unaccepted staged Continue or Regenerate
  whose 404 response was lost is retried as a fresh unsupported submit; the
  `chat_only_interaction_unsupported` result remains retained and replayable.
  Required repairs are a deterministic held-read full-to-targeted readiness
  regression with stale-response rejection and eventual one-click Continue,
  plus Continue/Regenerate 404-after-normalization recovery that reconciles
  accepted work first but keeps proven-unaccepted owner-only work dormant with
  an explicit disposition, zero submit, and preserved drafts. The reviewer
  found no other concrete blocker, made no edits, and did not rerun the supplied
  full gate. Production rollout remains disabled.
- Eleventh-review normalized-recovery repair: recovery still reconciles the
  authoritative operation identity before considering any resubmission. When a
  same-tuple owner Continue or Regenerate was never accepted and the retained
  occupancy has normalized to `chat_only`, the 404 proof now produces an
  explicit dormant `requires_resubmission` projection before dispatch. The
  encrypted intent and originating `draftGeneration` remain intact; two
  repeated recovery passes issue only their status reads, with zero operation
  submissions, dispatch starts, or outbox deletion. The matrix covers both
  deferred interactions, accepted owner Continue/Regenerate still reconcile,
  and fresh chat-only Continue/Regenerate remain rejected before staging or
  transport. The focused generation-operation suite passes 76/76, client
  typechecking reports zero errors or warnings, and Prettier plus the full diff
  check pass.
- Eleventh-review hydration-overlap repair: character hydration has an opt-in
  successor chain that transfers existing subscribers to a superseding request
  while retaining the highest minimum revision and the original abort,
  selection, and target fences. Full and targeted invalidations opt in with the
  exact refresh revision, so a revision-13 targeted refresh can replace a held
  revision-12 read without resolving the readiness subscriber as failed. A
  focused real-browser Fastify/SQLite journey first completes one owner Send,
  clears only the browser's applied-resource cursor through the smoke-only
  diagnostics hook, drives a real full invalidation, holds and poisons its
  native character response, then drives the next targeted invalidation at the
  exact following revision. It proves the first request is aborted and cannot
  publish when released, the second applies, readiness moves from
  `chat-dependencies` blocked to ready, and one Continue click yields exactly
  one 201 submission and one completed owner-occupancy operation. The journey
  passes 1/1 and then 5/5 serially. Character hydration passes 18/18, bootstrap
  247/247, hydration overlap 2/2, and resource refresh 15/15; both typecheck
  gates, smoke build, Prettier, and the full diff check pass. The complete Phase
  3 gate and fresh closure review remain required; rollout remains disabled.
- Final eleventh-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m19.9s. Frontend passed 9,491 tests/3 skipped, server passed 4,564 tests/3
  skipped, and browser smoke passed all 160 journeys, including the exact
  full-to-targeted hydration supersession and one-click Continue proof under
  complete-suite load. Server/browser and client typechecks, test topology,
  current documentation, compatibility registers and harness, smoke build, UI
  coverage, Realm scale, formatting, and performance gates all passed. This
  exact tree is ready for a twelfth fresh independent GPT 6 Astra High closure
  review. Phase 3 remains unaccepted and rollout remains disabled until that
  review is clean.
- Twelfth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 83 tracked diffs at SHA-256
  `8eff60a4e8cbc806aba233ae26d5a31794fabe6b8dde7d64e735ec85532778f9`,
  both untracked source hashes, the two-file manifest
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`,
  and combined changed-content manifest
  `7f31786115b10b02e1bd90048a965fbd88fecdd6ed68f222c44db2237cb7263f`.
  It accepted the eleventh-review hydration and normalized-recovery fixes, but
  rejected Phase 3 with one P2 completion-order defect. A disposable real
  Fastify/SQLite probe held an accepted owner generated-translation provider
  past the one-second defer cap, then successfully applied the exact authorized
  emotion-inlay message transformation while translation remained claimed.
  Releasing the provider caused translation to fail permanently with
  `Message changed before translation could be saved`, leaving the inlay text
  without generated translation. Owner inlay finalization must remain
  recoverable behind unfinished generated translation, then compose in order
  with IGP, including deterministic held-provider and reload proof. The reviewer
  made no source edits; rollout remains disabled.
- Twelfth-review translation-to-inlay ordering repair: exact validated owner
  inlay intent is now persisted on the generated-translation effect while that
  prerequisite is pending or claimed, without publishing the transformed
  transcript. Translation success completes its durable receipt and drains the
  deferred inlay in the same targeted message transaction; failed or skipped
  translation likewise settles and drains through one targeted transaction
  before IGP can become claimable. The drain revalidates the immutable accepted
  operation, exact terminal transcript, owner scope, supported transformation,
  and image assets, then rebases the generated translation source fingerprint
  across the display-only inlay transform. A deterministic real
  Fastify/SQLite regression holds the translation provider beyond the defer
  cap, accepts the inlay as deferred, reloads recovery state, proves IGP remains
  pending, then completes translation, inlay, and IGP in order with exactly two
  provider calls and terminal receipts. A separate failed-translation case
  proves the same atomic drain before IGP. Generation effects pass 25/25,
  client inlay finalization passes 4/4, server and browser typechecks plus the
  architecture inventory pass, and Prettier and the full diff check are clean.
  A complete gate rerun and thirteenth fresh independent closure review remain
  required; production rollout remains disabled.
- First twelfth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes
  in 8m5.4s. Thirteen lanes passed, including both typechecks, frontend,
  documentation, compatibility and architecture checks, smoke build, all 160
  browser journeys, UI coverage, Realm scale, formatting, and performance.
  Server tests passed 4,565 assertions/3 skipped but correctly failed the one
  reviewed-persistence-owner schema pin because the two new deferred-inlay
  ledger columns changed its digest. This failed run is not acceptance evidence;
  rollout remains disabled.
- Reviewed persistence-schema repair: the Phase 3 compatibility structure now
  pins the exact schema digest that includes
  `deferred_inlay_expected_data` and `deferred_inlay_final_data` on
  `generation_effects`. The preceding failure printed the complete schema and
  exact received digest, so the update changes only that closed-world review
  pin. A complete clean gate rerun remains required.
- Final twelfth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m14.9s. Frontend passed 9,492 tests/3 skipped, server passed 4,566 tests/3
  skipped, and browser smoke passed all 160 journeys. Server/browser and client
  typechecks, test topology, current documentation, compatibility registers and
  harness, smoke build, UI coverage, Realm scale, formatting, and performance
  gates also passed. This exact source tree is ready for a thirteenth fresh
  independent GPT 6 Astra High closure review. Phase 3 remains unaccepted and
  production rollout remains disabled until that review is clean.
- Thirteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 83 tracked diffs at SHA-256
  `3caa0522347b668496e0a0e8ac61d996fc78a58131a71faf07fe88ed51fd3d76`,
  both untracked source hashes, the two-file manifest
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`,
  and combined changed-content manifest
  `e10754d245084ff441c1c049134d83c3710087fe97b5b31dc35f78f00df8ba5d`.
  It rejected Phase 3 with one P2 stale-intent recovery defect. A disposable
  production Fastify/SQLite probe deferred exact owner emotion inlay behind a
  held generated translation, then applied an ordinary same-owner transcript
  edit. Translation settlement rolled back because the deferred inlay no longer
  matched; two expired-lease recovery passes and a real app reopen each
  redispatched the provider and retained the claimed translation, deferred
  payload, pending IGP, and occupancy release pin. The repair must terminally
  dispose of provably stale deferred intent without overwriting the newer
  transcript or rolling back translation's failure/skipped receipt, prevent
  redispatch across expiry/reopen, terminalize dependent work, and allow
  release. The reviewer found no other actionable blocker, made no source edits,
  and independently passed generation effects 25/25 plus the diff check.
  Production rollout remains disabled.
- Thirteenth-review stale deferred-inlay repair: persisted deferred intent now
  has a typed `none`/`ready`/`stale`/`invalid` classifier. `stale` requires
  complete validated transform data, exact accepted owner operation and scope,
  exact translation-to-IGP sibling binding, and one unambiguous assistant
  target; any terminal-transcript drift then retires the obsolete chain without
  writing the transcript. Partial payloads, corrupt scope/binding, and
  missing/ambiguous targets remain invalid and fail closed. Live translation
  failure atomically preserves its failed receipt, clears the stale intent, and
  skips IGP with `deferred_generation_inlay_target_stale`; a successful
  translation followed by unrelated transcript drift likewise retains its
  translation metadata/receipt while retiring inlay and IGP. Recovery performs
  the same classification before provider dispatch. Deterministic coverage
  proves a held provider plus target edit calls the provider once and allows
  release, an expired claim plus real `buildApp` reopen performs zero
  redispatches and allows release, another-row drift is safely stale, and a
  corrupted sibling epoch remains invalid and untouched. Generation effects
  pass 28/28, completion translation 8/8, occupancy 14/14, both typecheck
  surfaces and architecture inventory pass, client diagnostics report zero
  errors/warnings, and Prettier plus the diff check pass. A complete gate rerun
  and fourteenth fresh independent closure review remain required; rollout is
  disabled.
- Final thirteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m15.9s. Frontend passed 9,492 tests/3 skipped, server passed 4,569 tests/3
  skipped, and browser smoke passed all 160 journeys. Server/browser and client
  typechecks, topology, current documentation, compatibility registers and
  harness, smoke build, UI coverage, Realm scale, formatting, and performance
  gates all passed. This exact source tree is ready for a fourteenth fresh
  independent GPT 6 Astra High closure review. Phase 3 remains unaccepted and
  production rollout remains disabled until that review is clean.
- Fourteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 83 tracked diffs at SHA-256
  `21604cfee0efa9941a240fbbe7b6d0a7e10f910661b68896c33db9fed7544a40`,
  both untracked source hashes, the two-file manifest
  `1d6f6d7808c6b15eafcf471074d9c95a48f6a955975858f20f076475c913178c`,
  and combined changed-content manifest
  `0b0bd6fdb40c3ea969b01ffa360587e35ac85165d14e4408d713f4556a45e2ac`.
  It rejected Phase 3 with two P2 owner-inlay integration defects. First, real
  synchronous emotion finalization uses a plain command without the accepted
  database-lineage context; Chromium sent the writer header but no lineage, so
  Fastify returned 400 and no inlay intent or transform was persisted. Second,
  slow image generation has no durable pre-provider intent. A real
  Chromium/Fastify/SQLite probe held image and translation providers, released
  translation, observed recovered IGP claim/completion/commit/receipt succeed
  against the raw `<ImgGen>` transcript, then released image; asset upload and
  catalog registration succeeded but no finalization PATCH was sent, leaving
  the raw tag plus IGP suffix. Counts were one each for main, generated
  translation, IGP, and image providers. The repair must use stable durable
  lineage authority for finalization and persist an exact pre-async inlay
  obligation that fences live/recovered IGP until terminal settlement, with
  real browser proof. The reviewer found no additional confirmed blocker, made
  no source edits, and independently passed generation effects 28/28 plus the
  diff check. Production rollout remains disabled.
- Fourteenth-review durable owner-inlay repair: accepted-operation owner inlay
  now begins with an exact, operation-bound SQLite preparation on the dependent
  IGP effect before either a synchronous emotion transform or asynchronous
  image provider may run. Dedicated preparation, finalization, and abandonment
  commands carry the stable database lineage and originating writer session,
  use deterministic receipt identities with bounded revision retry, and
  revalidate the accepted operation, scope, target, source text, supported
  transform, and server-owned image assets in the targeted mutation. IGP claims
  fail closed while an exact preparation is pending or malformed. Translation
  hydration in the same page retains a registered live provider; a reload
  abandons only an inactive exact marker before IGP recovery. Provider,
  configuration, upload, or unresolved-image failures abandon the marker and
  retain the raw retryable source tag. Image settings no longer require the
  unrelated account group except for the Kei provider. The server transform
  validator additionally requires every source ImgGen obligation to become a
  verified image asset and rejects tag deletion. Real Chromium/Fastify/SQLite
  proofs pass for lineage-correct synchronous emotion finalization and a held
  image plus translation race with exactly one main, translation, IGP, and
  image provider call and IGP fenced until asset settlement. Generation effects
  and the closed-world schema suite pass 37/37; focused client coverage passes
  115 tests; both typechecks, the smoke build, Prettier, and the diff check pass.
  The reviewed schema digest is now
  `83034f56531769e59514f97af639c862e47afd87ad95dc1de6ba6a890d715217`
  for the two preparation columns. A complete clean gate and fifteenth fresh
  independent closure review remain required; production rollout is disabled.
- First fourteenth-review-repair Phase 3 `pnpm test:all`: intentionally stopped
  after the frontend lane reported 42 failures. The two root causes were
  closed-world expectations omitted by the new boundary: the route-operation
  catalog still pinned 119 entries and its durable list omitted the three inlay
  commands, while the shared server-backed send fixture exported only
  `runInlayScreen` and not the new pure preflight. Typechecks, current docs,
  compatibility registers, smoke build, formatting, and the focused server
  proofs had passed before the stop. This interrupted run is not acceptance
  evidence; rollout remains disabled.
- Fourteenth-review full-gate fixture repair: the protocol test now pins all 122
  reviewed operations and the three inlay command durability classes. The
  shared inlay fixture implements the same pure emotion/image preflight shape,
  so existing send and preview fixtures exercise the new call without gaining
  provider behavior. The affected protocol, route-backed send, and preview
  suites pass 70/70. A new complete clean Phase 3 gate remains required.
- Second fourteenth-review-repair Phase 3 `pnpm test:all`: the repaired frontend
  lane passed, then the server lane reported two closed-world inventory
  failures. The runtime mutation-path collector found the three new inlay
  paths absent from the metric budget registry, and route protection found the
  three auth-session commands absent from its reviewed active-writer exception
  list. The remaining browser lane was stopped; this run is not acceptance
  evidence.
- Fourteenth-review command-inventory repair: preparation and abandonment now
  have exact `generation_effects`-only write budgets; finalization permits only
  the exact message/effect tables and bounded derived memory/wiki invalidation
  tables. All three narrow paths require zero db.json rewrite time. Route
  protection explicitly pins the three accepted-session commands, and the
  narrow-gate meta-test covers every generation-effect command. Mutation
  budgets, route protection, and generation-effects suites pass 57/57. A new
  complete clean Phase 3 gate remains required; rollout is disabled.
- Third fourteenth-review-repair Phase 3 `pnpm test:all`: 13 of 14 lanes passed
  in 8m8.2s. Frontend passed 9,503 tests/3 skipped, server passed 4,571 tests/3
  skipped, and 161 of 162 browser journeys passed. The sole failure was an
  over-specific browser assertion that required one incidental automatic
  translation request to race the durable generated-translation owner and be
  rejected with 409. Under suite load, the completed server translation
  hydrated first, so the browser correctly made no redundant request; durable
  translation metadata, effect state, and all preceding/following provider
  counts remained correct. This failed run is not acceptance evidence.
- Browser generated-translation race-proof repair: the configured IGP journey
  now permits the two valid schedules after durable translation completion:
  zero redundant automatic requests when hydration wins, or at most one
  automatic request rejected with 409 when a client observes the raw row first.
  The audit is taken only after IGP settlement, transport-loss recovery, and a
  real reload, so the zero-request branch is not an early vacuous snapshot. The
  deterministic Fastify test still forces the latter schedule and proves
  `generated_translation_server_owned` before any provider dispatch or
  transcript mutation. The exact browser journey passed five unchanged
  standalone repetitions and then eight parallel repetitions with the initial
  schedule-neutral assertion. An independent read-only source review confirmed
  both schedules from the done-frame eligibility fence and the existing unit
  proofs; its focused generated-translation/client suites passed 92/92. A fourth
  complete gate was intentionally stopped after about one minute because this
  late terminal audit strengthened the browser proof while it was running. That
  mixed-source run is not acceptance evidence. A new complete clean Phase 3 gate
  remains required; rollout is disabled.
- Fifth fourteenth-review-repair Phase 3 `pnpm test:all`: completed all 14 lanes
  in 8m9.9s, with 13 lanes passing. Frontend passed 9,503 tests/3 skipped,
  server passed 4,571 tests/3 skipped, and 161 of 162 browser journeys passed.
  The sole failure was the new synchronous emotion-inlay Chromium proof: under
  suite load its request-only barrier released the held provider after an
  expected stale-epoch stream GET returned 409, before the redirected GET could
  attach. Completion therefore won the test-created race and correctly entered
  late recovery without running the live inlay transport. This failed run is
  not acceptance evidence.
- Live-stream proof synchronization repair: both synchronous emotion and held
  image journeys now retain the provider gate until an operation-stream response
  is actually 200. The failed trace showed the accepted operation at projection
  epoch 3, a normal provider-dispatch bump to epoch 4, a typed 409 redirect from
  the epoch-3 GET, and correct client retry; the test had released on the first
  request rather than the successful response. An independent read-only review
  matched that sequence to the three-redirect product path and existing unit
  proof, found no product retry gap, and identified the same latent barrier in
  the held-image test. The unchanged exact lineage, route/body, effect,
  provider-count, and persisted-output assertions then passed 8/8 for emotion
  alone and 16/16 for both journeys together. A new complete clean Phase 3 gate
  remains required; rollout is disabled.
- Final fourteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m21.7s. Frontend passed 9,503 tests/3 skipped, server passed 4,571 tests/3
  skipped, and browser smoke passed all 162 journeys, including both successful
  live-stream attachment barriers and the terminal generated-translation race
  audit under complete-suite load. Server/browser and client typechecks,
  topology, current documentation, compatibility registers and harness, smoke
  build, UI coverage, Realm scale, formatting, and performance gates all passed.
  This exact runtime/test tree is ready for a fifteenth fresh independent GPT 6
  Astra High closure review. Phase 3 remains unaccepted and production rollout
  remains disabled until that review is clean.
- Fifteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 87 tracked diffs at SHA-256
  `695339dc0ba97bb568d794391260b86d1e8b78b4e79bc5a8309cbc5439ff60a5`,
  all three untracked source hashes, the three-file manifest
  `30165902d28e4656bdfbb38d5ac558faddbc099e1cac5a6c2295ab961714acec`,
  and combined changed-content manifest
  `12e96604c0d6cd49ed7cff89137a27d5e20a0a4b9436a7f8e76dd3344f0740c3`.
  It rejected Phase 3 with three P2 owner-inlay lifecycle defects reproduced
  through real Chromium, Fastify, and disposable SQLite. First, production-
  default rollout-disabled owner Send admits `legacy_owner`, but the new
  occupancy-only preparation guard removed its compatibility inlay path: one
  provider call and terminal effects left `Reply <Emotion="happy">` raw with
  zero inlay requests; image inlay is excluded by the same guard. Second, TTS
  alternate text still called the provider-capable inlay renderer. A plain
  primary plus alternate `<ImgGen="alternate cat">` started a real held image
  request without a durable marker while every effect, including TTS, became
  terminal. Third, a role transfer while TTS settlement was held exited after
  successful emotion preparation without retiring the page-local active marker.
  Same-session/same-epoch normalization and a fresh bootstrap then skipped
  recovery forever and explicit release returned 409 until a reload abandoned
  the marker. The repair must restore exactly fenced legacy-owner behavior, make
  alternate TTS processing provider-free, and retire or settle every active
  preparation on supersession without prematurely abandoning genuine provider
  work. The reviewer independently passed generation effects 30/30, found the
  latest SSE/test scheduling repairs sound, made no source edits, and found no
  additional cross-epoch or expiry pin. Rollout remains disabled.
- Fifteenth-review owner-inlay lifecycle repair: rollout-disabled compatibility
  owners again finalize emotion and image inlays through the lineage-bearing,
  scoped durable message dispatcher with exact chat, message, source-data, and
  generation preconditions. Occupancy-scoped preparations settle before TTS;
  every accepted preparation retires its page-local active registration, while
  a genuinely running image provider remains alive through transient role loss.
  After provider settlement, current authority may finalize, otherwise only the
  captured accepted owner session may abandon its exact preparation marker. The
  abandonment route does not mutate the transcript or grant stale finalization
  authority. Alternate TTS text now uses a pure renderer and cannot start image
  provider work. Focused client coverage passes 182 tests across the core,
  server-backed fixture, and adjacent send/preview suites; generation effects
  pass 31/31. Four real Chromium/Fastify/SQLite regressions pass for modern
  emotion lineage, disabled-rollout legacy emotion, disabled-rollout held image,
  and ordered translation/held-image/IGP settlement. Both typechecks, Prettier,
  and the diff check pass. The complete Phase 3 gate and a sixteenth fresh
  independent closure review remain required; rollout is disabled.
- Final fifteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m3.8s. Frontend passed 9,511 tests/3 skipped, server passed 4,572 tests/3
  skipped, and browser smoke passed all 164 journeys. Server/browser and client
  typechecks, topology, current documentation, compatibility registers and
  harness, Realm scale, the production smoke build, UI coverage, formatting,
  and performance gates all passed. This exact runtime/test tree is ready for a
  sixteenth fresh independent GPT 6 Astra High closure review. Phase 3 remains
  unaccepted and production rollout remains disabled until that review is clean.
- Sixteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 89 tracked diffs at SHA-256
  `6fa43b49cfe30a6641d1bb2efaca7932591ca0d6969d11e882b89f3d081afc5f`,
  all three untracked hashes, the untracked manifest
  `a72ca01ea4f7b9147a039dcbe4307889777b49e53d2a955d277ac5fa1e875230`,
  and combined changed-content manifest
  `e9d2a0626419fa525d93fea0d6ebf8922d03c578de67d867ae3f0f7c13362700`.
  It rejected Phase 3 with one P2 compatibility projection defect. In a repeated
  real Chromium/Fastify/SQLite probe, rollout-disabled legacy owner Send started
  a held image provider, then a same-owner authenticated message PATCH persisted
  and hydrated newer text. With later chat/character refresh reads faulted, an
  image-provider HTTP 500 correctly sent no stale finalization PATCH and SQLite
  retained the newer edit, but unconditional legacy settlement repainted the
  browser with the obsolete raw ImgGen source for the full five-second
  assertion. The repair must capture the mutation-intent epoch and verify exact
  live text before applying success or failure projection settlement, including
  edit-away-and-back coverage, without depending on later hydration. The
  reviewer independently passed generation effects 31/31; three parallel
  broader cross-checks found no other demonstrated P1/P2. It made no source
  edits and matched the frozen identity again at the end. Rollout remains
  disabled.
- Sixteenth-review legacy projection repair: compatibility inlay state now
  captures the chat mutation-intent epoch. Both pre-dispatch and post-settlement
  paths require current owner authority, the same message identity and role,
  the unchanged intent epoch, and exact ownership of the placeholder, raw
  source, or resolved final text. A newer hydrated/editor projection and an
  edit-away-and-back race are therefore left untouched; failed or refused
  persistence cannot repaint unrelated text. Focused client suites pass 109/109,
  including provider success/failure after a newer edit, edit-away-and-back, and
  immediate emotion refusal. The reviewer-equivalent rollout-disabled real
  Chromium/Fastify/SQLite fault probe passes with the newer edit retained in the
  browser and SQLite, failed refresh reads, an image-provider HTTP 500, terminal
  effects, and zero stale finalization PATCHes. A combined four-journey browser
  run also preserves the preceding legacy and modern inlay cases. Both
  typechecks, Prettier, and the diff check pass. The complete Phase 3 gate and a
  seventeenth fresh independent closure review remain required; rollout is
  disabled.
- First sixteenth-review-repair Phase 3 `pnpm test:all`: 13 of 14 lanes passed in
  8m2.7s. Frontend passed 9,515 tests/3 skipped, server passed 4,572 tests/3
  skipped, and 164 of 165 browser journeys passed. The new real legacy held-image
  failure/faulted-refresh regression passed, as did the adjacent legacy image
  and modern ordered-inlay cases. The sole failure was the rollout-disabled
  legacy emotion journey: its recorded message PATCH had the exact source body,
  lineage header, and writer-session header, but the assertion observed that
  request record before its response status was attached. The trace and server
  truth require diagnosis before classifying this as product behavior or test
  synchronization. This failed run is not acceptance evidence; rollout remains
  disabled.
- Legacy compatibility proof synchronization repair: the failed trace contained
  the exact expected message PATCH and SQLite had already committed the emotion
  transform, but the test read its request record before Playwright's response
  event attached status 200 and then closed the context. Twelve parallel focused
  repetitions independently confirmed that every iteration reaching the final
  assertion eventually observed 200; three earlier failures exposed the same
  request-only stream barrier previously repaired in modern inlay tests, where
  an epoch-3 stream returned 409 before the redirected epoch-4 attachment. Both
  legacy emotion and image journeys now wait for a successful 200 stream before
  releasing the provider and poll the exact PATCH response to 200 before keeping
  all existing path, body, header, persisted-output, and no-modern-inlay-route
  assertions. No UI action or mutation is retried. Sixteen parallel focused
  repetitions pass, as do server/browser typechecking, Prettier, and the diff
  check. A new complete gate remains required; rollout is disabled.
- Final sixteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  7m55.5s. Frontend passed 9,515 tests/3 skipped, server passed 4,572 tests/3
  skipped, and browser smoke passed all 165 journeys. Server/browser and client
  typechecks, topology, current documentation, compatibility registers and
  harness, Realm scale, the production smoke build, UI coverage, formatting,
  and performance gates all passed. This exact runtime/test tree is ready for a
  seventeenth fresh independent GPT 6 Astra High closure review. Phase 3 remains
  unaccepted and production rollout remains disabled until that review is clean.
- Seventeenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 89 tracked diffs at SHA-256
  `379df2ed1811769e0c2dcccb488c95ecf0f00c4fd2139e132429269de98e8960`,
  all three untracked source hashes, the untracked manifest
  `a72ca01ea4f7b9147a039dcbe4307889777b49e53d2a955d277ac5fa1e875230`,
  and combined changed-content manifest
  `2773c293cafed809ddf894eef9bf01da16d1a5091bb6045bc4d9300d5dfc0a0b`
  at both start and end. It rejected Phase 3 with one P2 ordering defect,
  reproduced twice through real Chromium, Fastify, and disposable SQLite. If
  generated translation settles while the live owner's inlay-preparation PUT is
  awaiting its server acknowledgement, scoped recovery cannot see a durable
  preparation marker and may claim and commit IGP against the raw inlay source.
  The later preparation then becomes stale, leaving the raw emotion marker plus
  the IGP result permanently committed. Recovery must respect a page-local
  preparation throughout its acknowledgement window and preserve translation →
  inlay → IGP ordering. The review's cumulative cross-check found no other
  confirmed P1/P2, 157 focused tests passed, no repository files were edited,
  and rollout remains disabled.
- Seventeenth-review live-preparation ordering repair: the page-local active
  preparation registry is keyed by the full accepted ledger reference and now
  fences recovered IGP even before the server exposes a durable preparation ID.
  Recovery checks that gate both before hydrating the group and immediately
  before the IGP claim. Registration retirement is idempotent and schedules one
  refreshed scoped pass after success, refusal, transport failure, or
  supersession, so a retained group does not require reload while unrelated
  operations and durable restart recovery remain unaffected. Focused client
  suites pass 107/107. Four real Chromium/Fastify/SQLite journeys pass, including
  the exact held-preparation/held-translation race: no early IGP claim occurs;
  the stable preparation retry settles inlay before IGP; the final transcript is
  `Reply {{emotion::happy}} [accepted IGP snapshot]`; each provider runs once;
  every effect terminalizes; and occupancy releases successfully. Both
  typechecks, the smoke build, targeted Prettier, and the diff check pass. A new
  complete Phase 3 gate and fresh independent closure review remain required;
  rollout is disabled.
- Final seventeenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m3.7s. Frontend passed 9,519 tests/3 skipped, server passed 4,572 tests/3
  skipped, and browser smoke passed all 166 journeys. Server/browser and client
  typechecks, topology, current documentation, compatibility registers and
  harness, Realm scale, the production smoke build, UI coverage, formatting,
  and performance gates all passed. This exact runtime/test tree is ready for an
  eighteenth fresh independent GPT 6 Astra High closure review. Phase 3 remains
  unaccepted and production rollout remains disabled until that review is clean.
- Eighteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 89 tracked diffs at SHA-256
  `15ac178bd428c3f43f055e3803bf297c02eb64c3d668f6ce457cac1aad7f6d22`,
  all three untracked source hashes, the untracked manifest
  `a72ca01ea4f7b9147a039dcbe4307889777b49e53d2a955d277ac5fa1e875230`,
  and combined changed-content manifest
  `d250e1464887cb8ad15718b956d5d513469efdff9426b9bcc9d7ff286b0583e3`
  at both start and end. It rejected Phase 3 with one P2 lifecycle defect,
  reproduced twice through real Chromium, Fastify, and disposable SQLite. After
  the image provider completed, a held native asset upload survived general-
  owner transfer and exact-session normalization; the live terminal awaited the
  unbounded post-provider transport before checking lost authority or retiring
  its active preparation. Fresh recovery therefore kept the preparation and IGP
  pending, performed no abandonment or claim, and release returned
  `chat_occupancy_recovery_blocked`. The preparation request's own 30-second
  timeout was separately proven to retire correctly, but the later asset upload
  has no application deadline or cancellation signal. The repair must bound or
  cancel post-provider settlement on supersession, retire the exact preparation,
  and fence late callbacks. The review passed 161 focused tests, found no other
  confirmed P1/P2, made no repository edits, and left rollout disabled. Its
  controlled transport hold does not establish how long every browser/network
  stack would wait naturally; the source nevertheless makes recovery depend on
  that response or reload.
- Eighteenth-review post-provider settlement repair: modern accepted-operation
  image inlays now give only their post-provider asset upload and catalog work a
  scoped cancellation signal and 30-second deadline. Running providers retain
  the preceding transient-normalization behavior. After a provider returns, the
  exact accepted owner occupancy row defers cancellation during general-owner
  transfer; owner-to-chat-only normalization then aborts settlement immediately.
  Every late upload boundary checks cancellation before advancing cached
  revisions, catalog state, projection, or durable finalization. The continuation
  is consumed, the exact server preparation is abandoned, the local registration
  retires, and refreshed recovery terminalizes the remaining authorized effects.
  General and rollout-disabled legacy asset uploads remain unchanged. Eight
  focused files pass 188 tests. Five real Chromium/Fastify/SQLite journeys pass:
  the held-upload race dispatches each provider/upload once, performs no early
  IGP or stale inlay finalization, terminalizes every effect, and releases
  directly without reload; three ordering races and both legacy inlay paths also
  remain green. Both typechecks, the smoke build, Prettier, and the diff check
  pass. Cancellation cannot undo asset bytes already committed before a lost
  response, but later catalog/transcript callbacks remain fenced. A new complete
  Phase 3 gate and fresh independent closure review remain required; rollout is
  disabled.
- Final eighteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m16.2s. Frontend passed 9,524 tests/3 skipped, server passed 4,572 tests/3
  skipped, and browser smoke passed all 167 journeys. Server/browser and client
  typechecks, topology, current documentation, compatibility registers and
  harness, Realm scale, the production smoke build, UI coverage, formatting,
  and performance gates all passed. This exact runtime/test tree is ready for a
  nineteenth fresh independent GPT 6 Astra High closure review. Phase 3 remains
  unaccepted and production rollout remains disabled until that review is clean.
- Nineteenth Phase 3 closure review: a fresh GPT 6 Astra High reviewer matched
  baseline `bf32c875f`, all 92 tracked diffs at SHA-256
  `e5f850019b6296f75e69634e9c05f9773d9c6537dea2ff26b5653a6294aee630`,
  all three untracked source hashes, the untracked manifest
  `19e11b5e41c8bd3f1f33f3c9009e97d2f2df5a6f04158b0c1e955ff71dd64b71`,
  and combined changed-content manifest
  `d100e98481b85ee12cd62f77f6074174bf97f0bfb46bc173c7abad7b4a850264`
  at both start and end. It rejected Phase 3 with one P2 multi-image composition
  defect. A single settlement deadline begins after the first ImgGen provider
  returns, while its shared signal is also passed into later provider calls.
  With unchanged authority, a fast first image can therefore exhaust that
  30-second deadline while a second provider is legitimately running, abort the
  second provider, and abandon the whole preparation with raw source tags. The
  production-function probe used a real localhost WebUI-style provider/native
  fetch plus deterministic timer advancement and observed two provider requests,
  one completed upload, and the second fetch aborted by the settlement timeout.
  Post-provider work needs an independent bound for each image, separate from
  sibling provider lifetime, while preserving supersession cancellation and late-
  write fences. The reviewer passed 186 focused tests, reconciled two read-only
  cross-checks without another confirmed Phase 3 blocker, made no repository
  edits, and left rollout disabled. The defect was not reproduced through a full
  Chromium journey; its production functions and native transport were exercised
  directly.
- Nineteenth-review per-image settlement repair: provider lifetime is now
  governed only by exact-operation supersession, while every returned image
  receives an independent 30-second encode, asset-upload, and catalog
  continuation deadline. Completing or timing out one image therefore cannot
  abort a later sibling provider. Terminal failure still fences active and
  future persistence callbacks, consumes late resolutions, abandons the exact
  durable preparation, and releases scoped recovery without weakening
  definitive supersession or the transient owner-normalization exception. Eight
  focused files pass 191 tests. A real Chromium/Fastify/SQLite mixed-syntax
  journey held the second provider across the first image's former 30-second
  deadline, observed no early abandonment or finalization, then persisted both
  distinct inlays and terminalized every effect after release. The prior held-
  upload, held-preparation, translation/inlay/IGP ordering, and rollout-disabled
  legacy journeys also pass. Both typechecks, the smoke build, Prettier, and the
  diff check pass. A new complete Phase 3 gate and twentieth fresh independent
  closure review remain required; rollout is disabled.
- Final nineteenth-review-repair Phase 3 `pnpm test:all`: passed all 14 lanes in
  8m21.3s. Frontend tests, server/browser and client typechecks, topology,
  current documentation, compatibility registers and harness, Realm scale, the
  production smoke build, UI coverage, formatting, and performance gates all
  passed. Server tests passed 4,572 tests/3 skipped, and browser smoke passed all
  168 journeys, including the 31-second mixed-image regression inside the full
  parallel run. This exact runtime/test tree is ready for a twentieth fresh
  independent GPT 6 Astra High closure review. Phase 3 remains unaccepted and
  production rollout remains disabled until that review is clean.
- Twentieth Phase 3 closure review and acceptance: a fresh independent GPT 6
  Astra High reviewer inspected the complete cumulative Phase 3 tree read-only
  against baseline `bf32c875f`. It matched all 92 tracked paths at binary-diff
  SHA-256
  `4f0c81f9d3320a4d936e3c5f4103d5e00e9b381ab94a1b3b9bf85f1777c1cfb4`,
  the three supplied untracked file hashes, and untracked manifest
  `d299a02165a48ef238b16b8435ae3377e39d657acbcd655d28afdeca2674a746`
  at both start and end. It accepted Phase 3 with no actionable P1/P2 findings.
  The review independently passed 155 focused tests, `git diff --check`, and the
  real Chromium/Fastify/SQLite mixed-image journey across its 31-second hold;
  both images persisted, every effect terminalized, and occupancy released.
  The reviewer confirmed the repaired independent per-image settlement bounds
  preserve provider lifetime, supersession fencing, compatibility, and
  recovery. It relied on the supplied 14-lane full-suite result rather than
  rerunning that complete gate. Browser providers were deterministic and local;
  external-provider behavior and physical-device eviction remain explicit Phase
  4 evidence limits. Phase 3 is accepted for commit. Production rollout remains
  disabled until Phase 4.

## Status Update Contract

After each bounded slice, update the next action and record changed boundaries,
source identity, focused evidence, failures, and unresolved work. At phase
acceptance add full-suite results, reviewer identity/reference, each finding's
resolution, evidence limits, and phase commit/handoff reference. A discovered
blocker changes the cursor; it never changes a failed check into a pass.
