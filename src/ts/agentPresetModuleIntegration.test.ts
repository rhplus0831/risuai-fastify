import { describe, expect, it } from 'vitest'

import {
  agentPresetModuleIntegrationOptions,
  parseAgentPresetModuleIntegration,
  serializeAgentPresetModuleIntegration,
  unknownAgentPresetModuleIntegrations,
} from './agentPresetModuleIntegration'

describe('Agent Preset module integration authoring', () => {
  it('round-trips trimmed unknown namespaces and deduplicates existing values', () => {
    const selected = parseAgentPresetModuleIntegration(' known-id, custom-space, known-id ')
    expect(selected).toEqual(['known-id', 'custom-space'])
    expect(serializeAgentPresetModuleIntegration([...selected, ' custom-space ', 'next-space'])).toBe(
      'known-id, custom-space, next-space',
    )
  })

  it('offers valid module IDs and namespaces with a stable value identity', () => {
    const options = agentPresetModuleIntegrationOptions([
      { id: 'module-a', name: 'Research Tools', namespace: 'research' },
      { id: 'research', name: 'Duplicate Value', namespace: 'other-space' },
      { id: '', namespace: '  ' },
      null,
    ])
    expect(options).toEqual([
      { value: 'module-a', label: 'Research Tools', kind: 'id' },
      { value: 'research', label: 'Research Tools', kind: 'namespace' },
      { value: 'other-space', label: 'Duplicate Value', kind: 'namespace' },
    ])
    expect(unknownAgentPresetModuleIntegrations(['module-a', 'custom-space'], options)).toEqual(['custom-space'])
  })
})
