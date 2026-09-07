import type { AppRoute } from './routerRoute'
import type { character, Chat } from './storage/database.svelte'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
const isServerCharacterShell = (value: character): boolean =>
  (value as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true
import type { CharactersResourceState } from './server/resourceState.svelte'

type ReaderCharacterState = Pick<CharactersResourceState, 'characters' | 'status' | 'rowStatuses'>

export type ReaderRouteScope =
  | { status: 'home' | 'blocked' | 'loading' | 'ambiguous' | 'missing-character' }
  | { status: 'character'; character: character }
  | { status: 'chat'; character: character; chat: Chat }
  | { status: 'missing-chat'; character: character; fallbackChatId: string | null }

function nonemptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function knownChatIds(value: character): string[] {
  if (isServerCharacterShell(value)) {
    const summary = value as unknown as { chatIds?: unknown[] }
    return (summary.chatIds ?? []).filter(nonemptyId)
  }
  return (value.chats ?? []).map((chat) => chat.id).filter(nonemptyId)
}

/** Navigation options omit ambiguous IDs rather than silently selecting a first match. */
export function uniqueReaderCharacters(characters: readonly character[]): character[] {
  const counts = new Map<string, number>()
  for (const value of characters) {
    if (nonemptyId(value?.chaId)) counts.set(value.chaId, (counts.get(value.chaId) ?? 0) + 1)
  }
  return characters.filter((value) => nonemptyId(value?.chaId) && counts.get(value.chaId) === 1)
}

export function uniqueReaderChatIds(characters: readonly character[], target: character): string[] {
  const counts = new Map<string, number>()
  for (const value of characters) {
    for (const id of knownChatIds(value)) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return knownChatIds(target).filter((id) => counts.get(id) === 1)
}

/** Resolve the browser's route without consulting or repairing persisted selection. */
export function resolveReaderRoute(
  route: AppRoute,
  state: ReaderCharacterState,
  projectionReady = true,
): ReaderRouteScope {
  if (route.kind === 'home' || route.kind === 'grid') return { status: 'home' }
  if (route.kind !== 'character') return { status: 'blocked' }
  if (!projectionReady || state.status === 'idle') return { status: 'loading' }

  const matches = state.characters.filter((value) => value?.chaId === route.chaId)
  if (matches.length > 1) return { status: 'ambiguous' }
  const target = matches[0]
  if (!target) return { status: state.status === 'ready' ? 'missing-character' : 'loading' }
  if (!route.chatId) return { status: 'character', character: target }

  const targetChatIds = knownChatIds(target)
  const globalCount = state.characters.reduce(
    (count, value) => count + knownChatIds(value).filter((id) => id === route.chatId).length,
    0,
  )
  if (globalCount > 1) return { status: 'ambiguous' }
  if (!targetChatIds.includes(route.chatId)) {
    // An interrupted/failed resource read is not evidence of deletion.
    if (state.status !== 'ready' || ['loading', 'error'].includes(state.rowStatuses[route.chaId])) {
      return { status: 'loading' }
    }
    return {
      status: 'missing-chat',
      character: target,
      fallbackChatId: uniqueReaderChatIds(state.characters, target)[0] ?? null,
    }
  }
  if (isServerCharacterShell(target)) return { status: 'character', character: target }
  const chat = target.chats.find((value) => value.id === route.chatId)
  return chat ? { status: 'chat', character: target, chat } : { status: 'loading' }
}
