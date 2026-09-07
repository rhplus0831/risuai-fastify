import {
  beginClientSession,
  settleClientReader,
  authorizeClientWriterRecovery,
  setClientConnectionState,
  setClientProjectionReady,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat, character } from '../storage/database.svelte'
import type { PyWorkerRequest, PyWorkerResponse } from './pyworker'

const luaMock = vi.hoisted(() => {
  let nextEngineId = 0
  const state = {
    engines: [] as any[],
    createEngine: vi.fn(),
    runTimeouts: [] as number[],
    loadedCodes: [] as string[],
    closedEngineIds: [] as number[],
    lastAccessKey: '',
    rejectDispatch: false,
    nextRunError: null as Error | null,
    dispatchArgs: new Map<string, unknown[]>(),
    callListenAction: null as null | ((engine: any, accessKey: string) => void | Promise<void>),
  }

  function makeEngine(options: Record<string, unknown>) {
    const hostFns = new Map<string, Function>()
    const engine = {
      id: nextEngineId++,
      options,
      hostFns,
      closed: false,
      global: {
        set: vi.fn((name: string, func: Function) => {
          hostFns.set(name, func)
        }),
        get: vi.fn((name: string) => {
          if (name === 'callListenMain') {
            return async (_mode: string, accessKey: string, value: string) => {
              state.lastAccessKey = accessKey
              if (state.rejectDispatch) {
                throw new Error('lua dispatch failed')
              }
              await state.callListenAction?.(engine, accessKey)
              return JSON.stringify(JSON.parse(value))
            }
          }
          const hostFunction = hostFns.get(name)
          const dispatchArgs = state.dispatchArgs.get(name)
          if (hostFunction && dispatchArgs) {
            return (accessKey: string) => hostFunction(accessKey, ...dispatchArgs)
          }
          return hostFunction
        }),
        newThread: vi.fn(() => {
          let loadedCode = ''
          return {
            loadString: vi.fn((code: string) => {
              loadedCode = code
              state.loadedCodes.push(code)
            }),
            run: vi.fn(async (_argCount: number, options?: { timeout?: number }) => {
              state.runTimeouts.push(options?.timeout ?? 0)
              if (state.nextRunError) {
                const error = state.nextRunError
                state.nextRunError = null
                throw error
              }
              if (loadedCode.includes('while true do end')) {
                throw new Error('thread timeout exceeded')
              }
              return []
            }),
          }
        }),
        getTop: vi.fn(() => 1),
        remove: vi.fn(),
        close: vi.fn(() => {
          if (!engine.closed) {
            engine.closed = true
            state.closedEngineIds.push(engine.id)
          }
        }),
      },
    }
    state.engines.push(engine)
    return engine
  }

  class LuaFactory {
    async mountFile() {}
    async createEngine(options: Record<string, unknown>) {
      return state.createEngine(options)
    }
  }

  class LuaEngine {}

  state.createEngine.mockImplementation(async (options: Record<string, unknown>) => makeEngine(options))

  return {
    ...state,
    LuaFactory,
    LuaEngine,
    reset() {
      nextEngineId = 0
      state.engines.length = 0
      state.runTimeouts.length = 0
      state.loadedCodes.length = 0
      state.closedEngineIds.length = 0
      state.lastAccessKey = ''
      state.rejectDispatch = false
      state.nextRunError = null
      state.dispatchArgs.clear()
      state.callListenAction = null
      state.createEngine.mockClear()
      state.createEngine.mockImplementation(async (options: Record<string, unknown>) => makeEngine(options))
    },
    setRejectDispatch(value: boolean) {
      state.rejectDispatch = value
    },
    failNextRun(error: Error) {
      state.nextRunError = error
    },
    setDispatchArgs(name: string, args: unknown[]) {
      state.dispatchArgs.set(name, args)
    },
    setCallListenAction(action: null | ((engine: any, accessKey: string) => void | Promise<void>)) {
      state.callListenAction = action
    },
  }
})

const mediaMock = vi.hoisted(() => ({
  fetchNative: vi.fn(),
  generateAIImage: vi.fn(),
  getInlayAsset: vi.fn(),
  getPersonaPrompt: vi.fn(() => ''),
  getUserIcon: vi.fn(() => 'persona.png'),
  getUserName: vi.fn(() => 'User'),
  readImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
  writeInlayImage: vi.fn(async () => 'inlay-id'),
}))
const requestChatData = vi.hoisted(() => vi.fn(async () => ({ type: 'success', result: 'ok' })))
const lorebookMock = vi.hoisted(() => ({
  loadLoreBookV3Prompt: vi.fn(async () => ({ actives: [] as Array<{ prompt: string; role: string }> })),
}))
const tokenizerMock = vi.hoisted(() => ({
  tokenize: vi.fn(async (text: string) => text.length),
}))

vi.mock('wasmoon', () => ({
  LuaFactory: luaMock.LuaFactory,
  LuaEngine: luaMock.LuaEngine,
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'scriptings-test-auth',
}))

vi.mock('../globalApi.svelte', async (importActual) => {
  const actual = await importActual<typeof import('../globalApi.svelte')>()
  return {
    ...actual,
    fetchNative: mediaMock.fetchNative,
    readImage: mediaMock.readImage,
  }
})

vi.mock('src/ts/globalApi.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/globalApi.svelte')>()
  return {
    ...actual,
    fetchNative: mediaMock.fetchNative,
    readImage: mediaMock.readImage,
  }
})

