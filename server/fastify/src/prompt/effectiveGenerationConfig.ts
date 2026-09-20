import { applyProfileBoundGenerationFields } from './profileGenerationFields.js'
export { applyProfileBoundGenerationFields } from './profileGenerationFields.js'
import { decodeGenerationSettings } from './generationInputDecoder.js'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as Database,
  FastifyMessagePresetInfo as MessagePresetInfo,
  GenerationPreflightModule,
  GenerationConfigurationSettings,
  ResolvedGenerationConfigurationSettings,
  GenerationPreflightInputs,
} from './serverTypes.js'
import {
  createChatGenerationSettingsIncompleteError,
  projectSidebarTogglesToGlobalChatVariables,
  resolveChatGenerationSettingsReadiness,
  type ChatGenerationSettingsIncompleteErrorBody,
  type ChatGenerationSettingsReadiness,
} from '@risuai/shared-core/chat-generation-settings'
import { mirrorLegacyProfile } from '../commands/personas.js'
import {
  applyEffectivePresetComposition,
  applyPromptPresetModelOverrides,
  isLegacyModelPresetCompatibilityRecord,
  resolvePromptPresetRegexField,
} from '@risuai/shared-core/preset-split'
import {
  modelProfileGenerationBlockReason,
  resolveModelProfile,
  resolveModelProfileTokenizerSelection,
  resolveModelProfileWithLegacyCompatibility,
  type ResolvedModelProfile,
} from '@risuai/shared-core/model-profile-resolver'
import { normalizeModelRoleProfiles } from '@risuai/shared-core/model-profile-records'
import { serverTokenizerUnsupportedReason } from './tokenizerConfig.js'
import { createPromptInfoSnapshot } from '@risuai/shared-core/prompt-info-snapshot'
import { resolveEffectiveAgentPresetId } from '@risuai/shared-core/agent-preset-resolver'
import { combineModuleIntegrations, resolveAgentPresetModuleIntegration } from '@risuai/shared-core/module-integration'
import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'
import { selectedPersonaIndexFromStableId } from '@risuai/shared-core/persona-selection-identity'

export class ChatGenerationSettingsIncompleteAssemblyError extends Error {
  readonly statusCode = 409
  readonly body: ChatGenerationSettingsIncompleteErrorBody

  constructor(readiness: Pick<ChatGenerationSettingsReadiness, 'missing' | 'staleSidebarToggleKeys'>, chatId?: string) {
    const body = createChatGenerationSettingsIncompleteError(readiness, chatId)
    super(body.message)
    this.name = 'ChatGenerationSettingsIncompleteAssemblyError'
    this.body = body
  }
}

export function isChatGenerationSettingsIncompleteAssemblyError(
  error: unknown,
): error is ChatGenerationSettingsIncompleteAssemblyError {
  return error instanceof ChatGenerationSettingsIncompleteAssemblyError
}

export class ModelProfileGenerationGuardAssemblyError extends Error {
  readonly statusCode = 400
  readonly body: { error: string }

  constructor(message: string) {
    super(message)
    this.name = 'ModelProfileGenerationGuardAssemblyError'
    this.body = { error: message }
  }
}

export function isModelProfileGenerationGuardAssemblyError(
  error: unknown,
): error is ModelProfileGenerationGuardAssemblyError {
  return error instanceof ModelProfileGenerationGuardAssemblyError
}

export interface EffectiveGenerationConfigInput {
  database: Database
  currentChar: character
  currentChat: Chat
  selectedCharID: number
  chatPage: number
}

export interface EffectiveGenerationConfigResult {
  database: Database
  currentChar: character
  currentChat: Chat
  promptInfo: MessagePresetInfo
  resolvedMainProfile: ResolvedModelProfile
}

type ResolvedConfiguration<Module extends GenerationPreflightModule> = {
  database: ResolvedGenerationConfigurationSettings<Module>
  promptInfo: MessagePresetInfo
  resolvedMainProfile: ResolvedModelProfile
}
export type ResolvedGenerationPreflightConfiguration = ResolvedConfiguration<GenerationPreflightModule>

/** Resolve configuration without a transcript or executable module bodies. */
export function resolveGenerationPreflightConfiguration(
  input: GenerationPreflightInputs,
): ResolvedGenerationPreflightConfiguration {
  return resolveGenerationConfiguration(input)
}

