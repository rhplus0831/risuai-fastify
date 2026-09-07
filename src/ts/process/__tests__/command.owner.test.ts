import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { IDBFactory } from 'fake-indexeddb'

// Regression coverage: slash-command handlers (`/send`, `/setvar`, `/cut`, ...)
// apply an optimistic local update before dispatching a command. That update
// must target the explicit chat owner and still dispatch the matching command.

vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'command-projection-token',
}))

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

const coordinateAcceptedChatSendMock = vi.hoisted(() =>
  vi.fn<(...args: any[]) => Promise<any>>(async () => ({ status: 'generated' })),
)
vi.mock('../acceptedSendCoordinator.svelte', () => ({
  coordinateAcceptedChatSend: coordinateAcceptedChatSendMock,
}))

vi.mock('src/ts/activeChatGenerationSettings', () => ({
  guardActiveChatGenerationSettingsForSend: vi.fn(() => ({ status: 'ok' })),
}))

// Spy: count setDatabase normalizer runs without changing its behavior.
// `/setvar`/`/addvar` and send-family message mutations must not reach it: the
// owner-local write plus scoped dispatch persist the change without the
// whole-database normalizer and language refresh churn.
const setDatabaseSpy = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../storage/database.svelte', async (importActual) => {
  const actual = await importActual<typeof import('../../storage/database.svelte')>()
  return {
    ...actual,
    setDatabase: (...args: Parameters<typeof actual.setDatabase>) => {
      setDatabaseSpy.count += 1
      return actual.setDatabase(...args)
    },
  }
})

import { safeStructuredClone } from '../../polyfill'
import { testDatabaseState } from '../../__tests__/resourceDatabaseState'
import { processMultiCommand } from '../command'
import { clearCachedServerCommandRevision } from '../../server/commands'
import { captureClientSessionGeneration, demoteClientSession, resetClientSessionForTests } from '../../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../../__tests__/clientSession'
import { resolveAlertInput, resolveAlertSelection } from '../../alert'

import { alertStore, selectedCharID } from '../../stores.svelte'
import { withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import {
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from '../../server/pendingMutationOutbox'
import { replayPendingMutations } from '../../server/pendingMutationReplay'

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
      if (url.endsWith('/scriptstate')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'chat.scriptstate.updated', revision: 11, resource: 'chat' },
        })
      }
      if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: { type: 'message.appended', revision: 11, resource: 'message', parentId: 'chat-1' },
        })
      }
      if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'PUT') {
        return jsonResponse({
          revision: 11,
          event: { type: 'messages.replaced', revision: 11, resource: 'message', parentId: 'chat-1' },
        })
      }
      if (url.startsWith('/api/v1/commands/messages/') && init.method === 'PATCH') {
        return jsonResponse({
          revision: 11,
          event: { type: 'message.updated', revision: 11, resource: 'message', id: url.split('/').at(-1) },
        })
      }
      if (url.startsWith('/api/v1/commands/messages/') && init.method === 'DELETE') {
        return jsonResponse({
          revision: 11,
          event: { type: 'message.deleted', revision: 11, resource: 'message', id: url.split('/').at(-1) },
        })
      }
      if (url === '/api/v1/commands/chats/chat-1/messages/truncate' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: { type: 'message.truncated', revision: 11, resource: 'message', parentId: 'chat-1' },
        })
      }
      if (url === '/api/v1/commands/chats/chat-1/messages/tail' && init.method === 'POST') {
        return jsonResponse({
          revision: 11,
          event: { type: 'messages.replaced', revision: 11, resource: 'message', parentId: 'chat-1' },
        })
      }
      if (url.startsWith('/api/v1/commands/chats/')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'chat.updated', revision: 11, resource: 'chat' },
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForCommand(
  calls: CapturedFetch[],
  predicate: (call: CapturedFetch) => boolean,
): Promise<CapturedFetch> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = calls.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`command not dispatched; saw: ${JSON.stringify(calls)}`)
}

