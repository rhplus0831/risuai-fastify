import { demoteClientSession, resetClientSessionForTests } from './clientSession'
import { enterClientWriter, repromoteClientWriter } from './__tests__/clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const characterCardsState = vi.hoisted(() => ({
  importCharacter: vi.fn(),
}))

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'change-char-token',
}))

vi.mock('./alert', async () => {
  const { writable } = await import('svelte/store')
  return {
    alertAddCharacter: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
    alertStore: writable({ type: 'none', msg: '' }),
    alertWait: vi.fn(),
  }
})

vi.mock('./process/coldstorage.svelte', () => ({
  recoverColdStorageCharacter: vi.fn(async () => true),
}))

vi.mock('./characterCards', () => ({
  importCharacter: characterCardsState.importCharacter,
}))

import { alertAddCharacter } from './alert'
import { clearCachedServerCommandRevision, drainServerCommandExecutionForTests } from './server/commands'
import { stopSelectedCharacterShellHydration } from './server/characterShellHydration.svelte'

import { charactersResourceState, replaceResourceDatabase } from './server/resourceState.svelte'
import { selectedCharID } from './stores.svelte'
import { isServerCharacterShell, type character, type Database } from './storage/database.svelte'
import { addCharacter, changeChar } from './characters'
import { activeGenerationTarget, doingChat } from './process/index.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const testDatabaseState = {
  get db(): Database {
    return getResourceDatabase()
  },
  set db(value: Database) {
    replaceResourceDatabase(value)
  },
}

interface CapturedFetch {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function characterShell(characterId: string, name: string): character {
  return {
    __serverCharacterShell: true,
    chaId: characterId,
    name,
    chats: [{ id: `${characterId}-chat`, name: 'Chat', message: [] }],
    chatPage: 0,
    chatFolders: [],
  } as unknown as character
}

function hydratedCharacter(characterId: string, name: string): character {
  return {
    chaId: characterId,
    name,
    desc: '',
    firstMessage: 'Hello',
    chats: [{ id: `${characterId}-chat`, name: 'Chat', message: [] }],
    chatPage: 0,
    chatFolders: [],
    customscript: [],
    triggerscript: [],
    globalLore: [],
  } as unknown as character
}

function fullCharacter(characterId: string, name: string): character {
  return {
    ...hydratedCharacter(characterId, name),
    lastInteraction: 100,
  } as character
}

function stubChangeCharFetch(
  characterRowResponse: Promise<Response>,
  characterCreateResponse?: Promise<Response>,
): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ url, method: init.method ?? 'GET', body })

      if (url === '/api/v1/bootstrap') {
        return jsonResponse({ revision: 10 })
      }
      if (url.startsWith('/api/v1/characters/')) {
        return characterRowResponse
      }
      if (url === '/api/v1/commands/characters') {
        if (characterCreateResponse) return characterCreateResponse
        return jsonResponse({
          revision: 11,
          event: { type: 'character.created', revision: 11, resource: 'character' },
          characterId: body?.character?.chaId,
        })
      }
      if (url === '/api/v1/commands/characters/select') {
        return jsonResponse({
          revision: 11,
          event: { type: 'character.selected', revision: 11, resource: 'characterSelection' },
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function selectedCharacterCommandIds(calls: CapturedFetch[]): string[] {
  return calls
    .filter((call) => call.url === '/api/v1/commands/characters/select')
    .map((call) => (call.body as { characterId?: string } | null)?.characterId)
    .filter((characterId): characterId is string => typeof characterId === 'string')
}

async function waitForCharacterRowFetch(calls: CapturedFetch[]): Promise<void> {
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url.startsWith('/api/v1/characters/'))).toBe(true)
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.mocked(alertAddCharacter).mockReset()
  characterCardsState.importCharacter.mockReset()
  clearCachedServerCommandRevision()
  stopSelectedCharacterShellHydration()
  selectedCharID.set(-1)
  activeGenerationTarget.set(null)
  doingChat.set(false)
  testDatabaseState.db = {
    currentChar: -1,
    characters: [characterShell('char-a', 'Shell A'), fullCharacter('char-b', 'Character B')],
    characterOrder: ['char-a', 'char-b'],
  } as any
})