function resolveGenerationConfiguration<Module extends GenerationPreflightModule>(
  input: Omit<GenerationPreflightInputs, 'database'> & { database: GenerationConfigurationSettings<Module> },
): ResolvedConfiguration<Module> {
  const settings = input.currentChat.generationSettings
  const effectiveAgentPresetId = resolveEffectiveAgentPresetId(input.database, settings)
  const modelPresets = input.database.modelPresets ?? []
  const promptPresets = input.database.promptPresets ?? []
  const personas = input.database.personas ?? []
  const selectedModelPreset = findById(modelPresets, settings?.modelPresetId)
  const selectedPromptPreset = resolveUniquePromptPreset(promptPresets, settings?.promptPresetId)
  const readiness = resolveChatGenerationSettingsReadiness({
    settings,
    effectiveAgentPresetId,
    personas,
    modelPresets,
    promptPresets,
    agentPresets: input.database.agentPresets ?? [],
    agents: input.database.agents ?? [],
    modules: input.database.modules ?? [],
    enabledModuleIds: stringArray(input.database.enabledModules),
    characterModuleIds: stringArray(input.currentChar.modules),
    chatModuleIds: stringArray(input.currentChat.modules),
    moduleIntegration:
      typeof selectedPromptPreset?.moduleIntergration === 'string' ? selectedPromptPreset.moduleIntergration : null,
  })

  if (!readiness.ready) {
    throw new ChatGenerationSettingsIncompleteAssemblyError(readiness, input.currentChat.id)
  }

  const persona = findById(personas, settings?.personaId)
  const modelPreset = selectedModelPreset
  const promptPreset = selectedPromptPreset
  if (!persona || !modelPreset || !promptPreset) {
    throw new ChatGenerationSettingsIncompleteAssemblyError(readiness, input.currentChat.id)
  }

  const promptInfo = createPromptInfoSnapshot({
    enabled: input.database.promptInfoInsideChat === true,
    promptPreset,
    requiredSidebarToggles: readiness.requirements.sidebarToggles,
    sidebarToggles: settings?.sidebarToggles,
  })

  // Preset composition clones only selected overlay fields that it writes.
  // Selected collection records remain shared configuration, while all mutable
  // prompt/character/chat state is owned by the assembly wrapper below.
  const effectiveDatabase: GenerationConfigurationSettings<Module> = { ...input.database }
  const effectiveModelPresetIndex = modelPresets.indexOf(modelPreset)
  const effectivePromptPresetIndex = promptPresets.indexOf(promptPreset)
  const effectiveModelPreset = modelPreset
  const effectivePromptPreset = promptPreset
  const effectivePersona = persona

  effectiveDatabase.modelPresetsId = effectiveModelPresetIndex
  effectiveDatabase.promptPresetsId = effectivePromptPresetIndex
  applyEffectivePresetComposition(effectiveDatabase, {
    modelPreset: effectiveModelPreset,
    promptPreset: effectivePromptPreset,
    scope: 'full-generation',
  })
  effectiveDatabase.moduleIntergration = combineModuleIntegrations(
    effectivePromptPreset.moduleIntergration,
    resolveAgentPresetModuleIntegration(effectiveDatabase.agentPresets, effectiveAgentPresetId),
  )
  const promptPresetRegex = resolvePromptPresetRegexField(effectivePromptPreset)
  effectiveDatabase.presetRegex = structuredClone(
    promptPresetRegex.present && Array.isArray(promptPresetRegex.value)
      ? (decodeGenerationSettings({ presetRegex: promptPresetRegex.value }).presetRegex ?? [])
      : [],
  )

  effectiveDatabase.selectedPersonaId = effectivePersona.id
  effectiveDatabase.selectedPersona = selectedPersonaIndexFromStableId(effectiveDatabase)
  mirrorLegacyProfile(effectiveDatabase, effectivePersona)

  effectiveDatabase.globalChatVariables = projectSidebarTogglesToGlobalChatVariables(
    effectiveDatabase.globalChatVariables,
    settings?.sidebarToggles,
  )
  effectiveDatabase.jailbreakToggle = settings?.jailbreakToggle === true

  const legacyBinding = normalizeModelRoleProfiles(effectiveDatabase.modelRoleProfiles).chatMain.mode === 'legacy'
  const profile =
    isLegacyModelPresetCompatibilityRecord(effectiveModelPreset) || legacyBinding
      ? resolveModelProfileWithLegacyCompatibility({ database: effectiveDatabase })
      : resolveModelProfile({ database: effectiveDatabase })
  const profileBlockReason = modelProfileGenerationBlockReason(profile)
  if (profileBlockReason) {
    throw new ModelProfileGenerationGuardAssemblyError(profileBlockReason)
  }
  applyProfileBoundGenerationFields(effectiveDatabase, profile)
  // Durable profile runtime fields materialize onto the flat request settings.
  // Prompt preset model overrides are the final user-facing layer for a chat, so
  // reapply them after profile runtime defaults/profile-local options.
  applyPromptPresetModelOverrides(effectiveDatabase, effectivePromptPreset)
  if (profile.source.kind === 'durable-profile') {
    effectiveDatabase.customTokenizer = resolveModelProfileTokenizerSelection(effectiveDatabase, profile)
  }
  const tokenizerBlockReason = serverTokenizerUnsupportedReason(effectiveDatabase)
  if (tokenizerBlockReason) {
    throw new ModelProfileGenerationGuardAssemblyError(tokenizerBlockReason)
  }

  return { database: effectiveDatabase, promptInfo, resolvedMainProfile: profile }
}

export function buildEffectiveGenerationConfig(input: EffectiveGenerationConfigInput): EffectiveGenerationConfigResult {
  const resolved = resolveGenerationConfiguration(input)
  const storedChat = input.currentChar.chats[input.chatPage]
  if (!storedChat) throw new Error('selected generation chat is unavailable')
  const currentChar = cloneGenerationWorkingCharacter(input.currentChar)
  currentChar.chats[input.chatPage] = structuredClone(storedChat)
  const characters = input.database.characters.slice()
  characters[input.selectedCharID] = currentChar
  const database: Database = { ...resolved.database, characters }
  return {
    ...resolved,
    database,
    currentChar,
    currentChat: structuredClone(storedChat),
  }
}

/** Own mutable character fields without copying sibling transcripts. */
export function cloneGenerationWorkingCharacter(source: character): character {
  const copy: character = structuredClone({ ...source, chats: [] })
  copy.chats = source.chats.slice()
  return copy
}

function findById<T extends { id?: string | null }>(collection: readonly T[], id: string | undefined): T | undefined {
  if (!id) return undefined
  return collection.find((candidate) => candidate.id === id)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
