import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyLoreBook as loreBook,
} from '../src/prompt/serverTypes.js'
import type { PromptMessage } from '../src/prompt/promptMessage.js'
import type { ServerModule as RisuModule } from '../src/prompt/moduleDescriptors.js'
import { createTriggerVarEngine, type TriggerVarEngine } from '../src/prompt/triggerVars.js'
import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import { openDatabase } from '../src/db.js'
import { assetPath, getAssetMetadataById, listInlayCatalogEntries } from '../src/repository.js'
import { createRequestHistoryTable, listRequestHistory } from '../src/requestHistory.js'
import {
  createLuaExecBudget,
  isBlockedAddress,
  readLuaEngineAcquireStats,
  runLuaEditTrigger,
  runServerLua,
  serverLuaRequest,
  settleLuaEnginePool,
  validateEgressUrl,
  type EgressDeps,
  type RequestRateState,
  type ServerLuaRuntimeContext,
} from '../src/prompt/luaRuntime.js'

/**
 * Server Lua runtime proof suite: prompt rewrites, var writes, request safety,
 * execution limits, and explicit failures for interactive APIs.
 */

beforeAll(() => {
  bootPromptVariables()
})

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    message: [],
    note: '',
    name: 'main',
    localLore: [],
    scriptstate: {},
    fmIndex: -1,
    ...overrides,
  } as unknown as Chat
}

function makeChar(overrides: Partial<character> = {}): character {
  return {
    type: 'character',
    name: 'Tess',
    desc: 'A friendly assistant.',
    firstMessage: 'Hi there.',
    chaId: 'char-tess',
    triggerscript: [],
    chats: [{ message: [], scriptstate: {} }],
    chatPage: 0,
    ...overrides,
  } as unknown as character
}

function lore(overrides: Partial<loreBook> = {}): loreBook {
  return {
    key: '',
    secondkey: '',
    insertorder: 100,
    comment: 'preset',
    content: '',
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    ...overrides,
  } as loreBook
}

function makeModule(overrides: Partial<RisuModule> = {}): RisuModule {
  return {
    name: 'mod',
    description: '',
    id: 'mod-1',
    ...overrides,
  } as RisuModule
}

function makeDb(overrides: Partial<Database> = {}): Database {
  return {
    characters: [],
    templateDefaultVariables: '',
    currentChar: 0,
    username: 'Operator',
    globalChatVariables: {},
    aiModel: 'echo_model',
    subModel: 'echo_model',
    echoMessage: 'echo',
    echoDelay: 0,
    maxResponse: 200,
    temperature: 50,
    useStreaming: false,
    ...overrides,
  } as unknown as Database
}

/**
 * Build a runtime context whose chat / db / var engine are wired together the way
 * the assembler wires them (the var engine and the chat share a reference, and the
 * char's chat[0] is the same persisted chat).
 */
function makeRuntime(
  opts: {
    chat?: Chat
    char?: character
    model?: string
    database?: Partial<Database>
    egress?: EgressDeps
    rateState?: RequestRateState
    scriptstate?: Record<string, string | number | boolean>
  } = {},
): { ctx: ServerLuaRuntimeContext; engine: TriggerVarEngine } {
  const chat = opts.chat ?? makeChat({ scriptstate: { ...(opts.scriptstate ?? {}) } })
  const char = opts.char ?? makeChar({ chats: [chat] })
  const database = makeDb({ characters: [char], ...opts.database })
  const engine = createTriggerVarEngine({
    chat,
    database,
    selectedCharID: 0,
    chatPage: 0,
    defaultVariables: [],
  })
  const ctx: ServerLuaRuntimeContext = {
    chat,
    database,
    selectedCharID: 0,
    chatPage: 0,
    varEngine: engine,
    char,
    model: opts.model,
    egress: opts.egress,
    rateState: opts.rateState,
  }
  return { ctx, engine }
}

function rows(...contents: string[]): PromptMessage[] {
  return contents.map((content) => ({ role: 'user', content }) as PromptMessage)
}

// A short exec limit keeps the runaway tests fast.
const SHORT_LIMIT = 300

