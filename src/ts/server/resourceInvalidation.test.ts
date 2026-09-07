import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginClientSession, resetClientSessionForTests } from '../clientSession'
import type { character } from '../storage/database.svelte'
import type { CommandEvent } from './commands'

const api = vi.hoisted(() => ({
  shell: vi.fn(),
  settings: vi.fn(),
  settingsGroup: vi.fn(),
  standaloneSetting: vi.fn(),
  collections: vi.fn(),
  collection: vi.fn(),
  characters: vi.fn(),
  character: vi.fn(),
  characterOrder: vi.fn(),
  characterSelection: vi.fn(),
  chat: vi.fn(),
  generationChat: vi.fn(),
  legacyPreset: vi.fn(),
  lorebook: vi.fn(),
  lorebooks: vi.fn(),
  inlay: vi.fn(),
  bardWikiChat: vi.fn(),
  bardWikiDocument: vi.fn(),
  bardWikiVersions: vi.fn(),
}))

const sideEffects = vi.hoisted(() => ({
  reapplyPendingPresets: vi.fn(),
  mergeAgentPresetSettings: vi.fn((value: Record<string, unknown>) => value),
  mergeAgentPresetLoadouts: vi.fn((value: any[]) => value),
  mergeAgentPresetCharacters: vi.fn((value: any[]) => value),
  mergePluginCollection: vi.fn((value: any[]) => value),
  mergePluginProvider: vi.fn((value: unknown) => (typeof value === 'string' ? value : '')),
  mergePluginStorage: vi.fn((value: Record<string, unknown>) => value),
  reattach: vi.fn(),
  clearTranslation: vi.fn(),
  markLorebook: vi.fn(),
  applyChat: vi.fn(() => true),
  applyLorebook: vi.fn(() => true),
  refreshGreeting: vi.fn(async () => true),
}))

const promptHydration = vi.hoisted(() => ({
  currentOwner: null as string | null,
  ensure: vi.fn(async () => true),
  invalidate: vi.fn(),
  stale: vi.fn(),
  mark: vi.fn(),
  reset: vi.fn(),
  isHydrated: vi.fn(() => true),
}))

const languageSideEffects = vi.hoisted(() => ({
  change: vi.fn(),
}))

const inlayState = vi.hoisted(() => ({
  resource: null as { revision: number; assets: any[] } | null,
}))

vi.mock('../../lang', () => ({
  changeLanguage: languageSideEffects.change,
}))

vi.mock('./resourceReads', () => ({
  fetchServerShell: api.shell,
  fetchServerSettings: api.settings,
  fetchServerSettingsGroup: api.settingsGroup,
  fetchServerStandaloneSetting: api.standaloneSetting,
  fetchServerCollections: api.collections,
  fetchServerCollection: api.collection,
  fetchServerCharacters: api.characters,
  fetchServerCharacter: api.character,
  fetchServerCharacterOrder: api.characterOrder,
  fetchServerCharacterSelection: api.characterSelection,
  fetchServerInlayCatalog: api.inlay,
  fetchServerBardWikiChat: api.bardWikiChat,
  fetchServerBardWikiDocument: api.bardWikiDocument,
  fetchServerBardWikiVersions: api.bardWikiVersions,
}))

vi.mock('./hydrationReads', () => ({
  fetchServerChatMessages: api.chat,
  fetchServerGenerationChatMessages: api.generationChat,
  fetchServerLegacyPreset: api.legacyPreset,
  fetchServerCharacterLorebook: api.lorebook,
  fetchServerBulkCharacterLorebooks: api.lorebooks,
}))

vi.mock('./inlayCatalog', () => ({
  applyServerInlayCatalogResource: (resource: { revision: number; assets: any[] }, options?: { force?: boolean }) => {
    if (!options?.force && inlayState.resource && resource.revision < inlayState.resource.revision) return false
    inlayState.resource = structuredClone(resource)
    return true
  },
  getServerInlayCatalogResource: () => structuredClone(inlayState.resource),
  resetServerInlayCatalogResource: () => {
    inlayState.resource = null
  },
}))

vi.mock('./promptTemplateHydration', () => ({
  currentPromptTemplateOwnerId: () => promptHydration.currentOwner,
  ensurePromptTemplateHydrated: promptHydration.ensure,
  invalidatePromptTemplateHydration: promptHydration.invalidate,
  isPromptTemplateHydrated: promptHydration.isHydrated,
  markPromptTemplateHydrationStale: promptHydration.stale,
  markPromptTemplateProjectionApplied: promptHydration.mark,
  resetPromptTemplateHydration: promptHydration.reset,
}))

import {
  FULL_RESOURCE_REFRESH_MAX_ATTEMPTS,
  loadInitialServerResources,
  refreshAllServerResources,
  refreshInvalidatedServerResources,
  refreshServerResourceTargets,
  type ServerResourceInvalidationHooks,
} from './resourceInvalidation'
import { lorebookPageOwner } from './lorebookPageOwner.svelte'
import {
  SERVER_COLLECTION_NAMES,
  applyCharacterResource,
  applyCharactersResource,
  applyCollectionsResource,
  applySettingsGroupResource,
  applySettingsResource,
  beginCollectionsResourceLoad,
  beginSettingsGroupResourceLoad,
  beginStandaloneSettingResourceLoad,
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  charactersResourceState,
  collectionsResourceState,
  hasCharacterLorebookProjectionEpochChanged,
  hasCharacterRowProjectionEpochChanged,
  markCharacterLorebookProjectionApplied,
  markChatBodyProjectionApplied,
  resetServerResourceState,
  settingsResourceState,
} from './resourceState.svelte'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from './settingsGroups'
import { captureDestructiveRefreshEpoch, hasDestructiveRefreshEpochChanged } from './staleStateGuards'

import { SERVER_SHELL_PROTOCOL_VERSION, type ServerShellSettings } from '@risuai/protocol/shell-resource'
import {
  applyServerInlayCatalogResource,
  getServerInlayCatalogResource,
  resetServerInlayCatalogResource,
} from './inlayCatalog'
import {
  applyBardWikiChatResource,
  applyBardWikiDocumentResource,
  getBardWikiChatResource,
  getBardWikiDocumentResource,
  resetBardWikiResource,
} from './bardWikiResource'
import { BARDWIKI_PROTOCOL_VERSION, DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const hooks: ServerResourceInvalidationHooks = {
  reapplyPendingPresetProjections: sideEffects.reapplyPendingPresets,
  mergePendingAgentPresetSettings: sideEffects.mergeAgentPresetSettings,
  mergePendingAgentPresetLoadouts: sideEffects.mergeAgentPresetLoadouts,
  mergePendingAgentPresetCharacters: sideEffects.mergeAgentPresetCharacters,
  mergePendingPluginCollection: sideEffects.mergePluginCollection,
  mergePendingPluginProvider: sideEffects.mergePluginProvider,
  mergePendingPluginStorage: sideEffects.mergePluginStorage,
  applyChatMessages: sideEffects.applyChat,
  applyCharacterLorebook: sideEffects.applyLorebook,
  markCharacterLorebookHydrated: sideEffects.markLorebook,
  triggerOpenChatGenerationReattach: sideEffects.reattach,
  clearActiveMessageTranslation: sideEffects.clearTranslation,
  refreshGreetingTranslations: sideEffects.refreshGreeting,
}

function metadataCharacter(chaId: string, name: string, chatId = `chat-${chaId}`, message: unknown[] = []): character {
  return {
    chaId,
    name,
    globalLore: [],
    chats: [
      {
        id: chatId,
        name: `${name} chat`,
        message,
      },
    ],
  } as unknown as character
}

function characterSummaryShell(chaId: string, name: string, chatId = `chat-${chaId}`): character {
  return {
    __serverCharacterShell: true,
    chaId,
    name,
    chats: [{ id: chatId, name: '', message: [] }],
    chatPage: 0,
    chatFolders: [],
  } as unknown as character
}

function completeCollections(pluginCustomStorage: Record<string, unknown> = {}) {
  return Object.fromEntries(
    SERVER_COLLECTION_NAMES.map((name) => [name, name === 'pluginCustomStorage' ? pluginCustomStorage : []]),
  )
}

function seedResources(revision = 1): void {
  applySettingsResource({ revision, settings: { language: 'en' } })
  applyCollectionsResource({ revision, collections: completeCollections({ resident: true }) })
  const ada = metadataCharacter('char-a', 'Ada', 'chat-a', [{ role: 'user', data: 'resident-a' }])
  ada.chats[0].hypaV3Data = {
    summaries: [{ text: 'resident summary', chatMemos: [], isImportant: false }],
  }
  applyCharactersResource({
    version: 1,
    revision,
    characters: [ada, metadataCharacter('char-b', 'Bea', 'chat-b', [{ role: 'user', data: 'resident-b' }])],
    characterOrder: ['char-a', 'char-b'],
    currentChar: 0,
  })
}

function fullReadMocks(revision: number): void {
  api.settings.mockResolvedValue({ status: 'ok', revision, settings: { language: 'ko' } })
  api.collections.mockResolvedValue({
    status: 'ok',
    revision,
    collections: completeCollections({ authoritative: true }),
  })
  api.characters.mockResolvedValue({
    status: 'ok',
    version: 1,
    revision,
    characters: [
      metadataCharacter('char-a', 'Ada refreshed', 'chat-a'),
      metadataCharacter('char-b', 'Bea refreshed', 'chat-b'),
    ],
    characterOrder: ['char-b', 'char-a'],
    currentChar: 1,
  })
}

function shellSettings(language = 'en'): ServerShellSettings {
  return {
    language,
    username: 'User',
    colorScheme: {
      bgcolor: '#111111',
      darkbg: '#000000',
      borderc: '#222222',
      selected: '#333333',
      draculared: '#ff0000',
      textcolor: '#ffffff',
      textcolor2: '#cccccc',
      darkBorderc: '#444444',
      darkbutton: '#555555',
      type: 'dark',
    },
    colorSchemeName: 'custom',
    textTheme: 'standard',
    customTextTheme: {
      FontColorStandard: '#ffffff',
      FontColorBold: '#ffffff',
      FontColorItalic: '#cccccc',
      FontColorItalicBold: '#cccccc',
      FontColorQuote1: '#00ffff',
      FontColorQuote2: '#ffaa00',
    },
    font: 'default',
    customFont: '',
    customCSS: '',
    animationSpeed: 0.4,
    reducedMotion: false,
    heightMode: 'percent',
    sideBarSize: 0,
    roundIcons: false,
    menuSideBar: false,
    showFolderName: true,
    showSavingIcon: true,
    hamburgerButtonBottom: false,
    botSettingAtStart: false,
    enableDevTools: false,
    doNotWarnExternalServers: false,
    keepSessionAlive: 'off',
  }
}

function shellRead(revision: number) {
  return {
    status: 'ok' as const,
    protocolVersion: SERVER_SHELL_PROTOCOL_VERSION,
    revision,
    settings: shellSettings('ko'),
    characters: {
      version: 1 as const,
      revision,
      characters: [
        characterSummaryShell('char-a', 'Ada refreshed', 'chat-a'),
        characterSummaryShell('char-b', 'Bea refreshed', 'chat-b'),
      ],
      characterOrder: ['char-b', 'char-a'],
      currentChar: 1,
    },
  }
}

function event(revision: number, resource: string, ids: { id?: string; parentId?: string } = {}): CommandEvent {
  return { type: `${resource}.updated`, revision, resource, ...ids }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetClientSessionForTests()
  resetServerResourceState()
  lorebookPageOwner.reset()
  resetServerInlayCatalogResource()
  resetBardWikiResource()
  for (const mock of Object.values(api)) mock.mockReset()
  api.inlay.mockImplementation(async () => {
    const settingsResult = await api.settings.mock.results.at(-1)?.value
    return {
      status: 'ok',
      revision: settingsResult?.revision ?? 0,
      assets: [],
    }
  })
  for (const mock of Object.values(sideEffects)) mock.mockClear()
  languageSideEffects.change.mockClear()
  for (const mock of [
    promptHydration.ensure,
    promptHydration.invalidate,
    promptHydration.stale,
    promptHydration.mark,
    promptHydration.reset,
    promptHydration.isHydrated,
  ]) {
    mock.mockClear()
  }
  promptHydration.currentOwner = null
  promptHydration.isHydrated.mockReturnValue(true)
  sideEffects.mergePluginCollection.mockImplementation((value: any[]) => value)
  sideEffects.mergePluginProvider.mockImplementation((value: unknown) => (typeof value === 'string' ? value : ''))
  sideEffects.mergePluginStorage.mockImplementation((value: Record<string, unknown>) => value)
  sideEffects.mergeAgentPresetSettings.mockImplementation((value: Record<string, unknown>) => value)
  sideEffects.mergeAgentPresetLoadouts.mockImplementation((value: any[]) => value)
  sideEffects.mergeAgentPresetCharacters.mockImplementation((value: any[]) => value)
  promptHydration.ensure.mockResolvedValue(true)
})

