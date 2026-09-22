# Memory and Embeddings

Memory remains an extended real-boundary area, with core protection where memory
enters generation or crosses ownership and recovery fences. Mocked Hypa UI and
client orchestration tests were removed in Phase 5.

## Repository and planning

`server/fastify/__tests__/memoryRepository.test.ts`,
`server/fastify/__tests__/memoryPlanner.test.ts`,
`server/fastify/__tests__/memoryChunkPlanner.test.ts`, and
`server/fastify/__tests__/memoryBudgetAllocator.test.ts` exercise real data and
explicit planning results.

## Embedding, ranking, and summaries

Extended coverage lives in `server/fastify/__tests__/memoryEmbeddingAdapter.test.ts`,
`server/fastify/__tests__/memoryEmbeddingModel.test.ts`,
`server/fastify/__tests__/memorySimilarityRanking.test.ts`,
`server/fastify/__tests__/memorySummaryAdapter.test.ts`, and
`server/fastify/__tests__/memorySummaryModel.test.ts`. The client retains the
pure cache-key contract in `src/ts/process/memory/embeddingCacheKey.test.ts`.

## Jobs, API, and generation

`server/fastify/__tests__/memoryEmbedJobHandler.test.ts`,
`server/fastify/__tests__/memorySummarizeJobHandler.test.ts`,
`server/fastify/__tests__/memoryWorker.test.ts`, and
`server/fastify/__tests__/memoryJobsRoutes.test.ts` cover job transitions.
Memory selection through a real generation route is core in
`server/fastify/__tests__/generation.chat.test.ts`; real-SQLite occupancy
recovery remains in the extended
`server/fastify/__tests__/generationMemoryOccupancyRecovery.test.ts` suite.

## Browser recovery

`server/fastify/browser-smoke/backgroundJobRecovery.spec.ts` and
`server/fastify/browser-smoke/chatOccupancyRecovery.spec.ts` retain extended
browser reconciliation coverage.

## Primary inventory

- Core boundary: `server/fastify/__tests__/generation.chat.test.ts`.
- Extended: `server/fastify/__tests__/generationMemoryOccupancyRecovery.test.ts`, `server/fastify/__tests__/memoryRepository.test.ts`, `server/fastify/__tests__/memoryWorker.test.ts`, `server/fastify/browser-smoke/backgroundJobRecovery.spec.ts`.
