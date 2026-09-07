import { gcm } from '@noble/ciphers/aes.js'
import { writable } from 'svelte/store'
import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  getClientSessionSnapshot,
  isClientSessionGenerationCurrent,
  registerClientWriterLossHandler,
} from '../clientSession'
import { draftRecoveryScopesEqual, readDraftRecoveryScope, type DraftRecoveryScope } from './draftRecoveryScope'

export interface WriterDraftCapture {
  key: string
  label: string
  route?: string
  fields: Array<{ label: string; value: string; secret?: boolean }>
  data?: unknown
  baseline?: unknown
}

export interface WriterDraftRecord extends WriterDraftCapture {
  readonly scope: DraftRecoveryScope
  readonly generation: string
  readonly updatedAt: number
}

export interface WriterDraftRecoveryState {
  readonly drafts: readonly WriterDraftRecord[]
  readonly storageFailed: boolean
  readonly loading: boolean
}

export const WRITER_DRAFT_MAX_RECORDS = 40
export const WRITER_DRAFT_MAX_RECORD_BYTES = 16 * 1024 * 1024
export const WRITER_DRAFT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const WRITER_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const DATABASE_NAME = 'risu-writer-recovery-drafts-v1'
const RECORD_STORE = 'drafts'
const KEY_STORE = 'keys'
const SCOPE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/

type EncryptionKey = { kind: 'subtle'; key: CryptoKey } | { kind: 'raw'; key: Uint8Array<ArrayBuffer> }
interface StoredDraft extends DraftRecoveryScope {
  version: 1
  generation: string
  updatedAt: number
  plaintextBytes: number
  keyKind: EncryptionKey['kind']
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}
interface MemoryDraft {
  record: WriterDraftRecord
  persisted: boolean
}

const memory = new Map<string, MemoryDraft>()
const failures = new Set<string>()
const registrations = new Set<() => void>()
const captureCallbacks = new Set<() => void>()
let pagehideTarget: Window | null = null
const encryptionKeys = new Map<EncryptionKey['kind'], Promise<EncryptionKey>>()
const state = writable<WriterDraftRecoveryState>({ drafts: [], storageFailed: false, loading: false })
export const writerDraftRecoveryStore = { subscribe: state.subscribe }

let databasePromise: Promise<IDBDatabase> | null = null
let storageTail: Promise<void> = Promise.resolve()
let viewScope: DraftRecoveryScope | null = null
let viewRevision = 0
let loading = false
let lastUpdatedAt = 0
let memoryGeneration = 0

/** Scope initialization is authenticated bootstrap evidence on the conservative path. */
function authenticatedScope(): DraftRecoveryScope | null {
  const scope = readDraftRecoveryScope()
  if (!scope) return null
  const session = getClientSessionSnapshot()
  if (
    session.managed &&
    (!session.authenticated ||
      session.lifecycle === 'auth-required' ||
      session.databaseLineage !== scope.databaseLineage ||
      session.sessionId !== scope.writerSessionId)
  )
    return null
  return { ...scope }
}

function scopeKey(scope: DraftRecoveryScope): string {
  return JSON.stringify([scope.databaseLineage, scope.writerSessionId])
}

function memoryKey(scope: DraftRecoveryScope, key: string): string {
  return JSON.stringify([scope.databaseLineage, scope.writerSessionId, key])
}

function scopeIsVisible(scope: DraftRecoveryScope): boolean {
  const current = authenticatedScope()
  return current !== null && draftRecoveryScopesEqual(scope, current)
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    // Mounted Svelte state may be a proxy. Copy its enumerable values without
    // retaining reactive references in the recovery record.
    return decodeSnapshot(encodeSnapshot(value)) as T
  }
}

function publish(): void {
  if (!viewScope || !scopeIsVisible(viewScope)) {
    state.set({ drafts: [], storageFailed: false, loading: false })
    return
  }
  const scope = viewScope
  state.set({
    drafts: [...memory.values()]
      .filter(({ record }) => draftRecoveryScopesEqual(record.scope, scope))
      .map(({ record }) => clone(record))
      .sort(newestFirst),
    storageFailed: failures.has(scopeKey(scope)),
    loading,
  })
}

