import { describe, expect, it } from 'vitest'
import { groupChatsByFolderId } from './chatFolderGrouping'

interface TestChat {
  id: string
  folderId?: string | null
}

describe('groupChatsByFolderId', () => {
  it('groups chats by folder id in a single pass, preserving order and indices', () => {
    const chats: TestChat[] = [
      { id: 'a', folderId: 'f1' },
      { id: 'b', folderId: null },
      { id: 'c', folderId: 'f1' },
      { id: 'd', folderId: 'f2' },
      { id: 'e' }, // folderId undefined
    ]

    const groups = groupChatsByFolderId(chats)

    // f1 keeps source order with the real chara.chats indices
    expect(groups.get('f1')).toEqual([
      { chat: chats[0], index: 0 },
      { chat: chats[2], index: 2 },
    ])
    expect(groups.get('f2')).toEqual([{ chat: chats[3], index: 3 }])
    // null and undefined folderId both collapse to the empty-string key
    expect(groups.get('')).toEqual([
      { chat: chats[1], index: 1 },
      { chat: chats[4], index: 4 },
    ])
    for (const entries of groups.values()) {
      for (const { chat, index } of entries) {
        expect(index).toBe(chats.indexOf(chat))
        expect(chats[index]).toBe(chat)
      }
    }
  })

  it('classifies chats with unknown folder references as ungrouped', () => {
    const chats: TestChat[] = [
      { id: 'valid', folderId: 'f1' },
      { id: 'orphan', folderId: 'missing' },
      { id: 'root', folderId: null },
    ]

    const groups = groupChatsByFolderId(chats, new Set(['f1']))

    expect(groups.get('f1')).toEqual([{ chat: chats[0], index: 0 }])
    expect(groups.get('missing')).toBeUndefined()
    expect(groups.get('')).toEqual([
      { chat: chats[1], index: 1 },
      { chat: chats[2], index: 2 },
    ])
  })

  it('returns an empty map for no chats', () => {
    expect(groupChatsByFolderId([]).size).toBe(0)
  })
})
