import { assertDatabaseLineage, getDatabaseLineage } from './databaseLineage.js'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { embedTextGroups, embedTexts, type MemoryEmbeddingAdapterResult } from './memoryEmbeddingAdapter.js'
import {
  effectiveMemoryEmbeddingLimits,
  estimateMemoryEmbeddingTokens,
  findMemoryEmbeddingContextualGroupLimitViolation,
  findMemoryEmbeddingLimitViolation,
  formatMemoryEmbeddingLimitViolation,
  resolveMemoryEmbeddingModel,
  type MemoryEmbeddingModel,
  type MemoryEmbeddingModelRequest,
  type MemoryEmbeddingSettings,
} from './memoryEmbeddingModel.js'
import { normalizeHypaV3Settings, type HypaV3Settings } from './memoryPlanner.js'
import {
  createMemoryEmbedding,
  assertMemoryJobGenerationScope,
  getMemoryJobAcceptedEffectiveConfiguration,
  getMemoryChunk,
  listMemoryEmbeddings,
  memoryJobInstanceMayTransition,
  memoryJobMayApplyResult,
  type MemoryJob,
} from './memoryRepository.js'
import { loadPersistedDatabaseForMemoryJob } from './repository.js'
import { MEMORY_JOB_BATCH_MAX_JOBS, type MemoryJobBatchHandler, type MemoryJobHandlerContext } from './memoryWorker.js'
import { emitProtocolMetric } from './protocolMetrics.js'
import { awaitMemoryProviderResult, createMemoryProviderAbortScope } from './memoryProviderDeadline.js'
import { hypaV3PresetIndexFromStableId } from '@risuai/shared-core/hypa-v3-preset-selection-identity'

export interface EmbedMemoryJobHandlerOptions {
  db: DatabaseSync
  dataDir?: string
  loadDatabase?: () => unknown
  embed?: (opts: Parameters<typeof embedTexts>[0]) => Promise<MemoryEmbeddingAdapterResult | { error: string }>
  embedGroups?: (opts: Parameters<typeof embedTextGroups>[0]) => Promise<Awaited<ReturnType<typeof embedTextGroups>>>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Provider-call deadline override for tests; production uses a generous shared default. */
  providerFetchDeadlineMs?: number
  /** Token budget per contextual sub-batch (test seam; production defaults to
   *  the resolved model's contextual window limit). */
  contextualSubBatchTokenBudget?: number
}

interface HypaV3EmbedJobPayload {
  schemaVersion: 1
  chunkId: string
  model: string
}

interface MemoryEmbeddingJobDatabase extends MemoryEmbeddingSettings {
  hypaV3Presets?: unknown
  selectedHypaV3PresetId?: unknown
}

export function createEmbedMemoryJobHandler(
  opts: EmbedMemoryJobHandlerOptions,
): (job: MemoryJob, context?: MemoryJobHandlerContext) => Promise<void> {
  const embed = opts.embed ?? embedTexts
  const embedGroups = opts.embedGroups ?? embedTextGroups
  const acquireRateLimit = createEmbeddingRateLimiter(opts)

  return async (job: MemoryJob, context?: MemoryJobHandlerContext): Promise<void> => {
    const lineage = getDatabaseLineage(opts.db)
    if (job.kind !== 'embed') {
      throw new Error(`embed handler received ${job.kind} job`)
    }
    assertMemoryJobGenerationScope(opts.db, job)

    const database = loadDatabase(opts, job)
    const settings = resolveHypaV3Settings(database)
    const result = await executeEmbedJob({
      opts,
      job,
      database,
      settings,
      embed,
      embedGroups,
      acquireRateLimit,
      signal: context?.signal,
    })
    assertDatabaseLineage(opts.db, lineage)
    assertMemoryJobGenerationScope(opts.db, job)
    if (result.kind === 'existing') return
    if (!memoryJobMayApplyResult(opts.db, job)) return
    persistEmbedding(opts.db, result)
  }
}

