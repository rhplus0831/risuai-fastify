# Phase 2: Chat-Only Interaction

Dependency: Phase 1 accepted and committed. Primary boundaries: B02-B05,
B07-B08, B10. Read [PLAN.md](../PLAN.md) and [status](../status.md).

## Outcome

A connected chat-only device can browse locally, occupy an existing configured
chat, send, view its reply, use Reroll, and use Stop while another device sends
elsewhere. Observers keep the read experience. The feature remains unreleased
until Phase 3 recovery/effect work and Phase 4 integration are accepted.

## Work

### 2a. Scoped capabilities and UI

- Add per-chat admission/readiness without granting general write capability.
  Keep role and occupancy separate through bootstrap, owner events, and UI.
- Extend the existing reader workspace with clear available/occupied/self-owned
  states, claim/release feedback, and read-only observation. Local selection
  and navigation must not dispatch owner commands or alter `lastInteraction`.
- Retain the current occupancy across navigation and observation. Before a
  mutating interaction in another chat, require a clear explicit switch from the
  one currently occupied chat and reconcile any accepted work safely.
- Bind controls and their handlers, shortcuts, drops, and delayed continuations
  to the captured chat and occupancy. Follow the Phase 0 interaction disposition.
- Preserve the existing general-owner acquisition preference independently.
  Add localized strings in the existing language packs.

### 2b. Send pipeline

- Split send maintenance: forbid general writes while retaining explicitly
  required chat-local preparation. Use authoritative configured settings;
  owner-only editor flushes must not run on the chat-only device.
- Reuse protocol operation submission, optimistic accepted-send reconciliation,
  global revision retry, and stream handling with captured occupancy authority
  for both send and the required Reroll path.
- Apply the server's side-effect restrictions to browser callbacks as well.
  Do not enable the general plugin runtime solely to make readiness pass.
- Add scoped staging and immediate settlement needed for sends, Reroll, and Stop
  now; do not defer basic durable intent safety to a later exposed interface.

### 2c. Independent observation and owner continuity

- Keep canonical transcript hydration, stream projections, and command echoes
  distinct. Foreign writes must not steal selection or duplicate a user row.
- Ensure observer detach does not Stop generation or claim completion effects.
- Preserve owner authoring and unrelated-chat generation while another device
  occupies a chat. Show server rejections honestly rather than claiming success.

## Evidence and Exit Criteria

- Real separate browser sessions prove T01 normal-path sending and T02/T03
  containment, with persisted user/result identity and shared-state assertions.
- T04 proves independent browsing through foreign events and refresh.
- Focused UI/send-context tests prove capability handling, forbidden maintenance,
  and selected chat freshness; T08/T11 cover owner continuity and mobile controls.
- Basic Reroll, Stop, and accepted/queued/failed UI work without general write
  authority. Continue and regenerate are visibly deferred in chat-only mode.
- Other unsupported interactions are explicitly gated and cannot leak through
  handlers.

Use the Phase 0 test map and existing accepted-send/reader-generation browser
harnesses. Finish with the
[mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate) and commit.
