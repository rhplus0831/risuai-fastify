import {
  beginClientSession,
  settleClientReader,
  setClientConnectionState,
  setClientProjectionReady,
  authorizeClientWriterRecovery,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { get } from 'svelte/store'
import { IDBFactory } from 'fake-indexeddb'

const pluginImportMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertPluginConfirm: vi.fn(),
  selectMultipleFile: vi.fn(),
  selectSingleFile: vi.fn(),
  sleep: vi.fn(),
}))

const pluginPermissionMocks = vi.hoisted(() => ({
  getPluginPermission: vi.fn(async () => true),
}))

function createUtilMock() {
  return {
    BufferToText: (data: Uint8Array) => new TextDecoder().decode(data),
    asBuffer: (data: Uint8Array | ArrayBuffer) => (data instanceof Uint8Array ? data : new Uint8Array(data)),
    base64url: vi.fn((value: string) => value),
    blobToUint8Array: vi.fn(async () => new Uint8Array()),
    checkNullish: (data: unknown) => data === undefined || data === null,
    decryptBuffer: vi.fn(async (data: Uint8Array) => data),
    encryptBuffer: vi.fn(async (data: Uint8Array) => data),
    findCharacterIndexbyId: vi.fn(() => -1),
    findCharacterbyId: vi.fn((id: string) => ({ chaId: id, name: id, chats: [], chatPage: 0 })),
    getAuthorNoteDefaultText: vi.fn(() => ''),
    getKeypairStore: vi.fn(() => null),
    getNodetextToSentence: vi.fn((text: string) => [text]),
    getPersonaPrompt: vi.fn(() => ''),
    getUserIcon: vi.fn(() => ''),
    getUserIconProtrait: vi.fn(() => ''),
    getUserName: vi.fn(() => 'User'),
    isKnownUri: vi.fn(() => false),
    jsonOutputTrimmer: vi.fn((text: string) => text),
    messageForm: vi.fn((messages: unknown[]) => messages),
    parseKeyValue: vi.fn(() => ({})),
    parseMultilangString: vi.fn((text: string) => text),
    pickHashRand: vi.fn((items: unknown[]) => items?.[0]),
    prebuiltAssetCommand: vi.fn(() => ''),
    replaceAsync: vi.fn(async (text: string) => text),
    replacePlaceholders: vi.fn((text: string) => text),
    saveKeypairStore: vi.fn(),
    selectFileByDom: vi.fn(async () => []),
    selectMultipleFile: pluginImportMocks.selectMultipleFile,
    selectSingleFile: pluginImportMocks.selectSingleFile,
    simplifySchema: vi.fn((schema: unknown) => schema),
    sleep: pluginImportMocks.sleep,
    sortableOptions: {},
    toLangName: vi.fn((code: string) => code),
    trimUntilPunctuation: vi.fn((text: string) => text),
  }
}

vi.mock('../platform', () => ({ isFastifyServer: true, isIOS: () => false }))
vi.mock('src/ts/platform', () => ({ isFastifyServer: true, isIOS: () => false }))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'plugin-test-auth',
}))

vi.mock('../alert', () => ({
  alertConfirm: pluginImportMocks.alertConfirm,
  alertError: pluginImportMocks.alertError,
  alertPluginConfirm: pluginImportMocks.alertPluginConfirm,
}))

vi.mock('../util', () => createUtilMock())
vi.mock('src/ts/util', () => createUtilMock())
vi.mock('../filePicker', () => ({
  selectFileByDom: vi.fn(async () => []),
  selectMultipleFile: pluginImportMocks.selectMultipleFile,
  selectSingleFile: pluginImportMocks.selectSingleFile,
}))
vi.mock('../utilState', () => ({
  getAuthorNoteDefaultText: vi.fn(() => ''),
  getPersonaPrompt: vi.fn(() => ''),
  getUserDisplayName: vi.fn(() => 'User'),
  getUserIcon: vi.fn(() => ''),
  getUserIconProtrait: vi.fn(() => false),
  getUserName: vi.fn(() => 'User'),
  replacePlaceholders: vi.fn((text: string) => text),
}))
vi.mock('../characterState', () => ({
  findCharacterIndexbyId: vi.fn(() => -1),
  findCharacterbyId: vi.fn((id: string) => ({ chaId: id, name: id, chats: [], chatPage: 0 })),
}))

vi.mock('./apiV3/v3.svelte', () => ({
  loadV3Plugins: vi.fn(async () => undefined),
}))

vi.mock('./pluginPermissions', () => ({
  getPluginPermission: pluginPermissionMocks.getPluginPermission,
}))

import {
  clearCachedServerCommandRevision,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type CommandEvent,
} from '../server/commands'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from '../server/pendingMutationOutbox'
import { replayPendingMutations } from '../server/pendingMutationReplay'

import { selectedCharID } from '../stores.svelte'
import { setDatabaseLite, updateModelPreset, type Database } from '../storage/database.svelte'
import { SafeLocalPluginStorage } from './pluginSafeClass'
import { loadV3Plugins } from './apiV3/v3.svelte'
import {
  checkPluginUpdate,
  customProviderStore,
  getPluginRuntimeState,
  getV2PluginAPIs,
  importPlugin,
  loadPlugins,
  pluginRuntimeSignature,
  pluginV2,
  startPluginRuntimeSync,
  stopPluginRuntimeSync,
  UnsupportedPluginApiVersionError,
  updatePlugin,
  type RisuPlugin,
} from './plugins.svelte'
import type { RisuModule } from '../process/modules'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

interface CapturedFetch {
  url: string
  method: string
  body: unknown
}

interface SelectedFile {
  name: string
  data: Uint8Array
}

interface SelectSingleFileOptions {
  onFileSelected?: (file: File) => void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function createPicker() {
  const deferred = createDeferred<SelectedFile | null>()
  let options: SelectSingleFileOptions | undefined
  let selected: SelectedFile | null = null

  return {
    selectSingleFile: vi.fn((_extensions: string[], selectOptions?: SelectSingleFileOptions) => {
      options = selectOptions
      return deferred.promise
    }),
    select(value: SelectedFile | null) {
      selected = value
      if (value) {
        const data = value.data.buffer.slice(value.data.byteOffset, value.data.byteOffset + value.data.byteLength)
        options?.onFileSelected?.(new File([data as ArrayBuffer], value.name))
      }
    },
    resolve(value: SelectedFile | null = selected) {
      deferred.resolve(value)
    },
  }
}

function stubCommandFetch(
  options: { failCommands?: boolean; failCommandUrls?: string[]; failureStatus?: number } = {},
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
      if (options.failCommands || options.failCommandUrls?.includes(url)) {
        return jsonResponse({ error: 'forced command failure' }, options.failureStatus ?? 500)
      }
      const event: CommandEvent = {
        type: 'plugin.compat.updated',
        revision: 11,
        resource: 'plugin',
      } as CommandEvent
      return jsonResponse({ revision: 11, event })
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubRemotePluginUpdateFetch(input: {
  remoteUrl: string
  remoteSource: Promise<string> | string
  commandResponse?: Promise<Response> | Response
  failCommands?: boolean
}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(request)
      const requestHeaders = new Headers(init.headers)
      if (
        url === '/api/v1/proxy/plugin-fetch' &&
        requestHeaders.get('risu-url') === encodeURIComponent(input.remoteUrl)
      ) {
        return new Response(await input.remoteSource, { status: 200 })
      }
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      if (url === '/api/v1/bootstrap') {
        return jsonResponse({ revision: 10 })
      }
      calls.push({ url, method: init.method ?? 'GET', body })
      if (input.commandResponse) {
        return input.commandResponse
      }
      if (input.failCommands) {
        return jsonResponse({ error: 'forced command failure' }, 500)
      }
      const event: CommandEvent = {
        type: 'plugin.updated',
        revision: 11,
        resource: 'plugin',
      } as CommandEvent
      return jsonResponse({ revision: 11, event })
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubDeferredCommandFetch(): {
  calls: CapturedFetch[]
  commandResponses: Array<{ resolve: (response: Response) => void }>
} {
  const calls: CapturedFetch[] = []
  const commandResponses: Array<{ resolve: (response: Response) => void }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({ url, method: init.method ?? 'GET', body })
      if (url === '/api/v1/bootstrap') {
        return jsonResponse({ revision: 10 })
      }
      return new Promise<Response>((resolve) => {
        commandResponses.push({ resolve })
      })
    }) as unknown as typeof fetch,
  )
  return { calls, commandResponses }
}

function seedPlugin(name: string, patch: Partial<RisuPlugin> = {}): RisuPlugin {
  return {
    name,
    script: 'Risuai.log("plugin")',
    arguments: {},
    realArg: {},
    version: '3.0',
    customLink: [],
    argMeta: {},
    enabled: true,
    ...patch,
  }
}

function seedModule(id: string, patch: Partial<RisuModule> = {}): RisuModule {
  return {
    id,
    name: id,
    description: '',
    ...patch,
  } as RisuModule
}

function pluginSource(
  name: string,
  options: {
    api?: '2.1' | '3.0'
    body?: string
    displayName?: string | null
    versionOfPlugin?: string
    updateURL?: string
  } = {},
): string {
  const lines = [`//@name ${name}`]
  if (options.displayName !== null) {
    lines.push(`//@display-name ${options.displayName ?? name}`)
  }
  lines.push(`//@api ${options.api ?? '3.0'}`)
  if (options.versionOfPlugin) {
    lines.push(`//@version ${options.versionOfPlugin}`)
  }
  if (options.updateURL) {
    lines.push(`//@update-url ${options.updateURL}`)
  }
  lines.push(options.body ?? `Risuai.log("${name}")`)
  return lines.join('\n')
}

