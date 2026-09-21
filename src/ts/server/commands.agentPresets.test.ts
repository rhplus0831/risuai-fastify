import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createAgentCommand,
  createAgentPresetCommand,
  createAgentPresetStepCommand,
  createAgentPresetUseCommand,
  deleteAgentPresetCommand,
  deleteAgentPresetStepCommand,
  deleteAgentPresetUseCommand,
  deleteAgentCommand,
  duplicateAgentPresetCommand,
  duplicateAgentPresetStepCommand,
  duplicateAgentCommand,
  reorderAgentPresetsCommand,
  reorderAgentPresetStepsCommand,
  reorderAgentPresetUsesCommand,
  reorderAgentsCommand,
  setAgentPresetDefaultCommand,
  updateAgentPresetCommand,
  updateAgentPresetStepCommand,
  updateAgentPresetUseCommand,
  updateAgentCommand,
  setServerCommandSuccessReconciler,
  type AgentPresetStepSnapshot,
  type ServerCommandLocalEffect,
} from './commands'

describe('Agent and Agent Preset command adapters', () => {
  it('dispatches Agent Preset commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      const event = { type: 'agentPreset.test', revision: 99, resource: 'agentPreset' }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a/duplicate')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_copy', sourceStepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_b')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_b' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps/reorder')) {
        return { revision: 99, event, presetId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/steps')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'aps_a' }
      }
      if (url.endsWith('/agent-presets/default')) {
        return { revision: 99, event, agentPresetDefaultId: 'ap_b' }
      }
      if (url.endsWith('/agent-presets/reorder')) {
        return { revision: 99, event, agentPresetDefaultId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_a/duplicate')) {
        return { revision: 99, event, presetId: 'ap_copy', sourcePresetId: 'ap_a' }
      }
      if (url.endsWith('/agent-presets/ap_b')) {
        return {
          revision: 99,
          event: { type: 'agentPreset.deleted', revision: 99, resource: 'agentPresetDeleted', id: 'ap_b' },
          presetId: 'ap_b',
          clearedDefault: true,
          clearedChatCount: 2,
          clearedLoadoutCount: 1,
        }
      }
      if (url.endsWith('/agent-presets/ap_a')) {
        return { revision: 99, event, presetId: 'ap_a' }
      }
      return { revision: 99, event, presetId: 'ap_a' }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createAgentPresetCommand({
      baseRevision: 1,
      preset: { name: 'Created' },
    })
    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: 'Updated', enabled: false },
    })
    await duplicateAgentPresetCommand({
      baseRevision: 3,
      presetId: 'ap_a',
      name: 'Copy',
    })
    await deleteAgentPresetCommand({
      baseRevision: 4,
      presetId: 'ap_b',
    })
    await reorderAgentPresetsCommand({
      baseRevision: 5,
      presetIds: ['ap_b', 'ap_a'],
    })
    await setAgentPresetDefaultCommand({
      baseRevision: 6,
      agentPresetId: 'ap_b',
    })
    await createAgentPresetStepCommand({
      baseRevision: 7,
      presetId: 'ap_a',
      step: { name: 'Step' },
    })
    await updateAgentPresetStepCommand({
      baseRevision: 8,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { outputKey: 'facts' },
    })
    await duplicateAgentPresetStepCommand({
      baseRevision: 9,
      presetId: 'ap_a',
      stepId: 'aps_a',
      name: 'Step Copy',
    })
    await deleteAgentPresetStepCommand({
      baseRevision: 10,
      presetId: 'ap_a',
      stepId: 'aps_b',
    })
    await reorderAgentPresetStepsCommand({
      baseRevision: 11,
      presetId: 'ap_a',
      stepIds: ['aps_b', 'aps_a'],
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/agent-presets',
        method: 'POST',
        body: {
          baseRevision: 1,
          preset: { name: 'Created' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Updated', enabled: false },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/duplicate',
        method: 'POST',
        body: {
          baseRevision: 3,
          name: 'Copy',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_b',
        method: 'DELETE',
        body: {
          baseRevision: 4,
        },
      },
      {
        url: '/api/v1/commands/agent-presets/reorder',
        method: 'POST',
        body: {
          baseRevision: 5,
          presetIds: ['ap_b', 'ap_a'],
        },
      },
      {
        url: '/api/v1/commands/agent-presets/default',
        method: 'POST',
        body: {
          baseRevision: 6,
          agentPresetId: 'ap_b',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps',
        method: 'POST',
        body: {
          baseRevision: 7,
          step: { name: 'Step' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_a',
        method: 'PATCH',
        body: {
          baseRevision: 8,
          patch: { outputKey: 'facts' },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_a/duplicate',
        method: 'POST',
        body: {
          baseRevision: 9,
          name: 'Step Copy',
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/aps_b',
        method: 'DELETE',
        body: {
          baseRevision: 10,
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/steps/reorder',
        method: 'POST',
        body: {
          baseRevision: 11,
          stepIds: ['aps_b', 'aps_a'],
        },
      },
    ])
  })

  it('dispatches standalone Agent and preset-use commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      const event = { type: 'agent.test', revision: 99, resource: 'agentPreset' }
      if (url.endsWith('/agents/ag_a/duplicate')) {
        return { revision: 99, event, agentId: 'ag_b', sourceAgentId: 'ag_a' }
      }
      if (url.endsWith('/agents/ag_b')) return { revision: 99, event, agentId: 'ag_b' }
      if (url.endsWith('/agents/ag_a')) return { revision: 99, event, agentId: 'ag_a' }
      if (url.endsWith('/agents/reorder')) return { revision: 99, event }
      if (url.endsWith('/agents')) return { revision: 99, event, agentId: 'ag_a' }
      if (url.endsWith('/agent-presets/ap_a/uses/use_a')) {
        return { revision: 99, event, presetId: 'ap_a', stepId: 'use_a', useId: 'use_a', agentId: 'ag_a' }
      }
      return { revision: 99, event, presetId: 'ap_a', stepId: 'use_a', useId: 'use_a', agentId: 'ag_a' }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const agent = {
      name: 'Researcher',
      instruction: 'Collect facts.',
      modelDefaults: { mode: 'inheritMain' as const },
      runtimeDefaults: { timeoutMs: 30_000 },
      inputScopes: ['currentUserMessage' as const],
      outputFormat: 'text' as const,
    }
    await createAgentCommand({ baseRevision: 1, agent })
    await updateAgentCommand({ baseRevision: 2, agentId: 'ag_a', patch: { instruction: 'Verify facts.' } })
    await duplicateAgentCommand({ baseRevision: 3, agentId: 'ag_a', name: 'Researcher Copy' })
    await deleteAgentCommand({ baseRevision: 4, agentId: 'ag_b' })
    await reorderAgentsCommand({ baseRevision: 5, agentIds: ['ag_a'] })
    await createAgentPresetUseCommand({
      baseRevision: 6,
      presetId: 'ap_a',
      use: {
        agentId: 'ag_a',
        enabled: true,
        phase: 'beforeMain',
        dependencies: [],
        outputKey: 'facts',
        destination: 'promptOutput',
        failurePolicy: { mode: 'required' },
      },
    })
    await updateAgentPresetUseCommand({
      baseRevision: 7,
      presetId: 'ap_a',
      useId: 'use_a',
      patch: { runtimeOverride: { timeoutMs: 45_000 } },
    })
    await deleteAgentPresetUseCommand({ baseRevision: 8, presetId: 'ap_a', useId: 'use_a' })
    await reorderAgentPresetUsesCommand({ baseRevision: 9, presetId: 'ap_a', useIds: ['use_b'] })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/agents',
        method: 'POST',
        body: { baseRevision: 1, agent },
      },
      {
        url: '/api/v1/commands/agents/ag_a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { instruction: 'Verify facts.' } },
      },
      {
        url: '/api/v1/commands/agents/ag_a/duplicate',
        method: 'POST',
        body: { baseRevision: 3, name: 'Researcher Copy' },
      },
      {
        url: '/api/v1/commands/agents/ag_b',
        method: 'DELETE',
        body: { baseRevision: 4 },
      },
      {
        url: '/api/v1/commands/agents/reorder',
        method: 'POST',
        body: { baseRevision: 5, agentIds: ['ag_a'] },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses',
        method: 'POST',
        body: {
          baseRevision: 6,
          use: {
            agentId: 'ag_a',
            enabled: true,
            phase: 'beforeMain',
            dependencies: [],
            outputKey: 'facts',
            destination: 'promptOutput',
            failurePolicy: { mode: 'required' },
          },
        },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/use_a',
        method: 'PATCH',
        body: { baseRevision: 7, patch: { runtimeOverride: { timeoutMs: 45_000 } } },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/use_a',
        method: 'DELETE',
        body: { baseRevision: 8 },
      },
      {
        url: '/api/v1/commands/agent-presets/ap_a/uses/reorder',
        method: 'POST',
        body: { baseRevision: 9, useIds: ['use_b'] },
      },
    ])
  })

  it('exposes exact Agent Preset field acknowledgements without serializing optimistic proof', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/agent-presets/ap_a/steps/aps_a')) {
        return {
          revision: 4,
          event: {
            type: 'agentPreset.step.updated',
            revision: 4,
            resource: 'agentPreset',
            id: 'aps_a',
            parentId: 'ap_a',
          },
          presetId: 'ap_a',
          stepId: 'aps_a',
          acknowledgedKeys: ['outputKey'],
          canonicalValues: { outputKey: 'facts' },
          canonicalDeletedKeys: [],
          updatedAt: 400,
        }
      }
      return {
        revision: 3,
        event: {
          type: 'agentPreset.updated',
          revision: 3,
          resource: 'agentPreset',
          id: 'ap_a',
        },
        presetId: 'ap_a',
        acknowledgedKeys: ['name', 'description', 'moduleIntergration'],
        canonicalValues: { name: 'Canonical Name' },
        canonicalDeletedKeys: ['description', 'moduleIntergration'],
        updatedAt: 300,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: '  Canonical Name  ', description: null, moduleIntergration: null },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: {
          name: { present: true, value: '  Canonical Name  ' },
          description: { present: true, value: null },
          moduleIntergration: { present: true, value: null },
        },
      },
    })
    await updateAgentPresetStepCommand({
      baseRevision: 3,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { outputKey: ' facts ' },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { outputKey: { present: true, value: ' facts ' } },
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'agentPresetPatch',
        presetId: 'ap_a',
        settingsProjectionEpoch: 12,
        fields: {
          name: {
            attempted: { present: true, value: '  Canonical Name  ' },
            canonical: { present: true, value: 'Canonical Name' },
          },
          description: {
            attempted: { present: true, value: null },
            canonical: { present: false },
          },
          moduleIntergration: {
            attempted: { present: true, value: null },
            canonical: { present: false },
          },
        },
        updatedAt: 300,
      },
      {
        kind: 'agentPresetStepPatch',
        presetId: 'ap_a',
        stepId: 'aps_a',
        settingsProjectionEpoch: 12,
        fields: {
          outputKey: {
            attempted: { present: true, value: ' facts ' },
            canonical: { present: true, value: 'facts' },
          },
        },
        updatedAt: 400,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      {
        baseRevision: 2,
        patch: { name: '  Canonical Name  ', description: null, moduleIntergration: null },
      },
      {
        baseRevision: 3,
        patch: { outputKey: ' facts ' },
      },
    ])
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
    expect(commandFetch.calls[1]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps contradictory Agent Preset field receipts on authoritative reconciliation', async () => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'ap_a',
      },
      presetId: 'ap_a',
      acknowledgedKeys: ['enabled'],
      canonicalValues: { enabled: false },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { name: 'Attempted' },
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { name: { present: true, value: 'Attempted' } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it.each([
    {
      label: 'non-boolean enabled',
      field: 'enabled',
      attemptedValue: false,
      canonicalValue: 'yes',
    },
    {
      label: 'out-of-range maxConcurrency',
      field: 'maxConcurrency',
      attemptedValue: 4,
      canonicalValue: 17,
    },
    {
      label: 'non-canonical name',
      field: 'name',
      attemptedValue: 'Canonical name',
      canonicalValue: '  Canonical name  ',
    },
  ])('rejects a 2xx Agent Preset metadata receipt with $label', async ({ field, attemptedValue, canonicalValue }) => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'ap_a',
      },
      presetId: 'ap_a',
      acknowledgedKeys: [field],
      canonicalValues: { [field]: canonicalValue },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      patch: { [field]: attemptedValue } as never,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { [field]: { present: true, value: attemptedValue } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it.each([
    {
      label: 'non-boolean enabled',
      field: 'enabled',
      attemptedValue: false,
      canonicalValue: 'yes',
    },
    {
      label: 'invalid phase',
      field: 'phase',
      attemptedValue: 'afterMain',
      canonicalValue: 'duringMain',
    },
    {
      label: 'non-canonical dependencies',
      field: 'dependencies',
      attemptedValue: ['aps_a'],
      canonicalValue: ['aps_a', 'aps_a'],
    },
    {
      label: 'invalid model selection',
      field: 'model',
      attemptedValue: { mode: 'modelProfile', profileId: 'profile-a' },
      canonicalValue: { mode: 'modelProfile', profileId: ' ' },
    },
    {
      label: 'out-of-range runtime',
      field: 'runtime',
      attemptedValue: { timeoutMs: 1_000 },
      canonicalValue: { timeoutMs: 200 },
    },
    {
      label: 'non-canonical input scopes',
      field: 'inputScopes',
      attemptedValue: ['recentChatTail'],
      canonicalValue: ['recentChatTail', 'recentChatTail'],
    },
    {
      label: 'invalid output format',
      field: 'outputFormat',
      attemptedValue: 'jsonObject',
      canonicalValue: 'yaml',
    },
    {
      label: 'invalid destination',
      field: 'destination',
      attemptedValue: 'intermediate',
      canonicalValue: 'archive',
    },
    {
      label: 'non-canonical failure policy',
      field: 'failurePolicy',
      attemptedValue: { mode: 'optional' },
      canonicalValue: { mode: 'required', text: 'unexpected' },
    },
  ])('rejects a 2xx Agent Preset step receipt with $label', async ({ field, attemptedValue, canonicalValue }) => {
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.step.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'aps_a',
        parentId: 'ap_a',
      },
      presetId: 'ap_a',
      stepId: 'aps_a',
      acknowledgedKeys: [field],
      canonicalValues: { [field]: canonicalValue },
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetStepCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch: { [field]: attemptedValue } as never,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields: { [field]: { present: true, value: attemptedValue } },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it('accepts canonical structured Agent Preset step receipt values', async () => {
    const patch = {
      dependencies: ['aps_dependency'],
      model: { mode: 'modelProfile', profileId: 'profile-a' },
      runtime: {
        temperature: 120,
        maxInputChars: 2_000,
        maxOutputChars: 1_000,
        timeoutMs: 10_000,
        structuredOutputStrict: true,
      },
      inputScopes: ['recentChatTail', 'mainDraft'],
      failurePolicy: { mode: 'fallbackText', text: 'Fallback' },
    } satisfies AgentPresetStepSnapshot
    const attemptedFields = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, { present: true as const, value }]),
    )
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event: {
        type: 'agentPreset.step.updated',
        revision: 3,
        resource: 'agentPreset',
        id: 'aps_a',
        parentId: 'ap_a',
      },
      presetId: 'ap_a',
      stepId: 'aps_a',
      acknowledgedKeys: Object.keys(patch),
      canonicalValues: patch,
      canonicalDeletedKeys: [],
      updatedAt: 300,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updateAgentPresetStepCommand({
      baseRevision: 2,
      presetId: 'ap_a',
      stepId: 'aps_a',
      patch,
      optimisticAcknowledgement: {
        settingsProjectionEpoch: 12,
        attemptedFields,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'agentPresetStepPatch',
        presetId: 'ap_a',
        stepId: 'aps_a',
        settingsProjectionEpoch: 12,
        fields: Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            {
              attempted: { present: true, value },
              canonical: { present: true, value },
            },
          ]),
        ),
        updatedAt: 300,
      },
    ])
  })
})
