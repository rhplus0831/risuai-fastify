import { describe, expect, it } from 'vitest'
import { agentAuthoringIssues } from './agentAuthoringIssues'

function issues(overrides: Partial<Parameters<typeof agentAuthoringIssues>[0]> = {}) {
  return agentAuthoringIssues({
    name: 'Researcher',
    generatedDefaultName: 'New Agent',
    instruction: '{{currentUserMessage}}',
    useChatML: false,
    inputScopes: ['currentUserMessage'],
    outputFormat: 'text',
    structuredOutputStrict: false,
    ...overrides,
  })
}

describe('Agent authoring issues', () => {
  it('returns localized field-linked mismatch warnings with direct repair actions', () => {
    expect(issues({ instruction: '{{mainDraft}} {{unknownToken}}', inputScopes: ['currentUserMessage'] })).toEqual([
      expect.objectContaining({
        severity: 'warning',
        field: 'instruction',
        messageKey: 'issuePreparedInputSelectedButUnused',
        scope: 'currentUserMessage',
        recoveryActions: [
          { kind: 'insertPreparedInput', scope: 'currentUserMessage', token: '{{currentUserMessage}}' },
          { kind: 'deselectPreparedInput', scope: 'currentUserMessage' },
        ],
      }),
      expect.objectContaining({
        severity: 'warning',
        field: 'inputScopes',
        messageKey: 'issuePreparedInputUsedButUnselected',
        scope: 'mainDraft',
        recoveryActions: [{ kind: 'enablePreparedInput', scope: 'mainDraft' }],
      }),
    ])
  })

  it('keeps no-op and generated-name guidance as warnings but grammar mismatches as errors', () => {
    expect(
      issues({
        name: 'New Agent',
        instruction: '',
        useChatML: true,
        inputScopes: [],
        structuredOutputStrict: true,
      }).map(({ id, severity, field }) => ({ id, severity, field })),
    ).toEqual([
      { id: 'instruction-empty', severity: 'warning', field: 'instruction' },
      { id: 'name-generated', severity: 'warning', field: 'name' },
      { id: 'instruction-chatml', severity: 'error', field: 'instruction' },
      { id: 'output-format-strict', severity: 'error', field: 'outputFormat' },
    ])
  })
})
