import {
  beginClientSession,
  settleClientReader,
  setClientConnectionState,
  setClientProjectionReady,
  authorizeClientWriterRecovery,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../../clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const { makeStore, mockDbState, mockPluginV2, mockCustomProviderStore, mockSelectedCharID, mockServerCommands } =
  vi.hoisted(() => {
    const makeStore = <T>(initial: T) => {
      let value = initial
      return {
        get value() {
          return value
        },
        subscribe(run: (value: T) => void) {
          run(value)
          return () => {}
        },
        set(next: T) {
          value = next
        },
        update(updater: (value: T) => T) {
          value = updater(value)
        },
      }
    }
    const mockCustomProviderStore = makeStore([] as string[])
    const mockSelectedCharID = makeStore('char-a')
    const mockPluginV2 = {
      providers: new Map(),
      providerOptions: new Map(),
      editdisplay: new Set(),
      editoutput: new Set(),
      editprocess: new Set(),
      editinput: new Set(),
      replacerbeforeRequest: new Set(),
      replacerafterRequest: new Set(),
      unload: new Set(),
      loaded: false,
    }
    const mockDbState = {
      db: {
        plugins: [],
        characters: {},
        aiModel: 'test-model',
        pluginCustomStorage: {},
        currentPluginProvider: '',
      },
    }
    const mockServerCommands = {
      canUse: false,
    }
    return { makeStore, mockDbState, mockPluginV2, mockCustomProviderStore, mockSelectedCharID, mockServerCommands }
  })

const mockPluginMCP = vi.hoisted(() => ({
  registerMCPModule: vi.fn(),
  unregisterMCPModule: vi.fn(),
}))

const mockLegacyPluginApis = vi.hoisted(() => ({
  setArg: vi.fn(async () => null),
}))

const mockChatHydration = vi.hoisted(() => ({
  ensureCharacterLorebookHydrated: vi.fn(async () => true),
  hydrateChatMessages: vi.fn(async () => undefined),
  isChatMessageTranscriptHydrated: vi.fn(() => false),
}))

const mockModuleLorebooks = vi.hoisted(() => ({ entries: [] as any[] }))

const mockInlays = vi.hoisted(() => ({ getInlayAsset: vi.fn() }))

const mockResolvedModelState = vi.hoisted(() => ({ id: 'openai' }))

const mockPermissionForage = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
})

vi.mock('../plugins.svelte', () => ({
  allowedDbKeys: [],
  customProviderStore: mockCustomProviderStore,
  getV2PluginAPIs: () => ({
    risuFetch: vi.fn(),
    nativeFetch: vi.fn(),
    getChar: vi.fn(),
    setChar: vi.fn(),
    setDatabaseLite: vi.fn(),
    setDatabase: vi.fn(),
    loadPlugins: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    getArg: vi.fn(),
    setArg: mockLegacyPluginApis.setArg,
    addRisuScriptHandler: vi.fn(),
    removeRisuScriptHandler: vi.fn(),
    addRisuReplacer: vi.fn(),
    removeRisuReplacer: vi.fn(),
    pluginStorage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      keys: vi.fn(),
      length: vi.fn(),
    },
    safeLocalStorage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      keys: vi.fn(),
      length: vi.fn(),
    },
  }),
  handlePluginInstallViaPlugin: vi.fn(),
  isPluginRuntimeReady: vi.fn(() => true),
  pluginV2: mockPluginV2,
}))

vi.mock('src/ts/stores.svelte', () => ({
  additionalChatMenu: [],
  additionalFloatingActionButtons: [],
  additionalHamburgerMenu: [],
  additionalSettingsMenu: [],
  bodyIntercepterStore: [],
  chatPanelStore: [],
  hotReloading: makeStore(false),
  selectedCharID: mockSelectedCharID,
}))

vi.mock('../../stores.svelte', () => ({
  additionalChatMenu: [],
  additionalFloatingActionButtons: [],
  additionalHamburgerMenu: [],
  additionalSettingsMenu: [],
  bodyIntercepterStore: [],
  chatPanelStore: [],
  hotReloading: makeStore(false),
  selectedCharID: mockSelectedCharID,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
  getDatabase: () => mockDbState.db,
}))

vi.mock('../../storage/database.svelte', () => ({
  getCurrentCharacter: () => null,
  getDatabase: () => mockDbState.db,
  setDatabase: vi.fn(),
  setDatabaseLite: vi.fn(),
}))

vi.mock('src/ts/pluginCommands', () => ({
  currentPluginCollectionSnapshot: vi.fn(() => [...(mockDbState.db.plugins ?? [])]),
  currentPluginDatabaseSnapshot: vi.fn(() => JSON.parse(JSON.stringify(mockDbState.db))),
  currentPluginSettingsOwnerSnapshot: vi.fn((keys: readonly string[]) =>
    Object.fromEntries(keys.map((key) => [key, (mockDbState.db as any)[key]])),
  ),
  applyPluginSettingsOwnerPatch: vi.fn((patch: Record<string, unknown>) => Object.assign(mockDbState.db, patch)),
  rollbackPluginSettingsOwner: vi.fn((previous: Record<string, unknown>, attempted: Record<string, unknown>) => {
    const rolledBack: string[] = []
    for (const [key, value] of Object.entries(attempted)) {
      if (JSON.stringify((mockDbState.db as any)[key]) !== JSON.stringify(value)) continue
      ;(mockDbState.db as any)[key] = JSON.parse(JSON.stringify(previous[key]))
      rolledBack.push(key)
    }
    return rolledBack
  }),
  currentPluginCharacterSnapshot: vi.fn((index: number | string) => {
    const characters = mockDbState.db.characters as any
    const rows = Array.isArray(characters) ? characters : Object.values(characters)
    if (typeof index === 'number') return rows[index]
    return characters[index] ?? rows.find((character: any) => character?.chaId === index)
  }),
  currentPluginCharacterOwnerSnapshot: vi.fn((characterId: string) => {
    const characters = mockDbState.db.characters as any
    const rows = Array.isArray(characters) ? characters : Object.values(characters)
    const matches = rows.filter((character: any) => character?.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  }),
  currentPluginChatOwnerSnapshot: vi.fn((characterId: string, chatId: string) => {
    const characters = mockDbState.db.characters as any
    const rows = Array.isArray(characters) ? characters : Object.values(characters)
    const characterMatches = rows.filter((candidate: any) => candidate?.chaId === characterId)
    const chats = characterMatches.length === 1 ? (characterMatches[0].chats ?? []) : []
    const matches = chats.filter((chat: any) => chat?.id === chatId)
    return matches.length === 1 ? { characterId, chatId, chat: matches[0] } : undefined
  }),
  replacePluginCharacterOwnerAt: vi.fn((index: number | string, characterId: string, next: any) => {
    const characters = mockDbState.db.characters as any
    if (Array.isArray(characters)) {
      if (characters[index as number]?.chaId !== characterId) return false
      characters[index as number] = next
      return true
    }
    const key =
      typeof index === 'string' && characters[index]
        ? index
        : Object.keys(characters).find((candidate) => characters[candidate]?.chaId === characterId)
    if (!key || characters[key]?.chaId !== characterId) return false
    characters[key] = next
    return true
  }),
  replacePluginChatOwner: vi.fn((characterId: string, chatId: string, next: any) => {
    const characters = mockDbState.db.characters as any
    const rows = Array.isArray(characters) ? characters : Object.values(characters)
    const characterMatches = rows.filter((candidate: any) => candidate?.chaId === characterId)
    const chats = characterMatches.length === 1 ? (characterMatches[0].chats ?? []) : []
    const indexMatches = chats
      .map((chat: any, index: number) => ({ chat, index }))
      .filter(({ chat }: any) => chat?.id === chatId)
    if (characterMatches.length !== 1 || indexMatches.length !== 1) return false
    chats[indexMatches[0].index] = next
    return true
  }),
  replacePluginCollectionOwner: vi.fn((plugins: any[]) => {
    const current = mockDbState.db.plugins as any[]
    const previousRows = [...current]
    current.splice(0, current.length, ...plugins)
    for (let index = 0; index < current.length; index += 1) {
      const previous = previousRows[index]
      if (previous && typeof previous === 'object' && plugins[index] && typeof plugins[index] === 'object') {
        Object.assign(previous, plugins[index])
        current[index] = previous
      }
    }
    mockDbState.db.plugins = current
  }),
  currentPluginStateSnapshot: vi.fn(() => ({
    plugins: mockDbState.db.plugins ?? [],
    currentPluginProvider: mockDbState.db.currentPluginProvider ?? '',
    pluginCustomStorage: mockDbState.db.pluginCustomStorage ?? {},
  })),
  dispatchUpdatePlugin: vi.fn(),
}))

vi.mock('src/ts/server/commands', () => ({
  canUseServerCommands: () => mockServerCommands.canUse,
}))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  dispatchDurableServerBackedSettingsPatch: vi.fn(),
}))

vi.mock('src/ts/server/chatMessageHydration.svelte', () => mockChatHydration)

vi.mock('src/ts/characterCommands', () => ({
  CHARACTER_PATCH_EXCLUDED_KEYS: new Set([
    'chaId',
    'chats',
    'chatFolders',
    'globalLore',
    'customscript',
    'triggerscript',
    'scriptstate',
    'modules',
    'coldstorage',
    'coldStoragedChats',
  ]),
  currentCharacterRowSnapshot: vi.fn(() => ({})),
  prepareCompatibleCharacterUpdateScoped: vi.fn(() => ({
    factories: [],
    rollback: vi.fn(),
    dispatch: vi.fn(),
    dispatchAsync: vi.fn(async () => null),
  })),
}))

