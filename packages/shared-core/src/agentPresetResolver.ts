import {
  AGENT_PRESET_STEP_INPUT_SCOPES,
  type ReadonlyAgentPresetRecord,
  type AgentPresetStepDestination,
  type AgentPresetStepInputScope,
  type AgentPresetStepPhase,
  type AgentPresetStepRecord,
  type AgentPresetValidationIssue,
  type ReadonlyAgentRecord,
  isAgentPresetDirectOutputModifierStep,
  isAgentPresetUserInputModifierStep,
  isValidAgentPresetOutputKey,
  resolveAgentPresetSteps,
  validateAgentPresetRecord,
} from './agentPresetRecords.js'
import { agentPresetOutputReferences, type AgentPresetOutputReference } from './agentPresetOutputReferences.js'
import type { ChatGenerationSettings } from './chatGenerationSettings.js'
import {
  modelProfileGenerationBlockReason,
  resolveModelProfileByProfileId,
  type ModelProfileStatus,
  type ResolvedModelProfile,
} from './modelProfileResolver.js'

const DEFAULT_RECENT_CHAT_TAIL_COUNT = 12
const DEFAULT_RECENT_CHAT_TAIL_MAX_CHARS = 12_000
const DEFAULT_CHAT_SEARCH_LIMIT = 6
const DEFAULT_CHAT_SEARCH_MAX_CHARS = 8_000
const DEFAULT_LOREBOOK_CONTEXT_MAX_CHARS = 10_000
const DEFAULT_MEMORY_CONTEXT_MAX_CHARS = 10_000
const DEFAULT_CHARACTER_SUMMARY_MAX_CHARS = 6_000
const DEFAULT_PERSONA_SUMMARY_MAX_CHARS = 4_000
const DEFAULT_CURRENT_USER_MESSAGE_MAX_CHARS = 8_000
const DEFAULT_PREVIOUS_AGENT_OUTPUTS_MAX_CHARS = 12_000
const DEFAULT_MAIN_DRAFT_MAX_CHARS = 12_000

const INPUT_SCOPE_ORDER = new Map(
  AGENT_PRESET_STEP_INPUT_SCOPES.map((scope, index): [AgentPresetStepInputScope, number] => [scope, index]),
)

export type AgentPresetResolutionStatus =
  | 'none'
  | 'ready'
  | 'disabled'
  | 'missing'
  | 'invalid'
  | 'incomplete'
  | 'model_not_ready'

export type AgentPresetDirectModifierStatus = 'none' | 'valid' | 'multiple' | 'not_last'

export type AgentPresetStepModelReadinessKind =
  | 'inheritMainReady'
  | 'inheritMainIncomplete'
  | 'inheritMainUnsupported'
  | 'selectedProfileReady'
  | 'selectedProfileMissing'
  | 'selectedProfileIncomplete'
  | 'selectedProfileUnsupported'

export interface AgentPresetStepModelReadiness {
  stepId: string
  stepName: string
  kind: AgentPresetStepModelReadinessKind
  ready: boolean
  profileId?: string
  profileName?: string
  modelId?: string
  requestModel?: string
  status?: ModelProfileStatus
  reason?: string
}

export type AgentPresetPreparedInputScopePlan =
  | {
      scope: 'recentChatTail'
      messageCount: number
      maxChars: number
    }
  | {
      scope: 'chatSearchSnippets'
      querySource: 'currentUserMessage'
      limit: number
      maxChars: number
    }
  | {
      scope: 'lorebookContext'
      source: 'selectedChatCharacterAndGlobalLorebooks'
      maxChars: number
    }
  | {
      scope: 'memoryContext'
      source: 'existingMemorySelection'
      maxChars: number
    }
  | {
      scope: 'characterSummary'
      fields: readonly AgentPresetCharacterSummaryField[]
      maxChars: number
    }
  | {
      scope: 'personaSummary'
      fields: readonly AgentPresetPersonaSummaryField[]
      maxChars: number
    }
  | {
      scope: 'currentUserMessage'
      source: 'latestSubmittedUserMessage'
      maxChars: number
    }
  | {
      scope: 'previousAgentOutputs'
      source: 'completedAgentOutputs'
      includePhases: readonly AgentPresetStepPhase[]
      maxChars: number
    }
  | {
      scope: 'mainDraft'
      source: 'postEditOutputDraft'
      available: boolean
      maxChars: number
    }

