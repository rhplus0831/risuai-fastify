import { saveAsset, saveAssets } from './globalApi.svelte'
import { resetClientSessionForTests } from './clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from './__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { alertData } from './types/alert'

const dbState = vi.hoisted(() => ({
  db: {
    characters: [] as any[],
    characterOrder: [] as any[],
    goCharacterOnImport: false,
  },
}))

const alertState = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertProgress: vi.fn(),
  alertStoreSet: vi.fn(),
  alertRealmTerms: vi.fn(),
  alertWait: vi.fn(),
}))

const characterState = vi.hoisted(() => ({
  changeChar: vi.fn(),
}))

const characterCommandState = vi.hoisted(() => ({
  applyCharacterCreateOptimistically: vi.fn(),
  dispatchCreateCharacter: vi.fn(),
}))

const globalApiState = vi.hoisted(() => ({
  checkCharOrder: vi.fn(),
}))

const realmImportState = vi.hoisted(() => ({
  importRealmCharacterFromServer: vi.fn(),
}))

const resourceRefreshState = vi.hoisted(() => ({
  refreshServerRealmImportResources: vi.fn(),
}))

const presetImportState = vi.hoisted(() => ({
  importPreset: vi.fn(),
}))

const settingsState = vi.hoisted(() => ({
  settingsMenuIndexSet: vi.fn(),
  settingsOpenSet: vi.fn(),
}))

vi.mock('./alert', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./alert')>()
  return {
    ...actual,
    alertCardExport: vi.fn(),
    alertConfirm: alertState.alertConfirm.mockImplementation(actual.alertConfirm),
    alertError: alertState.alertError,
    alertInput: vi.fn(async () => ''),
    alertNormal: alertState.alertNormal,
    alertProgress: alertState.alertProgress.mockImplementation(actual.alertProgress),
    alertStore: {
      set: alertState.alertStoreSet.mockImplementation(actual.alertStore.set),
    },
    alertRealmTerms: alertState.alertRealmTerms,
    alertWait: alertState.alertWait,
  }
})

vi.mock('./stores/coreStores.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    alertStore: writable<alertData>({ type: 'none', msg: '' }),
    selectedCharID: writable(-1),
  }
})

vi.mock('./storage/database.svelte', () => ({
  appVer: 'test',
  defaultSdDataFunc: vi.fn(() => []),
  importPreset: presetImportState.importPreset,
}))

vi.mock('./util', () => ({
  checkNullish: (data: unknown) => data === undefined || data === null,
  decryptBuffer: vi.fn(),
  isKnownUri: vi.fn(() => false),
  selectFileByDom: vi.fn(),
  sleep: vi.fn(),
}))

vi.mock('./filePicker', () => ({ selectFileByDom: vi.fn() }))

vi.mock('src/lang', () => ({
  language: {
    errors: {
      noData: 'No data',
      wrongPassword: 'Wrong password',
    },
    importedCharacter: 'Imported character',
    characterImportQueued: 'Imported character queued',
    characterImportFailed: 'Imported character failed',
    inputCardPassword: 'Card password',
    lowLevelAccessConfirm: 'Low-level access?',
    successExport: 'Exported',
    successImport: 'Imported',
  },
}))

vi.mock('./characters', () => ({
  changeChar: characterState.changeChar,
  characterFormatUpdate: vi.fn(),
}))

vi.mock('./globalApi.svelte', () => {
  class TestAppendableBuffer {
    append() {}
    deappend() {}
    slice() {
      return new Uint8Array()
    }
    length() {
      return 0
    }
    clear() {}
  }

  class TestWriter {
    async init() {}
    async write() {}
    close() {}
  }

  return {
    AppendableBuffer: TestAppendableBuffer,
    BlankWriter: TestWriter,
    checkCharOrder: globalApiState.checkCharOrder,
    downloadFile: vi.fn(),
    loadAsset: vi.fn(),
    LocalWriter: TestWriter,
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    saveAssets: vi.fn(),
    VirtualWriter: TestWriter,
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: vi.fn(async () => 'test-token'),
}))

