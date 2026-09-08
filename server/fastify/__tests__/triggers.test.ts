import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyMessage as Message,
} from '../src/prompt/serverTypes.js'
import { serverUnsupportedTriggerEffectTypes } from '../src/prompt/triggerCompatibility.js'
import type { ServerModule as RisuModule } from '../src/prompt/moduleDescriptors.js'
import type {
  ServerTriggerCondition as triggerCondition,
  ServerTriggerScript as triggerscript,
} from '../src/prompt/triggerDescriptors.js'
import { getModuleTriggers } from '../src/prompt/modules.js'
import {
  collectTriggers,
  createTriggerExecutionBudget,
  evaluateConditions,
  getTriggerCloneInstrumentation,
  matchesTrigger,
  resetTriggerCloneInstrumentation,
  runTrigger,
  type TriggerRunContext,
  type TriggerMode,
} from '../src/prompt/triggers.js'
import { createTriggerVarEngine } from '../src/prompt/triggerVars.js'
import { applyV2DataEffect } from '../src/prompt/triggerDataEffects.js'
import { createTriggerRunCache } from '../src/prompt/triggerRunCache.js'
import { BOUNDED_REGEX_LIMITS } from '../src/prompt/boundedRegex.js'
import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import { getTriggerSource } from '../src/prompt/triggerSource.js'
import { expandVariables } from '../src/prompt/variables.js'

beforeAll(() => {
  bootPromptVariables()
})

afterEach(() => {
  resetTriggerCloneInstrumentation()
})

/** Pass-through expander for condition tests that use no CBS syntax. */
const identityExpand = (text: string): string => text

function makeChar(overrides: Partial<character> = {}): character {
  return {
    type: 'character',
    name: 'Tess',
    chaId: 'char-tess',
    triggerscript: [],
    chats: [{ message: [], scriptstate: {} }],
    chatPage: 0,
    ...overrides,
  } as unknown as character
}

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

function makeModule(overrides: Partial<RisuModule> = {}): RisuModule {
  return {
    name: 'mod',
    description: '',
    id: 'mod-1',
    ...overrides,
  } as RisuModule
}

function makeTrigger(overrides: Partial<triggerscript> = {}): triggerscript {
  return {
    comment: '',
    type: 'output',
    conditions: [],
    effect: [],
    ...overrides,
  } as triggerscript
}

function makeDb(overrides: Partial<Database> = {}): Database {
  return {
    characters: [],
    templateDefaultVariables: '',
    currentChar: 0,
    ...overrides,
  } as unknown as Database
}

function makeCtx(overrides: Partial<TriggerRunContext> = {}): TriggerRunContext {
  return {
    modules: [],
    database: makeDb(),
    selectedCharID: 0,
    chatPage: 0,
    ...overrides,
  }
}

const ctx: TriggerRunContext = makeCtx()

describe('getModuleTriggers', () => {
  it('returns [] when no module declares triggers', () => {
    expect(getModuleTriggers([makeModule()])).toEqual([])
  })

  it('inherits lowLevelAccess from the owning module without mutating the source', () => {
    const trigger = makeTrigger({ comment: 'm', type: 'start' })
    const mod = makeModule({ trigger: [trigger], lowLevelAccess: true })

    const out = getModuleTriggers([mod])

    expect(out).toHaveLength(1)
    expect(out[0].lowLevelAccess).toBe(true)
    expect(out[0]).not.toBe(trigger)
    expect(getTriggerSource(out[0])).toMatchObject({
      ownerType: 'module',
      ownerId: 'mod-1',
      ownerName: 'mod',
      triggerIndex: 0,
      triggerComment: 'm',
      triggerType: 'start',
      lowLevelAccess: true,
    })
    expect(Object.keys(out[0])).not.toContain('ownerType')
    expect(JSON.stringify(out[0])).not.toContain('mod-1')
    // source trigger object stays untouched
    expect(trigger.lowLevelAccess).toBeUndefined()
    expect(getTriggerSource(trigger)).toBeUndefined()
  })

  it('omits legacy tuple modes from scalar-only module attribution', () => {
    const trigger = makeTrigger({ type: ['output'] })
    const [collected] = getModuleTriggers([makeModule({ trigger: [trigger] })])

    expect(collected.type).toEqual(['output'])
    expect(getTriggerSource(collected)).not.toHaveProperty('triggerType')
    expect(trigger.type).toEqual(['output'])
  })

  it('flattens triggers across multiple modules in order', () => {
    const a = makeModule({
      id: 'a',
      trigger: [makeTrigger({ comment: 'a1' })],
      lowLevelAccess: false,
    })
    const b = makeModule({
      id: 'b',
      trigger: [makeTrigger({ comment: 'b1' }), makeTrigger({ comment: 'b2' })],
      lowLevelAccess: true,
    })

    const out = getModuleTriggers([a, b])

    expect(out.map((t) => t.comment)).toEqual(['a1', 'b1', 'b2'])
    expect(out.map((t) => t.lowLevelAccess)).toEqual([false, true, true])
  })
})

describe('collectTriggers', () => {
  it('clones character triggers with inherited lowLevelAccess and leaves the source untouched', () => {
    const own = makeTrigger({ comment: 'own', type: 'output' })
    const char = makeChar({ triggerscript: [own], lowLevelAccess: true })

    const out = collectTriggers(char, [])

    expect(out).toHaveLength(1)
    expect(out[0].lowLevelAccess).toBe(true)
    expect(out[0]).not.toBe(own)
    expect(getTriggerSource(out[0])).toMatchObject({
      ownerType: 'character',
      ownerId: 'char-tess',
      ownerName: 'Tess',
      triggerIndex: 0,
      triggerComment: 'own',
      triggerType: 'output',
      lowLevelAccess: true,
    })
    expect(Object.keys(out[0])).not.toContain('ownerType')
    expect(JSON.stringify(out[0])).not.toContain('char-tess')
    expect(own.lowLevelAccess).toBeUndefined()
    expect(getTriggerSource(own)).toBeUndefined()
  })

  it('omits legacy tuple modes from scalar-only character attribution', () => {
    const own = makeTrigger({ type: ['input'] })
    const [collected] = collectTriggers(makeChar({ triggerscript: [own] }), [])

    expect(collected.type).toEqual(['input'])
    expect(getTriggerSource(collected)).not.toHaveProperty('triggerType')
  })

  it('appends module triggers after the character triggers', () => {
    const own = makeTrigger({ comment: 'own' })
    const char = makeChar({ triggerscript: [own] })
    const mod = makeModule({ trigger: [makeTrigger({ comment: 'mod' })] })

    const out = collectTriggers(char, [mod])

    expect(out.map((t) => t.comment)).toEqual(['own', 'mod'])
  })

  it('defaults lowLevelAccess to false when the character does not set it', () => {
    const char = makeChar({ triggerscript: [makeTrigger()] })
    expect(collectTriggers(char, [])[0].lowLevelAccess).toBe(false)
  })
})

describe('matchesTrigger', () => {
  it('matches on equal mode/type', () => {
    expect(matchesTrigger(makeTrigger({ type: 'output' }), 'output')).toBe(true)
  })

  it('ignores triggers whose type differs from the mode', () => {
    expect(matchesTrigger(makeTrigger({ type: 'output' }), 'start')).toBe(false)
  })

  it('does not automatically match a persisted singleton tuple mode', () => {
    expect(matchesTrigger(makeTrigger({ type: ['output'] }), 'output')).toBe(false)
  })

  it('filters by manualName comment when one is supplied', () => {
    const named = makeTrigger({ comment: 'go', type: 'manual' })
    expect(matchesTrigger(named, 'manual', 'go')).toBe(true)
    expect(matchesTrigger(named, 'manual', 'other')).toBe(false)
  })

  it('selects triggercode/triggerlua triggers regardless of mode', () => {
    const code = makeTrigger({
      type: 'output',
      effect: [{ type: 'triggercode', code: '' }],
    })
    const lua = makeTrigger({
      type: 'output',
      effect: [{ type: 'triggerlua', code: '' }],
    })
    expect(matchesTrigger(code, 'start')).toBe(true)
    expect(matchesTrigger(lua, 'input')).toBe(true)
  })

  it('preserves manual-name and code/Lua bypasses for singleton tuple modes', () => {
    const manual = makeTrigger({ comment: 'go', type: ['output'] })
    const code = makeTrigger({ type: ['output'], effect: [{ type: 'triggercode', code: '' }] })
    const lua = makeTrigger({ type: ['output'], effect: [{ type: 'triggerlua', code: '' }] })

    expect(matchesTrigger(manual, 'manual', 'go')).toBe(true)
    expect(matchesTrigger(manual, 'manual', 'other')).toBe(false)
    expect(matchesTrigger(code, 'start')).toBe(true)
    expect(matchesTrigger(lua, 'input')).toBe(true)
  })
})

