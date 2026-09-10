import { describe, expect, it } from 'vitest'
import {
  PROVIDER_OPERATIONS,
  isProviderOperation,
  isProviderOperationRequest,
  isProviderOperationSuccess,
} from '@risuai/protocol/provider-operation'

describe('provider operation protocol', () => {
  it('publishes and validates the exact operation taxonomy', () => {
    expect([...PROVIDER_OPERATIONS].sort()).toEqual([
      'anthropic.models',
      'deepl.translate',
      'deeplx.translate',
      'elevenlabs.voices',
      'fish.models',
      'google.count-tokens',
      'google.models',
      'llmgateway.models',
      'nanogpt.balance',
      'nanogpt.model-providers',
      'nanogpt.models',
      'nanogpt.subscription',
      'nanogpt.subscription-models',
      'neuralwatt.models',
      'ollama.cloud-models',
      'openrouter.models',
      'openrouter.providers',
      'wavespeed.models',
    ])
    expect(new Set(PROVIDER_OPERATIONS).size).toBe(PROVIDER_OPERATIONS.length)
    for (const operation of PROVIDER_OPERATIONS) expect(isProviderOperation(operation)).toBe(true)
    expect(isProviderOperation('openrouter.proxy')).toBe(false)
  })

  it.each([
    { source: 'none' },
    { source: 'stored' },
    { source: 'model-profile', profileId: 'profile-1' },
    { source: 'provided', apiKey: 'draft-key' },
  ] as const)('accepts the $source credential envelope', (credential) => {
    expect(isProviderOperationRequest({ operation: 'openrouter.models', credential })).toBe(true)
  })

  it.each([
    ['nanogpt.model-providers', { modelId: 'owner/model' }],
    ['google.count-tokens', { modelId: 'gemini-2.5-pro', text: 'hello' }],
    ['deepl.translate', { text: 'hello', sourceLanguage: 'en', targetLanguage: 'ko' }],
  ] as const)('accepts the %s input envelope', (operation, input) => {
    expect(isProviderOperationRequest({ operation, credential: { source: 'stored' }, input })).toBe(true)
  })

  it('rejects unknown request, credential, and input fields', () => {
    expect(
      isProviderOperationRequest({
        operation: 'openrouter.models',
        credential: { source: 'stored' },
        url: 'https://attacker.example',
      }),
    ).toBe(false)
    expect(
      isProviderOperationRequest({
        operation: 'openrouter.models',
        credential: { source: 'stored', apiKey: 'unexpected' },
      }),
    ).toBe(false)
    expect(
      isProviderOperationRequest({
        operation: 'google.count-tokens',
        credential: { source: 'stored' },
        input: { modelId: 'gemini', text: 'hello', url: 'https://attacker.example' },
      }),
    ).toBe(false)
  })

  it('keeps success envelopes additive while requiring operation and data', () => {
    expect(isProviderOperationSuccess({ operation: 'openrouter.models', data: [], requestId: 'future' })).toBe(true)
    expect(isProviderOperationSuccess({ operation: 'openrouter.models' })).toBe(false)
    expect(isProviderOperationSuccess({ operation: 'unknown', data: [] })).toBe(false)
  })
})
