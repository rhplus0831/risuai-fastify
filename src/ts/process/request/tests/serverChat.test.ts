import { resetClientSessionForTests } from '../../../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const alertMocks = vi.hoisted(() => ({ alertToast: vi.fn() }))
const generationOperationMocks = vi.hoisted(() => ({
  applySseEvent: vi.fn(),
  reconcileErrorBody: vi.fn((): any => ({ disposition: 'unresolved' })),
  registerViewer: vi.fn((_operationId: string, _detach: () => void) => () => undefined),
  stopOperation: vi.fn(async (_operationId: string) => ({ status: 'acknowledged' })),
}))

vi.mock('../../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))

vi.mock('../../../server/activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-session-1' }),
  handleActiveWriterStaleResponse: vi.fn((response: Response) => response.status === 423),
}))

vi.mock('../../../alert', () => alertMocks)

vi.mock('../../../server/generationOperations', () => ({
  applyGenerationOperationSseEvent: generationOperationMocks.applySseEvent,
  reconcileGenerationOperationErrorBody: generationOperationMocks.reconcileErrorBody,
  registerGenerationOperationViewer: generationOperationMocks.registerViewer,
  stopGenerationOperation: generationOperationMocks.stopOperation,
}))

import {
  cancelServerChatGeneration,
  retireGenerationJobViewers,
  requestServerChat,
  requestServerChatGeneration,
  type ServerChatInput,
} from '../serverChat'
import { handleActiveWriterStaleResponse } from '../../../server/activeWriterSession'
import {
  CLIENT_PROMPT_CHAT_EVENT_TYPES,
  PROMPT_CHAT_EVENT_TYPES,
  type JobAcceptedEvent,
  type ServerChatMessagePatch,
} from '@risuai/protocol/generation-sse'
import {
  getServerChatCalls,
  resetServerChatState,
  serverChatFetch,
  setServerChatDispatchError,
  setServerChatDispatchResult,
  setServerChatError,
  setServerChatMessagePatch,
  setServerChatPrompt,
} from '../../__fixtures__/mocks/serverChatFetch'
import {
  clearPostGenerationProgress,
  postGenerationProgress,
  type ActivePostGenerationProgress,
} from '../../postGenerationProgress'
import {
  agentPresetProgress,
  clearAgentPresetProgress,
  type ActiveAgentPresetProgress,
} from '../../agentPresetProgress'
import {
  activeGenerationJobs,
  clearActiveGenerationJobProjection,
  forgetActiveGenerationJob,
  rememberActiveGenerationJob,
} from '../../reattach'
import {
  isClientAutomaticTranslationEligible,
  replaceAutomaticTranslationMessageIds,
  resetAutomaticTranslationEligibilityForTests,
} from '../../generatedMessageTranslationEligibility'
import {
  activeMessageTranslations,
  clearActiveMessageTranslation,
  setActiveMessageTranslations,
} from '../../../server/messageTranslationJobs'
import { halfStreamingProgress, resetHalfStreamingProgressForTests } from '../../halfStreamingProgress'
import { language } from '../../../../lang'

const baseInput: ServerChatInput = {
  chatId: 'chat-1',
  characterId: 'char-1',
  mode: 'send',
  userMessage: 'hi',
}

function findPostGenerationProgress(characterId: string, chatId: string): ActivePostGenerationProgress | undefined {
  return get(postGenerationProgress).find(
    (progress) => progress.target.characterId === characterId && progress.target.chatId === chatId,
  )
}

function findAgentPresetProgress(chatId: string): ActiveAgentPresetProgress | undefined {
  return get(agentPresetProgress).find((progress) => progress.chatId === chatId)
}

function findHalfStreamingProgress(generationId: string) {
  return get(halfStreamingProgress).find((progress) => progress.generationId === generationId)
}

function controlledGenerationStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
  return {
    response,
    send(event: string, data: Record<string, unknown>) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    },
    close() {
      controller.close()
    },
    error(error: unknown) {
      controller.error(error)
    },
  }
}

function sendGenerationReadyFrames(stream: ReturnType<typeof controlledGenerationStream>, generationId: string) {
  stream.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
  stream.send('info', {
    generationId,
    generationInfo: { generationId, model: 'm' },
  })
}

async function waitForAcceptedServerChatJob(jobId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(generationOperationMocks.applySseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'job_accepted', jobId }),
      expect.objectContaining({ chatId: 'chat-1', mode: 'send' }),
    )
  })
}

const incompleteChatSettingsBody = {
  statusCode: 409,
  error: 'chat_generation_settings_incomplete',
  message: 'Chat generation settings are incomplete',
  chatId: 'chat-1',
  missing: ['presetId'],
  staleSidebarToggleKeys: ['legacy-provider-toggle'],
}

describe('server chat SSE taxonomy', () => {
  it('keeps the client event vocabulary aligned with the server taxonomy', () => {
    expect(CLIENT_PROMPT_CHAT_EVENT_TYPES).toEqual(PROMPT_CHAT_EVENT_TYPES)

    const accepted: JobAcceptedEvent = { type: 'job_accepted', jobId: 'job-1' }
    expect(accepted.jobId).toBe('job-1')
  })
})

beforeEach(() => {
  resetClientSessionForTests()
  resetServerChatState()
  clearActiveGenerationJobProjection()
  resetAutomaticTranslationEligibilityForTests()
  clearActiveMessageTranslation('message-1')
  setActiveMessageTranslations([])
  localStorage.removeItem('risu:protocol-debug')
  vi.mocked(handleActiveWriterStaleResponse).mockClear()
  alertMocks.alertToast.mockReset()
  generationOperationMocks.applySseEvent.mockReset()
  generationOperationMocks.applySseEvent.mockImplementation(
    (data: Record<string, unknown>, job?: { chatId: string; mode?: 'send' | 'continue' | 'regenerate' }) => {
      if (data.type === 'job_accepted' && typeof data.jobId === 'string' && job) {
        rememberActiveGenerationJob({ ...job, jobId: data.jobId })
      }
      if ((data.type === 'done' || data.type === 'error') && typeof data.jobId === 'string') {
        forgetActiveGenerationJob(
          data.jobId,
          data.type === 'done' ? (data.outcome === 'cancelled' ? 'cancelled' : 'completed') : undefined,
        )
      }
    },
  )
  generationOperationMocks.reconcileErrorBody.mockReset()
  generationOperationMocks.reconcileErrorBody.mockReturnValue({ disposition: 'unresolved' })
  generationOperationMocks.registerViewer.mockReset()
  generationOperationMocks.registerViewer.mockReturnValue(() => undefined)
  generationOperationMocks.stopOperation.mockReset()
  generationOperationMocks.stopOperation.mockResolvedValue({ status: 'acknowledged' })
})

afterEach(() => {
  clearAgentPresetProgress()
  clearPostGenerationProgress()
  resetAutomaticTranslationEligibilityForTests()
  clearActiveMessageTranslation('message-1')
  setActiveMessageTranslations([])
  resetHalfStreamingProgressForTests()
  vi.unstubAllGlobals()
})

