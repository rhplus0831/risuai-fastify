import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const reads = vi.hoisted(() => ({ chat: vi.fn(), document: vi.fn(), versions: vi.fn() }))
vi.mock('./resourceReads', () => ({
  fetchServerBardWikiChat: reads.chat,
  fetchServerBardWikiDocument: reads.document,
  fetchServerBardWikiVersions: reads.versions,
}))
import { beginClientSession, resetClientSessionForTests } from '../clientSession'
import {
  bardWikiResource,
  loadBardWikiChatResource,
  loadBardWikiDocumentResource,
  loadBardWikiVersionsResource,
  refreshLoadedBardWikiChat,
  resetBardWikiResource,
} from './bardWikiResource'

const cases = [
  ['chat', () => loadBardWikiChatResource('chat-a'), { chatId: 'chat-a', documents: [] }],
  [
    'document',
    () => loadBardWikiDocumentResource('chat-a', 'document-a'),
    { chatId: 'chat-a', document: { id: 'document-a' } },
  ],
  [
    'versions',
    () => loadBardWikiVersionsResource('chat-a', 'document-a'),
    { chatId: 'chat-a', documentId: 'document-a' },
  ],
] as const

beforeEach(() => {
  resetClientSessionForTests()
  resetBardWikiResource()
  for (const read of Object.values(reads)) read.mockReset()
})
afterEach(() => {
  resetClientSessionForTests()
  resetBardWikiResource()
})

describe('BardWiki read projection lifetime', () => {
  it.each(cases)(
    'does not restore a late %s after authenticated projections were cleared',
    async (key, load, value) => {
      let resolve!: (value: unknown) => void
      reads[key].mockImplementation(
        () =>
          new Promise((finish) => {
            resolve = finish
          }),
      )
      const request = load()
      resetBardWikiResource()
      resolve({ status: 'ok', revision: 5, ...value })
      expect(await request).toEqual({ status: 'unavailable' })
      expect(get(bardWikiResource)).toEqual({ chats: {}, documents: {}, versions: {} })
    },
  )

  it.each(cases)('rejects a late %s response from a replaced client session', async (key, load, value) => {
    let resolve!: (value: unknown) => void
    reads[key].mockImplementation(
      () =>
        new Promise((finish) => {
          resolve = finish
        }),
    )
    const request = load()
    beginClientSession('next-reader')
    resolve({ status: 'ok', revision: 5, ...value })
    expect(await request).toEqual({ status: 'unavailable' })
    expect(get(bardWikiResource)).toEqual({ chats: {}, documents: {}, versions: {} })
  })

  it.each(['load', 'invalidation'] as const)(
    'rejects an older %s read after terminal state arrives at the same domain revision',
    async (owner) => {
      const running = { id: 'job-a', instanceId: 'instance-a', status: 'running', kind: 'rebuild_chat' }
      const active = { status: 'ok', revision: 5, chatId: 'chat-a', documents: [], receipts: [], jobs: [running] }
      reads.chat.mockResolvedValueOnce(active)
      await loadBardWikiChatResource('chat-a')
      let release!: (value: unknown) => void
      reads.chat.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      const old = owner === 'load' ? loadBardWikiChatResource('chat-a') : refreshLoadedBardWikiChat('chat-a', [], 5)
      const terminal = { ...active, jobs: [{ ...running, status: 'completed' }] }
      reads.chat.mockResolvedValueOnce(terminal)
      await loadBardWikiChatResource('chat-a')
      release(active)
      await old
      expect(get(bardWikiResource).chats['chat-a'].jobs).toEqual(terminal.jobs)
    },
  )

  it.each(cases)('continues applying a current %s read', async (key, load, value) => {
    reads[key].mockResolvedValue({ status: 'ok', revision: 5, ...value })
    expect(await load()).toMatchObject({ status: 'ok', revision: 5 })
    expect(
      Object.keys(get(bardWikiResource)[key === 'chat' ? 'chats' : key === 'document' ? 'documents' : 'versions']),
    ).toHaveLength(1)
  })
})
