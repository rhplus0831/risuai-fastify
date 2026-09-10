import { describe, expect, it } from 'vitest'
import { AnthropicModels } from './anthropicModels.js'
import { GoogleModels } from './googleModels.js'
import { GPT5Parameters, ClaudeParameters } from './modelTypes.js'
import { OpenAIModels } from './openaiModels.js'

describe('shared model provider catalogs', () => {
  it('preserves catalog sizes, order, duplicate rows, and metadata references', () => {
    expect(OpenAIModels).toHaveLength(56)
    expect(AnthropicModels).toHaveLength(30)
    expect(GoogleModels).toHaveLength(44)
    expect(OpenAIModels[0]?.id).toBe('gpt-5.5')
    expect(AnthropicModels[0]?.id).toBe('claude-opus-4-8')
    expect(GoogleModels[0]?.id).toBe('gemini-3.6-flash')
    expect(OpenAIModels.at(-1)?.id).toBe('gpt35')
    expect(AnthropicModels.at(-1)?.id).toBe('claude-instant-1.2')
    expect(GoogleModels.at(-1)?.id).toBe('gemini-pro-vision')

    const gpt5Rows = OpenAIModels.filter((model) => model.id === 'gpt-5')
    expect(gpt5Rows).toHaveLength(2)
    expect(gpt5Rows[0]?.parameters).toBe(GPT5Parameters)
    expect(gpt5Rows[1]?.parameters).toBe(GPT5Parameters)

    expect(AnthropicModels.some((model) => model.parameters === ClaudeParameters)).toBe(true)
    expect(AnthropicModels.some((model) => model.parameters !== ClaudeParameters)).toBe(true)

    const geminiPro15 = GoogleModels.find((model) => model.id === 'gemini-1.5-pro-latest')
    expect(geminiPro15?.flags.filter((flag) => flag === geminiPro15.flags[2])).toHaveLength(2)
  })
})