afterEach(() => {
  resetClientSessionForTests()
  stopSelectedCharacterShellHydration()
  activeGenerationTarget.set(null)
  doingChat.set(false)
  vi.unstubAllGlobals()
})

describe('changeChar shell selection freshness', () => {
  it('fails closed when the ready character owner has a duplicate stable id', async () => {
    testDatabaseState.db = {
      currentChar: -1,
      characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-a', 'Duplicate A')],
      characterOrder: ['char-a'],
    } as any
    const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))

    await changeChar(0)
    await drainServerCommandExecutionForTests()

    expect(get(selectedCharID)).toBe(-1)
    expect(charactersResourceState.currentChar).toBe(-1)
    expect(selectedCharacterCommandIds(calls)).toEqual([])
  })

  it.each(['idle', 'loading', 'error'] as const)(
    'does not select retained character rows while the owner is %s',
    async (status) => {
      testDatabaseState.db = {
        currentChar: -1,
        characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-b', 'Character B')],
        characterOrder: ['char-a', 'char-b'],
      } as any
      const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))
      charactersResourceState.status = status

      await changeChar(1)

      expect(get(selectedCharID)).toBe(-1)
      expect(charactersResourceState.currentChar).toBe(-1)
      await drainServerCommandExecutionForTests()
      expect(selectedCharacterCommandIds(calls)).toEqual([])
    },
  )

  it('allows selecting another character while a generation is active', async () => {
    testDatabaseState.db = {
      currentChar: -1,
      characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-b', 'Character B')],
      characterOrder: ['char-a', 'char-b'],
    } as any
    const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))
    activeGenerationTarget.set({
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'char-a',
      chatId: 'char-a-chat',
    })
    doingChat.set(true)

    await changeChar(1)
    expect(get(selectedCharID)).toBe(1)

    await changeChar(0)

    expect(get(selectedCharID)).toBe(0)
    await drainServerCommandExecutionForTests()
    expect(selectedCharacterCommandIds(calls)).toEqual(['char-b', 'char-a'])
  })

  it('preserves a newer character selection when an older shell hydration resolves later', async () => {
    const characterRow = deferred<Response>()
    const calls = stubChangeCharFetch(characterRow.promise)

    const delayedSelection = changeChar(0)
    await waitForCharacterRowFetch(calls)

    await changeChar(1)
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)

    characterRow.resolve(
      jsonResponse({
        revision: 10,
        character: hydratedCharacter('char-a', 'Hydrated A'),
      }),
    )
    await delayedSelection
    await drainServerCommandExecutionForTests()

    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
    expect(testDatabaseState.db.characters[0].name).toBe('Hydrated A')
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
    await vi.waitFor(() => {
      expect(selectedCharacterCommandIds(calls)).toContain('char-b')
    })
    expect(selectedCharacterCommandIds(calls)).not.toContain('char-a')
  })

  it('selects the live index for the captured character id after shell hydration reorders the row', async () => {
    const characterRow = deferred<Response>()
    const calls = stubChangeCharFetch(characterRow.promise)
    selectedCharID.set(1)
    charactersResourceState.currentChar = 1

    const pendingSelection = changeChar(0)
    await waitForCharacterRowFetch(calls)

    charactersResourceState.characters.reverse()
    selectedCharID.set(0)
    charactersResourceState.currentChar = 0
    characterRow.resolve(
      jsonResponse({
        revision: 10,
        character: hydratedCharacter('char-a', 'Hydrated A'),
      }),
    )

    await pendingSelection

    expect(testDatabaseState.db.characters[0].chaId).toBe('char-b')
    expect(testDatabaseState.db.characters[1].chaId).toBe('char-a')
    expect(testDatabaseState.db.characters[1].name).toBe('Hydrated A')
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
    await vi.waitFor(() => {
      expect(selectedCharacterCommandIds(calls)).toContain('char-a')
    })
  })

  it('does not select a shell target that disappeared before hydration completed', async () => {
    const characterRow = deferred<Response>()
    const calls = stubChangeCharFetch(characterRow.promise)
    selectedCharID.set(1)
    charactersResourceState.currentChar = 1

    const pendingSelection = changeChar(0)
    await waitForCharacterRowFetch(calls)

    testDatabaseState.db.characters = [testDatabaseState.db.characters[1]]
    selectedCharID.set(0)
    charactersResourceState.currentChar = 0
    characterRow.resolve(
      jsonResponse({
        revision: 10,
        character: hydratedCharacter('char-a', 'Hydrated A'),
      }),
    )

    await pendingSelection
    await drainServerCommandExecutionForTests()

    expect(testDatabaseState.db.characters.map((candidate) => candidate.chaId)).toEqual(['char-b'])
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
    expect(selectedCharacterCommandIds(calls)).not.toContain('char-a')
  })
})