vi.mock('src/ts/chatCommands', () => ({
  appendCurrentChatUserMessageForSend: vi.fn(),
  captureActiveChatTarget: vi.fn(() => {
    const selectedCharacterKey = mockSelectedCharID.value
    const characters = mockDbState.db.characters as Record<string, any>
    const character = characters[selectedCharacterKey]
    const chatPage = character?.chatPage ?? 0
    const chat = character?.chats?.[chatPage]
    if (!character || !chat) return null
    const selectedCharID = Math.max(0, Object.keys(characters).indexOf(selectedCharacterKey))
    return {
      selectedCharID,
      chatPage,
      characterId: character.chaId,
      chatId: chat.id,
    }
  }),
  CHAT_PATCH_ALLOWED_KEYS: new Set([
    'name',
    'note',
    'sdData',
    'lastMemory',
    'suggestMessages',
    'bindedPersona',
    'fmIndex',
    'translatorPresetId',
    'autoTranslate',
    'autoTranslateBotOnly',
    'bilingualDisplay',
    'bilingualEmphasis',
    'folderId',
    'lastDate',
    'bookmarks',
    'bookmarkNames',
    'modules',
  ]),
  prepareCompatibleChatUpdateScoped: vi.fn(() => ({
    commandCount: 0,
    dispatch: vi.fn(),
    dispatchAsync: vi.fn(async () => null),
  })),
}))

vi.mock('../pluginSafeClass', () => ({
  SafeLocalPluginStorage: class SafeLocalPluginStorage {},
  assertDeviceLocalPluginStorageEnabled: vi.fn(),
  isDeviceLocalPluginStorageEnabled: () => false,
  tagWhitelist: ['div', 'a', 'span'],
}))

vi.mock('src/ts/util', () => ({
  sleep: () => Promise.resolve(),
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: vi.fn(async () => true),
  alertError: vi.fn(),
  alertNormal: vi.fn(),
}))

vi.mock('src/lang', () => ({
  language: {
    errors: { settingsSaveFailed: 'Settings save failed' },
    fetchLogConsent: '{}',
    getFullDatabaseConsent: '{}',
    mainDomAccessConsent: '{}',
    pluginNetworkConsent: 'network:{}',
    pluginUpdateSourceConsent: 'update:{{plugin}}:{{url}}',
    replacerPermissionConsent: '{}',
    providerPermissionConsent: '{}',
    sendChatConsent: '{}',
    v3RuntimeConsent: '{}',
    permissionDenied: 'Permission denied',
    pluginMutation: { failed: 'Plugin changes failed' },
  },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  checkCharOrder: vi.fn(),
  getFetchLogs: () => [],
}))

vi.mock('src/ts/gui/colorscheme', () => ({
  builtInColorSchemes: {
    dracula: {
      bgcolor: '#1',
      darkbg: '#2',
      borderc: '#3',
      selected: '#4',
      draculared: '#5',
      textcolor: '#6',
      textcolor2: '#7',
      darkBorderc: '#8',
      darkbutton: '#9',
      type: 'dark',
    },
  },
  updateColorScheme: vi.fn(),
  updateTextThemeAndCSS: vi.fn(),
}))

vi.mock('src/ts/process/mcp/pluginmcp', () => mockPluginMCP)

vi.mock('src/ts/translator/translator', () => ({
  getLLMCache: vi.fn(),
  searchLLMCache: vi.fn(),
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
  hasher: vi.fn(async (value: Uint8Array) => `hash:${new TextDecoder().decode(value)}`),
  risuChatParser: vi.fn((text: string) => text),
}))

vi.mock('localforage', () => ({
  default: {
    createInstance: () => mockPermissionForage,
  },
}))

vi.mock('src/ts/process/index.svelte', () => ({
  doingChat: makeStore(false),
  clearActiveGenerationAbortController: vi.fn(),
  createActiveGenerationAbortController: vi.fn(() => new AbortController()),
  sendChat: vi.fn(),
}))

vi.mock('src/ts/model/modellist', () => ({
  getModelInfo: () => ({ id: 'openai' }),
}))

vi.mock('src/ts/model/modelProfileResolver', () => ({
  resolveModelProfile: () => ({ modelInfo: { id: mockResolvedModelState.id } }),
  resolveModelProfileWithLegacyCompatibility: () => ({ modelInfo: { id: mockResolvedModelState.id } }),
}))

vi.mock('src/ts/process/request/request', () => ({
  requestChatDataMain: vi.fn(),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleLorebooks: () => mockModuleLorebooks.entries,
}))

vi.mock('src/ts/process/files/inlays', () => mockInlays)

vi.mock('src/ts/process/ttsHooks', () => ({
  registerTTSPreprocessor: vi.fn(),
  unregisterTTSPreprocessor: vi.fn(),
  registerTTSPostprocessor: vi.fn(),
  unregisterTTSPostprocessor: vi.fn(),
}))

import { customProviderStore, pluginV2 } from '../plugins.svelte'
import { alertConfirm } from 'src/ts/alert'
import { prepareCompatibleCharacterUpdateScoped } from 'src/ts/characterCommands'
import {
  additionalChatMenu,
  additionalFloatingActionButtons,
  additionalHamburgerMenu,
  additionalSettingsMenu,
  chatPanelStore,
} from 'src/ts/stores.svelte'
import { dispatchDurableServerBackedSettingsPatch } from 'src/ts/server/settingsOwner.svelte'
import {
  ensureCharacterLorebookHydrated,
  hydrateChatMessages,
  isChatMessageTranscriptHydrated,
} from 'src/ts/server/chatMessageHydration.svelte'
import { dispatchUpdatePlugin } from 'src/ts/pluginCommands'
import { updateColorScheme, updateTextThemeAndCSS } from 'src/ts/gui/colorscheme'
import { registerMCPModule, unregisterMCPModule } from 'src/ts/process/mcp/pluginmcp'
import { appendCurrentChatUserMessageForSend, prepareCompatibleChatUpdateScoped } from 'src/ts/chatCommands'
import { getInlayAsset } from 'src/ts/process/files/inlays'
import { sendChat as processSendChat } from 'src/ts/process/index.svelte'
import {
  acceptedSendRecoveries,
  resetAcceptedSendCoordinatorForTests,
} from 'src/ts/process/acceptedSendCoordinator.svelte'
import {
  __v3PluginLifecycleTestHooks,
  customV3ProviderMetaStore,
  executePluginV3,
  getV3PluginInstance,
  loadV3Plugins,
} from './v3.svelte'
import { SandboxHost } from './factory'
import { chatOutputListeners } from '../chatOutputListeners'

function seedV3Plugin(name: string) {
  return {
    name,
    script: '',
    arguments: {},
    realArg: {},
    version: '3.0',
    customLink: [],
    argMeta: {},
    enabled: true,
  } as any
}

function seedV3ChatBridge(plugin: ReturnType<typeof seedV3Plugin>): void {
  mockDbState.db.plugins = [plugin]
  mockDbState.db.characters = {
    'char-a': {
      chaId: 'char-a',
      chatPage: 0,
      chats: [{ id: 'chat-a', message: [] }],
    },
    'char-b': {
      chaId: 'char-b',
      chatPage: 0,
      chats: [{ id: 'chat-b', message: [] }],
    },
  }
}

function capturedPluginChatTarget() {
  return {
    selectedCharID: 0,
    chatPage: 0,
    characterId: 'char-a',
    chatId: 'chat-a',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function messageCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => call[0] === 'message')
}

function capturedSettingsRollback(): () => void {
  const rollback = vi.mocked(dispatchDurableServerBackedSettingsPatch).mock.calls.at(-1)?.[0].rollback
  expect(rollback).toEqual(expect.any(Function))
  return rollback as () => void
}

beforeEach(async () => {
  resetClientSessionForTests()
  // Happy DOM does not execute the nested guest frame; host handshake behavior
  // is covered by factory.test.ts and the real browser startup regression.
  vi.spyOn(SandboxHost.prototype, 'waitForInitialization').mockResolvedValue(undefined)
  document.body.innerHTML = ''
  mockServerCommands.canUse = false
  mockSelectedCharID.set('char-a')
  resetAcceptedSendCoordinatorForTests()
  mockDbState.db = {
    plugins: [],
    characters: {},
    aiModel: 'test-model',
    pluginCustomStorage: {},
    currentPluginProvider: '',
  }
  vi.mocked(prepareCompatibleCharacterUpdateScoped).mockClear()
  vi.mocked(prepareCompatibleChatUpdateScoped).mockClear()
  vi.mocked(hydrateChatMessages).mockReset()
  vi.mocked(hydrateChatMessages).mockResolvedValue(undefined)
  vi.mocked(ensureCharacterLorebookHydrated).mockReset()
  vi.mocked(ensureCharacterLorebookHydrated).mockResolvedValue(true)
  vi.mocked(isChatMessageTranscriptHydrated).mockReset()
  vi.mocked(isChatMessageTranscriptHydrated).mockReturnValue(false)
  vi.mocked(appendCurrentChatUserMessageForSend).mockReset()
  vi.mocked(processSendChat).mockReset()
  vi.mocked(dispatchUpdatePlugin).mockReset()
  vi.mocked(dispatchUpdatePlugin).mockResolvedValue(null)
  mockLegacyPluginApis.setArg.mockReset()
  mockLegacyPluginApis.setArg.mockResolvedValue(null)
  vi.mocked(dispatchDurableServerBackedSettingsPatch).mockReset()
  vi.mocked(dispatchDurableServerBackedSettingsPatch).mockResolvedValue({
    status: 'ok',
    revision: 1,
    event: { type: 'settings.updated', revision: 1, resource: 'settings' },
  })
  vi.mocked(updateColorScheme).mockReset()
  vi.mocked(updateTextThemeAndCSS).mockReset()
  vi.mocked(registerMCPModule).mockReset()
  vi.mocked(unregisterMCPModule).mockReset()
  vi.mocked(alertConfirm).mockReset()
  vi.mocked(alertConfirm).mockResolvedValue(true)
  mockPermissionForage.values.clear()
  mockPermissionForage.getItem.mockClear()
  mockPermissionForage.setItem.mockClear()
  mockPermissionForage.removeItem.mockClear()
  mockModuleLorebooks.entries = []
  mockResolvedModelState.id = 'openai'
  vi.mocked(getInlayAsset).mockReset()
  await __v3PluginLifecycleTestHooks.reset()
})