vi.mock('./files/inlays', () => ({
  getInlayAsset: mediaMock.getInlayAsset,
  writeInlayImage: mediaMock.writeInlayImage,
}))

vi.mock('./stableDiff', () => ({
  generateAIImage: mediaMock.generateAIImage,
}))

vi.mock('./lorebook.svelte', async (importActual) => {
  const actual = await importActual<typeof import('./lorebook.svelte')>()
  return {
    ...actual,
    loadLoreBookV3Prompt: lorebookMock.loadLoreBookV3Prompt,
  }
})

vi.mock('../tokenizer', async (importActual) => {
  const actual = await importActual<typeof import('../tokenizer')>()
  return {
    ...actual,
    tokenize: tokenizerMock.tokenize,
  }
})

vi.mock('./request/request', () => ({
  requestChatData,
}))

vi.mock('../util', async (importActual) => {
  const actual = await importActual<typeof import('../util')>()
  return {
    ...actual,
  }
})

vi.mock('../utilState', () => ({
  getPersonaPrompt: mediaMock.getPersonaPrompt,
  getUserIcon: mediaMock.getUserIcon,
  getUserName: mediaMock.getUserName,
}))

vi.mock('src/ts/util', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/util')>()
  return {
    ...actual,
    asBuffer: (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
  }
})

vi.mock('./modules', async (importActual) => {
  const actual = await importActual<typeof import('./modules')>()
  return {
    ...actual,
    getModuleLorebooks: () => [],
    getModuleTriggers: () => [],
    moduleUpdate: () => {},
  }
})

import {
  CLIENT_LUA_ENGINE_CACHE_PER_MODE,
  getScriptingEngineCacheSnapshotForTests,
  resetScriptingEngineCacheForTests,
  runLuaEditTrigger,
  runScripted,
} from './scriptings'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
} from '../server/commands'

import { replaceResourceDatabase } from '../server/resourceState.svelte'
import { selectedCharID } from '../stores.svelte'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

function makeChat(): Chat {
  return {
    id: 'chat-1',
    message: [],
    note: '',
    name: 'main',
    localLore: [],
    scriptstate: {},
  } as unknown as Chat
}

function makeCharacter(chat: Chat): character {
  return {
    chaId: 'char-a',
    name: 'Character',
    desc: '',
    chatPage: 0,
    chats: [chat],
    triggerscript: [],
    defaultVariables: '',
    globalLore: [],
    type: 'character',
  } as unknown as character
}

class FakePythonWorker {
  static instances: FakePythonWorker[] = []
  static onPostMessage: (worker: FakePythonWorker, message: PyWorkerRequest) => void = () => {}

  onmessage: ((event: MessageEvent<PyWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly messages: PyWorkerRequest[] = []
  readonly terminate = vi.fn()

  constructor() {
    FakePythonWorker.instances.push(this)
  }

  postMessage(message: PyWorkerRequest) {
    this.messages.push(message)
    FakePythonWorker.onPostMessage(this, message)
  }

  respond(message: PyWorkerResponse) {
    queueMicrotask(() => {
      this.onmessage?.({ data: message } as MessageEvent<PyWorkerResponse>)
    })
  }

  static reset() {
    FakePythonWorker.instances = []
    FakePythonWorker.onPostMessage = () => {}
  }
}

async function waitForFakePythonWorker(): Promise<FakePythonWorker> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (FakePythonWorker.instances[0]) return FakePythonWorker.instances[0]
    await Promise.resolve()
  }
  throw new Error('Python run did not create a worker')
}

async function waitForPythonRequest(worker: FakePythonWorker, type: PyWorkerRequest['type']): Promise<PyWorkerRequest> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = worker.messages.find((candidate) => candidate.type === type)
    if (message) return message
    await Promise.resolve()
  }
  throw new Error(`Python worker did not receive ${type}`)
}

