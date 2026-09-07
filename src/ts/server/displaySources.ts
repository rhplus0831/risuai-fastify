import { readonly, writable } from 'svelte/store'
import {
  canUseClientReadServices,
  clientSessionStore,
  captureClientSessionGeneration,
  isClientReadOnly,
  isClientSessionGenerationCurrent,
  isClientSessionManaged,
} from '../clientSession'
import { sha256Hex } from '../sha256Fallback'
import { isPluginRuntimeReady, pluginV2 } from '../plugins/plugins.svelte'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse, isWriterAccessLost } from './activeWriterSession'
import {
  peekCachedServerCommandRevision,
  runExternalServerRevisionOperation,
  setCachedServerCommandRevision,
} from './commands'
import { readBrowserClientContext } from '../process/request/clientContext'
import {
  DISPLAY_SOURCE_LIMITS,
  DISPLAY_SOURCE_PROTOCOL_VERSION,
  displaySourceNamespaceJson,
  stableDisplayDependencyJson,
  type DisplayRequestContext,
  type DisplaySourceLayer,
  type DisplaySourceResponse,
  type DisplaySourceTarget,
} from '@risuai/protocol/display-source'
import { currentRegexDisplayReloadToken } from '../process/regexDisplayReload'

const SERVER_DATABASE_LINEAGE_HEADER = 'risu-database-lineage'

export interface ServerDisplaySourceInput {
  chatId: string
  character: { chaId: string; name?: string }
  messageId?: string
  index: number
  role: string | null
  firstMessage: boolean
  layer: DisplaySourceLayer
  source: string
  streaming?: boolean
  name?: string
  priority?: DisplaySourcePriority
}

export type DisplaySourcePriority = 'critical' | 'normal' | 'background'

export type ServerDisplaySourceResult =
  | { status: 'ok'; displaySource: string; dependencyFingerprint: string }
  | { status: 'fallback'; reason: string }

interface PendingDisplaySource {
  chatId: string
  priority: DisplaySourcePriority
  target: DisplaySourceTarget
  expectedContextFingerprint: string
  clientGeneration: number
  sessionGeneration: number
  reader: boolean
  resolve: (result: ServerDisplaySourceResult) => void
}

interface ActiveDisplaySourceFetch {
  chatId: string
  cancellable: boolean
}

interface CompletedDisplaySource {
  result: Extract<ServerDisplaySourceResult, { status: 'ok' }>
}

const readerDisplayLimitedWritable = writable(false)
/** Sticky within the visible chat/namespace: one successful row cannot hide another fallback. */
export const readerDisplayLimitedStore = readonly(readerDisplayLimitedWritable)
export function markReaderDisplayLimited(chatId?: string, sessionGeneration = captureClientSessionGeneration()): void {
  if (!isClientReadOnly() || !isClientSessionGenerationCurrent(sessionGeneration)) return
  if (chatId && activeDisplaySourceChatId !== null && chatId !== activeDisplaySourceChatId) return
  readerDisplayLimitedWritable.set(true)
}

const MAX_COMPLETED_DISPLAY_SOURCES = 512

let protocolVersion = 0
let databaseLineage: string | null = null
let activeWriterEpoch: number | null = null
let projectionEpoch = 0
const pendingByBatch = new Map<string, PendingDisplaySource[]>()
const preparingByBatch = new Map<string, number>()
const scheduledBatches = new Set<string>()
const activeFetches = new Map<AbortController, ActiveDisplaySourceFetch>()
const inFlightDisplaySources = new Map<string, Promise<ServerDisplaySourceResult>>()
const completedDisplaySources = new Map<string, CompletedDisplaySource>()
let activeDisplaySourceChatId: string | null = null
let displaySourceClientGeneration = 0
const pageSessionId = createPageSessionId()

function createPageSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function createRequestKey(epoch: number, sourceHash: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return `${epoch}:${sourceHash.slice(0, 16)}:${random}`.slice(0, DISPLAY_SOURCE_LIMITS.maxRequestKeyLength)
}

export function configureDisplaySourceProtocol(
  protocol: { version: number } | undefined,
  lineage?: string,
  writerEpoch?: number,
): void {
  const nextProtocolVersion =
    protocol?.version === DISPLAY_SOURCE_PROTOCOL_VERSION ? DISPLAY_SOURCE_PROTOCOL_VERSION : 0
  const nextDatabaseLineage = typeof lineage === 'string' && lineage.length > 0 ? lineage : null
  const nextActiveWriterEpoch =
    Number.isSafeInteger(writerEpoch) && (writerEpoch as number) >= 0 ? (writerEpoch as number) : null
  if (
    protocolVersion !== nextProtocolVersion ||
    databaseLineage !== nextDatabaseLineage ||
    activeWriterEpoch !== nextActiveWriterEpoch
  ) {
    clearDisplaySourceDedupeCache()
  }
  protocolVersion = nextProtocolVersion
  databaseLineage = nextDatabaseLineage
  activeWriterEpoch = nextActiveWriterEpoch
}

export function canUseDisplaySourceProtocol(): boolean {
  return (
    protocolVersion === DISPLAY_SOURCE_PROTOCOL_VERSION &&
    databaseLineage !== null &&
    activeWriterEpoch !== null &&
    (isClientSessionManaged() ? canUseClientReadServices() : !isWriterAccessLost())
  )
}

export function resetDisplaySourceClientForTests(): void {
  protocolVersion = 0
  databaseLineage = null
  activeWriterEpoch = null
  projectionEpoch = 0
  for (const pending of pendingByBatch.values()) {
    for (const item of pending) item.resolve({ status: 'fallback', reason: 'client_reset' })
  }
  for (const controller of activeFetches.keys()) controller.abort('client_reset')
  pendingByBatch.clear()
  preparingByBatch.clear()
  scheduledBatches.clear()
  activeFetches.clear()
  clearDisplaySourceDedupeCache()
  activeDisplaySourceChatId = null
}

/**
 * Claim the visible chat's display work. Pending or in-flight initial-render
 * work for the previous chat is obsolete and must not hold the shared revision
 * lane while the newly visible chat waits.
 */
export function activateDisplaySourceChat(chatId: string | null): void {
  if (activeDisplaySourceChatId === chatId) return
  activeDisplaySourceChatId = chatId
  readerDisplayLimitedWritable.set(false)

  for (const [batchKey, pending] of pendingByBatch) {
    const retained: PendingDisplaySource[] = []
    for (const item of pending) {
      if (item.priority === 'normal' || item.chatId === chatId) retained.push(item)
      else item.resolve({ status: 'fallback', reason: 'display_scope_changed' })
    }
    if (retained.length > 0) pendingByBatch.set(batchKey, retained)
    else pendingByBatch.delete(batchKey)
  }
  for (const [controller, active] of activeFetches) {
    if (active.cancellable && active.chatId !== chatId) controller.abort('display_scope_changed')
  }
}

export function releaseDisplaySourceChat(chatId: string | null): void {
  if (activeDisplaySourceChatId === chatId) activateDisplaySourceChat(null)
}

