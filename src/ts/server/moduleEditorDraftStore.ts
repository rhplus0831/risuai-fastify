import { gcm } from '@noble/ciphers/aes.js'

import {
  canUseClientReadServices,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import type { RisuModule } from '../process/modules'
import { isCurrentDraftRecoveryScope, readDraftRecoveryScope, type DraftRecoveryScope } from './draftRecoveryScope'

export type ModuleEditorDraftMode = 'create' | 'edit'
export type ModuleEditorDraftPersistenceStatus = 'persisted' | 'superseded' | 'unavailable'

export interface ModuleEditorDraftInput {
  mode: ModuleEditorDraftMode
  moduleId: string
  editBaseline: RisuModule | null
  tempModule: RisuModule
}

export interface ModuleEditorDraftGeneration extends DraftRecoveryScope {
  readonly key: string
  readonly mode: ModuleEditorDraftMode
  readonly moduleId: string
  readonly sequence: number
  readonly updatedAt: number
}

export interface ModuleEditorDraftWriteHandle {
  readonly generation: ModuleEditorDraftGeneration | null
  readonly ready: Promise<ModuleEditorDraftPersistenceStatus>
}

export interface RecoveredModuleEditorDraft extends ModuleEditorDraftInput {
  generation: ModuleEditorDraftGeneration
  updatedAt: number
}

type DraftEncryptionKey = { keyKind: 'raw'; key: Uint8Array<ArrayBuffer> } | { keyKind: 'subtle'; key: CryptoKey }
type DraftKeyKind = DraftEncryptionKey['keyKind']

interface StoredModuleEditorDraft extends DraftRecoveryScope {
  key: string
  version: 1
  surface: 'module-editor'
  mode: ModuleEditorDraftMode
  moduleId: string
  sequence: number
  updatedAt: number
  plaintextBytes: number
  keyKind: DraftKeyKind
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

interface EncryptedModuleEditorDraftPayload {
  version: 1
  baseline: RisuModule | null
  payload: {
    mode: ModuleEditorDraftMode
    moduleId: string
    tempModule: RisuModule
  }
}

export const MODULE_EDITOR_DRAFT_MAX_RECORDS = 20
export const MODULE_EDITOR_DRAFT_MAX_RECORD_BYTES = 16 * 1024 * 1024
export const MODULE_EDITOR_DRAFT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const MODULE_EDITOR_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const DRAFT_DATABASE_NAME = 'risu-recovery-drafts-v1'
const DRAFT_DATABASE_VERSION = 1
const DRAFT_STORE = 'moduleDrafts'
const DRAFT_KEY_STORE = 'keys'
const DRAFT_SUBTLE_KEY_ID = 'module-draft-aes-gcm-v1'
const DRAFT_RAW_KEY_ID = 'module-draft-aes-gcm-raw-v1'
const MAX_MODULE_ID_LENGTH = 2_048

let draftDatabasePromise: Promise<IDBDatabase | null> | null = null
let draftRawKeyPromise: Promise<DraftEncryptionKey | null> | null = null
let draftSubtleKeyPromise: Promise<DraftEncryptionKey | null> | null = null
let nextDraftSequence = 0
let lastDraftUpdatedAt = 0
let draftStorageFailureReported = false
let moduleDraftCommitHookForTests: ((transaction: IDBTransaction) => void) | null = null
const draftStorageFailureListeners = new Set<() => void>()
const localDraftLockTails = new Map<string, Promise<void>>()

/** Capture scope, owner ids, baseline, payload, sequence, and timestamp before the first async operation. */
export function writeModuleEditorDraft(input: ModuleEditorDraftInput): ModuleEditorDraftWriteHandle {
  const scope = readDraftRecoveryScope()
  let snapshot: ModuleEditorDraftInput
  try {
    snapshot = normalizeModuleEditorDraftInput(cloneJsonValue(input))
  } catch {
    reportModuleEditorDraftStorageFailure()
    return { generation: null, ready: Promise.resolve('unavailable') }
  }
  if (!scope) {
    reportModuleEditorDraftStorageFailure()
    return { generation: null, ready: Promise.resolve('unavailable') }
  }

  const updatedAt = nextModuleDraftUpdatedAt()
  const sequence = nextModuleDraftSequence()
  const key = moduleEditorDraftKey(scope, snapshot.mode, snapshot.moduleId)
  const generation: ModuleEditorDraftGeneration = {
    key,
    databaseLineage: scope.databaseLineage,
    writerSessionId: scope.writerSessionId,
    mode: snapshot.mode,
    moduleId: snapshot.moduleId,
    sequence,
    updatedAt,
  }
  const ready = withModuleDraftLock(scope, key, () => persistModuleEditorDraft(snapshot, generation)).catch(() => {
    reportModuleEditorDraftStorageFailure()
    return 'unavailable' as const
  })
  return { generation, ready }
}

export async function readLatestModuleEditorDraft(): Promise<RecoveredModuleEditorDraft | null> {
  const scope = readDraftRecoveryScope()
  if (!scope || !canUseClientReadServices()) return null
  const sessionGeneration = captureClientSessionGeneration()
  const current = () =>
    isCurrentDraftRecoveryScope(scope) &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    canUseClientReadServices()
  const database = await openModuleDraftDatabase()
  if (!database || !current()) return null

  let records: unknown[]
  try {
    const transaction = database.transaction(DRAFT_STORE, 'readonly')
    records = await requestResult<unknown[]>(transaction.objectStore(DRAFT_STORE).getAll())
    await transactionDone(transaction)
  } catch {
    reportModuleEditorDraftStorageFailure()
    return null
  }

  if (!current()) return null
  const now = Date.now()
  const invalidKeys = new Set<string>()
  const candidates: StoredModuleEditorDraft[] = []
  for (const record of records) {
    if (!isStoredModuleEditorDraftMetadata(record)) {
      const key = unknownStoredDraftKey(record)
      if (key) invalidKeys.add(key)
      continue
    }
    if (now - record.updatedAt > MODULE_EDITOR_DRAFT_MAX_AGE_MS || record.databaseLineage !== scope.databaseLineage) {
      invalidKeys.add(record.key)
      continue
    }
    if (record.writerSessionId !== scope.writerSessionId) continue
    candidates.push(record)
    nextDraftSequence = Math.max(nextDraftSequence, record.sequence)
    lastDraftUpdatedAt = Math.max(lastDraftUpdatedAt, record.updatedAt)
  }
  if (invalidKeys.size > 0) await deleteModuleDraftKeys(database, invalidKeys, records, current)
  candidates.sort(compareStoredModuleDraftNewestFirst)

  for (const record of candidates) {
    if (!current()) return null
    try {
      const payload = await decryptModuleEditorDraft(record)
      const normalized = normalizeEncryptedModuleEditorDraft(payload, record)
      if (
        !current() ||
        !(await isModuleEditorDraftGenerationCurrent(generationFromStoredModuleDraft(record))) ||
        !current()
      )
        return null
      return {
        ...normalized,
        generation: generationFromStoredModuleDraft(record),
        updatedAt: record.updatedAt,
      }
    } catch {
      if (!current()) return null
      // Corrupt snapshot A must not remove a valid replacement B at the same key.
      await deleteModuleDraftKeys(database, new Set([record.key]), [record], current)
      if (!current()) return null
      reportModuleEditorDraftStorageFailure()
    }
  }
  return null
}

export async function deleteModuleEditorDraft(generation: ModuleEditorDraftGeneration | null): Promise<boolean> {
  if (!generation) return false
  return withModuleDraftLock(generation, generation.key, async () => {
    const database = await openModuleDraftDatabase()
    if (!database) {
      reportModuleEditorDraftStorageFailure()
      return false
    }
    try {
      const transaction = database.transaction(DRAFT_STORE, 'readwrite')
      const store = transaction.objectStore(DRAFT_STORE)
      const current = await requestResult<StoredModuleEditorDraft | undefined>(store.get(generation.key))
      if (!storedModuleDraftMatchesGeneration(current, generation)) {
        await transactionDone(transaction)
        return false
      }
      store.delete(generation.key)
      await transactionDone(transaction)
      return true
    } catch {
      reportModuleEditorDraftStorageFailure()
      return false
    }
  })
}

export async function isModuleEditorDraftGenerationCurrent(
  generation: ModuleEditorDraftGeneration | null,
): Promise<boolean> {
  if (!generation) return false
  const database = await openModuleDraftDatabase()
  if (!database) return false
  try {
    const transaction = database.transaction(DRAFT_STORE, 'readonly')
    const current = await requestResult<StoredModuleEditorDraft | undefined>(
      transaction.objectStore(DRAFT_STORE).get(generation.key),
    )
    await transactionDone(transaction)
    return storedModuleDraftMatchesGeneration(current, generation)
  } catch {
    reportModuleEditorDraftStorageFailure()
    return false
  }
}

export function registerModuleEditorDraftStorageFailureListener(listener: () => void): () => void {
  draftStorageFailureListeners.add(listener)
  if (draftStorageFailureReported) listener()
  return () => draftStorageFailureListeners.delete(listener)
}

export async function clearModuleEditorDraftStoreForTests(): Promise<void> {
  const database = await openModuleDraftDatabase()
  if (!database) return
  const transaction = database.transaction(DRAFT_STORE, 'readwrite')
  transaction.objectStore(DRAFT_STORE).clear()
  await transactionDone(transaction)
}

export function resetModuleEditorDraftStoreForTests(): void {
  draftDatabasePromise = null
  draftRawKeyPromise = null
  draftSubtleKeyPromise = null
  nextDraftSequence = 0
  lastDraftUpdatedAt = 0
  draftStorageFailureReported = false
  moduleDraftCommitHookForTests = null
  localDraftLockTails.clear()
}

export function setModuleEditorDraftCommitHookForTests(hook: ((transaction: IDBTransaction) => void) | null): void {
  moduleDraftCommitHookForTests = hook
}

async function persistModuleEditorDraft(
  input: ModuleEditorDraftInput,
  generation: ModuleEditorDraftGeneration,
): Promise<ModuleEditorDraftPersistenceStatus> {
  if (!isCurrentDraftRecoveryScope(generation)) return 'superseded'
  try {
    const plaintext = serializeModuleEditorDraft(input)
    if (plaintext.byteLength > MODULE_EDITOR_DRAFT_MAX_RECORD_BYTES) {
      throw new RangeError('Module editor recovery draft is too large')
    }
    const [database, encryptionKey] = await Promise.all([openModuleDraftDatabase(), getModuleDraftEncryptionKey()])
    if (!database || !encryptionKey) throw new Error('Encrypted module draft storage is unavailable')
    const iv = globalThis.crypto?.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
    if (!iv) throw new Error('Secure random generation is unavailable')
    const metadata: StoredModuleEditorDraft = {
      ...generation,
      version: 1,
      surface: 'module-editor',
      plaintextBytes: plaintext.byteLength,
      keyKind: encryptionKey.keyKind,
      iv: iv.buffer,
      ciphertext: new ArrayBuffer(0),
    }
    metadata.ciphertext = await encryptModuleDraft(encryptionKey, iv, moduleDraftAdditionalData(metadata), plaintext)
    if (!isCurrentDraftRecoveryScope(generation)) return 'superseded'

    const transaction = database.transaction(DRAFT_STORE, 'readwrite')
    const store = transaction.objectStore(DRAFT_STORE)
    const current = await requestResult<StoredModuleEditorDraft | undefined>(store.get(generation.key))
    if (storedModuleDraftIsNewer(current, generation) || !isCurrentDraftRecoveryScope(generation)) {
      await transactionDone(transaction)
      return 'superseded'
    }
    store.put(metadata)
    moduleDraftCommitHookForTests?.(transaction)
    await transactionDone(transaction)
    await cleanupModuleEditorDraftStore(database, generation)
    return 'persisted'
  } catch {
    reportModuleEditorDraftStorageFailure()
    return 'unavailable'
  }
}

async function cleanupModuleEditorDraftStore(
  database: IDBDatabase,
  currentGeneration: ModuleEditorDraftGeneration,
): Promise<void> {
  if (!isCurrentDraftRecoveryScope(currentGeneration)) return
  const readTransaction = database.transaction(DRAFT_STORE, 'readonly')
  const records = await requestResult<unknown[]>(readTransaction.objectStore(DRAFT_STORE).getAll())
  await transactionDone(readTransaction)
  const now = Date.now()
  const deleteKeys = new Set<string>()
  const scoped = records
    .filter((record): record is StoredModuleEditorDraft => {
      if (!isStoredModuleEditorDraftMetadata(record)) {
        const key = unknownStoredDraftKey(record)
        if (key) deleteKeys.add(key)
        return false
      }
      if (
        now - record.updatedAt > MODULE_EDITOR_DRAFT_MAX_AGE_MS ||
        record.databaseLineage !== currentGeneration.databaseLineage
      ) {
        deleteKeys.add(record.key)
        return false
      }
      return record.databaseLineage === currentGeneration.databaseLineage
    })
    .sort(compareStoredModuleDraftOldestFirst)
  let totalBytes = scoped.reduce((total, record) => total + record.plaintextBytes, 0)
  while (scoped.length > MODULE_EDITOR_DRAFT_MAX_RECORDS || totalBytes > MODULE_EDITOR_DRAFT_MAX_TOTAL_BYTES) {
    const oldest = scoped.shift()
    if (!oldest) break
    deleteKeys.add(oldest.key)
    totalBytes -= oldest.plaintextBytes
  }
  if (deleteKeys.size > 0)
    await deleteModuleDraftKeys(database, deleteKeys, records, () => isCurrentDraftRecoveryScope(currentGeneration))
}

async function decryptModuleEditorDraft(record: StoredModuleEditorDraft): Promise<EncryptedModuleEditorDraftPayload> {
  const encryptionKey = await getModuleDraftEncryptionKey(record.keyKind)
  if (!encryptionKey) throw new Error('Module draft encryption key is unavailable')
  const iv = new Uint8Array(record.iv)
  const additionalData = moduleDraftAdditionalData(record)
  const plaintext =
    encryptionKey.keyKind === 'subtle'
      ? await decryptSubtleModuleDraft(encryptionKey.key, iv, additionalData, record.ciphertext)
      : uint8ArrayToArrayBuffer(gcm(encryptionKey.key, iv, additionalData).decrypt(new Uint8Array(record.ciphertext)))
  if (plaintext.byteLength !== record.plaintextBytes) throw new Error('Module draft plaintext size is invalid')
  return JSON.parse(new TextDecoder().decode(plaintext)) as EncryptedModuleEditorDraftPayload
}

function serializeModuleEditorDraft(input: ModuleEditorDraftInput): Uint8Array<ArrayBuffer> {
  const payload: EncryptedModuleEditorDraftPayload = {
    version: 1,
    baseline: input.editBaseline,
    payload: {
      mode: input.mode,
      moduleId: input.moduleId,
      tempModule: input.tempModule,
    },
  }
  return new TextEncoder().encode(JSON.stringify(payload))
}

function normalizeEncryptedModuleEditorDraft(
  value: unknown,
  metadata: StoredModuleEditorDraft,
): ModuleEditorDraftInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Module editor draft payload is invalid')
  }
  const record = value as Partial<EncryptedModuleEditorDraftPayload>
  if (record.version !== 1 || !record.payload || typeof record.payload !== 'object') {
    throw new TypeError('Module editor draft version is unsupported')
  }
  return normalizeModuleEditorDraftInput(
    {
      mode: record.payload.mode as ModuleEditorDraftMode,
      moduleId: record.payload.moduleId as string,
      editBaseline: record.baseline as RisuModule | null,
      tempModule: record.payload.tempModule as RisuModule,
    },
    metadata,
  )
}