function selectedPluginFile(source: string, name = 'plugin.js'): SelectedFile {
  return {
    name,
    data: new TextEncoder().encode(source),
  }
}

interface PluginStorageCloneStats<T> {
  result: T
  jsonStringifyCount: number
  structuredCloneCount: number
  totalCloneCount: number
  maxClonedSize: number
}

function withPluginStorageCloneStats<T>(fn: () => T): PluginStorageCloneStats<T> {
  const originalStringify = JSON.stringify
  const originalStructuredClone = globalThis.structuredClone
  let jsonStringifyCount = 0
  let structuredCloneCount = 0
  let maxClonedSize = 0

  const measure = (value: unknown): number => {
    try {
      return (originalStringify as (input: unknown) => string)(value)?.length ?? 0
    } catch {
      return 0
    }
  }

  const trackedStringify = function trackedStringify(
    this: unknown,
    value: unknown,
    replacer?: unknown,
    space?: unknown,
  ) {
    jsonStringifyCount += 1
    const out = (originalStringify as (...args: unknown[]) => string).call(this, value, replacer, space)
    if (typeof out === 'string' && out.length > maxClonedSize) maxClonedSize = out.length
    return out
  } as unknown as typeof JSON.stringify

  const trackedStructuredClone = function trackedStructuredClone<V>(value: V): V {
    structuredCloneCount += 1
    const size = measure(value)
    if (size > maxClonedSize) maxClonedSize = size
    return (originalStructuredClone as (input: V) => V)(value)
  } as typeof structuredClone

  JSON.stringify = trackedStringify
  globalThis.structuredClone = trackedStructuredClone
  try {
    const result = fn()
    return {
      result,
      jsonStringifyCount,
      structuredCloneCount,
      totalCloneCount: jsonStringifyCount + structuredCloneCount,
      maxClonedSize,
    }
  } finally {
    JSON.stringify = originalStringify
    globalThis.structuredClone = originalStructuredClone
  }
}

beforeEach(() => {
  resetClientSessionForTests()
  clearCachedServerCommandRevision()
  vi.unstubAllGlobals()
  pluginImportMocks.alertConfirm.mockReset()
  pluginImportMocks.alertConfirm.mockResolvedValue(true)
  pluginImportMocks.alertError.mockReset()
  pluginImportMocks.alertPluginConfirm.mockReset()
  pluginImportMocks.alertPluginConfirm.mockResolvedValue(true)
  pluginImportMocks.selectMultipleFile.mockReset()
  pluginImportMocks.selectMultipleFile.mockResolvedValue([])
  pluginImportMocks.selectSingleFile.mockReset()
  pluginImportMocks.sleep.mockReset()
  pluginImportMocks.sleep.mockResolvedValue(undefined)
  pluginPermissionMocks.getPluginPermission.mockReset()
  pluginPermissionMocks.getPluginPermission.mockResolvedValue(true)
  vi.mocked(loadV3Plugins).mockClear()
  setDatabaseLite({
    currentPluginProvider: 'old-provider',
    pluginCustomStorage: {},
    pluginCompatibilityMode: false,
    plugins: [seedPlugin('plugin-a')],
    modules: [seedModule('mod-a')],
    enabledModules: [],
  } as any)
})

afterEach(() => {
  resetClientSessionForTests()
  stopPluginRuntimeSync()
  setServerCommandSuccessReconciler(null)
})

describe('plugin runtime synchronization', () => {
  it.each([2, '2.1'] as const)('throws when a V%s-series plugin reaches the runtime', async (version) => {
    setDatabaseLite({
      ...getDatabase(),
      plugins: [{ ...seedPlugin('unsupported-plugin'), version } as unknown as RisuPlugin],
    })

    await expect(loadPlugins()).rejects.toEqual(new UnsupportedPluginApiVersionError('unsupported-plugin', version))
    expect(loadV3Plugins).not.toHaveBeenCalled()
    expect(getPluginRuntimeState()).toMatchObject({
      phase: 'error',
      error: expect.any(UnsupportedPluginApiVersionError),
    })
  })

  it('reconciles an accepted projection that lands while the initial runtime load is pending', async () => {
    const initialLoad = createDeferred<void>()
    vi.mocked(loadV3Plugins).mockImplementationOnce(() => initialLoad.promise)

    const loading = loadPlugins()
    await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledOnce())
    expect(getPluginRuntimeState()).toMatchObject({ phase: 'loading' })

    withTestDatabaseWrite(() => {
      getDatabase().plugins.push(seedPlugin('plugin-late'))
    })
    initialLoad.resolve(undefined)
    await loading

    expect(loadV3Plugins).toHaveBeenCalledTimes(2)
    expect(vi.mocked(loadV3Plugins).mock.calls[1][0].map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-late'])
    expect(getPluginRuntimeState()).toMatchObject({
      phase: 'ready',
      targetSignature: pluginRuntimeSignature(getDatabase().plugins),
      error: null,
    })
  })

  it('ignores live argument edits but reloads external script and membership projections', async () => {
    startPluginRuntimeSync()
    flushSync()

    withTestDatabaseWrite(() => {
      const plugin = getDatabase().plugins[0]
      getDatabase().plugins[0] = {
        ...plugin,
        displayName: 'Renamed presentation only',
        realArg: { mode: 'slow' },
      }
    })
    flushSync()
    await Promise.resolve()

    expect(loadV3Plugins).not.toHaveBeenCalled()
    expect(pluginRuntimeSignature(getDatabase().plugins)).toBe(
      pluginRuntimeSignature([
        seedPlugin('plugin-a', {
          displayName: 'Another presentation value',
          realArg: { mode: 'different' },
        }),
      ]),
    )

    withTestDatabaseWrite(() => {
      getDatabase().plugins[0] = {
        ...getDatabase().plugins[0],
        script: 'Risuai.log("authoritative update")',
      }
    })
    flushSync()

    await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledTimes(1))
    expect(vi.mocked(loadV3Plugins).mock.calls[0][0]).toEqual([
      expect.objectContaining({
        name: 'plugin-a',
        script: 'Risuai.log("authoritative update")',
      }),
    ])

    withTestDatabaseWrite(() => {
      getDatabase().plugins.push(seedPlugin('plugin-external'))
    })
    flushSync()

    await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledTimes(2))
    expect(vi.mocked(loadV3Plugins).mock.calls[1][0].map((plugin) => plugin.name)).toEqual([
      'plugin-a',
      'plugin-external',
    ])
  })

  it('queues the restored runtime when enablement rolls back during an optimistic reload', async () => {
    setDatabaseLite({
      ...getDatabase(),
      plugins: [seedPlugin('plugin-a', { enabled: false })],
    })
    const optimisticLoad = createDeferred<void>()
    vi.mocked(loadV3Plugins).mockImplementationOnce(() => optimisticLoad.promise)
    startPluginRuntimeSync()
    flushSync()

    withTestDatabaseWrite(() => {
      getDatabase().plugins[0] = { ...getDatabase().plugins[0], enabled: true }
    })
    flushSync()

    await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledTimes(1))
    expect(vi.mocked(loadV3Plugins).mock.calls[0][0].map((plugin) => plugin.name)).toEqual(['plugin-a'])

    // Simulate runServerCommand's failure rollback while plugin-a is still
    // being started. The final queued pass must unload the rejected runtime.
    withTestDatabaseWrite(() => {
      getDatabase().plugins[0] = { ...getDatabase().plugins[0], enabled: false }
    })
    flushSync()
    optimisticLoad.resolve(undefined)

    await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledTimes(2))
    expect(vi.mocked(loadV3Plugins).mock.calls[1][0]).toEqual([])
  })
})

