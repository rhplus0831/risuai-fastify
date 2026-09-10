import { describe, expect, it } from 'vitest'
import * as shared from '@risuai/shared-core/trigger-compatibility'
import * as browser from '../../../src/ts/process/triggerServerSupport'
import * as server from '../../../server/fastify/src/prompt/triggerCompatibility.js'

const unsupportedEffects = [
  '@@emo',
  'command',
  'extractRegex',
  'showAlert',
  'runImgGen',
  'checkSimilarity',
  'runLLM',
  'runAxLLM',
  'triggercode',
  'v2Command',
  'v2ImgGen',
  'v2CheckSimilarity',
  'v2RunLLM',
  'v2ShowAlert',
  'v2GetAlertInput',
  'v2GetAlertSelect',
  'v2GetCharacterDesc',
  'v2SetCharacterDesc',
  'v2GetPersonaDesc',
  'v2SetPersonaDesc',
  'v2GetReplaceGlobalNote',
  'v2SetReplaceGlobalNote',
  'v2GetAuthorNote',
  'v2SetAuthorNote',
  'v2ModifyLorebook',
  'v2GetLorebook',
  'v2GetLorebookCount',
  'v2GetLorebookEntry',
  'v2SetLorebookActivation',
  'v2GetLorebookIndexViaName',
  'v2GetAllLorebooks',
  'v2GetLorebookByName',
  'v2GetLorebookByIndex',
  'v2CreateLorebook',
  'v2ModifyLorebookByIndex',
  'v2DeleteLorebookByIndex',
  'v2GetLorebookCountNew',
  'v2SetLorebookAlwaysActive',
  'v2UpdateGUI',
  'v2UpdateChatAt',
  'v2Wait',
]

describe('shared trigger compatibility', () => {
  it('retains every unsupported classification and exact membership', () => {
    expect([...shared.serverUnsupportedTriggerEffectTypes]).toEqual(unsupportedEffects)
    for (const type of unsupportedEffects) expect(shared.isServerUnsupportedTriggerEffectType(type), type).toBe(true)
    for (const type of ['v2SetVar', 'v2FutureEffect', 'ShowAlert', 'showAlert ', '', '@@emo happy']) {
      expect(shared.isServerUnsupportedTriggerEffectType(type), type).toBe(false)
    }
    expect([...shared.serverUnsupportedCbsCallbackNames]).toEqual([])
  })

  it.each([
    ['@@emo happy', '@@emo'],
    ['@@emo ', '@@emo'],
    ['@@emo  happy', '@@emo'],
    ['@@emo', null],
    ['@@emo\thappy', null],
    ['@@emo\nhappy', null],
    ['@@emo\u00a0happy', null],
    ['@@EMO happy', null],
    [' @@emo happy', null],
    ['prefix @@emo happy', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
    [{ output: '@@emo happy' }, null],
  ] as const)('classifies regex output %j without coercion or whitespace normalization', (input, expected) => {
    expect(shared.serverUnsupportedRegexEffectType(input)).toBe(expected)
  })

  it.each([
    ['shared', shared],
    ['browser', browser],
    ['server', server],
  ] as const)('preserves sorted, deduplicated diagnostics and cyclic input through %s', (_name, entry) => {
    const effects = Object.freeze([...unsupportedEffects].reverse().map((type) => Object.freeze({ type })))
    const definitions: { effects: typeof effects; nested: unknown[]; self?: unknown } = {
      effects,
      nested: [effects, effects[0], { type: 'v2SetVar' }, { type: false }, '{{screenheight}}', null, 42],
    }
    definitions.self = definitions
    definitions.nested.push(definitions.nested)
    Object.freeze(definitions.nested[2])
    Object.freeze(definitions.nested[3])
    Object.freeze(definitions.nested)
    Object.freeze(definitions)
    const before = structuredClone(definitions)

    const diagnostics = entry.diagnoseServerTriggerCompatibility(definitions)
    expect(diagnostics).toEqual({ unsupportedEffectTypes: [...unsupportedEffects].sort(), unsupportedCbsCallbacks: [] })
    expect(definitions).toEqual(before)
    expect(definitions.effects).toBe(effects)
    expect(definitions.nested[0]).toBe(effects)
    expect(definitions.self).toBe(definitions)
    expect(definitions.nested.at(-1)).toBe(definitions.nested)

    diagnostics.unsupportedEffectTypes.length = 0
    expect(entry.diagnoseServerTriggerCompatibility(definitions).unsupportedEffectTypes).toEqual(
      [...unsupportedEffects].sort(),
    )
  })

  it('visits array elements while ignoring an array type property and primitive values', () => {
    const definitions: unknown[] & { type?: string } = [{ type: 'runLLM' }]
    definitions.type = 'showAlert'
    definitions.push(definitions, 'showAlert', false, undefined, null, 42, { type: ['showAlert'] })
    expect(shared.diagnoseServerTriggerCompatibility(definitions)).toEqual({
      unsupportedEffectTypes: ['runLLM'],
      unsupportedCbsCallbacks: [],
    })
    for (const input of ['showAlert', null, undefined, false, 42]) {
      expect(shared.diagnoseServerTriggerCompatibility(input)).toEqual({
        unsupportedEffectTypes: [],
        unsupportedCbsCallbacks: [],
      })
    }
  })
})
