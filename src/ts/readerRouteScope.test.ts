import { describe, expect, it } from 'vitest'
import type { character } from './storage/database.svelte'
import { parseRoute } from './routerRoute'
import { resolveReaderRoute, uniqueReaderCharacters, uniqueReaderChatIds } from './readerRouteScope'

function row(chaId: string, ids: string[]): character {
  return { chaId, chatPage: 0, chats: ids.map((id) => ({ id, name: id, message: [] })) } as character
}

describe('reader route scope', () => {
  it('resolves stable route IDs independently from persisted selection', () => {
    const characters = [row('writer', ['writer-chat']), row('reader', ['other', 'reader-chat'])]
    const state = { characters, currentChar: 0, status: 'ready' as const, rowStatuses: {} }
    const result = resolveReaderRoute(parseRoute('/character/reader/reader-chat'), state)
    expect(result).toEqual({ status: 'chat', character: characters[1], chat: characters[1].chats[1] })
    expect(state.currentChar).toBe(0)
    expect(characters[1].chatPage).toBe(0)
  })

  it('fails closed on duplicate character IDs and globally duplicated chat IDs', () => {
    const first = row('a', ['same'])
    const second = row('b', ['same'])
    expect(
      resolveReaderRoute(parseRoute('/character/a/same'), {
        characters: [first, second],
        status: 'ready' as const,
        rowStatuses: {},
      }).status,
    ).toBe('ambiguous')
    expect(
      resolveReaderRoute(parseRoute('/character/a'), {
        characters: [first, row('a', ['different'])],
        status: 'ready' as const,
        rowStatuses: {},
      }).status,
    ).toBe('ambiguous')
    expect(uniqueReaderCharacters([first, row('a', [])])).toEqual([])
    expect(uniqueReaderChatIds([first, second], first)).toEqual([])
  })

  it('uses the first unique surviving chat for authoritative deletion fallback', () => {
    const target = row('a', ['duplicate', 'survivor', 'later'])
    const state = { characters: [target, row('b', ['duplicate'])], status: 'ready' as const, rowStatuses: {} }
    expect(resolveReaderRoute(parseRoute('/character/a/deleted'), state)).toEqual({
      status: 'missing-chat',
      character: target,
      fallbackChatId: 'survivor',
    })
    expect(resolveReaderRoute(parseRoute('/character/deleted/chat'), state)).toEqual({ status: 'missing-character' })
  })

  it('does not infer deletion from loading, failed, or incoherent projections', () => {
    const target = row('a', ['retained'])
    for (const status of ['loading', 'error'] as const) {
      expect(
        resolveReaderRoute(parseRoute('/character/deleted/chat'), { characters: [target], status, rowStatuses: {} })
          .status,
      ).toBe('loading')
      expect(
        resolveReaderRoute(parseRoute('/character/a/deleted'), { characters: [target], status, rowStatuses: {} })
          .status,
      ).toBe('loading')
      expect(
        resolveReaderRoute(parseRoute('/character/a/retained'), { characters: [target], status, rowStatuses: {} })
          .status,
      ).toBe('chat')
    }
    expect(
      resolveReaderRoute(parseRoute('/character/a/deleted'), {
        characters: [target],
        status: 'ready' as const,
        rowStatuses: { a: 'error' },
      }).status,
    ).toBe('loading')
    expect(
      resolveReaderRoute(
        parseRoute('/character/a/deleted'),
        { characters: [target], status: 'ready' as const, rowStatuses: {} },
        false,
      ).status,
    ).toBe('loading')
  })

  it('uses complete shell chat IDs without treating unloaded details as deleted', () => {
    const shell = { chaId: 'a', __serverCharacterShell: true, chatIds: ['chat-a', 'chat-b'] } as unknown as character
    const state = { characters: [shell], status: 'ready' as const, rowStatuses: {} }
    expect(resolveReaderRoute(parseRoute('/character/a/chat-b'), state)).toEqual({
      status: 'character',
      character: shell,
    })
    expect(resolveReaderRoute(parseRoute('/character/a/removed'), state)).toEqual({
      status: 'missing-chat',
      character: shell,
      fallbackChatId: 'chat-a',
    })
  })

  it('gates authoring routes', () => {
    expect(
      resolveReaderRoute(parseRoute('/settings'), { characters: [], status: 'ready' as const, rowStatuses: {} }).status,
    ).toBe('blocked')
  })
})