async function waitForMatchingCalls(
  calls: CapturedFetch[],
  predicate: (call: CapturedFetch) => boolean,
  expected: number,
): Promise<CapturedFetch[]> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const matches = calls.filter(predicate)
    if (matches.length >= expected) return matches
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`expected ${expected} matching commands; saw: ${JSON.stringify(calls)}`)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function commandMessages(call: CapturedFetch): Array<Record<string, unknown>> {
  const body = call.body as { messages?: Array<Record<string, unknown>> } | null
  return body?.messages ?? []
}

interface ExpectedMessageCommand {
  url: string
  method: string
}

interface MessageCommandRun {
  command: CapturedFetch
  messages: Array<Record<string, unknown>>
}

async function runMessageCommand(
  command: string,
  messages: unknown[],
  expected: ExpectedMessageCommand,
): Promise<MessageCommandRun> {
  seedDatabase(messages)
  const calls = stubCommandFetch()
  await expect(processMultiCommand(command)).resolves.not.toBe(false)

  const dispatched = await waitForCommand(calls, (call) => call.url === expected.url && call.method === expected.method)
  return {
    command: dispatched,
    messages: testDatabaseState.db.characters[0].chats[0].message as unknown as Array<Record<string, unknown>>,
  }
}

async function withAsyncCloneInstrumentation<T>(fn: () => Promise<T>) {
  const originalStringify = JSON.stringify
  const originalStructuredClone = globalThis.structuredClone
  let jsonCloneCount = 0
  let structuredCloneCount = 0
  let maxClonedSize = 0

  const measure = (value: unknown): number => {
    try {
      return (originalStringify as (input: unknown) => string)(value)?.length ?? 0
    } catch {
      return 0
    }
  }

  const trackedStringify = function trackedStringify(
    this: unknown,
    value: unknown,
    replacer?: unknown,
    space?: unknown,
  ) {
    jsonCloneCount += 1
    const out = (originalStringify as (...args: unknown[]) => string).call(this, value, replacer, space)
    if (typeof out === 'string' && out.length > maxClonedSize) maxClonedSize = out.length
    return out
  } as unknown as typeof JSON.stringify

  const trackedStructuredClone = function trackedStructuredClone<V>(value: V): V {
    structuredCloneCount += 1
    const size = measure(value)
    if (size > maxClonedSize) maxClonedSize = size
    return (originalStructuredClone as (input: V) => V)(value)
  } as typeof structuredClone

  JSON.stringify = trackedStringify
  globalThis.structuredClone = trackedStructuredClone
  try {
    const result = await fn()
    return {
      result,
      jsonCloneCount,
      structuredCloneCount,
      totalCloneCount: jsonCloneCount + structuredCloneCount,
      maxClonedSize,
    }
  } finally {
    JSON.stringify = originalStringify
    globalThis.structuredClone = originalStructuredClone
  }
}

function seedDatabase(messages: unknown[] = [], options: { language?: string; includeSiblings?: boolean } = {}): void {
  selectedCharID.set(0)
  const activeChats = [
    {
      id: 'chat-1',
      message: messages,
      note: '',
      name: 'main',
      localLore: [],
      scriptstate: {},
    },
  ]
  if (options.includeSiblings) {
    activeChats.push({
      id: 'chat-active-sibling',
      message: [{ role: 'user', data: 'active sibling', chatId: 'm-active-sibling' }],
      note: '',
      name: 'active sibling',
      localLore: [],
      scriptstate: {},
    })
  }
  testDatabaseState.db = {
    language: options.language ?? 'en',
    characters: [
      {
        chaId: 'char-a',
        name: 'Character',
        desc: '',
        chatPage: 0,
        chats: activeChats,
        triggerscript: [],
        defaultVariables: '',
        globalLore: [],
        type: 'character',
      },
      ...(options.includeSiblings
        ? [
            {
              chaId: 'char-b',
              name: 'Sibling Character',
              desc: '',
              chatPage: 0,
              chats: [
                {
                  id: 'chat-sibling',
                  message: [{ role: 'user', data: 'sibling', chatId: 'm-sibling' }],
                  note: '',
                  name: 'sibling',
                  localLore: [],
                  scriptstate: {},
                },
              ],
              triggerscript: [],
              defaultVariables: '',
              globalLore: [],
              type: 'character',
            },
          ]
        : []),
    ],
    characterOrder: [],
    customscript: [],
  } as any
}