interface CapturedCommandFetch {
  url: string
  method: string
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubLuaEditTriggerCommandFetch(): CapturedCommandFetch[] {
  const calls: CapturedCommandFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        body,
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/chats/chat-a/messages' && init.method === 'POST') {
        const messageId = (body as { message?: { chatId?: string } } | null)?.message?.chatId
        return jsonResponse({
          revision: 11,
          event: {
            type: 'message.appended',
            revision: 11,
            resource: 'message',
            id: messageId,
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          messageId,
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/scriptstate' && init.method === 'PATCH') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'chat.scriptstate.updated',
            revision: 11,
            resource: 'chat',
            id: 'chat-a',
          },
          chatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/characters/char-a' && init.method === 'PATCH') {
        return jsonResponse({
          revision: 11,
          event: {
            type: 'character.updated',
            revision: 11,
            resource: 'characterRow',
            id: 'char-a',
          },
          characterId: 'char-a',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function seedLuaEditTriggerDatabase(): character {
  selectedCharID.set(0)
  replaceResourceDatabase({
    characters: [
      {
        chaId: 'char-a',
        name: 'Character',
        desc: '',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            message: [{ role: 'user', data: 'original', chatId: 'message-a' }],
            note: '',
            name: 'Chat A',
            localLore: [],
            scriptstate: {},
          },
          {
            id: 'chat-b',
            message: [{ role: 'char', data: 'other chat', chatId: 'message-b' }],
            note: '',
            name: 'Chat B',
            localLore: [],
            scriptstate: {},
          },
        ],
        triggerscript: [
          {
            comment: 'mutate chat from Lua',
            type: 'input',
            conditions: [],
            effect: [{ type: 'triggerlua', code: '-- mutate through host API' }],
          },
        ],
        customscript: [],
        defaultVariables: '',
        globalLore: [],
        type: 'character',
      },
    ],
    characterOrder: [],
    templateDefaultVariables: '',
  } as any)
  return getResourceDatabase().characters[0] as character
}

async function waitForCommandFetches(calls: CapturedCommandFetch[], expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(calls).toHaveLength(expected)
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  resetScriptingEngineCacheForTests()
  luaMock.reset()
  mediaMock.fetchNative.mockReset()
  mediaMock.generateAIImage.mockReset()
  mediaMock.generateAIImage.mockResolvedValue('data:image/png;base64,generated')
  mediaMock.getInlayAsset.mockReset()
  mediaMock.getPersonaPrompt.mockReturnValue('')
  mediaMock.getUserIcon.mockReturnValue('persona.png')
  mediaMock.getUserName.mockReturnValue('User')
  mediaMock.readImage.mockResolvedValue(new Uint8Array([1, 2, 3]))
  mediaMock.writeInlayImage.mockResolvedValue('inlay-id')
  lorebookMock.loadLoreBookV3Prompt.mockResolvedValue({ actives: [] })
  tokenizerMock.tokenize.mockClear()
  requestChatData.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  resetClientSessionForTests()
  resetScriptingEngineCacheForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('client scripting lightweight chat and changed-setter APIs', () => {
  it('exposes scalar chat reads and normalized recent chat JSON', async () => {
    const chat = makeChat()
    chat.message = [
      { role: 'user', data: 'older', time: 12 },
      { role: 'char', data: 'latest' },
    ] as Chat['message']

    await runScripted('-- lightweight chat hosts', {
      char: makeCharacter(chat),
      chat,
      mode: 'start',
    })

    const hostFns = luaMock.engines[0].hostFns
    expect(hostFns.get('getChatData')?.('id', 0)).toBe('older')
    expect(hostFns.get('getChatData')?.('id', 99)).toBe('')
    expect(hostFns.get('getChatRole')?.('id', -1)).toBe('char')
    expect(hostFns.get('getChatRole')?.('id', 99)).toBe('')
    expect(JSON.parse(hostFns.get('getRecentChatsMain')?.('id', 1.9) as string)).toEqual([
      { role: 'char', data: 'latest', time: 0 },
    ])
    expect(luaMock.loadedCodes[0]).toContain('function getRecentChats(id, count)')
    expect(luaMock.loadedCodes[0]).toContain('function setStateChanged(id, name, value)')
  })

  it('keeps legacy setters returnless and reports true only for changed writes', async () => {
    const chat = makeChat()
    const setVar = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    let legacyResult: unknown
    let unchangedResult: unknown
    let changedResult: unknown
    luaMock.setCallListenAction((engine, accessKey) => {
      legacyResult = engine.hostFns.get('setChatVar')?.(accessKey, 'same', 'value')
      unchangedResult = engine.hostFns.get('setChatVarChanged')?.(accessKey, 'same', 'value')
      changedResult = engine.hostFns.get('setChatVarChanged')?.(accessKey, 'new', 'value')
    })

    const result = await runScripted('-- changed setter hosts', {
      char: makeCharacter(chat),
      chat,
      data: 'body',
      mode: 'editDisplay',
      setVar,
    })

    expect(legacyResult).toBeUndefined()
    expect(unchangedResult).toBeUndefined()
    expect(changedResult).toBe(true)
    expect(result.stopSending).toBe(false)
  })
})

describe('client scripting lorebook loading', () => {
  it('uses the scriptMain profile context budget instead of the conflicting chat and flat budgets', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    selectedCharID.set(0)
    replaceResourceDatabase({
      currentChar: 0,
      characters: [char],
      maxContext: 100,
      modelProfiles: [
        {
          id: 'chat-profile',
          name: 'Chat profile',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          runtimeOptions: { maxContext: 100 },
        },
        {
          id: 'script-profile',
          name: 'Script profile',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          runtimeOptions: { maxContext: 2 },
        },
      ],
      modelRoleProfiles: {
        chatMain: { mode: 'profile', profileId: 'chat-profile' },
        scriptMain: { mode: 'profile', profileId: 'script-profile' },
      },
    } as any)
    lorebookMock.loadLoreBookV3Prompt.mockResolvedValueOnce({
      actives: [
        { prompt: 'aa', role: 'system' },
        { prompt: 'bb', role: 'user' },
      ],
    })
    luaMock.setDispatchArgs('loadLoreBooksMain', [0])

    const result = await runScripted('-- script-owned lore budget', {
      char,
      chat,
      mode: 'loadLoreBooksMain',
      lowLevelAccess: true,
    })

    expect(JSON.parse(result.res)).toEqual([{ data: 'aa', role: 'system' }])
    expect(tokenizerMock.tokenize).toHaveBeenCalledTimes(2)
  })

  it('retains the resolver-owned flat maxContext compatibility fallback when no durable script budget exists', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    selectedCharID.set(0)
    replaceResourceDatabase({
      currentChar: 0,
      characters: [char],
      maxContext: 2,
      modelProfiles: [],
      modelRoleProfiles: {},
    } as any)
    lorebookMock.loadLoreBookV3Prompt.mockResolvedValueOnce({
      actives: [{ prompt: 'aa', role: 'system' }],
    })
    luaMock.setDispatchArgs('loadLoreBooksMain', [0])

    const result = await runScripted('-- legacy lore budget', {
      char,
      chat,
      mode: 'loadLoreBooksMain',
      lowLevelAccess: true,
    })

    expect(JSON.parse(result.res)).toEqual([{ data: 'aa', role: 'system' }])
  })
})

describe('client scripting media cleanup', () => {
  it('getPersonaImageMain revokes its object URL when inlay writing fails', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    mediaMock.writeInlayImage.mockRejectedValueOnce(new Error('inlay failed'))
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:persona-image')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      await runScripted('return "api"', {
        char,
        chat,
        mode: 'editDisplay',
        data: 'body',
      })
      const getPersonaImageMain = luaMock.engines[0].hostFns.get('getPersonaImageMain')

      await expect(getPersonaImageMain?.('access-key')).resolves.toBe('')
      expect(mediaMock.readImage).toHaveBeenCalledWith('persona.png')
      expect(mediaMock.writeInlayImage).toHaveBeenCalledTimes(1)
      expect(createUrl).toHaveBeenCalledTimes(1)
      expect(revokeUrl).toHaveBeenCalledWith('blob:persona-image')
    } finally {
      createUrl.mockRestore()
      revokeUrl.mockRestore()
    }
  })
})