function fail(scope: DraftRecoveryScope, showCurrentScope = false): void {
  if (showCurrentScope && scopeIsVisible(scope)) viewScope = { ...scope }
  failures.add(scopeKey(scope))
  publish()
}

let observedSessionGeneration = captureClientSessionGeneration()
clientSessionStore.subscribe((session) => {
  if (viewScope && !scopeIsVisible(viewScope)) {
    clearWriterDraftRecoveryView()
  } else if (observedSessionGeneration !== session.generation) {
    viewRevision += 1
    loading = false
    publish()
  }
  observedSessionGeneration = session.generation
})

/**
 * The core calls this handler after revocation and before publishing the role.
 * Keep the last authenticated writer scope so auth loss also preserves edits,
 * without exposing them in the unauthenticated view.
 */
export function registerWriterDraftCapture(capture: () => WriterDraftCapture | null): () => void {
  let origin = canUseClientWriteAccess() ? authenticatedScope() : null
  const stopScope = clientSessionStore.subscribe(() => {
    if (canUseClientWriteAccess()) origin = authenticatedScope()
  })
  const captureCurrent = () => {
    if (!origin) return
    const scope = { ...origin }
    try {
      const input = capture()
      if (!input) return
      const snapshot = normalizeCapture({
        key: input.key,
        label: input.label,
        ...(input.route === undefined ? {} : { route: input.route }),
        fields: input.fields.map((field) => ({
          label: field.label,
          value: field.value,
          ...(field.secret === undefined ? {} : { secret: field.secret }),
        })),
      })
      let complete = true
      for (const key of ['data', 'baseline'] as const) {
        if (!Object.hasOwn(input, key)) continue
        try {
          snapshot[key] = clone(input[key])
        } catch {
          complete = false
        }
      }
      const record: WriterDraftRecord = {
        ...snapshot,
        scope,
        generation: nextGeneration(),
        updatedAt: (lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1)),
      }
      // This must finish synchronously, even when persistence is unavailable.
      memory.set(memoryKey(scope, record.key), { record, persisted: false })
      viewRevision += 1
      loading = false
      if (scopeIsVisible(scope)) viewScope = scope
      publish()
      if (complete) void serialized(() => persistDraft(record)).catch(() => fail(scope))
      else fail(scope, true)
    } catch {
      fail(scope, true)
    }
  }
  const stopCapture = registerClientWriterLossHandler(captureCurrent)
  captureCallbacks.add(captureCurrent)
  installPagehideCapture()
  const unregister = () => {
    captureCallbacks.delete(captureCurrent)
    stopCapture()
    stopScope()
    registrations.delete(unregister)
  }
  registrations.add(unregister)
  return unregister
}

/** Capture current mounted writer fields before a controlled reload, then flush. */
export async function captureWriterDraftsForReload(): Promise<void> {
  if (canUseClientWriteAccess()) {
    for (const capture of [...captureCallbacks]) capture()
  }
  await storageTail
}

function installPagehideCapture(): void {
  if (typeof window === 'undefined' || pagehideTarget === window) return
  pagehideTarget?.removeEventListener('pagehide', captureOnPagehide)
  pagehideTarget = window
  pagehideTarget.addEventListener('pagehide', captureOnPagehide)
}

function captureOnPagehide(): void {
  // Page exit does not guarantee asynchronous IDB completion. Controlled
  // reloads await captureWriterDraftsForReload; abrupt termination cannot.
  void captureWriterDraftsForReload()
}

export function readWriterDraft(key: string): WriterDraftRecord | null {
  if (!viewScope || !scopeIsVisible(viewScope)) return null
  const draft = memory.get(memoryKey(viewScope, key))
  return draft ? clone(draft.record) : null
}

