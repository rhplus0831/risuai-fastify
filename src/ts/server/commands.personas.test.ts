import { makeCommandFetch, sha256Hex } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
} from '../personaMutationCertificate'
import {
  createPersonaCommand,
  deletePersonaCommand,
  reorderPersonasCommand,
  selectPersonaCommand,
  updatePersonaCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'

describe('persona command adapters', () => {
  it('dispatches persona commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/select')) {
        return {
          revision: 5,
          event: { type: 'persona.selected', revision: 5, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/reorder')) {
        return {
          revision: 6,
          event: { type: 'persona.reordered', revision: 6, resource: 'persona' },
          selectedPersonaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 4,
          event: { type: 'persona.deleted', revision: 4, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
          selectedPersonaId: 'persona-b',
        }
      }
      if (url.endsWith('/personas/persona-b')) {
        return {
          revision: 3,
          event: { type: 'persona.updated', revision: 3, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
        }
      }
      return {
        revision: 2,
        event: { type: 'persona.created', revision: 2, resource: 'persona', id: 'persona-b' },
        personaId: 'persona-b',
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      createPersonaCommand({
        baseRevision: 1,
        persona: { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'hello' },
        mirrorLegacyProfile: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, personaId: 'persona-b' })

    await expect(
      updatePersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        patch: { name: 'Bee', largePortrait: true },
        mirrorLegacyProfile: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, personaId: 'persona-b' })

    await expect(
      deletePersonaCommand({
        baseRevision: 3,
        personaId: 'persona-a',
        selectPersonaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      revision: 4,
      personaId: 'persona-a',
      selectedPersonaId: 'persona-b',
    })

    await expect(
      selectPersonaCommand({
        baseRevision: 4,
        personaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, personaId: 'persona-b' })

    await expect(
      reorderPersonasCommand({
        baseRevision: 5,
        personaIds: ['persona-b'],
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, selectedPersonaId: 'persona-b' })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/personas',
        method: 'POST',
        body: {
          baseRevision: 1,
          persona: { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'hello' },
          mirrorLegacyProfile: true,
        },
      },
      {
        url: '/api/v1/commands/personas/persona-b',
        method: 'PATCH',
        body: {
          baseRevision: 2,
          patch: { name: 'Bee', largePortrait: true },
          mirrorLegacyProfile: true,
        },
      },
      {
        url: '/api/v1/commands/personas/persona-a',
        method: 'DELETE',
        body: {
          baseRevision: 3,
          selectPersonaId: 'persona-b',
          mirrorLegacyProfile: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/personas/select',
        method: 'POST',
        body: {
          baseRevision: 4,
          personaId: 'persona-b',
          mirrorLegacyProfile: true,
          saveCurrent: true,
        },
      },
      {
        url: '/api/v1/commands/personas/reorder',
        method: 'POST',
        body: { baseRevision: 5, personaIds: ['persona-b'] },
      },
    ])
  })

  it('acknowledges stable structural persona owners while keeping delete cascade reconciliation authoritative', async () => {
    const profileA = { name: 'A', icon: 'asset-a', personaPrompt: 'Prompt A', note: 'Note A' }
    const profileB = { name: 'B', icon: 'asset-b', personaPrompt: 'Prompt B', note: 'Note B' }
    const personaA = { id: 'persona-a', ...profileA }
    const personaB = { id: 'persona-b', ...profileB }
    const [idsAB, collectionAB, collectionB, profileBDigest] = await Promise.all([
      sha256Hex(serializePersonaIdsDigestInput(['persona-a', 'persona-b'])),
      sha256Hex(serializePersonaCollectionDigestInput([personaA, personaB])),
      sha256Hex(serializePersonaCollectionDigestInput([personaB])),
      sha256Hex(serializePersonaProfileDigestInput(profileB)),
    ])
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/personas/select')) {
        return {
          revision: 4,
          event: { type: 'persona.selected', revision: 4, resource: 'persona', id: 'persona-b' },
          personaId: 'persona-b',
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'select',
          personaProjectionDigest: idsAB,
          selectedPersonaId: 'persona-b',
          collectionWritten: false,
          settingsWritten: true,
          legacyProfileProjectionApplied: false,
          legacyProfileDigest: null,
        }
      }
      if (url.endsWith('/personas/reorder')) {
        return {
          revision: 5,
          event: { type: 'persona.reordered', revision: 5, resource: 'persona' },
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'reorder',
          personaProjectionDigest: collectionAB,
          selectedPersonaId: 'persona-b',
          collectionWritten: true,
          settingsWritten: true,
          legacyProfileProjectionApplied: false,
          legacyProfileDigest: null,
        }
      }
      if (url.endsWith('/personas/persona-a')) {
        return {
          revision: 3,
          event: { type: 'persona.deleted', revision: 3, resource: 'persona', id: 'persona-a' },
          personaId: 'persona-a',
          personaMutationCertificate: 'persona-mutation-v1',
          operation: 'delete',
          personaProjectionDigest: collectionB,
          selectedPersonaId: 'persona-b',
          collectionWritten: true,
          settingsWritten: true,
          legacyProfileProjectionApplied: true,
          legacyProfileDigest: profileBDigest,
        }
      }
      return {
        revision: 2,
        event: { type: 'persona.created', revision: 2, resource: 'persona', id: 'persona-b' },
        personaId: 'persona-b',
        personaMutationCertificate: 'persona-mutation-v1',
        operation: 'create',
        personaProjectionDigest: collectionAB,
        selectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionApplied: false,
        legacyProfileDigest: null,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await createPersonaCommand({
      baseRevision: 1,
      persona: personaB,
      mirrorLegacyProfile: false,
      optimisticAcknowledgement: {
        operation: 'create',
        collectionProjectionEpoch: 10,
        settingsProjectionEpoch: 20,
        beforePersonaIds: ['persona-a'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [personaA, personaB],
        beforeSelectedPersonaId: 'persona-a',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })
    await deletePersonaCommand({
      baseRevision: 2,
      personaId: 'persona-a',
      selectPersonaId: 'persona-b',
      mirrorLegacyProfile: true,
      saveCurrent: true,
      optimisticAcknowledgement: {
        operation: 'delete',
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 21,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-b'],
        attemptedPersonas: [personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: true,
        attemptedLegacyProfile: profileB,
      },
    })
    await selectPersonaCommand({
      baseRevision: 3,
      personaId: 'persona-b',
      mirrorLegacyProfile: false,
      saveCurrent: false,
      optimisticAcknowledgement: {
        operation: 'select',
        collectionProjectionEpoch: 12,
        settingsProjectionEpoch: 22,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [{ ...personaA, displayName: 'Unsent unrelated edit' }, personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: false,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })
    await reorderPersonasCommand({
      baseRevision: 4,
      personaIds: ['persona-a', 'persona-b'],
      optimisticAcknowledgement: {
        operation: 'reorder',
        collectionProjectionEpoch: 13,
        settingsProjectionEpoch: 23,
        beforePersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonaIds: ['persona-a', 'persona-b'],
        attemptedPersonas: [personaA, personaB],
        beforeSelectedPersonaId: 'persona-b',
        attemptedSelectedPersonaId: 'persona-b',
        collectionWritten: true,
        settingsWritten: true,
        legacyProfileProjectionExpected: false,
        attemptedLegacyProfile: null,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'personaMutation',
        operation: 'create',
        targetPersonaId: 'persona-b',
        collectionProjectionEpoch: 10,
        settingsProjectionEpoch: 20,
        collectionWritten: true,
        settingsWritten: true,
      },
      {
        kind: 'personaMutation',
        operation: 'select',
        targetPersonaId: 'persona-b',
        collectionProjectionEpoch: 12,
        settingsProjectionEpoch: 22,
        collectionWritten: false,
        settingsWritten: true,
      },
      {
        kind: 'personaMutation',
        operation: 'reorder',
        targetPersonaId: null,
        collectionProjectionEpoch: 13,
        settingsProjectionEpoch: 23,
        collectionWritten: true,
        settingsWritten: true,
      },
    ])
    expect(commandFetch.calls.every((call) => !Object.hasOwn(call.body as object, 'optimisticAcknowledgement'))).toBe(
      true,
    )
  })

  it('keeps malformed structural persona receipts and contradictory proofs on authoritative reconciliation', async () => {
    const profileA = { name: 'A', icon: '', personaPrompt: 'A', note: '' }
    const profileB = { name: 'B', icon: '', personaPrompt: 'B', note: '' }
    const personaA = { id: 'persona-a', ...profileA }
    const personaB = { id: 'persona-b', ...profileB }
    const [personaProjectionDigest, profileBDigest] = await Promise.all([
      sha256Hex(serializePersonaCollectionDigestInput([personaA, personaB])),
      sha256Hex(serializePersonaProfileDigestInput(profileB)),
    ])
    const exactResponse = {
      revision: 3,
      event: { type: 'persona.selected', revision: 3, resource: 'persona', id: 'persona-b' },
      personaId: 'persona-b',
      personaMutationCertificate: 'persona-mutation-v1',
      operation: 'select',
      personaProjectionDigest,
      selectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionApplied: true,
      legacyProfileDigest: profileBDigest,
    }
    const responses = [
      { ...exactResponse, personaProjectionDigest: '0'.repeat(64) },
      { ...exactResponse, legacyProfileDigest: 'f'.repeat(64) },
      { ...exactResponse, event: { ...exactResponse.event, resource: 'settings' } },
      exactResponse,
      exactResponse,
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const acknowledgement = {
      operation: 'select' as const,
      collectionProjectionEpoch: 12,
      settingsProjectionEpoch: 22,
      beforePersonaIds: ['persona-a', 'persona-b'],
      attemptedPersonaIds: ['persona-a', 'persona-b'],
      attemptedPersonas: [personaA, personaB],
      beforeSelectedPersonaId: 'persona-a',
      attemptedSelectedPersonaId: 'persona-b',
      collectionWritten: true,
      settingsWritten: true,
      legacyProfileProjectionExpected: true,
      attemptedLegacyProfile: profileB,
    }

    for (let index = 0; index < responses.length; index += 1) {
      await selectPersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        mirrorLegacyProfile: true,
        saveCurrent: true,
        optimisticAcknowledgement:
          index === responses.length - 1
            ? { ...acknowledgement, settingsWritten: false }
            : index === responses.length - 2
              ? { ...acknowledgement, collectionWritten: false }
              : acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0, 0, 0, 0])
  })

  it('exposes an exact persona PATCH acknowledgement without serializing optimistic proof', async () => {
    const event = {
      type: 'persona.updated',
      revision: 3,
      resource: 'persona',
      id: 'persona-b',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      personaId: 'persona-b',
      acknowledgedKeys: ['name', 'largePortrait'],
      legacyProfileProjectionApplied: true,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const attemptedPersona = {
      id: 'persona-b',
      name: 'Bee',
      displayName: 'B',
      icon: 'asset-b',
      personaPrompt: 'Prompt B',
      note: 'Note B',
      largePortrait: true,
    }

    await updatePersonaCommand({
      baseRevision: 2,
      personaId: 'persona-b',
      patch: { name: 'Bee', largePortrait: true },
      mirrorLegacyProfile: true,
      optimisticAcknowledgement: {
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        attemptedPersona,
        attemptedLegacyProfile: {
          username: 'Bee',
          userIcon: 'asset-b',
          personaPrompt: 'Prompt B',
          userNote: 'Note B',
        },
        legacyProfileProjectionExpected: true,
      },
    })

    expect(observedEffects).toEqual([
      {
        kind: 'personaPatch',
        personaId: 'persona-b',
        collectionProjectionEpoch: 11,
        settingsProjectionEpoch: 17,
        attemptedPatch: { name: 'Bee', largePortrait: true },
        attemptedPersona,
        attemptedLegacyProfile: {
          username: 'Bee',
          userIcon: 'asset-b',
          personaPrompt: 'Prompt B',
          userNote: 'Note B',
        },
        legacyProfileProjectionApplied: true,
      },
    ])
    expect(commandFetch.calls[0]?.body).toEqual({
      baseRevision: 2,
      patch: { name: 'Bee', largePortrait: true },
      mirrorLegacyProfile: true,
    })
    expect(commandFetch.calls[0]?.body).not.toHaveProperty('optimisticAcknowledgement')
  })

  it('keeps malformed or contradictory persona PATCH receipts on authoritative reconciliation', async () => {
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })
    const event = {
      type: 'persona.updated',
      revision: 3,
      resource: 'persona',
      id: 'persona-b',
    }
    const responses = [
      {
        revision: 3,
        event,
        personaId: 'persona-b',
        acknowledgedKeys: ['displayName'],
        legacyProfileProjectionApplied: true,
      },
      {
        revision: 3,
        event,
        personaId: 'persona-b',
        acknowledgedKeys: ['name'],
        legacyProfileProjectionApplied: false,
      },
      {
        revision: 3,
        event: { ...event, resource: 'settings' },
        personaId: 'persona-b',
        acknowledgedKeys: ['name'],
        legacyProfileProjectionApplied: true,
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => responses[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const acknowledgement = {
      collectionProjectionEpoch: 11,
      settingsProjectionEpoch: 17,
      attemptedPersona: { id: 'persona-b', name: 'Bee', icon: '', personaPrompt: '', note: '' },
      attemptedLegacyProfile: {
        username: 'Bee',
        userIcon: '',
        personaPrompt: '',
        userNote: '',
      },
      legacyProfileProjectionExpected: true,
    }

    for (let index = 0; index < responses.length; index += 1) {
      await updatePersonaCommand({
        baseRevision: 2,
        personaId: 'persona-b',
        patch: { name: 'Bee' },
        mirrorLegacyProfile: true,
        optimisticAcknowledgement: acknowledgement,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0, 0])
  })
})
