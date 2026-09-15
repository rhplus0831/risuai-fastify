import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { selectedCharID } from '../stores.svelte'

// Terminal assistant lookup scans newest-to-oldest without copying the transcript.

vi.mock('../platform', async (importActual) => {
  const actual = await importActual<typeof import('../platform')>()
  return { ...actual, isFastifyServer: true }
})

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'findmessage-token',
}))

vi.mock('./modules', async (importActual) => {
  const actual = await importActual<typeof import('./modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

const inlayMock = vi.hoisted(() => ({
  run: vi.fn(
    (
      _character: unknown,
      data: string,
      _options?: {
        signal?: AbortSignal
        settlePostProvider?: <T>(settle: (signal: AbortSignal) => Promise<T>) => Promise<T>
      },
    ) => ({ text: data }) as { text: string; promise?: Promise<string> },
  ),
  renderWithoutProviders: vi.fn((_character: unknown, data: string) => data),
  requiresFinalization: vi.fn((_character: unknown, data: string) => /<(?:ImgGen|Emotion)=/.test(data)),
}))
const inlayFinalizationMock = vi.hoisted(() => ({
  prepare: vi.fn<(input: { preparationId: string }) => Promise<boolean>>(async () => true),
  finalize: vi.fn<(input: { preparationId: string }) => Promise<boolean>>(async () => true),
  abandon: vi.fn<(input: { preparationId: string }) => Promise<boolean>>(async () => true),
}))
const ttsMock = vi.hoisted(() => ({
  say: vi.fn(async () => {}),
}))
const hydrationMock = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {}),
}))
const occupancyMock = vi.hoisted(() => ({
  current: true,
  recover: vi.fn(),
  listeners: new Set<() => void>(),
  occupancies: [] as Array<Record<string, unknown>>,
}))
const chatCommandsMock = vi.hoisted(() => ({
  updateMessage: vi.fn(async () => ({ status: 'accepted', result: { status: 'ok' } })),
}))

vi.mock('./inlayScreen', () => ({
  runInlayScreen: inlayMock.run,
  renderInlayScreenTextWithoutProviders: inlayMock.renderWithoutProviders,
  inlayScreenRequiresFinalization: inlayMock.requiresFinalization,
}))

vi.mock('./inlayFinalization', () => ({
  prepareServerBackedInlayMessage: inlayFinalizationMock.prepare,
  finalizeServerBackedInlayMessage: inlayFinalizationMock.finalize,
  abandonServerBackedInlayMessage: inlayFinalizationMock.abandon,
}))

vi.mock('../chatCommands', async (importActual) => {
  const actual = await importActual<typeof import('../chatCommands')>()
  return { ...actual, dispatchUpdateMessageScoped: chatCommandsMock.updateMessage }
})

vi.mock('../server/chatOccupancy', async (importActual) => {
  const actual = await importActual<typeof import('../server/chatOccupancy')>()
  return {
    ...actual,
    clientChatOccupancyStore: {
      subscribe: (listener: () => void) => {
        occupancyMock.listeners.add(listener)
        listener()
        return () => occupancyMock.listeners.delete(listener)
      },
    },
    getClientChatOccupancySnapshot: () => ({ occupancies: occupancyMock.occupancies }),
    isClientChatOccupancyAuthorityCurrent: () => occupancyMock.current,
    requestClientChatOccupancyRecovery: occupancyMock.recover,
  }
})

vi.mock('./generationEffectLedger', async (importActual) => {
  const actual = await importActual<typeof import('./generationEffectLedger')>()
  return {
    ...actual,
    runLedgeredGenerationEffect: async (
      _ref: unknown,
      _effect: unknown,
      _source: unknown,
      run: (context: { isCurrent: () => boolean }) => unknown,
    ) => run({ isCurrent: () => true }),
  }
})

vi.mock('./tts', () => ({
  sayTTS: ttsMock.say,
}))

vi.mock('../server/chatMessageHydration.svelte', async (importActual) => {
  const actual = await importActual<typeof import('../server/chatMessageHydration.svelte')>()
  return { ...actual, hydrateChatMessages: hydrationMock.hydrate }
})

import {
  applyServerBackedTerminal,
  captureServerBackedRestorationGuard,
  findGeneratedAssistantMessage,
} from './serverBackedSendChat'
import { markChatMessageMutationIntent } from '../server/chatMessageMutationIntent'
import {
  charactersResourceState,
  markChatBodyResourceRevision,
  replaceResourceDatabase,
} from '../server/resourceState.svelte'
import type { character, Chat, Message, MessageGenerationInfo } from '../storage/database.svelte'
import type { ServerChatMessagePatch, ServerChatRestoration } from '@risuai/protocol/generation-sse'
import { getRerollBuffer, getRerollId, resetRerollNavigation } from './rerollNavigation.svelte'
import { acknowledgeHydratedGenerationPersistences, queuedGenerationPersistences } from './generationPersistenceState'
import { addChatOutputListener, chatOutputListeners, type ChatOutputListenerArg } from '../plugins/chatOutputListeners'
import { _setPluginRuntimePhaseForTesting } from '../plugins/plugins.svelte'
import {
  beginGenerationDisplayProjection,
  generationDisplayProjections,
  resetGenerationDisplayProjectionsForTests,
} from './generationDisplayProjection.svelte'
import { clearAppliedServerResourceRevision } from '../server/commands'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'
import {
  applyGenerationOperationProjection,
  resetGenerationOperationClientForTests,
} from '../server/generationOperations'
import { hasActiveGenerationInlayPreparation, isGenerationInlayPreparationActive } from './generationEffectLedger'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: ReturnType<typeof getResourceDatabase>) {
    replaceResourceDatabase(value)
  },
}

function chatWith(messages: Partial<Message>[]): Chat {
  return { id: 'chat-1', message: messages as Message[] } as unknown as Chat
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function ownerInlayTerminal(finalText: string) {
  return {
    status: 'done' as const,
    done: {
      postGeneration: {
        messageId: 'gen-stable',
        finalText,
        effectLedger: {
          version: 1 as const,
          databaseLineage: 'lineage-a',
          keyType: 'operation' as const,
          keyId: 'operation-a',
          generationId: 'gen-stable',
          characterId: 'char-stable',
          chatId: 'chat-target',
          messageId: 'gen-stable',
        },
      },
    },
  }
}

function ownerInlayOccupancy() {
  return {
    interaction: 'send' as const,
    authority: {
      version: 1 as const,
      databaseLineage: 'lineage-a',
      chatId: 'chat-target',
      sessionId: 'occupant-a',
      sessionGeneration: 1,
      occupancyEpoch: 7,
      claimClass: 'owner' as const,
    },
  }
}

function trapIterator(chat: Chat): void {
  Object.defineProperty(chat.message, Symbol.iterator, {
    value: () => {
      throw new Error('transcript copied: the lookup must scan in place (L39)')
    },
  })
}

describe('terminal assistant-message lookup', () => {
  it('resolves the message by chatId without copying the transcript', () => {
    const chat = chatWith([
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'gen-1' },
    ])
    trapIterator(chat)

    const found = findGeneratedAssistantMessage(chat, 'gen-1')
    expect(found?.data).toBe('two')
  })

  it('falls back to the newest generationInfo match, scanning in place', () => {
    const chat = chatWith([
      { role: 'char', data: 'old', generationInfo: { generationId: 'gen-2' } },
      { role: 'user', data: 'middle' },
      { role: 'char', data: 'newest', generationInfo: { generationId: 'gen-2' } },
    ])
    trapIterator(chat)

    // Newest-to-oldest: the LAST matching assistant message wins, exactly like
    // the former reversed-copy `.find`.
    const found = findGeneratedAssistantMessage(chat, 'gen-2')
    expect(found?.data).toBe('newest')
  })

  it('returns undefined when nothing matches, still without copying', () => {
    const chat = chatWith([
      { role: 'user', data: 'one', chatId: 'm-1' },
      { role: 'char', data: 'two', chatId: 'm-2' },
    ])
    trapIterator(chat)

    expect(findGeneratedAssistantMessage(chat, 'missing')).toBeUndefined()
  })
})

