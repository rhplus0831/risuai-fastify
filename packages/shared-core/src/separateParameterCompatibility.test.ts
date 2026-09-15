import { describe, expect, it } from 'vitest'
import { repairLegacySeparateParameters } from './separateParameterCompatibility.js'

describe('original Risu separate parameter compatibility', () => {
  it('removes stray editor scalars without changing model overrides or the source', () => {
    const model = { thinking_type: 'budget', thinking_tokens: 1000 }
    const input = {
      memory: { top_k: 4 },
      overrides: {
        thinking_type: 'off',
        thinking_tokens: 0,
        outputImageModal: false,
        adaptive_thinking_effort: null,
        'custom/model': model,
        temperature: { temperature: 80 },
      },
    }
    const repaired = repairLegacySeparateParameters(input)
    expect(repaired.overrides).toEqual({ 'custom/model': model, temperature: { temperature: 80 } })
    expect(repaired.overrides['custom/model']).toBe(model)
    expect(repaired.memory).toBe(input.memory)
    expect(input.overrides.thinking_type).toBe('off')
    expect(repairLegacySeparateParameters(repaired)).toBe(repaired)
  })

  it('preserves unrelated malformed entries for strict validation', () => {
    for (const input of [
      null,
      [],
      { overrides: null },
      {
        overrides: {
          'unknown-model': 'bad',
          thinking_type: [],
          'valid-model': { thinking_type: 'bad' },
        },
      },
    ])
      expect(repairLegacySeparateParameters(input)).toBe(input)
  })
})
