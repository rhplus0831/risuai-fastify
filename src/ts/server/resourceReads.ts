import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import {
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
  requireClientAuthentication,
} from '../clientSession'
import { peekCachedServerCommandRevision } from './commands'
import type { Chat, character } from '../storage/database.svelte'
import {
  SERVER_CHARACTER_SUMMARY_VERSION,
  isServerCharactersSummaryPayload,
  type ServerCharacterSummary,
  type ServerCharactersSummaryPayload,
} from '@risuai/protocol/character-summary-resource'
import {
  isServerCharacterDetailResource,
  isServerCharacterOrderResource,
  isServerCharacterSelectionResource,
} from '@risuai/protocol/character-resource'
import { isServerChatMetadataResource } from '@risuai/protocol/chat-metadata'
import { SERVER_SETTINGS_KEYS_BY_GROUP, isSettingsGroup, type SettingsGroup } from './settingsGroups'
import {
  captureResourceCacheGeneration,
  isResourceCacheMetadata,
  persistResourceCache,
  prepareResourceCacheRequest,
  resourceCacheRequestBody,
  resolveResourceCacheArray,
  resolveResourceCacheValue,
  type ResourceCacheUpdate,
} from './resourceCache'
import {
  SERVER_COLLECTION_NAMES,
  isServerCollectionName,
  type ServerCharacterResourcePayload,
  type ServerCharacterOrderResourcePayload,
  type ServerCharacterSelectionResourcePayload,
  type ServerCharactersResourcePayload,
  type ServerCollectionName,
  type ServerCollectionsResourcePayload,
  type ServerCollectionValues,
  type ServerSettingsResourcePayload,
  type ServerSettingsGroupResourcePayload,
  type ServerSettingsValues,
} from './resourceState.svelte'
import { isServerInlayCatalogPayload, type ServerInlayCatalogResourcePayload } from './inlayCatalog'
import {
  SERVER_SHELL_PROTOCOL_VERSION,
  isServerShellPayload,
  type ServerShellSettings,
} from '@risuai/protocol/shell-resource'
import {
  isServerStandaloneSettingName,
  isServerStandaloneSettingPayload,
  type ServerStandaloneSettingName,
  type ServerStandaloneSettingPayload,
} from '@risuai/protocol/standalone-settings'
import {
  isBardWikiChatResource,
  isBardWikiDocumentResource,
  isBardWikiVersionsResource,
  type BardWikiChatResource,
  type BardWikiDocumentResource,
  type BardWikiVersionsResource,
} from '@risuai/protocol'

const SETTINGS_ENDPOINT = '/api/v1/settings'
const COLLECTIONS_ENDPOINT = '/api/v1/collections'
const CHARACTERS_ENDPOINT = '/api/v1/characters'
const INLAY_CATALOG_ENDPOINT = '/api/v1/inlay-assets'
const SHELL_ENDPOINT = '/api/v1/resources/shell'
const STANDALONE_SETTINGS_ENDPOINT = '/api/v1/resources/settings'
const CHARACTER_ORDER_ENDPOINT = `${CHARACTERS_ENDPOINT}/order`
const BARDWIKI_ENDPOINT = '/api/v1/bardwiki/chats'
const SETTINGS_CACHE_KEY = 'settings:all'
const CHARACTERS_CACHE_KEY = `characters:summary:v${SERVER_CHARACTER_SUMMARY_VERSION}`

type ServerResourceJsonRequestResult =
  | { status: 'ok'; body: unknown }
  | { status: 'error'; error: string; httpStatus?: number }
  | { status: 'unavailable' }

export type ServerResourceReadResult<T extends { revision: number }> =
  | ({ status: 'ok' } & T)
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export interface ServerShellResourcePayload {
  protocolVersion: typeof SERVER_SHELL_PROTOCOL_VERSION
  revision: number
  settings: ServerShellSettings
  characters: ServerCharactersResourcePayload
}

export function canUseServerResourceReads(): boolean {
  return true
}

