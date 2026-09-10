import { vi } from 'vitest'
import { abortChat, chatProcessStage, doingChat, sendChat } from '../process/index.svelte'
import {
  getServerChatCalls,
  resetServerChatState,
  serverChatFetch,
  setServerChatDispatchResult,
  setServerChatPrompt,
} from '../process/__fixtures__/mocks/serverChatFetch'
import { clearCachedServerCommandRevision } from '../server/commands'
import { testDatabaseState } from './resourceDatabaseState'
import { setDatabase, type Database, type character } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import { appendCurrentChatUserMessageForSend } from '../chatCommands'
import { seedCloneCostDb, withAsyncCloneInstrumentation, type CloneInstrumentation } from './cloneCostHarness'

export interface SendCloneCountProbeOptions {
  characterCount?: number
  hydratedMessageCount?: number
  messageBodySize?: number
  userMessage?: string
}

export interface SendCloneCountProbeFixture {
  characterCount: number
  messageCountBeforeSend: number
  messageCountAfterSubmit: number
  finalMessageCount: number
  messageBodySize: number
  transcriptJsonSizeBeforeSend: number
  activeChatJsonSizeBeforeSend: number
  activeCharacterJsonSizeBeforeSend: number
  charactersJsonSizeBeforeSend: number
}

export interface SendCloneCountProbeCommands {
  totalCommandCount: number
  messageReplaceCommandCount: number
  messageAppendCommandCount: number
  characterPatchCommandCount: number
  generationResultCommandCount: number
  persistedMessageCount: number
  persistedWholeTranscript: boolean
}

export interface SendCloneCountProbeServerChat {
  callCount: number
  mode: string
  userMessageLength: number
}

export interface SendCloneCountProbeResult extends CloneInstrumentation {
  ok: boolean
  fixture: SendCloneCountProbeFixture
  commands: SendCloneCountProbeCommands
  serverChat: SendCloneCountProbeServerChat
}

interface ProbeCommandCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

const DEFAULT_CHARACTER_COUNT = 3
const DEFAULT_HYDRATED_MESSAGE_COUNT = 40
const DEFAULT_MESSAGE_BODY_SIZE = 200
const DEFAULT_USER_MESSAGE = 'probe plain send'
const CLONE_JSON_STACK_NEEDLE = 'cloneJsonValue'
const PROBE_PERSONA_ID = 'probe-persona'
const PROBE_PRESET_ID = 'probe-preset'

function normalizeProbeCharacter(row: character, index: number): character {
  const record = row as character & Record<string, unknown>
  record.type = 'character'
  record.desc ??= ''
  record.firstMessage ??= ''
  record.customscript ??= []
  record.triggerscript ??= []
  record.utilityBot ??= false
  record.viewScreen ??= 'none'
  record.inlayViewScreen ??= false
  record.reloadKeys ??= 0
  record.globalLore ??= []
  record.chatFolders ??= []
  record.chats ??= []
  for (const [chatIndex, chat] of record.chats.entries()) {
    chat.id ??= `chat-${index}-${chatIndex}`
    chat.message ??= []
    chat.localLore ??= []
    chat.scriptstate ??= {}
    chat.fmIndex ??= -1
    chat.note ??= ''
    chat.generationSettings ??= {
      configured: true,
      personaId: PROBE_PERSONA_ID,
      modelPresetId: 'probe-model-preset',
      promptPresetId: PROBE_PRESET_ID,
      jailbreakToggle: false,
      sidebarToggles: {},
    }
  }
  return record
}

