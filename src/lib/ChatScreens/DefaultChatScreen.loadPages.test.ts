import { mount, tick, unmount } from 'svelte'
import { demoteClientSession, resetClientSessionForTests } from 'src/ts/clientSession'
import { enterClientWriter, repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActiveChatTarget, AppendCurrentChatUserMessageResult } from 'src/ts/chatCommands'
import type { SuccessfulSendChatEffects } from 'src/ts/process/sendChatCompletion'
import { sha256Hex } from 'src/ts/sha256Fallback'

const loadPageMocks = vi.hoisted(() => ({
  abortActiveGeneration: vi.fn(),
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  beginAlertWait: vi.fn(() => Symbol('screenshot-wait')),
  clearAlertWait: vi.fn(() => true),
  appendCurrentChatEmptyCharMessage: vi.fn(),
  appendCurrentChatUserMessageForSend: vi.fn(
    async (_input?: unknown): Promise<AppendCurrentChatUserMessageResult> => ({
      status: 'ok',
      messageId: 'message-a',
    }),
  ),
  applySuccessfulSendChatEffects: vi.fn(() => true),
  captureActiveChatTarget: vi.fn((): ActiveChatTarget | null => null),
  chatFoldedState: { data: null as null | Record<string, string> },
  chatFoldedStateMessageIndex: { index: -1 },
  clearActiveGenerationAbortController: vi.fn(),
  createActiveGenerationAbortController: vi.fn(() => ({ signal: new AbortController().signal })),
  downloadFile: vi.fn(async () => undefined),
  getCharImage: vi.fn(() => ''),
  getChatMessageOwnerState: vi.fn((_chatId: string) => undefined as Record<string, unknown> | undefined),
  getInlayAsset: vi.fn(async () => null),
  postChatFile: vi.fn(async () => []),
  preflightChatSendBeforeMutation: vi.fn(() => ({ type: 'server' as const })),
  processMultiCommand: vi.fn(async () => false),
  refreshActiveGenerationJobsFromBootstrap: vi.fn(async () => undefined),
  refreshGenerationJobFromBootstrap: vi.fn(async () => ({ status: 'active' as const })),
  retryGenerationJobReattach: vi.fn(async () => undefined),
  stopGenerationJob: vi.fn(async () => undefined),
  sendChat: vi.fn(async (_index?: number, _args?: unknown) => true),
  sleep: vi.fn(async () => undefined),
  stopTTS: vi.fn(),
  guardActiveChatGenerationSettingsForSend: vi.fn(() => ({ status: 'ok' })),
  hydrateActiveChatFully: vi.fn(async () => undefined),
  hydrateActiveChatWindow: vi.fn(async () => true),
  isActiveChatTargetFresh: vi.fn((_target: ActiveChatTarget | null | undefined) => false),
  currentRouteSubscribers: new Set<(value: unknown) => void>(),
  currentRouteValue: {
    kind: 'character',
    path: '/character/character-0/chat-0',
    chaId: 'character-0',
    chatId: 'chat-0',
  } as unknown,
  setCurrentRoute(value: unknown) {
    loadPageMocks.currentRouteValue = value
    loadPageMocks.currentRouteSubscribers.forEach((run) => run(value))
  },
  toCanvas: vi.fn(),
  updateAlertWait: vi.fn(() => true),
}))

vi.mock('./Chat.svelte', async () => {
  const mock = await import('./DefaultChatScreen.testChat.svelte')
  return { default: mock.default }
})

vi.mock('./Suggestion.svelte', async () => {
  const mock = await import('./DefaultChatScreen.testChat.svelte')
  return { default: mock.default }
})

vi.mock('../../lang', () => ({
  language: new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'transcriptShowMessages'
          ? (from: number, to: number) => `Show messages ${from}–${to}`
          : property === 'errors'
            ? {
                emptyText: 'emptyText',
                chatGenerationSettingsIncomplete: 'Chat generation settings are incomplete.',
                chatGenerationSettingsIncompleteWithMissing: (missing: string) =>
                  `Chat generation settings are incomplete. Missing: ${missing}.`,
              }
            : property === 'composerDraftRecovery'
              ? {
                  storageFailed: 'composerDraftStorageFailed',
                  sendFailed: (detail: string) => `composerSendFailed:${detail}`,
                  sendFailureDetails: {
                    chatGenerationSettings: 'chatGenerationSettingsSaveFailed',
                    personaSettings: 'personaSettingsSaveFailed',
                    characterDefinitions: 'characterDefinitionsSaveFailed',
                    activeChatMissing: 'activeChatMissing',
                    preparation: 'sendPreparationFailed',
                    staging: 'sendStagingFailed',
                    queuedConfirmation: 'queuedConfirmationFailed',
                    queuedConflict: 'queuedRevisionConflict',
                    queuedServerUnavailable: 'queuedServerUnavailable',
                    appendNotAccepted: 'appendNotAccepted',
                  },
                }
              : property === 'acceptedSendRecovery'
                ? {
                    generationFailed: 'acceptedSendGenerationFailed',
                    generationInProgress: 'acceptedSendGenerationInProgress',
                    abandoned: 'acceptedSendAbandoned',
                    providerMayHaveRun: 'acceptedSendProviderMayHaveRun',
                    providerMayHaveRunConfirm: 'acceptedSendProviderMayHaveRunConfirm',
                    retry: 'acceptedSendRetry',
                    retrying: 'acceptedSendRetrying',
                  }
                : property === 'generationStop'
                  ? {
                      stopping: 'Stopping acknowledged operation',
                      failed: 'Stop acknowledgement failed',
                      retry: 'Retry Stop',
                      savingStoppedPartial: 'Saving stopped partial',
                    }
                  : property === 'generationReattachFailure'
                    ? {
                        message: 'generationReattachMessage',
                        lastError: (error: string) => `generationReattachLastError:${error}`,
                        retry: 'Retry',
                        refresh: 'Refresh',
                        stop: 'Stop',
                        sidebarWarning: (name: string) => `generationReattachWarning:${name}`,
                      }
                    : property === 'agentPresets'
                      ? {
                          progressBeforeMain: 'beforeMain',
                          progressAfterMain: 'afterMain',
                          progressLabel: (name: string) => name,
                          progressActiveSteps: (names: string) => names,
                          progressWaiting: 'waiting',
                        }
                      : property === 'bardWiki'
                        ? { workspaceTitle: 'BardWiki workspace' }
                        : property === 'chatPostGenerationProgressModuleScript'
                          ? (name: string) => name
                          : property === 'chatPostGenerationProgressCharacterScript'
                            ? (name: string) => name
                            : property === 'chatPostGenerationProgressWithComment'
                              ? (owner: string) => owner
                              : property === 'chatPostGenerationProgressLabel'
                                ? (owner: string) => owner
                                : String(property),
    },
  ),
}))

vi.mock('../../ts/characters', () => ({
  getCharImage: loadPageMocks.getCharImage,
}))

vi.mock('src/ts/characters', () => ({
  getCharImage: loadPageMocks.getCharImage,
}))

vi.mock('../../ts/characterImage', () => ({
  getCharImage: loadPageMocks.getCharImage,
}))

vi.mock('src/ts/characterImage', () => ({
  getCharImage: loadPageMocks.getCharImage,
}))

vi.mock('../../ts/util', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/util')>()
  return {
    ...actual,
    sleep: loadPageMocks.sleep,
  }
})

vi.mock('../../ts/translator/translator', () => ({
  getTranslatorSettingsSignatureKey: () => 'test-translator-settings',
  isExpTranslator: () => false,
  translate: vi.fn(async (message: string) => message),
}))

vi.mock('src/ts/server/greetingTranslations.svelte', () => ({
  currentGreetingTranslatorSettingsSignature: () => 'test-translator-settings',
  findGreetingTranslation: () => null,
  greetingTranslationProjectionVersion: {
    subscribe(run: (value: number) => void) {
      run(0)
      return () => undefined
    },
  },
  refreshGreetingTranslationProjection: vi.fn(async () => ({ status: 'unavailable' as const })),
}))

vi.mock('src/ts/process/inputHooks', () => ({
  runInputHook: vi.fn(async (_hook: unknown, slots: { content: string }) => slots.content),
}))

vi.mock('../../ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  getModuleTriggers: () => [],
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModules: () => [],
  getModuleTriggers: () => [],
  moduleUpdate: vi.fn(),
}))

vi.mock('../../ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
}))

vi.mock('../../ts/alert', () => ({
  alertError: loadPageMocks.alertError,
  alertNormal: loadPageMocks.alertNormal,
  beginAlertWait: loadPageMocks.beginAlertWait,
  clearAlertWait: loadPageMocks.clearAlertWait,
  updateAlertWait: loadPageMocks.updateAlertWait,
}))

vi.mock('src/ts/process/index.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    abortActiveGeneration: loadPageMocks.abortActiveGeneration,
    activeGenerationTarget: writable(null),
    chatProcessStage: writable(0),
    clearActiveGenerationAbortController: loadPageMocks.clearActiveGenerationAbortController,
    createActiveGenerationAbortController: loadPageMocks.createActiveGenerationAbortController,
    doingChat: writable(false),
    sendChat: loadPageMocks.sendChat,
  }
})

vi.mock('src/ts/process/reattach', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/process/reattach')>()
  return {
    ...actual,
    refreshActiveGenerationJobsFromBootstrap: loadPageMocks.refreshActiveGenerationJobsFromBootstrap,
    refreshGenerationJobFromBootstrap: loadPageMocks.refreshGenerationJobFromBootstrap,
    retryGenerationJobReattach: loadPageMocks.retryGenerationJobReattach,
    stopGenerationJob: loadPageMocks.stopGenerationJob,
  }
})

vi.mock('src/ts/process/rerollNavigation.svelte', () => ({
  clearRerollBuffer: vi.fn(),
  markRerollChar: vi.fn(),
  newReroll: vi.fn(async () => undefined),
  recordGeneratedReroll: vi.fn(),
  reroll: vi.fn(async () => undefined),
  resetRerollOnCharChange: vi.fn(),
  selectRerollCandidate: vi.fn(async () => undefined),
  unReroll: vi.fn(async () => undefined),
}))

vi.mock('src/ts/process/command', () => ({
  processMultiCommand: loadPageMocks.processMultiCommand,
}))

vi.mock('src/ts/process/files/multisend', () => ({
  postChatFile: loadPageMocks.postChatFile,
}))

vi.mock('src/ts/process/files/inlays', () => ({
  getInlayAsset: loadPageMocks.getInlayAsset,
}))

vi.mock('src/ts/process/sendChatCompletion', () => ({
  applySuccessfulSendChatEffects: loadPageMocks.applySuccessfulSendChatEffects,
}))

vi.mock('src/ts/process/sendChatPreflight', () => ({
  preflightChatSendBeforeMutation: loadPageMocks.preflightChatSendBeforeMutation,
}))

vi.mock('src/ts/process/coldstorage.svelte', () => ({
  coldStorageHeader: 'cold-storage:',
  preLoadChat: vi.fn(async () => true),
}))

vi.mock('src/ts/process/tts', () => ({
  stopTTS: loadPageMocks.stopTTS,
}))

vi.mock('src/ts/chatCommands', () => ({
  appendCurrentChatEmptyCharMessage: loadPageMocks.appendCurrentChatEmptyCharMessage,
  appendCurrentChatUserMessageForSend: loadPageMocks.appendCurrentChatUserMessageForSend,
  captureActiveChatTarget: loadPageMocks.captureActiveChatTarget,
  cloneJsonValue: <T>(value: T) => JSON.parse(JSON.stringify(value)) as T,
  currentChatStateSnapshot: vi.fn(() => ({ before: 'chat-state' })),
  dispatchReplaceMessagesScoped: vi.fn(),
  dispatchSaveChatGenerationSettings: vi.fn(() => true),
  dispatchUpdateChat: vi.fn(),
  isActiveChatTargetFresh: loadPageMocks.isActiveChatTargetFresh,
  setCurrentChatSelectedDraftHookId: vi.fn((hookId: string | null) => {
    const selectedChar = get(selectedCharID)
    const character = getResourceDatabase().characters?.[selectedChar]
    const chat = character?.chats?.[character.chatPage]
    if (!chat) return false
    if (hookId === null) delete chat.selectedDraftHookId
    else chat.selectedDraftHookId = hookId
    return true
  }),
}))

vi.mock('src/ts/activeChatGenerationSettings', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/activeChatGenerationSettings')>()
  return {
    ...actual,
    guardActiveChatGenerationSettingsForSend: loadPageMocks.guardActiveChatGenerationSettingsForSend,
  }
})

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  applyServerBackedSetting: vi.fn(),
}))

vi.mock('src/ts/server/chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: vi.fn(),
  getChatMessageOwnerState: loadPageMocks.getChatMessageOwnerState,
  hasChatMessageHydrationFailed: () => false,
  hydrateActiveChat: vi.fn(async () => undefined),
  hydrateActiveChatFully: loadPageMocks.hydrateActiveChatFully,
  hydrateActiveChatWindow: loadPageMocks.hydrateActiveChatWindow,
  isChatMessageHydrationPending: () => false,
}))

vi.mock('src/ts/router', () => ({
  currentRoute: {
    subscribe(run: (value: unknown) => void) {
      run(loadPageMocks.currentRouteValue)
      loadPageMocks.currentRouteSubscribers.add(run)
      return () => {
        loadPageMocks.currentRouteSubscribers.delete(run)
      }
    },
  },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  aiLawApplies: () => false,
  chatFoldedState: loadPageMocks.chatFoldedState,
  chatFoldedStateMessageIndex: loadPageMocks.chatFoldedStateMessageIndex,
  downloadFile: loadPageMocks.downloadFile,
  saveAsset: vi.fn(async () => ''),
}))

vi.mock('html-to-image', () => ({
  toCanvas: loadPageMocks.toCanvas,
}))

import DefaultChatScreen from './DefaultChatScreen.svelte'
import {
  clearDefaultChatComposerDrafts,
  readDefaultChatComposerDraft,
  resetDefaultChatComposerDraftRuntimeForTests,
} from './DefaultChatScreen.composerDrafts'
import { initializeDraftRecoveryScope, resetDraftRecoveryScopeForTests } from 'src/ts/server/draftRecoveryScope'
import * as rerollNavigation from 'src/ts/process/rerollNavigation.svelte'
import {
  charactersResourceState,
  collectionsResourceState,
  replaceResourceDatabase,
  settingsResourceState,
} from 'src/ts/server/resourceState.svelte'
import {
  additionalChatMenu,
  additionalFloatingActionButtons,
  PlaygroundStore,
  ScrollToMessageStore,
  selectedCharID,
} from 'src/ts/stores.svelte'
import { presetTemplate, type Database, type Message } from 'src/ts/storage/database.svelte'
import { _setPluginRuntimePhaseForTesting } from 'src/ts/plugins/plugins.svelte'
import { beginStartupAttempt, recordStartupCapabilityFailure } from 'src/ts/startupReadiness'
import {
  createActiveChatGenerationSettingsIncompleteMessage,
  resolveActiveChatGenerationSettings,
} from 'src/ts/activeChatGenerationSettings'
import { translate } from '../../ts/translator/translator'
import { runInputHook } from 'src/ts/process/inputHooks'
import { resetAcceptedSendCoordinatorForTests } from 'src/ts/process/acceptedSendCoordinator.svelte'
import { applyAcceptedSendOperationProjection } from 'src/ts/process/acceptedSendRecoveryState'
import {
  generationOperationCancellations,
  resetGenerationOperationClientForTests,
} from 'src/ts/server/generationOperations'
import { activeGenerationJobs, generationJobLifecycles } from 'src/ts/process/reattach'
import {
  abortInputHookActivity,
  activeInputHookActivities,
  resetInputHookActivitiesForTests,
} from 'src/ts/process/inputHookActivity.svelte'
import {
  beginAgentPresetProgress,
  clearAgentPresetProgress,
  updateAgentPresetProgress,
} from 'src/ts/process/agentPresetProgress'
import {
  beginPostGenerationProgress,
  clearPostGenerationProgress,
  updatePostGenerationProgress,
} from 'src/ts/process/postGenerationProgress'
import {
  beginHalfStreamingProgress,
  recordHalfStreamingToken,
  resetHalfStreamingProgressForTests,
} from 'src/ts/process/halfStreamingProgress'
import { createBranchComment } from './branchComment'
import {
  beginChatGenerationActivity,
  finishChatGenerationActivity,
  resetChatGenerationActivitiesForTests,
  updateChatGenerationActivityMetadata,
  updateChatGenerationActivityPhase,
} from 'src/ts/process/generationActivity.svelte'
import { resetChatUnreadForTests, unreadChatIds } from 'src/ts/process/chatUnread.svelte'
import { defaultChatScreenTestChatController } from './DefaultChatScreen.testChatController'
import {
  beginGenerationDisplayProjection,
  generationDisplayProjections,
  resetGenerationDisplayProjectionsForTests,
  updateGenerationDisplayProjection,
} from 'src/ts/process/generationDisplayProjection.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined
let originalScrollIntoView: Element['scrollIntoView'] | undefined
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