export function createEmbedMemoryJobBatchHandler(opts: EmbedMemoryJobHandlerOptions): MemoryJobBatchHandler {
  const embed = opts.embed ?? embedTexts
  const embedGroups = opts.embedGroups ?? embedTextGroups
  const acquireRateLimit = createEmbeddingRateLimiter(opts)

  return async (firstJob, context): Promise<void> => {
    const lineage = getDatabaseLineage(opts.db)
    assertMemoryJobGenerationScope(opts.db, firstJob)
    const databaseResolver = createEmbedJobDatabaseResolver(opts)
    const firstDatabase = databaseResolver(firstJob)
    const firstSettings = resolveHypaV3Settings(firstDatabase)
    const jobs = [firstJob]
    // Bounded drain leave any overflow pending for later
    // ticks instead of materializing one chat's whole backlog into a single
    // batch (and a single worker turn).
    while (jobs.length < MEMORY_JOB_BATCH_MAX_JOBS) {
      const next = context.claimNext({ chatId: firstJob.chatId, kind: 'embed' })
      if (!next) break
      jobs.push(next)
    }

    const orderedJobs = [...jobs].sort(compareEmbedJobs)
    const authority = partitionMemoryJobsByAuthority(opts.db, orderedJobs)
    for (const invalid of authority.invalid) {
      retryMemoryJobAfterHandlerError(opts, context, invalid.job, invalid.error)
    }
    if (authority.valid.length === 0) return

    const maxConcurrent = Math.min(...authority.valid.map((job) => embedJobMaxConcurrent(databaseResolver, job)))
    const contextualModel = contextualVoyageBatchModel(authority.valid)
    if (contextualModel) {
      const modelRequest = resolveMemoryEmbeddingModel(firstDatabase, contextualModel)
      if (modelRequest.ok === false) {
        commitContextualBatchResults(
          opts,
          context,
          authority.valid.map((job) => ({ job, error: modelRequest.error })),
        )
        return
      }

      let plan: ContextualSubBatchPlan
      try {
        plan = planContextualSubBatches(opts, authority.valid, modelRequest.request)
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : String(error)
        commitContextualBatchResults(
          opts,
          context,
          authority.valid.map((job) => ({ job, error: message })),
        )
        return
      }
      emitContextualSubBatchSplitMetric(authority.valid, plan, modelRequest.request)

      // Token-aware sub-batches, each committed independently an
      // oversized or failing sub-batch retries alone instead of failing the
      // unrelated chunks drained alongside it.
      for (const subBatch of plan.subBatches) {
        const results = await executeContextualEmbedJobs({
          opts,
          jobs: subBatch,
          settings: firstSettings,
          modelRequest: modelRequest.request,
          embedGroups,
          acquireRateLimit,
          // One provider request produces vectors for the whole contextual
          // group. A single job cancellation must not abort its siblings; the
          // commit fence below discards only the cancelled job's staged vector.
        })
        assertDatabaseLineage(opts.db, lineage)
        commitContextualBatchResults(opts, context, results)
      }
      return
    }

    const results = await runWithConcurrency(authority.valid, maxConcurrent, async (job) => {
      try {
        assertMemoryJobGenerationScope(opts.db, job)
        const database = databaseResolver(job)
        const settings = resolveHypaV3Settings(database)
        return {
          job,
          result: await executeEmbedJob({
            opts,
            job,
            database,
            settings,
            embed,
            embedGroups,
            acquireRateLimit,
            signal: context.signalFor(job.id),
          }),
        } satisfies BatchJobResult
      } catch (error) {
        return {
          job,
          error: error instanceof Error && error.message ? error.message : String(error),
        } satisfies BatchJobResult
      }
    })

    assertDatabaseLineage(opts.db, lineage)
    commitIndependentBatchResults(opts, context, results)
  }
}

type EmbeddingRateLimiter = (settings: HypaV3Settings) => Promise<void>

type EmbedExecutionResult =
  | {
      kind: 'existing'
      job: MemoryJob
      payload: HypaV3EmbedJobPayload
      chunkId: string
    }
  | {
      kind: 'embedding'
      job: MemoryJob
      payload: HypaV3EmbedJobPayload
      request: MemoryEmbeddingModelRequest
      vector: Float32Array
      dim: number
      groupId: string | null
      groupIndex: number | null
    }

type BatchJobResult = { job: MemoryJob; result: EmbedExecutionResult } | BatchJobError

interface BatchJobError {
  job: MemoryJob
  error: string
  /** This job failed its own pre-dispatch authority fence, not the shared provider request. */
  isolated?: boolean
}

interface MemoryJobAuthorityPartition {
  valid: MemoryJob[]
  invalid: BatchJobError[]
}

interface ContextualSubBatchBudget {
  tokenBudget: number
  source: 'model-context-limit' | 'override'
}

