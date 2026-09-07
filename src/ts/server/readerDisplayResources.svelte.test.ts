import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginClientSession,
  settleClientReader,
  resetClientSessionForTests,
  requireClientAuthentication,
} from '../clientSession'
import {
  ensureReaderDisplayResources,
  readerDisplayResourcesReady,
  resetReaderDisplayResourcesForTests,
  READER_DISPLAY_RESOURCE_MAX_ATTEMPTS,
} from './readerDisplayResources'
import * as reads from './resourceReads'
import { refreshInvalidatedServerResources } from './resourceInvalidation'
import { resetServerResourceState, settingsResourceState, collectionsResourceState } from './resourceState.svelte'
import {
  peekAppliedServerResourceRevision,
  peekCachedServerCommandRevision,
  setAppliedServerResourceRevision,
  setCachedServerCommandRevision,
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
} from './commands'

function reader(id = 'reader') {
  const operation = beginClientSession(id)
  settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function displayPayload() {
  return {
    status: 'ok' as const,
    revision: 7,
    group: 'display' as const,
    settings: { useChatCopy: true, chatLoadInitialPages: 15 },
  }
}

beforeEach(() => {
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  resetServerResourceState()
  clearAppliedServerResourceRevision()
  clearCachedServerCommandRevision()
  reader()
  vi.spyOn(reads, 'fetchServerSettingsGroup').mockImplementation(async (group) => ({
    status: 'ok',
    revision: 7,
    group,
    settings: group === 'display' ? displayPayload().settings : {},
  }))
  vi.spyOn(reads, 'fetchServerCollection').mockImplementation(async (name) => ({
    status: 'ok',
    revision: 7,
    collections: { [name]: [] },
  }))
  vi.spyOn(reads, 'fetchServerStandaloneSetting').mockImplementation(async (setting) => ({
    status: 'ok',
    revision: 7,
    setting,
    state: { present: false },
  }))
})

afterEach(() => {
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  resetServerResourceState()
  vi.restoreAllMocks()
})

describe('reader display resources', () => {
  it('loads only missing manifest render requirements without advancing event cursors', async () => {
    settingsResourceState.groupStatuses.advanced = 'ready'
    collectionsResourceState.statuses.personas = 'ready'
    settingsResourceState.standaloneStatuses.userIcon = 'ready'
    setAppliedServerResourceRevision(3)
    setCachedServerCommandRevision(3)
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'ok' })
    expect(readerDisplayResourcesReady()).toBe(true)
    expect(vi.mocked(reads.fetchServerSettingsGroup).mock.calls.map(([group]) => group)).toEqual([
      'display',
      'media',
      'modules',
      'agents',
      'language',
      'prompt',
    ])
    expect(vi.mocked(reads.fetchServerCollection).mock.calls.map(([name]) => name)).toEqual([
      'modules',
      'promptPresets',
    ])
    expect(vi.mocked(reads.fetchServerStandaloneSetting).mock.calls.map(([name]) => name)).toEqual([
      'selectedPersonaId',
      'selectedPersona',
      'personaPrompt',
      'userNote',
    ])
    expect(settingsResourceState.value.useChatCopy).toBe(true)
    expect(peekAppliedServerResourceRevision()).toBe(3)
    expect(peekCachedServerCommandRevision()).toBe(3)
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'ok' })
    expect(reads.fetchServerSettingsGroup).toHaveBeenCalledTimes(6)
  })

  it('shares a generation-scoped load while allowing one transcript to detach', async () => {
    const pending = deferred<ReturnType<typeof displayPayload>>()
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementation(async (group) =>
      group === 'display' ? pending.promise : { status: 'ok', revision: 7, group, settings: {} },
    )
    const firstController = new AbortController()
    const first = ensureReaderDisplayResources({ signal: firstController.signal })
    const second = ensureReaderDisplayResources()
    firstController.abort()
    expect(await first).toEqual({ status: 'unavailable' })
    const displayRequest = vi.mocked(reads.fetchServerSettingsGroup).mock.calls.find(([group]) => group === 'display')!
    expect(displayRequest[1]?.aborted).toBe(false)
    pending.resolve(displayPayload())
    expect(await second).toEqual({ status: 'ok' })
    expect(reads.fetchServerSettingsGroup).toHaveBeenCalledTimes(7)
  })

  it('aborts the last detached consumer and does not apply its late resources', async () => {
    const pending = deferred<ReturnType<typeof displayPayload>>()
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementation(async (group) =>
      group === 'display' ? pending.promise : { status: 'ok', revision: 7, group, settings: {} },
    )
    const controller = new AbortController()
    const loaded = ensureReaderDisplayResources({ signal: controller.signal })
    controller.abort()
    expect(await loaded).toEqual({ status: 'unavailable' })
    expect(vi.mocked(reads.fetchServerSettingsGroup).mock.calls[0][1]?.aborted).toBe(true)
    pending.resolve(displayPayload())
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsResourceState.value.useChatCopy).toBeUndefined()
  })

  it('does not join or apply a request from an obsolete reader generation', async () => {
    const pending = deferred<ReturnType<typeof displayPayload>>()
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementationOnce(() => pending.promise)
    const obsolete = ensureReaderDisplayResources()
    reader('new-reader')
    expect(await obsolete).toEqual({ status: 'unavailable' })
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'ok' })
    pending.resolve({ ...displayPayload(), settings: { useChatCopy: false, chatLoadInitialPages: 90 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsResourceState.value.useChatCopy).toBe(true)
    expect(settingsResourceState.value.chatLoadInitialPages).toBe(15)
  })

  it('retries a failed requirement without refetching already resident resources', async () => {
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'ok' })
    settingsResourceState.groupStatuses.display = 'idle'
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementationOnce(async () => ({
      status: 'error',
      error: 'temporary read failure',
    }))
    expect(await ensureReaderDisplayResources()).toMatchObject({ status: 'error' })
    expect(settingsResourceState.groupStatuses.display).toBe('error')
    expect(settingsResourceState.groupStatuses.media).toBe('ready')
    vi.mocked(reads.fetchServerSettingsGroup).mockClear()
    vi.mocked(reads.fetchServerCollection).mockClear()
    vi.mocked(reads.fetchServerStandaloneSetting).mockClear()
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'ok' })
    expect(reads.fetchServerSettingsGroup).toHaveBeenCalledOnce()
    expect(reads.fetchServerSettingsGroup).toHaveBeenCalledWith('display', expect.any(AbortSignal))
    expect(reads.fetchServerCollection).not.toHaveBeenCalled()
    expect(reads.fetchServerStandaloneSetting).not.toHaveBeenCalled()
  })

  it('does not apply authenticated resources after auth loss', async () => {
    const pending = deferred<ReturnType<typeof displayPayload>>()
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementationOnce(() => pending.promise)
    const loaded = ensureReaderDisplayResources()
    requireClientAuthentication()
    expect(await loaded).toEqual({ status: 'unavailable' })
    pending.resolve(displayPayload())
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsResourceState.value.useChatCopy).toBeUndefined()
    expect(await ensureReaderDisplayResources()).toEqual({ status: 'unavailable' })
  })
  it('rejects dependency snapshots older than the already applied event cursor', async () => {
    setAppliedServerResourceRevision(8)
    expect(await ensureReaderDisplayResources()).toMatchObject({ status: 'error' })
    expect(settingsResourceState.value.useChatCopy).toBeUndefined()
    expect(peekAppliedServerResourceRevision()).toBe(8)
  })

  it('keeps a committed display update when it arrives while initial dependencies are loading', async () => {
    setAppliedServerResourceRevision(3)
    setCachedServerCommandRevision(3)
    const pending = deferred<ReturnType<typeof displayPayload>>()
    let firstDisplay = true
    let serverRevision = 3
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementation(async (group) => {
      if (group === 'display' && firstDisplay) {
        firstDisplay = false
        return pending.promise
      }
      return {
        status: 'ok',
        revision: serverRevision,
        group,
        settings: group === 'display' ? { useChatCopy: false } : {},
      }
    })
    vi.mocked(reads.fetchServerCollection).mockImplementation(async (name) => ({
      status: 'ok',
      revision: serverRevision,
      collections: { [name]: [] },
    }))
    vi.mocked(reads.fetchServerStandaloneSetting).mockImplementation(async (setting) => ({
      status: 'ok',
      revision: serverRevision,
      setting,
      state: { present: false },
    }))
    const loaded = ensureReaderDisplayResources()
    expect(settingsResourceState.groupStatuses.display).toBe('loading')
    serverRevision = 4
    const event = await refreshInvalidatedServerResources(
      { type: 'settings.updated', resource: 'settings', id: 'display', revision: 4 },
      { mode: 'reader', appliedRevision: 3 },
    )
    expect(event).toMatchObject({ status: 'ok', scope: 'targeted' })
    setAppliedServerResourceRevision(4)
    expect(settingsResourceState.value.useChatCopy).toBe(false)
    pending.resolve({ ...displayPayload(), revision: 3 })
    expect(await loaded).toEqual({ status: 'ok' })
    expect(settingsResourceState.value.useChatCopy).toBe(false)
    expect(settingsResourceState.groupRevisions.display).toBe(4)
    expect(readerDisplayResourcesReady()).toBe(true)
    expect(peekAppliedServerResourceRevision()).toBe(4)
    expect(peekCachedServerCommandRevision()).toBe(3)
  })

  it('bounds retries when commits keep advancing during dependency reads', async () => {
    setAppliedServerResourceRevision(1)
    vi.mocked(reads.fetchServerSettingsGroup).mockImplementation(async (group) => {
      if (group === 'display') setAppliedServerResourceRevision(peekAppliedServerResourceRevision()! + 1)
      return { status: 'ok', revision: 100, group, settings: {} }
    })
    expect(await ensureReaderDisplayResources()).toMatchObject({ status: 'error' })
    expect(vi.mocked(reads.fetchServerSettingsGroup).mock.calls.filter(([group]) => group === 'display')).toHaveLength(
      READER_DISPLAY_RESOURCE_MAX_ATTEMPTS,
    )
    expect(settingsResourceState.groupStatuses.display).toBe('error')
    expect(settingsResourceState.value.useChatCopy).toBeUndefined()
  })
})
