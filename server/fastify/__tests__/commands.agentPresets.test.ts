import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  importDatabase,
  updateSettingsRow,
} from './helpers/commandHarness.js'

let harness: Harness

describe('Agent Preset command surface', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates, updates, defaults, reorders, and projects Agent Presets without Context Agent conversion', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
      agentPresets: [],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        preset: { name: 'Research Agent' },
      },
    })
    expect(created.statusCode).toBe(200)
    const createdBody = created.json() as { revision: number; presetId: string; event: Record<string, unknown> }
    expect(createdBody.presetId).toMatch(/^ap_/)
    expect(createdBody.event).toMatchObject({
      type: 'agentPreset.created',
      resource: 'agentPreset',
      id: createdBody.presetId,
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agent-presets/${createdBody.presetId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: createdBody.revision,
        patch: {
          name: 'Research Agent Renamed',
          description: 'before-main helper',
          moduleIntergration: 'research-tools, citations',
          finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
          maxConcurrency: 2,
          enabled: false,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      presetId: createdBody.presetId,
      acknowledgedKeys: [
        'name',
        'description',
        'moduleIntergration',
        'finalOutputTemplate',
        'maxConcurrency',
        'enabled',
      ],
      canonicalValues: {
        name: 'Research Agent Renamed',
        description: 'before-main helper',
        moduleIntergration: 'research-tools, citations',
        finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
        maxConcurrency: 2,
        enabled: false,
      },
      canonicalDeletedKeys: [],
      updatedAt: expect.any(Number),
    })

    const defaulted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/default',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        agentPresetId: createdBody.presetId,
      },
    })
    expect(defaulted.statusCode).toBe(200)
    expect(defaulted.json()).toMatchObject({
      event: {
        type: 'agentPreset.default.updated',
        resource: 'agentPreset',
        id: createdBody.presetId,
      },
      agentPresetDefaultId: createdBody.presetId,
      certificate: 'agent-preset-collection-v1',
      agentPresetIds: [createdBody.presetId],
    })

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: defaulted.json().revision,
        preset: { name: 'After Agent' },
      },
    })
    expect(second.statusCode).toBe(200)
    const secondId = second.json().presetId as string

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: second.json().revision,
        presetIds: [secondId, createdBody.presetId],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toMatchObject({
      event: {
        type: 'agentPreset.reordered',
        resource: 'agentPreset',
      },
      agentPresetDefaultId: createdBody.presetId,
      certificate: 'agent-preset-collection-v1',
      agentPresetIds: [secondId, createdBody.presetId],
    })

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'risu-auth': assertion },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toMatchObject({
      settings: {
        agentPresetDefaultId: createdBody.presetId,
      },
    })
    expect(settings.json().settings.agentPresets.map((preset: { id: string }) => preset.id)).toEqual([
      secondId,
      createdBody.presetId,
    ])

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agentPresets).toHaveLength(2)
    expect(bootstrap.resourceDatabase.agentPresets[1]).toMatchObject({
      id: createdBody.presetId,
      name: 'Research Agent Renamed',
      description: 'before-main helper',
      moduleIntergration: 'research-tools, citations',
      finalOutputTemplate: '{{slot::mainOutput}}\n{{agent::research}}',
      maxConcurrency: 2,
      enabled: false,
      steps: [],
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })
  })

  it('migrates step mutations to Agents and duplicates presets with fresh use ids while sharing Agents', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'ap_source', name: 'Source', enabled: true, version: 1, steps: [] }],
    })

    const step = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        step: {
          name: 'Facts',
          phase: 'beforeMain',
          instruction: 'Find relevant facts.',
          outputKey: 'facts',
          inputScopes: ['currentUserMessage'],
        },
      },
    })
    expect(step.statusCode).toBe(200)
    const stepId = step.json().stepId as string
    expect(stepId).toMatch(/^aps_/)

    const duplicateKey = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: step.json().revision,
        step: {
          name: 'Duplicate Facts',
          phase: 'beforeMain',
          instruction: '',
          outputKey: 'facts',
        },
      },
    })
    expect(duplicateKey.statusCode).toBe(400)
    expect(duplicateKey.json().error).toContain('Duplicate enabled Agent Preset output key')

    const afterMain = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: step.json().revision,
        step: {
          name: 'Final polish',
          phase: 'afterMain',
          instruction: 'Polish the answer.',
          outputKey: 'polished',
          destination: 'finalOutput',
        },
      },
    })
    expect(afterMain.statusCode).toBe(200)

    const invalidAfterMainOrdering = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: afterMain.json().revision,
        step: {
          name: 'Advisory after',
          phase: 'afterMain',
          instruction: '',
          outputKey: 'advice',
        },
      },
    })
    expect(invalidAfterMainOrdering.statusCode).toBe(400)
    expect(invalidAfterMainOrdering.json().error).toContain('final-output modifier must be the last')

    const duplicatedStep = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/commands/agent-presets/ap_source/steps/${stepId}/duplicate`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: afterMain.json().revision,
        name: 'Facts Copy',
      },
    })
    expect(duplicatedStep.statusCode).toBe(200)
    const duplicatedStepId = duplicatedStep.json().stepId as string
    expect(duplicatedStepId).not.toBe(stepId)

    const duplicatedPreset = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_source/duplicate',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: duplicatedStep.json().revision,
        name: 'Source Copy',
      },
    })
    expect(duplicatedPreset.statusCode).toBe(200)
    const duplicatedPresetId = duplicatedPreset.json().presetId as string
    expect(duplicatedPresetId).not.toBe('ap_source')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const presets = bootstrap.resourceDatabase.agentPresets as Array<{
      id: string
      agentUses: Array<{ id: string; agentId: string }>
    }>
    const source = presets.find((preset) => preset.id === 'ap_source')!
    const copy = presets.find((preset) => preset.id === duplicatedPresetId)!
    expect(source.agentUses.map((candidate) => candidate.id)).toContain(stepId)
    expect(source.agentUses.map((candidate) => candidate.id)).toContain(duplicatedStepId)
    expect(copy.agentUses.map((candidate) => candidate.id)).not.toContain(stepId)
    expect(copy.agentUses).toHaveLength(source.agentUses.length)
    expect(copy.agentUses.map((use) => use.agentId)).toEqual(source.agentUses.map((use) => use.agentId))
    expect(bootstrap.resourceDatabase.agents).toHaveLength(2)
  })

  it('accepts a last before-main user-input modifier and rejects invalid phase or ordering', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [{ id: 'ap_input', name: 'Input Agent', enabled: true, version: 1, steps: [] }],
    })

    const modifier = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        step: {
          name: 'Rewrite input',
          phase: 'beforeMain',
          instruction: 'Rewrite the latest user input.',
          outputKey: 'input',
          destination: 'userInput',
        },
      },
    })
    expect(modifier.statusCode).toBe(200)

    const wrongPhase = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: modifier.json().revision,
        step: {
          name: 'Wrong phase',
          phase: 'afterMain',
          outputKey: 'wrong_phase',
          destination: 'userInput',
        },
      },
    })
    expect(wrongPhase.statusCode).toBe(400)
    expect(wrongPhase.json().error).toContain('Only before-main Agent uses can modify user input')

    const notLast = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_input/steps',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: modifier.json().revision,
        step: {
          name: 'Later context',
          phase: 'beforeMain',
          outputKey: 'later_context',
          destination: 'intermediate',
        },
      },
    })
    expect(notLast.statusCode).toBe(400)
    expect(notLast.json().error).toContain('user-input modifier must be the last')
  })

  it('reuses one standalone Agent across presets and blocks deletion while referenced', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_one', name: 'One', enabled: true, version: 1, steps: [] },
        { id: 'ap_two', name: 'Two', enabled: true, version: 1, steps: [] },
      ],
    })
    const contextBinding = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agents',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        agent: { name: 'Out of scope', contextBinding: { source: 'chat' } },
      },
    })
    expect(contextBinding.statusCode).toBe(400)
    expect(contextBinding.json().error).toContain('agent.contextBinding is not supported')

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agents',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        agent: {
          name: 'Shared Researcher',
          instruction:
            '<|im_start|>user\nResearch with {{agentInput::reference}} using {{agentToggle::tone}}.<|im_end|>',
          useChatML: true,
          inputScopes: ['currentUserMessage'],
          toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
          lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
          outputFormat: 'text',
        },
      },
    })
    expect(created.statusCode).toBe(200)
    const agentId = created.json().agentId as string

    let currentRevision = created.json().revision as number
    const useIds = new Map<string, string>()
    for (const [presetId, outputKey] of [
      ['ap_one', 'research_one'],
      ['ap_two', 'research_two'],
    ]) {
      const attached = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/commands/agent-presets/${presetId}/uses`,
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: currentRevision, use: { agentId, outputKey } },
      })
      expect(attached.statusCode).toBe(200)
      currentRevision = attached.json().revision
      useIds.set(presetId, attached.json().useId)
    }

    const firstUseId = useIds.get('ap_one')!
    const secondUseId = useIds.get('ap_two')!
    const updatedUse = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agent-presets/ap_one/uses/${firstUseId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: currentRevision, patch: { runtimeOverride: { timeoutMs: 45_000 } } },
    })
    expect(updatedUse.statusCode).toBe(200)
    expect(updatedUse.json()).toMatchObject({
      useId: firstUseId,
      agentId,
      acknowledgedKeys: ['runtimeOverride'],
      canonicalValues: { runtimeOverride: { timeoutMs: 45_000 } },
      canonicalDeletedKeys: [],
    })
    currentRevision = updatedUse.json().revision

    const reorderedUses = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/ap_two/uses/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: currentRevision, useIds: [secondUseId] },
    })
    expect(reorderedUses.statusCode).toBe(200)
    currentRevision = reorderedUses.json().revision

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/agents/${agentId}`,
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: currentRevision,
        patch: {
          instruction: '<|im_start|>user\nUpdated once for both presets. {{agentInput::reference}}<|im_end|>',
        },
      },
    })
    expect(updated.statusCode).toBe(200)

    const blockedDelete = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/commands/agents/${agentId}`,
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: updated.json().revision },
    })
    expect(blockedDelete.statusCode).toBe(400)
    expect(blockedDelete.json().error).toContain('still used by 2')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agents).toEqual([
      expect.objectContaining({
        id: agentId,
        instruction: '<|im_start|>user\nUpdated once for both presets. {{agentInput::reference}}<|im_end|>',
        useChatML: true,
        toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
        lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
      }),
    ])
    expect(
      bootstrap.resourceDatabase.agentPresets.map((preset: { agentUses: Array<{ agentId: string }> }) =>
        preset.agentUses.map((use) => use.agentId),
      ),
    ).toEqual([[agentId], [agentId]])
  })

  it('returns exact canonical field receipts for metadata and step PATCHes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        {
          id: 'ap_fields',
          name: 'Fields',
          description: 'Old description',
          moduleIntergration: 'old-space',
          enabled: true,
          version: 1,
          maxConcurrency: 4,
          steps: [
            {
              id: 'aps_fields',
              name: 'Fields Step',
              enabled: true,
              phase: 'beforeMain',
              dependencies: [],
              instruction: '',
              model: { mode: 'inheritMain' },
              runtime: {},
              inputScopes: [],
              outputKey: 'fields',
              outputFormat: 'text',
              destination: 'promptOutput',
              failurePolicy: { mode: 'required' },
            },
          ],
        },
      ],
    })

    const metadata = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_fields',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: '  Trimmed Fields  ', description: '   ', moduleIntergration: null, maxConcurrency: null },
      },
    })
    expect(metadata.statusCode).toBe(200)
    expect(metadata.json()).toMatchObject({
      presetId: 'ap_fields',
      acknowledgedKeys: ['name', 'description', 'moduleIntergration', 'maxConcurrency'],
      canonicalValues: { name: 'Trimmed Fields' },
      canonicalDeletedKeys: ['description', 'moduleIntergration', 'maxConcurrency'],
      updatedAt: expect.any(Number),
    })

    const step = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_fields/steps/aps_fields',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: metadata.json().revision,
        patch: {
          name: '  Trimmed Step  ',
          outputKey: '  canonical_key  ',
          inputScopes: ['currentUserMessage', 'currentUserMessage'],
          failurePolicy: 'fallbackText',
        },
      },
    })
    expect(step.statusCode).toBe(200)
    expect(step.json()).toMatchObject({
      presetId: 'ap_fields',
      stepId: 'aps_fields',
      acknowledgedKeys: ['name', 'outputKey', 'inputScopes', 'failurePolicy'],
      canonicalValues: {
        name: 'Trimmed Step',
        outputKey: 'canonical_key',
        inputScopes: ['currentUserMessage'],
        failurePolicy: { mode: 'fallbackText', text: '' },
      },
      canonicalDeletedKeys: [],
      updatedAt: expect.any(Number),
    })
  })

  it('rejects Agent Preset updates when a sibling requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_target', name: 'Target', enabled: true, version: 1, steps: [] },
        { id: 'ap_sibling', name: 'Sibling', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_target',
    })
    updateSettingsRow(harness.dataDir, (settings) => {
      const presets = settings.agentPresets as Array<Record<string, unknown>>
      presets[1] = { ...presets[1], name: '  Repaired Sibling  ', unexpected: true }
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/agent-presets/ap_target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { enabled: false } },
    })

    expect(updated.statusCode).toBe(400)
    expect(updated.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects Agent Preset reorder/default when the collection requires repair', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentPresets: [
        { id: 'ap_target', name: 'Target', enabled: true, version: 1, steps: [] },
        { id: 'ap_sibling', name: 'Sibling', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_target',
    })
    updateSettingsRow(harness.dataDir, (settings) => {
      const presets = settings.agentPresets as Array<Record<string, unknown>>
      presets[1] = { ...presets[1], name: '  Repaired Sibling  ', unexpected: true }
    })
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, presetIds: ['ap_sibling', 'ap_target'] },
    })

    expect(reordered.statusCode).toBe(400)
    expect(reordered.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)

    const defaulted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/agent-presets/default',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, agentPresetId: 'ap_sibling' },
    })

    expect(defaulted.statusCode).toBe(400)
    expect(defaulted.json().error).toContain('Agent configuration must already be canonical')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('deletes Agent Presets and clears default, chat, and loadout references atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentPresets: [
        { id: 'ap_delete', name: 'Delete Me', enabled: true, version: 1, steps: [] },
        { id: 'ap_keep', name: 'Keep Me', enabled: true, version: 1, steps: [] },
      ],
      agentPresetDefaultId: 'ap_delete',
      loadouts: [
        {
          id: 'loadout-a',
          name: 'A',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          agentPresetId: 'ap_delete',
          agentPresetName: 'Delete Me',
          personaId: '',
        },
        {
          id: 'loadout-b',
          name: 'B',
          lastUsed: 100,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          agentPresetId: 'ap_keep',
          agentPresetName: 'Keep Me',
          personaId: '',
        },
      ],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            {
              id: 'chat-delete',
              name: 'Delete chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                jailbreakToggle: false,
                agentPresetId: 'ap_delete',
              },
            },
            {
              id: 'chat-keep',
              name: 'Keep chat',
              note: '',
              message: [],
              localLore: [],
              generationSettings: {
                configured: true,
                jailbreakToggle: false,
                agentPresetId: 'ap_keep',
              },
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })
    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/agent-presets/ap_delete',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'agentPreset.deleted',
        resource: 'agentPresetDeleted',
        id: 'ap_delete',
      },
      presetId: 'ap_delete',
      clearedDefault: true,
      clearedChatCount: 1,
      clearedLoadoutCount: 1,
    })

    const settings = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'risu-auth': assertion },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json().settings.agentPresets).toEqual([
      { id: 'ap_keep', name: 'Keep Me', enabled: true, version: 1, agentUses: [], steps: [] },
    ])
    expect(settings.json().settings.agentPresetDefaultId).toBeUndefined()

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.agentPresets.map((preset: { id: string }) => preset.id)).toEqual(['ap_keep'])
    expect(bootstrap.resourceDatabase.agentPresetDefaultId).toBeUndefined()
    const chats = bootstrap.resourceDatabase.characters[0].chats as Array<{
      id: string
      generationSettings?: { agentPresetId?: string }
    }>
    expect(chats.find((chat) => chat.id === 'chat-delete')?.generationSettings).not.toHaveProperty('agentPresetId')
    expect(chats.find((chat) => chat.id === 'chat-keep')?.generationSettings?.agentPresetId).toBe('ap_keep')
    const loadouts = bootstrap.resourceDatabase.loadouts as Array<{
      id: string
      agentPresetId?: string
      agentPresetName?: string
    }>
    expect(loadouts.find((loadout) => loadout.id === 'loadout-a')).not.toHaveProperty('agentPresetId')
    expect(loadouts.find((loadout) => loadout.id === 'loadout-a')).not.toHaveProperty('agentPresetName')
    expect(loadouts.find((loadout) => loadout.id === 'loadout-b')).toMatchObject({
      agentPresetId: 'ap_keep',
      agentPresetName: 'Keep Me',
    })
    expect(bootstrap.resourceDatabase.agentContextEnabled).toBe(true)
  })
})