export async function requestServerDisplaySource(input: ServerDisplaySourceInput): Promise<ServerDisplaySourceResult> {
  if (!isClientReadOnly() && isPluginRuntimeReady() && pluginV2.editdisplay.size > 0) {
    return { status: 'fallback', reason: 'browser_editdisplay_plugin' }
  }
  if (!canUseDisplaySourceProtocol()) return { status: 'fallback', reason: 'protocol_unavailable' }
  if (!input.chatId || !input.character?.chaId) return { status: 'fallback', reason: 'target_unavailable' }
  if (new TextEncoder().encode(input.source).byteLength > DISPLAY_SOURCE_LIMITS.maxSourceBytes) {
    return { status: 'fallback', reason: 'source_oversize' }
  }
  const priority = input.priority ?? 'normal'
  if (priority !== 'normal') {
    if (activeDisplaySourceChatId === null) activeDisplaySourceChatId = input.chatId
    else if (activeDisplaySourceChatId !== input.chatId) {
      return { status: 'fallback', reason: 'display_scope_changed' }
    }
  }

  const context: DisplayRequestContext = { pageSessionId, ...readBrowserClientContext() }
  const configuredLineage = databaseLineage!
  const configuredWriterEpoch = activeWriterEpoch!
  const sessionGeneration = captureClientSessionGeneration()
  const reader = isClientReadOnly()
  const batchKey = stableDisplayDependencyJson({
    chatId: input.chatId,
    context,
    configuredLineage,
    configuredWriterEpoch,
    sessionGeneration,
    reader,
  })
  const preparationGeneration = displaySourceClientGeneration
  beginDisplaySourceBatchPreparation(batchKey)

  try {
    const [sourceHash, expectedContextFingerprint] = await Promise.all([
      sha256Hex(input.source),
      sha256Hex(
        displaySourceNamespaceJson({
          databaseLineage: configuredLineage,
          activeWriterEpoch: configuredWriterEpoch,
          context,
        }),
      ),
    ])
    if (
      preparationGeneration !== displaySourceClientGeneration ||
      !isClientSessionGenerationCurrent(sessionGeneration)
    ) {
      return { status: 'fallback', reason: 'display_namespace_changed' }
    }
    const dedupeKey = input.streaming
      ? null
      : displaySourceDedupeKey({
          input,
          context,
          sourceHash,
          priority,
          baseRevision: peekCachedServerCommandRevision(),
          regexDisplayReloadToken: currentRegexDisplayReloadToken({
            characterId: input.character.chaId,
            chatId: input.chatId,
          }),
        })
    if (dedupeKey) {
      const completed = completedDisplaySources.get(dedupeKey)
      if (completed) {
        completedDisplaySources.delete(dedupeKey)
        completedDisplaySources.set(dedupeKey, completed)
        return completed.result
      }
      const inFlight = inFlightDisplaySources.get(dedupeKey)
      if (inFlight) return inFlight
    }

    const epoch = ++projectionEpoch
    const target: DisplaySourceTarget = {
      requestKey: createRequestKey(epoch, sourceHash),
      characterId: input.character.chaId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      index: input.index,
      role: input.role,
      firstMessage: input.firstMessage,
      layer: input.layer,
      source: input.source,
      sourceHash,
      projectionEpoch: epoch,
      ...(input.streaming === true ? { streaming: true } : {}),
      ...(input.name ? { name: input.name } : {}),
    }
    const request = enqueueDisplaySourceRequest({
      chatId: input.chatId,
      priority,
      target,
      expectedContextFingerprint,
      clientGeneration: preparationGeneration,
      sessionGeneration,
      reader,
      batchKey,
    })

    if (!dedupeKey) return request
    const generation = displaySourceClientGeneration
    inFlightDisplaySources.set(dedupeKey, request)
    void request
      .then((result) => {
        if (result.status === 'ok' && generation === displaySourceClientGeneration) {
          rememberCompletedDisplaySource(dedupeKey, result)
        }
      })
      .finally(() => {
        if (inFlightDisplaySources.get(dedupeKey) === request) inFlightDisplaySources.delete(dedupeKey)
      })
    return request
  } finally {
    completeDisplaySourceBatchPreparation(batchKey, {
      chatId: input.chatId,
      context,
      configuredLineage,
    })
  }
}

function beginDisplaySourceBatchPreparation(batchKey: string): void {
  preparingByBatch.set(batchKey, (preparingByBatch.get(batchKey) ?? 0) + 1)
}

