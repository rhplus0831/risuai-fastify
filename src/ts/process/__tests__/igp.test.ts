import {
  beginClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../../clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from '../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestChatDataSpy } = vi.hoisted(() => ({
  requestChatDataSpy: vi.fn(),
}))
vi.mock('../request/request', () => ({
  requestChatData: requestChatDataSpy,
}))

// Same TDZ-break as sendChatErrors.test.ts: setDatabase writes fire a
// stores.svelte.ts $effect that reaches moduleUpdate -> getModules during
// vitest SSR module init.
vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

vi.mock('../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'igp-test-token',
}))

import {
  applyServerResourceDatabase,
  setDatabase,
  type Database,
  type MessageGenerationInfo,
  type character,
} from '../../storage/database.svelte'
import { selectedCharID } from '../../stores.svelte'
import { replaceResourceDatabase } from '../../server/resourceState.svelte'
import { evaluateIgp } from '../postGeneration/igp'
import { captureContinueExtendIgpAuthority } from '../postGeneration/igpTargetAuthority'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision } from '../../server/commands'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import {
  captureClientChatOccupancyAuthority,
  configureClientChatOccupancy,
  isClientChatOccupancyAuthorityCurrent,
  resetClientChatOccupancyForTests,
  setClientChatOccupancyIdentity,
} from '../../server/chatOccupancy'
import {
  applyGenerationOperationProjection,
  generationOperationProjections,
  resetGenerationOperationClientForTests,
} from '../../server/generationOperations'
import type { ChatOccupancyProjection } from '@risuai/protocol/chat-occupancy'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import { get } from 'svelte/store'

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: ReturnType<typeof getResourceDatabase>) {
    replaceResourceDatabase(value)
  },
}

interface CapturedFetch {
  url: string
  method: string
  body: any
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubCommandFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/chats/chat-1/messages') {
        return jsonResponse({
          revision: 11,
          event: { type: 'messages.replaced', revision: 11, resource: 'chat' },
        })
      }
      if (url === '/api/v1/commands/messages/message-1') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.updated',
            revision: 11,
            resource: 'message',
            id: 'message-1',
            parentId: 'chat-1',
          },
          chatId: 'chat-1',
          messageId: 'message-1',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForTargetedMessageCommand(calls: CapturedFetch[]): Promise<CapturedFetch> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = calls.find((call) => call.url === '/api/v1/commands/messages/message-1' && call.method === 'PATCH')
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`targeted message command not dispatched; saw ${JSON.stringify(calls)}`)
}

function makeChar(): character {
  return {
    name: 'Test',
    chaId: 'cha-1',
    firstMessage: '',
    desc: '',
    notes: '',
    chats: [
      {
        id: 'chat-1',
        message: [{ role: 'char', data: 'hello', time: 0, chatId: 'message-1' }],
        note: '',
        name: 'main',
        localLore: [],
      },
    ],
    chatPage: 0,
    image: '',
    emotionImages: [],
    bias: [],
    viewScreen: 'none',
    globalLore: [],
    chaVer: 0,
  } as unknown as character
}

function seed(char: character) {
  setDatabase({ characters: [char] } as Database)
  selectedCharID.set(0)
}

const baseOpts = {
  abortSignal: new AbortController().signal,
  target: {
    characterId: 'cha-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    expectedData: 'hello',
  },
}

function occupiedProjection(claimClass: 'owner' | 'chat_only', updatedAtMs: number): ChatOccupancyProjection {
  return {
    databaseLineage: 'lineage-a',
    chatId: 'chat-1',
    occupantSessionId: 'occupant-a',
    occupancyEpoch: 7,
    claimClass,
    state: 'occupied',
    claimedAtMs: updatedAtMs - 1,
    leaseExpiresAtMs: Date.now() + 90_000,
    updatedAtMs,
    releasedAtMs: null,
  }
}

