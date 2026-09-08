import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureJsonWork } from '../__tests__/browserWorkProbe'
const browserEvidence = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[], generation: 0 }))
vi.mock('./browserDiagnostics', () => ({
  recordBrowserDiagnostic: (entry: Record<string, unknown>) => browserEvidence.entries.push(entry),
  resetBrowserDiagnosticsSession: () => {
    browserEvidence.generation++
    browserEvidence.entries = []
  },
  captureBrowserDiagnosticsGeneration: () => browserEvidence.generation,
  isBrowserDiagnosticsGenerationCurrent: (generation: number) => generation === browserEvidence.generation,
}))

import {
  acceptPendingMutationLocalProjectionToken,
  acknowledgePendingMutation,
  advancePendingMutationProjectionTargets,
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  completePendingMutation,
  countBlockingPendingMutationRecords,
  countPendingMutationRecords,
  deletePendingMutationReceiptAcknowledgement,
  discardPendingMutation,
  listPendingMutationPredecessors,
  listPendingMutationReceiptAcknowledgements,
  listPendingMutations,
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
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
  readSinglePendingMutationOwner,
  replaceStagedPendingMutationIntent,
  resetPendingMutationOutboxForTests,
  retirePendingMutationLocalProjectionToken,
  setPendingMutationCommitTransactionHookForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import {
  PERSISTENCE_ACTIVITY_LINGER_MS,
  persistenceSavingState,
  resetPersistenceActivityForTests,
} from './persistenceActivity.svelte'

function settingsIntent(value: string): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: '/settings/runtime',
        body: { patch: { openAIKey: value } },
      },
    ],
  }
}