function completeDisplaySourceBatchPreparation(
  batchKey: string,
  batch: { chatId: string; context: DisplayRequestContext; configuredLineage: string },
): void {
  const preparing = preparingByBatch.get(batchKey)
  if (preparing === undefined) return
  if (preparing > 1) {
    preparingByBatch.set(batchKey, preparing - 1)
    return
  }
  preparingByBatch.delete(batchKey)
  scheduleDisplaySourceBatch(batchKey, batch)
}

function enqueueDisplaySourceRequest(input: {
  chatId: string
  priority: DisplaySourcePriority
  target: DisplaySourceTarget
  expectedContextFingerprint: string
  clientGeneration: number
  sessionGeneration: number
  reader: boolean
  batchKey: string
}): Promise<ServerDisplaySourceResult> {
  return new Promise<ServerDisplaySourceResult>((resolve) => {
    const pending = pendingByBatch.get(input.batchKey) ?? []
    if (input.target.streaming) {
      const supersededIndex = pending.findIndex(
        (item) =>
          item.target.streaming === true &&
          item.target.characterId === input.target.characterId &&
          item.target.messageId === input.target.messageId &&
          item.target.index === input.target.index &&
          item.target.layer === input.target.layer,
      )
      if (supersededIndex >= 0) {
        const [superseded] = pending.splice(supersededIndex, 1)
        superseded.resolve({
          status: 'ok',
          displaySource: superseded.target.source,
          dependencyFingerprint: 'streaming_projection_superseded',
        })
      }
    }
    pending.push({
      chatId: input.chatId,
      priority: input.priority,
      target: input.target,
      expectedContextFingerprint: input.expectedContextFingerprint,
      clientGeneration: input.clientGeneration,
      sessionGeneration: input.sessionGeneration,
      reader: input.reader,
      resolve,
    })
    pendingByBatch.set(input.batchKey, pending)
  })
}

function scheduleDisplaySourceBatch(
  batchKey: string,
  batch: { chatId: string; context: DisplayRequestContext; configuredLineage: string },
): void {
  if (!pendingByBatch.has(batchKey) || scheduledBatches.has(batchKey)) return
  scheduledBatches.add(batchKey)
  setTimeout(() => {
    scheduledBatches.delete(batchKey)
    if (preparingByBatch.has(batchKey)) {
      scheduleDisplaySourceBatch(batchKey, batch)
      return
    }
    const pending = pendingByBatch.get(batchKey) ?? []
    pendingByBatch.delete(batchKey)
    void flushDisplaySourcePriorityGroups(batch.chatId, batch.context, batch.configuredLineage, pending)
  }, 0)
}

function displaySourceDedupeKey(input: {
  input: ServerDisplaySourceInput
  context: DisplayRequestContext
  sourceHash: string
  priority: DisplaySourcePriority
  baseRevision: number | null
  regexDisplayReloadToken: string
}): string | null {
  if (input.baseRevision === null) return null
  return stableDisplayDependencyJson({
    namespace: {
      protocolVersion,
      sessionGeneration: captureClientSessionGeneration(),
      reader: isClientReadOnly(),
      databaseLineage,
      activeWriterEpoch,
      baseRevision: input.baseRevision,
      context: input.context,
    },
    target: {
      chatId: input.input.chatId,
      characterId: input.input.character.chaId,
      messageId: input.input.messageId ?? null,
      index: input.input.index,
      role: input.input.role,
      firstMessage: input.input.firstMessage,
      layer: input.input.layer,
      name: input.input.name ?? null,
      priority: input.priority,
      sourceHash: input.sourceHash,
      regexDisplayReloadToken: input.regexDisplayReloadToken,
    },
  })
}

