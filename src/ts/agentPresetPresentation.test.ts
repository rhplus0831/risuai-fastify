import { describe, expect, it } from 'vitest'
import { agentPresetPresentationStatus } from './agentPresetPresentation'
import type { AgentPresetResolverDatabase } from './agentPresetResolver'
import type { AgentPresetRecord, AgentPresetStepRecord } from './agentPresetRecords'

function step(patch: Partial<AgentPresetStepRecord> = {}): AgentPresetStepRecord {
  return {
    id: 'use-a',
    name: 'Agent A',
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    instruction: 'Help.',
    model: { mode: 'inheritMain' },
    runtime: {},
    inputScopes: [],
    outputKey: 'result',
    outputFormat: 'text',
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
    ...patch,
  }
}

function preset(patch: Partial<AgentPresetRecord> = {}): AgentPresetRecord {
  return { id: 'preset-a', name: 'Preset A', enabled: true, version: 1, steps: [step()], ...patch }
}

function database(agentPresets: AgentPresetRecord[]): AgentPresetResolverDatabase {
  return {
    agentPresets,
    agents: [],
    modelProfiles: [],
  }
}

describe('Agent Preset presentation status', () => {
  it('distinguishes a valid no-op preset from an executable ready preset', () => {
    const empty = preset({ steps: [] })
    const ready = preset()

    expect(agentPresetPresentationStatus({ preset: empty, database: database([empty]) })).toMatchObject({
      kind: 'empty',
      tone: 'muted',
      enabledUseCount: 0,
      planning: { ready: true },
    })
    expect(agentPresetPresentationStatus({ preset: ready, database: database([ready]) })).toMatchObject({
      kind: 'ready',
      tone: 'ready',
      enabledUseCount: 1,
      planning: { ready: true },
    })
  })

  it('retains disabled, invalid, incomplete, and model-not-ready precedence', () => {
    const disabled = preset({ enabled: false, steps: [] })
    const invalid = preset({ steps: [step({ outputKey: 'bad-key' })] })
    const incomplete = preset({ finalOutputTemplate: '{{agent::missing}}' })
    const modelNotReady = preset({ steps: [step({ model: { mode: 'modelProfile', profileId: 'missing' } })] })

    expect(agentPresetPresentationStatus({ preset: disabled, database: database([disabled]) }).kind).toBe('disabled')
    expect(agentPresetPresentationStatus({ preset: invalid, database: database([invalid]) }).kind).toBe('invalid')
    expect(agentPresetPresentationStatus({ preset: incomplete, database: database([incomplete]) }).kind).toBe(
      'incomplete',
    )
    expect(agentPresetPresentationStatus({ preset: modelNotReady, database: database([modelNotReady]) }).kind).toBe(
      'model_not_ready',
    )
  })
})