afterEach(async () => {
  resetClientSessionForTests()
  await __v3PluginLifecycleTestHooks.reset()
  vi.restoreAllMocks()
})

describe('V3 current lorebook entries', () => {
  it('hydrates and snapshots raw character, chat, and active-module entries in source order', async () => {
    const characterEntry = { id: 'character-lore', content: 'character' }
    const chatEntry = { id: 'chat-lore', content: 'chat' }
    const moduleEntry = { id: 'module-lore', content: 'module' }
    mockDbState.db.characters = {
      'char-a': {
        chaId: 'character-a',
        chatPage: 0,
        globalLore: [characterEntry],
        chats: [{ localLore: [chatEntry] }],
      },
    }
    mockModuleLorebooks.entries = [moduleEntry]
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    const result = await api.getCurrentLorebookEntries()

    expect(ensureCharacterLorebookHydrated).toHaveBeenCalledWith('character-a')
    expect(result).toEqual([characterEntry, chatEntry, moduleEntry])
    result[0].content = 'mutated snapshot'
    expect(characterEntry.content).toBe('character')
  })

  it('fails closed instead of returning a plausible empty character lorebook when hydration is unavailable', async () => {
    mockDbState.db.characters = {
      'char-a': {
        chaId: 'character-a',
        chatPage: 0,
        globalLore: [],
        chats: [{ localLore: [] }],
      },
    }
    vi.mocked(ensureCharacterLorebookHydrated).mockResolvedValueOnce(false)
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.getCurrentLorebookEntries()).rejects.toThrow('Current character lorebook is unavailable')
  })
})

describe('V3 inlay reads', () => {
  it('returns only the public plugin shape from the fork inlay reader', async () => {
    vi.mocked(getInlayAsset).mockResolvedValueOnce({
      data: 'data:image/png;base64,aGVsbG8=',
      ext: 'png',
      name: 'hello.png',
      type: 'image',
      width: 32,
      height: 16,
      serverAssetId: 'server-only-id',
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.readInlay('catalog-or-alias-id')).resolves.toEqual({
      data: 'data:image/png;base64,aGVsbG8=',
      ext: 'png',
      name: 'hello.png',
      type: 'image',
      width: 32,
      height: 16,
    })
    expect(getInlayAsset).toHaveBeenCalledWith('catalog-or-alias-id')
  })

  it('returns null when the catalog path cannot resolve an inlay', async () => {
    vi.mocked(getInlayAsset).mockResolvedValueOnce(null)
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.readInlay('missing')).resolves.toBeNull()
  })
})

describe('V3 durable setter acknowledgement', () => {
  it('resolves setArgument when the exact update is durably queued', async () => {
    mockServerCommands.canUse = true
    const plugin = seedV3Plugin('plugin-a')
    mockDbState.db.plugins = [plugin]
    vi.mocked(dispatchUpdatePlugin).mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'plugin-argument-queued',
      settlement: new Promise(() => {}),
    })
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    await expect(api.setArgument('api-key', 'queued-value')).resolves.toBeUndefined()
    expect(plugin.realArg['api-key']).toBe('queued-value')
  })

  it('keeps setArgument RPC pending and returns a terminal dispatcher failure to the guest', async () => {
    mockServerCommands.canUse = true
    const plugin = seedV3Plugin('plugin-a')
    mockDbState.db.plugins = [plugin]
    const persistence = deferred<any>()
    vi.mocked(dispatchUpdatePlugin).mockReturnValueOnce(persistence.promise)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin)
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const host = new SandboxHost(api)
    host.run(iframe, '')
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => undefined)

    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        data: {
          type: 'CALL_ROOT',
          reqId: 'set-argument',
          method: 'setArgument',
          args: ['api-key', 'new-value'],
        },
      }),
    )

    await vi.waitFor(() => expect(dispatchUpdatePlugin).toHaveBeenCalledOnce())
    expect(postMessage.mock.calls.some((call) => (call[0] as { reqId?: string }).reqId === 'set-argument')).toBe(false)

    persistence.resolve({
      status: 'failed',
      result: { status: 'error', error: 'argument rejected', reason: 'invalid-request' },
    })

    await vi.waitFor(() => {
      const response = postMessage.mock.calls.find(
        (call) => (call[0] as { reqId?: string }).reqId === 'set-argument',
      )?.[0] as { error?: string } | undefined
      expect(response?.error).toBe('argument rejected')
    })
    host.terminate()
  })

  it('awaits and translates the deprecated setArg persistence outcome', async () => {
    const plugin = seedV3Plugin('plugin-a')
    const persistence = deferred<any>()
    mockLegacyPluginApis.setArg.mockReturnValueOnce(persistence.promise)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    const result = api.setArg('plugin-a::api-key', 'new-value')
    expect(mockLegacyPluginApis.setArg).toHaveBeenCalledWith('plugin-a::api-key', 'new-value')
    persistence.resolve({
      status: 'failed',
      result: { status: 'error', error: 'deprecated argument rejected', reason: 'invalid-request' },
    })

    await expect(result).rejects.toThrow('deprecated argument rejected')
  })

  it('rejects a deprecated setArg result after its V3 instance becomes stale', async () => {
    const plugin = seedV3Plugin('plugin-a')
    const persistence = deferred<any>()
    mockLegacyPluginApis.setArg.mockReturnValueOnce(persistence.promise)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    const result = api.setArg('plugin-a::api-key', 'new-value')
    await __v3PluginLifecycleTestHooks.reset()
    persistence.resolve({ status: 'accepted', result: { status: 'ok', revision: 1 } })

    await expect(result).rejects.toThrow('Plugin instance is no longer active')
  })
})

describe('V3 character command bridge', () => {
  it('setCharacterToIndex applies the shared compatible optimistic row and awaits persistence', async () => {
    mockServerCommands.canUse = true
    const existingCharacter = {
      chaId: 'char-a',
      name: 'Old name',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
    }
    const optimisticCharacter = {
      chaId: 'char-a',
      name: 'New name',
      chats: existingCharacter.chats,
      globalLore: existingCharacter.globalLore,
    }
    const persistence = deferred<any>()
    const dispatchAsync = vi.fn(() => persistence.promise)
    mockDbState.db.characters = {
      0: existingCharacter,
    }
    vi.mocked(prepareCompatibleCharacterUpdateScoped).mockReturnValueOnce({
      characterId: 'char-a',
      patch: { name: 'New name' },
      optimisticCharacter,
      factories: [vi.fn()],
      rollback: vi.fn(),
      dispatch: vi.fn(),
      dispatchAsync,
    } as any)
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginCharacter = {
      chaId: 'char-a',
      name: 'New name',
      chats: existingCharacter.chats,
      globalLore: existingCharacter.globalLore,
    }

    let settled = false
    const mutation = api.setCharacterToIndex(0, pluginCharacter).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(prepareCompatibleCharacterUpdateScoped).toHaveBeenCalledWith(
      expect.objectContaining({ chaId: 'char-a' }),
      pluginCharacter,
      expect.anything(),
    )
    expect(mockDbState.db.characters[0]).toBe(optimisticCharacter)
    expect(mockDbState.db.characters[0]).not.toBe(pluginCharacter)
    expect(dispatchAsync).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    persistence.resolve({
      status: 'accepted',
      result: {
        status: 'ok',
        revision: 2,
        event: { type: 'character.updated', revision: 2, resource: 'character' },
      },
    })
    await mutation
    expect(settled).toBe(true)
  })

  it('setCharacterToIndex rejects unsupported character fields before projection mutation', async () => {
    mockServerCommands.canUse = true
    const existingCharacter = {
      chaId: 'char-a',
      name: 'Old name',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'old', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'old lore' }],
    }
    mockDbState.db.characters = {
      0: existingCharacter,
    }
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginCharacter = {
      ...existingCharacter,
      name: 'New name',
      chats: [{ id: 'chat-a', message: [{ role: 'user', data: 'changed', chatId: 'msg-a' }] }],
      globalLore: [{ key: 'changed lore' }],
    }

    await expect(api.setCharacterToIndex(0, pluginCharacter)).rejects.toThrow(
      /setCharacterToIndex cannot update unsupported character fields .*chats, globalLore/,
    )

    expect(mockDbState.db.characters[0]).toBe(existingCharacter)
    expect(prepareCompatibleCharacterUpdateScoped).not.toHaveBeenCalled()
  })

  it('setCharacter rejects when the current-character dispatcher reports terminal failure', async () => {
    mockServerCommands.canUse = true
    const existingCharacter = {
      chaId: 'char-a',
      name: 'Old name',
      chats: [],
    }
    const optimisticCharacter = { ...existingCharacter, name: 'New name' }
    mockDbState.db.characters = { 'char-a': existingCharacter }
    vi.mocked(prepareCompatibleCharacterUpdateScoped).mockReturnValueOnce({
      characterId: 'char-a',
      patch: { name: 'New name' },
      optimisticCharacter,
      factories: [vi.fn()],
      rollback: vi.fn(),
      dispatch: vi.fn(),
      dispatchAsync: vi.fn(async () => ({
        status: 'failed',
        result: { status: 'error', error: 'character rejected', reason: 'invalid-request' },
      })),
    } as any)
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.setCharacter(optimisticCharacter)).rejects.toThrow('character rejected')

    expect(mockDbState.db.characters['char-a']).toBe(optimisticCharacter)
  })
})

