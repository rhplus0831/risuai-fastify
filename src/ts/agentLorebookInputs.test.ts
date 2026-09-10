import { describe, expect, it } from 'vitest'
import * as sharedAgentOnlyLorebook from '@risuai/shared-core/agent-only-lorebook'
import * as sharedAgentLorebookInputs from '@risuai/shared-core/agent-lorebook-inputs'
import * as browserAgentLorebookInputs from './agentLorebookInputs'

describe('Agent lorebook browser compatibility', () => {
  it('re-exports shared resolver and marker contracts by identity', () => {
    expect(browserAgentLorebookInputs.resolveAgentLorebookInput).toBe(
      sharedAgentLorebookInputs.resolveAgentLorebookInput,
    )
    expect(browserAgentLorebookInputs.isAgentOnlyLorebookEntry).toBe(sharedAgentOnlyLorebook.isAgentOnlyLorebookEntry)
    expect(browserAgentLorebookInputs.AGENT_ONLY_LOREBOOK_EXTENSION_KEY).toBe(
      sharedAgentOnlyLorebook.AGENT_ONLY_LOREBOOK_EXTENSION_KEY,
    )
  })
})
