# Domain Mutations and Editing Owners

Phase 5 retains mutation coverage where a test observes durable state, returned
data, or visible rollback. Split command files that repeated the core command
suite and mocked bridge orchestration tests were removed.

## Client mutation owners

`src/ts/characterCommands.test.ts` and
`src/ts/chatCommands.messages.dom.test.ts` are core client rollback owners.
`src/ts/server/characterDraft.svelte.test.ts` preserves dirty fields across
authoritative refresh. `src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts`
and `src/ts/process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts`
guard live-owner replacement during access confirmation.

## Server command owners

The core command contract is concentrated in
`server/fastify/__tests__/commands.test.ts` and the surviving domain owners:
`server/fastify/__tests__/commands.messages.test.ts`,
`server/fastify/__tests__/commands.lorebooks.test.ts`,
`server/fastify/__tests__/commands.modelProfiles.test.ts`,
`server/fastify/__tests__/commands.scripts.test.ts`, and
`server/fastify/__tests__/commands.coldStorage.test.ts`.

## Receipts, narrowing, and visible recovery

`server/fastify/__tests__/commandMutationReceipts.test.ts`,
`server/fastify/__tests__/commandMutationReadNarrowing.test.ts`, and
`server/fastify/__tests__/commandMessageFreeCeiling.test.ts` protect replay and
narrow writes. `server/fastify/browser-smoke/durableMutationRecovery.spec.ts`
proves visible rollback, while `server/fastify/browser-smoke/coreLifecycle.spec.ts`
proves exact-id chat and message mutations in Chromium.

## Primary inventory

- Core client: `src/ts/characterCommands.test.ts`, `src/ts/chatCommands.messages.dom.test.ts`.
- Core server: `server/fastify/__tests__/commands.test.ts`, `server/fastify/__tests__/commandMutationReceipts.test.ts`.
- Core browser: `server/fastify/browser-smoke/durableMutationRecovery.spec.ts`, `server/fastify/browser-smoke/coreLifecycle.spec.ts`.
