import { describe, expect, it } from 'vitest'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
} from '../src/prompt/serverTypes.js'
import type { ServerModule as RisuModule } from '../src/prompt/moduleDescriptors.js'
import { getActiveModules } from '../src/prompt/modules.js'

/**
 * Audit L1 (Phase 2): `getActiveModules` used to re-scan + re-dedupe the full
 * modules collection on every call — ~8× per assembly with identical inputs.
 * The memo is keyed on the loaded `Database` object (WeakMap) plus the
 * requested-id list and the `database.modules` array reference, so repeat
 * calls within one assembly are cache hits while any input change — and any
 * fresh per-request database load — recomputes.
 */

function makeModule(id: string, overrides: Partial<RisuModule> = {}): RisuModule {
  return { id, name: `Module ${id}`, description: '', ...overrides } as RisuModule
}

function makeDatabase(overrides: Partial<Database> = {}): Database {
  return {
    enabledModules: ['mod-a'],
    modules: [makeModule('mod-a'), makeModule('mod-b'), makeModule('mod-c')],
    characters: [],
    ...overrides,
  } as unknown as Database
}

function makeCharacter(overrides: Partial<character> = {}): character {
  return { type: 'character', chaId: 'char-1', chats: [], ...overrides } as unknown as character
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return { id: 'chat-1', message: [], ...overrides } as unknown as Chat
}

describe('getActiveModules per-assembly memo', () => {
  it('returns the same resolved array for repeat calls with identical inputs', () => {
    const db = makeDatabase()
    const char = makeCharacter({ modules: ['mod-b'] } as Partial<character>)
    const chat = makeChat()

    const first = getActiveModules(db, char, chat)
    expect(first.map((m) => m.id)).toEqual(['mod-a', 'mod-b'])

    // Memo hit: the exact same array object, not a fresh scan result.
    expect(getActiveModules(db, char, chat)).toBe(first)
    // Identity differences in the char/chat wrappers do not matter — only the
    // requested-id inputs key the memo (triggers pass a cloned chat).
    expect(getActiveModules(db, makeCharacter({ modules: ['mod-b'] } as Partial<character>), makeChat())).toBe(first)
  })

  it('recomputes when the requested module ids change', () => {
    const db = makeDatabase()
    const char = makeCharacter()
    const chat = makeChat()

    const before = getActiveModules(db, char, chat)
    expect(before.map((m) => m.id)).toEqual(['mod-a'])

    const chatWithModule = makeChat({ modules: ['mod-c'] } as Partial<Chat>)
    const after = getActiveModules(db, char, chatWithModule)
    expect(after).not.toBe(before)
    expect(after.map((m) => m.id)).toEqual(['mod-a', 'mod-c'])
  })

  it('recomputes when the database.modules array is replaced', () => {
    const db = makeDatabase()
    const char = makeCharacter()
    const chat = makeChat()

    const before = getActiveModules(db, char, chat)
    expect(before.map((m) => m.name)).toEqual(['Module mod-a'])

    db.modules = [makeModule('mod-a', { name: 'Renamed' } as Partial<RisuModule>)]
    const after = getActiveModules(db, char, chat)
    expect(after).not.toBe(before)
    expect(after.map((m) => m.name)).toEqual(['Renamed'])
  })

  it('never leaks a memo entry across database objects (per-request isolation)', () => {
    const char = makeCharacter()
    const chat = makeChat()

    const dbA = makeDatabase()
    const fromA = getActiveModules(dbA, char, chat)

    // Same requested ids, different (fresh per-request) database object whose
    // module content differs — must resolve against the new object.
    const dbB = makeDatabase({
      modules: [makeModule('mod-a', { name: 'Other request' } as Partial<RisuModule>)],
    } as Partial<Database>)
    const fromB = getActiveModules(dbB, char, chat)
    expect(fromB).not.toBe(fromA)
    expect(fromB.map((m) => m.name)).toEqual(['Other request'])
  })

  it('keeps namespace matching and dedupe semantics through the memo', () => {
    const db = makeDatabase({
      enabledModules: ['ns-shared'],
      modules: [
        makeModule('mod-x', { namespace: 'ns-shared' } as Partial<RisuModule>),
        makeModule('mod-y', { namespace: 'ns-shared' } as Partial<RisuModule>),
      ],
    } as Partial<Database>)
    const char = makeCharacter({ modules: ['mod-x'] } as Partial<character>)

    const resolved = getActiveModules(db, char, makeChat())
    expect(resolved.map((m) => m.id)).toEqual(['mod-x', 'mod-y'])
    expect(getActiveModules(db, char, makeChat())).toBe(resolved)
  })
})
