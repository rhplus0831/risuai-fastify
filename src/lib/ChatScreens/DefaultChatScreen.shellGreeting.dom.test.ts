// Regression coverage for lazy bootstrap character shells. A shell is a valid
// intermediate projection state, so the chat screen must render it without
// evaluating greeting fields until the selected character is hydrated. The
// hydrated control case proves the greeting still paints after hydration.

import { mount, tick, unmount } from 'svelte'
import { _setPluginRuntimePhaseForTesting } from 'src/ts/plugins/plugins.svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TestStore<T> {
  set(value: T): void
  subscribe(run: (value: T) => void): () => void
}

const shellMocks = vi.hoisted(() => ({
  abortActiveGeneration: vi.fn(),
  captureActiveChatTarget: vi.fn(
    () => null as { selectedCharID: number; chatPage: number; characterId: string; chatId: string } | null,
  ),
  activeChatGenerations: undefined as TestStore<Array<Record<string, unknown>>> | undefined,
  activeGenerationJobs: undefined as TestStore<Array<Record<string, unknown>>> | undefined,
  activeGenerationTarget: undefined as TestStore<Record<string, unknown> | null> | undefined,
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertWait: vi.fn(),
  appendCurrentChatEmptyCharMessage: vi.fn(),
  appendCurrentChatUserMessageForSend: vi.fn(async () => ({ status: 'ok' })),
  applySuccessfulSendChatEffects: vi.fn(() => true),
  chatFoldedState: { data: null as null | Record<string, string> },
  chatFoldedStateMessageIndex: { index: -1 },
  chatProcessStage: undefined as TestStore<number> | undefined,
  clearActiveGenerationAbortController: vi.fn(),
  createActiveGenerationAbortController: vi.fn(() => ({ signal: new AbortController().signal })),
  doingChat: undefined as TestStore<boolean> | undefined,
  downloadFile: vi.fn(async () => undefined),
  getCharImage: vi.fn(() => ''),
  getInlayAsset: vi.fn(async () => null),
  postChatFile: vi.fn(async () => []),
  processMultiCommand: vi.fn(async () => false),
  sendChat: vi.fn(async () => true),
  sleep: vi.fn(async () => undefined),
  guardActiveChatGenerationSettingsForSend: vi.fn(() => ({ status: 'ok' })),
  hydrateActiveChat: vi.fn(async () => undefined),
  hydrateActiveChatFully: vi.fn(async () => undefined),
  hydrateActiveChatWindow: vi.fn(async () => undefined),
  hydrationFailed: false,
  hydrationPending: false,
  currentRouteSubscribers: new Set<(value: unknown) => void>(),
  currentRouteValue: {
    kind: 'character',
    path: '/character/character-0/chat-0',
    chaId: 'character-0',
    chatId: 'chat-0',
  } as unknown,
  setCurrentRoute(value: unknown) {
    shellMocks.currentRouteValue = value
    shellMocks.currentRouteSubscribers.forEach((run) => run(value))
  },
  toCanvas: vi.fn(),
}))

vi.mock('./Chat.svelte', async () => {
  // A faithful stub that READS altGreeting/totalPages/currentPage the way the
  // real Chat.svelte does (Svelte 5 props are lazy — a stub that ignores them
  // would never trigger the unguarded parent expression). See the stub file.
  const mock = await import('./DefaultChatScreen.shellGreetingStub.svelte')
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
      get: (_t, property) =>
        property === 'connectedReaders'
          ? {
              messageDraft: 'Message draft',
              draftInput: 'Draft',
              btwInput: 'BTW',
              attachments: 'Attachments',
              composerDraft: 'Composer draft',
            }
          : String(property),
    },
  ),
}))

vi.mock('../../ts/characters', () => ({ getCharImage: shellMocks.getCharImage }))
vi.mock('src/ts/characters', () => ({ getCharImage: shellMocks.getCharImage }))

