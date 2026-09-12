import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginClientSession, settleClientReader, resetClientSessionForTests } from '../clientSession'
import { hydrateActiveChat, hydrateActiveCharacterLorebook } from './chatMessageHydration.svelte'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { charactersResourceState } from './resourceState.svelte'

const projectionState = vi.hoisted(() => ({
  fetchResource: vi.fn(),
  canUse: true,
}))

vi.mock('./resourceReads', () => ({
  fetchServerCharacter: projectionState.fetchResource,
}))

vi.mock('./chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: vi.fn(),
  hydrateActiveChat: vi.fn(),
  hydrateActiveCharacterLorebook: vi.fn(),
  resetChatHydration: vi.fn(),
}))

import { selectedCharID } from '../stores.svelte'
import {
  isServerCharacterShell,
  mergeServerResourceCharacterRow,
  mergeServerResourceFields,
} from '../storage/database.svelte'
import {
  clearCachedServerCommandRevision,
  peekCachedServerCommandRevision,
  setCachedServerCommandRevision,
} from './commands'
import {
  characterShellHydrationState,
  hydrateCharacterShell,
  hydrateSelectedCharacterShell,
  resetCharacterShellHydrationStateForTests,
  retryCharacterShellHydration,
  startSelectedCharacterShellHydration,
} from './characterShellHydration.svelte'
import { withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function characterShell() {
  return {
    __serverCharacterShell: true,
    chaId: 'char-1',
    name: 'Shell',
    chats: [{ id: 'chat-1', name: 'Chat', message: [] }],
    chatPage: 0,
    chatFolders: [],
  }
}

function hydratedCharacter(name = 'Hydrated') {
  return {
    chaId: 'char-1',
    name,
    desc: '',
    firstMessage: 'Hello',
    chats: [{ id: 'chat-1', name: 'Chat', message: [] }],
    chatPage: 0,
    chatFolders: [],
    customscript: [],
    triggerscript: [],
    globalLore: [],
  }
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.mocked(hydrateActiveChat).mockClear()
  vi.mocked(hydrateActiveCharacterLorebook).mockClear()
  clearCachedServerCommandRevision()
  resetCharacterShellHydrationStateForTests()
  selectedCharID.set(0)
  testDatabaseState.db = {
    characters: [characterShell()],
    characterOrder: ['char-1'],
    currentChar: 0,
  } as any
  projectionState.canUse = true
  projectionState.fetchResource.mockReset()
})

afterEach(() => {
  resetCharacterShellHydrationStateForTests()
  resetClientSessionForTests()
  const database = JSON.parse(JSON.stringify(testDatabaseState.db))
  testDatabaseState.db = database
})