interface ContextualSubBatchPlan {
  subBatches: MemoryJob[][]
  budget: ContextualSubBatchBudget
}

async function executeEmbedJob(input: {
  opts: EmbedMemoryJobHandlerOptions
  job: MemoryJob
  database: MemoryEmbeddingJobDatabase
  settings: HypaV3Settings
  embed: NonNullable<EmbedMemoryJobHandlerOptions['embed']>
  embedGroups: NonNullable<EmbedMemoryJobHandlerOptions['embedGroups']>
  acquireRateLimit: EmbeddingRateLimiter
  signal?: AbortSignal
}): Promise<EmbedExecutionResult> {
  const payload = parseEmbedPayload(input.job.payload)
  const chunk = getMemoryChunk(input.opts.db, payload.chunkId)
  if (!chunk) {
    throw new Error(`memory chunk not found: ${payload.chunkId}`)
  }
  if (chunk.chatId !== input.job.chatId) {
    throw new Error(`memory chunk ${payload.chunkId} does not belong to chat ${input.job.chatId}`)
  }

  const isContextualModel = isVoyageContextualModel(payload.model)
  const existing = listMemoryEmbeddings(input.opts.db, {
    chatId: input.job.chatId,
    chunkId: chunk.id,
    model: payload.model,
    ...(isContextualModel ? {} : { groupId: null }),
  })[0]
  if (existing) {
    return { kind: 'existing', job: input.job, payload, chunkId: chunk.id }
  }

  const modelRequest = resolveMemoryEmbeddingModel(input.database, payload.model as MemoryEmbeddingModel)
  if (modelRequest.ok === false) {
    throw new Error(modelRequest.error)
  }
  assertChunkWithinEmbeddingLimits(modelRequest.request, chunk.id, chunk.text)

  await input.acquireRateLimit(input.settings)
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error('memory job cancelled')
  }
  assertMemoryJobGenerationScope(input.opts.db, input.job)
  const abortScope = createMemoryProviderAbortScope(input.signal, input.opts.providerFetchDeadlineMs)
  if (modelRequest.request.provider === 'voyage-contextual') {
    let embedding: Awaited<ReturnType<NonNullable<EmbedMemoryJobHandlerOptions['embedGroups']>>>
    try {
      embedding = await awaitMemoryProviderResult(abortScope.signal, () =>
        input.embedGroups({
          request: modelRequest.request,
          groups: [[chunk.text]],
          signal: abortScope.signal,
        }),
      )
    } finally {
      abortScope.dispose()
    }
    if ('error' in embedding) {
      throw new Error(embedding.error)
    }
    const vector = embedding.groups[0]?.[0]
    if (!vector) {
      throw new Error('embedding response did not include a vector')
    }
    return {
      kind: 'embedding',
      job: input.job,
      payload,
      request: modelRequest.request,
      vector,
      dim: embedding.dim,
      groupId: buildEmbeddingGroupId(input.job.chatId, payload.model, [chunk.id]),
      groupIndex: 0,
    }
  }

  let embedding: Awaited<ReturnType<NonNullable<EmbedMemoryJobHandlerOptions['embed']>>>
  try {
    embedding = await awaitMemoryProviderResult(abortScope.signal, () =>
      input.embed({
        request: modelRequest.request,
        input: [chunk.text],
        signal: abortScope.signal,
      }),
    )
  } finally {
    abortScope.dispose()
  }
  if ('error' in embedding) {
    throw new Error(embedding.error)
  }
  const vector = embedding.vectors[0]
  if (!vector) {
    throw new Error('embedding response did not include a vector')
  }

  return {
    kind: 'embedding',
    job: input.job,
    payload,
    request: modelRequest.request,
    vector,
    dim: embedding.dim,
    groupId: null,
    groupIndex: null,
  }
}

/**
 * Slice an ordered contextual batch into provider-budgeted sub-batches.
 * Production budgets come from model metadata; the option override is
 * only a test seam. A chunk already known to exceed its per-input ceiling is
 * isolated and then failed before provider dispatch, so valid siblings are not
 * serialized into the same doomed request.
 */
