import {
  planAgentPreset,
  type AgentPresetPlanningResult,
  type AgentPresetResolverDatabase,
} from './agentPresetResolver'
import { resolveAgentPresetSteps, type AgentPresetRecord } from './agentPresetRecords'

export type AgentPresetPresentationStatusKind =
  | 'ready'
  | 'empty'
  | 'disabled'
  | 'invalid'
  | 'incomplete'
  | 'model_not_ready'

export interface AgentPresetPresentationStatus {
  kind: AgentPresetPresentationStatusKind
  tone: 'ready' | 'muted' | 'warning' | 'error'
  enabledUseCount: number
  planning: AgentPresetPlanningResult
}

export function agentPresetPresentationStatus(input: {
  preset: AgentPresetRecord
  database: AgentPresetResolverDatabase
}): AgentPresetPresentationStatus {
  const planning = planAgentPreset(input)
  const enabledUseCount = resolveAgentPresetSteps(input.preset, input.database.agents).filter(
    (step) => step.enabled,
  ).length

  if (!input.preset.enabled) return { kind: 'disabled', tone: 'muted', enabledUseCount, planning }
  if (!planning.plan) return { kind: 'invalid', tone: 'error', enabledUseCount, planning }
  if (planning.incompleteIssues.length > 0) {
    return { kind: 'incomplete', tone: 'warning', enabledUseCount, planning }
  }
  if (!planning.ready) return { kind: 'model_not_ready', tone: 'warning', enabledUseCount, planning }
  if (enabledUseCount === 0) return { kind: 'empty', tone: 'muted', enabledUseCount, planning }
  return { kind: 'ready', tone: 'ready', enabledUseCount, planning }
}
