import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { alertErrorSpy } = vi.hoisted(() => ({ alertErrorSpy: vi.fn() }))
vi.mock('../../alert', async (importActual) => {
  const actual = await importActual<typeof import('../../alert')>()
  return { ...actual, alertError: alertErrorSpy }
})

// Break a circular-init chain where stores.svelte imports trigger moduleUpdate,
// then getModules/getDatabase before all DB imports are initialized in this test
// file's dependency graph. The tests do not exercise modules; a noop is safe.
vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, moduleUpdate: () => {} }
})

vi.mock('../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'send-error-test-token',
}))

import { applyServerResourceDatabase, setDatabase, type Database, type character } from '../../storage/database.svelte'
import { selectedCharID } from '../../stores.svelte'
import { replaceResourceDatabase } from '../../server/resourceState.svelte'
import { reportSendChatError, type SendChatErrorContext } from '../sendChatErrors'
import { clearCachedServerCommandRevision, runExternalServerRevisionOperation } from '../../server/commands'
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
      if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: { type: 'message.appended', revision: 11, resource: 'message', parentId: 'chat-1' },
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForMessageCommand(calls: CapturedFetch[]): Promise<CapturedFetch> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = calls.find((call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST')
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`message command not dispatched; saw ${JSON.stringify(calls)}`)
}