/** Load only this authenticated origin's recovery view; never apply it to resources. */
export async function loadWriterDrafts(): Promise<void> {
  const scope = authenticatedScope()
  if (!scope) {
    clearWriterDraftRecoveryView()
    return
  }
  const revision = ++viewRevision
  const sessionGeneration = captureClientSessionGeneration()
  const current = () =>
    revision === viewRevision && isClientSessionGenerationCurrent(sessionGeneration) && scopeIsVisible(scope)
  viewScope = scope
  loading = true
  publish()
  try {
    await serialized(async () => {
      const database = await openDatabase()
      const stored = await readRows(database)
      const { records, corrupt } = await decodeScope(stored, scope)
      if (!current()) return
      if (corrupt) failures.add(scopeKey(scope))
      for (const record of records) {
        const key = memoryKey(scope, record.key)
        const existing = memory.get(key)
        if (!existing || (existing.persisted && newestFirst(record, existing.record) < 0))
          memory.set(key, { record, persisted: true })
        lastUpdatedAt = Math.max(lastUpdatedAt, record.updatedAt)
      }
      // Expiry only removes successfully persisted recovery data, never fresh
      // captures whose failed save is the user's sole remaining copy.
      for (const [key, draft] of memory) {
        if (draft.persisted && expired(draft.record.updatedAt)) memory.delete(key)
      }
      await pruneRows(database)
    })
  } catch {
    if (current()) failures.add(scopeKey(scope))
  } finally {
    if (current()) {
      loading = false
      publish()
    }
  }
}

/** An old confirmation can never discard a newer capture for the same editor. */
export async function discardWriterDraft(generation: string): Promise<boolean> {
  const scope = authenticatedScope()
  if (!scope || !viewScope || !draftRecoveryScopesEqual(scope, viewScope)) return false
  const candidate = [...memory.values()].find(
    ({ record }) => record.generation === generation && draftRecoveryScopesEqual(record.scope, scope),
  )
  if (!candidate) return false
  const key = memoryKey(scope, candidate.record.key)
  const sessionGeneration = captureClientSessionGeneration()
  const revision = ++viewRevision
  const current = () =>
    revision === viewRevision &&
    viewScope !== null &&
    draftRecoveryScopesEqual(viewScope, scope) &&
    scopeIsVisible(scope) &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    memory.get(key)?.record.generation === generation
  loading = false
  publish()
  try {
    return await serialized(async () => {
      if (!current()) return false
      const database = await openDatabase()
      const { records, corrupt } = await decodeScope(await readRows(database), scope)
      if (corrupt) fail(scope)
      const matches = records.filter((record) => record.key === candidate.record.key).sort(newestFirst)
      if (!current() || (matches[0] && newestFirst(matches[0], candidate.record) < 0)) return false
      const transaction = database.transaction(RECORD_STORE, 'readwrite')
      const done = transactionDone(transaction)
      const store = transaction.objectStore(RECORD_STORE)
      // Generation is the immutable primary key, so a later insertion cannot
      // be deleted by this already-running exact-generation transaction.
      for (const record of matches) store.delete(record.generation)
      await done
      if (current()) {
        memory.delete(key)
        publish()
      }
      return true
    })
  } catch {
    fail(scope)
    return false
  }
}

/** Hide credentials on auth/scope changes without disposing originating drafts. */
export function clearWriterDraftRecoveryView(): void {
  viewRevision += 1
  viewScope = null
  loading = false
  publish()
}

function nextGeneration(): string {
  try {
    if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness unavailable')
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {}
  // Identity is still needed to retain an unsavable in-memory capture. This
  // fallback is never used as encryption randomness or persisted without an IV.
  return `memory-${Date.now()}-${++memoryGeneration}`
}

function normalizeCapture(value: unknown): WriterDraftCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid writer draft')
  const record = value as WriterDraftCapture
  if (
    typeof record.key !== 'string' ||
    !record.key ||
    typeof record.label !== 'string' ||
    (record.route !== undefined && typeof record.route !== 'string') ||
    !Array.isArray(record.fields) ||
    !record.fields.every(
      (field) =>
        field &&
        typeof field.label === 'string' &&
        typeof field.value === 'string' &&
        (field.secret === undefined || typeof field.secret === 'boolean'),
    )
  )
    throw new TypeError('Invalid writer draft fields')
  return {
    key: record.key,
    label: record.label,
    ...(record.route === undefined ? {} : { route: record.route }),
    fields: record.fields.map((field) => ({ ...field })),
    ...(Object.hasOwn(record, 'data') ? { data: record.data } : {}),
    ...(Object.hasOwn(record, 'baseline') ? { baseline: record.baseline } : {}),
  }
}