describe('requestServerChat', () => {
  it('parses the prompt + info events from a successful stream', async () => {
    setServerChatPrompt([{ role: 'user', content: 'hello there' }], { promptText: 'hello there' })
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.prompt.messages).toEqual([{ role: 'user', content: 'hello there' }])
    expect(res.prompt.promptInfo).toEqual({ promptText: 'hello there' })
    expect(res.info?.tokens).toEqual({ prompt: 7, total: 7 })
    expect(res.info?.responseBudget).toBe(50)
    expect(res.messagePatches).toEqual([])
  })

  it('surfaces the full formated rows + biases from the prompt event (7-12b)', async () => {
    setServerChatPrompt(
      [{ role: 'user', content: 'hi' }],
      { promptText: 'hi' },
      {
        formated: [{ role: 'user', content: 'hi', name: 'Tess' }],
        biases: [['hello', -100]],
      },
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.prompt.formated).toEqual([{ role: 'user', content: 'hi', name: 'Tess' }])
    expect(res.prompt.biases).toEqual([['hello', -100]])
  })

  it('collects message_patch events from the stream', async () => {
    const patch: ServerChatMessagePatch = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      varChanged: true,
      messageMutations: [
        {
          type: 'replace_all',
          source: 'run_var',
          beforeLength: 1,
          afterLength: 1,
          messages: [{ role: 'user', data: 'hello' }],
        },
      ],
      chatVarMutations: [{ key: '$mood', before: null, after: 'bright' }],
      additionalSystemPrompt: [],
    }
    setServerChatMessagePatch(patch)
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.messagePatches).toEqual([patch])
  })

  it('sends the intent body with auth and active-writer headers', async () => {
    vi.stubGlobal('fetch', serverChatFetch)
    await requestServerChat(baseInput, null)

    const calls = getServerChatCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      authHeader: 'test-auth-token',
      writerHeader: 'writer-session-1',
      callerHeader: 'chat-generate',
      chatId: 'chat-1',
      characterId: 'char-1',
      mode: 'send',
      clientCapabilities: { compactPromptEvent: true },
    })
    expect(calls[0]?.clientCapabilities).toEqual({
      compactPromptEvent: true,
      promptMetadataOnly: true,
      omitDuplicateDoneResult: true,
      hypaContextTruncationConfirmation: true,
      regenerateTargetProjection: 1,
    })
    expect(calls[0]?.clientContext).toEqual({
      browserLanguage: navigator.language,
      screenWidth: window.innerWidth,
      screenHeight: window.innerHeight,
    })
  })

  it('forwards the optional synthetic say-nothing marker additively', async () => {
    vi.stubGlobal('fetch', serverChatFetch)
    await requestServerChat({ ...baseInput, userMessage: '*says nothing*', syntheticSayNothing: true }, null)

    expect(getServerChatCalls()[0]).toMatchObject({
      mode: 'send',
      userMessage: '*says nothing*',
      syntheticSayNothing: true,
    })
  })

  it('labels preview prompt requests with x-risu-caller: preview-prompt', async () => {
    vi.stubGlobal('fetch', serverChatFetch)
    await requestServerChat({ ...baseInput, mode: 'preview_prompt', userMessage: undefined }, null)

    const calls = getServerChatCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      callerHeader: 'preview-prompt',
      mode: 'preview_prompt',
    })
  })

  it('accepts compact prompt events without the legacy duplicate fields', async () => {
    vi.stubGlobal('fetch', async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            enc.encode(
              'event: prompt\ndata: {"promptInfo":{"promptText":"hi"},"formated":[{"role":"user","content":"hi"}]}\n\n',
            ),
          )
          controller.enqueue(enc.encode('event: info\ndata: {"tokens":{"prompt":1,"total":1},"responseBudget":50}\n\n'))
          controller.enqueue(enc.encode('event: done\ndata: {}\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const res = await requestServerChat(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.prompt.messages).toBeUndefined()
    expect(res.prompt.lorebookActivation).toBeUndefined()
    expect(res.prompt.formated).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('sends regenerate intent with the target message id', async () => {
    vi.stubGlobal('fetch', serverChatFetch)
    await requestServerChat(
      {
        chatId: 'chat-1',
        characterId: 'char-1',
        mode: 'regenerate',
        regenerateMessageId: 'msg-assistant-1',
      },
      null,
    )

    const calls = getServerChatCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      mode: 'regenerate',
      regenerateMessageId: 'msg-assistant-1',
      userMessage: '',
    })
  })

  it('surfaces a terminal error event as a status:error result', async () => {
    setServerChatError('character not found')
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({ status: 'error', error: 'character not found' })
  })

  it('uses a fallback when a prompt error event has an empty message', async () => {
    setServerChatError('')
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'Server returned an error without details during prompt assembly.',
    })
  })

  it('keeps pre-error message patches visible for stop-trigger aborts', async () => {
    const patch: ServerChatMessagePatch = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      varChanged: true,
      messageMutations: [
        {
          type: 'replace_all',
          source: 'start_trigger',
          beforeLength: 1,
          afterLength: 2,
          messages: [
            { role: 'user', data: 'hi' },
            { role: 'char', data: 'mutated before stop' },
          ],
        },
      ],
      chatVarMutations: [{ key: '$score', before: '1', after: '9' }],
      additionalSystemPrompt: [],
    }
    setServerChatError('Generation was stopped by a start trigger.', { messagePatch: patch })
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'Generation was stopped by a start trigger.',
      messagePatches: [patch],
    })
  })

  it('maps a pre-stream 400 JSON body to status:error', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'chatId is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const res = await requestServerChat({ ...baseInput, chatId: '' }, null)
    expect(res).toEqual({ status: 'error', error: 'chatId is required' })
  })

  it('preserves the non-Hypa truncation confirmation code from pre-stream errors', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: 'hypa_context_truncation_confirmation_required',
            message: 'Confirmation is required before omitting older chat history without Hypa Memory.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )

    await expect(requestServerChat(baseInput, null)).resolves.toEqual({
      status: 'error',
      error: 'Confirmation is required before omitting older chat history without Hypa Memory.',
      code: 'hypa_context_truncation_confirmation_required',
    })
  })

  it('uses the stable incomplete chat settings message for prompt-only 409s', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(incompleteChatSettingsBody), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'Chat generation settings are incomplete',
    })
  })

  it('uses the human reason for generation-in-progress 409s', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: 'generation_in_progress',
            reason: 'A generation is already running for this chat.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'A generation is already running for this chat.',
      code: 'generation_in_progress',
    })
  })

  it('handles stale writer responses before opening the stream', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['risu-writer-session']).toBe('writer-session-1')
      return new Response(JSON.stringify({ error: 'active_writer_stale' }), {
        status: 423,
        headers: { 'content-type': 'application/json' },
      })
    })

    const res = await requestServerChat(baseInput, null)

    expect(res).toEqual({ status: 'error', error: 'active_writer_stale' })
    expect(handleActiveWriterStaleResponse).toHaveBeenCalledTimes(1)
  })

  it('returns status:aborted when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      // a real fetch rejects on an already-aborted signal
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return new Response(null, { status: 200 })
    })

    const res = await requestServerChat(baseInput, controller.signal)
    expect(res).toEqual({ status: 'aborted' })
  })

  it('reports a stream that ends without a prompt event', async () => {
    vi.stubGlobal('fetch', async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: stage\ndata: {"stage":"prompt","status":"start"}\n\n'))
          controller.enqueue(enc.encode('event: done\ndata: {}\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const res = await requestServerChat(baseInput, null)
    expect(res).toEqual({ status: 'error', error: 'stream ended without a prompt event' })
  })

  it('ignores unknown / dispatch-coupled events (token, side_effect)', async () => {
    vi.stubGlobal('fetch', async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: token\ndata: {"content":"x"}\n\n'))
          controller.enqueue(enc.encode('event: side_effect\ndata: {"kind":"tts","payload":{}}\n\n'))
          controller.enqueue(enc.encode('event: prompt\ndata: {"messages":[{"role":"user","content":"hi"}]}\n\n'))
          controller.enqueue(enc.encode('event: done\ndata: {}\n\n'))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const res = await requestServerChat(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.prompt.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('returns a streaming dispatch response from token + enriched done events', async () => {
    setServerChatPrompt([{ role: 'user', content: 'hello there' }], { promptText: 'hello there' })
    setServerChatDispatchResult(
      'server reply',
      {
        model: 'echo_model',
        inputTokens: 7,
        outputTokens: 50,
        maxContext: 4000,
        stageTiming: { stage1: 1, stage2: 0, stage3: 2, stage4: 0 },
      },
      'uuid-0',
      { alternates: ['second reply', 'third reply'] },
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    expect(res.generationId).toBe('uuid-0')
    expect(res.generationInfo).toMatchObject({
      model: 'echo_model',
      generationId: 'uuid-0',
      inputTokens: 7,
      outputTokens: 50,
    })
    expect(res.req.type).toBe('streaming')
    if (res.req.type !== 'streaming') return
    const reader = res.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'uuid-0': 'server reply' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(res.terminal).resolves.toMatchObject({
      status: 'done',
      done: {
        result: 'server reply',
        alternates: ['second reply', 'third reply'],
        generationId: 'uuid-0',
      },
    })
    const calls = getServerChatCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      callerHeader: 'chat-generate',
    })
  })

  it('half-streaming reports throughput but releases response text only on done', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null)
    controlled.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
    controlled.send('info', {
      halfStreaming: true,
      generationId: 'half-generation',
      generationInfo: { generationId: 'half-generation', model: 'm' },
    })

    const res = await pending
    expect(res.status).toBe('ok')
    if (res.status !== 'ok' || res.req.type !== 'streaming') return
    expect(res.req).toMatchObject({ halfStreaming: true, halfStreamingProgressManaged: true })

    const reader = res.req.result.getReader()
    let partialReadResolved = false
    const partialRead = reader.read().then((value) => {
      partialReadResolved = true
      return value
    })

    controlled.send('token', { content: 'Hel' })
    controlled.send('token', { content: 'lo' })
    await vi.waitFor(() => {
      expect(findHalfStreamingProgress('half-generation')?.generatedTokens).toBe(2)
    })

    expect(partialReadResolved).toBe(false)
    expect(findHalfStreamingProgress('half-generation')).toMatchObject({
      chatId: baseInput.chatId,
      generationId: 'half-generation',
      generatedTokens: 2,
    })

    controlled.send('done', { result: 'Hello', generationId: 'half-generation' })
    controlled.close()

    await expect(partialRead).resolves.toEqual({
      done: false,
      value: { 'half-generation': 'Hello' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(res.terminal).resolves.toMatchObject({ status: 'done' })
  })

  it('uses server progress for a half-streamed gateway response delivered in one token event', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null)
    controlled.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
    controlled.send('info', {
      halfStreaming: true,
      generationId: 'gateway-generation',
      generationInfo: { generationId: 'gateway-generation', model: 'llmgateway/gpt-5' },
    })

    const res = await pending
    expect(res.status).toBe('ok')
    if (res.status !== 'ok' || res.req.type !== 'streaming') return

    const reader = res.req.result.getReader()
    let partialReadResolved = false
    const partialRead = reader.read().then((value) => {
      partialReadResolved = true
      return value
    })

    controlled.send('token', {
      content: 'A complete batched gateway response.',
      generatedTokens: 9,
    })
    await vi.waitFor(() => {
      expect(findHalfStreamingProgress('gateway-generation')).toMatchObject({
        generatedTokens: 9,
        tokensPerSecond: 0,
      })
    })
    expect(partialReadResolved).toBe(false)

    controlled.send('done', {
      result: 'A complete batched gateway response.',
      generationId: 'gateway-generation',
    })
    controlled.close()

    await expect(partialRead).resolves.toEqual({
      done: false,
      value: { 'gateway-generation': 'A complete batched gateway response.' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
  })

  it.each([false, true])('handles progress-only Strip CoT frames with halfStreaming=%s', async (halfStreaming) => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)
    const pending = requestServerChatGeneration(baseInput, null)
    controlled.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
    controlled.send('info', {
      halfStreaming,
      generationId: 'stripped-generation',
      generationInfo: { generationId: 'stripped-generation', model: 'llmgateway/test' },
    })
    const res = await pending
    expect(res.status).toBe('ok')
    if (res.status !== 'ok' || res.req.type !== 'streaming') return
    const reader = res.req.result.getReader()
    let readResolved = false
    const firstRead = reader.read().then((value) => {
      readResolved = true
      return value
    })

    controlled.send('token', { content: '', generatedTokens: 12, elapsedMs: 2_000 })
    if (halfStreaming) {
      await vi.waitFor(() =>
        expect(findHalfStreamingProgress('stripped-generation')).toMatchObject({
          generatedTokens: 12,
          tokensPerSecond: 0,
        }),
      )
    } else {
      // Drain event handling without permitting an empty text update.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    expect(readResolved).toBe(false)

    controlled.send('token', { content: 'Visible answer', generatedTokens: 15, elapsedMs: 3_000 })
    if (halfStreaming) {
      await vi.waitFor(() =>
        expect(findHalfStreamingProgress('stripped-generation')).toMatchObject({
          generatedTokens: 15,
        }),
      )
      expect(readResolved).toBe(false)
    } else {
      await expect(firstRead).resolves.toEqual({ done: false, value: { 'stripped-generation': 'Visible answer' } })
    }
    controlled.send('done', { result: 'Visible answer', generationId: 'stripped-generation' })
    controlled.close()
    await expect(firstRead).resolves.toEqual({ done: false, value: { 'stripped-generation': 'Visible answer' } })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(res.terminal).resolves.toMatchObject({ status: 'done' })
  })

  it('reattaches a durable stream after a mobile-style transport drop without duplicating replayed tokens', async () => {
    const first = controlledGenerationStream()
    const calls: Array<{ url: string; method: string }> = []
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST') return first.response

      const replay = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: job_accepted\ndata: {"jobId":"job-mobile"}\n\n'))
          controller.enqueue(encoder.encode('event: prompt\ndata: {"promptInfo":{}}\n\n'))
          controller.enqueue(
            encoder.encode(
              'event: info\ndata: {"generationId":"job-mobile","generationInfo":{"generationId":"job-mobile","model":"m"}}\n\n',
            ),
          )
          controller.enqueue(encoder.encode('event: token\ndata: {"content":"partial"}\n\n'))
          controller.enqueue(encoder.encode('event: token\ndata: {"content":" recovered"}\n\n'))
          controller.enqueue(
            encoder.encode(
              'event: done\ndata: {"result":"partial recovered","generationId":"job-mobile","generationInfo":{"generationId":"job-mobile"}}\n\n',
            ),
          )
          controller.close()
        },
      })
      return new Response(replay, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const pending = requestServerChatGeneration({ ...baseInput, durable: true }, null)
    first.send('job_accepted', { jobId: 'job-mobile' })
    sendGenerationReadyFrames(first, 'job-mobile')
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-mobile', mode: 'send' }])

    const reader = served.req.result.getReader()
    first.send('token', { content: 'partial' })
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-mobile': 'partial' },
    })
    first.error(new TypeError('NetworkError: connection was suspended'))

    // Reattach replays the token history. The accumulator resets first, so the
    // replay replaces the partial projection instead of producing
    // `partialpartial recovered`.
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-mobile': 'partial' },
    })
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-mobile': 'partial recovered' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      done: { result: 'partial recovered', generationId: 'job-mobile' },
    })
    expect(calls).toEqual([
      { url: '/api/v1/generate/chat', method: 'POST' },
      { url: '/api/v1/generate/chat/job-mobile/stream', method: 'GET' },
    ])
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('suppresses a gap-truncated suffix and fetches the canonical terminal snapshot before closing', async () => {
    const controlled = controlledGenerationStream()
    const calls: Array<{ url: string; method: string; caller: string | null }> = []
    const terminalPayload = {
      result: 'evicted prefix retained suffix',
      generationId: 'job-side-channel',
      generationInfo: { generationId: 'job-side-channel', model: 'm' },
    }
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const headers = new Headers(init?.headers)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        caller: headers.get('x-risu-caller'),
      })
      if (url.endsWith('/terminal-snapshot')) {
        return new Response(JSON.stringify(terminalPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return controlled.response
    })

    const pending = requestServerChatGeneration(baseInput, null, 'job-side-channel')
    sendGenerationReadyFrames(controlled, 'job-side-channel')
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return

    const reader = served.req.result.getReader()
    let suffixReadResolved = false
    const firstRead = reader.read().then((value) => {
      suffixReadResolved = true
      return value
    })
    controlled.send('replay_gap', {
      reason: 'replay_budget_exceeded',
      jobId: 'job-side-channel',
      evictedEvents: 4,
      evictedBytes: 128,
    })
    controlled.send('token', { content: 'retained suffix' })
    await vi.waitFor(() => {
      expect(served.req.type === 'streaming' && served.req.replayGapTruncated).toBe(true)
    })
    expect(suffixReadResolved).toBe(false)
    expect(served.req.replayGapPending).toBe(true)

    controlled.send('done', {
      terminalSnapshot: {
        version: 1,
        href: '/api/v1/generate/chat/job-side-channel/terminal-snapshot',
        bytes: JSON.stringify(terminalPayload).length,
      },
      jobId: 'job-side-channel',
    })
    controlled.close()

    await expect(firstRead).resolves.toEqual({
      done: false,
      value: { 'job-side-channel': 'evicted prefix retained suffix' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    expect(served.req.replayGapPending).toBe(false)
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      reattachOutcome: 'completed',
      done: terminalPayload,
    })
    expect(calls).toEqual([
      {
        url: '/api/v1/generate/chat/job-side-channel/stream',
        method: 'GET',
        caller: 'chat-reattach',
      },
      {
        url: '/api/v1/generate/chat/job-side-channel/terminal-snapshot',
        method: 'GET',
        caller: 'chat-terminal-snapshot',
      },
    ])
  })

  it('consumes a canonical terminal after a replay gap evicts prompt and info readiness', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration({ ...baseInput, mode: 'continue' }, null, 'job-terminal-gap')
    controlled.send('replay_gap', {
      reason: 'replay_budget_exceeded',
      jobId: 'job-terminal-gap',
      evictedEvents: 2,
      evictedBytes: 2_500_000,
    })
    controlled.send('done', {
      result: 'Canonical terminal reply.',
      generationId: 'generation-terminal-gap',
      generationInfo: { generationId: 'generation-terminal-gap', model: 'test-model' },
      continueDisposition: 'extend',
      continueBase: 'Existing answer.',
    })
    controlled.close()

    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return
    expect(served.prompt).toEqual({})
    expect(served.info).toMatchObject({
      generationId: 'generation-terminal-gap',
      continueDisposition: 'extend',
      continueBase: 'Existing answer.',
    })
    expect(served.req.continueBase).toBe('Existing answer.')
    await expect(served.req.result.getReader().read()).resolves.toEqual({
      done: false,
      value: { 'generation-terminal-gap': 'Canonical terminal reply.' },
    })
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      reattachOutcome: 'completed',
      done: { result: 'Canonical terminal reply.' },
    })
  })

  it.each([
    { mode: 'send' as const, changed: false },
    { mode: 'send' as const, changed: true },
    { mode: 'continue' as const, changed: false },
    { mode: 'continue' as const, changed: true },
    { mode: 'regenerate' as const, changed: false },
    { mode: 'regenerate' as const, changed: true },
  ])(
    'replaces a retained $mode replay suffix before closing (post-generation changed: $changed)',
    async ({ mode, changed }) => {
      const controlled = controlledGenerationStream()
      vi.stubGlobal('fetch', async () => controlled.response)

      const pending = requestServerChatGeneration({ ...baseInput, mode }, null, 'job-gap')
      sendGenerationReadyFrames(controlled, 'job-gap')
      const served = await pending
      expect(served.status).toBe('ok')
      if (served.status !== 'ok' || served.req.type !== 'streaming') return

      const reader = served.req.result.getReader()
      controlled.send('token', { content: 'retained suffix' })
      controlled.send('done', {
        result: 'evicted prefix retained suffix',
        generationId: 'job-gap',
        generationInfo: { generationId: 'job-gap' },
        ...(changed ? { postGeneration: { finalText: 'derived complete whole-row text' } } : {}),
      })
      controlled.close()

      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { 'job-gap': 'retained suffix' },
      })
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { 'job-gap': 'evicted prefix retained suffix' },
      })
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
      await expect(served.terminal).resolves.toMatchObject({
        status: 'done',
        reattachOutcome: 'completed',
        done: {
          result: 'evicted prefix retained suffix',
          ...(changed ? { postGeneration: { finalText: 'derived complete whole-row text' } } : {}),
        },
      })
    },
  )

  it('emits exactly one complete terminal snapshot for half-streaming after a replay gap', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration({ ...baseInput, durable: true }, null)
    controlled.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
    controlled.send('info', {
      halfStreaming: true,
      generationId: 'half-gap',
      generationInfo: { generationId: 'half-gap', model: 'm' },
    })
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return

    const reader = served.req.result.getReader()
    controlled.send('token', { content: 'retained suffix' })
    controlled.send('done', {
      result: 'evicted prefix retained suffix',
      generationId: 'half-gap',
      generationInfo: { generationId: 'half-gap' },
    })
    controlled.close()

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'half-gap': 'evicted prefix retained suffix' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
  })

  it('reports a reattached cancelled terminal without losing its persisted partial snapshot', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null, 'job-cancelled')
    sendGenerationReadyFrames(controlled, 'job-cancelled')
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return

    const reader = served.req.result.getReader()
    controlled.send('token', { content: 'partial suffix' })
    controlled.send('done', {
      outcome: 'cancelled',
      result: 'complete partial suffix',
      generationId: 'job-cancelled',
      generationInfo: { generationId: 'job-cancelled' },
      postGeneration: { messageId: 'job-cancelled', revision: 3 },
    })
    controlled.close()

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-cancelled': 'partial suffix' },
    })
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-cancelled': 'complete partial suffix' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(served.terminal).resolves.toMatchObject({
      status: 'cancelled',
      reattachOutcome: 'cancelled',
      done: { outcome: 'cancelled', result: 'complete partial suffix' },
    })
  })

  it('reconstructs the full result when compact done omits the streamed duplicate', async () => {
    vi.stubGlobal('fetch', async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: prompt\ndata: {"promptInfo":{}}\n\n'))
          controller.enqueue(
            enc.encode(
              'event: info\ndata: {"generationId":"gen-compact","generationInfo":{"generationId":"gen-compact","model":"m"}}\n\n',
            ),
          )
          controller.enqueue(enc.encode('event: token\ndata: {"content":"server "}\n\n'))
          controller.enqueue(enc.encode('event: token\ndata: {"content":"reply"}\n\n'))
          controller.enqueue(
            enc.encode(
              'event: done\ndata: {"generationId":"gen-compact","generationInfo":{"generationId":"gen-compact"}}\n\n',
            ),
          )
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok' || res.req.type !== 'streaming') return
    const reader = res.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'gen-compact': 'server ' },
    })
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'gen-compact': 'server reply' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    const terminal = await res.terminal
    expect(terminal.status).toBe('done')
    expect(terminal.done).toMatchObject({ generationId: 'gen-compact' })
    expect(Object.hasOwn(terminal.done ?? {}, 'result')).toBe(false)
  })

  it('projects the server-selected append disposition onto a Continue stream', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration({ ...baseInput, mode: 'continue' }, null)
    controlled.send('prompt', { promptInfo: {} })
    controlled.send('info', {
      generationId: 'gen-append-continue',
      generationInfo: { generationId: 'gen-append-continue', model: 'm' },
      continueDisposition: 'append',
    })
    const served = await pending

    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return
    expect(served.info?.continueDisposition).toBe('append')
    expect(served.req.continueDisposition).toBe('append')

    controlled.send('done', {
      generationId: 'gen-append-continue',
      generationInfo: { generationId: 'gen-append-continue', model: 'm' },
    })
    controlled.close()
    const reader = served.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(served.terminal).resolves.toMatchObject({ status: 'done' })
  })

  it('keeps delivered token text authoritative for an inline stream with a different done fallback', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null)
    sendGenerationReadyFrames(controlled, 'inline-generation')
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return

    const reader = served.req.result.getReader()
    controlled.send('token', { content: 'inline token text' })
    controlled.send('done', {
      result: 'unused inline fallback',
      generationId: 'inline-generation',
      generationInfo: { generationId: 'inline-generation' },
    })
    controlled.close()

    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'inline-generation': 'inline token text' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      done: { result: 'unused inline fallback' },
    })
  })

  it('parses a running translation frame and consumes generated-row client eligibility', async () => {
    replaceAutomaticTranslationMessageIds(['message-1'])
    setServerChatDispatchResult('server reply', { model: 'm' }, 'gen-translation', {
      postGeneration: {
        messageId: 'message-1',
        translation: { status: 'running', jobId: 'translation-job-1' },
      },
    })
    vi.stubGlobal('fetch', serverChatFetch)

    const served = await requestServerChatGeneration(baseInput, null)
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return
    const reader = served.req.result.getReader()
    while (!(await reader.read()).done) {
      // Drain through the terminal done frame.
    }
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      done: {
        postGeneration: {
          messageId: 'message-1',
          translation: { status: 'running', jobId: 'translation-job-1' },
        },
      },
    })
    expect(isClientAutomaticTranslationEligible('message-1')).toBe(false)
    expect(get(activeMessageTranslations)).toContainEqual({
      chatId: 'chat-1',
      messageId: 'message-1',
      jobId: 'translation-job-1',
      status: 'running',
    })
  })

  it('uses done.result when a response has no token frames', async () => {
    vi.stubGlobal('fetch', async () => {
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: prompt\ndata: {"promptInfo":{}}\n\n'))
          controller.enqueue(
            enc.encode(
              'event: info\ndata: {"generationId":"gen-buffered","generationInfo":{"generationId":"gen-buffered","model":"m"}}\n\n',
            ),
          )
          controller.enqueue(
            enc.encode(
              'event: done\ndata: {"result":"buffered reply","generationId":"gen-buffered","generationInfo":{"generationId":"gen-buffered"}}\n\n',
            ),
          )
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok' || res.req.type !== 'streaming') return
    const reader = res.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'gen-buffered': 'buffered reply' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(res.terminal).resolves.toMatchObject({
      status: 'done',
      done: { result: 'buffered reply', generationId: 'gen-buffered' },
    })
  })

  it('does not emit X-Request-UID debug logging for cancel by default', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', serverChatFetch)

      await cancelServerChatGeneration('uuid-cancel')

      expect(debug).not.toHaveBeenCalled()
      expect(getServerChatCalls()).toHaveLength(1)
    } finally {
      debug.mockRestore()
    }
  })

  it('emits cancel X-Request-UID debug logging when protocol debug is opt-in', async () => {
    localStorage.setItem('risu:protocol-debug', '1')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', serverChatFetch)

      await cancelServerChatGeneration('uuid-cancel')

      expect(debug).toHaveBeenCalledTimes(1)
      expect(debug).toHaveBeenCalledWith('[risu:protocol]', 'server-chat-cancel-response', {
        requestUid: 'fixture-cancel-request-uid',
        status: 202,
        ok: true,
      })
    } finally {
      debug.mockRestore()
    }
  })

  it('collects side_effect events on the terminal dispatch result', async () => {
    setServerChatPrompt([{ role: 'user', content: 'hello there' }], { promptText: 'hello there' })
    setServerChatDispatchResult(
      'server reply',
      {
        model: 'echo_model',
        inputTokens: 7,
        outputTokens: 50,
      },
      'uuid-tts',
      { emitTtsSideEffect: true },
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    await expect(res.terminal).resolves.toMatchObject({
      status: 'done',
      sideEffects: [{ kind: 'tts', payload: { text: 'server reply', characterId: 'char-1' } }],
    })
  })

  it('updates and clears post-generation Lua progress from generation streams', async () => {
    const snapshots: ActivePostGenerationProgress[][] = []
    const unsubscribe = postGenerationProgress.subscribe((value) => {
      snapshots.push(value)
    })
    try {
      vi.stubGlobal('fetch', async () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode('event: prompt\ndata: {"messages":[{"role":"user","content":"hi"}]}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: info\ndata: {"generationId":"gen-progress","generationInfo":{"generationId":"gen-progress","model":"m"}}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: token\ndata: {"content":"ok"}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: post_generation_progress\ndata: {"phase":"onOutput","status":"started","runSeq":1,"ownerType":"module","ownerName":"Translator","llmCallCount":0,"pendingLlmCount":0,"llmCallCounts":{"LLM":0,"axLLM":0},"pendingLlmCounts":{"LLM":0,"axLLM":0}}\n\n',
              ),
            )
            controller.enqueue(
              enc.encode(
                'event: post_generation_progress\ndata: {"phase":"onOutput","status":"running","runSeq":1,"ownerType":"module","ownerName":"Translator","llmCallCount":1,"pendingLlmCount":1,"llmCallCounts":{"LLM":0,"axLLM":1},"pendingLlmCounts":{"LLM":0,"axLLM":1}}\n\n',
              ),
            )
            controller.enqueue(
              enc.encode(
                'event: done\ndata: {"result":"ok","generationId":"gen-progress","generationInfo":{"generationId":"gen-progress"}}\n\n',
              ),
            )
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })

      const res = await requestServerChatGeneration(baseInput, null)
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      await expect(res.terminal).resolves.toMatchObject({ status: 'done' })
      expect(snapshots.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { characterId: 'char-1', chatId: 'chat-1' },
            phase: 'onOutput',
            ownerType: 'module',
            ownerName: 'Translator',
            llmCallCount: 1,
            pendingLlmCount: 1,
          }),
        ]),
      )
      expect(get(postGenerationProgress)).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("keeps concurrent chat streams from replacing or clearing each other's post-generation progress", async () => {
    const sendProgress = (
      stream: ReturnType<typeof controlledGenerationStream>,
      ownerName: string,
      status: 'started' | 'running',
    ) => {
      stream.send('post_generation_progress', {
        phase: 'onOutput',
        status,
        runSeq: 1,
        ownerType: 'module',
        ownerName,
        llmCallCount: status === 'started' ? 0 : 1,
        pendingLlmCount: status === 'started' ? 0 : 1,
        llmCallCounts: { LLM: 0, axLLM: status === 'started' ? 0 : 1 },
        pendingLlmCounts: { LLM: 0, axLLM: status === 'started' ? 0 : 1 },
      })
    }

    const first = controlledGenerationStream()
    const second = controlledGenerationStream()
    const responses = [first.response, second.response]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    )

    const firstPending = requestServerChatGeneration(baseInput, null)
    sendGenerationReadyFrames(first, 'gen-first')
    sendProgress(first, 'First Chat Script', 'started')
    const firstResult = await firstPending
    expect(firstResult.status).toBe('ok')
    if (firstResult.status !== 'ok') return
    await vi.waitFor(() => {
      expect(findPostGenerationProgress('char-1', 'chat-1')).toMatchObject({
        target: { characterId: 'char-1', chatId: 'chat-1' },
        ownerName: 'First Chat Script',
      })
    })

    const secondInput = { ...baseInput, characterId: 'char-2', chatId: 'chat-2' }
    const secondPending = requestServerChatGeneration(secondInput, null)
    sendGenerationReadyFrames(second, 'gen-second')
    sendProgress(second, 'Second Chat Script', 'running')
    const secondResult = await secondPending
    expect(secondResult.status).toBe('ok')
    if (secondResult.status !== 'ok') return
    await vi.waitFor(() => {
      expect(findPostGenerationProgress('char-2', 'chat-2')).toMatchObject({
        target: { characterId: 'char-2', chatId: 'chat-2' },
        ownerName: 'Second Chat Script',
      })
    })

    sendProgress(first, 'Late First Chat Script', 'running')
    await vi.waitFor(() => {
      expect(findPostGenerationProgress('char-1', 'chat-1')).toMatchObject({
        ownerName: 'Late First Chat Script',
      })
      expect(findPostGenerationProgress('char-2', 'chat-2')).toMatchObject({
        ownerName: 'Second Chat Script',
      })
    })
    first.send('done', { generationId: 'gen-first', generationInfo: { generationId: 'gen-first' } })
    first.close()
    await expect(firstResult.terminal).resolves.toMatchObject({ status: 'done' })
    expect(findPostGenerationProgress('char-1', 'chat-1')).toBeUndefined()
    expect(findPostGenerationProgress('char-2', 'chat-2')).toMatchObject({
      target: { characterId: 'char-2', chatId: 'chat-2' },
      ownerName: 'Second Chat Script',
    })

    second.send('done', { generationId: 'gen-second', generationInfo: { generationId: 'gen-second' } })
    second.close()
    await expect(secondResult.terminal).resolves.toMatchObject({ status: 'done' })
    expect(get(postGenerationProgress)).toEqual([])
  })

  it('updates and clears Agent Preset progress from generation streams', async () => {
    const snapshots: ActiveAgentPresetProgress[][] = []
    const unsubscribe = agentPresetProgress.subscribe((value) => snapshots.push(value))
    try {
      vi.stubGlobal('fetch', async () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              enc.encode(
                'event: agent_preset_progress\ndata: {"chatId":"chat-1","presetId":"ap-1","presetName":"Research","phase":"beforeMain","status":"started","totalSteps":2,"completedSteps":0,"activeSteps":[]}\n\n',
              ),
            )
            controller.enqueue(
              enc.encode(
                'event: agent_preset_progress\ndata: {"chatId":"chat-1","presetId":"ap-1","presetName":"Research","phase":"beforeMain","status":"running","totalSteps":2,"completedSteps":1,"activeSteps":[{"stepId":"step-2","stepName":"Critique","outputKey":"critique"}]}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: prompt\ndata: {"messages":[{"role":"user","content":"hi"}]}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: info\ndata: {"generationId":"gen-agent-progress","generationInfo":{"generationId":"gen-agent-progress","model":"m"}}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: token\ndata: {"content":"ok"}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: done\ndata: {"result":"ok","generationId":"gen-agent-progress","generationInfo":{"generationId":"gen-agent-progress"}}\n\n',
              ),
            )
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })

      const res = await requestServerChatGeneration(baseInput, null)
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      await expect(res.terminal).resolves.toMatchObject({ status: 'done' })
      expect(snapshots.flat()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chatId: 'chat-1',
            presetName: 'Research',
            phase: 'beforeMain',
            completedSteps: 1,
            activeSteps: [expect.objectContaining({ stepName: 'Critique' })],
          }),
        ]),
      )
      expect(get(agentPresetProgress)).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it("keeps concurrent chat streams from replacing or clearing each other's Agent Preset progress", async () => {
    const sendProgress = (
      stream: ReturnType<typeof controlledGenerationStream>,
      chatId: string,
      presetName: string,
      status: 'started' | 'running',
    ) => {
      stream.send('agent_preset_progress', {
        chatId,
        presetId: `preset-${chatId}`,
        presetName,
        phase: 'beforeMain',
        status,
        totalSteps: 2,
        completedSteps: status === 'started' ? 0 : 1,
        activeSteps: status === 'started' ? [] : [{ stepId: 'step-2', stepName: 'Review', outputKey: 'review' }],
      })
    }

    const first = controlledGenerationStream()
    const second = controlledGenerationStream()
    const responses = [first.response, second.response]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!),
    )

    const firstPending = requestServerChatGeneration(baseInput, null)
    sendGenerationReadyFrames(first, 'gen-agent-first')
    sendProgress(first, 'chat-1', 'First Chat Preset', 'started')
    const firstResult = await firstPending
    expect(firstResult.status).toBe('ok')
    if (firstResult.status !== 'ok') return
    await vi.waitFor(() => {
      expect(findAgentPresetProgress('chat-1')).toMatchObject({ presetName: 'First Chat Preset' })
    })

    const secondPending = requestServerChatGeneration({ ...baseInput, characterId: 'char-2', chatId: 'chat-2' }, null)
    sendGenerationReadyFrames(second, 'gen-agent-second')
    sendProgress(second, 'chat-2', 'Second Chat Preset', 'running')
    const secondResult = await secondPending
    expect(secondResult.status).toBe('ok')
    if (secondResult.status !== 'ok') return
    await vi.waitFor(() => {
      expect(findAgentPresetProgress('chat-2')).toMatchObject({ presetName: 'Second Chat Preset' })
    })

    sendProgress(first, 'chat-1', 'Late First Chat Preset', 'running')
    await vi.waitFor(() => {
      expect(findAgentPresetProgress('chat-1')).toMatchObject({ presetName: 'Late First Chat Preset' })
      expect(findAgentPresetProgress('chat-2')).toMatchObject({ presetName: 'Second Chat Preset' })
    })
    first.send('done', {
      generationId: 'gen-agent-first',
      generationInfo: { generationId: 'gen-agent-first' },
    })
    first.close()
    await expect(firstResult.terminal).resolves.toMatchObject({ status: 'done' })
    expect(findAgentPresetProgress('chat-1')).toBeUndefined()
    expect(findAgentPresetProgress('chat-2')).toMatchObject({ presetName: 'Second Chat Preset' })

    second.send('done', {
      generationId: 'gen-agent-second',
      generationInfo: { generationId: 'gen-agent-second' },
    })
    second.close()
    await expect(secondResult.terminal).resolves.toMatchObject({ status: 'done' })
    expect(get(agentPresetProgress)).toEqual([])
  })

  it('captures warning events and makes server compatibility warnings visible', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', async () => {
        const enc = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode('event: future_event\ndata: {"ignored":true}\n\n'))
            controller.enqueue(enc.encode('event: warning\ndata: {"message":"careful"}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: warning\ndata: {"message":"effect skipped","context":{"kind":"unsupported_trigger_effect","effectType":"v2SetCharacterDesc"}}\n\n',
              ),
            )
            controller.enqueue(
              enc.encode(
                'event: warning\ndata: {"message":"callback skipped","context":{"kind":"unsupported_cbs_callback","callbackName":"screenheight","reason":"unsupported_on_server"}}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: prompt\ndata: {"messages":[{"role":"user","content":"hi"}]}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: info\ndata: {"generationId":"gen-taxonomy","generationInfo":{"generationId":"gen-taxonomy","model":"m"}}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: token\ndata: {"content":"ok"}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: done\ndata: {"result":"ok","generationId":"gen-taxonomy","generationInfo":{"generationId":"gen-taxonomy"}}\n\n',
              ),
            )
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      })

      const res = await requestServerChatGeneration(baseInput, null)
      expect(res.status).toBe('ok')
      if (res.status !== 'ok') return
      expect(res.generationId).toBe('gen-taxonomy')
      expect(res.req.type).toBe('streaming')
      if (res.req.type !== 'streaming') return
      const reader = res.req.result.getReader()
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { 'gen-taxonomy': 'ok' },
      })
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
      await expect(res.terminal).resolves.toMatchObject({
        status: 'done',
        warnings: [
          { message: 'careful' },
          {
            message: 'effect skipped',
            context: { kind: 'unsupported_trigger_effect', effectType: 'v2SetCharacterDesc' },
          },
          {
            message: 'callback skipped',
            context: {
              kind: 'unsupported_cbs_callback',
              callbackName: 'screenheight',
              reason: 'unsupported_on_server',
            },
          },
        ],
      })
      expect(warn).toHaveBeenCalledWith('Server chat warning: careful', '')
      expect(alertMocks.alertToast).toHaveBeenNthCalledWith(
        1,
        language.triggerEffectRuntimeUnsupported('v2SetCharacterDesc'),
      )
      expect(alertMocks.alertToast).toHaveBeenNthCalledWith(2, language.cbsCallbackRuntimeUnsupported('screenheight'))
    } finally {
      warn.mockRestore()
    }
  })

  it('surfaces restoration on terminal dispatch errors', async () => {
    const restoration = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      messages: [{ role: 'user' as const, data: 'Hi there' }],
      scriptstate: { $mood: 'calm' },
    }
    setServerChatPrompt([{ role: 'user', content: 'hello there' }], { promptText: 'hello there' })
    setServerChatDispatchError(
      'provider exploded',
      { model: 'echo_model', inputTokens: 7, outputTokens: 50 },
      restoration,
      'uuid-error',
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    await expect(res.terminal).resolves.toMatchObject({
      status: 'error',
      error: 'provider exploded',
      restoration,
    })
  })

  it('parses an unconfirmed generation-persistence disposition without converting it to queued', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null)
    sendGenerationReadyFrames(controlled, 'unconfirmed-generation')
    const result = await pending
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    controlled.send('token', { content: 'optimistic text' })
    controlled.send('error', {
      error: 'generation journal insert failed',
      reason: 'generation_persistence_failed',
      persistenceDisposition: 'unconfirmed',
      generationProjection: {
        characterId: 'char-1',
        chatId: 'chat-1',
        generationId: 'unconfirmed-generation',
        mode: 'send',
      },
    })
    controlled.close()

    await expect(result.terminal).resolves.toMatchObject({
      status: 'error',
      error: 'generation journal insert failed',
      persistenceDisposition: 'unconfirmed',
      generationProjection: { generationId: 'unconfirmed-generation' },
    })
  })

  it('preserves committed-cleanup-pending on a successful done frame', async () => {
    const controlled = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => controlled.response)

    const pending = requestServerChatGeneration(baseInput, null)
    sendGenerationReadyFrames(controlled, 'committed-generation')
    const result = await pending
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    controlled.send('token', { content: 'committed text' })
    controlled.send('done', {
      result: 'committed text',
      generationId: 'committed-generation',
      persistenceDisposition: 'committed_cleanup_pending',
    })
    controlled.close()

    await expect(result.terminal).resolves.toMatchObject({
      status: 'done',
      done: { persistenceDisposition: 'committed_cleanup_pending' },
    })
  })

  it('adds provider status and code details to terminal dispatch errors', async () => {
    const restoration = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      messages: [{ role: 'user' as const, data: 'Hi there' }],
      scriptstate: { $mood: 'calm' },
    }
    setServerChatPrompt([{ role: 'user', content: 'hello there' }], { promptText: 'hello there' })
    setServerChatDispatchError(
      'Not Found',
      { model: 'echo_model', inputTokens: 7, outputTokens: 50 },
      restoration,
      'uuid-error',
      { status: 404, statusText: 'Not Found', code: 'upstream_404' },
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res.status).toBe('ok')
    if (res.status !== 'ok') return
    await expect(res.terminal).resolves.toMatchObject({
      status: 'error',
      error: 'Not Found (HTTP 404 Not Found, code upstream_404)',
      restoration,
    })
  })

  it('surfaces pre-error patches and restoration before dispatch is ready', async () => {
    const patch: ServerChatMessagePatch = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      varChanged: true,
      messageMutations: [],
      chatVarMutations: [{ key: '$score', before: '1', after: '9' }],
      additionalSystemPrompt: [],
    }
    const restoration = {
      chatId: 'chat-1',
      characterId: 'char-1',
      selectedCharID: 0,
      chatPage: 0,
      messages: [{ role: 'user' as const, data: 'Hi there' }],
      scriptstate: { $score: '1' },
    }
    setServerChatError('Generation was stopped by a start trigger.', {
      messagePatch: patch,
      restoration,
    })
    vi.stubGlobal('fetch', serverChatFetch)

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'Generation was stopped by a start trigger.',
      messagePatches: [patch],
      restoration,
    })
  })

  it('uses the stable incomplete chat settings message for generation 409s', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify(incompleteChatSettingsBody), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'Chat generation settings are incomplete',
    })
  })

  it('uses the human reason for generation-in-progress generation 409s', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: 'generation_in_progress',
            reason: 'A generation is already running for this chat.',
          }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )

    const res = await requestServerChatGeneration(baseInput, null)
    expect(res).toEqual({
      status: 'error',
      error: 'A generation is already running for this chat.',
      code: 'generation_in_progress',
    })
  })

  it('uses the human reason for missing durable generation jobs', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            error: 'generation_job_not_found',
            reason: 'Generation job not found or already expired.',
          }),
          {
            status: 404,
            headers: { 'content-type': 'application/json' },
          },
        ),
    )

    const res = await requestServerChatGeneration(baseInput, null, 'missing-job')
    expect(res).toEqual({
      status: 'error',
      error: 'Generation job not found or already expired.',
      code: 'generation_job_not_found',
      reattachOutcome: 'missing_job',
    })
  })
})

