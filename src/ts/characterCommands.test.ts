import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { IDBFactory } from 'fake-indexeddb'

const alertConfirmState = vi.hoisted(() => ({
  messages: [] as string[],
  responses: [] as Array<boolean | Promise<boolean>>,
}))

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'character-command-token',
}))

vi.mock('./alert', async (importActual) => {
  const actual = await importActual<typeof import('./alert')>()
  return {
    ...actual,
    alertConfirm: vi.fn(async (message: string) => {
      alertConfirmState.messages.push(message)
      return alertConfirmState.responses.shift() ?? true
    }),
  }
})

import {
  applyAttemptedCharacterFieldRollback,
  applyCompatibleCharacterPatch,
  applyCharacterRowMutationScoped,
  applyCharacterSelectionOptimistically,
  changedCharacterFields,
  createCharacterOrderFolder,
  currentCharacterRowSnapshot,
  currentCharacterSelectionSnapshot,
  currentCharacterSupaMemorySnapshot,
  currentCharacterStateSnapshot,
  currentCharacterTrashTimeSnapshot,
  dispatchCompatibleCharacterUpdate,
  dispatchCompatibleCharacterUpdateScoped,
  dispatchCreateAndSelectCharacter,
  dispatchCreateCharacter,
  dispatchDeleteCharacter,
  dispatchSelectCharacter,
  dispatchSelectCharacterWithOutcome,
  dispatchUpdateCharacterScoped,
  moveCharacterOrderItem,
  moveCharacterOrderItemWithOutcome,
  normalizeCharacterOrder,
  prepareCompatibleCharacterUpdate,
  prepareCompatibleCharacterUpdateScoped,
  repairCharacterOrderOptimistically,
  restoreCharacterRow,
  restoreCharacterSupaMemory,
  restoreCharacterTrashTime,
  sanitizeCharacterPatch,
  setCharacterSupaMemory,
  setCharacterSupaMemoryWithOutcome,
  updateCharacterOrderFolder,
} from './characterCommands'
import { setCharacterByIndex, type Database, type folder } from './storage/database.svelte'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from './server/commands'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import * as pendingMutationOutboxModule from './server/pendingMutationOutbox'

