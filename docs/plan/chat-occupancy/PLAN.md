# Chat Occupancy and Chat-Only Devices

Date: 2026-09-14.

Start at [status](status.md) for the execution cursor, then read the active
[phase](phases/README.md). [Inventory](inventory.md) maps source boundaries and
required behavioral evidence. This document defines intended behavior; current
source and [architecture guides](../../structure/README.md) describe shipped
behavior until implementation lands.

## Objective

Enable two or more authenticated devices on one server to send messages in
different chats while retaining one owner for general application writes.

Retain the current single active writer as the general **owner**. Introduce
exclusive **occupancy** for each chat. Upgrade the connected reader experience
to **chat-only** access: a device may browse and observe, or occupy a chat and
interact with it, without gaining general write authority.

This is a scoped permission and lifecycle change. It does not introduce multiple
general owners, collaborative editing of the same chat, a new database engine,
an offline authoritative database, or a general merge/rebase framework.

## Document Ownership

- `PLAN.md`: stable scope, permissions, lifecycle invariants, decisions to settle,
  acceptance policy, and release criteria.
- [status.md](status.md): the only execution ledger; current phase/slice, next
  action, decisions, findings, evidence, blockers, and phase commit references.
- [inventory.md](inventory.md): source/test boundaries and required proof IDs.
- [phases](phases/README.md): bounded work, dependencies, and exit criteria.

Do not duplicate progress checklists in phase files. Add slice documents only
when a concrete handoff needs them. Writing this package does not execute or
accept Phase 0 and does not start runtime implementation.

## Agreed Product Contract

1. Exactly one general owner may perform settings, character, module, and other
   general application writes under the existing owner policy.
2. A chat has at most one occupying client session. Every other client,
   including the general owner, is prevented from modifying that occupied chat.
3. A chat-only device may occupy an available chat, send messages there, control
   its permitted generation work, or remain an observer. Reading or subscribing
   does not occupy a chat.
4. Chat-only devices cannot update `lastInteraction`, persisted global/character
   selection, shared settings, character definitions, modules, or plugin storage.
   Their navigation uses local presentation state.
5. General ownership, chat occupancy, authentication, connection health, and
   resource readiness are separate dimensions. Gaining or losing general owner
   status does not implicitly gain or revoke chat occupancy.
6. Occupancy is enforced on the server, including indirect mutations and delayed
   requests. UI disabling alone is insufficient.
7. Accepted server generation and its durable result must not be lost merely
   because a browser disconnects, hides, reloads, or loses general owner status.
8. Preserve `accepted`, `queued`, and `failed` outcomes, originating-session
   drafts, mutation identity, and database-lineage protections.
9. A chat-only client session may occupy at most one chat. Navigation does not
   release that occupancy, and observing another chat does not switch it. A
   mutating interaction in another chat requires an explicit occupancy switch.

An owner occupies a chat for the same conversational operations as a chat-only
device. Existing owner administrative operations on an unoccupied chat can
retain their authority, but must check that the affected chat has not become
foreign-occupied before committing. An explicit administrative handoff must
first resolve occupancy; owner authority is never an implicit bypass.
The one-chat-per-session limit applies to chat-only admission, not to the active
owner: preserve the owner's existing ability to run generation concurrently in
different chats that it occupies. A later owner demotion does not revoke those
occupancies or already accepted work, but new chat-only intent waits for an
explicit normalization to one retained occupancy. That atomic normalization
examines every occupancy held by the session, releases every nonselected idle
row regardless of its original claim class, and fails without changes if any
nonselected row is pinned.

Preserve the existing automatic general-owner acquisition preference and its
conditional connected-writer protection. Occupying, sending, or viewing a chat
must not trigger an additional general-owner acquisition. If existing startup
or foreground policy promotes a device, only its general-owner role changes;
occupancy remains independent. Test the preference enabled and disabled.

## Bounded Release Scope

The required end-to-end result is independent browsing and sends in existing,
configured chats, streamed replies, Reroll, Stop, observation, reload/reconnect,
and recovery of uncertain submissions and accepted results. Prove both owner
plus chat-only operation and two chat-only senders while a third device remains
owner.

General authoring stays owner-only. Reuse the current SQLite transactions,
globally ordered revisions/events, targeted chat persistence, operation IDs,
per-chat live-generation constraint, and browser command queue where possible.
Generation submit already has bounded revision-conflict retries; validate that
behavior before changing revision granularity. Owner command conflicts retain
their existing honest failure/recovery semantics. Do not add blind retries to
replacement commands to make concurrency tests pass.

Reroll is required in the first chat-only release and must receive the same
occupancy, durable-operation, and recovery treatment as send. Continue and
regenerate are deferred from the first chat-only release; keep them visibly
unavailable there until a later supported disposition, without removing the
owner's existing functionality. Additional chat interactions still need an
explicit Phase 0 disposition: message editing/deletion, chat generation settings,
chat creation/forking, attachments, translation, memory controls, input hooks,
IGP, TTS, emotion/image effects, and plugin callbacks. These are not silently
granted by occupancy, nor silently removed from the owner's existing
functionality. Classify each as required for the core send lifecycle, safely
supported under occupancy, owner-only, or visibly unavailable in chat-only mode.
Any proposed restriction that materially prevents the agreed send use case is a
scope issue, not an implementation shortcut.