function makeChar(): character {
  return {
    name: 'Test',
    chaId: 'test-cha-id',
    firstMessage: '',
    desc: '',
    notes: '',
    chats: [
      {
        id: 'chat-1',
        message: [],
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

function seed(opts: { inlayErrorResponse: boolean; char?: character | null }) {
  const db: Partial<Database> = {
    inlayErrorResponse: opts.inlayErrorResponse,
    characters: opts.char === null ? [] : [opts.char ?? makeChar()],
  }
  setDatabase(db as Database)
  selectedCharID.set(0)
}

const baseCtx: SendChatErrorContext = {
  target: { characterId: 'test-cha-id', chatId: 'chat-1' },
  generationInfo: undefined,
}

describe('reportSendChatError', () => {
  beforeEach(() => {
    clearCachedServerCommandRevision()
    vi.unstubAllGlobals()
    stubCommandFetch()
    alertErrorSpy.mockReset()
    // Each test calls seed() which wholesale reseeds testDatabaseState. Restoring to {}
    // between tests would fire a $effect chain that reads modules off a partial
    // DB and throws (same shape as the guard in parser.svelte.ts).
  })

  afterEach(async () => {
    await runExternalServerRevisionOperation(async () => undefined)
    vi.unstubAllGlobals()
  })

  it('falls back to alertError when inlayErrorResponse is off', () => {
    seed({ inlayErrorResponse: false })
    reportSendChatError('boom', baseCtx)
    expect(alertErrorSpy).toHaveBeenCalledTimes(1)
    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
    expect(testDatabaseState.db.characters[0].chats[0].message).toHaveLength(0)
  })

  it('falls back to alertError when the stable character is missing', () => {
    seed({ inlayErrorResponse: true, char: null })
    reportSendChatError('boom', baseCtx)
    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
  })

  it('falls back to alertError when the stable chat is missing', () => {
    const char = makeChar()
    char.chats = []
    seed({ inlayErrorResponse: true, char })
    reportSendChatError('boom', baseCtx)
    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
  })

  it('appends the error suffix only to the exact stable char message', () => {
    const char = makeChar()
    char.chats[0].message = [
      { role: 'user', data: 'hi', time: 0, chatId: 'm-user' },
      { role: 'char', data: 'hello', time: 0, chatId: 'm-char' },
      { role: 'char', data: 'newer', time: 0, chatId: 'm-newer' },
    ]
    seed({ inlayErrorResponse: true, char })
    reportSendChatError('boom', { ...baseCtx, messageId: 'm-char' })
    expect(alertErrorSpy).not.toHaveBeenCalled()
    const messages = testDatabaseState.db.characters[0].chats[0].message
    expect(messages).toHaveLength(3)
    expect(messages[1].data).toBe('hello\n```risuerror\nboom\n```')
    expect(messages[2].data).toBe('newer')
  })

  it('pushes a new char message when the last message is from user', () => {
    const char = makeChar()
    char.chats[0].message = [{ role: 'user', data: 'hi', time: 0 }]
    seed({ inlayErrorResponse: true, char })
    reportSendChatError('boom', baseCtx)
    const messages = testDatabaseState.db.characters[0].chats[0].message
    expect(messages).toHaveLength(2)
    expect(messages[1].role).toBe('char')
    expect(messages[1].data).toBe('```risuerror\nboom\n```')
    expect(messages[1].saying).toBe('test-cha-id')
  })

  it('attaches generationInfo to the pushed message when present', () => {
    seed({ inlayErrorResponse: true })
    reportSendChatError('boom', {
      ...baseCtx,
      generationInfo: { model: 'test-model', generationId: 'g-1' },
    })
    const messages = testDatabaseState.db.characters[0].chats[0].message
    expect(messages[0].generationInfo).toEqual({
      model: 'test-model',
      generationId: 'g-1',
    })
  })

  it('does not fall back to the current selection when the stable character is missing', () => {
    seed({ inlayErrorResponse: true })
    selectedCharID.set(0)
    reportSendChatError('boom', {
      ...baseCtx,
      target: { characterId: 'missing-character', chatId: 'chat-1' },
    })
    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([])
  })

  it('does not fall back to chatPage when the stable chat is missing', () => {
    const char = makeChar()
    char.chats = [
      { id: 'chat-1', message: [], note: '', name: 'a', localLore: [] } as never,
      { id: 'chat-2', message: [], note: '', name: 'b', localLore: [] } as never,
    ]
    char.chatPage = 1
    seed({ inlayErrorResponse: true, char })
    reportSendChatError('boom', {
      ...baseCtx,
      target: { characterId: 'test-cha-id', chatId: 'missing-chat' },
    })
    expect(testDatabaseState.db.characters[0].chats[0].message).toHaveLength(0)
    expect(testDatabaseState.db.characters[0].chats[1].message).toHaveLength(0)
    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
  })

  it('writes and persists the inlay bubble through the chat owner', async () => {
    const calls = stubCommandFetch()
    const char = makeChar()
    char.chats[0].message = [{ role: 'user', data: 'hi', time: 0, chatId: 'm-user' }]
    seed({ inlayErrorResponse: true, char })
    reportSendChatError('boom', baseCtx)

    const messages = testDatabaseState.db.characters[0].chats[0].message
    expect(alertErrorSpy).not.toHaveBeenCalled()
    expect(messages.at(-1)).toMatchObject({
      role: 'char',
      data: '```risuerror\nboom\n```',
      saying: 'test-cha-id',
    })

    const command = await waitForMessageCommand(calls)
    expect(command.body.message).toMatchObject({
      role: 'char',
      data: '```risuerror\nboom\n```',
      saying: 'test-cha-id',
      chatId: expect.any(String),
    })
    const projectedMessages = [{ role: 'user', data: 'hi', time: 0, chatId: 'm-user' }, command.body.message]

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[0].chats[0].message = [{ role: 'user', data: 'stale' }]
    })
    applyServerResourceDatabase({
      characters: [
        {
          ...makeChar(),
          chats: [
            {
              ...makeChar().chats[0],
              message: projectedMessages,
            },
          ],
        },
      ],
      inlayErrorResponse: true,
    } as Database)
    expect(testDatabaseState.db.characters[0].chats[0].message.at(-1).data).toBe('```risuerror\nboom\n```')
  })

  it('keeps modal fallback for invalid targets while the guard is enabled', () => {
    seed({ inlayErrorResponse: true, char: null })
    reportSendChatError('boom', {
      ...baseCtx,
      target: { characterId: 'missing-character', chatId: 'chat-1' },
    })

    expect(alertErrorSpy).toHaveBeenCalledWith('boom')
  })

  it('does not write through a reused character index when a deferred error target is deleted', async () => {
    const targetChar = makeChar()
    const replacement = makeChar()
    replacement.chaId = 'replacement-cha-id'
    replacement.name = 'Replacement'
    replacement.chats[0].id = 'replacement-chat-id'
    setDatabase({
      inlayErrorResponse: true,
      characters: [targetChar, replacement],
    } as Database)
    const capturedContext: SendChatErrorContext = {
      target: { characterId: 'test-cha-id', chatId: 'chat-1' },
      generationInfo: undefined,
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = gate.then(() => reportSendChatError('deferred boom', capturedContext))

    testDatabaseState.db.characters.splice(0, 1)
    release()
    await pending

    expect(testDatabaseState.db.characters[0].chaId).toBe('replacement-cha-id')
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([])
    expect(alertErrorSpy).toHaveBeenCalledWith('deferred boom')
  })
})