import {
  charactersResourceState,
  replaceResourceDatabase,
  resetServerResourceState,
} from './server/resourceState.svelte'
import { selectedCharID, selIdState } from './stores.svelte'
import { installStoreRuntimeEffects } from './stores/runtimeEffects.svelte'
import { restoreStartupWriterCapabilities, revokeStartupWriterCapabilities } from './startupReadiness'
import { removeChar } from './characters'
import {
  assertRollbackRestoresOnly,
  assertSnapshotIsScalar,
  assertSnapshotOmitsCollections,
  seedCloneCostDb,
  withAsyncCloneInstrumentation,
  withCloneInstrumentation,
} from './__tests__/cloneCostHarness'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: Database) {
    replaceResourceDatabase(value)
  },
}

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubCommandFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters/char-a') {
        return jsonResponse({
          revision: 11,
          event: { type: 'character.updated', revision: 11, resource: 'character' },
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubCreateCharacterCommandFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters') {
        return jsonResponse({
          revision: 11,
          event: { type: 'character.created', revision: 11, resource: 'character' },
          characterId: 'char-created',
        })
      }
      if (url === '/api/v1/commands/characters/create-and-select') {
        return jsonResponse({
          revision: 11,
          event: { type: 'character.createdAndSelected', revision: 11, resource: 'character' },
          characterId: 'char-selected',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubCharacterCollectionCommandFetch({
  failCreate = false,
  failCreateAndSelect = false,
  failDelete = false,
  onCreate,
  onCreateAndSelect,
  onDelete,
}: {
  failCreate?: boolean
  failCreateAndSelect?: boolean
  failDelete?: boolean
  onCreate?: () => void | Promise<void>
  onCreateAndSelect?: () => void | Promise<void>
  onDelete?: () => void | Promise<void>
} = {}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      const method = init.method ?? 'GET'
      calls.push({
        url,
        method,
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters') {
        await onCreate?.()
        if (failCreate) return jsonResponse({ error: 'create failed' }, 500)
        return jsonResponse({
          revision: 11,
          event: { type: 'character.created', revision: 11, resource: 'character' },
          characterId: 'char-created',
        })
      }
      if (url === '/api/v1/commands/characters/create-and-select') {
        await onCreateAndSelect?.()
        if (failCreateAndSelect) return jsonResponse({ error: 'create-and-select failed' }, 500)
        return jsonResponse({
          revision: 11,
          event: { type: 'character.createdAndSelected', revision: 11, resource: 'character' },
          characterId: 'char-selected',
        })
      }
      if (url === '/api/v1/commands/characters/char-b' && method === 'DELETE') {
        await onDelete?.()
        if (failDelete) return jsonResponse({ error: 'delete failed' }, 500)
        return jsonResponse({
          revision: 11,
          event: { type: 'character.deleted', revision: 11, resource: 'character' },
          characterId: 'char-b',
          selectedCharacterId: null,
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubReorderCommandFetch({
  failReorder = false,
  onReorder,
}: {
  failReorder?: boolean
  onReorder?: () => void | Promise<void>
} = {}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters/reorder') {
        await onReorder?.()
        if (failReorder) return jsonResponse({ error: 'reorder failed' }, 500)
        return jsonResponse({
          revision: 11,
          event: { type: 'character.reordered', revision: 11, resource: 'character' },
          selectedCharacterId: 'char-a',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForCallCount(calls: CapturedFetch[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(calls).toHaveLength(expected), { interval: 1 })
}

function deferredResponse(): {
  promise: Promise<Response>
  resolve: (response: Response) => void
} {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function deferredBoolean(): {
  promise: Promise<boolean>
  resolve: (value: boolean) => void
} {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function waitForCharacterPatch(calls: CapturedFetch[], characterId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(calls.some((call) => call.url === `/api/v1/commands/characters/${characterId}`)).toBe(true)
  })
}

async function flushAsyncWork(ticks = 4): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function cloneForExpect<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function withMockedNow<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    return await fn()
  } finally {
    nowSpy.mockRestore()
  }
}

beforeEach(() => {
  resetServerResourceState()
  clearCachedServerCommandRevision()
  selectedCharID.set(0)
  alertConfirmState.messages = []
  alertConfirmState.responses = [true, true]
  testDatabaseState.db = {
    characters: [{ chaId: 'char-a', name: 'Character', chats: [], supaMemory: false }],
    characterOrder: [],
  } as any
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('character create command payloads', () => {
  it('dispatchCreateCharacter omits embedded chats from the server payload and preserves the optimistic character', async () => {
    const calls = stubCreateCharacterCommandFetch()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const previous = currentCharacterStateSnapshot()
    const starterChat = {
      id: 'chat-created',
      name: 'Starter',
      message: [{ role: 'user', data: 'hello' }],
    }
    const character = {
      chaId: 'char-created',
      name: 'Imported card',
      firstMessage: 'Hi',
      chatPage: 0,
      chats: [starterChat],
    } as any

    try {
      const settlement = dispatchCreateCharacter(character, previous)
      await waitForCallCount(calls, 2)

      expect(calls[1]).toMatchObject({
        url: '/api/v1/commands/characters',
        method: 'POST',
        body: {
          baseRevision: 10,
          character: {
            chaId: 'char-created',
            name: 'Imported card',
            firstMessage: 'Hi',
            chatPage: 0,
          },
        },
      })
      expect(calls[1].body).not.toHaveProperty('character.chats')
      expect(character.chats).toEqual([starterChat])
      await expect(settlement).resolves.toMatchObject({ status: 'accepted' })
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Character create would drop 1 chat'), {
        characterId: 'char-created',
      })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('dispatchCreateCharacter carries an id-bearing empty imported starter chat', async () => {
    const calls = stubCreateCharacterCommandFetch()
    const previous = currentCharacterStateSnapshot()
    const starterChat = {
      id: 'chat-imported',
      name: 'Chat 1',
      note: '',
      message: [],
      localLore: [{ id: 'local-lore', content: 'Local lore' }],
    }
    const character = {
      chaId: 'char-created',
      name: 'Imported card',
      chatPage: 0,
      chats: [starterChat],
    } as any

    dispatchCreateCharacter(character, previous)
    await waitForCallCount(calls, 2)

    expect(calls[1].body).toMatchObject({
      character: { chaId: 'char-created', name: 'Imported card', chatPage: 0 },
      initialChat: starterChat,
    })
    expect((calls[1].body as { character: Record<string, unknown> }).character).not.toHaveProperty('chats')
  })

  it('dispatchCreateAndSelectCharacter omits embedded chats while keeping local selection data intact', async () => {
    const calls = stubCreateCharacterCommandFetch()
    const previous = currentCharacterStateSnapshot()
    const starterChat = {
      id: 'chat-selected',
      name: 'Starter',
      message: [{ role: 'char', data: 'hi' }],
    }
    const character = {
      chaId: 'char-selected',
      name: 'Scratch character',
      firstMessage: 'Hello',
      chatPage: 0,
      chats: [starterChat],
      lastInteraction: 5555,
    } as any

    dispatchCreateAndSelectCharacter(character, previous, 5555)
    await waitForCallCount(calls, 2)

    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/create-and-select',
      method: 'POST',
      body: {
        baseRevision: 10,
        character: {
          chaId: 'char-selected',
          name: 'Scratch character',
          firstMessage: 'Hello',
          chatPage: 0,
          lastInteraction: 5555,
        },
        lastInteraction: 5555,
      },
    })
    expect(calls[1].body).not.toHaveProperty('character.chats')
    expect(character.chats).toEqual([starterChat])
    expect(character.lastInteraction).toBe(5555)
  })
})

describe('character list create/delete rollback', () => {
  it('normalizes character order before dispatching an optimistic create', async () => {
    const calls = stubCharacterCollectionCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-created', name: 'Created', chats: [] },
      ],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    const previous = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
      selectedCharID: 0,
    } as any

    dispatchCreateCharacter(testDatabaseState.db.characters[1], previous)

    expect(charactersResourceState.characterOrder).toEqual(['char-a', 'char-created'])
    await waitForCallCount(calls, 2)
  })

  it('failed optimistic create removes only unchanged attempted row and preserves sibling edits, selection changes, and folder metadata/order', async () => {
    const calls = stubCharacterCollectionCommandFetch({
      failCreate: true,
      onCreate: () => {
        withTestDatabaseWrite(() => {
          testDatabaseState.db.characters[0].name = 'Sibling newer edit'
          selectedCharID.set(0)
        })
        charactersResourceState.characterOrder = [
          'char-created',
          { id: 'folder-1', name: 'Newer Folder', color: 'green', data: ['char-a'], imgFile: 'asset-newer' },
        ] as any
        charactersResourceState.currentChar = 0
      },
    })
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()
    const attempted = { chaId: 'char-created', name: 'Created', chats: [] } as any

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push(attempted)
    })
    repairCharacterOrderOptimistically({ dispatchReorder: false })
    dispatchCreateCharacter(attempted, previous)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters.map((character: any) => character.chaId)).toEqual(['char-a'])
    })
    expect(testDatabaseState.db.characters[0].name).toBe('Sibling newer edit')
    expect(charactersResourceState.characterOrder).toEqual([
      { id: 'folder-1', name: 'Newer Folder', color: 'green', data: ['char-a'], imgFile: 'asset-newer' },
    ])
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
  })

  it('failed create-and-select removes attempted row and restores previous selection only when attempted row is still selected', async () => {
    const calls = stubCharacterCollectionCommandFetch({ failCreateAndSelect: true })
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()
    const attempted = { chaId: 'char-selected', name: 'Selected', chats: [], lastInteraction: 1234 } as any

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push(attempted)
      selectedCharID.set(1)
    })
    charactersResourceState.currentChar = 1
    repairCharacterOrderOptimistically({ dispatchReorder: false })
    dispatchCreateAndSelectCharacter(attempted, previous, 1234)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters.map((character: any) => character.chaId)).toEqual(['char-a'])
    })
    expect(charactersResourceState.characterOrder).toEqual(['char-a'])
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
  })

  it('failed create-and-select preserves a later selected character by id after index compaction', async () => {
    setCachedServerCommandRevision(10)
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const response = deferredResponse()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/commands/characters/create-and-select') return response.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const previous = currentCharacterStateSnapshot()
    const attempted = { chaId: 'char-playground', name: 'Playground', chats: [], lastInteraction: 1234 } as any
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push(attempted)
      selectedCharID.set(1)
    })
    charactersResourceState.currentChar = 1

    const pending = dispatchCreateAndSelectCharacter(attempted, previous, 1234, {
      shouldRestoreSelection: () => false,
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push({ chaId: 'char-later', name: 'Later', chats: [] } as any)
      selectedCharID.set(2)
    })
    charactersResourceState.currentChar = 2
    response.resolve(jsonResponse({ error: 'invalid create' }, 400))

    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      result: { status: 'error', reason: 'invalid-request' },
    })
    expect(testDatabaseState.db.characters.map((character) => character.chaId)).toEqual(['char-a', 'char-later'])
    expect(charactersResourceState.currentChar).toBe(1)
    expect(get(selectedCharID)).toBe(1)
  })

  it('rolls back create-and-select when durable staging throws synchronously', async () => {
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()
    const attempted = { chaId: 'char-playground', name: 'Playground', chats: [], lastInteraction: 1234 } as any
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push(attempted)
      selectedCharID.set(1)
    })
    charactersResourceState.currentChar = 1
    const stage = vi.spyOn(pendingMutationOutboxModule, 'stagePendingMutation').mockImplementationOnce(() => {
      throw new RangeError('Pending mutation payload is too large')
    })

    try {
      await expect(dispatchCreateAndSelectCharacter(attempted, previous, 1234)).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', reason: 'invalid-request' },
      })
      expect(testDatabaseState.db.characters.map((character) => character.chaId)).toEqual(['char-a'])
      expect(charactersResourceState.currentChar).toBe(0)
      expect(get(selectedCharID)).toBe(0)
    } finally {
      stage.mockRestore()
    }
  })

  it('failed import-style create with no optimistic local row is a no-op rollback and preserves newer local edits', async () => {
    const calls = stubCharacterCollectionCommandFetch({
      failCreate: true,
      onCreate: () => {
        withTestDatabaseWrite(() => {
          testDatabaseState.db.characters[0].name = 'Local edit after import dispatch'
          selectedCharID.set(0)
        })
        charactersResourceState.characterOrder = [
          { id: 'folder-1', name: 'Local Folder', color: 'purple', data: ['char-a'] },
        ] as any
      },
    })
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()
    const imported = { chaId: 'char-imported', name: 'Imported', chats: [] } as any

    dispatchCreateCharacter(imported, previous)

    await waitForCallCount(calls, 2)
    await flushAsyncWork()
    expect(testDatabaseState.db.characters).toEqual([
      { chaId: 'char-a', name: 'Local edit after import dispatch', chats: [] },
    ])
    expect(charactersResourceState.characterOrder).toEqual([
      { id: 'folder-1', name: 'Local Folder', color: 'purple', data: ['char-a'] },
    ])
    expect(get(selectedCharID)).toBe(0)
  })

  it('failed permanent delete reinserts only the missing deleted row at the previous index, restores order placement, and preserves sibling edits/appended rows', async () => {
    const calls = stubCharacterCollectionCommandFetch({
      failDelete: true,
      onDelete: () => {
        withTestDatabaseWrite(() => {
          testDatabaseState.db.characters[0].name = 'A newer edit'
          testDatabaseState.db.characters.push({ chaId: 'char-d', name: 'D appended', chats: [] } as any)
          const folder = charactersResourceState.characterOrder.find(
            (entry: any) => typeof entry !== 'string' && entry.id === 'folder-1',
          )
          if (folder && typeof folder !== 'string') {
            folder.name = 'Newer Folder'
            folder.color = 'green'
          }
          charactersResourceState.characterOrder.push('char-d')
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B latest optimistic profile edit', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', { id: 'folder-1', name: 'Folder', color: 'blue', data: ['char-b', 'char-c'] }],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const previous = currentCharacterStateSnapshot()

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })
    dispatchDeleteCharacter('char-b', previous)
    repairCharacterOrderOptimistically({ dispatchReorder: false })
    charactersResourceState.currentChar = -1
    selectedCharID.set(-1)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters.map((character: any) => character.chaId)).toEqual([
        'char-a',
        'char-b',
        'char-c',
        'char-d',
      ])
    })
    expect(testDatabaseState.db.characters.map((character: any) => character.name)).toEqual([
      'A newer edit',
      'B latest optimistic profile edit',
      'C',
      'D appended',
    ])
    expect(charactersResourceState.characterOrder).toEqual([
      'char-a',
      { id: 'folder-1', name: 'Newer Folder', color: 'green', data: ['char-b', 'char-c'] },
      'char-d',
    ])
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
  })

  it('normalizes an out-of-range current character pointer during optimistic deletion', async () => {
    const calls = stubCharacterCollectionCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B deleted', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const previous = currentCharacterStateSnapshot()

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })
    dispatchDeleteCharacter('char-b', previous)

    expect(charactersResourceState.currentChar).toBe(0)
    expect(charactersResourceState.characterOrder).toEqual(['char-a'])
    await waitForCallCount(calls, 2)
  })

  it('keeps the current character pointer on the same row when an earlier character is deleted', async () => {
    const calls = stubCharacterCollectionCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-trash', name: 'Trash', chats: [], trashTime: 123 },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-b', 'char-c'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const previous = currentCharacterStateSnapshot()

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(0, 1)
    })
    dispatchDeleteCharacter('char-trash', previous)

    expect(testDatabaseState.db.characters.map((character: any) => character.chaId)).toEqual(['char-b', 'char-c'])
    expect(charactersResourceState.currentChar).toBe(0)
    expect(testDatabaseState.db.characters[charactersResourceState.currentChar].chaId).toBe('char-b')
    await waitForCallCount(calls, 2)
  })

  it('failed permanent delete preserves a newer selection of the shifted next character after rollback', async () => {
    const calls = stubCharacterCollectionCommandFetch({
      failDelete: true,
      onDelete: () => {
        charactersResourceState.currentChar = 1
        selectedCharID.set(1)
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B deleted', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const previous = currentCharacterStateSnapshot()

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })
    dispatchDeleteCharacter('char-b', previous)
    repairCharacterOrderOptimistically({ dispatchReorder: false })

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters.map((character: any) => character.chaId)).toEqual([
        'char-a',
        'char-b',
        'char-c',
      ])
      expect(get(selectedCharID)).toBe(2)
      expect(charactersResourceState.currentChar).toBe(2)
    })
  })

  it('failed permanent delete skips rollback overwrite when a same-id row already exists again', async () => {
    const calls = stubCharacterCollectionCommandFetch({ failDelete: true })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B deleted', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })
    dispatchDeleteCharacter('char-b', previous)
    repairCharacterOrderOptimistically({ dispatchReorder: false })
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push({ chaId: 'char-b', name: 'Replacement B', chats: [] } as any)
    })
    charactersResourceState.characterOrder.push('char-b')

    await waitForCallCount(calls, 2)
    await flushAsyncWork()
    const charBRows = testDatabaseState.db.characters.filter((character: any) => character.chaId === 'char-b')
    expect(charBRows).toEqual([{ chaId: 'char-b', name: 'Replacement B', chats: [] }])
    expect(charactersResourceState.characterOrder).toEqual(['char-a', 'char-c', 'char-b'])
  })

  it('holds a later selection behind a transient create-and-select owner', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-create-select',
      writerEpoch: 12,
      databaseLineage: 'lineage-character-create-select',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(20)
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [], lastInteraction: 100 },
        { chaId: 'char-b', name: 'B', chats: [], lastInteraction: 200 },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previous = currentCharacterStateSnapshot()
    const created = { chaId: 'char-new', name: 'New', chats: [], lastInteraction: 2_000 } as any
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.push(created)
      charactersResourceState.characterOrder.push(created.chaId)
      charactersResourceState.currentChar = 2
      selectedCharID.set(2)
    })

    const firstCreate = deferredResponse()
    let recover = false
    let revision = 20
    const commands: Array<{ url: string; characterId: string | null }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        if (url === '/api/v1/commands/characters/create-and-select') {
          commands.push({ url, characterId: body.character?.chaId ?? null })
          if (commands.length === 1) return firstCreate.promise
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'character.createdAndSelected',
              revision,
              resource: 'character',
              id: 'char-new',
            },
            characterId: 'char-new',
            selectedCharacterId: 'char-new',
          })
        }
        if (url === '/api/v1/commands/characters/select') {
          commands.push({ url, characterId: body.characterId ?? null })
          if (!recover) throw new Error('selection overtook its retained created owner')
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: 'character.selected',
              revision,
              resource: 'character',
              id: body.characterId,
            },
            characterId: body.characterId,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const createSettlement = dispatchCreateAndSelectCharacter(created, previous, 2_000)
      await vi.waitFor(() => expect(commands).toHaveLength(1))

      const previousB = currentCharacterSelectionSnapshot('char-b')
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters[1].lastInteraction = 3_000
        charactersResourceState.currentChar = 1
        selectedCharID.set(1)
      })
      dispatchSelectCharacter('char-b', previousB, 3_000)
      firstCreate.resolve(jsonResponse({ error: 'temporarily unavailable' }, 500))

      await expect(createSettlement).resolves.toMatchObject({
        status: 'queued',
        result: { status: 'error', error: 'temporarily unavailable' },
      })
      await vi.waitFor(() => expect(commands).toHaveLength(2))
      expect(commands.map(({ url }) => url)).toEqual([
        '/api/v1/commands/characters/create-and-select',
        '/api/v1/commands/characters/create-and-select',
      ])
      const retained = await listPendingMutations()
      expect(retained.map((entry) => entry.handle.key)).toEqual(['character-owner:char-new', 'character-selection'])
      expect(retained[1].intent.dependencyKeys).toEqual(['character-owner:char-new', 'character-owner:char-b'])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(commands.slice(recoveryStart)).toEqual([
        { url: '/api/v1/commands/characters/create-and-select', characterId: 'char-new' },
        { url: '/api/v1/commands/characters/select', characterId: 'char-b' },
      ])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      firstCreate.resolve(jsonResponse({ error: 'temporarily unavailable' }, 500))
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('holds character DELETE behind a transient profile PATCH and recovers in owner order', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-delete',
      writerEpoch: 12,
      databaseLineage: 'lineage-character-delete',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(20)
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'Latest optimistic profile edit', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const patchIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/characters/char-b',
          body: { patch: { name: 'Latest optimistic profile edit' } },
        },
      ],
    }
    const predecessor = stagePendingMutation('character-owner:char-b', patchIntent)
    await expect(predecessor.ready).resolves.toBe('persisted')
    const previous = currentCharacterStateSnapshot()
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })

    let recover = false
    let revision = 20
    const commands: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-b') {
          const method = init.method ?? 'GET'
          commands.push(method)
          if (!recover && method === 'PATCH') return jsonResponse({ error: 'temporarily unavailable' }, 500)
          if (!recover) throw new Error('DELETE overtook its profile predecessor')
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: method === 'DELETE' ? 'character.deleted' : 'character.updated',
              revision,
              resource: 'character',
              id: 'char-b',
            },
            characterId: 'char-b',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      dispatchDeleteCharacter('char-b', previous)
      await vi.waitFor(() => expect(commands).toEqual(['PATCH']))
      expect(
        (await listPendingMutations()).map((entry) => ({
          key: entry.handle.key,
          method: entry.intent.requests[0].method,
        })),
      ).toEqual([
        { key: 'character-owner:char-b', method: 'PATCH' },
        { key: 'character-selection', method: 'DELETE' },
      ])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(commands.slice(recoveryStart)).toEqual(['PATCH', 'DELETE'])
      expect(await listPendingMutations()).toEqual([])

      const commandCount = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 0 })
      expect(commands).toHaveLength(commandCount)
      // The retained successor owns this optimistic deletion, so predecessor
      // recovery must not resurrect the row before authoritative hydration.
      expect(testDatabaseState.db.characters.some((character) => character.chaId === 'char-b')).toBe(false)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('holds a restored trash-row PATCH behind its retained permanent DELETE', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-delete-restore',
      writerEpoch: 13,
      databaseLineage: 'lineage-character-delete-restore',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(20)
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-trash', name: 'Trashed', chats: [], trashTime: 123 },
      ],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    let recover = false
    let revision = 20
    let serverHasCharacter = true
    const commands: Array<{ method: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-trash') {
          const method = init.method ?? 'GET'
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          commands.push({ method, body })
          if (!recover) {
            if (method === 'PATCH') throw new Error('trash restore overtook its retained permanent DELETE')
            return jsonResponse({ error: 'temporarily unavailable' }, 500)
          }
          if (method === 'DELETE') {
            serverHasCharacter = false
            revision += 1
            return jsonResponse({
              revision,
              event: {
                type: 'character.deleted',
                revision,
                resource: 'character',
                id: 'char-trash',
              },
              characterId: 'char-trash',
            })
          }
          if (!serverHasCharacter) return jsonResponse({ error: 'character not found' }, 404)
          throw new Error('unexpected successful trash restore')
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    const beforeDelete = currentCharacterStateSnapshot()
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(1, 1)
    })

    try {
      dispatchDeleteCharacter('char-trash', beforeDelete)
      await vi.waitFor(() => expect(commands.map(({ method }) => method)).toEqual(['DELETE']))
      expect(testDatabaseState.db.characters.map((character) => character.chaId)).toEqual(['char-a'])

      // Simulate an authoritative row refresh racing the retained DELETE. The
      // restore PATCH must remain behind that predecessor and cannot send early.
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters.push({
          chaId: 'char-trash',
          name: 'Trashed',
          chats: [],
          trashTime: 123,
        } as any)
      })

      const trashIndex = testDatabaseState.db.characters.findIndex((character) => character.chaId === 'char-trash')
      const beforeRestore = currentCharacterRowSnapshot(trashIndex)
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters[trashIndex].trashTime = null
      })
      dispatchUpdateCharacterScoped('char-trash', { trashTime: null }, beforeRestore)

      await vi.waitFor(() => expect(commands.map(({ method }) => method)).toEqual(['DELETE', 'DELETE']))
      // The retryable PATCH retains its optimistic projection while it waits
      // for the retained DELETE predecessor to resolve.
      expect(testDatabaseState.db.characters[trashIndex].trashTime).toBeNull()
      const retained = await listPendingMutations()
      expect(
        retained.map((entry) => ({
          key: entry.handle.key,
          method: entry.intent.requests[0].method,
          dependencies: entry.intent.dependencyKeys ?? [],
          body: entry.intent.requests[0].body,
        })),
      ).toEqual([
        {
          key: 'character-selection',
          method: 'DELETE',
          dependencies: ['character-owner:char-trash'],
          body: {},
        },
        {
          key: 'character-owner:char-trash',
          method: 'PATCH',
          dependencies: ['character-selection'],
          body: { patch: { trashTime: null } },
        },
      ])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toEqual({
        attempted: 2,
        discarded: 1,
        retained: 0,
        succeeded: 1,
      })
      expect(commands.slice(recoveryStart).map(({ method }) => method)).toEqual(['DELETE', 'PATCH'])
      expect(commands.at(-1)?.body).toMatchObject({ patch: { trashTime: null } })
      expect(serverHasCharacter).toBe(false)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })
})