describe('runTrigger shell', () => {
  it('no-trigger run returns null before structured cloning inputs', async () => {
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone')
    try {
      const char = makeChar({ triggerscript: [] })
      const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })

      expect(result).toBeNull()
      expect(cloneSpy).not.toHaveBeenCalled()
    } finally {
      cloneSpy.mockRestore()
    }
  })

  it('returns a result (not null) even when no trigger matches the mode', async () => {
    const char = makeChar({ triggerscript: [makeTrigger({ type: 'output' })] })
    const result = await runTrigger(ctx, char, 'start', { chat: makeChat() })
    expect(result).not.toBeNull()
    expect(result?.additonalSysPrompt).toEqual({
      start: '',
      historyend: '',
      promptend: '',
    })
    expect(result?.tokens).toBe(0)
  })

  it('does not mutate the input character or chat', async () => {
    const char = makeChar({ triggerscript: [makeTrigger({ type: 'output' })] })
    const chat = makeChat({ message: [{ role: 'char', data: 'hi' }] as never })
    const charSnapshot = structuredClone(char)
    const chatSnapshot = structuredClone(chat)

    await runTrigger(ctx, char, 'output', { chat })

    expect(char).toEqual(charSnapshot)
    expect(chat).toEqual(chatSnapshot)
  })

  it('threads stopSending, displayData, and tempVars through the result', async () => {
    const char = makeChar({ triggerscript: [makeTrigger({ type: 'output' })] })
    const tempVars = { a: '1' }
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat(),
      stopSending: true,
      displayData: 'disp',
      tempVars,
      recursiveCount: 2,
      triggerId: 'trig-1',
    })

    expect(result?.stopSending).toBe(true)
    expect(result?.sendAIprompt).toBe(false)
    expect(result?.displayData).toBe('disp')
    expect(result?.tempVars).toEqual({ a: '1' })
  })

  it('includes module triggers when the character has none of its own', async () => {
    const char = makeChar({ triggerscript: [] })
    const mod = makeModule({ trigger: [makeTrigger({ type: 'output' })] })
    const result = await runTrigger(makeCtx({ modules: [mod] }), char, 'output', {
      chat: makeChat(),
    })
    expect(result).not.toBeNull()
  })

  it('counts tokens of a pre-populated additonalSysPrompt', async () => {
    const char = makeChar({ triggerscript: [makeTrigger({ type: 'output' })] })
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat(),
      additonalSysPrompt: {
        start: 'hello world',
        historyend: '',
        promptend: 'done',
      },
    })
    expect(result?.tokens).toBeGreaterThan(0)
  })

  it('uses the caller chat directly in displayMode (no clone)', async () => {
    const char = makeChar({ triggerscript: [makeTrigger({ type: 'display' })] })
    const chat = makeChat()
    const result = await runTrigger(ctx, char, 'display', {
      chat,
      displayMode: true,
    })
    expect(result?.chat).toBe(chat)
  })

  it('skips a trigger whose condition fails but still returns a result', async () => {
    const char = makeChar({
      triggerscript: [
        makeTrigger({
          type: 'output',
          conditions: [cond({ type: 'value', var: '1', value: '2', operator: '=' })],
        }),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result).not.toBeNull()
    expect(result?.varChanged).toBe(false)
  })
})

describe('trigger clone narrowing', () => {
  const nonMutatingEffect = eff({
    type: 'v2GetMessageCount',
    outputVar: 'messageCount',
    indent: 0,
  })

  it.each(['input', 'start', 'output'] as const)(
    '%s triggers with no message-mutating effects do not clone the transcript',
    async (mode: TriggerMode) => {
      const char = makeChar({
        triggerscript: [
          makeTrigger({
            type: mode,
            effect: [nonMutatingEffect],
          }),
        ],
      })
      const chat = makeChat({
        message: [
          { role: 'user', data: 'one' },
          { role: 'char', data: 'two' },
        ] as never,
        scriptstate: { $existing: 'kept' },
      })

      const result = await runTrigger(ctx, char, mode, { chat })

      expect(result?.chat.message).toBe(chat.message)
      expect(result?.chat.scriptstate?.['$messageCount']).toBe('2')
      expect(chat.scriptstate?.['$messageCount']).toBeUndefined()
      expect(getTriggerCloneInstrumentation().fullTranscriptClones[mode]).toBe(0)
      expect(getTriggerCloneInstrumentation().messageSharingEnvelopeClones[mode]).toBe(1)
    },
  )

  it('mutating output triggers get a private transcript clone', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({ type: 'modifychat', index: '0', value: 'edited' }),
          eff({ type: 'impersonate', role: 'char', value: 'added' }),
        ]),
      ],
    })
    const chat = makeChat({
      message: [{ role: 'user', data: 'original' }] as never,
    })

    const result = await runTrigger(ctx, char, 'output', { chat })

    expect(result?.chat).not.toBe(chat)
    expect(result?.chat.message).not.toBe(chat.message)
    expect(result?.chat.message.map((message: Message) => message.data)).toEqual(['edited', 'added'])
    expect(chat.message.map((message: Message) => message.data)).toEqual(['original'])
    expect(getTriggerCloneInstrumentation().fullTranscriptClones.output).toBe(1)
  })

  it('triggerlua uses a private transcript because host functions can mutate chat', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'triggerlua', code: 'mutate()' })])],
    })
    const chat = makeChat({
      message: [{ role: 'user', data: 'original' }] as never,
    })
    const luaCtx = makeCtx({
      runLua: async ({ chat: luaChat }) => {
        luaChat.message[0].data = 'lua edit'
        return { chat: luaChat, stopSending: false }
      },
    })

    const result = await runTrigger(luaCtx, char, 'output', { chat })

    expect(result?.chat.message[0].data).toBe('lua edit')
    expect(chat.message[0].data).toBe('original')
    expect(getTriggerCloneInstrumentation().fullTranscriptClones.output).toBe(1)
  })

  it('passes module triggerlua source metadata to the Lua runner', async () => {
    const trigger = triggerWithEffects([eff({ type: 'triggerlua', code: 'mutate()' })])
    const char = makeChar({ triggerscript: [] })
    const chat = makeChat()
    const runLua = vi.fn(async (_args: { source?: unknown }) => ({ chat, stopSending: false }))
    const luaCtx = makeCtx({
      modules: [
        makeModule({
          id: 'mod-lua',
          name: 'Lua Mod',
          lowLevelAccess: true,
          trigger: [trigger],
        }),
      ],
      runLua,
    })

    await runTrigger(luaCtx, char, 'output', { chat })

    expect(runLua).toHaveBeenCalledTimes(1)
    const firstLuaCall = runLua.mock.calls[0]?.[0]
    expect(firstLuaCall?.source).toMatchObject({
      ownerType: 'module',
      ownerId: 'mod-lua',
      ownerName: 'Lua Mod',
      triggerIndex: 0,
      triggerComment: trigger.comment,
      triggerType: trigger.type,
      effectIndex: 0,
      effectType: 'triggerlua',
      lowLevelAccess: true,
    })
  })

  it('displayMode keeps the legacy caller-chat no-clone path', async () => {
    const char = makeChar({
      triggerscript: [
        makeTrigger({
          type: 'display',
          effect: [eff({ type: 'impersonate', role: 'char', value: 'skipped' })],
        }),
      ],
    })
    const chat = makeChat({ message: [{ role: 'user', data: 'shown' }] as never })

    const result = await runTrigger(ctx, char, 'display', {
      chat,
      displayMode: true,
    })

    expect(result?.chat).toBe(chat)
    expect(chat.message.map((message: Message) => message.data)).toEqual(['shown'])
    expect(getTriggerCloneInstrumentation().fullTranscriptClones.display).toBe(0)
    expect(getTriggerCloneInstrumentation().messageSharingEnvelopeClones.display).toBe(0)
  })
})