describe('plugin import/update freshness', () => {
  it('throws before persisting an API V2.1 plugin import', async () => {
    const calls = stubCommandFetch()

    await expect(importPlugin(pluginSource('unsupported-plugin', { api: '2.1' }))).rejects.toEqual(
      new UnsupportedPluginApiVersionError('unsupported-plugin', '2.1'),
    )

    expect(calls).toEqual([])
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a'])
    expect(pluginImportMocks.alertError).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent checks and caches a successful no-update result', async () => {
    const updateURL = 'https://plugins.example/no-update.js'
    const fetchMock = vi.fn(async () => new Response('//@version 1.0.0\nRisuai.log("same")', { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const plugin = seedPlugin('plugin-negative-cache', {
      updateURL,
      versionOfPlugin: '1.0.0',
    })
    getDatabase().plugins = [plugin]

    await expect(Promise.all([checkPluginUpdate(plugin), checkPluginUpdate(plugin)])).resolves.toEqual([
      { status: 'up-to-date' },
      { status: 'up-to-date' },
    ])
    await expect(checkPluginUpdate({ ...plugin })).resolves.toEqual({ status: 'up-to-date' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/proxy/plugin-fetch',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'risu-auth': 'plugin-test-auth',
          'risu-url': encodeURIComponent(updateURL),
        }),
      }),
    )
  })

  it('does not reuse an update check after the source URL or installed version changes', async () => {
    const fetchMock = vi.fn(async () => new Response('//@version 2.0.0', { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const plugin = seedPlugin('plugin-update-cache-identity', {
      updateURL: 'https://plugins.example/first.js',
      versionOfPlugin: '1.0.0',
    })
    getDatabase().plugins = [plugin]

    await expect(checkPluginUpdate(plugin)).resolves.toMatchObject({
      status: 'available',
      update: { version: '2.0.0' },
    })
    const secondSource = { ...plugin, updateURL: 'https://plugins.example/second.js' }
    getDatabase().plugins = [secondSource]
    await expect(checkPluginUpdate(secondSource)).resolves.toMatchObject({
      status: 'available',
      update: { version: '2.0.0' },
    })
    const newerInstalledVersion = { ...plugin, versionOfPlugin: '1.1.0' }
    getDatabase().plugins = [newerInstalledVersion]
    await expect(checkPluginUpdate(newerInstalledVersion)).resolves.toMatchObject({
      status: 'available',
      update: { version: '2.0.0' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retries failed plugin update checks instead of caching failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(new Response('//@version 2.0.0', { status: 206 }))
    vi.stubGlobal('fetch', fetchMock)
    const plugin = seedPlugin('plugin-update-retry', {
      updateURL: 'https://plugins.example/retry.js',
      versionOfPlugin: '1.0.0',
    })
    getDatabase().plugins = [plugin]

    await expect(checkPluginUpdate(plugin)).resolves.toEqual({ status: 'failed' })
    await expect(checkPluginUpdate(plugin)).resolves.toMatchObject({
      status: 'available',
      update: { version: '2.0.0' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('drops file import after real file selection if the plugin list changes before file read completes', async () => {
    const calls = stubCommandFetch()
    const picker = createPicker()
    pluginImportMocks.selectSingleFile.mockImplementation(picker.selectSingleFile)

    const importPromise = importPlugin()
    await vi.waitFor(() => {
      expect(pluginImportMocks.selectSingleFile).toHaveBeenCalledWith(['js', 'ts'], expect.any(Object))
    })

    picker.select(selectedPluginFile(pluginSource('plugin-b')))
    getDatabase().plugins.push(seedPlugin('plugin-newer'))
    picker.resolve()

    await expect(importPromise).resolves.toEqual({ status: 'stale' })
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-newer'])
    expect(calls).toEqual([])
  })

  it('does not alert for an invalid stale plugin import', async () => {
    const picker = createPicker()
    pluginImportMocks.selectSingleFile.mockImplementation(picker.selectSingleFile)

    const importPromise = importPlugin()
    await vi.waitFor(() => {
      expect(pluginImportMocks.selectSingleFile).toHaveBeenCalledWith(['js', 'ts'], expect.any(Object))
    })

    picker.select(selectedPluginFile('not a plugin'))
    getDatabase().plugins.push(seedPlugin('plugin-newer'))
    picker.resolve()

    await expect(importPromise).resolves.toEqual({ status: 'stale' })
    expect(pluginImportMocks.alertError).not.toHaveBeenCalled()
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-newer'])
  })

  it('drops duplicate-confirm imports if plugin state changes while the confirm is open', async () => {
    const calls = stubCommandFetch()
    const confirm = createDeferred<boolean>()
    pluginImportMocks.alertConfirm.mockReturnValue(confirm.promise)
    const originalScript = getDatabase().plugins[0].script

    const importPromise = importPlugin(pluginSource('plugin-a', { body: 'Risuai.log("updated")' }))
    await vi.waitFor(() => {
      expect(pluginImportMocks.alertConfirm).toHaveBeenCalled()
    })

    getDatabase().plugins.push(seedPlugin('plugin-newer'))
    confirm.resolve(true)

    await expect(importPromise).resolves.toEqual({ status: 'stale' })
    expect(getDatabase().plugins[0].script).toBe(originalScript)
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-newer'])
    expect(calls).toEqual([])
  })

  it('rolls back a fresh server-backed plugin import and skips runtime reload when create fails', async () => {
    const calls = stubCommandFetch({ failCommands: true })
    startPluginRuntimeSync()
    flushSync()

    await expect(importPlugin(pluginSource('plugin-created'))).resolves.toEqual({ status: 'failed' })

    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a'])
    expect(calls.find((call) => call.url === '/api/v1/commands/plugins')).toMatchObject({
      method: 'POST',
      body: {
        baseRevision: 10,
        plugin: expect.objectContaining({
          name: 'plugin-created',
        }),
      },
    })
    expect(pluginImportMocks.alertError).toHaveBeenCalledWith(expect.stringContaining('could not be saved'))
    expect(loadV3Plugins).not.toHaveBeenCalled()
  })

  it('reports a retained plugin import as queued and loads it after replay acceptance', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-plugin-import',
      writerEpoch: 1,
      databaseLineage: 'lineage-plugin-import',
      requestedWriterWasActive: true,
    })
    setCachedServerCommandRevision(10)
    let recover = false
    const createBodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        if (url === '/api/v1/commands/plugins') {
          createBodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : null)
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
          return jsonResponse({
            revision: 11,
            event: {
              type: 'plugin.created',
              revision: 11,
              resource: 'plugin',
              id: 'plugin-created',
            } as CommandEvent,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    startPluginRuntimeSync()
    flushSync()

    try {
      const result = await importPlugin(pluginSource('plugin-created'))

      expect(result).toMatchObject({ status: 'queued', pluginName: 'plugin-created' })
      expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-created'])
      expect(loadV3Plugins).not.toHaveBeenCalled()
      expect(pluginImportMocks.alertError).not.toHaveBeenCalled()

      recover = true
      const settlement = result.status === 'queued' ? result.settlement : Promise.reject(new Error('not queued'))
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      await expect(settlement).resolves.toEqual({ status: 'accepted' })
      await vi.waitFor(() => expect(loadV3Plugins).toHaveBeenCalledTimes(1))
      expect(createBodies).toHaveLength(2)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('loads a fresh server-backed plugin import only after create acceptance', async () => {
    const { calls, commandResponses } = stubDeferredCommandFetch()
    startPluginRuntimeSync()
    flushSync()
    const importPromise = importPlugin(pluginSource('plugin-created'))

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugins')).toBe(true)
    })
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-created'])
    expect(loadV3Plugins).not.toHaveBeenCalled()

    commandResponses[0].resolve(
      jsonResponse({
        revision: 11,
        event: {
          type: 'plugin.created',
          revision: 11,
          resource: 'plugin',
          id: 'plugin-created',
        } as CommandEvent,
      }),
    )

    await expect(importPromise).resolves.toEqual({ status: 'accepted', pluginName: 'plugin-created' })
    await vi.waitFor(() => {
      expect(loadV3Plugins).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(loadV3Plugins).mock.calls[0][0].map((plugin) => plugin.name)).toEqual([
      'plugin-a',
      'plugin-created',
    ])
  })

  it('drops remote update if the original plugin row changes while fetch text is in flight', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const remoteSource = createDeferred<string>()
    const calls = stubRemotePluginUpdateFetch({
      remoteUrl,
      remoteSource: remoteSource.promise,
    })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ]

    const updatePromise = updatePlugin(getDatabase().plugins[0])
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/proxy/plugin-fetch',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'risu-url': encodeURIComponent(remoteUrl) }),
        }),
      )
    })

    getDatabase().plugins[0] = seedPlugin('plugin-a', {
      script: 'Risuai.log("reinstalled")',
      updateURL: remoteUrl,
      versionOfPlugin: '1.0.0',
    })
    remoteSource.resolve(
      pluginSource('plugin-a', {
        body: 'Risuai.log("updated")',
        versionOfPlugin: '1.0.1',
        updateURL: remoteUrl,
      }),
    )

    await expect(updatePromise).resolves.toBe(false)
    expect(getDatabase().plugins[0].script).toBe('Risuai.log("reinstalled")')
    expect(calls).toEqual([])
  })

  it('completes a remote update across unrelated plugin argument edits', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const remoteSource = createDeferred<string>()
    const calls = stubRemotePluginUpdateFetch({
      remoteUrl,
      remoteSource: remoteSource.promise,
    })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
      seedPlugin('plugin-b', { realArg: { mode: 'before' } }),
    ]

    const updatePromise = updatePlugin(getDatabase().plugins[0])
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/proxy/plugin-fetch',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ 'risu-url': encodeURIComponent(remoteUrl) }),
        }),
      )
    })

    getDatabase().plugins[1] = {
      ...getDatabase().plugins[1],
      realArg: { mode: 'after' },
    }
    remoteSource.resolve(
      pluginSource('plugin-a', {
        body: 'Risuai.log("updated")',
        versionOfPlugin: '1.0.1',
        updateURL: remoteUrl,
      }),
    )

    await expect(updatePromise).resolves.toBe(true)
    expect(getDatabase().plugins[0].script).toContain('Risuai.log("updated")')
    expect(getDatabase().plugins[1].realArg).toEqual({ mode: 'after' })
    expect(calls.some((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toBe(true)
  })

  it('rolls back a fresh remote update and skips runtime reload when update command fails', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const updatedSource = pluginSource('plugin-a', {
      body: 'Risuai.log("updated")',
      versionOfPlugin: '1.0.1',
      updateURL: remoteUrl,
    })
    const calls = stubRemotePluginUpdateFetch({
      remoteUrl,
      remoteSource: updatedSource,
      failCommands: true,
    })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ]

    await expect(updatePlugin(getDatabase().plugins[0])).resolves.toBe(false)

    expect(getDatabase().plugins).toEqual([
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ])
    const patchCall = calls.find((call) => call.url === '/api/v1/commands/plugins/plugin-a')
    expect(patchCall).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          script: updatedSource,
          displayName: 'plugin-a',
          versionOfPlugin: '1.0.1',
          allowedIPC: [],
        },
      },
    })
    expect(loadV3Plugins).not.toHaveBeenCalled()
  })

  it('loads a fresh remote update only after update acceptance', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const updatedSource = pluginSource('plugin-a', {
      body: 'Risuai.log("updated")',
      versionOfPlugin: '1.0.1',
      updateURL: remoteUrl,
    })
    const commandResponse = createDeferred<Response>()
    const calls = stubRemotePluginUpdateFetch({
      remoteUrl,
      remoteSource: updatedSource,
      commandResponse: commandResponse.promise,
    })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ]

    const updatePromise = updatePlugin(getDatabase().plugins[0])

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toBe(true)
    })
    expect(getDatabase().plugins[0].script).toBe(updatedSource)
    expect(loadV3Plugins).not.toHaveBeenCalled()

    commandResponse.resolve(
      jsonResponse({
        revision: 11,
        event: {
          type: 'plugin.updated',
          revision: 11,
          resource: 'plugin',
          id: 'plugin-a',
        } as CommandEvent,
      }),
    )

    await expect(updatePromise).resolves.toBe(true)
    await vi.waitFor(() => {
      expect(loadV3Plugins).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(loadV3Plugins).mock.calls[0][0].map((plugin) => plugin.name)).toEqual(['plugin-a'])
  })

  it('dispatches the plugin patch command for a fresh remote update', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const updatedSource = pluginSource('plugin-a', {
      body: 'Risuai.log("updated")',
      versionOfPlugin: '1.0.1',
      updateURL: remoteUrl,
    })
    const calls = stubRemotePluginUpdateFetch({
      remoteUrl,
      remoteSource: updatedSource,
    })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ]

    await expect(updatePlugin(getDatabase().plugins[0])).resolves.toBe(true)

    expect(getDatabase().plugins[0].script).toBe(updatedSource)
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toBe(true)
    })
    const patchCall = calls.find((call) => call.url === '/api/v1/commands/plugins/plugin-a')
    expect(patchCall).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          script: updatedSource,
          displayName: 'plugin-a',
          versionOfPlugin: '1.0.1',
          allowedIPC: [],
        },
      },
    })
  })

  it('removes optional metadata omitted by a fresh remote plugin snapshot', async () => {
    const remoteUrl = 'https://plugins.example/plugin-a.js'
    const updatedSource = pluginSource('plugin-a', {
      body: 'Risuai.log("updated")',
      displayName: null,
      versionOfPlugin: '1.0.1',
      updateURL: remoteUrl,
    })
    const calls = stubRemotePluginUpdateFetch({ remoteUrl, remoteSource: updatedSource })
    getDatabase().plugins = [
      seedPlugin('plugin-a', {
        script: 'Risuai.log("old")',
        displayName: 'Old display name',
        updateURL: remoteUrl,
        versionOfPlugin: '1.0.0',
      }),
    ]

    await expect(updatePlugin(getDatabase().plugins[0])).resolves.toBe(true)

    expect(getDatabase().plugins[0].displayName).toBeUndefined()
    expect(calls.find((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: expect.objectContaining({ displayName: null }),
      },
    })
  })
})

