import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Database } from '../../ts/storage/database.svelte'

const chatMocks = vi.hoisted(() => ({
  alertClear: vi.fn(),
  alertConfirm: vi.fn(async () => false),
  alertError: vi.fn(),
  alertInput: vi.fn(async () => ''),
  alertNormal: vi.fn(),
  alertRequestData: vi.fn(),
  alertWait: vi.fn(),
  canUseServerCommands: vi.fn(() => false),
  getDatabase: vi.fn(),
  getLLMCache: vi.fn(async () => null),
  ParseMarkdown: vi.fn(async (html: string) => html),
  risuChatParser: vi.fn((message: string, arg?: { cbsConditions?: unknown; chara?: unknown; chatID?: unknown }) => {
    return `parsed:${message}:${JSON.stringify(arg?.cbsConditions ?? {})}`
  }),
  clearManualTriggerAbortController: vi.fn(),
  createManualTriggerAbortController: vi.fn(() => new AbortController()),
  runLuaButtonTrigger: vi.fn(async () => undefined),
  runTrigger: vi.fn(async () => undefined),
  sayTTS: vi.fn(),
  setLLMCache: vi.fn(async () => undefined),
}))

const languageMocks = vi.hoisted(() => {
  const partialEdit = {
    cancelShortcut: 'Cancel',
    deleteButtonTooltip: 'Delete',
    deleteConfirmMessage: 'Delete this section?',
    deleteModalTitle: 'Delete',
    deleteNo: 'No',
    deleteYes: 'Yes',
    editButtonTooltip: 'Edit',
    editModalTitle: 'Edit',
    lineNumber: (line: number) => `Line ${line}`,
    matchFailedMessage: 'No match found.',
    matchFailedTitle: 'No match',
    matchesFound: 'matches',
    matchFound: (method: string) => `Matched by ${method}`,
    save: 'Save',
    saveShortcut: 'Save',
    selectDeleteMatch: 'Select delete match',
    selectMatch: 'Select match',
  }

  const language = new Proxy<Record<string, any>>(
    {},
    {
      get: (_target, property) =>
        property === 'partialEdit'
          ? partialEdit
          : property === 'chatGenerationElapsed'
            ? (seconds: number) => `${seconds}s`
            : String(property),
    },
  )

  return { language }
})

vi.mock('./ChatBody.svelte', async () => {
  const mock = await import('./DefaultChatScreen.testChat.svelte')
  return { default: mock.default }
})

vi.mock('../../lang', () => ({
  language: languageMocks.language,
}))

vi.mock('src/lang', () => ({
  language: languageMocks.language,
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  aiLawApplies: () => false,
  changeChatTo: vi.fn(),
  createChatCopyName: (name: string, suffix: string) => `${name} ${suffix}`,
  foldChatToMessage: vi.fn(),
  getFileSrc: vi.fn(async () => ''),
}))

vi.mock('src/ts/gui/longtouch', () => ({
  longpress: (node: HTMLElement, callback: (event: MouseEvent) => void) => {
    const handleTestLongPress = (event: Event) => callback(event as MouseEvent)
    node.addEventListener('test-longpress', handleTestLongPress)
    return {
      destroy: () => node.removeEventListener('test-longpress', handleTestLongPress),
    }
  },
}))

vi.mock('src/ts/model/modellist', () => ({
  getModelInfo: () => ({ shortName: 'mock-model' }),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  getModuleTriggers: () => [],
  moduleUpdate: vi.fn(),
}))

vi.mock('../../ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  getModuleTriggers: () => [],
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/process/scriptings', () => ({
  runLuaButtonTrigger: chatMocks.runLuaButtonTrigger,
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
  risuChatParser: chatMocks.risuChatParser,
}))

vi.mock('../../ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
  risuChatParser: chatMocks.risuChatParser,
}))

vi.mock('src/ts/process/triggers', () => ({
  clearManualTriggerAbortController: chatMocks.clearManualTriggerAbortController,
  createManualTriggerAbortController: chatMocks.createManualTriggerAbortController,
  runTrigger: chatMocks.runTrigger,
}))