function normalizeModuleEditorDraftInput(
  input: ModuleEditorDraftInput,
  metadata?: StoredModuleEditorDraft,
): ModuleEditorDraftInput {
  if (input.mode !== 'create' && input.mode !== 'edit') throw new TypeError('Module editor draft mode is invalid')
  if (
    typeof input.moduleId !== 'string' ||
    input.moduleId.length === 0 ||
    input.moduleId.length > MAX_MODULE_ID_LENGTH
  ) {
    throw new TypeError('Module editor draft owner is invalid')
  }
  if (!isRisuModuleDraft(input.tempModule) || input.tempModule.id !== input.moduleId) {
    throw new TypeError('Module editor draft module is invalid')
  }
  if (input.mode === 'edit') {
    if (!isRisuModuleDraft(input.editBaseline) || input.editBaseline.id !== input.moduleId) {
      throw new TypeError('Module editor draft baseline is invalid')
    }
  } else if (input.editBaseline !== null) {
    throw new TypeError('Create-module recovery drafts cannot have an edit baseline')
  }
  if (metadata && (metadata.mode !== input.mode || metadata.moduleId !== input.moduleId)) {
    throw new TypeError('Module editor draft metadata does not match its encrypted payload')
  }
  return cloneJsonValue(input)
}

function isRisuModuleDraft(value: unknown): value is RisuModule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.name === 'string'
}

