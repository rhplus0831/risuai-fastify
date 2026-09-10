import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PRESET_OUTPUT_CBS_RE,
  agentPresetOutputReferences,
  expandAgentPresetOutputCbs,
  type AgentPresetOutputReference,
} from './agentPresetOutputReferences.js'

const AGENT_PRESET_OUTPUT_CBS_RE_BEFORE_EXTRACTION = /\{\{\s*agent::([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g
const CASE_VARIANT_AGENT_REFERENCE_NEGATIVES = ['{{Agent::result}}', '{{AGENT::result}}']

function referencesBeforeExtraction(input: string): AgentPresetOutputReference[] {
  const references: AgentPresetOutputReference[] = []
  for (const match of input.matchAll(AGENT_PRESET_OUTPUT_CBS_RE_BEFORE_EXTRACTION)) {
    const key = match[1]
    if (!key) continue
    references.push({ key, token: match[0], index: match.index ?? 0 })
  }
  return references
}

function expandBeforeExtraction(input: string, resolveOutput: (key: string) => string | undefined): string {
  return input.replace(
    AGENT_PRESET_OUTPUT_CBS_RE_BEFORE_EXTRACTION,
    (token, key: string) => resolveOutput(key) ?? token,
  )
}

describe('agent-preset output references', () => {
  const key64 = `_${'a'.repeat(63)}`
  const key65 = `_${'a'.repeat(64)}`

  it.each([
    '',
    '{{agent::result}}',
    'before {{  agent::_result42  }} after',
    '{{agent::repeat}} + {{agent::repeat}}',
    `{{agent::${key64}}}`,
    `{{agent::${key65}}}`,
    '{{agent::9invalid}} {{agent::has-dash}} {{agent::한글}}',
    ...CASE_VARIANT_AGENT_REFERENCE_NEGATIVES,
    '🙂{{agent::utf16_index}}',
    '{{agent::a}}{{agent::b}}{{agent::c}}',
  ])('preserves discovery metadata for %o', (input) => {
    expect(agentPresetOutputReferences(input)).toEqual(referencesBeforeExtraction(input))
  })

  it('preserves exact tokens, UTF-16 indexes, boundaries, and repeated order', () => {
    const input = '🙂 {{ agent::_a1 }} / {{agent::_a1}}'
    const expected = [
      { key: '_a1', token: '{{ agent::_a1 }}', index: 3 },
      { key: '_a1', token: '{{agent::_a1}}', index: 22 },
    ]
    expect(agentPresetOutputReferences(input)).toEqual(expected)
    expect(
      [...input.matchAll(AGENT_PRESET_OUTPUT_CBS_RE)].map((match) => ({
        key: match[1],
        token: match[0],
        index: match.index,
      })),
    ).toEqual(expected)
    expect(agentPresetOutputReferences(`{{agent::${key64}}} {{agent::${key65}}}`)).toEqual([
      { key: key64, token: `{{agent::${key64}}}`, index: 0 },
    ])
  })

  it('preserves callback order and unresolved token identity', () => {
    const outputs: Record<string, string> = { first: 'ONE', empty: '' }
    const resolveOutput = vi.fn((key: string) => outputs[key])
    const input = '{{ agent::first }}|{{agent::missing}}|{{agent::empty}}|{{agent::first}}'

    expect(expandAgentPresetOutputCbs(input, resolveOutput)).toBe('ONE|{{agent::missing}}||ONE')
    expect(resolveOutput.mock.calls).toEqual([['first'], ['missing'], ['empty'], ['first']])
  })

  it('matches the pre-extraction expansion for replacement edge cases', () => {
    const input = '🙂{{agent::a}}/{{ agent::_b }}+{{agent::missing}}'
    const outputs: Record<string, string> = { a: '$&', _b: '$1' }
    const resolveOutput = (key: string): string | undefined => outputs[key]

    expect(expandAgentPresetOutputCbs(input, resolveOutput)).toBe(expandBeforeExtraction(input, resolveOutput))
  })
})