vi.mock('./media', () => ({
  compressImage: vi.fn(async (data: Uint8Array) => data),
  getImageType: vi.fn(() => 'PNG'),
}))

vi.mock('./stores.svelte', () => {
  const store = (set = vi.fn()) => ({
    set,
    subscribe: vi.fn(() => () => {}),
  })
  return {
    selectedCharID: store(),
    SettingsMenuIndex: store(settingsState.settingsMenuIndexSet),
    settingsOpen: store(settingsState.settingsOpenSet),
  }
})

vi.mock('./parser/parser.svelte', () => ({
  hasher: vi.fn(async () => 'hash'),
}))

vi.mock('./process/files/inlays', () => ({
  reencodeImage: vi.fn(async (data: Uint8Array) => data),
}))

vi.mock('./process/processzip', () => ({
  CharXImporter: class {},
  CharXWriter: class {},
  DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES: 50 * 1024 * 1024,
  formatCharXEntrySizeLimit: vi.fn((bytes: number) => `${bytes} bytes`),
}))

vi.mock('./process/modules', () => ({
  exportModule: vi.fn(),
  readModule: vi.fn(),
}))

vi.mock('./characterCommands', () => ({
  applyCharacterCreateOptimistically: characterCommandState.applyCharacterCreateOptimistically,
  currentCharacterStateSnapshot: vi.fn(() => ({
    characters: [],
    characterOrder: [],
    selectedCharID: -1,
  })),
  dispatchCreateCharacter: characterCommandState.dispatchCreateCharacter,
}))

vi.mock('./server/resourceState.svelte', () => ({
  charactersResourceState: {
    get characters() {
      return dbState.db.characters
    },
    set characters(characters: any[]) {
      dbState.db.characters = characters
    },
    status: 'ready',
  },
  getCharacterResourceOwner: (characterId: string) => {
    const matches = dbState.db.characters.filter((candidate) => candidate?.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  },
  settingsResourceState: {
    get value() {
      return dbState.db
    },
    groupStatuses: { sidebar: 'ready' },
    status: 'ready',
  },
}))

vi.mock('./moduleCommands', () => ({
  createGlobalModule: vi.fn(),
}))

vi.mock('./server/realmImport', () => ({
  importRealmCharacterFromServer: realmImportState.importRealmCharacterFromServer,
}))

vi.mock('./server/resourceRefresh', () => ({
  refreshServerRealmImportResources: resourceRefreshState.refreshServerRealmImportResources,
}))

import {
  cancelPendingRealmInfoRequest,
  characterURLImport,
  downloadRisuHub,
  getRealmInfo,
  getRisuHub,
  showRealmInfoStore,
} from './characterCards'
import { get } from 'svelte/store'
import { resolveAlertConfirmation } from './alert'
import { alertStore as alertPresentationStore } from './stores/coreStores.svelte'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function okRealmImport(characterId: string, revision = 10) {
  return {
    status: 'ok',
    revision,
    event: {
      type: 'character.created',
      resource: 'character',
      revision,
      id: characterId,
    },
    characterId,
  }
}

function fallbackRealmCard(name: string) {
  return {
    spec: 'chara_card_v3',
    data: {
      name,
      description: 'desc',
      first_mes: 'hello',
      mes_example: '',
      personality: '',
      scenario: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {
        risuai: {},
      },
      assets: [],
    },
  }
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.clearAllMocks()
  alertPresentationStore.set({ type: 'none', msg: '' })
  cancelPendingRealmInfoRequest()
  showRealmInfoStore.set(null)
  dbState.db = {
    characters: [],
    characterOrder: [],
    goCharacterOnImport: false,
  }
  alertState.alertRealmTerms.mockResolvedValue(true)
  characterCommandState.applyCharacterCreateOptimistically.mockImplementation((character: { chaId: string }) => {
    if (dbState.db.characters.some((candidate) => candidate?.chaId === character.chaId)) return -1
    dbState.db.characters.push(character)
    return dbState.db.characters.length - 1
  })
  characterCommandState.dispatchCreateCharacter.mockResolvedValue({
    status: 'accepted',
    result: {
      status: 'ok',
      revision: 11,
      event: { type: 'character.created', revision: 11, resource: 'character' },
    },
  })
  globalApiState.checkCharOrder.mockImplementation(() => undefined)
  presetImportState.importPreset.mockResolvedValue('applied')
  realmImportState.importRealmCharacterFromServer.mockResolvedValue(okRealmImport('char-imported'))
  resourceRefreshState.refreshServerRealmImportResources.mockResolvedValue({ status: 'ok', revision: 20 })
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Realm catalog failures', () => {
  it('distinguishes an HTTP failure from a valid empty catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })),
    )

    await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: '' })).resolves.toEqual({
      status: 'error',
      cards: [],
      additionalHTML: '',
    })
    await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: '' })).resolves.toEqual({
      status: 'ok',
      cards: [],
      additionalHTML: '',
    })
  })

  it('reports a network rejection as a catalog failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')))

    await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: '' })).resolves.toEqual({
      status: 'error',
      cards: [],
      additionalHTML: '',
    })
  })
})

