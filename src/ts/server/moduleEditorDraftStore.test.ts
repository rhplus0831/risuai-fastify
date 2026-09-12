import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initializeDraftRecoveryScope, resetDraftRecoveryScopeForTests } from './draftRecoveryScope'
import {
  MODULE_EDITOR_DRAFT_MAX_RECORD_BYTES,
  MODULE_EDITOR_DRAFT_MAX_RECORDS,
  MODULE_EDITOR_DRAFT_MAX_AGE_MS,
  clearModuleEditorDraftStoreForTests,
  deleteModuleEditorDraft,
  isModuleEditorDraftGenerationCurrent,
  readLatestModuleEditorDraft,
  registerModuleEditorDraftStorageFailureListener,
  resetModuleEditorDraftStoreForTests,
  setModuleEditorDraftCommitHookForTests,
  writeModuleEditorDraft,
  type ModuleEditorDraftInput,
} from './moduleEditorDraftStore'

function createDraft(id = 'module-create'): ModuleEditorDraftInput {
  return {
    mode: 'create',
    moduleId: id,
    editBaseline: null,
    tempModule: {
      id,
      name: 'Recovered create',
      description: 'Costly draft',
      cjs: 'return "encrypted-code"',
      assets: [['asset-a', 'asset-reference']] as any,
      lorebook: [{ id: 'lore-a', key: 'key', content: 'nested lore' }] as any,
      regex: [{ id: 'regex-a', in: 'before', out: 'after' }] as any,
      trigger: [{ id: 'trigger-a', type: 'start', effect: [] }] as any,
    },
  }
}