function seedProbeDb(options: Required<SendCloneCountProbeOptions>): SendCloneCountProbeFixture {
  const seeded = seedCloneCostDb({
    characterCount: options.characterCount,
    hydratedMessageCount: options.hydratedMessageCount,
    messageBodySize: options.messageBodySize,
  })
  const characters = seeded.characters.map((row, index) => normalizeProbeCharacter(row, index))

  setDatabase({
    ...seeded,
    aiModel: 'echo_model',
    subModel: 'echo_model',
    maxContext: 4000,
    maxResponse: 50,
    statics: { messages: 0 } as unknown as Database['statics'],
    promptInfoInsideChat: false,
    promptTextInfoInsideChat: false,
    selectedPersona: 0,
    personas: [
      {
        id: PROBE_PERSONA_ID,
        name: 'Probe User',
        personaPrompt: 'probe persona prompt',
        icon: '',
        note: '',
      },
    ],
    modelPresetsId: 0,
    modelPresets: [
      {
        id: 'probe-model-preset',
        name: 'Probe Model Preset',
        aiModel: 'echo_model',
        subModel: 'echo_model',
      },
    ],
    promptPresetsId: 0,
    promptPresets: [
      {
        id: PROBE_PRESET_ID,
        name: 'Probe Preset',
        customPromptTemplateToggle: '',
      },
    ],
    customPromptTemplateToggle: '',
    globalChatVariables: {},
    echoMessage: 'probe assistant reply',
    echoDelay: 0,
    modules: [],
    enabledModules: [],
    characters: characters as unknown as Database['characters'],
  } as unknown as Database)
  selectedCharID.set(0)
  ;(testDatabaseState.db as typeof testDatabaseState.db & { currentChar?: number }).currentChar = 0

  const activeCharacter = testDatabaseState.db.characters[0]
  const activeChat = activeCharacter.chats[activeCharacter.chatPage ?? 0]
  return {
    characterCount: testDatabaseState.db.characters.length,
    messageCountBeforeSend: activeChat.message.length,
    messageCountAfterSubmit: activeChat.message.length + 1,
    finalMessageCount: activeChat.message.length + 2,
    messageBodySize: options.messageBodySize,
    transcriptJsonSizeBeforeSend: JSON.stringify(activeChat.message).length,
    activeChatJsonSizeBeforeSend: JSON.stringify(activeChat).length,
    activeCharacterJsonSizeBeforeSend: JSON.stringify(activeCharacter).length,
    charactersJsonSizeBeforeSend: JSON.stringify(testDatabaseState.db.characters).length,
  }
}

function rawUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function pathFromUrl(input: RequestInfo | URL): string {
  const url = rawUrl(input)
  return url.startsWith('http') ? new URL(url).pathname : url
}