describe('cancelServerChatGeneration', () => {
  it('DELETEs the durable job by generationId with auth + writer-session headers', async () => {
    const calls: Array<{ url: string; method?: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response(JSON.stringify({ disposition: 'cancelling', jobId: 'gen-123' }), { status: 202 })
    })

    await expect(cancelServerChatGeneration('gen-123')).resolves.toEqual({
      status: 'acknowledged',
      disposition: 'cancelling',
      jobId: 'gen-123',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/v1/generate/chat/gen-123')
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].headers['risu-auth']).toBe('test-auth-token')
    expect(calls[0].headers['risu-writer-session']).toBe('writer-session-1')
    expect(calls[0].headers['x-risu-caller']).toBe('chat-cancel')
  })

  it('returns typed failures for an empty generationId and transport errors', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchSpy)
    await expect(cancelServerChatGeneration('')).resolves.toEqual({
      status: 'failed',
      error: 'Generation job ID is required.',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    await expect(cancelServerChatGeneration('gen-x')).resolves.toEqual({
      status: 'failed',
      error: 'Network error: network down',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('returns a typed not-found outcome for an expired compatibility job', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              disposition: 'not_found',
              error: 'generation_job_not_found',
              reason: 'Generation job not found or already expired.',
            }),
            { status: 404 },
          ),
      ),
    )

    await expect(cancelServerChatGeneration('expired-job')).resolves.toEqual({
      status: 'not_found',
      error: 'Generation job not found or already expired.',
    })
  })
})