async function persistDraft(record: WriterDraftRecord): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(record.generation)) throw new Error('Draft capture has no secure generation identity')
  const plaintext = encodeSnapshot(normalizeCapture(record))
  if (plaintext.byteLength > WRITER_DRAFT_MAX_RECORD_BYTES) throw new RangeError('Writer draft is too large')
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable')
  const database = await openDatabase()
  const encryptionKey = await getEncryptionKey(globalThis.crypto.subtle ? 'subtle' : 'raw')
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const metadata: StoredDraft = {
    ...record.scope,
    version: 1,
    generation: record.generation,
    updatedAt: record.updatedAt,
    plaintextBytes: plaintext.byteLength,
    keyKind: encryptionKey.kind,
    iv: iv.buffer,
    ciphertext: new ArrayBuffer(0),
  }
  const additionalData = authenticatedMetadata(metadata)
  metadata.ciphertext =
    encryptionKey.kind === 'subtle'
      ? await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, encryptionKey.key, plaintext)
      : toArrayBuffer(gcm(encryptionKey.key, iv, additionalData).encrypt(plaintext))
  const { records } = await decodeScope(await readRows(database), record.scope)
  const previous = records.filter((candidate) => candidate.key === record.key)
  if (previous.some((candidate) => newestFirst(candidate, record) < 0)) {
    // A clock change or another tab must not make the latest local capture
    // appear durably saved when its timestamp lost the storage comparison.
    if (memory.get(memoryKey(record.scope, record.key))?.record.generation === record.generation) fail(record.scope)
    return
  }
  const transaction = database.transaction(RECORD_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(RECORD_STORE)
  store.put(metadata)
  for (const candidate of previous) store.delete(candidate.generation)
  await done
  const current = memory.get(memoryKey(record.scope, record.key))
  if (current?.record.generation === record.generation) current.persisted = true
  await pruneRows(database)
}

async function decodeScope(
  rows: unknown[],
  scope: DraftRecoveryScope,
): Promise<{ records: WriterDraftRecord[]; corrupt: boolean }> {
  const records: WriterDraftRecord[] = []
  let corrupt = false
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const candidate = row as StoredDraft
    if (!draftRecoveryScopesEqual(candidate, scope)) continue
    if (!validMetadata(candidate)) {
      corrupt = true
      continue
    }
    if (expired(candidate.updatedAt)) continue
    try {
      const key = await getEncryptionKey(candidate.keyKind)
      const iv = new Uint8Array(candidate.iv)
      const additionalData = authenticatedMetadata(candidate)
      const plaintext =
        key.kind === 'subtle'
          ? new Uint8Array(
              await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key.key, candidate.ciphertext),
            )
          : gcm(key.key, iv, additionalData).decrypt(new Uint8Array(candidate.ciphertext))
      if (plaintext.byteLength !== candidate.plaintextBytes) throw new Error('Invalid writer draft size')
      const capture = normalizeCapture(decodeSnapshot(plaintext))
      records.push({
        ...capture,
        scope: { ...scope },
        generation: candidate.generation,
        updatedAt: candidate.updatedAt,
      })
    } catch {
      corrupt = true
    }
  }
  return { records, corrupt }
}

function validMetadata(row: StoredDraft): boolean {
  return (
    row.version === 1 &&
    typeof row.generation === 'string' &&
    /^[a-f0-9]{32}$/.test(row.generation) &&
    typeof row.databaseLineage === 'string' &&
    typeof row.writerSessionId === 'string' &&
    SCOPE_VALUE.test(row.databaseLineage) &&
    SCOPE_VALUE.test(row.writerSessionId) &&
    Number.isSafeInteger(row.updatedAt) &&
    row.updatedAt > 0 &&
    Number.isSafeInteger(row.plaintextBytes) &&
    row.plaintextBytes > 0 &&
    row.plaintextBytes <= WRITER_DRAFT_MAX_RECORD_BYTES &&
    (row.keyKind === 'subtle' || row.keyKind === 'raw') &&
    row.iv instanceof ArrayBuffer &&
    row.iv.byteLength === 12 &&
    row.ciphertext instanceof ArrayBuffer &&
    row.ciphertext.byteLength === row.plaintextBytes + 16
  )
}