describe('server Lua runtime — pure edit-hook dispatch', () => {
  it('runs a pure editRequest handler that rewrites a row (prelude + dispatch + JSON round-trip)', async () => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[#data].content = data[#data].content .. ' [' .. meta.tag .. ']'
        return data
      end)
    `
    const result = await runServerLua(
      { code, mode: 'editRequest', data: rows('alpha', 'omega'), meta: { tag: 'EDIT' } },
      ctx,
    )

    expect(result.error).toBeUndefined()
    expect(result.timedOut).toBe(false)
    const out = result.res as PromptMessage[]
    expect(out).toHaveLength(2)
    expect(out[0].content).toBe('alpha')
    expect(out[1].content).toBe('omega [EDIT]')
    expect(out[1].role).toBe('user')
  })

  it('binds setChatVar / setState to the assembler var engine (mutations land in scriptstate)', async () => {
    const { ctx, engine } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        setChatVar(id, 'mood', 'curious')
        setState(id, 'turns', 7)
        return data
      end)
    `
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('x') }, ctx)

    expect(result.error).toBeUndefined()
    expect(engine.getVar('mood')).toBe('curious')
    // setState JSON-encodes under the `__`-prefixed key.
    expect(engine.getVar('__turns')).toBe('7')
    expect(engine.varChanged).toBe(true)
  })

  it('returns lightweight chat fields and a bounded recent-chat array', async () => {
    const chat = makeChat({
      message: [
        { role: 'user', data: 'older', time: 41 },
        { role: 'char', data: 'latest' },
      ] as Chat['message'],
    })
    const { ctx } = makeRuntime({ chat })
    const code = `
      function onStart(id)
        return json.encode({
          firstData = getChatData(id, 0),
          lastRole = getChatRole(id, -1),
          missingData = getChatData(id, 99),
          missingRole = getChatRole(id, 99),
          recent = getRecentChats(id, 1.9)
        })
      end
    `

    const result = await runServerLua({ code, mode: 'start' }, ctx)

    expect(result.error).toBeUndefined()
    expect(JSON.parse(result.res as string)).toEqual({
      firstData: 'older',
      lastRole: 'char',
      missingData: '',
      missingRole: '',
      recent: [{ role: 'char', data: 'latest', time: 0 }],
    })
  })

  it('keeps unchanged setters nil and does not mark state changed or stop generation', async () => {
    const { ctx, engine } = makeRuntime({
      scriptstate: { $same: 'value', $__sameState: '"value"' },
    })
    const code = `
      function onStart(id)
        local chatResult = setChatVar(id, 'same', 'value')
        local stateResult = setState(id, 'sameState', 'value')
        local changedResult = setStateChanged(id, 'sameState', 'value')
        return type(chatResult) .. '|' .. type(stateResult) .. '|' .. type(changedResult)
      end
    `

    const result = await runServerLua({ code, mode: 'start' }, ctx)

    expect(result.res).toBe('nil|nil|nil')
    expect(result.stopSending).toBe(false)
    expect(engine.varChanged).toBe(false)
  })

  it('returns true only when the changed setter variants write a new value', async () => {
    const { ctx, engine } = makeRuntime()
    const code = `
      function onStart(id)
        local chatChanged = setChatVarChanged(id, 'mood', 'curious')
        local stateChanged = setStateChanged(id, 'turns', 7)
        return tostring(chatChanged) .. '|' .. tostring(stateChanged)
      end
    `

    const result = await runServerLua({ code, mode: 'start' }, ctx)

    expect(result.res).toBe('true|true')
    expect(result.stopSending).toBe(false)
    expect(engine.getVar('mood')).toBe('curious')
    expect(engine.getVar('__turns')).toBe('7')
    expect(engine.varChanged).toBe(true)
  })

  it('gates setChatVar by access key — a forged id cannot write', async () => {
    const { ctx, engine } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        setChatVar('forged-key', 'mood', 'leaked')
        return data
      end)
    `
    await runServerLua({ code, mode: 'editRequest', data: rows('x') }, ctx)
    expect(engine.getVar('mood')).toBe('null')
    expect(engine.varChanged).toBe(false)
  })
})

describe('server Lua runtime — character ownership', () => {
  it.each(['character', undefined, null])('preserves character reads and writes with legacy type %j', async (type) => {
    const char = makeChar()
    // Legacy fixtures can retain a null/missing tag at this runtime boundary.
    Object.assign(char, { type })
    const { ctx } = makeRuntime({ char })
    const result = await runServerLua(
      {
        code: `function onStart(id)
          local before = getName(id)
          setName(id, 'Renamed')
          return before .. '|' .. getName(id) .. '|' .. getCharacterFirstMessage(id)
        end`,
        mode: 'start',
      },
      ctx,
    )
    expect(result.error).toBeUndefined()
    expect(result.res).toBe('Tess|Renamed|Hi there.')
    expect(char.name).toBe('Renamed')
    expect(char.type).toBe(type)
  })

  it('does not grant character getters or setters to a simple edit owner', async () => {
    const { ctx } = makeRuntime()
    const simple = { type: 'simple' as const, chaId: 'simple-owner', name: 'Hidden' }
    ctx.char = simple
    const result = await runServerLua(
      {
        code: `function onStart(id)
          setName(id, 'Renamed')
          return getName(id) .. '|' .. getCharacterFirstMessage(id)
        end`,
        mode: 'start',
      },
      ctx,
    )
    expect(result.error).toBeUndefined()
    expect(result.res).toBe('|')
    expect(simple.name).toBe('Hidden')
  })
})

describe('server Lua runtime — complete chat replacement contract', () => {
  it('keeps only role/data and cannot introduce new speaker identities through setFullChat', async () => {
    const { ctx } = makeRuntime({
      chat: makeChat({ message: [{ role: 'char', data: 'before', saying: 'existing', name: 'Existing' }] }),
    })
    const result = await runServerLua(
      {
        code: `
      listenEdit('editRequest', function(id, data, meta)
        setFullChat(id, {
          {role='char',data='replacement',saying='new-sibling',name='Injected name',future='extension'},
          {role='user',data='question',saying='another-sibling'},
        })
        return data
      end)
    `,
        mode: 'editRequest',
        data: rows('request'),
      },
      ctx,
    )
    expect(result.error).toBeUndefined()
    expect(ctx.chat.message).toEqual([
      { role: 'char', data: 'replacement' },
      { role: 'user', data: 'question' },
    ])
  })

  it('rejects non-text complete chat replacements before mutating the working history', async () => {
    const { ctx } = makeRuntime({ chat: makeChat({ message: [{ role: 'char', data: 'before' }] }) })
    const before = structuredClone(ctx.chat.message)
    const result = await runServerLua(
      {
        code: `
      listenEdit('editRequest', function(id, data, meta)
        setFullChat(id, {{role='char',data=42}})
        return data
      end)
    `,
        mode: 'editRequest',
        data: rows('request'),
      },
      ctx,
    )
    expect(result.error).toContain('setFullChat expects text message records')
    expect(ctx.chat.message).toEqual(before)
  })
})

describe('server Lua runtime — request() egress guard (SSRF)', () => {
  it('classifies private / loopback / link-local / metadata / ULA addresses as blocked', () => {
    for (const blocked of [
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.5',
      '172.16.9.9',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '::1',
      'fe80::1',
      'fd00::1',
      'fc00::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(blocked)).toBe(true)
    }
    for (const allowed of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(allowed)).toBe(false)
    }
  })

  it('blocks embedded-private IPv6 transition forms (mapped-hex / compatible / 6to4 / NAT64)', () => {
    for (const blocked of [
      '::ffff:7f00:1', // IPv4-mapped loopback, hex form (dotted form was already unwrapped)
      '::ffff:a9fe:a9fe', // IPv4-mapped metadata IP, hex form
      '::7f00:1', // IPv4-compatible loopback
      '::127.0.0.1', // IPv4-compatible loopback, dotted form
      '::a00:1', // IPv4-compatible 10.0.0.1
      '2002:7f00:1::', // 6to4 embedding 127.0.0.1
      '2002:a9fe:a9fe::', // 6to4 embedding 169.254.169.254 (metadata)
      '2002:c0a8:101::', // 6to4 embedding 192.168.1.1
      '64:ff9b::7f00:1', // NAT64 embedding 127.0.0.1
      '64:ff9b::127.0.0.1', // NAT64, dotted form
      '64:ff9b::a9fe:a9fe', // NAT64 embedding the metadata IP
    ]) {
      expect(isBlockedAddress(blocked), `${blocked} should be blocked`).toBe(true)
    }
    // Transition forms of PUBLIC addresses stay reachable.
    for (const allowed of [
      '::ffff:808:808', // IPv4-mapped 8.8.8.8, hex form
      '2002:808:808::', // 6to4 of 8.8.8.8
      '64:ff9b::808:808', // NAT64 of 8.8.8.8
    ]) {
      expect(isBlockedAddress(allowed), `${allowed} should be allowed`).toBe(false)
    }
  })

  it('rejects non-https URLs', async () => {
    const verdict = await validateEgressUrl('http://example.com/')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.status).toBe(400)
  })

  it('rejects URLs longer than 120 characters', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(120)
    const verdict = await validateEgressUrl(longUrl)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.status).toBe(413)
  })

  it('rejects localhost by name (before any DNS lookup)', async () => {
    const verdict = await validateEgressUrl('https://localhost/secret')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.status).toBe(403)
  })

  it('rejects a URL that resolves to a private / loopback / metadata IP', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      const lookup: EgressDeps['lookup'] = async () => [{ address: ip, family: 4 }]
      const verdict = await validateEgressUrl('https://evil.test/x', { lookup })
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.status).toBe(403)
    }
  })

  it('allows a URL that resolves only to public addresses', async () => {
    const lookup: EgressDeps['lookup'] = async () => [{ address: '93.184.216.34', family: 4 }]
    const verdict = await validateEgressUrl('https://example.test/x', { lookup })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.addresses).toEqual(['93.184.216.34'])
  })

  it('rejects when ANY resolved address is private (mixed result)', async () => {
    const lookup: EgressDeps['lookup'] = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]
    const verdict = await validateEgressUrl('https://rebind.test/x', { lookup })
    expect(verdict.ok).toBe(false)
  })

  it('rate-limits to 30 requests per window (the 31st is 429)', async () => {
    const rate: RequestRateState = { count: 0, resetAt: 0 }
    const deps: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => ({ status: 200, data: 'ok' }),
      now: () => 1_000_000,
    }
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const raw = await serverLuaRequest('https://example.test/x', deps, rate)
      statuses.push((JSON.parse(raw) as { status: number }).status)
    }
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200))
    expect(statuses[30]).toBe(429)
  })

  it('a blocked URL does not consume the egress budget', async () => {
    const rate: RequestRateState = { count: 0, resetAt: 0 }
    const deps: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => ({ status: 200, data: 'ok' }),
      now: () => 1_000_000,
    }
    // 40 rejected requests (non-https) would previously exhaust the 30/window
    // budget without a single socket opening.
    for (let i = 0; i < 40; i++) {
      const raw = await serverLuaRequest('http://blocked.test/x', deps, rate)
      expect((JSON.parse(raw) as { status: number }).status).toBe(400)
    }
    expect(rate.count).toBe(0)
    // A valid request afterwards still goes through.
    const ok = await serverLuaRequest('https://example.test/x', deps, rate)
    expect((JSON.parse(ok) as { status: number }).status).toBe(200)
    expect(rate.count).toBe(1)
  })

  it('enforces the response cap using UTF-8 bytes instead of decoded code units', async () => {
    const rate: RequestRateState = { count: 0, resetAt: 0 }
    const deps: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      // 1,000,001 two-byte characters are under the 2,000,000 code-unit cap
      // but exceed its UTF-8 byte boundary.
      fetchImpl: async () => ({ status: 200, data: 'é'.repeat(1_000_001) }),
    }

    const raw = await serverLuaRequest('https://example.test/multibyte', deps, rate)

    expect(JSON.parse(raw)).toEqual({ status: 400, data: 'internal error' })
  })

  it('an abort mid-fetch rejects through serverLuaRequest instead of returning a synthetic 400', async () => {
    const controller = new AbortController()
    const rate: RequestRateState = { count: 0, resetAt: 0 }
    let seenSignal: AbortSignal | undefined
    const deps: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      // Mimics pinnedHttpsFetch: settles only when the originating request's
      // signal destroys the in-flight socket.
      fetchImpl: (_url, _addresses, signal) => {
        seenSignal = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('socket destroyed')), {
            once: true,
          })
        })
      },
    }
    const pending = serverLuaRequest('https://example.test/x', deps, rate, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow('request aborted')
    expect(seenSignal).toBe(controller.signal)
  })
})

describe('server Lua runtime — request() binding + low-level gate', () => {
  it('exposes request() only with low-level access; injected egress deps flow through', async () => {
    const egress: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => ({ status: 204, data: 'served' }),
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local res = request(id, 'https://example.test/data'):await()
        if res == nil then
          data[1].content = 'BLOCKED'
        else
          data[1].content = tostring(json.decode(res).status)
        end
        return data
      end)
    `

    // Low-level granted → request runs through the injected fetch.
    const granted = makeRuntime({ egress, rateState: { count: 0, resetAt: 0 } })
    const ok = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, granted.ctx)
    expect((ok.res as PromptMessage[])[0].content).toBe('204')

    // Low-level denied (edit-hook default) → request returns nil.
    const denied = makeRuntime({ egress, rateState: { count: 0, resetAt: 0 } })
    const blocked = await runServerLua(
      { code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: false },
      denied.ctx,
    )
    expect((blocked.res as PromptMessage[])[0].content).toBe('BLOCKED')
  })
})