function normalizeOwnerOccupancyToChatOnly() {
  const operation = beginClientSession('occupant-a')
  setClientChatOccupancyIdentity(
    { sessionId: 'occupant-a', exclusive: true, previousSessionId: null },
    operation.generation,
  )
  settleClientReader(operation, {
    databaseLineage: 'lineage-a',
    writer: { sessionId: 'other-writer', epoch: 2 },
  })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  const capability = { version: 1 as const, enabled: true, leaseMs: 90_000 as const, renewAfterMs: 30_000 as const }
  const admittedAt = Date.now()
  configureClientChatOccupancy(capability, {
    version: 1,
    databaseLineage: 'lineage-a',
    occupancies: [occupiedProjection('owner', admittedAt)],
  })
  const admittedAuthority = captureClientChatOccupancyAuthority('chat-1')
  configureClientChatOccupancy(capability, {
    version: 1,
    databaseLineage: 'lineage-a',
    occupancies: [occupiedProjection('chat_only', admittedAt + 1)],
  })
  const currentAuthority = captureClientChatOccupancyAuthority('chat-1')
  if (!admittedAuthority || !currentAuthority)
    throw new Error('Failed to establish normalized occupancy test authority')
  return { admittedAuthority, currentAuthority }
}

describe('evaluateIgp', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    resetClientChatOccupancyForTests()
    resetGenerationOperationClientForTests()
    clearCachedServerCommandRevision()
    vi.unstubAllGlobals()
    requestChatDataSpy.mockReset()
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'IGP-RESULT' })
  })

  afterEach(() => {
    resetGenerationOperationClientForTests()
    resetClientChatOccupancyForTests()
    resetClientSessionForTests()
    vi.unstubAllGlobals()
  })

  it('does not append an old IGP provider result after writer loss and re-promotion', async () => {
    seed(makeChar())
    setManagedWriterForTest()
    const calls = stubCommandFetch()
    let release!: (value: unknown) => void
    requestChatDataSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = evaluateIgp({ ...baseOpts, promptTemplate: '<|im_start|>system<|im_sep|>Rate it.<|im_end|>' })
    await vi.waitFor(() => expect(requestChatDataSpy).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release({ type: 'success', result: 'old-result' })
    await expect(pending).resolves.toBe(false)
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('hello')
    expect(calls).toEqual([])
  })

  it('is a no-op when the prompt template is empty', async () => {
    seed(makeChar())
    await evaluateIgp({ ...baseOpts, promptTemplate: '' })
    expect(requestChatDataSpy).not.toHaveBeenCalled()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('hello')
  })

  // parseChatML requires the prompt to start with <|im_start|>. The upstream
  // sendChat code does not enforce this; if a user sets db.igpPrompt to a
  // non-ChatML string the function passes formated: null down to
  // requestChatData. These tests use a well-formed ChatML prompt so the
  // happy path is exercised end-to-end.
  const CHATML_PROMPT = '<|im_start|>system<|im_sep|>Rate the response.<|im_end|>'

  it('dispatches with parsed ChatML and emotion mode when the prompt is non-empty', async () => {
    stubCommandFetch()
    seed(makeChar())
    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT })
    expect(requestChatDataSpy).toHaveBeenCalledTimes(1)
    const [arg, mode, signal] = requestChatDataSpy.mock.calls[0]
    expect(mode).toBe('emotion')
    expect(signal).toBe(baseOpts.abortSignal)
    expect(arg.bias).toEqual({})
    expect(Array.isArray(arg.formated)).toBe(true)
    expect(arg.formated).toHaveLength(1)
    expect(arg.formated[0].role).toBe('system')
  })

  it('appends the explicit response result instead of raw object coercion', async () => {
    const calls = stubCommandFetch()
    seed(makeChar())
    requestChatDataSpy.mockResolvedValueOnce({ type: 'success', result: 'IGP-RESULT' })
    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT })
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('helloIGP-RESULT')
    const command = await waitForTargetedMessageCommand(calls)
    expect(command.body.patch.data).toBe('helloIGP-RESULT')
  })

  it('uses the recovered effect resource view for its emotion request', async () => {
    stubCommandFetch()
    seed(makeChar())
    const database = { ...testDatabaseState.db, subModel: 'echo_model', echoMessage: 'Recovered effect' } as Database
    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT, database })
    expect(requestChatDataSpy).toHaveBeenCalledWith(
      expect.objectContaining({ database }),
      'emotion',
      baseOpts.abortSignal,
    )
  })

  it('stringifies non-string IGP result payloads without [object Object]', async () => {
    stubCommandFetch()
    seed(makeChar())
    requestChatDataSpy.mockResolvedValueOnce({ type: 'success', result: { label: 'joy' } })

    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT })

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('hello{"label":"joy"}')
  })

  it('does not append a failed IGP request as generated message text', async () => {
    const calls = stubCommandFetch()
    seed(makeChar())
    requestChatDataSpy.mockResolvedValueOnce({ type: 'fail', result: 'Request settings are not ready.' })
    await expect(evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT, waitForPersistence: true })).rejects.toThrow(
      'Request settings are not ready.',
    )
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('hello')
    expect(calls).toEqual([])
  })

  it('appends only to the exact stable message regardless of position', async () => {
    stubCommandFetch()
    const char = makeChar()
    char.chats[0].message = [
      { role: 'user', data: 'first', time: 0, chatId: 'message-user' },
      { role: 'char', data: 'second', time: 0, chatId: 'message-2' },
      { role: 'char', data: 'third', time: 0, chatId: 'message-3' },
    ]
    seed(char)
    await evaluateIgp({
      ...baseOpts,
      promptTemplate: CHATML_PROMPT,
      target: { ...baseOpts.target, messageId: 'message-3', expectedData: 'third' },
    })
    const messages = testDatabaseState.db.characters[0].chats[0].message
    expect(messages[0].data).toBe('first')
    expect(messages[1].data).toBe('second')
    expect(messages[2].data).toBe('thirdIGP-RESULT')
  })

  it('appends and persists through the message owner', async () => {
    const calls = stubCommandFetch()
    seed(makeChar())
    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT })

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('helloIGP-RESULT')
    const command = await waitForTargetedMessageCommand(calls)
    expect(command.body.patch.data).toBe('helloIGP-RESULT')

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[0].chats[0].message[0].data = 'stale'
    })
    applyServerResourceDatabase({
      characters: [
        {
          ...makeChar(),
          chats: [
            {
              ...makeChar().chats[0],
              message: [
                {
                  ...makeChar().chats[0].message[0],
                  data: command.body.patch.data,
                },
              ],
            },
          ],
        },
      ],
    } as Database)
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('helloIGP-RESULT')
  })

  it('appends to the stable post-terminal row with durable terminal-state preconditions', async () => {
    const calls = stubCommandFetch()
    const char = makeChar()
    char.chats[0].message = [
      {
        role: 'char',
        data: 'derived final text',
        time: 0,
        chatId: 'message-1',
        generationInfo: { generationId: 'generation-1' },
      },
    ]
    seed(char)

    await evaluateIgp({
      ...baseOpts,
      promptTemplate: CHATML_PROMPT,
      waitForPersistence: true,
      igpEffect: { generationId: 'generation-1', claimId: 'claim-1' },
      target: {
        characterId: 'cha-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        expectedData: 'derived final text',
        expectedGenerationId: 'generation-1',
      },
    })

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('derived final textIGP-RESULT')
    const command = await waitForTargetedMessageCommand(calls)
    expect(command.body).toMatchObject({
      patch: { data: 'derived final textIGP-RESULT' },
      expectedData: 'derived final text',
      expectedChatId: 'chat-1',
      expectedGenerationId: 'generation-1',
      igpEffect: { generationId: 'generation-1', claimId: 'claim-1' },
    })
  })

  it('commits recovered IGP after owner-to-chat-only normalization preserves the accepted tuple', async () => {
    const { admittedAuthority, currentAuthority } = normalizeOwnerOccupancyToChatOnly()
    const char = makeChar()
    char.chats[0].message = [
      {
        role: 'char',
        data: 'derived final text',
        time: 0,
        chatId: 'message-1',
        generationInfo: {
          generationId: 'generation-1',
          databaseLineage: admittedAuthority.databaseLineage,
          operationId: 'operation-1',
          attemptNo: 1,
          jobId: 'generation-1',
          effectLedgerKeyType: 'operation',
          effectLedgerKeyId: 'operation-1',
          effectLedgerCharacterId: 'cha-1',
          effectLedgerChatId: admittedAuthority.chatId,
        },
      },
    ]
    seed(char)
    const effectRef: ServerGenerationEffectLedgerRef = {
      version: 1,
      databaseLineage: admittedAuthority.databaseLineage,
      keyType: 'operation',
      keyId: 'operation-1',
      generationId: 'generation-1',
      characterId: 'cha-1',
      chatId: admittedAuthority.chatId,
      messageId: 'message-1',
    }
    applyGenerationOperationProjection({
      operationId: effectRef.keyId,
      protocolVersion: 1,
      requestOrigin: 'accepted_send',
      state: 'completed',
      stateVersion: 3,
      projectionEpoch: 4,
      creatorWriterSessionId: admittedAuthority.sessionId,
      creatorWriterEpoch: 1,
      generationScope: {
        admissionKind: 'owner_occupancy',
        occupancyDatabaseLineage: admittedAuthority.databaseLineage,
        occupancySessionId: admittedAuthority.sessionId,
        occupancyEpoch: admittedAuthority.occupancyEpoch,
        occupancyClaimClass: 'owner',
        permissionScopeVersion: 1,
        permissionScope: [],
      },
      characterId: effectRef.characterId,
      chatId: effectRef.chatId,
      mode: 'send',
      acceptedMessageId: 'user-1',
      acceptedRevision: 9,
      resultMessageId: effectRef.messageId,
      providerMayHaveRun: true,
    })
    setCachedServerCommandRevision(10)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/igp/completion')) return jsonResponse({ type: 'success', result: 'IGP-SNAPSHOT' })
      return jsonResponse({
        revision: 11,
        chatId: effectRef.chatId,
        messageId: effectRef.messageId,
        event: {
          type: 'message.updated',
          revision: 11,
          resource: 'message',
          id: effectRef.messageId,
          parentId: effectRef.chatId,
        },
        effect: { status: 'completed', claimId: 'claim-1' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(isClientChatOccupancyAuthorityCurrent(currentAuthority)).toBe(true)
    expect(get(generationOperationProjections)).toEqual([
      expect.objectContaining({
        operationId: effectRef.keyId,
        requestOrigin: 'accepted_send',
        creatorWriterSessionId: admittedAuthority.sessionId,
        characterId: effectRef.characterId,
        chatId: effectRef.chatId,
        resultMessageId: effectRef.messageId,
        generationScope: expect.objectContaining({ occupancyClaimClass: 'owner' }),
      }),
    ])
    expect(get(generationOperationProjections)[0]?.currentAttempt).toBeUndefined()

    const result = await evaluateIgp({
      ...baseOpts,
      // The current prompt is intentionally absent: occupied IGP execution
      // resolves the accepted prompt and provider snapshot on the server.
      promptTemplate: '',
      igpEffect: { generationId: effectRef.generationId, claimId: 'claim-1' },
      effectLedgerRef: effectRef,
      chatOccupancyAuthority: currentAuthority,
      isCurrent: () => isClientChatOccupancyAuthorityCurrent(currentAuthority),
      target: {
        characterId: effectRef.characterId,
        chatId: effectRef.chatId,
        messageId: effectRef.messageId,
        expectedData: 'derived final text',
        expectedGenerationId: effectRef.generationId,
      },
    })

    expect(admittedAuthority.claimClass).toBe('owner')
    expect(currentAuthority).toMatchObject({
      claimClass: 'chat_only',
      occupancyEpoch: admittedAuthority.occupancyEpoch,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toBe(true)
    expect(requestChatDataSpy).not.toHaveBeenCalled()
    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('derived final textIGP-SNAPSHOT')
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/generation-effects/${effectRef.generationId}/igp/completion`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/generation-effects/${effectRef.generationId}/igp/commit`,
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it.each([
    { lifecycle: 'live', disposition: 'extend', retainsAttempt: true },
    { lifecycle: 'live', disposition: 'append', retainsAttempt: true },
    { lifecycle: 'recovered', disposition: 'extend', retainsAttempt: false },
    { lifecycle: 'recovered', disposition: 'append', retainsAttempt: false },
  ] as const)(
    'executes and atomically commits occupied Continue-$disposition IGP for a $lifecycle projection',
    async ({ disposition, retainsAttempt }) => {
      const { admittedAuthority, currentAuthority } = normalizeOwnerOccupancyToChatOnly()
      const effectRef: ServerGenerationEffectLedgerRef = {
        version: 1,
        databaseLineage: admittedAuthority.databaseLineage,
        keyType: 'operation',
        keyId: 'continue-operation',
        generationId: 'continue-job',
        characterId: 'cha-1',
        chatId: admittedAuthority.chatId,
        messageId: disposition === 'extend' ? 'continued-assistant' : 'appended-assistant',
      }
      const retainedGenerationInfo: MessageGenerationInfo = {
        generationId: 'prior-generation',
        databaseLineage: 'prior-lineage',
        operationId: 'prior-operation',
        attemptNo: 4,
        jobId: 'prior-job',
        effectLedgerKeyType: 'operation',
        effectLedgerKeyId: 'prior-operation',
        effectLedgerCharacterId: 'cha-1',
        effectLedgerChatId: admittedAuthority.chatId,
      }
      const generatedInfo: MessageGenerationInfo = {
        generationId: effectRef.generationId,
        databaseLineage: effectRef.databaseLineage,
        operationId: effectRef.keyId,
        attemptNo: 2,
        jobId: effectRef.generationId,
        effectLedgerKeyType: effectRef.keyType,
        effectLedgerKeyId: effectRef.keyId,
        effectLedgerCharacterId: effectRef.characterId,
        effectLedgerChatId: effectRef.chatId,
      }
      const char = makeChar()
      char.chats[0].message =
        disposition === 'extend'
          ? [
              {
                role: 'char',
                data: 'prior reply plus continuation',
                time: 0,
                chatId: effectRef.messageId,
                generationInfo: structuredClone(retainedGenerationInfo),
              },
            ]
          : [
              {
                role: 'char',
                data: 'prior reply',
                time: 0,
                chatId: 'continued-assistant',
                generationInfo: structuredClone(retainedGenerationInfo),
              },
              {
                role: 'char',
                data: 'separate continuation',
                time: 1,
                chatId: effectRef.messageId,
                generationInfo: generatedInfo,
              },
            ]
      seed(char)
      applyGenerationOperationProjection({
        operationId: effectRef.keyId,
        protocolVersion: 1,
        requestOrigin: 'continue',
        state: 'completed',
        stateVersion: 8,
        projectionEpoch: 9,
        creatorWriterSessionId: admittedAuthority.sessionId,
        creatorWriterEpoch: 1,
        generationScope: {
          admissionKind: 'owner_occupancy',
          occupancyDatabaseLineage: admittedAuthority.databaseLineage,
          occupancySessionId: admittedAuthority.sessionId,
          occupancyEpoch: admittedAuthority.occupancyEpoch,
          occupancyClaimClass: 'owner',
          permissionScopeVersion: 1,
          permissionScope: [],
        },
        characterId: effectRef.characterId,
        chatId: effectRef.chatId,
        mode: 'continue',
        targetMessageId: 'continued-assistant',
        resultMessageId: effectRef.messageId,
        providerMayHaveRun: true,
        ...(retainsAttempt
          ? {
              currentAttempt: {
                attemptNo: 2,
                retryRequestId: 'continue-retry',
                jobId: effectRef.generationId,
                status: 'finalizing' as const,
                serverInstanceId: 'server-a',
                actorWriterSessionId: admittedAuthority.sessionId,
                actorWriterEpoch: 1,
                launchRevision: 7,
                finalizationGenerationId: effectRef.generationId,
              },
            }
          : {}),
      })
      setCachedServerCommandRevision(10)
      const responses: Array<{ url: string; body: Record<string, unknown> }> = []
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        responses.push({
          url,
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
        })
        if (url.endsWith('/igp/completion')) {
          return jsonResponse({ type: 'success', result: `::${disposition.toUpperCase()}-IGP` })
        }
        return jsonResponse({
          revision: 11,
          chatId: effectRef.chatId,
          messageId: effectRef.messageId,
          event: {
            type: 'message.updated',
            revision: 11,
            resource: 'message',
            id: effectRef.messageId,
            parentId: effectRef.chatId,
          },
          effect: { status: 'completed', claimId: 'continue-claim' },
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const terminalMessage = char.chats[0].message.at(-1)!
      const continueExtendAuthority =
        disposition === 'extend'
          ? captureContinueExtendIgpAuthority({
              ref: effectRef,
              operationAttemptNo: 2,
              message: terminalMessage,
              operation: get(generationOperationProjections)[0],
            })
          : undefined
      if (disposition === 'extend') expect(continueExtendAuthority).toBeDefined()

      const result = await evaluateIgp({
        ...baseOpts,
        promptTemplate: '',
        igpEffect: { generationId: effectRef.generationId, claimId: 'continue-claim' },
        effectLedgerRef: effectRef,
        chatOccupancyAuthority: currentAuthority,
        isCurrent: () => isClientChatOccupancyAuthorityCurrent(currentAuthority),
        target: {
          characterId: effectRef.characterId,
          chatId: effectRef.chatId,
          messageId: effectRef.messageId,
          expectedData: terminalMessage.data,
          ...(disposition === 'append' ? { expectedGenerationId: effectRef.generationId } : {}),
          ...(continueExtendAuthority ? { continueExtendAuthority } : {}),
        },
      })

      expect(result).toBe(true)
      expect(requestChatDataSpy).not.toHaveBeenCalled()
      expect(responses.map((response) => response.url)).toEqual([
        `/api/v1/generation-effects/${effectRef.generationId}/igp/completion`,
        `/api/v1/generation-effects/${effectRef.generationId}/igp/commit`,
      ])
      expect(responses[1].body).toMatchObject({
        claimId: 'continue-claim',
        expectedData: disposition === 'extend' ? 'prior reply plus continuation' : 'separate continuation',
        expectedGenerationId: effectRef.generationId,
      })
      const committedTerminal = testDatabaseState.db.characters[0].chats[0].message.at(-1)!
      expect(committedTerminal.data).toBe(
        disposition === 'extend' ? 'prior reply plus continuation::EXTEND-IGP' : 'separate continuation::APPEND-IGP',
      )
      expect(testDatabaseState.db.characters[0].chats[0].message[0].generationInfo).toEqual(retainedGenerationInfo)
      if (retainsAttempt) {
        expect(get(generationOperationProjections)[0]?.currentAttempt).toMatchObject({
          attemptNo: 2,
          jobId: effectRef.generationId,
        })
      } else {
        expect(get(generationOperationProjections)[0]?.currentAttempt).toBeUndefined()
      }
    },
  )

  it('rejects retained-row Continue IGP for chat-only admission before provider execution', async () => {
    const { currentAuthority } = normalizeOwnerOccupancyToChatOnly()
    const effectRef: ServerGenerationEffectLedgerRef = {
      version: 1,
      databaseLineage: currentAuthority.databaseLineage,
      keyType: 'operation',
      keyId: 'chat-only-continue',
      generationId: 'chat-only-job',
      characterId: 'cha-1',
      chatId: currentAuthority.chatId,
      messageId: 'message-1',
    }
    const retainedGenerationInfo: MessageGenerationInfo = { generationId: 'prior-generation' }
    const char = makeChar()
    char.chats[0].message[0].data = 'continued text'
    char.chats[0].message[0].generationInfo = retainedGenerationInfo
    seed(char)
    applyGenerationOperationProjection({
      operationId: effectRef.keyId,
      protocolVersion: 1,
      requestOrigin: 'continue',
      state: 'completed',
      stateVersion: 3,
      projectionEpoch: 4,
      creatorWriterSessionId: currentAuthority.sessionId,
      creatorWriterEpoch: 1,
      generationScope: {
        admissionKind: 'chat_only',
        occupancyDatabaseLineage: currentAuthority.databaseLineage,
        occupancySessionId: currentAuthority.sessionId,
        occupancyEpoch: currentAuthority.occupancyEpoch,
        occupancyClaimClass: 'chat_only',
        permissionScopeVersion: 1,
        permissionScope: [],
      },
      characterId: effectRef.characterId,
      chatId: effectRef.chatId,
      mode: 'continue',
      targetMessageId: effectRef.messageId,
      resultMessageId: effectRef.messageId,
      providerMayHaveRun: true,
    })
    const forgedRetainedAuthority = {
      kind: 'continue_extend' as const,
      operationId: effectRef.keyId,
      operationAttemptNo: 1,
      jobId: effectRef.generationId,
      targetMessageId: effectRef.messageId,
      resultMessageId: effectRef.messageId,
      retainedGenerationInfo,
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      evaluateIgp({
        ...baseOpts,
        promptTemplate: '',
        igpEffect: { generationId: effectRef.generationId, claimId: 'claim-chat-only' },
        effectLedgerRef: effectRef,
        chatOccupancyAuthority: currentAuthority,
        isCurrent: () => isClientChatOccupancyAuthorityCurrent(currentAuthority),
        target: {
          characterId: effectRef.characterId,
          chatId: effectRef.chatId,
          messageId: effectRef.messageId,
          expectedData: 'continued text',
          continueExtendAuthority: forgedRetainedAuthority,
        },
      }),
    ).resolves.toBe(false)
    expect(
      captureContinueExtendIgpAuthority({
        ref: effectRef,
        operationAttemptNo: 1,
        message: testDatabaseState.db.characters[0].chats[0].message[0],
        operation: get(generationOperationProjections)[0],
      }),
    ).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer edit made while terminal-targeted IGP is evaluating', async () => {
    const calls = stubCommandFetch()
    const char = makeChar()
    char.chats[0].message = [
      {
        role: 'char',
        data: 'derived final text',
        time: 0,
        chatId: 'message-1',
        generationInfo: { generationId: 'generation-1' },
      },
    ]
    seed(char)
    let resolveProvider!: (value: { type: 'success'; result: string }) => void
    requestChatDataSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve
        }),
    )

    const pending = evaluateIgp({
      ...baseOpts,
      promptTemplate: CHATML_PROMPT,
      target: {
        characterId: 'cha-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        expectedData: 'derived final text',
        expectedGenerationId: 'generation-1',
      },
    })
    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[0].chats[0].message[0].data = 'newer user edit'
    })
    resolveProvider({ type: 'success', result: 'IGP-RESULT' })
    await pending

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('newer user edit')
    expect(calls).not.toContainEqual(
      expect.objectContaining({ url: '/api/v1/commands/messages/message-1', method: 'PATCH' }),
    )
  })
})