export type AgentPresetCharacterSummaryField =
  | 'name'
  | 'displayName'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'systemPrompt'
  | 'postHistoryInstructions'
  | 'creatorNotes'

export type AgentPresetPersonaSummaryField = 'selectedPersona' | 'personaPrompt' | 'username'

export interface AgentPresetPlannedStep {
  step: AgentPresetStepRecord
  stableIndex: number
  dependencyLevel: number
  dependencies: readonly string[]
  modelReadiness: AgentPresetStepModelReadiness
  preparedInputs: readonly AgentPresetPreparedInputScopePlan[]
}

export interface AgentPresetDependencyLevel {
  level: number
  stepIds: readonly string[]
}

export interface AgentPresetPhasePlan {
  phase: AgentPresetStepPhase
  steps: readonly AgentPresetPlannedStep[]
  dependencyLevels: readonly AgentPresetDependencyLevel[]
}

export interface AgentPresetNamedOutputRegistryEntry {
  key: string
  phase: AgentPresetStepPhase
  destination: AgentPresetStepDestination
  stepId: string
  stepName: string
  stableIndex: number
}

export interface AgentPresetExecutionPlan {
  presetId: string
  presetName: string
  maxConcurrency?: number
  stableSteps: readonly AgentPresetPlannedStep[]
  beforeMain: AgentPresetPhasePlan
  afterMain: AgentPresetPhasePlan
  namedOutputRegistry: readonly AgentPresetNamedOutputRegistryEntry[]
  userInputModifierStepId?: string
  finalOutputModifierStepId?: string
}

export type AgentPresetOutputReferenceDiagnosticReason =
  | 'missing_output'
  | 'disabled_output'
  | 'self_reference'
  | 'future_phase'
  | 'same_dependency_level'
  | 'not_ordered_before'

export interface AgentPresetOutputReferenceDiagnostic extends AgentPresetOutputReference {
  path: string
  reason: AgentPresetOutputReferenceDiagnosticReason
  consumerStepId?: string
  producerStepIds: readonly string[]
  message: string
}

export interface AgentPresetStatusSummary {
  status: AgentPresetResolutionStatus
  enabled: boolean
  beforeMainStepCount: number
  afterMainStepCount: number
  invalidDependencyCount: number
  missingOutputKeyCount: number
  invalidOutputKeyCount: number
  directModifierStatus: AgentPresetDirectModifierStatus
  estimatedMaxCallsPerGeneration: number
  modelReadiness: readonly AgentPresetStepModelReadiness[]
}

export interface AgentPresetPlanningResult {
  ready: boolean
  issues: readonly AgentPresetValidationIssue[]
  incompleteIssues: readonly AgentPresetValidationIssue[]
  modelReadiness: readonly AgentPresetStepModelReadiness[]
  plan?: AgentPresetExecutionPlan
}

export interface ResolveAgentPresetForChatInput {
  database: AgentPresetResolverDatabase
  currentCharacter?: unknown
  currentChat?: { generationSettings?: Readonly<Pick<ChatGenerationSettings, 'agentPresetId'>> }
  generationSettings?: Readonly<Pick<ChatGenerationSettings, 'agentPresetId'>>
  resolvedMainProfile?: ResolvedModelProfile | null
}

export interface PlanAgentPresetInput {
  database: AgentPresetResolverDatabase
  preset: ReadonlyAgentPresetRecord
  resolvedMainProfile?: ResolvedModelProfile | null
}

export interface AgentPresetResolverDatabase {
  agentPresets: readonly ReadonlyAgentPresetRecord[]
  agents: readonly ReadonlyAgentRecord[]
  modelProfiles: readonly { id: string; name: string }[]
  agentPresetDefaultId?: unknown
}