describe('client scripting Lua budgets and cache', () => {
  it('uses the current script owner profile overrides with a cached Lua engine', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    char.scriptModelOverrides = { llmProfileId: 'character-main' }
    luaMock.setDispatchArgs('LLMMain', [JSON.stringify([{ role: 'user', content: 'prompt' }]), false, ''])
    const code = '-- cached owner-aware LLM handler'

    await runScripted(code, { char, chat, mode: 'LLMMain', lowLevelAccess: true })
    await runScripted(code, {
      char,
      chat,
      mode: 'LLMMain',
      lowLevelAccess: true,
      scriptModelOverrides: { llmProfileId: 'module-main' },
    })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(requestChatData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profileIdOverride: 'character-main', strictProfileIdOverride: true }),
      'scriptMain',
    )
    expect(requestChatData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ profileIdOverride: 'module-main', strictProfileIdOverride: true }),
      'scriptMain',
    )
  })

  it('uses the axLLM override for scriptAux calls', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    luaMock.setDispatchArgs('axLLMMain', [JSON.stringify([{ role: 'user', content: 'prompt' }]), false, ''])

    await runScripted('-- owner-aware axLLM handler', {
      char,
      chat,
      mode: 'axLLMMain',
      lowLevelAccess: true,
      scriptModelOverrides: { axLlmProfileId: 'module-aux' },
    })

    expect(requestChatData).toHaveBeenCalledWith(
      expect.objectContaining({ profileIdOverride: 'module-aux', strictProfileIdOverride: true }),
      'scriptAux',
    )
  })

  it('keeps readonly character trigger rows immutable before Lua edit-display dispatch', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    const trigger = Object.freeze({
      comment: 'readonly lua trigger',
      type: 'display',
      conditions: [],
      effect: [{ type: 'triggerlua', code: 'return "display"' }],
    })
    char.triggerscript = [trigger as unknown as character['triggerscript'][number]]

    await expect(runLuaEditTrigger(char, 'editdisplay', 'body')).resolves.toBe('body')

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect('lowLevelAccess' in trigger).toBe(false)
  })

  it('runs simple character trigger rows for first-message edit-display parity', async () => {
    const trigger = Object.freeze({
      comment: 'simple lua trigger',
      type: 'display',
      conditions: [],
      effect: [{ type: 'triggerlua', code: '-- simple display hook' }],
    })
    const char = {
      type: 'simple',
      chaId: 'simple-char',
      customscript: [],
      triggerscript: [trigger],
    } as any

    await expect(runLuaEditTrigger(char, 'editdisplay', 'first message')).resolves.toBe('first message')

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(luaMock.loadedCodes[0]).toContain('-- simple display hook')
    expect('lowLevelAccess' in trigger).toBe(false)
  })

  it('falls back to original edit-display content when Lua dispatch fails', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    char.triggerscript = [
      {
        comment: 'display-fallback',
        type: 'display',
        conditions: [],
        effect: [{ type: 'triggerlua', code: 'return "display"' }],
      },
    ] as character['triggerscript']
    luaMock.setRejectDispatch(true)

    await expect(runLuaEditTrigger(char, 'editdisplay', 'visible body')).resolves.toBe('visible body')

    expect(console.error).toHaveBeenCalledWith('Lua edit trigger failed in editDisplay:', expect.any(Error))
    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes.editDisplay).toBe(0)
  })

  it('client Lua while true loads through the timeout-bound thread', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)

    await expect(
      runScripted('while true do end', {
        char,
        chat,
        mode: 'editDisplay',
        data: 'body',
        luaExecTimeoutMs: 25,
      }),
    ).rejects.toThrow(/timeout/)

    expect(luaMock.createEngine).toHaveBeenCalledWith(
      expect.objectContaining({ injectObjects: true, functionTimeout: 25 }),
    )
    expect(luaMock.runTimeouts).toContain(25)
  })

  it('evicts a Lua engine whose wrapper load times out before retrying identical code', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    const code = '-- retry after timeout'
    luaMock.failNextRun(new Error('thread timeout exceeded'))

    await expect(
      runScripted(code, {
        char,
        chat,
        mode: 'editDisplay',
        data: 'first',
        luaExecTimeoutMs: 25,
      }),
    ).rejects.toThrow(/timeout/)

    expect(luaMock.closedEngineIds).toEqual([0])
    expect(getScriptingEngineCacheSnapshotForTests().keys).not.toContainEqual(
      expect.stringMatching(/^lua:editDisplay:/),
    )

    await expect(
      runScripted(code, {
        char,
        chat,
        mode: 'editDisplay',
        data: 'second',
        luaExecTimeoutMs: 25,
      }),
    ).resolves.toEqual(expect.objectContaining({ res: 'second' }))

    expect(luaMock.createEngine).toHaveBeenCalledTimes(2)
    expect(luaMock.engines[1].closed).toBe(false)
  })

  it('does not cache a Lua state whose engine creation fails', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    const code = '-- retry engine creation'
    luaMock.createEngine.mockRejectedValueOnce(new Error('engine init failed'))

    await expect(runScripted(code, { char, chat, mode: 'start' })).rejects.toThrow('engine init failed')
    expect(getScriptingEngineCacheSnapshotForTests().keys).not.toContainEqual(expect.stringMatching(/^lua:start:/))

    await expect(runScripted(code, { char, chat, mode: 'start' })).resolves.toBeDefined()
    expect(luaMock.createEngine).toHaveBeenCalledTimes(2)
  })

  it('same-mode Lua code hash cache reuses alternating bodies and evicts by LRU', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)

    await runScripted('return "A"', { char, chat, mode: 'editDisplay', data: 'a' })
    await runScripted('return "B"', { char, chat, mode: 'editDisplay', data: 'b' })
    await runScripted('return "A"', { char, chat, mode: 'editDisplay', data: 'a2' })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(2)
    expect(luaMock.closedEngineIds).toEqual([])

    for (let index = 0; index <= CLIENT_LUA_ENGINE_CACHE_PER_MODE; index++) {
      await runScripted(`return "cap-${index}"`, {
        char,
        chat,
        mode: 'boundedMode',
        data: `cap-${index}`,
      })
    }

    const boundedKeys = getScriptingEngineCacheSnapshotForTests().keys.filter((key) =>
      key.startsWith('lua:boundedMode:'),
    )
    expect(boundedKeys).toHaveLength(CLIENT_LUA_ENGINE_CACHE_PER_MODE)
    expect(luaMock.closedEngineIds.length).toBeGreaterThan(0)
  })

  it('memoizes Lua code hashes before looking up cached engines', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const code = `return "${'same lua source '.repeat(1_000)}"`

    await runScripted(code, { char, chat, mode: 'editDisplay', data: 'first' })
    await runScripted(code, { char, chat, mode: 'editDisplay', data: 'second' })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(digestSpy).toHaveBeenCalledTimes(1)
  })

  it('uses the current run stop handler when a cached engine calls stopChat', async () => {
    const firstChat = makeChat()
    const secondChat = makeChat()
    const code = '-- cached stopChat handler'

    const first = await runScripted(code, {
      char: makeCharacter(firstChat),
      chat: firstChat,
      mode: 'stopChat',
    })
    const second = await runScripted(code, {
      char: makeCharacter(secondChat),
      chat: secondChat,
      mode: 'stopChat',
    })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(first.stopSending).toBe(true)
    expect(second.stopSending).toBe(true)
  })

  it('uses the current run character when a cached engine generates an image', async () => {
    const firstChat = makeChat()
    const secondChat = makeChat()
    const firstCharacter = makeCharacter(firstChat)
    const secondCharacter = makeCharacter(secondChat)
    firstCharacter.chaId = 'char-first'
    secondCharacter.chaId = 'char-second'
    luaMock.setDispatchArgs('generateImage', ['portrait', 'negative'])
    const code = '-- cached generateImage handler'

    await runScripted(code, {
      char: firstCharacter,
      chat: firstChat,
      mode: 'generateImage',
      lowLevelAccess: true,
    })
    await runScripted(code, {
      char: secondCharacter,
      chat: secondChat,
      mode: 'generateImage',
      lowLevelAccess: true,
    })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(mediaMock.generateAIImage).toHaveBeenNthCalledWith(1, 'portrait', firstCharacter, 'negative', 'inlay')
    expect(mediaMock.generateAIImage).toHaveBeenNthCalledWith(2, 'portrait', secondCharacter, 'negative', 'inlay')
  })

  it('uses the current run character when a cached engine upserts local lore', async () => {
    const firstChat = makeChat()
    const secondChat = makeChat()
    const firstCharacter = makeCharacter(firstChat)
    const secondCharacter = makeCharacter(secondChat)
    firstCharacter.chaId = 'char-first'
    secondCharacter.chaId = 'char-second'
    luaMock.setDispatchArgs('upsertLocalLoreBook', ['run lore', 'current character', {}])
    const code = '-- cached upsertLocalLoreBook handler'

    await runScripted(code, { char: firstCharacter, chat: firstChat, mode: 'upsertLocalLoreBook' })
    await runScripted(code, { char: secondCharacter, chat: secondChat, mode: 'upsertLocalLoreBook' })

    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
    expect(firstChat.localLore).toHaveLength(1)
    expect(secondChat.localLore).toHaveLength(1)
    expect(secondChat.localLore[0]).toEqual(
      expect.objectContaining({
        comment: 'run lore',
        content: 'current character',
      }),
    )
  })

  it('editDisplay access key is removed after Lua success and rejection', async () => {
    const chat = makeChat()
    const char = makeCharacter(chat)
    const setVar = vi.fn()

    await runScripted('return "display"', {
      char,
      chat,
      mode: 'editDisplay',
      data: 'body',
      setVar,
    })

    const accessKey = luaMock.lastAccessKey
    const setChatVar = luaMock.engines[0].hostFns.get('setChatVar')
    setChatVar?.(accessKey, 'chat-1', 'leaked')

    expect(setVar).not.toHaveBeenCalled()
    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes.editDisplay).toBe(0)

    luaMock.setRejectDispatch(true)
    await expect(
      runScripted('return "reject"', {
        char,
        chat,
        mode: 'editDisplay',
        data: 'body',
        setVar,
      }),
    ).rejects.toThrow('lua dispatch failed')

    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes.editDisplay).toBe(0)
  })
})

