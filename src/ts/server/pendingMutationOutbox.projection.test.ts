import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptPendingMutationLocalProjectionToken,
  advancePendingMutationProjectionTargets,
  clearPendingMutationOutbox,
  completePendingMutation,
  discardPendingMutation,
  isPendingMutationProjectionFenceCurrent,
  pendingMutationAgentCollectionProjectionTarget,
  pendingMutationAgentPresetCollectionProjectionTarget,
  pendingMutationAgentPresetDefaultProjectionTarget,
  pendingMutationAgentPresetOrderProjectionTarget,
  pendingMutationAgentPresetRowProjectionTarget,
  pendingMutationAgentPresetStepProjectionTarget,
  pendingMutationAgentPresetStepsProjectionTarget,
  pendingMutationAgentRowProjectionTarget,
  pendingMutationCharacterLorebooksProjectionTarget,
  pendingMutationCharacterScriptsProjectionTarget,
  pendingMutationCharacterTriggersProjectionTarget,
  pendingMutationLocalProjectionFence,
  pendingMutationPluginOrderProjectionTarget,
  pendingMutationPluginProviderProjectionTarget,
  pendingMutationPluginRowProjectionTarget,
  pendingMutationPluginStorageProjectionTarget,
  pendingMutationProjectionFence,
  pendingMutationProjectionGenerationCountForTests,
  pendingMutationProjectionTargets,
  pendingMutationSettingsFieldProjectionTarget,
  preparePendingMutationOutbox,
  replaceStagedPendingMutationIntent,
  resetPendingMutationOutboxForTests,
  retirePendingMutationLocalProjectionToken,
  stagePendingMutation,
} from './pendingMutationOutbox'
import { resetPersistenceActivityForTests } from './persistenceActivity.svelte'
import { settingsIntent } from './pendingMutationOutbox.testSupport'

