import { resetClientSessionForTests } from '../../../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../../../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toolDiscovery = vi.hoisted(() => vi.fn(async (): Promise<any[]> => []))
vi.mock('../../mcp/mcp', async (importActual) => ({
  ...(await importActual<typeof import('../../mcp/mcp')>()),
  getTools: toolDiscovery,
}))
vi.mock('../serverCompletion', async (importActual) => {
  const actual = await importActual<typeof import('../serverCompletion')>()
  return {
    ...actual,
    resolveServerCompletionRoute: () => ({ type: 'local' as const }),
  }
})

vi.mock('../../modules', async (importActual) => {
  const actual = await importActual<typeof import('../../modules')>()
  return { ...actual, moduleUpdate: () => {}, getModuleToggles: () => '', getModuleTriggers: () => [] }
})

import { customV3ProviderMetaStore } from '../../../plugins/apiV3/v3.svelte'
import { _setPluginRuntimePhaseForTesting, pluginV2 } from '../../../plugins/plugins.svelte'
import { setDatabase, type Database } from '../../../storage/database.svelte'
import { createDefaultModelRoleProfiles } from '../../../model/modelProfileRecords'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from '../../../model/types'
import { requestChatData, requestChatDataMain } from '../request'

const pluginModelId = 'pluginmodel:::provider-a'

function seedDb(overrides: Partial<Database> = {}): void {
  const aiModel = overrides.aiModel ?? pluginModelId
  const modelProfiles = overrides.modelProfiles ?? [{ id: 'active-profile', name: 'Active', modelId: aiModel }]
  const modelRoleProfiles =
    overrides.modelRoleProfiles ??
    ({
      ...createDefaultModelRoleProfiles(),
      chatMain: { mode: 'profile', profileId: 'active-profile' },
    } as Database['modelRoleProfiles'])
  setDatabase({
    aiModel,
    subModel: pluginModelId,
    modelRoles: {},
    modelProfiles,
    modelRoleProfiles,
    characters: [],
    customModels: [],
    maxResponse: 64,
    temperature: 50,
    useStreaming: false,
    genTime: 1,
    extractJson: '',
    requestRetrys: 0,
    fallbackModels: {
      model: [],
      memory: [],
      emotion: [],
      translate: [],
      otherAx: [],
      scriptMain: [],
      scriptAux: [],
    },
    ...overrides,
  } as unknown as Database)
}

beforeEach(() => {
  resetClientSessionForTests()
  toolDiscovery.mockReset()
  toolDiscovery.mockResolvedValue([])
  pluginV2.replacerbeforeRequest.clear()
  pluginV2.replacerafterRequest.clear()
  _setPluginRuntimePhaseForTesting('ready')
  pluginV2.providers.clear()
  pluginV2.providerOptions.clear()
  customV3ProviderMetaStore.splice(0, customV3ProviderMetaStore.length, {
    id: pluginModelId,
    name: 'Provider A',
    shortName: 'Provider A',
    fullName: 'Provider A',
    internalID: pluginModelId,
    provider: LLMProvider.AsIs,
    format: LLMFormat.Plugin,
    flags: [LLMFlags.hasFullSystemPrompt],
    parameters: [],
    tokenizer: LLMTokenizer.Unknown,
  })
  seedDb()
})

afterEach(() => {
  _setPluginRuntimePhaseForTesting('idle')
  pluginV2.providers.clear()
  pluginV2.providerOptions.clear()
  customV3ProviderMetaStore.splice(0, customV3ProviderMetaStore.length)
  vi.restoreAllMocks()
})

