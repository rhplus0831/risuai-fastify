import { createHash } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { isDiagnosticEventV2, type DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import { registerDiagnosticDatabase, runWithDiagnosticContext } from '../src/diagnosticContext.js'
import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import { createTriggerVarEngine } from '../src/prompt/triggerVars.js'
import { runServerLua, type RunServerLuaOptions, type ServerLuaRuntimeContext } from '../src/prompt/luaRuntime.js'
import type { FastifyChat, FastifyCharacter, FastifyDatabase } from '../src/prompt/serverTypes.js'

beforeAll(() => bootPromptVariables())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const CANARY = 'private-script-output-log-owner-canary'

function runtime(): ServerLuaRuntimeContext {
  const chat = {
    message: [{ role: 'user', data: CANARY }],
    note: '',
    name: CANARY,
    localLore: [],
    scriptstate: {},
    fmIndex: -1,
  } as FastifyChat
  const char = {
    type: 'character',
    name: CANARY,
    chaId: CANARY,
    chats: [chat],
    chatPage: 0,
    triggerscript: [],
  } as unknown as FastifyCharacter
  const database = {
    characters: [char],
    currentChar: 0,
    aiModel: 'echo_model',
    globalChatVariables: {},
  } as FastifyDatabase
  return {
    chat,
    char,
    database,
    selectedCharID: 0,
    chatPage: 0,
    varEngine: createTriggerVarEngine({ chat, database, selectedCharID: 0, chatPage: 0, defaultVariables: [] }),
  }
}

async function capture(options: RunServerLuaOptions, ctx = runtime(), enabled = true) {
  const entries: DiagnosticEventV2[] = []
  const db = {}
  const unregister = enabled
    ? registerDiagnosticDatabase(db, { record: (entry) => entries.push(entry), history: () => 'synthetic' })
    : () => undefined
  try {
    const result = await runWithDiagnosticContext(
      db,
      { requestUid: 'a'.repeat(64), operationId: CANARY, attemptId: CANARY },
      () => runServerLua(options, ctx),
    )
    for (const entry of entries) expect(isDiagnosticEventV2(entry)).toBe(true)
    const scripts = entries.filter((entry) => entry.category === 'script')
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toContain(CANARY)
    expect(serialized).not.toContain(createHash('sha256').update(options.code).digest('hex'))
    expect(serialized).not.toMatch(/codeSha256|ownerId|ownerName|sourceId|hostEvents|chatBefore|chatAfter|sidecar/)
    return { result, entries: scripts, ctx }
  } finally {
    unregister()
  }
}

describe('safe Lua diagnostics', () => {
  it.each([
    ['0', '0'],
    ['1', '0'],
    ['0', '1'],
    ['1', '1'],
  ])('keeps safe evidence independent of raw metrics=%s and full prompt=%s', async (metrics, fullPrompt) => {
    vi.stubEnv('RISU_PROTOCOL_METRICS', metrics)
    vi.stubEnv('RISU_GENERATION_TRACE_FULL_PROMPT', fullPrompt)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { result, entries } = await capture({
      mode: 'editOutput',
      data: CANARY,
      source: { ownerType: 'character', ownerId: CANARY, ownerName: CANARY },
      code: `listenEdit('editOutput', function(id, data)
        local previous = getChatData(id, 0)
        setChat(id, 0, previous .. ' changed')
        log('${CANARY}')
        request(id, 'https://private-url-canary.invalid/'):await()
        return data .. ' changed'
      end)`,
    })
    expect(result.error).toBeUndefined()
    expect(result.res).toBe(`${CANARY} changed`)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      category: 'script',
      source: 'server',
      correlation: 'operation',
      requestUid: 'a'.repeat(64),
      hook: 'editOutput',
      runtime: 'lua',
      runs: 1,
      failures: 0,
      allowedCalls: 3,
      blockedCalls: 1,
      outputChanged: true,
      transcriptChanged: true,
      comparison: 'complete',
    })
    expect(entries[0].durationMs).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain('private-url-canary')
  })

  it('compares final transcript content after changed values and added rows are restored', async () => {
    const { result, entries } = await capture({
      mode: 'editInput',
      data: CANARY,
      code: `listenEdit('editInput', function(id, data)
        local previous = getChatData(id, 0)
        setChat(id, 0, 'temporary')
        setChat(id, 0, previous)
        addChat(id, 'char', 'temporary')
        removeChat(id, 1)
        return data
      end)`,
    })
    expect(result.error).toBeUndefined()
    expect(entries[0]).toMatchObject({
      hook: 'editInput',
      allowedCalls: 5,
      blockedCalls: 0,
      outputChanged: false,
      transcriptChanged: false,
    })
  })

  it('uses local structural equality for prompt output without exporting prompt or media fields', async () => {
    const options: RunServerLuaOptions = {
      mode: 'editRequest',
      data: [{ role: 'user', content: CANARY, memo: undefined, multimodals: [{ type: 'image', base64: CANARY }] }],
      code: `listenEdit('editRequest', function(id, data) return data end)`,
    }
    const unchanged = await capture(options)
    expect(unchanged.entries[0]).toMatchObject({ outputChanged: false, transcriptChanged: false })
    const changed = await capture({
      ...options,
      code: `listenEdit('editRequest', function(id, data)
        data[1].multimodals[1].base64 = '${CANARY}-changed'
        return data
      end)`,
    })
    expect(changed.entries[0]).toMatchObject({ outputChanged: true, transcriptChanged: false })
  })

  it('counts actual egress denials separately from allowed calls and provider HTTP failures', async () => {
    const ctx = runtime()
    const fetch = vi.fn(async () => ({ status: 403, data: CANARY }))
    ctx.egress = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: fetch }
    ctx.rateState = { count: 0, resetAt: Date.now() }
    const { result, entries } = await capture(
      {
        mode: 'output',
        lowLevelAccess: true,
        code: `onOutput = async(function(id)
          request(id, 'https://127.0.0.1/'):await()
          request(id, 'https://example.test/'):await()
        end)`,
      },
      ctx,
    )
    expect(result.error).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(entries[0]).toMatchObject({ hook: 'onOutput', allowedCalls: 1, blockedCalls: 1, failures: 0 })
  })

  it.each([
    { mode: 'input', code: `function onInput(id) error('${CANARY}') end` },
    { mode: 'editOutput', data: CANARY, code: `listenEdit('editOutput', function(id, data) return 23 end)` },
    { mode: CANARY, code: `invalid Lua ${CANARY}` },
  ])('counts failed hooks without preserving error text or arbitrary hook labels', async (options) => {
    const { entries } = await capture(options)
    expect(entries[0]).toMatchObject({ runs: 1, failures: 1, allowedCalls: 0, blockedCalls: 0 })
  })

  it('records budget exhaustion and cancellation before a host call without booting work', async () => {
    const ctx = runtime()
    ctx.execBudget = { totalMs: 1, usedMs: 1 }
    const exhausted = await capture({ mode: 'input', code: '' }, ctx)
    expect(exhausted.result.timedOut).toBe(true)
    expect(exhausted.entries[0]).toMatchObject({ failures: 1, allowedCalls: 0, blockedCalls: 0 })
    ctx.signal = AbortSignal.abort()
    const cancelled = await capture({ mode: 'input', code: '' }, ctx)
    expect(cancelled.result.aborted).toBe(true)
    expect(cancelled.entries[0]).toMatchObject({ failures: 1, allowedCalls: 0, blockedCalls: 0 })
  })

  it('omits unknown comparisons after bounded work while retaining useful execution evidence', async () => {
    const ctx = runtime()
    ctx.chat.message = Array.from({ length: 4097 }, () => ({ role: 'user', data: CANARY }))
    const { entries } = await capture(
      { mode: 'input', code: `function onInput(id) setChat(id, 0, 'changed') end` },
      ctx,
    )
    expect(entries[0]).toMatchObject({ comparison: 'unavailable', outputChanged: false, allowedCalls: 1 })
    expect(entries[0]).not.toHaveProperty('transcriptChanged')

    ctx.chat.message = [{ role: 'user', data: 'x'.repeat(1_048_577) }]
    const largeTranscript = await capture(
      { mode: 'input', code: `function onInput(id) setChat(id, 0, 'changed') end` },
      ctx,
    )
    expect(largeTranscript.entries[0]).toMatchObject({ comparison: 'unavailable', allowedCalls: 1 })
    expect(largeTranscript.entries[0]).not.toHaveProperty('transcriptChanged')

    const largeOutput = await capture({
      mode: 'editOutput',
      data: 'x'.repeat(1_048_577),
      code: `listenEdit('editOutput', function(id, data) return data end)`,
    })
    expect(largeOutput.entries[0]).toMatchObject({ comparison: 'unavailable', transcriptChanged: false })
    expect(largeOutput.entries[0]).not.toHaveProperty('outputChanged')
  })

  it('does not collect outside the enabled app context and preserves hook behavior', async () => {
    const { result, entries } = await capture(
      { mode: 'editInput', data: CANARY, code: `listenEdit('editInput', function(id, data) return data .. '!' end)` },
      runtime(),
      false,
    )
    expect(result.res).toBe(`${CANARY}!`)
    expect(entries).toEqual([])
  })
})
