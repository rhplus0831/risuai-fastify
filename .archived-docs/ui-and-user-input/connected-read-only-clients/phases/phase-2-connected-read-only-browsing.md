# Phase 2: Connected Read-Only Browsing

Dependency: Phase 1 accepted. Progress belongs in [status](../status.md).

## Outcome and Owners

A client can start and remain a reader, navigate supported conversations, and
receive committed changes without taking ownership or persisting selection.
Writer-to-reader transition with pending edits is completed in Phase 3; this
phase's reader startup must never bypass those recovery requirements.

Primary inventory owners: B02, B04–B06, B10, B13–B14. Read
[resource hydration](../../../../docs/structure/server-resources-and-bridges.md) and
[event recovery](../../../../docs/structure/durable-mutations-and-recovery.md#event-invalidation-and-recovery).

## Bounded Slices

### 2a. Observer startup and synchronization

- Establish authenticated read-only bootstrap, coherent shell hydration, and an
  event subscription without acquiring writer ownership. Preserve first-run and
  still-owning-session startup branches from the product contract.
- Separate subscription success from writer readiness. A foreign writer frame
  updates the reader's role information instead of invoking the old takeover
  dialog or stopping the stream.
- Keep command-event reconciliation, targeted reads, replay-gap refresh, cache
  fences, and lifecycle reconnect working in observer mode. Reconnect must not
  trigger outbox replay, receipt writes, finalization retry, or writer bootstrap.
- Keep known/applied revision roles correct; a loaded shell is not evidence that
  later events or resources were applied. Preserve ordering while a read is in
  flight and while the browser has missed more than the replay window.
- Audit replacement/resync helpers before sharing them with readers:
  `src/ts/server/replacementDatabaseOwnership.ts` also prepares outbox ownership
  and resets mutation owners. An observer refresh must not adopt write scope;
  a writer-epoch change alone must not run destructive lineage-reset behavior.

### 2b. Local selection and readable transcript

- Make observer character/chat navigation local to the client. Cover sidebar,
  direct links, browser history, notification navigation, and shared selection
  refreshes. Hydrate the selected stable IDs without dispatching selection,
  last-interaction, creation, or script mutations.
- Render the conversation with existing supported display behavior, history
  loading, copy, scroll anchoring, and responsive layout. Keep mutation controls
  and unsupported authoring routes gated by Phase 1.
- When the writer changes selection, keep the reader on its own conversation.
  When the selected resource is deleted, use a safe local fallback and explain
  the change. No repair/default-selection write may originate from the reader.

### 2c. Recovery and visible status

- Show connected read-only separately from interrupted/retrying connectivity.
  Keep usable last-known content while a read fails; do not claim freshness or
  clear selection merely because an optional resource failed.
- Handle auth loss and database replacement through their existing stronger
  reset boundaries. Superseded reads cannot repopulate cleared state.
- Display persisted generation and translation results through read updates.
  Full live generation attachment waits for Phase 4; do not start writer recovery
  effects as a shortcut to obtaining job status.
- Apply reader-safe memory/BardWiki job snapshots and live updates where the
  observer surface exposes them; gate the remaining controls. Preserve their
  stream/version ordering separately from command revisions, refresh from the
  reconnect snapshot, and stop old consumers on role/auth/lineage teardown.

## Exit Criteria and Proof

- With two separate sessions, one writer mutates a conversation and the reader
  visibly receives the committed result while its mutation request count stays
  zero. Opening/reloading/focusing the reader leaves the writer unchanged.
- The reader browses another conversation without changing either the server's
  persisted selection or the writer's displayed selection. Foreign selection
  events and full refreshes do not navigate the reader.
- Late reads, reconnect, an unavailable replay cursor, deleted selected data,
  auth loss, and lineage replacement recover without stale projection or writes.
- A reader receiving the initial and subsequent foreign-writer frames keeps
  its read subscription and remains read-only. Commit while replay transitions
  to live delivery: no update is lost or applied twice. Reconnect uses the last
  applied cursor, not a newer known-server cursor whose resources are pending.
- Slow-consumer overflow releases the server subscription and permits bounded
  recovery. Memory/BardWiki reconnect snapshots supersede older progress without
  advancing the domain cursor or triggering operational mutations. Reuse the
  existing server stream tests where they already prove the transport contract.
- Reading/history/copy work through the real UI with a disabled composer and
  clear status. Verify browser history and mobile-sized layout as applicable.

Extend event/bootstrap/hydration and route/UI tests from the inventory. Execute
an actual two-session browser scenario using the server writer snapshot and
command observations; manually assigning observer state does not prove startup.
