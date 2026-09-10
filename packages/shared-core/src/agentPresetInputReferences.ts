import { AGENT_PRESET_STEP_INPUT_SCOPES, type AgentPresetStepInputScope } from './agentPresetRecords.js'

export const AGENT_PRESET_PREPARED_INPUT_CBS_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

const PREPARED_INPUT_SCOPE_NAMES: ReadonlySet<string> = new Set(AGENT_PRESET_STEP_INPUT_SCOPES)

export interface AgentPresetPreparedInputReference {
  scope: AgentPresetStepInputScope
  token: string
  index: number
}

export interface AgentPresetUnknownInputReference {
  name: string
  token: string
  index: number
}

export interface AgentPresetPreparedInputReferenceAnalysis {
  references: AgentPresetPreparedInputReference[]
  unknownReferences: AgentPresetUnknownInputReference[]
  selectedWithoutReference: AgentPresetStepInputScope[]
  referencedWithoutSelection: AgentPresetStepInputScope[]
}

export function agentPresetPreparedInputToken(scope: AgentPresetStepInputScope): string {
  return `{{${scope}}}`
}

export function isAgentPresetPreparedInputScope(value: string): value is AgentPresetStepInputScope {
  return PREPARED_INPUT_SCOPE_NAMES.has(value)
}

export function agentPresetPreparedInputReferences(input: string): {
  references: AgentPresetPreparedInputReference[]
  unknownReferences: AgentPresetUnknownInputReference[]
} {
  const references: AgentPresetPreparedInputReference[] = []
  const unknownReferences: AgentPresetUnknownInputReference[] = []

  for (const match of input.matchAll(AGENT_PRESET_PREPARED_INPUT_CBS_RE)) {
    const name = match[1]
    if (!name) continue
    const reference = { token: match[0], index: match.index ?? 0 }
    if (isAgentPresetPreparedInputScope(name)) references.push({ ...reference, scope: name })
    else unknownReferences.push({ ...reference, name })
  }

  return { references, unknownReferences }
}

export function analyzeAgentPresetPreparedInputReferences(
  input: string,
  selectedScopes: readonly AgentPresetStepInputScope[],
): AgentPresetPreparedInputReferenceAnalysis {
  const { references, unknownReferences } = agentPresetPreparedInputReferences(input)
  const selected = new Set(selectedScopes)
  const referenced = new Set(references.map((reference) => reference.scope))

  return {
    references,
    unknownReferences,
    selectedWithoutReference: AGENT_PRESET_STEP_INPUT_SCOPES.filter(
      (scope) => selected.has(scope) && !referenced.has(scope),
    ),
    referencedWithoutSelection: AGENT_PRESET_STEP_INPUT_SCOPES.filter(
      (scope) => referenced.has(scope) && !selected.has(scope),
    ),
  }
}