describe('Fastify Lua edit-trigger chat mutation', () => {
  beforeEach(() => {
    clearAppliedServerResourceRevision()
    clearCachedServerCommandRevision()
    setServerCommandSuccessReconciler(null)
  })

  afterEach(() => {
    selectedCharID.set(-1)
    clearAppliedServerResourceRevision()
    clearCachedServerCommandRevision()
    setServerCommandSuccessReconciler(null)
  })

  it('applies a Lua host chat mutation through the scoped message command', async () => {
    const calls = stubLuaEditTriggerCommandFetch()
    const char = seedLuaEditTriggerDatabase()
    luaMock.setCallListenAction((engine, accessKey) => {
      engine.hostFns.get('addChat')?.(accessKey, 'char', 'from Lua')
    })

    await expect(runLuaEditTrigger(char, 'editinput', 'draft')).resolves.toBe('draft')

    expect(getResourceDatabase().characters[0].chats[0].message).toEqual([
      expect.objectContaining({ role: 'user', data: 'original', chatId: 'message-a' }),
      expect.objectContaining({ role: 'char', data: 'from Lua', chatId: expect.any(String) }),
    ])
    await waitForCommandFetches(calls, 2)
    expect(calls).toEqual([
      expect.objectContaining({ url: '/api/v1/bootstrap', method: 'GET' }),
      expect.objectContaining({
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'POST',
        body: {
          baseRevision: 10,
          message: expect.objectContaining({ role: 'char', data: 'from Lua', chatId: expect.any(String) }),
        },
      }),
    ])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('discards detached Lua chat changes when the active chat changes during the trigger', async () => {
    const calls = stubLuaEditTriggerCommandFetch()
    const char = seedLuaEditTriggerDatabase()
    luaMock.setCallListenAction((engine, accessKey) => {
      engine.hostFns.get('addChat')?.(accessKey, 'char', 'stale Lua mutation')
      withTestDatabaseWrite(() => {
        getResourceDatabase().characters[0].chatPage = 1
      })
    })

    await expect(runLuaEditTrigger(char, 'editinput', 'draft')).resolves.toBe('draft')
    await Promise.resolve()

    expect(getResourceDatabase().characters[0].chats[0].message).toEqual([
      expect.objectContaining({ role: 'user', data: 'original', chatId: 'message-a' }),
    ])
    expect(getResourceDatabase().characters[0].chats[1].message).toEqual([
      expect.objectContaining({ role: 'char', data: 'other chat', chatId: 'message-b' }),
    ])
    expect(calls).toHaveLength(0)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('persists Lua edit-display chat variables through the scriptstate command', async () => {
    const calls = stubLuaEditTriggerCommandFetch()
    const char = seedLuaEditTriggerDatabase()
    luaMock.setCallListenAction((engine, accessKey) => {
      engine.hostFns.get('setChatVar')?.(accessKey, 'choice', 'updated')
    })

    await expect(runLuaEditTrigger(char, 'editdisplay', 'draft')).resolves.toBe('draft')

    expect(getResourceDatabase().characters[0].chats[0].scriptstate).toEqual({ $choice: 'updated' })
    await waitForCommandFetches(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/chats/chat-a/scriptstate',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { $choice: 'updated' },
        deleteKeys: [],
      },
    })
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('client scripting description host API', () => {
  beforeEach(() => {
    clearAppliedServerResourceRevision()
    clearCachedServerCommandRevision()
    setServerCommandSuccessReconciler(null)
  })

  afterEach(() => {
    selectedCharID.set(-1)
    clearAppliedServerResourceRevision()
    clearCachedServerCommandRevision()
    setServerCommandSuccessReconciler(null)
  })

  it('accepts a string description when the outer scripting data is not a string', async () => {
    const calls = stubLuaEditTriggerCommandFetch()
    const char = seedLuaEditTriggerDatabase()
    luaMock.setDispatchArgs('setDescription', ['Updated description'])

    await expect(
      runScripted('-- set a valid description', {
        char,
        chat: char.chats[0],
        mode: 'setDescription',
        data: [],
      }),
    ).resolves.toBeDefined()

    expect(getResourceDatabase().characters[0].desc).toBe('Updated description')
    await waitForCommandFetches(calls, 2)
    expect(calls[1]).toEqual({
      url: '/api/v1/commands/characters/char-a',
      method: 'PATCH',
      body: {
        baseRevision: 10,
        patch: { desc: 'Updated description' },
      },
    })
  })

  it('rejects a non-string description even when the outer scripting data is a string', async () => {
    const calls = stubLuaEditTriggerCommandFetch()
    const char = seedLuaEditTriggerDatabase()
    luaMock.setDispatchArgs('setDescription', [42])

    await expect(
      runScripted('-- reject an invalid description', {
        char,
        chat: char.chats[0],
        mode: 'setDescription',
        data: 'outer data is valid',
      }),
    ).rejects.toBe('Invalid data type')

    expect(getResourceDatabase().characters[0].desc).toBe('')
    expect(calls).toHaveLength(0)
  })
})

describe('client Python worker protocol', () => {
  beforeEach(() => {
    FakePythonWorker.reset()
    vi.stubGlobal('Worker', FakePythonWorker)
  })

  it('multiplexes init and a successful structured Python call through one dispatcher', async () => {
    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: { version: 'test' } })
      } else if (message.type === 'python') {
        worker.respond({ type: 'result', id: message.id, result: message.args[2] })
      }
    }
    const chat = makeChat()
    const char = makeCharacter(chat)

    const result = await runScripted('def callListenMain(*args): return args[2]', {
      char,
      chat,
      mode: 'editDisplay',
      type: 'py',
      data: 'body',
    })

    expect(result.res).toBe('body')
    const worker = FakePythonWorker.instances[0]
    expect(worker.messages.filter((message) => message.type === 'init')).toHaveLength(1)
    expect(worker.messages.find((message) => message.type === 'python')).toEqual(
      expect.objectContaining({
        type: 'python',
        method: 'callListenMain',
        args: ['editDisplay', expect.any(String), JSON.stringify('body'), JSON.stringify({})],
      }),
    )
  })

  it('resolves synchronous host APIs called while a Python request is pending', async () => {
    let pythonRequest: Extract<PyWorkerRequest, { type: 'python' }> | undefined
    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: null })
      } else if (message.type === 'python') {
        pythonRequest = message
        worker.respond({
          type: 'call',
          callId: 'sync-host-call',
          method: 'getChatLength',
          args: [message.args[0]],
        })
      } else if (message.type === 'functionResult' && pythonRequest) {
        worker.respond({ type: 'result', id: pythonRequest.id, result: message.result })
      }
    }
    const chat = makeChat()
    chat.message = [
      { role: 'user', data: 'one' },
      { role: 'char', data: 'two' },
    ] as Chat['message']

    const result = await runScripted('def getChatLength(*args): return getChatLength(*args)', {
      char: makeCharacter(chat),
      chat,
      mode: 'getChatLength',
      type: 'py',
    })

    expect(result.res).toBe(2)
    expect(FakePythonWorker.instances[0].messages).toContainEqual({
      type: 'functionResult',
      callId: 'sync-host-call',
      result: 2,
    })
  })

  it('returns host API failures to Python and rejects the pending run', async () => {
    let pythonRequest: Extract<PyWorkerRequest, { type: 'python' }> | undefined
    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: null })
      } else if (message.type === 'python') {
        pythonRequest = message
        worker.respond({
          type: 'call',
          callId: 'failed-host-call',
          method: 'getChatVar',
          args: [message.args[0], 'broken'],
        })
      } else if (message.type === 'functionError' && pythonRequest) {
        worker.respond({ type: 'error', id: pythonRequest.id, error: message.error })
      }
    }
    const chat = makeChat()

    await expect(
      runScripted('def hostFailure(*args): return getChatVar(*args)', {
        char: makeCharacter(chat),
        chat,
        mode: 'hostFailure',
        type: 'py',
        getVar: () => {
          throw new Error('host API failed')
        },
      }),
    ).rejects.toThrow('host API failed')

    expect(FakePythonWorker.instances[0].messages).toContainEqual({
      type: 'functionError',
      callId: 'failed-host-call',
      error: 'host API failed',
    })
    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes.safe).toBe(0)
  })

  it('rejects pending Python work when its cached context is terminated', async () => {
    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: null })
      }
    }
    const chat = makeChat()
    const run = runScripted('def pendingRun(*args): return None', {
      char: makeCharacter(chat),
      chat,
      mode: 'pendingRun',
      type: 'py',
    })
    const rejection = expect(run).rejects.toThrow('Python scripting worker is terminated.')
    const worker = await waitForFakePythonWorker()
    await waitForPythonRequest(worker, 'python')

    resetScriptingEngineCacheForTests()

    await rejection
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('times out Python initialization and recreates a clean context for identical code', async () => {
    vi.useFakeTimers()
    const chat = makeChat()
    const char = makeCharacter(chat)
    const code = 'def start(*args): return "ready"'
    const firstRun = runScripted(code, {
      char,
      chat,
      mode: 'start',
      type: 'py',
      pythonExecTimeoutMs: 25,
      pythonInitTimeoutMs: 25,
    })
    const firstRejection = expect(firstRun).rejects.toThrow('Python scripting worker timed out after 25ms.')
    const firstWorker = await waitForFakePythonWorker()
    await waitForPythonRequest(firstWorker, 'init')

    await vi.advanceTimersByTimeAsync(25)
    await firstRejection

    expect(firstWorker.terminate).toHaveBeenCalledOnce()
    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes.safe).toBe(0)

    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: null })
      } else if (message.type === 'python') {
        worker.respond({ type: 'result', id: message.id, result: 'ready' })
      }
    }
    await expect(
      runScripted(code, {
        char,
        chat,
        mode: 'start',
        type: 'py',
        pythonExecTimeoutMs: 25,
        pythonInitTimeoutMs: 25,
      }),
    ).resolves.toEqual(expect.objectContaining({ res: 'ready' }))

    expect(FakePythonWorker.instances).toHaveLength(2)
  })

  it('times out a Python call, terminates its worker, and cleans the run access key', async () => {
    vi.useFakeTimers()
    FakePythonWorker.onPostMessage = (worker, message) => {
      if (message.type === 'init') {
        worker.respond({ type: 'result', id: message.id, result: null })
      }
    }
    const chat = makeChat()
    const run = runScripted('def pendingCall(*args): return None', {
      char: makeCharacter(chat),
      chat,
      mode: 'pendingCall',
      type: 'py',
      pythonExecTimeoutMs: 40,
    })
    const rejection = expect(run).rejects.toThrow('Python scripting worker timed out after 40ms.')
    const worker = await waitForFakePythonWorker()
    await waitForPythonRequest(worker, 'python')

    await vi.advanceTimersByTimeAsync(40)
    await rejection

    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(getScriptingEngineCacheSnapshotForTests().accessSetSizes).toEqual({
      safe: 0,
      editDisplay: 0,
      lowLevel: 0,
    })

    FakePythonWorker.onPostMessage = (retryWorker, message) => {
      if (message.type === 'init') {
        retryWorker.respond({ type: 'result', id: message.id, result: null })
      } else if (message.type === 'python') {
        retryWorker.respond({ type: 'result', id: message.id, result: 'recovered' })
      }
    }
    await expect(
      runScripted('def pendingCall(*args): return None', {
        char: makeCharacter(chat),
        chat,
        mode: 'pendingCall',
        type: 'py',
        pythonExecTimeoutMs: 40,
      }),
    ).resolves.toEqual(expect.objectContaining({ res: 'recovered' }))
    expect(FakePythonWorker.instances).toHaveLength(2)
  })
})

