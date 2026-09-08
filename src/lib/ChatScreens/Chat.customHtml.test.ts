import { demoteClientSession, resetClientSessionForTests } from 'src/ts/clientSession'
import { enterClientWriter, repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../../ts/storage/database.svelte'
import { parseBranchComment } from './branchComment'
import { TRANSCRIPT_INTERACTION_CONTEXT, type TranscriptInteractionProvider } from './transcriptInteraction'
import {
  createTranscriptMessageViewOwner,
  TRANSCRIPT_MESSAGE_VIEW_CONTEXT,
  type TranscriptMessageViewOwner,
} from './transcriptMessageView'

const customHtmlMocks = vi.hoisted(() => {
  const templates = {
    base: 'base-template',
    changed: 'changed-template',
    luaButton: 'lua-button-template',
    triggerButton: 'trigger-button-template',
    throwing: 'throw-template',
  }

  return {
    templates,
    alertClear: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertInput: vi.fn(async () => ''),
    alertNormal: vi.fn(),
    alertRequestData: vi.fn(),
    alertWait: vi.fn(),
    canUseServerCommands: vi.fn(() => false),
    captureChatForkSnapshot: vi.fn(),
    changeChatTo: vi.fn(),
    dispatchForkChatWithOutcome: vi.fn(),
    foldChatToMessage: vi.fn(),
    getDatabase: vi.fn(),
    getChatMessageOwnerState: vi.fn(
      (
        _chatId: string,
      ):
        | {
            chatId: string
            messages: Array<Record<string, unknown>>
            projectionEpoch: number
            resourceLoaded: boolean
            hydrationPending: boolean
            hydrationFailed: boolean
          }
        | undefined => undefined,
    ),
    getServerCommandBaseRevision: vi.fn(async () => 1),
    hydrateChatMessages: vi.fn(async (_chatId: string, _options?: { strict?: boolean; force?: boolean }) => undefined),
    runServerCommand: vi.fn(
      async (input: { command: (baseRevision: number) => Promise<unknown>; rollback?: () => void }) => {
        try {
          const result = await input.command(1)
          if ((result as { status?: string } | undefined)?.status !== 'ok') {
            input.rollback?.()
          }
          return result
        } catch (error) {
          input.rollback?.()
          return {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    ),
    translateMessageCommand: vi.fn(async (input: { baseRevision: number; messageId: string; jobId: string }) => ({
      status: 'ok',
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'message-0',
      },
      chatId: 'custom-html-chat',
      messageId: 'message-0',
      jobId: input.jobId,
      translation: {
        source: 'raw',
        text: 'translated raw',
        sourceHash: 'a'.repeat(64),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'llm',
        settingsHash: 'b'.repeat(64),
        updatedAt: 123,
      },
    })),
    translateGreetingCommand: vi.fn(
      async (input: {
        baseRevision: number
        characterId: string
        chatId: string
        greetingIndex: number
        jobId: string
      }) => ({
        status: 'ok',
        revision: 2,
        event: {
          type: 'character.greetingTranslation.updated',
          revision: 2,
          resource: 'greetingTranslation',
          id: input.characterId,
        },
        characterId: input.characterId,
        chatId: input.chatId,
        greetingIndex: input.greetingIndex,
        jobId: input.jobId,
        settingsHash: 'greeting-settings',
        translation: {
          source: 'raw',
          text: 'translated greeting',
          sourceHash: 'a'.repeat(64),
          targetLanguage: 'ko',
          inputLanguage: 'en',
          translatorType: 'llm',
          settingsHash: 'greeting-settings',
          updatedAt: 123,
        },
      }),
    ),
    updateMessageCommand: vi.fn(async () => ({
      status: 'ok',
      revision: 3,
      event: {
        type: 'message.updated',
        revision: 3,
        resource: 'message',
        id: 'message-0',
      },
    })),
    getLLMCache: vi.fn(async () => null),
    getFileSrc: vi.fn(async () => ''),
    ParseMarkdown: vi.fn(async (html: string) => html),
    risuChatParser: vi.fn(
      (message: string, arg?: { cbsConditions?: { firstmsg?: boolean; chatRole?: string | null } }) => {
        if (message === templates.throwing) {
          throw new Error('template parse failed')
        }

        if (message.startsWith('{{specialcomment')) {
          return message
        }

        if (message === templates.triggerButton) {
          return '<button class="manual-trigger-button" risu-trigger="manual-trigger" risu-id="trigger-id">Run trigger</button>'
        }

        if (message === templates.luaButton) {
          return '<button class="lua-trigger-button" risu-btn="lua-event" risu-id="lua-id">Run Lua</button>'
        }

        if (message === templates.base || message === templates.changed) {
          const cbsConditions = arg?.cbsConditions ?? {}
          return `<div class="custom-html-template" data-role="${cbsConditions.chatRole ?? ''}"><span>${message}|first=${String(cbsConditions.firstmsg ?? false)}|role=${cbsConditions.chatRole ?? 'null'}</span></div>`
        }

        return `parsed-message:${message}`
      },
    ),
    clearManualTriggerAbortController: vi.fn(),
    createManualTriggerAbortController: vi.fn(() => new AbortController()),
    runLuaButtonTrigger: vi.fn<(...args: any[]) => Promise<any>>(async () => undefined),
    runTrigger: vi.fn<(...args: any[]) => Promise<any>>(async () => undefined),
    sayTTS: vi.fn(),
    setLLMCache: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    navigate: vi.fn(),
    restoreChatRowMetadata: vi.fn(),
  }
})

vi.mock('./ChatBody.svelte', async () => {
  const mock = await import('./DefaultChatScreen.testChat.svelte')
  return { default: mock.default }
})

vi.mock('../../lang', async () => {
  const { languageEnglish } = await import('../../lang/en')
  return {
    language: new Proxy(
      {
        connectedReaders: languageEnglish.connectedReaders,
        halfStreamingTokensPerSecond: languageEnglish.halfStreamingTokensPerSecond,
        halfStreamingGeneratedTokens: languageEnglish.halfStreamingGeneratedTokens,
      },
      {
        get: (target, property) =>
          target[property as keyof typeof target] ??
          (property === 'playground'
            ? { translationRunFailed: (detail: string) => `Translation failed: ${detail}` }
            : String(property)),
      },
    ),
  }
})

vi.mock('src/ts/globalApi.svelte', () => ({
  aiLawApplies: () => false,
  changeChatTo: customHtmlMocks.changeChatTo,
  createChatCopyName: (name: string, suffix: string) => `${name} ${suffix}`,
  foldChatToMessage: customHtmlMocks.foldChatToMessage,
  getFileSrc: customHtmlMocks.getFileSrc,
}))

vi.mock('src/ts/router', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/router')>()
  return {
    ...actual,
    navigate: customHtmlMocks.navigate,
  }
})

vi.mock('src/ts/gui/longtouch', () => ({
  longpress: () => undefined,
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
  runLuaButtonTrigger: customHtmlMocks.runLuaButtonTrigger,
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
  risuChatParser: customHtmlMocks.risuChatParser,
}))

vi.mock('../../ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
  risuChatParser: customHtmlMocks.risuChatParser,
}))

vi.mock('src/ts/process/triggers', () => ({
  clearManualTriggerAbortController: customHtmlMocks.clearManualTriggerAbortController,
  createManualTriggerAbortController: customHtmlMocks.createManualTriggerAbortController,
  runTrigger: customHtmlMocks.runTrigger,
}))

vi.mock('src/ts/process/tts', () => ({
  sayTTS: customHtmlMocks.sayTTS,
}))

vi.mock('../../ts/alert', () => ({
  alertClear: customHtmlMocks.alertClear,
  alertConfirm: customHtmlMocks.alertConfirm,
  alertError: customHtmlMocks.alertError,
  alertInput: customHtmlMocks.alertInput,
  alertNormal: customHtmlMocks.alertNormal,
  alertRequestData: customHtmlMocks.alertRequestData,
  alertWait: customHtmlMocks.alertWait,
}))

vi.mock('../../ts/parser/parser.svelte', () => ({
  ParseMarkdown: customHtmlMocks.ParseMarkdown,
}))

vi.mock('../../ts/storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(),
  getCurrentChat: vi.fn(),
  getDatabase: customHtmlMocks.getDatabase,
  reapplyPendingPresetProjections: () => {},
  setCurrentChat: vi.fn(),
}))

vi.mock('../../ts/translator/translator', () => ({
  getLLMCache: customHtmlMocks.getLLMCache,
  setLLMCache: customHtmlMocks.setLLMCache,
}))

vi.mock('src/ts/chatCommands', () => ({
  captureChatForkSnapshot: customHtmlMocks.captureChatForkSnapshot,
  cloneJsonValue: <T>(value: T) => JSON.parse(JSON.stringify(value)) as T,
  currentChatScopedSnapshot: vi.fn(() => {
    const character = customHtmlMocks.getDatabase().characters[0]
    const chat = character.chats[character.chatPage]
    return {
      selectedCharID: 0,
      characterId: character.chaId,
      chatId: chat.id,
      chat: JSON.parse(JSON.stringify(chat)),
    }
  }),
  currentChatStateSnapshot: vi.fn(() => {
    throw new Error('Branching must not capture every character transcript')
  }),
  dispatchCompatibleChatUpdateScoped: vi.fn(),
  dispatchDeleteMessageScoped: vi.fn(),
  dispatchForkChatWithOutcome: customHtmlMocks.dispatchForkChatWithOutcome,
  dispatchReplaceMessagesScoped: vi.fn(),
  dispatchTruncateMessagesScoped: vi.fn(),
  dispatchUpdateChatScopedWithOutcome: vi.fn(),
  dispatchUpdateMessageScoped: vi.fn(),
  ensureMessageId: vi.fn((message: { chatId?: string }) => {
    message.chatId ??= 'generated-message-id'
    return message.chatId
  }),
  restoreChatRowMetadata: customHtmlMocks.restoreChatRowMetadata,
}))

vi.mock('src/ts/server/commands', () => ({
  canUseServerCommands: customHtmlMocks.canUseServerCommands,
  getServerCommandBaseRevision: customHtmlMocks.getServerCommandBaseRevision,
  runServerCommand: customHtmlMocks.runServerCommand,
  translateMessageCommand: customHtmlMocks.translateMessageCommand,
  translateGreetingCommand: customHtmlMocks.translateGreetingCommand,
  updateMessageCommand: customHtmlMocks.updateMessageCommand,
}))

const greetingProjectionMocks = vi.hoisted(() => {
  let jobs: unknown[] = []
  const subscribers = new Set<(value: unknown[]) => void>()
  return {
    translation: null as Record<string, unknown> | null,
    greetingIndex: -1,
    active: {
      subscribe(callback: (value: unknown[]) => void) {
        callback(jobs)
        subscribers.add(callback)
        return () => subscribers.delete(callback)
      },
      update(updater: (value: unknown[]) => unknown[]) {
        jobs = updater(jobs)
        for (const subscriber of subscribers) subscriber(jobs)
      },
    },
    reset() {
      this.translation = null
      this.greetingIndex = -1
      jobs = []
      for (const subscriber of subscribers) subscriber(jobs)
    },
  }
})

vi.mock('src/ts/server/greetingTranslations.svelte', () => ({
  activeGreetingTranslations: greetingProjectionMocks.active,
  getGreetingTranslationProjection: () => ({
    revision: 1,
    characterId: 'custom-html-character',
    chatId: 'custom-html-chat',
    settingsHash: 'greeting-settings',
    clientSettingsSignature: 'client-settings',
    translations: [],
  }),
  findGreetingTranslation: (input: { greetingIndex: number }) =>
    input.greetingIndex === greetingProjectionMocks.greetingIndex ? greetingProjectionMocks.translation : null,
  refreshGreetingTranslationProjection: vi.fn(async () => ({ status: 'ok' })),
  applyGreetingTranslationCommandReceipt: (input: { greetingIndex: number; translation: Record<string, unknown> }) => {
    greetingProjectionMocks.greetingIndex = input.greetingIndex
    greetingProjectionMocks.translation = input.translation
    return true
  },
  beginActiveGreetingTranslation: (job: Record<string, unknown>) => {
    greetingProjectionMocks.active.update((jobs) => [...jobs, job])
    return true
  },
  isCurrentGreetingTranslationJob: (
    characterId: string,
    chatId: string,
    greetingIndex: number,
    settingsHash: string,
    jobId: string,
  ) =>
    (greetingProjectionMocks.active as any) &&
    characterId === 'custom-html-character' &&
    chatId === 'custom-html-chat' &&
    greetingIndex === -1 &&
    settingsHash === 'greeting-settings' &&
    typeof jobId === 'string',
  clearGreetingTranslationJob: (jobId: string) => {
    greetingProjectionMocks.active.update((jobs) =>
      jobs.filter((job) => (job as Record<string, unknown>).jobId !== jobId),
    )
  },
}))

vi.mock('src/ts/server/chatMessageHydration.svelte', () => ({
  applyMessageTranslationLocalEffect: (chatId: string, messageId: string, translation: unknown) => {
    const messages = customHtmlMocks.getChatMessageOwnerState(chatId)?.messages ?? []
    const matches = messages.filter((message) => message.chatId === messageId)
    if (matches.length !== 1) return false
    matches[0].translation = translation
    return true
  },
  applyServerChatMessagesResource: vi.fn(() => true),
  getChatMessageOwnerState: customHtmlMocks.getChatMessageOwnerState,
  hydrateActiveChat: vi.fn(async () => undefined),
  hydrateChatMessages: customHtmlMocks.hydrateChatMessages,
  resetChatHydration: vi.fn(),
}))