function commandResponse(revision: number, body?: Record<string, unknown> | null): Response {
  const message = body?.message as { chatId?: string } | undefined
  const messageId = message?.chatId ?? 'probe-command-message'
  return new Response(
    JSON.stringify({
      revision,
      event: { type: 'fixture.command', revision, resource: 'fixture' },
      chatId: 'chat-0',
      messageId,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function createProbeFetch(commandCalls: ProbeCommandCall[]): typeof fetch {
  let revision = 1
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = pathFromUrl(input)
    if (path === '/api/v1/bootstrap') {
      return new Response('{"revision":1,"database":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path.startsWith('/api/v1/commands/')) {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      commandCalls.push({
        url: path,
        method: init.method ?? 'GET',
        body,
      })
      revision += 1
      return commandResponse(revision, body)
    }
    return serverChatFetch(input, init)
  }) as typeof fetch
}

async function waitForCommand(
  calls: ProbeCommandCall[],
  predicate: (call: ProbeCommandCall) => boolean,
  label: string,
): Promise<void> {
  await vi.waitFor(() => {
    if (!calls.some(predicate)) throw new Error(`missing ${label} command`)
  })
}

function configureServerChatFixture(): void {
  resetServerChatState()
  setServerChatPrompt(
    [{ role: 'user', content: 'probe server prompt' }],
    { promptText: 'probe server prompt', inputTokens: 11, outputTokens: 22 },
    { formated: [{ role: 'user', content: 'probe server prompt' }] },
  )
  setServerChatDispatchResult(
    'probe assistant reply',
    {
      model: 'echo_model',
      inputTokens: 11,
      outputTokens: 22,
      maxContext: 4000,
      stageTiming: { stage1: 1, stage2: 0, stage3: 0, stage4: 0 },
    },
    'probe-generation',
  )
}

async function submitPlainUserMessage(userMessage: string): Promise<void> {
  const result = await appendCurrentChatUserMessageForSend({
    role: 'user',
    data: userMessage,
    time: Date.now(),
    name: null,
  })
  if (result.status === 'queued') {
    throw new Error('plain-send append was queued during the online clone-count probe')
  }
  if (result.status === 'error') {
    throw new Error(`plain-send append failed: ${result.error}`)
  }
}

function summarizeCommands(calls: ProbeCommandCall[], submittedMessageCount: number): SendCloneCountProbeCommands {
  const messageReplaceCalls = calls.filter(
    (call) => call.method === 'PUT' && /\/chats\/[^/]+\/messages$/.test(call.url),
  )
  const messageAppendCalls = calls.filter(
    (call) => call.method === 'POST' && /\/chats\/[^/]+\/messages$/.test(call.url),
  )
  const replacedMessageCount = messageReplaceCalls.reduce((max, call) => {
    const messages = call.body?.messages
    return Array.isArray(messages) ? Math.max(max, messages.length) : max
  }, 0)
  const appendedMessageCount = messageAppendCalls.reduce((max, call) => {
    return call.body && 'message' in call.body ? Math.max(max, 1) : max
  }, 0)
  const persistedMessageCount = Math.max(replacedMessageCount, appendedMessageCount)

  return {
    totalCommandCount: calls.length,
    messageReplaceCommandCount: messageReplaceCalls.length,
    messageAppendCommandCount: messageAppendCalls.length,
    characterPatchCommandCount: calls.filter((call) => call.method === 'PATCH' && /\/characters\/[^/]+$/.test(call.url))
      .length,
    generationResultCommandCount: calls.filter((call) => /\/generation-result$/.test(call.url)).length,
    persistedMessageCount,
    persistedWholeTranscript: replacedMessageCount === submittedMessageCount,
  }
}

function summarizeServerChat(): SendCloneCountProbeServerChat {
  const calls = getServerChatCalls()
  const first = calls[0]
  return {
    callCount: calls.length,
    mode: first?.mode ?? '',
    userMessageLength: first?.userMessage.length ?? 0,
  }
}

function resolveOptions(options: SendCloneCountProbeOptions): Required<SendCloneCountProbeOptions> {
  return {
    characterCount: options.characterCount ?? DEFAULT_CHARACTER_COUNT,
    hydratedMessageCount: options.hydratedMessageCount ?? DEFAULT_HYDRATED_MESSAGE_COUNT,
    messageBodySize: options.messageBodySize ?? DEFAULT_MESSAGE_BODY_SIZE,
    userMessage: options.userMessage ?? DEFAULT_USER_MESSAGE,
  }
}

export async function runSendCloneCountProbe(
  options: SendCloneCountProbeOptions = {},
): Promise<SendCloneCountProbeResult> {
  const resolved = resolveOptions(options)
  const commandCalls: ProbeCommandCall[] = []
  const originalFetch = globalThis.fetch

  clearCachedServerCommandRevision()
  configureServerChatFixture()
  doingChat.set(false)
  abortChat.set(false)
  chatProcessStage.set(0)
  const fixture = seedProbeDb(resolved)
  globalThis.fetch = createProbeFetch(commandCalls)

  try {
    const instrumented = await withAsyncCloneInstrumentation(
      async () => {
        await submitPlainUserMessage(resolved.userMessage)
        await waitForCommand(
          commandCalls,
          (call) => call.method === 'POST' && /\/chats\/[^/]+\/messages$/.test(call.url),
          'message append',
        )
        const ok = await sendChat(-1)
        await waitForCommand(
          commandCalls,
          (call) => call.method === 'PATCH' && /\/characters\/[^/]+$/.test(call.url),
          'character patch',
        )
        return ok
      },
      {
        countJsonStringify: ({ stack }) => stack.includes(CLONE_JSON_STACK_NEEDLE),
      },
    )

    const activeChat = testDatabaseState.db.characters[0].chats[testDatabaseState.db.characters[0].chatPage ?? 0]
    fixture.finalMessageCount = activeChat.message.length

    return {
      ok: instrumented.result,
      jsonCloneCount: instrumented.jsonCloneCount,
      structuredCloneCount: instrumented.structuredCloneCount,
      totalCloneCount: instrumented.totalCloneCount,
      maxClonedSize: instrumented.maxClonedSize,
      fixture,
      commands: summarizeCommands(commandCalls, fixture.messageCountAfterSubmit),
      serverChat: summarizeServerChat(),
    }
  } finally {
    globalThis.fetch = originalFetch
    doingChat.set(false)
    abortChat.set(false)
    chatProcessStage.set(0)
  }
}
