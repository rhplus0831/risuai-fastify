Worklist created (2026-09-21): [Priority Test Review Worklist](TEST-REVIEW-WORKLIST.md)
tracks the 443 selected original inventory entries: all Critical entries plus High
entries rated Frequently or Often. Its canonical JSON maps those entries to current
files and imports the six completed reviews below with prior evidence; 437 entries
remain pending at creation. The historical inventory's ratings and counts are unchanged.

Post-snapshot update (2026-09-20): the original `pendingMutationOutbox.test.ts` coverage is now split across
`pendingMutationOutbox.test.ts`, `pendingMutationOutbox.intent.test.ts`, `pendingMutationOutbox.occupancy.test.ts`,
and `pendingMutationOutbox.projection.test.ts`; its replacement snapshot/work cases moved to
`pendingMutationOutbox.workCosts.svelte-node.test.ts`. The historical counts and rankings below describe the
snapshot, not these new file boundaries. See [Browser State Sync and Recovery](tests/browser-state-sync-and-recovery.md)
for current coverage ownership.

Post-snapshot bootstrap update (2026-09-20): the original `src/ts/bootstrap.test.ts` suite
now has **249 cases across 11 files**, including two new memory-rejection and writer-lineage
regressions. See [Bootstrap coverage ownership](tests/browser-state-sync-and-recovery.md#bootstrap-coverage-ownership)
for current file names and counts. The row below retains the historical 247-case scope and ranking.

Post-snapshot command update (2026-09-21): the original
`server/fastify/__tests__/commands.test.ts` coverage now has **247 cases across 20 files**.
The core transaction/initialization cases remain in `commands.test.ts`; domain cases moved
to focused files, with three independent message-finalization rejection cases added and
message write-isolation assertions strengthened. See [Command coverage ownership](tests/persistence-commands-and-events.md#command-coverage-ownership).
The row below retains the historical 244-case scope and ranking.

Post-snapshot chat command update (2026-09-21): the original `src/ts/chatCommands.test.ts`
coverage now has **232 cases across eight files**. Sequence-wrapper cases remain in the original file;
metadata, organization, generation settings, messages, notes/scriptstate, imports, and durable batches
have focused suites. Independent metadata expectations, awaited duplicate-edit outcomes, and a true
mid-sequence rejection strengthen the existing cases, with one new `sdData` dispatch regression.
See [Chat command coverage ownership](tests/domain-mutations-and-editing-bridges.md#chat-command-coverage-ownership).
The row below retains the historical 231-case scope and ranking.

Post-snapshot browser command update (2026-09-21): the original `src/ts/server/commands.test.ts`
coverage now has **167 cases across 21 files**. Transport, readiness, response decoding, and
revision cases remain in the original file; queue, replay, and domain adapters have focused suites.
Writer headers, receipt ACK routing, and complete prompt-item effects are now asserted. The six
malformed compact-settings variants run independently with acknowledgement enabled, alongside
an exact-receipt control. See [Browser command coverage ownership](tests/browser-state-sync-and-recovery.md#browser-command-coverage-ownership).
The row below retains the historical 161-case scope and ranking.

Post-snapshot chat hydration update (2026-09-21): the original `src/ts/server/chatMessageHydration.test.ts`
coverage now has **125 cases across six files**. All 105 original cases remain represented, with 18 new
identity/concurrency/reset regressions and two additional registered cases from separating bulk retry
and strict-failure scenarios. Reader handoff, freshness, bulk reads, accepted-send completion, and
character lorebooks have focused suites. See [Chat hydration coverage ownership](tests/browser-state-sync-and-recovery.md#chat-hydration-coverage-ownership).
The row below retains the historical 105-case scope and ranking.