describe('server Lua runtime — low-level LLM bindings', () => {
  function attachRequestHistory(ctx: ServerLuaRuntimeContext): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    createRequestHistoryTable(db)
    ctx.requestHistoryDb = db
    return db
  }

  function debugEchoDatabase(): Partial<Database> {
    return {
      aiModel: 'echo_model',
      subModel: 'echo_model',
      modelProfiles: [
        {
          id: 'script-main-debug',
          name: 'Script Main Debug',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://script-main',
            requestModel: 'script-main-model',
          },
        },
        {
          id: 'script-aux-debug',
          name: 'Script Aux Debug',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://script-aux',
            requestModel: 'script-aux-model',
          },
        },
        {
          id: 'character-script-debug',
          name: 'Character Script Debug',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://character-script',
            requestModel: 'character-script-model',
          },
        },
        {
          id: 'module-aux-debug',
          name: 'Module Auxiliary Debug',
          providerId: 'debug-echo',
          modelId: 'debug-echo',
          providerOptions: {
            baseUrl: 'debug://module-aux',
            requestModel: 'module-aux-model',
          },
        },
      ],
      modelRoleProfiles: {
        scriptMain: { mode: 'profile', profileId: 'script-main-debug' },
        scriptAux: { mode: 'profile', profileId: 'script-aux-debug' },
      },
    } as unknown as Partial<Database>
  }

  it('routes axLLM through the scriptAux model role when low-level access is granted', async () => {
    const { ctx } = makeRuntime({ database: debugEchoDatabase() })
    const historyDb = attachRequestHistory(ctx)
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local res = axLLM(id, {{ role = 'user', content = 'translate this' }})
        data[1].content = res.result
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('translate this')
    expect(listRequestHistory(historyDb, 20)[0]?.profile).toMatchObject({
      id: 'script-aux-debug',
      role: 'scriptAux',
      provider: 'debug-echo',
      requestModel: 'script-aux-model',
    })
    historyDb.close()
  })

  it('uses the active character script model override for LLM calls', async () => {
    const char = makeChar({ scriptModelOverrides: { llmProfileId: 'character-script-debug' } })
    const { ctx } = makeRuntime({ char, database: debugEchoDatabase() })
    const historyDb = attachRequestHistory(ctx)
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local res = LLM(id, {{ role = 'user', content = 'character prompt' }})
        data[1].content = res.result
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect((result.res as PromptMessage[])[0].content).toBe('character prompt')
    expect(listRequestHistory(historyDb, 20)[0]?.profile).toMatchObject({
      id: 'character-script-debug',
      role: 'scriptMain',
      requestModel: 'character-script-model',
    })
    historyDb.close()
  })

  it('uses the owning module override instead of the active character override', async () => {
    const char = makeChar({ scriptModelOverrides: { axLlmProfileId: 'script-aux-debug' } })
    const module = makeModule({ scriptModelOverrides: { axLlmProfileId: 'module-aux-debug' } })
    const { ctx } = makeRuntime({
      char,
      database: { ...debugEchoDatabase(), modules: [module] },
    })
    const historyDb = attachRequestHistory(ctx)
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local res = axLLM(id, {{ role = 'user', content = 'module prompt' }})
        data[1].content = res.result
        return data
      end)
    `

    const result = await runServerLua(
      {
        code,
        mode: 'editRequest',
        data: rows('orig'),
        lowLevelAccess: true,
        source: { ownerType: 'module', ownerId: module.id, ownerName: module.name },
      },
      ctx,
    )

    expect((result.res as PromptMessage[])[0].content).toBe('module prompt')
    expect(listRequestHistory(historyDb, 20)[0]?.profile).toMatchObject({
      id: 'module-aux-debug',
      role: 'scriptAux',
      requestModel: 'module-aux-model',
    })
    historyDb.close()
  })

  it('fails explicitly when a local script override references a missing profile', async () => {
    const char = makeChar({ scriptModelOverrides: { llmProfileId: 'missing-script-profile' } })
    const { ctx } = makeRuntime({ char, database: debugEchoDatabase() })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local res = LLM(id, {{ role = 'user', content = 'missing prompt' }})
        data[1].content = res.result
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect((result.res as PromptMessage[])[0].content).toContain('missing script model profile')
    expect((result.res as PromptMessage[])[0].content).toContain('missing-script-profile')
  })

  it('keeps axLLMMain denied without low-level access', async () => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local raw = axLLMMain(id, json.encode({{ role = 'user', content = 'blocked' }})):await()
        data[1].content = raw == nil and 'DENIED' or raw
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: false }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('DENIED')
  })

  it('routes LLM and simpleLLM through the scriptMain model role', async () => {
    const { ctx } = makeRuntime({ database: debugEchoDatabase() })
    const historyDb = attachRequestHistory(ctx)
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local full = LLM(id, {{ role = 'user', content = 'main full' }})
        local simple = simpleLLM(id, 'main simple'):await()
        data[1].content = full.result .. '\\n---\\n' .. simple.result
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('main full\n---\nmain simple')
    const profiles = listRequestHistory(historyDb, 20).map((record) => record.profile)
    expect(profiles).toHaveLength(2)
    for (const profile of profiles) {
      expect(profile).toMatchObject({
        id: 'script-main-debug',
        role: 'scriptMain',
        provider: 'debug-echo',
        requestModel: 'script-main-model',
      })
    }
    historyDb.close()
  })
})

describe('server Lua runtime — persona description', () => {
  it('uses the selected persona row over stale legacy profile scalars', async () => {
    const { ctx } = makeRuntime({
      database: {
        selectedPersonaId: 'persona-row',
        selectedPersona: 0,
        username: 'STALE NAME',
        personaPrompt: 'STALE PROMPT',
        personas: [
          { id: 'persona-row', name: 'Canonical Name', icon: '', personaPrompt: 'CANONICAL PROMPT', note: '' },
        ],
      },
    })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = getPersonaName(id) .. '|' .. getPersonaDescription(id)
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('Canonical Name|CANONICAL PROMPT')
  })

  it('falls back to explicit legacy profile aliases when stable selection is missing', async () => {
    const { ctx } = makeRuntime({
      database: {
        selectedPersonaId: 'missing-row',
        selectedPersona: 0,
        username: 'LEGACY NAME',
        personaPrompt: 'LEGACY PROMPT',
        personas: [{ id: 'persona-row', name: 'Wrong Row', icon: '', personaPrompt: 'WRONG PROMPT', note: '' }],
      },
    })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = getPersonaName(id) .. '|' .. getPersonaDescription(id)
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('LEGACY NAME|LEGACY PROMPT')
  })

  it('returns the effective persona prompt expanded in the current character CBS scope', async () => {
    const { ctx } = makeRuntime({
      database: { personaPrompt: 'Persona {{user}} accompanies {{char}}.' },
    })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = getPersonaDescription(id)
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('Persona Operator accompanies Tess.')
  })
})

describe('server Lua runtime — getLoreBooksMain', () => {
  it('returns exact-comment local, global, and module lorebooks in source order with parsed content', async () => {
    const chat = makeChat({
      localLore: [
        lore({ id: 'local-1', comment: 'preset', content: 'local {{char}}' }),
        lore({ id: 'local-nomatch', comment: 'Preset', content: 'wrong case' }),
        lore({ id: 'local-2', comment: 'preset', content: 'local duplicate {{user}}' }),
      ],
    })
    const moduleA = makeModule({
      id: 'module-a',
      lorebook: [lore({ id: 'module-a-1', comment: 'preset', content: 'module {{char}}' })],
    })
    const moduleB = makeModule({
      id: 'module-b',
      lorebook: [lore({ id: 'module-b-1', comment: 'other', content: 'not included' })],
    })
    const char = makeChar({
      chats: [chat],
      globalLore: [lore({ id: 'global-1', comment: 'preset', content: 'global {{user}}' })],
    })
    const { ctx } = makeRuntime({
      chat,
      char,
      database: {
        modules: [moduleA, moduleB],
        enabledModules: ['module-a', 'module-b'],
      } as Partial<Database>,
    })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = json.encode(getLoreBooks(id, 'preset'))
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.error).toBeUndefined()
    const books = JSON.parse((result.res as PromptMessage[])[0].content) as loreBook[]
    expect(books.map((book) => book.id)).toEqual(['local-1', 'local-2', 'global-1', 'module-a-1'])
    expect(books.map((book) => book.content)).toEqual([
      'local Tess',
      'local duplicate Operator',
      'global Operator',
      'module Tess',
    ])
  })

  it('sees upsertLocalLoreBook entries through ctx.chat.localLore in the same Lua run', async () => {
    const chat = makeChat()
    const char = makeChar({ chats: [chat], globalLore: [] })
    const { ctx } = makeRuntime({ chat, char })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        upsertLocalLoreBook(id, 'preset', 'added for {{user}}', { insertOrder = 7, key = 'preset-key' })
        data[1].content = json.encode(getLoreBooks(id, 'preset'))
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.error).toBeUndefined()
    const books = JSON.parse((result.res as PromptMessage[])[0].content) as loreBook[]
    expect(books).toHaveLength(1)
    expect(books[0]).toMatchObject({
      id: expect.any(String),
      comment: 'preset',
      content: 'added for Operator',
      insertorder: 7,
      key: 'preset-key',
    })
    expect(books[0].id).not.toBe('')
  })
})

describe('server Lua runtime — loadLoreBooks', () => {
  it('returns activated lore as exact data/role rows in activation order', async () => {
    const chat = makeChat({
      localLore: [
        lore({
          id: 'local-active',
          comment: 'local',
          content: '@@role assistant\n  local {{char}}  ',
          alwaysActive: true,
          insertorder: 10,
        }),
        lore({
          id: 'local-inactive',
          comment: 'inactive',
          content: 'must not appear',
          key: 'missing-key',
          insertorder: 15,
        }),
      ],
    })
    const module = makeModule({
      id: 'module-a',
      lorebook: [
        lore({
          id: 'module-active',
          comment: 'module',
          content: '@@role user\nmodule {{user}}',
          alwaysActive: true,
          insertorder: 30,
        }),
      ],
    })
    const char = makeChar({
      chats: [chat],
      globalLore: [
        lore({
          id: 'global-active',
          comment: 'global',
          content: 'global {{char}}',
          alwaysActive: true,
          insertorder: 20,
        }),
      ],
    })
    const { ctx } = makeRuntime({
      chat,
      char,
      database: {
        loreBookToken: 10_000,
        modules: [module],
        enabledModules: ['module-a'],
      } as Partial<Database>,
    })
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = json.encode(loadLoreBooks(id))
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect(JSON.parse((result.res as PromptMessage[])[0].content)).toEqual([
      { data: 'local Tess', role: 'char' },
      { data: 'global Tess', role: 'system' },
      { data: 'module Operator', role: 'user' },
    ])
  })
})

describe('server Lua runtime — similarity', () => {
  it('ranks values by the baseline dot-product similarity using the shared embedding contract', async () => {
    const { ctx } = makeRuntime({
      database: {
        hypaModel: 'custom',
        hypaCustomSettings: { url: 'https://embeddings.example/v1', key: 'test-key', model: 'test-model' },
      },
    })
    ctx.luaSimilarity = {
      embed: async ({ input }) => {
        const vectors = input.map((value) => {
          switch (value) {
            case 'right':
            case 'query':
              return new Float32Array([1, 0])
            case 'middle':
              return new Float32Array([0.5, 0.5])
            default:
              return new Float32Array([0, 1])
          }
        })
        return { model: 'test-model', vectors, dim: 2 }
      },
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local ranked = similarity(id, 'query', { 'left', 'right', 'middle' }):await()
        data[1].content = ranked[1] .. ',' .. ranked[2] .. ',' .. ranked[3]
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('right,middle,left')
  })

  it('returns the baseline nil failure value when the embedding provider reaches its deadline', async () => {
    const { ctx } = makeRuntime({
      database: {
        hypaModel: 'custom',
        hypaCustomSettings: { url: 'https://embeddings.example/v1', key: 'test-key', model: 'test-model' },
      },
    })
    ctx.luaSimilarity = {
      deadlineMs: 10,
      embed: async () => await new Promise<never>(() => undefined),
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        local ranked = similarity(id, 'query', { 'value' }):await()
        data[1].content = ranked == nil and 'nil' or 'unexpected'
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('nil')
  })
})

describe('server Lua runtime — generateImage', () => {
  it('blocks restricted asset scope before image-provider dispatch or publication', async () => {
    const { ctx } = makeRuntime({ database: { sdProvider: 'dalle', dallEQuality: 'standard' } })
    let executeCalls = 0
    let persistCalls = 0
    ctx.allowGeneratedAssetWrites = false
    ctx.luaImageGeneration = {
      execute: async () => {
        executeCalls++
        return { bytes: Buffer.from('unreachable'), contentType: 'image/png' }
      },
      persist: () => {
        persistCalls++
        return 'unreachable-asset'
      },
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = generateImage(id, 'a lighthouse'):await()
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('Error: Image generation failed')
    expect(executeCalls).toBe(0)
    expect(persistCalls).toBe(0)
  })

  it('rechecks restricted asset scope immediately before publication', async () => {
    const { ctx } = makeRuntime({ database: { sdProvider: 'dalle', dallEQuality: 'standard' } })
    let executeCalls = 0
    let persistCalls = 0
    ctx.allowGeneratedAssetWrites = true
    ctx.luaImageGeneration = {
      execute: async () => {
        executeCalls++
        ctx.allowGeneratedAssetWrites = false
        return { bytes: Buffer.from('provider-result'), contentType: 'image/png' }
      },
      persist: () => {
        persistCalls++
        return 'forbidden-asset'
      },
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = generateImage(id, 'a lighthouse'):await()
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('Error: Image generation failed')
    expect(executeCalls).toBe(1)
    expect(persistCalls).toBe(0)
  })

  it('uses the configured image model, persists the image, and returns an inlay marker', async () => {
    const { ctx } = makeRuntime({
      database: {
        sdProvider: 'stability',
        stabilityModel: 'sd3-medium',
        stabllityStyle: 'anime',
      },
    })
    let receivedRequest: unknown
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z0AAAAASUVORK5CYII=',
      'base64',
    )
    const assetId = createHash('sha256').update(imageBytes).digest('hex')
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-lua-image-'))
    const assetDb = openDatabase(dataDir)
    ctx.requestHistoryDb = assetDb
    ctx.assetDataDir = dataDir
    ctx.luaImageGeneration = {
      execute: async (request) => {
        receivedRequest = request
        return { bytes: imageBytes, contentType: 'image/png' }
      },
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = generateImage(id, 'a lighthouse', 'fog'):await()
        return data
      end)
    `

    try {
      const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

      expect(result.error).toBeUndefined()
      expect(receivedRequest).toEqual({
        provider: 'stability',
        credential: { source: 'stored' },
        prompt: 'a lighthouse',
        negativePrompt: 'fog',
        model: 'sd3-medium',
        style: 'anime',
      })
      expect((result.res as PromptMessage[])[0].content).toBe(`{{inlay::${assetId}}}`)
      const asset = getAssetMetadataById(assetDb, assetId)
      expect(asset).toMatchObject({ id: assetId, contentType: 'image/png', size: imageBytes.length })
      expect(existsSync(assetPath(dataDir, asset!))).toBe(true)
      expect(listInlayCatalogEntries(assetDb)).toContainEqual(
        expect.objectContaining({ assetId, name: assetId, type: 'image' }),
      )
    } finally {
      assetDb.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('returns the baseline failure string when image generation fails', async () => {
    const { ctx } = makeRuntime({ database: { sdProvider: 'dalle', dallEQuality: 'standard' } })
    ctx.luaImageGeneration = {
      execute: async () => {
        throw new Error('upstream unavailable')
      },
    }
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = generateImage(id, 'a lighthouse'):await()
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toBeUndefined()
    expect((result.res as PromptMessage[])[0].content).toBe('Error: Image generation failed')
  })
})