function cond(c: Record<string, unknown>): triggerCondition {
  return c as unknown as triggerCondition
}

interface EngineSetup {
  workingChat: Chat
  db: Database
}

function makeEngine(
  opts: {
    scriptstate?: Record<string, unknown>
    defaultVariables?: [string, string][]
    displayMode?: boolean
    tempVars?: Record<string, string>
  } = {},
): ReturnType<typeof createTriggerVarEngine> & EngineSetup {
  // dbChat is the persisted chat; workingChat is the clone runTrigger makes.
  const dbChat = makeChat({
    scriptstate: { ...(opts.scriptstate ?? {}) } as Record<string, string | number | boolean>,
  })
  const char = makeChar({ chats: [dbChat] })
  const db = makeDb({ characters: [char] })
  const workingChat = structuredClone(dbChat)
  const engine = createTriggerVarEngine({
    chat: workingChat,
    database: db,
    selectedCharID: 0,
    chatPage: 0,
    defaultVariables: opts.defaultVariables ?? [],
    displayMode: opts.displayMode,
    tempVars: opts.tempVars,
  })
  return Object.assign(engine, { workingChat, db })
}

describe('trigger var engine', () => {
  it('falls back to default variables, then null', () => {
    const engine = makeEngine({ defaultVariables: [['greet', 'hi']] })
    expect(engine.getVar('greet')).toBe('hi')
    expect(engine.getVar('missing')).toBe('null')
  })

  it('reads chat scriptstate', () => {
    const engine = makeEngine({ scriptstate: { $hp: '10' } })
    expect(engine.getVar('hp')).toBe('10')
  })

  it('writes scriptstate, flips varChanged, and propagates to the db chat', () => {
    const engine = makeEngine()
    expect(engine.setVar('hp', '5')).toBe(true)
    expect(engine.workingChat.scriptstate?.['$hp']).toBe('5')
    expect(engine.varChanged).toBe(true)
    // The persisted db chat now shares the working chat's scriptstate object.
    expect(engine.db.characters[0].chats[0].scriptstate).toBe(engine.workingChat.scriptstate)
  })

  it('skips an identical persistent write without marking or propagating state', () => {
    const engine = makeEngine({ scriptstate: { $hp: '5' } })
    const persistedState = engine.db.characters[0].chats[0].scriptstate

    expect(engine.setVar('hp', '5')).toBe(false)
    expect(engine.varChanged).toBe(false)
    expect(engine.db.characters[0].chats[0].scriptstate).toBe(persistedState)
    expect(engine.db.characters[0].chats[0].scriptstate).not.toBe(engine.workingChat.scriptstate)
  })

  it('local variables shadow scriptstate and stay local on write', () => {
    const engine = makeEngine({ scriptstate: { $x: 'global' } })
    engine.declareLocalVar('x', 'local', 0)
    expect(engine.getVar('x')).toBe('local')
    expect(engine.setVar('x', 'updated')).toBe(true)
    expect(engine.getVar('x')).toBe('updated')
    expect(engine.workingChat.scriptstate?.['$x']).toBe('global')
    expect(engine.varChanged).toBe(false)
  })

  it('reports identical local writes as unchanged', () => {
    const engine = makeEngine({ scriptstate: { $x: 'global' } })
    engine.declareLocalVar('x', 'local', 0)

    expect(engine.setVar('x', 'local')).toBe(false)
    expect(engine.setLocalVar('x', 'local', 0)).toBe(false)
    expect(engine.getVar('x')).toBe('local')
    expect(engine.varChanged).toBe(false)
  })

  it('clearLocalVarsAtIndent drops vars at or above the indent', () => {
    const engine = makeEngine()
    engine.declareLocalVar('a', '1', 0)
    engine.declareLocalVar('b', '2', 2)
    engine.setIndent(2)
    expect(engine.getVar('b')).toBe('2')
    engine.clearLocalVarsAtIndent(2)
    expect(engine.getVar('b')).toBe('null')
    expect(engine.getVar('a')).toBe('1')
  })

  it('displayMode keeps writes in tempVars and leaves scriptstate untouched', () => {
    const tempVars: Record<string, string> = {}
    const engine = makeEngine({ displayMode: true, tempVars })
    expect(engine.setVar('x', '5')).toBe(true)
    expect(engine.setVar('x', '5')).toBe(false)
    expect(tempVars.x).toBe('5')
    expect(engine.getVar('x')).toBe('5')
    expect(engine.workingChat.scriptstate?.['$x']).toBeUndefined()
    expect(engine.varChanged).toBe(false)
  })
})

describe('evaluateConditions', () => {
  it('passes a matching var condition and fails a mismatch', () => {
    const engine = makeEngine({ scriptstate: { $hp: '10' } })
    const chat = makeChat()
    expect(
      evaluateConditions([cond({ type: 'var', var: 'hp', value: '10', operator: '=' })], engine, chat, identityExpand),
    ).toBe(true)
    expect(
      evaluateConditions([cond({ type: 'var', var: 'hp', value: '5', operator: '=' })], engine, chat, identityExpand),
    ).toBe(false)
  })

  it('compares value literals and numeric operators', () => {
    const engine = makeEngine()
    const chat = makeChat()
    const check = (operator: string, left: string, right: string) =>
      evaluateConditions([cond({ type: 'value', var: left, value: right, operator })], engine, chat, identityExpand)
    expect(check('!=', '3', '4')).toBe(true)
    expect(check('>', '5', '4')).toBe(true)
    expect(check('<', '5', '4')).toBe(false)
    expect(check('>=', '4', '4')).toBe(true)
    expect(check('<=', '4', '4')).toBe(true)
    expect(check('true', 'true', '')).toBe(true)
    expect(check('true', 'false', '')).toBe(false)
  })

  it('checks the null operator against unset vars', () => {
    const engine = makeEngine()
    const chat = makeChat()
    expect(
      evaluateConditions(
        [cond({ type: 'var', var: 'missing', value: '', operator: 'null' })],
        engine,
        chat,
        identityExpand,
      ),
    ).toBe(true)
  })

  it('compares chatindex against the message count', () => {
    const engine = makeEngine()
    const chat = makeChat({
      message: [
        { role: 'user', data: 'a' },
        { role: 'char', data: 'b' },
      ] as never,
    })
    expect(
      evaluateConditions([cond({ type: 'chatindex', value: '2', operator: '=' })], engine, chat, identityExpand),
    ).toBe(true)
  })

  it('handles exists strict / loose / regex over the last depth messages', () => {
    const engine = makeEngine()
    const chat = makeChat({
      message: [{ role: 'char', data: 'hello world' }] as never,
    })
    const exists = (value: string, type2: string) =>
      evaluateConditions([cond({ type: 'exists', value, type2, depth: 1 })], engine, chat, identityExpand)
    expect(exists('world', 'strict')).toBe(true)
    expect(exists('planet', 'strict')).toBe(false)
    expect(exists('WORLD', 'loose')).toBe(true)
    expect(exists('wor.d', 'regex')).toBe(true)
  })

  it('requires every condition to pass', () => {
    const engine = makeEngine({ scriptstate: { $hp: '10' } })
    const chat = makeChat()
    expect(
      evaluateConditions(
        [
          cond({ type: 'var', var: 'hp', value: '10', operator: '=' }),
          cond({ type: 'value', var: '1', value: '2', operator: '=' }),
        ],
        engine,
        chat,
        identityExpand,
      ),
    ).toBe(false)
  })

  it('setChat repoints subsequent var writes', () => {
    const engine = makeEngine()
    const other = makeChat({ scriptstate: {} })
    engine.setChat(other)
    engine.setVar('x', '1')
    expect(other.scriptstate?.['$x']).toBe('1')
  })
})

function eff(e: Record<string, unknown>): triggerscript['effect'][number] {
  return e as unknown as triggerscript['effect'][number]
}

function triggerWithEffects(effect: triggerscript['effect'], overrides: Partial<triggerscript> = {}): triggerscript {
  return makeTrigger({ type: 'output', effect, ...overrides })
}