vi.mock('src/ts/util', () => ({
  capitalize: (value: string) => value.charAt(0).toUpperCase() + value.slice(1),
  sleep: customHtmlMocks.sleep,
}))

vi.mock('src/ts/utilState', () => ({
  getPersonaPrompt: () => '',
  getUserDisplayName: () => 'User',
  getUserIcon: () => '',
  getUserName: () => 'User',
}))

import Chat from './Chat.svelte'
import { createChatReadOwners } from './chatReadOwners.svelte'
import { CHAT_READ_OWNERS_CONTEXT } from './chatReadOwnersContext'
import { getChatMessageOwnerState } from 'src/ts/server/chatMessageHydration.svelte'
import PopupList from '../UI/PopupList.svelte'
import {
  clearCustomHtmlTemplateMemo,
  getCustomHtmlTemplateMemoSize,
  renderCustomHtmlTemplate,
} from './ChatCustomHtmlTemplate'
import {
  CurrentTriggerIdStore,
  HideIconStore,
  ReloadChatPointer,
  ReloadGUIPointer,
  SizeStore,
  VariableReloadGUIPointer,
  popUpEditorStore,
  popupStore,
  selIdState,
  selectedCharID,
} from '../../ts/stores.svelte'
import { getCurrentCharacter, getCurrentChat } from '../../ts/storage/database.svelte'
import {
  charactersResourceState,
  replaceResourceDatabase,
  settingsResourceState,
} from '../../ts/server/resourceState.svelte'
import {
  captureChatForkSnapshot,
  currentChatStateSnapshot,
  dispatchCompatibleChatUpdateScoped,
  dispatchDeleteMessageScoped,
  dispatchForkChatWithOutcome,
  dispatchReplaceMessagesScoped,
  dispatchTruncateMessagesScoped,
  dispatchUpdateChatScopedWithOutcome,
  dispatchUpdateMessageScoped,
  type ChatMutationFinalOutcome,
  type ChatMutationOutcome,
} from 'src/ts/chatCommands'
import {
  activeMessageTranslations,
  clearMessageTranslationJob,
  setActiveMessageTranslations,
} from 'src/ts/server/messageTranslationJobs'

import { BILINGUAL_PAIR_CLASS } from '../../ts/translator/bilingualInterleave'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: Database) {
    replaceResourceDatabase(value)
  },
}

customHtmlMocks.getDatabase.mockImplementation(() => testDatabaseState.db)

type MountedComponent = Parameters<typeof unmount>[0]

const previousDb = getResourceDatabase({ snapshot: true })
const previousSelectedChar = get(selectedCharID)
const previousReloadGui = get(ReloadGUIPointer)
const previousReloadChat = get(ReloadChatPointer)
const previousVariableReloadGui = get(VariableReloadGUIPointer)

let target: HTMLElement
let components: MountedComponent[] = []
let parserCalls: Array<[string, DOMParserSupportedType]>
let NativeDOMParser: typeof DOMParser

class CountingDOMParser {
  parseFromString(markup: string, type: DOMParserSupportedType) {
    parserCalls.push([markup, type])
    return new NativeDOMParser().parseFromString(markup, type)
  }
}

function templateCalls(template: string) {
  return customHtmlMocks.risuChatParser.mock.calls.filter((call) => call[0] === template)
}

function seedDatabase(messageCount: number, guiHTML = customHtmlMocks.templates.base) {
  selectedCharID.set(0)
  selIdState.selId = 0
  ReloadGUIPointer.set(0)
  ReloadChatPointer.set({})
  VariableReloadGUIPointer.set(0)
  popupStore.children = null
  popupStore.openId = 0
  popupStore.mouseX = 0
  popupStore.mouseY = 0
  popUpEditorStore.open = false
  popUpEditorStore.value = ''
  popUpEditorStore.mode = 'default'
  popUpEditorStore.language = 'markdown'
  HideIconStore.set(false)
  SizeStore.set({ w: 900, h: 700 })
  testDatabaseState.db = {
    askRemoval: false,
    characters: [
      {
        chaId: 'custom-html-character',
        chatPage: 0,
        chats: [
          {
            id: 'custom-html-chat',
            name: 'Custom HTML Chat',
            message: Array.from({ length: messageCount }, (_, index) => ({
              chatId: `message-${index}`,
              data: `visible message ${index}`,
              role: 'char',
            })),
            note: '',
            bookmarks: [],
            bookmarkNames: {},
            localLore: [],
          },
          {
            id: 'custom-html-other-chat',
            name: 'Other Chat',
            message: [
              {
                chatId: 'other-message-0',
                data: 'other chat message',
                role: 'char',
              },
            ],
            note: '',
            bookmarks: [],
            bookmarkNames: {},
            localLore: [],
          },
        ],
        image: '',
        largePortrait: false,
        name: 'Template Bot',
        ttsMode: 'none',
        type: 'character',
      },
    ],
    currentChar: 0,
    clickToEdit: false,
    createFolderOnBranch: false,
    disableAutoPopupMessageEditor: true,
    enableBlockPartialEdit: false,
    enableBookmark: false,
    enableDragPartialEdit: false,
    guiHTML,
    iconsize: 100,
    instantRemove: false,
    lineHeight: 1.25,
    memoryLimitThickness: 1,
    requestInfoInsideChat: false,
    roundIcons: false,
    showFirstMessagePages: false,
    swipe: false,
    theme: 'customHTML',
    translator: '',
    translatorType: 'none',
    useChatCopy: false,
    zoomsize: 100,
  } as unknown as Database
}

function mountCustomHtmlRows(
  count: number,
  role = 'char',
  props: Partial<{
    message: string
    readOnly: boolean
    displayChatId: string
    displayMessageId: string
    isComment: boolean
    rerollIcon: boolean | 'dynamic'
    onReroll: () => void
    unReroll: () => void
    onNewReroll: () => void
    onSelectRerollCandidate: (index: number) => void
    autoTranslateOnReady: boolean
    onAutoTranslationEligibilityConsumed: () => void
    isChatGenerating: boolean
    isGenerationLoading: boolean
    halfStreamingTokensPerSecond: number
    halfStreamingGeneratedTokens: number
    messageGenerationInfo: { model?: string; generationId?: string }
    generationPersistenceState: 'queued' | 'stalled' | 'terminal' | 'stalled_legacy' | null
  }> = {},
  startIndex = 0,
  interactions?: TranscriptInteractionProvider,
  messageViews?: TranscriptMessageViewOwner,
) {
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset
    components.push(
      mount(Chat, {
        target,
        context: new Map<symbol, unknown>([
          ...(interactions ? [[TRANSCRIPT_INTERACTION_CONTEXT, interactions] as const] : []),
          ...(messageViews ? [[TRANSCRIPT_MESSAGE_VIEW_CONTEXT, messageViews] as const] : []),
        ]),
        props: {
          message: `visible message ${index}`,
          name: 'Template Bot',
          isLastMemory: false,
          idx: index,
          role,
          totalLength: Math.max(count, startIndex + count),
          firstMessage: false,
          img: '',
          rerollIcon: false,
          disabled: false,
          ...props,
        },
      }) as MountedComponent,
    )
  }
}

function mountStableMessageRow(messageId: string) {
  const chat = testDatabaseState.db.characters[0].chats[0]
  components.push(
    mount(Chat, {
      target,
      props: {
        get message() {
          return chat.message.find((message) => message.chatId === messageId)?.data ?? ''
        },
        get idx() {
          return chat.message.findIndex((message) => message.chatId === messageId)
        },
        get totalLength() {
          return chat.message.length
        },
        name: 'Template Bot',
        isLastMemory: false,
        role: 'char',
        displayMessageId: messageId,
        displayChatId: chat.id,
      },
    }) as MountedComponent,
  )
}

function mountPopupList() {
  components.push(mount(PopupList, { target }) as MountedComponent)
}

