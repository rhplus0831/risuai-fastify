import { makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranslatorPresetCommand,
  deleteTranslatorPresetCommand,
  selectTranslatorPresetCommand,
  updatePersonaCommand,
  updateTranslatorPresetCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'

describe('translator preset command adapters', () => {
  it('dispatches translator preset commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/translator-presets/select')) {
        return {
          revision: 5,
          event: {
            type: 'translatorPreset.selected',
            revision: 5,
            resource: 'translatorPreset',
            id: 'translator-b',
          },
          presetId: 'translator-b',
        }
      }
      if (url.endsWith('/translator-presets/translator-a')) {
        return {
          revision: 4,
          event: {
            type: 'translatorPreset.deleted',
            revision: 4,
            resource: 'translatorPreset',
            id: 'translator-a',
          },
          presetId: 'translator-a',
          selectedPresetId: 'translator-b',
        }
      }
      if (url.endsWith('/translator-presets/translator-b')) {
        return {
          revision: 3,
          event: {
            type: 'translatorPreset.updated',
            revision: 3,
            resource: 'translatorPreset',
            id: 'translator-b',
          },
          presetId: 'translator-b',
        }
      }
      return {
        revision: 2,
        event: {
          type: 'translatorPreset.created',
          revision: 2,
          resource: 'translatorPreset',
          id: 'translator-b',
        },
        presetId: 'translator-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createTranslatorPresetCommand({
        baseRevision: 1,
        preset: {
          id: 'translator-b',
          name: 'B',
          prompt: 'translate to B',
          maxResponse: 200,
        },
        select: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, presetId: 'translator-b' })

    await expect(
      updateTranslatorPresetCommand({
        baseRevision: 2,
        presetId: 'translator-b',
        patch: { prompt: 'updated', maxResponse: 300 },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, presetId: 'translator-b' })

    await expect(
      deleteTranslatorPresetCommand({
        baseRevision: 3,
        presetId: 'translator-a',
        selectPresetId: 'translator-b',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      presetId: 'translator-a',
      selectedPresetId: 'translator-b',
    })

    await expect(
      selectTranslatorPresetCommand({
        baseRevision: 4,
        presetId: 'translator-b',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, presetId: 'translator-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/translator-presets',
        method: 'POST',
        body: {
          baseRevision: 1,
          preset: {
            id: 'translator-b',
            name: 'B',
            prompt: 'translate to B',
            maxResponse: 200,
          },
          select: true,
        },
      },
      {
        url: '/api/v1/commands/translator-presets/translator-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { prompt: 'updated', maxResponse: 300 },
        },
      },
      {
        url: '/api/v1/commands/translator-presets/translator-a',
        method: 'DELETE',
        body: {
          baseRevision: 3,
          selectPresetId: 'translator-b',
        },
      },
      {
        url: '/api/v1/commands/translator-presets/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          presetId: 'translator-b',
        },
      },
    ])
  })

  it('marks lifecycle persona and translator preset patches as keepalive requests', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 2,
          event: { type: 'persona.updated', revision: 2, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
        }
      }
      return {
        revision: 3,
        event: {
          type: 'translatorPreset.updated',
          revision: 3,
          resource: 'translatorPreset',
          id: 'translator-a',
        },
        presetId: 'translator-a',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await updatePersonaCommand(
      {
        baseRevision: 1,
        personaId: 'persona-a',
        patch: { personaPrompt: 'draft before pagehide' },
        mirrorLegacyProfile: true,
      },
      undefined,
      true,
    )
    await updateTranslatorPresetCommand(
      {
        baseRevision: 2,
        presetId: 'translator-a',
        patch: { prompt: 'draft before pagehide' },
      },
      undefined,
      true,
    )

    expect(vi.mocked(commandFetch.fetch).mock.calls).toHaveLength(2)
    expect(vi.mocked(commandFetch.fetch).mock.calls[0]?.[1]).toMatchObject({ keepalive: true })
    expect(vi.mocked(commandFetch.fetch).mock.calls[1]?.[1]).toMatchObject({ keepalive: true })
  })

  it('exposes an exact translator preset PATCH acknowledgement without serializing optimistic proof', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedPreset = {
      id: 'translator-b',
      name: 'B',
      prompt: 'updated prompt',
      maxResponse: 300,
    }

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { prompt: 'updated prompt', maxResponse: 300 },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'translatorPresetPatch',
        presetId: 'translator-b',
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPatch: { prompt: 'updated prompt', maxResponse: 300 },
        attemptedPreset,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { prompt: 'updated prompt', maxResponse: 300 },
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('accepts server-added legacy mirror keys for a steps-only translator preset PATCH acknowledgement', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['steps', 'prompt', 'maxResponse'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const steps = [
      {
        id: 'step-a',
        name: 'Renamed step',
        enabled: true,
        prompt: 'Translate the input',
        maxResponse: 300,
        model: { mode: 'inheritTranslate' as const },
        outputKey: 'translation',
      },
    ]
    const attemptedPreset = {
      id: 'translator-b',
      name: 'B',
      prompt: steps[0].prompt,
      maxResponse: steps[0].maxResponse,
      steps,
    }

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { steps },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'translatorPresetPatch',
        presetId: 'translator-b',
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPatch: { steps },
        attemptedPreset,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { steps },
    })
  })

  it('rejects unrelated extra keys in a steps-only translator preset PATCH acknowledgement', async () => {
    const event = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      presetId: 'translator-b',
      acknowledgedKeys: ['steps', 'name'],
      selectedPresetId: 'translator-a',
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const steps = [
      {
        id: 'step-a',
        name: 'Renamed step',
        enabled: true,
        prompt: 'Translate the input',
        maxResponse: 300,
        model: { mode: 'inheritTranslate' as const },
      },
    ]

    await updateTranslatorPresetCommand({
      baseRevision: 2,
      presetId: 'translator-b',
      patch: { steps },
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        languageSettingsProjectionEpoch: 17,
        selectedPresetId: 'translator-a',
        attemptedPreset: {
          id: 'translator-b',
          name: 'B',
          prompt: steps[0].prompt,
          maxResponse: steps[0].maxResponse,
          steps,
        },
      },
    })

    expect(observedEffects).toEqual([])
  })

  it('keeps malformed or contradictory translator preset PATCH receipts on authoritative reconciliation', async () => {
    const exactEvent = {
      type: 'translatorPreset.updated',
      revision: 3,
      resource: 'translatorPreset',
      id: 'translator-b',
    }
    const exactAcknowledgement = {
      collectionProjectionEpoch: 11,
      languageSettingsProjectionEpoch: 17,
      selectedPresetId: 'translator-a',
      attemptedPreset: {
        id: 'translator-b',
        name: 'B',
        prompt: 'updated prompt',
        maxResponse: 200,
      },
    }
    const cases = [
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: [],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['name'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt', 'prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-b',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: { ...exactEvent, resource: 'settings' },
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: exactAcknowledgement,
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: {
          ...exactAcknowledgement,
          attemptedPreset: { ...exactAcknowledgement.attemptedPreset, prompt: 'different' },
        },
      },
      {
        body: {
          revision: 3,
          event: exactEvent,
          presetId: 'translator-b',
          acknowledgedKeys: ['prompt'],
          selectedPresetId: 'translator-a',
        },
        acknowledgement: { ...exactAcknowledgement, languageSettingsProjectionEpoch: -1 },
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => cases[responseIndex++].body)
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const testCase of cases) {
      await updateTranslatorPresetCommand({
        baseRevision: 2,
        presetId: 'translator-b',
        patch: { prompt: 'updated prompt' },
        optimisticAcknowledgement: testCase.acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual(cases.map(() => 0))
  })
})