describe('requestServerChatGeneration durable cancel-on-abort', () => {
  // A streaming SSE response that emits `job_accepted` (carrying the jobId) + a stage
  // frame, then hangs until the request is aborted — modelling a durable job that is
  // still running when the user hits stop mid-assembly. DELETEs are captured.
  function stubDurableStreamFetch(jobId: string): { deletes: string[] } {
    const deletes: string[] = []
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`event: job_accepted\ndata: ${JSON.stringify({ jobId })}\n\n`))
          controller.enqueue(enc.encode('event: stage\ndata: {"stage":"prompt","status":"start"}\n\n'))
          // Intentionally never closes — the abort must end the stream.
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    return { deletes }
  }

  it('DELETEs the durable jobId (captured from job_accepted) when aborted mid-stream', async () => {
    const { deletes } = stubDurableStreamFetch('job-xyz')
    const controller = new AbortController()
    const pending = requestServerChatGeneration({ ...baseInput, durable: true }, controller.signal)
    await waitForAcceptedServerChatJob('job-xyz')

    controller.abort()

    await expect(pending).resolves.toMatchObject({ status: 'aborted' })
    await vi.waitFor(() => {
      expect(deletes).toContain('/api/v1/generate/chat/job-xyz')
    })
  })

  it('DELETEs the accepted job when stopped before the first SSE frame arrives', async () => {
    const deletes: string[] = []
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Model a response whose headers have arrived while the first body
          // frame is still delayed in transit.
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-risu-generation-job-id': 'job-from-header',
        },
      },
    )
    const headerSpy = vi.spyOn(response.headers, 'get')
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return response
    })

    const controller = new AbortController()
    const pending = requestServerChatGeneration({ ...baseInput, durable: true }, controller.signal)
    await vi.waitFor(() => {
      expect(headerSpy).toHaveBeenCalledWith('X-Risu-Generation-Job-ID')
    })

    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: 'aborted' })
    await vi.waitFor(() => {
      expect(deletes).toEqual(['/api/v1/generate/chat/job-from-header'])
    })
  })

  it('keeps the protocol-v1 Stop viewer attached through the canonical cancelled terminal', async () => {
    let detachViewer: (() => void) | undefined
    let viewerSignal: AbortSignal | null | undefined
    generationOperationMocks.registerViewer.mockImplementation((_operationId, detach) => {
      detachViewer = detach
      return () => undefined
    })
    const wire = controlledGenerationStream()
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      viewerSignal = init?.signal
      return wire.response
    })
    const stream = {
      operationId: '11111111-1111-4111-8111-111111111111',
      acceptedMessageId: '22222222-2222-4222-8222-222222222222',
      attemptNo: 1,
      jobId: 'job-operation-a',
      projectionEpoch: 4,
      href: '/api/v1/generation-operations/11111111-1111-4111-8111-111111111111/stream?attemptNo=1&jobId=job-operation-a&projectionEpoch=4',
    }
    const pending = requestServerChatGeneration(baseInput, null, undefined, stream)
    await vi.waitFor(() => expect(generationOperationMocks.registerViewer).toHaveBeenCalled())
    wire.send('prompt', { messages: [{ role: 'user', content: 'hi' }] })
    wire.send('info', {
      generationId: stream.jobId,
      generationInfo: { generationId: stream.jobId, model: 'm' },
      halfStreaming: true,
    })
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return

    detachViewer?.()
    expect(viewerSignal?.aborted).toBe(false)
    wire.send('done', {
      outcome: 'cancelled',
      result: 'raw partial',
      generationId: stream.jobId,
      generationInfo: { generationId: stream.jobId, model: 'm' },
      postGeneration: {
        revision: 9,
        messageId: stream.jobId,
        finalText: 'processed partial',
      },
    })
    const reader = served.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: { [stream.jobId]: 'raw partial' } })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(served.terminal).resolves.toMatchObject({
      status: 'cancelled',
      done: {
        result: 'raw partial',
        postGeneration: { revision: 9, messageId: stream.jobId, finalText: 'processed partial' },
      },
    })
    expect(viewerSignal?.aborted).toBe(false)
    expect(get(activeGenerationJobs)).toEqual([])
  })

  it('exposes negotiated regenerate target metadata on the token stream', async () => {
    const wire = controlledGenerationStream()
    vi.stubGlobal('fetch', async () => wire.response)
    const operationStream = {
      operationId: '11111111-1111-4111-8111-111111111111',
      attemptNo: 2,
      jobId: 'job-regenerate',
      projectionEpoch: 7,
      href: '/api/v1/generation-operations/11111111-1111-4111-8111-111111111111/stream?attemptNo=2&jobId=job-regenerate&projectionEpoch=7',
    }
    const input = {
      ...baseInput,
      mode: 'regenerate' as const,
      regenerateMessageId: 'assistant-old',
    }
    const pending = requestServerChatGeneration(input, null, undefined, operationStream)
    wire.send('prompt', {})
    wire.send('info', {
      generationId: 'assistant-new',
      generationInfo: { generationId: 'assistant-new', model: 'm' },
      generationDisplayProjection: {
        version: 1,
        mode: 'regenerate',
        targetMessageId: 'assistant-old',
        generationId: 'assistant-new',
        operationId: operationStream.operationId,
        attemptNo: 2,
        projectionEpoch: 7,
      },
    })

    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok' || served.req.type !== 'streaming') return
    expect(served.req.generationDisplayProjection).toEqual({
      operationId: operationStream.operationId,
      attemptNo: 2,
      characterId: 'char-1',
      chatId: 'chat-1',
      mode: 'regenerate',
      targetMessageId: 'assistant-old',
      generationId: 'assistant-new',
      projectionEpoch: 7,
    })

    wire.send('done', { generationId: 'assistant-new', result: 'new reply' })
    await expect(served.terminal).resolves.toMatchObject({ status: 'done' })
    await served.req.result.cancel()
  })

  it('refreshes typed stale-attempt authority and reattaches the current exact operation attempt', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const staleStream = {
      operationId,
      acceptedMessageId: '22222222-2222-4222-8222-222222222222',
      attemptNo: 1,
      jobId: 'job-stale',
      projectionEpoch: 40,
      href: `/api/v1/generation-operations/${operationId}/stream?attemptNo=1&jobId=job-stale&projectionEpoch=40`,
    }
    const currentStream = {
      ...staleStream,
      attemptNo: 2,
      jobId: 'job-current',
      projectionEpoch: 41,
      href: `/api/v1/generation-operations/${operationId}/stream?attemptNo=2&jobId=job-current&projectionEpoch=41`,
    }
    generationOperationMocks.reconcileErrorBody.mockReturnValueOnce({
      disposition: 'redirected',
      operation: { operationId, state: 'owned_by_job' },
      stream: currentStream,
    })
    const calls: string[] = []
    const encoder = new TextEncoder()
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            error: 'stale_generation_attempt',
            operation: { operationId, state: 'owned_by_job' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `event: job_accepted\ndata: ${JSON.stringify({
                  jobId: 'job-current',
                  operationId,
                  operationStateVersion: 6,
                  projectionEpoch: 41,
                  attemptNo: 2,
                })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode('event: prompt\ndata: {"formated":[{"role":"user","content":"hi"}]}\n\n'))
            controller.enqueue(
              encoder.encode(
                'event: info\ndata: {"generationId":"job-current","generationInfo":{"generationId":"job-current","model":"m"}}\n\n',
              ),
            )
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  result: 'current result',
                  generationId: 'job-current',
                  jobId: 'job-current',
                  operationId,
                  operationStateVersion: 7,
                  projectionEpoch: 42,
                  attemptNo: 2,
                })}\n\n`,
              ),
            )
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const served = await requestServerChatGeneration(baseInput, null, undefined, staleStream)

    expect(served.status).toBe('ok')
    if (served.status !== 'ok') return
    await expect(served.terminal).resolves.toMatchObject({
      status: 'done',
      done: { generationId: 'job-current', result: 'current result' },
    })
    expect(calls).toEqual([staleStream.href, currentStream.href])
    expect(generationOperationMocks.reconcileErrorBody).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'stale_generation_attempt' }),
    )
    expect(generationOperationMocks.applySseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'job_accepted', jobId: 'job-current', operationId }),
      expect.objectContaining({ chatId: 'chat-1', mode: 'send' }),
    )
    expect(generationOperationMocks.applySseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'done', jobId: 'job-current', operationId }),
    )
  })

  it('returns terminal stale-attempt authority for coordinator reconciliation', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111'
    const stream = {
      operationId,
      attemptNo: 1,
      jobId: 'job-expired-attempt',
      projectionEpoch: 40,
      href: `/api/v1/generation-operations/${operationId}/stream?attemptNo=1&jobId=job-expired-attempt&projectionEpoch=40`,
    }
    generationOperationMocks.reconcileErrorBody.mockReturnValueOnce({
      disposition: 'terminal',
      operation: { operationId, state: 'completed' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'stale_generation_attempt',
              operation: { operationId, state: 'completed' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    await expect(requestServerChatGeneration(baseInput, null, undefined, stream)).resolves.toMatchObject({
      status: 'error',
      code: 'stale_generation_attempt',
      reattachOutcome: 'authority_reconciliation_required',
    })
  })

  it('retires an exact job viewer without cancelling durable work', async () => {
    const jobId = 'job-observer-retire'
    const wire = controlledGenerationStream()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => wire.response),
    )

    const pending = requestServerChatGeneration(baseInput, null, jobId)
    sendGenerationReadyFrames(wire, jobId)
    const served = await pending
    expect(served.status).toBe('ok')
    if (served.status !== 'ok') return

    retireGenerationJobViewers(jobId)

    await expect(served.terminal).resolves.toMatchObject({
      status: 'error',
      reattachOutcome: 'observer_superseded',
    })
    expect(generationOperationMocks.stopOperation).not.toHaveBeenCalled()
  })

  it('does NOT cancel on abort for a non-durable send', async () => {
    const { deletes } = stubDurableStreamFetch('job-xyz')
    const controller = new AbortController()
    const pending = requestServerChatGeneration({ ...baseInput, durable: false }, controller.signal)
    await waitForAcceptedServerChatJob('job-xyz')

    controller.abort()

    await expect(pending).resolves.toMatchObject({ status: 'aborted' })
    expect(deletes).toEqual([])
  })

  it('passively detaches a cancelled token consumer while keeping the durable job replayable', async () => {
    const deletes: string[] = []
    const calls: Array<{ url: string; method: string }> = []
    let detachedViewers = 0
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (init?.method === 'DELETE') {
        deletes.push(url)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (method === 'GET') {
        const replay = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode('event: job_accepted\ndata: {"jobId":"job-consumer-detach"}\n\n'))
            controller.enqueue(enc.encode('event: prompt\ndata: {"formated":[{"role":"user","content":"hi"}]}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: info\ndata: {"generationId":"job-consumer-detach","generationInfo":{"generationId":"job-consumer-detach","model":"m"}}\n\n',
              ),
            )
            controller.enqueue(enc.encode('event: token\ndata: {"content":"completed after detach"}\n\n'))
            controller.enqueue(
              enc.encode(
                'event: done\ndata: {"result":"completed after detach","generationId":"job-consumer-detach","generationInfo":{"generationId":"job-consumer-detach"}}\n\n',
              ),
            )
            controller.close()
          },
        })
        return new Response(replay, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode('event: job_accepted\ndata: {"jobId":"job-consumer-detach"}\n\n'))
          controller.enqueue(
            enc.encode(
              'event: agent_preset_progress\ndata: {"chatId":"chat-1","presetId":"ap-detach","presetName":"Detached","phase":"beforeMain","status":"running","totalSteps":2,"completedSteps":1,"activeSteps":[]}\n\n',
            ),
          )
          controller.enqueue(
            enc.encode(
              'event: post_generation_progress\ndata: {"phase":"onOutput","status":"running","runSeq":1,"ownerType":"module","ownerName":"Detached","llmCallCount":1,"pendingLlmCount":1,"llmCallCounts":{"LLM":1,"axLLM":0},"pendingLlmCounts":{"LLM":1,"axLLM":0}}\n\n',
            ),
          )
          controller.enqueue(enc.encode('event: prompt\ndata: {"formated":[{"role":"user","content":"hi"}]}\n\n'))
          controller.enqueue(
            enc.encode(
              'event: info\ndata: {"generationId":"job-consumer-detach","generationInfo":{"generationId":"job-consumer-detach","model":"m"}}\n\n',
            ),
          )
          controller.enqueue(enc.encode('event: token\ndata: {"content":"partial"}\n\n'))
          // Intentionally remain live while the local token consumer detaches.
        },
        cancel() {
          detachedViewers += 1
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-risu-generation-job-id': 'job-consumer-detach',
        },
      })
    })

    const owner = new AbortController()
    const addAbortListener = vi.spyOn(owner.signal, 'addEventListener')
    const removeAbortListener = vi.spyOn(owner.signal, 'removeEventListener')
    const served = await requestServerChatGeneration({ ...baseInput, durable: true }, owner.signal)
    expect(served.status).toBe('ok')
    if (served.status !== 'ok') return
    expect(served.req.type).toBe('streaming')
    if (served.req.type !== 'streaming') return
    await vi.waitFor(() => {
      expect(findAgentPresetProgress('chat-1')).toBeDefined()
      expect(findPostGenerationProgress('char-1', 'chat-1')).toBeDefined()
    })
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-consumer-detach', mode: 'send' }])

    await served.req.result.getReader().cancel()
    await expect(served.terminal).resolves.toMatchObject({ status: 'error', error: 'Aborted' })
    await vi.waitFor(() => expect(detachedViewers).toBe(1))
    expect(get(agentPresetProgress)).toEqual([])
    expect(get(postGenerationProgress)).toEqual([])
    expect(addAbortListener.mock.calls.some(([type]) => type === 'abort')).toBe(true)
    expect(removeAbortListener.mock.calls.some(([type]) => type === 'abort')).toBe(true)

    owner.abort()
    expect(deletes).toEqual([])
    expect(get(activeGenerationJobs)).toEqual([{ chatId: 'chat-1', jobId: 'job-consumer-detach', mode: 'send' }])

    const reattached = await requestServerChatGeneration(baseInput, null, 'job-consumer-detach')
    expect(reattached.status).toBe('ok')
    if (reattached.status !== 'ok' || reattached.req.type !== 'streaming') return
    const reader = reattached.req.result.getReader()
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { 'job-consumer-detach': 'completed after detach' },
    })
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    await expect(reattached.terminal).resolves.toMatchObject({
      status: 'done',
      reattachOutcome: 'completed',
      done: { result: 'completed after detach' },
    })
    expect(get(activeGenerationJobs)).toEqual([])
    expect(calls).toEqual([
      { url: '/api/v1/generate/chat', method: 'POST' },
      { url: '/api/v1/generate/chat/job-consumer-detach/stream', method: 'GET' },
    ])
  })
})