export type AgentPresetResolution =
  | {
      status: 'none'
      ready: true
      selectedPresetId?: undefined
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'missing'
      ready: false
      selectedPresetId: string
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'disabled'
      ready: true
      selectedPresetId: string
      preset: ReadonlyAgentPresetRecord
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'invalid'
      ready: false
      selectedPresetId: string
      preset: ReadonlyAgentPresetRecord
      issues: readonly AgentPresetValidationIssue[]
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'model_not_ready'
      ready: false
      selectedPresetId: string
      preset: ReadonlyAgentPresetRecord
      plan: AgentPresetExecutionPlan
      modelReadiness: readonly AgentPresetStepModelReadiness[]
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'incomplete'
      ready: false
      selectedPresetId: string
      preset: ReadonlyAgentPresetRecord
      plan: AgentPresetExecutionPlan
      issues: readonly AgentPresetValidationIssue[]
      summary: AgentPresetStatusSummary
    }
  | {
      status: 'ready'
      ready: true
      selectedPresetId: string
      preset: ReadonlyAgentPresetRecord
      plan: AgentPresetExecutionPlan
      summary: AgentPresetStatusSummary
    }

export function resolveAgentPresetForChat(input: ResolveAgentPresetForChatInput): AgentPresetResolution {
  const selectedPresetId = resolveEffectiveAgentPresetId(
    input.database,
    input.generationSettings ?? input.currentChat?.generationSettings,
  )
  if (!selectedPresetId) {
    return {
      status: 'none',
      ready: true,
      summary: createEmptyStatusSummary('none'),
    }
  }

  const preset = input.database.agentPresets.find((candidate) => candidate.id === selectedPresetId)
  if (!preset) {
    return {
      status: 'missing',
      ready: false,
      selectedPresetId,
      summary: createEmptyStatusSummary('missing'),
    }
  }

  if (!preset.enabled) {
    return {
      status: 'disabled',
      ready: true,
      selectedPresetId,
      preset,
      summary: createAgentPresetStatusSummary({
        status: 'disabled',
        preset,
        issues: [],
        modelReadiness: [],
        disabledAsNoop: true,
        agents: input.database.agents,
      }),
    }
  }

  const planning = planAgentPreset({
    database: input.database,
    preset,
    resolvedMainProfile: input.resolvedMainProfile,
  })
  if (!planning.plan) {
    return {
      status: 'invalid',
      ready: false,
      selectedPresetId,
      preset,
      issues: planning.issues,
      summary: createAgentPresetStatusSummary({
        status: 'invalid',
        preset,
        issues: planning.issues,
        modelReadiness: planning.modelReadiness,
        agents: input.database.agents,
      }),
    }
  }

  if (planning.incompleteIssues.length > 0) {
    return {
      status: 'incomplete',
      ready: false,
      selectedPresetId,
      preset,
      plan: planning.plan,
      issues: planning.incompleteIssues,
      summary: createAgentPresetStatusSummary({
        status: 'incomplete',
        preset,
        issues: [...planning.issues, ...planning.incompleteIssues],
        modelReadiness: planning.modelReadiness,
        agents: input.database.agents,
      }),
    }
  }

  if (!planning.ready) {
    return {
      status: 'model_not_ready',
      ready: false,
      selectedPresetId,
      preset,
      plan: planning.plan,
      modelReadiness: planning.modelReadiness,
      summary: createAgentPresetStatusSummary({
        status: 'model_not_ready',
        preset,
        issues: planning.issues,
        modelReadiness: planning.modelReadiness,
        agents: input.database.agents,
      }),
    }
  }

  return {
    status: 'ready',
    ready: true,
    selectedPresetId,
    preset,
    plan: planning.plan,
    summary: createAgentPresetStatusSummary({
      status: 'ready',
      preset,
      issues: planning.issues,
      modelReadiness: planning.modelReadiness,
      agents: input.database.agents,
    }),
  }
}

export function planAgentPreset(input: PlanAgentPresetInput): AgentPresetPlanningResult {
  const agents: readonly ReadonlyAgentRecord[] = Array.isArray(input.database.agents) ? input.database.agents : []
  const resolvedSteps = resolveAgentPresetSteps(input.preset, agents)
  const recordIssues = validateAgentPresetRecord(input.preset, 'agentPreset', agents)
  const planningIssues = validatePhaseLocalDependencies(resolvedSteps)
  const issues = [...recordIssues, ...planningIssues]
  if (issues.length > 0) {
    return {
      ready: false,
      issues,
      incompleteIssues: [],
      modelReadiness: [],
    }
  }

  const enabledSteps = resolvedSteps.filter((step) => step.enabled)
  const modelReadiness = enabledSteps.map((step) =>
    resolveStepModelReadiness(input.database, step, input.resolvedMainProfile),
  )
  const modelReadinessByStepId = new Map(modelReadiness.map((readiness) => [readiness.stepId, readiness]))
  const plan = buildExecutionPlan(input.preset, enabledSteps, modelReadinessByStepId)
  const incompleteIssues = validateAgentOutputReferenceAvailability(
    resolvedSteps,
    plan,
    input.preset.finalOutputTemplate,
  )

  return {
    ready: modelReadiness.every((readiness) => readiness.ready) && incompleteIssues.length === 0,
    issues,
    incompleteIssues,
    modelReadiness,
    plan,
  }
}

