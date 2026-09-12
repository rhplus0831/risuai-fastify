import { get, writable } from 'svelte/store'
import { captureClientSessionGeneration, isClientSessionGenerationCurrent } from '../clientSession'
import type { BardWikiChatResource, BardWikiDocumentResource, BardWikiVersionsResource } from '@risuai/protocol'
import {
  fetchServerBardWikiChat,
  fetchServerBardWikiDocument,
  fetchServerBardWikiVersions,
  type ServerResourceReadResult,
} from './resourceReads'

export interface BardWikiResourceState {
  chats: Record<string, BardWikiChatResource>
  documents: Record<string, BardWikiDocumentResource>
  versions: Record<string, BardWikiVersionsResource>
}

const initialBardWikiResourceState = (): BardWikiResourceState => ({ chats: {}, documents: {}, versions: {} })

export const bardWikiResource = writable<BardWikiResourceState>(initialBardWikiResourceState())
let resourceGeneration = 0
const chatReadEpochs = new Map<string, number>()

export function resetBardWikiResource(): void {
  resourceGeneration += 1
  chatReadEpochs.clear()
  bardWikiResource.set(initialBardWikiResourceState())
}

function captureBardWikiReadFence(signal?: AbortSignal | null, isCurrent: () => boolean = () => true): () => boolean {
  const generation = resourceGeneration
  const sessionGeneration = captureClientSessionGeneration()
  return () =>
    generation === resourceGeneration &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    !signal?.aborted &&
    isCurrent()
}

function captureBardWikiChatReadFence(
  chatId: string,
  signal?: AbortSignal | null,
  isCurrent: () => boolean = () => true,
): () => boolean {
  const current = captureBardWikiReadFence(signal, isCurrent)
  const epoch = (chatReadEpochs.get(chatId) ?? 0) + 1
  chatReadEpochs.set(chatId, epoch)
  return () => current() && chatReadEpochs.get(chatId) === epoch
}

export function bardWikiDocumentResourceKey(chatId: string, documentId: string): string {
  return `${chatId}\u0000${documentId}`
}

export function getBardWikiChatResource(chatId: string): BardWikiChatResource | null {
  return get(bardWikiResource).chats[chatId] ?? null
}

export function getBardWikiDocumentResource(chatId: string, documentId: string): BardWikiDocumentResource | null {
  return get(bardWikiResource).documents[bardWikiDocumentResourceKey(chatId, documentId)] ?? null
}

export function isBardWikiChatResourceLoaded(chatId: string): boolean {
  return getBardWikiChatResource(chatId) !== null
}

export function isBardWikiDocumentResourceLoaded(chatId: string, documentId: string): boolean {
  return getBardWikiDocumentResource(chatId, documentId) !== null
}

export function isBardWikiVersionsResourceLoaded(chatId: string, documentId: string): boolean {
  return get(bardWikiResource).versions[bardWikiDocumentResourceKey(chatId, documentId)] !== undefined
}

export function applyBardWikiChatResource(resource: BardWikiChatResource): boolean {
  const current = getBardWikiChatResource(resource.chatId)
  if (current && current.revision > resource.revision) return false
  bardWikiResource.update((state) => ({
    ...state,
    chats: { ...state.chats, [resource.chatId]: structuredClone(resource) },
  }))
  return true
}

export function applyBardWikiDocumentResource(resource: BardWikiDocumentResource): boolean {
  const key = bardWikiDocumentResourceKey(resource.chatId, resource.document.id)
  const current = get(bardWikiResource).documents[key]
  if (current && current.revision > resource.revision) return false
  bardWikiResource.update((state) => ({
    ...state,
    documents: { ...state.documents, [key]: structuredClone(resource) },
  }))
  return true
}

export function applyBardWikiVersionsResource(resource: BardWikiVersionsResource): boolean {
  const key = bardWikiDocumentResourceKey(resource.chatId, resource.documentId)
  const current = get(bardWikiResource).versions[key]
  if (current && current.revision > resource.revision) return false
  bardWikiResource.update((state) => ({
    ...state,
    versions: { ...state.versions, [key]: structuredClone(resource) },
  }))
  return true
}

export function removeBardWikiDocumentResource(chatId: string, documentId: string): void {
  const key = bardWikiDocumentResourceKey(chatId, documentId)
  bardWikiResource.update((state) => {
    const documents = { ...state.documents }
    const versions = { ...state.versions }
    delete documents[key]
    delete versions[key]
    return { ...state, documents, versions }
  })
}

