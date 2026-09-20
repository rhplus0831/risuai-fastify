import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgePendingMutation,
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
  pendingMutationProjectionTargets,
  preparePendingMutationOutbox,
  readSinglePendingMutationOwner,
  replaceStagedPendingMutationIntent,
  resetPendingMutationOutboxForTests,
  setPendingMutationCommitTransactionHookForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from './pendingMutationOutbox'
import {
  PERSISTENCE_ACTIVITY_LINGER_MS,
  persistenceSavingState,
  resetPersistenceActivityForTests,
} from './persistenceActivity.svelte'
import {
  settingsIntent,
  deferred,
  stubCryptoWithoutSubtle,
  readRawMutation,
  readRawOrderCounters,
  deleteRawOrderCounters,
  mutateRawOrderCounter,
  removeRawKeyKind,
  removeRawDispatchStarted,
  corruptRawMutationCiphertext,
} from './pendingMutationOutbox.testSupport'

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

beforeEach(async () => {
  browserEvidence.entries = []
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

const coreIt = (name: string, fn: () => void | Promise<void>): void => it(name, { tags: 'core' }, fn)

describe('pending mutation outbox persistence', () => {
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
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(1)
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

  it('retains encrypted Retry controls without blocking hydration, while ordinary edits still block', async () => {
    const intent: DurableMutationIntent = {
      version: 1,
      kind: 'generation-operation-retry',
      requests: [
        {
          method: 'POST',
          path: '/generation-operations/11111111-1111-4111-8111-111111111111/retries',
          body: { retryRequestId: '22222222-2222-4222-8222-222222222222', expectedStateVersion: 3 },
        },
      ],
    }
    const handle = stagePendingMutation('generation-operation-retry:operation-a', intent)
    await expect(handle.ready).resolves.toBe('persisted')
    expect((await listPendingMutations())[0]?.intent).toEqual(intent)
    await expect(countPendingMutationRecords()).resolves.toBe(1)
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(0)

    const edit = stagePendingMutation('settings:first', settingsIntent('first'))
    await expect(edit.ready).resolves.toBe('persisted')
    await expect(countPendingMutationRecords()).resolves.toBe(2)
    await expect(countBlockingPendingMutationRecords()).resolves.toBe(1)
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
    await expect(countBlockingPendingMutationRecords()).resolves.toBeNull()
  })

  coreIt('persists encrypted intents across runtime cache resets without plaintext secrets at rest', async () => {
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
})

describe('pending mutation outbox ordering and replacement', () => {
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

  coreIt('rolls back both the counter and row when the final transaction aborts', async () => {
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

  coreIt('atomically replaces an unstarted staged payload under a fresh mutation id', async () => {
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
})

describe('pending mutation outbox ownership recovery', () => {
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

  coreIt('quarantines another writer session and lets each owner reclaim only its own rows', async () => {
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

  coreIt('deletes rows and receipt ACKs belonging to a different database lineage', async () => {
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
})

describe('pending mutation outbox receipts', () => {
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

  it('deletes an exact no-op row without creating receipt cleanup work', async () => {
    const handle = stagePendingMutation('settings:runtime', settingsIntent('no-op'))
    await expect(handle.ready).resolves.toBe('persisted')
    await expect(acknowledgePendingMutation(handle)).resolves.toBe('deleted')
    expect(await listPendingMutations()).toEqual([])
    expect(await listPendingMutationReceiptAcknowledgements()).toEqual([])
  })
})