function isStoredModuleEditorDraftMetadata(value: unknown): value is StoredModuleEditorDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<StoredModuleEditorDraft>
  return (
    record.version === 1 &&
    record.surface === 'module-editor' &&
    (record.mode === 'create' || record.mode === 'edit') &&
    typeof record.key === 'string' &&
    typeof record.databaseLineage === 'string' &&
    typeof record.writerSessionId === 'string' &&
    typeof record.moduleId === 'string' &&
    record.key === moduleEditorDraftKey(record as DraftRecoveryScope, record.mode, record.moduleId) &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence ?? 0) > 0 &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    Number.isSafeInteger(record.plaintextBytes) &&
    (record.plaintextBytes ?? 0) > 0 &&
    (record.plaintextBytes ?? 0) <= MODULE_EDITOR_DRAFT_MAX_RECORD_BYTES &&
    (record.keyKind === 'raw' || record.keyKind === 'subtle') &&
    record.iv instanceof ArrayBuffer &&
    record.iv.byteLength === 12 &&
    record.ciphertext instanceof ArrayBuffer &&
    record.ciphertext.byteLength > 0
  )
}

function unknownStoredDraftKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const key = (value as { key?: unknown }).key
  return typeof key === 'string' ? key : null
}

function storedModuleDraftMatchesGeneration(
  stored: StoredModuleEditorDraft | undefined,
  generation: ModuleEditorDraftGeneration,
): boolean {
  return Boolean(
    stored &&
    stored.key === generation.key &&
    stored.databaseLineage === generation.databaseLineage &&
    stored.writerSessionId === generation.writerSessionId &&
    stored.mode === generation.mode &&
    stored.moduleId === generation.moduleId &&
    stored.sequence === generation.sequence &&
    stored.updatedAt === generation.updatedAt,
  )
}