function terminalMessage(data: string, generationId = 'gen-stable'): Message {
  return {
    role: 'char',
    data,
    chatId: generationId,
    generationInfo: { generationId },
  }
}

function makeTerminalChat(id: string, message: Message[] = [terminalMessage(`${id} original`)]): Chat {
  return {
    id,
    name: id,
    note: '',
    localLore: [],
    message,
  } as Chat
}

function makeTerminalCharacter(chats: Chat[]): character {
  return {
    type: 'character',
    chaId: 'char-stable',
    name: 'Stable Character',
    firstMessage: '',
    desc: '',
    notes: '',
    chats,
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'none',
    bias: [],
    emotionImages: [],
    globalLore: [],
    sdData: [],
    customscript: [],
    triggerscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: 0,
    replaceGlobalNote: '',
    additionalText: '',
  } as character
}

function makePostGenerationPatch(chatId: string, data: string): ServerChatMessagePatch {
  return {
    chatId,
    characterId: 'char-stable',
    selectedCharID: 0,
    chatPage: 0,
    varChanged: true,
    messageMutations: [
      {
        type: 'replace_all',
        source: 'output_trigger',
        beforeLength: 1,
        afterLength: 1,
        firstChangedIndex: 0,
        messages: [terminalMessage(data)],
      },
    ],
    chatVarMutations: [{ key: '$mood', before: null, after: 'steady' }],
    additionalSystemPrompt: [],
  }
}

function makeRestoration(chatId: string): ServerChatRestoration {
  return {
    chatId,
    characterId: 'char-stable',
    selectedCharID: 0,
    chatPage: 0,
    messages: [{ role: 'user', data: 'restored user', chatId: 'restored-user' }],
    scriptstate: { $restored: 'yes' },
  }
}

function seedReorderedTerminalChats(): { char: character; target: Chat; staleIndexChat: Chat } {
  const target = makeTerminalChat('chat-target', [terminalMessage('target original')])
  const staleIndexChat = makeTerminalChat('chat-stale-index', [terminalMessage('stale original', 'gen-other')])
  const char = makeTerminalCharacter([staleIndexChat, target])
  testDatabaseState.db = { characters: [char] } as typeof testDatabaseState.db
  const liveChar = testDatabaseState.db.characters[0]
  return { char: liveChar, target: liveChar.chats[1], staleIndexChat: liveChar.chats[0] }
}