function planContextualSubBatches(
  opts: EmbedMemoryJobHandlerOptions,
  jobs: readonly MemoryJob[],
  request: MemoryEmbeddingModelRequest,
): ContextualSubBatchPlan {
  const budget = resolveContextualSubBatchBudget(opts, request)
  const subBatches: MemoryJob[][] = []
  let current: MemoryJob[] = []
  let currentTokens = 0
  const flush = (): void => {
    if (current.length > 0) {
      subBatches.push(current)
      current = []
      currentTokens = 0
    }
  }
  for (const job of jobs) {
    const payload = tryParseEmbedPayload(job.payload)
    const chunk = payload ? getMemoryChunk(opts.db, payload.chunkId) : null
    if (!chunk || chunk.chatId !== job.chatId) {
      flush()
      subBatches.push([job])
      continue
    }

    const violation = findMemoryEmbeddingLimitViolation(
      request,
      [chunk.text],
      () => `memory embedding chunk ${chunk.id}`,
    )
    if (violation) {
      flush()
      subBatches.push([job])
      continue
    }

    const tokens = estimateMemoryEmbeddingTokens(chunk.text)
    if (current.length > 0 && currentTokens + tokens > budget.tokenBudget) {
      flush()
    }
    current.push(job)
    currentTokens += tokens
  }
  flush()
  return { subBatches, budget }
}

function resolveContextualSubBatchBudget(
  opts: EmbedMemoryJobHandlerOptions,
  request: MemoryEmbeddingModelRequest,
): ContextualSubBatchBudget {
  if (
    typeof opts.contextualSubBatchTokenBudget === 'number' &&
    Number.isFinite(opts.contextualSubBatchTokenBudget) &&
    opts.contextualSubBatchTokenBudget > 0
  ) {
    return {
      tokenBudget: Math.max(1, Math.floor(opts.contextualSubBatchTokenBudget)),
      source: 'override',
    }
  }

  const contextualWindowTokens = effectiveMemoryEmbeddingLimits(request).contextualWindowTokens
  if (
    typeof contextualWindowTokens === 'number' &&
    Number.isFinite(contextualWindowTokens) &&
    contextualWindowTokens > 0
  ) {
    return {
      tokenBudget: Math.max(1, Math.floor(contextualWindowTokens)),
      source: 'model-context-limit',
    }
  }

  throw new Error(
    `contextual embedding model ${request.model} is missing contextualWindowTokens; refusing to split contextual batch`,
  )
}

function assertChunkWithinEmbeddingLimits(request: MemoryEmbeddingModelRequest, chunkId: string, text: string): void {
  assertChunksWithinEmbeddingLimits(request, [{ id: chunkId, text }])
}

function assertChunksWithinEmbeddingLimits(
  request: MemoryEmbeddingModelRequest,
  chunks: ReadonlyArray<{ id: string; text: string }>,
): void {
  const violation = findMemoryEmbeddingLimitViolation(
    request,
    chunks.map((chunk) => chunk.text),
    (index) => `memory embedding chunk ${chunks[index].id}`,
  )
  if (violation) {
    throw new Error(formatMemoryEmbeddingLimitViolation(violation))
  }
}

function assertContextualGroupWithinEmbeddingLimits(
  request: MemoryEmbeddingModelRequest,
  texts: readonly string[],
): void {
  const violation = findMemoryEmbeddingContextualGroupLimitViolation(
    request,
    [texts],
    () => 'contextual embedding group',
  )
  if (violation) {
    throw new Error(formatMemoryEmbeddingLimitViolation(violation))
  }
}

function emitContextualSubBatchSplitMetric(
  jobs: readonly MemoryJob[],
  plan: ContextualSubBatchPlan,
  request: MemoryEmbeddingModelRequest,
): void {
  if (plan.subBatches.length <= 1) return
  emitProtocolMetric('memory_contextual_embed_split', () => ({
    chatId: jobs[0]?.chatId ?? null,
    model: tryParseEmbedPayload(jobs[0]?.payload)?.model ?? null,
    provider: request.provider,
    requestModel: request.model,
    originalJobCount: jobs.length,
    subBatchCount: plan.subBatches.length,
    tokenBudget: plan.budget.tokenBudget,
    budgetSource: plan.budget.source,
    subBatchJobCounts: plan.subBatches.map((subBatch) => subBatch.length),
  }))
}