async function countRegexCompiles<T>(fn: () => Promise<T>): Promise<{ result: T; compiles: Map<string, number> }> {
  const RealRegExp = globalThis.RegExp
  const compiles = new Map<string, number>()
  class CountingRegExp extends RealRegExp {
    constructor(pattern: string | RegExp, flags?: string) {
      super(pattern as string, flags)
      const source = typeof pattern === 'string' ? pattern : pattern.source
      const regexFlags = flags ?? (typeof pattern === 'string' ? '' : pattern.flags)
      const key = `${source}/${regexFlags}`
      compiles.set(key, (compiles.get(key) ?? 0) + 1)
    }
  }
  ;(globalThis as { RegExp: RegExpConstructor }).RegExp = CountingRegExp as unknown as RegExpConstructor
  try {
    return { result: await fn(), compiles }
  } finally {
    ;(globalThis as { RegExp: RegExpConstructor }).RegExp = RealRegExp
  }
}

describe('deterministic V1 effects', () => {
  it('agrees with prompt CBS on a character-over-template default-backed variable', async () => {
    const chat = makeChat()
    const char = makeChar({
      chats: [chat],
      defaultVariables: 'mood=happy',
      triggerscript: [
        triggerWithEffects([eff({ type: 'setvar', operator: '=', var: 'matched', value: 'yes' })], {
          conditions: [cond({ type: 'var', var: 'mood', value: 'happy', operator: '=' })],
        }),
      ],
    })
    const database = makeDb({
      characters: [char],
      templateDefaultVariables: 'mood=template',
    })

    expect(expandVariables('{{getvar::mood}}', { database }).text).toBe('happy')
    const result = await runTrigger(makeCtx({ database }), char, 'output', { chat })
    expect(result?.chat.scriptstate?.['$matched']).toBe('yes')
  })

  it('setvar assigns and flips varChanged', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'setvar', operator: '=', var: 'hp', value: '5' })])],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$hp']).toBe('5')
    expect(result?.varChanged).toBe(true)
  })

  it('setvar applies numeric operators against the current value', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'setvar', operator: '+=', var: 'n', value: '2' })])],
    })
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $n: '3' } }),
    })
    expect(result?.chat.scriptstate?.['$n']).toBe('5')
  })

  it('systemprompt accumulates into a slot and counts tokens', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'systemprompt', location: 'start', value: 'You are a cat.' })])],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.additonalSysPrompt.start).toBe('You are a cat.\n\n')
    expect(result?.tokens).toBeGreaterThan(0)
  })

  it('impersonate appends a message', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'impersonate', role: 'user', value: 'hello' })])],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.message.at(-1)).toEqual({ role: 'user', data: 'hello' })
  })

  it('cutchat slices the message list', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'cutchat', start: '1', end: '3' })])],
    })
    const chat = makeChat({
      message: [
        { role: 'user', data: 'a' },
        { role: 'char', data: 'b' },
        { role: 'user', data: 'c' },
        { role: 'char', data: 'd' },
      ] as never,
    })
    const result = await runTrigger(ctx, char, 'output', { chat })
    expect(result?.chat.message.map((m) => m.data)).toEqual(['b', 'c'])
  })

  it('modifychat edits an existing row', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'modifychat', index: '0', value: 'edited' })])],
    })
    const chat = makeChat({ message: [{ role: 'char', data: 'orig' }] as never })
    const result = await runTrigger(ctx, char, 'output', { chat })
    expect(result?.chat.message[0].data).toBe('edited')
  })

  it('stop sets stopSending', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'stop' })])],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.stopSending).toBe(true)
  })

  it('runtrigger recurses into a named manual trigger and threads its result', async () => {
    const sub = makeTrigger({
      comment: 'sub',
      type: 'manual',
      effect: [eff({ type: 'setvar', operator: '=', var: 'hp', value: '99' })],
    })
    const outer = triggerWithEffects([eff({ type: 'runtrigger', value: 'sub' })])
    const char = makeChar({ triggerscript: [outer, sub] })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$hp']).toBe('99')
    expect(result?.varChanged).toBe(true)
  })

  it('runtrigger recursion terminates at the bound', async () => {
    const loop = makeTrigger({
      comment: 'loop',
      type: 'manual',
      effect: [eff({ type: 'runtrigger', value: 'loop' })],
    })
    const char = makeChar({ triggerscript: [loop] })
    const result = await runTrigger(ctx, char, 'manual', {
      chat: makeChat(),
      manualName: 'loop',
    })
    expect(result).not.toBeNull()
  })
})

describe('control flow', () => {
  it('runs the if body when the condition passes and skips it when it fails', async () => {
    const effects = [
      eff({
        type: 'v2If',
        condition: '=',
        source: 'x',
        targetType: 'value',
        target: '1',
        indent: 0,
      }),
      eff({
        type: 'v2SetVar',
        operator: '=',
        var: 'hit',
        valueType: 'value',
        value: 'yes',
        indent: 1,
      }),
      eff({ type: 'v2EndIndent', indent: 1 }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })

    const passed = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $x: '1' } }),
    })
    expect(passed?.chat.scriptstate?.['$hit']).toBe('yes')

    const failed = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $x: '0' } }),
    })
    expect(failed?.chat.scriptstate?.['$hit'] ?? 'null').toBe('null')
  })

  it('selects the else branch when the if is false', async () => {
    const effects = [
      eff({
        type: 'v2If',
        condition: '=',
        source: 'x',
        targetType: 'value',
        target: '1',
        indent: 0,
      }),
      eff({
        type: 'v2SetVar',
        operator: '=',
        var: 'branch',
        valueType: 'value',
        value: 'if',
        indent: 1,
      }),
      eff({ type: 'v2EndIndent', indent: 1 }),
      eff({ type: 'v2Else', indent: 0 }),
      eff({
        type: 'v2SetVar',
        operator: '=',
        var: 'branch',
        valueType: 'value',
        value: 'else',
        indent: 1,
      }),
      eff({ type: 'v2EndIndent', indent: 1 }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })

    const ifResult = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $x: '1' } }),
    })
    expect(ifResult?.chat.scriptstate?.['$branch']).toBe('if')

    const elseResult = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $x: '0' } }),
    })
    expect(elseResult?.chat.scriptstate?.['$branch']).toBe('else')
  })

  it.each([
    { target: '["a"]', expected: 'yes', label: 'source is absent from the target array' },
    { target: '["z"]', expected: undefined, label: 'source is present in the target array' },
    { target: 'not-json', expected: 'yes', label: 'target JSON is invalid' },
  ])('supports v2IfAdvanced ∉ when $label', async ({ target, expected }) => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2IfAdvanced',
            condition: '∉',
            sourceType: 'value',
            source: 'z',
            targetType: 'value',
            target,
            indent: 0,
          }),
          eff({
            type: 'v2SetVar',
            operator: '=',
            var: 'hit',
            valueType: 'value',
            value: 'yes',
            indent: 1,
          }),
          eff({ type: 'v2EndIndent', indent: 1 }),
        ]),
      ],
    })

    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })

    expect(result?.chat.scriptstate?.['$hit']).toBe(expected)
  })

  it('runs a counted loop N times', async () => {
    const effects = [
      eff({ type: 'v2LoopNTimes', valueType: 'value', value: '3', indent: 0 }),
      eff({
        type: 'v2SetVar',
        operator: '+=',
        var: 'count',
        valueType: 'value',
        value: '1',
        indent: 1,
      }),
      eff({ type: 'v2EndIndent', indent: 1, endOfLoop: true }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$count']).toBe('3')
  })

  it('v2BreakLoop exits the loop early', async () => {
    const effects = [
      eff({ type: 'v2LoopNTimes', valueType: 'value', value: '5', indent: 0 }),
      eff({
        type: 'v2SetVar',
        operator: '+=',
        var: 'count',
        valueType: 'value',
        value: '1',
        indent: 1,
      }),
      eff({ type: 'v2BreakLoop', indent: 1 }),
      eff({ type: 'v2EndIndent', indent: 1, endOfLoop: true }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$count']).toBe('1')
  })

  it('v2SetVar applies the %= operator', async () => {
    const effects = [
      eff({
        type: 'v2SetVar',
        operator: '%=',
        var: 'm',
        valueType: 'value',
        value: '3',
        indent: 0,
      }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $m: '7' } }),
    })
    expect(result?.chat.scriptstate?.['$m']).toBe('1')
  })

  it('clears local vars declared inside a block at v2EndIndent', async () => {
    const effects = [
      eff({
        type: 'v2If',
        condition: '=',
        source: 'x',
        targetType: 'value',
        target: '1',
        indent: 0,
      }),
      eff({
        type: 'v2DeclareLocalVar',
        var: 'loc',
        valueType: 'value',
        value: 'inside',
        indent: 1,
      }),
      eff({
        type: 'v2SetVar',
        operator: '=',
        var: 'captured',
        valueType: 'var',
        value: 'loc',
        indent: 1,
      }),
      eff({ type: 'v2EndIndent', indent: 1 }),
      eff({
        type: 'v2SetVar',
        operator: '=',
        var: 'after',
        valueType: 'var',
        value: 'loc',
        indent: 0,
      }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $x: '1' } }),
    })
    expect(result?.chat.scriptstate?.['$captured']).toBe('inside')
    expect(result?.chat.scriptstate?.['$after']).toBe('null')
  })

  it('v2StopTrigger halts the remaining effects', async () => {
    const effects = [
      eff({ type: 'v2SetVar', operator: '=', var: 'a', valueType: 'value', value: '1', indent: 0 }),
      eff({ type: 'v2StopTrigger', indent: 0 }),
      eff({ type: 'v2SetVar', operator: '=', var: 'b', valueType: 'value', value: '2', indent: 0 }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$a']).toBe('1')
    expect(result?.chat.scriptstate?.['$b'] ?? 'null').toBe('null')
  })

  it('v2RunTrigger recurses into a manual trigger via effect.target', async () => {
    const sub = makeTrigger({
      comment: 'sub',
      type: 'manual',
      effect: [
        eff({
          type: 'v2SetVar',
          operator: '=',
          var: 'hp',
          valueType: 'value',
          value: '42',
          indent: 0,
        }),
      ],
    })
    const outer = triggerWithEffects([eff({ type: 'v2RunTrigger', target: 'sub', indent: 0 })])
    const char = makeChar({ triggerscript: [outer, sub] })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$hp']).toBe('42')
    expect(result?.varChanged).toBe(true)
  })

  it('runs the deterministic V2 chat / prompt effects', async () => {
    const effects = [
      eff({ type: 'v2SystemPrompt', location: 'start', valueType: 'value', value: 'sys' }),
      eff({ type: 'v2Impersonate', role: 'user', valueType: 'value', value: 'hi' }),
      eff({
        type: 'v2ModifyChat',
        indexType: 'value',
        index: '0',
        valueType: 'value',
        value: 'edited',
      }),
    ]
    const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })
    const chat = makeChat({ message: [{ role: 'char', data: 'orig' }] as never })
    const result = await runTrigger(ctx, char, 'output', { chat })
    expect(result?.additonalSysPrompt.start).toBe('sys\n\n')
    expect(result?.chat.message[0].data).toBe('edited')
    expect(result?.chat.message.at(-1)).toEqual({ role: 'user', data: 'hi' })
  })
})