describe('V3 chat command bridge', () => {
  it('blocks sendChat when the resolved durable model is plugin-provided', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    mockDbState.db.aiModel = 'stale-flat-model'
    mockResolvedModelState.id = 'pluginmodel:::durable-provider'
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    await expect(api.sendChat('must not recurse')).rejects.toThrow(
      'Sending chat with plugin-based model is currently blocked',
    )
    expect(appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(processSendChat).not.toHaveBeenCalled()
  })

  it('sendChat rejects a stale target before append without starting generation', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    vi.mocked(appendCurrentChatUserMessageForSend).mockResolvedValueOnce({
      status: 'error',
      error: 'The active chat changed before the message could be appended.',
    })
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    const send = api.sendChat('stale before append')
    mockSelectedCharID.set('char-b')

    await expect(send).rejects.toThrow('The active chat changed before the message could be appended.')
    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledWith('stale before append', {
      expectedTarget: capturedPluginChatTarget(),
    })
    expect(processSendChat).not.toHaveBeenCalled()
  })

  it('sendChat keeps a deferred accepted append and generation on the captured target after navigation', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    const append = deferred<any>()
    vi.mocked(appendCurrentChatUserMessageForSend).mockReturnValueOnce(append.promise)
    vi.mocked(processSendChat).mockResolvedValueOnce(true)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    const send = api.sendChat('accepted in Chat A')
    await vi.waitFor(() => expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())
    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledWith('accepted in Chat A', {
      expectedTarget: capturedPluginChatTarget(),
    })

    mockSelectedCharID.set('char-b')
    append.resolve({ status: 'ok', messageId: 'msg-plugin' })

    await expect(send).resolves.toBe(true)
    expect(processSendChat).toHaveBeenCalledOnce()
    expect(processSendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: capturedPluginChatTarget() }),
    )
  })

  it('sendChat waits for one queued append and generates once for its captured target', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    const settlement = deferred<any>()
    vi.mocked(appendCurrentChatUserMessageForSend).mockResolvedValueOnce({
      status: 'queued',
      messageId: 'msg-plugin-queued',
      settlement: settlement.promise,
    })
    vi.mocked(processSendChat).mockResolvedValueOnce(true)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    let resolved = false
    const send = api.sendChat('queued from plugin').then((result: boolean) => {
      resolved = true
      return result
    })
    await vi.waitFor(() => expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())
    mockSelectedCharID.set('char-b')

    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledWith('queued from plugin', {
      expectedTarget: capturedPluginChatTarget(),
    })
    expect(processSendChat).not.toHaveBeenCalled()
    expect(resolved).toBe(false)

    settlement.resolve({ status: 'accepted' })
    await expect(send).resolves.toBe(true)

    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(processSendChat).toHaveBeenCalledTimes(1)
    expect(processSendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: capturedPluginChatTarget() }),
    )
  })

  it('sendChat reports false when a queued append settlement fails without retrying the append', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    vi.mocked(appendCurrentChatUserMessageForSend).mockResolvedValueOnce({
      status: 'queued',
      messageId: 'msg-plugin-queued-failure',
      settlement: Promise.resolve({
        status: 'failed',
        result: { status: 'unavailable' },
      }),
    })
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    await expect(api.sendChat('queued failure from plugin')).resolves.toBe(false)

    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledWith('queued failure from plugin', {
      expectedTarget: capturedPluginChatTarget(),
    })
    expect(processSendChat).not.toHaveBeenCalled()
    expect(get(acceptedSendRecoveries)).toEqual([])
  })

  it('sendChat reports false and retains coordinator recovery when generation fails', async () => {
    const plugin = seedV3Plugin('plugin-a')
    seedV3ChatBridge(plugin)
    vi.mocked(appendCurrentChatUserMessageForSend).mockResolvedValueOnce({
      status: 'ok',
      messageId: 'msg-plugin-failed-generation',
    })
    vi.mocked(processSendChat).mockResolvedValueOnce(false)
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any

    await expect(api.sendChat('generation fails')).resolves.toBe(false)

    expect(appendCurrentChatUserMessageForSend).toHaveBeenCalledWith('generation fails', {
      expectedTarget: capturedPluginChatTarget(),
    })
    expect(processSendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: capturedPluginChatTarget() }),
    )
    expect(get(acceptedSendRecoveries)).toEqual([
      expect.objectContaining({
        target: capturedPluginChatTarget(),
        messageId: 'msg-plugin-failed-generation',
        cause: 'generation_failed',
      }),
    ])
  })

  it('getChatFromIndex waits for strict hydration and never returns the bootstrap shell', async () => {
    mockServerCommands.canUse = true
    const hydration = deferred<void>()
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [{ id: 'chat-a', message: [] }],
      },
    }
    vi.mocked(hydrateChatMessages).mockImplementationOnce(async () => {
      await hydration.promise
      mockDbState.db.characters[0].chats[0].message = [
        { role: 'user', data: 'persisted history', chatId: 'message-existing' },
      ]
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    let resolved = false
    const read = api.getChatFromIndex(0, 0).then((chat: any) => {
      resolved = true
      return chat
    })
    await Promise.resolve()

    expect(hydrateChatMessages).toHaveBeenCalledWith('chat-a', { strict: true })
    expect(resolved).toBe(false)

    hydration.resolve()
    await expect(read).resolves.toMatchObject({
      id: 'chat-a',
      message: [{ role: 'user', data: 'persisted history', chatId: 'message-existing' }],
    })
  })

  it('setChatToIndex hydrates before diffing and preserves hydrated rows in a get/edit/set round trip', async () => {
    mockServerCommands.canUse = true
    const persisted = { role: 'user', data: 'persisted history', chatId: 'message-existing' }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [{ id: 'chat-a', message: [] }],
      },
    }
    vi.mocked(hydrateChatMessages).mockImplementation(async () => {
      mockDbState.db.characters[0].chats[0].message = [persisted]
    })
    const dispatchAsync = vi.fn(async () => ({ status: 'ok' as const, acceptedCount: 1 }))
    vi.mocked(prepareCompatibleChatUpdateScoped).mockReturnValueOnce({
      commandCount: 1,
      dispatch: vi.fn(),
      dispatchAsync,
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginChat = await api.getChatFromIndex(0, 0)
    pluginChat.message.push(
      { role: 'char', data: 'plugin one', chatId: 'message-plugin-1' },
      { role: 'user', data: 'plugin two', chatId: 'message-plugin-2' },
    )

    await expect(api.setChatToIndex(0, 0, pluginChat)).resolves.toBeUndefined()

    expect(hydrateChatMessages).toHaveBeenCalledTimes(2)
    expect(prepareCompatibleChatUpdateScoped).toHaveBeenCalledWith(
      expect.objectContaining({ message: [persisted] }),
      expect.objectContaining({
        message: [
          persisted,
          { role: 'char', data: 'plugin one', chatId: 'message-plugin-1' },
          { role: 'user', data: 'plugin two', chatId: 'message-plugin-2' },
        ],
      }),
      expect.objectContaining({ chatId: 'chat-a' }),
    )
    expect(dispatchAsync).toHaveBeenCalledOnce()
  })

  it('setChatToIndex rejects a message-bearing write when strict hydration fails', async () => {
    mockServerCommands.canUse = true
    const existingChat = { id: 'chat-a', message: [] }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    vi.mocked(hydrateChatMessages).mockRejectedValueOnce(new Error('Chat hydration incomplete for: chat-a'))
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(
      api.setChatToIndex(0, 0, {
        ...existingChat,
        message: [
          { role: 'user', data: 'plugin one', chatId: 'message-plugin-1' },
          { role: 'char', data: 'plugin two', chatId: 'message-plugin-2' },
        ],
      }),
    ).rejects.toThrow('Chat hydration incomplete for: chat-a')

    expect(mockDbState.db.characters[0].chats[0]).toBe(existingChat)
    expect(prepareCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('setChatToIndex rejects messages synthesized from a shell after hydration reveals persisted rows', async () => {
    mockServerCommands.canUse = true
    const existingChat = { id: 'chat-a', name: 'Chat', message: [] }
    const persisted = { role: 'user', data: 'persisted history', chatId: 'message-existing' }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    vi.mocked(hydrateChatMessages).mockImplementationOnce(async () => {
      mockDbState.db.characters[0].chats[0].message = [persisted]
      mockDbState.db.characters[0].chats[0].hypaV3Data = { memory: 'persisted' }
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(
      api.setChatToIndex(0, 0, {
        ...existingChat,
        message: [
          { role: 'user', data: 'plugin one', chatId: 'message-plugin-1' },
          { role: 'char', data: 'plugin two', chatId: 'message-plugin-2' },
        ],
      }),
    ).rejects.toThrow(/cannot replace messages from an unhydrated chat snapshot/)

    expect(mockDbState.db.characters[0].chats[0].message).toEqual([persisted])
    expect(prepareCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('setChatToIndex preserves hydrated rows when a stale shell only changes metadata', async () => {
    mockServerCommands.canUse = true
    const existingChat = { id: 'chat-a', name: 'Old chat', message: [] }
    const persisted = { role: 'user', data: 'persisted history', chatId: 'message-existing' }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    vi.mocked(hydrateChatMessages).mockImplementationOnce(async () => {
      mockDbState.db.characters[0].chats[0].message = [persisted]
      mockDbState.db.characters[0].chats[0].hypaV3Data = { memory: 'persisted' }
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.setChatToIndex(0, 0, { ...existingChat, name: 'New chat' })).resolves.toBeUndefined()

    expect(mockDbState.db.characters[0].chats[0]).toMatchObject({
      id: 'chat-a',
      name: 'New chat',
      message: [persisted],
      hypaV3Data: { memory: 'persisted' },
    })
    expect(prepareCompatibleChatUpdateScoped).toHaveBeenCalledWith(
      expect.objectContaining({ message: [persisted] }),
      expect.objectContaining({
        name: 'New chat',
        message: [persisted],
        hypaV3Data: { memory: 'persisted' },
      }),
      expect.objectContaining({ chatId: 'chat-a' }),
    )
  })

  it('setChatToIndex rejects unsupported chat fields before projection mutation', async () => {
    mockServerCommands.canUse = true
    const existingChat = {
      id: 'chat-a',
      name: 'Old chat',
      message: [{ role: 'user', data: 'old', chatId: 'msg-a' }],
      scriptstate: { count: 1 },
      localLore: [{ key: 'old lore' }],
      generationSettings: { configured: false },
    }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginChat = {
      ...existingChat,
      name: 'New chat',
      localLore: [{ key: 'changed lore' }],
      generationSettings: { configured: true },
    }

    await expect(api.setChatToIndex(0, 0, pluginChat)).rejects.toThrow(
      /setChatToIndex cannot update unsupported chat fields .*localLore, generationSettings/,
    )

    expect(mockDbState.db.characters[0].chats[0]).toBe(existingChat)
    expect(prepareCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('setChatToIndex rejects unsupported scriptstate value changes before projection mutation', async () => {
    mockServerCommands.canUse = true
    const existingChat = {
      id: 'chat-a',
      name: 'Old chat',
      message: [{ role: 'user', data: 'old', chatId: 'msg-a' }],
      scriptstate: { count: 1 },
    }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginChat = {
      ...existingChat,
      name: 'New chat',
      scriptstate: { count: { nested: true } },
    }

    await expect(api.setChatToIndex(0, 0, pluginChat)).rejects.toThrow(
      /setChatToIndex cannot update unsupported chat fields .*scriptstate.count/,
    )

    expect(mockDbState.db.characters[0].chats[0]).toBe(existingChat)
    expect(prepareCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('setChatToIndex awaits and accepts a durably queued supported chat change', async () => {
    mockServerCommands.canUse = true
    const existingChat = {
      id: 'chat-a',
      name: 'Old chat',
      message: [{ role: 'user', data: 'old', chatId: 'msg-a' }],
      scriptstate: { count: 1 },
      localLore: [{ key: 'old lore' }],
    }
    const persistence = deferred<any>()
    const dispatchAsync = vi.fn(() => persistence.promise)
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    vi.mocked(prepareCompatibleChatUpdateScoped).mockReturnValueOnce({
      commandCount: 3,
      dispatch: vi.fn(),
      dispatchAsync,
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const pluginChat = {
      ...existingChat,
      name: 'New chat',
      message: [{ role: 'char', data: 'new', chatId: 'msg-b' }],
      scriptstate: { count: 2 },
      localLore: existingChat.localLore,
    }

    let settled = false
    const mutation = api.setChatToIndex(0, 0, pluginChat).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(mockDbState.db.characters[0].chats[0]).toBe(pluginChat)
    expect(prepareCompatibleChatUpdateScoped).toHaveBeenCalledWith(existingChat, pluginChat, {
      selectedCharID: 'char-a',
      characterId: 'char-a',
      chatId: 'chat-a',
      chat: existingChat,
    })
    expect(dispatchAsync).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    persistence.resolve({ status: 'retained', acceptedCount: 0, failure: { status: 'unavailable' } })
    await mutation
    expect(settled).toBe(true)
  })

  it('setChatToIndex rejects a terminal durable batch failure', async () => {
    mockServerCommands.canUse = true
    const existingChat = {
      id: 'chat-a',
      name: 'Old chat',
      message: [],
    }
    mockDbState.db.characters = {
      0: {
        chaId: 'char-a',
        chats: [existingChat],
      },
    }
    vi.mocked(prepareCompatibleChatUpdateScoped).mockReturnValueOnce({
      commandCount: 1,
      dispatch: vi.fn(),
      dispatchAsync: vi.fn(async () => ({
        status: 'failure' as const,
        acceptedCount: 0,
        failure: {
          status: 'error' as const,
          error: 'chat rejected',
          reason: 'invalid-request' as const,
        },
      })),
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.setChatToIndex(0, 0, { ...existingChat, name: 'New chat' })).rejects.toThrow('chat rejected')
  })
})

describe('V3 plugin settings rollback', () => {
  it('delegates a named color scheme change to its single persistence owner', () => {
    mockServerCommands.canUse = true
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    void api.changeColorScheme('dracula')

    expect(dispatchDurableServerBackedSettingsPatch).toHaveBeenCalledOnce()
    expect(dispatchDurableServerBackedSettingsPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ colorSchemeName: 'dracula' }),
      }),
    )
  })

  it('keeps Plugin API custom color schemes in the saved custom palette', () => {
    mockServerCommands.canUse = true
    const scheme = {
      bgcolor: '#111111',
      darkbg: '#222222',
      borderc: '#333333',
      selected: '#444444',
      draculared: '#555555',
      textcolor: '#eeeeee',
      textcolor2: '#dddddd',
      darkBorderc: '#666666',
      darkbutton: '#777777',
      type: 'dark',
    }
    Object.assign(mockDbState.db, {
      colorSchemeName: 'default',
      colorScheme: { ...scheme, bgcolor: '#000000' },
      customColorScheme: { ...scheme, bgcolor: '#999999' },
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    void api.setColorScheme(scheme)

    expect(dispatchDurableServerBackedSettingsPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: {
          colorSchemeName: 'custom',
          colorScheme: scheme,
          customColorScheme: scheme,
        },
      }),
    )
    expect((mockDbState.db as any).customColorScheme).toEqual(scheme)
  })

  it('does not resolve a theme mutation before its durable command settles', async () => {
    mockServerCommands.canUse = true
    ;(mockDbState.db as any).textTheme = 'standard'
    let resolveCommand!: (value: any) => void
    vi.mocked(dispatchDurableServerBackedSettingsPatch).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCommand = resolve
      }),
    )
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    let settled = false

    const mutation = api.changeTextTheme('highcontrast').then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(settled).toBe(false)
    resolveCommand({
      status: 'ok',
      revision: 2,
      event: { type: 'settings.updated', revision: 2, resource: 'settings' },
    })
    await mutation
    expect(settled).toBe(true)
  })

  it('rejects a theme mutation after a terminal settings failure', async () => {
    mockServerCommands.canUse = true
    ;(mockDbState.db as any).textTheme = 'standard'
    vi.mocked(dispatchDurableServerBackedSettingsPatch).mockResolvedValueOnce({
      status: 'error',
      error: 'theme rejected',
    })
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    await expect(api.changeTextTheme('highcontrast')).rejects.toThrow('theme rejected')
  })

  it('keeps a newer theme value when a failed plugin settings rollback is stale', () => {
    mockServerCommands.canUse = true
    ;(mockDbState.db as any).textTheme = 'standard'
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    api.changeTextTheme('highcontrast')
    const rollback = capturedSettingsRollback()

    expect(dispatchDurableServerBackedSettingsPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        acknowledgeOptimistic: true,
        patch: { textTheme: 'highcontrast' },
      }),
    )

    expect((mockDbState.db as any).textTheme).toBe('highcontrast')
    ;(mockDbState.db as any).textTheme = 'newer-local-theme'
    vi.mocked(updateColorScheme).mockClear()
    vi.mocked(updateTextThemeAndCSS).mockClear()

    rollback()

    expect((mockDbState.db as any).textTheme).toBe('newer-local-theme')
    expect(updateColorScheme).not.toHaveBeenCalled()
    expect(updateTextThemeAndCSS).not.toHaveBeenCalled()
  })

  it('restores the previous theme value when live state still equals the attempted patch', () => {
    mockServerCommands.canUse = true
    ;(mockDbState.db as any).textTheme = 'standard'
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any

    api.changeTextTheme('highcontrast')
    const rollback = capturedSettingsRollback()
    vi.mocked(updateColorScheme).mockClear()
    vi.mocked(updateTextThemeAndCSS).mockClear()

    rollback()

    expect((mockDbState.db as any).textTheme).toBe('standard')
    expect(updateColorScheme).not.toHaveBeenCalled()
    expect(updateTextThemeAndCSS).toHaveBeenCalledTimes(1)
  })
})

describe('V3 plugin permissions', () => {
  it('keeps plugin loading pending until the guest finishes initialization', async () => {
    const plugin = seedV3Plugin('awaited-startup')
    mockDbState.db.plugins = [plugin]
    let release!: () => void
    vi.mocked(SandboxHost.prototype.waitForInitialization).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const settled = vi.fn()
    const loading = loadV3Plugins([plugin]).then(settled)
    await vi.waitFor(() => expect(SandboxHost.prototype.waitForInitialization).toHaveBeenCalledOnce())
    expect(settled).not.toHaveBeenCalled()
    release()
    await loading
    expect(settled).toHaveBeenCalledOnce()
  })

  it('unloads a guest whose initialization fails', async () => {
    const plugin = seedV3Plugin('failed-startup')
    mockDbState.db.plugins = [plugin]
    vi.mocked(SandboxHost.prototype.waitForInitialization).mockRejectedValueOnce(new Error('Startup failed'))
    await expect(loadV3Plugins([plugin])).rejects.toThrow('Startup failed')
    expect(getV3PluginInstance(plugin.name)).toBeUndefined()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('does not create a V3 guest when trusted browser runtime access is denied', async () => {
    const plugin = { ...seedV3Plugin('denied-runtime'), script: 'globalThis.ran = true' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await executePluginV3(plugin)

    expect(getV3PluginInstance(plugin.name)).toBeUndefined()
    expect(document.querySelector('iframe')).toBeNull()
    expect(alertConfirm).toHaveBeenCalledOnce()
  })

  it('requires a new trusted runtime decision after the V3 script changes', async () => {
    const first = { ...seedV3Plugin('changing-runtime'), script: 'void "first"' }
    const second = { ...seedV3Plugin('changing-runtime'), script: 'void "second"' }
    mockDbState.db.plugins = [first]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await loadV3Plugins([first])
    expect(getV3PluginInstance(first.name)).toBeDefined()
    mockDbState.db.plugins = [second]
    await loadV3Plugins([second])

    expect(getV3PluginInstance(second.name)).toBeUndefined()
    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a granted capability for another capability from the same plugin', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(true)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'mainDom')).resolves.toBe(false)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(true)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'mainDom')).resolves.toBe(false)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('does not let an update-source grant satisfy the plugin runtime network capability', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    const updateURL = 'https://plugins.example/plugin.js'
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(
      __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'pluginUpdate', false, plugin.script, undefined, {
        updateURL,
      }),
    ).resolves.toBe(true)
    await expect(
      __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'network', false, plugin.script),
    ).resolves.toBe(false)
    await expect(
      __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'pluginUpdate', false, plugin.script, undefined, {
        updateURL,
      }),
    ).resolves.toBe(true)

    expect(alertConfirm).toHaveBeenNthCalledWith(1, `update:${plugin.name}:${updateURL}`)
    expect(alertConfirm).toHaveBeenNthCalledWith(2, `network:${plugin.name}`)
  })

  it('does not reuse an update grant for another declared HTTPS source', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(
      __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'pluginUpdate', false, plugin.script, undefined, {
        updateURL: 'https://first.example/plugin.js',
      }),
    ).resolves.toBe(true)
    await expect(
      __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'pluginUpdate', false, plugin.script, undefined, {
        updateURL: 'https://second.example/plugin.js',
      }),
    ).resolves.toBe(false)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a denied capability for another capability from the same plugin', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(false)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'mainDom')).resolves.toBe(true)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(false)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'mainDom')).resolves.toBe(true)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('keeps decisions for the same capability independent between plugins', async () => {
    const pluginA = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    const pluginB = { ...seedV3Plugin('plugin-b'), script: 'script-b' }
    mockDbState.db.plugins = [pluginA, pluginB]
    vi.mocked(alertConfirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(pluginA.name, 'db')).resolves.toBe(false)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(pluginB.name, 'db')).resolves.toBe(true)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('continues to honor persisted script-hash grants without prompting', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    mockPermissionForage.values.set('plugin_permission:["plugin-a","hash:script-a","db"]', true)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(true)

    expect(alertConfirm).not.toHaveBeenCalled()
  })

  it('does not carry an in-memory grant across a script update with the same plugin name', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(true)
    plugin.script = 'script-b'
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(false)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('does not bank a grant when the installed script changes while its prompt is open', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    let resolveConfirmation!: (allowed: boolean) => void
    vi.mocked(alertConfirm).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve
        }),
    )

    const permission = __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')
    await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledOnce())
    plugin.script = 'script-b'
    resolveConfirmation(true)

    await expect(permission).resolves.toBe(false)
    expect(mockPermissionForage.setItem).not.toHaveBeenCalled()
  })

  it('does not reuse a persisted grant for a different plugin with byte-identical source', async () => {
    const pluginA = { ...seedV3Plugin('plugin-a'), script: 'shared-script' }
    const pluginB = { ...seedV3Plugin('plugin-b'), script: 'shared-script' }
    mockDbState.db.plugins = [pluginA, pluginB]
    mockPermissionForage.values.set('plugin_permission:["plugin-a","hash:shared-script","db"]', true)
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(pluginA.name, 'db')).resolves.toBe(true)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(pluginB.name, 'db')).resolves.toBe(false)

    expect(alertConfirm).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent non-reconfirm prompts for the same script capability', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    let resolveConfirmation!: (allowed: boolean) => void
    vi.mocked(alertConfirm).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve
        }),
    )

    const first = __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')
    const second = __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')
    await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledTimes(1))
    resolveConfirmation(true)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(alertConfirm).toHaveBeenCalledTimes(1)
  })

  it('bypasses an in-memory grant when explicit reconfirmation is requested', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db')).resolves.toBe(true)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', true)).resolves.toBe(true)

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it.each([true, 'periodically'] as const)(
    'coalesces concurrent %s reconfirmation prompts for the same script capability',
    async (reconfirm) => {
      const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
      mockDbState.db.plugins = [plugin]
      let resolveConfirmation!: (allowed: boolean) => void
      vi.mocked(alertConfirm).mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveConfirmation = resolve
          }),
      )

      const first = __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', reconfirm)
      const second = __v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', reconfirm)
      await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledTimes(1))
      resolveConfirmation(true)

      await expect(Promise.all([first, second])).resolves.toEqual([true, true])
      expect(alertConfirm).toHaveBeenCalledTimes(1)
    },
  )

  it('reconfirms a periodic capability after its grant expires', async () => {
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', 'periodically')).resolves.toBe(
      true,
    )
    now.mockReturnValue(1_001)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', 'periodically')).resolves.toBe(
      true,
    )
    now.mockReturnValue(1_000 + 3 * 24 * 60 * 60 * 1_000 + 1)
    await expect(__v3PluginLifecycleTestHooks.getPluginPermission(plugin.name, 'db', 'periodically')).resolves.toBe(
      true,
    )

    expect(alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('returns a failed provider result without invoking plugin code when permission is denied', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plugin = { ...seedV3Plugin('plugin-a'), script: 'script-a' }
    mockDbState.db.plugins = [plugin]
    vi.mocked(alertConfirm).mockResolvedValueOnce(false)
    const provider = vi.fn(async () => ({ success: true, content: 'provider response' }))
    const api = __v3PluginLifecycleTestHooks.createApi(plugin) as any
    api.addProvider('denied-provider', provider)
    const registeredProvider = pluginV2.providers.get('denied-provider')
    const arg = { mode: 'normal' } as any

    await expect(registeredProvider?.(arg)).resolves.toEqual({ success: false, content: 'Permission denied' })

    expect(provider).not.toHaveBeenCalled()
    expect(arg.mode).toBe('normal')
  })
})

