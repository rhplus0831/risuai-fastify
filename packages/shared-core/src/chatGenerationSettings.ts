import {
  agentToggleStorageKey,
  type AgentPresetUseRecord,
  type ReadonlyAgentToggleDefinition,
} from './agentPresetRecords.js'
import { resolveModuleActivationStates } from './moduleActivation.js'
import { parseModuleIntegration, resolveAgentPresetModuleIntegration } from './moduleIntegration.js'
import type { ChatGenerationSidebarToggleKind } from './chatGenerationTogglePresetRecords.js'

export type { ChatGenerationSidebarToggleKind } from './chatGenerationTogglePresetRecords.js'

export const CHAT_GENERATION_SETTINGS_FIELD = 'generationSettings' as const

export const CHAT_GENERATION_SETTINGS_INCOMPLETE_STATUS = 409 as const
export const CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR = 'chat_generation_settings_incomplete' as const
export const CHAT_GENERATION_SETTINGS_INCOMPLETE_MESSAGE = 'Chat generation settings are incomplete' as const

const JAILBREAK_TOGGLE_TOKEN = '{{jbtoggled}}'

export type ModelPresetSelectionSource = 'manual' | 'prompt-recommendation'

export interface ChatGenerationSettings {
  configured?: boolean
  personaId?: string
  modelPresetId?: string
  modelPresetSelectionSource?: ModelPresetSelectionSource
  promptPresetId?: string
  agentPresetId?: string
  togglePresetId?: string
  jailbreakToggle?: boolean
  sidebarToggles?: Record<string, string>
}

/**
 * Project chat-scoped sidebar controls onto the legacy CBS `toggle_*` names.
 * The returned map is request-local: callers must not persist it back into
 * global settings because each chat owns its own toggle selections.
 */
export function projectSidebarTogglesToGlobalChatVariables(
  globalChatVariables: unknown,
  sidebarToggles: unknown,
): Record<string, string> {
  const projected: Record<string, string> = {}
  if (isRecord(globalChatVariables)) {
    for (const [key, value] of Object.entries(globalChatVariables)) {
      if (typeof value === 'string') projected[key] = value
    }
  }
  if (isRecord(sidebarToggles)) {
    for (const [key, value] of Object.entries(sidebarToggles)) {
      if (typeof value === 'string') projected[`toggle_${key}`] = value
    }
  }
  return projected
}

export const CHAT_GENERATION_SETTINGS_KEYS = [
  'configured',
  'personaId',
  'modelPresetId',
  'modelPresetSelectionSource',
  'promptPresetId',
  'agentPresetId',
  'togglePresetId',
  'jailbreakToggle',
  'sidebarToggles',
] as const

export type ChatGenerationSettingsKey = (typeof CHAT_GENERATION_SETTINGS_KEYS)[number]

export interface SparseChatGenerationSettingsUpdate {
  patch: Partial<ChatGenerationSettings>
  deleteKeys?: ChatGenerationSettingsKey[]
  sidebarToggleDeleteKeys?: string[]
}