export function createAgentPresetStatusSummary({
  status,
  preset,
  issues = [],
  modelReadiness = [],
  disabledAsNoop = false,
  agents = [],
}: {
  status: AgentPresetResolutionStatus
  preset: ReadonlyAgentPresetRecord
  issues?: readonly AgentPresetValidationIssue[]
  modelReadiness?: readonly AgentPresetStepModelReadiness[]
  disabledAsNoop?: boolean
  agents?: readonly ReadonlyAgentRecord[]
}): AgentPresetStatusSummary {
  const enabledSteps = disabledAsNoop ? [] : resolveAgentPresetSteps(preset, agents).filter((step) => step.enabled)
  const beforeMainStepCount = enabledSteps.filter((step) => step.phase === 'beforeMain').length
  const afterMainStepCount = enabledSteps.filter((step) => step.phase === 'afterMain').length
  const missingOutputKeyCount = enabledSteps.filter((step) => !isNonEmptyString(step.outputKey)).length
  const invalidOutputKeyCount = enabledSteps.filter((step) => !isValidAgentPresetOutputKey(step.outputKey)).length

  return {
    status,
    enabled: preset.enabled,
    beforeMainStepCount,
    afterMainStepCount,
    invalidDependencyCount: issues.filter(
      (issue) => issue.code === 'invalid_dependency' || issue.code === 'cyclic_dependency',
    ).length,
    missingOutputKeyCount,
    invalidOutputKeyCount,
    directModifierStatus: directModifierStatus(enabledSteps),
    estimatedMaxCallsPerGeneration: enabledSteps.length,
    modelReadiness,
  }
}

function buildExecutionPlan(
  preset: ReadonlyAgentPresetRecord,
  enabledSteps: readonly AgentPresetStepRecord[],
  modelReadinessByStepId: ReadonlyMap<string, AgentPresetStepModelReadiness>,
): AgentPresetExecutionPlan {
  const stableIndexByStepId = new Map(enabledSteps.map((step, index) => [step.id, index]))
  const plannedById = new Map<string, AgentPresetPlannedStep>()

  const phasePlan = (phase: AgentPresetStepPhase): AgentPresetPhasePlan => {
    const steps = enabledSteps.filter((step) => step.phase === phase)
    const dependencyLevelByStepId = dependencyLevelsForPhase(steps)
    const plannedSteps = steps.map((step) => {
      const stableIndex = stableIndexByStepId.get(step.id) ?? 0
      const planned: AgentPresetPlannedStep = {
        step,
        stableIndex,
        dependencyLevel: dependencyLevelByStepId.get(step.id) ?? 0,
        dependencies: step.dependencies,
        modelReadiness: modelReadinessByStepId.get(step.id) ?? fallbackModelReadiness(step),
        preparedInputs: planPreparedInputs(step),
      }
      plannedById.set(step.id, planned)
      return planned
    })
    return {
      phase,
      steps: plannedSteps,
      dependencyLevels: groupDependencyLevels(plannedSteps),
    }
  }

  const beforeMain = phasePlan('beforeMain')
  const afterMain = phasePlan('afterMain')
  const stableSteps = enabledSteps.map((step) => plannedById.get(step.id) ?? plannedStepFallback(step))
  const userInputModifier = enabledSteps.find(
    (step) => step.phase === 'beforeMain' && isAgentPresetUserInputModifierStep(step),
  )
  const finalOutputModifier = enabledSteps.find(
    (step) => step.phase === 'afterMain' && isAgentPresetDirectOutputModifierStep(step),
  )

  return {
    presetId: preset.id,
    presetName: preset.name,
    ...(preset.maxConcurrency !== undefined ? { maxConcurrency: preset.maxConcurrency } : {}),
    stableSteps,
    beforeMain,
    afterMain,
    namedOutputRegistry: enabledSteps.map((step, stableIndex) => ({
      key: step.outputKey,
      phase: step.phase,
      destination: step.destination,
      stepId: step.id,
      stepName: step.name,
      stableIndex,
    })),
    ...(userInputModifier ? { userInputModifierStepId: userInputModifier.id } : {}),
    ...(finalOutputModifier ? { finalOutputModifierStepId: finalOutputModifier.id } : {}),
  }
}