describe('sendAIprompt trigger parity', () => {
  it.each([
    ['sendAIprompt', eff({ type: 'sendAIprompt' })],
    ['v2SendAIprompt', eff({ type: 'v2SendAIprompt', indent: 0 })],
  ])('%s sets the resend flag when low-level access is enabled', async (_label, effect) => {
    const char = makeChar({
      lowLevelAccess: true,
      triggerscript: [triggerWithEffects([effect])],
    })
    const chat = makeChat({
      message: [{ role: 'user', data: 'original' }] as never,
      scriptstate: { $kept: 'yes' },
    })
    const chatSnapshot = structuredClone(chat)

    const result = await runTrigger(ctx, char, 'output', { chat })

    expect(result?.sendAIprompt).toBe(true)
    expect(result?.varChanged).toBe(false)
    expect(result?.chat.message).toBe(chat.message)
    expect(result?.chat.message).toEqual(chatSnapshot.message)
    expect(result?.chat.scriptstate).toEqual(chatSnapshot.scriptstate)
    expect(chat).toEqual(chatSnapshot)
  })

  it.each([
    ['sendAIprompt', eff({ type: 'sendAIprompt' })],
    ['v2SendAIprompt', eff({ type: 'v2SendAIprompt', indent: 0 })],
  ])('%s leaves the resend flag false without low-level access', async (_label, effect) => {
    const char = makeChar({
      lowLevelAccess: false,
      triggerscript: [triggerWithEffects([effect])],
    })
    const chat = makeChat({
      message: [{ role: 'char', data: 'unchanged' }] as never,
      scriptstate: { $kept: 'yes' },
    })
    const chatSnapshot = structuredClone(chat)

    const result = await runTrigger(ctx, char, 'output', { chat })

    expect(result?.sendAIprompt).toBe(false)
    expect(result?.varChanged).toBe(false)
    expect(result?.chat.message).toBe(chat.message)
    expect(result?.chat.message).toEqual(chatSnapshot.message)
    expect(result?.chat.scriptstate).toEqual(chatSnapshot.scriptstate)
    expect(chat).toEqual(chatSnapshot)
  })
})

describe('trigger budget and abort', () => {
  it('stops a never-breaking v2Loop at the shared loop-back ceiling', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const budget = createTriggerExecutionBudget({
        wallClockMs: 60_000,
        maxLoopBackEdges: 5,
        maxEffectSteps: 1_000,
      })
      const effects = [
        eff({ type: 'v2Loop', indent: 0 }),
        eff({
          type: 'v2SetVar',
          operator: '+=',
          var: 'count',
          valueType: 'value',
          value: '1',
          indent: 1,
        }),
        eff({ type: 'v2EndIndent', indent: 1, endOfLoop: true }),
      ]
      const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })

      const result = await runTrigger(ctx, char, 'output', {
        chat: makeChat(),
        triggerBudget: budget,
      })

      expect(result).not.toBeNull()
      expect(budget.stoppedReason).toBe('loopBackEdges')
      expect(Number(result?.chat.scriptstate?.['$count'])).toBeGreaterThan(0)
      expect(Number(result?.chat.scriptstate?.['$count'])).toBeLessThanOrEqual(6)
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('loopBackEdges'))
    } finally {
      debug.mockRestore()
    }
  })

  it('stops a huge v2LoopNTimes at the shared loop-back ceiling', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const budget = createTriggerExecutionBudget({
        wallClockMs: 60_000,
        maxLoopBackEdges: 4,
        maxEffectSteps: 1_000,
      })
      const effects = [
        eff({ type: 'v2LoopNTimes', valueType: 'value', value: '1000000', indent: 0 }),
        eff({
          type: 'v2SetVar',
          operator: '+=',
          var: 'count',
          valueType: 'value',
          value: '1',
          indent: 1,
        }),
        eff({ type: 'v2EndIndent', indent: 1, endOfLoop: true }),
      ]
      const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })

      const result = await runTrigger(ctx, char, 'output', {
        chat: makeChat(),
        triggerBudget: budget,
      })

      expect(result).not.toBeNull()
      expect(budget.stoppedReason).toBe('loopBackEdges')
      expect(Number(result?.chat.scriptstate?.['$count'])).toBeGreaterThan(0)
      expect(Number(result?.chat.scriptstate?.['$count'])).toBeLessThanOrEqual(5)
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('loopBackEdges'))
    } finally {
      debug.mockRestore()
    }
  })

  it('low-level self-recursive v2RunTrigger cannot bypass the hard depth cap', async () => {
    const budget = createTriggerExecutionBudget({
      wallClockMs: 60_000,
      maxEffectSteps: 1_000,
      maxRecursionDepth: 3,
    })
    const self = makeTrigger({
      comment: 'self',
      type: 'manual',
      effect: [eff({ type: 'v2RunTrigger', target: 'self', indent: 0 })],
    })
    const char = makeChar({ lowLevelAccess: true, triggerscript: [self] })

    const result = await runTrigger(ctx, char, 'manual', {
      chat: makeChat(),
      manualName: 'self',
      triggerBudget: budget,
    })

    expect(result).not.toBeNull()
    expect(budget.stoppedReason).toBeUndefined()
    expect(budget.effectSteps).toBeLessThanOrEqual(4)
  })

  it('aborts a running trigger pass through AbortSignal', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const controller = new AbortController()
      const budget = createTriggerExecutionBudget({
        wallClockMs: 60_000,
        maxLoopBackEdges: 10_000,
        maxEffectSteps: 100_000,
      })
      const effects = [
        eff({ type: 'v2Loop', indent: 0 }),
        eff({
          type: 'v2SetVar',
          operator: '+=',
          var: 'count',
          valueType: 'value',
          value: '1',
          indent: 1,
        }),
        eff({ type: 'v2EndIndent', indent: 1, endOfLoop: true }),
      ]
      const char = makeChar({ triggerscript: [triggerWithEffects(effects)] })

      setTimeout(() => controller.abort(), 0)
      const result = await runTrigger(makeCtx({ signal: controller.signal }), char, 'output', {
        chat: makeChat(),
        triggerBudget: budget,
      })

      expect(result).not.toBeNull()
      expect(controller.signal.aborted).toBe(true)
      expect(budget.stoppedReason).toBe('aborted')
      expect(Number(result?.chat.scriptstate?.['$count'])).toBeGreaterThan(0)
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('aborted'))
    } finally {
      debug.mockRestore()
    }
  })
})

