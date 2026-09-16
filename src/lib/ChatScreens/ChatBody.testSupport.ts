import { resetClientSessionForTests } from 'src/ts/clientSession'
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte'
import { afterEach, beforeEach, vi } from 'vitest'

const chatBodyMocks = vi.hoisted(() => ({
  addMetadataToElement: vi.fn((html: string) => html),
  alertError: vi.fn(),
  getDatabase: vi.fn(),
  getCurrentCharacter: vi.fn(() => ({
    additionalAssets: [],
    prebuiltAssetStyle: 'none',
  })),
  getCurrentChat: vi.fn(() => ({ id: 'chat-a', autoTranslate: true })),
  getSelectedCharacterOwner: vi.fn(() => ({
    additionalAssets: [],
    prebuiltAssetStyle: 'none',
    chaId: 'char-a',
    chatPage: 0,
    chats: [chatBodyMocks.getCurrentChat()],
  })),
  getDistance: vi.fn(() => 0),
  getFileSrc: vi.fn(async (src: string) => src),
  getLLMCache: vi.fn(async () => null),
  getLLMCacheMutationEpoch: vi.fn(() => 0),
  getModuleAssets: vi.fn(() => []),
  chatMetadataOwner: { chatId: 'chat-a', autoTranslate: true } as
    | { chatId: string; autoTranslate: boolean }
    | undefined,
  settingsOwner: {} as Record<string, unknown>,
  ParseMarkdown: vi.fn(async (text: string) => text),
  postTranslationParse: vi.fn(async (html: string) => html),
  sleep: vi.fn(async () => {}),
  translateHTML: vi.fn(async (html: string) => html),
  trimMarkdown: vi.fn((html: string) => html),
}))

vi.mock('../../ts/parser/parser.svelte', () => ({
  addMetadataToElement: chatBodyMocks.addMetadataToElement,
  chatHtmlRenderPolicyKey: () => 'false|false',
  getDistance: chatBodyMocks.getDistance,
  ParseMarkdown: chatBodyMocks.ParseMarkdown,
  postTranslationParse: chatBodyMocks.postTranslationParse,
  trimMarkdown: chatBodyMocks.trimMarkdown,
}))

vi.mock('../../ts/translator/translator', () => ({
  getLLMCache: chatBodyMocks.getLLMCache,
  getLLMCacheMutationEpoch: chatBodyMocks.getLLMCacheMutationEpoch,
  translateHTML: chatBodyMocks.translateHTML,
}))

vi.mock('../../ts/alert', () => ({
  alertError: chatBodyMocks.alertError,
}))

vi.mock('src/ts/util', () => ({
  sleep: chatBodyMocks.sleep,
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: chatBodyMocks.getModuleAssets,
  getModules: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModuleTriggers: () => [],
  moduleUpdate: () => {},
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
}))

vi.mock('src/ts/storage/database.svelte', () => ({
  getCurrentCharacter: chatBodyMocks.getCurrentCharacter,
  getCurrentChat: chatBodyMocks.getCurrentChat,
  getDatabase: chatBodyMocks.getDatabase,
}))

vi.mock('src/ts/characterState', () => ({
  getSelectedCharacterOwner: chatBodyMocks.getSelectedCharacterOwner,
}))

vi.mock('src/ts/server/resourceState.svelte', () => ({
  charactersResourceState: { status: 'idle', characters: [], currentChar: -1 },
  collectionsResourceState: { status: 'idle', statuses: {}, values: { promptPresets: [] } },
  getCharacterResourceOwner: () => chatBodyMocks.getSelectedCharacterOwner(),
  getChatMetadataOwnerState: (chatId: string) =>
    chatBodyMocks.chatMetadataOwner?.chatId === chatId ? chatBodyMocks.chatMetadataOwner : undefined,
  settingsResourceState: {
    status: 'idle',
    groupStatuses: {},
    standaloneStatuses: {},
    get value() {
      return chatBodyMocks.settingsOwner
    },
  },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  getFileSrc: chatBodyMocks.getFileSrc,
}))

vi.mock('./sharedChatReadOwners.svelte', () => ({
  sharedChatReadOwners: {
    character: () => chatBodyMocks.getSelectedCharacterOwner(),
    characterById: () => chatBodyMocks.getSelectedCharacterOwner(),
    chat: () => {
      const character = chatBodyMocks.getSelectedCharacterOwner()
      const chat = character.chats[character.chatPage]
      return chatBodyMocks.chatMetadataOwner?.chatId === chat?.id ? chat : undefined
    },
  },
}))

import ChatBody from './ChatBody.svelte'
import { clearChatBodyParseMemo } from './ChatBodyParseMemo'

export { chatBodyMocks }

export async function flushComponentPromises() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await tick()
  }
}

export function setChatBodyDatabase(overrides: Record<string, unknown> = {}) {
  chatBodyMocks.settingsOwner = {
    autoTranslateCachedOnly: false,
    legacyTranslation: false,
    newImageHandlingBeta: false,
    showTranslationLoading: false,
    translateBeforeHTMLFormatting: false,
    translatorType: 'google',
    ...overrides,
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Only component defaults and lifetime are shared; each scenario owns its dependencies.
export function setupChatBody() {
  let target: HTMLElement
  let component: ReturnType<typeof mount> | undefined

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    clearChatBodyParseMemo()
    resetClientSessionForTests()
    chatBodyMocks.chatMetadataOwner = { chatId: 'chat-a', autoTranslate: true }
    chatBodyMocks.getDatabase.mockImplementation(() => chatBodyMocks.settingsOwner)
    setChatBodyDatabase()
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  async function unmountBody() {
    if (component) {
      const mounted = component
      component = undefined
      await unmount(mounted)
    }
  }

  afterEach(async () => {
    await unmountBody()
    target.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    clearChatBodyParseMemo()
    resetClientSessionForTests()
  })

  return {
    get target() {
      return target
    },
    mount(props: Partial<ComponentProps<typeof ChatBody>>, context?: Map<unknown, unknown>) {
      component = mount(ChatBody, {
        target,
        context,
        props: {
          idx: 0,
          modelShortName: '',
          role: 'char',
          translated: false,
          translating: false,
          retranslate: false,
          ...props,
        },
      })
      flushSync()
    },
    unmount: unmountBody,
  }
}