describe('Realm URL imports', () => {
  it('waits for the Realm information request before completing URL processing', async () => {
    const realmInfo = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => realmInfo.promise) as unknown as typeof fetch)
    window.history.replaceState(null, '', '/?realm=author%2Fcharacter')
    let settled = false

    const importing = characterURLImport().finally(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    realmInfo.resolve(new Response('Realm unavailable', { status: 503 }))
    await importing

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/hub/hub/info/author/character',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(alertState.alertError).toHaveBeenCalledWith('Realm unavailable')
  })

  it('contains Realm information network failures and reports them to the user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch)
    window.history.replaceState(null, '', '/?realm=author%2Fcharacter')

    await expect(characterURLImport()).resolves.toBeUndefined()

    expect(alertState.alertError).toHaveBeenCalledWith('No data')
  })

  it('keeps only the newest Realm information response', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))

    const loadingFirst = getRealmInfo('first-card')
    const loadingSecond = getRealmInfo('second-card')
    second.resolve(new Response(JSON.stringify({ id: 'second-card' }), { status: 200 }))
    await loadingSecond
    first.resolve(new Response(JSON.stringify({ id: 'first-card' }), { status: 200 }))
    await loadingFirst

    expect(get(showRealmInfoStore)).toMatchObject({ id: 'second-card' })
  })

  it('does not reopen Realm information after cancellation or navigation', async () => {
    const cancelled = deferred<Response>()
    const navigated = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(navigated.promise))

    const cancelledLoad = getRealmInfo('cancelled-card')
    cancelPendingRealmInfoRequest()
    cancelled.resolve(new Response(JSON.stringify({ id: 'cancelled-card' }), { status: 200 }))
    await cancelledLoad
    expect(get(showRealmInfoStore)).toBeNull()

    const navigatedLoad = getRealmInfo('navigated-card')
    window.history.pushState(null, '', '/somewhere-else')
    navigated.resolve(new Response(JSON.stringify({ id: 'navigated-card' }), { status: 200 }))
    await navigatedLoad
    expect(get(showRealmInfoStore)).toBeNull()
  })
})