describe('V3 plugin lifecycle cleanup', () => {
  it('removes a partially loaded generation when another plugin fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const failure = new Error('permission prompt failed')
    const pluginA = seedV3Plugin('plugin-a')
    const pluginB = seedV3Plugin('plugin-b')
    mockDbState.db.plugins = [pluginA, pluginB]
    vi.mocked(alertConfirm).mockResolvedValueOnce(true).mockRejectedValueOnce(failure)

    await expect(loadV3Plugins([pluginA, pluginB])).rejects.toBe(failure)

    expect(getV3PluginInstance('plugin-a')).toBeUndefined()
    expect(getV3PluginInstance('plugin-b')).toBeUndefined()
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('loadV3Plugins unloads every existing V3 instance from a snapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const pluginA = seedV3Plugin('plugin-a')
    const pluginB = seedV3Plugin('plugin-b')
    mockDbState.db.plugins = [pluginA, pluginB]
    await executePluginV3(pluginA)
    await executePluginV3(pluginB)

    expect(getV3PluginInstance('plugin-a')).toBeTruthy()
    expect(getV3PluginInstance('plugin-b')).toBeTruthy()

    await loadV3Plugins([])

    expect(getV3PluginInstance('plugin-a')).toBeUndefined()
    expect(getV3PluginInstance('plugin-b')).toBeUndefined()
    expect(messageCalls(removeSpy)).toHaveLength(2)
  })

  it('throwing unload callbacks do not skip SandboxHost or provider cleanup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    const plugin = seedV3Plugin('plugin-a')
    mockDbState.db.plugins = [plugin]
    await executePluginV3(plugin)
    __v3PluginLifecycleTestHooks.addUnloadCallback('plugin-a', () => {
      throw new Error('unload failed')
    })
    __v3PluginLifecycleTestHooks.registerProvider('plugin-a', 'owned')

    await __v3PluginLifecycleTestHooks.unloadPlugin('plugin-a')

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error running unload callback for plugin plugin-a:'),
      expect.any(Error),
    )
    expect(getV3PluginInstance('plugin-a')).toBeUndefined()
    expect(pluginV2.providers.has('owned')).toBe(false)
    expect(get(customProviderStore)).toEqual([])
    expect(messageCalls(removeSpy)).toHaveLength(1)
  })

  it('custom provider stores dedupe by provider name and unload by plugin ownership', async () => {
    const firstHandler = vi.fn(async () => ({ success: true, content: 'first' }))
    const secondHandler = vi.fn(async () => ({ success: true, content: 'second' }))

    __v3PluginLifecycleTestHooks.registerProvider('plugin-a', 'shared', firstHandler)
    __v3PluginLifecycleTestHooks.registerProvider('plugin-a', 'shared', firstHandler)
    __v3PluginLifecycleTestHooks.registerProvider('plugin-b', 'shared', secondHandler)

    expect(get(customProviderStore)).toEqual(['shared'])
    expect(customV3ProviderMetaStore.map((model) => model.id)).toEqual(['pluginmodel:::shared'])
    expect(pluginV2.providers.get('shared')).toBe(secondHandler)

    await __v3PluginLifecycleTestHooks.unloadPlugin('plugin-b')

    expect(get(customProviderStore)).toEqual(['shared'])
    expect(customV3ProviderMetaStore).toHaveLength(1)
    expect(pluginV2.providers.get('shared')).toBe(firstHandler)

    await __v3PluginLifecycleTestHooks.unloadPlugin('plugin-a')

    expect(get(customProviderStore)).toEqual([])
    expect(customV3ProviderMetaStore).toHaveLength(0)
    expect(pluginV2.providers.has('shared')).toBe(false)
    expect(pluginV2.providerOptions.has('shared')).toBe(false)
  })

  it('unloading a V3 provider does not remove a same-name provider reloaded by V2', async () => {
    const v2ReloadedHandler = vi.fn(async () => ({ success: true, content: 'v2' }))

    __v3PluginLifecycleTestHooks.registerProvider('plugin-a', 'shared')
    pluginV2.providers.set('shared', v2ReloadedHandler)
    pluginV2.providerOptions.set('shared', {})

    await __v3PluginLifecycleTestHooks.unloadPlugin('plugin-a')

    expect(pluginV2.providers.get('shared')).toBe(v2ReloadedHandler)
    expect(get(customProviderStore)).toEqual(['shared'])
    expect(customV3ProviderMetaStore).toHaveLength(0)
  })

  it('ignores stale provider registration after a newer V3 load', async () => {
    const oldPlugin = seedV3Plugin('plugin-old')
    const newPlugin = seedV3Plugin('plugin-new')

    mockDbState.db.plugins = [oldPlugin]
    await loadV3Plugins([oldPlugin])
    const oldInstance = getV3PluginInstance('plugin-old')
    expect(oldInstance).toBeTruthy()
    const oldApi = __v3PluginLifecycleTestHooks.createApiForInstance(oldPlugin, oldInstance as any) as any

    mockDbState.db.plugins = [newPlugin]
    await loadV3Plugins([newPlugin])
    const newInstance = getV3PluginInstance('plugin-new')
    expect(newInstance).toBeTruthy()
    const newApi = __v3PluginLifecycleTestHooks.createApiForInstance(newPlugin, newInstance as any) as any
    const newHandler = vi.fn(async () => ({ success: true, content: 'new' }))

    newApi.addProvider('provider-new', newHandler)

    expect(() =>
      oldApi.addProvider(
        'provider-old',
        vi.fn(async () => ({ success: true, content: 'old' })),
      ),
    ).toThrow(/no longer active/)
    expect(pluginV2.providers.has('provider-old')).toBe(false)
    expect(pluginV2.providers.has('provider-new')).toBe(true)
    expect(get(customProviderStore)).toEqual(['provider-new'])
    expect(customV3ProviderMetaStore.map((model) => model.id)).toEqual(['pluginmodel:::provider-new'])
  })

  it('ignores stale custom UI registration after a newer V3 load', async () => {
    const oldPlugin = seedV3Plugin('plugin-old')
    const newPlugin = seedV3Plugin('plugin-new')

    mockDbState.db.plugins = [oldPlugin]
    await loadV3Plugins([oldPlugin])
    const oldInstance = getV3PluginInstance('plugin-old')
    expect(oldInstance).toBeTruthy()
    const oldApi = __v3PluginLifecycleTestHooks.createApiForInstance(oldPlugin, oldInstance as any) as any

    mockDbState.db.plugins = [newPlugin]
    await loadV3Plugins([newPlugin])
    const newInstance = getV3PluginInstance('plugin-new')
    expect(newInstance).toBeTruthy()
    const newApi = __v3PluginLifecycleTestHooks.createApiForInstance(newPlugin, newInstance as any) as any

    newApi.registerButton(
      { name: 'New button', icon: '', iconType: 'none', location: 'action', id: 'shared-button' },
      vi.fn(),
    )

    expect(() =>
      oldApi.registerButton(
        { name: 'Old late button', icon: '', iconType: 'none', location: 'action', id: 'old-late-button' },
        vi.fn(),
      ),
    ).toThrow(/no longer active/)
    expect(additionalFloatingActionButtons.map((button) => ({ id: button.id, name: button.name }))).toEqual([
      { id: 'shared-button', name: 'New button' },
    ])
  })

  it('delayed old menu cleanup does not remove a newer same-id button', async () => {
    const oldPlugin = seedV3Plugin('plugin-shared')
    const oldRuntime = __v3PluginLifecycleTestHooks.createTrackedApi(oldPlugin)
    const oldApi = oldRuntime.api as any

    oldApi.registerButton(
      { name: 'Old button', icon: '', iconType: 'none', location: 'action', id: 'shared-button' },
      vi.fn(),
    )
    expect(additionalFloatingActionButtons.map((button) => button.name)).toEqual(['Old button'])

    __v3PluginLifecycleTestHooks.beginGeneration()
    const newRuntime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-shared'))
    const newApi = newRuntime.api as any
    newApi.registerButton(
      { name: 'New button', icon: '', iconType: 'none', location: 'action', id: 'shared-button' },
      vi.fn(),
    )

    await __v3PluginLifecycleTestHooks.unloadInstance(oldRuntime.instance)

    expect(additionalFloatingActionButtons.map((button) => ({ id: button.id, name: button.name }))).toEqual([
      { id: 'shared-button', name: 'New button' },
    ])

    await __v3PluginLifecycleTestHooks.unloadInstance(newRuntime.instance)

    expect(additionalFloatingActionButtons).toHaveLength(0)
  })

  it('moves a re-registered button to its newly requested location', async () => {
    const runtime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-moving-button'))
    const api = runtime.api as any
    const firstCallback = vi.fn()
    const movedCallback = vi.fn()

    api.registerButton(
      { name: 'Floating button', icon: '', iconType: 'none', location: 'action', id: 'moving-button' },
      firstCallback,
    )
    api.registerButton(
      { name: 'Chat button', icon: '', iconType: 'none', location: 'chat', id: 'moving-button' },
      movedCallback,
    )

    expect(additionalFloatingActionButtons).toHaveLength(0)
    expect(additionalHamburgerMenu).toHaveLength(0)
    expect(additionalChatMenu.map((button) => ({ id: button.id, name: button.name }))).toEqual([
      { id: 'moving-button', name: 'Chat button' },
    ])

    additionalChatMenu[0].callback()
    expect(firstCallback).not.toHaveBeenCalled()
    expect(movedCallback).toHaveBeenCalledOnce()

    await __v3PluginLifecycleTestHooks.unloadInstance(runtime.instance)
    expect(additionalChatMenu).toHaveLength(0)
  })

  it('replaces, explicitly unregisters, and unloads only the plugin-owned chat panel', async () => {
    const pluginA = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-a'))
    const pluginB = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-b'))
    const apiA = pluginA.api as any
    const apiB = pluginB.api as any

    apiA.setChatPanel('<img src="https://attacker.example/pixel"><span>first</span>', {
      id: 'shared-panel',
      className: 'plugin-panel',
    })
    apiA.setChatPanel('<strong>replacement</strong>', { id: 'shared-panel' })
    apiB.setChatPanel('<span>other owner</span>', { id: 'shared-panel' })

    expect(chatPanelStore).toHaveLength(2)
    expect(chatPanelStore[0]).toMatchObject({
      id: 'shared-panel',
      pluginName: 'plugin-a',
      html: '<strong>replacement</strong>',
    })
    expect(chatPanelStore[0].html).not.toContain('attacker.example')

    apiA.unregisterUIPart('shared-panel')
    expect(chatPanelStore.map((panel) => panel.pluginName)).toEqual(['plugin-b'])

    await __v3PluginLifecycleTestHooks.unloadInstance(pluginB.instance)
    expect(chatPanelStore).toHaveLength(0)
  })

  it('scopes shared UI ids to each plugin owner', async () => {
    const pluginA = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-a'))
    const pluginB = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-b'))
    const apiA = pluginA.api as any
    const apiB = pluginB.api as any

    apiA.registerSetting('Settings A', vi.fn(), '', 'none', 'settings')
    apiB.registerSetting('Settings B', vi.fn(), '', 'none', 'settings')
    apiA.registerButton(
      { name: 'Action A', icon: '', iconType: 'none', location: 'action', id: 'main-action' },
      vi.fn(),
    )
    apiB.registerButton(
      { name: 'Action B', icon: '', iconType: 'none', location: 'action', id: 'main-action' },
      vi.fn(),
    )

    expect(additionalSettingsMenu.map((menu) => menu.name)).toEqual(['Settings A', 'Settings B'])
    expect(additionalFloatingActionButtons.map((button) => button.name)).toEqual(['Action A', 'Action B'])

    apiA.unregisterUIPart('settings')
    apiA.unregisterUIPart('main-action')

    expect(additionalSettingsMenu.map((menu) => menu.name)).toEqual(['Settings B'])
    expect(additionalFloatingActionButtons.map((button) => button.name)).toEqual(['Action B'])

    await __v3PluginLifecycleTestHooks.unloadInstance(pluginA.instance)
    expect(additionalSettingsMenu.map((menu) => menu.name)).toEqual(['Settings B'])
    expect(additionalFloatingActionButtons.map((button) => button.name)).toEqual(['Action B'])
  })

  it('cleans up each plugin MCP with its registration identity across reload and unload', async () => {
    const identifier = 'plugin:shared-tools'
    const oldRegistration = { generation: 'old' }
    const newRegistration = { generation: 'new' }
    vi.mocked(registerMCPModule)
      .mockResolvedValueOnce(oldRegistration as any)
      .mockResolvedValueOnce(newRegistration as any)
    const getToolList = vi.fn(async () => [])
    const callTool = vi.fn(async () => [])

    const oldRuntime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-shared'))
    await (oldRuntime.api.registerMCP as Function)(
      {
        identifier,
        name: 'Old tools',
        version: '1.0.0',
        description: 'Old plugin generation.',
      },
      getToolList,
      callTool,
    )

    __v3PluginLifecycleTestHooks.beginGeneration()
    const newRuntime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-shared'))
    await (newRuntime.api.registerMCP as Function)(
      {
        identifier,
        name: 'New tools',
        version: '2.0.0',
        description: 'Current plugin generation.',
      },
      getToolList,
      callTool,
    )

    await __v3PluginLifecycleTestHooks.unloadInstance(oldRuntime.instance)

    expect(unregisterMCPModule).toHaveBeenCalledWith(identifier, oldRegistration)
    expect(unregisterMCPModule).not.toHaveBeenCalledWith(identifier, newRegistration)

    await __v3PluginLifecycleTestHooks.unloadInstance(newRuntime.instance)

    expect(unregisterMCPModule).toHaveBeenCalledWith(identifier, newRegistration)
  })

  it('unload cleanup removes SafeElement document listeners exactly once', async () => {
    const lifecycle = __v3PluginLifecycleTestHooks.createLifecycle()
    const safeDocument = __v3PluginLifecycleTestHooks.createSafeDocument(lifecycle)
    const listener = vi.fn()

    await safeDocument.addEventListener('click', listener)
    document.dispatchEvent(new MouseEvent('click'))

    lifecycle.cleanupAll()
    lifecycle.cleanupAll()
    document.dispatchEvent(new MouseEvent('click'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('removing a SafeElement keyboard listener cancels its delayed callback', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = __v3PluginLifecycleTestHooks.createLifecycle()
      const safeDocument = __v3PluginLifecycleTestHooks.createSafeDocument(lifecycle)
      const listener = vi.fn()
      const id = await safeDocument.addEventListener('keydown', listener)

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }))
      safeDocument.removeEventListener('keydown', id)
      vi.runAllTimers()

      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lifecycle cleanup cancels delayed SafeElement keyboard callbacks', async () => {
    vi.useFakeTimers()
    try {
      const lifecycle = __v3PluginLifecycleTestHooks.createLifecycle()
      const safeDocument = __v3PluginLifecycleTestHooks.createSafeDocument(lifecycle)
      const listener = vi.fn()

      await safeDocument.addEventListener('keyup', listener)
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }))
      lifecycle.cleanupAll()
      vi.runAllTimers()

      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps main-document HTML and CSS helpers network-dead', () => {
    const lifecycle = __v3PluginLifecycleTestHooks.createLifecycle()
    const safeDocument = __v3PluginLifecycleTestHooks.createSafeDocument(lifecycle)
    const element = safeDocument.createElement('div')

    expect(() => element.setStyle('backgroundImage', 'url(https://attacker.example/?secret=chat)')).toThrow(
      /not allowed|network-loading/i,
    )
    expect(() => element.setStyle('color', 'red')).not.toThrow()
    expect(() =>
      element.setStyleAttribute('color: blue; background-image: url(https://attacker.example/style)'),
    ).toThrow(/network-loading/i)

    element.setInnerHTML(`
      <img src="https://attacker.example/html">
      <svg><rect filter="url(https://attacker.example/filter)" fill="url(https://attacker.example/fill)"></rect></svg>
      <span class="kept">safe</span>
    `)
    expect(element.getInnerHTML()).toContain('<span class="kept">safe</span>')
    expect(element.getInnerHTML()).not.toContain('attacker.example')
    expect(element.getInnerHTML()).not.toMatch(/(?:filter|fill)="url/i)
    expect(safeDocument.createElement('img').nodeName()).toBe('DIV')
    expect(safeDocument.createElement('style').nodeName()).toBe('DIV')
    expect(safeDocument.createAnchorElement('https://public.example/path').getOuterHTML()).toContain(
      'rel="noopener noreferrer"',
    )

    const existingStyle = document.createElement('style')
    document.head.appendChild(existingStyle)
    const safeStyle = safeDocument.querySelector('style')
    expect(() => safeStyle?.setInnerHTML('body { background: url(https://attacker.example/style-element) }')).toThrow(
      /style element/i,
    )
    existingStyle.remove()

    const existingImage = document.createElement('img')
    existingImage.id = 'existing-network-image'
    existingImage.src = 'https://attacker.example/existing-image'
    document.body.appendChild(existingImage)
    const safeImage = safeDocument.querySelector('#existing-network-image')
    expect(() => safeImage?.cloneNode(true)).toThrow(/network-capable/i)
    expect(() => element.appendChild(safeImage!)).toThrow(/network-capable/i)
    existingImage.remove()
  })

  it('unload cleanup disconnects SafeMutationObservers exactly once', () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const lifecycle = __v3PluginLifecycleTestHooks.createLifecycle()
    const safeDocument = __v3PluginLifecycleTestHooks.createSafeDocument(lifecycle)
    const observer = __v3PluginLifecycleTestHooks.createMutationObserver(lifecycle, vi.fn())

    observer.observe(safeDocument, { childList: true })
    lifecycle.cleanupAll()
    lifecycle.cleanupAll()

    expect(disconnectSpy).toHaveBeenCalledTimes(1)
  })

  it('removes plugin channel listeners when their owning plugin unloads', async () => {
    const pluginAData = {
      ...seedV3Plugin('plugin-a'),
      allowedIPC: ['plugin-b'],
    }
    const pluginBData = {
      ...seedV3Plugin('plugin-b'),
      allowedIPC: ['plugin-a'],
    }
    mockDbState.db.plugins = [pluginAData, pluginBData]
    const pluginA = __v3PluginLifecycleTestHooks.createTrackedApi(pluginAData)
    const pluginB = __v3PluginLifecycleTestHooks.createTrackedApi(pluginBData)
    const listener = vi.fn()

    ;(pluginA.api as any).addPluginChannelListener('updates', listener)
    ;(pluginB.api as any).postPluginChannelMessage('plugin-a', 'updates', 'first')
    expect(listener).toHaveBeenCalledOnce()

    await __v3PluginLifecycleTestHooks.unloadInstance(pluginA.instance)
    ;(pluginB.api as any).postPluginChannelMessage('plugin-a', 'updates', 'second')

    expect(listener).toHaveBeenCalledOnce()
  })

  it('registers, removes, and unloads owned chat output listeners', async () => {
    const runtime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('listener-plugin'))
    const api = runtime.api as any
    const listener = vi.fn()

    await api.addRisuChatListener('output', listener)
    const guarded = [...chatOutputListeners][0]
    guarded({} as any)
    expect(listener).toHaveBeenCalledOnce()
    expect(chatOutputListeners.has(guarded)).toBe(true)

    api.removeRisuChatListener('output', listener)
    expect(chatOutputListeners.size).toBe(0)

    await api.addRisuChatListener('output', listener)
    await __v3PluginLifecycleTestHooks.unloadInstance(runtime.instance)
    expect(chatOutputListeners.size).toBe(0)
  })
})