async function settle() {
  flushSync()
  for (let i = 0; i < 6; i += 1) {
    await tick()
    await Promise.resolve()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function buttonByText(text: string) {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  )
}

async function openMessageActions() {
  target.querySelector<HTMLButtonElement>('.button-icon-menu')?.click()
  await settle()
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  components = []
  parserCalls = []
  NativeDOMParser = globalThis.DOMParser
  vi.stubGlobal('DOMParser', CountingDOMParser)
  vi.clearAllMocks()
  greetingProjectionMocks.reset()
  customHtmlMocks.changeChatTo.mockImplementation((idOrIndex: string | number) => {
    const character = testDatabaseState.db.characters[0]
    const chatIndex =
      typeof idOrIndex === 'number' ? idOrIndex : character.chats.findIndex((chat) => chat.id === idOrIndex)
    if (chatIndex >= 0) {
      character.chatPage = chatIndex
    }
  })
  customHtmlMocks.sleep.mockResolvedValue(undefined)
  customHtmlMocks.getFileSrc.mockResolvedValue('')
  customHtmlMocks.canUseServerCommands.mockReturnValue(false)
  customHtmlMocks.captureChatForkSnapshot.mockReturnValue({ kind: 'chat-fork' })
  customHtmlMocks.getChatMessageOwnerState.mockImplementation((chatId: string) => {
    const matches = testDatabaseState.db.characters.flatMap((character) =>
      character.chats.filter((chat) => chat.id === chatId),
    )
    if (matches.length !== 1) return undefined
    return {
      chatId,
      messages: matches[0].message as unknown as Array<Record<string, unknown>>,
      projectionEpoch: 0,
      resourceLoaded: true,
      hydrationPending: false,
      hydrationFailed: false,
    }
  })
  vi.mocked(dispatchForkChatWithOutcome).mockResolvedValue({
    status: 'accepted',
    result: { status: 'ok' },
  } as never)
  vi.mocked(dispatchUpdateMessageScoped).mockReturnValue(null)
  customHtmlMocks.runServerCommand.mockImplementation(
    async (input: { command: (baseRevision: number) => Promise<unknown>; rollback?: () => void }) => {
      try {
        const result = await input.command(1)
        if ((result as { status?: string } | undefined)?.status !== 'ok') {
          input.rollback?.()
        }
        return result
      } catch (error) {
        input.rollback?.()
        return {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  )
  customHtmlMocks.translateMessageCommand.mockImplementation(
    async (input: { baseRevision: number; messageId: string; jobId: string }) => ({
      status: 'ok',
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'message-0',
      },
      chatId: 'custom-html-chat',
      messageId: 'message-0',
      jobId: input.jobId,
      translation: {
        source: 'raw',
        text: 'translated raw',
        sourceHash: 'a'.repeat(64),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'llm' as const,
        settingsHash: 'b'.repeat(64),
        updatedAt: 123,
      },
    }),
  )
  customHtmlMocks.updateMessageCommand.mockResolvedValue({
    status: 'ok',
    revision: 3,
    event: {
      type: 'message.updated',
      revision: 3,
      resource: 'message',
      id: 'message-0',
    },
  })
  for (const job of get(activeMessageTranslations)) clearMessageTranslationJob(job.jobId)
  setActiveMessageTranslations([])
  clearCustomHtmlTemplateMemo()
  vi.mocked(getCurrentCharacter).mockImplementation(() => testDatabaseState.db.characters?.[selIdState.selId] ?? null)
  vi.mocked(getCurrentChat).mockImplementation(() => {
    const character = testDatabaseState.db.characters?.[selIdState.selId]
    return character?.chats?.[character.chatPage] ?? null
  })
})

afterEach(() => {
  for (const component of components) {
    unmount(component)
  }
  components = []
  clearCustomHtmlTemplateMemo()
  for (const job of get(activeMessageTranslations)) clearMessageTranslationJob(job.jobId)
  setActiveMessageTranslations([])
  vi.unstubAllGlobals()
  testDatabaseState.db = previousDb
  selectedCharID.set(previousSelectedChar)
  selIdState.selId = previousSelectedChar
  ReloadGUIPointer.set(previousReloadGui)
  ReloadChatPointer.set(previousReloadChat)
  VariableReloadGUIPointer.set(previousVariableReloadGui)
  popupStore.children = null
  popupStore.openId = 0
  popupStore.mouseX = 0
  popupStore.mouseY = 0
  popUpEditorStore.open = false
  popUpEditorStore.value = ''
  setActiveMessageTranslations([])
  target.remove()
  document.body.innerHTML = ''
  resetClientSessionForTests()
})

describe('empty synthetic greeting identity', () => {
  it('keeps the character icon and name beside the empty-chat prompt', async () => {
    seedDatabase(0, null as unknown as string)
    components.push(
      mount(Chat, {
        target,
        props: {
          message: '',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          img: 'background-image:url("character-icon.png");',
          rerollIcon: false,
          disabled: false,
        },
      }) as MountedComponent,
    )
    await settle()

    const greeting = target.querySelector<HTMLElement>('.risu-chat[data-chat-index="-1"]')
    expect(greeting?.textContent).toContain('noMessage')
    expect(greeting?.textContent).toContain('Template Bot')
    expect(greeting?.querySelector<HTMLElement>('.shadow-lg.bg-textcolor2')?.style.backgroundImage).toContain(
      'character-icon.png',
    )
  })
})

describe('generation finalization row indicator', () => {
  it('renders a terminal legacy warning only on the exact affected message row', async () => {
    seedDatabase(2, null as unknown as string)
    mountCustomHtmlRows(1, 'char', {}, 0)
    mountCustomHtmlRows(1, 'char', { generationPersistenceState: 'stalled_legacy' }, 1)
    await settle()

    const unaffected = target.querySelector<HTMLElement>('.risu-chat[data-chat-id="message-0"]')
    const affected = target.querySelector<HTMLElement>('.risu-chat[data-chat-id="message-1"]')
    expect(unaffected?.querySelector('[data-generation-persistence-state]')).toBeNull()
    expect(affected?.querySelector('[data-generation-persistence-state="stalled_legacy"]')?.textContent).toContain(
      'generationPersistenceStalledLegacy',
    )
  })
})

describe('explicit Chat resource owners', () => {
  it('does not recover a ready message id from the aggregate when the transcript owner is missing', async () => {
    seedDatabase(1, null as unknown as string)
    customHtmlMocks.getChatMessageOwnerState.mockReturnValue(undefined)
    mountCustomHtmlRows(1)
    await settle()

    expect(target.querySelector<HTMLElement>('.risu-chat[data-chat-index="0"]')?.dataset.chatId).toBe('')
    target.querySelector<HTMLButtonElement>('[data-risu-message-action="remove"]')?.click()
    await settle()
    expect(dispatchDeleteMessageScoped).not.toHaveBeenCalled()
  })

  it('fails closed when ready character or chat ids are duplicated', async () => {
    seedDatabase(1, null as unknown as string)
    const character = testDatabaseState.db.characters[0]
    character.chats.push(JSON.parse(JSON.stringify(character.chats[0])) as (typeof character.chats)[number])
    testDatabaseState.db.characters.push(JSON.parse(JSON.stringify(character)) as typeof character)
    mountCustomHtmlRows(1)
    await settle()

    expect(target.querySelector<HTMLElement>('.risu-chat[data-chat-index="0"]')?.dataset.chatId).toBe('')
  })

  it('does not revive character or display aggregates after an owner error', async () => {
    seedDatabase(1, customHtmlMocks.templates.base)
    charactersResourceState.status = 'error'
    settingsResourceState.groupStatuses.display = 'error'
    mountCustomHtmlRows(1)
    await settle()

    const row = target.querySelector<HTMLElement>('.risu-chat[data-chat-index="0"]')
    expect(row?.dataset.chatId).toBe('')
    expect(row?.querySelector('.custom-html-template')).toBeNull()
  })
})

describe('regeneration row feedback', () => {
  it('replaces the previous response and its metadata controls with generation loading feedback', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.requestInfoInsideChat = true
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.autoTranslate = true
    chat.message[0].generationInfo = { model: 'mock-model', generationId: 'message-0' }
    chat.message[0].translation = {
      source: 'raw',
      text: 'translated previous response',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }

    mountCustomHtmlRows(1, 'char', {
      isGenerationLoading: true,
      messageGenerationInfo: chat.message[0].generationInfo,
      rerollIcon: true,
    })
    await settle()

    expect(target.querySelector('.chat-generation-loading[role="status"]')).toBeTruthy()
    expect(target.textContent).not.toContain('visible message 0')
    expect(target.textContent).not.toContain('translated previous response')
    expect(target.textContent).not.toContain('retranslate')
    expect(target.textContent).not.toContain('Mock-model')
    expect(target.querySelector('.button-icon-reroll')).toBeNull()
  })
})

describe('half-streaming row feedback', () => {
  it.each(['', 'visible previous response'])('shows speed and total output tokens with message=%j', async (message) => {
    seedDatabase(1, null as unknown as string)
    mountCustomHtmlRows(1, 'char', {
      message,
      isGenerationLoading: message.length === 0,
      isChatGenerating: true,
      halfStreamingTokensPerSecond: 12.5,
      halfStreamingGeneratedTokens: 250,
    })
    await settle()

    expect(target.querySelector('.chat-generation-loading')?.textContent).toContain('12.5 tokens/s · 250 tokens')
  })
})

describe('customHTML template memo', () => {
  it('repeated customHTML rows share one parsed template per template version', async () => {
    seedDatabase(4)
    mountCustomHtmlRows(4)
    await settle()

    expect(templateCalls(customHtmlMocks.templates.base)).toHaveLength(1)
    expect(parserCalls).toHaveLength(1)
    expect(target.querySelectorAll('.custom-html-template')).toHaveLength(4)
    expect(target.textContent).toContain('base-template|first=false|role=char')

    customHtmlMocks.risuChatParser.mockClear()
    parserCalls = []
    ReloadGUIPointer.update((value) => value + 1)
    await settle()

    expect(templateCalls(customHtmlMocks.templates.base)).toHaveLength(0)
    expect(parserCalls).toHaveLength(0)
  })

  it('guiHTML changes and cbs-condition changes invalidate the customHTML template memo', async () => {
    seedDatabase(2)
    mountCustomHtmlRows(2)
    await settle()
    customHtmlMocks.risuChatParser.mockClear()
    parserCalls = []

    testDatabaseState.db.guiHTML = customHtmlMocks.templates.changed
    await settle()

    expect(templateCalls(customHtmlMocks.templates.changed)).toHaveLength(1)
    expect(parserCalls).toHaveLength(1)
    expect(target.textContent).toContain('changed-template|first=false|role=char')

    customHtmlMocks.risuChatParser.mockClear()
    parserCalls = []
    mountCustomHtmlRows(1, 'user')
    await settle()

    expect(templateCalls(customHtmlMocks.templates.changed)).toHaveLength(1)
    expect(parserCalls).toHaveLength(1)
    expect(target.textContent).toContain('changed-template|first=false|role=user')
  })

  it('re-parses the customHTML template when variable or active-chat scope changes', async () => {
    seedDatabase(2)
    mountCustomHtmlRows(2)
    await settle()
    customHtmlMocks.risuChatParser.mockClear()
    parserCalls = []

    VariableReloadGUIPointer.update((value) => value + 1)
    await settle()

    expect(templateCalls(customHtmlMocks.templates.base)).toHaveLength(1)
    expect(parserCalls).toHaveLength(1)

    customHtmlMocks.risuChatParser.mockClear()
    parserCalls = []
    testDatabaseState.db.characters[0].chatPage = 1
    await settle()

    expect(templateCalls(customHtmlMocks.templates.base)).toHaveLength(1)
    expect(parserCalls).toHaveLength(1)
  })

  it('falls back to the standard message layout when customHTML has no template', async () => {
    seedDatabase(1, null as unknown as string)
    mountCustomHtmlRows(1)
    await settle()

    expect(target.querySelector('.custom-html-template')).toBeNull()
    expect(target.textContent).toContain('Template Bot')
    expect(target.textContent).toContain('parsed-message:visible message 0')
  })

  it('parse failures return an empty placeholder without poisoning the memo', () => {
    const body = renderCustomHtmlTemplate(customHtmlMocks.templates.throwing, {
      firstmsg: false,
      chatRole: 'char',
    })

    expect(body.tagName).toBe('DIV')
    expect(body.childNodes).toHaveLength(0)
    expect(getCustomHtmlTemplateMemoSize()).toBe(0)
  })
})

describe('customHTML rendered button trigger freshness', () => {
  it('hydrates the full transcript before running and persisting a manual trigger', async () => {
    seedDatabase(31, customHtmlMocks.templates.triggerButton)
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.message[0] = {
      role: 'char',
      data: '',
      isComment: true,
      disabled: true,
      __risuServerUnloadedMessage: true,
    } as unknown as (typeof chat.message)[number]
    chat.message[1] = {
      role: 'char',
      data: '',
      isComment: true,
      disabled: true,
      __risuServerUnloadedMessage: true,
    } as unknown as (typeof chat.message)[number]
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      chat.message[0] = { chatId: 'message-0', data: 'hydrated head 0', role: 'user' }
      chat.message[1] = { chatId: 'message-1', data: 'hydrated head 1', role: 'char' }
    })
    customHtmlMocks.runTrigger.mockImplementationOnce(async (_char, _mode, arg) => {
      expect(arg.chat.message[0].data).toBe('hydrated head 0')
      expect(arg.chat.message[1].data).toBe('hydrated head 1')
      return {
        chat: {
          ...arg.chat,
          message: arg.chat.message.map((message: { data: string }, index: number) =>
            index < 2 ? { ...message, data: `trigger edit ${index}` } : message,
          ),
        },
      }
    })
    mountCustomHtmlRows(1, 'char', {}, 30)
    await settle()

    target.querySelector<HTMLButtonElement>('.manual-trigger-button')?.click()
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledWith('custom-html-chat', { strict: true })
    expect(customHtmlMocks.runTrigger).toHaveBeenCalledTimes(1)
    const appliedMessages = testDatabaseState.db.characters[0].chats[0].message
    expect(appliedMessages[0].data).toBe('trigger edit 0')
    expect(appliedMessages[1].data).toBe('trigger edit 1')
    expect(dispatchCompatibleChatUpdateScoped).toHaveBeenCalledTimes(1)
  })

  it('does not let an older trigger cleanup clear a newer manual trigger identity', async () => {
    seedDatabase(1, customHtmlMocks.templates.triggerButton)
    mountCustomHtmlRows(1)
    await settle()

    const secondTrigger = deferred<void>()
    let invocation = 0
    customHtmlMocks.runTrigger.mockImplementation(async (_char, _mode, arg) => {
      invocation += 1
      CurrentTriggerIdStore.set(arg.triggerId ?? null)
      if (invocation === 2) await secondTrigger.promise
      return undefined
    })
    CurrentTriggerIdStore.set(null)
    vi.useFakeTimers()

    try {
      const button = target.querySelector<HTMLButtonElement>('.manual-trigger-button')
      button?.click()
      await settle()
      expect(invocation).toBe(1)
      expect(get(CurrentTriggerIdStore)).toBe('trigger-id')

      button?.click()
      await settle()
      expect(invocation).toBe(2)

      await vi.advanceTimersByTimeAsync(100)
      await settle()
      expect(get(CurrentTriggerIdStore)).toBe('trigger-id')

      secondTrigger.resolve()
      await settle()
      await vi.advanceTimersByTimeAsync(100)
      await settle()
      expect(get(CurrentTriggerIdStore)).toBeNull()
    } finally {
      vi.useRealTimers()
      CurrentTriggerIdStore.set(null)
    }
  })

  it('drops a stale risu-trigger result after the active chat switches', async () => {
    seedDatabase(1, customHtmlMocks.templates.triggerButton)
    mountCustomHtmlRows(1)
    await settle()

    const result = deferred<void>()
    customHtmlMocks.runTrigger.mockImplementation(async (_char, _mode, arg) => {
      await result.promise
      return {
        chat: {
          ...arg.chat,
          message: [{ chatId: 'message-0', data: 'stale trigger result', role: 'char' }],
        },
      }
    })

    target.querySelector<HTMLButtonElement>('.manual-trigger-button')?.click()
    await tick()

    testDatabaseState.db.characters[0].chatPage = 1
    result.resolve()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(testDatabaseState.db.characters[0].chats[1].message[0].data).toBe('other chat message')
    expect(dispatchCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('drops a stale risu-btn result after the active chat switches', async () => {
    seedDatabase(1, customHtmlMocks.templates.luaButton)
    mountCustomHtmlRows(1)
    await settle()

    const result = deferred<void>()
    customHtmlMocks.runLuaButtonTrigger.mockImplementation(async (_char, _event, options) => {
      await result.promise
      return {
        chat: {
          ...options.chat,
          message: [{ chatId: 'message-0', data: 'stale lua result', role: 'char' }],
        },
      }
    })

    target.querySelector<HTMLButtonElement>('.lua-trigger-button')?.click()
    await tick()

    testDatabaseState.db.characters[0].chatPage = 1
    result.resolve()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(testDatabaseState.db.characters[0].chats[1].message[0].data).toBe('other chat message')
    expect(dispatchCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('bumps the variable-only reload epoch after an applied risu-btn scriptstate change', async () => {
    seedDatabase(1, customHtmlMocks.templates.luaButton)
    mountCustomHtmlRows(1)
    await settle()

    customHtmlMocks.runLuaButtonTrigger.mockImplementation(async (_char, _event, options) => ({
      chat: {
        ...options.chat,
        scriptstate: {
          ...(options.chat.scriptstate ?? {}),
          $choice: 'applied',
        },
      },
    }))
    const previousVariableEpoch = get(VariableReloadGUIPointer)

    target.querySelector<HTMLButtonElement>('.lua-trigger-button')?.click()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].scriptstate?.$choice).toBe('applied')
    expect(get(VariableReloadGUIPointer)).toBe(previousVariableEpoch + 1)
    expect(dispatchCompatibleChatUpdateScoped).toHaveBeenCalled()
  })
})

describe('transcript interaction reservations', () => {
  it('rejects an additional editor before changing its draft and releases accepted edits on save', async () => {
    seedDatabase(1, null as unknown as string)
    const release = vi.fn()
    const reserve = vi.fn<TranscriptInteractionProvider['reserve']>(() => null)
    mountCustomHtmlRows(1, 'char', {}, 0, { reserve, subscribeAvailable: () => () => {} })
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(customHtmlMocks.alertNormal).toHaveBeenCalledWith('transcriptInteractionLimit')
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()

    reserve.mockReturnValue(release)
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(reserve).toHaveBeenLastCalledWith('message-0', expect.any(Object))
    expect(target.querySelector('.message-edit-area')).not.toBeNull()
    expect(release).not.toHaveBeenCalled()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(release).toHaveBeenCalledOnce()
  })

  it('restores a manual return to the original after the translated row is evicted and remounted', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.autoTranslate = true
    chat.message[0].translation = {
      source: 'raw',
      text: 'saved translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const views = createTranscriptMessageViewOwner()
    mountCustomHtmlRows(1, 'char', {}, 0, undefined, views)
    await settle()
    expect(target.textContent).toContain('saved translation')
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).not.toContain('saved translation')
    for (const mounted of components) unmount(mounted)
    components = []
    await settle()
    mountCustomHtmlRows(1, 'char', {}, 0, undefined, views)
    await settle()
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('saved translation')
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
  })

  it('keeps automatic translation eligible while full, then holds the row until its provider request settles', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    testDatabaseState.db.characters[0].chats[0].autoTranslate = true
    const release = vi.fn()
    const reserve = vi.fn<TranscriptInteractionProvider['reserve']>(() => null)
    const unsubscribe = vi.fn()
    let available!: () => void
    const consumed = vi.fn()
    const pending = deferred<Awaited<ReturnType<typeof customHtmlMocks.translateMessageCommand>>>()
    customHtmlMocks.translateMessageCommand.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(
      1,
      'char',
      {
        autoTranslateOnReady: true,
        onAutoTranslationEligibilityConsumed: consumed,
      },
      0,
      {
        reserve,
        subscribeAvailable: (listener) => {
          available = listener
          return unsubscribe
        },
      },
    )
    await settle()
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    expect(customHtmlMocks.alertNormal).not.toHaveBeenCalled()

    reserve.mockReturnValue(release)
    available()
    await settle()
    expect(consumed).toHaveBeenCalledOnce()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    const request = customHtmlMocks.translateMessageCommand.mock.calls[0][0]
    pending.resolve({
      status: 'ok',
      revision: 2,
      event: { type: 'message.updated', revision: 2, resource: 'message', id: 'message-0' },
      chatId: 'custom-html-chat',
      messageId: 'message-0',
      jobId: request.jobId,
      translation: {
        source: 'raw',
        text: 'completed automatic translation',
        sourceHash: 'a'.repeat(64),
        targetLanguage: 'ko',
        inputLanguage: 'en',
        translatorType: 'google',
        settingsHash: 'b'.repeat(64),
        updatedAt: 123,
      },
    })
    await settle()
    expect(release).toHaveBeenCalledOnce()
    expect(target.textContent).toContain('completed automatic translation')
    available()
    await settle()
    expect(consumed).toHaveBeenCalledOnce()
    for (const mounted of components) unmount(mounted)
    components = []
    await settle()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('stable message editor identity', () => {
  it('keeps the inline draft and saves to the same message after an earlier row is deleted', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(3, null as unknown as string)
    mountStableMessageRow('message-1')
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
    expect(editor).not.toBeNull()
    editor.value = 'kept inline draft'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    testDatabaseState.db.characters[0].chats[0].message.splice(0, 1)
    await settle()
    expect(target.querySelector('.message-edit-area')).toBe(editor)
    expect(editor.value).toBe('kept inline draft')
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-1',
      { data: 'kept inline draft' },
      expect.anything(),
    )
    expect(testDatabaseState.db.characters[0].chats[0].message[1].data).toBe('visible message 2')
  })

  it('keeps the popup draft after an earlier row is deleted', async () => {
    const pendingEditorWait = deferred<void>()
    customHtmlMocks.sleep.mockReturnValueOnce(pendingEditorWait.promise)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(3, null as unknown as string)
    testDatabaseState.db.disableAutoPopupMessageEditor = false
    mountStableMessageRow('message-1')
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.value = 'kept popup draft'
    testDatabaseState.db.characters[0].chats[0].message.splice(0, 1)
    await settle()
    expect(popUpEditorStore.open).toBe(true)
    popUpEditorStore.open = false
    pendingEditorWait.resolve()
    await settle()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-1',
      { data: 'kept popup draft' },
      expect.anything(),
    )
  })

  it('does not overwrite a changed source after relocation', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(3, null as unknown as string)
    mountStableMessageRow('message-1')
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
    editor.value = 'stale draft'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.message.splice(0, 1)
    chat.message[0].data = 'newer authoritative text'
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    expect(chat.message[0].data).toBe('newer authoritative text')
    expect(chat.message[1].data).toBe('visible message 2')
  })
})

describe('message popup editor target freshness', () => {
  it('does not write a delayed edit into the newly active chat', async () => {
    const pendingEditorWait = deferred<void>()
    customHtmlMocks.sleep.mockReturnValueOnce(pendingEditorWait.promise)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.disableAutoPopupMessageEditor = false
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()

    expect(popUpEditorStore.open).toBe(true)
    expect(popUpEditorStore.value).toBe('visible message 0')

    popUpEditorStore.value = 'stale edit from original chat'
    testDatabaseState.db.characters[0].chatPage = 1
    popUpEditorStore.open = false
    pendingEditorWait.resolve()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(testDatabaseState.db.characters[0].chats[1].message[0].data).toBe('other chat message')
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })
})

describe('message action target freshness', () => {
  it('settles rich copy and replaces the blocking alert when copied images cannot decode', async () => {
    const clipboard = {
      write: vi.fn(async () => undefined),
      writeText: vi.fn(async () => undefined),
    }
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    })
    const imageDecodeErrors = vi.fn()

    class BrokenImage {
      crossOrigin = ''
      height = 0
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      width = 0

      set src(_value: string) {
        imageDecodeErrors()
        this.onerror?.()
      }
    }

    class DataUrlFileReader {
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      result: string | null = null

      readAsDataURL() {
        this.result = 'data:image/png;base64,Y29ycnVwdA=='
        this.onload?.()
      }
    }

    vi.stubGlobal('ClipboardItem', class ClipboardItem {})
    vi.stubGlobal('FileReader', DataUrlFileReader)
    vi.stubGlobal('Image', BrokenImage)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(['corrupt image bytes'], { type: 'image/png' }),
        ok: true,
      })),
    )

    try {
      seedDatabase(1, null as unknown as string)
      testDatabaseState.db.useChatCopy = true
      testDatabaseState.db.characters[0].image = 'corrupt-avatar'
      customHtmlMocks.getFileSrc.mockResolvedValue('https://example.test/corrupt-avatar.png')
      customHtmlMocks.ParseMarkdown.mockResolvedValueOnce('<img src="https://example.test/corrupt.png">')
      mountCustomHtmlRows(1)
      await settle()

      target.querySelector<HTMLButtonElement>('.button-icon-copy')?.click()

      await vi.waitFor(() => expect(customHtmlMocks.alertNormal).toHaveBeenCalledWith('copied'))
      expect(customHtmlMocks.alertWait).toHaveBeenCalledWith('loading')
      expect(imageDecodeErrors).toHaveBeenCalledTimes(2)
      expect(clipboard.write).toHaveBeenCalledOnce()
      expect(clipboard.writeText).not.toHaveBeenCalled()
      expect(customHtmlMocks.alertWait.mock.invocationCallOrder[0]).toBeLessThan(
        customHtmlMocks.alertNormal.mock.invocationCallOrder[0],
      )
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(window.navigator, 'clipboard')
      }
    }
  })

  it('clears rich-copy loading and runs the plain-text fallback only once', async () => {
    const clipboard = {
      write: vi.fn(async () => {
        throw new Error('rich clipboard unavailable')
      }),
      writeText: vi.fn(async () => undefined),
    }
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    })
    vi.stubGlobal('ClipboardItem', class ClipboardItem {})

    try {
      seedDatabase(1, null as unknown as string)
      testDatabaseState.db.useChatCopy = true
      mountCustomHtmlRows(1)
      await settle()

      target.querySelector<HTMLButtonElement>('.button-icon-copy')?.click()

      await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledOnce())
      expect(customHtmlMocks.alertWait).toHaveBeenCalledWith('loading')
      expect(customHtmlMocks.alertClear).toHaveBeenCalledOnce()
      expect(clipboard.write).toHaveBeenCalledOnce()
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(window.navigator, 'clipboard')
      }
    }
  })

  it('does not expose transcript-only actions for the synthetic greeting', async () => {
    seedDatabase(0, null as unknown as string)
    testDatabaseState.db.enableBookmark = true
    testDatabaseState.db.useChatCopy = true
    SizeStore.set({ w: 320, h: 700 })
    mountPopupList()
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'Character greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          img: '',
          rerollIcon: false,
          disabled: false,
        },
      }) as MountedComponent,
    )
    await settle()

    await openMessageActions()

    expect(buttonByText('copy')).toBeTruthy()
    expect(buttonByText('bookmark')).toBeUndefined()
    expect(buttonByText('branch')).toBeUndefined()
    expect(buttonByText('disableMessage')).toBeUndefined()
    expect(buttonByText('disableAbove')).toBeUndefined()
  })

  it('paints a bookmark before the server command completes', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.alertInput.mockResolvedValueOnce('Pinned now')
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.enableBookmark = true
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    const bookmarkButton = target.querySelector<HTMLButtonElement>('.button-icon-bookmark')
    bookmarkButton?.click()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].bookmarks).toEqual(['message-0'])
    expect(testDatabaseState.db.characters[0].chats[0].bookmarkNames).toEqual({
      'message-0': 'Pinned now',
    })
    popupStore.openId = 0
    await openMessageActions()
    expect(target.querySelector('.button-icon-bookmark')?.classList.contains('text-yellow-400')).toBe(true)
    expect(dispatchUpdateChatScopedWithOutcome).toHaveBeenCalled()
  })

  it('bookmarks the clicked message when the active chat switches before the prompt resolves', async () => {
    const pendingName = deferred<string>()
    customHtmlMocks.alertInput.mockReturnValueOnce(pendingName.promise)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.enableBookmark = true
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    target.querySelector<HTMLButtonElement>('.button-icon-bookmark')?.click()
    testDatabaseState.db.characters[0].chatPage = 1
    pendingName.resolve('Pinned original')
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].bookmarks).toEqual(['message-0'])
    expect(testDatabaseState.db.characters[0].chats[0].bookmarkNames).toEqual({
      'message-0': 'Pinned original',
    })
    expect(testDatabaseState.db.characters[0].chats[1].bookmarks).toEqual([])
    expect(dispatchUpdateChatScopedWithOutcome).toHaveBeenCalledWith(
      'custom-html-chat',
      expect.objectContaining({
        bookmarks: ['message-0'],
        bookmarkNames: {
          'message-0': 'Pinned original',
        },
      }),
      expect.anything(),
      customHtmlMocks.restoreChatRowMetadata,
    )
  })

  it('selects a new branch and navigates to its canonical route', async () => {
    seedDatabase(1, null as unknown as string)
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('branch')?.click()
    await settle()

    const character = testDatabaseState.db.characters[0]
    const branchedChat = character.chats.find((chat) =>
      chat.message.some((message) => message.data.includes('{{specialcomment::branchedfrom::')),
    )
    expect(branchedChat?.id).toBeTruthy()
    expect(customHtmlMocks.changeChatTo).toHaveBeenCalledWith(0)
    expect(character.chats[character.chatPage].id).toBe(branchedChat?.id)
    expect(customHtmlMocks.navigate).toHaveBeenCalledWith(`/character/custom-html-character/${branchedChat?.id}`)
  })

  it.each([false, true])(
    'captures branch intent before changing source folder or membership (existing folder: %s)',
    async (hasExistingFolder) => {
      seedDatabase(1, null as unknown as string)
      testDatabaseState.db.createFolderOnBranch = true
      const character = testDatabaseState.db.characters[0]
      const sourceChat = character.chats[0]
      const sourceMessage = sourceChat.message[0]
      const originalChatIds = character.chats.map((chat) => chat.id)
      character.chatFolders = hasExistingFolder
        ? [{ id: 'branches-folder', name: `Branches of ${sourceChat.name}`, folded: true }]
        : []
      if (hasExistingFolder) sourceChat.folderId = 'branches-folder'
      const snapshot = { kind: 'chat-fork' }
      customHtmlMocks.captureChatForkSnapshot.mockImplementationOnce((sourceChatId, input) => {
        expect(sourceChatId).toBe(sourceChat.id)
        expect(character.chats.map((chat) => chat.id)).toEqual(originalChatIds)
        expect(character.chatFolders).toHaveLength(hasExistingFolder ? 1 : 0)
        expect(sourceChat.folderId).toBe(hasExistingFolder ? 'branches-folder' : undefined)
        expect(sourceChat.message[0]).toBe(sourceMessage)
        expect(input.chat.folderId).toBe(input.folder.id)
        expect(input.sourcePatch).toEqual({ folderId: input.folder.id })
        expect(input.chat.message.at(-1)?.data).toContain('{{specialcomment::branchedfrom::')
        return snapshot
      })
      mountPopupList()
      mountCustomHtmlRows(1)
      await settle()

      await openMessageActions()
      buttonByText('branch')?.click()
      await settle()

      expect(captureChatForkSnapshot).toHaveBeenCalledOnce()
      const forkInput = vi.mocked(captureChatForkSnapshot).mock.calls[0]?.[1]
      expect(dispatchForkChatWithOutcome).toHaveBeenCalledWith(sourceChat.id, snapshot, forkInput)
      expect(character.chatFolders).toHaveLength(1)
      expect(sourceChat.folderId).toBe(forkInput?.folder?.id)
      expect(character.chats[0].folderId).toBe(forkInput?.folder?.id)
      expect(sourceChat.message[0]).toBe(sourceMessage)
      expect(currentChatStateSnapshot).not.toHaveBeenCalled()
    },
  )

  it('leaves the source unchanged when branch intent cannot resolve its owner', async () => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.createFolderOnBranch = true
    const character = testDatabaseState.db.characters[0]
    const sourceChat = character.chats[0]
    const originalChatIds = character.chats.map((chat) => chat.id)
    customHtmlMocks.captureChatForkSnapshot.mockReturnValueOnce(null)
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('branch')?.click()
    await settle()

    expect(character.chats.map((chat) => chat.id)).toEqual(originalChatIds)
    expect(sourceChat.folderId).toBeUndefined()
    expect(character.chatFolders).toBeUndefined()
    expect(dispatchForkChatWithOutcome).not.toHaveBeenCalled()
    expect(customHtmlMocks.navigate).not.toHaveBeenCalled()
    expect(customHtmlMocks.alertError).toHaveBeenCalled()
  })

  it('recovers the source route when a queued branch finally fails and rolls back', async () => {
    const finalSettlement = deferred<ChatMutationFinalOutcome>()
    seedDatabase(1, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    window.history.replaceState(null, '', '/character/custom-html-character/custom-html-chat')
    customHtmlMocks.navigate.mockImplementation((path: string, options?: { replace?: boolean }) => {
      window.history[options?.replace ? 'replaceState' : 'pushState'](null, '', path)
    })
    vi.mocked(dispatchForkChatWithOutcome).mockImplementationOnce((_sourceChatId, _previous, input) => {
      const character = testDatabaseState.db.characters[0]
      const provisionalChat = JSON.parse(JSON.stringify(input.chat)) as (typeof character.chats)[number]
      withTestDatabaseWrite(() => {
        character.chats.unshift(provisionalChat)
        character.chatPage = 0
      })
      const settlement = finalSettlement.promise.then((outcome) => {
        if (outcome.status === 'failed') {
          withTestDatabaseWrite(() => {
            character.chats = character.chats.filter((chat) => chat.id !== provisionalChat.id)
            character.chatPage = character.chats.findIndex((chat) => chat.id === 'custom-html-chat')
          })
        }
        return outcome
      })
      return Promise.resolve({
        status: 'queued',
        result: { status: 'unavailable' },
        mutationIds: ['queued-branch'],
        settlement,
      } satisfies ChatMutationOutcome)
    })
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('branch')?.click()
    await settle()

    const forkPayload = vi.mocked(dispatchForkChatWithOutcome).mock.calls.at(-1)?.[2]
    const provisionalChatId = forkPayload?.chat.id
    expect(provisionalChatId).toBeTruthy()
    expect(testDatabaseState.db.characters[0].chats[0].id).toBe(provisionalChatId)
    expect(window.location.pathname).toBe(`/character/custom-html-character/${provisionalChatId}`)

    finalSettlement.resolve({ status: 'failed', result: { status: 'error', error: 'fork rejected' } })
    await settle()

    const character = testDatabaseState.db.characters[0]
    expect(character.chats.some((chat) => chat.id === provisionalChatId)).toBe(false)
    expect(character.chats[character.chatPage].id).toBe('custom-html-chat')
    expect(window.location.pathname).toBe('/character/custom-html-character/custom-html-chat')
    expect(customHtmlMocks.navigate).toHaveBeenLastCalledWith('/character/custom-html-character/custom-html-chat', {
      replace: true,
    })
  })

  it('does not branch when the confirmation is declined', async () => {
    seedDatabase(1, null as unknown as string)
    customHtmlMocks.alertConfirm.mockResolvedValueOnce(false)
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('branch')?.click()
    await settle()

    expect(customHtmlMocks.alertConfirm).toHaveBeenCalled()
    const character = testDatabaseState.db.characters[0]
    const branchedChat = character.chats.find((chat) =>
      chat.message.some((message) => message.data.includes('{{specialcomment::branchedfrom::')),
    )
    expect(branchedChat).toBeUndefined()
    expect(dispatchForkChatWithOutcome).not.toHaveBeenCalled()
    expect(customHtmlMocks.changeChatTo).not.toHaveBeenCalled()
    expect(customHtmlMocks.navigate).not.toHaveBeenCalled()
  })

  it('hydrates unloaded history before dispatching a server-backed branch', async () => {
    seedDatabase(3, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.message = [
      { role: 'char', data: '', isComment: true, disabled: true, __risuServerUnloadedMessage: true },
      { role: 'char', data: '', isComment: true, disabled: true, __risuServerUnloadedMessage: true },
      { chatId: 'message-2', data: 'visible message 2', role: 'char' },
    ] as typeof chat.message
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      chat.message = [
        { chatId: 'message-0', data: 'loaded message 0', role: 'user' },
        { chatId: 'message-1', data: 'loaded message 1', role: 'char' },
        { chatId: 'message-2', data: 'visible message 2', role: 'char' },
      ]
    })
    mountPopupList()
    mountCustomHtmlRows(1, 'char', {}, 2)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-menu')?.click()
    await settle()
    buttonByText('branch')?.click()
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledWith('custom-html-chat', { strict: true })
    const forkPayload = vi.mocked(dispatchForkChatWithOutcome).mock.calls.at(-1)?.[2] as
      | Parameters<typeof dispatchForkChatWithOutcome>[2]
      | undefined
    expect(forkPayload?.chat.message.slice(0, 3).map((item) => item.data)).toEqual([
      'loaded message 0',
      'loaded message 1',
      'visible message 2',
    ])
    expect(
      forkPayload?.chat.message.some(
        (item) => (item as unknown as Record<string, unknown>).__risuServerUnloadedMessage === true,
      ),
    ).toBe(false)
  })

  it('hydrates an unloaded predecessor before truncating at the visible boundary', async () => {
    seedDatabase(3, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    const chat = testDatabaseState.db.characters[0].chats[0]
    chat.message = [
      { role: 'char', data: '', isComment: true, disabled: true, __risuServerUnloadedMessage: true },
      { role: 'char', data: '', isComment: true, disabled: true, __risuServerUnloadedMessage: true },
      { chatId: 'message-2', data: 'visible message 2', role: 'char' },
    ] as typeof chat.message
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      chat.message = [
        { chatId: 'message-0', data: 'loaded message 0', role: 'user' },
        { chatId: 'message-1', data: 'loaded message 1', role: 'char' },
        { chatId: 'message-2', data: 'visible message 2', role: 'char' },
      ]
    })
    mountPopupList()
    mountCustomHtmlRows(1, 'char', {}, 2)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-menu')?.click()
    await settle()
    const removeButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    expect(removeButton).toBeTruthy()
    removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledWith('custom-html-chat', { strict: true })
    expect(dispatchTruncateMessagesScoped).toHaveBeenCalledWith('custom-html-chat', 'message-1', expect.anything())
    expect(dispatchReplaceMessagesScoped).not.toHaveBeenCalled()
  })

  it('selects a legacy branch source whose name contains delimiters and navigates to its canonical route', async () => {
    seedDatabase(1, null as unknown as string)
    const marker = '{{specialcomment::branchedfrom::custom-html-chat::Custom::HTML Chat::message-0::}}'
    const character = testDatabaseState.db.characters[0]
    character.chatPage = 1
    character.chats[1].message[0].data = marker

    mountCustomHtmlRows(1, 'char', { message: marker, isComment: true })
    await settle()

    buttonByText('branchedText')?.click()
    await settle()

    expect(customHtmlMocks.changeChatTo).toHaveBeenCalledWith('custom-html-chat')
    expect(character.chats[character.chatPage].id).toBe('custom-html-chat')
    expect(customHtmlMocks.foldChatToMessage).toHaveBeenCalledWith('message-0')
    expect(customHtmlMocks.navigate).toHaveBeenCalledWith('/character/custom-html-character/custom-html-chat')
  })

  it('hydrates a nonresident branch source before folding to its origin message', async () => {
    seedDatabase(1, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    const marker = '{{specialcomment::branchedfrom::custom-html-chat::Custom HTML Chat::message-0::}}'
    const character = testDatabaseState.db.characters[0]
    const sourceChat = character.chats[0]
    sourceChat.message = [
      { role: 'char', data: '', isComment: true, disabled: true, __risuServerUnloadedMessage: true },
      { chatId: 'message-tail', data: 'resident tail', role: 'char' },
    ] as typeof sourceChat.message
    character.chatPage = 1
    character.chats[1].message[0].data = marker
    const hydration = deferred<void>()
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      await hydration.promise
      sourceChat.message = [
        { chatId: 'message-0', data: 'loaded branch origin', role: 'user' },
        { chatId: 'message-tail', data: 'resident tail', role: 'char' },
      ]
    })

    mountCustomHtmlRows(1, 'char', { message: marker, isComment: true })
    await settle()

    buttonByText('branchedText')?.click()
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledWith('custom-html-chat', { strict: true })
    expect(customHtmlMocks.changeChatTo).not.toHaveBeenCalled()
    expect(customHtmlMocks.foldChatToMessage).not.toHaveBeenCalled()

    hydration.resolve()
    await settle()

    expect(customHtmlMocks.changeChatTo).toHaveBeenCalledWith('custom-html-chat')
    expect(customHtmlMocks.foldChatToMessage).toHaveBeenCalledWith('message-0')
    expect(customHtmlMocks.navigate).toHaveBeenCalledWith('/character/custom-html-character/custom-html-chat')
  })

  it('branches from the clicked chat when the active chat switches immediately after the click', async () => {
    seedDatabase(1, null as unknown as string)
    const sourceChat = testDatabaseState.db.characters[0].chats[0]
    sourceChat.message[0].generationInfo = { generationId: 'message-0' }
    sourceChat.bookmarks = ['message-0', 'removed-tail']
    sourceChat.bookmarkNames = { 'message-0': 'Opening', 'removed-tail': 'Removed' }
    sourceChat.hypaV3Data = {
      summaries: [{ chatMemos: ['message-0', 'removed-tail'] }],
    } as (typeof sourceChat)['hypaV3Data']
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('branch')?.click()
    const otherChatIndex = testDatabaseState.db.characters[0].chats.findIndex(
      (chat) => chat.id === 'custom-html-other-chat',
    )
    testDatabaseState.db.characters[0].chatPage = otherChatIndex
    await settle()

    const branchedChat = testDatabaseState.db.characters[0].chats.find((chat) =>
      chat.message.some((message) => message.data.includes('{{specialcomment::branchedfrom::')),
    )
    expect(branchedChat?.name).toBe('Custom HTML Chat Branch')
    expect(branchedChat?.message[0].chatId).toBeTruthy()
    expect(branchedChat?.message[0].chatId).not.toBe('message-0')
    expect(branchedChat?.message.at(-1)?.data).toMatch(/^\{\{specialcomment::branchedfrom::json-v1::/)
    expect(parseBranchComment(branchedChat?.message.at(-1)?.data ?? '')).toEqual({
      sourceChatId: 'custom-html-chat',
      sourceChatName: 'Custom HTML Chat',
      sourceMessageId: 'message-0',
    })
    expect(
      testDatabaseState.db.characters[0].chats.find((chat) => chat.id === 'custom-html-other-chat')?.message[0],
    ).toEqual({
      chatId: 'other-message-0',
      data: 'other chat message',
      role: 'char',
    })
    expect(dispatchForkChatWithOutcome).toHaveBeenCalledWith(
      'custom-html-chat',
      expect.anything(),
      expect.objectContaining({
        chat: expect.objectContaining({
          name: 'Custom HTML Chat Branch',
        }),
      }),
    )
    const forkPayload = vi.mocked(dispatchForkChatWithOutcome).mock.calls.at(-1)?.[2] as
      | {
          chat: {
            message: Array<{ chatId?: string; data: string; generationInfo?: { generationId?: string } }>
            bookmarks?: string[]
            bookmarkNames?: Record<string, string>
            hypaV3Data?: { summaries?: Array<{ chatMemos?: string[] }> }
          }
        }
      | undefined
    const forkedMessageIds = forkPayload?.chat.message.map((message) => message.chatId)
    expect(forkedMessageIds?.[0]).toBeTruthy()
    expect(forkedMessageIds).not.toContain('message-0')
    expect(new Set(forkedMessageIds).size).toBe(forkedMessageIds?.length)
    expect(forkPayload?.chat.bookmarks).toEqual([forkedMessageIds?.[0]])
    expect(forkPayload?.chat.bookmarkNames).toEqual({ [forkedMessageIds?.[0] ?? '']: 'Opening' })
    expect(forkPayload?.chat.message[0].generationInfo?.generationId).toBe(forkedMessageIds?.[0])
    expect(forkPayload?.chat.hypaV3Data?.summaries?.[0]?.chatMemos).toEqual([forkedMessageIds?.[0]])
    expect(sourceChat.bookmarks).toEqual(['message-0', 'removed-tail'])
    expect(parseBranchComment(forkPayload?.chat.message.at(-1)?.data ?? '')).toEqual({
      sourceChatId: 'custom-html-chat',
      sourceChatName: 'Custom HTML Chat',
      sourceMessageId: 'message-0',
    })
  })

  it('disables the clicked message when the active chat switches immediately after the click', async () => {
    seedDatabase(1, null as unknown as string)
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('disableMessage')?.click()
    testDatabaseState.db.characters[0].chatPage = 1
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].disabled).toBe(true)
    expect(testDatabaseState.db.characters[0].chats[1].message[0].disabled).toBeUndefined()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-0',
      {
        disabled: true,
      },
      expect.anything(),
    )
  })

  it('disables messages above the clicked message when the active chat switches immediately after the click', async () => {
    seedDatabase(1, null as unknown as string)
    mountPopupList()
    mountCustomHtmlRows(1)
    await settle()

    await openMessageActions()
    buttonByText('disableAbove')?.click()
    testDatabaseState.db.characters[0].chatPage = 1
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].disabled).toBe('allBefore')
    expect(testDatabaseState.db.characters[0].chats[1].message[0].disabled).toBeUndefined()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-0',
      {
        disabled: 'allBefore',
      },
      expect.anything(),
    )
  })
})