describe('plugin database command bridge', () => {
  it.each([
    ['the legacy database proxy', (apis: ReturnType<typeof getV2PluginAPIs>) => apis.getDatabase()],
    [
      'a detached V3-style snapshot',
      () => ({
        plugins: getDatabase().plugins.map((plugin) => ({ ...plugin, realArg: { ...plugin.realArg } })),
      }),
    ],
  ])('preserves installed plugins when setDatabase receives %s unchanged', async (_label, databaseSnapshot) => {
    const calls = stubCommandFetch()
    getDatabase().plugins = [seedPlugin('plugin-a'), seedPlugin('plugin-b')]
    const apis = getV2PluginAPIs()

    await apis.setDatabase(databaseSnapshot(apis))

    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-b'])
    expect(
      calls.filter((call) => call.method === 'DELETE' && call.url.startsWith('/api/v1/commands/plugins/')),
    ).toEqual([])
    expect(pluginImportMocks.alertConfirm).not.toHaveBeenCalled()
  })

  it('merges an approved plugin candidate without deleting already-installed plugins', async () => {
    const calls = stubCommandFetch()
    getDatabase().plugins = [seedPlugin('plugin-a'), seedPlugin('plugin-b')]
    const apis = getV2PluginAPIs()
    const pluginC = seedPlugin('plugin-c', { script: 'Risuai.log("plugin c")' })

    await apis.setDatabase({ plugins: [...getDatabase().plugins, pluginC] })

    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-b', 'plugin-c'])
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: '/api/v1/commands/plugins',
          method: 'POST',
        }),
      ]),
    )
    expect(
      calls.filter((call) => call.method === 'DELETE' && call.url.startsWith('/api/v1/commands/plugins/')),
    ).toEqual([])
  })

  it('routes plugin provider database writes through the provider command', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({ currentPluginProvider: 'provider-a' })

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugins/provider')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/plugins/provider')).toMatchObject({
      method: 'POST',
      body: {
        baseRevision: 10,
        provider: 'provider-a',
      },
    })
    expect(calls.some((call) => call.url.includes('/api/v1/commands/plugin-storage'))).toBe(false)
    expect(getDatabase().currentPluginProvider).toBe('provider-a')
  })

  it('setArg updates plugin realArg through its owner command', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    let persistence: ReturnType<typeof apis.setArg> | undefined
    expect(() => {
      persistence = apis.setArg('plugin-a::myarg', 'myvalue')
    }).not.toThrow()
    expect(persistence).toBeInstanceOf(Promise)

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/plugins/plugin-a')).toMatchObject({
      method: 'PATCH',
      body: { patch: { realArg: { myarg: 'myvalue' } } },
    })
    expect(getDatabase().plugins[0].realArg.myarg).toBe('myvalue')
    await expect(persistence).resolves.toMatchObject({ status: 'accepted' })
  })

  it('setArg returns a terminal persistence failure after guarded rollback', async () => {
    stubCommandFetch({ failCommands: true, failureStatus: 400 })
    const apis = getV2PluginAPIs()

    const persistence = apis.setArg('plugin-a::rejected', 'attempted')
    expect(getDatabase().plugins[0].realArg.rejected).toBe('attempted')

    await expect(persistence).resolves.toMatchObject({ status: 'failed' })
    expect(getDatabase().plugins[0].realArg).not.toHaveProperty('rejected')
  })

  it('setArg rechecks the plugin lifecycle after persistence settles', async () => {
    const { calls, commandResponses } = stubDeferredCommandFetch()
    let current = true
    const apis = getV2PluginAPIs(undefined, () => {
      if (!current) throw new Error('stale plugin instance')
    })

    const persistence = apis.setArg('plugin-a::delayed', 'value')
    await vi.waitFor(() => expect(commandResponses).toHaveLength(1))
    expect(calls.at(-1)?.url).toBe('/api/v1/commands/plugins/plugin-a')
    current = false
    commandResponses[0].resolve(
      jsonResponse({
        revision: 11,
        event: { type: 'plugin.updated', revision: 11, resource: 'plugin', id: 'plugin-a' },
        pluginId: 'plugin-a',
      }),
    )

    await expect(persistence).rejects.toThrow('stale plugin instance')
  })

  it('setChar applies command-compatible character fields in server mode', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    selectedCharID.set(0)
    getDatabase().characters = [
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
    ] as any

    const persistence = apis.setChar({
      chaId: 'char-a',
      name: 'New name',
      desc: 'New desc',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
      customscript: 'old custom script',
      triggerscript: 'old trigger script',
      modules: ['old-module'],
    })

    expect(getDatabase().characters[0]).toEqual({
      chaId: 'char-a',
      name: 'New name',
      desc: 'New desc',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
      customscript: 'old custom script',
      triggerscript: 'old trigger script',
      modules: ['old-module'],
    })
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/characters/char-a')).toBe(true)
    })
    const update = calls.find((call) => call.url === '/api/v1/commands/characters/char-a')
    expect(update).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          name: 'New name',
          desc: 'New desc',
        },
      },
    })
    const patch = (update?.body as any)?.patch
    expect(patch).not.toHaveProperty('chaId')
    expect(patch).not.toHaveProperty('chats')
    expect(patch).not.toHaveProperty('globalLore')
    expect(patch).not.toHaveProperty('customscript')
    expect(patch).not.toHaveProperty('triggerscript')
    expect(patch).not.toHaveProperty('modules')
    await expect(persistence).resolves.toMatchObject({ status: 'accepted' })
  })

  it('setChar retains a transient optimistic replacement and replays its exact patch', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-plugin-v2-character',
      writerEpoch: 1,
      databaseLineage: 'lineage-plugin-v2-character',
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
    selectedCharID.set(0)
    getDatabase().characters = [
      {
        chaId: 'char-a',
        name: 'Old name',
        chats: [{ id: 'chat-a', message: [] }],
      },
    ] as any

    try {
      const persistence = getV2PluginAPIs().setChar({
        chaId: 'char-a',
        name: 'Retained name',
        chats: [{ id: 'chat-a', message: [] }],
      })

      await vi.waitFor(() => expect(patches).toHaveLength(1))
      await expect(persistence).resolves.toMatchObject({ status: 'queued' })
      expect(getDatabase().characters[0].name).toBe('Retained name')
      expect((await listPendingMutations()).map((entry) => entry.intent.requests[0])).toMatchObject([
        {
          method: 'PATCH',
          path: '/characters/char-a',
          body: { patch: { name: 'Retained name' } },
        },
      ])

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      expect(patches.map((body) => body.patch)).toEqual([{ name: 'Retained name' }, { name: 'Retained name' }])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('setChar failure rolls back attempted target fields without clobbering sibling edits or selection', async () => {
    const calls = stubCommandFetch({ failCommands: true, failureStatus: 400 })
    const apis = getV2PluginAPIs()
    selectedCharID.set(0)
    getDatabase().characters = [
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
    ] as any
    ;(getDatabase() as any).currentChar = 0

    const persistence = apis.setChar({
      chaId: 'char-a',
      name: 'Attempted name',
      desc: 'Attempted desc',
      chats: [{ id: 'chat-a', message: [] }],
    })

    expect(getDatabase().characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'Attempted name',
      desc: 'Attempted desc',
    })

    getDatabase().characters[1].name = 'Newer sibling name'
    ;(getDatabase() as any).currentChar = 1
    selectedCharID.set(1)

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/characters/char-a')).toBe(true)
    })
    await vi.waitFor(() => {
      expect(getDatabase().characters[0].name).toBe('Old name')
    })

    expect(getDatabase().characters[0].desc).toBe('Old desc')
    expect(getDatabase().characters[1].name).toBe('Newer sibling name')
    expect((getDatabase() as any).currentChar).toBe(1)
    expect(get(selectedCharID)).toBe(1)
    await expect(persistence).resolves.toMatchObject({ status: 'failed' })
  })

  it('setChar rejects unsupported character field changes before projection mutation and command dispatch', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    selectedCharID.set(0)
    getDatabase().characters = [
      {
        chaId: 'char-a',
        name: 'Old name',
        chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
        globalLore: [{ key: 'old lore' }],
        customscript: 'old custom script',
      },
    ] as any
    const originalCharacter = JSON.parse(JSON.stringify(getDatabase().characters[0]))

    expect(() =>
      apis.setChar({
        ...originalCharacter,
        name: 'New name',
        chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'changed', chatId: 'msg-a' }] }],
        globalLore: [{ key: 'changed lore' }],
        customscript: 'changed custom script',
      }),
    ).toThrow(/setChar cannot update unsupported character fields .*chats, globalLore, customscript/)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(getDatabase().characters[0]).toEqual(originalCharacter)
    expect(calls.some((call) => call.url.startsWith('/api/v1/commands/characters/'))).toBe(false)
  })

  it('setChar rejects excluded-only character changes before projection mutation and command dispatch', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    selectedCharID.set(0)
    getDatabase().characters = [
      {
        chaId: 'char-a',
        name: 'Old name',
        chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
        globalLore: [{ key: 'old lore' }],
      },
    ] as any
    const originalCharacter = JSON.parse(JSON.stringify(getDatabase().characters[0]))

    expect(() =>
      apis.setChar({
        ...originalCharacter,
        chaId: 'plugin-supplied-id',
        chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'changed', chatId: 'msg-a' }] }],
        globalLore: [{ key: 'changed lore' }],
      }),
    ).toThrow(/setChar cannot update unsupported character fields .*chaId, chats, globalLore/)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(getDatabase().characters[0]).toEqual(originalCharacter)
    expect(calls.some((call) => call.url.startsWith('/api/v1/commands/characters/'))).toBe(false)
  })

  it('routes plugin module-integration database writes through settings commands', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({ moduleIntergration: 'ns-a, ns-b' })

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/settings/advanced')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/settings/advanced')).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          moduleIntergration: 'ns-a, ns-b',
        },
      },
    })
    expect(getDatabase().moduleIntergration).toBe('ns-a, ns-b')
  })

  it('rolls back failed plugin DB bridge settings patches without clobbering newer plugin state', async () => {
    const advancedCommand = createDeferred<Response>()
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 50 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/commands/settings/advanced') {
          return advancedCommand.promise
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    withTestDatabaseWrite(() => {
      getDatabase().moduleIntergration = 'old-modules'
      getDatabase().plugins = [seedPlugin('plugin-a')]
      getDatabase().currentPluginProvider = 'plugin-a'
      getDatabase().pluginCustomStorage = {
        retained: { value: 1 },
      }
    })
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({ moduleIntergration: 'attempted-modules' })

    await vi.waitFor(() => {
      expect(captured.length).toBe(1)
    })
    expect(getDatabase().moduleIntergration).toBe('attempted-modules')

    withTestDatabaseWrite(() => {
      getDatabase().plugins.push(
        seedPlugin('plugin-newer', {
          realArg: { mode: 'newer-plugin' },
        }),
      )
      getDatabase().currentPluginProvider = 'plugin-newer'
      getDatabase().pluginCustomStorage.newerStorage = { value: 'kept' }
    })
    advancedCommand.resolve(jsonResponse({ error: 'forced advanced failure' }, 500))

    await vi.waitFor(() => {
      expect(getDatabase().moduleIntergration).toBe('old-modules')
    })

    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/settings/advanced',
      method: 'PATCH',
      body: {
        baseRevision: 50,
        patch: {
          moduleIntergration: 'attempted-modules',
        },
      },
    })
    expect(getDatabase().plugins).toEqual([
      seedPlugin('plugin-a'),
      seedPlugin('plugin-newer', {
        realArg: { mode: 'newer-plugin' },
      }),
    ])
    expect(getDatabase().currentPluginProvider).toBe('plugin-newer')
    expect(getDatabase().pluginCustomStorage).toEqual({
      retained: { value: 1 },
      newerStorage: { value: 'kept' },
    })
  })

  it('keeps accepted plugin DB bridge settings groups when a later group fails', async () => {
    const advancedCommand = createDeferred<Response>()
    const captured: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 50 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/commands/settings/providers') {
          const event: CommandEvent = {
            type: 'settings.updated',
            revision: 51,
            resource: 'settings',
          } as CommandEvent
          return jsonResponse({ revision: 51, event })
        }
        if (url === '/api/v1/commands/settings/advanced') {
          return advancedCommand.promise
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const oldCustomModels = [{ id: 'old-model', name: 'Old Model' }] as unknown as Database['customModels']
    const attemptedCustomModels = [{ id: 'attempted-model', name: 'Attempted Model' }]
    withTestDatabaseWrite(() => {
      getDatabase().customModels = oldCustomModels
      getDatabase().moduleIntergration = 'old-modules'
      getDatabase().plugins = [seedPlugin('plugin-a')]
      getDatabase().currentPluginProvider = 'plugin-a'
      getDatabase().pluginCustomStorage = {
        retained: { value: 1 },
      }
      getDatabase().modules = [seedModule('mod-a')]
    })
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      customModels: attemptedCustomModels,
      moduleIntergration: 'attempted-modules',
    })

    await vi.waitFor(() => {
      expect(captured).toHaveLength(2)
    })
    expect(getDatabase().customModels).toEqual(attemptedCustomModels)
    expect(getDatabase().moduleIntergration).toBe('attempted-modules')

    withTestDatabaseWrite(() => {
      getDatabase().plugins.push(
        seedPlugin('plugin-newer', {
          realArg: { mode: 'newer-plugin' },
        }),
      )
      getDatabase().currentPluginProvider = 'plugin-newer'
      getDatabase().pluginCustomStorage.newerStorage = { value: 'kept' }
      getDatabase().modules.push(seedModule('mod-newer', { description: 'newer module' }))
    })
    advancedCommand.resolve(jsonResponse({ error: 'forced advanced failure' }, 500))

    await vi.waitFor(() => {
      expect(getDatabase().moduleIntergration).toBe('old-modules')
    })

    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/settings/providers',
      method: 'PATCH',
      body: {
        baseRevision: 50,
        patch: {
          customModels: attemptedCustomModels,
        },
      },
    })
    expect(captured[1]).toMatchObject({
      url: '/api/v1/commands/settings/advanced',
      method: 'PATCH',
      body: {
        baseRevision: 51,
        patch: {
          moduleIntergration: 'attempted-modules',
        },
      },
    })
    expect(getDatabase().customModels).toEqual(attemptedCustomModels)
    expect(getDatabase().plugins).toEqual([
      seedPlugin('plugin-a'),
      seedPlugin('plugin-newer', {
        realArg: { mode: 'newer-plugin' },
      }),
    ])
    expect(getDatabase().currentPluginProvider).toBe('plugin-newer')
    expect(getDatabase().pluginCustomStorage).toEqual({
      retained: { value: 1 },
      newerStorage: { value: 'kept' },
    })
    expect(getDatabase().modules).toEqual([
      seedModule('mod-a'),
      seedModule('mod-newer', { description: 'newer module' }),
    ])
  })

  it('routes plugin custom model and advanced database writes through settings commands', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      customModels: [{ id: 'xcustom:::a', name: 'Model A', key: 'secret' }],
      banCharacterset: ['Latn'],
      allowAllExtentionFiles: true,
      auxModelUnderModelSettings: true,
      pluginDevelopMode: true,
    })

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/settings/providers')).toBe(true)
      expect(calls.some((call) => call.url === '/api/v1/commands/settings/advanced')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/settings/providers')).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: {
          customModels: [{ id: 'xcustom:::a', name: 'Model A', key: 'secret' }],
        },
      },
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/settings/advanced')).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: 11,
        patch: {
          banCharacterset: ['Latn'],
          allowAllExtentionFiles: true,
          auxModelUnderModelSettings: true,
          pluginDevelopMode: true,
        },
      },
    })
    expect(calls.some((call) => call.url.includes('/api/v1/commands/plugin-storage'))).toBe(false)
  })

  it('routes plugin module database writes through module commands', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      modules: [seedModule('mod-a', { description: 'updated' }), seedModule('mod-b', { description: 'new module' })],
      enabledModules: ['mod-b'],
    })

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/modules/mod-a')).toBe(true)
      expect(calls.some((call) => call.url === '/api/v1/commands/modules')).toBe(true)
      expect(calls.some((call) => call.url === '/api/v1/commands/modules/enable')).toBe(true)
    })
    // The module patch dispatchers route through runOptimisticCommandSequence.
    // Within one sequencer, each command awaits the previous response, so
    // baseRevision is read from cache after each result, not from the bootstrap.
    expect(calls.find((call) => call.url === '/api/v1/commands/modules/mod-a')).toMatchObject({
      method: 'PATCH',
      body: {
        baseRevision: expect.any(Number),
        patch: expect.objectContaining({ description: 'updated' }),
      },
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/modules')).toMatchObject({
      method: 'POST',
      body: {
        baseRevision: expect.any(Number),
        module: expect.objectContaining({ id: 'mod-b', description: 'new module' }),
      },
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/modules/enable')).toMatchObject({
      method: 'POST',
      body: {
        baseRevision: expect.any(Number),
        moduleId: 'mod-b',
        enabled: true,
      },
    })
  })

  it('serializes module collection patch commands against advancing revisions', async () => {
    // dispatchModuleCollectionPatch fans out update/create/delete/reorder calls
    // against one optimistic snapshot. The sequencer must thread each returned
    // revision into the next command.
    let nextRevision = 100
    const captured: { url: string; body: { baseRevision?: number } }[] = []
    const reconciledEventRevisions: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciledEventRevisions.push(events.map((event) => event.revision))
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: nextRevision })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, body })
        nextRevision += 1
        return jsonResponse({
          revision: nextRevision,
          event: {
            type: 'module.updated',
            revision: nextRevision,
            resource: 'module',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().modules = [seedModule('mod-a')]
    getDatabase().enabledModules = []
    const apis = getV2PluginAPIs()

    // Only patch `modules` (not enabledModules) so the assertion sees a
    // single sequencer drain in deterministic order.
    apis.setDatabaseLite({
      modules: [seedModule('mod-a', { description: 'updated' }), seedModule('mod-b', { description: 'new module' })],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(2)
      expect(reconciledEventRevisions).toEqual([[101, 102]])
    })
    expect(captured[0].url).toBe('/api/v1/commands/modules/mod-a')
    expect(captured[0].body?.baseRevision).toBe(100)
    expect(captured[1].url).toBe('/api/v1/commands/modules')
    // The second command reads the revision from cache after the first command
    // returns.
    expect(captured[1].body?.baseRevision).toBe(101)
  })

  it('preserves newer module edits when a plugin DB module patch fails', async () => {
    const moduleCommand = createDeferred<Response>()
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 150 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/commands/modules/mod-a') {
          return moduleCommand.promise
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    getDatabase().modules = [seedModule('mod-a', { description: 'old description' })]
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      modules: [seedModule('mod-a', { description: 'attempted description' })],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(1)
    })
    expect(getDatabase().modules[0].description).toBe('attempted description')

    withTestDatabaseWrite(() => {
      getDatabase().modules[0] = {
        ...getDatabase().modules[0],
        description: 'newer description',
      }
    })
    moduleCommand.resolve(jsonResponse({ error: 'failed module patch' }, 500))

    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/modules/mod-a',
      method: 'PATCH',
      body: {
        baseRevision: 150,
        patch: expect.objectContaining({
          description: 'attempted description',
        }),
      },
    })
    expect(getDatabase().modules[0].description).toBe('newer description')
  })

  it('serializes plugin collection create/update/delete commands against advancing revisions', async () => {
    let nextRevision = 300
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    const reconciledEventRevisions: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciledEventRevisions.push(events.map((event) => event.revision))
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: nextRevision })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        nextRevision += 1
        return jsonResponse({
          revision: nextRevision,
          event: {
            type: 'plugin.updated',
            revision: nextRevision,
            resource: 'plugin',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().plugins = [seedPlugin('plugin-a'), seedPlugin('plugin-c')]
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      plugins: [
        seedPlugin('plugin-a', { displayName: 'Updated A' }),
        seedPlugin('plugin-b', { displayName: 'Plugin B' }),
      ],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(3)
      expect(reconciledEventRevisions).toEqual([[301, 302, 303]])
    })
    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-a',
      method: 'PATCH',
      body: {
        baseRevision: 300,
        patch: expect.objectContaining({ displayName: 'Updated A' }),
      },
    })
    expect(captured[0].body.patch).not.toHaveProperty('name')
    expect(captured[1]).toMatchObject({
      url: '/api/v1/commands/plugins',
      method: 'POST',
      body: {
        baseRevision: 301,
        plugin: expect.objectContaining({ name: 'plugin-b', displayName: 'Plugin B' }),
      },
    })
    expect(captured[2]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-c',
      method: 'DELETE',
      body: {
        baseRevision: 302,
      },
    })
    expect(captured.some((call) => call.url === '/api/v1/commands/plugins/reorder')).toBe(false)
  })

  it('serializes plugin collection reorder commands against advancing revisions', async () => {
    let nextRevision = 400
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: nextRevision })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        nextRevision += 1
        return jsonResponse({
          revision: nextRevision,
          event: {
            type: 'plugin.updated',
            revision: nextRevision,
            resource: 'plugin',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().plugins = [seedPlugin('plugin-a'), seedPlugin('plugin-b'), seedPlugin('plugin-c')]
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      plugins: [seedPlugin('plugin-c', { displayName: 'Updated C' }), seedPlugin('plugin-b')],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(3)
    })
    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-c',
      method: 'PATCH',
      body: {
        baseRevision: 400,
        patch: expect.objectContaining({ displayName: 'Updated C' }),
      },
    })
    expect(captured[1]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-a',
      method: 'DELETE',
      body: {
        baseRevision: 401,
      },
    })
    expect(captured[2]).toMatchObject({
      url: '/api/v1/commands/plugins/reorder',
      method: 'POST',
      body: {
        baseRevision: 402,
        pluginIds: ['plugin-c', 'plugin-b'],
      },
    })
  })

  it('rolls back plugin collection replacement when a sequenced command fails and skips later commands', async () => {
    const previousPlugins = [seedPlugin('plugin-a'), seedPlugin('plugin-c')]
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 500 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (captured.length === 1) {
          return jsonResponse({ error: 'failed plugin update' }, 500)
        }
        return jsonResponse({
          revision: 501,
          event: {
            type: 'plugin.updated',
            revision: 501,
            resource: 'plugin',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().plugins = previousPlugins
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      plugins: [
        seedPlugin('plugin-a', { displayName: 'Updated A' }),
        seedPlugin('plugin-b', { displayName: 'Plugin B' }),
      ],
    })

    await vi.waitFor(() => {
      expect(getDatabase().plugins).toEqual(previousPlugins)
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-a',
      method: 'PATCH',
      body: {
        baseRevision: 500,
      },
    })
    expect(captured.some((call) => call.url === '/api/v1/commands/plugins')).toBe(false)
    expect(captured.some((call) => call.url === '/api/v1/commands/plugins/plugin-c')).toBe(false)
  })

  it('rolls back failed plugin DB bridge collection effects without clobbering concurrent plugin, storage, or provider edits', async () => {
    const firstCommand = createDeferred<Response>()
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 600 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (captured.length === 1) {
          return firstCommand.promise
        }
        return jsonResponse({
          revision: 601,
          event: {
            type: 'plugin.updated',
            revision: 601,
            resource: 'plugin',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().plugins = [
      seedPlugin('plugin-a'),
      seedPlugin('plugin-c', { displayName: 'Plugin C' }),
      seedPlugin('plugin-d', { script: 'Risuai.log("old d")' }),
    ]
    getDatabase().currentPluginProvider = 'plugin-a'
    getDatabase().pluginCustomStorage = {
      retained: { value: 1 },
    }
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      plugins: [
        seedPlugin('plugin-b', { displayName: 'Created B' }),
        seedPlugin('plugin-d', {
          script: 'Risuai.log("attempted d")',
          displayName: 'Attempted D',
        }),
        seedPlugin('plugin-a'),
      ],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(1)
    })
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-b', 'plugin-d', 'plugin-a'])

    withTestDatabaseWrite(() => {
      const pluginDIndex = getDatabase().plugins.findIndex((plugin) => plugin.name === 'plugin-d')
      getDatabase().plugins[pluginDIndex] = {
        ...getDatabase().plugins[pluginDIndex],
        script: 'Risuai.log("newer d")',
      }
      getDatabase().currentPluginProvider = 'plugin-d'
      getDatabase().pluginCustomStorage.newerStorage = { value: 'kept' }
    })
    firstCommand.resolve(jsonResponse({ error: 'failed plugin create' }, 500))

    await vi.waitFor(() => {
      expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-c', 'plugin-d'])
    })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/plugins',
      method: 'POST',
      body: {
        baseRevision: 600,
        plugin: expect.objectContaining({ name: 'plugin-b', displayName: 'Created B' }),
      },
    })
    expect(getDatabase().plugins).toEqual([
      seedPlugin('plugin-a'),
      seedPlugin('plugin-c', { displayName: 'Plugin C' }),
      seedPlugin('plugin-d', { script: 'Risuai.log("newer d")' }),
    ])
    expect(getDatabase().currentPluginProvider).toBe('plugin-d')
    expect(getDatabase().pluginCustomStorage).toEqual({
      retained: { value: 1 },
      newerStorage: { value: 'kept' },
    })
  })

  it('keeps successful plugin collection steps when a later create fails', async () => {
    const secondCommand = createDeferred<Response>()
    const captured: { url: string; method: string; body: { baseRevision?: number; [key: string]: unknown } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: 700 })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, method: init.method ?? 'GET', body })
        if (captured.length === 1) {
          return jsonResponse({
            revision: 701,
            event: {
              type: 'plugin.updated',
              revision: 701,
              resource: 'plugin',
              id: 'plugin-d',
            } as unknown as CommandEvent,
          })
        }
        return secondCommand.promise
      }) as unknown as typeof fetch,
    )

    getDatabase().plugins = [
      seedPlugin('plugin-a'),
      seedPlugin('plugin-d', {
        script: 'Risuai.log("old d")',
        displayName: 'Old D',
      }),
    ]
    getDatabase().currentPluginProvider = 'plugin-a'
    getDatabase().pluginCustomStorage = {
      retained: { value: 1 },
    }
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      plugins: [
        seedPlugin('plugin-a'),
        seedPlugin('plugin-d', {
          script: 'Risuai.log("attempted d")',
          displayName: 'Attempted D',
        }),
        seedPlugin('plugin-b', { displayName: 'Created B' }),
      ],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(2)
    })
    expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-d', 'plugin-b'])

    withTestDatabaseWrite(() => {
      getDatabase().currentPluginProvider = 'plugin-d'
      getDatabase().pluginCustomStorage.newerStorage = { value: 'kept' }
    })
    secondCommand.resolve(jsonResponse({ error: 'failed plugin create' }, 500))

    await vi.waitFor(() => {
      expect(getDatabase().plugins.map((plugin) => plugin.name)).toEqual(['plugin-a', 'plugin-d'])
    })

    expect(captured[0]).toMatchObject({
      url: '/api/v1/commands/plugins/plugin-d',
      method: 'PATCH',
      body: {
        baseRevision: 700,
        patch: expect.objectContaining({
          script: 'Risuai.log("attempted d")',
          displayName: 'Attempted D',
        }),
      },
    })
    expect(captured[1]).toMatchObject({
      url: '/api/v1/commands/plugins',
      method: 'POST',
      body: {
        baseRevision: 701,
        plugin: expect.objectContaining({ name: 'plugin-b', displayName: 'Created B' }),
      },
    })
    expect(getDatabase().plugins).toEqual([
      seedPlugin('plugin-a'),
      seedPlugin('plugin-d', {
        script: 'Risuai.log("attempted d")',
        displayName: 'Attempted D',
      }),
    ])
    expect(getDatabase().currentPluginProvider).toBe('plugin-d')
    expect(getDatabase().pluginCustomStorage).toEqual({
      retained: { value: 1 },
      newerStorage: { value: 'kept' },
    })
  })

  it('serializes enabled-modules diff commands against advancing revisions', async () => {
    // dispatchEnabledModulesPatch fans out N enable/disable calls against one
    // optimistic snapshot. The sequencer must thread each returned revision into
    // the next command.
    let nextRevision = 200
    const captured: { url: string; body: { baseRevision?: number } }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') {
          return jsonResponse({ revision: nextRevision })
        }
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        captured.push({ url, body })
        nextRevision += 1
        return jsonResponse({
          revision: nextRevision,
          event: {
            type: 'module.enabled',
            revision: nextRevision,
            resource: 'module',
          } as unknown as CommandEvent,
        })
      }) as unknown as typeof fetch,
    )

    getDatabase().modules = [seedModule('mod-a'), seedModule('mod-b')]
    getDatabase().enabledModules = ['mod-a']
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      enabledModules: ['mod-b'],
    })

    await vi.waitFor(() => {
      expect(captured.length).toBe(2)
    })
    expect(captured.every((c) => c.url === '/api/v1/commands/modules/enable')).toBe(true)
    expect(captured[0].body?.baseRevision).toBe(200)
    // Second enable command reads the cached revision returned by the first.
    expect(captured[1].body?.baseRevision).toBe(201)
  })

  it('keeps unknown plugin database keys on plugin storage commands', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({ customPluginKey: { value: 1 } })

    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/plugin-storage/bulk')).toBe(true)
    })
    expect(calls.find((call) => call.url === '/api/v1/commands/plugin-storage/bulk')).toMatchObject({
      method: 'POST',
      body: {
        baseRevision: 10,
        values: { customPluginKey: { value: 1 } },
      },
    })
    expect(getDatabase().pluginCustomStorage.customPluginKey).toEqual({ value: 1 })
  })

  it('rejects undefined database values before changing the live projection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    getDatabase().customCSS = 'body { color: red; }'

    apis.setDatabaseLite({ customCSS: undefined })

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(getDatabase().customCSS).toBe('body { color: red; }')
    expect(calls.some((call) => call.url.includes('/api/v1/commands/'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('customCSS'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('undefined'))
    warn.mockRestore()
  })

  it('routes selected model preset fields through the preset mirror', async () => {
    const calls = stubCommandFetch()
    setDatabaseLite({
      ...getDatabase(),
      currentPluginProvider: 'old-provider',
      temperature: 0.2,
      maxContext: 4096,
      modelPresetsId: 0,
      modelPresets: [
        {
          id: 'model-a',
          name: 'Model A',
          currentPluginProvider: 'old-provider',
          temperature: 0.2,
          maxContext: 4096,
        },
      ],
      promptPresetsId: -1,
      promptPresets: [],
    } as any)
    const apis = getV2PluginAPIs()

    await apis.setDatabaseLite({
      currentPluginProvider: 'new-provider',
      temperature: 0.9,
    })

    expect(getDatabase().modelPresets[0]).toMatchObject({
      currentPluginProvider: 'new-provider',
      temperature: 0.9,
    })
    expect(calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-a')).toHaveLength(1)
    expect(calls.find((call) => call.url === '/api/v1/commands/model-presets/model-a')).toMatchObject({
      method: 'PATCH',
      body: {
        patch: {
          currentPluginProvider: 'new-provider',
          temperature: 0.9,
        },
      },
    })
    expect(calls.some((call) => call.url === '/api/v1/commands/plugins/provider')).toBe(false)
    expect(calls.some((call) => call.url.startsWith('/api/v1/commands/settings/'))).toBe(false)

    const unrelatedEdit = updateModelPreset(0, { maxContext: 8192 })
    expect(getDatabase().temperature).toBe(0.9)
    expect(getDatabase().currentPluginProvider).toBe('new-provider')
    await unrelatedEdit
  })

  it('blocks recognized resource families (in allowedDbKeys) in server mode without persisting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    getDatabase().characters = [{ chaId: 'char-a', name: 'Ada', chats: [], chatPage: 0 }] as any

    apis.setDatabaseLite({ characters: [{ chaId: 'char-b', name: 'Grace' }] })

    await new Promise((resolve) => setTimeout(resolve, 30))

    // No projection change, no plugin-storage shadow, no command dispatched.
    expect(getDatabase().characters).toEqual([{ chaId: 'char-a', name: 'Ada', chats: [], chatPage: 0 }])
    expect(getDatabase().pluginCustomStorage.characters).toBeUndefined()
    expect(calls.some((call) => call.url.includes('/api/v1/commands/'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('characters'))
    warn.mockRestore()
  })

  it('blocks omitted documented keys (not in allowedDbKeys) instead of shadowing plugin storage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({
      botPresets: [{ id: 'preset-a' }],
      loreBook: [{ id: 'lore-a', data: [] }],
    })

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(getDatabase().pluginCustomStorage.botPresets).toBeUndefined()
    expect(getDatabase().pluginCustomStorage.loreBook).toBeUndefined()
    expect(calls.some((call) => call.url.includes('/api/v1/commands/plugin-storage'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('botPresets'))
    warn.mockRestore()
  })

  it('blocks pluginV2 database writes in server mode instead of dropping or shadowing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()

    apis.setDatabaseLite({ pluginV2: [{ name: 'legacy-v2' }] })

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect((getDatabase() as any).pluginV2).toBeUndefined()
    expect(getDatabase().pluginCustomStorage.pluginV2).toBeUndefined()
    expect(calls.some((call) => call.url.includes('/api/v1/commands/'))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pluginV2'))
    warn.mockRestore()
  })

  it('does not expose server-owned resource shadows through V2 getDatabase in server mode', () => {
    const apis = getV2PluginAPIs()
    getDatabase().characters = [{ chaId: 'char-a', name: 'Ada', chats: [], chatPage: 0 }] as any
    getDatabase().pluginCustomStorage = {
      characters: [{ chaId: 'shadow-char', name: 'Shadow' }],
      pluginV2: [{ name: 'shadow-v2' }],
      botPresets: [{ id: 'shadow-preset' }],
      customPluginKey: 'visible',
    }

    const safeDb = apis.getDatabase() as any

    expect(safeDb.characters).toEqual([{ chaId: 'char-a', name: 'Ada', chats: [], chatPage: 0 }])
    expect(safeDb.pluginV2).toBeUndefined()
    expect(safeDb.botPresets).toBeUndefined()
    expect(safeDb.customPluginKey).toBe('visible')
    expect(Object.keys(safeDb)).toContain('customPluginKey')
    expect(Object.keys(safeDb)).not.toContain('pluginV2')
    expect(Object.keys(safeDb)).not.toContain('botPresets')
  })

  it('pluginStorage.getItem clones only the selected key without a whole-DB snapshot', () => {
    const apis = getV2PluginAPIs()
    const largeBody = 'x'.repeat(80_000)
    getDatabase().characters = [
      {
        chaId: 'char-a',
        chats: [
          {
            id: 'chat-a',
            message: [{ role: 'user', data: largeBody, chatId: 'msg-a' }],
          },
        ],
      },
    ] as any
    getDatabase().pluginCustomStorage = {
      selected: { nested: { count: 1 }, list: ['kept'] },
      unrelated: { blob: largeBody },
    }
    const unrelatedStorageSize = JSON.stringify(getDatabase().pluginCustomStorage.unrelated).length
    const charactersSize = JSON.stringify(getDatabase().characters).length

    const stats = withPluginStorageCloneStats(
      () =>
        apis.pluginStorage.getItem('selected') as {
          nested: { count: number }
          list: string[]
        },
    )

    expect(stats.structuredCloneCount).toBe(1)
    expect(stats.totalCloneCount).toBe(1)
    expect(stats.maxClonedSize).toBeLessThan(unrelatedStorageSize)
    expect(stats.maxClonedSize).toBeLessThan(charactersSize)
    expect(stats.result).toEqual({ nested: { count: 1 }, list: ['kept'] })
    expect(stats.result).not.toBe(getDatabase().pluginCustomStorage.selected)

    stats.result.nested.count = 2
    stats.result.list.push('changed')
    expect(getDatabase().pluginCustomStorage.selected).toEqual({
      nested: { count: 1 },
      list: ['kept'],
    })
  })

  it('pluginStorage.getItem preserves missing scalar and falsey results', () => {
    const apis = getV2PluginAPIs()
    getDatabase().pluginCustomStorage = {
      empty: '',
      zero: 0,
      disabled: false,
      text: 'stored',
      nullValue: null,
    }

    expect(apis.pluginStorage.getItem('empty')).toBe('')
    expect(apis.pluginStorage.getItem('zero')).toBe(0)
    expect(apis.pluginStorage.getItem('disabled')).toBe(false)
    expect(apis.pluginStorage.getItem('text')).toBe('stored')
    expect(apis.pluginStorage.getItem('nullValue')).toBeNull()
    expect(apis.pluginStorage.getItem('missing')).toBeNull()

    setDatabaseLite({
      currentPluginProvider: 'old-provider',
      pluginCompatibilityMode: false,
      plugins: [seedPlugin('plugin-a')],
      modules: [seedModule('mod-a')],
      enabledModules: [],
    } as any)
    expect(Object.prototype.hasOwnProperty.call(getDatabase(), 'pluginCustomStorage')).toBe(false)
    expect(apis.pluginStorage.getItem('missing')).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(getDatabase(), 'pluginCustomStorage')).toBe(false)
  })

  it('pluginStorage.getItem detaches array values from live plugin storage', () => {
    const apis = getV2PluginAPIs()
    getDatabase().pluginCustomStorage = {
      arrayValue: [{ label: 'live' }],
    }

    const value = apis.pluginStorage.getItem('arrayValue') as Array<{ label: string }>

    expect(value).toEqual([{ label: 'live' }])
    expect(value).not.toBe(getDatabase().pluginCustomStorage.arrayValue)
    value[0].label = 'mutated'
    value.push({ label: 'new' })
    expect(getDatabase().pluginCustomStorage.arrayValue).toEqual([{ label: 'live' }])
  })

  it('disables device-local plugin storage APIs by default in server mode', async () => {
    const apis = getV2PluginAPIs()
    const localPluginStorage = new SafeLocalPluginStorage()

    expect(() => apis.safeLocalStorage.getItem('device')).toThrow(/Device-local plugin storage is disabled/)
    expect(() => apis.safeIdbFactory.open('device')).toThrow(/Device-local plugin storage is disabled/)
    await expect(localPluginStorage.getItem('device')).rejects.toThrow(/Device-local plugin storage is disabled/)
  })

  it('restores device-local plugin storage APIs when compatibility mode is enabled', () => {
    const apis = getV2PluginAPIs()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size
      },
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    })
    const open = vi.fn(() => ({}) as IDBOpenDBRequest)
    vi.stubGlobal('indexedDB', {
      open,
      cmp: vi.fn(() => 0),
    })
    getDatabase().pluginCompatibilityMode = true

    apis.safeLocalStorage.setItem('device', 'enabled')

    expect(apis.safeLocalStorage.getItem('device')).toBe('enabled')
    expect(() => apis.safeIdbFactory.open('device')).not.toThrow()
    expect(open).toHaveBeenCalledWith('safe_plugin_device', undefined)
  })
})

