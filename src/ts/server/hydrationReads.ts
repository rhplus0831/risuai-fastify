import { beginCacheDiagnostic } from './protocolDiagnostics'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import {
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  requireClientAuthentication,
} from '../clientSession'
import { canUseServerResourceReads } from './resourceReads'
import { isServerBulkChatMessagesResource, isServerChatMessagesResource } from '@risuai/protocol/chat-messages-resource'
import {
  captureResourceCacheGeneration,
  isResourceCacheMetadata,
  persistResourceCache,
  prepareResourceCacheRequest,
  resourceCacheRequestBody,
  resolveResourceCacheArray,
  resolveResourceCacheValue,
  type PreparedResourceCacheRequest,
  type ResourceCacheDescriptor,
  type ResourceCacheUpdate,
} from './resourceCache'

export async function fetchServerLegacyPreset(
  presetId: string,
  options: { signal?: AbortSignal | null } = {},
): Promise<
  | { status: 'ok'; revision: number; presetId: string; preset: Record<string, unknown> }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }
> {
  if (!canUseServerResourceReads()) return { status: 'unavailable' }
  const result = await requestCacheNegotiatedHydrationJson(
    `/api/v1/legacy-presets/${encodeURIComponent(presetId)}`,
    options.signal,
    [{ name: 'preset', key: `legacy-preset:${presetId}` }],
    async (record, prepared) => {
      if (!isResourceCacheMetadata(record.cache) || !Object.prototype.hasOwnProperty.call(record, 'preset')) {
        return null
      }
      const snapshot = prepared.snapshots.get('preset')
      if (!snapshot) return null
      const resolved = await resolveResourceCacheValue(record.preset, snapshot, prepared.hashes.preset ?? [])
      if (
        !resolved ||
        !isResourceRevision(record.revision) ||
        !resolved.value ||
        typeof resolved.value !== 'object' ||
        Array.isArray(resolved.value)
      ) {
        return null
      }
      return {
        body: { ...record, preset: resolved.value },
        updates: [{ key: `legacy-preset:${presetId}`, hashes: resolved.hashes, values: [resolved.value] }],
      }
    },
  )
  if (result.status !== 'ok') return { status: 'error', error: result.error }
  const body = result.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'error', error: 'Invalid preset response' }
  }

  const record = body as Record<string, unknown>
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  if (!record.preset || typeof record.preset !== 'object' || Array.isArray(record.preset)) {
    return { status: 'error', error: 'Invalid preset response' }
  }
  const preset = record.preset as Record<string, unknown>
  return {
    status: 'ok',
    revision: record.revision as number,
    presetId: typeof preset.id === 'string' && preset.id.trim() !== '' ? preset.id : presetId,
    preset,
  }
}

export type ServerPromptPresetTemplateResult =
  | {
      status: 'ok'
      revision: number
      promptPresetId: string
      promptTemplate: unknown[] | null
      selectedFallbackPromptTemplate?: unknown[]
    }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

