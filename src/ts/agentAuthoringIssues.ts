import { agentPresetPreparedInputToken, analyzeAgentPresetPreparedInputReferences } from './agentPresetInputReferences'
import type { AgentPresetStepInputScope, AgentPresetStepOutputFormat } from './agentPresetRecords'
import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'

export type AgentAuthoringIssueSeverity = 'warning' | 'error'
export type AgentAuthoringIssueField = 'name' | 'instruction' | 'inputScopes' | 'outputFormat'
export type AgentAuthoringIssueMessageKey =
  | 'issuePreparedInputSelectedButUnused'
  | 'issuePreparedInputUsedButUnselected'
  | 'issueEmptyInstruction'
  | 'issueGeneratedName'
  | 'issueInvalidChatML'
  | 'issueStrictOutputRequiresJson'

export type AgentAuthoringRecoveryAction =
  | { kind: 'insertPreparedInput'; scope: AgentPresetStepInputScope; token: string }
  | { kind: 'deselectPreparedInput'; scope: AgentPresetStepInputScope }
  | { kind: 'enablePreparedInput'; scope: AgentPresetStepInputScope }
  | { kind: 'focusField'; field: AgentAuthoringIssueField }

export interface AgentAuthoringIssue {
  id: string
  severity: AgentAuthoringIssueSeverity
  field: AgentAuthoringIssueField
  messageKey: AgentAuthoringIssueMessageKey
  scope?: AgentPresetStepInputScope
  recoveryActions: readonly AgentAuthoringRecoveryAction[]
}

export function agentAuthoringIssues(input: {
  name: string
  generatedDefaultName: string
  instruction: string
  useChatML: boolean
  inputScopes: readonly AgentPresetStepInputScope[]
  outputFormat: AgentPresetStepOutputFormat
  structuredOutputStrict: boolean
}): AgentAuthoringIssue[] {
  const issues: AgentAuthoringIssue[] = []
  const inputReferences = analyzeAgentPresetPreparedInputReferences(input.instruction, input.inputScopes)

  for (const scope of inputReferences.selectedWithoutReference) {
    issues.push({
      id: `prepared-input-selected:${scope}`,
      severity: 'warning',
      field: 'instruction',
      messageKey: 'issuePreparedInputSelectedButUnused',
      scope,
      recoveryActions: [
        { kind: 'insertPreparedInput', scope, token: agentPresetPreparedInputToken(scope) },
        { kind: 'deselectPreparedInput', scope },
      ],
    })
  }

  for (const scope of inputReferences.referencedWithoutSelection) {
    issues.push({
      id: `prepared-input-unselected:${scope}`,
      severity: 'warning',
      field: 'inputScopes',
      messageKey: 'issuePreparedInputUsedButUnselected',
      scope,
      recoveryActions: [{ kind: 'enablePreparedInput', scope }],
    })
  }

  if (input.instruction.trim().length === 0) {
    issues.push({
      id: 'instruction-empty',
      severity: 'warning',
      field: 'instruction',
      messageKey: 'issueEmptyInstruction',
      recoveryActions: [{ kind: 'focusField', field: 'instruction' }],
    })
  }
  if (input.name.trim() === input.generatedDefaultName.trim()) {
    issues.push({
      id: 'name-generated',
      severity: 'warning',
      field: 'name',
      messageKey: 'issueGeneratedName',
      recoveryActions: [{ kind: 'focusField', field: 'name' }],
    })
  }
  if (input.useChatML && parseChatMLRows(input.instruction) === null) {
    issues.push({
      id: 'instruction-chatml',
      severity: 'error',
      field: 'instruction',
      messageKey: 'issueInvalidChatML',
      recoveryActions: [{ kind: 'focusField', field: 'instruction' }],
    })
  }
  if (input.structuredOutputStrict && input.outputFormat !== 'jsonObject') {
    issues.push({
      id: 'output-format-strict',
      severity: 'error',
      field: 'outputFormat',
      messageKey: 'issueStrictOutputRequiresJson',
      recoveryActions: [{ kind: 'focusField', field: 'outputFormat' }],
    })
  }

  return issues
}