describe('character select command rollback', () => {
  function stubDelayedSelectCommandFetch(selectResponse: Promise<Response>): CapturedFetch[] {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/select') return selectResponse
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    return calls
  }

  beforeEach(() => {
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [], lastInteraction: 100 },
        { chaId: 'char-b', name: 'B', chats: [], lastInteraction: 200 },
        { chaId: 'char-c', name: 'C', chats: [], lastInteraction: 300 },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
  })

  it('rolls back the exact selection owner when durable staging fails', async () => {
    const previous = currentCharacterSelectionSnapshot('char-b')
    expect(applyCharacterSelectionOptimistically('char-b', 2_000)).toBe(1)
    const stage = vi.spyOn(pendingMutationOutboxModule, 'stagePendingMutation').mockImplementationOnce(() => {
      throw new RangeError('Pending mutation payload is too large')
    })

    try {
      await expect(dispatchSelectCharacterWithOutcome('char-b', previous, 2_000)).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', reason: 'invalid-request' },
      })
      expect(charactersResourceState.currentChar).toBe(0)
      expect(get(selectedCharID)).toBe(0)
      expect(testDatabaseState.db.characters[1].lastInteraction).toBe(200)
    } finally {
      stage.mockRestore()
    }
  })

  it('retains the exact optimistic selection when writer access is lost after durable staging', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-select-loss',
      writerEpoch: 15,
      databaseLineage: 'lineage-character-select-loss',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(40)
    const previous = currentCharacterSelectionSnapshot('char-b')
    expect(applyCharacterSelectionOptimistically('char-b', 2_000)).toBe(1)

    try {
      const settlement = dispatchSelectCharacterWithOutcome('char-b', previous, 2_000)
      revokeStartupWriterCapabilities()

      await expect(settlement).resolves.toMatchObject({ status: 'queued', result: { status: 'unavailable' } })
      expect(charactersResourceState.currentChar).toBe(1)
      expect(get(selectedCharID)).toBe(1)
      expect(testDatabaseState.db.characters[1].lastInteraction).toBe(2_000)
      expect((await listPendingMutations()).map((entry) => entry.handle.key)).toEqual(['character-selection'])
    } finally {
      restoreStartupWriterCapabilities()
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('orders a durable selection correction after an older character-owner patch', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-select',
      writerEpoch: 13,
      databaseLineage: 'lineage-character-select',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(20)

    const predecessorIntent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/characters/char-b',
          body: { patch: { lastInteraction: 1_000 } },
        },
      ],
    }
    const predecessor = stagePendingMutation('character-owner:char-b', predecessorIntent)
    await expect(predecessor.ready).resolves.toBe('persisted')

    let recover = false
    let revision = 20
    const commands: Array<{ method: string; url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-b' || url === '/api/v1/commands/characters/select') {
          commands.push({
            method,
            url,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
          })
          if (!recover && url.endsWith('/characters/char-b')) {
            return jsonResponse({ error: 'temporarily unavailable' }, 500)
          }
          if (!recover) throw new Error('character selection overtook its owner predecessor')
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: url.endsWith('/characters/select') ? 'character.selected' : 'character.updated',
              revision,
              resource: 'character',
              id: 'char-b',
            },
            characterId: 'char-b',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    const previous = currentCharacterSelectionSnapshot('char-b')
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[1].lastInteraction = 2_000
      charactersResourceState.currentChar = 1
      selectedCharID.set(1)
    })

    try {
      dispatchSelectCharacter('char-b', previous, 2_000)
      await vi.waitFor(() => expect(commands.map((command) => command.method)).toEqual(['PATCH']))
      expect(
        (await listPendingMutations()).map((entry) => ({
          key: entry.handle.key,
          method: entry.intent.requests[0].method,
        })),
      ).toEqual([
        { key: 'character-owner:char-b', method: 'PATCH' },
        { key: 'character-selection', method: 'POST' },
      ])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(commands.slice(recoveryStart).map(({ method, url }) => ({ method, url }))).toEqual([
        { method: 'PATCH', url: '/api/v1/commands/characters/char-b' },
        { method: 'POST', url: '/api/v1/commands/characters/select' },
      ])
      expect(commands.at(-1)?.body).toMatchObject({
        characterId: 'char-b',
        lastInteraction: 2_000,
      })
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps rapid cross-target selections in one durable lane so the latest target wins', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-cross-select',
      writerEpoch: 14,
      databaseLineage: 'lineage-character-cross-select',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(30)

    let recover = false
    let revision = 30
    const commands: Array<{
      characterId: string
      mutationId: string | null
    }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url !== '/api/v1/commands/characters/select') {
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        const headers = init.headers as Record<string, string> | undefined
        commands.push({
          characterId: body.characterId,
          mutationId: headers?.['risu-mutation-id'] ?? null,
        })
        if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
        revision += 1
        return jsonResponse({
          revision,
          event: {
            type: 'character.selected',
            revision,
            resource: 'character',
            id: body.characterId,
          },
          characterId: body.characterId,
        })
      }) as unknown as typeof fetch,
    )

    try {
      const previousB = currentCharacterSelectionSnapshot('char-b')
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters[1].lastInteraction = 2_000
        selectedCharID.set(1)
      })
      charactersResourceState.currentChar = 1
      dispatchSelectCharacter('char-b', previousB, 2_000)
      await vi.waitFor(() => expect(commands).toHaveLength(1))

      const previousC = currentCharacterSelectionSnapshot('char-c')
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters[2].lastInteraction = 3_000
        selectedCharID.set(2)
      })
      charactersResourceState.currentChar = 2
      dispatchSelectCharacter('char-c', previousC, 3_000)
      await vi.waitFor(() => expect(commands).toHaveLength(2))
      expect(commands.map(({ characterId }) => characterId)).toEqual(['char-b', 'char-b'])
      expect((await listPendingMutations()).map((entry) => entry.handle.key)).toEqual([
        'character-selection',
        'character-selection',
      ])

      recover = true
      const recoveryStart = commands.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(commands.slice(recoveryStart).map(({ characterId }) => characterId)).toEqual(['char-b', 'char-c'])
      expect(new Set(commands.slice(recoveryStart).map(({ mutationId }) => mutationId)).size).toBe(2)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('restores the previous selection when the failed attempted selection is still live', async () => {
    const selectResponse = deferredResponse()
    const calls = stubDelayedSelectCommandFetch(selectResponse.promise)
    const previous = currentCharacterSelectionSnapshot('char-b')

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[1].lastInteraction = 2000
      selectedCharID.set(1)
    })
    charactersResourceState.currentChar = 1
    dispatchSelectCharacter('char-b', previous, 2000)

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/select',
      method: 'POST',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        characterId: 'char-b',
        lastInteraction: 2000,
      },
    })

    selectResponse.resolve(jsonResponse({ error: 'select failed' }, 500))

    await vi.waitFor(() => {
      expect(get(selectedCharID)).toBe(0)
    })
    expect(charactersResourceState.currentChar).toBe(0)
    expect(testDatabaseState.db.characters[1].lastInteraction).toBe(200)
  })

  it('preserves a newer selection when an older failed select command resolves late', async () => {
    const selectResponse = deferredResponse()
    const calls = stubDelayedSelectCommandFetch(selectResponse.promise)
    const previous = currentCharacterSelectionSnapshot('char-b')

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[1].lastInteraction = 2000
      selectedCharID.set(1)
    })
    charactersResourceState.currentChar = 1
    dispatchSelectCharacter('char-b', previous, 2000)
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[2].lastInteraction = 3000
      selectedCharID.set(2)
    })
    charactersResourceState.currentChar = 2
    selectResponse.resolve(jsonResponse({ error: 'select failed' }, 500))

    await flushAsyncWork()
    expect(get(selectedCharID)).toBe(2)
    expect(charactersResourceState.currentChar).toBe(2)
    expect(testDatabaseState.db.characters[1].lastInteraction).toBe(2000)
    expect(testDatabaseState.db.characters[2].lastInteraction).toBe(3000)
  })
})