async function executeContextualEmbedJobs(input: {
  opts: EmbedMemoryJobHandlerOptions
  jobs: readonly MemoryJob[]
  settings: HypaV3Settings
  modelRequest: MemoryEmbeddingModelRequest
  embedGroups: NonNullable<EmbedMemoryJobHandlerOptions['embedGroups']>
  acquireRateLimit: EmbeddingRateLimiter
  signal?: AbortSignal
}): Promise<BatchJobResult[]> {
  const initialAuthority = partitionMemoryJobsByAuthority(input.opts.db, input.jobs)
  const isolatedErrors = initialAuthority.invalid
  let activeJobs = initialAuthority.valid
  if (activeJobs.length === 0) return isolatedErrors

  try {
    let parsed = activeJobs.map((job) => {
      const payload = parseEmbedPayload(job.payload)
      const chunk = getMemoryChunk(input.opts.db, payload.chunkId)
      if (!chunk) {
        throw new Error(`memory chunk not found: ${payload.chunkId}`)
      }
      if (chunk.chatId !== job.chatId) {
        throw new Error(`memory chunk ${payload.chunkId} does not belong to chat ${job.chatId}`)
      }
      return { job, payload, chunk }
    })

    let groupChunkIds = parsed.map((item) => item.chunk.id)
    let groupId = buildEmbeddingGroupId(activeJobs[0].chatId, parsed[0].payload.model, groupChunkIds)
    const existing = new Map(
      parsed.map((item) => [
        item.chunk.id,
        listMemoryEmbeddings(input.opts.db, {
          chatId: item.job.chatId,
          chunkId: item.chunk.id,
          model: item.payload.model,
        })[0],
      ]),
    )
    if ([...existing.values()].every(Boolean)) {
      return [
        ...parsed.map(({ job, payload, chunk }) => ({
          job,
          result: { kind: 'existing' as const, job, payload, chunkId: chunk.id },
        })),
        ...isolatedErrors,
      ]
    }
    assertChunksWithinEmbeddingLimits(
      input.modelRequest,
      parsed.map((item) => ({ id: item.chunk.id, text: item.chunk.text })),
    )
    assertContextualGroupWithinEmbeddingLimits(
      input.modelRequest,
      parsed.map((item) => item.chunk.text),
    )

    await input.acquireRateLimit(input.settings)
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error('memory job cancelled')
    }

    // The rate limiter may wait. Revalidate every member after that async gap
    // and immediately before constructing the shared provider request. A bad
    // sibling must contribute neither its text nor contextual group identity.
    const dispatchAuthority = partitionMemoryJobsByAuthority(input.opts.db, activeJobs)
    isolatedErrors.push(...dispatchAuthority.invalid)
    activeJobs = dispatchAuthority.valid
    if (activeJobs.length === 0) return isolatedErrors
    const activeIds = new Set(activeJobs.map((job) => job.id))
    parsed = parsed.filter(({ job }) => activeIds.has(job.id))
    groupChunkIds = parsed.map((item) => item.chunk.id)
    groupId = buildEmbeddingGroupId(activeJobs[0].chatId, parsed[0].payload.model, groupChunkIds)
    assertChunksWithinEmbeddingLimits(
      input.modelRequest,
      parsed.map((item) => ({ id: item.chunk.id, text: item.chunk.text })),
    )
    assertContextualGroupWithinEmbeddingLimits(
      input.modelRequest,
      parsed.map((item) => item.chunk.text),
    )

    const abortScope = createMemoryProviderAbortScope(input.signal, input.opts.providerFetchDeadlineMs)
    let embedding: Awaited<ReturnType<NonNullable<EmbedMemoryJobHandlerOptions['embedGroups']>>>
    try {
      embedding = await awaitMemoryProviderResult(abortScope.signal, () =>
        input.embedGroups({
          request: input.modelRequest,
          groups: [parsed.map((item) => item.chunk.text)],
          signal: abortScope.signal,
        }),
      )
    } finally {
      abortScope.dispose()
    }
    if ('error' in embedding) {
      throw new Error(embedding.error)
    }
    const vectors = embedding.groups[0]
    if (!vectors || vectors.length !== parsed.length) {
      throw new Error(`embedding response count mismatch: expected ${parsed.length}, got ${vectors?.length ?? 0}`)
    }

    const results = parsed.map(({ job, payload, chunk }, index): BatchJobResult => {
      const existingEmbedding = existing.get(chunk.id)
      if (existingEmbedding) {
        return {
          job,
          result: { kind: 'existing', job, payload, chunkId: chunk.id },
        }
      }
      return {
        job,
        result: {
          kind: 'embedding',
          job,
          payload,
          request: input.modelRequest,
          vector: vectors[index],
          dim: embedding.dim,
          groupId,
          groupIndex: index,
        },
      }
    })
    return [...results, ...isolatedErrors]
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : String(error)
    return [...activeJobs.map((job) => ({ job, error: message })), ...isolatedErrors]
  }
}