export function serializeChatGenerationSettingsDigestInput(
  settings: ChatGenerationSettings | null | undefined,
): string {
  if (settings == null) return 'chat-generation-settings-base-v1:null'
  const normalized: Record<string, unknown> = {}
  for (const key of CHAT_GENERATION_SETTINGS_KEYS) {
    const value = settings[key]
    if (value === undefined) continue
    if (key === 'sidebarToggles') {
      normalized.sidebarToggles = Object.fromEntries(
        Object.entries(value as Record<string, string>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      )
    } else {
      normalized[key] = value
    }
  }
  return `chat-generation-settings-base-v1:${JSON.stringify(normalized)}`
}

const CHAT_GENERATION_SETTINGS_SCALAR_KEYS = CHAT_GENERATION_SETTINGS_KEYS.filter(
  (key): key is Exclude<ChatGenerationSettingsKey, 'sidebarToggles'> => key !== 'sidebarToggles',
)

export function diffChatGenerationSettings(
  previous: ChatGenerationSettings | undefined,
  attempted: ChatGenerationSettings,
): SparseChatGenerationSettingsUpdate | null {
  const patch: Partial<ChatGenerationSettings> = {}
  const deleteKeys: ChatGenerationSettingsKey[] = []
  const before = previous ?? {}

  for (const key of CHAT_GENERATION_SETTINGS_SCALAR_KEYS) {
    const previousPresent = hasDefinedOwn(before, key)
    const attemptedPresent = hasDefinedOwn(attempted, key)
    if (!attemptedPresent) {
      if (previousPresent) deleteKeys.push(key)
      continue
    }
    if (!previousPresent || !isJsonValueEqual(before[key], attempted[key])) {
      ;(patch as Record<string, unknown>)[key] = cloneJsonValue(attempted[key])
    }
  }

  const previousHasToggles = hasDefinedOwn(before, 'sidebarToggles')
  const attemptedHasToggles = hasDefinedOwn(attempted, 'sidebarToggles')
  const sidebarToggleDeleteKeys: string[] = []
  if (!attemptedHasToggles) {
    if (previousHasToggles) deleteKeys.push('sidebarToggles')
  } else {
    const previousToggles = previousHasToggles ? (before.sidebarToggles ?? {}) : {}
    const attemptedToggles = attempted.sidebarToggles ?? {}
    const sidebarPatch: Record<string, string> = {}
    for (const key of new Set([...Object.keys(previousToggles), ...Object.keys(attemptedToggles)])) {
      if (!Object.prototype.hasOwnProperty.call(attemptedToggles, key)) {
        sidebarToggleDeleteKeys.push(key)
      } else if (
        !Object.prototype.hasOwnProperty.call(previousToggles, key) ||
        previousToggles[key] !== attemptedToggles[key]
      ) {
        sidebarPatch[key] = attemptedToggles[key]
      }
    }
    if (!previousHasToggles || Object.keys(sidebarPatch).length > 0) patch.sidebarToggles = sidebarPatch
  }

  if (Object.keys(patch).length === 0 && deleteKeys.length === 0 && sidebarToggleDeleteKeys.length === 0) return null
  return {
    patch,
    ...(deleteKeys.length ? { deleteKeys: deleteKeys.sort() } : {}),
    ...(sidebarToggleDeleteKeys.length ? { sidebarToggleDeleteKeys: sidebarToggleDeleteKeys.sort() } : {}),
  }
}

export function applySparseChatGenerationSettingsUpdate(
  current: ChatGenerationSettings | undefined,
  update: SparseChatGenerationSettingsUpdate,
): ChatGenerationSettings {
  const next = cloneJsonValue(current ?? {})
  for (const [key, value] of Object.entries(update.patch)) {
    if (key === 'sidebarToggles') continue
    ;(next as Record<string, unknown>)[key] = cloneJsonValue(value)
  }

  if (Object.prototype.hasOwnProperty.call(update.patch, 'sidebarToggles')) {
    next.sidebarToggles = {
      ...(next.sidebarToggles ?? {}),
      ...cloneJsonValue(update.patch.sidebarToggles ?? {}),
    }
  }
  if (next.sidebarToggles) {
    for (const key of update.sidebarToggleDeleteKeys ?? []) delete next.sidebarToggles[key]
  }
  for (const key of update.deleteKeys ?? []) delete next[key]
  return next
}

function hasDefinedOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && (value as Record<PropertyKey, unknown>)[key] !== undefined
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isJsonValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export interface ChatGenerationPersonaReference {
  id?: string | null
  modules?: readonly string[] | null
}

export interface ChatGenerationPromptTemplateItemReference {
  type?: string
  text?: string
  innerFormat?: string | null
  defaultText?: string
}

export interface ChatGenerationModelPresetReference {
  id?: string | null
}

export interface ChatGenerationPromptPresetReference {
  id?: string | null
  recommendedModelPresetId?: string | null
  jailbreak?: string | null
  promptTemplate?: readonly ChatGenerationPromptTemplateItemReference[] | null
  customPromptTemplateToggle?: string | null
}

export type ChatGenerationPresetReference = ChatGenerationPromptPresetReference

export interface ChatGenerationAgentPresetReference {
  id?: string | null
  name?: string | null
  enabled?: boolean | null
  moduleIntergration?: string | null
  agentUses?: readonly Pick<AgentPresetUseRecord, 'agentId' | 'enabled'>[] | null
}

export interface ChatGenerationAgentReference {
  id?: string | null
  name?: string | null
  toggles?: readonly ReadonlyAgentToggleDefinition[] | null
}

export interface ChatGenerationModuleReference {
  id: string
  namespace?: string | null
  customModuleToggle?: string | null
}

export type ChatGenerationSidebarToggleLayoutKind = 'group' | 'groupEnd' | 'divider' | 'caption'

type ChatGenerationSidebarToggleSource =
  | { source: 'preset'; presetId: string }
  | { source: 'module'; moduleId: string; moduleNamespace?: string }
  | { source: 'agent'; agentId: string; agentName?: string; localKey: string }

export interface ChatGenerationRequiredSidebarToggle {
  key: string
  label: string
  kind: ChatGenerationSidebarToggleKind
  options: string[]
  source: 'preset' | 'module' | 'agent'
  presetId?: string
  moduleId?: string
  moduleNamespace?: string
  agentId?: string
  agentName?: string
  localKey?: string
}

export interface ChatGenerationSidebarToggleLayout {
  key?: string
  label: string
  kind: ChatGenerationSidebarToggleLayoutKind
  options: []
  source: 'preset' | 'module' | 'agent'
  presetId?: string
  moduleId?: string
  moduleNamespace?: string
  agentId?: string
  agentName?: string
  localKey?: string
}

export type ChatGenerationDisplayedSidebarToggle =
  | ChatGenerationRequiredSidebarToggle
  | ChatGenerationSidebarToggleLayout

export interface ChatGenerationJailbreakToggleRequirement {
  field: 'jailbreakToggle'
  required: true
  displayed: boolean
}

export interface ChatGenerationControlRequirements {
  modelPreset: ChatGenerationModelPresetReference | undefined
  modelPresetFound: boolean
  promptPreset: ChatGenerationPromptPresetReference | undefined
  promptPresetFound: boolean
  jailbreakToggle: ChatGenerationJailbreakToggleRequirement
  sidebarToggles: ChatGenerationRequiredSidebarToggle[]
}

export interface ResolveChatGenerationRequirementsInput {
  modelPresetId?: string
  promptPresetId?: string
  agentPresetId?: string
  modelPresets: readonly ChatGenerationModelPresetReference[]
  promptPresets: readonly ChatGenerationPromptPresetReference[]
  agentPresets?: readonly ChatGenerationAgentPresetReference[]
  agents?: readonly ChatGenerationAgentReference[]
  modules?: readonly ChatGenerationModuleReference[]
  enabledModuleIds?: readonly string[]
  chatModuleIds?: readonly string[]
  characterModuleIds?: readonly string[]
  personaModuleIds?: readonly string[]
  moduleIntegration?: string | null
}

export interface ResolveChatGenerationSettingsReadinessInput extends ResolveChatGenerationRequirementsInput {
  settings?: ChatGenerationSettings
  personas: readonly ChatGenerationPersonaReference[]
  effectiveAgentPresetId?: string
}

export const CHAT_GENERATION_SETTINGS_MISSING_REASON_CODES = [
  'settings_missing',
  'settings_not_configured',
  'persona_id_missing',
  'persona_missing',
  'model_preset_id_missing',
  'model_preset_missing',
  'prompt_preset_id_missing',
  'prompt_preset_missing',
  'agent_preset_missing',
  'jailbreak_toggle_missing',
  'jailbreak_toggle_invalid',
  'sidebar_toggles_missing',
  'sidebar_toggle_missing',
  'sidebar_toggle_invalid',
] as const

export type ChatGenerationSettingsMissingReasonCode = (typeof CHAT_GENERATION_SETTINGS_MISSING_REASON_CODES)[number]

export type ChatGenerationSettingsFieldPath =
  | typeof CHAT_GENERATION_SETTINGS_FIELD
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.configured`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.personaId`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.modelPresetId`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.modelPresetSelectionSource`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.promptPresetId`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.agentPresetId`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.togglePresetId`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.jailbreakToggle`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles`
  | `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles.${string}`

export type ChatGenerationSettingsMissingReason =
  | {
      code: 'settings_missing'
      field: typeof CHAT_GENERATION_SETTINGS_FIELD
    }
  | {
      code: 'settings_not_configured'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.configured`
    }
  | {
      code: 'persona_id_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.personaId`
    }
  | {
      code: 'persona_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.personaId`
      personaId: string
    }
  | {
      code: 'model_preset_id_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.modelPresetId`
    }
  | {
      code: 'model_preset_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.modelPresetId`
      modelPresetId: string
    }
  | {
      code: 'prompt_preset_id_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.promptPresetId`
    }
  | {
      code: 'prompt_preset_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.promptPresetId`
      promptPresetId: string
    }
  | {
      code: 'agent_preset_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.agentPresetId`
      agentPresetId: string
    }
  | {
      code: 'jailbreak_toggle_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.jailbreakToggle`
    }
  | {
      code: 'jailbreak_toggle_invalid'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.jailbreakToggle`
      actualType: string
    }
  | {
      code: 'sidebar_toggles_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles`
    }
  | {
      code: 'sidebar_toggle_missing'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles.${string}`
      toggleKey: string
    }
  | {
      code: 'sidebar_toggle_invalid'
      field: `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles.${string}`
      toggleKey: string
      actualType: string
    }

export interface ChatGenerationSettingsReadiness {
  ready: boolean
  missing: ChatGenerationSettingsMissingReason[]
  requirements: ChatGenerationControlRequirements
  staleSidebarToggleKeys: string[]
}

export interface ChatGenerationSettingsIncompleteErrorBody {
  statusCode: typeof CHAT_GENERATION_SETTINGS_INCOMPLETE_STATUS
  error: typeof CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR
  message: typeof CHAT_GENERATION_SETTINGS_INCOMPLETE_MESSAGE
  chatId?: string
  missing: ChatGenerationSettingsMissingReason[]
  staleSidebarToggleKeys: string[]
}

export function resolveRequiredSidebarToggles(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationRequiredSidebarToggle[] {
  return collectRequiredSidebarToggles(input)
}

export function resolveDisplayedSidebarToggles(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationDisplayedSidebarToggle[] {
  return collectDisplayedSidebarToggles(input)
}

export function resolveChatGenerationControlRequirements(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationControlRequirements {
  const modelPreset = resolvePreset(input.modelPresets, input.modelPresetId)
  const promptPreset = resolvePreset(input.promptPresets, input.promptPresetId)

  return {
    modelPreset,
    modelPresetFound: !!modelPreset,
    promptPreset,
    promptPresetFound: !!promptPreset,
    jailbreakToggle: {
      field: 'jailbreakToggle',
      required: true,
      displayed: presetDisplaysJailbreakToggle(promptPreset),
    },
    sidebarToggles: collectRequiredSidebarToggles(input),
  }
}

export function resolveChatGenerationSettingsReadiness(
  input: ResolveChatGenerationSettingsReadinessInput,
): ChatGenerationSettingsReadiness {
  const settings = input.settings
  const personaModuleIds = isNonEmptyString(settings?.personaId)
    ? (input.personas.find((persona) => persona.id === settings.personaId)?.modules ?? [])
    : []
  const requirements = resolveChatGenerationControlRequirements({
    ...input,
    personaModuleIds,
    modelPresetId: settings?.modelPresetId,
    promptPresetId: settings?.promptPresetId,
    agentPresetId:
      settings && hasOwn(settings, 'agentPresetId') ? settings.agentPresetId : input.effectiveAgentPresetId,
  })
  const missing: ChatGenerationSettingsMissingReason[] = []

  if (!settings) {
    missing.push({
      code: 'settings_missing',
      field: CHAT_GENERATION_SETTINGS_FIELD,
    })
  }

  if (settings?.configured !== true) {
    missing.push({
      code: 'settings_not_configured',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.configured`,
    })
  }

  const personaId = settings?.personaId
  if (!isNonEmptyString(personaId)) {
    missing.push({
      code: 'persona_id_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.personaId`,
    })
  } else if (!input.personas.some((persona) => persona.id === personaId)) {
    missing.push({
      code: 'persona_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.personaId`,
      personaId,
    })
  }

  const modelPresetId = settings?.modelPresetId
  if (!isNonEmptyString(modelPresetId)) {
    missing.push({
      code: 'model_preset_id_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.modelPresetId`,
    })
  } else if (!requirements.modelPresetFound) {
    missing.push({
      code: 'model_preset_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.modelPresetId`,
      modelPresetId,
    })
  }

  const promptPresetId = settings?.promptPresetId
  if (!isNonEmptyString(promptPresetId)) {
    missing.push({
      code: 'prompt_preset_id_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.promptPresetId`,
    })
  } else if (!requirements.promptPresetFound) {
    missing.push({
      code: 'prompt_preset_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.promptPresetId`,
      promptPresetId,
    })
  }

  const agentPresetId = settings?.agentPresetId
  if (
    isNonEmptyString(agentPresetId) &&
    input.agentPresets &&
    !input.agentPresets.some((preset) => preset.id === agentPresetId)
  ) {
    missing.push({
      code: 'agent_preset_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.agentPresetId`,
      agentPresetId,
    })
  }

  if (!settings || !hasOwn(settings, 'jailbreakToggle')) {
    missing.push({
      code: 'jailbreak_toggle_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.jailbreakToggle`,
    })
  } else if (typeof settings.jailbreakToggle !== 'boolean') {
    missing.push({
      code: 'jailbreak_toggle_invalid',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.jailbreakToggle`,
      actualType: valueType(settings.jailbreakToggle),
    })
  }

  const sidebarToggles = isRecord(settings?.sidebarToggles) ? settings.sidebarToggles : undefined
  if (!sidebarToggles && requirements.sidebarToggles.length > 0) {
    missing.push({
      code: 'sidebar_toggles_missing',
      field: `${CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles`,
    })
  }

  for (const toggle of requirements.sidebarToggles) {
    if (!sidebarToggles || !hasOwn(sidebarToggles, toggle.key)) {
      missing.push({
        code: 'sidebar_toggle_missing',
        field: sidebarToggleField(toggle.key),
        toggleKey: toggle.key,
      })
      continue
    }
    if (typeof sidebarToggles[toggle.key] !== 'string') {
      missing.push({
        code: 'sidebar_toggle_invalid',
        field: sidebarToggleField(toggle.key),
        toggleKey: toggle.key,
        actualType: valueType(sidebarToggles[toggle.key]),
      })
    }
  }

  const requiredToggleKeys = new Set(requirements.sidebarToggles.map((toggle) => toggle.key))
  const staleSidebarToggleKeys = sidebarToggles
    ? Object.keys(sidebarToggles).filter((key) => !requiredToggleKeys.has(key))
    : []

  return {
    ready: missing.length === 0,
    missing,
    requirements,
    staleSidebarToggleKeys,
  }
}

export function createChatGenerationSettingsIncompleteError(
  readiness: Pick<ChatGenerationSettingsReadiness, 'missing' | 'staleSidebarToggleKeys'>,
  chatId?: string,
): ChatGenerationSettingsIncompleteErrorBody {
  const body: ChatGenerationSettingsIncompleteErrorBody = {
    statusCode: CHAT_GENERATION_SETTINGS_INCOMPLETE_STATUS,
    error: CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR,
    message: CHAT_GENERATION_SETTINGS_INCOMPLETE_MESSAGE,
    missing: readiness.missing,
    staleSidebarToggleKeys: readiness.staleSidebarToggleKeys,
  }
  if (chatId !== undefined) {
    body.chatId = chatId
  }
  return body
}

function collectRequiredSidebarToggles(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationRequiredSidebarToggle[] {
  const toggles: ChatGenerationRequiredSidebarToggle[] = []
  const seenKeys = new Set<string>()
  const preset = resolvePreset(input.promptPresets, input.promptPresetId)
  appendUniqueToggles(toggles, seenKeys, resolveActiveAgentToggles(input))

  if (preset?.id) {
    appendUniqueToggles(
      toggles,
      seenKeys,
      parseSidebarToggleSyntax(preset.customPromptTemplateToggle ?? '', {
        source: 'preset',
        presetId: preset.id,
      }),
    )
  }

  for (const module of resolveActiveModules(input)) {
    appendUniqueToggles(
      toggles,
      seenKeys,
      parseSidebarToggleSyntax(module.customModuleToggle ?? '', {
        source: 'module',
        moduleId: module.id,
        moduleNamespace: module.namespace ?? undefined,
      }),
    )
  }

  return toggles
}

function collectDisplayedSidebarToggles(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationDisplayedSidebarToggle[] {
  const toggles: ChatGenerationDisplayedSidebarToggle[] = []
  const seenKeys = new Set<string>()
  const preset = resolvePreset(input.promptPresets, input.promptPresetId)
  appendUniqueDisplayedToggles(toggles, seenKeys, resolveActiveAgentToggles(input))

  if (preset?.id) {
    appendUniqueDisplayedToggles(
      toggles,
      seenKeys,
      parseDisplayedSidebarToggleSyntax(preset.customPromptTemplateToggle ?? '', {
        source: 'preset',
        presetId: preset.id,
      }),
    )
  }

  for (const module of resolveActiveModules(input)) {
    appendUniqueDisplayedToggles(
      toggles,
      seenKeys,
      parseDisplayedSidebarToggleSyntax(module.customModuleToggle ?? '', {
        source: 'module',
        moduleId: module.id,
        moduleNamespace: module.namespace ?? undefined,
      }),
    )
  }

  return toggles
}

function resolveActiveAgentToggles(
  input: ResolveChatGenerationRequirementsInput,
): ChatGenerationRequiredSidebarToggle[] {
  const preset = resolvePreset(input.agentPresets ?? [], input.agentPresetId)
  if (!preset?.agentUses || preset.enabled === false || !input.agents?.length) return []

  const agentsById = new Map(
    input.agents.flatMap((agent) => (isNonEmptyString(agent.id) ? [[agent.id, agent] as const] : [])),
  )
  const toggles: ChatGenerationRequiredSidebarToggle[] = []
  const seenAgents = new Set<string>()
  for (const use of preset.agentUses) {
    if (use.enabled === false || !isNonEmptyString(use.agentId) || seenAgents.has(use.agentId)) continue
    seenAgents.add(use.agentId)
    const agent = agentsById.get(use.agentId)
    if (!agent) continue
    for (const definition of agent.toggles ?? []) {
      if (!isNonEmptyString(definition.key) || !isNonEmptyString(definition.label)) continue
      if (
        definition.kind !== 'boolean' &&
        definition.kind !== 'select' &&
        definition.kind !== 'text' &&
        definition.kind !== 'textarea'
      ) {
        continue
      }
      toggles.push({
        key: agentToggleStorageKey(use.agentId, definition.key),
        label: definition.label,
        kind: definition.kind,
        options: definition.kind === 'select' ? [...definition.options] : [],
        source: 'agent',
        agentId: use.agentId,
        ...(isNonEmptyString(agent.name) ? { agentName: agent.name } : {}),
        localKey: definition.key,
      })
    }
  }
  return toggles
}

function appendUniqueToggles(
  target: ChatGenerationRequiredSidebarToggle[],
  seenKeys: Set<string>,
  toggles: readonly ChatGenerationRequiredSidebarToggle[],
): void {
  for (const toggle of toggles) {
    if (seenKeys.has(toggle.key)) continue
    seenKeys.add(toggle.key)
    target.push(toggle)
  }
}

function appendUniqueDisplayedToggles(
  target: ChatGenerationDisplayedSidebarToggle[],
  seenKeys: Set<string>,
  toggles: readonly ChatGenerationDisplayedSidebarToggle[],
): void {
  for (const toggle of toggles) {
    if (isRequiredSidebarToggle(toggle)) {
      if (seenKeys.has(toggle.key)) continue
      seenKeys.add(toggle.key)
    }
    target.push(toggle)
  }
}

function parseSidebarToggleSyntax(
  syntax: string,
  source: ChatGenerationSidebarToggleSource,
): ChatGenerationRequiredSidebarToggle[] {
  return parseDisplayedSidebarToggleSyntax(syntax, source).filter(isRequiredSidebarToggle)
}

function parseDisplayedSidebarToggleSyntax(
  syntax: string,
  source: ChatGenerationSidebarToggleSource,
): ChatGenerationDisplayedSidebarToggle[] {
  if (!syntax) return []

  const toggles: ChatGenerationDisplayedSidebarToggle[] = []
  for (const line of syntax.split('\n')) {
    const [key, label, rawType, optionText] = line.split('=')
    const layoutKind = normalizeSidebarToggleLayoutKind(rawType)
    if (layoutKind === 'group' || layoutKind === 'groupEnd' || layoutKind === 'divider') {
      toggles.push({
        key: key || undefined,
        label: label ?? '',
        kind: layoutKind,
        options: [],
        ...source,
      })
      continue
    }
    if (layoutKind === 'caption') {
      if (label) {
        toggles.push({
          key: key || undefined,
          label,
          kind: layoutKind,
          options: [],
          ...source,
        })
      }
      continue
    }
    if (!key || !label) {
      continue
    }

    const kind = rawType === 'select' || rawType === 'text' || rawType === 'textarea' ? rawType : 'boolean'
    toggles.push({
      key,
      label,
      kind,
      options: kind === 'select' ? (optionText?.split(',') ?? []) : [],
      ...source,
    })
  }
  return toggles
}

function normalizeSidebarToggleLayoutKind(rawType: string | undefined): ChatGenerationSidebarToggleLayoutKind | null {
  if (rawType === 'group' || rawType === 'groupEnd' || rawType === 'divider' || rawType === 'caption') {
    return rawType
  }
  if (rawType === 'groupend') return 'groupEnd'
  return null
}

function isRequiredSidebarToggle(
  toggle: ChatGenerationDisplayedSidebarToggle,
): toggle is ChatGenerationRequiredSidebarToggle {
  return toggle.kind === 'boolean' || toggle.kind === 'select' || toggle.kind === 'text' || toggle.kind === 'textarea'
}

function resolvePreset<T extends { id?: string | null }>(
  presets: readonly T[],
  presetId: string | undefined,
): T | undefined {
  if (!isNonEmptyString(presetId)) return undefined
  return presets.find((preset) => preset.id === presetId)
}

function resolveActiveModules(input: ResolveChatGenerationRequirementsInput): ChatGenerationModuleReference[] {
  const agentPresetModuleIntegration = resolveAgentPresetModuleIntegration(input.agentPresets, input.agentPresetId)
  const modules = (input.modules ?? []).filter(
    (module): module is ChatGenerationModuleReference => !!module && isNonEmptyString(module.id),
  )
  return resolveModuleActivationStates({
    modules,
    identifiers: {
      global: input.enabledModuleIds?.filter(isNonEmptyString),
      chat: input.chatModuleIds?.filter(isNonEmptyString),
      character: input.characterModuleIds?.filter(isNonEmptyString),
      persona: input.personaModuleIds?.filter(isNonEmptyString),
      promptPresetIntegration: parseModuleIntegration(input.moduleIntegration),
      agentPresetIntegration: parseModuleIntegration(agentPresetModuleIntegration),
    },
  }).map((state) => state.module)
}

function presetDisplaysJailbreakToggle(preset: ChatGenerationPresetReference | undefined): boolean {
  if (!preset) return false
  if (!Array.isArray(preset.promptTemplate)) {
    return typeof preset.jailbreak === 'string' && preset.jailbreak.trim().length > 0
  }
  return preset.promptTemplate.some((item) => {
    if (item.type === 'jailbreak') return true
    return (
      usesJailbreakToggle(item.text) || usesJailbreakToggle(item.innerFormat) || usesJailbreakToggle(item.defaultText)
    )
  })
}

function usesJailbreakToggle(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes(JAILBREAK_TOGGLE_TOKEN)
}

function sidebarToggleField(key: string): `${typeof CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles.${string}` {
  return `${CHAT_GENERATION_SETTINGS_FIELD}.sidebarToggles.${key}`
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}