vi.mock('src/ts/process/tts', () => ({
  sayTTS: chatMocks.sayTTS,
}))

vi.mock('../../ts/alert', () => ({
  alertClear: chatMocks.alertClear,
  alertConfirm: chatMocks.alertConfirm,
  alertError: chatMocks.alertError,
  alertInput: chatMocks.alertInput,
  alertNormal: chatMocks.alertNormal,
  alertRequestData: chatMocks.alertRequestData,
  alertWait: chatMocks.alertWait,
}))

vi.mock('../../ts/parser/parser.svelte', () => ({
  ParseMarkdown: chatMocks.ParseMarkdown,
}))

vi.mock('../../ts/storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => null),
  getCurrentChat: vi.fn(() => null),
  getDatabase: chatMocks.getDatabase,
  reapplyPendingPresetProjections: () => {},
  setCurrentChat: vi.fn(),
}))

vi.mock('../../ts/translator/translator', () => ({
  getLLMCache: chatMocks.getLLMCache,
  setLLMCache: chatMocks.setLLMCache,
}))

vi.mock('src/ts/chatCommands', () => ({
  cloneJsonValue: <T>(value: T) => JSON.parse(JSON.stringify(value)) as T,
  currentChatScopedSnapshot: vi.fn(() => ({})),
  currentChatStateSnapshot: vi.fn(() => ({})),
  dispatchCompatibleChatUpdateScoped: vi.fn(),
  dispatchDeleteMessageScoped: vi.fn(),
  dispatchForkChat: vi.fn(),
  dispatchReplaceMessagesScoped: vi.fn(),
  dispatchTruncateMessagesScoped: vi.fn(),
  dispatchUpdateChatScopedWithOutcome: vi.fn(),
  dispatchUpdateMessageScoped: vi.fn(),
  ensureMessageId: vi.fn((message: { chatId?: string }) => {
    message.chatId ??= 'generated-message-id'
    return message.chatId
  }),
  restoreChatRowMetadata: vi.fn(),
}))

vi.mock('src/ts/server/commands', () => ({
  canUseServerCommands: chatMocks.canUseServerCommands,
}))

vi.mock('src/ts/util', () => ({
  capitalize: (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
  sleep: vi.fn(async () => undefined),
}))

vi.mock('src/ts/utilState', () => ({
  getPersonaPrompt: () => '',
  getUserDisplayName: () => 'User',
  getUserIcon: () => '',
  getUserName: () => 'User',
}))

import ChatParserDependenciesHarness, { type ParserDependencyRow } from './Chat.parserDependenciesHarness.svelte'
import { replaceResourceDatabase } from '../../ts/server/resourceState.svelte'
import {
  HideIconStore,
  ReloadChatPointer,
  ReloadGUIPointer,
  SizeStore,
  VariableReloadGUIPointer,
  selIdState,
  selectedCharID,
} from '../../ts/stores.svelte'

import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]
type ChatHarnessApi = MountedComponent & {
  updateMessage(index: number, data: string): void
  updateName(index: number, name: string): void
  updateParserIndex(index: number, parserIdx: number): void
  updateRole(index: number, role: string): void
}

let previousDb = getResourceDatabase({ snapshot: true })
let previousSelectedChar = get(selectedCharID)
let previousReloadGui = get(ReloadGUIPointer)
let previousReloadChat = get(ReloadChatPointer)
let previousVariableReloadGui = get(VariableReloadGUIPointer)

let previousHideIcon = get(HideIconStore)
let previousSize = get(SizeStore)
let previousSelId = selIdState.selId

let target: HTMLElement
let component: ChatHarnessApi | undefined

class VisibleIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin = '300px'
  readonly thresholds: ReadonlyArray<number> = [0]

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    const rect = target.getBoundingClientRect()
    this.callback(
      [
        {
          boundingClientRect: rect,
          intersectionRatio: 1,
          intersectionRect: rect,
          isIntersecting: true,
          rootBounds: null,
          target,
          time: 0,
        } as IntersectionObserverEntry,
      ],
      this,
    )
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function setRect(element: HTMLElement, left: number, top: number, width: number, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => domRect(left, top, width, height),
  })
}