function storedModuleDraftIsNewer(
  stored: StoredModuleEditorDraft | undefined,
  generation: ModuleEditorDraftGeneration,
): boolean {
  if (!stored) return false
  return (
    stored.sequence > generation.sequence ||
    (stored.sequence === generation.sequence && stored.updatedAt >= generation.updatedAt)
  )
}

function generationFromStoredModuleDraft(record: StoredModuleEditorDraft): ModuleEditorDraftGeneration {
  return {
    key: record.key,
    databaseLineage: record.databaseLineage,
    writerSessionId: record.writerSessionId,
    mode: record.mode,
    moduleId: record.moduleId,
    sequence: record.sequence,
    updatedAt: record.updatedAt,
  }
}

function moduleEditorDraftKey(scope: DraftRecoveryScope, mode: ModuleEditorDraftMode, moduleId: string): string {
  return JSON.stringify(['module-editor-draft', 1, scope.databaseLineage, scope.writerSessionId, mode, moduleId])
}

function moduleDraftAdditionalData(record: StoredModuleEditorDraft): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      record.version,
      record.surface,
      record.databaseLineage,
      record.writerSessionId,
      record.mode,
      record.moduleId,
      record.sequence,
      record.updatedAt,
      record.plaintextBytes,
      record.keyKind,
    ]),
  )
}