describe('V3 plugin provider response model ids', () => {
  it('does not execute a provider from an incoherent plugin runtime', async () => {
    const provider = vi.fn(async () => ({ success: true, content: 'must not run' }))
    pluginV2.providers.set('provider-a', provider)
    _setPluginRuntimePhaseForTesting('loading')

    const result = await requestChatDataMain({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')

    expect(result).toMatchObject({ type: 'fail', model: pluginModelId })
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['success', { success: true, content: 'complete' }, 'success'],
    ['failure', { success: false, content: 'rejected' }, 'fail'],
  ] as const)('preserves the V3 id for a %s response', async (_case, providerResult, expectedType) => {
    pluginV2.providers.set(
      'provider-a',
      vi.fn(async () => providerResult),
    )

    const result = await requestChatDataMain({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')

    expect(result.type).toBe(expectedType)
    expect(result.model).toBe(pluginModelId)
  })

  it('preserves the V3 id for a streaming response', async () => {
    pluginV2.providers.set(
      'provider-a',
      vi.fn(async () => ({
        success: true,
        content: new ReadableStream<string>({
          start(controller) {
            controller.enqueue('chunk')
            controller.close()
          },
        }),
      })),
    )

    const result = await requestChatDataMain(
      { formated: [{ role: 'user', content: 'hello' }], bias: {}, useStreaming: true },
      'model',
    )

    expect(result.type).toBe('streaming')
    expect(result.model).toBe(pluginModelId)
  })

  it('keeps legacy provider responses classified as custom', async () => {
    seedDb({ aiModel: 'custom', subModel: 'custom', currentPluginProvider: 'legacy-provider' })
    pluginV2.providers.set(
      'legacy-provider',
      vi.fn(async () => ({ success: true, content: 'legacy' })),
    )

    const result = await requestChatDataMain({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')

    expect(result).toMatchObject({ type: 'success', result: 'legacy', model: 'custom' })
  })

  it('treats a failed V3 fallback as a plugin response instead of falling through to the primary model', async () => {
    seedDb({
      aiModel: 'echo_model',
      subModel: 'echo_model',
      modelProfiles: [
        {
          id: 'active-profile',
          name: 'Active',
          modelId: 'echo_model',
          fallbacks: [{ mode: 'model', modelId: pluginModelId }],
        },
      ],
      fallbackModels: {
        model: [pluginModelId],
        memory: [],
        emotion: [],
        translate: [],
        otherAx: [],
        scriptMain: [],
        scriptAux: [],
      },
    })
    const provider = vi.fn(async () => ({ success: false, content: 'plugin failed' }))
    pluginV2.providers.set('provider-a', provider)

    const result = await requestChatData({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')

    expect(result).toEqual({ type: 'fail', result: 'plugin failed', model: pluginModelId })
    expect(provider).toHaveBeenCalledOnce()
  })
})

describe('request coordinator writer lifecycle', () => {
  it('does not execute a plugin provider after held tool discovery crosses re-promotion', async () => {
    setManagedWriterForTest()
    _setPluginRuntimePhaseForTesting('ready')
    const provider = vi.fn(async () => ({ success: true, content: 'must not run' }))
    pluginV2.providers.set('provider-a', provider)
    let release!: (tools: any[]) => void
    toolDiscovery.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = requestChatDataMain({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')
    await vi.waitFor(() => expect(toolDiscovery).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    _setPluginRuntimePhaseForTesting('ready')
    pluginV2.providers.set('provider-a', provider)
    release([])
    await expect(pending).resolves.toEqual({ type: 'fail', result: 'Aborted' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('does not resume provider dispatch after an old before-request plugin callback', async () => {
    setManagedWriterForTest()
    _setPluginRuntimePhaseForTesting('ready')
    const provider = vi.fn(async () => ({ success: true, content: 'must not run' }))
    pluginV2.providers.set('provider-a', provider)
    let release!: (messages: any[]) => void
    const replacer = vi.fn(
      () =>
        new Promise<any[]>((resolve) => {
          release = resolve
        }),
    )
    pluginV2.replacerbeforeRequest.add(replacer)
    const pending = requestChatData({ formated: [{ role: 'user', content: 'hello' }], bias: {} }, 'model')
    await vi.waitFor(() => expect(replacer).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    _setPluginRuntimePhaseForTesting('ready')
    pluginV2.providers.set('provider-a', provider)
    release([{ role: 'user', content: 'old plugin output' }])
    await expect(pending).resolves.toEqual({ type: 'fail', result: 'Aborted' })
    expect(toolDiscovery).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
  })

  it('preserves already-aborted request semantics without tool or plugin work', async () => {
    setManagedWriterForTest()
    _setPluginRuntimePhaseForTesting('ready')
    const provider = vi.fn()
    const replacer = vi.fn()
    pluginV2.providers.set('provider-a', provider)
    pluginV2.replacerbeforeRequest.add(replacer)
    const controller = new AbortController()
    controller.abort()
    const request = { formated: [{ role: 'user' as const, content: 'hello' }], bias: {} }
    await expect(requestChatData(request, 'model', controller.signal)).resolves.toEqual({
      type: 'fail',
      result: 'Aborted',
    })
    await expect(requestChatDataMain(request, 'model', controller.signal)).resolves.toEqual({
      type: 'fail',
      result: 'Aborted',
    })
    expect(toolDiscovery).not.toHaveBeenCalled()
    expect(provider).not.toHaveBeenCalled()
    expect(replacer).not.toHaveBeenCalled()
  })

  it('rejects Reader request coordinators before provider work', async () => {
    setManagedReaderForTest()
    const request = { formated: [{ role: 'user' as const, content: 'hello' }], bias: {} }
    await expect(requestChatData(request, 'model')).resolves.toMatchObject({
      type: 'fail',
      result: 'client_write_access_required',
    })
    await expect(requestChatDataMain(request, 'model')).resolves.toMatchObject({
      type: 'fail',
      result: 'client_write_access_required',
    })
    expect(toolDiscovery).not.toHaveBeenCalled()
  })
})