describe('Realm character import finish refresh', () => {
  it('requests Realm terms before a standard catalog download', async () => {
    await downloadRisuHub('realm-id')

    expect(alertState.alertRealmTerms).toHaveBeenCalledTimes(1)
    expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledTimes(1)
  })

  it('does not start a Realm import when its terms are declined', async () => {
    alertState.alertRealmTerms.mockResolvedValue(false)

    await downloadRisuHub('realm-id')

    expect(realmImportState.importRealmCharacterFromServer).not.toHaveBeenCalled()
  })

  it.each([
    { presentation: 'card-reading progress', reportProgress: true, confirmed: true },
    { presentation: 'card-reading progress', reportProgress: true, confirmed: false },
    { presentation: 'initial wait', reportProgress: false, confirmed: true },
    { presentation: 'initial wait', reportProgress: false, confirmed: false },
  ])(
    'shows low-level confirmation after $presentation and handles confirmed=$confirmed',
    async ({ reportProgress, confirmed }) => {
      realmImportState.importRealmCharacterFromServer
        .mockResolvedValue(okRealmImport('char-imported', 21))
        .mockImplementationOnce(async (_id, options) => {
          if (reportProgress) {
            options.onProgress({ phase: 'extract', message: 'Reading character card', percent: 32 })
          }
          expect(get(alertPresentationStore).type).toBe(reportProgress ? 'progress' : 'wait')
          return { status: 'low-level-access', pendingImportToken: 'pending-token' }
        })

      const download = downloadRisuHub('realm-id')

      await vi.waitFor(() =>
        expect(get(alertPresentationStore)).toMatchObject({ type: 'ask', msg: 'Low-level access?' }),
      )
      expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledTimes(1)
      expect(resourceRefreshState.refreshServerRealmImportResources).not.toHaveBeenCalled()

      expect(resolveAlertConfirmation(get(alertPresentationStore).dialogOwner, confirmed)).toBe(true)
      await download

      if (confirmed) {
        expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledTimes(2)
        expect(realmImportState.importRealmCharacterFromServer.mock.calls[1]).toEqual([
          'realm-id',
          {
            allowLowLevelAccess: true,
            pendingImportToken: 'pending-token',
            onProgress: expect.any(Function),
          },
        ])
        expect(resourceRefreshState.refreshServerRealmImportResources).toHaveBeenCalledTimes(1)
      } else {
        expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledTimes(1)
        expect(resourceRefreshState.refreshServerRealmImportResources).not.toHaveBeenCalled()
        expect(characterState.changeChar).not.toHaveBeenCalled()
        expect(get(alertPresentationStore).type).toBe('none')
      }
      expect(alertState.alertError).not.toHaveBeenCalled()
    },
  )

  it('ignores a stale low-level confirmation result while a newer import shows progress', async () => {
    const olderResult = deferred<any>()
    const newerResult = deferred<any>()
    realmImportState.importRealmCharacterFromServer
      .mockReturnValueOnce(olderResult.promise)
      .mockImplementationOnce((_id, options) => {
        options.onProgress({ phase: 'download', message: 'Newer import', percent: 20 })
        return newerResult.promise
      })

    const older = downloadRisuHub('older-realm', { forceRedirect: true })
    const newer = downloadRisuHub('newer-realm', { forceRedirect: true })
    olderResult.resolve({ status: 'low-level-access', pendingImportToken: 'stale-token' })
    await older

    expect(get(alertPresentationStore)).toMatchObject({ type: 'progress', msg: 'Newer import', progress: 20 })
    expect(alertState.alertConfirm).not.toHaveBeenCalled()
    expect(alertState.alertStoreSet).not.toHaveBeenCalled()

    newerResult.resolve(okRealmImport('new-char', 31))
    await newer
    expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledTimes(2)
  })

  it('uses the returned event for a fenced targeted refresh and navigates by imported character id', async () => {
    realmImportState.importRealmCharacterFromServer.mockImplementation(async (_id, options) => {
      options.onProgress?.({
        phase: 'download',
        message: 'Downloading Realm character',
        percent: 25,
      })
      return okRealmImport('char-imported', 21)
    })
    resourceRefreshState.refreshServerRealmImportResources.mockImplementation(async () => {
      dbState.db = {
        characters: [{ chaId: 'other-char' }, { chaId: 'char-imported' }],
        characterOrder: [],
        goCharacterOnImport: false,
      }
      return { status: 'ok', revision: 21 }
    })

    await downloadRisuHub('realm-id', { forceRedirect: true })

    expect(resourceRefreshState.refreshServerRealmImportResources).toHaveBeenCalledTimes(1)
    expect(resourceRefreshState.refreshServerRealmImportResources).toHaveBeenCalledWith(
      okRealmImport('char-imported', 21),
    )
    expect(characterState.changeChar).toHaveBeenCalledTimes(1)
    expect(characterState.changeChar.mock.calls[0][0]).toBe(1)
    expect(characterState.changeChar.mock.calls[0][1]).toEqual({ isFresh: expect.any(Function) })
    expect(characterState.changeChar.mock.calls[0][1].isFresh()).toBe(true)
    expect(alertState.alertStoreSet).toHaveBeenCalledWith({ type: 'none', msg: '' })
    expect(alertState.alertProgress).toHaveBeenCalledWith('Downloading Realm character', 25)
    expect(alertState.alertProgress).toHaveBeenCalledWith('Realm import complete', 100)
  })

  it('uses the returned character id for unsupported Realm fallback navigation after local reorder', async () => {
    setManagedWriterForTest()
    realmImportState.importRealmCharacterFromServer.mockResolvedValue({ status: 'unsupported' })
    dbState.db = {
      characters: [{ chaId: 'existing-char', name: 'Existing' }],
      characterOrder: [],
      goCharacterOnImport: true,
    }
    globalApiState.checkCharOrder.mockImplementation(() => {
      const imported = dbState.db.characters.find((character) => character.name === 'Fallback Imported')
      dbState.db.characters = [imported, { chaId: 'tail-char', name: 'Tail Character' }].filter(Boolean)
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('https://realm.risuai.net/api/v1/download/dynamic/')) {
          return new Response(
            JSON.stringify({
              card: fallbackRealmCard('Fallback Imported'),
              img: 'fallback-img',
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }
        if (url === '/api/v1/hub/resource/fallback-img') {
          return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        }
        return new Response(`unexpected ${url}`, { status: 404 })
      }) as unknown as typeof fetch,
    )

    await downloadRisuHub('realm-id', { forceRedirect: true })

    expect(globalApiState.checkCharOrder).toHaveBeenCalledTimes(1)
    expect(dbState.db.characters.map((character) => character.chaId)).toEqual([expect.any(String), 'tail-char'])
    expect(dbState.db.characters[0].name).toBe('Fallback Imported')
    expect(characterState.changeChar).toHaveBeenCalledTimes(1)
    expect(characterState.changeChar.mock.calls[0][0]).toBe(0)
    expect(characterState.changeChar.mock.calls[0][1]).toEqual({ isFresh: expect.any(Function) })
    expect(alertState.alertStoreSet).toHaveBeenCalledWith({ type: 'none', msg: '' })
  })

  it('keeps stale Realm completions from overwriting newer progress, errors, or navigation', async () => {
    const imports: Array<{
      options: { onProgress?: (progress: any) => void }
      result: Deferred<any>
    }> = []
    realmImportState.importRealmCharacterFromServer.mockImplementation((_id, options) => {
      const result = deferred<any>()
      imports.push({ options, result })
      return result.promise
    })
    let resyncCount = 0
    resourceRefreshState.refreshServerRealmImportResources.mockImplementation(async () => {
      resyncCount += 1
      if (resyncCount === 1) {
        dbState.db = {
          characters: [{ chaId: 'new-char' }],
          characterOrder: [],
          goCharacterOnImport: true,
        }
        return { status: 'ok', revision: 31 }
      }
      dbState.db = {
        characters: [{ chaId: 'old-char' }],
        characterOrder: [],
        goCharacterOnImport: true,
      }
      throw new Error('stale refresh failed')
    })

    const older = downloadRisuHub('older-realm', { forceRedirect: true })
    const newer = downloadRisuHub('newer-realm', { forceRedirect: true })

    expect(imports).toHaveLength(2)
    imports[0].options.onProgress?.({
      phase: 'download',
      message: 'old import progress',
      percent: 10,
    })
    imports[1].options.onProgress?.({
      phase: 'download',
      message: 'new import progress',
      percent: 20,
    })

    imports[1].result.resolve(okRealmImport('new-char', 31))
    await newer
    imports[0].result.resolve(okRealmImport('old-char', 30))
    await older

    expect(resourceRefreshState.refreshServerRealmImportResources).toHaveBeenCalledTimes(1)
    expect(dbState.db.characters.map((character) => character.chaId)).toEqual(['new-char'])
    expect(characterState.changeChar).toHaveBeenCalledTimes(1)
    expect(characterState.changeChar.mock.calls[0][0]).toBe(0)
    expect(characterState.changeChar.mock.calls[0][1]).toEqual({ isFresh: expect.any(Function) })
    expect(alertState.alertError).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
    expect(alertState.alertStoreSet).toHaveBeenCalledTimes(1)
    expect(alertState.alertStoreSet).toHaveBeenCalledWith({ type: 'none', msg: '' })

    const progressMessages = alertState.alertProgress.mock.calls.map(([message]) => message)
    expect(progressMessages).toContain('new import progress')
    expect(progressMessages).not.toContain('old import progress')
    expect(progressMessages.filter((message) => message === 'Refreshing imported character')).toHaveLength(1)
    expect(progressMessages.filter((message) => message === 'Realm import complete')).toHaveLength(1)
  })

  it('reports latest-operation resync failures and skips navigation', async () => {
    realmImportState.importRealmCharacterFromServer.mockResolvedValue(okRealmImport('char-failed', 40))
    resourceRefreshState.refreshServerRealmImportResources.mockResolvedValue({
      status: 'error',
      error: 'refresh failed',
    })
    dbState.db = {
      characters: [{ chaId: 'char-failed' }],
      characterOrder: [],
      goCharacterOnImport: true,
    }

    await downloadRisuHub('realm-id', { forceRedirect: true })

    expect(resourceRefreshState.refreshServerRealmImportResources).toHaveBeenCalledWith(
      okRealmImport('char-failed', 40),
    )
    expect(alertState.alertError).toHaveBeenCalledTimes(1)
    expect(alertState.alertError).toHaveBeenCalledWith('refresh failed')
    expect(characterState.changeChar).not.toHaveBeenCalled()
    expect(alertState.alertStoreSet).not.toHaveBeenCalledWith({ type: 'none', msg: '' })

    const progressMessages = alertState.alertProgress.mock.calls.map(([message]) => message)
    expect(progressMessages).toContain('Refreshing imported character')
    expect(progressMessages).not.toContain('Realm import complete')
  })
})

describe('preset URL imports', () => {
  it('does not open preset settings when an inline preset import fails', async () => {
    const encodedPreset = encodeURIComponent(Buffer.from([1, 2, 3]).toString('base64'))
    window.history.replaceState(null, '', `/#import_preset=${encodedPreset}`)
    presetImportState.importPreset.mockResolvedValueOnce('failed')

    await characterURLImport()

    expect(presetImportState.importPreset).toHaveBeenCalledWith({
      name: 'imported.risupreset',
      data: Buffer.from([1, 2, 3]),
    })
    expect(settingsState.settingsMenuIndexSet).not.toHaveBeenCalled()
    expect(settingsState.settingsOpenSet).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('opens preset settings for an inline import that is safely queued', async () => {
    const encodedPreset = encodeURIComponent(Buffer.from([7, 8, 9]).toString('base64'))
    window.history.replaceState(null, '', `/#import_preset=${encodedPreset}`)
    presetImportState.importPreset.mockResolvedValueOnce('queued')

    await characterURLImport()

    expect(settingsState.settingsMenuIndexSet).toHaveBeenCalledWith(18)
    expect(settingsState.settingsOpenSet).toHaveBeenCalledWith(true)
  })

  it('does not report success or open settings when a downloaded preset import fails', async () => {
    window.history.replaceState(null, '', '/#import=https://example.test/broken.risup')
    presetImportState.importPreset.mockResolvedValueOnce('failed')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([4, 5, 6]), {
            status: 200,
            headers: {
              'content-disposition': 'attachment; filename="broken.risup"',
            },
          }),
      ) as unknown as typeof fetch,
    )

    await characterURLImport()

    expect(presetImportState.importPreset).toHaveBeenCalledWith({
      name: 'broken.risup',
      data: new Uint8Array([4, 5, 6]),
    })
    expect(settingsState.settingsMenuIndexSet).not.toHaveBeenCalled()
    expect(settingsState.settingsOpenSet).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })
})

