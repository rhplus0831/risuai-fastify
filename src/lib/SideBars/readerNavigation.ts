import type { character, Database } from 'src/ts/storage/database.svelte'
import { uniqueReaderCharacters, uniqueReaderChatIds } from 'src/ts/readerRouteScope'
import type { PinnedChatItem } from './sidebarMultitasking'
import { getCharacterDisplayName } from 'src/ts/characterDisplayName'

/** Sanitize display order without repairing or persisting the writer's metadata. */
export function readerCharacterOrder(
  characters: readonly character[],
  order: Database['characterOrder'],
): Database['characterOrder'] {
  const known = new Set(
    uniqueReaderCharacters(characters)
      .filter((row) => !row.trashTime)
      .map((row) => row.chaId),
  )
  const used = new Set<string>()
  const folders = new Set<string>()
  const take = (id: string) => {
    if (!known.has(id) || used.has(id)) return false
    used.add(id)
    return true
  }
  const result: Database['characterOrder'] = []
  for (const entry of order ?? []) {
    if (typeof entry === 'string') {
      if (take(entry)) result.push(entry)
    } else if (entry?.id && !folders.has(entry.id)) {
      folders.add(entry.id)
      result.push({ ...entry, data: (entry.data ?? []).filter(take) })
    }
  }
  for (const id of known) if (take(id)) result.push(id)
  return result
}

export function readerPinnedChats(
  characters: readonly character[],
  order: Database['characterOrder'],
): PinnedChatItem[] {
  const result: PinnedChatItem[] = []
  const byId = new Map(uniqueReaderCharacters(characters).map((row, index) => [row.chaId, { row, index }]))
  for (const id of readerCharacterOrder(characters, order).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : entry.data,
  )) {
    const owner = byId.get(id)
    if (!owner) continue
    const { row, index } = owner
    const valid = new Set(uniqueReaderChatIds(characters, row))
    const summary = row as unknown as {
      __serverCharacterShell?: boolean
      pinnedChats?: Array<{ id: string; name: string }>
    }
    const pinned = summary.__serverCharacterShell
      ? (summary.pinnedChats ?? [])
      : (row.chats ?? []).filter((chat) => chat.pinned)
    for (const chat of pinned)
      if (chat.id && valid.has(chat.id))
        result.push({
          characterId: id,
          characterIndex: index,
          characterName: getCharacterDisplayName(row),
          characterImage: row.image ?? '',
          chatId: chat.id,
          chatName: chat.name,
        })
  }
  return result
}