afterEach(() => resetClientSessionForTests())

describe('API-backed resource invalidation', () => {
  it.each(['group', 'aggregate-group', 'collection', 'standalone'] as const)(
    'refreshes a loading %s on a committed event and rejects the older held demand read',
    async (kind) => {
      const held = deferred<any>()
      api.settingsGroup.mockImplementation(async (group: string) => ({
        status: 'ok',
        revision: 6,
        group,
        settings: group === 'runtime' ? { maxContext: 12000 } : {},
      }))
      api.collection.mockResolvedValue({
        status: 'ok',
        revision: 6,
        collections: { modules: [{ id: 'module-a', name: 'Committed' }] },
      })
      api.standaloneSetting.mockResolvedValue({
        status: 'ok',
        revision: 6,
        setting: 'loreBookPage',
        state: { present: true, value: 3 },
      })
      const group = kind === 'group' || kind === 'aggregate-group'
      if (group) {
        beginSettingsGroupResourceLoad('runtime')
        api.settingsGroup.mockReturnValueOnce(held.promise)
      } else if (kind === 'collection') {
        beginCollectionsResourceLoad('modules')
        api.collection.mockReturnValueOnce(held.promise)
      } else {
        beginStandaloneSettingResourceLoad('loreBookPage')
        api.standaloneSetting.mockReturnValueOnce(held.promise)
      }
      const pending = refreshServerResourceTargets(
        group
          ? { settingsGroups: ['runtime'] }
          : kind === 'collection'
            ? { collections: ['modules'] }
            : { standaloneSettings: ['loreBookPage'] },
        { mode: 'reader' },
      )
      const changed =
        kind === 'group'
          ? event(6, 'settings', { id: 'runtime' })
          : kind === 'collection'
            ? event(6, 'moduleUpdated', { id: 'module-a' })
            : event(6, 'presetPointer')
      expect(await refreshInvalidatedServerResources(changed, { mode: 'reader', appliedRevision: 5 })).toEqual({
        status: 'ok',
        revision: 6,
        scope: 'targeted',
      })
      if (group) {
        expect(api.settingsGroup.mock.calls.filter(([name]) => name === 'runtime')).toHaveLength(2)
        expect(settingsResourceState.groupStatuses.runtime).toBe('ready')
        expect(settingsResourceState.groupRevisions.runtime).toBe(6)
      } else if (kind === 'collection') {
        expect(api.collection).toHaveBeenCalledTimes(2)
        expect(collectionsResourceState.statuses.modules).toBe('ready')
        expect(collectionsResourceState.revisions.modules).toBe(6)
      } else {
        expect(api.standaloneSetting).toHaveBeenCalledTimes(2)
        expect(settingsResourceState.standaloneStatuses.loreBookPage).toBe('ready')
        expect(settingsResourceState.standaloneRevisions.loreBookPage).toBe(6)
      }
      held.resolve(
        group
          ? { status: 'ok', revision: 5, group: 'runtime', settings: { maxContext: 6000 } }
          : kind === 'collection'
            ? { status: 'ok', revision: 5, collections: { modules: [{ id: 'module-a', name: 'Old' }] } }
            : { status: 'ok', revision: 5, setting: 'loreBookPage', state: { present: true, value: 1 } },
      )
      expect(await pending).toEqual({ status: 'error', error: 'Reader resource refresh was superseded before apply' })
      if (group) expect(getResourceDatabase().maxContext).toBe(12000)
      else if (kind === 'collection') expect(getResourceDatabase().modules[0].name).toBe('Committed')
      else expect(getResourceDatabase().loreBookPage).toBe(3)
    },
  )

  it.each(['full', 'targeted'] as const)(
    'does not acknowledge a reader %s snapshot superseded by concurrent detail hydration',
    async (kind) => {
      seedResources(5)
      fullReadMocks(6)
      const held = deferred<any>()
      if (kind === 'full') api.settings.mockReturnValueOnce(held.promise)
      else api.character.mockReturnValueOnce(held.promise)
      const request =
        kind === 'full'
          ? refreshAllServerResources({ mode: 'reader' })
          : refreshInvalidatedServerResources(event(6, 'characterRow', { id: 'char-a' }), {
              mode: 'reader',
              appliedRevision: 5,
            })
      applyCharacterResource({ revision: 5, character: metadataCharacter('char-a', 'Concurrent detail', 'chat-a') })
      held.resolve(
        kind === 'full'
          ? { status: 'ok', revision: 6, settings: { language: 'ko' } }
          : { status: 'ok', revision: 6, character: metadataCharacter('char-a', 'New event', 'chat-a') },
      )
      expect(await request).toEqual({ status: 'error', error: 'Reader resource refresh was superseded before apply' })
      expect(getResourceDatabase().characters[0].name).toBe('Concurrent detail')
    },
  )

  it('retains the readable reader transcript when an optional full-refresh BardWiki read fails', async () => {
    seedResources(5)
    fullReadMocks(6)
    applyBardWikiChatResource({
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 5,
      chatId: 'chat-a',
      globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      chatSettings: null,
      effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      confirmationCandidate: null,
      documents: [],
      receipts: [],
      jobs: [],
    })
    api.bardWikiChat.mockResolvedValue({ status: 'error', error: 'offline' })
    const onFullProjectionApplied = vi.fn()
    expect(await refreshAllServerResources({ mode: 'reader', onFullProjectionApplied })).toEqual({
      status: 'error',
      error: 'offline',
    })
    expect(getResourceDatabase().language).toBe('en')
    expect(getResourceDatabase().characters[0].chats[0].message).toEqual([{ role: 'user', data: 'resident-a' }])
    expect(onFullProjectionApplied).not.toHaveBeenCalled()
  })

  it('automatically fences a legacy writer refresh when its managed session is replaced', async () => {
    seedResources(5)
    fullReadMocks(6)
    const held = deferred<any>()
    api.settings.mockReturnValueOnce(held.promise)
    const request = refreshAllServerResources({ hooks })
    beginClientSession('new-reader')
    held.resolve({ status: 'ok', revision: 6, settings: { language: 'ko' } })
    expect(await request).toEqual({ status: 'unavailable' })
    expect(getResourceDatabase().language).toBe('en')
    expect(sideEffects.reapplyPendingPresets).not.toHaveBeenCalled()
  })

  it.each(['shell', 'full', 'targeted'] as const)(
    'rejects a superseded reader %s response before projection apply',
    async (kind) => {
      seedResources(5)
      let current = true
      const held = deferred<any>()
      const options = { mode: 'reader' as const, isCurrent: () => current, onFullProjectionApplied: vi.fn() }
      fullReadMocks(6)
      if (kind === 'shell') api.shell.mockReturnValueOnce(held.promise)
      if (kind === 'full') api.settings.mockReturnValueOnce(held.promise)
      if (kind === 'targeted') api.settingsGroup.mockReturnValueOnce(held.promise)
      const request =
        kind === 'shell'
          ? loadInitialServerResources(options)
          : kind === 'full'
            ? refreshAllServerResources(options)
            : refreshInvalidatedServerResources(event(6, 'settings', { id: 'language' }), {
                ...options,
                appliedRevision: 5,
              })
      await Promise.resolve()
      current = false
      held.resolve(
        kind === 'shell'
          ? shellRead(6)
          : kind === 'full'
            ? { status: 'ok', revision: 6, settings: { language: 'ko' } }
            : { status: 'ok', revision: 6, group: 'language', settings: { language: 'ko' } },
      )
      expect(await request).toEqual({ status: 'unavailable' })
      expect(getResourceDatabase().language).toBe('en')
      expect(getResourceDatabase().characters[0].name).toBe('Ada')
      expect(options.onFullProjectionApplied).not.toHaveBeenCalled()
    },
  )

  it('ignores foreign navigation and leaves reader prompt authoring bodies lazy', async () => {
    seedResources(5)
    await expect(
      refreshInvalidatedServerResources(
        [
          event(6, 'characterSelection', { id: 'char-b' }),
          event(7, 'promptItem', { id: 'item-a', parentId: 'prompt-a' }),
        ],
        { mode: 'reader', appliedRevision: 5 },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 7, scope: 'targeted' })
    expect(api.characterSelection).not.toHaveBeenCalled()
    expect(charactersResourceState.currentChar).toBe(0)
    expect(promptHydration.invalidate).toHaveBeenCalledWith('prompt-a')
    expect(promptHydration.ensure).not.toHaveBeenCalled()
  })

  it('applies committed reader messages without requiring a generation reattachment hook', async () => {
    seedResources(5)
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 6,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'committed' }],
      alternates: [],
    })
    await expect(
      refreshInvalidatedServerResources(event(6, 'message', { id: 'message-a', parentId: 'chat-a' }), {
        mode: 'reader',
        appliedRevision: 5,
        hooks: {
          applyChatMessages: sideEffects.applyChat,
          clearActiveMessageTranslation: sideEffects.clearTranslation,
        },
      }),
    ).resolves.toEqual({ status: 'ok', revision: 6, scope: 'targeted' })
    expect(sideEffects.applyChat).toHaveBeenCalledOnce()
    expect(sideEffects.reattach).not.toHaveBeenCalled()
    expect(sideEffects.reapplyPendingPresets).not.toHaveBeenCalled()
  })

  it('does not apply a BardWiki read after its reader operation was stopped', async () => {
    seedResources(5)
    const resident = {
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 5,
      chatId: 'chat-a',
      globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      chatSettings: null,
      effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      confirmationCandidate: null,
      documents: [],
      receipts: [],
      jobs: [],
    }
    applyBardWikiChatResource(resident)
    let current = true
    const held = deferred<any>()
    api.bardWikiChat.mockReturnValueOnce(held.promise)
    const request = refreshInvalidatedServerResources(event(6, 'bardWikiChat', { id: 'chat-a' }), {
      mode: 'reader',
      appliedRevision: 5,
      isCurrent: () => current,
    })
    await vi.waitFor(() => expect(api.bardWikiChat).toHaveBeenCalledOnce())
    current = false
    held.resolve({ status: 'ok', ...resident, revision: 6 })
    expect(await request).toEqual({ status: 'unavailable' })
    expect(getBardWikiChatResource('chat-a')?.revision).toBe(5)
  })

  it.each(['full', 'targeted'] as const)(
    'does not advance a reader %s cursor over unrelated commits observed by a newer BardWiki read',
    async (kind) => {
      seedResources(5)
      const resident = {
        protocolVersion: BARDWIKI_PROTOCOL_VERSION,
        revision: 5,
        chatId: 'chat-a',
        globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        chatSettings: null,
        effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        confirmationCandidate: null,
        documents: [],
        receipts: [],
        jobs: [],
      }
      applyBardWikiChatResource(resident)
      api.bardWikiChat.mockResolvedValue({ status: 'ok', ...resident, revision: 8 })
      fullReadMocks(6)
      const result =
        kind === 'full'
          ? await refreshAllServerResources({ mode: 'reader' })
          : await refreshInvalidatedServerResources(event(6, 'bardWikiChat', { id: 'chat-a' }), {
              mode: 'reader',
              appliedRevision: 5,
            })
      expect(result).toEqual({ status: 'ok', revision: 6, scope: kind })
      expect(getBardWikiChatResource('chat-a')?.revision).toBe(8)
    },
  )

  it('loads only the coherent shell at ordinary startup', async () => {
    seedResources(4)
    api.shell.mockResolvedValue(shellRead(5))

    await expect(loadInitialServerResources({ hooks })).resolves.toEqual({ status: 'ok', revision: 5, scope: 'shell' })

    const database = getResourceDatabase()
    expect(database).toMatchObject({
      language: 'ko',
      pluginCustomStorage: { resident: true },
      currentChar: 1,
    })
    expect(database.characters.find((candidate) => candidate.chaId === 'char-a')).toMatchObject({
      chaId: 'char-a',
      name: 'Ada refreshed',
      chats: [
        {
          message: [],
        },
      ],
    })
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
    expect(api.inlay).not.toHaveBeenCalled()
    expect(sideEffects.mergeAgentPresetCharacters).toHaveBeenCalledOnce()
    expect(languageSideEffects.change).toHaveBeenLastCalledWith('ko')
  })

  it('refreshes only resident slices for contiguous events but keeps gap recovery complete', async () => {
    api.shell.mockResolvedValue(shellRead(1))
    await expect(loadInitialServerResources({ hooks })).resolves.toMatchObject({ status: 'ok', scope: 'shell' })
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'display',
      settings: { colorSchemeName: 'remote' },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'settings', { id: 'display' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(api.settingsGroup).toHaveBeenCalledWith('display', undefined)

    api.settingsGroup.mockClear()
    await expect(
      refreshInvalidatedServerResources(event(3, 'settings', { id: 'runtime' }), {
        appliedRevision: 2,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })
    expect(api.settingsGroup).not.toHaveBeenCalled()

    await expect(
      refreshInvalidatedServerResources(event(4, 'pluginCollection'), { appliedRevision: 3, hooks }),
    ).resolves.toEqual({ status: 'ok', revision: 4, scope: 'targeted' })
    expect(api.collection).not.toHaveBeenCalled()

    await expect(
      refreshInvalidatedServerResources(event(5, 'inlayCatalog'), { appliedRevision: 4, hooks }),
    ).resolves.toEqual({ status: 'ok', revision: 5, scope: 'targeted' })
    expect(api.inlay).not.toHaveBeenCalled()

    fullReadMocks(7)
    await expect(
      refreshInvalidatedServerResources(event(7, 'settings', { id: 'runtime' }), {
        appliedRevision: 5,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 7, scope: 'full' })
    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collections).toHaveBeenCalledOnce()
    expect(api.characters).toHaveBeenCalledOnce()
    expect(api.inlay).toHaveBeenCalledOnce()
  })

  it('refreshes the server-owned inlay catalog for another client event', async () => {
    const assetId = 'a'.repeat(64)
    applyServerInlayCatalogResource({ revision: 1, assets: [] })
    api.inlay.mockResolvedValue({
      status: 'ok',
      revision: 2,
      assets: [
        {
          assetId,
          aliases: ['friendly-id'],
          ext: 'png',
          name: 'shared.png',
          size: 12,
          type: 'image',
          width: 4,
          height: 3,
        },
      ],
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'inlayCatalog.upserted', resource: 'inlayCatalog', id: assetId, revision: 2 },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(getServerInlayCatalogResource()).toMatchObject({
      revision: 2,
      assets: [{ assetId, aliases: ['friendly-id'], name: 'shared.png' }],
    })
    expect(api.settings).not.toHaveBeenCalled()
  })

  it('replaces a newer browser catalog with a restored full snapshot', async () => {
    const newerId = 'b'.repeat(64)
    const restoredId = 'c'.repeat(64)
    applyServerInlayCatalogResource({
      revision: 9,
      assets: [{ assetId: newerId, aliases: [], ext: 'png', name: 'newer.png', size: 9, type: 'image' }],
    })
    fullReadMocks(3)
    api.inlay.mockResolvedValue({
      status: 'ok',
      revision: 3,
      assets: [{ assetId: restoredId, aliases: [], ext: 'png', name: 'restored.png', size: 3, type: 'image' }],
    })

    await expect(refreshAllServerResources({ hooks })).resolves.toEqual({ status: 'ok', revision: 3, scope: 'full' })
    expect(getServerInlayCatalogResource()).toMatchObject({
      revision: 3,
      assets: [{ assetId: restoredId, name: 'restored.png' }],
    })
  })

  it('preserves pending Agent Preset settings and deletion cascades during a full refresh', async () => {
    const authoritativeCharacter = metadataCharacter('char-a', 'Ada refreshed', 'chat-a')
    authoritativeCharacter.chats[0].generationSettings = {
      agentPresetId: 'agent-delete',
    } as never
    api.settings.mockResolvedValue({
      status: 'ok',
      revision: 5,
      settings: {
        language: 'ko',
        agentPresets: [{ id: 'agent-delete', name: 'Authoritative name', enabled: true, version: 1, steps: [] }],
        agentPresetDefaultId: 'agent-delete',
      },
    })
    api.collections.mockResolvedValue({
      status: 'ok',
      revision: 5,
      collections: {
        ...completeCollections(),
        loadouts: [
          {
            id: 'loadout-a',
            name: 'Loadout A',
            agentPresetId: 'agent-delete',
            agentPresetName: 'Authoritative name',
          },
        ],
      },
    })
    api.characters.mockResolvedValue({
      status: 'ok',
      version: 1,
      revision: 5,
      characters: [authoritativeCharacter],
      characterOrder: ['char-a'],
      currentChar: 0,
    })
    sideEffects.mergeAgentPresetSettings.mockImplementation((value) => ({
      ...value,
      agentPresets: [{ id: 'agent-delete', name: 'Pending name', enabled: true, version: 1, steps: [] }],
    }))
    sideEffects.mergeAgentPresetLoadouts.mockImplementation((value) =>
      value.map(({ agentPresetId: _agentPresetId, agentPresetName: _agentPresetName, ...loadout }) => loadout),
    )
    sideEffects.mergeAgentPresetCharacters.mockImplementation((value) =>
      value.map((character) => ({
        ...character,
        chats: character.chats.map((chat: any) => ({
          ...chat,
          generationSettings: {},
        })),
      })),
    )

    await expect(refreshAllServerResources({ hooks })).resolves.toEqual({ status: 'ok', revision: 5, scope: 'full' })

    expect(getResourceDatabase().agentPresets[0].name).toBe('Pending name')
    expect(getResourceDatabase().loadouts).toEqual([{ id: 'loadout-a', name: 'Loadout A' }])
    expect(getResourceDatabase().characters[0].chats[0].generationSettings).toEqual({})
    expect(sideEffects.mergeAgentPresetSettings).toHaveBeenCalledOnce()
    expect(sideEffects.mergeAgentPresetLoadouts).toHaveBeenCalledOnce()
    expect(sideEffects.mergeAgentPresetCharacters).toHaveBeenCalledOnce()
  })

  it('retries inconsistent full reads and applies only a common revision', async () => {
    const optimisticEpoch = captureDestructiveRefreshEpoch()
    api.settings
      .mockResolvedValueOnce({ status: 'ok', revision: 5, settings: { language: 'stale' } })
      .mockResolvedValueOnce({ status: 'ok', revision: 7, settings: { language: 'fresh' } })
    api.collections
      .mockResolvedValueOnce({ status: 'ok', revision: 6, collections: completeCollections() })
      .mockResolvedValueOnce({ status: 'ok', revision: 7, collections: completeCollections() })
    api.characters
      .mockResolvedValueOnce({
        status: 'ok',
        version: 1,
        revision: 6,
        characters: [],
        characterOrder: [],
        currentChar: -1,
      })
      .mockResolvedValueOnce({
        status: 'ok',
        version: 1,
        revision: 7,
        characters: [],
        characterOrder: [],
        currentChar: -1,
      })

    await expect(refreshAllServerResources({ hooks })).resolves.toEqual({ status: 'ok', revision: 7, scope: 'full' })
    expect(api.settings).toHaveBeenCalledTimes(2)
    expect(getResourceDatabase().language).toBe('fresh')
    expect(hasDestructiveRefreshEpochChanged(optimisticEpoch)).toBe(true)
  })

  it('fails after bounded revision mismatches without applying any response', async () => {
    seedResources(1)
    api.settings.mockResolvedValue({ status: 'ok', revision: 2, settings: { language: 'not-applied' } })
    api.collections.mockResolvedValue({ status: 'ok', revision: 3, collections: completeCollections() })
    api.characters.mockResolvedValue({
      status: 'ok',
      version: 1,
      revision: 3,
      characters: [],
      characterOrder: [],
      currentChar: -1,
    })

    const result = await refreshAllServerResources({ hooks })
    expect(result).toEqual({
      status: 'error',
      error: `Server resource revisions did not converge after ${FULL_RESOURCE_REFRESH_MAX_ATTEMPTS} attempts`,
    })
    expect(api.settings).toHaveBeenCalledTimes(FULL_RESOURCE_REFRESH_MAX_ATTEMPTS)
    expect(getResourceDatabase().language).toBe('en')
    expect(getResourceDatabase().characters).toHaveLength(2)
  })

  it('coalesces known events into minimal settings, collection, and character reads', async () => {
    seedResources(5)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 10,
      group: 'language',
      settings: { language: 'ja' },
    })
    api.collection.mockImplementation(async (name: string) => ({
      status: 'ok',
      revision: 10,
      collections: { [name]: name === 'modules' ? [{ id: 'module-a', name: 'A', description: '' }] : [] },
    }))
    api.character.mockResolvedValue({
      status: 'ok',
      revision: 10,
      character: metadataCharacter('char-a', 'Ada updated', 'chat-a'),
    })

    const result = await refreshInvalidatedServerResources(
      [
        event(6, 'settings', { id: 'language' }),
        event(7, 'moduleUpdated', { id: 'module-a' }),
        event(8, 'characterRow', { id: 'char-a' }),
      ],
      { appliedRevision: 5, hooks },
    )

    expect(result).toEqual({ status: 'ok', revision: 8, scope: 'targeted' })
    expect(api.settingsGroup).toHaveBeenCalledWith('language', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collection).toHaveBeenCalledWith('modules', undefined)
    expect(api.character).toHaveBeenCalledWith('char-a', undefined)
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
    expect(api.chat).not.toHaveBeenCalled()
    const database = getResourceDatabase()
    expect(database).toMatchObject({ language: 'ja', modules: [{ id: 'module-a' }] })
    expect(languageSideEffects.change).toHaveBeenLastCalledWith('ja')
    expect(sideEffects.reapplyPendingPresets).toHaveBeenCalledTimes(1)
    expect(database.characters.find((candidate) => candidate.chaId === 'char-a')).toMatchObject({
      chaId: 'char-a',
      name: 'Ada updated',
      chats: [{ message: [{ role: 'user', data: 'resident-a' }] }],
    })
  })

  it('refreshes only the affected greeting translation projection for its targeted event', async () => {
    seedResources(5)
    await expect(
      refreshInvalidatedServerResources(event(6, 'greetingTranslation', { id: 'char-a' }), {
        appliedRevision: 5,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 6, scope: 'targeted' })
    expect(sideEffects.refreshGreeting).toHaveBeenCalledWith('char-a', 6)
    expect(api.character).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
    expect(api.settings).not.toHaveBeenCalled()
  })

  it('keeps an optimistic character-row edit when an older generic read completes', async () => {
    seedResources(1)
    const staleCharacter = metadataCharacter('char-a', 'Ada', 'chat-a')
    staleCharacter.customscript = [{ id: 'script-a', out: 'server before edit' }] as never
    applyCharacterResource({ revision: 1, character: staleCharacter })
    const response = deferred<{
      status: 'ok'
      revision: number
      character: character
    }>()
    api.character.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(event(2, 'characterRow', { id: 'char-a' }), {
      appliedRevision: 1,
      hooks,
    })
    expect(api.character).toHaveBeenCalledWith('char-a', undefined)

    withTestDatabaseWrite(() => {
      const liveCharacter = getResourceDatabase().characters.find((candidate) => candidate.chaId === 'char-a')
      if (!liveCharacter) throw new Error('Missing optimistic character')
      liveCharacter.customscript = [{ id: 'script-a', out: 'newer optimistic edit' }] as never
    })
    response.resolve({ status: 'ok', revision: 2, character: staleCharacter })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(getResourceDatabase().characters[0].customscript).toEqual([{ id: 'script-a', out: 'newer optimistic edit' }])
  })

  it('keeps an optimistic collection edit when an older generic read completes', async () => {
    seedResources(1)
    applyCollectionsResource({
      revision: 1,
      collections: { modules: [{ id: 'module-a', name: 'Before', regex: [] }] as never },
    })
    const response = deferred<{
      status: 'ok'
      revision: number
      collections: { modules: unknown[] }
    }>()
    api.collection.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(event(2, 'moduleUpdated', { id: 'module-a' }), {
      appliedRevision: 1,
      hooks,
    })
    expect(api.collection).toHaveBeenCalledWith('modules', undefined)

    withTestDatabaseWrite(() => {
      const live = getResourceDatabase()
      live.modules = [{ id: 'module-a', name: 'Optimistic', regex: [] }] as never
    })
    response.resolve({
      status: 'ok',
      revision: 2,
      collections: { modules: [{ id: 'module-a', name: 'Before', regex: [] }] },
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(getResourceDatabase().modules).toEqual([{ id: 'module-a', name: 'Optimistic', regex: [] }])
  })

  it('does not let a complete refresh replace a slice edited after the refresh started', async () => {
    seedResources(1)
    const settingsResponse = deferred<{
      status: 'ok'
      revision: number
      settings: Record<string, unknown>
    }>()
    const collectionsResponse = deferred<{
      status: 'ok'
      revision: number
      collections: ReturnType<typeof completeCollections>
    }>()
    const charactersResponse = deferred<{
      status: 'ok'
      version: 1
      revision: number
      characters: character[]
      characterOrder: string[]
      currentChar: number
    }>()
    api.settings.mockReturnValue(settingsResponse.promise)
    api.collections.mockReturnValue(collectionsResponse.promise)
    api.characters.mockReturnValue(charactersResponse.promise)

    const refresh = refreshAllServerResources({ hooks })
    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collections).toHaveBeenCalledOnce()
    expect(api.characters).toHaveBeenCalledOnce()

    withTestDatabaseWrite(() => {
      const liveCharacter = getResourceDatabase().characters.find((candidate) => candidate.chaId === 'char-a')
      if (!liveCharacter) throw new Error('Missing optimistic character')
      liveCharacter.customscript = [{ id: 'script-a', out: 'optimistic during refresh' }] as never
    })

    settingsResponse.resolve({ status: 'ok', revision: 2, settings: { language: 'ko' } })
    collectionsResponse.resolve({ status: 'ok', revision: 2, collections: completeCollections() })
    charactersResponse.resolve({
      status: 'ok',
      version: 1,
      revision: 2,
      characters: [metadataCharacter('char-a', 'Ada restored', 'chat-a')],
      characterOrder: ['char-a'],
      currentChar: 0,
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'full' })
    expect(getResourceDatabase().language).toBe('ko')
    expect(getResourceDatabase().characters[0]).toMatchObject({
      name: 'Ada',
      customscript: [{ id: 'script-a', out: 'optimistic during refresh' }],
    })
  })

  it('reads only loadouts for favorite events and adds sidebar settings for touches', async () => {
    seedResources(5)
    const loadouts = [
      {
        id: 'loadout-a',
        name: 'Loadout A',
        lastUsed: 200,
        favorite: true,
        characterIds: [],
        modules: [],
        globalVariables: {},
        presetName: '',
        modelPresetId: '',
        modelPresetName: '',
        promptPresetId: '',
        promptPresetName: '',
        personaId: '',
      },
    ]
    api.collection.mockImplementation(async (name: string) => ({
      status: 'ok',
      revision: 7,
      collections: { [name]: loadouts },
    }))
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 7,
      group: 'sidebar',
      settings: { lastLoadedLoadoutName: 'Loadout A' },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'loadout.favorited', revision: 6, resource: 'loadout', id: 'loadout-a' },
        { appliedRevision: 5, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 6, scope: 'targeted' })
    expect(api.collection).toHaveBeenCalledWith('loadouts', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.settingsGroup).not.toHaveBeenCalled()

    api.collection.mockClear()
    await expect(
      refreshInvalidatedServerResources(
        { type: 'loadout.touched', revision: 7, resource: 'loadout', id: 'loadout-a' },
        { appliedRevision: 6, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 7, scope: 'targeted' })
    expect(api.collection).toHaveBeenCalledWith('loadouts', undefined)
    expect(api.settingsGroup).toHaveBeenCalledWith('sidebar', undefined)
    expect(api.settings).not.toHaveBeenCalled()
  })

  it('reads only language settings alongside translator preset mutations', async () => {
    seedResources(1)
    const translatorPresets = [
      {
        id: 'preset-a',
        name: 'Authoritative translator',
        prompt: 'Translate this',
        maxResponse: 2048,
      },
    ]
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'language',
      settings: {
        translatorPresetId: 'preset-a',
        translatorPrompt: 'Translate this',
        translatorMaxResponse: 2048,
      },
    })
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: { translatorPresets },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'translatorPreset.updated', revision: 2, resource: 'translatorPreset', id: 'preset-a' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('language', undefined)
    expect(api.collection).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledWith('translatorPresets', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({
      translatorPresets,
      translatorPresetId: 'preset-a',
      translatorPrompt: 'Translate this',
      translatorMaxResponse: 2048,
    })
  })

  it('reads Hypa presets only for the cross-resource memory settings event', async () => {
    seedResources(1)
    api.settingsGroup
      .mockResolvedValueOnce({ status: 'ok', revision: 2, group: 'memory', settings: { hypaV3: true } })
      .mockResolvedValueOnce({ status: 'ok', revision: 3, group: 'memory', settings: { hypaV3: true } })
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 3,
      collections: { hypaV3Presets: [{ name: 'Authoritative memory' }] },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'settings', { id: 'memory' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('memory', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collection).not.toHaveBeenCalled()

    await expect(
      refreshInvalidatedServerResources(event(3, 'settingsWithHypaV3Presets', { id: 'memory' }), {
        appliedRevision: 2,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })
    expect(api.settingsGroup).toHaveBeenCalledTimes(2)
    expect(api.collection).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledWith('hypaV3Presets', undefined)
    expect(getResourceDatabase().hypaV3Presets).toEqual([{ name: 'Authoritative memory' }])
  })

  it('spends one scoped request for a settings-group invalidation', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'display',
      settings: { theme: 'light' },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'settings', { id: 'display' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('display', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
  })

  it('coalesces well-formed Agent Preset events into one agents-group read', async () => {
    seedResources(1)
    const agentPresets = [{ id: 'agent-a', name: 'Agent A', enabled: true, version: 1, steps: [] }]
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 11,
      group: 'agents',
      settings: { agentPresets, agentPresetDefaultId: 'agent-a' },
    })
    const events: CommandEvent[] = [
      { type: 'agentPreset.created', revision: 2, resource: 'agentPreset', id: 'agent-a' },
      { type: 'agentPreset.updated', revision: 3, resource: 'agentPreset', id: 'agent-a' },
      {
        type: 'agentPreset.duplicated',
        revision: 4,
        resource: 'agentPreset',
        id: 'agent-b',
        parentId: 'agent-a',
      },
      { type: 'agentPreset.reordered', revision: 5, resource: 'agentPreset' },
      { type: 'agentPreset.default.updated', revision: 6, resource: 'agentPreset', id: 'agent-a' },
      {
        type: 'agentPreset.step.created',
        revision: 7,
        resource: 'agentPreset',
        id: 'step-a',
        parentId: 'agent-a',
      },
      {
        type: 'agentPreset.step.updated',
        revision: 8,
        resource: 'agentPreset',
        id: 'step-a',
        parentId: 'agent-a',
      },
      {
        type: 'agentPreset.step.duplicated',
        revision: 9,
        resource: 'agentPreset',
        id: 'step-b',
        parentId: 'agent-a',
      },
      {
        type: 'agentPreset.step.deleted',
        revision: 10,
        resource: 'agentPreset',
        id: 'step-b',
        parentId: 'agent-a',
      },
      { type: 'agentPreset.step.reordered', revision: 11, resource: 'agentPreset', id: 'agent-a' },
    ]

    await expect(refreshInvalidatedServerResources(events, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 11,
      scope: 'targeted',
    })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('agents', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({ agentPresets, agentPresetDefaultId: 'agent-a' })
  })

  it('coalesces standalone Agent and preset-use events into one agents-group read', async () => {
    seedResources(1)
    const agents = [
      {
        id: 'agent-a',
        name: 'Agent A',
        version: 1,
        instruction: 'Help',
        modelDefaults: { mode: 'inheritMain' },
        runtimeDefaults: {},
        inputScopes: [],
        outputFormat: 'text',
      },
    ]
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 10,
      group: 'agents',
      settings: { agents, agentPresets: [] },
    })
    const events: CommandEvent[] = [
      { type: 'agent.created', revision: 2, resource: 'agentPreset', id: 'agent-a' },
      { type: 'agent.updated', revision: 3, resource: 'agentPreset', id: 'agent-a' },
      {
        type: 'agent.duplicated',
        revision: 4,
        resource: 'agentPreset',
        id: 'agent-b',
        parentId: 'agent-a',
      },
      { type: 'agent.deleted', revision: 5, resource: 'agentPreset', id: 'agent-b' },
      { type: 'agent.reordered', revision: 6, resource: 'agentPreset' },
      {
        type: 'agentPreset.use.created',
        revision: 7,
        resource: 'agentPreset',
        id: 'use-a',
        parentId: 'preset-a',
      },
      {
        type: 'agentPreset.use.updated',
        revision: 8,
        resource: 'agentPreset',
        id: 'use-a',
        parentId: 'preset-a',
      },
      {
        type: 'agentPreset.use.deleted',
        revision: 9,
        resource: 'agentPreset',
        id: 'use-a',
        parentId: 'preset-a',
      },
      { type: 'agentPreset.use.reordered', revision: 10, resource: 'agentPreset', id: 'preset-a' },
    ]

    await expect(refreshInvalidatedServerResources(events, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 10,
      scope: 'targeted',
    })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('agents', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({ agents, agentPresets: [] })
  })

  it('refreshes the agents group plus deletion cascades for an Agent Preset delete', async () => {
    seedResources(1)
    applySettingsResource({
      revision: 1,
      settings: {
        language: 'en',
        agentPresets: [
          { id: 'agent-delete', name: 'Delete', enabled: true, version: 1, steps: [] },
          { id: 'agent-keep', name: 'Keep', enabled: true, version: 1, steps: [] },
        ],
        agentPresetDefaultId: 'agent-delete',
      },
    })
    const agentPresets = [{ id: 'agent-keep', name: 'Keep', enabled: true, version: 1, steps: [] }]
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'agents',
      settings: { agentPresets },
    })
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: {
        loadouts: [
          {
            id: 'loadout-a',
            name: 'Loadout A',
            agentPresetId: 'agent-delete',
            agentPresetName: 'Delete',
          },
        ],
      },
    })
    const authoritativeCharacter = metadataCharacter('char-a', 'Ada authoritative')
    authoritativeCharacter.chats[0].generationSettings = { agentPresetId: 'agent-delete' } as never
    api.characters.mockResolvedValue({
      status: 'ok',
      version: 1,
      revision: 2,
      characters: [authoritativeCharacter],
      characterOrder: ['char-a'],
      currentChar: 0,
    })
    sideEffects.mergeAgentPresetLoadouts.mockImplementation((value) =>
      value.map(({ agentPresetId: _agentPresetId, agentPresetName: _agentPresetName, ...loadout }) => loadout),
    )
    sideEffects.mergeAgentPresetCharacters.mockImplementation((value) =>
      value.map((character) => ({
        ...character,
        chats: character.chats.map((chat: any) => ({ ...chat, generationSettings: {} })),
      })),
    )

    await expect(
      refreshInvalidatedServerResources(
        { type: 'agentPreset.deleted', revision: 2, resource: 'agentPresetDeleted', id: 'agent-delete' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledWith('agents', undefined)
    expect(api.collection).toHaveBeenCalledWith('loadouts', undefined)
    expect(api.characters).toHaveBeenCalledOnce()
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({ agentPresets, loadouts: [{ id: 'loadout-a' }] })
    expect(getResourceDatabase().characters[0].chats[0].generationSettings).toEqual({})
    expect(getResourceDatabase()).not.toHaveProperty('agentPresetDefaultId')
    expect(sideEffects.mergeAgentPresetSettings).toHaveBeenCalledOnce()
    expect(sideEffects.mergeAgentPresetLoadouts).toHaveBeenCalledOnce()
    expect(sideEffects.mergeAgentPresetCharacters).toHaveBeenCalledOnce()
  })

  it('preserves pending Agent Preset chat cleanup on an unrelated targeted character read', async () => {
    seedResources(1)
    const authoritativeCharacter = metadataCharacter('char-a', 'Ada authoritative', 'chat-a')
    authoritativeCharacter.chats[0].generationSettings = { agentPresetId: 'agent-delete' } as never
    api.character.mockResolvedValue({
      status: 'ok',
      revision: 2,
      character: authoritativeCharacter,
    })
    sideEffects.mergeAgentPresetCharacters.mockImplementation((value) =>
      value.map((character) => ({
        ...character,
        chats: character.chats.map((chat: any) => ({ ...chat, generationSettings: {} })),
      })),
    )

    await expect(
      refreshInvalidatedServerResources(event(2, 'characterRow', { id: 'char-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.character).toHaveBeenCalledWith('char-a', undefined)
    expect(getResourceDatabase().characters[0].chats[0].generationSettings).toEqual({})
    expect(sideEffects.mergeAgentPresetCharacters).toHaveBeenCalledOnce()
  })

  it.each([
    { type: 'agentPreset.future', revision: 2, resource: 'agentPreset', id: 'agent-a' },
    { type: 'agentPreset.updated', revision: 2, resource: 'agentPreset' },
    { type: 'agentPreset.reordered', revision: 2, resource: 'agentPreset', id: 'agent-a' },
    { type: 'agentPreset.step.updated', revision: 2, resource: 'agentPreset', id: 'step-a' },
    {
      type: 'agentPreset.default.updated',
      revision: 2,
      resource: 'agentPreset',
      parentId: 'unexpected-parent',
    },
    { type: 'agentPreset.updated', revision: 2, resource: 'agentPresetDeleted', id: 'agent-a' },
    { type: 'agentPreset.deleted', revision: 2, resource: 'agentPresetDeleted' },
  ] as CommandEvent[])('uses a full refresh for malformed Agent Preset event %#', async (commandEvent) => {
    fullReadMocks(9)

    await expect(refreshInvalidatedServerResources(commandEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 9,
      scope: 'full',
    })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collections).toHaveBeenCalledOnce()
    expect(api.characters).toHaveBeenCalledOnce()
    expect(api.settingsGroup).not.toHaveBeenCalled()
  })

  it('narrows the legacy prompt-settings event to the prompt settings group', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'prompt',
      settings: { mainPrompt: 'authoritative', fallbackModels: ['model-a'] },
    })
    const legacyEvent: CommandEvent = {
      type: 'prompt.settings.updated',
      revision: 2,
      resource: 'prompt',
    }

    await expect(
      refreshInvalidatedServerResources(legacyEvent, {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('prompt', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.characters).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({
      mainPrompt: 'authoritative',
      fallbackModels: ['model-a'],
    })
  })

  it.each([
    [
      'group then full',
      [
        event(2, 'settings', { id: 'display' }),
        {
          type: 'lorebook.selected',
          revision: 3,
          resource: 'globalLorebook',
          id: 'lore-a',
        } as CommandEvent,
      ],
    ],
    [
      'full then group',
      [
        {
          type: 'lorebook.selected',
          revision: 2,
          resource: 'globalLorebook',
          id: 'lore-a',
        } as CommandEvent,
        event(3, 'settings', { id: 'display' }),
      ],
    ],
  ])('lets a full settings read subsume a scoped read in either order: %s', async (_label, events) => {
    seedResources(1)
    api.settings.mockResolvedValue({ status: 'ok', revision: 3, settings: { theme: 'light' } })

    await expect(refreshInvalidatedServerResources(events, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 3,
      scope: 'targeted',
    })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.settingsGroup).not.toHaveBeenCalled()
  })

  it('reads only enabled modules for foreign module enable events', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'modules',
      settings: { enabledModules: ['module-a'] },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'moduleEnabled', { id: 'module-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('modules', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(getResourceDatabase().enabledModules).toEqual(['module-a'])
  })

  it('reads only the modules settings group for module folder metadata events', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'modules',
      settings: { enabledModules: [], moduleFolders: [{ id: 'folder-a', name: 'Folder A' }] },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'moduleFolders', { id: 'folder-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledWith('modules', undefined)
    expect(api.collection).not.toHaveBeenCalled()
    expect(getResourceDatabase().moduleFolders).toEqual([{ id: 'folder-a', name: 'Folder A' }])
  })

  it('reads module folders and module rows after a folder deletion', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'modules',
      settings: { enabledModules: [], moduleFolders: [] },
    })
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: { modules: [{ id: 'module-a', name: 'A', description: '' }] },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'moduleOrganization', { id: 'folder-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledWith('modules', undefined)
    expect(api.collection).toHaveBeenCalledWith('modules', undefined)
  })

  it('reads only enabled modules alongside the required module deletion cascade', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 2,
      group: 'modules',
      settings: { enabledModules: [] },
    })
    api.collection.mockImplementation(async (name: string) => ({
      status: 'ok',
      revision: 2,
      collections: { [name]: [] },
    }))
    api.characters.mockResolvedValue({
      status: 'ok',
      version: 1,
      revision: 2,
      characters: [metadataCharacter('char-a', 'Ada'), metadataCharacter('char-b', 'Bea')],
      characterOrder: ['char-a', 'char-b'],
      currentChar: 0,
    })

    const deletedEvent: CommandEvent = {
      type: 'module.deleted',
      revision: 2,
      resource: 'module',
      id: 'module-a',
    }
    await expect(refreshInvalidatedServerResources(deletedEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 2,
      scope: 'targeted',
    })

    expect(api.settingsGroup).toHaveBeenCalledWith('modules', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collection).toHaveBeenCalledTimes(3)
    expect(api.collection).toHaveBeenCalledWith('modules', undefined)
    expect(api.collection).toHaveBeenCalledWith('personas', undefined)
    expect(api.collection).toHaveBeenCalledWith('loadouts', undefined)
    expect(api.characters).toHaveBeenCalledWith(undefined)
  })

  it('reads only the resource slices changed by each preset selection shape', async () => {
    seedResources(1)
    api.collection
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 2,
        collections: { botPresets: [{ id: 'preset-a', name: 'A' }] },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 3,
        collections: { botPresets: [{ id: 'preset-b', name: 'B' }] },
      })
    api.settings
      .mockResolvedValueOnce({ status: 'ok', revision: 3, settings: { botPresetsId: 0 } })
      .mockResolvedValueOnce({ status: 'ok', revision: 4, settings: { botPresetsId: 1 } })
    api.legacyPreset
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 2,
        presetId: 'preset-a',
        preset: { id: 'preset-a', name: 'A', mainPrompt: 'A body' },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 3,
        presetId: 'preset-b',
        preset: { id: 'preset-b', name: 'B', mainPrompt: 'B body' },
      })

    await expect(
      refreshInvalidatedServerResources(event(2, 'presetCollection', { id: 'preset-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(api.collection).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledWith('botPresets', undefined)
    expect(api.settings).not.toHaveBeenCalled()

    await expect(
      refreshInvalidatedServerResources(event(3, 'presetCollectionWithPointer', { id: 'preset-b' }), {
        appliedRevision: 2,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })
    expect(api.collection).toHaveBeenCalledTimes(2)
    expect(api.settings).toHaveBeenCalledOnce()
    expect(getResourceDatabase()).toMatchObject({
      botPresetsId: 0,
      botPresets: [{ id: 'preset-b', name: 'B', mainPrompt: 'B body' }],
    })

    await expect(
      refreshInvalidatedServerResources(event(4, 'presetPointer', { id: 'preset-a' }), {
        appliedRevision: 3,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 4, scope: 'targeted' })
    expect(api.settings).toHaveBeenCalledTimes(2)
    expect(api.collection).toHaveBeenCalledTimes(2)
    expect(getResourceDatabase().botPresetsId).toBe(1)

    await expect(
      refreshInvalidatedServerResources(event(5, 'revisionOnly', { id: 'preset-a' }), {
        appliedRevision: 4,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 5, scope: 'targeted' })
    expect(api.settings).toHaveBeenCalledTimes(2)
    expect(api.collection).toHaveBeenCalledTimes(2)
  })

  it('hydrates an exact legacy preset row without replacing hydrated siblings', async () => {
    seedResources(1)
    applyCollectionsResource(
      {
        revision: 1,
        collections: {
          botPresets: [
            { id: 'preset-a', name: 'A' },
            { id: 'preset-b', name: 'B', mainPrompt: 'B resident' },
          ] as never,
        },
      },
      'botPresets',
    )
    api.legacyPreset.mockResolvedValue({
      status: 'ok',
      revision: 2,
      presetId: 'preset-a',
      preset: { id: 'preset-a', name: 'A', mainPrompt: 'A hydrated' },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'presetRow', { id: 'preset-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.collection).not.toHaveBeenCalled()
    expect(api.legacyPreset).toHaveBeenCalledWith('preset-a', { signal: undefined })
    expect(getResourceDatabase().botPresets).toEqual([
      { id: 'preset-a', name: 'A', mainPrompt: 'A hydrated' },
      { id: 'preset-b', name: 'B', mainPrompt: 'B resident' },
    ])
  })

  it('preserves resident legacy bodies across reorder and hydrates only a newly created row', async () => {
    seedResources(1)
    applyCollectionsResource(
      {
        revision: 1,
        collections: {
          botPresets: [
            { id: 'preset-a', name: 'A', mainPrompt: 'A resident' },
            { id: 'preset-b', name: 'B', mainPrompt: 'B resident' },
          ] as never,
        },
      },
      'botPresets',
    )
    api.collection
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 2,
        collections: {
          botPresets: [
            { id: 'preset-b', name: 'B renamed' },
            { id: 'preset-a', name: 'A' },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        revision: 3,
        collections: {
          botPresets: [
            { id: 'preset-b', name: 'B renamed' },
            { id: 'preset-new', name: 'New' },
            { id: 'preset-a', name: 'A' },
          ],
        },
      })
    api.legacyPreset.mockResolvedValue({
      status: 'ok',
      revision: 3,
      presetId: 'preset-new',
      preset: { id: 'preset-new', name: 'New', mainPrompt: 'New hydrated' },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'preset.reordered', revision: 2, resource: 'presetCollection' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(api.legacyPreset).not.toHaveBeenCalled()
    expect(getResourceDatabase().botPresets).toEqual([
      { id: 'preset-b', name: 'B renamed', mainPrompt: 'B resident' },
      { id: 'preset-a', name: 'A', mainPrompt: 'A resident' },
    ])

    await expect(
      refreshInvalidatedServerResources(
        { type: 'preset.created', revision: 3, resource: 'presetCollection', id: 'preset-new' },
        { appliedRevision: 2, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })
    expect(api.legacyPreset).toHaveBeenCalledOnce()
    expect(api.legacyPreset).toHaveBeenCalledWith('preset-new', { signal: undefined })
    expect(getResourceDatabase().botPresets).toEqual([
      { id: 'preset-b', name: 'B renamed', mainPrompt: 'B resident' },
      { id: 'preset-new', name: 'New', mainPrompt: 'New hydrated' },
      { id: 'preset-a', name: 'A', mainPrompt: 'A resident' },
    ])
  })

  it('filters a deleted legacy preset id before body reads', async () => {
    seedResources(1)
    applyCollectionsResource(
      {
        revision: 1,
        collections: {
          botPresets: [
            { id: 'preset-a', name: 'A', mainPrompt: 'A resident' },
            { id: 'preset-b', name: 'B', mainPrompt: 'B resident' },
          ] as never,
        },
      },
      'botPresets',
    )
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: { botPresets: [{ id: 'preset-b', name: 'B' }] },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'preset.deleted', revision: 2, resource: 'presetCollection', id: 'preset-a' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.legacyPreset).not.toHaveBeenCalled()
    expect(getResourceDatabase().botPresets).toEqual([{ id: 'preset-b', name: 'B', mainPrompt: 'B resident' }])
  })

  it('fails closed when legacy shell and body revisions do not converge', async () => {
    seedResources(1)
    applyCollectionsResource(
      {
        revision: 1,
        collections: { botPresets: [{ id: 'preset-a', name: 'A', mainPrompt: 'A resident' }] as never },
      },
      'botPresets',
    )
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: { botPresets: [{ id: 'preset-new', name: 'New' }] },
    })
    api.legacyPreset.mockResolvedValue({
      status: 'ok',
      revision: 3,
      presetId: 'preset-new',
      preset: { id: 'preset-new', name: 'New', mainPrompt: 'raced body' },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'preset.created', revision: 2, resource: 'presetCollection', id: 'preset-new' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({
      status: 'error',
      error: `Legacy preset resource revisions did not converge after ${FULL_RESOURCE_REFRESH_MAX_ATTEMPTS} attempts`,
    })
    expect(api.collection).toHaveBeenCalledTimes(FULL_RESOURCE_REFRESH_MAX_ATTEMPTS)
    expect(api.legacyPreset).toHaveBeenCalledTimes(FULL_RESOURCE_REFRESH_MAX_ATTEMPTS)
    expect(getResourceDatabase().botPresets).toEqual([{ id: 'preset-a', name: 'A', mainPrompt: 'A resident' }])
  })

  it('uses narrow order and selection reads without fetching all characters', async () => {
    seedResources(5)
    api.characterOrder.mockResolvedValue({
      status: 'ok',
      revision: 7,
      characterOrder: ['char-b', 'char-a'],
    })
    api.characterSelection.mockResolvedValue({
      status: 'ok',
      revision: 7,
      characterId: 'char-b',
      currentChar: 1,
      lastInteraction: 77,
    })

    const result = await refreshInvalidatedServerResources(
      [event(6, 'characterOrder'), event(7, 'characterSelection', { id: 'char-b' })],
      { appliedRevision: 5, hooks },
    )

    expect(result).toEqual({ status: 'ok', revision: 7, scope: 'targeted' })
    expect(api.characterOrder).toHaveBeenCalledWith(undefined)
    expect(api.characterSelection).toHaveBeenCalledWith('char-b', undefined)
    expect(api.characters).not.toHaveBeenCalled()
    expect(api.character).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({
      characterOrder: ['char-b', 'char-a'],
      currentChar: 1,
      characters: [{ chaId: 'char-a' }, { chaId: 'char-b', lastInteraction: 77 }],
    })
  })

  it('refreshes only character shells for a character-created event without retaining resident detail', async () => {
    seedResources(20)
    api.characters.mockResolvedValue({
      status: 'ok',
      version: 1,
      revision: 21,
      characters: [
        characterSummaryShell('char-a', 'Ada refreshed', 'chat-a'),
        characterSummaryShell('char-b', 'Bea refreshed', 'chat-b'),
        characterSummaryShell('char-imported', 'Imported', 'chat-imported'),
      ],
      characterOrder: ['char-a', 'char-b', 'char-imported'],
      currentChar: 0,
    })
    const createdEvent: CommandEvent = {
      type: 'character.created',
      resource: 'character',
      revision: 21,
      id: 'char-imported',
    }

    await expect(refreshInvalidatedServerResources(createdEvent, { appliedRevision: 20, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 21,
      scope: 'targeted',
    })

    expect(api.characters).toHaveBeenCalledWith(undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.settingsGroup).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(api.collection).not.toHaveBeenCalled()
    expect(api.character).not.toHaveBeenCalled()
    expect(api.chat).not.toHaveBeenCalled()
    expect(api.generationChat).not.toHaveBeenCalled()
    expect(api.lorebook).not.toHaveBeenCalled()
    expect(api.lorebooks).not.toHaveBeenCalled()
    expect(sideEffects.reattach).not.toHaveBeenCalled()
    expect(getResourceDatabase().characters).toMatchObject([
      { __serverCharacterShell: true, chaId: 'char-a', name: 'Ada refreshed', chats: [{ message: [] }] },
      { __serverCharacterShell: true, chaId: 'char-b', name: 'Bea refreshed', chats: [{ message: [] }] },
      { __serverCharacterShell: true, chaId: 'char-imported', name: 'Imported', chats: [{ message: [] }] },
    ])
  })

  it('uses individual chat and bulk lorebook reads while applying hydration side effects', async () => {
    seedResources(1)
    const characterLorebookEpoch = captureCharacterLorebookProjectionEpoch('char-a')
    const characterRowEpoch = captureCharacterRowProjectionEpoch('char-a')
    api.chat.mockImplementation(async (chatId: string) => ({
      status: 'ok',
      revision: 5,
      chatId,
      message: [{ role: 'char', data: 'fresh-a' }],
      hypaV3Data: { fresh: 'a' },
      hypaV3DataIncluded: true,
      alternates: [{ role: 'char', data: `${chatId}-alternate` }],
    }))
    api.generationChat.mockImplementation(async (chatId: string) => ({
      status: 'ok',
      revision: 5,
      chatId,
      message: [{ role: 'char', data: 'fresh-b' }],
      hypaV3DataIncluded: false,
      alternates: [{ role: 'char', data: `${chatId}-alternate` }],
      messageStart: 1,
      messageTotal: 2,
    }))
    api.lorebooks.mockResolvedValue({
      status: 'ok',
      revision: 5,
      characters: [
        { characterId: 'char-a', globalLore: [{ key: 'A' }] },
        { characterId: 'char-b', globalLore: [{ key: 'B' }] },
      ],
      missing: [],
    })

    const result = await refreshInvalidatedServerResources(
      [
        event(2, 'message', { id: 'message-a', parentId: 'chat-a' }),
        event(3, 'generation', { id: 'message-b', parentId: 'chat-b' }),
        event(4, 'characterLorebook', { id: 'char-a' }),
        event(5, 'characterLorebook', { id: 'char-b' }),
      ],
      { appliedRevision: 1, hooks },
    )

    expect(result).toEqual({ status: 'ok', revision: 5, scope: 'targeted' })
    expect(api.chat).toHaveBeenCalledTimes(1)
    expect(api.chat).toHaveBeenCalledWith('chat-a', { signal: undefined })
    expect(api.generationChat).toHaveBeenCalledWith('chat-b', 'message-b', { signal: undefined })
    expect(api.lorebooks).toHaveBeenCalledWith(['char-a', 'char-b'], { signal: undefined })
    expect(api.lorebook).not.toHaveBeenCalled()
    expect(sideEffects.applyChat).toHaveBeenCalledWith(
      'chat-a',
      [{ role: 'char', data: 'fresh-a' }],
      { fresh: 'a' },
      [{ role: 'char', data: 'chat-a-alternate' }],
      undefined,
      { hypaV3DataIncluded: true },
    )
    expect(sideEffects.applyChat).toHaveBeenCalledWith(
      'chat-b',
      [{ role: 'char', data: 'fresh-b' }],
      undefined,
      [{ role: 'char', data: 'chat-b-alternate' }],
      { start: 1, total: 2 },
      { hypaV3DataIncluded: false },
    )
    expect(sideEffects.applyLorebook).toHaveBeenCalledWith('char-a', [{ key: 'A' }])
    expect(sideEffects.applyLorebook).toHaveBeenCalledWith('char-b', [{ key: 'B' }])
    expect(sideEffects.reattach).toHaveBeenCalledTimes(1)
    expect(sideEffects.clearTranslation).toHaveBeenCalledWith('message-a')
    expect(sideEffects.markLorebook).toHaveBeenCalledTimes(2)
    expect(hasCharacterLorebookProjectionEpochChanged('char-a', characterLorebookEpoch)).toBe(true)
    expect(hasCharacterRowProjectionEpochChanged('char-a', characterRowEpoch)).toBe(false)
  })

  it('drops an in-flight chat invalidation after a newer projection removes its target', async () => {
    seedResources(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      chatId: string
      message: unknown[]
      hypaV3Data: unknown
      alternates: unknown[]
    }>()
    api.chat.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(event(2, 'message', { id: 'message-a', parentId: 'chat-a' }), {
      appliedRevision: 1,
      hooks,
    })
    expect(api.chat).toHaveBeenCalledWith('chat-a', { signal: undefined })

    applyCharacterResource({
      revision: 2,
      character: metadataCharacter('char-a', 'Ada', 'chat-b'),
    })
    response.resolve({
      status: 'ok',
      revision: 2,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'older in-flight transcript' }],
      hypaV3Data: undefined,
      alternates: [],
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(sideEffects.applyChat).not.toHaveBeenCalled()
  })

  it('drops an in-flight generation window after a newer local transcript projection', async () => {
    seedResources(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      chatId: string
      message: unknown[]
      hypaV3Data: unknown
      alternates: unknown[]
      messageStart: number
      messageTotal: number
    }>()
    api.generationChat.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(
      event(2, 'generation', { id: 'generated-a', parentId: 'chat-a' }),
      { appliedRevision: 1, hooks },
    )
    expect(api.generationChat).toHaveBeenCalledWith('chat-a', 'generated-a', { signal: undefined })

    markChatBodyProjectionApplied('chat-a')
    response.resolve({
      status: 'ok',
      revision: 2,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'older in-flight generation' }],
      hypaV3Data: undefined,
      alternates: [],
      messageStart: 1,
      messageTotal: 2,
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(sideEffects.applyChat).not.toHaveBeenCalled()
  })

  it('drops an in-flight character-lorebook invalidation after a newer local body projection', async () => {
    seedResources(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      characterId: string
      globalLore: unknown[]
    }>()
    api.lorebook.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(event(2, 'characterLorebook', { id: 'char-a' }), {
      appliedRevision: 1,
      hooks,
    })
    expect(api.lorebook).toHaveBeenCalledWith('char-a', { signal: undefined })

    markCharacterLorebookProjectionApplied('char-a')
    response.resolve({
      status: 'ok',
      revision: 2,
      characterId: 'char-a',
      globalLore: [{ key: 'older in-flight lore' }],
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })
    expect(sideEffects.applyLorebook).not.toHaveBeenCalled()
  })

  it('rejects a single-character lorebook response for a different resident character', async () => {
    seedResources(1)
    api.lorebook.mockResolvedValue({
      status: 'ok',
      revision: 2,
      characterId: 'char-b',
      globalLore: [{ key: 'wrong resident character' }],
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'characterLorebook', { id: 'char-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'error', error: 'Failed to apply server character char-a lorebook response' })
    expect(sideEffects.applyLorebook).not.toHaveBeenCalled()
  })

  it('checks each captured character-lorebook epoch from a bulk invalidation independently', async () => {
    seedResources(1)
    const response = deferred<{
      status: 'ok'
      revision: number
      characters: Array<{ characterId: string; globalLore: unknown[] }>
      missing: string[]
    }>()
    api.lorebooks.mockReturnValue(response.promise)

    const refresh = refreshInvalidatedServerResources(
      [event(2, 'characterLorebook', { id: 'char-a' }), event(3, 'characterLorebook', { id: 'char-b' })],
      { appliedRevision: 1, hooks },
    )
    expect(api.lorebooks).toHaveBeenCalledWith(['char-a', 'char-b'], { signal: undefined })

    markCharacterLorebookProjectionApplied('char-a')
    response.resolve({
      status: 'ok',
      revision: 3,
      characters: [
        { characterId: 'char-a', globalLore: [{ key: 'older A' }] },
        { characterId: 'char-b', globalLore: [{ key: 'fresh B' }] },
      ],
      missing: [],
    })

    await expect(refresh).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })
    expect(sideEffects.applyLorebook).toHaveBeenCalledOnce()
    expect(sideEffects.applyLorebook).toHaveBeenCalledWith('char-b', [{ key: 'fresh B' }])
  })

  it('applies transcript and lorebook bodies even when a newer character shell was read in the same batch', async () => {
    seedResources(1)
    const characterShell = metadataCharacter('char-a', 'Ada refreshed', 'chat-a')
    delete characterShell.globalLore
    api.character.mockResolvedValue({
      status: 'ok',
      revision: 5,
      character: characterShell,
    })
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 4,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'fresh transcript' }],
      hypaV3Data: { fresh: true },
      alternates: [],
    })
    api.lorebook.mockResolvedValue({
      status: 'ok',
      revision: 4,
      characterId: 'char-a',
      globalLore: [{ key: 'fresh lore' }],
    })

    await expect(
      refreshInvalidatedServerResources(
        [
          event(2, 'characterRow', { id: 'char-a' }),
          event(3, 'message', { id: 'message-a', parentId: 'chat-a' }),
          event(4, 'characterLorebook', { id: 'char-a' }),
        ],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 4, scope: 'targeted' })

    expect(api.character).toHaveBeenCalledWith('char-a', undefined)
    expect(sideEffects.applyChat).toHaveBeenCalledWith(
      'chat-a',
      [{ role: 'char', data: 'fresh transcript' }],
      { fresh: true },
      [],
      undefined,
    )
    expect(sideEffects.applyLorebook).toHaveBeenCalledWith('char-a', [{ key: 'fresh lore' }])
  })

  it('keeps a newer un-stubbed character-row lorebook ahead of an older dedicated body', async () => {
    seedResources(1)
    const character = metadataCharacter('char-a', 'Ada refreshed', 'chat-a')
    character.globalLore = [{ key: 'newer row lore' }] as never
    api.character.mockResolvedValue({ status: 'ok', revision: 5, character })
    api.lorebook.mockResolvedValue({
      status: 'ok',
      revision: 3,
      characterId: 'char-a',
      globalLore: [{ key: 'older dedicated lore' }],
    })

    await expect(
      refreshInvalidatedServerResources(
        [event(2, 'characterRow', { id: 'char-a' }), event(3, 'characterLorebook', { id: 'char-a' })],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(sideEffects.applyLorebook).not.toHaveBeenCalled()
    expect(getResourceDatabase().characters[0].globalLore).toEqual([{ key: 'newer row lore' }])
  })

  it('uses the pre-apply supersession snapshot when an earlier sibling apply advances an epoch', async () => {
    seedResources(1)
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 3,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'fresh transcript' }],
      hypaV3Data: undefined,
      alternates: [],
    })
    api.lorebook.mockResolvedValue({
      status: 'ok',
      revision: 3,
      characterId: 'char-a',
      globalLore: [{ key: 'fresh lore' }],
    })
    sideEffects.applyChat.mockImplementationOnce(() => {
      markCharacterLorebookProjectionApplied('char-a')
      return true
    })

    await expect(
      refreshInvalidatedServerResources(
        [event(2, 'message', { id: 'message-a', parentId: 'chat-a' }), event(3, 'characterLorebook', { id: 'char-a' })],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(sideEffects.applyChat).toHaveBeenCalledOnce()
    expect(sideEffects.applyLorebook).toHaveBeenCalledWith('char-a', [{ key: 'fresh lore' }])
  })

  it('does not claim a parent character-row revision for body-only reads', async () => {
    seedResources(1)
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 3,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'fresh transcript' }],
      hypaV3Data: undefined,
      alternates: [],
    })
    api.lorebook.mockResolvedValue({
      status: 'ok',
      revision: 3,
      characterId: 'char-a',
      globalLore: [{ key: 'fresh lore' }],
    })

    await expect(
      refreshInvalidatedServerResources(
        [event(2, 'message', { id: 'message-a', parentId: 'chat-a' }), event(3, 'characterLorebook', { id: 'char-a' })],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(charactersResourceState.rowRevisions['char-a']).toBe(1)
    expect(charactersResourceState.revision).toBe(1)
  })

  it('uses a full chat read when generation windows for one chat are ambiguous', async () => {
    seedResources(1)
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 3,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'authoritative transcript' }],
      hypaV3Data: undefined,
      alternates: [],
    })

    await expect(
      refreshInvalidatedServerResources(
        [
          event(2, 'generation', { id: 'generated-late', parentId: 'chat-a' }),
          event(3, 'generation', { id: 'generated-earlier', parentId: 'chat-a' }),
        ],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(api.chat).toHaveBeenCalledOnce()
    expect(api.chat).toHaveBeenCalledWith('chat-a', { signal: undefined })
    expect(api.generationChat).not.toHaveBeenCalled()
    expect(sideEffects.applyChat).toHaveBeenCalledWith(
      'chat-a',
      [{ role: 'char', data: 'authoritative transcript' }],
      undefined,
      [],
      undefined,
    )
  })

  it('lets a full message invalidation win over a generation window for the same chat', async () => {
    seedResources(1)
    api.chat.mockResolvedValue({
      status: 'ok',
      revision: 3,
      chatId: 'chat-a',
      message: [{ role: 'char', data: 'full transcript' }],
      hypaV3Data: undefined,
      alternates: [],
    })

    await expect(
      refreshInvalidatedServerResources(
        [
          event(2, 'generation', { id: 'generated-a', parentId: 'chat-a' }),
          event(3, 'message', { id: 'message-a', parentId: 'chat-a' }),
        ],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(api.chat).toHaveBeenCalledOnce()
    expect(api.generationChat).not.toHaveBeenCalled()
  })

  it('rejects chat invalidation before reading when required apply hooks are absent', async () => {
    seedResources(1)

    await expect(
      refreshInvalidatedServerResources(event(2, 'generation', { parentId: 'chat-a' }), {
        appliedRevision: 1,
      }),
    ).resolves.toEqual({
      status: 'error',
      error: 'Server resource invalidation requires the applyChatMessages hook',
    })
    expect(api.chat).not.toHaveBeenCalled()
  })

  it('merges pending plugin storage on a targeted invalidation', async () => {
    seedResources(1)
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 3,
      collections: { pluginCustomStorage: { authoritative: true } },
    })
    sideEffects.mergePluginStorage.mockImplementation((value) => ({ ...value, pending: true }))

    await expect(
      refreshInvalidatedServerResources(event(2, 'pluginStorage', { id: 'key' }), { appliedRevision: 1, hooks }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.collection).toHaveBeenCalledWith('pluginCustomStorage', undefined)
    expect(getResourceDatabase().pluginCustomStorage).toEqual({ authoritative: true, pending: true })
  })

  it('reads only plugin records and provider settings for precise plugin event scopes', async () => {
    seedResources(1)
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 4,
      collections: { plugins: [{ name: 'plugin-a', script: 'authoritative' }] },
    })
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 4,
      group: 'providers',
      settings: { currentPluginProvider: 'plugin-a' },
    })
    sideEffects.mergePluginCollection.mockImplementation((value) => [
      ...value,
      { name: 'plugin-pending', script: 'optimistic' },
    ])
    sideEffects.mergePluginProvider.mockReturnValue('plugin-pending')

    await expect(
      refreshInvalidatedServerResources(
        [
          event(2, 'pluginCollection', { id: 'plugin-a' }),
          event(3, 'pluginProvider', { id: 'plugin-a' }),
          event(4, 'pluginCollectionWithProvider', { id: 'plugin-b' }),
        ],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 4, scope: 'targeted' })

    expect(api.collection).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledWith('plugins', undefined)
    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('providers', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({
      currentPluginProvider: 'plugin-pending',
      plugins: [
        { name: 'plugin-a', script: 'authoritative' },
        { name: 'plugin-pending', script: 'optimistic' },
      ],
    })
  })

  it('coalesces model profile events into one models-only settings read', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 5,
      group: 'models',
      settings: {
        providerCredentials: [
          { id: 'credential-a', name: 'Credential A', type: 'apiKey', apiKey: '__RISU_SECRET_MASKED__' },
        ],
        modelProfiles: [{ id: 'profile-a', name: 'Profile A', modelId: 'model-a' }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelRuntimeDefaults: { maxContext: 8_192 },
      },
    })

    await expect(
      refreshInvalidatedServerResources(
        [
          { type: 'modelProfile.updated', revision: 2, resource: 'modelProfile', id: 'profile-a' },
          { type: 'modelProfile.roles.updated', revision: 3, resource: 'modelProfile' },
          { type: 'modelProfile.runtimeDefaults.updated', revision: 4, resource: 'modelProfile' },
          {
            type: 'providerCredential.updated',
            revision: 5,
            resource: 'providerCredential',
            id: 'credential-a',
          },
        ],
        {
          appliedRevision: 1,
          hooks,
        },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 5, scope: 'targeted' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('models', undefined)
    expect(api.settings).not.toHaveBeenCalled()
    expect(getResourceDatabase()).toMatchObject({
      providerCredentials: [
        { id: 'credential-a', name: 'Credential A', type: 'apiKey', apiKey: '__RISU_SECRET_MASKED__' },
      ],
      modelProfiles: [{ id: 'profile-a', name: 'Profile A', modelId: 'model-a' }],
      modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
      modelRuntimeDefaults: { maxContext: 8_192 },
    })
  })

  it.each([
    {
      label: 'provider event first',
      events: [
        { type: 'settings.updated', revision: 2, resource: 'settings', id: 'providers' },
        { type: 'modelProfile.updated', revision: 3, resource: 'modelProfile', id: 'profile-a' },
      ],
    },
    {
      label: 'model event first',
      events: [
        { type: 'modelProfile.updated', revision: 2, resource: 'modelProfile', id: 'profile-a' },
        { type: 'settings.updated', revision: 3, resource: 'settings', id: 'providers' },
      ],
    },
  ] satisfies Array<{ label: string; events: CommandEvent[] }>)(
    'lets the provider superset dominate an overlapping models read: $label',
    async ({ events }) => {
      seedResources(1)
      api.settingsGroup.mockImplementation(async (group: string) => ({
        status: 'ok',
        revision: 3,
        group,
        settings:
          group === 'providers'
            ? {
                openAIKey: 'provider-key',
                modelProfiles: [{ id: 'profile-a', name: 'Profile A' }],
                modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
                modelRuntimeDefaults: { maxContext: 8_192 },
              }
            : {
                modelProfiles: [{ id: 'profile-a', name: 'Profile A' }],
                modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
                modelRuntimeDefaults: { maxContext: 8_192 },
              },
      }))

      await expect(
        refreshInvalidatedServerResources(events, {
          appliedRevision: 1,
          hooks,
        }),
      ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

      expect(api.settingsGroup).toHaveBeenCalledOnce()
      expect(api.settingsGroup).toHaveBeenCalledWith('providers', undefined)
      expect(api.settings).not.toHaveBeenCalled()
      expect(getResourceDatabase()).toMatchObject({
        openAIKey: 'provider-key',
        modelProfiles: [{ id: 'profile-a', name: 'Profile A' }],
        modelRoleProfiles: { chatMain: { mode: 'profile', profileId: 'profile-a' } },
        modelRuntimeDefaults: { maxContext: 8_192 },
      })
    },
  )

  it('does not treat a newer models slice as proof that unrelated provider settings are current', async () => {
    seedResources(1)
    applySettingsGroupResource(
      {
        revision: 10,
        group: 'models',
        settings: { modelProfiles: [{ id: 'profile-newer', name: 'Newer Profile' }] },
      },
      SERVER_SETTINGS_KEYS_BY_GROUP.models,
    )
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 9,
      group: 'providers',
      settings: {
        openAIKey: 'provider-at-nine',
        modelProfiles: [{ id: 'profile-stale', name: 'Stale Profile' }],
      },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'settings.updated', revision: 9, resource: 'settings', id: 'providers' },
        { appliedRevision: 8, hooks },
      ),
    ).resolves.toEqual({ status: 'error', error: 'Failed to apply server providers settings response' })

    expect(api.settingsGroup).toHaveBeenCalledOnce()
    expect(api.settingsGroup).toHaveBeenCalledWith('providers', undefined)
    expect(getResourceDatabase()).toMatchObject({
      modelProfiles: [{ id: 'profile-newer', name: 'Newer Profile' }],
    })
    expect(getResourceDatabase()).not.toHaveProperty('openAIKey')
  })

  it('reads a preset-owned prompt body and only the root collection for root prompt item events', async () => {
    seedResources(1)
    api.collection.mockImplementation(async (name: string) => ({
      status: 'ok',
      revision: 3,
      collections: { [name]: [] },
    }))

    await expect(
      refreshInvalidatedServerResources(
        [
          event(2, 'promptItem', { id: 'item-a', parentId: 'prompt-preset-a' }),
          event(3, 'promptItem', { id: 'legacy-item-a' }),
        ],
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 3, scope: 'targeted' })

    expect(api.collection).toHaveBeenCalledTimes(1)
    expect(api.collection).toHaveBeenCalledWith('promptTemplate', undefined)
    expect(promptHydration.stale).toHaveBeenCalledWith('prompt-preset-a')
    expect(promptHydration.invalidate).not.toHaveBeenCalled()
    expect(promptHydration.ensure).toHaveBeenCalledWith({
      applyProjection: false,
      force: true,
      minimumRevision: 3,
      promptPresetId: 'prompt-preset-a',
    })
    expect(promptHydration.mark).toHaveBeenCalledWith(null, 3)
    expect(api.settings).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
  })

  it('fully invalidates a retained prompt owner when its targeted refresh fails', async () => {
    seedResources(1)
    promptHydration.currentOwner = 'prompt-preset-a'
    promptHydration.ensure.mockResolvedValueOnce(false)

    await expect(
      refreshInvalidatedServerResources(event(2, 'promptItem', { id: 'item-a', parentId: 'prompt-preset-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'error', error: 'Failed to refresh an invalidated prompt-template owner' })

    expect(promptHydration.stale).toHaveBeenCalledWith('prompt-preset-a')
    expect(promptHydration.invalidate).toHaveBeenCalledWith('prompt-preset-a')
  })

  it.each([
    {
      type: 'modelPreset.created',
      resource: 'modelPreset',
      collection: 'modelPresets',
      settings: false,
      promptTemplate: false,
    },
    {
      type: 'modelPreset.updated',
      resource: 'modelPreset',
      collection: 'modelPresets',
      settings: true,
      promptTemplate: false,
    },
    {
      type: 'modelPreset.selected',
      resource: 'modelPreset',
      collection: null,
      settings: true,
      promptTemplate: false,
    },
    {
      type: 'modelPreset.imported',
      resource: 'modelPreset',
      collection: 'modelPresets',
      settings: false,
      promptTemplate: false,
    },
    {
      type: 'modelPreset.reordered',
      resource: 'modelPreset',
      collection: 'modelPresets',
      settings: true,
      promptTemplate: false,
    },
    {
      type: 'promptPreset.created',
      resource: 'promptPreset',
      collection: 'promptPresets',
      settings: false,
      promptTemplate: true,
    },
    {
      type: 'promptPreset.updated',
      resource: 'promptPreset',
      collection: 'promptPresets',
      settings: true,
      promptTemplate: true,
    },
    {
      type: 'promptPreset.selected',
      resource: 'promptPreset',
      collection: null,
      settings: true,
      promptTemplate: true,
    },
    {
      type: 'promptPreset.imported',
      resource: 'promptPreset',
      collection: 'promptPresets',
      settings: false,
      promptTemplate: true,
    },
    {
      type: 'promptPreset.reordered',
      resource: 'promptPreset',
      collection: 'promptPresets',
      settings: true,
      promptTemplate: true,
    },
  ] as const)(
    'plans only the server-written slices for $type',
    async ({ type, resource, collection, settings, promptTemplate }) => {
      seedResources(1)
      promptHydration.currentOwner = 'prompt-preset-a'
      api.settings.mockResolvedValue({
        status: 'ok',
        revision: 2,
        settings: { modelPresetsId: 0, promptPresetsId: 0 },
      })
      api.collection.mockImplementation(async (name: string) => ({
        status: 'ok',
        revision: 2,
        collections: {
          [name]:
            name === 'modelPresets'
              ? [{ id: 'model-preset-a', name: 'Model A' }]
              : [{ id: 'prompt-preset-a', name: 'Prompt A' }],
        },
      }))
      const commandEvent: CommandEvent = {
        type,
        revision: 2,
        resource,
        ...(!type.endsWith('.reordered')
          ? { id: resource === 'modelPreset' ? 'model-preset-a' : 'prompt-preset-a' }
          : {}),
      }

      await expect(refreshInvalidatedServerResources(commandEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
        status: 'ok',
        revision: 2,
        scope: 'targeted',
      })

      expect(api.settings).toHaveBeenCalledTimes(settings ? 1 : 0)
      expect(api.collection).toHaveBeenCalledTimes(collection === null ? 0 : 1)
      if (collection !== null) expect(api.collection).toHaveBeenCalledWith(collection, undefined)
      expect(promptHydration.ensure).toHaveBeenCalledTimes(promptTemplate ? 1 : 0)
      expect(promptHydration.invalidate).toHaveBeenCalledTimes(promptTemplate ? 1 : 0)
      if (promptTemplate) {
        expect(promptHydration.ensure).toHaveBeenCalledWith({
          applyProjection: true,
          force: true,
          minimumRevision: 2,
          promptPresetId: 'prompt-preset-a',
        })
      }
      expect(promptHydration.reset).toHaveBeenCalledTimes(collection === 'promptPresets' ? 1 : 0)
      expect(api.collections).not.toHaveBeenCalled()
      expect(api.characters).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      type: 'persona.deleted',
      resource: 'persona',
      ownerCollection: 'personas',
      promptTemplate: false,
    },
    {
      type: 'modelPreset.deleted',
      resource: 'modelPreset',
      ownerCollection: 'modelPresets',
      promptTemplate: false,
    },
    {
      type: 'promptPreset.deleted',
      resource: 'promptPreset',
      ownerCollection: 'promptPresets',
      promptTemplate: true,
    },
  ] as const)(
    'refreshes every generation-reference cascade slice for $type',
    async ({ type, resource, ownerCollection, promptTemplate }) => {
      seedResources(1)
      promptHydration.currentOwner = 'prompt-preset-a'
      api.settings.mockResolvedValue({
        status: 'ok',
        revision: 2,
        settings: { selectedPersona: 0, modelPresetsId: 0, promptPresetsId: 0 },
      })
      api.collection.mockImplementation(async (name: string) => ({
        status: 'ok',
        revision: 2,
        collections: {
          [name]:
            name === 'loadouts'
              ? [{ id: 'loadout-a', name: 'Loadout A' }]
              : [{ id: `${name}-survivor`, name: `${name} survivor` }],
        },
      }))
      api.characters.mockResolvedValue({
        status: 'ok',
        version: 1,
        revision: 2,
        characters: [metadataCharacter('char-a', 'Ada authoritative')],
        characterOrder: ['char-a'],
        currentChar: 0,
      })

      await expect(
        refreshInvalidatedServerResources(
          { type, revision: 2, resource, id: `${resource}-deleted` },
          { appliedRevision: 1, hooks },
        ),
      ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

      expect(api.settings).toHaveBeenCalledOnce()
      expect(api.collection).toHaveBeenCalledTimes(resource === 'modelPreset' ? 3 : 2)
      expect(api.collection).toHaveBeenCalledWith(ownerCollection, undefined)
      if (resource === 'modelPreset') {
        expect(api.collection).toHaveBeenCalledWith('promptPresets', undefined)
      }
      expect(api.collection).toHaveBeenCalledWith('loadouts', undefined)
      expect(api.characters).toHaveBeenCalledOnce()
      expect(promptHydration.ensure).toHaveBeenCalledTimes(promptTemplate ? 1 : 0)
      expect(promptHydration.invalidate).toHaveBeenCalledTimes(promptTemplate ? 1 : 0)
      expect(api.collections).not.toHaveBeenCalled()
    },
  )

  it.each([
    { type: 'modelPreset.future', revision: 2, resource: 'modelPreset', id: 'model-preset-a' },
    { type: 'promptPreset.future', revision: 2, resource: 'promptPreset', id: 'prompt-preset-a' },
    { type: 'modelPreset.selected', revision: 2, resource: 'modelPreset' },
    { type: 'promptPreset.updated', revision: 2, resource: 'promptPreset' },
    { type: 'modelPreset.reordered', revision: 2, resource: 'modelPreset', id: 'unexpected-id' },
    { type: 'promptPreset.created', revision: 2, resource: 'promptPreset', id: 'prompt-preset-a', parentId: 'x' },
  ] as CommandEvent[])('uses a full refresh for malformed split-preset event %#', async (commandEvent) => {
    fullReadMocks(9)

    await expect(refreshInvalidatedServerResources(commandEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 9,
      scope: 'full',
    })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collections).toHaveBeenCalledOnce()
    expect(api.characters).toHaveBeenCalledOnce()
  })

  it('replaces prompt-preset shells and rehydrates the selected owner after a prompt preset update', async () => {
    seedResources(1)
    promptHydration.currentOwner = 'prompt-preset-a'
    api.settings.mockResolvedValue({ status: 'ok', revision: 2, settings: { promptPresetsId: 0 } })
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: { promptPresets: [{ id: 'prompt-preset-a', name: 'Prompt A' }] },
    })

    await expect(
      refreshInvalidatedServerResources(event(2, 'promptPreset', { id: 'prompt-preset-a' }), {
        appliedRevision: 1,
        hooks,
      }),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledOnce()
    expect(api.collection).toHaveBeenCalledWith('promptPresets', undefined)
    expect(api.collection).not.toHaveBeenCalledWith('promptTemplate', undefined)
    expect(promptHydration.reset).toHaveBeenCalledTimes(1)
    expect(promptHydration.invalidate).toHaveBeenCalledWith('prompt-preset-a')
    expect(promptHydration.ensure).toHaveBeenCalledWith({
      applyProjection: true,
      force: true,
      minimumRevision: 2,
      promptPresetId: 'prompt-preset-a',
    })
  })

  it('restores the unchanged selected prompt body after a prompt preset creation replaces shell rows', async () => {
    seedResources(1)
    promptHydration.currentOwner = 'prompt-preset-a'
    api.collection.mockResolvedValue({
      status: 'ok',
      revision: 2,
      collections: {
        promptPresets: [
          { id: 'prompt-preset-a', name: 'Prompt A' },
          { id: 'prompt-preset-b', name: 'Prompt B' },
        ],
      },
    })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'promptPreset.created', revision: 2, resource: 'promptPreset', id: 'prompt-preset-b' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settings).not.toHaveBeenCalled()
    expect(promptHydration.reset).toHaveBeenCalledOnce()
    expect(promptHydration.invalidate).toHaveBeenCalledWith('prompt-preset-a')
    expect(promptHydration.ensure).toHaveBeenCalledWith({
      applyProjection: true,
      force: true,
      minimumRevision: 2,
      promptPresetId: 'prompt-preset-a',
    })
  })

  it.each(['lorebook.created', 'lorebook.updated', 'lorebook.entries.replaced'])(
    'refreshes only the lorebook collection for foreign %s events',
    async (type) => {
      seedResources(1)
      api.collection.mockResolvedValue({
        status: 'ok',
        revision: 2,
        collections: { loreBook: [{ id: 'book-a', name: 'Book A', data: [] }] },
      })

      await expect(
        refreshInvalidatedServerResources(
          { type, revision: 2, resource: 'globalLorebook', id: 'book-a' },
          { appliedRevision: 1, hooks },
        ),
      ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

      expect(api.collection).toHaveBeenCalledWith('loreBook', undefined)
      expect(api.settings).not.toHaveBeenCalled()
      expect(api.collections).not.toHaveBeenCalled()
    },
  )

  it('refreshes only settings for a foreign top-level lorebook selection', async () => {
    seedResources(1)
    api.settings.mockResolvedValue({ status: 'ok', revision: 2, settings: { loreBookPage: 0, language: 'ko' } })

    await expect(
      refreshInvalidatedServerResources(
        { type: 'lorebook.selected', revision: 2, resource: 'globalLorebook', id: 'book-a' },
        { appliedRevision: 1, hooks },
      ),
    ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collection).not.toHaveBeenCalled()
    expect(api.collections).not.toHaveBeenCalled()
    expect(lorebookPageOwner.snapshot()).toMatchObject({
      status: 'ready',
      revision: 2,
      state: { present: true, value: 0 },
    })
  })

  it.each([{ type: 'lorebook.deleted', id: 'book-a' }, { type: 'lorebook.reordered' }])(
    'refreshes the lorebook collection and settings for a foreign $type event',
    async ({ type, id }) => {
      seedResources(1)
      api.settings.mockResolvedValue({ status: 'ok', revision: 2, settings: { loreBookPage: 0 } })
      api.collection.mockResolvedValue({
        status: 'ok',
        revision: 2,
        collections: { loreBook: [{ id: 'book-b', name: 'Book B', data: [] }] },
      })

      await expect(
        refreshInvalidatedServerResources(
          { type, revision: 2, resource: 'globalLorebook', ...(id ? { id } : {}) },
          { appliedRevision: 1, hooks },
        ),
      ).resolves.toEqual({ status: 'ok', revision: 2, scope: 'targeted' })

      expect(api.settings).toHaveBeenCalledOnce()
      expect(api.collection).toHaveBeenCalledWith('loreBook', undefined)
      expect(api.collections).not.toHaveBeenCalled()
    },
  )

  it.each([
    { type: 'lorebook.future', revision: 2, resource: 'globalLorebook', id: 'book-a' },
    {
      type: 'lorebook.created',
      revision: 2,
      resource: 'globalLorebook',
      id: 'book-a',
      parentId: 'unexpected-parent',
    },
    { type: 'lorebook.deleted', revision: 2, resource: 'globalLorebook' },
    { type: 'lorebook.reordered', revision: 2, resource: 'globalLorebook', id: 'unexpected-id' },
  ] as CommandEvent[])('uses a full refresh for malformed global lorebook event %#', async (commandEvent) => {
    fullReadMocks(9)

    await expect(refreshInvalidatedServerResources(commandEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 9,
      scope: 'full',
    })

    expect(api.settings).toHaveBeenCalledOnce()
    expect(api.collections).toHaveBeenCalledOnce()
    expect(api.characters).toHaveBeenCalledOnce()
  })

  it.each([
    ['a revision gap', event(4, 'settings'), 1],
    ['a settings event without a group', event(2, 'settings'), 1],
    ['a settings event with an unknown group', event(2, 'settings', { id: 'futureGroup' }), 1],
    ['a state event', event(2, 'state'), 1],
    ['an unknown resource', event(2, 'futureResource'), 1],
    ['a missing required id', event(2, 'characterRow'), 1],
    ['a preset row missing its id', event(2, 'presetRow'), 1],
  ])('falls back to a full refresh for %s', async (_label, commandEvent, appliedRevision) => {
    fullReadMocks(9)

    await expect(refreshInvalidatedServerResources(commandEvent, { appliedRevision, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 9,
      scope: 'full',
    })
    expect(api.settings).toHaveBeenCalledTimes(1)
    expect(api.collections).toHaveBeenCalledTimes(1)
    expect(api.characters).toHaveBeenCalledTimes(1)
  })

  it('propagates failed targeted reads without applying successful siblings or returning a revision', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 3,
      group: 'language',
      settings: { language: 'not-applied' },
    })
    api.collection.mockResolvedValue({ status: 'error', error: 'collection failed' })

    const result = await refreshInvalidatedServerResources(
      [event(2, 'settings', { id: 'language' }), event(3, 'moduleUpdated', { id: 'module-a' })],
      { appliedRevision: 1, hooks },
    )

    expect(result).toEqual({ status: 'error', error: 'collection failed' })
    expect(result).not.toHaveProperty('revision')
    expect(getResourceDatabase().language).toBe('en')
  })

  it('rejects a read older than its event and leaves the applied state unchanged', async () => {
    seedResources(1)
    api.settingsGroup.mockResolvedValue({
      status: 'ok',
      revision: 1,
      group: 'language',
      settings: { language: 'not-applied' },
    })

    const result = await refreshInvalidatedServerResources(event(2, 'settings', { id: 'language' }), {
      appliedRevision: 1,
      hooks,
    })

    expect(result).toMatchObject({ status: 'error', error: expect.stringContaining('older than event revision 2') })
    expect(result).not.toHaveProperty('revision')
    expect(getResourceDatabase().language).toBe('en')
  })

  it.each([
    {
      boundary: 'targeted document',
      changedEvent: {
        type: 'bardwiki.document.updated',
        revision: 2,
        resource: 'bardWikiDocument',
        id: 'document-a',
        parentId: 'chat-a',
      },
    },
    {
      boundary: 'chat-wide change-set',
      changedEvent: {
        type: 'bardwiki.change_set.applied',
        revision: 2,
        resource: 'bardWikiChat',
        id: 'chat-a',
      },
    },
  ])('refreshes resident BardWiki indexes and document bodies after a $boundary event', async ({ changedEvent }) => {
    const document = {
      id: 'document-a',
      chatId: 'chat-a',
      kind: 'location' as const,
      title: 'Old Tavern',
      logicalPath: 'Places/Old Tavern',
      normalizedPath: 'places/old tavern',
      aliases: [],
      contextPolicy: 'relevant' as const,
      reviewState: 'active' as const,
      contentHash: 'a'.repeat(64),
      version: 1,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }
    applyBardWikiChatResource({
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 1,
      chatId: 'chat-a',
      globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      chatSettings: null,
      effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      confirmationCandidate: null,
      documents: [document],
      receipts: [],
      jobs: [],
    })
    applyBardWikiDocumentResource({
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 1,
      chatId: 'chat-a',
      document: { ...document, markdown: 'old', deletedAt: null },
      links: [],
    })
    const updated = { ...document, title: 'New Tavern', contentHash: 'b'.repeat(64), version: 2 }
    api.bardWikiChat.mockResolvedValue({
      status: 'ok',
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 2,
      chatId: 'chat-a',
      globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      chatSettings: null,
      effectiveSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      confirmationCandidate: null,
      documents: [updated],
      receipts: [],
      jobs: [],
    })
    api.bardWikiDocument.mockResolvedValue({
      status: 'ok',
      protocolVersion: BARDWIKI_PROTOCOL_VERSION,
      revision: 2,
      chatId: 'chat-a',
      document: { ...updated, markdown: 'new', deletedAt: null },
      links: [],
    })

    await expect(refreshInvalidatedServerResources(changedEvent, { appliedRevision: 1, hooks })).resolves.toEqual({
      status: 'ok',
      revision: 2,
      scope: 'targeted',
    })

    expect(api.bardWikiChat).toHaveBeenCalledOnce()
    expect(api.bardWikiDocument).toHaveBeenCalledOnce()
    expect(getBardWikiChatResource('chat-a')?.documents[0]).toMatchObject({ title: 'New Tavern', version: 2 })
    expect(getBardWikiDocumentResource('chat-a', 'document-a')?.document).toMatchObject({
      markdown: 'new',
      version: 2,
    })
  })
})