export async function loadBardWikiChatResource(
  chatId: string,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<BardWikiChatResource>> {
  const current = captureBardWikiChatReadFence(chatId, signal)
  const result = await fetchServerBardWikiChat(chatId, signal)
  if (!current()) return { status: 'unavailable' }
  if (result.status === 'ok') applyBardWikiChatResource(result)
  return result
}

export async function loadBardWikiDocumentResource(
  chatId: string,
  documentId: string,
  signal?: AbortSignal | null,
): Promise<ServerResourceReadResult<BardWikiDocumentResource>> {
  const current = captureBardWikiReadFence(signal)
  const result = await fetchServerBardWikiDocument(chatId, documentId, signal)
  if (!current()) return { status: 'unavailable' }
  if (result.status === 'ok') applyBardWikiDocumentResource(result)
  return result
}

export async function loadBardWikiVersionsResource(
  chatId: string,
  documentId: string,
  options: { limit?: number; beforeVersion?: number; signal?: AbortSignal | null } = {},
): Promise<ServerResourceReadResult<BardWikiVersionsResource>> {
  const current = captureBardWikiReadFence(options.signal)
  const result = await fetchServerBardWikiVersions(chatId, documentId, options)
  if (!current()) return { status: 'unavailable' }
  if (result.status === 'ok') applyBardWikiVersionsResource(result)
  return result
}

export async function refreshLoadedBardWikiChat(
  chatId: string,
  documentIds: readonly string[],
  minimumRevision: number,
  signal?: AbortSignal | null,
  isCurrent: () => boolean = () => true,
): Promise<{ status: 'ok'; revision: number } | { status: 'error'; error: string } | { status: 'unavailable' }> {
  const current = captureBardWikiChatReadFence(chatId, signal, isCurrent)
  if (!current()) return { status: 'unavailable' }
  if (!isBardWikiChatResourceLoaded(chatId)) return { status: 'ok', revision: minimumRevision }
  const chat = await fetchServerBardWikiChat(chatId, signal)
  if (!current()) return { status: 'unavailable' }
  if (chat.status !== 'ok') return chat
  if (chat.revision < minimumRevision) {
    return { status: 'error', error: `BardWiki chat response revision ${chat.revision} is stale` }
  }
  if (!applyBardWikiChatResource(chat)) return { status: 'error', error: 'BardWiki chat response was superseded' }
  let revision = chat.revision
  const refreshedDocumentIds =
    documentIds.length > 0
      ? documentIds
      : Object.keys(get(bardWikiResource).documents)
          .filter((key) => key.startsWith(`${chatId}\u0000`))
          .map((key) => key.slice(chatId.length + 1))
  for (const documentId of refreshedDocumentIds) {
    if (!isBardWikiDocumentResourceLoaded(chatId, documentId)) continue
    if (!chat.documents.some((document) => document.id === documentId)) {
      removeBardWikiDocumentResource(chatId, documentId)
      continue
    }
    const document = await fetchServerBardWikiDocument(chatId, documentId, signal)
    if (!current()) return { status: 'unavailable' }
    if (document.status !== 'ok') return document
    if (document.revision < minimumRevision) {
      return { status: 'error', error: `BardWiki document response revision ${document.revision} is stale` }
    }
    if (!applyBardWikiDocumentResource(document)) {
      return { status: 'error', error: 'BardWiki document response was superseded' }
    }
    revision = Math.max(revision, document.revision)
    if (!isBardWikiVersionsResourceLoaded(chatId, documentId)) continue
    const versions = await fetchServerBardWikiVersions(chatId, documentId, { signal })
    if (!current()) return { status: 'unavailable' }
    if (versions.status !== 'ok') return versions
    if (versions.revision < minimumRevision) {
      return { status: 'error', error: `BardWiki versions response revision ${versions.revision} is stale` }
    }
    if (!applyBardWikiVersionsResource(versions)) {
      return { status: 'error', error: 'BardWiki versions response was superseded' }
    }
    revision = Math.max(revision, versions.revision)
  }
  return { status: 'ok', revision }
}

export async function refreshAllLoadedBardWikiResources(
  minimumRevision: number,
  signal?: AbortSignal | null,
  isCurrent: () => boolean = () => true,
): Promise<{ status: 'ok'; revision: number } | { status: 'error'; error: string } | { status: 'unavailable' }> {
  const current = captureBardWikiReadFence(signal, isCurrent)
  const snapshot = get(bardWikiResource)
  let revision = minimumRevision
  for (const chatId of Object.keys(snapshot.chats)) {
    const prefix = `${chatId}\u0000`
    const documentIds = Object.keys(snapshot.documents)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
    if (!current()) return { status: 'unavailable' }
    const refreshed = await refreshLoadedBardWikiChat(chatId, documentIds, minimumRevision, signal, current)
    if (refreshed.status !== 'ok') return refreshed
    revision = Math.max(revision, refreshed.revision)
  }
  return { status: 'ok', revision }
}