function authenticatedMetadata(row: StoredDraft): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      'writer-draft',
      row.version,
      row.databaseLineage,
      row.writerSessionId,
      row.generation,
      row.updatedAt,
      row.plaintextBytes,
      row.keyKind,
    ]),
  )
}

function newestFirst(
  left: Pick<WriterDraftRecord, 'updatedAt' | 'generation'>,
  right: Pick<WriterDraftRecord, 'updatedAt' | 'generation'>,
): number {
  return right.updatedAt - left.updatedAt || right.generation.localeCompare(left.generation)
}

function expired(updatedAt: number): boolean {
  return Date.now() - updatedAt > WRITER_DRAFT_MAX_AGE_MS
}

async function pruneRows(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(RECORD_STORE, 'readwrite')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(RECORD_STORE)
  const rows = await requestResult<StoredDraft[]>(store.getAll())
  const retained = rows.filter((row) => validMetadata(row) && !expired(row.updatedAt)).sort(newestFirst)
  const keep = new Set<string>()
  let bytes = 0
  for (const row of retained) {
    if (keep.size >= WRITER_DRAFT_MAX_RECORDS || bytes + row.plaintextBytes > WRITER_DRAFT_MAX_TOTAL_BYTES) continue
    bytes += row.plaintextBytes
    keep.add(row.generation)
  }
  for (const row of rows) if (!keep.has(row.generation)) store.delete(row.generation)
  await done
  for (const [key, draft] of memory) {
    if (draft.persisted && !keep.has(draft.record.generation)) memory.delete(key)
  }
  publish()
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const execute = (): Promise<T> => {
    const locks = globalThis.navigator?.locks
    if (!locks) return task()
    return new Promise<T>((resolve, reject) => {
      void locks
        .request('risu:writer-recovery-drafts', { mode: 'exclusive' }, async () => {
          try {
            resolve(await task())
          } catch (error) {
            reject(error)
          }
        })
        .catch(reject)
    })
  }
  const pending = storageTail.then(execute, execute)
  storageTail = pending.then(
    () => undefined,
    () => undefined,
  )
  return pending
}

async function readRows(database: IDBDatabase): Promise<StoredDraft[]> {
  const transaction = database.transaction(RECORD_STORE, 'readonly')
  const [rows] = await Promise.all([
    requestResult<StoredDraft[]>(transaction.objectStore(RECORD_STORE).getAll()),
    transactionDone(transaction),
  ])
  return rows
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable'))
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore(RECORD_STORE, { keyPath: 'generation' })
      database.createObjectStore(KEY_STORE)
    }
    request.onsuccess = () => {
      const database = request.result
      if (blocked) {
        database.close()
        return
      }
      database.onversionchange = () => {
        database.close()
        if (databasePromise === opening) databasePromise = null
        encryptionKeys.clear()
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('Writer draft database failed'))
    request.onblocked = () => {
      blocked = true
      reject(new Error('Writer draft database is blocked'))
    }
  })
  databasePromise = opening
  void opening.catch(() => {
    if (databasePromise === opening) databasePromise = null
  })
  return opening
}

function getEncryptionKey(kind: EncryptionKey['kind']): Promise<EncryptionKey> {
  const existing = encryptionKeys.get(kind)
  if (existing) return existing
  const pending = loadEncryptionKey(kind)
  encryptionKeys.set(kind, pending)
  void pending.catch(() => {
    if (encryptionKeys.get(kind) === pending) encryptionKeys.delete(kind)
  })
  return pending
}

