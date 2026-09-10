import { describe, expect, it } from 'vitest'
import { resolveAgentLorebookInput, type AgentLorebookEntryLike } from './agentLorebookInputs'

function entry(overrides: Partial<AgentLorebookEntryLike> = {}): AgentLorebookEntryLike {
  return {
    key: '',
    secondkey: '',
    comment: 'Reference Notes',
    content: 'Reference content',
    mode: 'normal',
    alwaysActive: false,
    agentOnly: true,
    ...overrides,
  }
}

const requiredInput = { key: 'reference', displayName: 'Reference Notes', required: true }

describe('shared Agent lorebook input resolution', () => {
  it('uses a chat match before a character match without database types', () => {
    const resolution = resolveAgentLorebookInput(
      requiredInput,
      { globalLore: [entry({ content: 'Character value' })] },
      { localLore: [entry({ content: 'Chat value' })] },
    )

    expect(resolution).toMatchObject({ status: 'resolved', scope: 'chat', content: 'Chat value' })
  })

  it('does not fall back when the winning chat-level override is invalid', () => {
    const resolution = resolveAgentLorebookInput(
      requiredInput,
      { globalLore: [entry({ content: 'Character value' })] },
      { localLore: [entry({ agentOnly: false })] },
    )

    expect(resolution).toMatchObject({ status: 'not_agent_only', scope: 'chat' })
  })

  it('reports duplicate names and optional missing inputs', () => {
    expect(
      resolveAgentLorebookInput(requiredInput, { globalLore: [] }, { localLore: [entry(), entry({ key: 'two' })] }),
    ).toMatchObject({ status: 'ambiguous', scope: 'chat' })
    expect(
      resolveAgentLorebookInput({ ...requiredInput, required: false }, { globalLore: [] }, { localLore: [] }),
    ).toEqual({ status: 'optional_missing', input: { ...requiredInput, required: false } })
  })

  it('preserves activation, entry-shape, and content validation', () => {
    for (const invalidActivation of [{ alwaysActive: true }, { key: 'primary' }, { secondkey: 'secondary' }]) {
      expect(resolveAgentLorebookInput(requiredInput, { globalLore: [entry(invalidActivation)] }, {})).toMatchObject({
        status: 'invalid_activation',
        scope: 'character',
      })
    }
    expect(resolveAgentLorebookInput(requiredInput, { globalLore: [entry({ mode: 'child' })] }, {})).toMatchObject({
      status: 'invalid_entry',
      scope: 'character',
    })
    expect(resolveAgentLorebookInput(requiredInput, { globalLore: [entry({ content: '   ' })] }, {})).toMatchObject({
      status: 'empty',
      scope: 'character',
    })
  })
})
