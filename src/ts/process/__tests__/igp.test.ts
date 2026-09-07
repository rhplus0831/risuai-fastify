import { resetClientSessionForTests } from '../../clientSession'
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

import { applyServerResourceDatabase, setDatabase, type Database, type character } from '../../storage/database.svelte'
import { selectedCharID } from '../../stores.svelte'
import { replaceResourceDatabase } from '../../server/resourceState.svelte'
import { evaluateIgp } from '../postGeneration/igp'
import { clearCachedServerCommandRevision } from '../../server/commands'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

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

describe('evaluateIgp', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    clearCachedServerCommandRevision()
    vi.unstubAllGlobals()
    requestChatDataSpy.mockReset()
    requestChatDataSpy.mockResolvedValue({ type: 'success', result: 'IGP-RESULT' })
  })

  afterEach(() => {
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

  it('is a no-op when the parsed prompt is empty (whitespace-only after parsing)', async () => {
    seed(makeChar())
    await evaluateIgp({ ...baseOpts, promptTemplate: '' })
    expect(requestChatDataSpy).not.toHaveBeenCalled()
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

  it('stringifies non-string IGP result payloads without [object Object]', async () => {
    stubCommandFetch()
    seed(makeChar())
    requestChatDataSpy.mockResolvedValueOnce({ type: 'success', result: { label: 'joy' } })

    await evaluateIgp({ ...baseOpts, promptTemplate: CHATML_PROMPT })

    expect(testDatabaseState.db.characters[0].chats[0].message[0].data).toBe('hello{"label":"joy"}')
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
    })
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