describe('connected reader plugin compatibility boundary', () => {
  it('blocks setters and storage proxies before command-unavailable local fallbacks', async () => {
    const calls = stubCommandFetch()
    const apis = getV2PluginAPIs()
    const proxy = apis.getDatabase()
    const localStorageSet = apis.safeLocalStorage.setItem
    const before = JSON.stringify(getDatabase())
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    clearCachedServerCommandRevision()
    for (const mutate of [
      () => apis.setChar({ chaId: 'char-a', name: 'changed' }),
      () => apis.setArg('plugin-a::arg', 'changed'),
      () => apis.setDatabaseLite({ aiModel: 'changed', pluginCustomStorage: { key: 'changed' } }),
      () => apis.pluginStorage.setItem('key', 'changed'),
      () => apis.pluginStorage.removeItem('key'),
      () => apis.pluginStorage.clear(),
      () => localStorageSet('key', 'changed'),
      () => {
        proxy.customKey = 'changed'
      },
    ])
      expect(mutate).toThrow('client_write_access_required')
    await expect(apis.setDatabase({ aiModel: 'changed' })).rejects.toThrow('client_write_access_required')
    await loadPlugins()
    expect(JSON.stringify(getDatabase())).toBe(before)
    expect(calls).toHaveLength(0)
    expect(loadV3Plugins).not.toHaveBeenCalled()
  })

  it('fences retained provider, hook and timer callbacks across writer loss and reacquisition', async () => {
    const operation = beginClientSession('writer')
    authorizeClientWriterRecovery(operation, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    completeClientWriterRecovery(operation)
    const apis = getV2PluginAPIs()
    const effect = vi.fn(async () => ({ success: true, content: 'changed' }))
    apis.addProvider('reader-test-provider', effect)
    const retained = pluginV2.providers.get('reader-test-provider')!
    const hook = vi.fn(() => 'changed')
    apis.addRisuScriptHandler('display', hook)
    const retainedHook = [...pluginV2.editdisplay].at(-1)!
    const timer = vi.fn()
    apis.getSafeGlobalThis().setTimeout(timer, 0)
    demoteClientSession()
    expect(() => retained({} as any)).toThrow('client_write_access_required')
    expect(() => retainedHook('source')).toThrow('client_write_access_required')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(timer).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
    const renewed = beginClientSession('writer')
    authorizeClientWriterRecovery(renewed, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 2 } })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    completeClientWriterRecovery(renewed)
    expect(() => retained({} as any)).toThrow('Plugin client session is no longer active')
    pluginV2.providers.delete('reader-test-provider')
    pluginV2.editdisplay.delete(retainedHook)
  })
})