describe('server raw translation controls', () => {
  it('requires confirmation before replacing an existing message translation', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].message[0].translation = {
      source: 'raw',
      text: 'existing translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('existing translation')

    customHtmlMocks.alertConfirm.mockResolvedValueOnce(false)
    buttonByText('retranslate')?.click()
    await settle()

    expect(customHtmlMocks.alertConfirm).toHaveBeenCalledWith('retranslateConfirm')
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation?.text).toBe('existing translation')

    customHtmlMocks.alertConfirm.mockResolvedValueOnce(true)
    buttonByText('retranslate')?.click()
    await settle()

    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation?.text).toBe('translated raw')
  })

  it('auto-displays a stored translation once without overriding a manual return to the original', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.autoTranslate = true
    chat.message[0].translation = {
      source: 'raw',
      text: 'stored automatic translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    mountCustomHtmlRows(1)
    await settle()

    expect(target.textContent).toContain('stored automatic translation')
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('stored automatic translation')
  })

  it('auto-displays an existing user translation in bot-only mode without requesting a new translation', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.autoTranslate = true
    chat.autoTranslateBotOnly = true
    chat.message[0].translation = {
      source: 'raw',
      text: 'manual user translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    mountCustomHtmlRows(1, 'user', { autoTranslateOnReady: true })
    await settle()

    expect(target.textContent).toContain('manual user translation')
    expect(target.textContent).not.toContain('visible message 0')
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('manual user translation')
  })

  it('consumes one-shot append eligibility only after streaming finishes and attempts translation once', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.autoTranslate = true
    chat.isStreaming = true
    const consumed = vi.fn()
    mountCustomHtmlRows(1, 'char', {
      autoTranslateOnReady: true,
      onAutoTranslationEligibilityConsumed: consumed,
    })
    await settle()
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()

    chat.isStreaming = false
    await settle()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
    expect(consumed).toHaveBeenCalledOnce()
    expect(target.textContent).toContain('translated raw')

    await settle()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
  })

  it('does not auto-request uncached LLM translations in cached-only mode', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.autoTranslateCachedOnly = true
    chat.autoTranslate = true
    const consumed = vi.fn()
    mountCustomHtmlRows(1, 'char', {
      autoTranslateOnReady: true,
      onAutoTranslationEligibilityConsumed: consumed,
    })
    await settle()

    expect(consumed).toHaveBeenCalledOnce()
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
    expect(target.textContent).toContain('visible message 0')
  })

  it('surfaces one failed automatic attempt and leaves the message original without retrying', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.translateMessageCommand.mockResolvedValueOnce({
      status: 'error',
      error: 'automatic provider failure',
    } as never)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.autoTranslate = true
    mountCustomHtmlRows(1, 'char', { autoTranslateOnReady: true })
    await settle()

    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
    expect(target.textContent).toContain('automatic provider failure')
    expect(target.textContent).toContain('visible message 0')
    await settle()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
  })

  it('uses the bilingual display composite without changing the stored raw translation', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.bilingualDisplay = true
    chat.message[0].translation = {
      source: 'raw',
      text: '번역된 메시지',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    mountCustomHtmlRows(1)
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()

    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).toContain('번역된 메시지')
    expect(target.textContent).toContain('x-risu-bilingual-translation')
    expect(chat.message[0].translation?.text).toBe('번역된 메시지')
  })

  it('translates the synthetic greeting through the server command without exposing the pencil editor', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'primary greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          img: '',
          rerollIcon: false,
          disabled: false,
          greetingTarget: {
            characterId: 'custom-html-character',
            chatId: 'custom-html-chat',
            greetingIndex: -1,
            source: 'primary greeting',
            clientSettingsSignature: 'client-settings',
          },
        },
      }) as MountedComponent,
    )
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()

    expect(customHtmlMocks.translateGreetingCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRevision: 1,
        characterId: 'custom-html-character',
        greetingIndex: -1,
        jobId: expect.any(String),
      }),
    )
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
    expect(target.textContent).toContain('translated greeting')
    expect(target.querySelector('.button-icon-translate')?.getAttribute('aria-label')).toBe('translate')
    expect(buttonByText('editTranslation')).toBeUndefined()

    buttonByText('retranslate')?.click()
    await settle()
    expect(customHtmlMocks.translateGreetingCommand).toHaveBeenCalledTimes(2)
    expect(customHtmlMocks.translateGreetingCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ characterId: 'custom-html-character', greetingIndex: -1 }),
    )
  })

  it('reuses a persisted greeting after remount and renders it through the bilingual display path', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].bilingualDisplay = true
    greetingProjectionMocks.translation = {
      source: 'raw',
      text: 'persisted greeting translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'greeting-settings',
      updatedAt: 123,
    }
    const props = {
      message: 'primary greeting',
      name: 'Template Bot',
      isLastMemory: false,
      idx: -1,
      role: 'char' as const,
      totalLength: 0,
      firstMessage: true,
      greetingTarget: {
        characterId: 'custom-html-character',
        chatId: 'custom-html-chat',
        greetingIndex: -1,
        source: 'primary greeting',
        clientSettingsSignature: 'client-settings',
      },
    }

    const firstMount = mount(Chat, { target, props }) as MountedComponent
    await settle()
    expect(target.textContent).toContain('primary greeting')
    expect(target.textContent).not.toContain('persisted greeting translation')
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('primary greeting')
    expect(target.textContent).toContain('persisted greeting translation')
    expect(target.textContent).toContain('x-risu-bilingual-translation')
    expect(customHtmlMocks.translateGreetingCommand).not.toHaveBeenCalled()

    await unmount(firstMount)
    target.replaceChildren()
    components.push(mount(Chat, { target, props }) as MountedComponent)
    await settle()
    expect(target.textContent).not.toContain('persisted greeting translation')
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('persisted greeting translation')
    expect(customHtmlMocks.translateGreetingCommand).not.toHaveBeenCalled()
  })

  it('shows an eligible persisted greeting on open without starting automatic provider work', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].autoTranslate = true
    greetingProjectionMocks.translation = {
      source: 'raw',
      text: 'cached greeting translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'greeting-settings',
      updatedAt: 123,
    }
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'primary greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          greetingTarget: {
            characterId: 'custom-html-character',
            chatId: 'custom-html-chat',
            greetingIndex: -1,
            source: 'primary greeting',
            clientSettingsSignature: 'client-settings',
          },
        },
      }) as MountedComponent,
    )
    await settle()

    expect(target.textContent).toContain('cached greeting translation')
    expect(customHtmlMocks.translateGreetingCommand).not.toHaveBeenCalled()
  })

  it('keeps a replacement alternate greeting untouched when the captured primary request finishes', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    const provider = deferred<void>()
    customHtmlMocks.translateGreetingCommand.mockImplementationOnce(async (input) => {
      await provider.promise
      return {
        status: 'ok',
        revision: 2,
        event: {
          type: 'character.greetingTranslation.updated',
          revision: 2,
          resource: 'greetingTranslation',
          id: input.characterId,
        },
        characterId: input.characterId,
        chatId: input.chatId,
        greetingIndex: input.greetingIndex,
        jobId: input.jobId,
        settingsHash: 'greeting-settings',
        translation: {
          source: 'raw',
          text: 'late primary translation',
          sourceHash: 'a'.repeat(64),
          targetLanguage: 'ko',
          inputLanguage: 'en',
          translatorType: 'llm',
          settingsHash: 'greeting-settings',
          updatedAt: 123,
        },
      } as const
    })

    const firstMount = mount(Chat, {
      target,
      props: {
        message: 'primary greeting',
        name: 'Template Bot',
        isLastMemory: false,
        idx: -1,
        role: 'char',
        totalLength: 0,
        firstMessage: true,
        greetingTarget: {
          characterId: 'custom-html-character',
          chatId: 'custom-html-chat',
          greetingIndex: -1,
          source: 'primary greeting',
          clientSettingsSignature: 'client-settings',
        },
      },
    }) as MountedComponent
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(true)

    await unmount(firstMount)
    target.replaceChildren()
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'alternate greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          greetingTarget: {
            characterId: 'custom-html-character',
            chatId: 'custom-html-chat',
            greetingIndex: 0,
            source: 'alternate greeting',
            clientSettingsSignature: 'client-settings',
          },
        },
      }) as MountedComponent,
    )
    provider.resolve()
    await settle()

    expect(target.textContent).toContain('alternate greeting')
    expect(target.textContent).not.toContain('late primary translation')
    expect(customHtmlMocks.translateGreetingCommand).toHaveBeenCalledOnce()
  })

  it('restores the greeting source when the manual provider request fails', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.translateGreetingCommand.mockResolvedValueOnce({
      status: 'error',
      error: 'greeting provider failed',
    } as never)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'primary greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          greetingTarget: {
            characterId: 'custom-html-character',
            chatId: 'custom-html-chat',
            greetingIndex: -1,
            source: 'primary greeting',
            clientSettingsSignature: 'client-settings',
          },
        },
      }) as MountedComponent,
    )
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()

    expect(target.textContent).toContain('primary greeting')
    expect(target.textContent).toContain('greeting provider failed')
    expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(false)
  })

  it('keeps an untranslated greeting manual-only even when chat auto-translation is enabled', async () => {
    seedDatabase(0, null as unknown as string)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].autoTranslate = true
    components.push(
      mount(Chat, {
        target,
        props: {
          message: 'primary greeting',
          name: 'Template Bot',
          isLastMemory: false,
          idx: -1,
          role: 'char',
          totalLength: 0,
          firstMessage: true,
          autoTranslateOnReady: true,
          greetingTarget: {
            characterId: 'custom-html-character',
            chatId: 'custom-html-chat',
            greetingIndex: -1,
            source: 'primary greeting',
            clientSettingsSignature: 'client-settings',
          },
        },
      }) as MountedComponent,
    )
    await settle()

    expect(customHtmlMocks.translateGreetingCommand).not.toHaveBeenCalled()
    expect(target.textContent).toContain('primary greeting')
  })

  it('reactively pairs sentence chunks when sentence paragraph breaks are enabled', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    const chat = testDatabaseState.db.characters[0].chats[0]
    const original = '원문 하나. 원문 둘. 원문 셋. 원문 넷. 원문 다섯. 원문 여섯. 원문 일곱.'
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'google'
    chat.bilingualDisplay = true
    chat.message[0].translation = {
      source: 'raw',
      text: 'Translation one. Translation two. Translation three. Translation four. Translation five. Translation six. Translation seven.',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'en',
      inputLanguage: 'ko',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    mountCustomHtmlRows(1, 'char', { message: original })
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()

    const renderedPairCount = () => (target.textContent ?? '').split(BILINGUAL_PAIR_CLASS).length - 1
    expect(renderedPairCount()).toBe(1)

    withTestDatabaseWrite(() => {
      testDatabaseState.db.paragraphBreakBySentences = true
      testDatabaseState.db.paragraphBreakSentenceCount = 3
    })
    await settle()

    expect(renderedPairCount()).toBe(3)
  })

  it('clears a cached raw translation when the source message is edited', async () => {
    const translation = {
      source: 'raw' as const,
      text: 'obsolete translated text',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].message[0].translation = translation
    vi.mocked(dispatchUpdateMessageScoped).mockImplementationOnce(async (_messageId, patch) => {
      Object.assign(testDatabaseState.db.characters[0].chats[0].message[0], patch)
      return {
        status: 'accepted',
        result: {
          status: 'ok',
          revision: 2,
          event: { type: 'message.updated', revision: 2, resource: 'message', id: 'message-0' },
        },
      }
    })
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(target.textContent).toContain('obsolete translated text')

    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea?.value).toBe('visible message 0')
    textarea!.value = 'edited source text'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()

    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-0',
      { data: 'edited source text', translation: null },
      expect.anything(),
    )
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation).toBeNull()
    expect(target.textContent).toContain('edited source text')
    expect(target.textContent).not.toContain('obsolete translated text')

    customHtmlMocks.translateMessageCommand.mockClear()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
  })

  it('treats a reload as cancel for an unsaved inline message edit', async () => {
    seedDatabase(1, null as unknown as string)
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea?.value).toBe('visible message 0')
    textarea!.value = 'transient unsaved edit'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    for (const mounted of components) unmount(mounted)
    components = []
    target.replaceChildren()
    mountCustomHtmlRows(1)
    await settle()

    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('transient unsaved edit')
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
  })

  it('keeps translate pending state separate from completed translation UI', async () => {
    const translation = {
      source: 'raw',
      text: 'translated raw',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const pendingTranslation = deferred<{
      status: 'ok'
      revision: number
      event: {
        type: string
        revision: number
        resource: string
        id: string
      }
      chatId: string
      messageId: string
      jobId: string
      translation: typeof translation
    }>()
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.translateMessageCommand.mockReturnValue(pendingTranslation.promise)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    const onReroll = vi.fn()
    mountCustomHtmlRows(1, 'char', { rerollIcon: true, onReroll })
    await settle()

    let translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
    let editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
    let deleteButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    let rerollButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')
    expect(translateButton).not.toBeNull()
    translateButton?.click()
    await settle()

    translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
    editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
    deleteButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    rerollButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')
    const translationRequest = customHtmlMocks.translateMessageCommand.mock.calls[0][0]
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledWith({
      baseRevision: 1,
      messageId: 'message-0',
      jobId: expect.any(String),
    })
    expect(customHtmlMocks.runServerCommand).not.toHaveBeenCalled()
    expect(translateButton?.disabled).toBe(true)
    expect(translateButton?.getAttribute('aria-busy')).toBe('true')
    expect(editButton?.disabled).toBe(true)
    expect(deleteButton?.disabled).toBe(true)
    expect(rerollButton?.disabled).toBe(true)
    expect(translateButton?.className).not.toContain('text-blue-400')
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('translated raw')
    expect(target.textContent).not.toContain('retranslate')
    expect(target.textContent).not.toContain('editTranslation')

    pendingTranslation.resolve({
      status: 'ok',
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'message-0',
      },
      chatId: 'custom-html-chat',
      messageId: 'message-0',
      jobId: translationRequest.jobId,
      translation,
    })
    await settle()

    translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
    editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
    deleteButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    rerollButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')
    expect(translateButton?.disabled).toBe(false)
    expect(translateButton?.getAttribute('aria-busy')).toBe('false')
    expect(editButton?.disabled).toBe(false)
    expect(deleteButton?.disabled).toBe(false)
    expect(rerollButton?.disabled).toBe(false)
    expect(translateButton?.className).toContain('text-blue-400')
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation).toEqual(translation)
    expect(target.textContent).toContain('translated raw')
    expect(target.textContent).toContain('retranslate')
    expect(target.textContent).toContain('editTranslation')
  })

  it('applies delayed translate success to the captured message after the active chat switches', async () => {
    const translation = {
      source: 'raw' as const,
      text: 'translated original chat',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 321,
    }
    const pendingTranslation = deferred<{
      status: 'ok'
      revision: number
      event: {
        type: string
        revision: number
        resource: string
        id: string
      }
      chatId: string
      messageId: string
      jobId: string
      translation: typeof translation
    }>()
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    customHtmlMocks.translateMessageCommand.mockReturnValue(pendingTranslation.promise)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    const translationRequest = customHtmlMocks.translateMessageCommand.mock.calls[0][0]
    testDatabaseState.db.characters[0].chatPage = 1

    pendingTranslation.resolve({
      status: 'ok',
      revision: 2,
      event: {
        type: 'message.updated',
        revision: 2,
        resource: 'message',
        id: 'message-0',
      },
      chatId: 'custom-html-chat',
      messageId: 'message-0',
      jobId: translationRequest.jobId,
      translation,
    })
    await settle()

    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledWith({
      baseRevision: 1,
      messageId: 'message-0',
      jobId: expect.any(String),
    })
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation).toEqual(translation)
    expect(testDatabaseState.db.characters[0].chats[1].message[0].translation).toBeUndefined()
    expect(target.textContent).toContain('visible message 0')
    expect(target.textContent).not.toContain('translated original chat')
  })

  it('routes a failed translation edit through the durable captured-message dispatcher', async () => {
    const existingTranslation = {
      source: 'raw' as const,
      text: 'original raw translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const otherTranslation = {
      ...existingTranslation,
      text: 'other chat raw translation',
      updatedAt: 456,
    }
    const pendingUpdate = deferred<{
      status: 'failed'
      result: { status: 'error'; error: string }
    }>()
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].message[0].translation = existingTranslation
    testDatabaseState.db.characters[0].chats[1].message[0].translation = otherTranslation
    vi.mocked(dispatchUpdateMessageScoped).mockImplementationOnce(async (_messageId, _patch, previous) => {
      const result = await pendingUpdate.promise
      testDatabaseState.db.characters[0].chats[0].message[0].translation = previous.chat.message[0].translation
      return result
    })
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    buttonByText('editTranslation')?.click()
    await settle()

    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea?.value).toBe('original raw translation')
    textarea!.value = 'attempted raw translation'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    buttonByText('editTranslationSave')?.click()
    await settle()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith(
      'message-0',
      {
        translation: expect.objectContaining({
          text: 'attempted raw translation',
        }),
      },
      expect.objectContaining({
        characterId: 'custom-html-character',
        chatId: 'custom-html-chat',
        chat: expect.objectContaining({ id: 'custom-html-chat' }),
      }),
      { optimisticPatchAlreadyApplied: true },
    )
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation?.text).toBe('attempted raw translation')

    testDatabaseState.db.characters[0].chatPage = 1
    pendingUpdate.resolve({ status: 'failed', result: { status: 'error', error: 'update failed' } })
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation).toEqual(existingTranslation)
    expect(testDatabaseState.db.characters[0].chats[1].message[0].translation).toEqual(otherTranslation)
    expect(target.querySelector('.message-edit-area')).toBeNull()
  })

  it('does not let an older translation save reopen a newer completed edit', async () => {
    const existingTranslation = {
      source: 'raw' as const,
      text: 'original raw translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const firstSave = deferred<Awaited<NonNullable<ReturnType<typeof dispatchUpdateMessageScoped>>>>()
    const secondSave = deferred<Awaited<NonNullable<ReturnType<typeof dispatchUpdateMessageScoped>>>>()
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].message[0].translation = existingTranslation
    vi.mocked(dispatchUpdateMessageScoped)
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise)
    mountCustomHtmlRows(1)
    await settle()

    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    buttonByText('editTranslation')?.click()
    await settle()
    let textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    textarea!.value = 'translation A'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    buttonByText('editTranslationSave')?.click()
    await settle()

    buttonByText('editTranslation')?.click()
    await settle()
    textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    textarea!.value = 'translation B'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    buttonByText('editTranslationSave')?.click()
    await settle()

    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation?.text).toBe('translation B')
    expect(target.querySelector('.message-edit-area')).toBeNull()

    firstSave.resolve({
      status: 'accepted',
      result: {
        status: 'ok',
        revision: 1,
        event: { type: 'message.updated', revision: 1, resource: 'message', id: 'message-0' },
      },
    })
    await settle()
    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation?.text).toBe('translation B')

    secondSave.resolve({
      status: 'accepted',
      result: {
        status: 'ok',
        revision: 2,
        event: { type: 'message.updated', revision: 2, resource: 'message', id: 'message-0' },
      },
    })
    await settle()
    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(popUpEditorStore.open).toBe(false)
  })

  it('preserves server-active translation busy state across refresh and displays the completed translation', async () => {
    const translation = {
      source: 'raw' as const,
      text: 'translated after refresh',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 456,
    }
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    setActiveMessageTranslations([
      {
        chatId: 'custom-html-chat',
        messageId: 'message-0',
        jobId: 'translation-running',
        status: 'running',
      },
    ])
    mountCustomHtmlRows(1, 'char', { rerollIcon: true })
    await settle()

    let translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
    let editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
    let deleteButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    let rerollButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')
    expect(translateButton?.disabled).toBe(true)
    expect(translateButton?.getAttribute('aria-busy')).toBe('true')
    expect(editButton?.disabled).toBe(true)
    expect(deleteButton?.disabled).toBe(true)
    expect(rerollButton?.disabled).toBe(true)

    testDatabaseState.db.characters[0].chats[0].message[0].translation = translation
    setActiveMessageTranslations([])
    await settle()

    translateButton = target.querySelector<HTMLButtonElement>('.button-icon-translate')
    editButton = target.querySelector<HTMLButtonElement>('.button-icon-edit')
    deleteButton = target.querySelector<HTMLButtonElement>('.button-icon-remove')
    rerollButton = target.querySelector<HTMLButtonElement>('.button-icon-reroll')
    expect(translateButton?.disabled).toBe(false)
    expect(translateButton?.getAttribute('aria-busy')).toBe('false')
    expect(editButton?.disabled).toBe(false)
    expect(deleteButton?.disabled).toBe(false)
    expect(rerollButton?.disabled).toBe(false)
    expect(target.textContent).toContain('translated after refresh')
  })

  it('shows the retained failure when a detached translation finishes after refresh', async () => {
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    setActiveMessageTranslations([
      {
        chatId: 'custom-html-chat',
        messageId: 'message-0',
        jobId: 'translation-failed',
        status: 'failed',
        error: 'provider rejected the request',
        completedAt: 456,
      },
    ])

    mountCustomHtmlRows(1, 'char', { rerollIcon: true })
    await settle()

    expect(target.textContent).toContain('Translation failed: provider rejected the request')
    expect(target.querySelector<HTMLButtonElement>('.button-icon-translate')?.disabled).toBe(false)
    expect(get(activeMessageTranslations)).toEqual([])
  })

  it('force-rehydrates a retained successful translation after refresh', async () => {
    const translation = {
      source: 'raw' as const,
      text: 'translated after terminal reattach',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 789,
    }
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(async () => {
      testDatabaseState.db.characters[0].chats[0].message[0].translation = translation
    })
    setActiveMessageTranslations([
      {
        chatId: 'custom-html-chat',
        messageId: 'message-0',
        jobId: 'translation-succeeded',
        status: 'succeeded',
        completedAt: 789,
      },
    ])

    mountCustomHtmlRows(1, 'char', { rerollIcon: true })
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledWith('custom-html-chat', {
      force: true,
      strict: true,
    })
    expect(target.textContent).toContain('translated after terminal reattach')
    expect(get(activeMessageTranslations)).toEqual([])
  })

  it('retries a stale successful-translation hydration before clearing the job', async () => {
    const firstHydration = deferred<void>()
    const translation = {
      source: 'raw' as const,
      text: 'translated after hydration retry',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 790,
    }
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    customHtmlMocks.hydrateChatMessages
      .mockImplementationOnce(() => firstHydration.promise)
      .mockImplementationOnce(async () => {
        testDatabaseState.db.characters[0].chats[0].message[0].translation = translation
      })
    setActiveMessageTranslations([
      {
        chatId: 'custom-html-chat',
        messageId: 'message-0',
        jobId: 'translation-retry',
        status: 'succeeded',
        completedAt: 790,
      },
    ])

    mountCustomHtmlRows(1, 'char', { rerollIcon: true })
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledTimes(1)
    expect(get(activeMessageTranslations)).toEqual([
      expect.objectContaining({ jobId: 'translation-retry', status: 'succeeded' }),
    ])

    firstHydration.reject(new Error('Chat hydration incomplete for: custom-html-chat'))
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledTimes(2)
    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenNthCalledWith(2, 'custom-html-chat', {
      force: true,
      strict: true,
    })
    expect(target.textContent).toContain('translated after hydration retry')
    expect(target.textContent).not.toContain('Translation failed:')
    expect(get(activeMessageTranslations)).toEqual([])
  })

  it('does not clear a successful translation job after its row loses ownership', async () => {
    const hydration = deferred<void>()
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    customHtmlMocks.hydrateChatMessages.mockImplementationOnce(() => hydration.promise)
    setActiveMessageTranslations([
      {
        chatId: 'custom-html-chat',
        messageId: 'message-0',
        jobId: 'translation-old-chat',
        status: 'succeeded',
        completedAt: 791,
      },
    ])

    mountCustomHtmlRows(1, 'char', { rerollIcon: true })
    await settle()
    testDatabaseState.db.characters[0].chatPage = 1
    await settle()
    hydration.resolve()
    await settle()

    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledTimes(1)
    expect(get(activeMessageTranslations)).toEqual([
      expect.objectContaining({ jobId: 'translation-old-chat', status: 'succeeded' }),
    ])
    expect(target.textContent).not.toContain('Translation failed:')
  })
})