function makeMessages(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    chatId: `${prefix}-message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('char' as const),
    data: `${prefix} message ${index}`,
  }))
}

function makeCharacter(index: number, messageCount: number) {
  return {
    chaId: `character-${index}`,
    name: `Character ${index}`,
    image: '',
    chatPage: 0,
    chats: [
      {
        id: `chat-${index}`,
        name: `Chat ${index}`,
        message: makeMessages(`chat-${index}`, messageCount),
        bookmarks: [],
        bookmarkNames: {},
        fmIndex: -1,
        localLore: [],
      },
    ],
    type: 'character',
    firstMessage: `Greeting ${index}`,
    alternateGreetings: [],
    creatorNotes: '',
    removedQuotes: false,
    largePortrait: false,
    viewScreen: 'none',
    ttsMode: 'none',
  }
}

function captureActiveChatTargetForTest(): ActiveChatTarget | null {
  const selectedChar = get(selectedCharID)
  const character = getResourceDatabase().characters?.[selectedChar]
  const chatPage = character?.chatPage ?? 0
  const chat = character?.chats?.[chatPage]
  if (!character || !chat) return null

  return {
    selectedCharID: selectedChar,
    chatPage,
    characterId: character.chaId,
    chatId: chat.id,
  }
}

function isActiveChatTargetFreshForTest(target: ActiveChatTarget | null | undefined): boolean {
  if (!target) return false

  const selectedChar = get(selectedCharID)
  const character = getResourceDatabase().characters?.[selectedChar]
  const chatPage = character?.chatPage ?? 0
  const chat = character?.chats?.[chatPage]
  if (!character || !chat) return false

  if (target.characterId !== undefined || character.chaId !== undefined) {
    if (target.characterId !== character.chaId) return false
  } else if (target.selectedCharID !== selectedChar) {
    return false
  }

  if (target.chatId !== undefined || chat.id !== undefined) {
    return target.chatId === chat.id
  }

  return target.chatPage === chatPage
}

function seedDatabase(messageCounts: number[]) {
  selectedCharID.set(0)
  loadPageMocks.setCurrentRoute({
    kind: 'character',
    path: '/character/character-0/chat-0',
    chaId: 'character-0',
    chatId: 'chat-0',
  })
  PlaygroundStore.set(0)
  ScrollToMessageStore.value = -1
  loadPageMocks.chatFoldedState.data = null
  loadPageMocks.chatFoldedStateMessageIndex.index = -1
  additionalChatMenu.splice(0, additionalChatMenu.length)
  additionalFloatingActionButtons.splice(0, additionalFloatingActionButtons.length)

  replaceResourceDatabase({
    aiModel: '',
    alwaysScrollToNewMessage: false,
    autoScrollToNewMessage: false,
    characters: messageCounts.map((count, index) => makeCharacter(index, count)),
    currentChar: 0,
    chatLoadInitialPages: 30,
    chatLoadAdditionalPages: 15,
    chatScreenWidth: 900,
    enableRisuaiProTools: false,
    fixedChatTextarea: false,
    floatingChatInput: true,
    hypaV3: false,
    inputHooks: [],
    newMessageButtonStyle: 'bottom-center',
    modules: [],
    promptPresets: [],
    personas: [{ id: 'persona-default', name: 'User', icon: '', largePortrait: false, personaPrompt: '', note: '' }],
    playMessage: false,
    personaPrompt: '',
    selectedPersonaId: 'persona-default',
    selectedPersona: 0,
    showMenuChatList: false,
    showMenuHypaMemoryModal: false,
    sideMenuRerollButton: false,
    subModel: '',
    translator: '',
    useAutoSuggestions: false,
    useAutoTranslateInput: false,
    useChatSticker: false,
    useSayNothing: false,
    username: 'User',
    userIcon: '',
    userNote: '',
  } as unknown as Database)
  loadPageMocks.getChatMessageOwnerState.mockImplementation((chatId: string) => {
    const matches = charactersResourceState.characters.flatMap((character) =>
      (character.chats ?? []).filter((chat) => chat.id === chatId),
    )
    if (matches.length !== 1) return undefined
    return { chatId, messages: matches[0].message, projectionEpoch: 0 }
  })
}

function mountScreen(props: { customStyle?: string } = {}) {
  component = mount(DefaultChatScreen, { target, props })
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await tick()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function settleWithoutTimers() {
  for (let i = 0; i < 8; i += 1) {
    await tick()
    await Promise.resolve()
  }
}

async function waitFor(assertion: () => void) {
  let lastError: unknown
  for (let i = 0; i < 80; i += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await settle()
    }
  }
  throw lastError
}

function messageRowIndexes() {
  return Array.from(target.querySelectorAll<HTMLElement>('.risu-chat[data-chat-index]'))
    .map((element) => Number(element.dataset.chatIndex))
    .filter((index) => index >= 0)
}

function createCanvas(width = 120, height = 12) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
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

function installResizeObserverHarness() {
  const records: Array<{
    callback: ResizeObserverCallback
    observer: ResizeObserver
    targets: Set<Element>
  }> = []

  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>()
    readonly record: (typeof records)[number]

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, observer: this, targets: this.targets }
      records.push(this.record)
    }

    observe(target: Element) {
      this.targets.add(target)
    }

    unobserve(target: Element) {
      this.targets.delete(target)
    }

    disconnect() {
      this.targets.clear()
    }
  }

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  return {
    records,
    notify(target: Element) {
      for (const record of records) {
        if (record.targets.has(target)) record.callback([], record.observer)
      }
    },
  }
}

function geometryRect(top: number, bottom: number, width = 600): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: width,
    width,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function stubLatestMessageGeometry(input: {
  transcript: HTMLElement
  row: HTMLElement
  spacer: HTMLElement
  clientHeight: () => number
  rowHeight: () => number
  trailingHeight: () => number
}) {
  const { transcript, row, spacer, clientHeight, rowHeight, trailingHeight } = input
  Object.defineProperty(transcript, 'clientHeight', { configurable: true, get: clientHeight })
  Object.defineProperty(transcript, 'clientTop', { configurable: true, value: 0 })
  transcript.getBoundingClientRect = () => geometryRect(0, clientHeight())

  spacer.getBoundingClientRect = () => {
    const height = Number.parseFloat(spacer.style.height) || 0
    const bottom = clientHeight() - transcript.scrollTop - trailingHeight()
    return geometryRect(bottom - height, bottom)
  }
  row.getBoundingClientRect = () => {
    const spacerHeight = Number.parseFloat(spacer.style.height) || 0
    const bottom = clientHeight() - transcript.scrollTop - trailingHeight() - spacerHeight
    return geometryRect(bottom - rowHeight(), bottom)
  }
}

function expectedActiveTarget(characterIndex: number) {
  return expect.objectContaining({
    selectedCharID: characterIndex,
    chatPage: 0,
    characterId: `character-${characterIndex}`,
    chatId: `chat-${characterIndex}`,
  })
}

function switchToCharacterChat(characterIndex: number) {
  selectedCharID.set(characterIndex)
  charactersResourceState.currentChar = characterIndex
  loadPageMocks.setCurrentRoute({
    kind: 'character',
    path: `/character/character-${characterIndex}/chat-${characterIndex}`,
    chaId: `character-${characterIndex}`,
    chatId: `chat-${characterIndex}`,
  })
}

async function startDraftHookFromComposer(source: string, expectedCallCount: number): Promise<void> {
  await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
  const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
  composer.value = source
  composer.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
  expect(sendButton).toBeTruthy()
  sendButton!.click()
  await waitFor(() => expect(runInputHook).toHaveBeenCalledTimes(expectedCallCount))
}

async function clickScreenshotMenuItem() {
  const menuButton = target.querySelector<HTMLElement>('[data-testid="default-chat-menu-button"]')
  expect(menuButton).toBeTruthy()
  menuButton!.click()
  await tick()

  const screenshotButton = target.querySelector<HTMLElement>('[data-testid="default-chat-screenshot-button"]')
  expect(screenshotButton).toBeTruthy()
  screenshotButton!.click()
}

async function clickPostFileMenuItem() {
  const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')
  expect(menuButton).toBeTruthy()
  menuButton!.click()
  await tick()
  const postFileMenuItem = findClickableByText('postFile')
  expect(postFileMenuItem).toBeTruthy()
  postFileMenuItem!.click()
}

async function clickContinueMenuItem() {
  const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')
  expect(menuButton).toBeTruthy()
  menuButton!.click()
  await tick()
  const continueMenuItem = findClickableByText('continueResponse')
  expect(continueMenuItem).toBeTruthy()
  continueMenuItem!.click()
}

async function clickSideMenuRerollItem() {
  const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')
  expect(menuButton).toBeTruthy()
  menuButton!.click()
  await tick()
  const rerollMenuItem = findClickableByText('reroll')
  expect(rerollMenuItem).toBeTruthy()
  rerollMenuItem!.click()
}

function findClickableByText(text: string): HTMLElement | undefined {
  return Array.from(target.querySelectorAll<HTMLElement>('button, div')).find(
    (element) => element.textContent?.trim() === text,
  )
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.textContent?.trim() === text,
  )
}

beforeEach(() => {
  _setPluginRuntimePhaseForTesting('ready')
  defaultChatScreenTestChatController.reset()
  resetChatGenerationActivitiesForTests()
  resetChatUnreadForTests()
  resetGenerationOperationClientForTests()
  resetAcceptedSendCoordinatorForTests()
  resetInputHookActivitiesForTests()
  clearAgentPresetProgress()
  clearPostGenerationProgress()
  resetHalfStreamingProgressForTests()
  resetGenerationDisplayProjectionsForTests()
  resetDraftRecoveryScopeForTests()
  clearDefaultChatComposerDrafts()
  initializeDraftRecoveryScope({ databaseLineage: 'database-a', writerSessionId: 'writer-a' })
  target = document.createElement('div')
  document.body.appendChild(target)
  originalScrollIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==')
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.clearAllMocks()
  loadPageMocks.getCharImage.mockReturnValue('')
  loadPageMocks.abortActiveGeneration.mockImplementation(() => {
    abortInputHookActivity(captureActiveChatTargetForTest())
  })
  loadPageMocks.appendCurrentChatUserMessageForSend.mockReset()
  loadPageMocks.appendCurrentChatUserMessageForSend.mockResolvedValue({ status: 'ok', messageId: 'message-a' })
  loadPageMocks.sendChat.mockReset()
  loadPageMocks.sendChat.mockResolvedValue(true)
  loadPageMocks.refreshActiveGenerationJobsFromBootstrap.mockReset()
  loadPageMocks.refreshActiveGenerationJobsFromBootstrap.mockResolvedValue(undefined)
  loadPageMocks.refreshGenerationJobFromBootstrap.mockReset()
  loadPageMocks.refreshGenerationJobFromBootstrap.mockResolvedValue({ status: 'active' })
  loadPageMocks.retryGenerationJobReattach.mockReset()
  loadPageMocks.retryGenerationJobReattach.mockResolvedValue(undefined)
  loadPageMocks.stopGenerationJob.mockReset()
  loadPageMocks.stopGenerationJob.mockResolvedValue(undefined)
  activeGenerationJobs.set([])
  generationJobLifecycles.set({})
  loadPageMocks.postChatFile.mockReset()
  loadPageMocks.postChatFile.mockResolvedValue([])
  loadPageMocks.captureActiveChatTarget.mockImplementation(captureActiveChatTargetForTest)
  loadPageMocks.isActiveChatTargetFresh.mockImplementation(isActiveChatTargetFreshForTest)
  vi.mocked(runInputHook).mockReset()
  vi.mocked(runInputHook).mockImplementation(async (_hook, slots) => slots.content)
  vi.mocked(translate).mockImplementation(async (message: string) => message)
  loadPageMocks.toCanvas.mockReset()
  loadPageMocks.toCanvas.mockImplementation(async () => createCanvas())
  loadPageMocks.hydrateActiveChatFully.mockClear()
  loadPageMocks.hydrateActiveChatWindow.mockClear()
  loadPageMocks.guardActiveChatGenerationSettingsForSend.mockImplementation(() => ({
    status: 'ok',
    state: resolveActiveChatGenerationSettings(),
  }))
  loadPageMocks.preflightChatSendBeforeMutation.mockReturnValue({ type: 'server' })
})

afterEach(() => {
  vi.useRealTimers()
  _setPluginRuntimePhaseForTesting('idle')
  if (component) {
    unmount(component)
    component = undefined
  }
  resetClientSessionForTests()
  vi.unstubAllGlobals()
  Element.prototype.scrollIntoView = originalScrollIntoView as Element['scrollIntoView']
  vi.restoreAllMocks()
  selectedCharID.set(-1)
  ScrollToMessageStore.value = -1
  loadPageMocks.chatFoldedState.data = null
  loadPageMocks.chatFoldedStateMessageIndex.index = -1
  replaceResourceDatabase({} as Database)
  document.documentElement.style.removeProperty('--risu-theme-bgcolor')
  target.remove()
  document.body.innerHTML = ''
  clearDefaultChatComposerDrafts()
  resetDraftRecoveryScopeForTests()
  resetAcceptedSendCoordinatorForTests()
  resetInputHookActivitiesForTests()
  clearAgentPresetProgress()
  clearPostGenerationProgress()
  resetHalfStreamingProgressForTests()
  resetGenerationDisplayProjectionsForTests()
  activeGenerationJobs.set([])
  generationJobLifecycles.set({})
  resetGenerationOperationClientForTests()
  resetChatGenerationActivitiesForTests()
  resetChatUnreadForTests()
  defaultChatScreenTestChatController.reset()
})

describe('DefaultChatScreen persona presentation', () => {
  it('repaints the bound persona when navigation changes the selected character', async () => {
    seedDatabase([1, 1])
    const database = getResourceDatabase()
    database.personas = [
      {
        id: 'persona-a',
        name: 'Persona A',
        displayName: 'Display A',
        icon: 'persona-a.png',
        largePortrait: false,
        personaPrompt: '',
      },
      {
        id: 'persona-b',
        name: 'Persona B',
        displayName: 'Display B',
        icon: 'persona-b.png',
        largePortrait: true,
        personaPrompt: '',
      },
    ] as never
    database.selectedPersonaId = 'persona-a'
    database.selectedPersona = 0
    database.characters[0].chats[0].generationSettings = { personaId: 'persona-a' }
    database.characters[1].chats[0].generationSettings = { personaId: 'persona-b' }
    loadPageMocks.getCharImage.mockImplementation((image?: unknown) => String(image ?? ''))

    mountScreen()
    await settle()

    const currentUserRow = () => target.querySelector<HTMLElement>('.risu-chat[data-chat-index="0"]')
    expect(currentUserRow()?.dataset).toMatchObject({
      chatName: 'Display A',
      chatImage: 'persona-a.png',
      chatLargePortrait: 'false',
    })

    switchToCharacterChat(1)
    await settle()

    expect(currentUserRow()?.dataset).toMatchObject({
      chatName: 'Display B',
      chatImage: 'persona-b.png',
      chatLargePortrait: 'true',
    })
  })
})

describe('DefaultChatScreen initial display readiness', () => {
  it('waits for persona, module, display settings and plugins before mounting rows, independently of generation resources', async () => {
    seedDatabase([2])
    defaultChatScreenTestChatController.hold()
    collectionsResourceState.statuses.personas = 'loading'
    collectionsResourceState.statuses.modules = 'loading'
    settingsResourceState.groupStatuses.display = 'loading'
    settingsResourceState.groupStatuses.providers = 'loading'
    settingsResourceState.groupStatuses.memory = 'loading'
    _setPluginRuntimePhaseForTesting('loading')
    mountScreen()
    await settle()

    const assertWaiting = () => {
      expect(messageRowIndexes()).toEqual([])
      expect(defaultChatScreenTestChatController.pendingCount()).toBe(0)
      expect(target.querySelector('[data-chat-loading-mode="display"]')).toBeTruthy()
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    }
    assertWaiting()
    collectionsResourceState.statuses.personas = 'ready'
    await settle()
    assertWaiting()
    collectionsResourceState.statuses.modules = 'ready'
    settingsResourceState.groupStatuses.display = 'ready'
    await settle()
    assertWaiting()
    _setPluginRuntimePhaseForTesting('ready')
    await waitFor(() => expect(defaultChatScreenTestChatController.pendingCount()).toBe(2))
    expect(messageRowIndexes()).toEqual([1, 0])
    expect(target.querySelector('[data-chat-loading-mode="display"]')).toBeTruthy()
    while (defaultChatScreenTestChatController.releaseNext()) {}
    await waitFor(() => expect(target.querySelector('[data-chat-message-skeleton]')).toBeNull())

    // A refresh of display dependencies must not replace an already-visible transcript.
    collectionsResourceState.statuses.personas = 'loading'
    _setPluginRuntimePhaseForTesting('loading')
    await settle()
    expect(messageRowIndexes()).toEqual([1, 0])
    expect(target.querySelector('[data-chat-message-skeleton]')).toBeNull()
  })

  it.each(['resource', 'plugin', 'plugin-resources'] as const)(
    'exposes a retryable %s failure instead of an indefinite display skeleton',
    async (failure) => {
      seedDatabase([1])
      if (failure === 'resource') settingsResourceState.groupStatuses.media = 'error'
      else if (failure === 'plugin') _setPluginRuntimePhaseForTesting('error')
      else {
        _setPluginRuntimePhaseForTesting('idle')
        recordStartupCapabilityFailure(beginStartupAttempt(), 'plugin-initialization-failed', 'plugins-ready')
      }
      mountScreen()
      await settle()
      expect(messageRowIndexes()).toEqual([])
      expect(target.querySelector('[data-chat-message-skeleton]')).toBeNull()
      const error = target.querySelector('[data-testid="chat-display-dependency-error"]')
      expect(error?.getAttribute('role')).toBe('alert')
      expect(error?.querySelector('button')?.textContent).toBe('retry')
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()

      settingsResourceState.groupStatuses.media = 'ready'
      _setPluginRuntimePhaseForTesting('ready')
      await waitFor(() => expect(messageRowIndexes()).toEqual([0]))
      expect(target.querySelector('[data-testid="chat-display-dependency-error"]')).toBeNull()
    },
  )

  it('does not resume a display plugin retry in a newer writer session after the loader import', async () => {
    const pluginRuntime = await import('src/ts/plugins/plugins.svelte')
    const resourceLoader = await import('src/ts/server/routeResourceLoader')
    const retryPlugin = vi.spyOn(pluginRuntime, 'retryPluginRuntime').mockResolvedValue(true)
    vi.spyOn(resourceLoader, 'ensureResourceSurfaces').mockResolvedValue(undefined)
    seedDatabase([1])
    enterClientWriter()
    _setPluginRuntimePhaseForTesting('error')
    mountScreen()
    await settle()
    const retry = target.querySelector<HTMLButtonElement>('[data-testid="chat-display-dependency-error"] button')
    expect(retry).toBeTruthy()

    // Import resolution yields even for an already-loaded module. Revoke the
    // originating writer before that microtask resumes, then restore the same target.
    retry!.click()
    demoteClientSession()
    repromoteClientWriter()
    _setPluginRuntimePhaseForTesting('error')
    await settle()
    expect(retryPlugin).not.toHaveBeenCalled()

    // A new, explicit Retry belongs to the restored writer and still works.
    target.querySelector<HTMLButtonElement>('[data-testid="chat-display-dependency-error"] button')!.click()
    await waitFor(() => expect(retryPlugin).toHaveBeenCalledOnce())
  })

  it('shows the message skeleton until the newest three cold row parses settle', async () => {
    defaultChatScreenTestChatController.hold()
    seedDatabase([4])
    mountScreen()

    await waitFor(() => {
      expect(defaultChatScreenTestChatController.pendingCount()).toBe(3)
    })
    expect(messageRowIndexes()).toEqual([3, 2, 1, 0])

    const skeleton = target.querySelector<HTMLElement>('[data-chat-message-skeleton]')
    expect(skeleton).toBeTruthy()
    const transcript = skeleton?.closest('[data-default-chat-transcript]')
    expect(transcript).toBeTruthy()
    expect(transcript?.hasAttribute('data-chat-initial-display-pending')).toBe(true)
    expect(skeleton?.getAttribute('data-chat-loading-mode')).toBe('display')
    expect(skeleton?.getAttribute('role')).toBe('status')
    expect(skeleton?.getAttribute('aria-live')).toBe('polite')
    expect(skeleton?.getAttribute('aria-busy')).toBe('true')
    expect(skeleton?.textContent).toContain('loadingChat')
    expect(skeleton?.querySelectorAll('[data-chat-skeleton-row]')).toHaveLength(3)
    expect(skeleton?.querySelector('.animate-spin')).toBeNull()
    expect(skeleton?.contains(target.querySelector('[data-testid="default-chat-composer"]'))).toBe(false)
    expect(target.querySelector('[data-testid="chat-display-loading"]')).toBeNull()

    expect(defaultChatScreenTestChatController.releaseNext()).toBe(true)
    await settle()
    expect(defaultChatScreenTestChatController.pendingCount()).toBe(2)
    expect(target.querySelector('[data-chat-message-skeleton]')).toBeTruthy()

    expect(defaultChatScreenTestChatController.releaseNext()).toBe(true)

    await settle()
    expect(defaultChatScreenTestChatController.pendingCount()).toBe(1)
    expect(target.querySelector('[data-chat-message-skeleton]')).toBeTruthy()
    expect(defaultChatScreenTestChatController.releaseNext()).toBe(true)

    await waitFor(() => {
      expect(target.querySelector('[data-chat-message-skeleton]')).toBeNull()
    })
    expect(target.textContent).toContain('chat-0 message 0')
    expect(target.textContent).toContain('chat-0 message 3')
  })

  it('does not cover the first message appended to a settled empty chat', async () => {
    defaultChatScreenTestChatController.hold()
    seedDatabase([0])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    expect(target.querySelector('[data-chat-loading-cover]')).toBeNull()

    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'first-message',
      role: 'user',
      data: 'First message',
    })

    await waitFor(() => {
      expect(defaultChatScreenTestChatController.pendingCount()).toBe(1)
      expect(target.querySelector('.chat-message-container')).toBeTruthy()
    })
    expect(target.querySelector('[data-chat-loading-cover]')).toBeNull()

    defaultChatScreenTestChatController.release()
  })
})

describe('DefaultChatScreen acknowledged Stop lifecycle', () => {
  it('keeps Stop available for a newer live Continue after an older Stop settled', async () => {
    seedDatabase([2])
    generationOperationCancellations.set([
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        target: captureActiveChatTargetForTest()!,
        state: 'settled_cancelled',
        disposition: 'cancelled',
        operationState: 'cancelled',
      },
    ])
    activeGenerationJobs.set([
      {
        chatId: 'chat-0',
        jobId: 'continue-job',
        operationId: '22222222-2222-4222-8222-222222222222',
        mode: 'continue',
      },
    ])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy()
      expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeNull()
    })
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-cancel-button"]')!.click()
    expect(loadPageMocks.abortActiveGeneration).toHaveBeenCalledTimes(1)
  })

  it('keeps Stopping visible until authority responds, then exposes retry and stopped-partial saving states', async () => {
    seedDatabase([1])
    mountScreen()
    generationOperationCancellations.set([
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        target: captureActiveChatTargetForTest()!,
        state: 'stop_waiting',
        operationState: 'stopping',
      },
    ])
    await waitFor(() => {
      const stop = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-cancel-button"]')
      expect(stop?.disabled).toBe(true)
      expect(stop?.textContent).toContain('Stopping acknowledged operation')
      expect(stop?.getAttribute('aria-busy')).toBe('true')
    })

    generationOperationCancellations.set([
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        target: captureActiveChatTargetForTest()!,
        state: 'stop_failed',
        operationState: 'stopping',
        error: 'network unavailable',
      },
    ])
    await waitFor(() => {
      expect(target.querySelector('[data-testid="generation-stop-failed"]')?.textContent).toContain(
        'Stop acknowledgement failed',
      )
      expect(target.querySelector<HTMLButtonElement>('[data-testid="generation-stop-retry"]')?.disabled).toBe(false)
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')?.textContent).toContain('Retry Stop')
    })

    generationOperationCancellations.set([
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        target: captureActiveChatTargetForTest()!,
        state: 'stopped_finalizing',
        disposition: 'cancelled_finalizing',
        operationState: 'finalizing',
      },
    ])
    await waitFor(() => {
      expect(target.querySelector('[data-testid="generation-stop-saving-partial"]')?.textContent).toContain(
        'Saving stopped partial',
      )
      expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeTruthy()
    })
  })
})

describe('DefaultChatScreen accepted-send recovery projection', () => {
  it('renders distinct retry controls and the abandoned billing warning', async () => {
    seedDatabase([1])
    applyAcceptedSendOperationProjection({
      operationId: 'operation-a',
      protocolVersion: 1,
      requestOrigin: 'accepted_send',
      state: 'retryable',
      stateVersion: 2,
      projectionEpoch: 2,
      creatorWriterSessionId: 'writer-a',
      creatorWriterEpoch: 1,
      characterId: 'character-0',
      chatId: 'chat-0',
      mode: 'send',
      acceptedMessageId: 'accepted-a',
      acceptedRevision: 2,
      providerMayHaveRun: false,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:01.000Z',
    })
    applyAcceptedSendOperationProjection({
      operationId: 'operation-b',
      protocolVersion: 1,
      requestOrigin: 'accepted_send',
      state: 'abandoned',
      stateVersion: 3,
      projectionEpoch: 3,
      creatorWriterSessionId: 'writer-a',
      creatorWriterEpoch: 1,
      characterId: 'character-0',
      chatId: 'chat-0',
      mode: 'send',
      acceptedMessageId: 'accepted-b',
      acceptedRevision: 3,
      providerMayHaveRun: true,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:02.000Z',
    })
    mountScreen()

    await waitFor(() => expect(target.querySelectorAll('[data-testid="accepted-send-recovery"]')).toHaveLength(2))
    expect(target.textContent).toContain('acceptedSendAbandoned')
    expect(target.textContent).toContain('acceptedSendProviderMayHaveRun')
    expect(target.querySelectorAll('[data-testid="accepted-send-retry"]')).toHaveLength(2)
    const flow = target.querySelector<HTMLElement>('[data-default-chat-composer-flow]')!
    expect(
      [...target.querySelectorAll('[data-testid="accepted-send-recovery"]')].every((recovery) =>
        flow.contains(recovery),
      ),
    ).toBe(true)
  })
})

describe('DefaultChatScreen overflow menu accessibility', () => {
  it('exposes a named menu of native buttons and focuses the first enabled item', async () => {
    seedDatabase([2])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-menu-button"]')).toBeTruthy()
    })

    const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!
    menuButton.focus()
    menuButton.click()
    await settle()

    const menu = target.querySelector<HTMLElement>('[data-testid="default-chat-overflow-menu"]')
    expect(menu).toBeTruthy()
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.getAttribute('aria-label')).toBe('menu')
    expect(menuButton.getAttribute('aria-haspopup')).toBe('menu')
    expect(menuButton.getAttribute('aria-controls')).toBe(menu?.id)
    expect(menuButton.getAttribute('aria-expanded')).toBe('true')
    expect(menu?.classList).toContain('overflow-y-auto')
    expect(menu?.classList).toContain('overscroll-contain')
    expect(menu?.className).toContain('max-h-[calc(100dvh-5rem)]')
    expect(menu?.className).toContain('max-w-[calc(100vw-1rem)]')
    expect(menu?.classList).toContain('chat-overflow-menu')
    expect(menu?.classList).not.toContain('chat-overflow-menu-fixed')
    expect(target.querySelector('[data-default-chat-transcript]')?.contains(menu)).toBe(true)

    const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[data-default-chat-menu-item]'))
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.tagName === 'BUTTON')).toBe(true)
    expect(items.every((item) => item.textContent?.trim())).toBe(true)
    expect(items.every((item) => item.getAttribute('role')?.startsWith('menuitem'))).toBe(true)
    expect(target.querySelector('[data-testid="default-chat-open-bardwiki"]')?.textContent).toContain(
      'BardWiki workspace',
    )
    const pinItem = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-pin-button"]')
    expect(pinItem?.getAttribute('role')).toBe('menuitemcheckbox')
    expect(pinItem?.getAttribute('aria-checked')).toBe('false')
    expect(pinItem?.textContent?.trim()).toBe('pinChat')
    expect(document.activeElement).toBe(items[0])

    const bardWikiItem = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-open-bardwiki"]')!
    bardWikiItem.click()
    expect(document.activeElement).toBe(menuButton)
    await settle()
    expect(target.querySelector('[data-testid="default-chat-overflow-menu"]')).toBeNull()
  })

  it('supports arrow, Home, and End navigation and restores opener focus on Escape', async () => {
    seedDatabase([2])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-menu-button"]')).toBeTruthy()
    })

    const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!
    menuButton.click()
    await settle()

    const enabledItems = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-default-chat-menu-item]:not(:disabled)'),
    )
    expect(enabledItems.length).toBeGreaterThan(2)
    expect(document.activeElement).toBe(enabledItems[0])

    enabledItems[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(enabledItems[1])

    enabledItems[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(enabledItems.at(-1))

    enabledItems.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(enabledItems[0])

    enabledItems[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(enabledItems.at(-1))

    enabledItems.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(target.querySelector('[data-testid="default-chat-overflow-menu"]')).toBeNull()
    expect(menuButton.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(menuButton)
  })

  it('skips the unavailable continue action when placing initial focus', async () => {
    seedDatabase([1])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-menu-button"]')).toBeTruthy()
    })

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!.click()
    await settle()

    const continueItem = findClickableByText('continueResponse') as HTMLButtonElement | undefined
    const firstEnabledItem = target.querySelector<HTMLButtonElement>('[data-default-chat-menu-item]:not(:disabled)')
    expect(continueItem).toBeInstanceOf(HTMLButtonElement)
    expect(continueItem?.disabled).toBe(true)
    expect(firstEnabledItem).toBeTruthy()
    expect(document.activeElement).toBe(firstEnabledItem)
  })
})

describe('DefaultChatScreen floating action accessibility', () => {
  it('uses the localized new-message name for the icon-only floating control', async () => {
    seedDatabase([1])
    getResourceDatabase().autoScrollToNewMessage = true
    getResourceDatabase().newMessageButtonStyle = 'floating-circle'
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('.chat-message-container')).toBeTruthy()
    })
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    latestRow.getBoundingClientRect = () => ({
      top: 1_000,
      bottom: 1_100,
      left: 0,
      right: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 1_000,
      toJSON() {},
    })

    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'new-message',
      role: 'char',
      data: 'New response',
    })

    await waitFor(() => {
      expect(target.querySelector('button[aria-label="newMessage"]')).toBeTruthy()
    })

    const newMessageButton = target.querySelector<HTMLButtonElement>('button[aria-label="newMessage"]')!
    expect(newMessageButton.type).toBe('button')
    expect(newMessageButton.title).toBe('newMessage')
  })

  it('reveals the floating button past the threshold and moves the same composer after activation', async () => {
    seedDatabase([2])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    const flow = target.querySelector<HTMLElement>('[data-default-chat-composer-flow]')!
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const composerRow = target.querySelector<HTMLElement>('[data-default-chat-composer-row]')!
    composerRow.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 120,
        left: 0,
        right: 500,
        width: 500,
        height: 120,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    composer.value = 'Original text'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    draft.value = 'Reviewed Draft text'
    draft.dispatchEvent(new Event('input', { bubbles: true }))

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -59
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()

    transcript.scrollTop = -61
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(transcript.scrollTop).toBe(-61)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    const floatingButton = target.querySelector<HTMLButtonElement>('[data-testid="floating-chat-input-button"]')
    expect(floatingButton).toBeTruthy()

    floatingButton!.click()
    await settle()

    expect(transcript.scrollTop).toBe(-61)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBe(flow)
    expect(flow.classList).toContain('floating-chat-composer')
    expect(flow.contains(composer)).toBe(true)
    expect(flow.contains(draft)).toBe(true)
    expect(transcript.contains(composer)).toBe(true)
    expect(target.querySelector('[data-default-chat-composer-dock]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()
    expect(composer.value).toBe('Reviewed Draft text')
    expect(composer.readOnly).toBe(true)
    expect(draft.value).toBe('Reviewed Draft text')

    transcript.scrollTop = 0
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(flow.classList).not.toContain('floating-chat-composer')
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()
    expect(target.querySelector('[data-testid="default-chat-composer"]')).toBe(composer)
    expect(composer.value).toBe('Original text')
    expect(composer.readOnly).toBe(false)
    expect(draft.value).toBe('Reviewed Draft text')
  })

  it('opens from the pencil without changing scroll and returns to it when hidden', async () => {
    seedDatabase([2])
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!

    composer.value = 'unfinished draft'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -80
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    const floatingButton = target.querySelector<HTMLButtonElement>('[data-testid="floating-chat-input-button"]')
    expect(floatingButton).toBeTruthy()
    expect(floatingButton?.getAttribute('aria-label')).toBe('openFloatingChatInput')
    expect(floatingButton?.title).toBe('openFloatingChatInput')

    floatingButton!.click()
    await settle()

    expect(transcript.scrollTop).toBe(-80)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeTruthy()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!.click()
    await settle()

    expect(target.querySelector('[data-testid="floating-chat-input-go-to-bottom"]')).toBeTruthy()
    expect(target.querySelector('[data-testid="floating-chat-input-hide"]')).toBeTruthy()
    expect(target.querySelector('[data-testid="default-chat-overflow-menu"]')?.classList).toContain(
      'chat-overflow-menu-fixed',
    )

    target.querySelector<HTMLButtonElement>('[data-testid="floating-chat-input-hide"]')!.click()
    await settle()

    expect(transcript.scrollTop).toBe(-80)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    const reopenedFloatingButton = target.querySelector<HTMLButtonElement>('[data-testid="floating-chat-input-button"]')
    expect(reopenedFloatingButton).toBeTruthy()
    expect(document.activeElement).toBe(reopenedFloatingButton)
    expect(composer.value).toBe('unfinished draft')

    transcript.scrollTop = -120
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBe(reopenedFloatingButton)

    reopenedFloatingButton!.click()
    await settle()

    expect(transcript.scrollTop).toBe(-120)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeTruthy()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()
    expect(document.activeElement).toBe(composer)

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!.click()
    await settle()
    target.querySelector<HTMLButtonElement>('[data-testid="floating-chat-input-go-to-bottom"]')!.click()
    await settle()

    expect(transcript.scrollTop).toBe(0)
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()
    expect(composer.value).toBe('unfinished draft')
  })

  it('keeps the composer in flow when the floating input toggle is off', async () => {
    seedDatabase([2])
    getResourceDatabase().floatingChatInput = false
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-default-chat-composer-flow]')).toBeTruthy())
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -80
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()
  })

  it('uses the external composer dock and gates floating even when its toggle is on', async () => {
    seedDatabase([2])
    getResourceDatabase().fixedChatTextarea = true
    getResourceDatabase().floatingChatInput = true
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-default-chat-composer-dock]')).toBeTruthy())

    const row = target.querySelector<HTMLElement>('[data-default-chat-composer-row]')!
    const screen = target.querySelector<HTMLElement>('[data-default-chat-screen-width]')!
    const dock = target.querySelector<HTMLElement>('[data-default-chat-composer-dock]')!
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    expect(row.classList).not.toContain('sticky')
    expect(row.classList).not.toContain('fixed')
    expect(dock.parentElement).toBe(screen)
    expect(transcript.contains(row)).toBe(false)
    expect(target.querySelector('[data-default-chat-composer-flow]')).toBeNull()
    expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -80
    transcript.dispatchEvent(new Event('scroll'))
    await settle()
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeNull()

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!.click()
    await settle()

    const menu = target.querySelector<HTMLElement>('[data-testid="default-chat-overflow-menu"]')!
    expect(menu.parentElement).toBe(screen)
    expect(menu.classList).toContain('absolute')
  })

  it('treats missing fixed and floating preferences as default-on in-flow floating mode', async () => {
    seedDatabase([2])
    delete (getResourceDatabase() as Partial<Database>).fixedChatTextarea
    delete (getResourceDatabase() as Partial<Database>).floatingChatInput
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-default-chat-composer-flow]')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const composer = target.querySelector<HTMLElement>('[data-testid="default-chat-composer"]')!
    expect(transcript.contains(composer)).toBe(true)
    expect(target.querySelector('[data-default-chat-composer-dock]')).toBeNull()

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -80
    transcript.dispatchEvent(new Event('scroll'))
    await settle()
    expect(target.querySelector('[data-floating-chat-input="true"]')).toBeNull()
    expect(target.querySelector('[data-testid="floating-chat-input-button"]')).toBeTruthy()
  })

  it('names attachment removal for the selected attachment', async () => {
    seedDatabase([1])
    loadPageMocks.postChatFile.mockResolvedValueOnce([{ type: 'asset', data: 'asset-a' }])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-menu-button"]')).toBeTruthy()
    })
    await clickPostFileMenuItem()

    await waitFor(() => {
      expect(target.querySelector('button[aria-label="remove: asset-a"]')).toBeTruthy()
    })
    const removeButton = target.querySelector<HTMLButtonElement>('button[aria-label="remove: asset-a"]')!
    expect(removeButton.type).toBe('button')

    removeButton.click()
    await tick()

    expect(target.querySelector('button[aria-label="remove: asset-a"]')).toBeNull()
  })

  it('uses each plugin action name for its floating button', async () => {
    seedDatabase([1])
    const callback = vi.fn()
    additionalFloatingActionButtons.push({
      id: 'plugin-action-a',
      name: 'Open plugin action',
      icon: '',
      iconType: 'none',
      callback,
    })
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('button[aria-label="Open plugin action"]')).toBeTruthy()
    })
    const pluginButton = target.querySelector<HTMLButtonElement>('button[aria-label="Open plugin action"]')!
    expect(pluginButton.type).toBe('button')

    pluginButton.click()

    expect(callback).toHaveBeenCalledTimes(1)
  })
})

describe('DefaultChatScreen latest-message viewport anchoring', () => {
  it('opens an existing chat at the beginning of its latest message', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().floatingChatInput = false
    mountScreen()

    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(2))

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const spacer = target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')!
    stubLatestMessageGeometry({
      transcript,
      row: latestRow,
      spacer,
      clientHeight: () => 600,
      rowHeight: () => 180,
      trailingHeight: () => 100,
    })
    resizeObservers.notify(transcript)

    await waitFor(() => expect(spacer.style.height).toBe('320px'))
    expect(transcript.scrollTop).toBe(0)
    expect(latestRow.getBoundingClientRect().top).toBe(0)
  })

  it('renders a regenerate stream in the existing latest row and follows its natural end until the user scrolls away', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().autoScrollToNewMessage = true
    getResourceDatabase().floatingChatInput = false
    const targetMessageId = 'chat-0-message-1'
    const generation = beginChatGenerationActivity({
      target: captureActiveChatTargetForTest()!,
      kind: 'message',
      mode: 'regenerate',
      targetMessageId,
      operationId: 'operation-regenerate',
      attemptNo: 1,
      projectionEpoch: 4,
    })!
    mountScreen()
    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(2))

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    await waitFor(() => expect(latestRow.querySelector('.chat-generation-loading')).toBeTruthy())
    expect(latestRow.textContent).not.toContain('chat-0 message 1')
    const projection = {
      operationId: 'operation-regenerate',
      attemptNo: 1,
      characterId: 'character-0',
      chatId: 'chat-0',
      mode: 'regenerate' as const,
      targetMessageId,
      projectionEpoch: 4,
    }

    beginGenerationDisplayProjection(projection)
    expect(get(generationDisplayProjections)).toEqual([expect.objectContaining(projection)])
    await waitFor(() => expect(latestRow.dataset.generationDisplayProjection).toBe('regenerate'))
    expect(target.querySelectorAll('.chat-message-container')).toHaveLength(2)
    expect(latestRow.textContent).not.toContain('chat-0 message 1')
    expect(latestRow.querySelector('[data-generation-projection-loading]')).toBeTruthy()
    expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
    expect(transcript.scrollTop).toBe(0)

    updateGenerationDisplayProjection(projection, { status: 'streaming', text: 'projected replacement' })
    resizeObservers.notify(latestRow)
    await waitFor(() => expect(latestRow.textContent).toContain('projected replacement'))
    expect(target.querySelector('.chat-message-container')).toBe(latestRow)
    expect(getResourceDatabase().characters[0].chats[0].message[1]).toMatchObject({
      chatId: targetMessageId,
      data: 'chat-0 message 1',
    })

    transcript.scrollTop = -120
    transcript.dispatchEvent(new Event('scroll'))
    await waitFor(() => expect(transcript.scrollTop).toBe(0))

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -160
    transcript.dispatchEvent(new Event('scroll'))
    await settle()
    updateGenerationDisplayProjection(projection, { text: 'projected replacement grows' })
    resizeObservers.notify(latestRow)
    await settle()
    expect(transcript.scrollTop).toBe(-160)

    updateGenerationDisplayProjection(projection, {
      status: 'finalizing',
      generationId: 'assistant-new',
      text: 'projected replacement complete',
    })
    getResourceDatabase().characters[0].chats[0].message[1] = {
      role: 'char',
      data: 'projected replacement complete',
      chatId: 'assistant-new',
      generationInfo: { generationId: 'assistant-new' },
    }
    await waitFor(() => expect(get(generationDisplayProjections)).toEqual([]))
    expect(target.querySelector('.chat-message-container')).toBe(latestRow)
    finishChatGenerationActivity(generation.id)
    await settle()
    expect(transcript.scrollTop).toBe(-160)
    expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
  })

  it('projects an early assistant row and adopts the generated message without remounting it', async () => {
    seedDatabase([2])
    const activeTarget = captureActiveChatTargetForTest()!
    const generation = beginChatGenerationActivity({ target: activeTarget, kind: 'message', mode: 'send' })!
    const chat = charactersResourceState.characters[0].chats[0]
    mountScreen()

    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))
    const projectedRow = target.querySelector<HTMLElement>('.chat-message-container')!
    expect(projectedRow.dataset.generationDisplayProjection).toBe('send')
    expect(projectedRow.querySelector('.chat-generation-loading')).toBeTruthy()
    expect(chat.message).toHaveLength(2)

    updateChatGenerationActivityMetadata(activeTarget, { generationId: 'assistant-generated' })
    chat.message.push({
      chatId: 'assistant-generated',
      role: 'char',
      data: '',
    })
    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))
    expect(target.querySelector('.chat-message-container')).toBe(projectedRow)

    chat.message[2].data = 'Streamed response'
    updateChatGenerationActivityPhase(generation.id, 'generating')
    await waitFor(() => expect(projectedRow.textContent).toContain('Streamed response'))
    expect(projectedRow.querySelector('.chat-generation-loading')).toBeTruthy()

    finishChatGenerationActivity(generation.id)
    await settle()
    expect(target.querySelector('.chat-message-container')).toBe(projectedRow)
    expect(projectedRow.dataset.generationDisplayProjection).toBeUndefined()
    expect(projectedRow.querySelector('.chat-generation-loading')).toBeNull()
  })

  it('keeps the projected assistant and loader mounted while a foreground observer is replaced', async () => {
    seedDatabase([2])
    const generationTarget = captureActiveChatTargetForTest()!
    const operationId = '11111111-1111-4111-8111-111111111111'
    const job = {
      chatId: 'chat-0',
      jobId: 'foreground-job',
      operationId,
      attemptNo: 1,
      mode: 'send' as const,
    }
    activeGenerationJobs.set([job])
    const firstObserver = beginChatGenerationActivity({
      target: generationTarget,
      kind: 'message',
      mode: 'send',
      operationId,
      attemptNo: 1,
    })!
    updateChatGenerationActivityPhase(firstObserver.id, 'waiting-for-model')
    mountScreen()

    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))
    const projectedRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const projectedSurface = projectedRow.querySelector<HTMLElement>('.risu-chat')!
    const loading = projectedRow.querySelector<HTMLElement>('.chat-generation-loading')!
    const startedAt = projectedSurface.dataset.generationStartedAt
    expect(projectedSurface.dataset.generationPhase).toBe('waiting-for-model')

    finishChatGenerationActivity(firstObserver.id)
    await settle()
    expect(target.querySelector('.chat-message-container')).toBe(projectedRow)
    expect(projectedRow.querySelector('.chat-generation-loading')).toBe(loading)
    expect(projectedSurface.dataset.generationPhase).toBe('waiting-for-model')
    expect(projectedSurface.dataset.generationStartedAt).toBe(startedAt)

    const replacementObserver = beginChatGenerationActivity({
      target: generationTarget,
      kind: 'message',
      mode: 'send',
      operationId,
      attemptNo: 1,
    })!
    await settle()
    expect(target.querySelector('.chat-message-container')).toBe(projectedRow)
    expect(projectedRow.querySelector('.chat-generation-loading')).toBe(loading)
    expect(projectedSurface.dataset.generationPhase).toBe('waiting-for-model')
    expect(projectedSurface.dataset.generationStartedAt).toBe(startedAt)

    finishChatGenerationActivity(replacementObserver.id)
    activeGenerationJobs.set([])
  })

  it('keeps a newly appended assistant turn at the natural end while streaming and start-aligns it on completion', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().autoScrollToNewMessage = true
    const generation = beginChatGenerationActivity({ target: captureActiveChatTargetForTest()!, kind: 'message' })!
    mountScreen()

    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!

    updateChatGenerationActivityMetadata(generation.target, { generationId: 'streaming-placeholder-message' })
    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'streaming-placeholder-message',
      role: 'char',
      data: '',
    })

    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))
    const placeholderRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const spacer = target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')!
    let placeholderHeight = 80
    stubLatestMessageGeometry({
      transcript,
      row: placeholderRow,
      spacer,
      clientHeight: () => 600,
      rowHeight: () => placeholderHeight,
      trailingHeight: () => 100,
    })
    expect(transcript.scrollTop).toBe(0)
    expect(spacer.style.height).toBe('0px')

    getResourceDatabase().characters[0].chats[0].message[2].data = 'Finished generated response'
    placeholderHeight = 180
    await settle()
    resizeObservers.notify(placeholderRow)
    await settle()
    expect(transcript.scrollTop).toBe(0)

    finishChatGenerationActivity(generation.id)
    await settle()

    await waitFor(() => expect(spacer.style.height).toBe('320px'))
    expect(transcript.scrollTop).toBe(0)
    expect(placeholderRow.getBoundingClientRect().top).toBe(0)
    expect(get(unreadChatIds).has('chat-0')).toBe(false)
  })

  it('follows a completed assistant append immediately at the natural end', async () => {
    seedDatabase([2])
    getResourceDatabase().autoScrollToNewMessage = true
    mountScreen()

    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())
    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    transcript.scrollTop = 0

    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'completed-assistant-message',
      role: 'char',
      data: 'Completed response',
    })

    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))
    expect(transcript.scrollTop).toBe(0)
    expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
  })

  it('preserves history and lets the new-message action return to the natural end', async () => {
    seedDatabase([2])
    getResourceDatabase().autoScrollToNewMessage = false
    getResourceDatabase().floatingChatInput = false
    mountScreen()
    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    transcript.getBoundingClientRect = () => geometryRect(0, 600)
    latestRow.getBoundingClientRect = () => geometryRect(800, 900)
    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -300
    transcript.dispatchEvent(new Event('scroll'))
    await settle()

    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'unseen-appended-message',
      role: 'char',
      data: 'Reply while reading history',
    })
    await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))

    expect(transcript.scrollTop).toBe(-300)
    expect(get(unreadChatIds).has('chat-0')).toBe(true)
    const newMessageButton = findButtonByText('newMessage')
    expect(newMessageButton).toBeTruthy()

    newMessageButton!.click()
    await settle()

    expect(transcript.scrollTop).toBe(0)
    expect(get(unreadChatIds).has('chat-0')).toBe(false)
    expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
  })

  it.each([true, false])(
    'preserves history and flags unread when generation completes away from latest (auto-scroll: %s)',
    async (autoScrollToNewMessage) => {
      seedDatabase([2])
      getResourceDatabase().autoScrollToNewMessage = autoScrollToNewMessage
      getResourceDatabase().floatingChatInput = false
      const generation = beginChatGenerationActivity({ target: captureActiveChatTargetForTest()!, kind: 'message' })!
      mountScreen()
      await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

      updateChatGenerationActivityMetadata(generation.target, { generationId: 'unfollowed-placeholder-message' })
      getResourceDatabase().characters[0].chats[0].message.push({
        chatId: 'unfollowed-placeholder-message',
        role: 'char',
        data: '',
      })
      await waitFor(() => expect(target.querySelectorAll('.chat-message-container')).toHaveLength(3))

      const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
      getResourceDatabase().characters[0].chats[0].message[2].data = 'Finished while reading history'
      await settle()

      transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      transcript.scrollTop = -150
      transcript.dispatchEvent(new Event('scroll'))
      await settle()
      finishChatGenerationActivity(generation.id)
      await settle()

      expect(transcript.scrollTop).toBe(-150)
      expect(get(unreadChatIds).has('chat-0')).toBe(true)
      expect(findButtonByText('newMessage')).toBeTruthy()
      expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
    },
  )

  it('reasserts the natural end when the followed row or scrollport resizes', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    mountScreen()
    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!

    transcript.scrollTop = -75
    resizeObservers.notify(latestRow)
    await waitFor(() => expect(transcript.scrollTop).toBe(0))

    transcript.scrollTop = -50
    resizeObservers.notify(transcript)
    await waitFor(() => expect(transcript.scrollTop).toBe(0))

    expect(target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')?.style.height).toBe('0px')
  })

  it('freezes an expanded spacer while the user scrolls and when free scroll reaches zero', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().floatingChatInput = false
    mountScreen()
    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const spacer = target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')!
    let latestRowHeight = 180
    stubLatestMessageGeometry({
      transcript,
      row: latestRow,
      spacer,
      clientHeight: () => 600,
      rowHeight: () => latestRowHeight,
      trailingHeight: () => 100,
    })
    resizeObservers.notify(transcript)
    await waitFor(() => expect(spacer.style.height).toBe('320px'))

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -120
    transcript.dispatchEvent(new Event('scroll'))
    latestRowHeight = 420
    resizeObservers.notify(latestRow)
    await settle()

    expect(spacer.style.height).toBe('320px')

    transcript.scrollTop = 0
    transcript.dispatchEvent(new Event('scroll'))
    resizeObservers.notify(latestRow)
    await settle()

    expect(spacer.style.height).toBe('320px')
  })

  it('does not expand a zero spacer when a free transcript returns to zero', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().floatingChatInput = false
    mountScreen()
    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const spacer = target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')!
    let latestRowHeight = 700
    stubLatestMessageGeometry({
      transcript,
      row: latestRow,
      spacer,
      clientHeight: () => 600,
      rowHeight: () => latestRowHeight,
      trailingHeight: () => 100,
    })
    resizeObservers.notify(transcript)
    await waitFor(() => expect(latestRow.getBoundingClientRect().top).toBe(0))
    expect(spacer.style.height).toBe('0px')
    expect(transcript.scrollTop).toBe(-200)

    transcript.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    transcript.scrollTop = -300
    transcript.dispatchEvent(new Event('scroll'))
    latestRowHeight = 180
    resizeObservers.notify(latestRow)
    await settle()

    transcript.scrollTop = 0
    transcript.dispatchEvent(new Event('scroll'))
    resizeObservers.notify(latestRow)
    await settle()

    expect(spacer.style.height).toBe('0px')
    expect(transcript.scrollTop).toBe(0)
    expect(latestRow.getBoundingClientRect().top).toBe(320)
  })

  it('keeps a start-anchored message fixed while its spacer is consumed by row growth', async () => {
    const resizeObservers = installResizeObserverHarness()
    seedDatabase([2])
    getResourceDatabase().floatingChatInput = false
    mountScreen()
    await waitFor(() => expect(target.querySelector('.chat-message-container')).toBeTruthy())

    const transcript = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    const latestRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const spacer = target.querySelector<HTMLElement>('[data-latest-message-scroll-spacer]')!
    let latestRowHeight = 180
    stubLatestMessageGeometry({
      transcript,
      row: latestRow,
      spacer,
      clientHeight: () => 600,
      rowHeight: () => latestRowHeight,
      trailingHeight: () => 100,
    })
    resizeObservers.notify(transcript)
    await waitFor(() => expect(spacer.style.height).toBe('320px'))

    latestRowHeight = 420
    resizeObservers.notify(latestRow)
    await waitFor(() => expect(spacer.style.height).toBe('80px'))
    expect(latestRow.getBoundingClientRect().top).toBe(0)

    latestRowHeight = 700
    resizeObservers.notify(latestRow)
    await waitFor(() => expect(spacer.style.height).toBe('0px'))
    expect(transcript.scrollTop).toBe(-200)
    expect(latestRow.getBoundingClientRect().top).toBe(0)
  })
})

describe('DefaultChatScreen dynamic icon anchor', () => {
  it('anchors the swipe controls on the newest row by default', async () => {
    seedDatabase([3])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('.chat-message-container')).toBeTruthy()
    })

    const containers = [...target.querySelectorAll<HTMLElement>('.chat-message-container')]
    expect(containers.length).toBeGreaterThan(1)
    expect(containers[0].hasAttribute('data-risu-dyna-icons')).toBe(true)
    expect(containers.slice(1).some((container) => container.hasAttribute('data-risu-dyna-icons'))).toBe(false)
  })

  it('anchors the swipe controls on the newest non-comment row when a branch marker is newest', async () => {
    seedDatabase([3])
    // The marker row branchFromCurrentMessage appends to a freshly branched chat.
    getResourceDatabase().characters[0].chats[0].message.push({
      chatId: 'branch-marker',
      role: 'char',
      data: createBranchComment({
        sourceChatId: 'chat-0',
        sourceChatName: 'Chat 0',
        sourceMessageId: 'message-1',
      }),
      isComment: true,
      disabled: true,
    })
    mountScreen()

    await waitFor(() => {
      expect(target.querySelectorAll('.chat-message-container').length).toBeGreaterThan(1)
    })

    const containers = [...target.querySelectorAll<HTMLElement>('.chat-message-container')]
    // Chat.svelte is stubbed here; the anchor attribute computed by
    // Chats.svelte is the contract under test (the stylesheet reveals the
    // swipe controls inside the anchored container).
    const markerRow = containers[0]
    const newestRealRow = containers[1]
    expect(markerRow.hasAttribute('data-risu-dyna-icons')).toBe(false)
    expect(newestRealRow.hasAttribute('data-risu-dyna-icons')).toBe(true)
    expect(containers.slice(2).some((container) => container.hasAttribute('data-risu-dyna-icons'))).toBe(false)
  })
})

describe('DefaultChatScreen content width', () => {
  it('centers the transcript and composer in one reactively sized fixed-width column', async () => {
    seedDatabase([1])
    getResourceDatabase().chatScreenWidth = 500
    getResourceDatabase().fixedChatTextarea = true
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-default-chat-screen-width]')).toBeTruthy()
      expect(target.querySelector('.chat-message-container')).toBeTruthy()
    })

    const screen = target.querySelector<HTMLElement>('[data-default-chat-screen-width]')!
    const composer = target.querySelector<HTMLElement>('[data-testid="default-chat-composer"]')!
    const messageRow = target.querySelector<HTMLElement>('.chat-message-container')!
    const composerRow = composer.closest<HTMLElement>('.chat-screen-content-width')
    const transcript = messageRow.closest<HTMLElement>('.chat-screen-content-width')

    Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 800 })
    screen.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 600,
        left: 100,
        right: 900,
        width: 800,
        height: 600,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
    window.dispatchEvent(new Event('resize'))
    await tick()

    expect(screen.style.getPropertyValue('--chat-screen-width')).toBe('500px')
    expect(screen.style.getPropertyValue('--chat-content-rendered-width')).toBe('500px')
    expect(screen.style.getPropertyValue('--chat-content-inline-end')).toBe('150px')
    expect(screen.style.getPropertyValue('--chat-content-fixed-inline-end')).toBe(`${window.innerWidth - 750}px`)
    const dock = target.querySelector<HTMLElement>('[data-default-chat-composer-dock]')!
    const transcriptPane = target.querySelector<HTMLElement>('[data-default-chat-transcript]')!
    expect(composerRow).toBeTruthy()
    expect(transcript).toBeTruthy()
    expect(composerRow).not.toBe(transcript)
    expect(dock.parentElement).toBe(screen)
    expect(transcriptPane.parentElement).toBe(screen)
    expect(composer.classList).not.toContain('ml-4')
    expect(target.querySelector('[data-testid="default-chat-menu-button"]')?.classList).not.toContain('mr-2')
    expect(target.querySelector('[data-default-chat-agent-progress-column]')?.classList).toContain(
      'chat-screen-content-width',
    )
    expect(target.querySelector('[data-default-chat-post-generation-progress-column]')?.classList).toContain(
      'chat-screen-content-width',
    )

    getResourceDatabase().chatScreenWidth = 1240
    await tick()

    expect(screen.style.getPropertyValue('--chat-screen-width')).toBe('1240px')
    expect(screen.style.getPropertyValue('--chat-content-rendered-width')).toBe('800px')
    expect(screen.style.getPropertyValue('--chat-content-inline-end')).toBe('0px')
    expect(screen.style.getPropertyValue('--chat-content-fixed-inline-end')).toBe(`${window.innerWidth - 900}px`)
  })

  it('measures fixed inline placement from a custom backdrop-filter containing block', async () => {
    seedDatabase([1])
    getResourceDatabase().chatScreenWidth = 500
    mountScreen({ customStyle: 'backdrop-filter: blur(4px);' })

    await waitFor(() => expect(target.querySelector('[data-default-chat-screen-width]')).toBeTruthy())

    const chatRoot = target.querySelector<HTMLElement>('[data-default-chat-fixed-containing-block="chat-root"]')!
    const screen = target.querySelector<HTMLElement>('[data-default-chat-screen-width]')!
    Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 800 })
    screen.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 600,
        left: 100,
        right: 900,
        width: 800,
        height: 600,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect
    chatRoot.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 600,
        left: 50,
        right: 850,
        width: 800,
        height: 600,
        x: 50,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect

    window.dispatchEvent(new Event('resize'))
    await tick()

    expect(screen.style.getPropertyValue('--chat-content-fixed-inline-end')).toBe('100px')
  })
})

describe('DefaultChatScreen live generation progress ownership', () => {
  it('switches Agent, post-generation, and half-streaming projections with the active chat', async () => {
    seedDatabase([2, 2])
    const agentFirst = beginAgentPresetProgress('chat-0')
    const agentSecond = beginAgentPresetProgress('chat-1')
    updateAgentPresetProgress(agentFirst, {
      type: 'agent_preset_progress',
      chatId: 'chat-0',
      presetId: 'preset-0',
      presetName: 'Agent progress A',
      phase: 'beforeMain',
      status: 'running',
      totalSteps: 2,
      completedSteps: 1,
      activeSteps: [],
    })
    updateAgentPresetProgress(agentSecond, {
      type: 'agent_preset_progress',
      chatId: 'chat-1',
      presetId: 'preset-1',
      presetName: 'Agent progress B',
      phase: 'afterMain',
      status: 'running',
      totalSteps: 3,
      completedSteps: 1,
      activeSteps: [],
    })

    const postFirst = beginPostGenerationProgress({ characterId: 'character-0', chatId: 'chat-0' })
    const postSecond = beginPostGenerationProgress({ characterId: 'character-1', chatId: 'chat-1' })
    for (const [session, ownerName] of [
      [postFirst, 'Post progress A'],
      [postSecond, 'Post progress B'],
    ] as const) {
      updatePostGenerationProgress(session, {
        type: 'post_generation_progress',
        phase: 'onOutput',
        status: 'running',
        runSeq: 1,
        ownerType: 'module',
        ownerName,
        llmCallCount: 1,
        pendingLlmCount: 1,
        llmCallCounts: { LLM: 0, axLLM: 1 },
        pendingLlmCounts: { LLM: 0, axLLM: 1 },
      })
    }

    const halfFirst = { characterId: 'character-0', chatId: 'chat-0', generationId: 'generation-0' }
    const halfSecond = { characterId: 'character-1', chatId: 'chat-1', generationId: 'generation-1' }
    beginHalfStreamingProgress(halfFirst)
    beginHalfStreamingProgress(halfSecond)
    recordHalfStreamingToken(halfFirst, 2_000, { generatedTokens: 4 })
    recordHalfStreamingToken(halfSecond, 3_000, { generatedTokens: 12 })
    recordHalfStreamingToken(halfFirst, 3_000, { generatedTokens: 8 })
    recordHalfStreamingToken(halfSecond, 4_000, { generatedTokens: 18 })

    mountScreen()
    await waitFor(() => {
      expect(target.textContent).toContain('Agent progress A')
      expect(target.textContent).toContain('Post progress A')
      expect(target.querySelector('[data-testid="half-streaming-throughput"]')?.textContent).toBe('4')
      expect(target.querySelector('[data-testid="half-streaming-token-count"]')?.textContent).toBe('8')
    })
    expect(target.textContent).not.toContain('Agent progress B')
    expect(target.textContent).not.toContain('Post progress B')

    switchToCharacterChat(1)
    await waitFor(() => {
      expect(target.textContent).toContain('Agent progress B')
      expect(target.textContent).toContain('Post progress B')
      expect(target.querySelector('[data-testid="half-streaming-throughput"]')?.textContent).toBe('6')
      expect(target.querySelector('[data-testid="half-streaming-token-count"]')?.textContent).toBe('18')
    })
    expect(target.textContent).not.toContain('Agent progress A')
    expect(target.textContent).not.toContain('Post progress A')
  })
})

describe('DefaultChatScreen transcript window state', () => {
  it('preserves a branch fold that targets the chat selected in the same task', async () => {
    seedDatabase([20, 20])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toContain(19))

    const foldedTarget = {
      targetCharacterId: 'character-1',
      targetChatId: 'chat-1',
      targetMessageId: 'chat-1-message-10',
    }
    loadPageMocks.chatFoldedState.data = foldedTarget
    loadPageMocks.chatFoldedStateMessageIndex.index = 10
    switchToCharacterChat(1)

    await waitFor(() => expect(messageRowIndexes()).toContain(10))
    expect(loadPageMocks.chatFoldedState.data).toEqual(foldedTarget)
    expect(loadPageMocks.chatFoldedStateMessageIndex.index).toBe(10)
  })

  it('renders one native Load More control instead of nested buttons', async () => {
    seedDatabase([20])
    loadPageMocks.chatFoldedStateMessageIndex.index = 10
    mountScreen()

    await waitFor(() => {
      const loadMoreButtons = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).filter(
        (button) => button.textContent?.trim() === 'loadMore',
      )
      expect(loadMoreButtons).toHaveLength(1)
    })
    expect(target.querySelector('button button')).toBeNull()
  })

  it('expands a deep folded target by its distance from the transcript tail before unfolding', async () => {
    seedDatabase([120])
    loadPageMocks.chatFoldedState.data = {
      targetCharacterId: 'character-0',
      targetChatId: 'chat-0',
      targetMessageId: 'chat-0-message-10',
    }
    loadPageMocks.chatFoldedStateMessageIndex.index = 10
    mountScreen()

    await waitFor(() => {
      expect(messageRowIndexes()).toContain(10)
      expect(messageRowIndexes()).not.toContain(119)
    })
    const loadMore = findButtonByText('loadMore')
    expect(loadMore).toBeTruthy()
    loadMore!.click()

    await waitFor(() => {
      expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(115)
      expect(loadPageMocks.chatFoldedState.data).toBeNull()
      expect(messageRowIndexes()).toContain(10)
      expect(messageRowIndexes()).toContain(119)
    })
  })

  it('keeps a folded target available when transcript expansion hydration fails', async () => {
    seedDatabase([120])
    const foldedTarget = {
      targetCharacterId: 'character-0',
      targetChatId: 'chat-0',
      targetMessageId: 'chat-0-message-10',
    }
    loadPageMocks.chatFoldedState.data = foldedTarget
    loadPageMocks.chatFoldedStateMessageIndex.index = 10
    loadPageMocks.hydrateActiveChatWindow.mockResolvedValueOnce(false)
    mountScreen()

    await waitFor(() => expect(messageRowIndexes()).toContain(10))
    findButtonByText('loadMore')!.click()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(115))

    expect(loadPageMocks.chatFoldedState.data).toEqual(foldedTarget)
    expect(loadPageMocks.chatFoldedStateMessageIndex.index).toBe(10)
    expect(messageRowIndexes()).toContain(10)
  })

  it('offers the Stop TTS action for configured gptsovits synthesis', async () => {
    seedDatabase([2])
    getResourceDatabase().characters[0].ttsMode = 'gptsovits'
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-menu-button"]')).toBeTruthy()
    })
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')!.click()
    await tick()

    const stop = findClickableByText('ttsStop')
    expect(stop).toBeTruthy()
    stop!.click()
    expect(loadPageMocks.stopTTS).toHaveBeenCalledTimes(1)
  })

  it('uses the configured initial chat load count for the initial chat window', async () => {
    seedDatabase([80])
    getResourceDatabase().chatLoadInitialPages = 12

    mountScreen()

    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toHaveLength(12)
      expect(indexes).toContain(79)
      expect(indexes).toContain(68)
      expect(indexes).not.toContain(67)
    })
  })

  it('uses the configured additional chat load count when scrolling to older messages', async () => {
    seedDatabase([80])
    getResourceDatabase().chatLoadInitialPages = 12
    getResourceDatabase().chatLoadAdditionalPages = 7
    mountScreen()

    await waitFor(() => expect(messageRowIndexes()).toHaveLength(12))
    const screen = target.querySelector<HTMLElement>('.default-chat-screen')!
    screen.dispatchEvent(new Event('scroll'))

    await waitFor(() => {
      expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(19)
      expect(messageRowIndexes()).toHaveLength(19)
    })
  })

  it('resizes the logical transcript while bounding DOM when the configured initial load count changes', async () => {
    seedDatabase([80])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    getResourceDatabase().chatLoadInitialPages = 10
    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toHaveLength(10)
      expect(indexes).toContain(79)
      expect(indexes).not.toContain(69)
    })

    getResourceDatabase().chatLoadInitialPages = 60
    await waitFor(() => {
      expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(60)
      expect(document.querySelector('[data-transcript-window-rows]')?.getAttribute('data-transcript-window-rows')).toBe(
        '60',
      )
      const indexes = messageRowIndexes()
      expect(indexes.length).toBeGreaterThanOrEqual(30)
      expect(indexes.length).toBeLessThanOrEqual(31)
      expect(indexes).toContain(79)
      expect(indexes).not.toContain(19)
    })
  })

  it('discards an older load-count hydration after the active chat and setting change', async () => {
    seedDatabase([80, 70])
    const hydration = createDeferred<boolean>()
    loadPageMocks.hydrateActiveChatWindow.mockReturnValueOnce(hydration.promise)
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    getResourceDatabase().chatLoadInitialPages = 60
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(60))

    switchToCharacterChat(1)
    getResourceDatabase().chatLoadInitialPages = 10
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(10))

    hydration.resolve(true)
    await settle()

    expect(messageRowIndexes()).toHaveLength(10)
    expect(messageRowIndexes()).toContain(69)
    expect(messageRowIndexes()).not.toContain(9)
  })

  it('expands the current chat window enough for a deep jump target', async () => {
    seedDatabase([120])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    ScrollToMessageStore.value = 8

    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toContain(8)
      expect(indexes).toContain(3)
      expect(indexes).toContain(119)
      expect(indexes).not.toContain(2)
    })
  })

  it('keeps the current window intact when older-message hydration fails', async () => {
    seedDatabase([120])
    loadPageMocks.hydrateActiveChatWindow.mockResolvedValueOnce(false)
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    ScrollToMessageStore.value = 8

    await waitFor(() => {
      expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(117)
    })
    expect(messageRowIndexes()).toHaveLength(30)
    expect(messageRowIndexes()).not.toContain(8)
  })

  it('resets the bounded window when the active chat identity changes after a deep jump', async () => {
    seedDatabase([200, 150])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    ScrollToMessageStore.value = 5
    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(target.querySelector('[data-transcript-window-rows]')?.getAttribute('data-transcript-window-rows')).toBe(
        '200',
      )
      expect(indexes.length).toBeLessThanOrEqual(76)
      expect(indexes).toContain(5)
    })

    selectedCharID.set(1)
    charactersResourceState.currentChar = 1
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-1/chat-1',
      chaId: 'character-1',
      chatId: 'chat-1',
    })

    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toHaveLength(30)
      expect(indexes).toContain(149)
      expect(indexes).toContain(120)
      expect(indexes).not.toContain(5)
      expect(indexes).not.toContain(0)
    })
  })

  it('keeps chat selection reactive after the previous transcript unmounts during navigation', async () => {
    seedDatabase([2, 2])
    const nextCharacter = charactersResourceState.characters[1]
    nextCharacter.chats.push({
      ...nextCharacter.chats[0],
      id: 'chat-1-next',
      name: 'Next chat',
      message: makeMessages('chat-1-next', 3),
    })
    mountScreen()
    await waitFor(() => expect(target.textContent).toContain('chat-0 message 1'))

    // Route application selects the character before committing its rendered
    // route. This mismatch unmounts the previous transcript during teardown.
    selectedCharID.set(1)
    charactersResourceState.currentChar = 1
    await settle()
    expect(target.querySelector('[data-risu-chat-empty-state]')).not.toBeNull()

    nextCharacter.chatPage = 1
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-1/chat-1-next',
      chaId: 'character-1',
      chatId: 'chat-1-next',
    })
    await waitFor(() => {
      expect(target.querySelector('[data-risu-chat-empty-state]')).toBeNull()
      expect(target.querySelector('[data-testid="default-chat-composer"]')).not.toBeNull()
      expect(target.textContent).toContain('chat-1-next message 2')
      expect(target.textContent).not.toContain('chat-0 message 1')
    })

    nextCharacter.chatPage = 0
    switchToCharacterChat(1)
    await waitFor(() => {
      expect(target.querySelector('[data-risu-chat-empty-state]')).toBeNull()
      expect(target.textContent).toContain('chat-1 message 1')
      expect(target.textContent).not.toContain('chat-1-next message 2')
    })
  })

  it('shows a choose-chat empty state when a character route has no chat id', async () => {
    seedDatabase([12])
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-0',
      chaId: 'character-0',
    })

    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-risu-chat-empty-state]')).toBeTruthy()
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeNull()
      expect(messageRowIndexes()).toEqual([])
    })
  })

  it('restores the bounded window after successful screenshot expansion', async () => {
    seedDatabase([80])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))
    const observedMountedRows: number[] = []
    loadPageMocks.toCanvas.mockImplementation(async () => {
      observedMountedRows.push(messageRowIndexes().length)
      return createCanvas()
    })

    await clickScreenshotMenuItem()

    await waitFor(() => expect(loadPageMocks.downloadFile).toHaveBeenCalledTimes(1))
    expect(observedMountedRows.some((count) => count >= 80)).toBe(true)
    expect(messageRowIndexes()).toHaveLength(30)
    expect(messageRowIndexes()).not.toContain(0)
    expect(loadPageMocks.alertNormal).toHaveBeenCalledWith('screenshotSaved')
  })

  it('restores the bounded window when screenshot capture fails', async () => {
    seedDatabase([80])
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))
    const observedMountedRows: number[] = []
    loadPageMocks.toCanvas.mockImplementation(async () => {
      observedMountedRows.push(messageRowIndexes().length)
      throw new Error('capture failed')
    })

    await clickScreenshotMenuItem()

    await waitFor(() => expect(loadPageMocks.alertError).toHaveBeenCalledTimes(1))
    expect(observedMountedRows.some((count) => count >= 80)).toBe(true)
    expect(messageRowIndexes()).toHaveLength(30)
    expect(messageRowIndexes()).not.toContain(0)
    expect(loadPageMocks.downloadFile).not.toHaveBeenCalled()
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('aborts a screenshot when the active chat changes during hydration', async () => {
    seedDatabase([80, 70])
    const hydration = createDeferred<void>()
    loadPageMocks.hydrateActiveChatFully.mockReturnValueOnce(hydration.promise)
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    await clickScreenshotMenuItem()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))

    switchToCharacterChat(1)
    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toHaveLength(30)
      expect(indexes).toContain(69)
      expect(indexes).not.toContain(39)
    })

    hydration.resolve()
    await settle()

    expect(loadPageMocks.toCanvas).not.toHaveBeenCalled()
    expect(loadPageMocks.downloadFile).not.toHaveBeenCalled()
    expect(loadPageMocks.alertNormal).not.toHaveBeenCalled()
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
    expect(messageRowIndexes()).toHaveLength(30)
    expect(messageRowIndexes()).not.toContain(39)
  })

  it('aborts a screenshot when the active chat changes during row capture', async () => {
    seedDatabase([80])
    const character = getResourceDatabase().characters[0]
    character.chats.push({
      ...character.chats[0],
      id: 'alternate-chat',
      name: 'Alternate chat',
      message: makeMessages('alternate-chat', 70),
      bookmarks: [],
      bookmarkNames: {},
      localLore: [],
    })
    const rowCapture = createDeferred<HTMLCanvasElement>()
    loadPageMocks.toCanvas.mockReturnValueOnce(rowCapture.promise)
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(30))

    await clickScreenshotMenuItem()
    await waitFor(() => expect(loadPageMocks.toCanvas).toHaveBeenCalledTimes(1))
    const waitHandle = loadPageMocks.beginAlertWait.mock.results[0]?.value

    character.chatPage = 1
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-0/alternate-chat',
      chaId: 'character-0',
      chatId: 'alternate-chat',
    })
    await waitFor(() => {
      const indexes = messageRowIndexes()
      expect(indexes).toHaveLength(30)
      expect(indexes).toContain(69)
      expect(indexes).not.toContain(39)
    })

    rowCapture.resolve(createCanvas())
    await settle()

    expect(loadPageMocks.toCanvas).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.downloadFile).not.toHaveBeenCalled()
    expect(loadPageMocks.alertNormal).not.toHaveBeenCalled()
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
    expect(loadPageMocks.clearAlertWait).toHaveBeenCalledWith(waitHandle)
    expect(messageRowIndexes()).toHaveLength(30)
    expect(messageRowIndexes()).not.toContain(39)
  })

  it('paints the resolved theme color behind transparent screenshot rows', async () => {
    seedDatabase([2])
    document.documentElement.style.setProperty('--risu-theme-bgcolor', 'rgb(12, 34, 56)')
    const mergedContext = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(mergedContext)
    mountScreen()
    await waitFor(() => expect(messageRowIndexes()).toHaveLength(2))

    await clickScreenshotMenuItem()

    await waitFor(() => expect(loadPageMocks.downloadFile).toHaveBeenCalledTimes(1))
    expect(mergedContext.fillStyle).toBe('rgb(12, 34, 56)')
    expect(mergedContext.fillRect).toHaveBeenCalled()
  })

  it('blocks a prefilled incomplete-chat send without clearing the composer or appending', async () => {
    seedDatabase([1])
    getResourceDatabase().personas = [
      {
        id: 'persona-a',
        name: 'Persona Alpha',
        icon: '',
        largePortrait: false,
        personaPrompt: '',
      },
    ]
    getResourceDatabase().modelPresets = [{ id: 'model-preset-a', name: 'Model Preset Alpha' }] as any
    getResourceDatabase().promptPresets = [
      {
        ...presetTemplate,
        id: 'preset-a',
        name: 'Preset Alpha',
        jailbreak: 'Jailbreak',
        customPromptTemplateToggle: 'mood=Mood=select=Calm,Spicy\nflag=Flag\nnote=Note=text',
      },
    ]
    getResourceDatabase().characters[0].chats[0].generationSettings = {
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'imported-note',
      },
    }
    const originalHistory = JSON.parse(JSON.stringify(getResourceDatabase().characters[0].chats[0].message))
    loadPageMocks.guardActiveChatGenerationSettingsForSend.mockImplementation(() => {
      const state = resolveActiveChatGenerationSettings()
      if (state.readiness.ready) {
        return { status: 'ok', state }
      }
      return {
        status: 'error',
        error: createActiveChatGenerationSettingsIncompleteMessage(state),
        state,
      }
    })
    mountScreen()

    expect(resolveActiveChatGenerationSettings().missingLabels).toEqual(['Configuration confirmation'])

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Keep this draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    loadPageMocks.hydrateActiveChatFully.mockClear()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockClear()
    loadPageMocks.sendChat.mockClear()

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => {
      expect(loadPageMocks.alertError).toHaveBeenCalledTimes(1)
    })
    const [guardError] = loadPageMocks.alertError.mock.calls[0] ?? []
    expect(guardError).toContain('Chat generation settings are incomplete')
    expect(guardError).toContain('Configuration confirmation')
    expect(textarea.value).toBe('Keep this draft')
    expect(getResourceDatabase().characters[0].chats[0].message).toEqual(originalHistory)
    expect(loadPageMocks.hydrateActiveChatFully).not.toHaveBeenCalled()
    expect(loadPageMocks.processMultiCommand).not.toHaveBeenCalled()
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('restores composer text and selected files when appending the user message fails', async () => {
    seedDatabase([1])
    loadPageMocks.postChatFile.mockResolvedValueOnce([{ type: 'asset', data: 'asset-a' }])
    loadPageMocks.appendCurrentChatUserMessageForSend.mockResolvedValueOnce({
      status: 'error',
      error: 'append failed',
    })
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Retry with file'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const menuButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-menu-button"]')
    expect(menuButton).toBeTruthy()
    menuButton!.click()
    await tick()
    const postFileMenuItem = findClickableByText('postFile')
    expect(postFileMenuItem).toBeTruthy()
    postFileMenuItem!.click()

    await waitFor(() => {
      expect(target.textContent).toContain('Missing file')
    })

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => {
      expect(loadPageMocks.alertError).toHaveBeenCalledWith('append failed')
    })

    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: 'Retry with file{{inlayed::asset-a}}',
      }),
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )
    expect(textarea.value).toBe('Retry with file')
    expect(target.textContent).toContain('Missing file')
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('keeps a legacy group composer and transcript unchanged when preflight rejects generation', async () => {
    seedDatabase([1])
    ;(getResourceDatabase().characters[0] as unknown as { type: string }).type = 'group'
    const originalHistory = JSON.parse(
      JSON.stringify(getResourceDatabase().characters[0].chats[0].message),
    ) as unknown[]
    loadPageMocks.preflightChatSendBeforeMutation.mockReturnValueOnce({
      type: 'unsupported',
      reason: 'Group chats are not supported by server prompt assembly.',
    } as never)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Keep this legacy group draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => {
      expect(loadPageMocks.alertError).toHaveBeenCalledWith('Group chats are not supported by server prompt assembly.')
    })

    expect(loadPageMocks.preflightChatSendBeforeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        currentChar: expect.objectContaining({ type: 'group' }),
        pendingUserMessage: expect.objectContaining({
          role: 'user',
          data: 'Keep this legacy group draft',
        }),
      }),
    )
    expect(textarea.value).toBe('Keep this legacy group draft')
    expect(getResourceDatabase().characters[0].chats[0].message).toEqual(originalHistory)
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('retains a plain-send draft while queued and clears only after final acceptance', async () => {
    seedDatabase([1])
    const chat = getResourceDatabase().characters[0].chats[0]
    const settlement = createDeferred<
      { status: 'accepted' } | { status: 'failed'; result: { status: 'unavailable' } }
    >()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockImplementationOnce(async (input) => {
      chat.message.push({ ...(input as Message), chatId: 'queued-message' })
      return {
        status: 'queued',
        messageId: 'queued-message',
        settlement: settlement.promise,
      }
    })
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Keep durably'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())
    expect(textarea.value).toBe('Keep durably')
    expect(loadPageMocks.alertNormal).not.toHaveBeenCalledWith('pendingChatMessageQueued')
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
    expect(loadPageMocks.applySuccessfulSendChatEffects).not.toHaveBeenCalled()
    expect(chat.message.filter((message) => message.chatId === 'queued-message')).toHaveLength(1)

    settlement.resolve({ status: 'accepted' })
    await waitFor(() => {
      expect(textarea.value).toBe('')
      expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1)
    })
    await settle()
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(chat.message.filter((message) => message.chatId === 'queued-message')).toHaveLength(1)
    expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
  })

  it('retains a newer composer generation when an older queued send is accepted', async () => {
    seedDatabase([1])
    const settlement = createDeferred<
      { status: 'accepted' } | { status: 'failed'; result: { status: 'unavailable' } }
    >()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockResolvedValueOnce({
      status: 'queued',
      messageId: 'queued-message',
      settlement: settlement.promise,
    })
    mountScreen()
    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Older queued draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()
    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())

    textarea.value = 'Newer unsent draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    settlement.resolve({ status: 'accepted' })
    await settle()

    expect(textarea.value).toBe('Newer unsent draft')
  })

  it('keeps typing editable and reports sessionStorage quota failure inline and globally', async () => {
    seedDatabase([1])
    mountScreen()
    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const storageWrite = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!

    textarea.value = 'Still editable'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    await waitFor(() =>
      expect(target.querySelector('[data-testid="composer-draft-persistence-error"]')?.textContent).toContain(
        'composerDraftStorageFailed',
      ),
    )
    expect(textarea.value).toBe('Still editable')
    expect(textarea.readOnly).toBe(false)
    expect(loadPageMocks.alertError).toHaveBeenCalledWith('composerDraftStorageFailed')
    storageWrite.mockRestore()
  })

  it('runs the selected draft hook into the draft area while preserving the composer', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: '{{slot::content}}' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    vi.mocked(runInputHook).mockResolvedValueOnce('  Refined draft  ')
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const draftArea = target.querySelector<HTMLElement>('[data-testid="default-chat-draft-area"]')!
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    expect(draftArea.classList).toContain('chat-screen-content-width')
    expect(draft.classList).toContain('w-full')
    draft.value = 'Earlier draft'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    composer.value = 'Composer source'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(draft.value).toBe('Refined draft'))
    expect(runInputHook).toHaveBeenCalledWith(
      hook,
      { content: 'Composer source', draft: 'Earlier draft' },
      expect.any(Object),
      undefined,
    )
    expect(composer.value).toBe('Composer source')
    expect(loadPageMocks.preflightChatSendBeforeMutation).not.toHaveBeenCalled()
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('uses the amber input-hook process stage only while a draft hook is running', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: '{{slot::content}}' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    const pending = createDeferred<string>()
    vi.mocked(runInputHook).mockReturnValueOnce(pending.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composer.value = 'Composer source'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => {
      expect(get(activeInputHookActivities)).toEqual([
        expect.objectContaining({ chatId: 'chat-0', kind: 'draft', stage: 5 }),
      ])
      expect(target.querySelector('[data-testid="default-chat-cancel-button"] .chat-process-stage-5')).toBeTruthy()
    })

    pending.resolve('Refined draft')
    await waitFor(() => expect(get(activeInputHookActivities)).toEqual([]))
    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
  })

  it('shows Chat B send controls while Chat A owns a pending draft hook', async () => {
    seedDatabase([1, 1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    const pendingA = createDeferred<string>()
    vi.mocked(runInputHook).mockReturnValueOnce(pendingA.promise)
    mountScreen()

    await startDraftHookFromComposer('Chat A source', 1)
    await waitFor(() => {
      expect(get(activeInputHookActivities)).toEqual([
        expect.objectContaining({ chatId: 'chat-0', kind: 'draft', stage: 5 }),
      ])
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy()
    })

    switchToCharacterChat(1)
    await waitFor(() => {
      const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
      expect(sendButton).toBeTruthy()
      expect(sendButton?.disabled).toBe(false)
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
    })

    pendingA.resolve('Stale Chat A result')
    await waitFor(() => expect(get(activeInputHookActivities)).toEqual([]))
    expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeTruthy()
    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
  })

  it('cancels only the open chat hook when two chat targets are active', async () => {
    seedDatabase([1, 1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    getResourceDatabase().characters[1].chats[0].selectedDraftHookId = hook.id
    const pendingA = createDeferred<string>()
    const pendingB = createDeferred<string>()
    const signals = new Map<string, AbortSignal>()
    vi.mocked(runInputHook).mockImplementation((_hook, slots, signal) => {
      signals.set(slots.content, signal)
      return slots.content === 'Chat A source' ? pendingA.promise : pendingB.promise
    })
    mountScreen()

    await startDraftHookFromComposer('Chat A source', 1)
    switchToCharacterChat(1)
    await startDraftHookFromComposer('Chat B source', 2)
    await waitFor(() => expect(get(activeInputHookActivities)).toHaveLength(2))

    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-cancel-button"]')!.click()

    expect(signals.get('Chat B source')?.aborted).toBe(true)
    expect(signals.get('Chat A source')?.aborted).toBe(false)
    pendingB.reject(new Error('Chat B aborted'))
    await waitFor(() => {
      expect(get(activeInputHookActivities).map((activity) => activity.chatId)).toEqual(['chat-0'])
    })

    switchToCharacterChat(0)
    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy())
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-cancel-button"]')!.click()
    expect(signals.get('Chat A source')?.aborted).toBe(true)
    pendingA.reject(new Error('Chat A aborted'))
    await waitFor(() => expect(get(activeInputHookActivities)).toEqual([]))
    expect(loadPageMocks.abortActiveGeneration).toHaveBeenCalledTimes(2)
  })

  it('keeps Chat A hook state when Chat B finishes first and cleans up in reverse order', async () => {
    seedDatabase([1, 1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    getResourceDatabase().characters[1].chats[0].selectedDraftHookId = hook.id
    const pendingA = createDeferred<string>()
    const pendingB = createDeferred<string>()
    vi.mocked(runInputHook).mockImplementation((_hook, slots) =>
      slots.content === 'Chat A source' ? pendingA.promise : pendingB.promise,
    )
    mountScreen()

    await startDraftHookFromComposer('Chat A source', 1)
    switchToCharacterChat(1)
    await startDraftHookFromComposer('Chat B source', 2)
    await waitFor(() => expect(get(activeInputHookActivities)).toHaveLength(2))

    pendingB.resolve('Chat B draft')
    await waitFor(() => {
      expect(get(activeInputHookActivities).map((activity) => activity.chatId)).toEqual(['chat-0'])
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')?.value).toBe(
        'Chat B draft',
      )
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
    })

    switchToCharacterChat(0)
    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy())
    pendingA.resolve('Stale Chat A draft')
    await waitFor(() => expect(get(activeInputHookActivities)).toEqual([]))
    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()

    switchToCharacterChat(1)
    await waitFor(() =>
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')?.value).toBe(
        'Chat B draft',
      ),
    )
  })

  it('submits Chat B with Enter while Chat A owns a pending hook', async () => {
    seedDatabase([1, 1])
    getResourceDatabase().sendWithEnter = true
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    const pendingA = createDeferred<string>()
    vi.mocked(runInputHook).mockReturnValueOnce(pendingA.promise)
    mountScreen()

    await startDraftHookFromComposer('Chat A source', 1)
    switchToCharacterChat(1)
    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeTruthy()
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
    })
    const composerB = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composerB.value = 'Chat B keyboard send'
    composerB.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })

    composerB.dispatchEvent(keydown)

    expect(keydown.defaultPrevented).toBe(true)
    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'Chat B keyboard send' }),
      { expectedTarget: expectedActiveTarget(1) },
    )
    expect(runInputHook).toHaveBeenCalledTimes(1)

    pendingA.resolve('Stale Chat A result')
    await waitFor(() => expect(get(activeInputHookActivities)).toEqual([]))
  })

  it('discards a draft-hook result after the active chat target changes', async () => {
    seedDatabase([1, 1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    const pending = createDeferred<string>()
    vi.mocked(runInputHook).mockReturnValueOnce(pending.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composer.value = 'Source'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()
    await waitFor(() => expect(runInputHook).toHaveBeenCalledTimes(1))

    switchToCharacterChat(1)
    await settle()
    pending.resolve('Stale result')
    await settle()
    switchToCharacterChat(0)
    await settle()

    expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')?.value).toBe('')
  })

  it('reports an empty draft-hook result and preserves the composer', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    vi.mocked(runInputHook).mockResolvedValueOnce('   ')
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composer.value = 'Keep me'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(loadPageMocks.alertError).toHaveBeenCalledWith('emptyText'))
    expect(composer.value).toBe('Keep me')
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
  })

  it('sends a draft as a user message, starts generation, and clears draft state on success', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    composer.value = 'Preserved until success'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    draft.value = '  Ready draft  '
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-draft-send"]')!.click()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', data: '  Ready draft  ' }),
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    const [sentMessage] = loadPageMocks.appendCurrentChatUserMessageForSend.mock.calls[0]
    expect(sentMessage).not.toHaveProperty('translation')
    await waitFor(() => {
      expect(composer.value).toBe('')
      expect(draft.value).toBe('')
    })
  })

  it('stores the original composer text as the translation for an enabled Draft hook', async () => {
    seedDatabase([1])
    const hook = {
      id: 'translation-hook',
      name: 'Translation Hook',
      type: 'draft' as const,
      prompt: 'prompt',
      translation: true,
    }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    composer.value = 'Original composer text'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    draft.value = 'Draft hook output'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-draft-send"]')!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())
    const [sentMessage] = loadPageMocks.appendCurrentChatUserMessageForSend.mock.calls[0]
    expect(sentMessage).toMatchObject({
      role: 'user',
      data: 'Draft hook output',
      translation: {
        text: 'Original composer text',
        source: 'raw',
        sourceHash: await sha256Hex('Draft hook output'),
        targetLanguage: 'original',
        inputLanguage: 'auto',
        translatorType: 'llm',
        settingsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        updatedAt: expect.any(Number),
      },
    })
  })

  it('retains a durably queued hook draft and reports a final failure persistently', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    const settlement = createDeferred<
      { status: 'accepted' } | { status: 'failed'; result: { status: 'unavailable' } }
    >()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockResolvedValueOnce({
      status: 'queued',
      messageId: 'queued-draft',
      settlement: settlement.promise,
    })
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    draft.value = 'Queued draft'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-draft-send"]')!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledOnce())
    expect(draft.value).toBe('Queued draft')
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()

    settlement.resolve({ status: 'failed', result: { status: 'unavailable' } })
    await waitFor(() => {
      expect(target.querySelector('[data-testid="composer-draft-persistence-error"]')?.textContent).toContain(
        'composerSendFailed:queuedServerUnavailable',
      )
    })
    expect(loadPageMocks.alertError).toHaveBeenCalledWith('composerSendFailed:queuedServerUnavailable')
    expect(draft.value).toBe('Queued draft')
  })

  it('preserves the draft when its append fails', async () => {
    seedDatabase([1])
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    loadPageMocks.appendCurrentChatUserMessageForSend.mockResolvedValueOnce({ status: 'error', error: 'append failed' })
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-draft-input"]')).toBeTruthy())
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    draft.value = 'Retry this draft'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-draft-send"]')!.click()

    await waitFor(() => expect(loadPageMocks.alertError).toHaveBeenCalledWith('append failed'))
    expect(draft.value).toBe('Retry this draft')
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('runs a BTW hook into a dismissible result panel', async () => {
    seedDatabase([1])
    const draftHook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'draft' }
    const btwHook = { id: 'btw-hook', name: 'BTW Hook', type: 'btw' as const, prompt: 'btw' }
    getResourceDatabase().inputHooks = [draftHook, btwHook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = draftHook.id
    vi.mocked(runInputHook).mockResolvedValueOnce('  BTW answer  ')
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-btw-button"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const draft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    composer.value = 'Question'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    draft.value = 'Current draft'
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-btw-button"]')!.click()
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-input-hook-option-btw-hook"]')!.click()

    await waitFor(() =>
      expect(target.querySelector('[data-testid="default-chat-btw-result"]')?.textContent).toContain('BTW answer'),
    )
    expect(runInputHook).toHaveBeenCalledWith(
      btwHook,
      { content: 'Question', draft: 'Current draft' },
      expect.any(Object),
      undefined,
    )
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-btw-dismiss"]')!.click()
    await tick()
    expect(target.querySelector('[data-testid="default-chat-btw-result"]')).toBeNull()
  })

  it('captures prior messages and the selected greeting for history-aware input hooks', async () => {
    seedDatabase([2])
    const hook = {
      id: 'history-hook',
      name: 'History Hook',
      type: 'draft' as const,
      prompt: '{{slot::history::3}}\n{{slot::historytrans::3}}\n{{slot::content}}',
    }
    getResourceDatabase().inputHooks = [hook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = hook.id
    getResourceDatabase().characters[0].chats[0].message[0].translation = {
      text: 'translated first row',
    } as Message['translation']
    vi.mocked(runInputHook).mockResolvedValueOnce('History-aware draft')
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composer.value = 'Composer source'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(runInputHook).toHaveBeenCalledTimes(1))
    expect(runInputHook).toHaveBeenCalledWith(hook, { content: 'Composer source', draft: '' }, expect.any(Object), {
      messages: [
        {
          role: 'user',
          data: 'chat-0 message 0',
          translation: { text: 'translated first row' },
        },
        { role: 'char', data: 'chat-0 message 1' },
      ],
      messageIndex: 2,
      greeting: { source: 'Greeting 0' },
      maxTokens: 2048,
    })
    expect(loadPageMocks.hydrateActiveChatWindow).not.toHaveBeenCalled()
  })

  it('hydrates only the tail needed by the largest input-hook history window', async () => {
    seedDatabase([60])
    const chat = getResourceDatabase().characters[0].chats[0]
    const originalMessages = chat.message.map((message) => ({ ...message }))
    for (let index = 0; index < 30; index += 1) {
      chat.message[index] = {
        role: 'char',
        data: '',
        disabled: true,
        isComment: true,
        __risuServerUnloadedMessage: true,
      } as Message
    }
    const hook = {
      id: 'history-hook',
      name: 'History Hook',
      type: 'draft' as const,
      prompt: '{{slot::history::40}}',
    }
    getResourceDatabase().inputHooks = [hook]
    chat.selectedDraftHookId = hook.id
    loadPageMocks.hydrateActiveChatWindow.mockImplementationOnce(async () => {
      for (let index = 20; index < 30; index += 1) chat.message[index] = originalMessages[index]
      return true
    })
    vi.mocked(runInputHook).mockResolvedValueOnce('History-aware draft')
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const composer = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    composer.value = 'Composer source'
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(runInputHook).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.hydrateActiveChatWindow).toHaveBeenCalledWith(40)
    const historyContext = vi.mocked(runInputHook).mock.calls[0][3]
    expect(historyContext?.messageIndex).toBe(60)
    expect(historyContext?.messages.slice(20).map((message) => message.data)).toEqual(
      originalMessages.slice(20).map((message) => message.data),
    )
  })

  it('shrinks the composer back after sending a tall draft', async () => {
    seedDatabase([1])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => (textarea.value === '' ? 0 : 180),
    })

    textarea.value = 'A long draft that wraps enough to make the composer tall.'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => {
      expect(textarea.style.height).toBe('180px')
    })

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => {
      expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1)
      expect(textarea.value).toBe('')
      expect(textarea.style.height).toBe('44px')
    })
  })

  it('marks an empty useSayNothing send for server-side input-hook bypass', async () => {
    seedDatabase([0])
    getResourceDatabase().useSayNothing = true
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeTruthy())
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', data: '*says nothing*' }),
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        syntheticSayNothing: true,
        expectedTarget: expectedActiveTarget(0),
      }),
    )
  })

  it('does not clear newer typed composer text when a delayed append succeeds', async () => {
    seedDatabase([1])
    const append = createDeferred<AppendCurrentChatUserMessageResult>()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockReturnValueOnce(append.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Send the captured draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: 'Send the captured draft',
      }),
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )

    textarea.value = 'Newer draft typed while append waits'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    append.resolve({ status: 'ok', messageId: 'delayed-message' })

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(textarea.value).toBe('Newer draft typed while append waits')
  })

  it('continues a delayed accepted send for its captured target after the active chat changes', async () => {
    seedDatabase([1, 1])
    const append = createDeferred<AppendCurrentChatUserMessageResult>()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockReturnValueOnce(append.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'First chat message'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: 'First chat message',
      }),
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )

    switchToCharacterChat(1)
    await settle()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'Second chat draft'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    append.resolve({ status: 'ok', messageId: 'delayed-message' })
    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))

    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
    expect(secondTextarea.value).toBe('Second chat draft')
    expect(readDefaultChatComposerDraft('0:character-0:chat-0')).toBeUndefined()
    expect(readDefaultChatComposerDraft('1:character-1:chat-1')?.messageInput).toBe('Second chat draft')
  })

  it('continues an accepted send after navigation during the post-append delay', async () => {
    seedDatabase([1, 1])
    const postAppendDelay = createDeferred<void>()
    loadPageMocks.sleep.mockReturnValueOnce(postAppendDelay.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'Accepted before navigation'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(loadPageMocks.sleep).toHaveBeenCalledWith(10))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()

    switchToCharacterChat(1)
    await settle()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'New Chat B draft during handoff'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    postAppendDelay.resolve()
    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))

    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    expect(secondTextarea.value).toBe('New Chat B draft during handoff')
    expect(readDefaultChatComposerDraft('0:character-0:chat-0')).toBeUndefined()
    expect(readDefaultChatComposerDraft('1:character-1:chat-1')?.messageInput).toBe('New Chat B draft during handoff')
  })

  it('shows a retryable generation failure only in the accepted send target chat', async () => {
    seedDatabase([1, 1])
    loadPageMocks.sendChat.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'Persist once, retry generation only'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="accepted-send-recovery"]')?.textContent).toContain(
        'acceptedSendGenerationFailed',
      )
    })
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1)

    switchToCharacterChat(1)
    await settle()
    expect(target.querySelector('[data-testid="accepted-send-recovery"]')).toBeNull()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'Chat B stays untouched'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    switchToCharacterChat(0)
    await waitFor(() => expect(target.querySelector('[data-testid="accepted-send-retry"]')).toBeTruthy())
    target.querySelector<HTMLButtonElement>('[data-testid="accepted-send-retry"]')!.click()
    await waitFor(() => {
      expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(2)
      expect(target.querySelector('[data-testid="accepted-send-recovery"]')).toBeNull()
    })

    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    switchToCharacterChat(1)
    await settle()
    expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')?.value).toBe(
      'Chat B stays untouched',
    )
  })

  it('explains a generation lock while bootstrap catches up and keeps the accepted row retryable', async () => {
    seedDatabase([1])
    loadPageMocks.appendCurrentChatUserMessageForSend.mockImplementationOnce(async (input?: unknown) => {
      const chat = getResourceDatabase().characters[0].chats[0]
      chat.message.push({ ...(input as Message), chatId: 'accepted-lock-message' })
      return { status: 'ok', messageId: 'accepted-lock-message' }
    })
    const rejectForRunningGeneration = async (_index?: number, args?: unknown): Promise<boolean> => {
      const onFailure = (args as { onFailure?: (failure: { cause: 'generation_in_progress' }) => void })?.onFailure
      onFailure?.({ cause: 'generation_in_progress' })
      return false
    }
    loadPageMocks.sendChat
      .mockImplementationOnce(rejectForRunningGeneration)
      .mockImplementationOnce(rejectForRunningGeneration)
      .mockResolvedValueOnce(true)
    loadPageMocks.refreshActiveGenerationJobsFromBootstrap.mockImplementation(async () => {
      activeGenerationJobs.set([{ chatId: 'chat-0', jobId: 'remote-job' }])
    })
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Accepted while another client generates'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="accepted-send-recovery"]')?.textContent).toContain(
        'acceptedSendGenerationInProgress',
      )
      expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy()
    })
    expect(textarea.value).toBe('')
    expect(
      Array.from(target.querySelectorAll('.risu-chat')).filter((row) =>
        row.textContent?.includes('Accepted while another client generates'),
      ),
    ).toHaveLength(1)
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(1)

    target.querySelector<HTMLButtonElement>('[data-testid="accepted-send-retry"]')!.click()
    await waitFor(() => {
      expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(2)
      expect(loadPageMocks.refreshActiveGenerationJobsFromBootstrap).toHaveBeenCalledTimes(2)
      expect(target.querySelector('[data-testid="accepted-send-recovery"]')?.textContent).toContain(
        'acceptedSendGenerationInProgress',
      )
    })
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-0', jobId: 'remote-job' }])

    activeGenerationJobs.set([])
    await settle()
    expect(target.querySelector('[data-testid="accepted-send-recovery"]')?.textContent).toContain(
      'acceptedSendGenerationInProgress',
    )
    expect(target.querySelector('[data-testid="default-chat-send-button"]')).toBeTruthy()
    expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(2)

    target.querySelector<HTMLButtonElement>('[data-testid="accepted-send-retry"]')!.click()
    await waitFor(() => {
      expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(3)
      expect(target.querySelector('[data-testid="accepted-send-recovery"]')).toBeNull()
    })
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1)
    expect(
      Array.from(target.querySelectorAll('.risu-chat')).filter((row) =>
        row.textContent?.includes('Accepted while another client generates'),
      ),
    ).toHaveLength(1)
  })

  it('shows an accessible exhausted observer alert and targets Retry, Refresh, and Stop to its exact job', async () => {
    seedDatabase([2, 2])
    activeGenerationJobs.set([
      { chatId: 'chat-0', jobId: 'job-dead' },
      { chatId: 'chat-1', jobId: 'job-other' },
    ])
    generationJobLifecycles.set({
      'job-dead': {
        chatId: 'chat-0',
        jobId: 'job-dead',
        status: 'exhausted-dead',
        reattachAttempts: 4,
        lastError: 'mobile connection lost',
        updatedAt: 1,
      },
      'job-other': {
        chatId: 'chat-1',
        jobId: 'job-other',
        status: 'exhausted-dead',
        reattachAttempts: 4,
        lastError: 'other chat error',
        updatedAt: 2,
      },
    })
    mountScreen()

    await waitFor(() => {
      const alert = target.querySelector<HTMLElement>('[data-testid="generation-reattach-failure"]')
      expect(alert).toBeTruthy()
      expect(alert?.getAttribute('role')).toBe('alert')
      expect(alert?.dataset.generationJobId).toBe('job-dead')
      expect(alert?.textContent).toContain('generationReattachMessage')
      expect(alert?.textContent).toContain('generationReattachLastError:mobile connection lost')
    })

    const composerStop = target.querySelector<HTMLElement>('[data-testid="default-chat-cancel-button"]')
    expect(composerStop?.getAttribute('aria-label')).toBe('Stop')
    expect(composerStop?.querySelector('.risu-ongoing-pulse')).toBeNull()

    target.querySelector<HTMLButtonElement>('[data-testid="generation-reattach-retry"]')!.click()
    await waitFor(() => expect(loadPageMocks.retryGenerationJobReattach).toHaveBeenCalledWith('job-dead'))
    await waitFor(() =>
      expect(target.querySelector<HTMLButtonElement>('[data-testid="generation-reattach-refresh"]')?.disabled).toBe(
        false,
      ),
    )

    target.querySelector<HTMLButtonElement>('[data-testid="generation-reattach-refresh"]')!.click()
    await waitFor(() => expect(loadPageMocks.refreshGenerationJobFromBootstrap).toHaveBeenCalledWith('job-dead'))
    await waitFor(() =>
      expect(target.querySelector<HTMLButtonElement>('[data-testid="generation-reattach-stop"]')?.disabled).toBe(false),
    )

    target.querySelector<HTMLButtonElement>('[data-testid="generation-reattach-stop"]')!.click()
    await waitFor(() => expect(loadPageMocks.stopGenerationJob).toHaveBeenCalledWith('job-dead'))

    expect(loadPageMocks.retryGenerationJobReattach).not.toHaveBeenCalledWith('job-other')
    expect(loadPageMocks.refreshGenerationJobFromBootstrap).not.toHaveBeenCalledWith('job-other')
    expect(loadPageMocks.stopGenerationJob).not.toHaveBeenCalledWith('job-other')
  })

  it('does not restore old text or files over a newer draft when a delayed append fails', async () => {
    seedDatabase([1])
    loadPageMocks.postChatFile.mockResolvedValueOnce([{ type: 'asset', data: 'asset-a' }])
    const append = createDeferred<AppendCurrentChatUserMessageResult>()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockReturnValueOnce(append.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Old draft with file'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickPostFileMenuItem()

    await waitFor(() => {
      expect(target.textContent).toContain('Missing file')
    })

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: 'Old draft with file{{inlayed::asset-a}}',
      }),
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )

    const removeFileButton = target.querySelector<HTMLButtonElement>('button[aria-label="remove: asset-a"]')
    expect(removeFileButton).toBeTruthy()
    removeFileButton!.click()
    textarea.value = 'Newer draft after removing file'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    append.resolve({ status: 'error', error: 'append failed' })

    await waitFor(() => {
      expect(loadPageMocks.alertError).toHaveBeenCalledWith('append failed')
    })

    expect(textarea.value).toBe('Newer draft after removing file')
    expect(target.textContent).not.toContain('Missing file')
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()
  })

  it('starts generation in another chat while the first chat generation remains pending', async () => {
    seedDatabase([1, 1])
    const firstSend = createDeferred<boolean>()
    const secondSend = createDeferred<boolean>()
    loadPageMocks.sendChat.mockReturnValueOnce(firstSend.promise).mockReturnValueOnce(secondSend.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'Generate from first chat'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )

    switchToCharacterChat(1)
    await settle()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'Generate from second chat'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    const secondSendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!
    expect(secondSendButton.disabled).toBe(false)
    secondSendButton.click()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(2))
    expect(loadPageMocks.sendChat).toHaveBeenLastCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(1) }),
    )

    secondSend.resolve(true)
    await settle()
    firstSend.resolve(true)
    await settle()
  })

  it('applies successful send effects to the captured chat after the active chat changes', async () => {
    seedDatabase([1, 1])
    const send = createDeferred<boolean>()
    loadPageMocks.sendChat.mockReturnValueOnce(send.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'Generate from first chat'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')
    expect(sendButton).toBeTruthy()
    sendButton!.click()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: 'Generate from first chat',
      }),
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )

    switchToCharacterChat(1)
    await settle()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'Visible second chat draft'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    send.resolve(true)
    await settle()

    expect(loadPageMocks.applySuccessfulSendChatEffects).toHaveBeenCalledWith(
      { sendSucceeded: true, previousLength: 1, confirmBoundary: true },
      expect.objectContaining({
        clearRerollBuffer: expect.any(Function),
        recordGeneratedReroll: expect.any(Function),
        markRerollChar: expect.any(Function),
      }),
    )
    const completionCalls = loadPageMocks.applySuccessfulSendChatEffects.mock.calls as unknown as Array<
      [unknown, SuccessfulSendChatEffects]
    >
    const effects = completionCalls[0][1]
    effects.clearRerollBuffer()
    effects.recordGeneratedReroll(1)
    effects.markRerollChar()
    expect(rerollNavigation.clearRerollBuffer).toHaveBeenCalledWith(expectedActiveTarget(0))
    expect(rerollNavigation.recordGeneratedReroll).toHaveBeenCalledWith(1, expectedActiveTarget(0))
    expect(rerollNavigation.markRerollChar).toHaveBeenCalledWith(expectedActiveTarget(0))
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
    expect(secondTextarea.value).toBe('Visible second chat draft')
  })

  it('keeps reroll completion effects owned by the originating chat after navigation', async () => {
    seedDatabase([2, 2])
    getResourceDatabase().sideMenuRerollButton = true
    const send = createDeferred<boolean>()
    loadPageMocks.sendChat.mockReturnValueOnce(send.promise)
    vi.mocked(rerollNavigation.reroll).mockImplementationOnce(async (deps) => {
      await deps.sendChatMain(false, 'message-1')
    })
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    await clickSideMenuRerollItem()
    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )

    switchToCharacterChat(1)
    await settle()
    send.resolve(true)
    await settle()

    expect(loadPageMocks.applySuccessfulSendChatEffects).toHaveBeenCalledWith(
      { sendSucceeded: true, previousLength: 2, confirmBoundary: false },
      expect.objectContaining({
        clearRerollBuffer: expect.any(Function),
        recordGeneratedReroll: expect.any(Function),
        markRerollChar: expect.any(Function),
      }),
    )
    const completionCalls = loadPageMocks.applySuccessfulSendChatEffects.mock.calls as unknown as Array<
      [unknown, SuccessfulSendChatEffects]
    >
    const effects = completionCalls[0][1]
    effects.recordGeneratedReroll(2)
    effects.markRerollChar()
    expect(rerollNavigation.clearRerollBuffer).not.toHaveBeenCalled()
    expect(rerollNavigation.recordGeneratedReroll).toHaveBeenCalledWith(2, expectedActiveTarget(0))
    expect(rerollNavigation.markRerollChar).toHaveBeenCalledWith(expectedActiveTarget(0))
  })

  it('does not clear newer typed text when continue waits for hydration', async () => {
    seedDatabase([2])
    const hydration = createDeferred<void>()
    loadPageMocks.hydrateActiveChatFully.mockReturnValueOnce(hydration.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!

    await clickContinueMenuItem()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))

    textarea.value = 'Newer draft typed during continue'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    hydration.resolve()

    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        continue: true,
        expectedTarget: expectedActiveTarget(0),
      }),
    )
    expect(textarea.value).toBe('Newer draft typed during continue')
  })

  it('consumes typed composer text as a user turn before continuing', async () => {
    seedDatabase([2])
    getResourceDatabase().useAutoTranslateInput = true
    loadPageMocks.postChatFile.mockResolvedValueOnce([{ type: 'asset', data: 'asset-a' }])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
      expect(target.querySelector('#messageInputTranslate')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const translation = target.querySelector<HTMLTextAreaElement>('#messageInputTranslate')!
    translation.value = 'Translated typed turn'
    translation.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    textarea.value = '/typed continue turn'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickPostFileMenuItem()
    await waitFor(() => expect(target.textContent).toContain('Missing file'))
    const sourceBeforeContinue = textarea.value
    loadPageMocks.processMultiCommand.mockClear()
    loadPageMocks.appendCurrentChatUserMessageForSend.mockClear()

    const continueMenuItem = findClickableByText('continueResponse')
    expect(continueMenuItem).toBeTruthy()
    continueMenuItem!.click()
    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))

    expect(textarea.value).toBe('')
    expect(translation.value).toBe('')
    expect(target.textContent).not.toContain('Missing file')
    expect(loadPageMocks.processMultiCommand).toHaveBeenCalledWith(sourceBeforeContinue)
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        data: `${sourceBeforeContinue}{{inlayed::asset-a}}`,
      }),
      expect.objectContaining({ expectedTarget: expectedActiveTarget(0) }),
    )
    expect(loadPageMocks.sendChat).toHaveBeenCalledWith(
      -1,
      expect.objectContaining({
        expectedTarget: expectedActiveTarget(0),
      }),
    )
    const sendArgs = loadPageMocks.sendChat.mock.calls[0]?.[1] as { continue?: boolean } | undefined
    expect(sendArgs?.continue).not.toBe(true)
  })

  it('does not call reroll navigation when the active chat changes during reroll hydration', async () => {
    seedDatabase([2, 2])
    getResourceDatabase().sideMenuRerollButton = true
    const hydration = createDeferred<void>()
    loadPageMocks.hydrateActiveChatFully.mockReturnValueOnce(hydration.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })

    await clickSideMenuRerollItem()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))

    selectedCharID.set(1)
    charactersResourceState.currentChar = 1
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-1/chat-1',
      chaId: 'character-1',
      chatId: 'chat-1',
    })
    await settle()
    hydration.resolve()
    await settle()

    expect(rerollNavigation.reroll).not.toHaveBeenCalled()
  })

  it('rejects reroll while a send preflight owns the hydration gate', async () => {
    seedDatabase([2])
    getResourceDatabase().sideMenuRerollButton = true
    const hydration = createDeferred<void>()
    loadPageMocks.hydrateActiveChatFully.mockReturnValueOnce(hydration.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Send owns preflight'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    const sendButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!
    sendButton.focus()
    sendButton.click()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))
    const preparingButton = target.querySelector<HTMLButtonElement>('[data-testid="default-chat-preparing-button"]')
    expect(preparingButton).toBe(sendButton)
    expect(document.activeElement).toBe(sendButton)
    expect(preparingButton?.disabled).toBe(false)
    expect(preparingButton?.getAttribute('aria-disabled')).toBe('true')
    expect(preparingButton?.getAttribute('aria-busy')).toBe('true')
    expect(preparingButton?.textContent).toBe('')
    expect(preparingButton?.querySelector('svg.animate-spin')).toBeTruthy()
    expect(preparingButton?.classList).toContain('w-12')
    expect(preparingButton?.classList).toContain('shrink-0')
    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()

    await clickSideMenuRerollItem()
    await settle()

    expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1)
    expect(rerollNavigation.reroll).not.toHaveBeenCalled()

    hydration.resolve()
    await waitFor(() => expect(loadPageMocks.sendChat).toHaveBeenCalledTimes(1))
  })

  it('rejects send while a reroll preflight owns the hydration gate', async () => {
    seedDatabase([2])
    getResourceDatabase().sideMenuRerollButton = true
    const hydration = createDeferred<void>()
    loadPageMocks.hydrateActiveChatFully.mockReturnValueOnce(hydration.promise)
    mountScreen()

    await waitFor(() => expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy())
    await clickSideMenuRerollItem()
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))

    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Blocked by reroll preflight'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()
    await settle()

    expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1)
    expect(loadPageMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(loadPageMocks.sendChat).not.toHaveBeenCalled()

    hydration.resolve()
    await waitFor(() => expect(rerollNavigation.reroll).toHaveBeenCalledTimes(1))
  })

  it('does not let a stale auto-translate result overwrite newer source or target fields', async () => {
    seedDatabase([1])
    getResourceDatabase().useAutoTranslateInput = true
    const firstTranslation = createDeferred<string>()
    const pendingTranslation = new Promise<string>(() => undefined)
    const translateMock = vi.mocked(translate)
    translateMock.mockImplementationOnce(() => firstTranslation.promise)
    translateMock.mockImplementation(() => pendingTranslation)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
      expect(target.querySelector('#messageInputTranslate')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    const translateTextarea = target.querySelector<HTMLTextAreaElement>('#messageInputTranslate')!

    textarea.value = 'Original source'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => expect(translateMock).toHaveBeenCalledWith('Original source', false))

    translateTextarea.value = 'Manual target'
    translateTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    textarea.value = 'Newer source'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    firstTranslation.resolve('Stale translated source')
    await settle()

    expect(textarea.value).toBe('Newer source')
    expect(translateTextarea.value).toBe('Manual target')
  })

  it('sends from the translated composer with Shift+Enter when Enter-to-send is disabled', async () => {
    seedDatabase([1])
    getResourceDatabase().useAutoTranslateInput = true
    getResourceDatabase().sendWithEnter = false
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('#messageInputTranslate')).toBeTruthy()
    })
    loadPageMocks.hydrateActiveChatFully.mockClear()

    const translateTextarea = target.querySelector<HTMLTextAreaElement>('#messageInputTranslate')!
    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    translateTextarea.dispatchEvent(keydown)

    expect(keydown.defaultPrevented).toBe(true)
    await waitFor(() => expect(loadPageMocks.hydrateActiveChatFully).toHaveBeenCalledTimes(1))
  })

  it('does not send from the translated composer while Enter is committing IME composition', async () => {
    seedDatabase([1])
    getResourceDatabase().useAutoTranslateInput = true
    getResourceDatabase().sendWithEnter = true
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('#messageInputTranslate')).toBeTruthy()
    })
    loadPageMocks.hydrateActiveChatFully.mockClear()

    const translateTextarea = target.querySelector<HTMLTextAreaElement>('#messageInputTranslate')!
    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    translateTextarea.dispatchEvent(keydown)
    await settle()

    expect(keydown.defaultPrevented).toBe(false)
    expect(loadPageMocks.hydrateActiveChatFully).not.toHaveBeenCalled()
  })

  it('merges a delayed menu file result into newer composer text', async () => {
    seedDatabase([1])
    const upload =
      createDeferred<Array<{ type: 'asset'; data: string } | { type: 'text'; name: string; data: string }>>()
    loadPageMocks.postChatFile.mockReturnValueOnce(upload.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Draft before file'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickPostFileMenuItem()
    await waitFor(() => expect(loadPageMocks.postChatFile).toHaveBeenCalledWith('Draft before file'))

    textarea.value = 'Newer draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    upload.resolve([
      { type: 'asset', data: 'uploaded-asset' },
      { type: 'text', name: 'uploaded.txt', data: 'uploaded-text' },
    ])
    await settle()

    expect(textarea.value).toBe('Newer draft{{file::uploaded.txt::uploaded-text}}')
    expect(target.querySelector('button[aria-label="remove: uploaded-asset"]')).toBeTruthy()
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
  })

  it('ignores a delayed menu file result after the active chat changes', async () => {
    seedDatabase([1, 1])
    const upload =
      createDeferred<Array<{ type: 'asset'; data: string } | { type: 'text'; name: string; data: string }>>()
    loadPageMocks.postChatFile.mockReturnValueOnce(upload.promise)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'First chat draft'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickPostFileMenuItem()
    await waitFor(() => expect(loadPageMocks.postChatFile).toHaveBeenCalledWith('First chat draft'))

    selectedCharID.set(1)
    charactersResourceState.currentChar = 1
    loadPageMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-1/chat-1',
      chaId: 'character-1',
      chatId: 'chat-1',
    })
    await settle()
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    upload.resolve([
      { type: 'asset', data: 'other-chat-asset' },
      { type: 'text', name: 'other-chat.txt', data: 'other-chat-text' },
    ])
    await settle()

    expect(secondTextarea.value).toBe('')
    expect(secondTextarea.value).not.toContain('other-chat.txt')
    expect(loadPageMocks.alertError).toHaveBeenCalledWith('composerFileResultDiscarded')
  })

  it('keeps composer drafts scoped to their chat', async () => {
    seedDatabase([1, 1])
    const draftHook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'draft' }
    const btwHook = { id: 'btw-hook', name: 'BTW Hook', type: 'btw' as const, prompt: 'btw' }
    getResourceDatabase().inputHooks = [draftHook, btwHook]
    getResourceDatabase().characters[0].chats[0].selectedDraftHookId = draftHook.id
    getResourceDatabase().characters[1].chats[0].selectedDraftHookId = draftHook.id
    vi.mocked(runInputHook).mockResolvedValueOnce('First BTW').mockResolvedValueOnce('Second BTW')
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const firstTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    firstTextarea.value = 'First chat draft'
    firstTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    const firstHookDraft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    firstHookDraft.value = 'First hook draft'
    firstHookDraft.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-btw-button"]')!.click()
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-input-hook-option-btw-hook"]')!.click()
    await waitFor(() =>
      expect(target.querySelector('[data-testid="default-chat-btw-result"]')?.textContent).toContain('First BTW'),
    )

    switchToCharacterChat(1)
    await waitFor(() => {
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')?.value).toBe('')
    })
    const secondTextarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    secondTextarea.value = 'Second chat draft'
    secondTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    const secondHookDraft = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')!
    secondHookDraft.value = 'Second hook draft'
    secondHookDraft.dispatchEvent(new Event('input', { bubbles: true }))
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-btw-button"]')!.click()
    await tick()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-input-hook-option-btw-hook"]')!.click()
    await waitFor(() =>
      expect(target.querySelector('[data-testid="default-chat-btw-result"]')?.textContent).toContain('Second BTW'),
    )

    switchToCharacterChat(0)
    await waitFor(() => {
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')?.value).toBe(
        'First chat draft',
      )
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')?.value).toBe(
        'First hook draft',
      )
      expect(target.querySelector('[data-testid="default-chat-btw-result"]')?.textContent).toContain('First BTW')
    })

    switchToCharacterChat(1)
    await waitFor(() => {
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')?.value).toBe(
        'Second chat draft',
      )
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-draft-input"]')?.value).toBe(
        'Second hook draft',
      )
      expect(target.querySelector('[data-testid="default-chat-btw-result"]')?.textContent).toContain('Second BTW')
    })
  })

  it('restores composer text and selected files after a fresh runtime reload', async () => {
    seedDatabase([1])
    loadPageMocks.postChatFile.mockResolvedValueOnce([{ type: 'asset', data: 'asset-a' }])
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Draft that survives a full-screen route'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await clickPostFileMenuItem()

    await waitFor(() => {
      expect(target.querySelector('button[aria-label="remove: asset-a"]')).toBeTruthy()
    })

    unmount(component!)
    component = undefined
    resetDefaultChatComposerDraftRuntimeForTests()
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')?.value).toBe(
        'Draft that survives a full-screen route',
      )
      expect(target.querySelector('button[aria-label="remove: asset-a"]')).toBeTruthy()
    })
  })

  it('merges a delayed pasted image result into newer composer text', async () => {
    seedDatabase([1])
    const upload =
      createDeferred<Array<{ type: 'asset'; data: string } | { type: 'text'; name: string; data: string }>>()
    loadPageMocks.postChatFile.mockReturnValueOnce(upload.promise)
    const imageBytes = new Uint8Array([1, 2, 3])
    class MockFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      error: Error | null = null

      readAsArrayBuffer() {
        setTimeout(() => {
          this.onload?.({
            target: { result: imageBytes.buffer },
          } as ProgressEvent<FileReader>)
        }, 0)
      }
    }
    vi.stubGlobal('FileReader', MockFileReader as unknown as typeof FileReader)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Paste before file'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const pastedFile = new File([imageBytes], 'pasted.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => pastedFile,
          },
        ],
      },
    })
    textarea.dispatchEvent(pasteEvent)
    await waitFor(() =>
      expect(loadPageMocks.postChatFile).toHaveBeenCalledWith({
        name: 'pasted.png',
        data: imageBytes,
      }),
    )

    textarea.value = 'Newer paste draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    upload.resolve([
      { type: 'asset', data: 'pasted-asset' },
      { type: 'text', name: 'pasted.txt', data: 'pasted-text' },
    ])
    await settle()

    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('Newer paste draft{{file::pasted.txt::pasted-text}}')
    expect(target.querySelector('button[aria-label="remove: pasted-asset"]')).toBeTruthy()
    expect(loadPageMocks.alertError).not.toHaveBeenCalled()
  })

  it('reports a pasted image upload failure while the composer is still current', async () => {
    seedDatabase([1])
    const uploadError = new Error('pasted image upload failed')
    loadPageMocks.postChatFile.mockRejectedValueOnce(uploadError)
    const imageBytes = new Uint8Array([7, 8, 9])
    class MockFileReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      error: Error | null = null

      readAsArrayBuffer() {
        queueMicrotask(() => {
          this.onload?.({
            target: { result: imageBytes.buffer },
          } as ProgressEvent<FileReader>)
        })
      }
    }
    vi.stubGlobal('FileReader', MockFileReader as unknown as typeof FileReader)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Keep this draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    const pastedFile = new File([imageBytes], 'broken.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => pastedFile,
          },
        ],
      },
    })
    textarea.dispatchEvent(pasteEvent)

    await waitFor(() => expect(loadPageMocks.alertError).toHaveBeenCalledWith(uploadError))
    expect(pasteEvent.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('Keep this draft')
  })

  it('reports a menu attachment upload failure while the composer is still current', async () => {
    seedDatabase([1])
    const uploadError = new Error('menu attachment upload failed')
    loadPageMocks.postChatFile.mockRejectedValueOnce(uploadError)
    mountScreen()

    await waitFor(() => {
      expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    })
    const textarea = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    textarea.value = 'Keep this menu draft'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickPostFileMenuItem()

    await waitFor(() => expect(loadPageMocks.alertError).toHaveBeenCalledWith(uploadError))
    expect(loadPageMocks.postChatFile).toHaveBeenCalledWith('Keep this menu draft')
    expect(textarea.value).toBe('Keep this menu draft')
  })
})