function makeRows(count: number): ParserDependencyRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    data: `visible message ${index}`,
    name: index % 2 === 0 ? `Parser Bot ${index}` : 'User',
    role: index % 2 === 0 ? 'char' : 'user',
  }))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function seedDatabase(rows: ParserDependencyRow[]) {
  selectedCharID.set(0)
  selIdState.selId = 0
  ReloadGUIPointer.set(0)
  ReloadChatPointer.set({})
  VariableReloadGUIPointer.set(0)
  HideIconStore.set(false)
  SizeStore.set({ w: 900, h: 700 })
  replaceResourceDatabase({
    askRemoval: false,
    currentChar: 0,
    characters: [
      {
        chaId: 'parser-dependency-character',
        chatPage: 0,
        chats: [
          {
            id: 'parser-dependency-chat',
            name: 'Parser Dependency Chat',
            message: rows.map((row) => ({
              chatId: row.id,
              data: row.data,
              role: row.role,
            })),
            note: '',
            bookmarks: [],
            bookmarkNames: {},
            localLore: [],
          },
        ],
        image: '',
        largePortrait: false,
        name: 'Parser Bot',
        ttsMode: 'none',
        type: 'character',
      },
    ],
    clickToEdit: false,
    createFolderOnBranch: false,
    disableAutoPopupMessageEditor: true,
    enableBlockPartialEdit: false,
    enableBookmark: false,
    enableDragPartialEdit: false,
    guiHTML: '',
    iconsize: 100,
    instantRemove: false,
    lineHeight: 1.25,
    memoryLimitThickness: 1,
    requestInfoInsideChat: false,
    roundIcons: false,
    showFirstMessagePages: false,
    swipe: false,
    theme: '',
    translator: '',
    translatorType: 'none',
    useChatCopy: false,
    zoomsize: 100,
  } as unknown as Database)
}

async function settle() {
  flushSync()
  for (let i = 0; i < 6; i += 1) {
    await tick()
    await Promise.resolve()
  }
}

function mountHarness(rows: ParserDependencyRow[]) {
  component = mount(ChatParserDependenciesHarness, {
    target,
    props: { initialRows: rows },
  }) as ChatHarnessApi
}

// Register once per suite. The real Chat component is mounted, but body parsing
// and command persistence are doubles: assertions cover component orchestration.
export function setupChatTests() {
  beforeEach(() => {
    previousDb = getResourceDatabase({ snapshot: true })
    previousSelectedChar = get(selectedCharID)
    previousSelId = selIdState.selId
    previousReloadGui = get(ReloadGUIPointer)
    previousReloadChat = get(ReloadChatPointer)
    previousVariableReloadGui = get(VariableReloadGUIPointer)
    previousHideIcon = get(HideIconStore)
    previousSize = get(SizeStore)
    target = document.createElement('div')
    document.body.appendChild(target)
    vi.resetAllMocks()
    chatMocks.getDatabase.mockImplementation(() => getResourceDatabase())
    chatMocks.risuChatParser.mockImplementation(
      (message: string, arg?: { cbsConditions?: unknown; chara?: unknown; chatID?: unknown }) => {
        return `parsed:${message}:${JSON.stringify(arg?.cbsConditions ?? {})}`
      },
    )
  })

  afterEach(async () => {
    if (component) {
      await unmount(component)
      component = undefined
    }
    replaceResourceDatabase(previousDb)
    selectedCharID.set(previousSelectedChar)
    selIdState.selId = previousSelId
    ReloadGUIPointer.set(previousReloadGui)
    ReloadChatPointer.set(previousReloadChat)
    VariableReloadGUIPointer.set(previousVariableReloadGui)
    HideIconStore.set(previousHideIcon)
    SizeStore.set(previousSize)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    target.remove()
    document.body.innerHTML = ''
  })
}

export {
  chatMocks,
  languageMocks,
  component,
  target,
  makeRows,
  deferred,
  seedDatabase,
  settle,
  mountHarness,
  VisibleIntersectionObserver,
  setRect,
}
export type { ParserDependencyRow }