function rememberCompletedDisplaySource(
  key: string,
  result: Extract<ServerDisplaySourceResult, { status: 'ok' }>,
): void {
  completedDisplaySources.delete(key)
  completedDisplaySources.set(key, { result })
  while (completedDisplaySources.size > MAX_COMPLETED_DISPLAY_SOURCES) {
    const oldestKey = completedDisplaySources.keys().next().value
    if (typeof oldestKey !== 'string') break
    completedDisplaySources.delete(oldestKey)
  }
}

function clearDisplaySourceDedupeCache(): void {
  readerDisplayLimitedWritable.set(false)
  displaySourceClientGeneration += 1
  inFlightDisplaySources.clear()
  completedDisplaySources.clear()
}

async function flushDisplaySourcePriorityGroups(
  chatId: string,
  context: DisplayRequestContext,
  configuredLineage: string,
  pending: PendingDisplaySource[],
): Promise<void> {
  const critical = pending.filter((item) => item.priority === 'critical')
  const normal = pending.filter((item) => item.priority === 'normal')
  const background = pending.filter((item) => item.priority === 'background')

  await flushDisplaySourceBatch(chatId, context, configuredLineage, critical)
  await flushDisplaySourceBatch(chatId, context, configuredLineage, normal)
  if (background.length === 0) return
  await yieldToBackgroundDisplayWork()
  await flushDisplaySourceBatch(chatId, context, configuredLineage, background)
}

function yieldToBackgroundDisplayWork(): Promise<void> {
  return new Promise((resolve) => {
    const requestIdleCallback = (
      globalThis as typeof globalThis & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      }
    ).requestIdleCallback
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(resolve, { timeout: 250 })
      return
    }
    setTimeout(resolve, 0)
  })
}

async function flushDisplaySourceBatch(
  chatId: string,
  context: DisplayRequestContext,
  configuredLineage: string,
  pending: PendingDisplaySource[],
): Promise<void> {
  if (pending.length === 0) return
  const ordered = [...pending].sort(
    (left, right) =>
      left.target.index - right.target.index ||
      left.target.layer.localeCompare(right.target.layer) ||
      left.target.requestKey.localeCompare(right.target.requestKey),
  )
  let executed = false
  try {
    const execute = async () => {
      for (let offset = 0; offset < ordered.length; offset += DISPLAY_SOURCE_LIMITS.maxTargets) {
        await flushDisplaySourceChunk(
          chatId,
          context,
          configuredLineage,
          ordered.slice(offset, offset + DISPLAY_SOURCE_LIMITS.maxTargets),
        )
      }
    }
    if (ordered[0].reader) {
      await execute()
      executed = true
    } else {
      const execution = await runExternalServerRevisionOperation(execute)
      executed = execution.status === 'executed'
    }
  } catch {
    for (const item of ordered) item.resolve({ status: 'fallback', reason: 'network_error' })
    return
  }
  if (!executed) {
    for (const item of ordered) item.resolve({ status: 'fallback', reason: 'revision_unavailable' })
  }
}

