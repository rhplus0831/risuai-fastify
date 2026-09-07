# Phase 3: Explicit Writer Switching

Dependency: Phase 2 accepted. Progress belongs in [status](../status.md).

## Outcome and Owners

**Use this device** transfers writer ownership in place. The old writer becomes
a connected reader, and both clients retain correct data and local recovery
state. The server guard remains the authority under concurrent requests.

Primary inventory owners: B02–B04, B07–B08, B11, B13. Read
[durable mutation recovery](../../../../docs/structure/durable-mutations-and-recovery.md)
and [auth/writer policy](../../../../docs/structure/data-and-events.md#auth-and-active-writer).

## Bounded Slices

### 3a. Demotion and pending-edit preservation

- On an authoritative foreign writer event or a genuine stale-writer response,
  revoke writes synchronously. Capture recoverable local drafts before editor
  teardown and stop writer dispatch/replay/flush/effect services.
- Preserve observer reads and reconciliation. A role transition may replace an
  event subscription under an epoch fence, but must not leave a frozen page or
  leak subscriptions/timers. Do not await a takeover dialog to admit reading.
- Distinguish unsent drafts, staged intent, in-flight requests, accepted work
  awaiting acknowledgement, and terminal rejection. Park inactive intent and
  separate optimistic overlays from authoritative reader projections without
  deleting the intent or applying an old rollback over newer server data.
- Allow late receipts to settle their exact mutation identity without reopening
  write capability. Preserve newer drafts and same-origin other-tab ownership.
  Account for editor debounces and pagehide events arriving during demotion.
  Local acceptance bookkeeping may finish; any server receipt acknowledgement
  that requires writer authority remains deferred until authorized recovery.

### 3b. Promotion coordinator and UI

- Wire one explicit promotion operation to the localized switch affordance.
  Reuse the server takeover confirmation protocol; changing the user-facing
  wording does not require breaking old clients' handshake headers.
- Follow existing owner adoption, lineage/epoch validation, outbox preparation,
  receipt settlement, pending replay, post-recovery resource hydration, and
  current event subscription ordering. Ordinary controls remain disabled until
  all required fences are reinstalled and this operation still owns promotion.
- Guard each await against a newer role/lineage/promotion event. If another
  client wins during promotion, settle back into reading; do not automatically
  claim again. Preserve server serialization and stale-mutation rejection.
- Retained/unreadable current-owner intent may block promotion but must leave
  reading available. Expose recoverable status; do not discard work to force a
  successful switch. Resume local drafts under existing ownership/rebase rules.
- Preserve the chosen reader conversation by stable identity. Persist selection
  only after promotion is accepted, when required by writer behavior.

### 3c. Failure and repeated switching

- Failed promotion removes only partially started writer services and returns to
  a stable reader. Repeated clicks share one request chain and one result.
- Handle switching during a network interruption, delayed bootstrap/command
  response, server restart, or browser resume. A stale response cannot enable
  editing, acknowledge another intent, or restore a prior database projection.
- Keep the old client's draft local and readable/recoverable; the new writer
  does not receive it through an implicit cross-device transfer.

## Exit Criteria and Proof

- Real UI switching A → B → A leaves exactly the server-selected session able
  to commit writes, with the other still receiving updates and no forced reload.
- Simultaneous promotion and repeated clicks converge to server authority without
  an automatic takeover loop. A superseded local success cannot open controls.
- Inject holds before dispatch, after server acceptance but before response,
  during receipt cleanup/replay, and during post-recovery hydration. Assert no
  lost retained intent, duplicate accepted mutation, newer-draft overwrite, or
  rollback of unrelated updates.
- Drafts survive editor unmount and later return. Reader hydration progresses
  despite dormant pending work; failed recovery leaves a usable read-only view.

Use outbox/cross-tab/replay/draft, bootstrap/writer, and server receipt/ownership
tests, plus the UI-driven multi-session browser journey. Cover an active server
generation during takeover for durable-result preservation here; live reader
stream/effect behavior is verified in Phase 4.
