import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerOperations = vi.hoisted(() => ({
  credential: vi.fn((apiKey: string) => ({ source: 'provided', apiKey })),
  request: vi.fn(),
}))
vi.mock('../server/providerOperations', () => ({
  providerOperationCredential: providerOperations.credential,
  requestProviderOperation: providerOperations.request,
}))

vi.mock('../plugins/plugins.svelte', () => ({
  customProviderStore: {},
  pluginV2: {},
}))

vi.mock('../plugins/apiV3/v3.svelte', () => ({
  customV3ProviderMetaStore: [],
}))

import { LLMModels, registerModelDynamic } from './modellist'

const dynamicIds = ['dynamic_google_audit-google-model', 'dynamic_anthropic_audit-anthropic-model']

function removeAuditModels(): void {
  for (const id of dynamicIds) {
    const index = LLMModels.findIndex((model) => model.id === id)
    if (index !== -1) LLMModels.splice(index, 1)
  }
}

beforeEach(() => {
  removeAuditModels()
  providerOperations.credential.mockClear()
  providerOperations.request.mockReset()
})

afterEach(() => {
  removeAuditModels()
})

describe('registerModelDynamic provider operations', () => {
  it('registers Google and Anthropic models without exposing catalog credentials cross-origin', async () => {
    providerOperations.request.mockImplementation(async (operation: string) => {
      if (operation === 'google.models') {
        return {
          models: [
            {
              name: 'models/audit-google-model',
              displayName: 'Audit Google Model',
              supportedGenerationMethods: ['generateContent'],
            },
            {
              name: 'models/audit-embedding-model',
              displayName: 'Audit Embedding Model',
              supportedGenerationMethods: ['embedContent'],
            },
          ],
        }
      }
      if (operation === 'anthropic.models') {
        return { data: [{ id: 'audit-anthropic-model', display_name: 'Audit Anthropic Model' }] }
      }
      throw new Error(`unexpected operation: ${operation}`)
    })

    await registerModelDynamic({
      dynamicModelRegistry: true,
      googleAccessToken: 'google-catalog-key',
      claudeAPIKey: 'anthropic-catalog-key',
    })

    expect(providerOperations.request.mock.calls.map(([operation]) => operation)).toEqual([
      'google.models',
      'anthropic.models',
    ])
    expect(providerOperations.credential.mock.calls.map(([apiKey]) => apiKey)).toEqual([
      'google-catalog-key',
      'anthropic-catalog-key',
    ])
    expect(LLMModels.find((model) => model.id === 'dynamic_google_audit-google-model')).toMatchObject({
      name: 'Audit Google Model',
      internalID: 'models/audit-google-model',
    })
    expect(LLMModels.find((model) => model.id === 'dynamic_anthropic_audit-anthropic-model')).toMatchObject({
      name: 'Audit Anthropic Model',
      internalID: 'audit-anthropic-model',
    })
    expect(LLMModels.some((model) => model.id === 'dynamic_google_audit-embedding-model')).toBe(false)
  })
})