describe('character order command helpers', () => {
  it('computes normalized character order without mutating the input order', () => {
    const order = [
      'missing',
      'char-a',
      { id: 'folder-1', name: 'Folder', color: 'blue', data: ['char-b', 'char-a', '§temp', 'char-c'] },
      null,
      '§playground',
      'char-b',
    ] as any[]
    const originalOrder = cloneForExpect(order)

    const result = normalizeCharacterOrder(order, [
      { chaId: 'char-a', name: 'A', chats: [] },
      { chaId: 'char-b', name: 'B', chats: [] },
      { chaId: 'char-c', name: 'C', chats: [] },
      { chaId: 'char-d', name: 'D', chats: [] },
      { chaId: 'trash', name: 'Trash', chats: [], trashTime: 123 },
      { chaId: '§temp', name: 'Temp', chats: [] },
      { chaId: '§playground', name: 'Playground', chats: [] },
    ] as any)

    expect(result).toEqual({
      changed: true,
      characterOrder: [
        'char-a',
        { id: 'folder-1', name: 'Folder', color: 'blue', data: ['char-b', 'char-c'] },
        '§playground',
        'char-d',
      ],
    })
    expect(order).toEqual(originalOrder)
    expect(result.characterOrder).not.toBe(order)
    expect(result.characterOrder[1]).not.toBe(order[2])
  })

  it('applies normalized character order through the character command domain and dispatches reorder', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
        { chaId: 'trash', name: 'Trash', chats: [], trashTime: 123 },
        { chaId: '§playground', name: 'Playground', chats: [] },
      ],
      characterOrder: [
        { id: 'folder-1', name: 'Folder', color: '', data: ['char-b', 'missing', 'char-a', 'trash'] },
        'char-b',
        '§playground',
      ],
    } as any
    const expectedOrder = [
      { id: 'folder-1', name: 'Folder', color: '', data: ['char-b', 'char-a'] },
      '§playground',
      'char-c',
    ]
    expect(repairCharacterOrderOptimistically()).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/characters/reorder',
      method: 'POST',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        characterOrder: expectedOrder,
      },
    })
  })

  it('can apply a suppressed optimistic repair for character create/delete command flows', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: ['char-a'],
    } as any
    expect(repairCharacterOrderOptimistically({ dispatchReorder: false })).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(['char-a', 'char-b'])
    await flushAsyncWork()
    expect(calls).toHaveLength(0)
  })

  it('moves a root character into a folder, dispatches reorder, normalizes order, and rolls back on failure', async () => {
    const calls = stubReorderCommandFetch({ failReorder: true })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
        { chaId: 'char-d', name: 'D', chats: [] },
      ],
      characterOrder: ['char-a', { id: 'folder-1', name: 'Folder', color: '', data: ['char-b'] }, 'char-c'],
      currentChar: 0,
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    const expectedOrder = [
      { id: 'folder-1', name: 'Folder', color: '', data: ['char-b', 'char-a'] },
      'char-c',
      'char-d',
    ]
    const mutation = moveCharacterOrderItemWithOutcome({ index: 0 }, { folder: 'folder-1', index: 1 })
    expect(mutation.applied).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/characters/reorder',
      method: 'POST',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        characterOrder: expectedOrder,
      },
    })
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    })
    await expect(mutation.settlement).resolves.toMatchObject({ status: 'failed' })
  })

  it('failed character reorder restores previous structure when live still equals attempted', async () => {
    const calls = stubReorderCommandFetch({
      failReorder: true,
      onReorder: () => {
        withTestDatabaseWrite(() => {
          charactersResourceState.currentChar = 1
          selectedCharID.set(1)
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
        { chaId: 'char-d', name: 'D', chats: [] },
      ],
      characterOrder: ['char-a', { id: 'folder-1', name: 'Folder', color: '', data: ['char-b'] }, 'char-c'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    const attemptedOrder = [
      { id: 'folder-1', name: 'Folder', color: '', data: ['char-b', 'char-a'] },
      'char-c',
      'char-d',
    ]
    expect(moveCharacterOrderItem({ index: 0 }, { folder: 'folder-1', index: 1 })).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(attemptedOrder)
    await waitForCallCount(calls, 2)
    expect(calls[1].body).toEqual({
      baseRevision: 10,
      characterOrder: attemptedOrder,
    })
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    })
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
  })

  it('moves a root character to a root position with the existing index behavior and rollback', async () => {
    const calls = stubReorderCommandFetch({ failReorder: true })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    expect(moveCharacterOrderItem({ index: 2 }, { index: 0 })).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(['char-c', 'char-a', 'char-b'])
    await waitForCallCount(calls, 2)
    expect(calls[1].body).toEqual({
      baseRevision: 10,
      characterOrder: ['char-c', 'char-a', 'char-b'],
    })
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    })
  })

  it('failed character reorder skips rollback after a newer reorder', async () => {
    const newerOrder = ['char-b', 'char-c', 'char-a']
    const calls = stubReorderCommandFetch({
      failReorder: true,
      onReorder: () => {
        withTestDatabaseWrite(() => {
          charactersResourceState.characterOrder = cloneForExpect(newerOrder)
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
    } as any
    expect(moveCharacterOrderItem({ index: 2 }, { index: 0 })).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(['char-c', 'char-a', 'char-b'])
    await waitForCallCount(calls, 2)
    expect(calls[1].body).toEqual({
      baseRevision: 10,
      characterOrder: ['char-c', 'char-a', 'char-b'],
    })
    await flushAsyncWork()
    expect(charactersResourceState.characterOrder).toEqual(newerOrder)
  })

  it('failed character reorder preserves newer folder metadata while restoring order structure', async () => {
    const calls = stubReorderCommandFetch({
      failReorder: true,
      onReorder: () => {
        withTestDatabaseWrite(() => {
          const folder = charactersResourceState.characterOrder.find(
            (entry): entry is folder => typeof entry !== 'string' && entry.id === 'folder-1',
          )
          if (folder) {
            folder.name = 'Newer Folder'
            folder.color = 'green'
            folder.imgFile = 'asset-newer'
            folder.img = '/api/v1/assets/asset-newer'
          }
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: [
        { id: 'folder-1', name: 'Folder', color: 'red', data: ['char-a'], imgFile: 'asset-old', img: 'old-src' },
        'char-b',
        'char-c',
      ],
    } as any
    expect(moveCharacterOrderItem({ index: 1 }, { folder: 'folder-1', index: 1 })).toBe(true)

    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder).toEqual([
        {
          id: 'folder-1',
          name: 'Newer Folder',
          color: 'green',
          data: ['char-a'],
          imgFile: 'asset-newer',
          img: '/api/v1/assets/asset-newer',
        },
        'char-b',
        'char-c',
      ])
    })
  })

  it('returns false without mutation or command when moving a folder into a folder', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: [
        { id: 'folder-a', name: 'Folder A', color: '', data: ['char-a'] },
        { id: 'folder-b', name: 'Folder B', color: '', data: ['char-b'] },
      ],
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    expect(moveCharacterOrderItem({ index: 0 }, { folder: 'folder-b', index: 0 })).toBe(false)

    await flushAsyncWork()
    expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    expect(calls).toHaveLength(0)
  })

  it('creates a new folder from two root characters, dispatches reorder, and rolls back on failure', async () => {
    const calls = stubReorderCommandFetch({ failReorder: true })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 0,
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    const expectedOrder = [
      { id: 'folder-new', name: 'Localized Folder', color: '', data: ['char-a', 'char-b'] },
      'char-c',
    ]
    expect(createCharacterOrderFolder({ index: 0 }, { index: 1 }, () => 'folder-new', 'Localized Folder')).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
    await waitForCallCount(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/characters/reorder',
      method: 'POST',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        characterOrder: expectedOrder,
      },
    })
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    })
  })

  it('returns false without mutation or command for identical drag positions', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    expect(moveCharacterOrderItem({ index: 0 }, { index: 0 })).toBe(false)
    expect(createCharacterOrderFolder({ index: 0 }, { index: 0 }, () => 'unused')).toBe(false)

    await flushAsyncWork()
    expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    expect(calls).toHaveLength(0)
  })

  it.each([
    [
      'rename',
      { name: 'Renamed Folder' },
      { id: 'folder-b', name: 'Renamed Folder', color: 'blue', data: ['char-b'], imgFile: 'asset-old', img: 'old-src' },
    ],
    [
      'color',
      { color: 'PURPLE' },
      { id: 'folder-b', name: 'Folder B', color: 'purple', data: ['char-b'], imgFile: 'asset-old', img: 'old-src' },
    ],
    [
      'opening confirmation',
      { askBeforeOpening: true },
      {
        id: 'folder-b',
        name: 'Folder B',
        color: 'blue',
        data: ['char-b'],
        askBeforeOpening: true,
        imgFile: 'asset-old',
        img: 'old-src',
      },
    ],
    [
      'image reset',
      { imgFile: null, img: '' },
      { id: 'folder-b', name: 'Folder B', color: 'blue', data: ['char-b'], imgFile: null, img: '' },
    ],
    [
      'image update',
      { imgFile: 'asset-new', img: '/api/v1/assets/asset-new' },
      {
        id: 'folder-b',
        name: 'Folder B',
        color: 'blue',
        data: ['char-b'],
        imgFile: 'asset-new',
        img: '/api/v1/assets/asset-new',
      },
    ],
  ])(
    'updates folder metadata for %s, dispatches reorder, and rolls back on failure',
    async (_, patch, expectedFolder) => {
      const calls = stubReorderCommandFetch({ failReorder: true })
      testDatabaseState.db = {
        characters: [
          { chaId: 'char-a', name: 'A', chats: [] },
          { chaId: 'char-b', name: 'B', chats: [] },
        ],
        characterOrder: [
          { id: 'folder-a', name: 'Folder A', color: 'red', data: ['char-a'] },
          { id: 'folder-b', name: 'Folder B', color: 'blue', data: ['char-b'], imgFile: 'asset-old', img: 'old-src' },
        ],
        currentChar: 0,
      } as any
      const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
      const expectedOrder = [previousOrder[0], expectedFolder]
      expect(updateCharacterOrderFolder({ id: 'folder-b', index: 0 }, patch)).toBe(true)

      expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
      await waitForCallCount(calls, 2)
      expect(calls[1]).toEqual({
        url: '/api/v1/commands/characters/reorder',
        method: 'POST',
        authHeader: 'character-command-token',
        body: {
          baseRevision: 10,
          characterOrder: expectedOrder,
        },
      })
      await vi.waitFor(() => {
        expect(charactersResourceState.characterOrder).toEqual(previousOrder)
      })
    },
  )

  it('failed folder metadata rollback skips when the same folder metadata changed again', async () => {
    const calls = stubReorderCommandFetch({
      failReorder: true,
      onReorder: () => {
        withTestDatabaseWrite(() => {
          const folder = charactersResourceState.characterOrder.find(
            (entry): entry is folder => typeof entry !== 'string' && entry.id === 'folder-b',
          )
          if (folder) folder.name = 'Newer Folder B'
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: [
        { id: 'folder-a', name: 'Folder A', color: 'red', data: ['char-a'] },
        { id: 'folder-b', name: 'Folder B', color: 'blue', data: ['char-b'] },
      ],
    } as any
    expect(updateCharacterOrderFolder({ id: 'folder-b', index: 0 }, { name: 'Attempted Folder B' })).toBe(true)

    expect(charactersResourceState.characterOrder[1]).toMatchObject({ id: 'folder-b', name: 'Attempted Folder B' })
    await waitForCallCount(calls, 2)
    expect(calls[1].body).toEqual({
      baseRevision: 10,
      characterOrder: [
        { id: 'folder-a', name: 'Folder A', color: 'red', data: ['char-a'] },
        { id: 'folder-b', name: 'Attempted Folder B', color: 'blue', data: ['char-b'] },
      ],
    })
    await flushAsyncWork()
    expect(charactersResourceState.characterOrder[1]).toMatchObject({ id: 'folder-b', name: 'Newer Folder B' })
  })

  it('failed folder metadata rollback does not restore selectedCharID or current character', async () => {
    const calls = stubReorderCommandFetch({
      failReorder: true,
      onReorder: () => {
        withTestDatabaseWrite(() => {
          charactersResourceState.currentChar = 1
          selectedCharID.set(1)
        })
      },
    })
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: [{ id: 'folder-b', name: 'Folder B', color: 'blue', data: ['char-b'] }, 'char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    expect(updateCharacterOrderFolder({ id: 'folder-b', index: 0 }, { color: 'PURPLE' })).toBe(true)

    expect(charactersResourceState.characterOrder[0]).toMatchObject({ id: 'folder-b', color: 'purple' })
    await waitForCallCount(calls, 2)
    await vi.waitFor(() => {
      expect(charactersResourceState.characterOrder[0]).toMatchObject({ id: 'folder-b', color: 'blue' })
    })
    expect(get(selectedCharID)).toBe(1)
    expect(charactersResourceState.currentChar).toBe(1)
  })

  it('returns false without mutation or command for a missing folder target', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'A', chats: [] }],
      characterOrder: [{ id: 'folder-a', name: 'Folder A', color: '', data: ['char-a'] }],
    } as any
    const previousOrder = cloneForExpect(charactersResourceState.characterOrder)
    expect(updateCharacterOrderFolder({ id: 'missing-folder', index: 0 }, { name: 'Wrong' })).toBe(false)
    expect(updateCharacterOrderFolder({}, { name: 'Wrong' })).toBe(false)

    await flushAsyncWork()
    expect(charactersResourceState.characterOrder).toEqual(previousOrder)
    expect(calls).toHaveLength(0)
  })

  it('uses stable folder id instead of a stale fallback index', async () => {
    const calls = stubReorderCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: [
        { id: 'folder-a', name: 'Folder A', color: '', data: ['char-a'] },
        { id: 'folder-b', name: 'Folder B', color: '', data: ['char-b'] },
      ],
    } as any
    expect(updateCharacterOrderFolder({ id: 'folder-b', index: 0 }, { name: 'Updated B' })).toBe(true)

    expect(charactersResourceState.characterOrder).toEqual([
      { id: 'folder-a', name: 'Folder A', color: '', data: ['char-a'] },
      { id: 'folder-b', name: 'Updated B', color: '', data: ['char-b'] },
    ])
    await waitForCallCount(calls, 2)
    expect(calls[1].body).toEqual({
      baseRevision: 10,
      characterOrder: [
        { id: 'folder-a', name: 'Folder A', color: '', data: ['char-a'] },
        { id: 'folder-b', name: 'Updated B', color: '', data: ['char-b'] },
      ],
    })
  })

  describe('durable character order dispatch', () => {
    beforeEach(async () => {
      vi.stubGlobal('indexedDB', new IDBFactory())
      resetPendingMutationOutboxForTests()
      await preparePendingMutationOutbox({
        writerSessionId: 'writer-character-order',
        writerEpoch: 21,
        databaseLineage: 'lineage-character-order',
        requestedWriterWasActive: true,
      })
      setCachedServerCommandRevision(30)
    })

    afterEach(async () => {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    })

    it('persists and applies one exact reorder without duplicate dispatch', async () => {
      testDatabaseState.db = {
        characters: [
          { chaId: 'char-a', name: 'A', chats: [] },
          { chaId: 'char-b', name: 'B', chats: [] },
          { chaId: 'char-c', name: 'C', chats: [] },
        ],
        characterOrder: ['char-a', 'char-b', 'char-c'],
      } as any
      const reorderRequests: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url !== '/api/v1/commands/characters/reorder') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          const headers = init.headers as Record<string, string> | undefined
          reorderRequests.push({
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
            mutationId: headers?.['risu-mutation-id'] ?? null,
          })
          return jsonResponse({
            revision: 31,
            event: { type: 'character.reordered', revision: 31, resource: 'character' },
            selectedCharacterId: 'char-a',
          })
        }) as unknown as typeof fetch,
      )

      expect(moveCharacterOrderItem({ index: 2 }, { index: 0 })).toBe(true)

      await vi.waitFor(() => expect(reorderRequests).toHaveLength(1))
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
      expect(reorderRequests[0]).toEqual({
        body: {
          baseRevision: 30,
          characterOrder: ['char-c', 'char-a', 'char-b'],
        },
        mutationId: expect.any(String),
      })
      expect(charactersResourceState.characterOrder).toEqual(['char-c', 'char-a', 'char-b'])
      await flushAsyncWork()
      expect(reorderRequests).toHaveLength(1)
    })

    it('retains and reasserts a queued reorder after a retryable failure, then replays it', async () => {
      const previousOrder = ['char-a', 'char-b', 'char-c']
      const attemptedOrder = ['char-c', 'char-a', 'char-b']
      testDatabaseState.db = {
        characters: [
          { chaId: 'char-a', name: 'A', chats: [] },
          { chaId: 'char-b', name: 'B', chats: [] },
          { chaId: 'char-c', name: 'C', chats: [] },
        ],
        characterOrder: cloneForExpect(previousOrder),
      } as any
      let recover = false
      let reorderRequests = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url !== '/api/v1/commands/characters/reorder') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          reorderRequests += 1
          if (!recover) {
            withTestDatabaseWrite(() => {
              charactersResourceState.characterOrder = cloneForExpect(previousOrder)
            })
            return jsonResponse({ error: 'temporarily unavailable' }, 500)
          }
          return jsonResponse({
            revision: 31,
            event: { type: 'character.reordered', revision: 31, resource: 'character' },
            selectedCharacterId: 'char-a',
          })
        }) as unknown as typeof fetch,
      )

      const mutation = moveCharacterOrderItemWithOutcome({ index: 2 }, { index: 0 })
      expect(mutation.applied).toBe(true)

      await vi.waitFor(() => expect(reorderRequests).toBe(1))
      await expect(mutation.settlement).resolves.toMatchObject({ status: 'queued' })
      await vi.waitFor(() => expect(charactersResourceState.characterOrder).toEqual(attemptedOrder))
      const retained = await listPendingMutations()
      expect(retained).toHaveLength(1)
      expect(retained[0]).toMatchObject({
        handle: { key: 'character-selection' },
        intent: {
          dependencyKeys: ['character-owner:char-c'],
          requests: [
            {
              method: 'POST',
              path: '/characters/reorder',
              body: { characterOrder: attemptedOrder },
            },
          ],
        },
      })

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      expect(reorderRequests).toBe(2)
      expect(charactersResourceState.characterOrder).toEqual(attemptedOrder)
      expect(await listPendingMutations()).toEqual([])
    })

    it('rolls back a terminal reorder rejection and removes its durable row', async () => {
      const previousOrder = ['char-a', 'char-b', 'char-c']
      testDatabaseState.db = {
        characters: [
          { chaId: 'char-a', name: 'A', chats: [] },
          { chaId: 'char-b', name: 'B', chats: [] },
          { chaId: 'char-c', name: 'C', chats: [] },
        ],
        characterOrder: cloneForExpect(previousOrder),
      } as any
      let reorderRequests = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url !== '/api/v1/commands/characters/reorder') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          reorderRequests += 1
          return jsonResponse({ error: 'invalid character order' }, 400)
        }) as unknown as typeof fetch,
      )

      expect(moveCharacterOrderItem({ index: 2 }, { index: 0 })).toBe(true)
      expect(charactersResourceState.characterOrder).toEqual(['char-c', 'char-a', 'char-b'])

      await vi.waitFor(() => expect(charactersResourceState.characterOrder).toEqual(previousOrder))
      expect(reorderRequests).toBe(1)
      expect(await listPendingMutations()).toEqual([])
    })

    it('keeps rapid later folder metadata and reorder projections when an older reorder rejects', async () => {
      const firstResponse = deferredResponse()
      testDatabaseState.db = {
        characters: [
          { chaId: 'char-a', name: 'A', chats: [] },
          { chaId: 'char-b', name: 'B', chats: [] },
          { chaId: 'char-c', name: 'C', chats: [] },
        ],
        characterOrder: ['char-a', { id: 'folder-1', name: 'Folder', color: 'blue', data: ['char-b'] }, 'char-c'],
      } as any
      let revision = 30
      const reorderRequests: Array<{ body: Record<string, unknown>; mutationId: string | null }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url !== '/api/v1/commands/characters/reorder') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          const headers = init.headers as Record<string, string> | undefined
          reorderRequests.push({
            body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
            mutationId: headers?.['risu-mutation-id'] ?? null,
          })
          if (reorderRequests.length === 1) return firstResponse.promise
          revision += 1
          return jsonResponse({
            revision,
            event: { type: 'character.reordered', revision, resource: 'character' },
            selectedCharacterId: 'char-a',
          })
        }) as unknown as typeof fetch,
      )

      expect(moveCharacterOrderItem({ index: 0 }, { folder: 'folder-1', index: 1 })).toBe(true)
      await vi.waitFor(() => expect(reorderRequests).toHaveLength(1))
      expect(updateCharacterOrderFolder('folder-1', { name: 'Later Folder' })).toBe(true)
      expect(moveCharacterOrderItem({ index: 1 }, { index: 0 })).toBe(true)

      const expectedOrder = [
        'char-c',
        { id: 'folder-1', name: 'Later Folder', color: 'blue', data: ['char-b', 'char-a'] },
      ]
      expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
      firstResponse.resolve(jsonResponse({ error: 'invalid character order' }, 400))

      await vi.waitFor(() => expect(reorderRequests).toHaveLength(3))
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
      expect(charactersResourceState.characterOrder).toEqual(expectedOrder)
      expect(reorderRequests.map(({ body }) => body.characterOrder)).toEqual([
        [{ id: 'folder-1', name: 'Folder', color: 'blue', data: ['char-b', 'char-a'] }, 'char-c'],
        [{ id: 'folder-1', name: 'Later Folder', color: 'blue', data: ['char-b', 'char-a'] }, 'char-c'],
        expectedOrder,
      ])
      expect(new Set(reorderRequests.map(({ mutationId }) => mutationId)).size).toBe(3)
    })
  })
})

