import type { DatabaseSync } from 'node:sqlite'
import { refreshAcceptedProfileCredential } from './generationCredentials.js'
import type { ModelProfileProviderOptions } from '@risuai/shared-core/model-profile-resolver'
import { resolveModelProfile } from '@risuai/shared-core/model-profile-resolver'
import type { WorkingGenerationSettings as Database } from './prompt/serverTypes.js'
import { resolveMemoryModelCapability } from '@risuai/shared-core/memory-model-capability'
import { type OpenAICompatibleOptions, type OpenAICompatibleProvider } from './generation/openaiCompatible.js'
import { getProfileAdditionalParameters } from './generation/additionalParams.js'

export interface MemorySummaryModelRequest {
  provider: OpenAICompatibleProvider
  model: string
  options: OpenAICompatibleOptions
}

export type ResolveMemorySummaryModelResult =
  | { ok: true; request: MemorySummaryModelRequest }
  | { ok: false; error: string }

export function resolveMemorySummaryModel(
  db: Database,
  requestedModel: string,
  sqlite?: DatabaseSync,
): ResolveMemorySummaryModelResult {
  if (requestedModel !== 'subModel' && requestedModel !== 'memory') {
    return {
      ok: false,
      error: 'server-side memory summarization currently supports only the memory/subModel API path',
    }
  }

  const profile = refreshAcceptedProfileCredential(sqlite, db, resolveModelProfile({ database: db, role: 'memory' }))
  const provider = resolveMemoryModelCapability(profile)
  if (provider.ok === false) return provider

  if (!profile.requestModel) {
    return { ok: false, error: 'summarization model must be a non-empty string' }
  }

  return {
    ok: true,
    request: {
      provider: provider.provider,
      model: profile.requestModel,
      options: buildMemorySummaryOptions(db, profile.modelId, provider.provider, profile.providerOptions),
    },
  }
}

function buildMemorySummaryOptions(
  db: Database,
  modelId: string,
  provider: OpenAICompatibleProvider,
  options: ModelProfileProviderOptions,
): OpenAICompatibleOptions {
  const additionalParams = getProfileAdditionalParameters(db, modelId, options.additionalParams, options.extraHeaders)
  if (provider === 'nanogpt') {
    return {
      nanogpt: withoutUndefined({
        apiKey: options.apiKey,
        providerHint: options.nanogpt?.providerHint,
        useSubscription: options.nanogpt?.useSubscriptionEndpoint,
        additionalParams: additionalParams.length > 0 ? additionalParams : undefined,
      }),
    }
  }

  if (provider === 'openrouter') {
    return {
      openrouter: withoutUndefined({
        apiKey: options.apiKey,
        additionalParams: additionalParams.length > 0 ? additionalParams : undefined,
      }),
    }
  }

  return {
    openai: withoutUndefined({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      extraHeaders: options.extraHeaders,
      additionalParams: additionalParams.length > 0 ? additionalParams : undefined,
      oobaSystemHoist: options.reverseProxy?.oobaSystemHoist === true ? true : undefined,
    }),
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item
  }
  return result as T
}