describe('server Lua runtime — unsupported server APIs reject loudly', () => {
  it.each([
    {
      api: 'multimodal LLM',
      call: "LLM(id, { { role = 'user', content = 'look' } }, true)",
    },
    { api: 'getCharacterImage', call: 'getCharacterImage(id)' },
    { api: 'getPersonaImage', call: 'getPersonaImage(id)' },
  ])('$api raises a script-facing unsupported-server error', async ({ call }) => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        ${call}
        data[1].content = 'SHOULD_NOT_APPLY'
        return data
      end)
    `

    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig'), lowLevelAccess: true }, ctx)

    expect(result.error).toContain('Lua API is unsupported on the server')
    expect(result.res).toBeUndefined()
  })
})

describe('server Lua runtime — execution limit', () => {
  it('interrupts a top-level runaway loop within the limit', async () => {
    const { ctx } = makeRuntime()
    const started = Date.now()
    const result = await runServerLua(
      {
        code: 'while true do end',
        mode: 'editRequest',
        data: rows('x'),
        execTimeoutMs: SHORT_LIMIT,
      },
      ctx,
    )
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(5000)
  })

  it('interrupts a runaway loop inside an edit handler within the limit', async () => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        while true do end
        return data
      end)
    `
    const started = Date.now()
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('x'), execTimeoutMs: SHORT_LIMIT }, ctx)
    const elapsed = Date.now() - started
    expect(result.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(5000)
  })
})