/** Fetch the lazily stored template owned by one prompt preset. */
export async function fetchServerPromptPresetTemplate(
  promptPresetId: string,
  options: { signal?: AbortSignal | null } = {},
): Promise<ServerPromptPresetTemplateResult> {
  if (!canUseServerResourceReads()) return { status: 'unavailable' }
  if (typeof promptPresetId !== 'string' || promptPresetId.trim() === '') {
    return { status: 'error', error: 'Prompt preset id is required' }
  }

  const templateCacheKey = `prompt-preset-template:${promptPresetId}`
  const fallbackCacheKey = `prompt-preset-fallback:${promptPresetId}`
  const result = await requestCacheNegotiatedHydrationJson(
    `/api/v1/prompt-presets/${encodeURIComponent(promptPresetId)}/template`,
    options.signal,
    [
      { name: 'promptTemplate', key: templateCacheKey },
      { name: 'selectedFallbackPromptTemplate', key: fallbackCacheKey },
    ],
    async (record, prepared) => {
      if (!isResourceCacheMetadata(record.cache) || !Object.prototype.hasOwnProperty.call(record, 'promptTemplate')) {
        return null
      }
      const templateSnapshot = prepared.snapshots.get('promptTemplate')
      if (!templateSnapshot) return null
      const mixedTemplate = record.promptTemplate
      const template = Array.isArray(mixedTemplate)
        ? await resolveResourceCacheArray(mixedTemplate, templateSnapshot, prepared.hashes.promptTemplate ?? [])
        : await resolveResourceCacheValue(mixedTemplate, templateSnapshot, prepared.hashes.promptTemplate ?? [])
      if (!template || (template.value !== null && !Array.isArray(template.value))) return null

      const updates: ResourceCacheUpdate[] = [
        {
          key: templateCacheKey,
          hashes: template.hashes,
          values: Array.isArray(template.value) ? template.value : [template.value],
        },
      ]
      const reconstructed: Record<string, unknown> = { ...record, promptTemplate: template.value }
      const hasSelectedFallback = Object.prototype.hasOwnProperty.call(record, 'selectedFallbackPromptTemplate')
      if (hasSelectedFallback) {
        const fallbackSnapshot = prepared.snapshots.get('selectedFallbackPromptTemplate')
        if (!fallbackSnapshot) return null
        const fallback = await resolveResourceCacheArray(
          record.selectedFallbackPromptTemplate,
          fallbackSnapshot,
          prepared.hashes.selectedFallbackPromptTemplate ?? [],
        )
        if (!fallback) return null
        reconstructed.selectedFallbackPromptTemplate = fallback.value
        updates.push({ key: fallbackCacheKey, hashes: fallback.hashes, values: fallback.value })
      }

      if (
        !isResourceRevision(record.revision) ||
        record.promptPresetId !== promptPresetId ||
        (hasSelectedFallback &&
          (template.value !== null || !Array.isArray(reconstructed.selectedFallbackPromptTemplate)))
      ) {
        return null
      }
      return { body: reconstructed, updates }
    },
  )
  if (result.status !== 'ok') return { status: 'error', error: result.error }
  const body = result.body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'error', error: 'Invalid prompt preset template response' }
  }

  const record = body as Record<string, unknown>
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  const hasSelectedFallback = Object.prototype.hasOwnProperty.call(record, 'selectedFallbackPromptTemplate')
  if (
    record.promptPresetId !== promptPresetId ||
    (record.promptTemplate !== null && !Array.isArray(record.promptTemplate)) ||
    (hasSelectedFallback && (record.promptTemplate !== null || !Array.isArray(record.selectedFallbackPromptTemplate)))
  ) {
    return { status: 'error', error: 'Invalid prompt preset template response' }
  }
  return {
    status: 'ok',
    revision: record.revision as number,
    promptPresetId,
    promptTemplate: record.promptTemplate as unknown[] | null,
    ...(hasSelectedFallback
      ? { selectedFallbackPromptTemplate: record.selectedFallbackPromptTemplate as unknown[] }
      : {}),
  }
}

export type ServerChatMessagesResult =
  | {
      status: 'ok'
      revision: number
      chatId: string
      message: unknown[]
      hypaV3Data?: unknown
      /** False only for a narrow generation suffix that deliberately omitted chat-wide Hypa state. */
      hypaV3DataIncluded: boolean
      messageStart?: number
      messageTotal?: number
      // Persisted reroll candidates for this chat's turn (the alternate rows).
      // Always present (empty array when none); the client seeds its swipe buffer
      // from these so rerolls survive a reload.
      alternates: unknown[]
    }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export type ServerBulkChatMessagesResult =
  | {
      status: 'ok'
      revision: number
      chats: Array<{
        chatId: string
        message: unknown[]
        hypaV3Data?: unknown
        alternates: unknown[]
      }>
      missing: string[]
    }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

/** Fetch full, tail, or ranged chat-message hydration from the server. */
export async function fetchServerChatMessages(
  chatId: string,
  options: { signal?: AbortSignal | null; start?: number; limit?: number; tail?: number } = {},
): Promise<ServerChatMessagesResult> {
  return fetchServerChatMessagesFromEndpoint(chatId, options)
}

/** Fetch the authoritative suffix changed by one generation-persisted event. */
export async function fetchServerGenerationChatMessages(
  chatId: string,
  generationMessageId: string,
  options: { signal?: AbortSignal | null } = {},
): Promise<ServerChatMessagesResult> {
  if (!nonEmptyString(generationMessageId)) {
    return { status: 'error', error: 'Generation message id is required' }
  }
  return fetchServerChatMessagesFromEndpoint(chatId, { ...options, generationMessageId })
}