export function diagnoseAgentPresetOutputReferences(
  steps: readonly AgentPresetStepRecord[],
  plan: AgentPresetExecutionPlan,
  finalOutputTemplate?: string,
): AgentPresetOutputReferenceDiagnostic[] {
  const diagnostics: AgentPresetOutputReferenceDiagnostic[] = []
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]))
  const allStepsByKey = new Map<string, AgentPresetStepRecord[]>()
  const producersByKey = new Map<string, AgentPresetPlannedStep[]>()

  for (const step of steps) {
    const producers = allStepsByKey.get(step.outputKey) ?? []
    producers.push(step)
    allStepsByKey.set(step.outputKey, producers)
  }

  for (const planned of plan.stableSteps) {
    const producers = producersByKey.get(planned.step.outputKey) ?? []
    producers.push(planned)
    producersByKey.set(planned.step.outputKey, producers)
  }

  for (const consumer of plan.stableSteps) {
    const references = agentPresetOutputReferences(consumer.step.instruction)
    if (references.length === 0) continue
    const path = `agentPreset.steps[${stepIndexById.get(consumer.step.id) ?? consumer.stableIndex}].instruction`

    for (const reference of references) {
      const producers = producersByKey.get(reference.key) ?? []
      if (producers.length === 0) {
        const disabledProducers = (allStepsByKey.get(reference.key) ?? []).filter((step) => !step.enabled)
        const reason = disabledProducers.length > 0 ? 'disabled_output' : 'missing_output'
        diagnostics.push({
          ...reference,
          path,
          reason,
          consumerStepId: consumer.step.id,
          producerStepIds: disabledProducers.map((step) => step.id),
          message:
            reason === 'disabled_output'
              ? `Agent CBS reference ${reference.token} uses output key "${reference.key}", but every matching Agent use is disabled.`
              : `Agent CBS reference ${reference.token} has no enabled Agent Preset output key "${reference.key}".`,
        })
        continue
      }

      if (producers.some((producer) => isAgentOutputAvailableToStep(producer, consumer))) continue

      diagnostics.push({
        ...reference,
        path,
        reason: unavailableAgentOutputReason(consumer, producers),
        consumerStepId: consumer.step.id,
        producerStepIds: producers.map((producer) => producer.step.id),
        message: unavailableAgentOutputMessage(reference.token, reference.key, consumer, producers),
      })
    }
  }

  if (finalOutputTemplate) {
    for (const reference of agentPresetOutputReferences(finalOutputTemplate)) {
      if (producersByKey.has(reference.key)) continue
      const disabledProducers = (allStepsByKey.get(reference.key) ?? []).filter((step) => !step.enabled)
      const reason = disabledProducers.length > 0 ? 'disabled_output' : 'missing_output'
      diagnostics.push({
        ...reference,
        path: 'agentPreset.finalOutputTemplate',
        reason,
        producerStepIds: disabledProducers.map((step) => step.id),
        message:
          reason === 'disabled_output'
            ? `Final output CBS reference ${reference.token} uses output key "${reference.key}", but every matching Agent use is disabled.`
            : `Final output CBS reference ${reference.token} has no enabled Agent Preset output key "${reference.key}".`,
      })
    }
  }

  return diagnostics
}

function validateAgentOutputReferenceAvailability(
  steps: readonly AgentPresetStepRecord[],
  plan: AgentPresetExecutionPlan,
  finalOutputTemplate?: string,
): AgentPresetValidationIssue[] {
  return diagnoseAgentPresetOutputReferences(steps, plan, finalOutputTemplate).map((diagnostic) => ({
    code: 'unavailable_agent_output',
    path: diagnostic.path,
    message: diagnostic.message,
  }))
}