function compareStoredModuleDraftOldestFirst(left: StoredModuleEditorDraft, right: StoredModuleEditorDraft): number {
  return left.updatedAt === right.updatedAt ? left.key.localeCompare(right.key) : left.updatedAt - right.updatedAt
}

function compareStoredModuleDraftNewestFirst(left: StoredModuleEditorDraft, right: StoredModuleEditorDraft): number {
  return -compareStoredModuleDraftOldestFirst(left, right)
}

function nextModuleDraftSequence(): number {
  if (nextDraftSequence >= Number.MAX_SAFE_INTEGER) nextDraftSequence = 0
  nextDraftSequence += 1
  return nextDraftSequence
}

function nextModuleDraftUpdatedAt(): number {
  lastDraftUpdatedAt = Math.max(Date.now(), lastDraftUpdatedAt + 1)
  return lastDraftUpdatedAt
}

async function withModuleDraftLock<T>(scope: DraftRecoveryScope, key: string, task: () => Promise<T>): Promise<T> {
  const name = `risu:module-editor-draft:${JSON.stringify([scope.databaseLineage, scope.writerSessionId, key])}`
  const lockManager = globalThis.navigator?.locks
  if (lockManager) return lockManager.request(name, { mode: 'exclusive' }, task)
  const previous = localDraftLockTails.get(name) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queuedTail = previous.then(() => tail)
  localDraftLockTails.set(name, queuedTail)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (localDraftLockTails.get(name) === queuedTail) localDraftLockTails.delete(name)
  }
}