async function fetchServerChatMessagesFromEndpoint(
  chatId: string,
  options: {
    signal?: AbortSignal | null
    start?: number
    limit?: number
    tail?: number
    generationMessageId?: string
  },
): Promise<ServerChatMessagesResult> {
  const generation = captureClientSessionGeneration()
  if (!canUseServerResourceReads()) return { status: 'unavailable' }

  const query = new URLSearchParams()
  if (nonEmptyString(options.generationMessageId)) {
    query.set('generationMessageId', options.generationMessageId)
  } else if (Number.isInteger(options.tail) && (options.tail as number) > 0) {
    query.set('tail', String(options.tail))
  } else if (
    Number.isInteger(options.start) &&
    (options.start as number) >= 0 &&
    Number.isInteger(options.limit) &&
    (options.limit as number) > 0
  ) {
    query.set('start', String(options.start))
    query.set('limit', String(options.limit))
  }
  const suffix = query.toString()
  const url = `/api/v1/chats/${encodeURIComponent(chatId)}/messages${suffix ? `?${suffix}` : ''}`
  const auth = await getNodeServerProxyAuth()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: options.signal ?? undefined,
      headers: { 'risu-auth': auth },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (response.status === 401) await discardHydrationAuthLoss(response.status, generation, options.signal)

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Reported via HTTP status below.
  }

  if (!response.ok) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }
  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid chat-messages response' }
  }

  const record = body as Record<string, unknown>
  const generationRequest = nonEmptyString(options.generationMessageId)
  const hypaV3DataIncluded = !generationRequest || Object.prototype.hasOwnProperty.call(record, 'hypaV3Data')
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  if (
    (record.messageStart !== undefined || record.messageTotal !== undefined) &&
    (!Number.isInteger(record.messageStart) ||
      (record.messageStart as number) < 0 ||
      !Number.isInteger(record.messageTotal) ||
      (record.messageTotal as number) < 0 ||
      (record.messageStart as number) > (record.messageTotal as number))
  ) {
    return { status: 'error', error: 'Invalid chat-messages range' }
  }
  if (!isServerChatMessagesResource(record)) {
    return { status: 'error', error: 'Invalid chat-messages response' }
  }
  return {
    status: 'ok',
    revision: revision as number,
    chatId: typeof record.chatId === 'string' ? record.chatId : chatId,
    message: record.message as unknown[],
    hypaV3Data: record.hypaV3Data,
    hypaV3DataIncluded,
    ...(typeof record.messageStart === 'number' && typeof record.messageTotal === 'number'
      ? {
          messageStart: record.messageStart,
          messageTotal: record.messageTotal,
        }
      : {}),
    alternates: Array.isArray(record.alternates) ? (record.alternates as unknown[]) : [],
  }
}

/**
 * Bulk chat message hydration for workflows that need every chat history. The
 * open chat still uses the single-chat path to keep active-chat dedupe narrow.
 */