beforeEach(async () => {
  browserEvidence.entries = []
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

describe('pending mutation outbox', () => {
  it.each(['replaced', 'successor'] as const)(
    'owns one normalized snapshot when a prepared intent is %s',
    async (expectedStatus) => {
      const placeholder = stagePendingMutation('settings:runtime', settingsIntent('placeholder'))
      await placeholder.ready
      if (expectedStatus === 'successor') {
        await expect(discardPendingMutation((await listPendingMutations())[0]!.handle)).resolves.toBe('deleted')
      }
      const input = settingsIntent('exact captured value')
      const measured = await measureJsonWork(
        async () => {
          const replacement = replaceStagedPendingMutationIntent(placeholder, input)
          input.requests[0]!.body.patch = { openAIKey: 'caller changed after capture' }
          return replacement
        },
        (stack) => (stack.includes('normalizeRequest') ? 'normalization' : undefined),
      )
      expect(measured.result.status).toBe(expectedStatus)
      expect(measured.counters.normalization?.count).toBe(1)
      expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
        settingsIntent('exact captured value'),
      ])
      if (measured.result.status === 'successor')
        expect(measured.result.handle.mutationId).not.toBe(placeholder.mutationId)
    },
  )

  it.each([
    { name: 'non-object body', body: [] },
    { name: 'injected base revision', body: { baseRevision: 9 } },
  ])('validates the owned JSON snapshot before staging a $name', ({ body }) => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: 'PATCH', path: '/settings/runtime', body: { toJSON: () => body } }],
    }
    expect(() => stagePendingMutation('invalid-canonical-body', intent)).toThrow(TypeError)
    expect(() => pendingMutationProjectionTargets(intent)).toThrow(TypeError)
  })

  it('captures request headers and membership before a body JSON conversion changes its caller', async () => {
    const intent = settingsIntent('external')
    const request = intent.requests[0]!
    request.body = {
      toJSON: () => {
        request.path = '/unsafe-side-effect'
        intent.requests.length = 0
        return { patch: { openAIKey: 'owned' } }
      },
    }
    await expect(stagePendingMutation('owned-headers', intent).ready).resolves.toBe('persisted')
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('owned')])
    expect(() => stagePendingMutation('sparse', { version: 1, requests: new Array(1) })).toThrow(
      'request must be an object',
    )
  })

  it('continues validating public projection helpers and request bounds', () => {
    const intent = settingsIntent('external')
    expect(pendingMutationProjectionTargets(intent)).toEqual([
      pendingMutationSettingsFieldProjectionTarget('openAIKey'),
    ])
    intent.requests[0]!.path = '/unsafe-side-effect'
    expect(() => pendingMutationProjectionTargets(intent)).toThrow('not allowlisted')
    for (const requestCount of [0, 101]) {
      expect(() =>
        stagePendingMutation('request-limit', {
          version: 1,
          requests: Array.from({ length: requestCount }, () => settingsIntent('value').requests[0]!),
        }),
      ).toThrow('request count is invalid')
    }
    expect(() =>
      stagePendingMutation('generation-limit', {
        version: 1,
        kind: 'generation-operation-submit',
        requests: [
          { method: 'POST', path: '/generation-operations', body: {} },
          { method: 'POST', path: '/generation-operations', body: {} },
        ],
      }),
    ).toThrow('exactly one request')
  })

  it('normalizes frozen non-JSON numbers and rejects frozen cycles or bigint instead of trusting them', async () => {
    const input: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/settings/runtime',
          body: Object.freeze({ patch: Object.freeze({ temperature: NaN, topP: -0, username: undefined }) }),
        },
      ],
    }
    await expect(stagePendingMutation('canonical-values', input).ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]!.intent.requests[0]!.body).toEqual({
      patch: { temperature: null, topP: 0 },
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const patch of [Object.freeze(cycle), Object.freeze({ value: 1n })]) {
      expect(() =>
        stagePendingMutation('unsupported', {
          version: 1,
          requests: [{ method: 'PATCH', path: '/settings/runtime', body: Object.freeze({ patch }) }],
        }),
      ).toThrow(TypeError)
    }
    expect(await listPendingMutations()).toHaveLength(1)
  })

  it('keeps oversized staging and replacement unavailable without destroying the durable predecessor', async () => {
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('keep predecessor'))
    await placeholder.ready
    const oversized = settingsIntent('x'.repeat(MAX_DURABLE_MUTATION_PAYLOAD_BYTES))
    await expect(stagePendingMutation('oversized', oversized).ready).resolves.toBe('unavailable')
    await expect(replaceStagedPendingMutationIntent(placeholder, oversized)).resolves.toEqual({ status: 'unavailable' })
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('keep predecessor')])
    expect(placeholder.phase).toBe('staged')
  })

  it('encrypts and restores complete generation-operation submit intents', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      kind: 'generation-operation-submit',
      requests: [
        {
          method: 'POST',
          path: '/generation-operations',
          body: {
            operationId: '11111111-1111-4111-8111-111111111111',
            acceptedMessageId: '22222222-2222-4222-8222-222222222222',
            baseRevision: 7,
            draftGeneration: { transcriptIdentity: 'chat-a', sequence: 4 },
          },
        },
      ],
    }
    const handle = stagePendingMutation('generation-operation-submit:operation-a', intent)

    await expect(handle.ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]?.intent).toEqual(intent)
    expect(pendingMutationProjectionTargets(intent)).toEqual([
      'generation-operation:11111111-1111-4111-8111-111111111111',
    ])
  })

  it('encrypts Stop controls without treating an acknowledged pending cancellation as startup-blocking', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      kind: 'generation-operation-cancel',
      requests: [
        {
          method: 'PUT',
          path: '/generation-operations/11111111-1111-4111-8111-111111111111/cancellation',
          body: {
            reason: 'user_stop',
            knownStateVersion: 3,
            knownAttemptNo: 1,
            knownJobId: 'job-a',
          },
        },
      ],
    }
    const handle = stagePendingMutation('generation-operation-cancel:operation-a', intent)

    await expect(handle.ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]?.intent).toEqual(intent)
    expect(pendingMutationProjectionTargets(intent)).toEqual([
      'generation-operation:11111111-1111-4111-8111-111111111111',
    ])
    await expect(countPendingMutationRecords()).resolves.toBe(1)
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(0)
  })

  it('lazily advances an explicit committed-order counter and retains it when rows are cleared', async () => {
    expect(await readRawOrderCounters()).toEqual([])

    const first = stagePendingMutation('settings:first', settingsIntent('first'))
    await expect(first.ready).resolves.toBe('persisted')
    expect(await readRawMutation(first.mutationId)).toMatchObject({ order: 1 })
    expect(await readRawOrderCounters()).toEqual([
      expect.objectContaining({
        version: 1,
        writerSessionId: 'writer-a',
        databaseLineage: 'database-a',
        lastCommittedOrder: 1,
      }),
    ])

    await clearPendingMutationOutbox()
    expect(await readRawOrderCounters()).toEqual([expect.objectContaining({ lastCommittedOrder: 1 })])

    const second = stagePendingMutation('settings:second', settingsIntent('second'))
    await expect(second.ready).resolves.toBe('persisted')
    expect(await readRawMutation(second.mutationId)).toMatchObject({ order: 2 })
    expect(await readRawOrderCounters()).toEqual([expect.objectContaining({ lastCommittedOrder: 2 })])
  })

  it('rolls back both the counter and row when the final transaction aborts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPendingMutationCommitTransactionHookForTests((transaction) => transaction.abort())

    const aborted = stagePendingMutation('settings:aborted', settingsIntent('aborted'))
    await expect(aborted.ready).resolves.toBe('unavailable')
    expect(await readRawMutation(aborted.mutationId)).toBeUndefined()
    expect(await readRawOrderCounters()).toEqual([])

    setPendingMutationCommitTransactionHookForTests(null)
    const recovered = stagePendingMutation('settings:recovered', settingsIntent('recovered'))
    await expect(recovered.ready).resolves.toBe('persisted')
    expect(await readRawMutation(recovered.mutationId)).toMatchObject({ order: 1 })
    expect(await readRawOrderCounters()).toEqual([expect.objectContaining({ lastCommittedOrder: 1 })])
  })

  it('initializes above legacy rows across epochs without rewriting their ciphertext', async () => {
    const first = stagePendingMutation('settings:first', settingsIntent('legacy-first'))
    const second = stagePendingMutation('settings:second', settingsIntent('legacy-second'))
    await Promise.all([first.ready, second.ready])
    const firstCiphertext = (await readRawMutation(first.mutationId))?.ciphertext
    const secondCiphertext = (await readRawMutation(second.mutationId))?.ciphertext
    await deleteRawOrderCounters()
    await removeRawKeyKind(first.mutationId)

    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 2,
      databaseLineage: 'database-a',
      requestedWriterWasActive: false,
    })
    const current = stagePendingMutation('settings:current', settingsIntent('current'))
    await expect(current.ready).resolves.toBe('persisted')

    expect(await readRawMutation(first.mutationId)).toMatchObject({ order: 1, ciphertext: firstCiphertext })
    expect(await readRawMutation(second.mutationId)).toMatchObject({ order: 2, ciphertext: secondCiphertext })
    expect(await readRawMutation(current.mutationId)).toMatchObject({ order: 3, writerEpoch: 2 })
    expect(await readRawOrderCounters()).toEqual([
      expect.objectContaining({
        writerSessionId: 'writer-a',
        databaseLineage: 'database-a',
        lastCommittedOrder: 3,
      }),
    ])
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
      settingsIntent('legacy-first'),
      settingsIntent('legacy-second'),
      settingsIntent('current'),
    ])
  })

  it('treats an explicit counter corruption as unavailable without deleting retained rows', async () => {
    const retained = stagePendingMutation('settings:retained', settingsIntent('retained'))
    await retained.ready
    await mutateRawOrderCounter((counter) => ({ ...counter, lastCommittedOrder: -1 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rejected = stagePendingMutation('settings:rejected', settingsIntent('rejected'))

    await expect(rejected.ready).resolves.toBe('unavailable')
    expect(await readRawMutation(retained.mutationId)).toBeDefined()
    expect(await readRawMutation(rejected.mutationId)).toBeUndefined()
    await expect(countPendingMutationRecords()).resolves.toBe(1)
  })

  it('treats committed-order exhaustion as unavailable without deleting retained rows', async () => {
    const retained = stagePendingMutation('settings:retained', settingsIntent('retained'))
    await retained.ready
    await mutateRawOrderCounter((counter) => ({
      ...counter,
      lastCommittedOrder: Number.MAX_SAFE_INTEGER,
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const rejected = stagePendingMutation('settings:rejected', settingsIntent('rejected'))

    await expect(rejected.ready).resolves.toBe('unavailable')
    expect(await readRawMutation(retained.mutationId)).toBeDefined()
    expect(await readRawMutation(rejected.mutationId)).toBeUndefined()
    await expect(countPendingMutationRecords()).resolves.toBe(1)
  })

  it('keeps persistence activity visible while an unacknowledged intent remains in the outbox', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('held-intent'))
    await expect(handle.ready).resolves.toBe('persisted')
    expect(await countPendingMutationRecords()).toBe(1)

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(PERSISTENCE_ACTIVITY_LINGER_MS * 2)

    expect(persistenceSavingState.state).toBe(true)
  })

  it('roundtrips and counts raw-key intents without WebCrypto subtle', async () => {
    stubCryptoWithoutSubtle()
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    await expect(countPendingMutationRecords()).resolves.toBe(0)

    const intent = settingsIntent('raw-key-roundtrip')
    const handle = stagePendingMutation('settings:runtime', intent)

    await expect(handle.ready).resolves.toBe('persisted')
    await expect(countPendingMutationRecords()).resolves.toBe(1)
    await expect(readRawMutation(handle.mutationId)).resolves.toMatchObject({ keyKind: 'raw' })

    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    const replayEntries = await listPendingMutations()
    expect(replayEntries).toEqual([
      expect.objectContaining({
        intent,
        handle: expect.objectContaining({ mutationId: handle.mutationId }),
      }),
    ])

    const replayHandle = replayEntries[0]!.handle
    await expect(beginPendingMutationDispatch(replayHandle)).resolves.toBe('persisted')
    await expect(completePendingMutation(replayHandle, 1)).resolves.toBe('deleted')
    await expect(countPendingMutationRecords()).resolves.toBe(0)
  })

  it('reports durable queue count and age without decrypting contents or changing the staged row', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const handle = stagePendingMutation('settings:private-canary', settingsIntent('PRIVATE_CREDENTIAL_CANARY'))
    await expect(handle.ready).resolves.toBe('persisted')
    await countPendingMutationRecords()
    expect(browserEvidence.entries).toContainEqual(
      expect.objectContaining({ stage: 'queue', queuedCount: 1, queueAgeMs: 0 }),
    )
    const rowBefore = await readRawMutation(handle.mutationId)
    clock.mockReturnValue(1_700_000_012_000)
    browserEvidence.generation++
    await countPendingMutationRecords()
    expect(browserEvidence.entries).toContainEqual(
      expect.objectContaining({ stage: 'queue', outcome: 'pending', queuedCount: 1, queueAgeMs: 12_000 }),
    )
    expect(await readRawMutation(handle.mutationId)).toEqual(rowBefore)
    clock.mockReturnValue(1_700_000_000_000 + 2 * 86_400_000)
    browserEvidence.generation++
    await countPendingMutationRecords()
    expect(browserEvidence.entries.at(-1)).toMatchObject({ queueAgeMs: 86_400_000 })
    expect(JSON.stringify(browserEvidence.entries)).not.toMatch(
      /PRIVATE_CREDENTIAL_CANARY|private-canary|writer-a|database-a|mutationId|ciphertext/,
    )
    clock.mockRestore()
  })

  it('retains and counts subtle-key intents when subtle becomes unavailable', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('subtle-key-retained'))
    await expect(handle.ready).resolves.toBe('persisted')
    await expect(readRawMutation(handle.mutationId)).resolves.toMatchObject({ keyKind: 'subtle' })

    stubCryptoWithoutSubtle()
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(listPendingMutations()).resolves.toEqual([])
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Unable to decrypt pending server mutation'),
      expect.any(Error),
    )
    await expect(countPendingMutationRecords()).resolves.toBe(1)
    await expect(readRawMutation(handle.mutationId)).resolves.toBeDefined()
  })

  it('counts scoped raw rows even when an encrypted intent cannot be decrypted', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('unreadable'))
    await expect(handle.ready).resolves.toBe('persisted')
    await corruptRawMutationCiphertext(handle.mutationId)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(listPendingMutations()).resolves.toEqual([])
    await expect(countPendingMutationRecords()).resolves.toBe(1)
  })

  it('persists encrypted intents across runtime cache resets without plaintext secrets at rest', async () => {
    const secret = 'sentinel-provider-secret-never-store-plaintext'
    const handle = stagePendingMutation('settings:runtime', settingsIntent(secret))

    await expect(handle.ready).resolves.toBe('persisted')
    const rawRecord = await readRawMutation(handle.mutationId)
    expect(rawRecord).toMatchObject({
      semanticKey: 'settings:runtime',
      mutationId: handle.mutationId,
      sequence: handle.sequence,
      ownerWriterSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
    })
    expect(JSON.stringify(rawRecord)).not.toContain(secret)
    expect(rawRecord?.ciphertext).toBeInstanceOf(ArrayBuffer)

    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    const entries = await listPendingMutations()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.intent).toEqual(settingsIntent(secret))
    expect(entries[0]?.handle.mutationId).toBe(handle.mutationId)
  })

  it('atomically replaces an unstarted staged payload under a fresh mutation id', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const first = stagePendingMutation('settings:runtime', settingsIntent('first'))
    await first.ready
    const remoteReady = deferred<'persisted'>()
    const remoteHandle = { ...(await listPendingMutations())[0]!.handle, ready: remoteReady.promise }
    const remoteBegin = beginPendingMutationDispatch(remoteHandle)
    clock.mockReturnValue(1_700_000_005_000)
    const latest = stagePendingMutation('settings:runtime', settingsIntent('latest'), first)

    expect(latest.mutationId).not.toBe(first.mutationId)
    expect(first.phase).toBe('superseded')
    await latest.ready
    remoteReady.resolve('persisted')
    await expect(remoteBegin).resolves.toBe('superseded')

    const entries = await listPendingMutations()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.intent).toEqual(settingsIntent('latest'))
    expect(entries[0]?.handle.sequence).toBe(latest.sequence)
    expect(await readRawMutation(latest.mutationId)).toMatchObject({
      queuedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
    })
  })

  it('keeps both fresh-id generations when another tab marks the predecessor first', async () => {
    const predecessor = stagePendingMutation('settings:runtime', settingsIntent('predecessor'))
    await predecessor.ready
    const remoteHandle = (await listPendingMutations())[0]!.handle
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })

    const successor = stagePendingMutation('settings:runtime', settingsIntent('successor'), predecessor)
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    await expect(beginPendingMutationDispatch(remoteHandle)).resolves.toBe('persisted')
    encryptionGate.resolve()
    await expect(successor.ready).resolves.toBe('persisted')

    const entries = await listPendingMutations()
    expect(entries.map((entry) => entry.handle.mutationId)).toEqual([predecessor.mutationId, successor.mutationId])
    expect(entries.map((entry) => entry.intent)).toEqual([settingsIntent('predecessor'), settingsIntent('successor')])
    expect(await readRawMutation(predecessor.mutationId)).toMatchObject({ dispatchStarted: true })
  })

  it('keeps a dispatching generation and its queued successor as separate durable rows', async () => {
    const acceptedA = stagePendingMutation('settings:runtime', settingsIntent('accepted-a'))
    await expect(beginPendingMutationDispatch(acceptedA)).resolves.toBe('persisted')

    const queuedB = stagePendingMutation('settings:runtime', settingsIntent('queued-b'), acceptedA)
    expect(queuedB.mutationId).not.toBe(acceptedA.mutationId)
    expect(acceptedA.phase).toBe('dispatching')
    await expect(queuedB.ready).resolves.toBe('persisted')

    let entries = await listPendingMutations()
    expect(entries.map((entry) => entry.intent)).toEqual([settingsIntent('accepted-a'), settingsIntent('queued-b')])

    await expect(completePendingMutation(acceptedA, 1)).resolves.toBe('deleted')
    entries = await listPendingMutations()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.handle.mutationId).toBe(queuedB.mutationId)
    expect(entries[0]?.intent).toEqual(settingsIntent('queued-b'))
  })

  it('lists only older generations for the same semantic resource and ownership scope', async () => {
    const retained = stagePendingMutation('settings:runtime', settingsIntent('retained-a'))
    await expect(beginPendingMutationDispatch(retained)).resolves.toBe('persisted')
    const successor = stagePendingMutation('settings:runtime', settingsIntent('successor-b'), retained)
    const unrelated = stagePendingMutation('settings:other', settingsIntent('unrelated'))
    await Promise.all([successor.ready, unrelated.ready])

    await expect(listPendingMutationPredecessors(successor)).resolves.toEqual({
      status: 'ok',
      semanticKeys: ['settings:runtime'],
      entries: [
        {
          handle: expect.objectContaining({
            key: 'settings:runtime',
            mutationId: retained.mutationId,
          }),
          intent: settingsIntent('retained-a'),
        },
      ],
    })
    await expect(listPendingMutationPredecessors(unrelated)).resolves.toEqual({
      status: 'ok',
      entries: [],
      semanticKeys: ['settings:other'],
    })
  })

  it('lists a transitive dependency closure without crossing the referring predecessor order', async () => {
    const olderTargetB = stagePendingMutation('character-owner:char-b', settingsIntent('target-b-older'))
    const selectB = stagePendingMutation('character-selection', {
      ...settingsIntent('select-b'),
      dependencyKeys: ['character-owner:char-b', 'character-selection'],
    })
    const newerTargetB = stagePendingMutation('character-owner:char-b', settingsIntent('target-b-newer'))
    const targetC = stagePendingMutation('character-owner:char-c', settingsIntent('target-c'))
    const selectC = stagePendingMutation('character-selection', {
      ...settingsIntent('select-c'),
      dependencyKeys: ['character-owner:char-c'],
    })
    await Promise.all([olderTargetB.ready, selectB.ready, newerTargetB.ready, targetC.ready, selectC.ready])

    const predecessors = await listPendingMutationPredecessors(selectC)

    expect(predecessors).toMatchObject({
      status: 'ok',
      semanticKeys: ['character-owner:char-b', 'character-owner:char-c', 'character-selection'],
    })
    if (predecessors.status !== 'ok') throw new Error('Expected a predecessor closure')
    expect(predecessors.entries.map((entry) => entry.handle.mutationId)).toEqual([
      olderTargetB.mutationId,
      selectB.mutationId,
      targetC.mutationId,
    ])
    expect(predecessors.entries.map((entry) => entry.handle.mutationId)).not.toContain(newerTargetB.mutationId)
  })

  it('normalizes bounded dependency keys and rejects near-malformed dependency metadata', async () => {
    const normalized = stagePendingMutation('settings:runtime', {
      ...settingsIntent('normalized'),
      dependencyKeys: [' settings:bridge ', 'settings:bridge', 'settings:runtime'],
    })
    await normalized.ready
    expect((await listPendingMutations())[0]?.intent.dependencyKeys).toEqual(['settings:bridge', 'settings:runtime'])

    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('not-an-array'),
        dependencyKeys: 'settings:bridge',
      } as unknown as DurableMutationIntent),
    ).toThrow('Pending mutation dependency keys must be an array')
    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('too-many'),
        dependencyKeys: Array.from({ length: 33 }, (_, index) => `dependency:${index}`),
      }),
    ).toThrow('Pending mutation dependency key count is invalid')
    expect(() =>
      stagePendingMutation('settings:runtime', {
        ...settingsIntent('too-long'),
        dependencyKeys: ['x'.repeat(2_049)],
      }),
    ).toThrow('Pending mutation key is invalid')
  })

  it('chains a slow predecessor persistence before atomically replacing it', async () => {
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi.spyOn(globalThis.crypto.subtle, 'encrypt')
    encryptSpy.mockImplementationOnce(async (algorithm, key, data) => {
      await encryptionGate.promise
      return originalEncrypt(algorithm, key, data)
    })

    const older = stagePendingMutation('settings:runtime', settingsIntent('older'))
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    const newer = stagePendingMutation('settings:runtime', settingsIntent('newer'), older)
    expect(newer.mutationId).not.toBe(older.mutationId)
    let newerSettled = false
    void newer.ready.then(() => {
      newerSettled = true
    })
    await Promise.resolve()
    expect(newerSettled).toBe(false)

    encryptionGate.resolve()
    await expect(Promise.all([older.ready, newer.ready])).resolves.toEqual(['persisted', 'persisted'])
    const entries = await listPendingMutations()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.handle.sequence).toBe(newer.sequence)
    expect(entries[0]?.intent).toEqual(settingsIntent('newer'))
  })

  it('marks legacy rows before dispatch and treats a missing marker as unstarted for replacement', async () => {
    const legacyDispatch = stagePendingMutation('settings:runtime', settingsIntent('legacy-dispatch'))
    await legacyDispatch.ready
    await removeRawDispatchStarted(legacyDispatch.mutationId)
    await expect(beginPendingMutationDispatch(legacyDispatch)).resolves.toBe('persisted')
    expect(await readRawMutation(legacyDispatch.mutationId)).toMatchObject({ dispatchStarted: true })

    const legacyReplace = stagePendingMutation('settings:other', settingsIntent('legacy-replace'))
    await legacyReplace.ready
    await removeRawDispatchStarted(legacyReplace.mutationId)
    const replacement = stagePendingMutation('settings:other', settingsIntent('replacement'), legacyReplace)
    await replacement.ready
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([
      legacyDispatch.mutationId,
      replacement.mutationId,
    ])
  })

  it('exactly replaces an unstarted placeholder without changing its id or durable order', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('fallback'))
    await placeholder.ready
    const staleReady = deferred<'persisted'>()
    const staleReplayHandle = { ...(await listPendingMutations())[0]!.handle, ready: staleReady.promise }
    const staleBegin = beginPendingMutationDispatch(staleReplayHandle)
    const before = await readRawMutation(placeholder.mutationId)

    clock.mockReturnValue(1_700_000_005_000)
    const replacement = await replaceStagedPendingMutationIntent(placeholder, settingsIntent('exact'))
    expect(replacement.status).toBe('replaced')
    if (replacement.status !== 'replaced') throw new Error('Expected an exact replacement')
    const exact = replacement.handle

    expect(exact.mutationId).toBe(placeholder.mutationId)
    expect(exact.sequence).not.toBe(placeholder.sequence)
    expect(await readRawMutation(exact.mutationId)).toMatchObject({
      order: before?.order,
      dispatchStarted: false,
      queuedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
    })
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('exact')])
    staleReady.resolve('persisted')
    await expect(staleBegin).resolves.toBe('superseded')
    await expect(beginPendingMutationDispatch(exact)).resolves.toBe('persisted')
  })

  it('gives an exact prepared intent a fresh successor id when dispatch marking wins the race', async () => {
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('fallback'))
    await placeholder.ready
    const remoteHandle = (await listPendingMutations())[0]!.handle
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })
    const replacement = replaceStagedPendingMutationIntent(placeholder, settingsIntent('exact'))
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalledOnce())
    await beginPendingMutationDispatch(remoteHandle)
    encryptionGate.resolve()

    const exact = await replacement

    expect(exact.status).toBe('successor')
    if (exact.status !== 'successor') throw new Error('Expected a fresh successor')
    expect(exact.handle.mutationId).not.toBe(placeholder.mutationId)
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
      settingsIntent('fallback'),
      settingsIntent('exact'),
    ])
  })

  it('keeps an exact same-scope correction when another tab removes its placeholder first', async () => {
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('fallback'))
    await placeholder.ready
    const remoteHandle = (await listPendingMutations())[0]!.handle
    await expect(discardPendingMutation(remoteHandle)).resolves.toBe('deleted')

    const exact = await replaceStagedPendingMutationIntent(placeholder, settingsIntent('exact'))

    expect(exact.status).toBe('successor')
    if (exact.status !== 'successor') throw new Error('Expected a fresh successor')
    expect(exact.handle.mutationId).not.toBe(placeholder.mutationId)
    expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([settingsIntent('exact')])
  })

  it('does not bind a superseded prepared placeholder to a replacement database scope', async () => {
    const placeholder = stagePendingMutation('settings:runtime', settingsIntent('old-database'))
    await placeholder.ready
    resetPendingMutationOutboxForTests()
    await expect(
      preparePendingMutationOutbox({
        writerSessionId: 'writer-a',
        writerEpoch: 1,
        databaseLineage: 'database-b',
        requestedWriterWasActive: true,
      }),
    ).resolves.toEqual({ discarded: 1 })

    await expect(replaceStagedPendingMutationIntent(placeholder, settingsIntent('must-not-restage'))).resolves.toEqual({
      status: 'superseded',
    })
    expect(await listPendingMutations()).toEqual([])
  })

  it('atomically replaces an accepted row with durable receipt cleanup work', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('accepted'))
    await expect(handle.ready).resolves.toBe('persisted')

    await expect(completePendingMutation(handle, 1)).resolves.toBe('deleted')
    expect(await listPendingMutations()).toEqual([])
    const acknowledgements = await listPendingMutationReceiptAcknowledgements()
    expect(acknowledgements).toEqual([
      expect.objectContaining({
        mutationId: handle.mutationId,
        requestCount: 1,
        databaseLineage: 'database-a',
      }),
    ])

    await expect(deletePendingMutationReceiptAcknowledgement(acknowledgements[0]!)).resolves.toBe(true)
    expect(await listPendingMutationReceiptAcknowledgements()).toEqual([])
  })

  it('keeps this writer drafts replayable when the same session reclaims a newer epoch', async () => {
    const rejected = stagePendingMutation('settings:runtime', settingsIntent('stale-tab-edit'))
    await expect(rejected.ready).resolves.toBe('persisted')

    resetPendingMutationOutboxForTests()
    const preparation = await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 2,
      databaseLineage: 'database-a',
      requestedWriterWasActive: false,
    })

    expect(preparation).toEqual({ discarded: 0 })
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([rejected.mutationId])
    expect(await readRawMutation(rejected.mutationId)).toBeDefined()
  })

  it('quarantines another writer session and lets each owner reclaim only its own rows', async () => {
    const pending = stagePendingMutation('settings:runtime', settingsIntent('recover-owner'))
    await pending.ready
    resetPendingMutationOutboxForTests()

    await expect(readSinglePendingMutationOwner()).resolves.toEqual({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
    })

    await expect(
      preparePendingMutationOutbox({
        writerSessionId: 'writer-b',
        writerEpoch: 2,
        databaseLineage: 'database-a',
        requestedWriterWasActive: false,
      }),
    ).resolves.toEqual({ discarded: 0 })
    expect(await listPendingMutations()).toEqual([])
    expect(await countPendingMutationRecords()).toBe(0)
    expect(await readRawMutation(pending.mutationId)).toBeDefined()

    const other = stagePendingMutation('settings:other', settingsIntent('other-owner'))
    await other.ready
    expect((await readRawOrderCounters()).map((counter) => counter.writerSessionId).sort()).toEqual([
      'writer-a',
      'writer-b',
    ])
    expect(await readRawMutation(pending.mutationId)).toMatchObject({ order: 1 })
    expect(await readRawMutation(other.mutationId)).toMatchObject({ order: 1 })
    resetPendingMutationOutboxForTests()
    await expect(readSinglePendingMutationOwner()).resolves.toBeNull()

    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 3,
      databaseLineage: 'database-a',
      requestedWriterWasActive: false,
    })
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([pending.mutationId])
    expect(await countPendingMutationRecords()).toBe(1)
    expect(await readRawMutation(other.mutationId)).toBeDefined()
    expect(await readRawOrderCounters()).toHaveLength(2)

    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-b',
      writerEpoch: 4,
      databaseLineage: 'database-a',
      requestedWriterWasActive: false,
    })
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([other.mutationId])
    expect(await countPendingMutationRecords()).toBe(1)
    expect(await readRawMutation(pending.mutationId)).toBeDefined()
  })

  it('deletes rows and receipt ACKs belonging to a different database lineage', async () => {
    const old = stagePendingMutation('settings:runtime', settingsIntent('old-database'))
    await old.ready
    await completePendingMutation(old, 1)
    const pending = stagePendingMutation('settings:runtime', settingsIntent('still-pending'))
    await pending.ready

    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-b',
      requestedWriterWasActive: true,
    })

    expect(await listPendingMutations()).toEqual([])
    expect(await listPendingMutationReceiptAcknowledgements()).toEqual([])
    expect(await readRawMutation(pending.mutationId)).toBeUndefined()
  })

  it('resets changed ownership synchronously once before admitting replacement-lineage writes', async () => {
    const old = stagePendingMutation('settings:old', settingsIntent('old-database'))
    await expect(old.ready).resolves.toBe('persisted')
    const onOwnershipChange = vi.fn()

    const preparation = preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-b',
      requestedWriterWasActive: true,
      onOwnershipChange,
    })
    expect(onOwnershipChange).toHaveBeenCalledOnce()

    const replacement = stagePendingMutation('settings:new', settingsIntent('replacement-database'))
    await expect(replacement.ready).resolves.toBe('persisted')
    await expect(preparation).resolves.toEqual({ discarded: 1 })
    expect((await listPendingMutations()).map((entry) => entry.handle.mutationId)).toEqual([replacement.mutationId])

    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-b',
      requestedWriterWasActive: true,
      onOwnershipChange,
    })
    expect(onOwnershipChange).toHaveBeenCalledOnce()
  })

  it('deletes an exact no-op row without creating receipt cleanup work', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('no-op'))
    await expect(handle.ready).resolves.toBe('persisted')
    await expect(acknowledgePendingMutation(handle)).resolves.toBe('deleted')
    expect(await listPendingMutations()).toEqual([])
    expect(await listPendingMutationReceiptAcknowledgements()).toEqual([])
  })

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

  it('cannot persist an old-scope row after a newer scope finishes quarantine cleanup', async () => {
    const encryptionGate = deferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementationOnce(async (algorithm, key, data) => {
        await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })
    const old = stagePendingMutation('settings:old-scope-race', settingsIntent('old'))
    await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalled())

    await preparePendingMutationOutbox({
      writerSessionId: 'writer-b',
      writerEpoch: 2,
      databaseLineage: 'database-b',
      requestedWriterWasActive: true,
    })
    encryptionGate.resolve()

    await expect(old.ready).resolves.toBe('superseded')
    expect(await readRawMutation(old.mutationId)).toBeUndefined()
    expect(await listPendingMutations()).toEqual([])
  })

  it('rejects persisted base revisions and command paths outside the autosave allowlist', () => {
    expect(() =>
      stagePendingMutation('settings:runtime', {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/runtime',
            body: { baseRevision: 4, patch: { maxContext: 8_000 } },
          },
        ],
      }),
    ).toThrow('must not persist a base revision')

    expect(() =>
      stagePendingMutation('unsafe', {
        version: 1,
        requests: [{ method: 'POST', path: '/messages/translate', body: { text: 'side effect' } }],
      }),
    ).toThrow('not allowlisted')
  })

  it.each([
    ['POST', '/model-presets'],
    ['PATCH', '/model-presets/model-a'],
    ['DELETE', '/model-presets/model-a'],
    ['POST', '/model-presets/select'],
    ['POST', '/model-profiles'],
    ['PATCH', '/model-profiles/profile-a'],
    ['DELETE', '/model-profiles/profile-a'],
    ['POST', '/model-profiles/profile-a/duplicate'],
    ['POST', '/model-profiles/convert-legacy'],
    ['POST', '/model-profiles/reorder'],
    ['PUT', '/model-role-profiles'],
    ['PUT', '/model-runtime-defaults'],
    ['POST', '/agents'],
    ['PATCH', '/agents/agent-a'],
    ['DELETE', '/agents/agent-a'],
    ['POST', '/agents/agent-a/duplicate'],
    ['POST', '/agents/reorder'],
    ['POST', '/agent-presets'],
    ['PATCH', '/agent-presets/preset-a'],
    ['DELETE', '/agent-presets/preset-a'],
    ['POST', '/agent-presets/preset-a/duplicate'],
    ['POST', '/agent-presets/reorder'],
    ['POST', '/agent-presets/default'],
    ['POST', '/agent-presets/preset-a/uses'],
    ['PATCH', '/agent-presets/preset-a/uses/use-a'],
    ['DELETE', '/agent-presets/preset-a/uses/use-a'],
    ['POST', '/agent-presets/preset-a/uses/reorder'],
    ['POST', '/agent-presets/preset-a/steps'],
    ['PATCH', '/agent-presets/preset-a/steps/step-a'],
    ['DELETE', '/agent-presets/preset-a/steps/step-a'],
    ['POST', '/agent-presets/preset-a/steps/step-a/duplicate'],
    ['POST', '/agent-presets/preset-a/steps/reorder'],
    ['POST', '/prompt-presets'],
    ['PATCH', '/prompt-presets/prompt-a'],
    ['DELETE', '/prompt-presets/prompt-a'],
    ['POST', '/prompt-presets/select'],
    ['POST', '/prompt-presets/reorder'],
    ['POST', '/presets'],
    ['PATCH', '/presets/preset-a'],
    ['DELETE', '/presets/preset-a'],
    ['POST', '/presets/preset-a/copy'],
    ['POST', '/presets/select'],
    ['POST', '/presets/reorder'],
    ['POST', '/model-presets/reorder'],
    ['POST', '/legacy-bot-presets/preset-a/extract'],
    ['POST', '/prompt-items'],
    ['POST', '/prompt-items/reorder'],
    ['DELETE', '/prompt-items/item-a'],
    ['POST', '/prompt-items/enable'],
    ['DELETE', '/personas/persona-a'],
    ['POST', '/personas'],
    ['POST', '/personas/select'],
    ['POST', '/personas/reorder'],
    ['POST', '/translator-presets'],
    ['PATCH', '/translator-presets/translator-a'],
    ['DELETE', '/translator-presets/translator-a'],
    ['POST', '/translator-presets/select'],
    ['POST', '/characters'],
    ['POST', '/characters/create-and-select'],
    ['PATCH', '/characters/character-a/alternate-greetings'],
    ['DELETE', '/characters/character-a'],
    ['POST', '/characters/select'],
    ['POST', '/characters/character-a/chats'],
    ['PUT', '/characters/character-a/chats'],
    ['POST', '/characters/character-a/chats/reorder'],
    ['POST', '/characters/character-a/chat-folders'],
    ['POST', '/characters/character-a/chat-folders/reorder'],
    ['POST', '/characters/character-a/modules/reorder'],
    ['PATCH', '/chats/chat-a'],
    ['PATCH', '/chats/chat-a/scriptstate'],
    ['POST', '/chats/chat-a/fork'],
    ['POST', '/chats/chat-a/messages'],
    ['POST', '/chats/chat-a/messages/truncate'],
    ['POST', '/chats/chat-a/messages/tail'],
    ['PUT', '/chats/chat-a/messages'],
    ['PATCH', '/messages/message-a'],
    ['DELETE', '/messages/message-a'],
    ['DELETE', '/chat-folders/folder-a'],
    ['POST', '/modules'],
    ['PATCH', '/modules/module-a'],
    ['DELETE', '/modules/module-a'],
    ['POST', '/modules/enable'],
    ['POST', '/modules/reorder'],
    ['POST', '/module-folders'],
    ['PATCH', '/module-folders/folder-a'],
    ['DELETE', '/module-folders/folder-a'],
    ['POST', '/module-folders/reorder'],
    ['POST', '/plugins'],
    ['PATCH', '/plugins/plugin-a'],
    ['DELETE', '/plugins/plugin-a'],
    ['POST', '/plugins/plugin-a/enable'],
    ['POST', '/plugins/provider'],
    ['POST', '/plugins/reorder'],
    ['PUT', '/plugin-storage/key-a'],
    ['DELETE', '/plugin-storage/key-a'],
    ['POST', '/plugin-storage/bulk'],
    ['POST', '/loadouts'],
    ['DELETE', '/loadouts/loadout-a'],
    ['POST', '/loadouts/loadout-a/favorite'],
    ['POST', '/loadouts/loadout-a/touch'],
    ['PUT', '/chats/chat-a/generation-settings'],
    ['DELETE', '/chats/chat-a'],
    ['PATCH', '/settings/advanced/global-scripts'],
    ['PUT', '/characters/character-a/scripts'],
    ['PATCH', '/characters/character-a/triggers'],
    ['PUT', '/modules/module-a/scripts'],
    ['PATCH', '/modules/module-a/triggers'],
    ['POST', '/lorebooks'],
    ['POST', '/lorebooks/reorder'],
    ['PATCH', '/lorebooks/lorebook-a'],
    ['DELETE', '/lorebooks/lorebook-a'],
    ['POST', '/lorebooks/lorebook-a/select'],
    ['PUT', '/lorebooks/lorebook-a/entries'],
    ['PUT', '/lorebooks/lorebook-a/entries/entry-a'],
    ['DELETE', '/lorebooks/lorebook-a/entries/entry-a'],
    ['POST', '/lorebooks/lorebook-a/entries/reorder'],
    ['PUT', '/characters/character-a/lorebooks'],
    ['PUT', '/chats/chat-a/lorebooks/entries/entry-a'],
    ['DELETE', '/modules/module-a/lorebooks/entries/entry-a'],
    ['POST', '/chats/chat-a/lorebooks/entries/reorder'],
    ['PATCH', '/bardwiki/chats/chat-a/settings'],
    ['POST', '/bardwiki/chats/chat-a/documents'],
    ['PATCH', '/bardwiki/chats/chat-a/documents/document-a'],
    ['DELETE', '/bardwiki/chats/chat-a/documents/document-a'],
    ['POST', '/bardwiki/chats/chat-a/confirmations'],
  ] as const)('allowlists the durable bridge route %s %s', async (method, path) => {
    const handle = stagePendingMutation(`allowlist:${method}:${path}`, {
      version: 1,
      requests: [{ method, path, body: { patch: { value: true } } }],
    })

    await expect(handle.ready).resolves.toBe('persisted')
    await expect(discardPendingMutation(handle)).resolves.toBe('deleted')
  })

  it.each(['full', 'missing'] as const)('persists and restores a confirmed %s BardWiki rebuild', async (policy) => {
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/bardwiki/chats/chat-a/rebuilds',
          body: { preview: false, confirm: true, policy, expectedSourceCount: 4 },
        },
      ],
    }

    const handle = stagePendingMutation('bardwiki-rebuild:chat-a', intent)

    await expect(handle.ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]?.intent).toEqual(intent)
    await expect(discardPendingMutation(handle)).resolves.toBe('deleted')
  })

  it('keeps similar nested resource routes outside the durable allowlist', () => {
    expect(() =>
      stagePendingMutation('unsafe-nested-route', {
        version: 1,
        requests: [
          {
            method: 'POST',
            path: '/characters/character-a/scripts/reorder',
            body: { scriptIds: ['script-a'] },
          },
        ],
      }),
    ).toThrow('not allowlisted')
  })

  it.each([
    ['POST', '/prompt-items/item-a'],
    ['POST', '/prompt-items/enable/extra'],
    ['POST', '/prompt-items/reorder/extra'],
    ['POST', '/presets/select/extra'],
    ['POST', '/presets/reorder/extra'],
    ['POST', '/presets/preset-a/copy/extra'],
    ['PATCH', '/presets/preset-a/extra'],
    ['POST', '/model-presets/select/extra'],
    ['POST', '/model-presets/reorder/extra'],
    ['POST', '/model-profiles/profile-a'],
    ['PUT', '/model-profiles/profile-a'],
    ['POST', '/model-profiles/convert-legacy/extra'],
    ['PUT', '/model-role-profiles/extra'],
    ['PUT', '/model-runtime-defaults/extra'],
    ['PUT', '/agents'],
    ['POST', '/agents/agent-a'],
    ['PATCH', '/agents/reorder'],
    ['POST', '/agents/reorder/extra'],
    ['PATCH', '/agents/agent-a/duplicate'],
    ['PUT', '/agent-presets/preset-a/uses'],
    ['PATCH', '/agent-presets/preset-a/uses'],
    ['POST', '/agent-presets/preset-a/uses/use-a'],
    ['DELETE', '/agent-presets/preset-a/uses/reorder'],
    ['PUT', '/agent-presets'],
    ['POST', '/agent-presets/preset-a'],
    ['PATCH', '/agent-presets/preset-a/duplicate'],
    ['POST', '/agent-presets/default/extra'],
    ['POST', '/agent-presets/preset-a/steps/reorder/extra'],
    ['PATCH', '/agent-presets/preset-a/steps'],
    ['POST', '/prompt-presets/select/extra'],
    ['POST', '/prompt-presets/reorder/extra'],
    ['POST', '/legacy-bot-presets/preset-a/extract/extra'],
    ['DELETE', '/presets/preset-a/extra'],
    ['POST', '/modules/module-a'],
    ['PATCH', '/modules'],
    ['POST', '/modules/enable/extra'],
    ['POST', '/module-folders/folder-a'],
    ['PATCH', '/module-folders'],
    ['POST', '/module-folders/reorder/extra'],
    ['PATCH', '/loadouts/loadout-a'],
    ['DELETE', '/loadouts'],
    ['POST', '/loadouts/loadout-a'],
    ['POST', '/loadouts/loadout-a/favorite/extra'],
    ['POST', '/loadouts/loadout-a/touch/extra'],
    ['POST', '/personas/select/extra'],
    ['POST', '/translator-presets/select/extra'],
    ['POST', '/characters/create-and-select/extra'],
    ['PATCH', '/characters/character-a/alternate-greetings/extra'],
    ['POST', '/characters/character-a'],
    ['POST', '/characters/character-a/chats/extra'],
    ['POST', '/characters/character-a/chats/reorder/extra'],
    ['POST', '/characters/character-a/chat-folders/extra'],
    ['POST', '/characters/character-a/chat-folders/reorder/extra'],
    ['POST', '/characters/character-a/modules/reorder/extra'],
    ['PATCH', '/chats/chat-a/scriptstate/extra'],
    ['POST', '/chats/chat-a/fork/extra'],
    ['POST', '/chats/chat-a/messages/extra'],
    ['POST', '/chats/chat-a/messages/truncate/extra'],
    ['POST', '/chats/chat-a/messages/tail/extra'],
    ['PUT', '/chats/chat-a/messages/extra'],
    ['POST', '/messages/message-a/translate'],
    ['POST', '/chats/chat-a/generation-result'],
    ['POST', '/lorebooks/lorebook-a'],
    ['POST', '/lorebooks/reorder/extra'],
    ['PATCH', '/lorebooks'],
    ['POST', '/lorebooks/lorebook-a/select/extra'],
    ['DELETE', '/personas/persona-a/extra'],
    ['DELETE', '/lorebooks/lorebook-a/entries'],
  ] as const)('rejects the near-miss durable route %s %s', (method, path) => {
    expect(() =>
      stagePendingMutation(`near-miss:${method}:${path}`, {
        version: 1,
        requests: [{ method, path, body: { value: true } }],
      }),
    ).toThrow('not allowlisted')
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function stubCryptoWithoutSubtle(): void {
  const cryptoApi = globalThis.crypto
  vi.stubGlobal('crypto', {
    getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi),
    randomUUID: cryptoApi.randomUUID.bind(cryptoApi),
  })
}

async function readRawMutation(mutationId: string): Promise<Record<string, unknown> | undefined> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction('mutations', 'readonly')
    return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = transaction.objectStore('mutations').get(mutationId)
      request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

async function readRawOrderCounters(): Promise<Array<Record<string, unknown>>> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readonly')
    const counters = await rawRequestResult<Array<Record<string, unknown>>>(transaction.objectStore('orders').getAll())
    await rawTransactionDone(transaction)
    return counters
  } finally {
    database.close()
  }
}