it('does not dispatch plugin fetch after permission returns to a demoted writer', async () => {
  const operation = beginClientSession('writer')
  authorizeClientWriterRecovery(operation, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  completeClientWriterRecovery(operation)
  const permission = createDeferred<boolean>()
  pluginPermissionMocks.getPluginPermission.mockReturnValueOnce(permission.promise)
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const apis = getV2PluginAPIs(seedPlugin('plugin-a'))
  const request = apis.nativeFetch('https://example.com')
  await vi.waitFor(() => expect(pluginPermissionMocks.getPluginPermission).toHaveBeenCalled())
  demoteClientSession()
  permission.resolve(true)
  await expect(request).rejects.toThrow('client_write_access_required')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('fences a provider result that completes after writer loss', async () => {
  const operation = beginClientSession('writer')
  authorizeClientWriterRecovery(operation, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  completeClientWriterRecovery(operation)
  const result = createDeferred<{ success: boolean; content: string }>()
  let cleanup = () => {}
  const apis = getV2PluginAPIs(undefined, undefined, (dispose) => {
    cleanup = dispose
  })
  apis.addProvider('late-provider', () => result.promise)
  const request = pluginV2.providers.get('late-provider')!({} as any)
  demoteClientSession()
  result.resolve({ success: true, content: 'obsolete' })
  await expect(request).rejects.toThrow('client_write_access_required')
  cleanup()
  expect(pluginV2.providers.has('late-provider')).toBe(false)
})