describe('server-backed terminal stable chat target', () => {
  let originalDb: typeof testDatabaseState.db

  beforeEach(() => {
    _setPluginRuntimePhaseForTesting('ready')
    originalDb = testDatabaseState.db
    resetRerollNavigation()
    inlayMock.run.mockReset()
    inlayMock.run.mockImplementation((_character: unknown, data: string) => ({ text: data }))
    inlayMock.renderWithoutProviders.mockReset()
    inlayMock.renderWithoutProviders.mockImplementation((_character: unknown, data: string) => data)
    inlayMock.requiresFinalization.mockReset()
    inlayMock.requiresFinalization.mockImplementation((_character: unknown, data: string) =>
      /<(?:ImgGen|Emotion)=/.test(data),
    )
    inlayFinalizationMock.prepare.mockReset()
    inlayFinalizationMock.prepare.mockResolvedValue(true)
    inlayFinalizationMock.finalize.mockReset()
    inlayFinalizationMock.finalize.mockResolvedValue(true)
    inlayFinalizationMock.abandon.mockReset()
    inlayFinalizationMock.abandon.mockResolvedValue(true)
    chatCommandsMock.updateMessage.mockReset()
    chatCommandsMock.updateMessage.mockResolvedValue({ status: 'accepted', result: { status: 'ok' } })
    ttsMock.say.mockReset()
    ttsMock.say.mockResolvedValue(undefined)
    hydrationMock.hydrate.mockReset()
    hydrationMock.hydrate.mockResolvedValue(undefined)
    resetGenerationDisplayProjectionsForTests()
    queuedGenerationPersistences.set([])
    chatOutputListeners.clear()
    resetGenerationDisplayProjectionsForTests()
    clearAppliedServerResourceRevision()
    resetGenerationOperationClientForTests()
    selectedCharID.set(0)
    occupancyMock.current = true
    occupancyMock.occupancies = []
    occupancyMock.recover.mockReset()
    occupancyMock.listeners.clear()
  })

  afterEach(() => {
    _setPluginRuntimePhaseForTesting('idle')
    resetRerollNavigation()
    queuedGenerationPersistences.set([])
    chatOutputListeners.clear()
    clearAppliedServerResourceRevision()
    resetGenerationOperationClientForTests()
    testDatabaseState.db = originalDb
    selectedCharID.set(-1)
    vi.unstubAllGlobals()
  })

  it('applies terminal final text without a nested patch to the stable chat id after chat reorder', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()
    const generationInfo: MessageGenerationInfo = { generationId: 'gen-stable' }

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: { postGeneration: { finalText: 'stable final text' } },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo,
    })

    expect(result.status).toBe('ok')
    expect(result.currentChat.id).toBe('chat-target')
    if (result.status !== 'ok') throw new Error('unexpected terminal status')
    expect(result.igpTarget).toEqual({
      characterId: 'char-stable',
      chatId: 'chat-target',
      messageId: 'gen-stable',
      expectedData: 'stable final text',
      expectedGenerationId: 'gen-stable',
    })
    expect(target.message[0].data).toBe('stable final text')
    expect(staleIndexChat.message[0].data).toBe('stale original')
  })

  it.each(['extend', 'append'] as const)(
    'constructs exact live Continue-%s IGP target authority while preserving prior metadata',
    async (disposition) => {
      const generationId = 'continue-job'
      const resultMessageId = disposition === 'extend' ? 'accepted-assistant' : 'continued-assistant'
      const retainedGenerationInfo: MessageGenerationInfo = {
        generationId: 'prior-generation',
        databaseLineage: 'prior-lineage',
        operationId: 'prior-operation',
        attemptNo: 3,
        jobId: 'prior-job',
      }
      const retainedAssistant: Message = {
        role: 'char',
        data: disposition === 'extend' ? 'prior reply plus continuation' : 'prior reply',
        chatId: 'accepted-assistant',
        generationInfo: structuredClone(retainedGenerationInfo),
      } as Message
      const appendedAssistant: Message = {
        role: 'char',
        data: 'separate continuation',
        chatId: resultMessageId,
        generationInfo: {
          generationId,
          databaseLineage: 'lineage-a',
          operationId: 'continue-operation',
          attemptNo: 2,
          jobId: generationId,
          effectLedgerKeyType: 'operation',
          effectLedgerKeyId: 'continue-operation',
          effectLedgerCharacterId: 'char-stable',
          effectLedgerChatId: 'chat-target',
        },
      } as Message
      const target = makeTerminalChat('chat-target', [
        retainedAssistant,
        ...(disposition === 'append' ? [appendedAssistant] : []),
      ])
      const char = makeTerminalCharacter([target])
      testDatabaseState.db = { characters: [char] } as typeof testDatabaseState.db
      const liveChar = testDatabaseState.db.characters[0]
      const liveChat = liveChar.chats[0]
      applyGenerationOperationProjection({
        operationId: 'continue-operation',
        protocolVersion: 1,
        requestOrigin: 'continue',
        state: 'completed',
        stateVersion: 8,
        projectionEpoch: 9,
        creatorWriterSessionId: 'occupant-a',
        creatorWriterEpoch: 1,
        generationScope: {
          admissionKind: 'owner_occupancy',
          occupancyDatabaseLineage: 'lineage-a',
          occupancySessionId: 'occupant-a',
          occupancyEpoch: 7,
          occupancyClaimClass: 'owner',
          permissionScopeVersion: 1,
          permissionScope: [],
        },
        characterId: 'char-stable',
        chatId: 'chat-target',
        mode: 'continue',
        targetMessageId: 'accepted-assistant',
        resultMessageId,
        providerMayHaveRun: true,
        currentAttempt: {
          attemptNo: 2,
          retryRequestId: 'continue-retry',
          jobId: generationId,
          status: 'finalizing',
          serverInstanceId: 'server-a',
          actorWriterSessionId: 'occupant-a',
          actorWriterEpoch: 1,
          launchRevision: 7,
          finalizationGenerationId: generationId,
        },
      })
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ status: 'not_claimed', reason: 'already_receipted' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      )
      const effectLedger = {
        version: 1 as const,
        databaseLineage: 'lineage-a',
        keyType: 'operation' as const,
        keyId: 'continue-operation',
        generationId,
        characterId: 'char-stable',
        chatId: 'chat-target',
        messageId: resultMessageId,
      }

      const result = await applyServerBackedTerminal({
        terminal: {
          status: 'done',
          done: {
            outcome: 'completed',
            generationId,
            continueDisposition: disposition,
            resultMessageId,
            postGeneration: {
              messageId: resultMessageId,
              finalText: disposition === 'extend' ? 'prior reply plus continuation' : 'separate continuation',
              effectLedger,
            },
          },
        },
        currentChar: liveChar,
        currentChat: liveChat,
        selectedChar: 0,
        selectedChat: 0,
        targetCharacterId: 'char-stable',
        targetChatId: 'chat-target',
        targetMessageId: 'accepted-assistant',
        generationInfo: {
          generationId,
          databaseLineage: 'lineage-a',
          operationId: 'continue-operation',
          attemptNo: 2,
          jobId: generationId,
        },
      })

      expect(result.status).toBe('ok')
      if (result.status !== 'ok') throw new Error('unexpected terminal status')
      expect(result.igpTarget).toMatchObject({
        characterId: 'char-stable',
        chatId: 'chat-target',
        messageId: resultMessageId,
        expectedData: disposition === 'extend' ? 'prior reply plus continuation' : 'separate continuation',
      })
      if (disposition === 'extend') {
        expect(result.igpTarget).not.toHaveProperty('expectedGenerationId')
        expect(result.igpTarget?.continueExtendAuthority).toMatchObject({
          kind: 'continue_extend',
          operationId: 'continue-operation',
          operationAttemptNo: 2,
          jobId: generationId,
          targetMessageId: resultMessageId,
          resultMessageId,
          retainedGenerationInfo,
        })
      } else {
        expect(result.igpTarget).toMatchObject({ expectedGenerationId: generationId })
        expect(result.igpTarget).not.toHaveProperty('continueExtendAuthority')
      }
      expect(liveChat.message[0].generationInfo).toEqual(retainedGenerationInfo)
    },
  )

  it('fails closed when a ready owner collection contains duplicate character ids', async () => {
    const { char, target } = seedReorderedTerminalChats()
    testDatabaseState.db = {
      characters: [char, char],
    } as typeof testDatabaseState.db
    charactersResourceState.status = 'ready'

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: { postGeneration: { finalText: 'must not write' } },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(target.message[0].data).toBe('target original')
  })

  it('hydrates regenerate authority before removing its transient target projection', async () => {
    const target = makeTerminalChat('chat-target', [
      { role: 'user', data: 'try again', chatId: 'user-1' } as Message,
      { role: 'char', data: 'old reply', chatId: 'assistant-old' } as Message,
    ])
    const char = makeTerminalCharacter([target])
    testDatabaseState.db = { characters: [char] } as typeof testDatabaseState.db
    const liveChar = testDatabaseState.db.characters[0]
    const liveChat = liveChar.chats[0]
    const displayProjection = {
      operationId: 'operation-1',
      attemptNo: 1,
      characterId: 'char-stable',
      chatId: 'chat-target',
      mode: 'regenerate' as const,
      targetMessageId: 'assistant-old',
      generationId: 'assistant-new',
      projectionEpoch: 4,
    }
    beginGenerationDisplayProjection(displayProjection)
    hydrationMock.hydrate.mockImplementationOnce(async () => {
      liveChat.message[1] = terminalMessage('new reply', 'assistant-new')
    })

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          generationId: 'assistant-new',
          postGeneration: { messageId: 'assistant-new', finalText: 'new reply' },
        },
      },
      currentChar: liveChar,
      currentChat: liveChat,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      targetMessageId: 'assistant-old',
      generationInfo: { generationId: 'assistant-new' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'assistant-old',
        generationId: 'assistant-new',
        previousData: 'old reply',
        ownedData: 'old reply',
        appended: false,
        displayProjection,
      },
    })

    expect(hydrationMock.hydrate).toHaveBeenCalledWith('chat-target', { force: true, strict: true })
    expect(result.status).toBe('ok')
    expect(liveChat.message).toEqual([
      expect.objectContaining({ chatId: 'user-1', data: 'try again' }),
      expect.objectContaining({ chatId: 'assistant-new', data: 'new reply' }),
    ])
    expect(get(generationDisplayProjections)).toEqual([])
  })

  it('drops a failed regenerate projection without changing the original target', async () => {
    const target = makeTerminalChat('chat-target', [
      { role: 'user', data: 'try again', chatId: 'user-1' } as Message,
      { role: 'char', data: 'old reply', chatId: 'assistant-old' } as Message,
    ])
    const char = makeTerminalCharacter([target])
    testDatabaseState.db = { characters: [char] } as typeof testDatabaseState.db
    const liveChar = testDatabaseState.db.characters[0]
    const liveChat = liveChar.chats[0]
    const displayProjection = {
      operationId: 'operation-1',
      attemptNo: 1,
      characterId: 'char-stable',
      chatId: 'chat-target',
      mode: 'regenerate' as const,
      targetMessageId: 'assistant-old',
      generationId: 'assistant-new',
      projectionEpoch: 4,
    }
    beginGenerationDisplayProjection(displayProjection)

    const result = await applyServerBackedTerminal({
      terminal: { status: 'error', error: 'provider failed before output' },
      currentChar: liveChar,
      currentChat: liveChat,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      targetMessageId: 'assistant-old',
      generationInfo: { generationId: 'assistant-new' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'assistant-old',
        generationId: 'assistant-new',
        previousData: 'old reply',
        ownedData: 'old reply',
        appended: false,
        displayProjection,
      },
    })

    expect(result.status).toBe('failed')
    expect(liveChat.message).toEqual([
      expect.objectContaining({ chatId: 'user-1', data: 'try again' }),
      expect.objectContaining({ chatId: 'assistant-old', data: 'old reply' }),
    ])
    expect(hydrationMock.hydrate).not.toHaveBeenCalled()
    expect(get(generationDisplayProjections)).toEqual([])
  })

  it('notifies output listeners after the finalized assistant message is applied', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const calls: ChatOutputListenerArg[] = []
    const order: string[] = []
    addChatOutputListener('output', async (arg) => {
      order.push('first:start')
      await Promise.resolve()
      calls.push(arg)
      arg.chat.message[0].data = 'detached plugin mutation'
      arg.char.name = 'Detached Plugin Character'
      order.push('first:end')
    })
    addChatOutputListener('output', () => {
      order.push('second')
    })

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: { postGeneration: { finalText: 'listener-visible final text' } },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(order).toEqual(['first:start', 'first:end', 'second'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      characterIndex: 0,
      chatIndex: 1,
      messageIndex: 0,
    })
    expect(target.message[0].data).toBe('listener-visible final text')
    expect(char.name).toBe('Stable Character')
  })

  it('applies the exact cancelled snapshot without running success-only terminal effects', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message[0].data = 'persisted partial reply'
    const listener = vi.fn()
    addChatOutputListener('output', listener)

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'cancelled',
        reattachOutcome: 'cancelled',
        sideEffects: [{ kind: 'tts', payload: { text: 'must not speak' } }],
        done: {
          outcome: 'cancelled',
          result: 'persisted partial reply',
          alternates: ['must not become an alternate'],
          postGeneration: {
            messageId: 'gen-stable',
            finalText: '*says nothing*persisted partial reply',
            messagePatch: makePostGenerationPatch('chat-target', 'must not patch'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'persisted partial reply',
        appended: true,
      },
    })

    expect(result).toMatchObject({ status: 'cancelled', reattachOutcome: 'cancelled', resendChat: false })
    expect(target.message[0].data).toBe('*says nothing*persisted partial reply')
    expect(target.scriptstate).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect(ttsMock.say).not.toHaveBeenCalled()
    expect(inlayMock.run).not.toHaveBeenCalled()
    expect(getRerollBuffer()).toEqual([])
  })

  it('recreates a half-streaming placeholder removed before the cancelled snapshot arrives', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message = [{ role: 'user', data: 'question', chatId: 'user-1' } as Message]

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'cancelled',
        done: {
          outcome: 'cancelled',
          result: 'raw partial',
          postGeneration: {
            messageId: 'gen-half-stop',
            finalText: 'processed partial',
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-half-stop', model: 'test-model' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-half-stop',
        generationId: 'gen-half-stop',
        previousData: '',
        ownedData: '',
        appended: true,
        detached: false,
        messageIndex: 1,
      },
    })

    expect(result.status).toBe('cancelled')
    expect(target.message).toHaveLength(2)
    expect(target.message[1]).toMatchObject({
      role: 'char',
      chatId: 'gen-half-stop',
      data: 'processed partial',
      saying: 'char-stable',
      generationInfo: { generationId: 'gen-half-stop', model: 'test-model' },
    })
  })

  it('keeps a processed failed partial instead of applying the pre-generation restoration', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message[0].data = 'raw failed partial'

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'provider exploded',
        restoration: makeRestoration('chat-target'),
        done: {
          result: 'raw failed partial',
          postGeneration: {
            messageId: 'gen-stable',
            finalText: 'processed failed partial',
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'raw failed partial',
        appended: true,
      },
    })

    expect(result.status).toBe('failed')
    expect(target.message).toHaveLength(1)
    expect(target.message[0].data).toBe('processed failed partial')
    expect(target.scriptstate).toBeUndefined()
    expect(hydrationMock.hydrate).not.toHaveBeenCalled()
  })

  it('durably prepares the exact inlay obligation before starting its provider', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const preparation = deferred<boolean>()
    const completion = deferred<string>()
    inlayFinalizationMock.prepare.mockReturnValueOnce(preparation.promise)
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    await vi.waitFor(() => expect(inlayFinalizationMock.prepare).toHaveBeenCalledOnce())
    const effectLedger = ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(true)
    expect(occupancyMock.recover).not.toHaveBeenCalled()
    expect(inlayMock.run).not.toHaveBeenCalled()
    preparation.resolve(true)
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    completion.resolve('{{inlay::asset-current}}')
    await applying
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(false)
    expect(occupancyMock.recover).toHaveBeenCalledExactlyOnceWith({ refresh: true })
  })

  it('retires a refused pre-acknowledgement preparation and releases queued recovery', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const preparation = deferred<boolean>()
    inlayFinalizationMock.prepare.mockReturnValueOnce(preparation.promise)

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    await vi.waitFor(() => expect(inlayFinalizationMock.prepare).toHaveBeenCalledOnce())
    const effectLedger = ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(true)
    preparation.resolve(false)
    await applying

    expect(inlayMock.run).not.toHaveBeenCalled()
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(false)
    expect(occupancyMock.recover).toHaveBeenCalledExactlyOnceWith({ refresh: true })
  })

  it('retires a failed pre-acknowledgement preparation and releases queued recovery', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const preparation = deferred<boolean>()
    inlayFinalizationMock.prepare.mockReturnValueOnce(preparation.promise)

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    await vi.waitFor(() => expect(inlayFinalizationMock.prepare).toHaveBeenCalledOnce())
    const effectLedger = ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(true)
    preparation.reject(new Error('preparation transport failed'))
    await expect(applying).rejects.toThrow('preparation transport failed')

    expect(inlayMock.run).not.toHaveBeenCalled()
    expect(hasActiveGenerationInlayPreparation(effectLedger)).toBe(false)
    expect(occupancyMock.recover).toHaveBeenCalledExactlyOnceWith({ refresh: true })
  })

  it('abandons the exact durable preparation when the image provider fails', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    completion.reject(new Error('provider failed'))
    await applying

    expect(inlayFinalizationMock.abandon).toHaveBeenCalledWith({
      effectLedger: ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger,
      chatOccupancyAuthority: ownerInlayOccupancy().authority,
      operationId: 'operation-a',
      preparationId: inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId,
      expectedData: '<ImgGen="cat">',
    })
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('<ImgGen="cat">')
  })

  it('abandons when the image provider preserves an unresolved source obligation', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    completion.resolve('<ImgGen="cat">')
    await applying

    expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('<ImgGen="cat">')
  })

  it('submits a late inlay completion for server-side stale classification while preserving a newer local edit', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    expect(target.message[0].data).toBe('[Generating...]')

    markChatMessageMutationIntent('chat-target')
    target.message[0].data = 'newer saved edit'
    completion.resolve('{{inlay::asset-stale}}')
    await applying

    expect(target.message[0].data).toBe('newer saved edit')
    expect(inlayFinalizationMock.finalize).toHaveBeenCalledOnce()
  })

  it('submits edit-away-then-back races while the local intent epoch rejects their projection', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())

    markChatMessageMutationIntent('chat-target')
    target.message[0].data = 'temporary edit'
    target.message[0].data = '[Generating...]'
    completion.resolve('{{inlay::asset-stale}}')
    await applying

    expect(target.message[0].data).toBe('[Generating...]')
    expect(inlayFinalizationMock.finalize).toHaveBeenCalledOnce()
  })

  it('settles over an exact raw hydration caused by a server-authored metadata update', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())

    // Translation completion rehydrates the message row without recording a
    // local mutation intent. Its transcript data remains the exact terminal
    // value protected by the durable inlay preparation.
    target.message[0].data = '<ImgGen="cat">'
    completion.resolve('{{inlay::asset-after-translation}}')
    await applying

    expect(target.message[0].data).toBe('{{inlay::asset-after-translation}}')
    expect(inlayFinalizationMock.finalize).toHaveBeenCalledOnce()
  })

  it('applies an unchanged inlay completion exactly once', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await Promise.resolve()

    completion.resolve('{{inlay::asset-current}}')
    await applying

    expect(target.message[0].data).toBe('{{inlay::asset-current}}')
    expect(inlayFinalizationMock.prepare).toHaveBeenCalledWith({
      effectLedger: ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger,
      chatOccupancyAuthority: ownerInlayOccupancy().authority,
      operationId: 'operation-a',
      preparationId: expect.any(String),
      expectedData: '<ImgGen="cat">',
    })
    const preparationId = inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId
    expect(inlayFinalizationMock.finalize).toHaveBeenCalledWith({
      effectLedger: ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger,
      chatOccupancyAuthority: ownerInlayOccupancy().authority,
      operationId: 'operation-a',
      preparationId,
      expectedData: '<ImgGen="cat">',
      finalData: '{{inlay::asset-current}}',
    })
  })

  it('persists an immediate emotion transformation before keeping it visible', async () => {
    const { char, target } = seedReorderedTerminalChats()
    inlayMock.run.mockReturnValueOnce({ text: 'reply {{emotion::happy}}' })

    await applyServerBackedTerminal({
      terminal: ownerInlayTerminal('reply <Emotion="happy">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    expect(inlayFinalizationMock.finalize).toHaveBeenCalledWith({
      effectLedger: ownerInlayTerminal('reply <Emotion="happy">').done.postGeneration.effectLedger,
      chatOccupancyAuthority: ownerInlayOccupancy().authority,
      operationId: 'operation-a',
      preparationId: inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId,
      expectedData: 'reply <Emotion="happy">',
      finalData: 'reply {{emotion::happy}}',
    })
    expect(target.message[0].data).toBe('reply {{emotion::happy}}')
  })

  it('preserves legacy-owner emotion completion when chat occupancy is disabled', async () => {
    const { char, target } = seedReorderedTerminalChats()
    inlayMock.run.mockReturnValueOnce({ text: 'reply {{emotion::happy}}' })

    await applyServerBackedTerminal({
      terminal: ownerInlayTerminal('reply <Emotion="happy">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
    })

    expect(inlayFinalizationMock.prepare).not.toHaveBeenCalled()
    expect(chatCommandsMock.updateMessage).toHaveBeenCalledWith(
      'gen-stable',
      { data: 'reply {{emotion::happy}}' },
      expect.objectContaining({ characterId: 'char-stable', chatId: 'chat-target' }),
      expect.objectContaining({
        expectedData: 'reply <Emotion="happy">',
        expectedChatId: 'chat-target',
        expectedGenerationId: 'gen-stable',
      }),
    )
    expect(target.message[0].data).toBe('reply {{emotion::happy}}')
  })

  it('does not repaint a newer legacy-owner edit when immediate persistence is refused', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const persistence = deferred<{
      status: 'failed'
      result: { status: 'unavailable' }
    }>()
    inlayMock.run.mockReturnValueOnce({ text: 'reply {{emotion::happy}}' })
    chatCommandsMock.updateMessage.mockReturnValueOnce(persistence.promise)

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('reply <Emotion="happy">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
    })
    await vi.waitFor(() => expect(chatCommandsMock.updateMessage).toHaveBeenCalledOnce())
    target.message[0].data = 'Newer hydrated emotion edit.'
    persistence.resolve({ status: 'failed', result: { status: 'unavailable' } })
    await applying

    expect(target.message[0].data).toBe('Newer hydrated emotion edit.')
  })

  it('preserves legacy-owner image completion when chat occupancy is disabled', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    completion.resolve('{{inlay::legacy-asset}}')
    await applying

    expect(inlayFinalizationMock.prepare).not.toHaveBeenCalled()
    expect(chatCommandsMock.updateMessage).toHaveBeenCalledWith(
      'gen-stable',
      { data: '{{inlay::legacy-asset}}' },
      expect.objectContaining({ characterId: 'char-stable', chatId: 'chat-target' }),
      expect.objectContaining({
        expectedData: '<ImgGen="cat">',
        expectedChatId: 'chat-target',
        expectedGenerationId: 'gen-stable',
      }),
    )
    expect(target.message[0].data).toBe('{{inlay::legacy-asset}}')
  })

  it.each([
    { label: 'provider failure', settle: (completion: ReturnType<typeof deferred<string>>) => completion.reject() },
    {
      label: 'provider success',
      settle: (completion: ReturnType<typeof deferred<string>>) => completion.resolve('{{inlay::late-legacy-asset}}'),
    },
  ])('preserves a newer legacy-owner edit after deferred image $label', async ({ settle }) => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
    })
    await vi.waitFor(() => expect(target.message[0].data).toBe('[Generating...]'))
    target.message[0].data = 'Newer owner edit must survive.'
    settle(completion)
    await applying

    expect(chatCommandsMock.updateMessage).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('Newer owner edit must survive.')
  })

  it('rejects a legacy image edit-away-and-back race by mutation-intent epoch', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
    })
    await vi.waitFor(() => expect(target.message[0].data).toBe('[Generating...]'))
    markChatMessageMutationIntent('chat-target')
    target.message[0].data = 'temporary edit'
    target.message[0].data = '[Generating...]'
    completion.resolve('{{inlay::must-not-persist}}')
    await applying

    expect(chatCommandsMock.updateMessage).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('[Generating...]')
  })

  it('does not abandon a running image provider during transient authority normalization', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    occupancyMock.current = false
    await Promise.resolve()
    expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()
    occupancyMock.current = true
    completion.resolve('{{inlay::normalized-asset}}')
    await applying

    expect(inlayFinalizationMock.finalize).toHaveBeenCalledOnce()
    expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('{{inlay::normalized-asset}}')
  })

  it('abandons only after a running image provider settles under transferred authority', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    inlayMock.run.mockReturnValueOnce({ text: '[Generating...]', promise: completion.promise })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    const effectLedger = ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger
    const preparationId = inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId
    occupancyMock.current = false
    expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(true)
    completion.resolve('{{inlay::late-asset}}')
    await applying

    expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(false)
  })

  it('cancels held post-provider asset settlement on authority loss and ignores its late resolution', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    let settlementSignal: AbortSignal | undefined
    inlayMock.run.mockImplementationOnce((_character, _data, options) => {
      const promise = options!.settlePostProvider!((signal) => {
        settlementSignal = signal
        return completion.promise
      })
      return { text: '[Generating...]', promise }
    })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())
    const effectLedger = ownerInlayTerminal('<ImgGen="cat">').done.postGeneration.effectLedger
    const preparationId = inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId
    expect(settlementSignal?.aborted).toBe(false)
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(true)

    occupancyMock.current = false
    for (const listener of occupancyMock.listeners) listener()
    await applying

    expect(settlementSignal?.aborted).toBe(true)
    expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(false)
    expect(occupancyMock.recover).toHaveBeenCalledWith({ refresh: true })

    completion.resolve('{{inlay::late-upload}}')
    await Promise.resolve()
    await Promise.resolve()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    expect(target.message[0].data).toBe('[Generating...]')
  })

  it('defers post-provider cancellation through exact owner-row normalization and aborts on the new tuple', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const completion = deferred<string>()
    let settlementSignal: AbortSignal | undefined
    occupancyMock.occupancies = [
      {
        databaseLineage: 'lineage-a',
        chatId: 'chat-target',
        occupantSessionId: 'occupant-a',
        occupancyEpoch: 7,
        claimClass: 'owner',
        state: 'occupied',
      },
    ]
    inlayMock.run.mockImplementationOnce((_character, _data, options) => {
      const promise = options!.settlePostProvider!((signal) => {
        settlementSignal = signal
        return completion.promise
      })
      return { text: '[Generating...]', promise }
    })

    const applying = applyServerBackedTerminal({
      terminal: ownerInlayTerminal('<ImgGen="cat">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })
    await vi.waitFor(() => expect(inlayMock.run).toHaveBeenCalledOnce())

    occupancyMock.current = false
    for (const listener of occupancyMock.listeners) listener()
    expect(settlementSignal?.aborted).toBe(false)
    expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()

    occupancyMock.occupancies = [{ ...occupancyMock.occupancies[0], claimClass: 'chat_only' }]
    for (const listener of occupancyMock.listeners) listener()
    await applying

    expect(settlementSignal?.aborted).toBe(true)
    expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    completion.resolve('{{inlay::ignored-after-normalization}}')
    await Promise.resolve()
    expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
  })

  it('clears a fast image settlement deadline without aborting a later sibling provider', async () => {
    vi.useFakeTimers()
    try {
      const { char, target } = seedReorderedTerminalChats()
      const slowProvider = deferred<void>()
      let providerSignal: AbortSignal | undefined
      inlayMock.run.mockImplementationOnce((_character, _data, options) => {
        providerSignal = options?.signal
        const promise = (async () => {
          const fast = await options!.settlePostProvider!(async () => '{{inlay::fast-asset}}')
          await slowProvider.promise
          const slow = await options!.settlePostProvider!(async () => '{{inlay::slow-asset}}')
          return `First ${fast} then ${slow}`
        })()
        return { text: 'First [Generating...] then [Generating...]', promise }
      })

      const applying = applyServerBackedTerminal({
        terminal: ownerInlayTerminal('First <ImgGen="fast"> then {{ImgGen="slow"}}'),
        currentChar: char,
        currentChat: target,
        selectedChar: 0,
        selectedChat: 0,
        targetCharacterId: 'char-stable',
        targetChatId: 'chat-target',
        generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
        chatOccupancy: ownerInlayOccupancy(),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(providerSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(providerSignal?.aborted).toBe(false)
      expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()

      slowProvider.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await applying

      expect(inlayFinalizationMock.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ finalData: 'First {{inlay::fast-asset}} then {{inlay::slow-asset}}' }),
      )
      expect(inlayFinalizationMock.abandon).not.toHaveBeenCalled()
      expect(target.message[0].data).toBe('First {{inlay::fast-asset}} then {{inlay::slow-asset}}')
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts an independent bound for each concurrent image settlement and consumes late results', async () => {
    vi.useFakeTimers()
    try {
      const { char, target } = seedReorderedTerminalChats()
      const startSecond = deferred<void>()
      const firstUpload = deferred<string>()
      const secondUpload = deferred<string>()
      const settlementSignals: AbortSignal[] = []
      let providerSignal: AbortSignal | undefined
      inlayMock.run.mockImplementationOnce((_character, _data, options) => {
        providerSignal = options?.signal
        const first = options!.settlePostProvider!((signal) => {
          settlementSignals.push(signal)
          return firstUpload.promise
        })
        const promise = (async () => {
          await startSecond.promise
          const second = options!.settlePostProvider!((signal) => {
            settlementSignals.push(signal)
            return secondUpload.promise
          })
          const [firstAsset, secondAsset] = await Promise.all([first, second])
          return `${firstAsset}:${secondAsset}`
        })()
        return { text: '[Generating...]:[Generating...]', promise }
      })

      const applying = applyServerBackedTerminal({
        terminal: ownerInlayTerminal('<ImgGen="first">:<ImgGen="second">'),
        currentChar: char,
        currentChat: target,
        selectedChar: 0,
        selectedChat: 0,
        targetCharacterId: 'char-stable',
        targetChatId: 'chat-target',
        generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
        chatOccupancy: ownerInlayOccupancy(),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(settlementSignals).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(10_000)
      startSecond.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(settlementSignals).toHaveLength(2)

      vi.advanceTimersByTime(20_000)
      expect(settlementSignals[0]?.aborted).toBe(true)
      expect(settlementSignals[1]?.aborted).toBe(false)
      expect(providerSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(0)
      await applying
      expect(settlementSignals[1]?.aborted).toBe(true)
      expect(providerSignal?.aborted).toBe(false)
      expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
      expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()

      firstUpload.resolve('{{inlay::late-first}}')
      secondUpload.resolve('{{inlay::late-second}}')
      await vi.advanceTimersByTimeAsync(0)
      expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
      expect(target.message[0].data).toBe('<ImgGen="first">:<ImgGen="second">')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds post-provider settlement and abandons before an ignored late upload resolves', async () => {
    vi.useFakeTimers()
    try {
      const { char, target } = seedReorderedTerminalChats()
      const completion = deferred<string>()
      let settlementSignal: AbortSignal | undefined
      inlayMock.run.mockImplementationOnce((_character, _data, options) => {
        const promise = options!.settlePostProvider!((signal) => {
          settlementSignal = signal
          return completion.promise
        })
        return { text: '[Generating...]', promise }
      })

      const applying = applyServerBackedTerminal({
        terminal: ownerInlayTerminal('<ImgGen="cat">'),
        currentChar: char,
        currentChat: target,
        selectedChar: 0,
        selectedChat: 0,
        targetCharacterId: 'char-stable',
        targetChatId: 'chat-target',
        generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
        chatOccupancy: ownerInlayOccupancy(),
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(inlayMock.run).toHaveBeenCalledOnce()
      expect(settlementSignal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(30_000)
      await applying

      expect(settlementSignal?.aborted).toBe(true)
      expect(inlayFinalizationMock.abandon).toHaveBeenCalledOnce()
      expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
      expect(target.message[0].data).toBe('<ImgGen="cat">')

      completion.resolve('{{inlay::late-timeout-upload}}')
      await vi.advanceTimersByTimeAsync(0)
      expect(inlayFinalizationMock.finalize).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders alternate TTS text without starting an untracked inlay provider', async () => {
    const { char, target } = seedReorderedTerminalChats()
    inlayMock.renderWithoutProviders.mockImplementation((_character, data) =>
      data.replace(/<ImgGen=".+?">/g, '[Generating...]'),
    )

    await applyServerBackedTerminal({
      terminal: {
        ...ownerInlayTerminal('primary reply'),
        sideEffects: [
          { kind: 'tts', payload: { text: 'primary reply' } },
          { kind: 'tts', payload: { text: 'alternate <ImgGen="untracked">' } },
        ],
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    expect(inlayMock.run).not.toHaveBeenCalled()
    expect(inlayFinalizationMock.prepare).not.toHaveBeenCalled()
    expect(inlayMock.renderWithoutProviders).toHaveBeenCalledWith(char, 'alternate <ImgGen="untracked">')
    expect(ttsMock.say).toHaveBeenNthCalledWith(2, char, 'alternate [Generating...]')
  })

  it('restores authoritative model text when an inlay finalization fails', async () => {
    const { char, target } = seedReorderedTerminalChats()
    inlayMock.run.mockReturnValueOnce({ text: 'reply {{emotion::happy}}' })
    inlayFinalizationMock.finalize.mockResolvedValueOnce(false)

    await applyServerBackedTerminal({
      terminal: ownerInlayTerminal('reply <Emotion="happy">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    expect(target.message[0].data).toBe('reply <Emotion="happy">')
    const effectLedger = ownerInlayTerminal('reply <Emotion="happy">').done.postGeneration.effectLedger
    const preparationId = inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(false)
  })

  it('retires and exactly abandons an accepted preparation when finalization throws', async () => {
    const { char, target } = seedReorderedTerminalChats()
    inlayMock.run.mockReturnValueOnce({ text: 'reply {{emotion::happy}}' })
    inlayFinalizationMock.finalize.mockRejectedValueOnce(new Error('transport exploded'))

    await applyServerBackedTerminal({
      terminal: ownerInlayTerminal('reply <Emotion="happy">'),
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable', operationId: 'operation-a', databaseLineage: 'lineage-a' },
      chatOccupancy: ownerInlayOccupancy(),
    })

    const effectLedger = ownerInlayTerminal('reply <Emotion="happy">').done.postGeneration.effectLedger
    const preparationId = inlayFinalizationMock.prepare.mock.calls[0]?.[0].preparationId
    expect(inlayFinalizationMock.abandon).toHaveBeenCalledWith(
      expect.objectContaining({ preparationId, operationId: 'operation-a' }),
    )
    expect(isGenerationInlayPreparationActive(effectLedger, preparationId)).toBe(false)
    expect(target.message[0].data).toBe('reply <Emotion="happy">')
  })

  it('seeds live reroll navigation from terminal multi-generation choices', async () => {
    const { char, target } = seedReorderedTerminalChats()
    char.chatPage = 1
    target.message[0].data = 'primary reply'

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          result: 'primary reply',
          generationId: 'gen-stable',
          alternates: ['second reply', 'third reply'],
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual([
      'primary reply',
      'second reply',
      'third reply',
    ])
    expect(getRerollBuffer().map((candidate) => candidate[0]?.chatId)).toEqual([
      'gen-stable',
      'gen-stable:alternate:1',
      'gen-stable:alternate:2',
    ])
    expect(getRerollId()).toBe(0)
  })

  it('keeps background terminal alternates for an already-resident chat until it is reopened', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message[0].data = 'primary reply'

    await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          result: 'primary reply',
          generationId: 'gen-stable',
          alternates: ['other reply'],
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 1,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(char.chats[char.chatPage].id).toBe('chat-stale-index')
    expect(getRerollBuffer()).toEqual([])
    expect(getRerollId()).toBe(-1)

    char.chatPage = 1
    expect(getRerollBuffer().map((candidate) => candidate[0]?.data)).toEqual(['primary reply', 'other reply'])
    expect(getRerollId()).toBe(0)
    expect(hydrationMock.hydrate).not.toHaveBeenCalled()
  })

  it('applies terminal post-generation patches to the stable chat id after chat reorder', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()
    const generationInfo: MessageGenerationInfo = { generationId: 'gen-stable' }

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            finalText: 'patched then finalized',
            messagePatch: makePostGenerationPatch('chat-target', 'patched text'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo,
    })

    expect(result.status).toBe('ok')
    expect(result.currentChat.id).toBe('chat-target')
    expect(target.message).toHaveLength(1)
    expect(target.message[0].data).toBe('patched then finalized')
    expect(target.scriptstate).toEqual({ $mood: 'steady' })
    expect(staleIndexChat.message[0].data).toBe('stale original')
    expect(staleIndexChat.scriptstate).toBeUndefined()
  })

  it('does not apply a terminal patch after a newer local message mutation intent', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message.unshift({ role: 'user', data: 'original user text', chatId: 'user-stable' })
    const restorationGuard = captureServerBackedRestorationGuard('chat-target')
    target.message[0].data = 'newer user edit'
    markChatMessageMutationIntent('chat-target')

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            revision: 8,
            finalText: 'stale terminal final text',
            messagePatch: makePostGenerationPatch('chat-target', 'stale patched text'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 1,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      restorationGuard,
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'target original',
        appended: true,
      },
    })

    expect(result.status).toBe('ok')
    expect(target.message).toEqual([
      { role: 'user', data: 'newer user edit', chatId: 'user-stable' },
      terminalMessage('target original'),
    ])
    expect(target.scriptstate).toBeUndefined()
  })

  it('does not apply a terminal patch older than the projected server revision', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.scriptstate = { $mood: 'newer server value' }
    markChatBodyResourceRevision('chat-target', 9)

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            revision: 8,
            finalText: 'stale terminal final text',
            messagePatch: makePostGenerationPatch('chat-target', 'stale patched text'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 1,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(target.message[0].data).toBe('target original')
    expect(target.scriptstate).toEqual({ $mood: 'newer server value' })
  })

  it('applies an embedded succeeded translation before terminal generation UI settlement', async () => {
    const { char, target } = seedReorderedTerminalChats()

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            messageId: 'gen-stable',
            translation: {
              status: 'succeeded',
              jobId: 'translation-job-1',
              translation: {
                source: 'raw',
                text: 'translated target',
                sourceHash: 'source-hash',
                targetLanguage: 'ko',
                inputLanguage: 'en',
                translatorType: 'google',
                settingsHash: 'settings-hash',
                updatedAt: 123,
              },
            },
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(target.message[0].translation?.text).toBe('translated target')
  })

  it('mirrors a terminal patch before slow TTS and preserves a newer saved edit', async () => {
    const { char, target } = seedReorderedTerminalChats()
    const tts = deferred<void>()
    ttsMock.say.mockReturnValueOnce(tts.promise)

    const applying = applyServerBackedTerminal({
      terminal: {
        status: 'done',
        sideEffects: [{ kind: 'tts', payload: { text: 'patched then finalized' } }],
        done: {
          postGeneration: {
            finalText: 'patched then finalized',
            messagePatch: makePostGenerationPatch('chat-target', 'patched text'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    await vi.waitFor(() => expect(ttsMock.say).toHaveBeenCalledOnce())
    expect(target.message[0].data).toBe('patched then finalized')
    expect(target.scriptstate).toEqual({ $mood: 'steady' })

    markChatMessageMutationIntent('chat-target')
    target.message[0].data = 'newer saved edit'
    tts.resolve()
    await applying

    expect(target.message[0].data).toBe('newer saved edit')
  })

  it('applies terminal final text before surfacing an Agent Preset terminal error', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()
    const generationInfo: MessageGenerationInfo = { generationId: 'gen-stable' }

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            finalText: 'preserved main output',
            agentPresetError: {
              error: 'agent_preset_generation_failed',
              message: 'Agent Preset step failed: Rewrite Output: provider exploded',
              statusCode: 422,
              phase: 'afterMain',
              stepId: 'aps_after',
              stepName: 'Rewrite Output',
              outputKey: 'rewrite',
            },
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo,
    })

    if (result.status !== 'failed') {
      throw new Error(`Expected failed terminal result, got ${result.status}`)
    }
    expect(result.error).toContain('Agent Preset step failed')
    expect(result.currentChat.id).toBe('chat-target')
    expect(target.message[0].data).toBe('preserved main output')
    expect(staleIndexChat.message[0].data).toBe('stale original')
  })

  it('skips terminal mirroring when stable patch ids are present but no live chat matches', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'done',
        done: {
          postGeneration: {
            finalText: 'should not land anywhere',
            messagePatch: makePostGenerationPatch('missing-chat', 'missing patch text'),
          },
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('ok')
    expect(result.currentChat.id).toBe('chat-target')
    expect(target.message[0].data).toBe('target original')
    expect(staleIndexChat.message[0].data).toBe('stale original')
    expect(staleIndexChat.scriptstate).toBeUndefined()
  })

  it('restores terminal errors to the stable chat id instead of a stale selectedChat index', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'provider failed',
        restoration: makeRestoration('chat-target'),
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
    })

    expect(result.status).toBe('failed')
    expect(result.currentChat.id).toBe('chat-target')
    expect(target.message).toEqual([{ role: 'user', data: 'restored user', chatId: 'restored-user' }])
    expect(target.scriptstate).toEqual({ $restored: 'yes' })
    expect(target.isStreaming).toBe(false)
    expect(staleIndexChat.message[0].data).toBe('stale original')
    expect(staleIndexChat.scriptstate).toBeUndefined()
  })

  it('does not apply an assembly restoration after a newer message mutation intent', async () => {
    const { char, target, staleIndexChat } = seedReorderedTerminalChats()
    const restorationGuard = captureServerBackedRestorationGuard('chat-target')
    target.message[0].data = 'accepted newer edit'
    markChatMessageMutationIntent('chat-target')

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'provider failed late',
        restoration: makeRestoration('chat-target'),
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      restorationGuard,
    })

    expect(result.status).toBe('failed')
    expect(target.message[0].data).toBe('accepted newer edit')
    expect(target.scriptstate).toBeUndefined()
    expect(staleIndexChat.message[0].data).toBe('stale original')
  })

  it('removes a still-owned optimistic reply after terminal persistence rejection', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message = [terminalMessage('streamed but rejected')]

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'Generation finalization target is stale',
        persistenceDisposition: 'rejected',
        generationProjection: {
          characterId: 'char-stable',
          chatId: 'chat-target',
          generationId: 'gen-stable',
          mode: 'send',
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'streamed but rejected',
        appended: true,
      },
    })

    expect(result.status).toBe('failed')
    expect(target.message).toEqual([])
    expect(hydrationMock.hydrate).toHaveBeenCalledWith('chat-target', { force: true, strict: true })
  })

  it('removes an appended optimistic reply and creates no queued marker when journaling is unconfirmed', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message = [terminalMessage('streamed without a journal')]

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'Generation finalization journal was not confirmed',
        persistenceDisposition: 'unconfirmed',
        generationProjection: {
          characterId: 'char-stable',
          chatId: 'chat-target',
          generationId: 'gen-stable',
          mode: 'send',
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'streamed without a journal',
        appended: true,
      },
    })

    expect(result.status).toBe('failed')
    expect(target.message).toEqual([])
    expect(get(queuedGenerationPersistences)).toEqual([])
    expect(hydrationMock.hydrate).toHaveBeenCalledWith('chat-target', { force: true, strict: true })
  })

  it.each(['continue', 'regenerate'] as const)(
    'restores the prior %s text when the still-owned projection has no confirmed journal',
    async (mode) => {
      const { char, target } = seedReorderedTerminalChats()
      target.message = [
        {
          role: 'char',
          data: 'prior text plus streamed text',
          chatId: 'target-message',
          generationInfo: { generationId: 'gen-stable' },
        },
      ]

      await applyServerBackedTerminal({
        terminal: {
          status: 'error',
          error: 'Generation finalization journal was not confirmed',
          persistenceDisposition: 'unconfirmed',
          generationProjection: {
            characterId: 'char-stable',
            chatId: 'chat-target',
            generationId: 'gen-stable',
            mode,
            targetMessageId: 'target-message',
          },
        },
        currentChar: char,
        currentChat: target,
        selectedChar: 0,
        selectedChat: 0,
        targetCharacterId: 'char-stable',
        targetChatId: 'chat-target',
        targetMessageId: 'target-message',
        generationInfo: { generationId: 'gen-stable' },
        streamProjection: {
          chatId: 'chat-target',
          messageId: 'target-message',
          generationId: 'gen-stable',
          previousData: 'prior text',
          ownedData: 'prior text plus streamed text',
          appended: false,
        },
      })

      expect(target.message).toEqual([expect.objectContaining({ chatId: 'target-message', data: 'prior text' })])
      expect(get(queuedGenerationPersistences)).toEqual([])
      expect(hydrationMock.hydrate).toHaveBeenCalledWith('chat-target', { force: true, strict: true })
    },
  )

  it('keeps a retry-queued reply visibly provisional until authoritative persistence', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message = [terminalMessage('streamed and queued')]

    const result = await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'database temporarily unavailable',
        persistenceDisposition: 'queued',
        generationProjection: {
          characterId: 'char-stable',
          chatId: 'chat-target',
          generationId: 'gen-stable',
          mode: 'send',
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'streamed and queued',
        appended: true,
      },
    })

    expect(result.status).toBe('failed')
    expect(target.message[0].data).toBe('streamed and queued')
    expect(get(queuedGenerationPersistences)).toEqual([
      { chatId: 'chat-target', messageId: 'gen-stable', generationId: 'gen-stable' },
    ])
  })

  it('clears provisional state only when hydration confirms the queued generation', () => {
    queuedGenerationPersistences.set([
      { chatId: 'chat-target', messageId: 'continued-message', generationId: 'new-generation' },
    ])

    acknowledgeHydratedGenerationPersistences('chat-target', [
      {
        role: 'char',
        data: 'old persisted text',
        chatId: 'continued-message',
        generationInfo: { generationId: 'old-generation' },
      },
    ])
    expect(get(queuedGenerationPersistences)).toHaveLength(1)

    acknowledgeHydratedGenerationPersistences('chat-target', [
      {
        role: 'char',
        data: 'new persisted text',
        chatId: 'continued-message',
        generationInfo: { generationId: 'new-generation' },
      },
    ])
    expect(get(queuedGenerationPersistences)).toEqual([])
  })

  it('does not remove a newer edit while reconciling an unconfirmed journal', async () => {
    const { char, target } = seedReorderedTerminalChats()
    target.message = [terminalMessage('newer user edit')]

    await applyServerBackedTerminal({
      terminal: {
        status: 'error',
        error: 'Generation finalization journal was not confirmed',
        persistenceDisposition: 'unconfirmed',
        generationProjection: {
          characterId: 'char-stable',
          chatId: 'chat-target',
          generationId: 'gen-stable',
          mode: 'send',
        },
      },
      currentChar: char,
      currentChat: target,
      selectedChar: 0,
      selectedChat: 0,
      targetCharacterId: 'char-stable',
      targetChatId: 'chat-target',
      generationInfo: { generationId: 'gen-stable' },
      streamProjection: {
        chatId: 'chat-target',
        messageId: 'gen-stable',
        generationId: 'gen-stable',
        previousData: '',
        ownedData: 'older streamed value',
        appended: true,
      },
    })

    expect(target.message[0].data).toBe('newer user edit')
    expect(get(queuedGenerationPersistences)).toEqual([])
    expect(hydrationMock.hydrate).toHaveBeenCalledWith('chat-target', { force: true, strict: true })
  })
})