beforeEach(async () => {
  // This suite owns one isolated database; cross-tab locking has its own suite.
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-a',
    writerEpoch: 1,
    databaseLineage: 'database-a',
    requestedWriterWasActive: true,
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  resetPersistenceActivityForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pending mutation outbox projection targets', () => {
  it('maps character lorebook, script, and trigger variants to shared owner projections', () => {
    const targetsFor = (method: 'DELETE' | 'PATCH' | 'POST' | 'PUT', path: string) =>
      pendingMutationProjectionTargets({ version: 1, requests: [{ method, path, body: {} }] })
    const lorebooksTarget = pendingMutationCharacterLorebooksProjectionTarget('character a')

    expect([
      targetsFor('PUT', '/characters/character%20a/lorebooks'),
      targetsFor('PUT', '/characters/character%20a/lorebooks/entries/entry-a'),
      targetsFor('DELETE', '/characters/character%20a/lorebooks/entries/entry-a'),
      targetsFor('POST', '/characters/character%20a/lorebooks/entries/reorder'),
    ]).toEqual([[lorebooksTarget], [lorebooksTarget], [lorebooksTarget], [lorebooksTarget]])
    expect(targetsFor('PUT', '/characters/character%20a/scripts')).toEqual([
      pendingMutationCharacterScriptsProjectionTarget('character a'),
    ])
    expect(targetsFor('PATCH', '/characters/character%20a/triggers')).toEqual([
      pendingMutationCharacterTriggersProjectionTarget('character a'),
    ])

    expect(targetsFor('PUT', '/chats/character%20a/lorebooks')).toEqual(['request:PUT:/chats/character%20a/lorebooks'])
    expect(targetsFor('PATCH', '/modules/character%20a/scripts')).toEqual([
      'request:PATCH:/modules/character%20a/scripts',
    ])
  })

  it('maps plugin rows, provider, ordering, and storage keys to concrete projections', () => {
    const targetsFor = (
      method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
      path: string,
      body: Record<string, unknown> = {},
    ) => pendingMutationProjectionTargets({ version: 1, requests: [{ method, path, body }] })

    const row = pendingMutationPluginRowProjectionTarget('plugin a')
    expect(targetsFor('POST', '/plugins', { plugin: { name: 'plugin a' } })).toEqual([row])
    expect(targetsFor('PATCH', '/plugins/plugin%20a')).toEqual([row])
    expect(targetsFor('POST', '/plugins/plugin%20a/enable')).toEqual([row])
    expect(targetsFor('DELETE', '/plugins/plugin%20a')).toEqual(
      [row, pendingMutationPluginProviderProjectionTarget()].sort(),
    )
    expect(targetsFor('POST', '/plugins/provider')).toEqual([pendingMutationPluginProviderProjectionTarget()])
    expect(targetsFor('POST', '/plugins/reorder')).toEqual([pendingMutationPluginOrderProjectionTarget()])
    expect(targetsFor('PUT', '/plugin-storage/key%20a')).toEqual([
      pendingMutationPluginStorageProjectionTarget('key a'),
    ])
    expect(
      targetsFor('POST', '/plugin-storage/bulk', {
        values: { alpha: true },
        deleteKeys: ['beta'],
      }),
    ).toEqual([
      pendingMutationPluginStorageProjectionTarget('alpha'),
      pendingMutationPluginStorageProjectionTarget('beta'),
    ])
  })

  it('maps Agent Preset rows, steps, ordering, and defaults to concrete projections', () => {
    const targetsFor = (method: 'DELETE' | 'PATCH' | 'POST', path: string) =>
      pendingMutationProjectionTargets({ version: 1, requests: [{ method, path, body: {} }] })
    const presetRow = pendingMutationAgentPresetRowProjectionTarget('preset a')
    const steps = pendingMutationAgentPresetStepsProjectionTarget('preset a')
    const stepRow = pendingMutationAgentPresetStepProjectionTarget('preset a', 'step a')

    expect(targetsFor('POST', '/agent-presets')).toEqual([pendingMutationAgentPresetCollectionProjectionTarget()])
    expect(targetsFor('POST', '/agent-presets/preset%20a/duplicate')).toEqual([
      pendingMutationAgentPresetCollectionProjectionTarget(),
    ])
    expect(targetsFor('PATCH', '/agent-presets/preset%20a')).toEqual([presetRow])
    expect(targetsFor('DELETE', '/agent-presets/preset%20a')).toEqual(
      [
        presetRow,
        pendingMutationAgentPresetOrderProjectionTarget(),
        pendingMutationAgentPresetDefaultProjectionTarget(),
      ].sort(),
    )
    expect(targetsFor('POST', '/agent-presets/reorder')).toEqual([pendingMutationAgentPresetOrderProjectionTarget()])
    expect(targetsFor('POST', '/agent-presets/default')).toEqual([pendingMutationAgentPresetDefaultProjectionTarget()])
    expect(targetsFor('POST', '/agent-presets/preset%20a/uses')).toEqual([steps])
    expect(targetsFor('POST', '/agent-presets/preset%20a/uses/reorder')).toEqual([steps])
    expect(targetsFor('PATCH', '/agent-presets/preset%20a/uses/step%20a')).toEqual([stepRow])
    expect(targetsFor('DELETE', '/agent-presets/preset%20a/uses/step%20a')).toEqual([stepRow, steps].sort())
    expect(targetsFor('POST', '/agent-presets/preset%20a/steps')).toEqual([steps])
    expect(targetsFor('POST', '/agent-presets/preset%20a/steps/step%20a/duplicate')).toEqual([steps])
    expect(targetsFor('POST', '/agent-presets/preset%20a/steps/reorder')).toEqual([steps])
    expect(targetsFor('PATCH', '/agent-presets/preset%20a/steps/step%20a')).toEqual([stepRow])
    expect(targetsFor('DELETE', '/agent-presets/preset%20a/steps/step%20a')).toEqual([stepRow, steps].sort())
  })

  it('maps standalone Agent rows and ordering to concrete projections', () => {
    const targetsFor = (method: 'DELETE' | 'PATCH' | 'POST', path: string) =>
      pendingMutationProjectionTargets({ version: 1, requests: [{ method, path, body: {} }] })
    const collection = pendingMutationAgentCollectionProjectionTarget()
    const row = pendingMutationAgentRowProjectionTarget('agent a')

    expect(targetsFor('POST', '/agents')).toEqual([collection])
    expect(targetsFor('POST', '/agents/reorder')).toEqual([collection])
    expect(targetsFor('POST', '/agents/agent%20a/duplicate')).toEqual([collection])
    expect(targetsFor('PATCH', '/agents/agent%20a')).toEqual([row])
    expect(targetsFor('DELETE', '/agents/agent%20a')).toEqual([row, collection].sort())
  })
})