function enterScriptWriter(epoch = 1): void {
  const operation = beginClientSession('script-writer')
  authorizeClientWriterRecovery(operation, {
    databaseLineage: 'lineage',
    writer: { sessionId: 'script-writer', epoch },
  })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  completeClientWriterRecovery(operation)
}

describe('connected Lua/Python host authority', () => {
  it('does not create a scripting engine for a reader', async () => {
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    await expect(runScripted('source', { char: makeCharacter(makeChat()), mode: 'editDisplay' })).rejects.toThrow(
      'client_write_access_required',
    )
    expect(luaMock.createEngine).not.toHaveBeenCalled()
  })
  it('blocks a held Lua host setter after demotion and reacquisition', async () => {
    enterScriptWriter()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    const setVar = vi.fn()
    luaMock.setCallListenAction(async (engine, key) => {
      entered = true
      await held
      engine.hostFns.get('setChatVar')(key, 'late', 'changed')
    })
    const chat = makeChat()
    const run = runScripted('source', { char: makeCharacter(chat), chat, setVar, mode: 'editDisplay' })
    await vi.waitFor(() => expect(entered).toBe(true))
    demoteClientSession()
    enterScriptWriter(2)
    release()
    await expect(run).rejects.toThrow('client_write_operation_stale')
    expect(setVar).not.toHaveBeenCalled()
  })
  it('stops an awaited image-generation API before an inlay write after role loss', async () => {
    enterScriptWriter()
    let release!: (value: string) => void
    mediaMock.generateAIImage.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve
      }),
    )
    luaMock.setDispatchArgs('generateImage', ['prompt', 'negative'])
    const chat = makeChat()
    const run = runScripted('source', { char: makeCharacter(chat), chat, mode: 'generateImage', lowLevelAccess: true })
    await vi.waitFor(() => expect(mediaMock.generateAIImage).toHaveBeenCalled())
    demoteClientSession()
    enterScriptWriter(2)
    release('data:image/png;base64,AA==')
    await expect(run).rejects.toThrow('client_write_operation_stale')
    expect(mediaMock.writeInlayImage).not.toHaveBeenCalled()
  })
  it('lets a fresh writer reuse a cached engine with a fresh host operation', async () => {
    enterScriptWriter()
    const setVar = vi.fn()
    luaMock.setCallListenAction((engine, key) => {
      engine.hostFns.get('setChatVar')(key, 'current', 'ok')
    })
    const chat = makeChat()
    const args = { char: makeCharacter(chat), chat, setVar, mode: 'editDisplay' }
    await runScripted('reusable source', args)
    demoteClientSession()
    enterScriptWriter(2)
    await runScripted('reusable source', args)
    expect(setVar).toHaveBeenCalledTimes(2)
    expect(luaMock.createEngine).toHaveBeenCalledTimes(1)
  })
})

it('terminates a running Python worker when its writer loses access', async () => {
  enterScriptWriter()
  FakePythonWorker.reset()
  vi.stubGlobal('Worker', FakePythonWorker)
  FakePythonWorker.onPostMessage = (worker, message) => {
    if (message.type === 'init') worker.respond({ type: 'result', id: message.id, result: null })
  }
  const run = runScripted('def pendingRun(*args): return None', {
    char: makeCharacter(makeChat()),
    mode: 'pendingRun',
    type: 'py',
  })
  const rejected = expect(run).rejects.toThrow('client_write_access_required')
  const worker = await waitForFakePythonWorker()
  await waitForPythonRequest(worker, 'python')
  demoteClientSession()
  expect(worker.terminate).toHaveBeenCalledOnce()
  await rejected
})