describe('character command projection helpers', () => {
  it('setCharacterSupaMemory applies one-field optimistic command patch', async () => {
    const calls = stubCommandFetch()
    const mutation = setCharacterSupaMemoryWithOutcome('char-a', true)

    expect(testDatabaseState.db.characters[0].supaMemory).toBe(true)

    await waitForCallCount(calls, 2)
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'character-command-token',
        body: null,
      },
      {
        url: '/api/v1/commands/characters/char-a',
        method: 'PATCH',
        authHeader: 'character-command-token',
        body: {
          baseRevision: 10,
          patch: { supaMemory: true },
        },
      },
    ])
    await expect(mutation).resolves.toMatchObject({ status: 'accepted' })
  })
})

describe('select supa memory flag patch', () => {
  it('retains a transient supaMemory toggle for replay without duplicate sends', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-supa',
      writerEpoch: 1,
      databaseLineage: 'lineage-character-supa',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    let recover = false
    const patches: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-a') {
          patches.push(typeof init.body === 'string' ? JSON.parse(init.body) : {})
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character', id: 'char-a' },
            characterId: 'char-a',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      await expect(setCharacterSupaMemoryWithOutcome('char-a', true)).resolves.toMatchObject({ status: 'queued' })
      expect(testDatabaseState.db.characters[0].supaMemory).toBe(true)
      expect((await listPendingMutations()).map((entry) => entry.intent.requests[0])).toMatchObject([
        {
          method: 'PATCH',
          path: '/characters/char-a',
          body: { patch: { supaMemory: true } },
        },
      ])

      expect(setCharacterSupaMemory('char-a', true)).toBeUndefined()
      expect(patches).toHaveLength(1)

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      expect(patches).toHaveLength(2)
      expect(patches.map((body) => body.patch)).toEqual([{ supaMemory: true }, { supaMemory: true }])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('supaMemory snapshots are scalar and restore only the target flag', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(1)

    const snapshot = currentCharacterSupaMemorySnapshot('char-1')

    expect(snapshot).toEqual({
      characterId: 'char-1',
      hadSupaMemory: false,
      supaMemory: undefined,
    })
    assertSnapshotIsScalar(snapshot)

    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const instrumented = withCloneInstrumentation(() => currentCharacterSupaMemorySnapshot('char-1'))
    expect(instrumented.totalCloneCount).toBe(0)
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)

    testDatabaseState.db.characters[1].supaMemory = true
    testDatabaseState.db.characters[1].name = 'Same row concurrent edit'
    testDatabaseState.db.characters[0].name = 'Sibling concurrent edit'
    selectedCharID.set(2)

    restoreCharacterSupaMemory(snapshot!)

    expect(Object.prototype.hasOwnProperty.call(testDatabaseState.db.characters[1], 'supaMemory')).toBe(false)
    expect(testDatabaseState.db.characters[1].name).toBe('Same row concurrent edit')
    expect(testDatabaseState.db.characters[0].name).toBe('Sibling concurrent edit')
    expect(get(selectedCharID)).toBe(2)
  })

  it('setCharacterSupaMemory captures no full character row or characters array clone', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-1') {
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character' },
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = seedCloneCostDb({
      hydratedMessageCount: 80,
      messageBodySize: 500,
    }) as any
    selectedCharID.set(1)
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const targetRowSize = JSON.stringify(testDatabaseState.db.characters[1]).length

    const instrumented = withCloneInstrumentation(() => {
      setCharacterSupaMemory('char-1', true)
    })

    expect(testDatabaseState.db.characters[1].supaMemory).toBe(true)
    expect(instrumented.maxClonedSize).toBeLessThan(targetRowSize)
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)

    await waitForCallCount(calls, 2)
    expect(calls.find((call) => call.url === '/api/v1/commands/characters/char-1')).toEqual({
      url: '/api/v1/commands/characters/char-1',
      method: 'PATCH',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        patch: { supaMemory: true },
      },
    })
  })

  it('failed supaMemory command restores only supaMemory and preserves selection', async () => {
    const calls: CapturedFetch[] = []
    const patchResponse = deferredResponse()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-a') return patchResponse.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'Character', chats: [], supaMemory: false },
        { chaId: 'char-b', name: 'Sibling', chats: [], supaMemory: false },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)

    const mutation = setCharacterSupaMemoryWithOutcome('char-a', true)
    await waitForCharacterPatch(calls, 'char-a')
    expect(testDatabaseState.db.characters[0].supaMemory).toBe(true)

    testDatabaseState.db.characters[0].name = 'Same row concurrent edit'
    testDatabaseState.db.characters[1].name = 'Sibling concurrent edit'
    selectedCharID.set(1)
    patchResponse.resolve(jsonResponse({ error: 'nope' }, 500))

    await expect(mutation).resolves.toMatchObject({ status: 'failed' })

    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters[0].supaMemory).toBe(false)
    })
    expect(testDatabaseState.db.characters[0].name).toBe('Same row concurrent edit')
    expect(testDatabaseState.db.characters[1].name).toBe('Sibling concurrent edit')
    expect(get(selectedCharID)).toBe(1)
  })

  it('selectedCharID auto-enable uses one-field patch without full row clone', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-1') {
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character' },
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    selectedCharID.set(-1)
    testDatabaseState.db = {
      ...seedCloneCostDb({
        hydratedMessageCount: 80,
        messageBodySize: 500,
      }),
      hypaV3: true,
      selectedHypaV3PresetId: 'preset-on',
      hypaV3Presets: [{ id: 'preset-on', name: 'Always on', settings: { alwaysToggleOn: true } }],
    } as any
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const targetRowSize = JSON.stringify(testDatabaseState.db.characters[1]).length
    const disposeRuntimeEffects = installStoreRuntimeEffects()

    try {
      const instrumented = await withAsyncCloneInstrumentation(async () => {
        selectedCharID.set(1)
        expect(selIdState.selId).toBe(1)
        await waitForCharacterPatch(calls, 'char-1')
      })

      expect(testDatabaseState.db.characters[1].supaMemory).toBe(true)
      expect(instrumented.maxClonedSize).toBeLessThan(targetRowSize)
      expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
      expect(calls.find((call) => call.url === '/api/v1/commands/characters/char-1')).toEqual({
        url: '/api/v1/commands/characters/char-1',
        method: 'PATCH',
        authHeader: 'character-command-token',
        body: {
          baseRevision: 10,
          patch: { supaMemory: true },
        },
      })

      selectedCharID.set(-1)
      selectedCharID.set(1)
      await flushAsyncWork()
      expect(calls.filter((call) => call.url === '/api/v1/commands/characters/char-1')).toHaveLength(1)
    } finally {
      disposeRuntimeEffects()
    }
  })

  it('selectedCharID auto-enable preserves all no-op gates', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        calls.push({
          url: String(input),
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        return jsonResponse({ error: 'unexpected command' }, 500)
      }) as unknown as typeof fetch,
    )

    const cases: Array<[string, unknown]> = [
      [
        'Hypa V3 disabled',
        {
          characters: [{ chaId: 'char-a', name: 'Character', chats: [], supaMemory: false }],
          hypaV3: false,
          hypaV3PresetId: 'preset-on',
          hypaV3Presets: { 'preset-on': { settings: { alwaysToggleOn: true } } },
        },
      ],
      [
        'preset missing',
        {
          characters: [{ chaId: 'char-a', name: 'Character', chats: [], supaMemory: false }],
          hypaV3: true,
          hypaV3PresetId: 'missing',
          hypaV3Presets: {},
        },
      ],
      [
        'alwaysToggleOn disabled',
        {
          characters: [{ chaId: 'char-a', name: 'Character', chats: [], supaMemory: false }],
          hypaV3: true,
          hypaV3PresetId: 'preset-off',
          hypaV3Presets: { 'preset-off': { settings: { alwaysToggleOn: false } } },
        },
      ],
      [
        'selected character missing',
        {
          characters: [],
          hypaV3: true,
          hypaV3PresetId: 'preset-on',
          hypaV3Presets: { 'preset-on': { settings: { alwaysToggleOn: true } } },
        },
      ],
      [
        'character id missing',
        {
          characters: [{ name: 'Character', chats: [], supaMemory: false }],
          hypaV3: true,
          hypaV3PresetId: 'preset-on',
          hypaV3Presets: { 'preset-on': { settings: { alwaysToggleOn: true } } },
        },
      ],
      [
        'already enabled',
        {
          characters: [{ chaId: 'char-a', name: 'Character', chats: [], supaMemory: true }],
          hypaV3: true,
          hypaV3PresetId: 'preset-on',
          hypaV3Presets: { 'preset-on': { settings: { alwaysToggleOn: true } } },
        },
      ],
    ]

    selectedCharID.set(-1)
    const disposeRuntimeEffects = installStoreRuntimeEffects()
    try {
      for (const [label, db] of cases) {
        clearCachedServerCommandRevision()
        calls.length = 0
        selectedCharID.set(-1)
        testDatabaseState.db = db as any
        const beforeSupaMemory = testDatabaseState.db.characters?.[0]?.supaMemory
        selectedCharID.set(0)
        expect(selIdState.selId).toBe(0)
        await flushAsyncWork()
        expect(testDatabaseState.db.characters?.[0]?.supaMemory, label).toBe(beforeSupaMemory)
        expect(calls, label).toHaveLength(0)
      }
    } finally {
      disposeRuntimeEffects()
    }
  })
})