function preferredModuleDraftKeyKind(): DraftKeyKind | null {
  if (globalThis.crypto?.subtle) return 'subtle'
  return globalThis.crypto?.getRandomValues ? 'raw' : null
}

async function getModuleDraftEncryptionKey(
  keyKind: DraftKeyKind | null = preferredModuleDraftKeyKind(),
): Promise<DraftEncryptionKey | null> {
  if (!keyKind || (keyKind === 'subtle' && !globalThis.crypto?.subtle)) return null
  if (keyKind === 'raw') {
    draftRawKeyPromise ??= loadOrCreateModuleDraftEncryptionKey('raw')
    return draftRawKeyPromise
  }
  draftSubtleKeyPromise ??= loadOrCreateModuleDraftEncryptionKey('subtle')
  return draftSubtleKeyPromise
}

async function loadOrCreateModuleDraftEncryptionKey(keyKind: DraftKeyKind): Promise<DraftEncryptionKey | null> {
  const database = await openModuleDraftDatabase()
  if (!database) return null
  const keyId = keyKind === 'subtle' ? DRAFT_SUBTLE_KEY_ID : DRAFT_RAW_KEY_ID
  try {
    const readTransaction = database.transaction(DRAFT_KEY_STORE, 'readonly')
    const existing = await requestResult<unknown>(readTransaction.objectStore(DRAFT_KEY_STORE).get(keyId))
    await transactionDone(readTransaction)
    const normalizedExisting = normalizeStoredModuleDraftKey(keyKind, existing)
    if (normalizedExisting) return normalizedExisting

    const generated =
      keyKind === 'subtle'
        ? await globalThis.crypto?.subtle?.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt', 'encrypt'])
        : globalThis.crypto?.getRandomValues(new Uint8Array(32))
    const normalizedGenerated = normalizeStoredModuleDraftKey(keyKind, generated)
    if (!normalizedGenerated) return null
    try {
      const createTransaction = database.transaction(DRAFT_KEY_STORE, 'readwrite')
      createTransaction.objectStore(DRAFT_KEY_STORE).add(generated, keyId)
      await transactionDone(createTransaction)
      return normalizedGenerated
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error
      const retryTransaction = database.transaction(DRAFT_KEY_STORE, 'readonly')
      const raced = await requestResult<unknown>(retryTransaction.objectStore(DRAFT_KEY_STORE).get(keyId))
      await transactionDone(retryTransaction)
      return normalizeStoredModuleDraftKey(keyKind, raced)
    }
  } catch {
    reportModuleEditorDraftStorageFailure()
    return null
  }
}