describe('character shell hydration', () => {
  it('fetches a character row and replaces a selected bootstrap shell', async () => {
    setCachedServerCommandRevision(5)
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter(),
    })

    await expect(hydrateCharacterShell('char-1')).resolves.toBe(true)

    expect(projectionState.fetchResource).toHaveBeenCalledWith('char-1', expect.any(AbortSignal))
    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
    expect(testDatabaseState.db.characters[0].name).toBe('Hydrated')
    expect(peekCachedServerCommandRevision()).toBe(5)
  })

  it('hydrates an explicit reader character without starting canonical chat or lorebook reads', async () => {
    const session = beginClientSession('reader')
    settleClientReader(session, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter(),
    })
    await expect(hydrateCharacterShell('char-1')).resolves.toBe(true)
    expect(testDatabaseState.db.characters[0].name).toBe('Hydrated')
    expect(charactersResourceState.currentChar).toBe(0)
    expect(testDatabaseState.db.characters[0].chatPage).toBe(0)
    expect(hydrateActiveChat).not.toHaveBeenCalled()
    expect(hydrateActiveCharacterLorebook).not.toHaveBeenCalled()
  })

  it('accepts a character row response after an unrelated projection advances the known revision', async () => {
    setCachedServerCommandRevision(5)
    const response = deferred<{
      status: 'ok'
      revision: number
      mode: 'character-row'
      characterId: string
      character: Record<string, unknown>
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = hydrateCharacterShell('char-1')
    setCachedServerCommandRevision(6)
    mergeServerResourceFields({ language: 'ko' } as any)
    response.resolve({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter('Hydrated after settings'),
    })

    await expect(pending).resolves.toBe(true)

    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
    expect(testDatabaseState.db.characters[0].name).toBe('Hydrated after settings')
    expect(testDatabaseState.db.language).toBe('ko')
    expect(peekCachedServerCommandRevision()).toBe(6)
  })

  it('accepts detail after scoped transcript hydration mutates the same shell', async () => {
    setCachedServerCommandRevision(5)
    const response = deferred<{
      status: 'ok'
      revision: number
      mode: 'character-row'
      characterId: string
      character: Record<string, unknown>
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = hydrateCharacterShell('char-1')
    withTestDatabaseWrite(() => {
      const shell = testDatabaseState.db.characters[0]
      shell.chats[0].message = [{ role: 'user', data: 'Hydrated transcript' }] as any
    })
    response.resolve({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter('Hydrated after transcript'),
    })

    await expect(pending).resolves.toBe(true)

    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
    expect(testDatabaseState.db.characters[0].name).toBe('Hydrated after transcript')
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([{ role: 'user', data: 'Hydrated transcript' }])
  })

  it('rejects a response after the target character row changes during hydration', async () => {
    setCachedServerCommandRevision(5)
    const response = deferred<{
      status: 'ok'
      revision: number
      mode: 'character-row'
      characterId: string
      character: Record<string, unknown>
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = hydrateCharacterShell('char-1')
    setCachedServerCommandRevision(6)
    mergeServerResourceCharacterRow(hydratedCharacter('Newer projection'))
    response.resolve({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter('Stale hydration'),
    })

    await expect(pending).resolves.toBe(false)

    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
    expect(testDatabaseState.db.characters[0].name).toBe('Newer projection')
  })

  it('does not apply detail after the target shell is deleted', async () => {
    const response = deferred<{
      status: 'ok'
      revision: number
      character: Record<string, unknown>
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = hydrateCharacterShell('char-1')
    testDatabaseState.db.characters.splice(0, 1)
    response.resolve({ status: 'ok', revision: 2, character: hydratedCharacter('Deleted target') })

    await expect(pending).resolves.toBe(false)
    expect(testDatabaseState.db.characters).toEqual([])
  })

  it('rejects selected detail after the selection owner changes', async () => {
    const secondShell = { ...characterShell(), chaId: 'char-2', name: 'Second shell' }
    testDatabaseState.db = {
      characters: [characterShell(), secondShell],
      characterOrder: ['char-1', 'char-2'],
      currentChar: 0,
    } as any
    const response = deferred<{ status: 'ok'; revision: number; character: Record<string, unknown> }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const pending = hydrateSelectedCharacterShell()
    selectedCharID.set(1)
    response.resolve({ status: 'ok', revision: 2, character: hydratedCharacter('Stale selected detail') })

    await expect(pending).resolves.toBe(false)
    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(true)
    expect(testDatabaseState.db.characters[0].name).toBe('Shell')
  })

  it('supersedes an older request when a refreshed shell becomes authoritative', async () => {
    const first = deferred<{ status: 'ok'; revision: number; character: Record<string, unknown> }>()
    const second = deferred<{ status: 'ok'; revision: number; character: Record<string, unknown> }>()
    projectionState.fetchResource.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const older = hydrateCharacterShell('char-1')
    testDatabaseState.db.characters[0] = { ...characterShell(), name: 'Refreshed shell' } as any
    const newer = hydrateCharacterShell('char-1', { supersede: true })
    const olderSignal = projectionState.fetchResource.mock.calls[0]?.[1] as AbortSignal
    expect(olderSignal.aborted).toBe(true)

    first.resolve({ status: 'ok', revision: 2, character: hydratedCharacter('Stale detail') })
    second.resolve({ status: 'ok', revision: 3, character: hydratedCharacter('Fresh detail') })

    await expect(older).resolves.toBe(false)
    await expect(newer).resolves.toBe(true)
    expect(testDatabaseState.db.characters[0].name).toBe('Fresh detail')
  })

  it('rejects a character row response older than the request-start revision', async () => {
    setCachedServerCommandRevision(6)
    projectionState.fetchResource.mockResolvedValue({
      status: 'ok',
      revision: 5,
      mode: 'character-row',
      characterId: 'char-1',
      character: hydratedCharacter('Older than request'),
    })

    await expect(hydrateCharacterShell('char-1')).resolves.toBe(false)

    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(true)
    expect(testDatabaseState.db.characters[0].name).toBe('Shell')
  })

  it('deduplicates concurrent detail requests for the same shell', async () => {
    const response = deferred<{
      status: 'ok'
      revision: number
      character: Record<string, unknown>
    }>()
    projectionState.fetchResource.mockReturnValue(response.promise)

    const first = hydrateCharacterShell('char-1')
    const second = hydrateCharacterShell('char-1')
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
    response.resolve({ status: 'ok', revision: 1, character: hydratedCharacter() })

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('aborts selected-shell work when selection changes', async () => {
    projectionState.fetchResource.mockImplementation(
      async (_characterId: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true })
        }),
    )

    startSelectedCharacterShellHydration()
    const signal = projectionState.fetchResource.mock.calls[0]?.[1] as AbortSignal
    expect(signal.aborted).toBe(false)
    selectedCharID.set(-1)

    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(true)
  })

  it('keeps route hydration alive when the selected-character subscriber changes selection', async () => {
    const response = deferred<{ status: 'ok'; revision: number; character: Record<string, unknown> }>()
    projectionState.fetchResource.mockReturnValue(response.promise)
    const route = hydrateCharacterShell('char-1')
    startSelectedCharacterShellHydration()
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
    const signal = projectionState.fetchResource.mock.calls[0][1] as AbortSignal
    selectedCharID.set(-1)
    expect(signal.aborted).toBe(false)
    response.resolve({ status: 'ok', revision: 1, character: hydratedCharacter() })
    await expect(route).resolves.toBe(true)
    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(false)
  })

  it('cancels a route subscriber without cancelling selected-character hydration', async () => {
    const response = deferred<{ status: 'ok'; revision: number; character: Record<string, unknown> }>()
    projectionState.fetchResource.mockReturnValue(response.promise)
    const routeController = new AbortController()
    const route = hydrateCharacterShell('char-1', { signal: routeController.signal })
    const selected = hydrateSelectedCharacterShell()
    routeController.abort()
    await expect(route).resolves.toBe(false)
    expect((projectionState.fetchResource.mock.calls[0][1] as AbortSignal).aborted).toBe(false)
    response.resolve({ status: 'ok', revision: 1, character: hydratedCharacter() })
    await expect(selected).resolves.toBe(true)
    expect(projectionState.fetchResource).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)(
    'settles a timeout before an abort-insensitive read and ignores its late %s after retry',
    async (outcome) => {
      vi.useFakeTimers()
      const oldRead = deferred<unknown>()
      projectionState.fetchResource.mockReturnValueOnce(oldRead.promise)
      let settled = false
      const pending = hydrateCharacterShell('char-1', { timeoutMs: 25 }).then((value) => {
        settled = true
        return value
      })
      try {
        await vi.advanceTimersByTimeAsync(25)
        expect(settled).toBe(true)
        await expect(pending).resolves.toBe(false)
        expect(characterShellHydrationState.rows['char-1']).toEqual({ status: 'error', error: 'timeout' })
        projectionState.fetchResource.mockResolvedValueOnce({
          status: 'ok',
          revision: 1,
          character: hydratedCharacter('Replacement'),
        })
        await expect(retryCharacterShellHydration('char-1')).resolves.toBe(true)
        oldRead.resolve(
          outcome === 'success'
            ? { status: 'ok', revision: 1, character: hydratedCharacter('Old') }
            : { status: 'error', error: 'Late old read failure' },
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(testDatabaseState.db.characters[0].name).toBe('Replacement')
        expect(characterShellHydrationState.rows['char-1']).toEqual({ status: 'ready', error: null })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        oldRead.resolve({ status: 'unavailable' })
        await pending
        vi.useRealTimers()
      }
    },
  )

  it('times out a stalled request, retains the shell, and exposes retry state', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    projectionState.fetchResource.mockImplementation(
      async (_characterId: string, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true })
        }),
    )

    const pending = hydrateCharacterShell('char-1', { timeoutMs: 25 })
    await vi.advanceTimersByTimeAsync(25)

    await expect(pending).resolves.toBe(false)
    expect(isServerCharacterShell(testDatabaseState.db.characters[0])).toBe(true)
    expect(characterShellHydrationState.rows['char-1']).toEqual({ status: 'error', error: 'timeout' })
  })

  it('retries a failed shell request and clears its error after detail applies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    projectionState.fetchResource
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'ok', revision: 1, character: hydratedCharacter('Retried') })

    await expect(hydrateCharacterShell('char-1')).resolves.toBe(false)
    expect(characterShellHydrationState.rows['char-1']?.status).toBe('error')
    await expect(retryCharacterShellHydration('char-1')).resolves.toBe(true)

    expect(characterShellHydrationState.rows['char-1']).toEqual({ status: 'ready', error: null })
    expect(testDatabaseState.db.characters[0].name).toBe('Retried')
  })
})