describe('Realm import completion writer lifecycle', () => {
  it('does not start a Realm import or terms prompt as a Reader', async () => {
    setManagedReaderForTest()
    await downloadRisuHub('reader-card')
    expect(alertState.alertRealmTerms).not.toHaveBeenCalled()
    expect(realmImportState.importRealmCharacterFromServer).not.toHaveBeenCalled()
  })

  it('does not confirm, refresh, or navigate an old import result after re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (value: unknown) => void
    realmImportState.importRealmCharacterFromServer.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = downloadRisuHub('writer-card', { forceRedirect: true })
    await vi.waitFor(() => expect(realmImportState.importRealmCharacterFromServer).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(okRealmImport('char-imported'))
    await pending
    expect(resourceRefreshState.refreshServerRealmImportResources).not.toHaveBeenCalled()
    expect(characterState.changeChar).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })
})

describe('browser URL fallback writer lifecycle', () => {
  it('leaves a Reader import hash untouched and does not fetch the import', async () => {
    setManagedReaderForTest()
    window.history.replaceState(null, '', '/#import=https://example.test/card.png')
    const originalHash = location.hash
    vi.stubGlobal('fetch', vi.fn())
    await characterURLImport()
    expect(location.hash).toBe(originalHash)
    expect(fetch).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
  })

  it('does not parse or create from a held URL response after re-promotion', async () => {
    setManagedWriterForTest()
    window.history.replaceState(null, '', '/#import=https://example.test/card.png')
    const response = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise),
    )
    const pending = characterURLImport()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    response.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="card.png"' },
      }),
    )
    await pending
    expect(saveAsset).not.toHaveBeenCalled()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(characterCommandState.applyCharacterCreateOptimistically).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('does not upload a held Realm emotion asset or create its character after re-promotion', async () => {
    setManagedWriterForTest()
    realmImportState.importRealmCharacterFromServer.mockResolvedValueOnce({ status: 'unsupported' })
    vi.mocked(saveAsset).mockResolvedValueOnce('primary-asset')
    const base = fallbackRealmCard('Held Realm resource')
    const card = {
      ...base,
      spec: 'chara_card_v2',
      data: { ...base.data, extensions: { risuai: { emotions: [['happy', 'held-emotion']] } } },
    }
    const emotion = deferred<Response>()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://realm.risuai.net/api/v1/download/dynamic/'))
        return new Response(JSON.stringify({ card, img: 'primary' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url === '/api/v1/hub/resource/primary') return new Response(new Uint8Array([1]), { status: 200 })
      if (url === '/api/v1/hub/resource/held-emotion') return emotion.promise
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const pending = downloadRisuHub('realm-held', { forceRedirect: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/hub/resource/held-emotion'))
    expect(saveAsset).toHaveBeenCalledOnce()
    demoteAndRepromoteForTest()
    emotion.resolve(new Response(new Uint8Array([2]), { status: 200 }))
    await pending
    expect(saveAsset).toHaveBeenCalledOnce()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(characterCommandState.applyCharacterCreateOptimistically).not.toHaveBeenCalled()
    expect(characterCommandState.dispatchCreateCharacter).not.toHaveBeenCalled()
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })
})