describe('trigger transcript and regex cache', () => {
  it('reuses transcript windows across exists conditions and quick-search effects', () => {
    const cache = createTriggerRunCache()
    const engine = makeEngine()
    const char = makeChar()
    const chat = makeChat({
      message: [
        { role: 'user', data: 'alpha beta' },
        { role: 'char', data: 'quick Needle42' },
      ] as never,
    })
    const sliceSpy = vi.spyOn(chat.message, 'slice')

    expect(
      evaluateConditions(
        [
          cond({ type: 'exists', value: 'quick', type2: 'strict', depth: 2 }),
          cond({ type: 'exists', value: 'needle', type2: 'loose', depth: 2 }),
        ],
        engine,
        chat,
        identityExpand,
        cache,
      ),
    ).toBe(true)

    applyV2DataEffect(
      eff({
        type: 'v2QuickSearchChat',
        valueType: 'value',
        value: 'beta',
        depthType: 'value',
        depth: '2',
        condition: 'strict',
        outputVar: 'qs1',
      }),
      { engine, expand: identityExpand, chat, char, triggerCache: cache },
    )
    applyV2DataEffect(
      eff({
        type: 'v2QuickSearchChat',
        valueType: 'value',
        value: 'needle',
        depthType: 'value',
        depth: '2',
        condition: 'loose',
        outputVar: 'qs2',
      }),
      { engine, expand: identityExpand, chat, char, triggerCache: cache },
    )

    expect(sliceSpy).toHaveBeenCalledTimes(1)
  })

  it('invalidates transcript cache after trigger message mutations', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2QuickSearchChat',
            valueType: 'value',
            value: 'old',
            depthType: 'value',
            depth: '1',
            condition: 'strict',
            outputVar: 'before',
          }),
          eff({
            type: 'v2ModifyChat',
            indexType: 'value',
            index: '0',
            valueType: 'value',
            value: 'new token',
          }),
          eff({
            type: 'v2QuickSearchChat',
            valueType: 'value',
            value: 'old',
            depthType: 'value',
            depth: '1',
            condition: 'strict',
            outputVar: 'afterOld',
          }),
          eff({
            type: 'v2QuickSearchChat',
            valueType: 'value',
            value: 'new',
            depthType: 'value',
            depth: '1',
            condition: 'strict',
            outputVar: 'afterNew',
          }),
        ]),
      ],
    })
    const chat = makeChat({ message: [{ role: 'char', data: 'old token' }] as never })

    const result = await runTrigger(ctx, char, 'output', { chat })

    expect(result?.chat.scriptstate?.['$before']).toBe('1')
    expect(result?.chat.scriptstate?.['$afterOld']).toBe('0')
    expect(result?.chat.scriptstate?.['$afterNew']).toBe('1')
  })

  it('reuses compiled regexes across trigger conditions and V2 effects', async () => {
    const char = makeChar({
      triggerscript: [
        makeTrigger({
          type: 'output',
          conditions: [
            cond({ type: 'exists', value: 'needle\\d', type2: 'regex', depth: 1 }),
            cond({ type: 'exists', value: 'needle\\d', type2: 'regex', depth: 1 }),
          ],
          effect: [
            eff({
              type: 'v2RegexTest',
              valueType: 'value',
              value: 'hello l6-world',
              regexType: 'value',
              regex: 'l6-w[a-z]+',
              flagsType: 'value',
              flags: 'g',
              outputVar: 'hit1',
            }),
            eff({
              type: 'v2RegexTest',
              valueType: 'value',
              value: 'hello l6-world',
              regexType: 'value',
              regex: 'l6-w[a-z]+',
              flagsType: 'value',
              flags: 'g',
              outputVar: 'hit2',
            }),
            eff({
              type: 'v2ReplaceString',
              sourceType: 'value',
              source: 'l6-a1 l6-a2',
              regexType: 'value',
              regex: 'l6-a(\\d)',
              resultType: 'value',
              result: '[$1]',
              replacementType: 'value',
              replacement: '',
              flagsType: 'value',
              flags: 'g',
              outputVar: 'rep1',
            }),
            eff({
              type: 'v2ReplaceString',
              sourceType: 'value',
              source: 'l6-a1 l6-a2',
              regexType: 'value',
              regex: 'l6-a(\\d)',
              resultType: 'value',
              result: '[$1]',
              replacementType: 'value',
              replacement: '',
              flagsType: 'value',
              flags: 'g',
              outputVar: 'rep2',
            }),
            eff({
              type: 'v2SplitString',
              sourceType: 'value',
              source: 'a,b;c',
              delimiterType: 'regex',
              delimiter: '/[,;]/g',
              outputVar: 'split1',
            }),
            eff({
              type: 'v2SplitString',
              sourceType: 'value',
              source: 'a,b;c',
              delimiterType: 'regex',
              delimiter: '/[,;]/g',
              outputVar: 'split2',
            }),
          ],
        }),
      ],
    })
    const chat = makeChat({ message: [{ role: 'char', data: 'needle7' }] as never })

    const { result, compiles } = await countRegexCompiles(() => runTrigger(ctx, char, 'output', { chat }))

    expect(result?.chat.scriptstate?.['$hit1']).toBe('1')
    expect(result?.chat.scriptstate?.['$hit2']).toBe('1')
    expect(result?.chat.scriptstate?.['$rep1']).toBe('[1] [2]')
    expect(result?.chat.scriptstate?.['$rep2']).toBe('[1] [2]')
    expect(result?.chat.scriptstate?.['$split1']).toBe('["a","b","c"]')
    expect(result?.chat.scriptstate?.['$split2']).toBe('["a","b","c"]')
    expect(compiles.get('needle\\d/')).toBe(1)
    expect(compiles.get('l6-w[a-z]+/g')).toBe(1)
    expect(compiles.get('l6-a(\\d)/g')).toBe(1)
    expect(compiles.get('[,;]/g')).toBe(1)
  })

  it('keeps malformed V2 regex fallback behavior with the cache enabled', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'abc',
            regexType: 'value',
            regex: '[',
            flagsType: 'value',
            flags: '',
            outputVar: 'test',
          }),
          eff({
            type: 'v2ReplaceString',
            sourceType: 'value',
            source: 'abc',
            regexType: 'value',
            regex: '[',
            resultType: 'value',
            result: '$0',
            replacementType: 'value',
            replacement: 'x',
            flagsType: 'value',
            flags: '',
            outputVar: 'replace',
          }),
          eff({
            type: 'v2SplitString',
            sourceType: 'value',
            source: 'a[b',
            delimiterType: 'regex',
            delimiter: '[',
            outputVar: 'split',
          }),
        ]),
      ],
    })

    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })

    expect(result?.chat.scriptstate?.['$test']).toBe('0')
    expect(result?.chat.scriptstate?.['$replace']).toBe('abc')
    expect(result?.chat.scriptstate?.['$split']).toBe('["a[b"]')
  })

  it('preserves valid trigger regex behavior under bounds', async () => {
    const char = makeChar({
      triggerscript: [
        makeTrigger({
          type: 'output',
          conditions: [cond({ type: 'exists', value: 'quick\\s+fox', type2: 'regex', depth: 2 })],
          effect: [
            eff({
              type: 'v2SplitString',
              sourceType: 'value',
              source: 'red,green;blue',
              delimiterType: 'regex',
              delimiter: '/[,;]/g',
              outputVar: 'split',
            }),
            eff({
              type: 'v2ReplaceString',
              sourceType: 'value',
              source: 'cat-12 dog-34',
              regexType: 'value',
              regex: '(cat|dog)-(\\d+)',
              resultType: 'value',
              result: '$2:$1',
              replacementType: 'value',
              replacement: '',
              flagsType: 'value',
              flags: 'g',
              outputVar: 'replace',
            }),
            eff({
              type: 'v2RegexTest',
              valueType: 'value',
              value: 'room 42',
              regexType: 'value',
              regex: 'room\\s+(\\d+)',
              flagsType: 'value',
              flags: '',
              outputVar: 'test',
            }),
            eff({
              type: 'v2QuickSearchChat',
              valueType: 'value',
              value: 'quick\\s+fox',
              depthType: 'value',
              depth: '2',
              condition: 'regex',
              outputVar: 'quick',
            }),
          ],
        }),
      ],
    })
    const chat = makeChat({
      message: [
        { role: 'user', data: 'filler' },
        { role: 'char', data: 'the quick fox jumps' },
      ] as never,
    })

    const result = await runTrigger(ctx, char, 'output', { chat })

    expect(result?.chat.scriptstate).toMatchObject({
      $split: '["red","green","blue"]',
      $replace: '12:cat 34:dog',
      $test: '1',
      $quick: '1',
    })
  })

  it('rejects unsafe trigger regexes before synchronous execution', async () => {
    const unsafeTrigger = (effect: triggerscript['effect'][number]) =>
      makeChar({ triggerscript: [triggerWithEffects([effect])] })
    const limitedCtx = {
      ...ctx,
      database: {
        ...ctx.database,
        complexRegexCompatibilityMode: 'worker' as const,
        complexRegexOutputTimeoutMs: 15_000,
        regexOutputSizeLimitMiB: 1,
      },
    }

    await expect(
      runTrigger(
        ctx,
        unsafeTrigger(
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'a'.repeat(32) + '!',
            regexType: 'value',
            regex: '(a+)+$',
            flagsType: 'value',
            flags: '',
            outputVar: 'out',
          }),
        ),
        'output',
        { chat: makeChat() },
      ),
    ).rejects.toThrow(/bounded regex rejected: trigger v2RegexTest pattern: complexity screen/)

    await expect(
      runTrigger(
        limitedCtx,
        unsafeTrigger(
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'x',
            regexType: 'value',
            regex: 'x'.repeat(BOUNDED_REGEX_LIMITS.pattern + 1),
            flagsType: 'value',
            flags: '',
            outputVar: 'out',
          }),
        ),
        'output',
        { chat: makeChat() },
      ),
    ).rejects.toThrow(/pattern length/)

    await expect(
      runTrigger(
        ctx,
        unsafeTrigger(
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'x'.repeat(BOUNDED_REGEX_LIMITS.haystack + 1),
            regexType: 'value',
            regex: 'x',
            flagsType: 'value',
            flags: '',
            outputVar: 'out',
          }),
        ),
        'output',
        { chat: makeChat() },
      ),
    ).rejects.toThrow(/haystack length/)

    await expect(
      runTrigger(
        limitedCtx,
        unsafeTrigger(
          eff({
            type: 'v2ReplaceString',
            sourceType: 'value',
            source: 'x',
            regexType: 'value',
            regex: 'x',
            resultType: 'value',
            result: '$0',
            replacementType: 'value',
            replacement: 'r'.repeat(1024 * 1024 + 1),
            flagsType: 'value',
            flags: '',
            outputVar: 'out',
          }),
        ),
        'output',
        { chat: makeChat() },
      ),
    ).rejects.toThrow(/replacement length/)
  })

  it('rejects unsafe trigger condition regex before execution', async () => {
    const char = makeChar({
      triggerscript: [
        makeTrigger({
          type: 'output',
          conditions: [cond({ type: 'exists', value: '(a+)+$', type2: 'regex', depth: 1 })],
          effect: [eff({ type: 'setvar', operator: '=', var: 'hit', value: '1' })],
        }),
      ],
    })
    const chat = makeChat({
      message: [{ role: 'user', data: 'a'.repeat(32) + '!' }] as never,
    })

    await expect(runTrigger(ctx, char, 'output', { chat })).rejects.toThrow(
      /bounded regex rejected: trigger condition regex pattern: complexity screen/,
    )
  })
})

