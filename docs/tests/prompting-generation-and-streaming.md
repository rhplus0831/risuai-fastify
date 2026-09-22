# Prompting, Generation, and Streaming

Generation is a core-protected product boundary. Retained tests observe provider
input, persisted messages/operations, SSE output, or browser-visible recovery;
mock-heavy stage unit tests were removed in Phase 5.

## Prompt assembly and generation

`server/fastify/__tests__/generation.chat.test.ts` is the primary core owner for
prompt ordering, CBS/lore/trigger behavior, context overflow, memory selection,
and reroll persistence. `server/fastify/__tests__/generationInputLoaders.test.ts`,
`server/fastify/__tests__/generationInputDecoder.test.ts`, and
`server/fastify/__tests__/preflight.test.ts` protect scoped input and validation.

## Durable operations and effects

Core lifecycle coverage lives in
`server/fastify/__tests__/durableGeneration.test.ts`,
`server/fastify/__tests__/generationOperationsStartup.test.ts`,
`server/fastify/__tests__/generationEffects.test.ts`, and
`server/fastify/__tests__/generationFinalizationRetry.test.ts`. Client request and
replay boundaries remain in `src/ts/process/request/tests/durableGeneration.test.ts`
and `src/ts/process/__tests__/streamReplayGap.boundary.dom.test.ts`.

## Streaming and provider wires

`src/ts/process/__tests__/streamResponse.test.ts` and
`src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts` are core client
owners. Extended server depth remains in `server/fastify/__tests__/streamJobs.test.ts`,
`server/fastify/__tests__/streamBackpressure.test.ts`, and
`server/fastify/__tests__/requestAbort.test.ts`.

## Intermediate display

Extended real-boundary coverage is retained in
`server/fastify/__tests__/displaySources.test.ts`,
`server/fastify/__tests__/displaySourceQueue.test.ts`, and
`server/fastify/__tests__/displaySourceCache.test.ts`. The browser-visible owner
is `server/fastify/browser-smoke/chatDisplayScrollStability.spec.ts`.

## Browser durability

`server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`,
`server/fastify/browser-smoke/rerollSwipePersistence.spec.ts`, and
`server/fastify/browser-smoke/coreLifecycle.spec.ts` are core. Extended occupancy
and connection cases remain in
`server/fastify/browser-smoke/chatOccupancyInteraction.spec.ts`,
`server/fastify/browser-smoke/chatOccupancyRecovery.spec.ts`, and
`server/fastify/browser-smoke/connectedReaderGeneration.spec.ts`.

## Primary inventory

- Core client: `src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts`, `src/ts/process/__tests__/streamResponse.test.ts`.
- Core server: `server/fastify/__tests__/generation.chat.test.ts`, `server/fastify/__tests__/durableGeneration.test.ts`.
- Core browser: `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`, `server/fastify/browser-smoke/rerollSwipePersistence.spec.ts`.