describe('server Lua runtime — request-signal abort', () => {
  it('an already-aborted request signal returns immediately without dispatching', async () => {
    const { ctx, engine } = makeRuntime()
    const controller = new AbortController()
    controller.abort()
    ctx.signal = controller.signal
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        setChatVar(id, 'mood', 'ran-anyway')
        return data
      end)
    `
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('x') }, ctx)

    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.res).toBeUndefined()
    expect(engine.getVar('mood')).toBe('null')
  })

  it('aborting mid-dispatch cancels in-flight hook work well before the exec limit', async () => {
    const { ctx, engine } = makeRuntime()
    const controller = new AbortController()
    ctx.signal = controller.signal
    // The handler would loop sleep() for far longer than our abort point; every
    // host-fn call is the abort checkpoint, so the loop dies on the next call.
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        while true do
          sleep(id, 200):await()
        end
        return data
      end)
    `
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('x'), execTimeoutMs: 60_000 }, ctx)
    const elapsed = Date.now() - started

    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.res).toBeUndefined()
    expect(elapsed).toBeLessThan(5_000)
    expect(engine.varChanged).toBe(false)
  })

  it('aborting while a Lua request() egress fetch is in flight cancels the run promptly', async () => {
    const controller = new AbortController()
    let fetchStarted = false
    const egress: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      // Mimics pinnedHttpsFetch: never resolves on its own (a slow upstream);
      // rejects only when the originating request's signal tears the socket down.
      fetchImpl: (_url, _addresses, signal) =>
        new Promise((_resolve, reject) => {
          fetchStarted = true
          signal?.addEventListener('abort', () => reject(new Error('request aborted')), {
            once: true,
          })
        }),
    }
    const { ctx, engine } = makeRuntime({ egress, rateState: { count: 0, resetAt: 0 } })
    ctx.signal = controller.signal
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        request(id, 'https://example.test/slow'):await()
        setChatVar(id, 'mood', 'survived-abort')
        return data
      end)
    `
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const result = await runServerLua(
      { code, mode: 'editRequest', data: rows('x'), lowLevelAccess: true, execTimeoutMs: 60_000 },
      ctx,
    )
    const elapsed = Date.now() - started

    expect(fetchStarted).toBe(true)
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.res).toBeUndefined()
    expect(elapsed).toBeLessThan(5_000)
    // The script never continued past the in-flight await.
    expect(engine.getVar('mood')).toBe('null')
  })
})

describe('server Lua runtime — interactive APIs fail explicitly', () => {
  it('does not flag alertInput when the handler containing it is not executed', async () => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editOutput', function(id, data, meta)
        alertInput(id, 'pick one')
        return data
      end)
    `
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.interactiveInvoked).toBe(false)
    expect(result.res).toEqual(rows('orig'))
  })

  it('flags alertInput and does not silently apply the handler', async () => {
    const { ctx } = makeRuntime()
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        alertInput(id, 'pick one')
        data[1].content = 'SHOULD_NOT_APPLY'
        return data
      end)
    `
    const result = await runServerLua({ code, mode: 'editRequest', data: rows('orig') }, ctx)

    expect(result.interactiveInvoked).toBe(true)
    // The handler threw at alertInput, so the row was never rewritten.
    expect(result.res).toBeUndefined()
  })
})

describe('server Lua runtime — aggregate exec budget', () => {
  it('an exhausted aggregate budget short-circuits before booting an engine', async () => {
    const { ctx } = makeRuntime()
    ctx.execBudget = { totalMs: 100, usedMs: 100 }
    const before = readLuaEngineAcquireStats()

    const result = await runServerLua({ code: 'while true do end', mode: 'editRequest', data: rows('x') }, ctx)

    expect(result.timedOut).toBe(true)
    expect(result.error).toBe('aggregate Lua execution budget exhausted')
    expect(result.res).toBeUndefined()
    const after = readLuaEngineAcquireStats()
    expect(after.pooledAcquires + after.freshAcquires).toBe(before.pooledAcquires + before.freshAcquires)
  })

  it('runaway hooks across a trigger loop are bounded by the aggregate budget, not per-run limits', async () => {
    const chat = makeChat()
    const runawayEffect = {
      comment: 'runaway',
      type: 'request',
      conditions: [],
      effect: [{ type: 'triggerlua', code: 'while true do end' }],
    }
    const char = makeChar({
      chats: [chat],
      // Three runaway hooks: with the default 3000ms per-run limit alone this
      // loop would stall for ~9s; the shared budget bounds the whole pass.
      triggerscript: [runawayEffect, runawayEffect, runawayEffect] as never,
    })
    const { ctx } = makeRuntime({ chat, char })
    const { char: _char, ...editCtx } = ctx
    const budget = createLuaExecBudget(300)

    const input = rows('survives')
    const started = Date.now()
    await expect(
      runLuaEditTrigger(
        char,
        'editRequest',
        input,
        {},
        {
          ...editCtx,
          execBudget: budget,
        },
      ),
    ).rejects.toThrow(/Lua editRequest edit trigger failed/)
    const elapsed = Date.now() - started

    // Bounded by ~the budget (plus scheduling slack), well under one per-run
    // limit per hook.
    expect(elapsed).toBeLessThan(2_500)
    expect(budget.usedMs).toBeGreaterThanOrEqual(300)
  })
})

describe('server Lua runtime — pre-warmed engines', () => {
  it('a default-limit run serves from the warm pool without a hot-path boot, output identical', async () => {
    // Prime: this run may boot inline, but its completion refills the pool.
    const code = `
      listenEdit('editRequest', function(id, data, meta)
        data[#data].content = data[#data].content .. ' [' .. meta.tag .. ']'
        return data
      end)
    `
    const prime = makeRuntime()
    const fresh = await runServerLua(
      { code, mode: 'editRequest', data: rows('alpha', 'omega'), meta: { tag: 'EDIT' } },
      prime.ctx,
    )
    await settleLuaEnginePool()

    const before = readLuaEngineAcquireStats()
    const { ctx } = makeRuntime()
    const pooled = await runServerLua(
      { code, mode: 'editRequest', data: rows('alpha', 'omega'), meta: { tag: 'EDIT' } },
      ctx,
    )
    const after = readLuaEngineAcquireStats()

    // The second run came from the pool — no fresh boot on the hot path.
    expect(after.pooledAcquires).toBe(before.pooledAcquires + 1)
    expect(after.freshAcquires).toBe(before.freshAcquires)
    // Pooled and fresh-boot runs produce identical results.
    const withoutDuration = (result: typeof fresh) => ({
      ...result,
      runtimeMetricFields: result.runtimeMetricFields
        ? { ...result.runtimeMetricFields, durationMs: 0 }
        : result.runtimeMetricFields,
    })
    expect(withoutDuration(pooled)).toEqual(withoutDuration(fresh))
    expect((pooled.res as PromptMessage[])[1].content).toBe('omega [EDIT]')
  })

  it('pooled engines never leak Lua globals between runs (per-call isolation preserved)', async () => {
    const readMarker = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = tostring(MARKER)
        return data
      end)
    `
    // Run A plants a global on its engine…
    const writer = makeRuntime()
    const wrote = await runServerLua(
      { code: `MARKER = 'leaked'\n${readMarker}`, mode: 'editRequest', data: rows('x') },
      writer.ctx,
    )
    expect((wrote.res as PromptMessage[])[0].content).toBe('leaked')

    // …and run B (a pooled engine under the same default limit) must not see it.
    await settleLuaEnginePool()
    const reader = makeRuntime()
    const read = await runServerLua({ code: readMarker, mode: 'editRequest', data: rows('x') }, reader.ctx)
    expect((read.res as PromptMessage[])[0].content).toBe('nil')
  })

  it('a fresh boot never overlaps an active run with a pending Lua continuation', async () => {
    // Engine boots mutate the shared wasm module; booting while another engine
    // sits in an in-flight `:await()` continuation crashes wasmoon. Run A
    // suspends inside request():await(); run B uses a custom exec limit, so it
    // can never be served from the pool and MUST fresh-boot — that boot has to
    // wait until A drains.
    await settleLuaEnginePool()

    let resolveFetch!: (result: { status: number; data: string }) => void
    let markFetchStarted!: () => void
    const fetchInFlight = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const egress: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: () =>
        new Promise((resolve) => {
          markFetchStarted()
          resolveFetch = resolve
        }),
    }
    const a = makeRuntime({ egress, rateState: { count: 0, resetAt: 0 } })
    const codeA = `
      listenEdit('editRequest', function(id, data, meta)
        request(id, 'https://example.test/slow'):await()
        setChatVar(id, 'aDone', 'yes')
        return data
      end)
    `
    const settleOrder: string[] = []
    const before = readLuaEngineAcquireStats()
    const runA = runServerLua(
      {
        code: codeA,
        mode: 'editRequest',
        data: rows('a'),
        lowLevelAccess: true,
        execTimeoutMs: 60_000,
      },
      a.ctx,
    ).then((result) => {
      settleOrder.push('A')
      return result
    })
    await fetchInFlight
    const duringA = readLuaEngineAcquireStats()
    expect(duringA.freshAcquires).toBe(before.freshAcquires + 1)

    const b = makeRuntime()
    const codeB = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = data[1].content .. ' [B]'
        return data
      end)
    `
    const runB = runServerLua({ code: codeB, mode: 'editRequest', data: rows('b'), execTimeoutMs: 10_000 }, b.ctx).then(
      (result) => {
        settleOrder.push('B')
        return result
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 150))

    // While A holds a pending continuation, B's fresh boot is parked: no new
    // engine boot occurred and B has not settled.
    const whileSuspended = readLuaEngineAcquireStats()
    expect(whileSuspended.engineBoots).toBe(duringA.engineBoots)
    expect(whileSuspended.freshAcquires).toBe(duringA.freshAcquires)
    expect(settleOrder).toEqual([])

    resolveFetch({ status: 200, data: 'ok' })
    const resultA = await runA
    const resultB = await runB

    // Strict ordering: A drained first, only then did B boot and run.
    expect(settleOrder).toEqual(['A', 'B'])
    expect(resultA.error).toBeUndefined()
    expect(a.engine.getVar('aDone')).toBe('yes')
    expect(resultB.error).toBeUndefined()
    expect((resultB.res as PromptMessage[])[0].content).toBe('b [B]')
    const after = readLuaEngineAcquireStats()
    expect(after.freshAcquires).toBe(duringA.freshAcquires + 1)
  })

  it('a pooled engine never overlaps an active run with a pending Lua continuation', async () => {
    // Regression for two output Lua hooks that both wait on low-level host fns
    // such as axLLM(): even when a second prewarmed engine is available, it must
    // not run beside the suspended continuation.
    const warmup = makeRuntime()
    await runServerLua(
      {
        code: `
          listenEdit('editRequest', function(id, data, meta)
            return data
          end)
        `,
        mode: 'editRequest',
        data: rows('warm'),
      },
      warmup.ctx,
    )
    await settleLuaEnginePool()

    let resolveFetch!: (result: { status: number; data: string }) => void
    let markFetchStarted!: () => void
    const fetchInFlight = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const egress: EgressDeps = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: () =>
        new Promise((resolve) => {
          markFetchStarted()
          resolveFetch = resolve
        }),
    }

    const a = makeRuntime({ egress, rateState: { count: 0, resetAt: 0 } })
    const codeA = `
      listenEdit('editRequest', function(id, data, meta)
        request(id, 'https://example.test/slow'):await()
        setChatVar(id, 'aDone', 'yes')
        return data
      end)
    `
    const settleOrder: string[] = []
    const before = readLuaEngineAcquireStats()
    const runA = runServerLua(
      {
        code: codeA,
        mode: 'editRequest',
        data: rows('a'),
        lowLevelAccess: true,
      },
      a.ctx,
    ).then((result) => {
      settleOrder.push('A')
      return result
    })
    await fetchInFlight
    const duringA = readLuaEngineAcquireStats()
    expect(duringA.pooledAcquires).toBe(before.pooledAcquires + 1)

    const b = makeRuntime()
    const codeB = `
      listenEdit('editRequest', function(id, data, meta)
        data[1].content = data[1].content .. ' [B]'
        return data
      end)
    `
    const runB = runServerLua({ code: codeB, mode: 'editRequest', data: rows('b') }, b.ctx).then((result) => {
      settleOrder.push('B')
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const whileSuspended = readLuaEngineAcquireStats()
    expect(whileSuspended.pooledAcquires).toBe(duringA.pooledAcquires)
    expect(settleOrder).toEqual([])

    resolveFetch({ status: 200, data: 'ok' })
    const resultA = await runA
    const resultB = await runB

    expect(settleOrder).toEqual(['A', 'B'])
    expect(resultA.error).toBeUndefined()
    expect(a.engine.getVar('aDone')).toBe('yes')
    expect(resultB.error).toBeUndefined()
    expect((resultB.res as PromptMessage[])[0].content).toBe('b [B]')
    const after = readLuaEngineAcquireStats()
    expect(after.pooledAcquires).toBe(duringA.pooledAcquires + 1)
  })
})

describe('server Lua runtime — runLuaEditTrigger entry', () => {
  it.each([
    { mode: 'editRequest', body: "return 'wrong channel'" },
    { mode: 'editRequest', body: "return {{role='user',content=42}}" },
    { mode: 'editOutput', body: 'return 42' },
  ])('rejects malformed $mode edit-hook outputs at the Lua boundary: $body', async ({ mode, body }) => {
    const chat = makeChat()
    const char = makeChar({
      chats: [chat],
      triggerscript: [
        {
          comment: 'bad output',
          type: 'request',
          conditions: [],
          effect: [{ type: 'triggerlua', code: `listenEdit('${mode}', function(id,data,meta) ${body} end)` }],
        },
      ],
    })
    const { ctx } = makeRuntime({ chat, char })
    const { char: _char, ...editCtx } = ctx
    const result =
      mode === 'editOutput'
        ? runLuaEditTrigger(char, mode, 'original', undefined, editCtx)
        : runLuaEditTrigger(char, mode, rows('original'), undefined, editCtx)
    await expect(result).rejects.toThrow('Lua edit hook expected')
  })

  it('preserves valid prompt-row extension data and null/no-result fallback', async () => {
    const chat = makeChat()
    const char = makeChar({
      chats: [chat],
      triggerscript: [
        {
          comment: 'output',
          type: 'request',
          conditions: [],
          effect: [
            {
              type: 'triggerlua',
              code: `
      listenEdit('editRequest', function(id,data,meta)
        data[1].future = {label='preserved'}
        return data
      end)
      listenEdit('editOutput', function(id,data,meta) return nil end)
    `,
            },
          ],
        },
      ],
    })
    const { ctx } = makeRuntime({ chat, char })
    const { char: _char, ...editCtx } = ctx
    const output = await runLuaEditTrigger(char, 'editRequest', rows('valid'), undefined, editCtx)
    expect(output[0]).toEqual({ role: 'user', content: 'valid', future: { label: 'preserved' } })
    expect(await runLuaEditTrigger(char, 'editOutput', 'unchanged', undefined, editCtx)).toBe('unchanged')
  })

  it('runs a character triggerlua editRequest hook over the rows', async () => {
    const chat = makeChat()
    const char = makeChar({
      chats: [chat],
      triggerscript: [
        {
          comment: 'edit',
          type: 'request',
          conditions: [],
          effect: [
            {
              type: 'triggerlua',
              code: `
                listenEdit('editRequest', function(id, data, meta)
                  data[#data].content = data[#data].content .. ' !'
                  return data
                end)
              `,
            },
          ],
        } as never,
      ],
    })
    const { ctx } = makeRuntime({ chat, char })
    const { char: _char, ...editCtx } = ctx

    const out = await runLuaEditTrigger(char, 'editRequest', rows('ping'), {}, editCtx)
    expect(out[0].content).toBe('ping !')
  })

  it('runs simple character triggerlua editDisplay hooks for first-message parity', async () => {
    const chat = makeChat()
    const backingChar = makeChar({ chats: [chat] })
    const simpleChar = {
      type: 'simple',
      chaId: 'simple-char',
      customscript: [],
      triggerscript: [
        {
          comment: 'display',
          type: 'display',
          conditions: [],
          effect: [
            {
              type: 'triggerlua',
              code: `
                listenEdit('editDisplay', function(id, data, meta)
                  return data .. ' [simple]'
                end)
              `,
            },
          ],
        },
      ],
    } as never
    const { ctx } = makeRuntime({ chat, char: backingChar })
    const { char: _char, ...editCtx } = ctx

    const out = await runLuaEditTrigger(simpleChar, 'editdisplay', 'first message', {}, editCtx)
    expect(out).toBe('first message [simple]')
  })

  it('returns content unchanged for editprocess (browser no-op)', async () => {
    const chat = makeChat()
    const char = makeChar({ chats: [chat] })
    const { ctx } = makeRuntime({ chat, char })
    const { char: _char, ...editCtx } = ctx

    const input = rows('untouched')
    const out = await runLuaEditTrigger(char, 'editprocess', input, {}, editCtx)
    expect(out).toBe(input)
  })
})
