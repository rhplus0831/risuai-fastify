import fc from 'fast-check'
import { writable } from 'svelte/store'
import { beforeEach, expect, test, vi } from 'vitest'
import { risuChatParser } from '../../parser.svelte'
import { registerRisuChatParserMatcher } from '../../risuChatParser'
import { cbs, validCBSArgProp } from './lib'
import { PHASE9_CBS_COMPATIBILITY_CORPUS } from '../../../../../test/fixtures/phase9CompatibilityCorpus'
import { charactersResourceState, settingsResourceState } from '../../../server/resourceState.svelte'

//#region module mocks

vi.mock(
  import('../../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => ({}),
      getDatabase: () => mocks.db,
      reapplyPendingPresetProjections: () => {},
    }) as unknown as typeof import('../../../storage/database.svelte'),
)

vi.mock(import('../../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(''),
}))

const mocks = vi.hoisted(() => {
  const varStorage = {} as Record<string, unknown>

  return {
    db: {
      characters: [
        {
          chaId: 'strings-character',
          chatPage: 0,
          chats: [
            {
              id: 'strings-chat',
              message: [],
              scriptstate: varStorage,
            },
          ],
          defaultVariables: '',
        },
      ],
      globalChatVariables: varStorage,
      templateDefaultVariables: '',
    },
    varStorage,
  }
})