async function flushDisplaySourceChunk(
  chatId: string,
  context: DisplayRequestContext,
  configuredLineage: string,
  pending: PendingDisplaySource[],
): Promise<void> {
  const fallbackAll = (reason: string) => {
    for (const item of pending) item.resolve({ status: 'fallback', reason })
  }
  if (pending.some((item) => item.priority !== 'normal') && activeDisplaySourceChatId !== chatId) {
    fallbackAll('display_scope_changed')
    return
  }
  const isCurrent = () =>
    canUseDisplaySourceProtocol() &&
    databaseLineage === configuredLineage &&
    pending.every(
      (item) =>
        item.clientGeneration === displaySourceClientGeneration &&
        isClientSessionGenerationCurrent(item.sessionGeneration),
    )
  if (!isCurrent()) {
    fallbackAll('display_namespace_changed')
    return
  }

  let auth: string
  try {
    auth = await getNodeServerProxyAuth()
  } catch {
    fallbackAll('auth_unavailable')
    return
  }

  if (!isCurrent()) {
    fallbackAll('display_namespace_changed')
    return
  }
  const baseRevision = peekCachedServerCommandRevision()
  if (baseRevision === null) {
    fallbackAll('revision_unavailable')
    return
  }

  let response: Response
  const controller = new AbortController()
  activeFetches.set(controller, {
    chatId,
    cancellable: pending.some((item) => item.priority !== 'normal'),
  })
  try {
    response = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/display-sources`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
        [SERVER_DATABASE_LINEAGE_HEADER]: configuredLineage,
        ...activeWriterSessionHeader(),
      },
      body: JSON.stringify({
        protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION,
        baseRevision,
        context,
        targets: pending.map((item) => item.target),
      }),
    })
  } catch {
    fallbackAll(
      controller.signal.aborted && typeof controller.signal.reason === 'string'
        ? controller.signal.reason
        : 'network_error',
    )
    return
  } finally {
    activeFetches.delete(controller)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!isCurrent()) {
    fallbackAll('display_namespace_changed')
    return
  }
  if (pending.some((item) => item.priority !== 'normal') && activeDisplaySourceChatId !== chatId) {
    fallbackAll('display_scope_changed')
    return
  }
  if (!response.ok) {
    if (!pending[0].reader) handleActiveWriterStaleResponse(response, body, pending[0].sessionGeneration)
    if (
      response.status === 409 &&
      body &&
      typeof body === 'object' &&
      Number.isSafeInteger((body as { currentRevision?: unknown }).currentRevision)
    ) {
      setCachedServerCommandRevision((body as { currentRevision: number }).currentRevision)
    }
    fallbackAll(response.status === 409 ? 'revision_conflict' : `http_${response.status}`)
    return
  }
  if (!isDisplaySourceResponse(body)) {
    fallbackAll('invalid_response')
    return
  }
  if (body.revision < baseRevision || body.revision < (peekCachedServerCommandRevision() ?? 0)) {
    fallbackAll('stale_response')
    return
  }
  // A namespace mismatch must never advance even the shared read revision fence.
  if (pending.some((item) => body.contextFingerprint !== item.expectedContextFingerprint)) {
    fallbackAll('stale_response')
    return
  }
  setCachedServerCommandRevision(body.revision)

  const entries = new Map(body.entries.map((entry) => [entry.requestKey, entry]))
  for (const item of pending) {
    const entry = entries.get(item.target.requestKey)
    if (
      body.contextFingerprint !== item.expectedContextFingerprint ||
      !entry ||
      entry.sourceHash !== item.target.sourceHash
    ) {
      item.resolve({ status: 'fallback', reason: 'stale_response' })
      continue
    }
    if (entry.status !== 'ok') {
      item.resolve({ status: 'fallback', reason: entry.reason })
      continue
    }
    item.resolve({
      status: 'ok',
      displaySource: entry.displaySource,
      dependencyFingerprint: entry.dependencyFingerprint,
    })
  }
}

function isDisplaySourceResponse(value: unknown): value is DisplaySourceResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    record.protocolVersion !== DISPLAY_SOURCE_PROTOCOL_VERSION ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0 ||
    typeof record.contextFingerprint !== 'string' ||
    !Array.isArray(record.entries)
  ) {
    return false
  }
  return record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const row = entry as Record<string, unknown>
    if (typeof row.requestKey !== 'string' || typeof row.sourceHash !== 'string' || typeof row.status !== 'string') {
      return false
    }
    return row.status === 'ok'
      ? typeof row.displaySource === 'string' && typeof row.dependencyFingerprint === 'string'
      : (row.status === 'client_fallback' || row.status === 'stale' || row.status === 'error') &&
          typeof row.reason === 'string'
  })
}

let observedSessionGeneration = captureClientSessionGeneration()
clientSessionStore.subscribe((session) => {
  if (session.generation === observedSessionGeneration) return
  observedSessionGeneration = session.generation
  clearDisplaySourceDedupeCache()
})