describe('connected reader message authority', () => {
  it('renders two local chat scopes with equal message IDs without borrowing canonical translation or request metadata', async () => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'configured'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.requestInfoInsideChat = true
    const character = testDatabaseState.db.characters[0]
    const first = character.chats[0]
    const second = character.chats[1]
    first.autoTranslate = true
    second.autoTranslate = true
    first.message[0].translation = {
      source: 'raw',
      text: 'first scoped translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 1,
    }
    second.message[0].chatId = first.message[0].chatId
    second.message[0].translation = { ...first.message[0].translation, text: 'second scoped translation' }
    first.message[0].generationInfo = { model: 'gpt35', generationId: 'first-generation' }
    second.message[0].generationInfo = { model: 'gpt35', generationId: 'second-generation' }
    setActiveMessageTranslations([
      { chatId: first.id!, messageId: first.message[0].chatId!, jobId: 'first-reader-job', status: 'succeeded' },
      { chatId: second.id!, messageId: second.message[0].chatId!, jobId: 'second-reader-job', status: 'succeeded' },
    ])
    const hosts = [first, second].map((chat) => {
      const host = document.createElement('section')
      target.appendChild(host)
      const owners = createChatReadOwners(
        charactersResourceState,
        (chatId) => getChatMessageOwnerState(chatId)?.messages,
        () => ({ characterId: character.chaId, chatId: chat.id }),
      )
      components.push(
        mount(Chat, {
          target: host,
          context: new Map([[CHAT_READ_OWNERS_CONTEXT, owners]]),
          props: {
            message: chat.message[0].data,
            name: 'Scoped reader',
            isLastMemory: false,
            idx: 0,
            role: 'char',
            displayChatId: chat.id,
            displayMessageId: chat.message[0].chatId,
            totalLength: 1,
            readOnly: true,
            messageGenerationInfo: chat.message[0].generationInfo,
          },
        }) as MountedComponent,
      )
      return host
    })
    await settle()
    expect(hosts[0].textContent).toContain('first scoped translation')
    expect(hosts[0].textContent).not.toContain('second scoped translation')
    expect(hosts[1].textContent).toContain('second scoped translation')
    expect(hosts[1].textContent).not.toContain('first scoped translation')
    Array.from(hosts[1].querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Mock-model'))
      ?.click()
    await settle()
    expect(customHtmlMocks.alertRequestData).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: character.chaId,
        chatId: second.id,
        messageId: first.message[0].chatId,
        genInfo: expect.objectContaining({ generationId: 'second-generation' }),
      }),
    )
    expect(character.chatPage).toBe(0)
    expect(get(selectedCharID)).toBe(0)
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
    expect(customHtmlMocks.runTrigger).not.toHaveBeenCalled()
    expect(get(activeMessageTranslations).map((job) => job.jobId)).toEqual(['first-reader-job', 'second-reader-job'])
    expect(customHtmlMocks.hydrateChatMessages).not.toHaveBeenCalled()
    character.chatPage = 1
    await settle()
    expect(hosts[0].textContent).toContain('first scoped translation')
    expect(hosts[1].textContent).toContain('second scoped translation')
  })

  it.each([320, 900])(
    'keeps plain copy inline without a popup in read-only custom snippets (width=%s)',
    async (width) => {
      seedDatabase(
        1,
        '<div><risutextbox></risutextbox><risubuttons></risubuttons><button class="reader-trigger" risu-trigger="manual" risu-id="id">Run</button><button class="reader-lua" risu-btn="lua">Lua</button></div>',
      )
      testDatabaseState.db.useChatCopy = true
      testDatabaseState.db.enableBookmark = true
      testDatabaseState.db.characters[0].ttsMode = 'browser'
      SizeStore.set({ w: width, h: 700 })
      const clipboard = { writeText: vi.fn(async () => undefined), write: vi.fn(async () => undefined) }
      const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
      try {
        mountCustomHtmlRows(1, 'char', { readOnly: true, rerollIcon: true })
        await settle()
        expect(
          Array.from(target.querySelectorAll('[data-risu-message-action]')).map((button) =>
            button.getAttribute('data-risu-message-action'),
          ),
        ).toEqual(['copy'])
        expect(target.querySelector<HTMLButtonElement>('.reader-trigger')?.disabled).toBe(true)
        expect(target.querySelector<HTMLButtonElement>('.reader-lua')?.disabled).toBe(true)
        target.querySelector<HTMLButtonElement>('.reader-trigger')?.click()
        target.querySelector<HTMLButtonElement>('.reader-lua')?.click()
        target
          .querySelector<HTMLButtonElement>('.reader-trigger')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        target
          .querySelector<HTMLButtonElement>('.reader-lua')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        target.querySelector<HTMLButtonElement>('.button-icon-copy')?.click()
        await settle()
        expect(clipboard.writeText).toHaveBeenCalledWith('visible message 0')
        expect(clipboard.write).not.toHaveBeenCalled()
        expect(customHtmlMocks.ParseMarkdown).not.toHaveBeenCalled()
        expect(customHtmlMocks.runTrigger).not.toHaveBeenCalled()
        expect(customHtmlMocks.runLuaButtonTrigger).not.toHaveBeenCalled()
        expect(customHtmlMocks.risuChatParser).not.toHaveBeenCalled()
      } finally {
        if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
        else Reflect.deleteProperty(window.navigator, 'clipboard')
      }
    },
  )

  it.each([
    { width: 320, role: 'char' },
    { width: 320, role: 'user' },
    { width: 900, role: 'char' },
    { width: 900, role: 'user' },
  ])(
    'exposes only plain-text copy in reader mobilechat bubbles (width=$width, role=$role)',
    async ({ width, role }) => {
      seedDatabase(1)
      testDatabaseState.db.theme = 'mobilechat'
      testDatabaseState.db.useChatCopy = true
      testDatabaseState.db.enableBookmark = true
      testDatabaseState.db.swipe = true
      testDatabaseState.db.characters[0].ttsMode = 'browser'
      SizeStore.set({ w: width, h: 700 })
      const clipboard = { writeText: vi.fn(async () => undefined), write: vi.fn(async () => undefined) }
      const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
      Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
      try {
        mountCustomHtmlRows(1, role, { readOnly: true, rerollIcon: true })
        await settle()
        const actions = Array.from(target.querySelectorAll('[data-risu-message-action]'))
        expect(actions.map((button) => button.getAttribute('data-risu-message-action'))).toEqual(['copy'])
        const body = target.querySelector<HTMLElement>('.chat-message-body')!
        expect(body.classList.contains('reader-message-appearance')).toBe(true)
        expect(body.dataset.readerMessageTone).toBe('light')
        expect(body.classList.contains('prose-invert')).toBe(false)
        const copy = target.querySelector<HTMLButtonElement>('[data-risu-message-action="copy"]')!
        expect(copy.disabled).toBe(false)
        expect(copy.getAttribute('aria-label')).toBeTruthy()
        copy.click()
        await settle()
        expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('visible message 0')
        expect(clipboard.write).not.toHaveBeenCalled()
        expect(customHtmlMocks.ParseMarkdown).not.toHaveBeenCalled()
        expect(customHtmlMocks.runTrigger).not.toHaveBeenCalled()
        expect(customHtmlMocks.runLuaButtonTrigger).not.toHaveBeenCalled()
        expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
      } finally {
        if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
        else Reflect.deleteProperty(window.navigator, 'clipboard')
      }
    },
  )

  it('keeps safe custom-template disclosures and denies non-native and inline script controls', async () => {
    seedDatabase(
      1,
      '<details><summary>Show more</summary><a href="https://example.com">Safe link</a></details><span class="script-link" role="button" risu-btn="local-only">Local script</span><button class="inline-script" onclick="window.localEffect = true">Inline script</button><script>window.localEffect = true</script>',
    )
    mountCustomHtmlRows(1, 'char', { readOnly: true })
    await settle()
    expect(target.querySelector('details summary')?.textContent).toBe('Show more')
    expect(target.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(target.querySelector('script')).toBeNull()
    expect(target.querySelector<HTMLButtonElement>('.inline-script')?.disabled).toBe(true)
    const control = target.querySelector<HTMLElement>('.script-link')!
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.getAttribute('title')).toBeTruthy()
    const clicked = new MouseEvent('click', { bubbles: true, cancelable: true })
    const keyed = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    control.dispatchEvent(clicked)
    control.dispatchEvent(keyed)
    expect(clicked.defaultPrevented).toBe(true)
    expect(keyed.defaultPrevented).toBe(true)
    expect(customHtmlMocks.runTrigger).not.toHaveBeenCalled()
    expect(customHtmlMocks.runLuaButtonTrigger).not.toHaveBeenCalled()
    expect(customHtmlMocks.risuChatParser).not.toHaveBeenCalled()
  })

  it('does not request automatic translation as a managed reader', async () => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].autoTranslate = true
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    enterClientWriter()
    demoteClientSession()
    mountCustomHtmlRows(1, 'char', { autoTranslateOnReady: true })
    await settle()
    expect(target.querySelector('[data-risu-message-action="translate"]')).toBeNull()
    expect(target.querySelector('[data-risu-message-action="edit"]')).toBeNull()
    expect(customHtmlMocks.translateMessageCommand).not.toHaveBeenCalled()
  })

  it('denies writes when displayed identity differs from the canonical writer chat', async () => {
    seedDatabase(1, null as unknown as string)
    mountCustomHtmlRows(1, 'char', { displayChatId: 'different-chat', displayMessageId: 'different-message' })
    await settle()
    expect(target.querySelector('[data-risu-message-action="edit"]')).toBeNull()
  })

  it('does not resume a bookmark confirmation after demotion and promotion', async () => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.enableBookmark = true
    enterClientWriter()
    const pending = deferred<string>()
    customHtmlMocks.alertInput.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    mountPopupList()
    await settle()
    await openMessageActions()
    target.querySelector<HTMLButtonElement>('[data-risu-message-action="bookmark"]')?.click()
    await settle()
    expect(customHtmlMocks.alertInput).toHaveBeenCalledOnce()
    demoteClientSession()
    repromoteClientWriter()
    pending.resolve('late bookmark')
    await settle()
    expect(testDatabaseState.db.characters[0].chats[0].bookmarks).toEqual([])
    expect(dispatchUpdateChatScopedWithOutcome).not.toHaveBeenCalled()
  })

  it('does not start a trigger after hydration resumes in a newer writer session', async () => {
    seedDatabase(1, customHtmlMocks.templates.triggerButton)
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    enterClientWriter()
    const pending = deferred<void>()
    customHtmlMocks.hydrateChatMessages.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    await settle()
    target.querySelector<HTMLButtonElement>('.manual-trigger-button')?.click()
    await settle()
    expect(customHtmlMocks.hydrateChatMessages).toHaveBeenCalledOnce()
    demoteClientSession()
    repromoteClientWriter()
    pending.resolve()
    await settle()
    expect(customHtmlMocks.runTrigger).not.toHaveBeenCalled()
    expect(dispatchCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it('does not apply a translation response received after demotion and promotion', async () => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    enterClientWriter()
    const receipt = await customHtmlMocks.translateMessageCommand({
      baseRevision: 1,
      messageId: 'message-0',
      jobId: 'seed',
    })
    customHtmlMocks.translateMessageCommand.mockClear()
    const pending = deferred<typeof receipt>()
    customHtmlMocks.translateMessageCommand.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-translate')?.click()
    await settle()
    expect(customHtmlMocks.translateMessageCommand).toHaveBeenCalledOnce()
    const jobId = customHtmlMocks.translateMessageCommand.mock.calls[0][0].jobId
    demoteClientSession()
    repromoteClientWriter()
    pending.resolve({ ...receipt, jobId })
    await settle()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].translation).toBeUndefined()
    expect(target.textContent).not.toContain('translated raw')
  })

  it('does not apply a manual trigger result received after demotion and promotion', async () => {
    seedDatabase(1, customHtmlMocks.templates.triggerButton)
    enterClientWriter()
    const pending = deferred<any>()
    customHtmlMocks.runTrigger.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    await settle()
    target.querySelector<HTMLButtonElement>('.manual-trigger-button')?.click()
    await settle()
    expect(customHtmlMocks.runTrigger).toHaveBeenCalledOnce()
    const nextChat = JSON.parse(JSON.stringify(testDatabaseState.db.characters[0].chats[0]))
    nextChat.message[0].data = 'stale trigger output'
    demoteClientSession()
    repromoteClientWriter()
    pending.resolve({ chat: nextChat })
    await settle()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(dispatchCompatibleChatUpdateScoped).not.toHaveBeenCalled()
  })

  it.each([false, true])('captures the message draft on demotion (popup=%s)', async (popup) => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.disableAutoPopupMessageEditor = !popup
    await beginWriterDraftCaptureTest()
    const pending = deferred<void>()
    if (popup) customHtmlMocks.sleep.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    await settle()
    target.querySelector<HTMLButtonElement>('.button-icon-edit')?.click()
    await settle()
    if (popup) {
      expect(popUpEditorStore.open).toBe(true)
      popUpEditorStore.value = 'recover this message draft'
    } else {
      const editor = target.querySelector<HTMLTextAreaElement>('.message-edit-area')!
      editor.value = 'recover this message draft'
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    }
    demoteClientSession()
    pending.resolve()
    await settle()
    expect(capturedWriterDrafts().map((draft) => draft.fields[0]?.value)).toContain('recover this message draft')
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('visible message 0')
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    for (const component of components) unmount(component)
    components = []
    await endWriterDraftCaptureTest()
  })

  it.each([false, true])('captures the translation draft on demotion (popup=%s)', async (popup) => {
    seedDatabase(1, null as unknown as string)
    testDatabaseState.db.disableAutoPopupMessageEditor = !popup
    testDatabaseState.db.translator = 'ko'
    testDatabaseState.db.translatorType = 'llm'
    testDatabaseState.db.characters[0].chats[0].autoTranslate = true
    const message = testDatabaseState.db.characters[0].chats[0].message[0]
    message.translation = {
      source: 'raw',
      text: 'saved translation',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    customHtmlMocks.canUseServerCommands.mockReturnValue(true)
    await beginWriterDraftCaptureTest()
    const pending = deferred<void>()
    if (popup) customHtmlMocks.sleep.mockReturnValueOnce(pending.promise)
    mountCustomHtmlRows(1)
    await settle()
    buttonByText('editTranslation')?.click()
    await settle()
    if (popup) {
      expect(popUpEditorStore.open).toBe(true)
      popUpEditorStore.value = 'recover this translation draft'
    } else {
      const editor = target.querySelector<HTMLTextAreaElement>('[aria-label="editTranslation"]')!
      expect(editor).toBeTruthy()
      editor.value = 'recover this translation draft'
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
    }
    demoteClientSession()
    pending.resolve()
    await settle()
    expect(capturedWriterDrafts().map((draft) => draft.fields[0]?.value)).toContain('recover this translation draft')
    expect(message.translation?.text).toBe('saved translation')
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    for (const component of components) unmount(component)
    components = []
    await endWriterDraftCaptureTest()
  })
})