vi.mock(import('../../../stores.svelte'), () => {
  return {
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as typeof import('../../../stores.svelte')
})

//#endregion

const validCBSArgPropLong = validCBSArgProp.filter((s) => s.length > 1)

beforeEach(() => {
  charactersResourceState.characters = mocks.db.characters as never
  charactersResourceState.currentChar = 0
  charactersResourceState.status = 'ready'
  settingsResourceState.value = mocks.db as never
  settingsResourceState.status = 'ready'
})

const quickParse = (op: string, ...args: (string | number)[]) => risuChatParser(cbs(op, ...args.map(String)))

const ownerScriptstate = () => charactersResourceState.characters[0].chats[0].scriptstate as Record<string, unknown>

test.each(PHASE9_CBS_COMPATIBILITY_CORPUS)('shared Phase 9 corpus: $name', ({ input, expected }) => {
  expect(risuChatParser(input)).toBe(expected)
})

test('normalizes matcher aliases with case and separators while preserving args', () => {
  expect(risuChatParser('{{NOT_EQUAL::a::b}}')).toBe('1')
  expect(risuChatParser('{{not-equal::same::same}}')).toBe('0')
  expect(risuChatParser('{{greater equal::2::2}}')).toBe('1')
  expect(risuChatParser('{{Array_Element::["a","b"]::1}}')).toBe('b')
})

test('preserves raw matcher tag text passed to callbacks', () => {
  const seen: { raw?: string; args?: string[] } = {}
  registerRisuChatParserMatcher({
    name: 'phase_l11_raw',
    alias: ['phase-l11-alias'],
    description: 'Phase 3 L11 parser normalization test hook.',
    callback: (raw, _matcherArg, args) => {
      seen.raw = raw
      seen.args = args
      return `${raw}|${args.join(',')}`
    },
  })

  expect(risuChatParser('{{Phase L11 Alias::A:B::C}}')).toBe('Phase L11 Alias::A:B::C|A:B,C')
  expect(seen).toEqual({
    raw: 'Phase L11 Alias::A:B::C',
    args: ['A:B', 'C'],
  })
})

test('independent nested matcher expansions do not accumulate recursion depth', () => {
  registerRisuChatParserMatcher({
    name: 'sibling_depth_test',
    alias: [],
    description: 'Recursion-depth sibling regression hook.',
    callback: (_raw, matcherArg) => risuChatParser('x', matcherArg),
  })

  expect(risuChatParser('{{sibling_depth_test}}'.repeat(25))).toBe('x'.repeat(25))
})

test('genuinely recursive matcher expansion still stops at the depth limit', () => {
  registerRisuChatParserMatcher({
    name: 'recursive_depth_test',
    alias: [],
    description: 'Recursion-depth limit regression hook.',
    callback: (_raw, matcherArg) => risuChatParser('{{recursive_depth_test}}', matcherArg),
  })

  expect(risuChatParser('{{recursive_depth_test}}')).toBe('ERROR: Call stack limit reached')
})

test('startswith, endswith, contains', () => {
  expect(quickParse('startswith', 'Hello World', 'Hello')).toBe('1')
  expect(quickParse('endswith', 'Hello World', 'World')).toBe('1')
  expect(quickParse('contains', 'Hello World', 'lo Wo')).toBe('1')

  fc.assert(
    fc.property(validCBSArgPropLong, validCBSArgPropLong, (a, b) => {
      fc.pre(!a.includes(b))

      expect(quickParse('startsWith', a, a.slice(0, -1))).toBe('1')
      expect(quickParse('startsWith', a, b)).toBe('0')

      expect(quickParse('endsWith', a, a.slice(-1))).toBe('1')
      expect(quickParse('endsWith', a, b)).toBe('0')

      expect(quickParse('contains', a, a.slice(0, -1))).toBe('1')
      expect(quickParse('contains', a, a.slice(-1))).toBe('1')
      expect(quickParse('contains', a, a)).toBe('1')
      expect(quickParse('contains', a, b)).toBe('0')
    }),
  )
})

test('replace', () => {
  expect(quickParse('replace', 'Hello World', 'o', '0')).toBe('Hell0 W0rld')

  fc.assert(
    fc.property(validCBSArgPropLong, validCBSArgPropLong, fc.nat(), (a, b, indexSeed) => {
      const index = indexSeed % a.length
      expect(quickParse('replace', a, a[index], b)).toBe(a.replaceAll(a[index], b))
    }),
  )
})

test('split', () => {
  expect(quickParse('split', 'apple,banana,cherry', ',')).toBe(JSON.stringify(['apple', 'banana', 'cherry']))

  fc.assert(
    fc.property(fc.array(validCBSArgPropLong), validCBSArgProp, (arr, b) => {
      const a = arr.join(b)

      expect(quickParse('split', a, b)).toBe(JSON.stringify(a.split(b)))
    }),
  )
})

test('trim', () => {
  expect(quickParse('trim', '  hello world  ')).toBe('hello world')
  expect(quickParse('trim', '  hello  \n  world  ')).toBe('hello  \n  world')

  fc.assert(
    fc.property(validCBSArgProp, (a) => {
      expect(quickParse('trim', a)).toBe(a.trim())
    }),
  )
})

test('length', () => {
  expect(quickParse('length', 'Hello')).toBe('5')

  fc.assert(
    fc.property(validCBSArgProp, (a) => {
      expect(quickParse('length', a)).toBe(String(a.length))
    }),
  )
})

test('capitalize, lower, upper', () => {
  expect(quickParse('capitalize', 'hello world')).toBe('Hello world')
  expect(quickParse('lower', 'Hello WORLD')).toBe('hello world')
  expect(quickParse('upper', 'Hello WORLD')).toBe('HELLO WORLD')

  fc.assert(
    fc.property(validCBSArgProp, (a) => {
      expect(quickParse('capitalize', a)).toBe(a.charAt(0).toUpperCase() + a.slice(1))
      expect(quickParse('lower', a)).toBe(a.toLocaleLowerCase())
      expect(quickParse('upper', a)).toBe(a.toLocaleUpperCase())
    }),
  )
})

test('setdefaultvar installs a missing browser chat variable without replacing existing values', () => {
  delete ownerScriptstate().$missingDefault

  expect(risuChatParser('{{setdefaultvar::missingDefault::fallback}}', { runVar: true })).toBe('')
  expect(ownerScriptstate().$missingDefault).toBe('fallback')
  expect(risuChatParser('{{setdefaultvar::missingDefault::replacement}}', { runVar: true })).toBe('')
  expect(ownerScriptstate().$missingDefault).toBe('fallback')
})

test("setdefaultvar replaces the browser chat variable 'null' sentinel", () => {
  ownerScriptstate().$nullDefault = 'null'

  expect(risuChatParser('{{setdefaultvar::nullDefault::fallback}}', { runVar: true })).toBe('')
  expect(ownerScriptstate().$nullDefault).toBe('fallback')
})

test('reverse', () => {
  const splitByPoints = (str: string) => [...str].reverse().join('')

  expect(quickParse('reverse')).toBe('')
  expect(quickParse('reverse', 'Hello World')).toBe('dlroW olleH')
  // No combiner: 👦‍👧‍👩‍👨
  // Intended behavior. See https://github.com/kwaroran/Risuai/pull/1151#issuecomment-3714792523
  expect(quickParse('reverse', '👨‍👩‍👧‍👦')).toBe(splitByPoints('👨‍👩‍👧‍👦'))

  fc.assert(
    fc.property(validCBSArgProp, (a) => {
      expect(quickParse('reverse', a)).toBe(splitByPoints(a))
    }),
  )
})

test('unicodeencode', () => {
  fc.assert(
    fc.property(validCBSArgProp, fc.nat(), (a, indexSeed) => {
      const index = indexSeed % a.length
      expect(quickParse('unicodeencode', a, index)).toBe(String(a.charCodeAt(index)))
    }),
  )
})

test('unicodedecode, u', () => {
  fc.assert(
    fc.property(fc.integer(), (a) => {
      expect(quickParse('unicodedecode', a)).toBe(String.fromCharCode(a))
      expect(quickParse('u', a.toString(16))).toBe(String.fromCharCode(a))
    }),
  )
})