describe('pending mutation outbox projection fences', () => {
  it('fences concrete fields independently even when writers share a semantic key', async () => {
    const openAIKeyTarget = pendingMutationSettingsFieldProjectionTarget('openAIKey')
    const temperatureTarget = pendingMutationSettingsFieldProjectionTarget('temperature')
    const first = stagePendingMutation('settings:runtime', settingsIntent('first'))
    const unrelated = stagePendingMutation('settings:runtime', {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { temperature: 0.7 } } }],
    })
    await Promise.all([first.ready, unrelated.ready])

    const firstFence = pendingMutationProjectionFence(first, openAIKeyTarget)
    const unrelatedFence = pendingMutationProjectionFence(unrelated, temperatureTarget)
    expect(firstFence && isPendingMutationProjectionFenceCurrent(firstFence)).toBe(true)
    expect(unrelatedFence && isPendingMutationProjectionFenceCurrent(unrelatedFence)).toBe(true)

    const newer = stagePendingMutation('settings:other', settingsIntent('newer'))
    await newer.ready
    const newerFence = pendingMutationProjectionFence(newer, openAIKeyTarget)
    expect(firstFence && isPendingMutationProjectionFenceCurrent(firstFence)).toBe(false)
    expect(newerFence && isPendingMutationProjectionFenceCurrent(newerFence)).toBe(true)
  })

  it('keeps an accepted generation as the baseline when a newer rejected writer retires', async () => {
    const target = pendingMutationSettingsFieldProjectionTarget('openAIKey')
    const obsolete = stagePendingMutation('settings:obsolete', settingsIntent('obsolete'))
    const accepted = stagePendingMutation('settings:accepted', settingsIntent('accepted'))
    await Promise.all([obsolete.ready, accepted.ready])
    await expect(completePendingMutation(accepted, 1)).resolves.toBe('deleted')

    const acceptedFence = pendingMutationProjectionFence(accepted, target)
    expect(pendingMutationProjectionFence(obsolete, target)).toBeNull()
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(true)

    const rejected = stagePendingMutation('settings:rejected', settingsIntent('rejected'))
    await rejected.ready
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(false)
    await expect(discardPendingMutation(rejected)).resolves.toBe('deleted')
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(true)
  })

  it('compacts accepted projection history instead of growing one field forever', async () => {
    for (let index = 0; index < 24; index += 1) {
      const handle = stagePendingMutation(`settings:accepted:${index}`, settingsIntent(`value-${index}`))
      await handle.ready
      await expect(completePendingMutation(handle, 1)).resolves.toBe('deleted')
    }

    expect(pendingMutationProjectionGenerationCountForTests()).toBe(1)
  })

  it('automatically retires an unavailable successor and reveals its prior writer', async () => {
    const target = pendingMutationSettingsFieldProjectionTarget('openAIKey')
    const prior = stagePendingMutation('settings:prior', settingsIntent('prior'))
    await prior.ready
    const priorFence = pendingMutationProjectionFence(prior, target)
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('encryption unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const unavailable = stagePendingMutation('settings:unavailable', settingsIntent('unavailable'))
    const unavailableFence = pendingMutationProjectionFence(unavailable, target)
    expect(unavailableFence && isPendingMutationProjectionFenceCurrent(unavailableFence)).toBe(true)
    await expect(unavailable.ready).resolves.toBe('unavailable')
    await Promise.resolve()

    expect(pendingMutationProjectionFence(unavailable, target)).toBeNull()
    expect(priorFence && isPendingMutationProjectionFenceCurrent(priorFence)).toBe(true)
  })

  it('preserves a placeholder ordinal when exact intent replacement adds a target', async () => {
    const temperatureTarget = pendingMutationSettingsFieldProjectionTarget('temperature')
    const placeholder = stagePendingMutation('settings:placeholder', settingsIntent('placeholder'))
    await placeholder.ready
    const newer = stagePendingMutation('settings:newer', {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { patch: { temperature: 0.8 } } }],
    })
    await newer.ready

    const replacement = await replaceStagedPendingMutationIntent(placeholder, {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/runtime',
          body: { patch: { openAIKey: 'placeholder', temperature: 0.4 } },
        },
      ],
    })
    expect(replacement.status).toBe('replaced')
    if (replacement.status !== 'replaced') throw new Error('Expected exact replacement')

    const replacementFence = pendingMutationProjectionFence(replacement.handle, temperatureTarget)
    const newerFence = pendingMutationProjectionFence(newer, temperatureTarget)
    expect(replacementFence && isPendingMutationProjectionFenceCurrent(replacementFence)).toBe(false)
    expect(newerFence && isPendingMutationProjectionFenceCurrent(newerFence)).toBe(true)
  })

  it('advances and retires local projection writers without losing an accepted local baseline', async () => {
    const target = pendingMutationSettingsFieldProjectionTarget('openAIKey')
    const prior = stagePendingMutation('settings:prior', settingsIntent('prior'))
    await prior.ready
    const priorFence = pendingMutationProjectionFence(prior, target)
    const accepted = advancePendingMutationProjectionTargets([target])
    const acceptedFence = pendingMutationLocalProjectionFence(accepted, target)
    expect(priorFence && isPendingMutationProjectionFenceCurrent(priorFence)).toBe(false)
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(true)

    acceptPendingMutationLocalProjectionToken(accepted)
    expect(pendingMutationProjectionFence(prior, target)).toBeNull()
    const failed = advancePendingMutationProjectionTargets([target])
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(false)
    retirePendingMutationLocalProjectionToken(failed)
    expect(acceptedFence && isPendingMutationProjectionFenceCurrent(acceptedFence)).toBe(true)
  })

  it('invalidates live fences on scope changes and same-scope rejected-writer cleanup', async () => {
    const target = pendingMutationSettingsFieldProjectionTarget('openAIKey')
    const oldScope = stagePendingMutation('settings:old-scope', settingsIntent('old'))
    const oldFence = pendingMutationProjectionFence(oldScope, target)
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 2,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    expect(oldFence && isPendingMutationProjectionFenceCurrent(oldFence)).toBe(false)

    const rejectedWriter = stagePendingMutation('settings:rejected-writer', settingsIntent('rejected'))
    const rejectedFence = pendingMutationProjectionFence(rejectedWriter, target)
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 2,
      databaseLineage: 'database-a',
      requestedWriterWasActive: false,
    })
    expect(rejectedFence && isPendingMutationProjectionFenceCurrent(rejectedFence)).toBe(false)
  })
})
