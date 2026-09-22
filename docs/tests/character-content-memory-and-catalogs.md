# Character Content, Memory, and Catalogs

Phase 5 removed mocked component tests for character editors, lore/trigger panels,
Hypa modals, and catalogs. Their durable effects are protected at client command,
Fastify/SQLite, and browser-smoke boundaries.

## Character and lore mutations

`src/ts/characterCommands.test.ts` is the core client rollback owner.
`server/fastify/__tests__/commands.lorebooks.test.ts`,
`server/fastify/__tests__/commands.scripts.test.ts`, and
`server/fastify/__tests__/commandMessageFreeCeiling.test.ts` protect sparse
updates and reference cleanup in SQLite.

## Character media and records

Extended client boundary tests remain in
`src/ts/server/characterEmotionUpload.test.ts`,
`src/ts/server/characterTtsAssetUpload.test.ts`, and
`src/ts/server/selectedCharacterRefresh.test.ts`. Protocol record shape is
covered by `packages/protocol/src/characterResource.test.ts` and
`packages/protocol/src/characterSummaryResource.test.ts`.

## Memory, BardWiki, and catalogs

Fastify memory coverage is mapped in [Memory and Embeddings](memory-and-embeddings.md).
BardWiki real-boundary coverage includes
`server/fastify/__tests__/bardWikiLifecycle.test.ts`,
`server/fastify/__tests__/bardWikiVault.test.ts`, and
`server/fastify/browser-smoke/bardWikiLifecycle.spec.ts`. Realm import remains
core in `server/fastify/__tests__/realmImport.test.ts`.

## Primary inventory

- Core: `src/ts/characterCommands.test.ts`, `server/fastify/__tests__/commands.lorebooks.test.ts`, `server/fastify/__tests__/bardWikiLifecycle.test.ts`, `server/fastify/__tests__/realmImport.test.ts`.
- Extended: `server/fastify/__tests__/bardWikiRepository.test.ts`, `server/fastify/__tests__/bardWikiWorker.test.ts`, `server/fastify/browser-smoke/realmProgressConfirmation.spec.ts`.