describe('connected reader V3 runtime boundary', () => {
  it('rejects all mutation and operational APIs before local fallback or requests', async () => {
    const api = __v3PluginLifecycleTestHooks.createApi(seedV3Plugin('plugin-a')) as any
    const before = JSON.stringify(mockDbState.db)
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    for (const invoke of [
      () => api.setCharacter({ chaId: 'char-a', name: 'changed' }),
      () => api.setCharacterToIndex(0, { name: 'changed' }),
      () => api.setChatToIndex(0, 0, { message: [] }),
      () => api.setArgument('key', 'changed'),
      () => api.setDatabaseLite({ aiModel: 'changed' }),
      () => api._setPluginStorage('key', 'changed'),
      () => api._setSafeLocalStorage('key', 'changed'),
      () => api.changeTextTheme('highcontrast'),
      () => api.nativeFetch('https://example.com'),
      () => api.runLLMModel({ mode: 'model', messages: [] }),
      () => api.addProvider('unsafe', vi.fn()),
      () => api.addTTSPreprocessor(vi.fn()),
      () => api.registerButton({ name: 'unsafe', icon: '', iconType: 'none' }, vi.fn()),
    ])
      expect(invoke).toThrow('client_write_access_required')
    expect(JSON.stringify(mockDbState.db)).toBe(before)
    expect(dispatchUpdatePlugin).not.toHaveBeenCalled()
    expect(prepareCompatibleCharacterUpdateScoped).not.toHaveBeenCalled()
  })

  it('retires writer instances and fences held host callbacks immediately on role loss', async () => {
    const operation = beginClientSession('writer')
    authorizeClientWriterRecovery(operation, { databaseLineage: 'lineage', writer: { sessionId: 'writer', epoch: 1 } })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    completeClientWriterRecovery(operation)
    const runtime = __v3PluginLifecycleTestHooks.createTrackedApi(seedV3Plugin('plugin-a'))
    const api = runtime.api as any
    const buttonEffect = vi.fn()
    const outputEffect = vi.fn()
    const unloadEffect = vi.fn()
    api.registerButton({ name: 'test', icon: '', iconType: 'none' }, buttonEffect)
    await api.addRisuChatListener('output', outputEffect)
    api.onUnload(unloadEffect)
    const button = additionalFloatingActionButtons[0].callback
    const output = [...chatOutputListeners][0]
    demoteClientSession()
    expect(runtime.instance.active).toBe(false)
    expect(() => button()).toThrow('client_write_access_required')
    expect(() => output({} as any)).toThrow('client_write_access_required')
    expect(buttonEffect).not.toHaveBeenCalled()
    expect(outputEffect).not.toHaveBeenCalled()
    expect(unloadEffect).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(additionalFloatingActionButtons).toHaveLength(0))
  })
})