async function loadEncryptionKey(kind: EncryptionKey['kind']): Promise<EncryptionKey> {
  if (kind === 'subtle' && !globalThis.crypto?.subtle) throw new Error('SubtleCrypto is unavailable')
  const database = await openDatabase()
  const keyId = `writer-draft-aes-gcm-${kind}-v1`
  const read = async () => {
    const transaction = database.transaction(KEY_STORE, 'readonly')
    const [value] = await Promise.all([
      requestResult<unknown>(transaction.objectStore(KEY_STORE).get(keyId)),
      transactionDone(transaction),
    ])
    return value
  }
  const existing = await read()
  if (existing !== undefined) return normalizeKey(kind, existing)
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable')
  const generated =
    kind === 'subtle'
      ? await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      : crypto.getRandomValues(new Uint8Array(32))
  try {
    const transaction = database.transaction(KEY_STORE, 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(KEY_STORE).add(generated, keyId)
    await done
    return normalizeKey(kind, generated)
  } catch (error) {
    if ((error as { name?: unknown })?.name !== 'ConstraintError') throw error
    return normalizeKey(kind, await read())
  }
}

function normalizeKey(kind: EncryptionKey['kind'], value: unknown): EncryptionKey {
  if (kind === 'subtle') {
    const key = value as CryptoKey | undefined
    if (
      key?.type === 'secret' &&
      key.extractable === false &&
      key.algorithm?.name === 'AES-GCM' &&
      (key.algorithm as AesKeyAlgorithm).length === 256 &&
      key.usages.includes('encrypt') &&
      key.usages.includes('decrypt')
    )
      return { kind, key }
  } else if ((value instanceof Uint8Array || value instanceof ArrayBuffer) && value.byteLength === 32) {
    return { kind, key: new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value) }
  }
  throw new Error('Invalid writer draft encryption key')
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Writer draft request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  const pending = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Writer draft transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Writer draft transaction failed'))
  })
  void pending.catch(() => undefined)
  return pending
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

// A small tagged graph keeps structured form snapshots (including undefined,
// binary data, Maps/Sets and cycles) reversible without executable serialization.
type WireValue =
  | null
  | boolean
  | number
  | string
  | { ref: number }
  | { scalar: 'undefined' | 'number' | 'bigint'; value?: string }
interface WireNode {
  kind: 'object' | 'array' | 'date' | 'map' | 'set' | 'bytes' | 'regexp'
  entries?: [string, WireValue][]
  values?: WireValue[]
  pairs?: [WireValue, WireValue][]
  bytes?: number[]
  name?: string
  value?: number | string | null
  flags?: string
  nullPrototype?: boolean
}

function encodeSnapshot(input: unknown): Uint8Array<ArrayBuffer> {
  const nodes: WireNode[] = []
  const seen = new Map<object, number>()
  const visit = (value: unknown): WireValue => {
    if (value === null) return null
    if (typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') return Number.isFinite(value) ? value : { scalar: 'number', value: String(value) }
    if (typeof value === 'undefined') return { scalar: 'undefined' }
    if (typeof value === 'bigint') return { scalar: 'bigint', value: String(value) }
    if (typeof value !== 'object') throw new TypeError('Draft contains an unsupported value')
    const previous = seen.get(value)
    if (previous !== undefined) return { ref: previous }
    const index = nodes.length
    seen.set(value, index)
    nodes.push({ kind: 'object' })
    let node: WireNode
    if (value instanceof Date) node = { kind: 'date', value: Number.isFinite(value.getTime()) ? value.getTime() : null }
    else if (value instanceof Map)
      node = { kind: 'map', pairs: [...value].map(([key, entry]) => [visit(key), visit(entry)]) }
    else if (value instanceof Set) node = { kind: 'set', values: [...value].map(visit) }
    else if (value instanceof RegExp) node = { kind: 'regexp', value: value.source, flags: value.flags }
    else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      node = { kind: 'bytes', name: value.constructor.name, bytes: [...bytes] }
    } else {
      const prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Draft contains an unsupported object')
      node = {
        kind: Array.isArray(value) ? 'array' : 'object',
        ...(Array.isArray(value) ? { value: value.length } : { nullPrototype: prototype === null }),
        entries: Object.entries(value).map(([key, entry]) => [key, visit(entry)]),
      }
    }
    nodes[index] = node
    return { ref: index }
  }
  const root = visit(input)
  return new TextEncoder().encode(JSON.stringify({ root, nodes }))
}