function seedLargeSiblingDatabase(): void {
  seedDatabase([{ role: 'user', data: 'seed', chatId: 'm-seed' }], {
    language: 'ko',
    includeSiblings: true,
  })
  testDatabaseState.db.characters[1].chats[0].message = Array.from({ length: 120 }, (_unused, index) => ({
    role: index % 2 === 0 ? 'user' : 'char',
    data: `${'x'.repeat(500)}-${index}`,
    chatId: `m-sibling-large-${index}`,
  }))
}

beforeEach(() => {
  resetClientSessionForTests()
  ;(globalThis as Record<string, unknown>).safeStructuredClone = safeStructuredClone
  clearCachedServerCommandRevision()
  seedDatabase()
  setDatabaseSpy.count = 0
  coordinateAcceptedChatSendMock.mockReset().mockResolvedValue({ status: 'generated' })
})

afterEach(() => {
  resetClientSessionForTests()
  const alert = get(alertStore)
  if (alert.type === 'input') resolveAlertInput(alert.dialogOwner, null)
  if (alert.type === 'select') resolveAlertSelection(alert.dialogOwner, null)
  vi.unstubAllGlobals()
})

describe('slash-command durable owner writes', () => {
  it.each(['/input Message', '/buttons labels=["Message"]'])(
    'stops the next pipeline write after %s crosses demotion and repromotion',
    async (firstCommand) => {
      enterClientWriter()
      const calls = stubCommandFetch()
      const pipeline = processMultiCommand(`${firstCommand}|/send {{pipe}}|/setvar key=stale yes`)
      const alert = get(alertStore)
      expect(alert.dialogOwner).toBeDefined()
      demoteClientSession()
      repromoteClientWriter()
      if (firstCommand.startsWith('/input')) expect(resolveAlertInput(alert.dialogOwner, 'Old dialog text')).toBe(true)
      else expect(resolveAlertSelection(alert.dialogOwner, 0)).toBe(true)
      const result = await pipeline
      expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([])
      expect(testDatabaseState.db.characters[0].chats[0].scriptstate).toEqual({})
      expect(calls).toEqual([])
      expect(result).toBe(false)
    },
  )

  it('rejects a command pipeline entered by a reader before showing a dialog or changing scriptstate', async () => {
    enterClientWriter()
    demoteClientSession()
    const calls = stubCommandFetch()
    const alert = get(alertStore)
    await expect(processMultiCommand('/setvar key=reader yes|/send reader text')).resolves.toBe(false)
    await expect(processMultiCommand('/input Reader dialog')).resolves.toBe(false)
    expect(testDatabaseState.db.characters[0].chats[0].scriptstate).toEqual({})
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([])
    expect(get(alertStore)).toBe(alert)
    expect(calls).toEqual([])
  })

  it('continues an admitted writer pipeline after its input dialog resolves', async () => {
    enterClientWriter()
    const calls = stubCommandFetch()
    const pipeline = processMultiCommand('/input Message|/send {{pipe}}')
    expect(resolveAlertInput(get(alertStore).dialogOwner, 'Current writer text')).toBe(true)
    await expect(pipeline).resolves.toBe('Current writer text')
    const command = await waitForCommand(calls, (call) => call.method === 'POST')
    expect(command.body.message).toMatchObject({ role: 'user', data: 'Current writer text' })
    expect(testDatabaseState.db.characters[0].chats[0].message.at(-1)?.data).toBe('Current writer text')
  })

  it('/send appends a user message without setDatabase or whole-db clone churn', async () => {
    seedLargeSiblingDatabase()
    const wholeCharactersSize = JSON.stringify(testDatabaseState.db.characters).length
    const calls = stubCommandFetch()
    const instrumented = await withAsyncCloneInstrumentation(() => processMultiCommand('/send hello world'))

    expect(instrumented.result).toBe('')
    expect(testDatabaseState.db.characters[0].chats[0].message.at(-1)).toMatchObject({
      role: 'user',
      data: 'hello world',
    })
    expect(setDatabaseSpy.count).toBe(0)
    expect(instrumented.maxClonedSize).toBeLessThan(wholeCharactersSize)
    expect(instrumented.structuredCloneCount).toBe(0)

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
    )
    expect(cmd.body.message).toMatchObject({ role: 'user', data: 'hello world', chatId: expect.any(String) })
  })

  it('/send preserves pipe return behavior while appending the piped text', async () => {
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/pass piped text|/send {{pipe}}')).resolves.toBe('piped text')

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
    )
    expect(cmd.body.message).toMatchObject({ role: 'user', data: 'piped text', chatId: expect.any(String) })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/sendas appends a character message without setDatabase', async () => {
    const { command, messages } = await runMessageCommand(
      '/sendas character line',
      [{ role: 'user', data: 'seed', chatId: 'm-seed' }],
      { url: '/api/v1/commands/chats/chat-1/messages', method: 'POST' },
    )

    expect(messages).toHaveLength(2)
    expect(messages.at(-1)).toMatchObject({ role: 'char', data: 'character line' })
    expect(command.body.message).toMatchObject({ role: 'char', data: 'character line', chatId: expect.any(String) })
    expect(testDatabaseState.db.characters[0].chats[0].message.at(-1)).toMatchObject({
      role: 'char',
      data: 'character line',
    })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/comment appends the legacy comment block to the last message', async () => {
    const { command, messages } = await runMessageCommand(
      '/comment side note',
      [{ role: 'char', data: 'base', chatId: 'm-base' }],
      { url: '/api/v1/commands/messages/m-base', method: 'PATCH' },
    )

    expect(messages).toEqual([
      {
        role: 'char',
        data: 'base<Comment>\nside note\n</Comment>',
        chatId: 'm-base',
      },
    ])
    expect(command.body.patch).toEqual({ data: 'base<Comment>\nside note\n</Comment>' })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/cut range deletes the inclusive message range', async () => {
    const { command, messages } = await runMessageCommand(
      '/cut 1-3',
      [
        { role: 'user', data: 'zero', chatId: 'm0' },
        { role: 'char', data: 'one', chatId: 'm1' },
        { role: 'user', data: 'two', chatId: 'm2' },
        { role: 'char', data: 'three', chatId: 'm3' },
        { role: 'user', data: 'four', chatId: 'm4' },
      ],
      { url: '/api/v1/commands/chats/chat-1/messages/tail', method: 'POST' },
    )

    expect(messages.map((message) => message.chatId)).toEqual(['m0', 'm4'])
    expect(command.body.afterMessageId).toBe('m0')
    expect(commandMessages(command).map((message) => message.chatId)).toEqual(['m4'])
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/cut index deletes only the selected message', async () => {
    const { command, messages } = await runMessageCommand(
      '/cut 1',
      [
        { role: 'user', data: 'zero', chatId: 'm0' },
        { role: 'char', data: 'one', chatId: 'm1' },
        { role: 'user', data: 'two', chatId: 'm2' },
      ],
      { url: '/api/v1/commands/messages/m1', method: 'DELETE' },
    )

    expect(messages.map((message) => message.chatId)).toEqual(['m0', 'm2'])
    expect(command.body).toEqual({ baseRevision: 10 })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/cut treats a hyphenated message id as an id rather than a numeric range', async () => {
    const messageId = 'message-uuid-with-hyphens'
    const { command, messages } = await runMessageCommand(
      `/cut ${messageId}`,
      [
        { role: 'user', data: 'zero', chatId: 'm0' },
        { role: 'char', data: 'one', chatId: messageId },
        { role: 'user', data: 'two', chatId: 'm2' },
      ],
      { url: `/api/v1/commands/messages/${messageId}`, method: 'DELETE' },
    )

    expect(messages.map((message) => message.chatId)).toEqual(['m0', 'm2'])
    expect(command.body).toEqual({ baseRevision: 10 })
  })

  it('/cut id removes the matching chatId without setDatabase', async () => {
    const { command, messages } = await runMessageCommand(
      '/cut m2',
      [
        { role: 'user', data: 'zero', chatId: 'm0' },
        { role: 'char', data: 'one', chatId: 'm1' },
        { role: 'user', data: 'two', chatId: 'm2' },
      ],
      { url: '/api/v1/commands/chats/chat-1/messages/truncate', method: 'POST' },
    )

    expect(messages.map((message) => message.chatId)).toEqual(['m0', 'm1'])
    expect(command.body.afterMessageId).toBe('m1')
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/del removes the last N messages without setDatabase', async () => {
    const { command, messages } = await runMessageCommand(
      '/del 2',
      [
        { role: 'user', data: 'zero', chatId: 'm0' },
        { role: 'char', data: 'one', chatId: 'm1' },
        { role: 'user', data: 'two', chatId: 'm2' },
        { role: 'char', data: 'three', chatId: 'm3' },
      ],
      { url: '/api/v1/commands/chats/chat-1/messages/truncate', method: 'POST' },
    )

    expect(messages.map((message) => message.chatId)).toEqual(['m0', 'm1'])
    expect(command.body).toEqual({ baseRevision: 10, afterMessageId: 'm1' })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/multisend appends each segment in order and sends after each one', async () => {
    seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }])
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/multisend first|||second')).resolves.toBe('')

    const messageCommands = await waitForMatchingCalls(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
      2,
    )
    expect(messageCommands.map((call) => call.body.message.data)).toEqual(['first', 'second'])
    expect(testDatabaseState.db.characters[0].chats[0].message.map((message: any) => message.data)).toEqual([
      'base',
      'first',
      'second',
    ])
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(2)
    expect(coordinateAcceptedChatSendMock).toHaveBeenNthCalledWith(1, {
      target: expect.objectContaining({ characterId: 'char-a', chatId: 'chat-1' }),
      clientGeneration: expect.any(Number),
      append: expect.objectContaining({ status: 'ok', messageId: expect.any(String) }),
    })
    expect(coordinateAcceptedChatSendMock).toHaveBeenNthCalledWith(2, {
      target: expect.objectContaining({ characterId: 'char-a', chatId: 'chat-1' }),
      clientGeneration: expect.any(Number),
      append: expect.objectContaining({ status: 'ok', messageId: expect.any(String) }),
    })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it.each(['accepted', 'queued'] as const)(
    'settles a %s compatibility append across a role cycle without starting generation or the next segment',
    async (initialStatus) => {
      const { coordinateAcceptedChatSend } = await vi.importActual<typeof import('../acceptedSendCoordinator.svelte')>(
        '../acceptedSendCoordinator.svelte',
      )
      let coordination: ReturnType<typeof coordinateAcceptedChatSend> | undefined
      coordinateAcceptedChatSendMock.mockImplementationOnce((input) => {
        coordination = coordinateAcceptedChatSend(input)
        return coordination
      })
      vi.stubGlobal('indexedDB', new IDBFactory())
      resetPendingMutationOutboxForTests()
      await preparePendingMutationOutbox({
        writerSessionId: 'draft-test-session',
        writerEpoch: 1,
        databaseLineage: 'draft-test-lineage',
        requestedWriterWasActive: true,
      })
      enterClientWriter()
      const clientGeneration = captureClientSessionGeneration()
      const response = deferred<Response>()
      const calls: CapturedFetch[] = []
      const acceptedResponse = (messageId: string) =>
        jsonResponse({
          revision: 11,
          chatId: 'chat-1',
          messageId,
          event: { type: 'message.appended', revision: 11, resource: 'message', id: messageId, parentId: 'chat-1' },
        })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({ url, method: init.method ?? 'GET', body })
          if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'POST') {
            return calls.filter((call) => call.url === url && call.method === 'POST').length === 1
              ? response.promise
              : acceptedResponse(body.message.chatId)
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }),
      )
      try {
        let finished = false
        const pipeline = processMultiCommand('/multisend first|||do not append').finally(() => {
          finished = true
        })
        const append = await waitForCommand(calls, (call) => call.method === 'POST')
        const messageId = append.body.message.chatId as string
        demoteClientSession()
        repromoteClientWriter()
        response.resolve(
          initialStatus === 'queued'
            ? jsonResponse({ error: 'temporarily unavailable' }, 503)
            : acceptedResponse(messageId),
        )
        await vi.waitFor(() => expect(coordinateAcceptedChatSendMock).toHaveBeenCalledOnce())
        expect(coordinateAcceptedChatSendMock).toHaveBeenCalledWith(
          expect.objectContaining({
            clientGeneration,
            append: expect.objectContaining({ status: initialStatus === 'queued' ? 'queued' : 'ok', messageId }),
          }),
        )
        if (initialStatus === 'queued') {
          expect(finished).toBe(false)
          expect(await listPendingMutations()).toHaveLength(1)
          await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1, retained: 0 })
        }
        await expect(coordination).resolves.toMatchObject({ status: 'generation_failed', acceptedMessageId: messageId })
        await expect(pipeline).resolves.toBe(false)
        expect(coordinateAcceptedChatSendMock).toHaveBeenCalledOnce()
        expect(calls.filter((call) => call.url.endsWith('/messages') && call.method === 'POST')).toHaveLength(
          initialStatus === 'queued' ? 2 : 1,
        )
        expect(
          calls.some((call) => call.url.includes('generation-operations') || call.url.includes('/chat/completions')),
        ).toBe(false)
        expect(testDatabaseState.db.characters[0].chats[0].message.map((message) => message.data)).toEqual(['first'])
        expect(await listPendingMutations()).toEqual([])
      } finally {
        response.resolve(jsonResponse({ error: 'cleanup' }, 503))
        await clearPendingMutationOutbox()
        resetPendingMutationOutboxForTests()
      }
    },
  )

  it.each([false, true])(
    'rechecks the writer after each coordinated /multisend result (role cycle: %s)',
    async (roleCycle) => {
      enterClientWriter()
      seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }])
      const calls = stubCommandFetch()
      const firstGeneration = deferred<{ status: 'generated' }>()
      coordinateAcceptedChatSendMock.mockReturnValueOnce(firstGeneration.promise)
      const command = processMultiCommand('/multisend first|||second')
      await waitForMatchingCalls(
        calls,
        (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
        1,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(1)
      expect(
        calls.filter((call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST'),
      ).toHaveLength(1)

      if (roleCycle) {
        demoteClientSession()
        repromoteClientWriter()
      }
      firstGeneration.resolve({ status: 'generated' })
      await expect(command).resolves.toBe(roleCycle ? false : '')

      expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(roleCycle ? 1 : 2)
      expect(
        calls.filter((call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST'),
      ).toHaveLength(roleCycle ? 1 : 2)
    },
  )

  it('stops /multisend after an accepted item reaches coordinator recovery', async () => {
    seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }])
    const calls = stubCommandFetch()
    coordinateAcceptedChatSendMock.mockResolvedValueOnce({
      status: 'generation_failed',
      cause: 'generation_failed',
    })
    await expect(processMultiCommand('/multisend first|||do not append')).resolves.toBe('')

    expect(
      calls.filter((call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST'),
    ).toHaveLength(1)
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(1)
  })

  it('/multisend stops after the active chat changes during the first send', async () => {
    seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }], { includeSiblings: true })
    const calls = stubCommandFetch()
    coordinateAcceptedChatSendMock.mockImplementationOnce(async () => {
      withTestDatabaseWrite(() => {
        testDatabaseState.db.characters[0].chatPage = 1
      })
      return { status: 'generated' }
    })

    await expect(processMultiCommand('/multisend first|||second')).resolves.toBe('')

    await waitForMatchingCalls(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
      1,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const messageCommands = calls.filter(
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
    )
    expect(messageCommands).toHaveLength(1)
    expect(messageCommands[0].body.message).toMatchObject({ data: 'first', chatId: expect.any(String) })
    expect(testDatabaseState.db.characters[0].chats[0].message.map((message: any) => message.data)).toEqual([
      'base',
      'first',
    ])
    expect(testDatabaseState.db.characters[0].chats[1].message.map((message: any) => message.data)).toEqual([
      'active sibling',
    ])
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(1)
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledWith({
      target: expect.objectContaining({ characterId: 'char-a', chatId: 'chat-1' }),
      clientGeneration: expect.any(Number),
      append: expect.objectContaining({ status: 'ok', messageId: expect.any(String) }),
    })
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/multisend clear resets before each segment and still sends each segment', async () => {
    seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }])
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/multisend clear|||first|||second')).resolves.toBe('')

    const messageCommands = await waitForMatchingCalls(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'PUT',
      2,
    )
    expect(messageCommands.map((call) => commandMessages(call))).toEqual([[], []])
    const appendCommands = await waitForMatchingCalls(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
      2,
    )
    expect(appendCommands.map((call) => call.body.message.data)).toEqual(['first', 'second'])
    expect(testDatabaseState.db.characters[0].chats[0].message.map((message: any) => message.data)).toEqual(['second'])
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(2)
    expect(
      calls
        .filter((call) => call.url === '/api/v1/commands/chats/chat-1/messages')
        .map((call) => [call.method, call.method === 'PUT' ? commandMessages(call) : call.body.message.data]),
    ).toEqual([
      ['PUT', []],
      ['POST', 'first'],
      ['PUT', []],
      ['POST', 'second'],
    ])
    expect(setDatabaseSpy.count).toBe(0)
  })

  it.each([false, true])(
    'rechecks the writer after /multisend clear is accepted (role cycle: %s)',
    async (roleCycle) => {
      enterClientWriter()
      const calls: CapturedFetch[] = []
      const clearResponse = deferred<Response>()
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
          if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'PUT') {
            return clearResponse.promise
          }
          if (url === '/api/v1/commands/chats/chat-1/messages' && init.method === 'POST') {
            return jsonResponse({
              revision: 12,
              event: { type: 'message.appended', revision: 12, resource: 'message', parentId: 'chat-1' },
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )
      seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }])
      const command = processMultiCommand('/multisend clear|||first')
      await waitForCommand(
        calls,
        (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'PUT',
      )

      expect(calls.some((call) => call.method === 'POST')).toBe(false)
      expect(coordinateAcceptedChatSendMock).not.toHaveBeenCalled()
      if (roleCycle) {
        demoteClientSession()
        repromoteClientWriter()
      }

      clearResponse.resolve(
        jsonResponse({
          revision: 11,
          event: { type: 'messages.replaced', revision: 11, resource: 'message', parentId: 'chat-1' },
        }),
      )
      await expect(command).resolves.toBe(roleCycle ? false : '')

      expect(calls.map((call) => call.method)).toEqual(roleCycle ? ['GET', 'PUT'] : ['GET', 'PUT', 'POST'])
      expect(coordinateAcceptedChatSendMock).toHaveBeenCalledTimes(roleCycle ? 0 : 1)
    },
  )

  it('forced message-command failure restores only the active chat', async () => {
    const calls: CapturedFetch[] = []
    let resolveMessageResponse: ((response: Response) => void) | undefined
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
          return new Promise<Response>((resolve) => {
            resolveMessageResponse = resolve
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    seedDatabase([{ role: 'char', data: 'base', chatId: 'm-base' }], { includeSiblings: true })
    await expect(processMultiCommand('/send optimistic')).resolves.toBe('')
    await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST',
    )
    expect(testDatabaseState.db.characters[0].chats[0].message.map((message: any) => message.data)).toEqual([
      'base',
      'optimistic',
    ])

    withTestDatabaseWrite(() => {
      testDatabaseState.db.characters[0].chats[1].name = 'active sibling edit'
      testDatabaseState.db.characters[1].name = 'sibling character edit'
      testDatabaseState.db.characters[1].chats[0].message.push({
        role: 'char',
        data: 'sibling message edit',
        chatId: 'm-sibling-edit',
      })
    })

    resolveMessageResponse?.(jsonResponse({ error: 'forced failure' }, 500))

    await vi.waitFor(() => {
      expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([
        {
          role: 'char',
          data: 'base',
          chatId: 'm-base',
        },
      ])
    })
    expect(testDatabaseState.db.characters[0].chats[1].name).toBe('active sibling edit')
    expect(testDatabaseState.db.characters[1].name).toBe('sibling character edit')
    expect(testDatabaseState.db.characters[1].chats[0].message.map((message: any) => message.data)).toEqual([
      'sibling',
      'sibling message edit',
    ])
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/setvar updates chat scriptstate via the scriptstate command', async () => {
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/setvar key=hp 100')).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/scriptstate' && call.method === 'PATCH',
    )
    expect(cmd.body.patch['$hp']).toBe('100')
  })

  it('/setvar persists scriptstate without re-running the setDatabase normalizer', async () => {
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/setvar key=hp 100')).resolves.not.toThrow()

    // The in-place write landed and the scoped command dispatched...
    expect(testDatabaseState.db.characters[0].chats[0].scriptstate?.['$hp']).toBe('100')
    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/scriptstate' && call.method === 'PATCH',
    )
    expect(cmd.body.patch['$hp']).toBe('100')
    // ...without the ~680-line normalizer (and its non-English language-pack
    // deep clone) running once per var write.
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/addvar persists the incremented value without the setDatabase normalizer', async () => {
    seedDatabase()
    testDatabaseState.db.characters[0].chats[0].scriptstate = { $damage: '5' }
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/addvar key=damage 10')).resolves.not.toThrow()

    expect(testDatabaseState.db.characters[0].chats[0].scriptstate?.['$damage']).toBe('15')
    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/scriptstate' && call.method === 'PATCH',
    )
    expect(cmd.body.patch['$damage']).toBe('15')
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('/del truncates message history without throwing', async () => {
    seedDatabase([
      { role: 'user', data: 'one', chatId: 'm1' },
      { role: 'char', data: 'two', chatId: 'm2' },
    ])
    const calls = stubCommandFetch()
    await expect(processMultiCommand('/del 1')).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/messages/truncate' && call.method === 'POST',
    )
    expect(cmd.body).toEqual({ baseRevision: 10, afterMessageId: 'm1' })
    expect(testDatabaseState.db.characters[0].chats[0].message).toEqual([{ role: 'user', data: 'one', chatId: 'm1' }])
    expect(setDatabaseSpy.count).toBe(0)
  })

  it('command processing logs nothing to console.log on the warm path', async () => {
    const calls = stubCommandFetch()
    const logSpy = vi.spyOn(console, 'log')

    try {
      // A piped multi-command exercises both former log sites: the parsed
      // `splited` dump and the per-step `pipe` dump.
      await expect(processMultiCommand('/setvar key=hp 100|/getvar key=hp')).resolves.toBe('100')
      await waitForCommand(
        calls,
        (call) => call.url === '/api/v1/commands/chats/chat-1/scriptstate' && call.method === 'PATCH',
      )
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })
})