export async function fetchServerBulkChatMessages(
  chatIds: readonly string[],
  options: { signal?: AbortSignal | null } = {},
): Promise<ServerBulkChatMessagesResult> {
  const generation = captureClientSessionGeneration()
  if (!canUseServerResourceReads()) return { status: 'unavailable' }

  const auth = await getNodeServerProxyAuth()
  let response: Response
  try {
    response = await fetch('/api/v1/chats/messages/bulk', {
      method: 'POST',
      signal: options.signal ?? undefined,
      headers: { 'content-type': 'application/json', 'risu-auth': auth },
      body: JSON.stringify({ ids: chatIds }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (response.status === 401) await discardHydrationAuthLoss(response.status, generation, options.signal)

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Reported via HTTP status below.
  }

  if (!response.ok) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }
  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid bulk chat-messages response' }
  }

  const record = body as Record<string, unknown>
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  if (
    Array.isArray(record.chats) &&
    record.chats.some(
      (chat) =>
        !chat ||
        typeof chat !== 'object' ||
        typeof (chat as Record<string, unknown>).chatId !== 'string' ||
        !Array.isArray((chat as Record<string, unknown>).message),
    )
  ) {
    return { status: 'error', error: 'Invalid bulk chat-messages entry' }
  }
  if (!isServerBulkChatMessagesResource(record)) {
    return { status: 'error', error: 'Invalid bulk chat-messages response' }
  }

  const chats: Extract<ServerBulkChatMessagesResult, { status: 'ok' }>['chats'] = record.chats.map((chat) => ({
    ...chat,
    alternates: chat.alternates ?? [],
  }))

  return {
    status: 'ok',
    revision: revision as number,
    chats,
    missing: record.missing.filter((value): value is string => typeof value === 'string'),
  }
}

export type ServerCharacterLorebookResult =
  | { status: 'ok'; revision: number; characterId: string; globalLore: unknown[] }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export type ServerBulkCharacterLorebookResult =
  | {
      status: 'ok'
      revision: number
      characters: Array<{
        characterId: string
        globalLore: unknown[]
      }>
      missing: string[]
    }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

/**
 * Per-character `globalLore` hydration. When `enableLorebookStubs` is on, the
 * character metadata may carry a lorebook stub; this fetches the full
 * globalLore on character-open.
 */
export async function fetchServerCharacterLorebook(
  characterId: string,
  options: { signal?: AbortSignal | null } = {},
): Promise<ServerCharacterLorebookResult> {
  if (!canUseServerResourceReads()) return { status: 'unavailable' }

  const url = `/api/v1/characters/${encodeURIComponent(characterId)}/lorebook`
  const cacheKey = `character-lorebook:${characterId}`
  const result = await requestCacheNegotiatedHydrationJson(
    url,
    options.signal,
    [{ name: 'globalLore', key: cacheKey }],
    async (record, prepared) => {
      if (!isResourceCacheMetadata(record.cache)) return null
      const snapshot = prepared.snapshots.get('globalLore')
      if (!snapshot) return null
      const lorebook = await resolveResourceCacheArray(record.globalLore, snapshot, prepared.hashes.globalLore ?? [])
      if (!lorebook || !isResourceRevision(record.revision)) return null
      return {
        body: { ...record, globalLore: lorebook.value },
        updates: [{ key: cacheKey, hashes: lorebook.hashes, values: lorebook.value }],
      }
    },
  )
  if (result.status !== 'ok') return { status: 'error', error: result.error }
  const body = result.body
  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid character-lorebook response' }
  }

  const record = body as Record<string, unknown>
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  if (!Array.isArray(record.globalLore)) {
    return { status: 'error', error: 'Invalid character-lorebook response' }
  }
  const responseCharacterId = typeof record.characterId === 'string' ? record.characterId : characterId
  if (responseCharacterId !== characterId) {
    return { status: 'error', error: 'Invalid character-lorebook identity' }
  }
  return {
    status: 'ok',
    revision: revision as number,
    characterId: responseCharacterId,
    globalLore: record.globalLore as unknown[],
  }
}

/**
 * Bulk character `globalLore` hydration for workflows that need every
 * character lorebook. The open character still uses the single-character path.
 */