vi.mock('../../ts/util', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/util')>()
  return { ...actual, sleep: shellMocks.sleep }
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

vi.mock('../../ts/process/scripts', () => ({ resetScriptCache: vi.fn() }))
vi.mock('src/ts/process/scripts', () => ({ resetScriptCache: vi.fn() }))

vi.mock('../../ts/alert', () => ({
  alertError: shellMocks.alertError,
  alertNormal: shellMocks.alertNormal,
  alertWait: shellMocks.alertWait,
}))

vi.mock('src/ts/process/index.svelte', async () => {
  const { writable } = await import('svelte/store')
  shellMocks.activeGenerationTarget ??= writable(null)
  shellMocks.chatProcessStage ??= writable(0)
  shellMocks.doingChat ??= writable(false)
  return {
    abortActiveGeneration: shellMocks.abortActiveGeneration,
    activeGenerationTarget: shellMocks.activeGenerationTarget,
    chatProcessStage: shellMocks.chatProcessStage,
    clearActiveGenerationAbortController: shellMocks.clearActiveGenerationAbortController,
    createActiveGenerationAbortController: shellMocks.createActiveGenerationAbortController,
    doingChat: shellMocks.doingChat,
    sendChat: shellMocks.sendChat,
  }
})

vi.mock('src/ts/process/generationActivity.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/process/generationActivity.svelte')>()
  const { writable } = await import('svelte/store')
  shellMocks.activeChatGenerations ??= writable([])
  return { ...actual, activeChatGenerations: shellMocks.activeChatGenerations }
})

vi.mock('src/ts/process/reattach', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/process/reattach')>()
  const { writable } = await import('svelte/store')
  shellMocks.activeGenerationJobs ??= writable([])
  return { ...actual, activeGenerationJobs: shellMocks.activeGenerationJobs }
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

vi.mock('src/ts/process/command', () => ({ processMultiCommand: shellMocks.processMultiCommand }))
vi.mock('src/ts/process/files/multisend', () => ({ postChatFile: shellMocks.postChatFile }))
vi.mock('src/ts/process/files/inlays', () => ({ getInlayAsset: shellMocks.getInlayAsset }))
vi.mock('src/ts/process/sendChatCompletion', () => ({
  applySuccessfulSendChatEffects: shellMocks.applySuccessfulSendChatEffects,
}))
vi.mock('src/ts/process/coldstorage.svelte', () => ({
  coldStorageHeader: 'cold-storage:',
  preLoadChat: vi.fn(async () => true),
}))
vi.mock('src/ts/process/tts', () => ({ stopTTS: vi.fn() }))

vi.mock('src/ts/chatCommands', () => ({
  appendCurrentChatEmptyCharMessage: shellMocks.appendCurrentChatEmptyCharMessage,
  appendCurrentChatUserMessageForSend: shellMocks.appendCurrentChatUserMessageForSend,
  captureActiveChatTarget: shellMocks.captureActiveChatTarget,
  isActiveChatTargetFresh: (target: unknown) => target === shellMocks.captureActiveChatTarget(),
  cloneJsonValue: <T>(value: T) => JSON.parse(JSON.stringify(value)) as T,
  currentChatScopedSnapshot: vi.fn(() => ({ before: 'chat-scoped' })),
  currentChatStateSnapshot: vi.fn(() => ({ before: 'chat-state' })),
  dispatchReplaceMessagesScoped: vi.fn(),
  dispatchSaveChatGenerationSettings: vi.fn(() => true),
  dispatchUpdateChat: vi.fn(),
}))

vi.mock('src/ts/activeChatGenerationSettings', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/activeChatGenerationSettings')>()
  return { ...actual, guardActiveChatGenerationSettingsForSend: shellMocks.guardActiveChatGenerationSettingsForSend }
})

vi.mock('src/ts/server/settingsOwner.svelte', () => ({ applyServerBackedSetting: vi.fn() }))
vi.mock('src/ts/server/chatMessageHydration.svelte', () => ({
  applyServerChatMessagesResource: vi.fn(),
  getChatMessageOwnerState: () => undefined,
  hasChatMessageHydrationFailed: () => shellMocks.hydrationFailed,
  hydrateActiveChat: shellMocks.hydrateActiveChat,
  hydrateActiveChatFully: shellMocks.hydrateActiveChatFully,
  hydrateActiveChatWindow: shellMocks.hydrateActiveChatWindow,
  isChatMessageHydrationPending: () => shellMocks.hydrationPending,
}))