describe('requestServerChatGeneration reattach mode', () => {
  const enc = new TextEncoder()
  function completedReattachResponse(jobId: string): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`event: job_accepted\ndata: ${JSON.stringify({ jobId })}\n\n`))
        controller.enqueue(
          enc.encode(`event: prompt\ndata: ${JSON.stringify({ formated: [{ role: 'user', content: 'hi' }] })}\n\n`),
        )
        controller.enqueue(
          enc.encode(
            `event: info\ndata: ${JSON.stringify({ generationId: jobId, generationInfo: { model: 'm', generationId: jobId } })}\n\n`,
          ),
        )
        controller.enqueue(
          enc.encode(
            `event: done\ndata: ${JSON.stringify({ result: 'reply', generationId: jobId, generationInfo: { generationId: jobId } })}\n\n`,
          ),
        )
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  function stubReattachFetch(
    jobId: string,
    opts: { hang?: boolean } = {},
  ): { calls: Array<{ url: string; method: string }>; deletes: string[] } {
    const calls: Array<{ url: string; method: string }> = []
    const deletes: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'DELETE') {
        deletes.push(url)
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`event: job_accepted\ndata: ${JSON.stringify({ jobId })}\n\n`))
          controller.enqueue(
            enc.encode(`event: prompt\ndata: ${JSON.stringify({ formated: [{ role: 'user', content: 'hi' }] })}\n\n`),
          )
          controller.enqueue(
            enc.encode(
              `event: info\ndata: ${JSON.stringify({ generationId: jobId, generationInfo: { model: 'm', generationId: jobId } })}\n\n`,
            ),
          )
          controller.enqueue(enc.encode(`event: token\ndata: ${JSON.stringify({ content: 'partial reply' })}\n\n`))
          if (!opts.hang) {
            controller.enqueue(
              enc.encode(
                `event: done\ndata: ${JSON.stringify({ result: 'partial reply', generationId: jobId, generationInfo: { generationId: jobId } })}\n\n`,
              ),
            )
            controller.close()
          }
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    return { calls, deletes }
  }

  it('GETs the job stream and consumes the replayed frames', async () => {
    const { calls } = stubReattachFetch('job-reattach')
    const res = await requestServerChatGeneration(baseInput, null, 'job-reattach')
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.generationId).toBe('job-reattach')
      const terminal = await res.terminal
      expect(terminal).toMatchObject({ status: 'done', reattachOutcome: 'completed' })
    }
    expect(calls[0]).toEqual({
      url: '/api/v1/generate/chat/job-reattach/stream',
      method: 'GET',
    })
  })

  it('labels reattach stream requests with x-risu-caller: chat-reattach', async () => {
    vi.stubGlobal('fetch', serverChatFetch)

    await requestServerChatGeneration(baseInput, null, 'job-reattach')

    const calls = getServerChatCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: '/api/v1/generate/chat/job-reattach/stream',
      method: 'GET',
      callerHeader: 'chat-reattach',
    })
  })

  it('cancels the job on abort even though durable is not set (reattach implies durable)', async () => {
    const { deletes } = stubReattachFetch('job-reattach', { hang: true })
    const controller = new AbortController()
    const served = await requestServerChatGeneration(baseInput, controller.signal, 'job-reattach')
    expect(served.status).toBe('ok')
    if (served.status !== 'ok') return
    await waitForAcceptedServerChatJob('job-reattach')

    controller.abort()

    await expect(served.terminal).resolves.toMatchObject({ status: 'error', reattachOutcome: 'aborted' })
    await vi.waitFor(() => {
      expect(deletes).toEqual(['/api/v1/generate/chat/job-reattach'])
    })
  })

  it('cancels exactly once when abort wins before the reattach response opens', async () => {
    const deletes: string[] = []
    let markGetStarted!: () => void
    const getStarted = new Promise<void>((resolve) => {
      markGetStarted = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
        }
        markGetStarted()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          })
        })
      }),
    )
    const controller = new AbortController()
    const pending = requestServerChatGeneration(baseInput, controller.signal, 'job-before-open')
    await getStarted

    controller.abort()

    await expect(pending).resolves.toMatchObject({ status: 'aborted' })
    await vi.waitFor(() => {
      expect(deletes).toEqual(['/api/v1/generate/chat/job-before-open'])
    })
  })

  it('cancels only Chat A while two chat reattach responses are pending', async () => {
    const deletes: string[] = []
    const openResolvers = new Map<string, (response: Response) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'DELETE') {
          deletes.push(url)
          return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }))
        }
        const jobId = url.split('/').at(-2) ?? ''
        return new Promise((resolve, reject) => {
          openResolvers.set(jobId, resolve)
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          })
        })
      }),
    )
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    const pendingA = requestServerChatGeneration(
      { ...baseInput, chatId: 'chat-a', characterId: 'char-a' },
      controllerA.signal,
      'job-a',
    )
    const pendingB = requestServerChatGeneration(
      { ...baseInput, chatId: 'chat-b', characterId: 'char-b' },
      controllerB.signal,
      'job-b',
    )
    await vi.waitFor(() => expect([...openResolvers.keys()].sort()).toEqual(['job-a', 'job-b']))

    controllerA.abort()

    await expect(pendingA).resolves.toMatchObject({ status: 'aborted' })
    await vi.waitFor(() => {
      expect(deletes).toEqual(['/api/v1/generate/chat/job-a'])
    })
    expect(controllerB.signal.aborted).toBe(false)

    openResolvers.get('job-b')?.(completedReattachResponse('job-b'))
    const servedB = await pendingB
    expect(servedB.status).toBe('ok')
    if (servedB.status === 'ok') {
      await expect(servedB.terminal).resolves.toMatchObject({ status: 'done', reattachOutcome: 'completed' })
    }
    expect(deletes).toEqual(['/api/v1/generate/chat/job-a'])
  })

  it('classifies a terminal SSE error as a terminal reattach failure', async () => {
    setServerChatDispatchError(
      'provider rejected the request',
      { generationId: 'job-terminal', model: 'm' },
      {
        chatId: 'chat-1',
        characterId: 'char-1',
        selectedCharID: 0,
        chatPage: 0,
        messages: [{ role: 'user', data: 'hi' }],
      },
      'job-terminal',
    )
    vi.stubGlobal('fetch', serverChatFetch)

    const served = await requestServerChatGeneration(baseInput, null, 'job-terminal')

    expect(served.status).toBe('ok')
    if (served.status === 'ok') {
      await expect(served.terminal).resolves.toMatchObject({
        status: 'error',
        error: 'provider rejected the request',
        reattachOutcome: 'terminal_failure',
      })
    }
  })

  it('classifies a 404 reattach response as a missing job', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'generation job not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(requestServerChatGeneration(baseInput, null, 'job-expired')).resolves.toMatchObject({
      status: 'error',
      error: 'generation job not found',
      reattachOutcome: 'missing_job',
    })
  })

  it('classifies a network disconnect as retryable without cancelling durable work', async () => {
    const calls: Array<{ url: string; method: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' })
        throw new Error('network unavailable')
      }),
    )

    await expect(requestServerChatGeneration(baseInput, null, 'job-offline')).resolves.toMatchObject({
      status: 'error',
      error: 'Network error: network unavailable',
      reattachOutcome: 'retryable_transport_failure',
    })
    expect(calls).toEqual([{ url: '/api/v1/generate/chat/job-offline/stream', method: 'GET' }])
  })
})