async function deleteRawOrderCounters(): Promise<void> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readwrite')
    transaction.objectStore('orders').clear()
    await rawTransactionDone(transaction)
  } finally {
    database.close()
  }
}

async function mutateRawOrderCounter(
  mutate: (counter: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('orders', 'readwrite')
    const store = transaction.objectStore('orders')
    const [keys, counters] = await Promise.all([
      rawRequestResult<IDBValidKey[]>(store.getAllKeys()),
      rawRequestResult<Array<Record<string, unknown>>>(store.getAll()),
    ])
    if (keys.length !== 1 || counters.length !== 1) throw new Error('Expected one pending-mutation order counter')
    store.put(mutate(counters[0]!), keys[0])
    await rawTransactionDone(transaction)
  } finally {
    database.close()
  }
}

async function removeRawKeyKind(mutationId: string): Promise<void> {
  const database = await openRawOutboxDatabase()
  try {
    const transaction = database.transaction('mutations', 'readwrite')
    const store = transaction.objectStore('mutations')
    const record = await rawRequestResult<Record<string, unknown>>(store.get(mutationId))
    delete record.keyKind
    store.put(record)
    await rawTransactionDone(transaction)
  } finally {
    database.close()
  }
}

function openRawOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function rawRequestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function rawTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function removeRawDispatchStarted(mutationId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction('mutations', 'readwrite')
    const store = transaction.objectStore('mutations')
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get(mutationId)
      request.onsuccess = () => resolve(request.result as Record<string, unknown>)
      request.onerror = () => reject(request.error)
    })
    delete record.dispatchStarted
    store.put(record)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

async function corruptRawMutationCiphertext(mutationId: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('risu-pending-mutations-v1', 3)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const transaction = database.transaction('mutations', 'readwrite')
    const store = transaction.objectStore('mutations')
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get(mutationId)
      request.onsuccess = () => resolve(request.result as Record<string, unknown>)
      request.onerror = () => reject(request.error)
    })
    record.ciphertext = new ArrayBuffer(1)
    store.put(record)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}