vi.mock('src/ts/router', () => ({
  currentRoute: {
    subscribe(run: (value: unknown) => void) {
      run(shellMocks.currentRouteValue)
      shellMocks.currentRouteSubscribers.add(run)
      return () => {
        shellMocks.currentRouteSubscribers.delete(run)
      }
    },
  },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  aiLawApplies: () => false,
  chatFoldedState: shellMocks.chatFoldedState,
  chatFoldedStateMessageIndex: shellMocks.chatFoldedStateMessageIndex,
  downloadFile: shellMocks.downloadFile,
  saveAsset: vi.fn(async () => ''),
}))

vi.mock('html-to-image', () => ({ toCanvas: shellMocks.toCanvas }))

import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import { clearDefaultChatComposerDrafts } from './DefaultChatScreen.composerDrafts'
import DefaultChatScreen from './DefaultChatScreen.svelte'
import { PlaygroundStore, ScrollToMessageStore, selectedCharID } from 'src/ts/stores.svelte'
import { charactersResourceState, replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'
import { isServerCharacterShell, SERVER_CHARACTER_SHELL_MARKER, type Database } from 'src/ts/storage/database.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

let target: HTMLElement
let component: MountedComponent | undefined

// A faithful bootstrap shell as the server character resource ships it for an inactive
// character: marker set, chat metadata kept with empty messages, but
// alternateGreetings/firstMessage stripped (NOT in BOOTSTRAP_CHARACTER_SHELL_FIELDS).
function makeBootstrapShellCharacter() {
  return {
    [SERVER_CHARACTER_SHELL_MARKER]: true,
    chaId: 'character-0',
    name: 'Shell Character',
    type: 'character',
    image: '',
    chatPage: 0,
    chatFolders: [],
    creatorNotes: '',
    tags: [],
    largePortrait: false,
    viewScreen: 'none',
    ttsMode: 'none',
    removedQuotes: false,
    chats: [
      {
        id: 'chat-0',
        name: 'Chat 0',
        note: '',
        fmIndex: -1,
        localLore: [],
        message: [],
        bookmarks: [],
        bookmarkNames: {},
      },
    ],
    // NOTE: no `alternateGreetings`, no `firstMessage` — stripped on a shell.
  }
}

// The same character after hydration completes (the full character resource row
// on character-row hydration): alternateGreetings/firstMessage present.
function makeHydratedCharacter() {
  return {
    ...makeBootstrapShellCharacter(),
    [SERVER_CHARACTER_SHELL_MARKER]: undefined,
    firstMessage: 'Greeting from a hydrated character',
    alternateGreetings: [],
  }
}

function makeHydratedCharacterWithTwoChats() {
  const character = makeHydratedCharacter()
  return {
    ...character,
    chats: [
      character.chats[0],
      {
        ...character.chats[0],
        id: 'chat-1',
        name: 'Chat 1',
        message: [],
      },
    ],
  }
}

function seedDatabase(character: Record<string, unknown>) {
  selectedCharID.set(0)
  shellMocks.setCurrentRoute({
    kind: 'character',
    path: '/character/character-0/chat-0',
    chaId: 'character-0',
    chatId: 'chat-0',
  })
  PlaygroundStore.set(0)
  ScrollToMessageStore.value = -1
  replaceResourceDatabase({
    aiModel: '',
    alwaysScrollToNewMessage: false,
    autoScrollToNewMessage: false,
    characters: [character],
    currentChar: 0,
    chatDisplayTailCount: 30,
    enableRisuaiProTools: false,
    fixedChatTextarea: false,
    hypaV3: false,
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
}

function tryMount(): unknown {
  try {
    component = mount(DefaultChatScreen, { target })
    return null
  } catch (error) {
    return error
  }
}

function greetingBubble(): HTMLElement | null {
  return target.querySelector<HTMLElement>('.risu-chat[data-chat-index="-1"]')
}

beforeEach(() => {
  _setPluginRuntimePhaseForTesting('ready')
  shellMocks.captureActiveChatTarget.mockReturnValue(null)
  shellMocks.hydrateActiveChat.mockClear()
  shellMocks.hydrationFailed = false
  shellMocks.hydrationPending = false
  shellMocks.activeGenerationTarget!.set(null)
  shellMocks.activeChatGenerations!.set([])
  shellMocks.activeGenerationJobs!.set([])
  shellMocks.doingChat!.set(false)
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(async () => {
  if (component) {
    try {
      unmount(component)
    } catch {}
    component = undefined
  }
  await endWriterDraftCaptureTest()
  clearDefaultChatComposerDrafts()
  target.remove()
  document.body.innerHTML = ''
  selectedCharID.set(-1)
  replaceResourceDatabase({} as never)
})

describe('bootstrap shell greeting render (DOM oracle)', () => {
  it('paints the greeting bubble once the character is hydrated (correct-store control)', async () => {
    seedDatabase(makeHydratedCharacter())
    const error = tryMount()
    await tick()

    expect(error, 'hydrated character must not throw on render').toBeNull()
    const bubble = greetingBubble()
    expect(bubble, 'greeting bubble for a hydrated character').toBeTruthy()
    expect(bubble!.textContent).toContain('Greeting from a hydrated character')
  })

  // A correct bootstrap shell renders no greeting until hydration fills the
  // greeting fields, and it must not crash while those fields are absent.
  it('renders a bootstrap shell without crashing on alternateGreetings.length', async () => {
    seedDatabase(makeBootstrapShellCharacter())

    // The store is in its CORRECT lazy-shell state (not a wrong value): this is
    // what makes the divergence in-scope rather than a logic bug.
    expect(isServerCharacterShell(getResourceDatabase().characters[0])).toBe(true)
    expect(
      (getResourceDatabase().characters[0] as unknown as Record<string, unknown>).alternateGreetings,
    ).toBeUndefined()

    const error = tryMount()
    await tick()

    // The render must not throw on the correct shell state...
    expect(error, `shell render threw: ${String(error)}`).toBeNull()
    // ...and the greeting bubble must be suppressed until hydration lands (no
    // complete-but-empty greeting painted for a shell).
    expect(greetingBubble(), 'greeting bubble must be absent for an un-hydrated shell').toBeNull()
  })

  it('fails closed when the ready projection has no selected owner', async () => {
    seedDatabase(makeHydratedCharacter())
    charactersResourceState.currentChar = 99

    const error = tryMount()
    await tick()

    expect(error).toBeNull()
    expect(greetingBubble()).toBeNull()
  })

  it('fails closed when the ready projection has duplicate selected owners', async () => {
    const character = makeHydratedCharacter()
    seedDatabase(character)
    charactersResourceState.characters = [character as never, structuredClone(character) as never]

    const error = tryMount()
    await tick()

    expect(error).toBeNull()
    expect(greetingBubble()).toBeNull()
  })
})

describe('chat history hydration failure', () => {
  it('replaces the empty transcript with an actionable retry state', async () => {
    shellMocks.hydrationFailed = true
    seedDatabase(makeHydratedCharacter())

    const error = tryMount()
    await tick()

    expect(error).toBeNull()
    const failure = target.querySelector<HTMLElement>('[data-testid="chat-hydration-error"]')
    expect(failure?.textContent).toContain('chatDataLoadFailed')
    expect(failure?.textContent).toContain('retry')

    failure?.querySelector<HTMLButtonElement>('button')?.click()
    await tick()

    expect(shellMocks.hydrateActiveChat).toHaveBeenCalledWith({ force: true })
  })
})

describe('chat history hydration loading', () => {
  it('keeps the composer mounted while showing message-shaped transcript placeholders', async () => {
    shellMocks.hydrationPending = true
    seedDatabase(makeHydratedCharacter())

    const error = tryMount()
    await tick()

    expect(error).toBeNull()
    const skeleton = target.querySelector<HTMLElement>('[data-chat-message-skeleton]')
    expect(skeleton).toBeTruthy()
    expect(skeleton?.getAttribute('role')).toBe('status')
    expect(skeleton?.getAttribute('aria-busy')).toBe('true')
    expect(skeleton?.getAttribute('data-chat-loading-mode')).toBe('hydration')
    expect(skeleton?.textContent).toContain('loadingChat')
    expect(skeleton?.querySelectorAll('[data-chat-skeleton-row]')).toHaveLength(3)
    expect(target.querySelector('[data-testid="default-chat-composer"]')).toBeTruthy()
    expect(skeleton?.contains(target.querySelector('[data-testid="default-chat-composer"]'))).toBe(false)
    expect(target.querySelector('[data-testid="chat-display-loading"]')).toBeNull()
  })
})

describe('playground character creation reconciliation', () => {
  it('renders the transient empty state while the first-created playground character has no local chat', async () => {
    seedDatabase({
      ...makeHydratedCharacter(),
      chaId: '§playground',
      name: 'assistant',
      chatPage: 0,
      chats: [],
    })
    shellMocks.setCurrentRoute({ kind: 'playground', path: '/playground/chat', page: 2 })
    PlaygroundStore.set(2)

    const error = tryMount()
    await tick()

    expect(error, `playground create reconciliation threw: ${String(error)}`).toBeNull()
    expect(target.querySelector('[data-risu-chat-empty-state]')).toBeTruthy()
  })
})

describe('generation control ownership', () => {
  it('shows the abort control only on its owner while another chat remains sendable', async () => {
    const stream = deferred<void>()
    seedDatabase(makeHydratedCharacterWithTwoChats())
    shellMocks.activeGenerationTarget!.set({
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'character-0',
      chatId: 'chat-0',
    })
    shellMocks.doingChat!.set(true)
    shellMocks.activeChatGenerations!.set([
      {
        id: 1,
        targetKey: 'chat:chat-0',
        target: { selectedCharID: 0, chatPage: 0, characterId: 'character-0', chatId: 'chat-0' },
        characterId: 'character-0',
        chatId: 'chat-0',
        stage: 3,
        kind: 'message',
      },
    ])
    const settleStream = stream.promise.finally(() => {
      shellMocks.doingChat!.set(false)
      shellMocks.activeGenerationTarget!.set(null)
      shellMocks.activeChatGenerations!.set([])
    })

    const error = tryMount()
    await tick()

    expect(error).toBeNull()
    expect(target.querySelector('[data-testid="default-chat-cancel-button"] .risu-ongoing-pulse.loadmove')).toBeTruthy()

    getResourceDatabase().characters[0].chatPage = 1
    shellMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-0/chat-1',
      chaId: 'character-0',
      chatId: 'chat-1',
    })
    await tick()

    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeNull()
    expect(target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')?.disabled).toBe(false)

    getResourceDatabase().characters[0].chatPage = 0
    shellMocks.setCurrentRoute({
      kind: 'character',
      path: '/character/character-0/chat-0',
      chaId: 'character-0',
      chatId: 'chat-0',
    })
    await tick()

    expect(target.querySelector('[data-testid="default-chat-cancel-button"]')).toBeTruthy()

    stream.resolve(undefined)
    await settleStream
    await tick()

    expect(target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')?.disabled).toBe(false)
  })
})

describe('composer writer loss', () => {
  it('retains text typed immediately before demotion and prevents an old hydration preflight from sending after promotion', async () => {
    await beginWriterDraftCaptureTest()
    seedDatabase(makeHydratedCharacter())
    expect(tryMount()).toBeNull()
    await tick()
    const input = target.querySelector<HTMLTextAreaElement>('[data-testid="default-chat-composer"]')!
    expect(input).not.toBeNull()
    input.value = 'message waiting for hydration'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    shellMocks.captureActiveChatTarget.mockReturnValue({
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'character-0',
      chatId: 'chat-0',
    })
    const hydration = deferred<void>()
    shellMocks.hydrateActiveChatFully.mockImplementationOnce(() => hydration.promise)
    shellMocks.appendCurrentChatUserMessageForSend.mockClear()
    shellMocks.sendChat.mockClear()
    target.querySelector<HTMLButtonElement>('[data-testid="default-chat-send-button"]')!.click()
    expect(shellMocks.hydrateActiveChatFully).toHaveBeenCalled()
    input.value = 'newer unsent text before demotion'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        fields: [expect.objectContaining({ value: 'newer unsent text before demotion' })],
        data: expect.objectContaining({ messageInput: 'newer unsent text before demotion' }),
      }),
    ])
    repromoteClientWriter()
    hydration.resolve()
    await tick()
    await tick()
    expect(shellMocks.appendCurrentChatUserMessageForSend).not.toHaveBeenCalled()
    expect(shellMocks.sendChat).not.toHaveBeenCalled()
    expect(input.value).toBe('newer unsent text before demotion')
    unmount(component!)
    component = undefined
    expect(capturedWriterDrafts()[0].fields[0].value).toBe('newer unsent text before demotion')
  })
})
