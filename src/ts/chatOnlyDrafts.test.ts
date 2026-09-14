import { describe, expect, it } from 'vitest'
import {
  chatOnlyDraftStorageKey,
  pruneChatOnlyDraftsForScope,
  readChatOnlyDraft,
  writeChatOnlyDraft,
  type ChatOnlyDraftScope,
} from './chatOnlyDrafts'

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const scope = (overrides: Partial<ChatOnlyDraftScope> = {}): ChatOnlyDraftScope => ({
  databaseLineage: 'lineage/a',
  sessionId: 'page session',
  chatId: 'chat:one',
  ...overrides,
})

describe('chat-only drafts', () => {
  it('round-trips exact text only within the lineage, page session, and chat namespace', () => {
    const storage = new MemoryStorage()
    expect(writeChatOnlyDraft(scope(), '  unfinished\nmessage  ', storage)).toBe(true)
    expect(readChatOnlyDraft(scope(), storage)).toBe('  unfinished\nmessage  ')
    expect(readChatOnlyDraft(scope({ chatId: 'chat:two' }), storage)).toBe('')
    expect(readChatOnlyDraft(scope({ sessionId: 'duplicated-tab' }), storage)).toBe('')
    expect(readChatOnlyDraft(scope({ databaseLineage: 'replacement' }), storage)).toBe('')
  })

  it('removes copied and stale session namespaces without touching unrelated session storage', () => {
    const storage = new MemoryStorage()
    const original = scope({ sessionId: 'original-tab' })
    const duplicate = scope({ sessionId: 'duplicate-tab' })
    writeChatOnlyDraft(original, 'private original draft', storage)
    storage.setItem('unrelated', 'preserved')

    pruneChatOnlyDraftsForScope(duplicate, storage)

    expect(storage.getItem(chatOnlyDraftStorageKey(original)!)).toBeNull()
    expect(storage.getItem('unrelated')).toBe('preserved')
  })

  it('removes accepted drafts and fails closed for invalid scopes or unavailable storage', () => {
    const storage = new MemoryStorage()
    writeChatOnlyDraft(scope(), 'accepted message', storage)
    expect(writeChatOnlyDraft(scope(), '', storage)).toBe(true)
    expect(readChatOnlyDraft(scope(), storage)).toBe('')
    expect(chatOnlyDraftStorageKey(scope({ chatId: '   ' }))).toBeNull()
    expect(writeChatOnlyDraft(scope({ chatId: '' }), 'must not persist', storage)).toBe(false)
  })

  it('keeps the in-memory caller usable when browser storage throws', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => {
      throw new Error('quota')
    }
    storage.getItem = () => {
      throw new Error('privacy mode')
    }
    expect(writeChatOnlyDraft(scope(), 'retained by component', storage)).toBe(false)
    expect(readChatOnlyDraft(scope(), storage)).toBe('')
  })
})