function editDraft(name = 'Locally edited'): ModuleEditorDraftInput {
  const baseline = {
    id: 'module-edit',
    name: 'Baseline',
    description: 'Baseline description',
    lorebook: [{ id: 'lore-base', content: 'baseline lore' }],
  } as any
  return {
    mode: 'edit',
    moduleId: baseline.id,
    editBaseline: baseline,
    tempModule: {
      ...baseline,
      name,
      lorebook: [{ id: 'lore-local', content: 'local lore' }],
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetDraftRecoveryScopeForTests()
  resetModuleEditorDraftStoreForTests()
  initializeDraftRecoveryScope({ databaseLineage: 'database-a', writerSessionId: 'writer-a' })
})

afterEach(async () => {
  await clearModuleEditorDraftStoreForTests()
  resetModuleEditorDraftStoreForTests()
  resetDraftRecoveryScopeForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('encrypted module editor draft store', () => {
  it.each(['success', 'failure', 'scope-change'] as const)(
    'fences a late decrypt %s while a newer draft becomes durable',
    async (outcome) => {
      await writeModuleEditorDraft(editDraft('Older edit')).ready
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const decrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle)
      const held = vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
        const plaintext = await decrypt(...args)
        await gate
        if (outcome === 'failure') throw new Error('Old ciphertext failed authentication')
        return plaintext
      })
      const reading = readLatestModuleEditorDraft()
      await vi.waitFor(() => expect(held).toHaveBeenCalledOnce())
      if (outcome === 'scope-change')
        initializeDraftRecoveryScope({ databaseLineage: 'database-b', writerSessionId: 'writer-a' })
      const newer = writeModuleEditorDraft(editDraft('Newer edit'))
      await expect(newer.ready).resolves.toBe('persisted')
      release()
      await expect(reading).resolves.toBeNull()
      await expect(isModuleEditorDraftGenerationCurrent(newer.generation)).resolves.toBe(true)
      await expect(readLatestModuleEditorDraft()).resolves.toMatchObject({ tempModule: { name: 'Newer edit' } })
    },
  )

  it('roundtrips create and edit drafts with nested code, collection, and asset-reference payloads', async () => {
    const create = createDraft()
    const createWrite = writeModuleEditorDraft(create)
    await expect(createWrite.ready).resolves.toBe('persisted')
    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject(create)

    const edit = editDraft()
    const editWrite = writeModuleEditorDraft(edit)
    await expect(editWrite.ready).resolves.toBe('persisted')
    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject(edit)
  })

  it('keeps module payload and baseline encrypted at rest in a database separate from the outbox', async () => {
    const input = editDraft('secret-local-module-name')
    const write = writeModuleEditorDraft(input)
    await write.ready

    const raw = await readRawModuleDrafts()
    expect(raw).toHaveLength(1)
    expect(JSON.stringify(raw)).not.toContain('secret-local-module-name')
    expect(JSON.stringify(raw)).not.toContain('Baseline description')
    expect(raw[0]).toMatchObject({
      surface: 'module-editor',
      databaseLineage: 'database-a',
      writerSessionId: 'writer-a',
      moduleId: 'module-edit',
    })
    expect(raw[0].ciphertext).toBeInstanceOf(ArrayBuffer)

    const outbox = await openDatabase('risu-pending-mutations-v1', 3)
    expect(outbox.objectStoreNames.contains('moduleDrafts')).toBe(false)
    outbox.close()
  })

  it('isolates another lineage and writer while retaining a dormant same-lineage writer draft', async () => {
    const write = writeModuleEditorDraft(createDraft())
    await write.ready

    initializeDraftRecoveryScope({ databaseLineage: 'database-a', writerSessionId: 'writer-b' })
    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
    expect(await readRawModuleDrafts()).toHaveLength(1)

    initializeDraftRecoveryScope({ databaseLineage: 'database-a', writerSessionId: 'writer-a' })
    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject({ moduleId: 'module-create' })

    initializeDraftRecoveryScope({ databaseLineage: 'database-b', writerSessionId: 'writer-a' })
    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
    expect(await readRawModuleDrafts()).toHaveLength(0)
  })

  it('keeps the stable create id across a fresh store runtime', async () => {
    const write = writeModuleEditorDraft(createDraft('stable-create-id'))
    await write.ready
    resetModuleEditorDraftStoreForTests()

    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject({
      mode: 'create',
      moduleId: 'stable-create-id',
      tempModule: { id: 'stable-create-id' },
    })
  })

  it('serializes captured writes and refuses to delete a newer generation with an older handle', async () => {
    const older = writeModuleEditorDraft(editDraft('Older edit'))
    const newer = writeModuleEditorDraft(editDraft('Newer edit'))

    await expect(newer.ready).resolves.toBe('persisted')
    await expect(older.ready).resolves.toBe('persisted')
    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject({
      tempModule: { name: 'Newer edit' },
    })
    await expect(deleteModuleEditorDraft(older.generation)).resolves.toBe(false)
    await expect(isModuleEditorDraftGenerationCurrent(newer.generation)).resolves.toBe(true)
    await expect(deleteModuleEditorDraft(newer.generation)).resolves.toBe(true)
    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
  })

  it('applies deterministic record-count cleanup', async () => {
    for (let index = 0; index <= MODULE_EDITOR_DRAFT_MAX_RECORDS; index += 1) {
      const write = writeModuleEditorDraft(createDraft(`module-${index}`))
      await expect(write.ready).resolves.toBe('persisted')
    }

    const raw = await readRawModuleDrafts()
    expect(raw).toHaveLength(MODULE_EDITOR_DRAFT_MAX_RECORDS)
    expect(raw.some((record) => record.moduleId === 'module-0')).toBe(false)
    expect(raw.some((record) => record.moduleId === `module-${MODULE_EDITOR_DRAFT_MAX_RECORDS}`)).toBe(true)
  })

  it('deletes expired records without trying to recover their payload', async () => {
    const write = writeModuleEditorDraft(createDraft())
    await write.ready
    await mutateRawModuleDraft((record) => ({
      ...record,
      updatedAt: Date.now() - MODULE_EDITOR_DRAFT_MAX_AGE_MS - 1,
    }))
    resetModuleEditorDraftStoreForTests()

    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
    expect(await readRawModuleDrafts()).toHaveLength(0)
  })

  it('rejects oversized drafts loudly without creating a row', async () => {
    const failure = vi.fn()
    const unregister = registerModuleEditorDraftStorageFailureListener(failure)
    const input = createDraft()
    input.tempModule.cjs = 'x'.repeat(MODULE_EDITOR_DRAFT_MAX_RECORD_BYTES)

    const write = writeModuleEditorDraft(input)

    await expect(write.ready).resolves.toBe('unavailable')
    expect(failure).toHaveBeenCalledOnce()
    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
    expect(await readRawModuleDrafts()).toHaveLength(0)
    unregister()
  })

  it('reports transaction/quota-style failures once and preserves the previous generation', async () => {
    const retained = writeModuleEditorDraft(editDraft('Retained edit'))
    await retained.ready
    const failure = vi.fn()
    const unregister = registerModuleEditorDraftStorageFailureListener(failure)
    setModuleEditorDraftCommitHookForTests((transaction) => transaction.abort())

    const failed = writeModuleEditorDraft(editDraft('Unavailable edit'))

    await expect(failed.ready).resolves.toBe('unavailable')
    expect(failure).toHaveBeenCalledOnce()
    await expect(readLatestModuleEditorDraft()).resolves.toMatchObject({
      tempModule: { name: 'Retained edit' },
    })
    unregister()
  })

  it('drops corrupt ciphertext loudly and returns no recovered draft', async () => {
    const write = writeModuleEditorDraft(createDraft())
    await write.ready
    await mutateRawModuleDraft((record) => ({ ...record, ciphertext: new Uint8Array([1, 2, 3]).buffer }))
    const failure = vi.fn()
    const unregister = registerModuleEditorDraftStorageFailureListener(failure)

    await expect(readLatestModuleEditorDraft()).resolves.toBeNull()
    expect(failure).toHaveBeenCalledOnce()
    expect(await readRawModuleDrafts()).toHaveLength(0)
    unregister()
  })
})

async function openDatabase(name = 'risu-recovery-drafts-v1', version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readRawModuleDrafts(): Promise<any[]> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction('moduleDrafts', 'readonly')
    return await requestResult<any[]>(transaction.objectStore('moduleDrafts').getAll())
  } finally {
    database.close()
  }
}

async function mutateRawModuleDraft(mutator: (record: any) => any): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction('moduleDrafts', 'readwrite')
    const store = transaction.objectStore('moduleDrafts')
    const records = await requestResult<any[]>(store.getAll())
    store.put(mutator(records[0]))
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
