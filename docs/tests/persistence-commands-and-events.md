# Persistence, Revisioned Commands, and Events

The surviving persistence suite uses real SQLite and Fastify boundaries. Phase 5
removed redundant split command suites, source ownership checks, and tests whose
oracle was internal call shape.

## Database and migrations

Core database protection lives in `server/fastify/__tests__/db.test.ts`,
`server/fastify/__tests__/databaseInitialization.test.ts`,
`server/fastify/__tests__/legacyDatabaseImport.test.ts`,
`server/fastify/__tests__/messageStore.test.ts`, and
`server/fastify/__tests__/missingDatabaseGuard.test.ts`. Extended defaults and
migration coverage remains in `server/fastify/__tests__/databaseDefaults.test.ts`
and `server/fastify/__tests__/migrationFoundation.test.ts`.

## Command coverage ownership

`server/fastify/__tests__/commands.test.ts` owns transaction and initialization
behavior. Domain core owners are `server/fastify/__tests__/commands.messages.test.ts`,
`server/fastify/__tests__/commands.lorebooks.test.ts`,
`server/fastify/__tests__/commands.modelProfiles.test.ts`,
`server/fastify/__tests__/commands.scripts.test.ts`, and
`server/fastify/__tests__/commands.coldStorage.test.ts`.

## Revision, receipts, and events

`server/fastify/__tests__/commandMutationReceipts.test.ts`,
`server/fastify/__tests__/commandMutationReadNarrowing.test.ts`,
`server/fastify/__tests__/commandMessageFreeCeiling.test.ts`,
`server/fastify/__tests__/durableDeleteIdempotency.test.ts`, and
`server/fastify/__tests__/events.test.ts` guard narrow durable writes and event
publication. `server/fastify/__tests__/repositoryWriterKit.test.ts` is retained
extended coverage for writer primitives.

## Browser cross-reference

Client dispatch/replay is mapped in [Browser State Sync and Recovery](browser-state-sync-and-recovery.md).
Exact-id mutation and restore behavior is exercised by
`server/fastify/browser-smoke/coreLifecycle.spec.ts` and
`server/fastify/browser-smoke/coreLineage.spec.ts`.

## Primary inventory

- Core: `server/fastify/__tests__/commands.test.ts`, `server/fastify/__tests__/commandMutationReceipts.test.ts`, `server/fastify/__tests__/events.test.ts`.
- Extended: `server/fastify/__tests__/repositoryWriterKit.test.ts`, `server/fastify/__tests__/greetingTranslationStore.test.ts`.