describe('addCharacter import navigation freshness', () => {
  it('selects the production-imported optimistic character by returned chaId when projection reorders it away from the tail', async () => {
    const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))
    let importedCharacterId: string | null | undefined
    testDatabaseState.db = {
      currentChar: 0,
      characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-b', 'Character B')],
      characterOrder: ['char-a', 'char-b'],
    } as any
    selectedCharID.set(0)
    vi.mocked(alertAddCharacter).mockResolvedValue('importCharacter')
    characterCardsState.importCharacter.mockImplementation(async () => {
      const actualCharacterCards = await vi.importActual<typeof import('./characterCards')>('./characterCards')
      const imported = await actualCharacterCards.importCharacterProcess({
        name: 'imported-character.json',
        data: Buffer.from(
          JSON.stringify({
            name: 'Imported',
            description: 'Imported description',
            first_mes: 'Hello from import',
          }),
        ),
      })
      importedCharacterId = imported?.status === 'accepted' ? imported.characterId : undefined
      const importedCharacter = testDatabaseState.db.characters.find(
        (character) => character.chaId === importedCharacterId,
      )
      expect(importedCharacter).toBeTruthy()
      expect(importedCharacter?.chats[0]?.fmIndex).toBe(-1)
      testDatabaseState.db.characters = [
        importedCharacter!,
        fullCharacter('char-a', 'Character A'),
        fullCharacter('tail-char', 'Tail Character'),
      ]
      charactersResourceState.currentChar = 1
      selectedCharID.set(1)
      return imported
    })

    await addCharacter()

    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
    expect(importedCharacterId).toBeTruthy()
    expect(testDatabaseState.db.characters[0].chaId).toBe(importedCharacterId)
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/characters')).toBe(true)
    })
    await vi.waitFor(() => {
      expect(selectedCharacterCommandIds(calls)).toContain(importedCharacterId)
    })
    expect(selectedCharacterCommandIds(calls)).not.toContain('tail-char')
  })

  it('skips stale post-import navigation when the user selects another character before import finishes', async () => {
    const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))
    const importResult = deferred<{ status: 'accepted'; characterId: string }>()
    testDatabaseState.db = {
      currentChar: 0,
      characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-b', 'Character B')],
      characterOrder: ['char-a', 'char-b'],
    } as any
    selectedCharID.set(0)
    vi.mocked(alertAddCharacter).mockResolvedValue('importCharacter')
    characterCardsState.importCharacter.mockReturnValue(importResult.promise)

    const pendingAdd = addCharacter()
    await vi.waitFor(() => {
      expect(characterCardsState.importCharacter).toHaveBeenCalledTimes(1)
    })

    testDatabaseState.db.characters.push(fullCharacter('imported-char', 'Imported'))
    charactersResourceState.currentChar = 1
    selectedCharID.set(1)
    importResult.resolve({ status: 'accepted', characterId: 'imported-char' })
    await pendingAdd

    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
    expect(selectedCharacterCommandIds(calls)).not.toContain('imported-char')
  })

  it('does not navigate to an imported character until its durable create is accepted', async () => {
    const createResult = deferred<Response>()
    const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})), createResult.promise)
    testDatabaseState.db = {
      currentChar: 0,
      characters: [fullCharacter('char-a', 'Character A')],
      characterOrder: ['char-a'],
    } as any
    selectedCharID.set(0)
    vi.mocked(alertAddCharacter).mockResolvedValue('importCharacter')
    characterCardsState.importCharacter.mockImplementation(async () => {
      const actualCharacterCards = await vi.importActual<typeof import('./characterCards')>('./characterCards')
      return actualCharacterCards.importCharacterProcess({
        name: 'durable-import.json',
        data: Buffer.from(
          JSON.stringify({
            name: 'Durable Imported',
            description: 'Imported description',
            first_mes: 'Hello from import',
          }),
        ),
      })
    })

    const adding = addCharacter()
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/characters')).toBe(true)
    })

    expect(testDatabaseState.db.characters).toHaveLength(2)
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
    expect(selectedCharacterCommandIds(calls)).toEqual([])

    const characterId = testDatabaseState.db.characters[1].chaId
    createResult.resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'character.created', revision: 11, resource: 'character' },
        characterId,
      }),
    )
    await adding

    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
    await vi.waitFor(() => {
      expect(selectedCharacterCommandIds(calls)).toContain(characterId)
    })
  })

  it('returns failed and leaves no created character or navigation target after import rejection', async () => {
    const calls = stubChangeCharFetch(
      Promise.resolve(jsonResponse({})),
      Promise.resolve(jsonResponse({ error: 'import rejected' }, 400)),
    )
    let importOutcome: Awaited<ReturnType<(typeof import('./characterCards'))['importCharacterProcess']>>
    testDatabaseState.db = {
      currentChar: 0,
      characters: [fullCharacter('char-a', 'Character A')],
      characterOrder: ['char-a'],
    } as any
    selectedCharID.set(0)
    vi.mocked(alertAddCharacter).mockResolvedValue('importCharacter')
    characterCardsState.importCharacter.mockImplementation(async () => {
      const actualCharacterCards = await vi.importActual<typeof import('./characterCards')>('./characterCards')
      importOutcome = await actualCharacterCards.importCharacterProcess({
        name: 'rejected-import.json',
        data: Buffer.from(
          JSON.stringify({
            name: 'Rejected Imported',
            description: 'Imported description',
            first_mes: 'Hello from import',
          }),
        ),
      })
      return importOutcome
    })

    await addCharacter()

    expect(importOutcome!).toMatchObject({
      status: 'failed',
      result: { status: 'error', reason: 'invalid-request' },
    })
    expect(importOutcome!).not.toHaveProperty('characterId')
    expect(testDatabaseState.db.characters.map((character) => character.chaId)).toEqual(['char-a'])
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
    expect(selectedCharacterCommandIds(calls)).toEqual([])
  })
})