## Authority and Persistence Design

### Occupancy identity

Use a server-authoritative tuple containing database lineage, chat identity,
occupying session, and a monotonically changing occupancy epoch or equivalent
fencing token. It is separate from the existing general-owner epoch. Phase 0
fixes the exact schema and wire vocabulary; avoid mass renaming legacy internal
`writer` symbols solely for terminology.

- Claim and handoff are conditional and atomic. Concurrent claims have exactly
  one winner; absence of a reply is not proof of success or a free chat.
- Authenticate requests and resolve their real target chat from stored message,
  operation, job, or effect identity. Do not trust a caller-supplied chat ID that
  disagrees with that target.
- Validate occupancy at the mutation transaction boundary. Recheck after
  asynchronous preparation when authority or lineage could have changed.
- Old release, renewal, queued writes, and callbacks cannot affect a newer
  occupancy, including when the same session returns after another occupant.
- Duplicate tabs must not share write authority accidentally. Reuse the existing
  exclusive tab-identity mechanisms and prove reload versus duplicated-tab cases.

### Accepted work and release

Browser occupancy admits new intent. An accepted server operation retains its
own durable authority to finish its already-authorized chat-local work under
the current lineage and operation/attempt fences. Do not require a live browser
connection to persist its result.

Do not make a chat writable by a new occupant while incompatible accepted work
or finalization can still modify it. The proposed first-release rule is to defer
release/handoff until such work settles, or require an explicit Stop followed by
acknowledged terminal reconciliation. Server restart must not leave an immortal
occupancy or permit stale work to write into a newly assigned chat.

Disconnect expiry and crash recovery must account for both client presence and
durable operations; an SSE disconnect alone is not permission to discard work.
Phase 0 chooses the lease/presence timeout and reclaim protocol with deterministic
tests. Navigation away retains occupancy. Browsing or observing another chat does
not switch occupancy; attempting a mutating interaction there requires an
explicit, safely reconciled switch from the currently occupied chat.

### General owner and indirect writes

Occupancy checks cover direct message/chat writes and parent or whole-database
operations that can rewrite, move, reset, or delete an occupied chat. Inventory
character deletion, all-chat reset, folders/reorder, import/restore, broad
repository write-back, and server background writers. Resolve affected chats
before commit; a route-family exemption must not become a bypass.

Reject an entire deletion, reset, or restore operation when its affected scope
contains any occupied chat; do not partially apply it. The rejection must
identify the conflicting chats and explain how to release them safely. Other
parent/global mutations still require an explicit preserve-or-reject disposition.

General settings and character-definition edits remain owner-only. Define how
their accepted changes become inputs to subsequent generation and how an
in-flight operation retains its validated configuration. Do not lock the whole
application simply because any chat is occupied. Broader physical row rewrites
must either preserve occupied data exactly or be blocked for that operation.

### Send side effects

Split general send maintenance from chat-local preparation. In particular,
chat-only sending must not issue or optimistically apply a character
`lastInteraction` update. Message-ID repair and required prompt/chat metadata
need their own scoped disposition rather than blindly skipping all maintenance.

Enforce the same permission boundary inside server prompt assembly, triggers,
finalization, and browser completion work. Running a script on the server does
not authorize shared character/settings writes on behalf of a chat-only sender.
Inventory effects before dispatch where possible; unsupported behavior must be
reported explicitly, with no partial forbidden mutation. Preserve already
accepted transcript/result data when a later optional effect is unavailable.

Persist the permitted mutation scope with accepted operations so later owner
promotion cannot expand it, and later owner loss cannot invalidate authorized
chat-local finalization. Resolve effect claims, renewals, and receipts to the
actual operation/chat. Suppressed effects need a terminal ledger disposition;
they must not remain pending forever or be replayed by the general owner to
circumvent the original chat-only restriction.

### Recovery and events

Keep general and occupied-chat mutation admission distinct. Do not globally
enable `canUseClientWriteAccess()` or general outbox replay for chat-only mode.
Replay only permitted intents for the originating session, lineage, chat, and
validated occupancy. Preserve dormant unrelated/general intent across role
changes; never transfer another device's pending work.

Reacquisition reconciles accepted operation/receipt identity before considering
resubmission. An old unaccepted intent cannot become valid just by replacing its
occupancy token. Define target freshness and user-visible recovery for it.

Continue one global committed-event sequence. Occupancy discovery/events must
recover missed changes without fabricating domain revisions. Foreign chat events
must not steal local navigation, overwrite optimistic messages, duplicate
accepted sends/effects, or demote a valid occupant because the general owner
changed. Auth loss, chat deletion, and lineage replacement remain hard fences.

## Phase 0 Decisions

Settle these in Phase 0 with source evidence, record the decisions in status,
and update this stable contract when the selected behavior changes:

- Occupancy storage, epoch protocol, presence/expiry, reload/restart recovery,
  and release/handoff details. Preserve the decided one-occupied-chat limit for
  each chat-only device, retained occupancy across navigation, observation without
  switching, and explicit switching before another chat is mutated.
- The remaining interaction/effect dispositions from the bounded release scope,
  including source of configuration and unsupported-feature feedback. Reroll is
  first-release required; continue and regenerate are deferred for chat-only mode.
- Which remaining parent/global mutations preserve occupied chats and which
  require rejection or coordinated release. Deletion, reset, and restore reject
  the whole operation when any affected chat is occupied and report the conflicts
  and safe release path; destructive maintenance cannot bypass this.
- The additive wire capability, older-client handling, and safe rollback path.
  A mixed-version client must fail closed for unsupported chat-only writes;
  older owner commands still cannot overwrite foreign-occupied chats.

Resolve routine implementation details using these requirements and evidence.
Escalate a real product tradeoff when the core use case cannot be preserved;
do not invent a new permission checkpoint before every phase.

## Mandatory Phase Completion Gate

The user explicitly authorized this policy for **every phase, including Phase
0**, and phase commits. It supplements [AGENTS.md](../../../AGENTS.md) for this
workstream. Focused checks remain appropriate during implementation; the full
suite is mandatory at phase completion.

1. Finish the phase's implementation/contract work, self-review, required tests,
   current documentation, explicit plan-document checks, and Prettier formatting.
2. Run `pnpm test:all` to completion. Investigate and resolve failures, including
   discovered pre-existing failures where safely actionable. Rerun failed checks
   while fixing, then obtain a passing full run on the resulting code/tests.
   Do not skip, weaken, or relabel a failing lane as success. An external blocker
   or interrupted run leaves the phase unaccepted with evidence in status.
3. **After that passing run**, invoke an independent read-only sub-agent with
   model `gpt-6-astra` and reasoning effort `high` (GPT 6 Astra High). Give it
   the original objective, this plan, active phase, phase baseline, exact current
   diff/source identity, and test commands/results. Use a fresh bounded context
   (`fork_turns: "none"` with the collaboration tool); supply the task context
   explicitly, not only the implementer's conclusions. Do not change the
   reviewed source while the review runs.
4. Have Astra inspect implementation and tests against the user requirement,
   phase acceptance, surrounding architecture, and earlier accepted phases.
   Use [TEST-GUIDELINE.md](../../TEST-GUIDELINE.md) as test-quality guidance.
   Check substantive correctness, authority leaks, recovery/races, missing
   behaviors, and tests whose mocks/assertions cannot detect the claimed bug.
   For Phase 0, inspect the contract/inventory and proposed proof against source;
   do not report nonexistent implementation as reviewed or complete.
5. The implementing agent fixes confirmed findings. Record evidence-based
   dispositions for rejected findings. If code or tests change, rerun focused
   checks and **`pnpm test:all`**, then request Astra review of the corrections
   and affected interactions. Repeat until no actionable finding is unresolved.
   Contract-only corrections require their document checks and Astra recheck;
   code/test evidence remains usable only if its source and assumptions hold.
   Never substitute another model/effort silently if Astra is unavailable.
6. Update status with the accepted boundary, final source identity, full-suite
   evidence, reviewer model/effort and review reference, findings/dispositions,
   any test/environment limits, and the next action. Validate final ledger edits.
7. Commit the completed phase with a conventional title and descriptive body.
   End the message with `Co-Authored-By: Codex <noreply@openai.com>`. Include only
   this phase's changes and necessary documented fixes; preserve unrelated work.
   Record the resulting commit reference in the next status update or handoff
   rather than trying to embed a commit's own hash inside itself.

A phase may span multiple cohesive slices/commits, but its completion commit
requires the gate above. Neither a green suite alone nor a clean review alone
accepts a phase. No repeated user permission is required for the authorized
tests, reviewer, fixes, or phase commits. No publishing or production deployment
is implied by this plan.

The workflow precedent is the implementation task
`01a0991d-e855-7d61-a5ad-c7d82b64dfa1` followed by independent review task
`01a09927-23c1-7c62-8ff0-42e68f3400dd`. Those records demonstrate separate review
and strengthened race tests, not prior execution of this plan's stricter full
suite and exact-model gate.

## Release and Closeout

Phases are sequential. Keep incomplete chat-only behavior behind one coherent
server-advertised rollout boundary until recovery, effect policy, and enforcement
are complete. The ordinary owner path must continue working at every phase.

Release requires all [proof obligations](inventory.md#required-behavioral-proof)
to have explicit test evidence or a justified feature disposition consistent
with the required send use case. Run actual multi-session browser journeys;
parallel jobs submitted by one writer are not proof of multiple authorized
devices. Record provider/physical-device limitations honestly.

Update the current architecture and test guides to describe shipped ownership
and occupancy. Archive the complete package under the corresponding UI/user-input
topic, update active/archive indexes, and validate links at the new location.
The final phase uses the same full-suite, Astra High review, and commit gate.