function decodeSnapshot(bytes: Uint8Array): unknown {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as { root: WireValue; nodes: WireNode[] }
  if (!Array.isArray(wire.nodes)) throw new TypeError('Invalid draft encoding')
  const values: unknown[] = wire.nodes.map((node) => {
    switch (node.kind) {
      case 'object':
        return node.nullPrototype ? Object.create(null) : {}
      case 'array':
        return new Array(node.value as number)
      case 'date':
        return new Date(node.value === null ? NaN : (node.value as number))
      case 'map':
        return new Map()
      case 'set':
        return new Set()
      case 'regexp':
        return new RegExp(node.value as string, node.flags)
      case 'bytes': {
        if (
          !Array.isArray(node.bytes) ||
          !node.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
        )
          throw new TypeError('Invalid draft bytes')
        const buffer = new Uint8Array(node.bytes).buffer
        switch (node.name) {
          case 'ArrayBuffer':
            return buffer
          case 'DataView':
            return new DataView(buffer)
          case 'Int8Array':
            return new Int8Array(buffer)
          case 'Uint8Array':
          case 'Buffer':
            return new Uint8Array(buffer)
          case 'Uint8ClampedArray':
            return new Uint8ClampedArray(buffer)
          case 'Int16Array':
            return new Int16Array(buffer)
          case 'Uint16Array':
            return new Uint16Array(buffer)
          case 'Int32Array':
            return new Int32Array(buffer)
          case 'Uint32Array':
            return new Uint32Array(buffer)
          case 'Float32Array':
            return new Float32Array(buffer)
          case 'Float64Array':
            return new Float64Array(buffer)
          case 'BigInt64Array':
            return new BigInt64Array(buffer)
          case 'BigUint64Array':
            return new BigUint64Array(buffer)
          default:
            throw new TypeError('Invalid draft binary type')
        }
      }
      default:
        throw new TypeError('Invalid draft object type')
    }
  })
  const visit = (value: WireValue): unknown => {
    if (value === null || typeof value !== 'object') return value
    if ('ref' in value) {
      if (!Number.isInteger(value.ref) || value.ref < 0 || value.ref >= values.length)
        throw new TypeError('Invalid draft reference')
      return values[value.ref]
    }
    if (value.scalar === 'undefined') return undefined
    if (value.scalar === 'number' && ['NaN', 'Infinity', '-Infinity', '-0'].includes(value.value!))
      return Number(value.value)
    if (value.scalar === 'bigint') return BigInt(value.value!)
    throw new TypeError('Invalid draft scalar')
  }
  wire.nodes.forEach((node, index) => {
    const target = values[index]
    if (node.kind === 'map')
      for (const [key, value] of node.pairs!) (target as Map<unknown, unknown>).set(visit(key), visit(value))
    else if (node.kind === 'set') for (const value of node.values!) (target as Set<unknown>).add(visit(value))
    else if (node.kind === 'object' || node.kind === 'array') {
      for (const [key, value] of node.entries!)
        Object.defineProperty(target, key, {
          value: visit(value),
          enumerable: true,
          configurable: true,
          writable: true,
        })
    }
  })
  return visit(wire.root)
}

export async function flushWriterDraftRecoveryForTests(): Promise<void> {
  await storageTail
}

export async function resetWriterDraftRecoveryForTests(): Promise<void> {
  await storageTail
  for (const unregister of [...registrations]) unregister()
  pagehideTarget?.removeEventListener('pagehide', captureOnPagehide)
  pagehideTarget = null
  const database = await databasePromise?.catch(() => null)
  database?.close()
  databasePromise = null
  encryptionKeys.clear()
  memory.clear()
  failures.clear()
  lastUpdatedAt = 0
  memoryGeneration = 0
  clearWriterDraftRecoveryView()
}
