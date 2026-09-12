import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'chat-select-token',
}))

const reattachMocks = vi.hoisted(() => ({
  trigger: vi.fn(),
}))

vi.mock('./process/reattach', () => ({
  triggerOpenChatGenerationReattach: reattachMocks.trigger,
}))

// stores first, then the heavy globalApi module (test import-order TDZ).
import { tick } from 'svelte'
import { selectedCharID } from './stores.svelte'
import { changeChatTo, chatFoldedState, chatFoldedStateMessageIndex, foldChatToMessage } from './globalApi.svelte'
import { testDatabaseState } from './__tests__/resourceDatabaseState'
import { clearCachedServerCommandRevision, runExternalServerRevisionOperation } from './server/commands'
import { seedCloneCostDb, withCloneInstrumentation } from './__tests__/cloneCostHarness'
import { charactersResourceState } from './server/resourceState.svelte'

// Guards chat selection against whole-collection cloning.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

beforeEach(() => {
  reattachMocks.trigger.mockClear()
  clearCachedServerCommandRevision()
  testDatabaseState.db = seedCloneCostDb() as any
  ;(testDatabaseState.db.characters[0].chats as unknown[]).push({
    id: 'chat-0b',
    name: 'Chat 0b',
    note: '',
    folderId: null,
    message: [],
    localLore: [],
    scriptstate: {},
  })
  selectedCharID.set(0)
  chatFoldedState.data = null
  chatFoldedStateMessageIndex.index = -1
  // The select dispatch fires fetches asynchronously after the click returns.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      return jsonResponse({
        revision: 11,
        event: { type: 'chat.updated', revision: 11, resource: 'chat' },
        selectedChatId: 'chat-0b',
      })
    }) as unknown as typeof fetch,
  )
})

afterEach(async () => {
  await runExternalServerRevisionOperation(async () => undefined)
  vi.unstubAllGlobals()
})

describe('changeChatTo (clone-cost gate)', () => {
  it('switches chatPage by index without cloning the characters array', () => {
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length

    const instrumented = withCloneInstrumentation(() => changeChatTo(1))

    expect(testDatabaseState.db.characters[0].chatPage).toBe(1)
    // The old whole-characters snapshot showed up here as a clone at least as
    // large as the serialized characters array.
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
  })

  it('switches chatPage by chat id without cloning the characters array', () => {
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length

    const instrumented = withCloneInstrumentation(() => changeChatTo('chat-0b'))

    expect(testDatabaseState.db.characters[0].chatPage).toBe(1)
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
    expect(reattachMocks.trigger).toHaveBeenCalledOnce()
  })

  it('returns without mutation for an unknown chat id', () => {
    changeChatTo('missing-chat')
    expect(testDatabaseState.db.characters[0].chatPage).toBe(0)
    expect(reattachMocks.trigger).not.toHaveBeenCalled()
  })

  it.each([
    ['negative', -2],
    ['too large', 2],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
  ])('returns without mutation for a %s numeric chat index', (_label, index) => {
    changeChatTo(index)

    expect(testDatabaseState.db.characters[0].chatPage).toBe(0)
    expect(reattachMocks.trigger).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the ready character-selection owner instead of a stale compatibility selection', () => {
    selectedCharID.set(1)

    changeChatTo('chat-0b')

    expect(charactersResourceState.characters[0].chatPage).toBe(1)
    expect(charactersResourceState.characters[1].chatPage).toBe(0)
    expect(reattachMocks.trigger).toHaveBeenCalledOnce()
  })

  it('retains selected-index compatibility only before the character owner is ready', () => {
    charactersResourceState.status = 'loading'
    charactersResourceState.currentChar = 1

    changeChatTo('chat-0b')

    expect(charactersResourceState.characters[0].chatPage).toBe(1)
    expect(charactersResourceState.characters[1].chatPage).toBe(0)
    expect(reattachMocks.trigger).toHaveBeenCalledOnce()
  })

  it('does not reuse compatibility selection after the character owner fails', () => {
    charactersResourceState.status = 'error'

    changeChatTo('chat-0b')

    expect(charactersResourceState.characters[0].chatPage).toBe(0)
    expect(reattachMocks.trigger).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the selected character stable id has duplicate ready owners', () => {
    charactersResourceState.characters.push(cloneJson(charactersResourceState.characters[0]))

    changeChatTo('chat-0b')

    expect(charactersResourceState.characters[0].chatPage).toBe(0)
    expect(reattachMocks.trigger).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when the target chat stable id has another ready owner', () => {
    charactersResourceState.characters[1].chats.push({
      ...cloneJson(charactersResourceState.characters[0].chats[1]),
    })

    changeChatTo('chat-0b')

    expect(charactersResourceState.characters[0].chatPage).toBe(0)
    expect(reattachMocks.trigger).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('foldChatToMessage (resource owners)', () => {
  it('targets the ready selected character and transcript owner', async () => {
    selectedCharID.set(1)

    foldChatToMessage(0)
    await tick()

    expect(chatFoldedState.data).toEqual({
      targetCharacterId: 'char-0',
      targetChatId: 'chat-0',
      targetMessageId: 'msg-0-0',
    })
    expect(chatFoldedStateMessageIndex.index).toBe(0)
  })

  it.each(['missing-message', ''])('clears a fold request for a non-owned message id', (messageId) => {
    chatFoldedState.data = {
      targetCharacterId: 'stale-character',
      targetChatId: 'stale-chat',
      targetMessageId: 'stale-message',
    }
    chatFoldedStateMessageIndex.index = 12

    foldChatToMessage(messageId)

    expect(chatFoldedState.data).toBeNull()
    expect(chatFoldedStateMessageIndex.index).toBe(-1)
  })

  it('fails closed when a message stable id is duplicated in the transcript owner', () => {
    const transcript = charactersResourceState.characters[0].chats[0].message
    transcript.push(cloneJson(transcript[0]))

    foldChatToMessage('msg-0-0')

    expect(chatFoldedState.data).toBeNull()
    expect(chatFoldedStateMessageIndex.index).toBe(-1)
  })

  it('fails closed when the active chat stable id is duplicated across ready owners', () => {
    charactersResourceState.characters[1].chats.push(cloneJson(charactersResourceState.characters[0].chats[0]))

    foldChatToMessage(0)

    expect(chatFoldedState.data).toBeNull()
    expect(chatFoldedStateMessageIndex.index).toBe(-1)
  })
})