function isAgentOutputAvailableToStep(producer: AgentPresetPlannedStep, consumer: AgentPresetPlannedStep): boolean {
  if (producer.step.id === consumer.step.id) return false
  if (consumer.step.phase === 'beforeMain') {
    return producer.step.phase === 'beforeMain' && producer.dependencyLevel < consumer.dependencyLevel
  }
  if (producer.step.phase === 'beforeMain') return true
  return producer.step.phase === 'afterMain' && producer.dependencyLevel < consumer.dependencyLevel
}

function unavailableAgentOutputMessage(
  token: string,
  key: string,
  consumer: AgentPresetPlannedStep,
  producers: readonly AgentPresetPlannedStep[],
): string {
  const producerSummary = producers
    .map((producer) => `${producer.step.name} (${producer.step.phase}, level ${producer.dependencyLevel})`)
    .join(', ')

  if (consumer.step.phase === 'beforeMain' && producers.some((producer) => producer.step.phase === 'afterMain')) {
    return `Agent CBS reference ${token} is unavailable in before-main step "${consumer.step.name}" because output key "${key}" is produced after the main response.`
  }

  if (producers.some((producer) => producer.dependencyLevel === consumer.dependencyLevel)) {
    return `Agent CBS reference ${token} is unavailable in step "${consumer.step.name}" because output key "${key}" is produced by a same-level step. Add a dependency so the producer runs earlier.`
  }

  return `Agent CBS reference ${token} is unavailable in step "${consumer.step.name}" at ${consumer.step.phase} level ${consumer.dependencyLevel}; producers: ${producerSummary}.`
}

function unavailableAgentOutputReason(
  consumer: AgentPresetPlannedStep,
  producers: readonly AgentPresetPlannedStep[],
): AgentPresetOutputReferenceDiagnosticReason {
  if (producers.every((producer) => producer.step.id === consumer.step.id)) return 'self_reference'
  if (consumer.step.phase === 'beforeMain' && producers.some((producer) => producer.step.phase === 'afterMain')) {
    return 'future_phase'
  }
  if (producers.some((producer) => producer.dependencyLevel === consumer.dependencyLevel)) {
    return 'same_dependency_level'
  }
  return 'not_ordered_before'
}

function dependencyLevelsForPhase(steps: readonly AgentPresetStepRecord[]): Map<string, number> {
  const stepsById = new Map(steps.map((step) => [step.id, step]))
  const memo = new Map<string, number>()

  const levelFor = (step: AgentPresetStepRecord): number => {
    const cached = memo.get(step.id)
    if (cached !== undefined) return cached
    const dependencyLevels = step.dependencies
      .map((dependencyId) => stepsById.get(dependencyId))
      .filter((dependency): dependency is AgentPresetStepRecord => !!dependency)
      .map((dependency) => levelFor(dependency))
    const level = dependencyLevels.length > 0 ? Math.max(...dependencyLevels) + 1 : 0
    memo.set(step.id, level)
    return level
  }

  for (const step of steps) levelFor(step)
  return memo
}

function groupDependencyLevels(steps: readonly AgentPresetPlannedStep[]): AgentPresetDependencyLevel[] {
  const grouped = new Map<number, string[]>()
  for (const step of steps) {
    const stepIds = grouped.get(step.dependencyLevel) ?? []
    stepIds.push(step.step.id)
    grouped.set(step.dependencyLevel, stepIds)
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).map(([level, stepIds]) => ({ level, stepIds }))
}

function resolveStepModelReadiness(
  database: AgentPresetResolverDatabase,
  step: AgentPresetStepRecord,
  resolvedMainProfile?: ResolvedModelProfile | null,
): AgentPresetStepModelReadiness {
  if (step.model.mode === 'inheritMain') {
    return inheritMainReadiness(step, resolvedMainProfile)
  }

  const requestedProfileId = step.model.profileId.trim()
  const storedProfile = database.modelProfiles.find((profile) => profile.id === requestedProfileId)
  if (!storedProfile) {
    return {
      stepId: step.id,
      stepName: step.name,
      kind: 'selectedProfileMissing',
      ready: false,
      profileId: requestedProfileId,
      reason: `Selected model profile does not exist: ${requestedProfileId}`,
    }
  }

  const profile = resolveModelProfileByProfileId({
    database,
    role: 'chatAux',
    profileId: requestedProfileId,
  })
  if (!profile) {
    return {
      stepId: step.id,
      stepName: step.name,
      kind: 'selectedProfileIncomplete',
      ready: false,
      profileId: storedProfile.id,
      profileName: storedProfile.name,
      reason: `Selected model profile is incomplete: ${storedProfile.name}`,
    }
  }

  return readinessFromResolvedProfile(step, profile, 'selectedProfile')
}