describe('safe data helpers', () => {
  it('concatenates strings into an output var', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2ConcatString',
            source1Type: 'value',
            source1: 'foo',
            source2Type: 'value',
            source2: 'bar',
            outputVar: 'out',
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$out']).toBe('foobar')
  })

  it('round-trips an array var through make / push / length / pop', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({ type: 'v2MakeArrayVar', var: 'arr' }),
          eff({ type: 'v2PushArrayVar', var: 'arr', valueType: 'value', value: 'x' }),
          eff({ type: 'v2PushArrayVar', var: 'arr', valueType: 'value', value: 'y' }),
          eff({ type: 'v2GetArrayVarLength', var: 'arr', outputVar: 'len' }),
          eff({ type: 'v2PopArrayVar', var: 'arr', outputVar: 'popped' }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$len']).toBe('2')
    expect(result?.chat.scriptstate?.['$popped']).toBe('y')
    expect(result?.chat.scriptstate?.['$arr']).toBe('["x"]')
  })

  it('sets, gets, and checks a dict key', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({ type: 'v2MakeDictVar', var: 'd' }),
          eff({
            type: 'v2SetDictVar',
            varType: 'var',
            var: 'd',
            keyType: 'value',
            key: 'k',
            valueType: 'value',
            value: 'v',
          }),
          eff({
            type: 'v2GetDictVar',
            varType: 'var',
            var: 'd',
            keyType: 'value',
            key: 'k',
            outputVar: 'got',
          }),
          eff({
            type: 'v2HasDictKey',
            varType: 'var',
            var: 'd',
            keyType: 'value',
            key: 'k',
            outputVar: 'has',
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$got']).toBe('v')
    expect(result?.chat.scriptstate?.['$has']).toBe('1')
  })

  it('evaluates a calculation with $var substitution', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2Calculate',
            expressionType: 'value',
            expression: '($a + 2) * 3',
            outputVar: 'calc',
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', {
      chat: makeChat({ scriptstate: { $a: '4' } }),
    })
    expect(result?.chat.scriptstate?.['$calc']).toBe('18')
  })

  it('tokenizes to a positive count', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2Tokenize',
            valueType: 'value',
            value: 'hello world foo bar',
            outputVar: 'tok',
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(Number(result?.chat.scriptstate?.['$tok'])).toBeGreaterThan(0)
  })

  it('regex-tests for a hit and a miss', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'hello',
            regexType: 'value',
            regex: '^h',
            flagsType: 'value',
            flags: '',
            outputVar: 'hit',
          }),
          eff({
            type: 'v2RegexTest',
            valueType: 'value',
            value: 'hello',
            regexType: 'value',
            regex: '^z',
            flagsType: 'value',
            flags: '',
            outputVar: 'miss',
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result?.chat.scriptstate?.['$hit']).toBe('1')
    expect(result?.chat.scriptstate?.['$miss']).toBe('0')
  })

  it('extracts the first regex match and expands $n, $&, and $$ without low-level access', async () => {
    const char = makeChar({
      lowLevelAccess: false,
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2ExtractRegex',
            valueType: 'value',
            value: 'ID=42; ID=99',
            regexType: 'value',
            regex: 'ID=(\\d+)',
            flagsType: 'value',
            flags: 'g',
            resultType: 'value',
            result: '$1|$&|$$|$9',
            outputVar: 'extracted',
          }),
        ]),
      ],
    })

    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })

    expect(result?.chat.scriptstate?.['$extracted']).toBe('42|ID=42|$|')
  })

  it('writes the capture-stripped result template when v2ExtractRegex has no match', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2ExtractRegex',
            valueType: 'value',
            value: 'no id here',
            regexType: 'value',
            regex: 'ID=(\\d+)',
            flagsType: 'value',
            flags: '',
            resultType: 'value',
            result: '[$1][$&][$$]',
            outputVar: 'extracted',
          }),
        ]),
      ],
    })

    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })

    expect(result?.chat.scriptstate?.['$extracted']).toBe('[][][$]')
  })

  it('rejects an invalid v2ExtractRegex pattern before changing the output variable', async () => {
    const chat = makeChat({ scriptstate: { $extracted: 'kept' } })
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2ExtractRegex',
            valueType: 'value',
            value: 'ID=42',
            regexType: 'value',
            regex: '[',
            flagsType: 'value',
            flags: '',
            resultType: 'value',
            result: '$1',
            outputVar: 'extracted',
          }),
        ]),
      ],
    })

    await expect(runTrigger(ctx, char, 'output', { chat })).rejects.toThrow(SyntaxError)
    expect(chat.scriptstate?.['$extracted']).toBe('kept')
  })

  it('quick-searches the recent chat', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2QuickSearchChat',
            valueType: 'value',
            value: 'quick',
            depthType: 'value',
            depth: '1',
            condition: 'strict',
            outputVar: 'qs',
          }),
        ]),
      ],
    })
    const chat = makeChat({ message: [{ role: 'char', data: 'the quick brown fox' }] as never })
    const result = await runTrigger(ctx, char, 'output', { chat })
    expect(result?.chat.scriptstate?.['$qs']).toBe('1')
  })

  it('reads the last message', async () => {
    const char = makeChar({
      triggerscript: [triggerWithEffects([eff({ type: 'v2GetLastMessage', outputVar: 'last' })])],
    })
    const chat = makeChat({
      message: [
        { role: 'user', data: 'first' },
        { role: 'char', data: 'second' },
      ] as never,
    })
    const result = await runTrigger(ctx, char, 'output', { chat })
    expect(result?.chat.scriptstate?.['$last']).toBe('second')
  })

  it.each([
    { type: 'v2MakeArrayVar', var: '[]' },
    { type: 'v2MakeDictVar', var: '{}' },
    { type: 'v2ClearDict', var: '{}' },
    { type: 'v2GetDisplayState' },
    { type: 'v2SetDisplayState' },
    { type: 'v2GetRequestState' },
    { type: 'v2SetRequestState' },
    { type: 'v2GetRequestStateRole' },
    { type: 'v2SetRequestStateRole' },
    { type: 'v2GetRequestStateLength' },
  ])('retains the whole-trigger guard for $type before later effects', async (badEffect) => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects([
          eff({
            type: 'v2SetVar',
            operator: '=',
            var: 'beforeAbort',
            valueType: 'value',
            value: 'kept',
            indent: 0,
          }),
          eff(badEffect),
          eff({
            type: 'v2SetVar',
            operator: '=',
            var: 'after',
            valueType: 'value',
            value: 'ok',
            indent: 0,
          }),
        ]),
      ],
    })
    const result = await runTrigger(ctx, char, 'output', { chat: makeChat() })
    expect(result).toMatchObject({ aborted: true, varChanged: true })
    expect(result?.chat.scriptstate?.['$beforeAbort']).toBe('kept')
    expect(result?.chat.scriptstate?.['$after']).toBeUndefined()
  })
})