function commitIndependentBatchResults(
  opts: EmbedMemoryJobHandlerOptions,
  context: Parameters<MemoryJobBatchHandler>[1],
  results: readonly BatchJobResult[],
): void {
  for (const item of results) {
    if ('error' in item) {
      retryMemoryJobAfterHandlerError(opts, context, item.job, item.error || 'embed job failed')
      continue
    }

    try {
      if (!memoryJobMayApplyResult(opts.db, item.job)) {
        continue
      }
      if (item.result.kind === 'embedding') {
        persistEmbedding(opts.db, item.result)
      }
      context.complete(item.job.id)
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error)
      context.retryOrFail(item.job.id, message)
    }
  }
}

function commitContextualBatchResults(
  opts: EmbedMemoryJobHandlerOptions,
  context: Parameters<MemoryJobBatchHandler>[1],
  results: readonly BatchJobResult[],
): void {
  const isolatedFailures = results.filter((item): item is BatchJobError => 'error' in item && item.isolated === true)
  for (const failed of isolatedFailures) {
    retryMemoryJobAfterHandlerError(opts, context, failed.job, failed.error || 'embed job failed')
  }

  const groupResults = results.filter((item) => !('error' in item && item.isolated === true))
  const failed = groupResults.find((item): item is BatchJobError => 'error' in item)
  if (failed) {
    retryContextualBatch(opts, context, groupResults, failed.error || 'embed job failed')
    return
  }

  const successful: Array<{ job: MemoryJob; result: EmbedExecutionResult }> = []
  for (const item of groupResults as Array<{ job: MemoryJob; result: EmbedExecutionResult }>) {
    try {
      if (memoryJobMayApplyResult(opts.db, item.job)) successful.push(item)
    } catch (error) {
      retryMemoryJobAfterHandlerError(
        opts,
        context,
        item.job,
        error instanceof Error && error.message ? error.message : String(error),
      )
    }
  }
  if (successful.length === 0) return

  try {
    persistEmbeddingGroup(
      opts.db,
      successful
        .map((item) => item.result)
        .filter((result): result is Extract<EmbedExecutionResult, { kind: 'embedding' }> => {
          return result.kind === 'embedding'
        }),
    )
    for (const item of successful) {
      context.complete(item.job.id)
    }
  } catch (error) {
    retryContextualBatch(
      opts,
      context,
      successful,
      error instanceof Error && error.message ? error.message : String(error),
    )
  }
}

function retryContextualBatch(
  opts: EmbedMemoryJobHandlerOptions,
  context: Parameters<MemoryJobBatchHandler>[1],
  results: ReadonlyArray<{ job: MemoryJob }>,
  error: string,
): void {
  for (const item of results) {
    retryMemoryJobAfterHandlerError(opts, context, item.job, error)
  }
}

function retryMemoryJobAfterHandlerError(
  opts: EmbedMemoryJobHandlerOptions,
  context: Parameters<MemoryJobBatchHandler>[1],
  job: MemoryJob,
  error: string,
): void {
  try {
    if (memoryJobMayApplyResult(opts.db, job)) context.retryOrFail(job.id, error)
  } catch (scopeError) {
    if (!memoryJobInstanceMayTransition(opts.db, job)) return
    context.retryOrFail(
      job.id,
      scopeError instanceof Error && scopeError.message ? scopeError.message : String(scopeError),
    )
  }
}