it('does not revive a pre-demotion selection after hydration and re-promotion', async () => {
  const characterRow = deferred<Response>()
  const calls = stubChangeCharFetch(characterRow.promise)
  selectedCharID.set(1)
  charactersResourceState.currentChar = 1
  enterClientWriter()
  const pending = changeChar(0)
  await waitForCharacterRowFetch(calls)
  demoteClientSession()
  repromoteClientWriter()
  characterRow.resolve(jsonResponse({ revision: 10, character: hydratedCharacter('char-a', 'Hydrated A') }))
  await pending
  await drainServerCommandExecutionForTests()
  expect(testDatabaseState.db.characters[0].name).toBe('Hydrated A')
  expect(get(selectedCharID)).toBe(1)
  expect(charactersResourceState.currentChar).toBe(1)
  expect(selectedCharacterCommandIds(calls)).toEqual([])
})

it('does not navigate from an accepted import that completes after demotion and re-promotion', async () => {
  const calls = stubChangeCharFetch(Promise.resolve(jsonResponse({})))
  const imported = deferred<{ status: 'accepted'; characterId: string }>()
  testDatabaseState.db = {
    currentChar: 0,
    characters: [fullCharacter('char-a', 'Character A'), fullCharacter('char-b', 'Character B')],
    characterOrder: ['char-a', 'char-b'],
  } as any
  selectedCharID.set(0)
  vi.mocked(alertAddCharacter).mockResolvedValue('importCharacter')
  characterCardsState.importCharacter.mockReturnValue(imported.promise)
  enterClientWriter()
  const pending = addCharacter()
  await vi.waitFor(() => expect(characterCardsState.importCharacter).toHaveBeenCalledTimes(1))
  demoteClientSession()
  repromoteClientWriter()
  imported.resolve({ status: 'accepted', characterId: 'char-b' })
  await pending
  expect(get(selectedCharID)).toBe(0)
  expect(charactersResourceState.currentChar).toBe(0)
  expect(selectedCharacterCommandIds(calls)).toEqual([])
})