describe('generation transport writer lifecycle', () => {
  it('denies Reader submission and cancellation while allowing a GET viewer to detach without cancelling its job', async () => {
    setManagedReaderForTest()
    const controlled = controlledGenerationStream()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => controlled.response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestServerChatGeneration(baseInput, null)).resolves.toMatchObject({ status: 'error' })
    await expect(cancelServerChatGeneration('reader-job')).resolves.toMatchObject({ status: 'failed' })
    expect(fetchMock).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = requestServerChatGeneration(baseInput, controller.signal, 'reader-job')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    sendGenerationReadyFrames(controlled, 'reader-job')
    const opened = await pending
    expect(opened.status).toBe('ok')
    if (opened.status !== 'ok') throw new Error('Reader GET should remain available')
    controller.abort()
    await expect(opened.terminal).resolves.toMatchObject({ reattachOutcome: 'observer_superseded' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/generate/chat/reader-job/stream',
      expect.objectContaining({ method: 'GET' }),
    )
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(new Headers(init?.headers).has('risu-writer-session')).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(generationOperationMocks.stopOperation).not.toHaveBeenCalled()
  })

  it('detaches an old writer viewer on loss and never cancels the provider job after re-promotion', async () => {
    setManagedWriterForTest()
    const controlled = controlledGenerationStream()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => controlled.response)
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = requestServerChatGeneration(baseInput, controller.signal, 'writer-job')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    sendGenerationReadyFrames(controlled, 'writer-job')
    const opened = await pending
    if (opened.status !== 'ok') throw new Error('Expected active writer viewer')
    demoteAndRepromoteForTest()
    controller.abort()
    await expect(opened.terminal).resolves.toMatchObject({ reattachOutcome: 'observer_superseded' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(generationOperationMocks.stopOperation).not.toHaveBeenCalled()
  })
})
