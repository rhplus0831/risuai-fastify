import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createPresetCommand,
  copyPresetCommand,
  importPresetCommand,
  reorderModelPresetsCommand,
  reorderPresetsCommand,
  runServerPresetCommand,
  updateModelPresetCommand,
  selectPresetCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
  updatePromptPresetCommand,
  updatePresetCommand,
} from './commands'

describe('preset command adapters', () => {
  it('creates presets through the typed command helper', async () => {
    const event = { type: 'preset.created', revision: 2, resource: 'preset', id: 'preset-a' }
    const commandFetch = makeCommandFetch(() => ({ revision: 2, event, presetId: 'preset-a' }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await createPresetCommand({
      baseRevision: 1,
      preset: { id: 'preset-a', name: 'A', mainPrompt: 'hello' },
    })

    expect(result).toEqual({ status: 'ok', revision: 2, event, presetId: 'preset-a' })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/presets',
        method: 'POST',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: {
          baseRevision: 1,
          preset: { id: 'preset-a', name: 'A', mainPrompt: 'hello' },
        },
      },
    ])
  })

  it('copies and imports presets through typed command helpers with stable ids', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/preset-a/copy')) {
        return {
          revision: 2,
          event: { type: 'preset.copied', revision: 2, resource: 'preset', id: 'preset-copy' },
          presetId: 'preset-copy',
          sourcePresetId: 'preset-a',
        }
      }
      return {
        revision: 3,
        event: { type: 'preset.imported', revision: 3, resource: 'preset', id: 'preset-import' },
        presetId: 'preset-import',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      copyPresetCommand({
        baseRevision: 1,
        presetId: 'preset-a',
        newPresetId: 'preset-copy',
        name: 'A Copy',
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, presetId: 'preset-copy' })

    await expect(
      importPresetCommand({
        baseRevision: 2,
        preset: { id: 'preset-import', name: 'Imported' },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'preset-import' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/presets/preset-a/copy',
        body: {
          baseRevision: 1,
          newPresetId: 'preset-copy',
          name: 'A Copy',
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/presets/import',
        body: {
          baseRevision: 2,
          preset: { id: 'preset-import', name: 'Imported' },
        },
      },
    ])
  })

  it('selects and reorders presets through typed command helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/select')) {
        return {
          revision: 3,
          event: { type: 'preset.selected', revision: 3, resource: 'preset', id: 'preset-b' },
          presetId: 'preset-b',
        }
      }
      return {
        revision: 4,
        event: { type: 'preset.reordered', revision: 4, resource: 'preset' },
        selectedPresetId: 'preset-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      selectPresetCommand({
        baseRevision: 2,
        presetId: 'preset-b',
        apply: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'preset-b' })

    await expect(
      reorderPresetsCommand({
        baseRevision: 3,
        presetIds: ['preset-b', 'preset-a'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, selectedPresetId: 'preset-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/presets/select',
        body: {
          baseRevision: 2,
          presetId: 'preset-b',
          apply: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/presets/reorder',
        body: {
          baseRevision: 3,
          presetIds: ['preset-b', 'preset-a'],
        },
      },
    ])
  })

  it('emits strict legacy/model preset reorder effects without serializing projection proofs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/presets/reorder')) {
        return {
          revision: 4,
          event: {
            type: 'preset.reordered',
            revision: 4,
            resource: 'presetCollectionWithPointer',
          },
          presetReorderCertificate: 'preset-reorder-v1',
          presetKind: 'legacy',
          presetIds: ['preset-b', 'preset-a'],
          selectedPresetId: 'preset-a',
          settingsWritten: true,
        }
      }
      return {
        revision: 5,
        event: { type: 'modelPreset.reordered', revision: 5, resource: 'modelPreset' },
        presetReorderCertificate: 'preset-reorder-v1',
        presetKind: 'model',
        presetIds: ['model-c', 'model-b', 'model-a'],
        selectedModelPresetId: 'model-b',
        settingsWritten: false,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await reorderPresetsCommand({
      baseRevision: 3,
      presetIds: ['preset-b', 'preset-a'],
      optimisticAcknowledgement: {
        presetKind: 'legacy',
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        beforePresetIds: ['preset-a', 'preset-b'],
        attemptedPresetIds: ['preset-b', 'preset-a'],
        beforeSelectedPresetId: 'preset-a',
        attemptedSelectedPresetId: 'preset-a',
        settingsWritten: true,
      },
    })
    await reorderModelPresetsCommand({
      baseRevision: 4,
      modelPresetIds: ['model-c', 'model-b', 'model-a'],
      optimisticAcknowledgement: {
        presetKind: 'model',
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        beforePresetIds: ['model-a', 'model-b', 'model-c'],
        attemptedPresetIds: ['model-c', 'model-b', 'model-a'],
        beforeSelectedPresetId: 'model-b',
        attemptedSelectedPresetId: 'model-b',
        settingsWritten: false,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'presetReorder',
        presetKind: 'legacy',
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        presetIds: ['preset-b', 'preset-a'],
        selectedPresetId: 'preset-a',
        settingsWritten: true,
      },
      {
        kind: 'presetReorder',
        presetKind: 'model',
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        presetIds: ['model-c', 'model-b', 'model-a'],
        selectedPresetId: 'model-b',
        settingsWritten: false,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 3, presetIds: ['preset-b', 'preset-a'] },
      { baseRevision: 4, modelPresetIds: ['model-c', 'model-b', 'model-a'] },
    ])
  })

  it('rejects malformed legacy preset reorder receipts so authoritative reconciliation remains available', async () => {
    const exactEvent = {
      type: 'preset.reordered',
      revision: 4,
      resource: 'presetCollectionWithPointer',
    }
    const exactReceipt = {
      revision: 4,
      event: exactEvent,
      presetReorderCertificate: 'preset-reorder-v1',
      presetKind: 'legacy',
      presetIds: ['preset-b', 'preset-a'],
      selectedPresetId: 'preset-a',
      settingsWritten: true,
    }
    const bodies = [
      { ...exactReceipt, presetReorderCertificate: undefined },
      { ...exactReceipt, presetIds: ['preset-a', 'preset-b'] },
      { ...exactReceipt, selectedPresetId: 'preset-b' },
      { ...exactReceipt, settingsWritten: false },
      { ...exactReceipt, event: { ...exactEvent, resource: 'presetCollection' } },
    ]
    let bodyIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(bodies[bodyIndex++])),
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const _body of bodies) {
      await reorderPresetsCommand({
        baseRevision: 3,
        presetIds: ['preset-b', 'preset-a'],
        optimisticAcknowledgement: {
          presetKind: 'legacy',
          collectionProjectionEpoch: 4,
          settingsProjectionEpoch: 5,
          beforePresetIds: ['preset-a', 'preset-b'],
          attemptedPresetIds: ['preset-b', 'preset-a'],
          beforeSelectedPresetId: 'preset-a',
          attemptedSelectedPresetId: 'preset-a',
          settingsWritten: true,
        },
      })
    }

    expect(observedEffectCounts).toEqual(bodies.map(() => 0))
  })

  it('runs server preset commands with revision lookup and surfaces conflicts', async () => {
    let selectAttempts = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 5 }
      selectAttempts += 1
      if (selectAttempts === 1) {
        return jsonResponse({ error: 'revision_conflict', currentRevision: 8 }, 409)
      }
      throw new Error('unexpected retry')
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      runServerPresetCommand({
        command: (baseRevision) =>
          selectPresetCommand({
            baseRevision,
            presetId: 'preset-b',
          }),
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 8 })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([null, { baseRevision: 5, presetId: 'preset-b' }])
  })

  it('emits exact split-preset PATCH acknowledgements without serializing projection proofs', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.includes('/model-presets/')) {
        return {
          revision: 2,
          event: { type: 'modelPreset.updated', revision: 2, resource: 'modelPreset', id: 'model-a' },
          modelPresetId: 'model-a',
          acknowledgedKeys: ['temperature'],
          preset: { temperature: 0.5 },
          settings: { temperature: 0.5 },
          selectedProjectionApplied: true,
          ownerProjectionApplied: false,
          selectedPromptPresetId: 'prompt-a',
        }
      }
      return {
        revision: 3,
        event: { type: 'promptPreset.updated', revision: 3, resource: 'promptPreset', id: 'prompt-a' },
        promptPresetId: 'prompt-a',
        acknowledgedKeys: ['name'],
        preset: {},
        settings: {},
        selectedProjectionApplied: false,
        ownerProjectionApplied: false,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updateModelPresetCommand({
      baseRevision: 1,
      modelPresetId: 'model-a',
      patch: { temperature: 0.6 },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        selectedPresetId: 'model-a',
        selectedPromptPresetId: 'prompt-a',
        attemptedSettings: { temperature: 0.6 },
        selectedProjectionExpected: true,
        ownerProjectionExpected: false,
      },
    })
    await updatePromptPresetCommand({
      baseRevision: 2,
      promptPresetId: 'prompt-a',
      patch: { name: 'Prompt renamed' },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        selectedPresetId: 'prompt-a',
        selectedPromptPresetId: 'prompt-a',
        attemptedSettings: {},
        selectedProjectionExpected: false,
        ownerProjectionExpected: false,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'splitPresetPatch',
        presetKind: 'model',
        presetId: 'model-a',
        attemptedPatch: { temperature: 0.6 },
        preset: { temperature: 0.5 },
        attemptedSettings: { temperature: 0.6 },
        settings: { temperature: 0.5 },
        selectedProjectionApplied: true,
        ownerProjectionApplied: false,
        collectionProjectionEpoch: 4,
        settingsProjectionEpoch: 5,
        selectedPresetId: 'model-a',
        selectedPromptPresetId: 'prompt-a',
      },
      {
        kind: 'splitPresetPatch',
        presetKind: 'prompt',
        presetId: 'prompt-a',
        attemptedPatch: { name: 'Prompt renamed' },
        preset: { name: 'Prompt renamed' },
        attemptedSettings: {},
        settings: {},
        selectedProjectionApplied: false,
        ownerProjectionApplied: false,
        collectionProjectionEpoch: 6,
        settingsProjectionEpoch: 7,
        selectedPresetId: 'prompt-a',
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({ baseRevision: 1, patch: { temperature: 0.6 } })
    expect(commandFetch.calls[1]?.body).toEqual({ baseRevision: 2, patch: { name: 'Prompt renamed' } })
  })

  it('emits an exact legacy-preset PATCH acknowledgement without serializing its optimistic proof', async () => {
    const event = {
      type: 'preset.updated',
      revision: 2,
      resource: 'presetRow',
      id: 'preset-a',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event,
      presetId: 'preset-a',
      acknowledgedKeys: ['name'],
      canonicalValues: { name: 'Canonical name' },
      canonicalDeletedKeys: ['agentPresetDefaultId'],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await updatePresetCommand({
      baseRevision: 1,
      presetId: 'preset-a',
      patch: { name: 'Optimistic name' },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 17,
        attemptedFields: {
          name: { present: true, value: 'Optimistic name' },
          agents: { present: false },
          agentPresets: { present: false },
          agentPresetDefaultId: { present: true, value: 'missing-agent' },
        },
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'legacyPresetPatch',
        presetId: 'preset-a',
        collectionProjectionEpoch: 17,
        fields: {
          name: {
            attempted: { present: true, value: 'Optimistic name' },
            canonical: { present: true, value: 'Canonical name' },
          },
          agentPresetDefaultId: {
            attempted: { present: true, value: 'missing-agent' },
            canonical: { present: false },
          },
        },
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 1,
      patch: { name: 'Optimistic name' },
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps malformed legacy-preset PATCH receipts on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'preset.updated',
      revision: 2,
      resource: 'presetRow',
      id: 'preset-a',
    }
    const exactBody = {
      revision: 2,
      event: exactEvent,
      presetId: 'preset-a',
      acknowledgedKeys: ['name'],
      canonicalValues: { name: 'Canonical name' },
      canonicalDeletedKeys: [] as string[],
    }
    const cases: Array<{
      body?: Record<string, unknown>
      acknowledgement?: {
        collectionProjectionEpoch: number
        attemptedFields: Record<string, unknown>
      }
    }> = [
      { body: { ...exactBody, event: { ...exactEvent, resource: 'preset' } } },
      { body: { ...exactBody, presetId: 'preset-b' } },
      { body: { ...exactBody, acknowledgedKeys: ['name', 'extra'] } },
      { body: { ...exactBody, canonicalValues: { id: 'preset-b' } } },
      { body: { ...exactBody, canonicalValues: { foreign: true } } },
      {
        body: {
          ...exactBody,
          canonicalValues: { name: 'Canonical name' },
          canonicalDeletedKeys: ['name'],
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: { name: { present: false, value: 'invalid' } },
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresetDefaultId: { present: false },
          },
        },
      },
      {
        acknowledgement: {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresets: { present: false },
            agentPresetDefaultId: { present: false },
            foreign: { present: false },
          },
        },
      },
      { acknowledgement: { collectionProjectionEpoch: -1, attemptedFields: {} } },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(cases[responseIndex].body ?? exactBody)) as unknown as typeof fetch,
    )
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await updatePresetCommand({
        baseRevision: 1,
        presetId: 'preset-a',
        patch: { name: 'Optimistic name' },
        optimisticAcknowledgement: (testCase.acknowledgement ?? {
          collectionProjectionEpoch: 17,
          attemptedFields: {
            name: { present: true, value: 'Optimistic name' },
            agentPresets: { present: false },
            agentPresetDefaultId: { present: false },
          },
        }) as never,
      })
      responseIndex += 1
    }

    expect(observedEffectCounts).toEqual(cases.map(() => 0))
  })

  it('keeps malformed split-preset receipts on authoritative reconciliation', async () => {
    const exactEvent = { type: 'modelPreset.updated', revision: 2, resource: 'modelPreset', id: 'model-a' }
    const cases = [
      { ...exactEvent, resource: 'promptPreset', responseRevision: 2 },
      { ...exactEvent, id: 'model-b', responseRevision: 2 },
    ]
    let responseIndex = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const testCase = cases[responseIndex++]
        return jsonResponse({
          revision: testCase.responseRevision,
          event: {
            type: testCase.type,
            revision: 2,
            resource: testCase.resource,
            id: testCase.id,
          },
          modelPresetId: 'model-a',
          acknowledgedKeys: ['temperature'],
          preset: {},
          settings: {},
          selectedProjectionApplied: true,
          ownerProjectionApplied: false,
          selectedPromptPresetId: 'prompt-a',
        })
      }) as unknown as typeof fetch,
    )
    const observedSizes: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedSizes.push(localEffects.size)
    })

    for (const _testCase of cases) {
      await updateModelPresetCommand({
        baseRevision: 1,
        modelPresetId: 'model-a',
        patch: { temperature: 0.6 },
        optimisticAcknowledgement: {
          collectionProjectionEpoch: 1,
          settingsProjectionEpoch: 1,
          selectedPresetId: 'model-a',
          selectedPromptPresetId: 'prompt-a',
          attemptedSettings: { temperature: 0.6 },
          selectedProjectionExpected: true,
        },
      })
    }

    expect(observedSizes).toEqual([0, 0])
  })
})