function inheritMainReadiness(
  step: AgentPresetStepRecord,
  resolvedMainProfile?: ResolvedModelProfile | null,
): AgentPresetStepModelReadiness {
  if (!resolvedMainProfile) {
    return {
      stepId: step.id,
      stepName: step.name,
      kind: 'inheritMainReady',
      ready: true,
    }
  }

  return readinessFromResolvedProfile(step, resolvedMainProfile, 'inheritMain')
}

function readinessFromResolvedProfile(
  step: AgentPresetStepRecord,
  profile: ResolvedModelProfile,
  source: 'inheritMain' | 'selectedProfile',
): AgentPresetStepModelReadiness {
  const blockReason = modelProfileGenerationBlockReason(profile)
  const base = {
    stepId: step.id,
    stepName: step.name,
    profileId: profile.source.profileId ?? profile.profileId,
    profileName: profile.source.profileName,
    modelId: profile.modelId,
    requestModel: profile.requestModel,
    status: profile.status,
    reason: blockReason ?? undefined,
  }

  if (profile.status.bucket === 'incomplete') {
    return {
      ...base,
      kind: source === 'inheritMain' ? 'inheritMainIncomplete' : 'selectedProfileIncomplete',
      ready: false,
    }
  }
  if (profile.status.bucket === 'unsupported') {
    return {
      ...base,
      kind: source === 'inheritMain' ? 'inheritMainUnsupported' : 'selectedProfileUnsupported',
      ready: false,
    }
  }

  return {
    ...base,
    kind: source === 'inheritMain' ? 'inheritMainReady' : 'selectedProfileReady',
    ready: true,
  }
}

function planPreparedInputs(step: AgentPresetStepRecord): AgentPresetPreparedInputScopePlan[] {
  return orderedInputScopes(step.inputScopes).map((scope) => preparedInputScopePlan(step, scope))
}

function preparedInputScopePlan(
  step: AgentPresetStepRecord,
  scope: AgentPresetStepInputScope,
): AgentPresetPreparedInputScopePlan {
  switch (scope) {
    case 'recentChatTail':
      return {
        scope,
        messageCount: DEFAULT_RECENT_CHAT_TAIL_COUNT,
        maxChars: maxCharsForScope(step, DEFAULT_RECENT_CHAT_TAIL_MAX_CHARS),
      }
    case 'chatSearchSnippets':
      return {
        scope,
        querySource: 'currentUserMessage',
        limit: DEFAULT_CHAT_SEARCH_LIMIT,
        maxChars: maxCharsForScope(step, DEFAULT_CHAT_SEARCH_MAX_CHARS),
      }
    case 'lorebookContext':
      return {
        scope,
        source: 'selectedChatCharacterAndGlobalLorebooks',
        maxChars: maxCharsForScope(step, DEFAULT_LOREBOOK_CONTEXT_MAX_CHARS),
      }
    case 'memoryContext':
      return {
        scope,
        source: 'existingMemorySelection',
        maxChars: maxCharsForScope(step, DEFAULT_MEMORY_CONTEXT_MAX_CHARS),
      }
    case 'characterSummary':
      return {
        scope,
        fields: [
          'name',
          'displayName',
          'description',
          'personality',
          'scenario',
          'systemPrompt',
          'postHistoryInstructions',
          'creatorNotes',
        ],
        maxChars: maxCharsForScope(step, DEFAULT_CHARACTER_SUMMARY_MAX_CHARS),
      }
    case 'personaSummary':
      return {
        scope,
        fields: ['selectedPersona', 'personaPrompt', 'username'],
        maxChars: maxCharsForScope(step, DEFAULT_PERSONA_SUMMARY_MAX_CHARS),
      }
    case 'currentUserMessage':
      return {
        scope,
        source: 'latestSubmittedUserMessage',
        maxChars: maxCharsForScope(step, DEFAULT_CURRENT_USER_MESSAGE_MAX_CHARS),
      }
    case 'previousAgentOutputs':
      return {
        scope,
        source: 'completedAgentOutputs',
        includePhases: step.phase === 'beforeMain' ? ['beforeMain'] : ['beforeMain', 'afterMain'],
        maxChars: maxCharsForScope(step, DEFAULT_PREVIOUS_AGENT_OUTPUTS_MAX_CHARS),
      }
    case 'mainDraft':
      return {
        scope,
        source: 'postEditOutputDraft',
        available: step.phase === 'afterMain',
        maxChars: maxCharsForScope(step, DEFAULT_MAIN_DRAFT_MAX_CHARS),
      }
  }
}

