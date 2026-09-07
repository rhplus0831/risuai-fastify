import { beforeEach, describe, expect, it } from 'vitest'
import type { character, Message } from 'src/ts/storage/database.svelte'
import { charactersResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import { createChatReadOwners } from './chatReadOwners.svelte'

function row(id: string, chatId = `chat-${id}`, count = 3): character {
  return {
    chaId: id,
    chatPage: 0,
    chats: [
      { id: chatId, message: Array.from({ length: count }, (_, i) => ({ chatId: `message-${i}`, data: `${i}` })) },
    ],
  } as character
}

function readers() {
  return createChatReadOwners(
    charactersResourceState,
    (id) =>
      charactersResourceState.characters.flatMap((character) => character.chats ?? []).find((chat) => chat.id === id)
        ?.message,
  )
}

beforeEach(() => {
  charactersResourceState.status = 'ready'
  charactersResourceState.characters = [row('a'), row('b')]
  charactersResourceState.currentChar = 0
})

describe('shared chat render owners', () => {
  it('keeps simultaneous explicit scopes independent of canonical selection and equal message IDs', () => {
    const canonical = readers()
    const readMessages = (id: string) =>
      charactersResourceState.characters.flatMap((character) => character.chats).find((chat) => chat.id === id)?.message
    const a = createChatReadOwners(charactersResourceState, readMessages, () => ({
      characterId: 'a',
      chatId: 'chat-a',
    }))
    const b = createChatReadOwners(charactersResourceState, readMessages, () => ({
      characterId: 'b',
      chatId: 'chat-b',
    }))
    charactersResourceState.characters[0].chats[0].message[0].data = 'reader a'
    charactersResourceState.characters[1].chats[0].message[0].data = 'reader b'
    expect(a.message(0)?.chatId).toBe(b.message(0)?.chatId)
    expect(a.message(0)?.data).toBe('reader a')
    expect(b.message(0)?.data).toBe('reader b')
    expect(b.messages()).toBe(charactersResourceState.characters[1].chats[0].message)
    charactersResourceState.currentChar = 1
    expect(canonical.chat()?.id).toBe('chat-b')
    expect(a.chat()?.id).toBe('chat-a')
    charactersResourceState.characters[0].chatPage = 100
    expect(a.chat()?.id).toBe('chat-a')
    expect(a.message(0)?.data).toBe('reader a')
  })

  it('retains a scoped committed row through refresh errors but rejects mismatched, duplicate and removed owners', () => {
    const readMessages = (id: string) =>
      charactersResourceState.characters.flatMap((character) => character.chats).find((chat) => chat.id === id)?.message
    const scoped = createChatReadOwners(charactersResourceState, readMessages, () => ({
      characterId: 'a',
      chatId: 'chat-a',
    }))
    const mismatch = createChatReadOwners(charactersResourceState, readMessages, () => ({
      characterId: 'b',
      chatId: 'chat-a',
    }))
    const absent = createChatReadOwners(charactersResourceState, readMessages, () => null)
    const retained = scoped.chat()
    expect(mismatch.chat()).toBeUndefined()
    expect(absent.chat()).toBeUndefined()
    charactersResourceState.status = 'error'
    expect(scoped.chat()).toBe(retained)
    expect(scoped.message(0)?.data).toBe('0')
    expect(readers().chat()).toBeUndefined()
    charactersResourceState.status = 'ready'
    charactersResourceState.characters[1].chats[0].id = 'chat-a'
    expect(scoped.chat()).toBeUndefined()
    charactersResourceState.characters[1].chats[0].id = 'chat-b'
    charactersResourceState.characters[0].chats = []
    expect(scoped.chat()).toBeUndefined()
    expect(scoped.message(0)).toBeUndefined()
    charactersResourceState.status = 'loading'
    expect(scoped.character()).toBeUndefined()
  })

  it('rejects ambiguous character, global chat, and message IDs and recovers after rollback', () => {
    const read = readers()
    const a = charactersResourceState.characters[0]
    expect(read.chat()).toBe(a.chats[0])
    charactersResourceState.characters.push(row('a', 'other-chat'))
    expect(read.character()).toBeUndefined()
    expect(read.chat()).toBeUndefined()
    expect(read.message(0)).toBeUndefined()
    charactersResourceState.characters.pop()
    expect(read.character()).toBe(a)

    // A chat under a missing or duplicated character ID also prevents claiming it.
    charactersResourceState.characters.push(row('', 'chat-a'))
    expect(read.chat()).toBeUndefined()
    charactersResourceState.characters.pop()
    charactersResourceState.characters[1].chats[0].id = 'chat-a'
    expect(read.chat()).toBeUndefined()
    charactersResourceState.characters[1].chats[0].id = 'chat-b'
    expect(read.chat()).toBe(a.chats[0])

    a.chats[0].message.push({ chatId: 'message-0', data: 'duplicate' } as Message)
    expect(read.message(0)).toBeUndefined()
    a.chats[0].message.pop()
    expect(read.message(0)).toBe(a.chats[0].message[0])
    a.chats[0].message[0].chatId = ''
    expect(read.message(0)).toBeUndefined()
    a.chats[0].id = '  '
    expect(read.chat()).toBeUndefined()
  })

  it('follows selection, reorder, replacement, hydration, errors and resets synchronously', () => {
    const read = readers()
    const a = charactersResourceState.characters[0]
    expect(read.message(0)?.data).toBe('0')
    a.chats[0].message = []
    expect(read.message(0)).toBeUndefined()
    a.chats[0].message = [{ chatId: 'hydrated', data: 'new body' } as Message]
    expect(read.message(0)?.chatId).toBe('hydrated')
    a.chats[0].message[0].data = 'optimistic body'
    expect(read.message(0)?.data).toBe('optimistic body')
    a.chats.push({ id: 'next-chat', message: [] } as character['chats'][number])
    a.chatPage = 1
    expect(read.chat()?.id).toBe('next-chat')
    charactersResourceState.currentChar = 1
    expect(read.chat()?.id).toBe('chat-b')
    charactersResourceState.characters.reverse()
    expect(read.chat()?.id).toBe('next-chat')
    charactersResourceState.characters[1] = row('replacement')
    expect(read.chat()?.id).toBe('chat-replacement')
    charactersResourceState.status = 'error'
    expect(read.character()).toBeUndefined()
    expect(read.chat()).toBeUndefined()
    expect(read.message(0)).toBeUndefined()
    charactersResourceState.status = 'ready'
    expect(read.chat()?.id).toBe('chat-replacement')
    charactersResourceState.characters = []
    expect(read.message(0)).toBeUndefined()
  })

  it.each([50, 200, 800])('shares linear structure validation across %i characters and repeated row reads', (count) => {
    let characterIdReads = 0
    let messageIdReads = 0
    const rows = Array.from({ length: count }, (_, i) => {
      const character = row(`character-${i}`, `chat-${i}`, 30)
      Object.defineProperty(character, 'chaId', {
        get: () => {
          characterIdReads++
          return `character-${i}`
        },
      })
      if (i === 0) {
        character.chats[0].message.forEach((message, j) => {
          Object.defineProperty(message, 'chatId', {
            get: () => {
              messageIdReads++
              return `message-${j}`
            },
          })
        })
      }
      return character
    })
    charactersResourceState.characters = rows
    const read = readers()
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 0; i < 30; i++) expect(read.message(i)?.data).toBe(`${i}`)
    }
    // One graph build and one message identity build; row access itself is O(1).
    expect(characterIdReads).toBeLessThan(count * 6 + 10)
    expect(messageIdReads).toBeLessThan(30 * 6 + 30 * 10 * 3)
    const graphReads = characterIdReads
    const idsRead = messageIdReads
    settingsResourceState.value.zoomsize = 125
    charactersResourceState.characters[0].name = 'renamed'
    charactersResourceState.characters[0].chats[0].message[0].data = 'updated'
    charactersResourceState.characters[1].chats[0].message.push({ chatId: 'background', data: '' } as Message)
    expect(read.message(0)?.data).toBe('updated')
    expect(characterIdReads).toBe(graphReads)
    expect(messageIdReads - idsRead).toBeLessThanOrEqual(3)
  })
})