export async function fetchServerBulkCharacterLorebooks(
  characterIds: readonly string[],
  options: { signal?: AbortSignal | null } = {},
): Promise<ServerBulkCharacterLorebookResult> {
  const generation = captureClientSessionGeneration()
  if (!canUseServerResourceReads()) return { status: 'unavailable' }

  const auth = await getNodeServerProxyAuth()
  let response: Response
  try {
    response = await fetch('/api/v1/characters/lorebooks/bulk', {
      method: 'POST',
      signal: options.signal ?? undefined,
      headers: { 'content-type': 'application/json', 'risu-auth': auth },
      body: JSON.stringify({ ids: characterIds }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (response.status === 401) await discardHydrationAuthLoss(response.status, generation, options.signal)

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Reported via HTTP status below.
  }

  if (!response.ok) {
    return { status: 'error', error: errorMessageFromBody(body, `HTTP ${response.status}`) }
  }
  if (!body || typeof body !== 'object') {
    return { status: 'error', error: 'Invalid bulk character-lorebook response' }
  }

  const record = body as Record<string, unknown>
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    return { status: 'error', error: 'Invalid resource revision' }
  }
  if (!Array.isArray(record.characters)) {
    return { status: 'error', error: 'Invalid bulk character-lorebook response' }
  }

  const characters: Extract<ServerBulkCharacterLorebookResult, { status: 'ok' }>['characters'] = []
  for (const raw of record.characters) {
    if (!raw || typeof raw !== 'object') {
      return { status: 'error', error: 'Invalid bulk character-lorebook entry' }
    }
    const character = raw as Record<string, unknown>
    if (typeof character.characterId !== 'string' || !Array.isArray(character.globalLore)) {
      return { status: 'error', error: 'Invalid bulk character-lorebook entry' }
    }
    characters.push({
      characterId: character.characterId,
      globalLore: character.globalLore as unknown[],
    })
  }

  return {
    status: 'ok',
    revision: revision as number,
    characters,
    missing: Array.isArray(record.missing)
      ? record.missing.filter((value): value is string => typeof value === 'string')
      : [],
  }
}

type HydrationJsonRequestResult =
  | { status: 'ok'; body: unknown }
  | { status: 'error'; error: string; httpStatus?: number }

interface ReconstructedHydrationCacheResponse {
  body: unknown
  updates: ResourceCacheUpdate[]
}

async function requestCacheNegotiatedHydrationJson(
  url: string,
  signal: AbortSignal | null | undefined,
  descriptors: readonly ResourceCacheDescriptor[],
  reconstruct: (
    record: Record<string, unknown>,
    prepared: PreparedResourceCacheRequest,
  ) => Promise<ReconstructedHydrationCacheResponse | null>,
): Promise<HydrationJsonRequestResult> {
  const finishCache = beginCacheDiagnostic()
  const generation = captureClientSessionGeneration()
  const cacheGeneration = captureResourceCacheGeneration()
  const auth = await getNodeServerProxyAuth()
  const request = (options: { method?: 'GET' | 'POST'; body?: unknown } = {}) =>
    requestHydrationJson(url, auth, signal, options, generation)
  const fallback = () => {
    finishCache('failed')
    return request()
  }
  const prepared = await prepareResourceCacheRequest(descriptors)
  if (!prepared) {
    finishCache('unknown')
    return request()
  }

  const result = await request({
    method: 'POST',
    body: resourceCacheRequestBody(prepared.hashes),
  })
  if (result.status !== 'ok') {
    finishCache(signal?.aborted ? 'cancelled' : 'failed')
    return shouldFallbackHydrationCachePost(result) ? request() : result
  }

  if (!isRecord(result.body)) return fallback()
  try {
    const reconstructed = await reconstruct(result.body, prepared)
    if (!reconstructed) return fallback()
    void persistResourceCache(reconstructed.updates, cacheGeneration)
    finishCache('ready')
    return { status: 'ok', body: reconstructed.body }
  } catch {
    return fallback()
  }
}

async function requestHydrationJson(
  url: string,
  auth: string,
  signal: AbortSignal | null | undefined,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
  generation = captureClientSessionGeneration(),
): Promise<HydrationJsonRequestResult> {
  const method = options.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(url, {
      method,
      signal: signal ?? undefined,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        'risu-auth': auth,
      },
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: `Network error: ${message}` }
  }

  if (response.status === 401) await discardHydrationAuthLoss(response.status, generation, signal)

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Reported via HTTP status or response validation by the caller.
  }
  if (!response.ok) {
    return {
      status: 'error',
      error: errorMessageFromBody(body, `HTTP ${response.status}`),
      httpStatus: response.status,
    }
  }
  return { status: 'ok', body }
}

async function discardHydrationAuthLoss(
  status: number,
  generation: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (status !== 401 || !isClientSessionGenerationCurrent(generation) || signal?.aborted) return
  requireClientAuthentication()
  const authGeneration = captureClientSessionGeneration()
  const { discardObserverProjectionState } = await import('../observerProjectionLifecycle')
  if (isClientSessionGenerationCurrent(authGeneration)) await discardObserverProjectionState('auth-loss')
}

function shouldFallbackHydrationCachePost(result: HydrationJsonRequestResult): boolean {
  return (
    result.status === 'error' &&
    result.httpStatus !== undefined &&
    [400, 404, 405, 413, 415].includes(result.httpStatus)
  )
}

function isResourceRevision(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