describe('character-row snapshot kit', () => {
  it.each(['idle', 'loading', 'error'] as const)(
    'does not expose retained character rows while the owner is %s',
    (status) => {
      testDatabaseState.db = {
        characters: [{ chaId: 'char-a', name: 'Retained', chats: [], supaMemory: true }],
        characterOrder: ['char-a'],
        currentChar: 0,
      } as any
      charactersResourceState.status = status

      expect(currentCharacterRowSnapshot(0).character).toBeUndefined()
      expect(currentCharacterSupaMemorySnapshot('char-a')).toBeNull()
      expect(applyCharacterRowMutationScoped(0, 'char-a', (character) => (character.name = 'mutated'))).toBe(false)
    },
  )

  it('fails closed for ordinary row mutation when the owner is missing, duplicated, or errored', () => {
    const aggregate = { chaId: 'char-a', name: 'Aggregate', chats: [] }
    testDatabaseState.db = {
      characters: [aggregate],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    charactersResourceState.characters = [
      { chaId: 'char-a', name: 'Owner A', chats: [] },
      { chaId: 'char-a', name: 'Duplicate A', chats: [] },
    ] as any
    selectedCharID.set(0)

    expect(applyCharacterRowMutationScoped(0, 'char-a', (character) => (character.name = 'mutated'))).toBe(false)
    expect(charactersResourceState.characters.map((character) => character.name)).toEqual(['Owner A', 'Duplicate A'])

    charactersResourceState.status = 'error'
    expect(applyCharacterRowMutationScoped(0, 'char-a', (character) => (character.name = 'mutated'))).toBe(false)
  })

  it('fails closed when the ready owner collection contains duplicate stable IDs', () => {
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'Aggregate', chats: [], lastInteraction: 7 }],
      characterOrder: [],
      currentChar: 0,
    } as any
    charactersResourceState.characters = [
      { chaId: 'char-a', name: 'Owner A', chats: [], lastInteraction: 11 },
      { chaId: 'char-a', name: 'Owner duplicate', chats: [], lastInteraction: 13 },
    ] as any
    selectedCharID.set(0)

    expect(currentCharacterSelectionSnapshot('char-a').lastInteraction).toBeUndefined()
    expect(currentCharacterRowSnapshot(0).characterId).toBeUndefined()
  })

  it('captures row and trash snapshots from the ready owner instead of stale aggregate data', () => {
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'Aggregate stale', chats: [], trashTime: 3 }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    const staleAggregate = getResourceDatabase().characters
    charactersResourceState.characters = [{ chaId: 'char-a', name: 'Owner current', chats: [], trashTime: 17 }] as any
    selectedCharID.set(0)

    expect(staleAggregate[0].name).toBe('Aggregate stale')
    expect(currentCharacterRowSnapshot(0).character?.name).toBe('Owner current')
    expect(currentCharacterTrashTimeSnapshot(0).trashTime).toBe(17)
  })

  it('captures one character row plus selection scalars, never the whole array', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(2)

    const snapshot = currentCharacterRowSnapshot(1)

    expect(snapshot.characterId).toBe('char-1')
    expect(snapshot.index).toBe(1)
    expect(snapshot.character?.chaId).toBe('char-1')
    expect(snapshot.currentChar).toBe(0)
    expect(snapshot.selectedCharID).toBe(2)
    expect(snapshot).not.toHaveProperty('characters')
    expect(Array.isArray((snapshot as { character?: unknown }).character)).toBe(false)
    assertSnapshotOmitsCollections(snapshot)

    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const instrumented = withCloneInstrumentation(() => currentCharacterRowSnapshot(1))
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
  })

  it('restores only the targeted row and preserves concurrent edits to siblings', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(1)

    assertRollbackRestoresOnly({
      capture: () => currentCharacterRowSnapshot(1),
      mutate: () => {
        // optimistic edit to the targeted row that the failing command will undo
        testDatabaseState.db.characters[1].name = 'Optimistic'
        // a concurrent, unrelated edit to a sibling row
        testDatabaseState.db.characters[0].name = 'Concurrent sibling edit'
      },
      expectMutated: () => {
        expect(testDatabaseState.db.characters[1].name).toBe('Optimistic')
      },
      restore: (snapshot) => restoreCharacterRow(snapshot),
      expectRestored: () => {
        expect(testDatabaseState.db.characters[1].name).toBe('Character 1')
      },
      expectUntouched: () => {
        // a full-array restore would have wiped the sibling's concurrent edit
        expect(testDatabaseState.db.characters[0].name).toBe('Concurrent sibling edit')
      },
    })
  })

  it('restores the row by stable id even when its index has shifted', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(0)
    const snapshot = currentCharacterRowSnapshot(1)

    // Simulate a reorder/insert before the captured index so the row moves from
    // index 1 to index 2.
    testDatabaseState.db.characters[1].name = 'Optimistic'
    testDatabaseState.db.characters.unshift({ chaId: 'char-new', name: 'Inserted', chats: [] } as any)
    expect(testDatabaseState.db.characters[2].chaId).toBe('char-1')

    restoreCharacterRow(snapshot)

    // char-1 is restored at its new id-located index, not at the stale index 1.
    expect(testDatabaseState.db.characters.find((c: any) => c.chaId === 'char-1')?.name).toBe('Character 1')
    // the stale captured index (1) now holds char-0 and must be left untouched.
    expect(testDatabaseState.db.characters[1].chaId).toBe('char-0')
    expect(testDatabaseState.db.characters[1].name).toBe('Character 0')
  })

  it('does not restore attempted character fields after a newer same-row edit', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(0)
    const snapshot = currentCharacterRowSnapshot(1)

    testDatabaseState.db.characters[1].name = 'Newer local name'
    restoreCharacterRow({
      ...snapshot,
      attempted: { name: 'Optimistic name' },
    })

    expect(testDatabaseState.db.characters[1].name).toBe('Newer local name')
  })

  it('deletes a row field added by a failed attempted rollback when the baseline lacked it', () => {
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'Character', chats: [] },
        { chaId: 'char-b', name: 'Sibling', chats: [] },
      ],
      characterOrder: [],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const snapshot = currentCharacterRowSnapshot(0)

    testDatabaseState.db.characters[0].creatorNotes = 'Optimistic notes'
    restoreCharacterRow({
      ...snapshot,
      attempted: { creatorNotes: 'Optimistic notes' },
    })

    expect(Object.hasOwn(testDatabaseState.db.characters[0], 'creatorNotes')).toBe(false)
    expect(testDatabaseState.db.characters[1].name).toBe('Sibling')
  })

  it('keeps the selection snapshot below the whole-character collection size', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(0)
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length

    const selection = withCloneInstrumentation(() => currentCharacterSelectionSnapshot('char-0'))
    expect(selection.maxClonedSize).toBeLessThan(charactersSize)
    assertSnapshotIsScalar(selection.result)
  })
})