function orderedInputScopes(inputScopes: readonly AgentPresetStepInputScope[]): AgentPresetStepInputScope[] {
  return [...new Set(inputScopes)].sort((a, b) => (INPUT_SCOPE_ORDER.get(a) ?? 0) - (INPUT_SCOPE_ORDER.get(b) ?? 0))
}

function maxCharsForScope(step: AgentPresetStepRecord, defaultMaxChars: number): number {
  const maxInputChars = step.runtime.maxInputChars
  if (maxInputChars === undefined) return defaultMaxChars
  return Math.max(0, Math.min(defaultMaxChars, maxInputChars))
}

function validatePhaseLocalDependencies(steps: readonly AgentPresetStepRecord[]): AgentPresetValidationIssue[] {
  const issues: AgentPresetValidationIssue[] = []
  const enabledById = new Map(steps.filter((step) => step.enabled).map((step) => [step.id, step]))

  steps.forEach((step, index) => {
    if (!step.enabled) return
    const dependencies = Array.isArray(step.dependencies) ? step.dependencies : []
    for (const dependencyId of dependencies) {
      const dependency = enabledById.get(dependencyId)
      if (dependency && step.phase === 'afterMain' && dependency.phase === 'beforeMain') {
        issues.push({
          code: 'invalid_dependency',
          path: `agentPreset.steps[${index}].dependencies`,
          message: 'Agent Preset step dependencies must stay within the same execution phase',
        })
      }
    }
  })

  return issues
}

function directModifierStatus(enabledSteps: readonly AgentPresetStepRecord[]): AgentPresetDirectModifierStatus {
  const afterMainSteps = enabledSteps.filter((step) => step.phase === 'afterMain')
  const modifiers = afterMainSteps.filter(isAgentPresetDirectOutputModifierStep)
  if (modifiers.length === 0) return 'none'
  if (modifiers.length > 1) return 'multiple'
  return afterMainSteps[afterMainSteps.length - 1] === modifiers[0] ? 'valid' : 'not_last'
}

export function resolveEffectiveAgentPresetId(
  database: Pick<AgentPresetResolverDatabase, 'agentPresetDefaultId'>,
  settings: Readonly<Pick<ChatGenerationSettings, 'agentPresetId'>> | undefined,
): string | undefined {
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'agentPresetId')) {
    return nonBlankAgentPresetId(settings.agentPresetId)
  }
  return nonBlankAgentPresetId(database.agentPresetDefaultId)
}

function nonBlankAgentPresetId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function createEmptyStatusSummary(status: AgentPresetResolutionStatus): AgentPresetStatusSummary {
  return {
    status,
    enabled: false,
    beforeMainStepCount: 0,
    afterMainStepCount: 0,
    invalidDependencyCount: 0,
    missingOutputKeyCount: 0,
    invalidOutputKeyCount: 0,
    directModifierStatus: 'none',
    estimatedMaxCallsPerGeneration: 0,
    modelReadiness: [],
  }
}

function fallbackModelReadiness(step: AgentPresetStepRecord): AgentPresetStepModelReadiness {
  return {
    stepId: step.id,
    stepName: step.name,
    kind: 'inheritMainReady',
    ready: true,
  }
}

function plannedStepFallback(step: AgentPresetStepRecord): AgentPresetPlannedStep {
  return {
    step,
    stableIndex: 0,
    dependencyLevel: 0,
    dependencies: step.dependencies,
    modelReadiness: fallbackModelReadiness(step),
    preparedInputs: planPreparedInputs(step),
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
