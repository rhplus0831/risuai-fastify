# Browser State Sync and Recovery

This topic is primarily core protection. The retained tests exercise real
IndexedDB/WebCrypto or boundary-visible state; Phase 5 removed orchestration
suites built on repository-module mocks.

## Bootstrap and ownership

`src/ts/bootstrap.test.ts`, `src/ts/bootstrap.resourceEvents.dom.test.ts`,
`src/ts/server/connectedTabIdentity.test.ts`, and
`src/ts/server/activeWriterSession.test.ts` cover bootstrap, identity, takeover,
and replacement events. `server/fastify/__tests__/stateInitializeRace.core.test.ts`
guards concurrent first-run initialization at the Fastify/SQLite boundary.

## Durable outbox and replay

`src/ts/server/pendingMutationOutbox.test.ts`,
`src/ts/server/pendingMutationReplay.test.ts`, and
`src/ts/server/durableMutationDispatch.test.ts` protect encrypted intent,
dependency blocking, replay, and dispatch. Visible rollback is proven by
`server/fastify/browser-smoke/durableMutationRecovery.spec.ts`.

## Resource coherence and drafts

`src/ts/server/resourceCache.test.ts`,
`src/ts/server/resourceInvalidation.test.ts`,
`src/ts/storage/database.resourceState.test.ts`, and
`src/ts/server/writerDraftRecovery.test.ts` cover cache hashes, coherent
revisions, projections, and writer-loss drafts.

## Browser recovery journeys

Core lineage and authority recovery live in
`server/fastify/browser-smoke/coreLineage.spec.ts` and
`server/fastify/browser-smoke/coreOwnership.spec.ts`. Extended recovery depth is
kept in `server/fastify/browser-smoke/resourceHydrationRecovery.spec.ts`,
`server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts`, and
`server/fastify/browser-smoke/visibleStateRecovery.spec.ts`.

## Primary inventory

- Core client: `src/ts/server/pendingMutationOutbox.test.ts`, `src/ts/server/pendingMutationReplay.test.ts`, `src/ts/server/resourceInvalidation.test.ts`.
- Core browser: `server/fastify/browser-smoke/coreLineage.spec.ts`, `server/fastify/browser-smoke/coreOwnership.spec.ts`.
- Extended browser: `server/fastify/browser-smoke/connectedWriterSwitching.spec.ts`, `server/fastify/browser-smoke/connectedReaderRollout.spec.ts`.
