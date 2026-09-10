import { describe, expect, it } from 'vitest'
import {
  agentPresetPreparedInputReferences,
  agentPresetPreparedInputToken,
  analyzeAgentPresetPreparedInputReferences,
} from './agentPresetInputReferences.js'

describe('Agent Preset prepared-input references', () => {
  it('preserves exact known tokens, UTF-16 indexes, and repeat order', () => {
    expect(
      agentPresetPreparedInputReferences('🙂 {{ currentUserMessage }} / {{currentUserMessage}} / {{recentChatTail}}')
        .references,
    ).toEqual([
      { scope: 'currentUserMessage', token: '{{ currentUserMessage }}', index: 3 },
      { scope: 'currentUserMessage', token: '{{currentUserMessage}}', index: 30 },
      { scope: 'recentChatTail', token: '{{recentChatTail}}', index: 55 },
    ])
    expect(agentPresetPreparedInputToken('mainDraft')).toBe('{{mainDraft}}')
  })

  it('reports both mismatch directions in canonical scope order', () => {
    expect(
      analyzeAgentPresetPreparedInputReferences('{{mainDraft}} {{currentUserMessage}}', [
        'personaSummary',
        'currentUserMessage',
        'recentChatTail',
      ]),
    ).toMatchObject({
      selectedWithoutReference: ['recentChatTail', 'personaSummary'],
      referencedWithoutSelection: ['mainDraft'],
    })
  })

  it('keeps unknown bare tokens separate and ignores namespaced or malformed tokens', () => {
    expect(
      agentPresetPreparedInputReferences(
        '{{unknownScope}} {{agent::result}} {{agentInput::notes}} {{has-dash}} {{9invalid}}',
      ),
    ).toEqual({
      references: [],
      unknownReferences: [{ name: 'unknownScope', token: '{{unknownScope}}', index: 0 }],
    })
  })
})