export async function fetchServerShell(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerShellResourcePayload>> {
  const result = await requestServerResourceJson(SHELL_ENDPOINT, signal)
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (!isServerShellPayload(result.body)) {
    return { status: 'error', error: 'Invalid shell response' }
  }

  return {
    status: 'ok',
    protocolVersion: result.body.protocolVersion,
    revision: result.body.revision,
    settings: result.body.settings,
    characters: {
      version: result.body.characters.version,
      revision: result.body.characters.revision,
      characters: result.body.characters.characters.map(characterSummaryToShell),
      characterOrder: result.body.characters.characterOrder as ServerCharactersResourcePayload['characterOrder'],
      currentChar: result.body.characters.currentChar,
    },
  }
}

export async function fetchServerStandaloneSetting(
  setting: ServerStandaloneSettingName,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerStandaloneSettingPayload>> {
  if (!isServerStandaloneSettingName(setting)) return { status: 'error', error: 'Unknown standalone setting' }
  const result = await requestServerResourceJson(
    `${STANDALONE_SETTINGS_ENDPOINT}/${encodeURIComponent(setting)}`,
    signal,
  )
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (!isServerStandaloneSettingPayload(result.body) || result.body.setting !== setting) {
    return { status: 'error', error: 'Invalid standalone setting response' }
  }
  return {
    status: 'ok',
    revision: result.body.revision,
    setting,
    state: result.body.state.present
      ? { present: true, value: structuredClone(result.body.state.value) }
      : { present: false },
  }
}

export async function fetchServerBardWikiChat(
  chatId: string,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<BardWikiChatResource>> {
  if (!nonEmptyString(chatId)) return { status: 'error', error: 'Chat id is required' }
  const result = await requestServerResourceJson(`${BARDWIKI_ENDPOINT}/${encodeURIComponent(chatId)}`, signal)
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (!isBardWikiChatResource(result.body) || result.body.chatId !== chatId) {
    return { status: 'error', error: 'Invalid BardWiki chat response' }
  }
  return { status: 'ok', ...structuredClone(result.body) }
}

export async function fetchServerBardWikiDocument(
  chatId: string,
  documentId: string,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<BardWikiDocumentResource>> {
  if (!nonEmptyString(chatId) || !nonEmptyString(documentId)) {
    return { status: 'error', error: 'Chat and document ids are required' }
  }
  const result = await requestServerResourceJson(
    `${BARDWIKI_ENDPOINT}/${encodeURIComponent(chatId)}/documents/${encodeURIComponent(documentId)}`,
    signal,
  )
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (
    !isBardWikiDocumentResource(result.body) ||
    result.body.chatId !== chatId ||
    result.body.document.id !== documentId ||
    result.body.document.chatId !== chatId
  ) {
    return { status: 'error', error: 'Invalid BardWiki document response' }
  }
  return { status: 'ok', ...structuredClone(result.body) }
}

export async function fetchServerBardWikiVersions(
  chatId: string,
  documentId: string,
  options: { limit?: number; beforeVersion?: number; signal?: AbortSignal | null } = {},
): Promise<ServerResourceReadResult<BardWikiVersionsResource>> {
  if (!nonEmptyString(chatId) || !nonEmptyString(documentId)) {
    return { status: 'error', error: 'Chat and document ids are required' }
  }
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.beforeVersion !== undefined) query.set('beforeVersion', String(options.beforeVersion))
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const result = await requestServerResourceJson(
    `${BARDWIKI_ENDPOINT}/${encodeURIComponent(chatId)}/documents/${encodeURIComponent(documentId)}/versions${suffix}`,
    options.signal,
  )
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (
    !isBardWikiVersionsResource(result.body) ||
    result.body.chatId !== chatId ||
    result.body.documentId !== documentId
  ) {
    return { status: 'error', error: 'Invalid BardWiki versions response' }
  }
  return { status: 'ok', ...structuredClone(result.body) }
}

export async function fetchServerInlayCatalog(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerInlayCatalogResourcePayload>> {
  const result = await requestServerResourceJson(INLAY_CATALOG_ENDPOINT, signal)
  if (result.status !== 'ok') return resourceReadFailure(result)
  if (!isServerInlayCatalogPayload(result.body)) {
    return { status: 'error', error: 'Invalid inlay catalog response' }
  }
  return {
    status: 'ok',
    revision: result.body.revision,
    assets: result.body.assets.map((entry) => ({ ...entry, aliases: [...entry.aliases] })),
  }
}

export async function fetchServerSettings(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerSettingsResourcePayload>> {
  const result = await requestCachedSingularResource(
    SETTINGS_ENDPOINT,
    'settings',
    SETTINGS_CACHE_KEY,
    signal,
    (value, record) =>
      readRevisionEnvelope(record) !== null && isPlainRecord(value) && !containsNonSettingResource(value),
  )
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (!record || !isPlainRecord(record.settings)) {
    return { status: 'error', error: 'Invalid settings response' }
  }
  if (containsNonSettingResource(record.settings)) {
    return { status: 'error', error: 'Settings response contained non-setting resources' }
  }
  return {
    status: 'ok',
    revision: record.revision,
    settings: record.settings as ServerSettingsValues,
  }
}

export async function fetchServerSettingsGroup(
  group: SettingsGroup,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerSettingsGroupResourcePayload>> {
  if (!isSettingsGroup(group)) return { status: 'error', error: 'Unknown settings group' }
  const result = await requestCachedSingularResource(
    `${SETTINGS_ENDPOINT}/${encodeURIComponent(group)}`,
    'settings',
    `settings:group:${group}`,
    signal,
    (value, record) =>
      readRevisionEnvelope(record) !== null &&
      record.group === group &&
      isPlainRecord(value) &&
      !containsNonSettingResource(value) &&
      Object.keys(value).every((key) => key !== 'hypaV3Presets' && SERVER_SETTINGS_KEYS_BY_GROUP[group].includes(key)),
  )
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (!record || record.group !== group || !isPlainRecord(record.settings)) {
    return { status: 'error', error: 'Invalid settings group response' }
  }
  if (
    containsNonSettingResource(record.settings) ||
    Object.keys(record.settings).some(
      (key) => key === 'hypaV3Presets' || !SERVER_SETTINGS_KEYS_BY_GROUP[group].includes(key),
    )
  ) {
    return { status: 'error', error: `Invalid ${group} settings response` }
  }
  return {
    status: 'ok',
    revision: record.revision,
    group,
    settings: record.settings as ServerSettingsValues,
  }
}

export async function fetchServerCollections(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerCollectionsResourcePayload>> {
  return fetchServerCollectionsFromEndpoint(COLLECTIONS_ENDPOINT, undefined, signal)
}

export async function fetchServerCollection(
  name: ServerCollectionName,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerCollectionsResourcePayload>> {
  return fetchServerCollectionsFromEndpoint(`${COLLECTIONS_ENDPOINT}/${encodeURIComponent(name)}`, name, signal)
}

export async function fetchServerCharacters(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerCharactersResourcePayload>> {
  const result = await requestCachedCharacters(signal)
  if (result.status !== 'ok') return resourceReadFailure(result)

  const payload = readCharactersSummaryEnvelope(result.body)
  if (!payload) {
    return { status: 'error', error: 'Invalid characters response' }
  }
  return {
    status: 'ok',
    version: payload.version,
    revision: payload.revision,
    characters: payload.characters.map(characterSummaryToShell),
    characterOrder: payload.characterOrder as ServerCharactersResourcePayload['characterOrder'],
    currentChar: payload.currentChar,
  }
}

type CharacterRead = ServerResourceReadResult<ServerCharacterResourcePayload>
interface SharedCharacterRead {
  controller: AbortController
  promise: Promise<CharacterRead>
  subscribers: number
  settled: boolean
}
const characterReads = new Map<string, SharedCharacterRead>()

/** Share transport only; each hydration/route owner retains its own apply fences. */
export async function fetchServerCharacter(characterId: string, signal?: AbortSignal | null): Promise<CharacterRead> {
  const generation = captureClientSessionGeneration()
  if (!nonEmptyString(characterId)) {
    return { status: 'error', error: 'Character id is required' }
  }
  const cancelled = (): CharacterRead => ({ status: 'error', error: 'Character request was cancelled' })
  if (signal?.aborted) return cancelled()
  const revision = peekCachedServerCommandRevision()
  const auth = await getNodeServerProxyAuth()
  if (signal?.aborted || !isClientSessionGenerationCurrent(generation)) return cancelled()
  // A newer revision or authentication scope needs a fresh read.
  const key = JSON.stringify([characterId, revision, auth, generation])
  let request = characterReads.get(key)
  if (!request || request.controller.signal.aborted) {
    const controller = new AbortController()
    const created: SharedCharacterRead = {
      controller,
      subscribers: 0,
      settled: false,
      promise: fetchServerCharacterOnce(characterId, controller.signal, auth).finally(() => {
        created.settled = true
        if (characterReads.get(key) === created) characterReads.delete(key)
      }),
    }
    characterReads.set(key, created)
    request = created
  }
  const shared = request
  shared.subscribers += 1
  return new Promise<CharacterRead>((resolve, reject) => {
    let finished = false
    const finish = (complete: () => void) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      shared.subscribers -= 1
      if (shared.subscribers === 0 && !shared.settled) {
        if (characterReads.get(key) === shared) characterReads.delete(key)
        shared.controller.abort()
      }
      complete()
    }
    const abort = () => finish(() => resolve(cancelled()))
    signal?.addEventListener('abort', abort, { once: true })
    shared.promise.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    )
  })
}

async function fetchServerCharacterOnce(
  characterId: string,
  signal: AbortSignal,
  auth: string,
): Promise<CharacterRead> {
  const result = await requestServerResourceJson(`${CHARACTERS_ENDPOINT}/${encodeURIComponent(characterId)}`, signal, {
    auth,
  })
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (
    !isServerCharacterDetailResource(result.body) ||
    !isServerChatMetadataResource(result.body) ||
    !isMessageFreeCharacter(record.character) ||
    record.character.chaId !== characterId
  ) {
    return { status: 'error', error: 'Invalid character response' }
  }
  return {
    status: 'ok',
    revision: record.revision,
    character: record.character as unknown as ServerCharacterResourcePayload['character'],
  }
}

export async function fetchServerCharacterOrder(
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerCharacterOrderResourcePayload>> {
  const result = await requestServerResourceJson(CHARACTER_ORDER_ENDPOINT, signal)
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (!isServerCharacterOrderResource(result.body)) {
    return { status: 'error', error: 'Invalid character order response' }
  }
  return {
    status: 'ok',
    revision: record.revision,
    characterOrder: record.characterOrder as ServerCharacterOrderResourcePayload['characterOrder'],
  }
}

export async function fetchServerCharacterSelection(
  characterId: string,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<ServerCharacterSelectionResourcePayload>> {
  if (!nonEmptyString(characterId)) {
    return { status: 'error', error: 'Character id is required' }
  }
  const result = await requestServerResourceJson(
    `${CHARACTERS_ENDPOINT}/${encodeURIComponent(characterId)}/selection`,
    signal,
  )
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (
    !isServerCharacterSelectionResource(result.body) ||
    record.characterId !== characterId ||
    !Number.isInteger(record.currentChar) ||
    (record.currentChar as number) < 0 ||
    (record.lastInteraction !== undefined &&
      (typeof record.lastInteraction !== 'number' || !Number.isFinite(record.lastInteraction)))
  ) {
    return { status: 'error', error: 'Invalid character selection response' }
  }
  return {
    status: 'ok',
    revision: record.revision,
    characterId,
    currentChar: record.currentChar as number,
    ...(typeof record.lastInteraction === 'number' ? { lastInteraction: record.lastInteraction } : {}),
  }
}

async function fetchServerCollectionsFromEndpoint(
  endpoint: string,
  requestedName: ServerCollectionName | undefined,
  signal: AbortSignal | null | undefined,
): Promise<ServerResourceReadResult<ServerCollectionsResourcePayload>> {
  const result = await requestCachedCollections(endpoint, requestedName, signal)
  if (result.status !== 'ok') return resourceReadFailure(result)

  const record = readRevisionEnvelope(result.body)
  if (!record || !isPlainRecord(record.collections)) {
    return { status: 'error', error: 'Invalid collections response' }
  }
  const names = Object.keys(record.collections)
  if (
    names.some((name) => !isServerCollectionName(name)) ||
    (requestedName ? names.length !== 1 || names[0] !== requestedName : !hasEveryServerCollection(names))
  ) {
    return { status: 'error', error: 'Invalid collections response' }
  }

  const collections: Partial<ServerCollectionValues> = {}
  for (const name of names) {
    if (!isServerCollectionName(name)) continue
    const value = record.collections[name]
    if (!isValidCollectionValue(name, value)) {
      return { status: 'error', error: `Invalid ${name} collection response` }
    }
    collections[name] = value as never
  }
  return {
    status: 'ok',
    revision: record.revision,
    collections,
  }
}

async function requestCachedSingularResource(
  endpoint: string,
  resourceName: string,
  cacheKey: string,
  signal: AbortSignal | null | undefined,
  validate: (value: unknown, record: Record<string, unknown>) => boolean,
): Promise<ServerResourceJsonRequestResult> {
  const generation = captureClientSessionGeneration()
  const request = (options: { method?: 'GET' | 'POST'; body?: unknown } = {}) =>
    requestServerResourceJson(endpoint, signal, options, generation)
  const cacheGeneration = captureResourceCacheGeneration()
  const prepared = await prepareResourceCacheRequest([{ name: resourceName, key: cacheKey }])
  if (!prepared) return request()

  const result = await request({
    method: 'POST',
    body: resourceCacheRequestBody(prepared.hashes),
  })
  if (result.status !== 'ok') {
    return shouldFallbackToLegacyGet(result) ? request() : result
  }

  const record = isPlainRecord(result.body) ? result.body : null
  if (
    !record ||
    !isResourceCacheMetadata(record.cache) ||
    !Object.prototype.hasOwnProperty.call(record, resourceName)
  ) {
    return request()
  }

  const snapshot = prepared.snapshots.get(resourceName)
  if (!snapshot) return request()
  try {
    const resolved = await resolveResourceCacheValue(
      record[resourceName],
      snapshot,
      prepared.hashes[resourceName] ?? [],
    )
    if (!resolved) return request()
    if (!validate(resolved.value, record)) {
      return request()
    }
    void persistResourceCache(
      [
        {
          key: cacheKey,
          hashes: resolved.hashes,
          values: [resolved.value],
        },
      ],
      cacheGeneration,
    )
    return {
      status: 'ok',
      body: { ...record, [resourceName]: resolved.value },
    }
  } catch {
    return request()
  }
}

async function requestCachedCollections(
  endpoint: string,
  requestedName: ServerCollectionName | undefined,
  signal: AbortSignal | null | undefined,
): Promise<ServerResourceJsonRequestResult> {
  const generation = captureClientSessionGeneration()
  const request = (options: { method?: 'GET' | 'POST'; body?: unknown } = {}) =>
    requestServerResourceJson(endpoint, signal, options, generation)
  const cacheGeneration = captureResourceCacheGeneration()
  const names: readonly ServerCollectionName[] = requestedName ? [requestedName] : SERVER_COLLECTION_NAMES
  const descriptors = names.map((name) => ({
    name,
    key: collectionCacheKey(name, requestedName === undefined),
  }))
  const prepared = await prepareResourceCacheRequest(descriptors)
  if (!prepared) return request()

  const result = await request({
    method: 'POST',
    body: resourceCacheRequestBody(prepared.hashes),
  })
  if (result.status !== 'ok') {
    return shouldFallbackToLegacyGet(result) ? request() : result
  }

  const record = isPlainRecord(result.body) ? result.body : null
  const mixedCollections = record && isPlainRecord(record.collections) ? record.collections : null
  if (
    !record ||
    !mixedCollections ||
    !isResourceCacheMetadata(record.cache) ||
    !hasExactCollectionNames(Object.keys(mixedCollections), names)
  ) {
    return request()
  }

  try {
    const collections: Partial<ServerCollectionValues> = {}
    const updates: ResourceCacheUpdate[] = []
    for (const descriptor of descriptors) {
      const name = descriptor.name as ServerCollectionName
      const snapshot = prepared.snapshots.get(name)
      if (!snapshot) return request()
      const sentHashes = prepared.hashes[name] ?? []
      const resolved =
        name === 'pluginCustomStorage'
          ? await resolveResourceCacheValue(mixedCollections[name], snapshot, sentHashes)
          : await resolveResourceCacheArray(mixedCollections[name], snapshot, sentHashes)
      if (!resolved) return request()

      collections[name] = resolved.value as never
      updates.push({
        key: descriptor.key,
        hashes: resolved.hashes,
        values: Array.isArray(resolved.value) ? resolved.value : [resolved.value],
      })
    }
    if (
      readRevisionEnvelope(record) === null ||
      !names.every((name) => isValidCollectionValue(name, collections[name]))
    ) {
      return request()
    }
    void persistResourceCache(updates, cacheGeneration)
    return {
      status: 'ok',
      body: { ...record, collections },
    }
  } catch {
    return request()
  }
}

async function requestCachedCharacters(
  signal: AbortSignal | null | undefined,
): Promise<ServerResourceJsonRequestResult> {
  const generation = captureClientSessionGeneration()
  const request = (options: { method?: 'GET' | 'POST'; body?: unknown } = {}) =>
    requestServerResourceJson(CHARACTERS_ENDPOINT, signal, options, generation)
  const cacheGeneration = captureResourceCacheGeneration()
  const prepared = await prepareResourceCacheRequest([{ name: 'characters', key: CHARACTERS_CACHE_KEY }])
  if (!prepared) return request()

  const result = await request({
    method: 'POST',
    body: resourceCacheRequestBody(prepared.hashes),
  })
  if (result.status !== 'ok') {
    return shouldFallbackToLegacyGet(result) ? request() : result
  }

  const record = isPlainRecord(result.body) ? result.body : null
  if (!record || !isResourceCacheMetadata(record.cache)) {
    return request()
  }
  const snapshot = prepared.snapshots.get('characters')
  if (!snapshot) return request()

  try {
    const resolved = await resolveResourceCacheArray(record.characters, snapshot, prepared.hashes.characters ?? [])
    if (!resolved) return request()
    const { cache: _cache, ...responsePayload } = record
    const payload = readCharactersSummaryEnvelope({ ...responsePayload, characters: resolved.value })
    if (!payload) return request()
    void persistResourceCache(
      [
        {
          key: CHARACTERS_CACHE_KEY,
          hashes: resolved.hashes,
          values: resolved.value,
        },
      ],
      cacheGeneration,
    )
    return {
      status: 'ok',
      body: payload,
    }
  } catch {
    return request()
  }
}

function readCharactersSummaryEnvelope(value: unknown): ServerCharactersSummaryPayload | null {
  return isServerCharactersSummaryPayload(value) ? value : null
}

function characterSummaryToShell(summary: ServerCharacterSummary): character {
  const pinnedChatsById = new Map(summary.pinnedChats.map((chat) => [chat.id, chat]))
  const chats = summary.chatIds.map((id) => {
    const pinned = pinnedChatsById.get(id)
    return {
      id,
      name: pinned?.name ?? '',
      ...(pinned ? { pinned: true } : {}),
      message: [],
    } as Chat
  })
  const activeChatIndex = summary.activeChatId === null ? -1 : summary.chatIds.indexOf(summary.activeChatId)
  return {
    ...summary,
    chats,
    chatPage: activeChatIndex >= 0 ? activeChatIndex : 0,
    chatFolders: [],
  } as unknown as character
}

function collectionCacheKey(name: ServerCollectionName, aggregate: boolean): string {
  return name === 'promptTemplate' && aggregate ? 'collection:promptTemplate:aggregate' : `collection:${name}`
}

function hasExactCollectionNames(names: readonly string[], expected: readonly ServerCollectionName[]): boolean {
  return names.length === expected.length && expected.every((name) => names.includes(name))
}

function shouldFallbackToLegacyGet(result: ServerResourceJsonRequestResult): boolean {
  return (
    result.status === 'error' &&
    result.httpStatus !== undefined &&
    [400, 404, 405, 413, 415].includes(result.httpStatus)
  )
}

function resourceReadFailure(
  result: Exclude<ServerResourceJsonRequestResult, { status: 'ok' }>,
): { status: 'error'; error: string } | { status: 'unavailable' } {
  return result.status === 'unavailable' ? result : { status: 'error', error: result.error }
}

async function requestServerResourceJson(
  endpoint: string,
  signal?: AbortSignal | null,
  options: { method?: 'GET' | 'POST'; body?: unknown; auth?: string } = {},
  generation = captureClientSessionGeneration(),
): Promise<ServerResourceJsonRequestResult> {
  if (!canUseServerResourceReads()) return { status: 'unavailable' }

  const auth = options.auth ?? (await getNodeServerProxyAuth())
  const method = options.method ?? 'GET'
  let response: Response
  try {
    response = await fetch(endpoint, {
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

  if (response.status === 401 && isClientSessionGenerationCurrent(generation) && !signal?.aborted) {
    requireClientAuthentication()
    const authGeneration = captureClientSessionGeneration()
    const { discardObserverProjectionState } = await import('../observerProjectionLifecycle')
    if (isClientSessionGenerationCurrent(authGeneration)) await discardObserverProjectionState('auth-loss')
  }

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // HTTP handling below reports non-JSON failures. Successful non-JSON
    // responses fail the resource-specific envelope validation.
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

function readRevisionEnvelope(body: unknown): (Record<string, unknown> & { revision: number }) | null {
  if (!isPlainRecord(body) || !Number.isInteger(body.revision) || (body.revision as number) < 0) return null
  return body as Record<string, unknown> & { revision: number }
}

function containsNonSettingResource(settings: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(settings, 'characters')) return true
  return SERVER_COLLECTION_NAMES.some((name) => Object.prototype.hasOwnProperty.call(settings, name))
}

function hasEveryServerCollection(names: readonly string[]): boolean {
  return (
    names.length === SERVER_COLLECTION_NAMES.length && SERVER_COLLECTION_NAMES.every((name) => names.includes(name))
  )
}

function isValidCollectionValue(name: ServerCollectionName, value: unknown): boolean {
  if (name === 'pluginCustomStorage') return isPlainRecord(value)
  if (name === 'loreBook') return isValidGlobalLorebookCollection(value)
  return Array.isArray(value)
}

function isValidGlobalLorebookCollection(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const lorebookIds = new Set<string>()
  for (const lorebook of value) {
    if (!isPlainRecord(lorebook) || !nonEmptyString(lorebook.id) || !Array.isArray(lorebook.data)) return false
    if (lorebookIds.has(lorebook.id)) return false
    lorebookIds.add(lorebook.id)

    const entryIds = new Set<string>()
    for (const entry of lorebook.data) {
      if (!isPlainRecord(entry) || !nonEmptyString(entry.id) || entryIds.has(entry.id)) return false
      entryIds.add(entry.id)
    }
  }
  return true
}

function isMessageFreeCharacter(value: unknown): value is Record<string, unknown> & { chaId: string } {
  if (!isPlainRecord(value) || !nonEmptyString(value.chaId)) return false
  if (value.chats === undefined) return true
  if (!Array.isArray(value.chats)) return false
  return value.chats.every((chat) => {
    if (!isPlainRecord(chat)) return false
    return chat.message === undefined || (Array.isArray(chat.message) && chat.message.length === 0)
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (isPlainRecord(body)) {
    if (typeof body.reason === 'string' && body.reason.trim() !== '') return body.reason
    if (typeof body.error === 'string' && body.error.trim() !== '') return body.error
  }
  return fallback
}