function normalizeStoredModuleDraftKey(keyKind: DraftKeyKind, value: unknown): DraftEncryptionKey | null {
  if (keyKind === 'subtle') {
    return value && typeof value === 'object' ? { keyKind, key: value as CryptoKey } : null
  }
  const key =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value.slice(0))
        : null
  return key?.byteLength === 32 ? { keyKind, key } : null
}

async function encryptModuleDraft(
  encryptionKey: DraftEncryptionKey,
  iv: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  if (encryptionKey.keyKind === 'subtle') {
    if (!globalThis.crypto?.subtle) throw new Error('Module draft encryption is unavailable')
    return globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey.key, plaintext)
  }
  return uint8ArrayToArrayBuffer(gcm(encryptionKey.key, iv, additionalData).encrypt(plaintext))
}

async function decryptSubtleModuleDraft(
  encryptionKey: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
  ciphertext: ArrayBuffer,
): Promise<ArrayBuffer> {
  if (!globalThis.crypto?.subtle) throw new Error('Module draft decryption is unavailable')
  return globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey, ciphertext)
}

async function openModuleDraftDatabase(): Promise<IDBDatabase | null> {
  if (typeof globalThis.indexedDB === 'undefined') {
    reportModuleEditorDraftStorageFailure()
    return null
  }
  if (draftDatabasePromise) return draftDatabasePromise
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open(DRAFT_DATABASE_NAME, DRAFT_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE, { keyPath: 'key' })
      }
      if (!database.objectStoreNames.contains(DRAFT_KEY_STORE)) database.createObjectStore(DRAFT_KEY_STORE)
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        if (draftDatabasePromise === opening) {
          draftDatabasePromise = null
          draftRawKeyPromise = null
          draftSubtleKeyPromise = null
        }
      }
      resolve(database)
    }
    request.onerror = () => {
      reportModuleEditorDraftStorageFailure()
      resolve(null)
    }
    request.onblocked = () => reportModuleEditorDraftStorageFailure()
  })
  draftDatabasePromise = opening
  return opening
}

/** Cleanup owns only the rows it inspected, never a newer draft at the same key. */
async function deleteModuleDraftKeys(
  database: IDBDatabase,
  keys: Set<string>,
  observed: unknown[],
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return
  try {
    const transaction = database.transaction(DRAFT_STORE, 'readwrite')
    const done = transactionDone(transaction)
    void done.catch(() => undefined)
    const store = transaction.objectStore(DRAFT_STORE)
    for (const key of keys) {
      const previous = observed.find((record) => unknownStoredDraftKey(record) === key)
      const current = await requestResult<unknown>(store.get(key))
      if (!isCurrent()) {
        transaction.abort()
        return
      }
      if (isStoredModuleEditorDraftMetadata(previous)) {
        if (
          !isStoredModuleEditorDraftMetadata(current) ||
          !storedModuleDraftMatchesGeneration(current, generationFromStoredModuleDraft(previous))
        )
          continue
      } else if (isStoredModuleEditorDraftMetadata(current)) continue
      store.delete(key)
    }
    await done
  } catch {
    if (isCurrent()) reportModuleEditorDraftStorageFailure()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function uint8ArrayToArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function reportModuleEditorDraftStorageFailure(): void {
  if (draftStorageFailureReported) return
  draftStorageFailureReported = true
  for (const listener of draftStorageFailureListeners) listener()
}