function createEmbeddingRateLimiter(opts: EmbedMemoryJobHandlerOptions): EmbeddingRateLimiter {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  let lastRequestAtMs: number | undefined
  let lastIntervalMs = 0

  return async (settings) => {
    const requestsPerMinute = Math.max(1, settings.embeddingRequestsPerMinute)
    const intervalMs = Math.ceil(60_000 / requestsPerMinute)
    const current = now()
    const requestAt =
      lastRequestAtMs === undefined
        ? current
        : Math.max(current, lastRequestAtMs + Math.max(lastIntervalMs, intervalMs))
    const waitMs = Math.max(0, requestAt - current)
    lastRequestAtMs = requestAt
    lastIntervalMs = intervalMs
    if (waitMs > 0) await sleep(waitMs)
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function compareEmbedJobs(left: MemoryJob, right: MemoryJob): number {
  const leftPayload = tryParseEmbedPayload(left.payload)
  const rightPayload = tryParseEmbedPayload(right.payload)
  if (left.chatId !== right.chatId) return left.chatId.localeCompare(right.chatId)
  if (leftPayload && rightPayload) {
    const chunkDiff = leftPayload.chunkId.localeCompare(rightPayload.chunkId)
    if (chunkDiff !== 0) return chunkDiff
    const modelDiff = leftPayload.model.localeCompare(rightPayload.model)
    if (modelDiff !== 0) return modelDiff
  }
  const createdDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (createdDiff !== 0) return createdDiff
  return left.id.localeCompare(right.id)
}

function contextualVoyageBatchModel(jobs: readonly MemoryJob[]): MemoryEmbeddingModel | null {
  const model = tryParseEmbedPayload(jobs[0]?.payload)?.model
  if (!isVoyageContextualModel(model)) return null
  const configurationIdentity = memoryJobConfigurationIdentity(jobs[0])
  return jobs.every(
    (job) =>
      tryParseEmbedPayload(job.payload)?.model === model &&
      memoryJobConfigurationIdentity(job) === configurationIdentity,
  )
    ? model
    : null
}

function isVoyageContextualModel(
  model: unknown,
): model is Extract<MemoryEmbeddingModel, 'voyageContext3' | 'voyageContext4'> {
  return model === 'voyageContext3' || model === 'voyageContext4'
}

function tryParseEmbedPayload(payload: unknown): HypaV3EmbedJobPayload | null {
  try {
    return parseEmbedPayload(payload)
  } catch {
    return null
  }
}

function parseEmbedPayload(payload: unknown): HypaV3EmbedJobPayload {
  if (!isRecord(payload)) throw new Error('embed payload must be an object')
  if (payload.schemaVersion !== 1) throw new Error('embed payload schemaVersion must be 1')
  if (typeof payload.chunkId !== 'string' || payload.chunkId.length === 0) {
    throw new Error('embed payload chunkId must be a non-empty string')
  }
  if (typeof payload.model !== 'string' || payload.model.length === 0) {
    throw new Error('embed payload model must be a non-empty string')
  }
  return {
    schemaVersion: 1,
    chunkId: payload.chunkId,
    model: payload.model,
  }
}

function loadDatabase(opts: EmbedMemoryJobHandlerOptions, job: MemoryJob): MemoryEmbeddingJobDatabase {
  const accepted = getMemoryJobAcceptedEffectiveConfiguration(opts.db, job)
  if (accepted) return accepted.database as MemoryEmbeddingJobDatabase
  // Memory-job-scoped read settings + hypa presets + chat-id
  // stubs only — never the whole characters/chats/collections payload parse.
  const database = opts.loadDatabase
    ? opts.loadDatabase()
    : opts.dataDir
      ? loadPersistedDatabaseForMemoryJob(opts.db, opts.dataDir)
      : null
  if (!isRecord(database)) {
    throw new Error('persisted database is missing')
  }
  return database as MemoryEmbeddingJobDatabase
}

function createEmbedJobDatabaseResolver(
  opts: EmbedMemoryJobHandlerOptions,
): (job: MemoryJob) => MemoryEmbeddingJobDatabase {
  const databases = new Map<string, MemoryEmbeddingJobDatabase>()
  return (job) => {
    // Cache hits share only configuration bytes, never authority. Every job
    // must cross its own persisted scope fence before using that configuration.
    assertMemoryJobGenerationScope(opts.db, job)
    const key = memoryJobConfigurationIdentity(job)
    const existing = databases.get(key)
    if (existing) return existing
    const database = loadDatabase(opts, job)
    databases.set(key, database)
    return database
  }
}

function embedJobMaxConcurrent(
  resolveDatabase: (job: MemoryJob) => MemoryEmbeddingJobDatabase,
  job: MemoryJob,
): number {
  try {
    return Math.max(1, resolveHypaV3Settings(resolveDatabase(job)).embeddingMaxConcurrent)
  } catch {
    // The per-job execution path records its own configuration failure. Keep
    // the batch conservative until that job reaches the guarded error path.
    return 1
  }
}

function memoryJobConfigurationIdentity(job: MemoryJob): string {
  if (job.operationId && job.operationAttemptNo !== undefined) {
    return `operation:${job.operationId}:${job.operationAttemptNo}:scope:${JSON.stringify(job.generationScope ?? null)}`
  }
  return 'legacy-live'
}

function partitionMemoryJobsByAuthority(db: DatabaseSync, jobs: readonly MemoryJob[]): MemoryJobAuthorityPartition {
  const valid: MemoryJob[] = []
  const invalid: BatchJobError[] = []
  for (const job of jobs) {
    try {
      assertMemoryJobGenerationScope(db, job)
      valid.push(job)
    } catch (error) {
      invalid.push({
        job,
        error: error instanceof Error && error.message ? error.message : String(error),
        isolated: true,
      })
    }
  }
  return { valid, invalid }
}

function resolveHypaV3Settings(database: MemoryEmbeddingJobDatabase): HypaV3Settings {
  const db = database
  let rawSettings: unknown = null
  const presetId = hypaV3PresetIndexFromStableId({
    hypaV3Presets: db.hypaV3Presets,
    selectedHypaV3PresetId: db.selectedHypaV3PresetId,
  })
  if (Array.isArray(db.hypaV3Presets)) {
    const preset = db.hypaV3Presets[presetId]
    if (isRecord(preset)) rawSettings = preset.settings
  }
  return normalizeHypaV3Settings(isRecord(rawSettings) ? rawSettings : null).settings
}

function persistEmbedding(
  db: DatabaseSync,
  input: {
    job: MemoryJob
    payload: HypaV3EmbedJobPayload
    request: MemoryEmbeddingModelRequest
    vector: Float32Array
    dim: number
    groupId: string | null
    groupIndex: number | null
  },
): boolean {
  if (input.vector.length !== input.dim) {
    throw new Error(`embedding dimension mismatch: expected ${input.dim}, got ${input.vector.length}`)
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    if (!memoryJobMayApplyResult(db, input.job)) {
      db.exec('ROLLBACK')
      return false
    }
    const existing = listMemoryEmbeddings(db, {
      chatId: input.job.chatId,
      chunkId: input.payload.chunkId,
      model: input.payload.model,
    })[0]
    if (!existing) {
      createMemoryEmbedding(db, {
        id: buildEmbeddingId(input.job.chatId, input.payload.chunkId, input.payload.model, input.groupId),
        chatId: input.job.chatId,
        chunkId: input.payload.chunkId,
        model: input.payload.model,
        vector: input.vector,
        groupId: input.groupId,
        groupIndex: input.groupIndex,
      })
    }
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function persistEmbeddingGroup(
  db: DatabaseSync,
  inputs: ReadonlyArray<{
    job: MemoryJob
    payload: HypaV3EmbedJobPayload
    vector: Float32Array
    dim: number
    groupId: string | null
    groupIndex: number | null
  }>,
): boolean {
  if (inputs.length === 0) return true

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const input of inputs) {
      if (!memoryJobMayApplyResult(db, input.job)) continue
      if (input.vector.length !== input.dim) {
        throw new Error(`embedding dimension mismatch: expected ${input.dim}, got ${input.vector.length}`)
      }
      const existing = listMemoryEmbeddings(db, {
        chatId: input.job.chatId,
        chunkId: input.payload.chunkId,
        model: input.payload.model,
      })[0]
      if (existing) continue

      createMemoryEmbedding(db, {
        id: buildEmbeddingId(input.job.chatId, input.payload.chunkId, input.payload.model, input.groupId),
        chatId: input.job.chatId,
        chunkId: input.payload.chunkId,
        model: input.payload.model,
        vector: input.vector,
        groupId: input.groupId,
        groupIndex: input.groupIndex,
      })
    }
    db.exec('COMMIT')
    return true
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function buildEmbeddingId(chatId: string, chunkId: string, model: string, groupId: string | null = null): string {
  if (groupId === null) {
    return `hypav3-embedding-${shortHash(JSON.stringify({ chatId, chunkId, model }))}`
  }
  return `hypav3-embedding-${shortHash(JSON.stringify({ chatId, chunkId, model, groupId }))}`
}

function buildEmbeddingGroupId(chatId: string, model: string, chunkIds: readonly string[]): string {
  return `hypav3-embedding-group-${shortHash(JSON.stringify({ chatId, model, chunkIds }))}`
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