describe('character-row scoped dispatch', () => {
  it('dispatchCompatibleCharacterUpdateScoped rolls back only the target row on failure', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-a') return jsonResponse({ error: 'nope' }, 500)
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'Character', chats: [] },
        { chaId: 'char-b', name: 'Sibling', chats: [] },
      ],
      characterOrder: [],
    } as any
    selectedCharID.set(0)

    const previous = currentCharacterRowSnapshot(0)
    const previousCharacter = JSON.parse(JSON.stringify(testDatabaseState.db.characters[0]))

    // optimistic edit to the target row plus an unrelated concurrent sibling edit
    const nextCharacter = { ...previousCharacter, name: 'Optimistic' }
    testDatabaseState.db.characters[0] = nextCharacter as any
    testDatabaseState.db.characters[1].name = 'Concurrent sibling edit'

    dispatchCompatibleCharacterUpdateScoped(previousCharacter as any, nextCharacter as any, previous)
    await waitForCallCount(calls, 2)

    // the failed update restores only the target row; the sibling edit survives a
    // whole-array restore would have wiped.
    expect(testDatabaseState.db.characters[0].name).toBe('Character')
    expect(testDatabaseState.db.characters[1].name).toBe('Concurrent sibling edit')
  })

  it('setCharacterByIndex captures a single-row rollback baseline, never the whole array', async () => {
    testDatabaseState.db = seedCloneCostDb() as any // char-0 large (40 messages), siblings small
    selectedCharID.set(1)
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ revision: 10 })) as unknown as typeof fetch)

    const target = JSON.parse(JSON.stringify(testDatabaseState.db.characters[1]))
    target.name = 'Renamed'

    // The selection capture + the compatible-update diff stay bounded to the one
    // edited row; the large sibling (char-0) transcript is never serialized.
    const instrumented = withCloneInstrumentation(() => {
      setCharacterByIndex(1, target as any)
    })
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)

    // drain the async dispatch so it does not leak into the next test
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('kept-key character diff', () => {
  it('restores a rejected deletion without overwriting a newer field value', () => {
    const previous = { loreSettings: { scanDepth: 4 } }
    const deletedProjection: Record<string, unknown> = {}

    expect(
      applyAttemptedCharacterFieldRollback({
        target: deletedProjection,
        previous,
        attempted: { loreSettings: null },
      }),
    ).toEqual(['loreSettings'])
    expect(deletedProjection.loreSettings).toEqual({ scanDepth: 4 })

    const newerProjection = { loreSettings: { scanDepth: 9 } }
    expect(
      applyAttemptedCharacterFieldRollback({
        target: newerProjection,
        previous,
        attempted: { loreSettings: null },
      }),
    ).toEqual([])
    expect(newerProjection.loreSettings).toEqual({ scanDepth: 9 })
  })

  it('applies the lore settings sentinel as an optimistic field deletion', () => {
    const character = {
      chaId: 'char-a',
      name: 'A',
      loreSettings: { scanDepth: 4, tokenBudget: 800 },
    } as any

    const updated = applyCompatibleCharacterPatch(character, { loreSettings: null }) as unknown as Record<
      string,
      unknown
    >

    expect(updated).not.toHaveProperty('loreSettings')
    expect(character).toHaveProperty('loreSettings')
  })

  it('changedCharacterFields diffs without cloning the chats payload', () => {
    testDatabaseState.db = seedCloneCostDb() as any // char-0 carries a 40-message hydrated chat
    const previous = testDatabaseState.db.characters[0]
    const next = { ...previous, name: 'Renamed' }
    const chatsSize = JSON.stringify(previous.chats).length

    const instrumented = withCloneInstrumentation(() => changedCharacterFields(previous, next as any))

    // Pre-fix the diff cloned BOTH characters in full (chats with every hydrated
    // history included) before stripping exactly those keys.
    expect(instrumented.maxClonedSize).toBeLessThan(chatsSize)
    expect(instrumented.result).toEqual({ name: 'Renamed' })
  })

  it('the per-key diff preserves ordinary semantics and emits supported deletion sentinels', () => {
    const previous = {
      chaId: 'char-a',
      name: 'Old name',
      desc: 'same',
      lastInteraction: 100,
      nested: { a: 1, b: [1, 2] },
      removed: 'gone after',
      loreSettings: { scanDepth: 4, tokenBudget: 800 },
      chats: [{ id: 'chat-1', message: [{ role: 'user', data: 'x' }] }],
      scriptstate: { $x: '1' },
    }
    const next = {
      chaId: 'char-a',
      name: 'New name',
      desc: 'same',
      lastInteraction: 200,
      nested: { a: 1, b: [1, 2, 3] },
      added: 'new field',
      chats: [{ id: 'chat-1', message: [] }], // excluded key change must be ignored
      scriptstate: { $x: '2' }, // excluded key change must be ignored
    }

    const patch = changedCharacterFields(previous as any, next as any)

    expect(patch).toMatchObject({
      name: 'New name',
      nested: { a: 1, b: [1, 2, 3] },
      added: 'new field',
    })
    // An unsupported deleted field remains explicit undefined and is dropped.
    expect('removed' in patch).toBe(true)
    expect(patch.removed).toBeUndefined()
    // Supported deletions are translated into the server's null sentinel.
    expect('loreSettings' in patch).toBe(true)
    expect(patch.loreSettings).toBeUndefined()
    expect(sanitizeCharacterPatch(patch)).toEqual({
      name: 'New name',
      nested: { a: 1, b: [1, 2, 3] },
      added: 'new field',
      loreSettings: null,
    })
    // excluded keys never enter the patch, changed or not
    expect('chats' in patch).toBe(false)
    expect('scriptstate' in patch).toBe(false)
    expect('lastInteraction' in patch).toBe(false)
    expect('chaId' in patch).toBe(false)
    expect('desc' in patch).toBe(false)
  })

  it('prepareCompatibleCharacterUpdate builds its factory without serializing the transcript', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    const previous = testDatabaseState.db.characters[0]
    const next = { ...previous, name: 'Renamed' }
    const chatsSize = JSON.stringify(previous.chats).length
    const rowSnapshot = currentCharacterStateSnapshot() // captured outside the measurement

    const instrumented = withCloneInstrumentation(() =>
      prepareCompatibleCharacterUpdate(previous, next as any, rowSnapshot),
    )

    expect(instrumented.maxClonedSize).toBeLessThan(chatsSize)
    expect(instrumented.result.factories).toHaveLength(1)
  })

  it('prepareCompatibleCharacterUpdate builds local projection from the sanitized command patch', () => {
    testDatabaseState.db = {
      characters: [
        {
          chaId: 'char-a',
          name: 'Old name',
          desc: 'Old desc',
          chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
          globalLore: [{ key: 'old lore' }],
          customscript: 'old custom script',
          triggerscript: 'old trigger script',
          modules: ['old-module'],
        },
      ],
      characterOrder: [],
    } as any
    const previous = testDatabaseState.db.characters[0]
    const next = {
      chaId: 'plugin-supplied-id',
      name: 'New name',
      desc: 'New desc',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'changed', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'changed lore' }],
      customscript: 'changed custom script',
      triggerscript: 'changed trigger script',
      modules: ['changed-module'],
    }
    const stateSnapshot = currentCharacterStateSnapshot()

    const prepared = prepareCompatibleCharacterUpdate(previous, next as any, stateSnapshot)

    expect(prepared.characterId).toBe('char-a')
    expect(prepared.patch).toEqual({
      name: 'New name',
      desc: 'New desc',
    })
    expect(prepared.factories).toHaveLength(1)
    expect(prepared.optimisticCharacter).toEqual({
      chaId: 'char-a',
      name: 'New name',
      desc: 'New desc',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
      customscript: 'old custom script',
      triggerscript: 'old trigger script',
      modules: ['old-module'],
    })
  })

  it('prepareCompatibleCharacterUpdate is a no-op when only excluded or deleted fields change', () => {
    const previous = {
      chaId: 'char-a',
      name: 'Old name',
      desc: 'Deleted desc',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
    }
    const next = {
      chaId: 'plugin-supplied-id',
      name: 'Old name',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'changed', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'changed lore' }],
    }
    const stateSnapshot = currentCharacterStateSnapshot()

    const prepared = prepareCompatibleCharacterUpdate(previous as any, next as any, stateSnapshot)

    expect(prepared.characterId).toBe('char-a')
    expect(prepared.patch).toEqual({})
    expect(prepared.optimisticCharacter).toBeUndefined()
    expect(prepared.factories).toHaveLength(0)
  })

  it('prepareCompatibleCharacterUpdateScoped rolls back attempted fields without restoring selection', () => {
    testDatabaseState.db = {
      characters: [
        {
          chaId: 'char-a',
          name: 'Old name',
          desc: 'Old desc',
          chats: [{ id: 'chat-a', message: [] }],
        },
        {
          chaId: 'char-b',
          name: 'Sibling name',
          chats: [{ id: 'chat-b', message: [] }],
        },
      ],
      characterOrder: [],
      currentChar: 0,
    } as any
    selectedCharID.set(0)

    const previousCharacter = testDatabaseState.db.characters[0]
    const previous = currentCharacterRowSnapshot(0)
    const nextCharacter = {
      ...previousCharacter,
      name: 'Attempted name',
      desc: 'Attempted desc',
    }

    const prepared = prepareCompatibleCharacterUpdateScoped(previousCharacter, nextCharacter as any, previous)
    expect(prepared.optimisticCharacter).toBeDefined()
    testDatabaseState.db.characters[0] = prepared.optimisticCharacter as any

    testDatabaseState.db.characters[1].name = 'Newer sibling name'
    charactersResourceState.currentChar = 1
    selectedCharID.set(1)

    prepared.rollback()

    expect(testDatabaseState.db.characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'Old name',
      desc: 'Old desc',
    })
    expect(testDatabaseState.db.characters[1].name).toBe('Newer sibling name')
    expect(charactersResourceState.currentChar).toBe(1)
    expect(get(selectedCharID)).toBe(1)
  })

  it('rolls back a compatible projection when durable staging throws synchronously', async () => {
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'Original', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const previousCharacter = testDatabaseState.db.characters[0]
    const prepared = prepareCompatibleCharacterUpdateScoped(
      previousCharacter,
      { ...previousCharacter, name: 'Oversized projection' } as any,
      currentCharacterRowSnapshot(0),
    )
    testDatabaseState.db.characters[0] = prepared.optimisticCharacter as any
    const stage = vi.spyOn(pendingMutationOutboxModule, 'stagePendingMutation').mockImplementationOnce(() => {
      throw new RangeError('Pending mutation payload is too large')
    })

    try {
      await expect(prepared.dispatchAsync()).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', reason: 'invalid-request' },
      })
      expect(testDatabaseState.db.characters[0].name).toBe('Original')
    } finally {
      stage.mockRestore()
    }
  })

  it('reports a durably retained compatible character projection as queued', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-compatible-character-retained',
      writerEpoch: 1,
      databaseLineage: 'lineage-compatible-character-retained',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'Original', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/api/v1/commands/characters/char-a') {
          return jsonResponse({ error: 'temporarily unavailable' }, 500)
        }
        return jsonResponse({ error: `unexpected ${String(input)}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const previousCharacter = testDatabaseState.db.characters[0]
      const prepared = prepareCompatibleCharacterUpdateScoped(
        previousCharacter,
        { ...previousCharacter, name: 'Queued name' } as any,
        currentCharacterRowSnapshot(0),
      )
      testDatabaseState.db.characters[0] = prepared.optimisticCharacter as any

      await expect(prepared.dispatchAsync()).resolves.toMatchObject({
        status: 'queued',
        result: { status: 'error', error: 'temporarily unavailable' },
      })
      expect(testDatabaseState.db.characters[0].name).toBe('Queued name')
      expect(await listPendingMutations()).toHaveLength(1)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rebases rapid nested-array replacements when both queued patches fail terminally', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-compatible-character-chain',
      writerEpoch: 1,
      databaseLineage: 'lineage-compatible-character-chain',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    testDatabaseState.db = {
      characters: [
        {
          chaId: 'char-a',
          name: 'Character',
          chats: [],
          sdData: { nested: { values: ['original', 1] } },
        },
      ],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const firstResponse = deferredResponse()
    const patches: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/characters/char-a') {
          patches.push(typeof init.body === 'string' ? JSON.parse(init.body) : {})
          if (patches.length === 1) return firstResponse.promise
          return jsonResponse({ error: 'second replacement rejected' }, 400)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const firstPreviousCharacter = testDatabaseState.db.characters[0]
      const first = prepareCompatibleCharacterUpdateScoped(
        firstPreviousCharacter,
        { ...firstPreviousCharacter, sdData: { nested: { values: ['intermediate', 2] } } } as any,
        currentCharacterRowSnapshot(0),
      )
      testDatabaseState.db.characters[0] = first.optimisticCharacter as any
      const firstDispatch = first.dispatchAsync()

      const secondPreviousCharacter = testDatabaseState.db.characters[0]
      const second = prepareCompatibleCharacterUpdateScoped(
        secondPreviousCharacter,
        { ...secondPreviousCharacter, sdData: { nested: { values: ['original', 1] } } } as any,
        currentCharacterRowSnapshot(0),
      )
      testDatabaseState.db.characters[0] = second.optimisticCharacter as any
      const secondDispatch = second.dispatchAsync()

      await vi.waitFor(() => expect(patches).toHaveLength(1))
      firstResponse.resolve(jsonResponse({ error: 'first replacement rejected' }, 400))
      await expect(firstDispatch).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', reason: 'invalid-request' },
      })
      await expect(secondDispatch).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', reason: 'invalid-request' },
      })

      expect(testDatabaseState.db.characters[0].sdData).toEqual({ nested: { values: ['original', 1] } })
      expect(patches.map((body) => body.patch)).toEqual([
        { sdData: { nested: { values: ['intermediate', 2] } } },
        { sdData: { nested: { values: ['original', 1] } } },
      ])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('compatible character updates do not target a replacement chaId when the previous row has no id', async () => {
    const calls = stubCommandFetch()
    const previousCharacter = {
      name: 'Missing id',
      chats: [],
    }
    const nextCharacter = {
      chaId: 'replacement-id',
      name: 'Replacement name',
      chats: [],
    }
    const stateSnapshot = currentCharacterStateSnapshot()

    const prepared = prepareCompatibleCharacterUpdate(previousCharacter as any, nextCharacter as any, stateSnapshot)

    expect(prepared.characterId).toBeUndefined()
    expect(prepared.patch).toEqual({})
    expect(prepared.optimisticCharacter).toBeUndefined()
    expect(prepared.factories).toHaveLength(0)

    dispatchCompatibleCharacterUpdate(previousCharacter as any, nextCharacter as any, stateSnapshot)
    await flushAsyncWork()

    expect(calls).toHaveLength(0)
  })
})

describe('removeChar trashTime field rollback', () => {
  it('retains a transient soft-delete projection and replays its exact timestamp once', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-character-trash',
      writerEpoch: 1,
      databaseLineage: 'lineage-character-trash',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    let recover = false
    const patches: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/characters/char-a') {
          patches.push(typeof init.body === 'string' ? JSON.parse(init.body) : {})
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character', id: 'char-a' },
            characterId: 'char-a',
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    charactersResourceState.characterOrder = ['char-a']
    charactersResourceState.currentChar = 0
    selectedCharID.set(0)

    try {
      const outcome = await withMockedNow(654321, () => removeChar(0, 'Character', 'normal'))
      await vi.waitFor(() => expect(patches).toHaveLength(1))

      expect(outcome).toMatchObject({ status: 'queued' })
      expect(testDatabaseState.db.characters[0].trashTime).toBe(654321)
      expect(charactersResourceState.characterOrder).toEqual([])
      expect((await listPendingMutations()).map((entry) => entry.intent.requests[0].body)).toEqual([
        { patch: { trashTime: 654321 } },
      ])

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      expect(patches).toHaveLength(2)
      expect(patches.map((body) => body.patch)).toEqual([{ trashTime: 654321 }, { trashTime: 654321 }])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('ignores repeated removal attempts while the same character confirmation is pending', async () => {
    const calls = stubCommandFetch()
    testDatabaseState.db = {
      characters: [{ chaId: 'char-a', name: 'Character', chats: [] }],
      characterOrder: ['char-a'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)
    const confirmation = deferredBoolean()
    alertConfirmState.responses = [confirmation.promise, true]

    const firstRemoval = removeChar(0, 'Character', 'normal')
    await vi.waitFor(() => expect(alertConfirmState.messages).toHaveLength(1))
    const repeatedRemoval = removeChar(0, 'Character', 'normal')

    await repeatedRemoval
    expect(alertConfirmState.messages).toHaveLength(1)

    confirmation.resolve(true)
    await firstRemoval
    await waitForCharacterPatch(calls, 'char-a')

    expect(alertConfirmState.messages).toHaveLength(2)
    expect(calls.filter((call) => call.url === '/api/v1/commands/characters/char-a')).toHaveLength(1)
  })

  it('trashes the original character when a preceding row is removed during confirmation', async () => {
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-b') {
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character' },
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const confirmation = deferredBoolean()
    alertConfirmState.responses = [confirmation.promise, true]

    const removal = withMockedNow(444444, () => removeChar(1, 'B', 'normal'))
    await vi.waitFor(() => expect(alertConfirmState.messages).toHaveLength(1))
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters.splice(0, 1)
      charactersResourceState.characterOrder = ['char-b', 'char-c']
      charactersResourceState.currentChar = 0
      selectedCharID.set(0)
    })
    confirmation.resolve(true)
    await removal

    expect(testDatabaseState.db.characters.find((character) => character.chaId === 'char-b')?.trashTime).toBe(444444)
    expect(testDatabaseState.db.characters.find((character) => character.chaId === 'char-c')?.trashTime).toBeUndefined()
    await waitForCharacterPatch(calls, 'char-b')
  })

  it('permanently deletes the original character when rows are reordered during confirmation', async () => {
    const calls = stubCharacterCollectionCommandFetch()
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b', 'char-c'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)
    const confirmation = deferredBoolean()
    alertConfirmState.responses = [true, confirmation.promise]

    const removal = removeChar(1, 'B', 'permanent')
    await vi.waitFor(() => expect(alertConfirmState.messages).toHaveLength(2))
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters = [
        testDatabaseState.db.characters[2],
        testDatabaseState.db.characters[0],
        testDatabaseState.db.characters[1],
      ]
      charactersResourceState.characterOrder = ['char-c', 'char-a', 'char-b']
      charactersResourceState.currentChar = 2
      selectedCharID.set(2)
    })
    confirmation.resolve(true)
    await removal

    expect(testDatabaseState.db.characters.map((character) => character.chaId)).toEqual(['char-c', 'char-a'])
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/characters/char-b' && call.method === 'DELETE')).toBe(
        true,
      )
    })
  })

  it('trashTime snapshots are scalar and restore only the target field plus order placement', () => {
    testDatabaseState.db = seedCloneCostDb() as any
    selectedCharID.set(1)

    const snapshot = currentCharacterTrashTimeSnapshot(1)

    expect(snapshot).toEqual({
      characterId: 'char-1',
      index: 1,
      hadTrashTime: false,
      trashTime: undefined,
      orderPlacement: {
        characterId: 'char-1',
        rootIndex: 1,
      },
      currentChar: 0,
      selectedCharID: 1,
    })
    assertSnapshotIsScalar(snapshot)

    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const instrumented = withCloneInstrumentation(() => currentCharacterTrashTimeSnapshot(1))
    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)

    testDatabaseState.db.characters[1].trashTime = 123
    testDatabaseState.db.characters[1].name = 'Same row concurrent edit'
    testDatabaseState.db.characters[0].name = 'Sibling concurrent edit'
    charactersResourceState.characterOrder = ['char-0', 'char-2']

    restoreCharacterTrashTime(snapshot)

    expect(Object.prototype.hasOwnProperty.call(testDatabaseState.db.characters[1], 'trashTime')).toBe(false)
    expect(testDatabaseState.db.characters[1].name).toBe('Same row concurrent edit')
    expect(testDatabaseState.db.characters[0].name).toBe('Sibling concurrent edit')
    expect(charactersResourceState.characterOrder).toEqual(['char-0', 'char-1', 'char-2'])
  })

  it('removeChar normal trash captures no whole-characters clone and reuses one timestamp', async () => {
    testDatabaseState.db = seedCloneCostDb({
      hydratedMessageCount: 80,
      messageBodySize: 500,
    }) as any
    charactersResourceState.characterOrder = ['char-0', 'char-1', 'char-2']
    selectedCharID.set(1)
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-1') {
          return jsonResponse({
            revision: 11,
            event: { type: 'character.updated', revision: 11, resource: 'character' },
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const charactersSize = JSON.stringify(testDatabaseState.db.characters).length

    const instrumented = await withMockedNow(987654, () =>
      withAsyncCloneInstrumentation(() => removeChar(1, 'Character 1', 'normal')),
    )

    expect(instrumented.maxClonedSize).toBeLessThan(charactersSize)
    expect(testDatabaseState.db.characters[1].trashTime).toBe(987654)
    expect(get(selectedCharID)).toBe(-1)
    expect(alertConfirmState.messages).toHaveLength(2)
    expect(alertConfirmState.messages[0]).toContain('Character 1')
    expect(alertConfirmState.messages[1]).toContain('Character 1')

    await waitForCallCount(calls, 2)
    expect(calls.find((call) => call.url === '/api/v1/commands/characters/char-1')).toEqual({
      url: '/api/v1/commands/characters/char-1',
      method: 'PATCH',
      authHeader: 'character-command-token',
      body: {
        baseRevision: 10,
        patch: { trashTime: 987654 },
      },
    })
  })

  it('failed removeChar trash update restores only trashTime', async () => {
    const calls: CapturedFetch[] = []
    const patchResponse = deferredResponse()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-a') return patchResponse.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'Character', chats: [] },
        { chaId: 'char-b', name: 'Sibling', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    } as any
    selectedCharID.set(0)

    const removal = withMockedNow(222222, () => removeChar(0, 'Character', 'normal'))
    await waitForCharacterPatch(calls, 'char-a')
    expect(testDatabaseState.db.characters[0].trashTime).toBe(222222)
    expect(charactersResourceState.characterOrder).toEqual(['char-b'])
    expect(get(selectedCharID)).toBe(-1)

    await expect(removeChar(0, 'Character', 'normal')).resolves.toBeNull()
    expect(alertConfirmState.messages).toHaveLength(2)
    expect(calls.filter((call) => call.url === '/api/v1/commands/characters/char-a')).toHaveLength(1)

    testDatabaseState.db.characters[0].name = 'Same row concurrent edit'
    testDatabaseState.db.characters[1].name = 'Sibling concurrent edit'
    patchResponse.resolve(jsonResponse({ error: 'nope' }, 500))

    await expect(removal).resolves.toMatchObject({ status: 'failed' })

    await vi.waitFor(() => {
      expect(Object.prototype.hasOwnProperty.call(testDatabaseState.db.characters[0], 'trashTime')).toBe(false)
    })
    expect(testDatabaseState.db.characters[0].name).toBe('Same row concurrent edit')
    expect(testDatabaseState.db.characters[1].name).toBe('Sibling concurrent edit')
    expect(charactersResourceState.characterOrder).toEqual(['char-a', 'char-b'])
    expect(get(selectedCharID)).toBe(0)
  })

  it('trash rollback restores by stable id after index shifts', async () => {
    const calls: CapturedFetch[] = []
    const patchResponse = deferredResponse()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const headers = init.headers as Record<string, string> | undefined
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          authHeader: headers?.['risu-auth'] ?? null,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })

        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url === '/api/v1/commands/characters/char-b') return patchResponse.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    testDatabaseState.db = {
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [], trashTime: 111111 },
        { chaId: 'char-c', name: 'C', chats: [] },
      ],
      characterOrder: ['char-a', 'char-c'],
      currentChar: 1,
    } as any
    selectedCharID.set(1)

    const removal = withMockedNow(333333, () => removeChar(1, 'B', 'normal'))
    await waitForCharacterPatch(calls, 'char-b')
    expect(testDatabaseState.db.characters[1].trashTime).toBe(333333)

    testDatabaseState.db.characters.unshift({ chaId: 'char-new', name: 'Inserted', chats: [] } as any)
    testDatabaseState.db.characters[1].name = 'Stale index sibling edit'
    patchResponse.resolve(jsonResponse({ error: 'nope' }, 500))

    await expect(removal).resolves.toMatchObject({ status: 'failed' })

    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters.find((c: any) => c.chaId === 'char-b')?.trashTime).toBe(111111)
    })
    expect(testDatabaseState.db.characters[1].chaId).toBe('char-a')
    expect(testDatabaseState.db.characters[1].name).toBe('Stale index sibling edit')
    expect(testDatabaseState.db.characters[0].chaId).toBe('char-new')
  })
})