describe('unsupported trigger effects', () => {
  it.each([...serverUnsupportedTriggerEffectTypes].filter((type) => type !== '@@emo'))(
    'keeps %s as a diagnosed no-op without partially mutating trigger state',
    async (type) => {
      const chat = makeChat({ scriptstate: { $before: 'kept' } })
      const char = makeChar({
        chats: [chat],
        triggerscript: [triggerWithEffects([eff({ type })])],
      })
      const database = makeDb({ characters: [char] })
      const unsupportedEffectTypes = new Set<string>()
      const before = structuredClone({ char, chat })

      const result = await runTrigger(makeCtx({ database, unsupportedEffectTypes }), char, 'output', { chat })

      expect(result?.chat.scriptstate).toEqual({ $before: 'kept' })
      expect(char).toEqual(before.char)
      expect(chat).toEqual(before.chat)
      expect(unsupportedEffectTypes).toEqual(new Set([type]))
    },
  )
})

describe('request/display state adapters', () => {
  it('round-trips display text through set then get', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects(
          [
            eff({ type: 'v2SetDisplayState', valueType: 'value', value: 'new text', indent: 0 }),
            eff({ type: 'v2GetDisplayState', outputVar: 'd', indent: 0 }),
          ],
          { type: 'display' },
        ),
      ],
    })
    const tempVars: Record<string, string> = {}
    const result = await runTrigger(ctx, char, 'display', {
      chat: makeChat(),
      displayMode: true,
      displayData: 'initial',
      tempVars,
    })
    expect(result?.displayData).toBe('new text')
    expect(tempVars.d).toBe('new text')
  })

  it('reads and writes content, role, and length over an OpenAIChat[] payload', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects(
          [
            eff({ type: 'v2GetRequestStateLength', outputVar: 'len', indent: 0 }),
            eff({
              type: 'v2GetRequestState',
              indexType: 'value',
              index: '0',
              outputVar: 'c0',
              indent: 0,
            }),
            eff({
              type: 'v2GetRequestStateRole',
              indexType: 'value',
              index: '0',
              outputVar: 'r0',
              indent: 0,
            }),
            eff({
              type: 'v2SetRequestState',
              indexType: 'value',
              index: '1',
              valueType: 'value',
              value: 'changed',
              indent: 0,
            }),
            eff({
              type: 'v2SetRequestStateRole',
              indexType: 'value',
              index: '0',
              valueType: 'value',
              value: 'system',
              indent: 0,
            }),
          ],
          { type: 'request' },
        ),
      ],
    })
    const tempVars: Record<string, string> = {}
    const payload = JSON.stringify([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    const result = await runTrigger(ctx, char, 'request', {
      chat: makeChat(),
      displayMode: true,
      displayData: payload,
      tempVars,
    })
    expect(tempVars.len).toBe('2')
    expect(tempVars.c0).toBe('hello')
    expect(tempVars.r0).toBe('user')
    const out = JSON.parse(result?.displayData ?? 'null')
    expect(out[1].content).toBe('changed')
    expect(out[0].role).toBe('system')
  })

  it('leaves the role unchanged when v2SetRequestStateRole gets an invalid value', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects(
          [
            eff({
              type: 'v2SetRequestStateRole',
              indexType: 'value',
              index: '0',
              valueType: 'value',
              value: 'bogus',
              indent: 0,
            }),
          ],
          { type: 'request' },
        ),
      ],
    })
    const payload = JSON.stringify([{ role: 'user', content: 'hello' }])
    const result = await runTrigger(ctx, char, 'request', {
      chat: makeChat(),
      displayMode: true,
      displayData: payload,
      tempVars: {},
    })
    const out = JSON.parse(result?.displayData ?? 'null')
    expect(out[0].role).toBe('user')
  })

  it('skips a non-allowlisted effect in display mode but runs allowlisted ones', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects(
          [
            eff({ type: 'v2GetLastMessage', outputVar: 'skipped', indent: 0 }),
            eff({
              type: 'v2SetVar',
              operator: '=',
              var: 'ran',
              valueType: 'value',
              value: 'yes',
              indent: 0,
            }),
          ],
          { type: 'display' },
        ),
      ],
    })
    const tempVars: Record<string, string> = {}
    const chat = makeChat({ message: [{ role: 'char', data: 'last line' }] as never })
    await runTrigger(ctx, char, 'display', {
      chat,
      displayMode: true,
      displayData: '',
      tempVars,
    })
    expect(tempVars.skipped).toBeUndefined()
    expect(tempVars.ran).toBe('yes')
  })

  it('skips a non-allowlisted effect in request mode', async () => {
    const char = makeChar({
      triggerscript: [
        triggerWithEffects(
          [
            eff({ type: 'v2GetMessageCount', outputVar: 'skipped', indent: 0 }),
            eff({ type: 'v2GetRequestStateLength', outputVar: 'len', indent: 0 }),
          ],
          { type: 'request' },
        ),
      ],
    })
    const tempVars: Record<string, string> = {}
    const payload = JSON.stringify([{ role: 'user', content: 'hello' }])
    await runTrigger(ctx, char, 'request', {
      chat: makeChat({ message: [{ role: 'user', data: 'x' }] as never }),
      displayMode: true,
      displayData: payload,
      tempVars,
    })
    expect(tempVars.skipped).toBeUndefined()
    expect(tempVars.len).toBe('1')
  })
})
