import type { ResolvedModelProfile } from '@risuai/shared-core/model-profile-resolver'
import { decodeGenerationSettings } from './generationInputDecoder.js'
import type { WorkingGenerationSettings } from './serverTypes.js'

type GenerationSettings = Omit<WorkingGenerationSettings, 'modules'>

export function applyProfileBoundGenerationFields(database: GenerationSettings, profile: ResolvedModelProfile): void {
  if (profile.source.kind !== 'durable-profile') return

  database.aiModel = profile.modelId
  const runtime = profile.runtimeOptions
  const checkedRuntime = decodeGenerationSettings({
    thinkingType: runtime.thinkingType,
    deepseekThinkingType: runtime.deepseekThinkingType,
    adaptiveThinkingEffort: runtime.adaptiveThinkingEffort,
    deepseekReasoningEffort: runtime.deepseekReasoningEffort,
    dynamicOutput: runtime.dynamicOutput,
  })
  assignIfDefined(database, 'maxContext', runtime.maxContext)
  assignIfDefined(database, 'maxResponse', runtime.maxResponse)
  assignIfDefined(database, 'temperature', runtime.rawTemperature)
  assignIfDefined(database, 'top_p', runtime.topP)
  assignIfDefined(database, 'top_k', runtime.topK)
  assignIfDefined(database, 'min_p', runtime.minP)
  assignIfDefined(database, 'top_a', runtime.topA)
  assignIfDefined(database, 'repetition_penalty', runtime.repetitionPenalty)
  assignIfDefined(database, 'frequencyPenalty', scaleSamplerForDatabase(runtime.frequencyPenalty))
  assignIfDefined(database, 'PresensePenalty', scaleSamplerForDatabase(runtime.presencePenalty))
  assignIfDefined(database, 'reasoningEffort', runtime.reasoningEffort)
  assignIfDefined(database, 'thinkingTokens', runtime.thinkingTokens)
  assignIfDefined(database, 'thinkingType', checkedRuntime.thinkingType)
  assignIfDefined(database, 'deepseekThinkingType', checkedRuntime.deepseekThinkingType)
  assignIfDefined(database, 'adaptiveThinkingEffort', checkedRuntime.adaptiveThinkingEffort)
  assignIfDefined(database, 'deepseekReasoningEffort', checkedRuntime.deepseekReasoningEffort)
  assignIfDefined(database, 'verbosity', runtime.verbosity)
  assignIfDefined(database, 'halfStreaming', runtime.halfStreaming)
  assignIfDefined(database, 'useStreaming', runtime.useStreaming)
  assignIfDefined(database, 'genTime', runtime.genTime)
  assignIfDefined(database, 'extractJson', runtime.extractJson)
  assignIfDefined(database, 'jsonSchemaEnabled', runtime.jsonSchemaEnabled)
  assignIfDefined(database, 'jsonSchema', runtime.jsonSchema)
  assignIfDefined(database, 'strictJsonSchema', runtime.strictJsonSchema)
  assignIfDefined(database, 'outputImageModal', runtime.outputImageModal)
  assignIfDefined(database, 'dynamicOutput', checkedRuntime.dynamicOutput)
  database.modelTools = [...runtime.modelTools]
  assignIfDefined(database, 'enableCustomFlags', runtime.enableCustomFlags)
  if (runtime.customFlags !== undefined) database.customFlags = [...runtime.customFlags]
  assignIfDefined(database, 'customTokenizer', runtime.customTokenizer)
}

type ProfileBoundGenerationFields = Pick<
  GenerationSettings,
  | 'maxContext'
  | 'maxResponse'
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'top_a'
  | 'repetition_penalty'
  | 'frequencyPenalty'
  | 'PresensePenalty'
  | 'reasoningEffort'
  | 'thinkingTokens'
  | 'thinkingType'
  | 'deepseekThinkingType'
  | 'adaptiveThinkingEffort'
  | 'deepseekReasoningEffort'
  | 'verbosity'
  | 'halfStreaming'
  | 'useStreaming'
  | 'genTime'
  | 'extractJson'
  | 'jsonSchemaEnabled'
  | 'jsonSchema'
  | 'strictJsonSchema'
  | 'outputImageModal'
  | 'dynamicOutput'
  | 'enableCustomFlags'
  | 'customTokenizer'
>

function assignIfDefined<K extends keyof ProfileBoundGenerationFields>(
  database: GenerationSettings,
  key: K,
  value: GenerationSettings[K] | undefined,
): void {
  if (value !== undefined) {
    database[key] = value
  }
}

function scaleSamplerForDatabase(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 100
}
