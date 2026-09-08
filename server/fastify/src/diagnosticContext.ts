import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  isDiagnosticTransportUrl,
  projectDiagnosticEventV2,
  type DiagnosticEventV2,
} from '@risuai/protocol/remote-diagnostics'
import { readRequestTraceUid } from './requestTrace.js'

interface DiagnosticRegistration {
  owner?: object
  record(entry: DiagnosticEventV2, context?: DiagnosticContext): void
  /** Private authority check; raw lineage is never added to a diagnostic event. */
  history(): string
  key?: Uint8Array
}
interface RegisteredDiagnostics extends DiagnosticRegistration {
  key: Uint8Array
  active: boolean
}
export interface DiagnosticContext {
  readonly owner: object
  readonly requestUid?: string
  readonly operationRef?: string
  readonly attemptRef?: string
  readonly background: boolean
  readonly epoch: string
  readonly registration: RegisteredDiagnostics
}
export interface DiagnosticOperationReferences {
  databaseLineage?: string
  requestUid?: string
  operationId?: string
  attemptId?: string
  background?: boolean
}

const registrations = new WeakMap<object, RegisteredDiagnostics>()
const contexts = new AsyncLocalStorage<DiagnosticContext>()
const opaque = () => randomBytes(16).toString('hex')

export function registerDiagnosticDatabase(db: object, registration: DiagnosticRegistration): () => void {
  const value = { ...registration, key: registration.key ?? randomBytes(32), active: true }
  registrations.set(db, value)
  return () => {
    value.active = false
    if (registrations.get(db) === value) registrations.delete(db)
  }
}

export function getDiagnosticContext(): DiagnosticContext | undefined {
  return contexts.getStore()
}
export function diagnosticsContextEnabled(): boolean {
  const context = contexts.getStore()
  if (!context) return false
  try {
    return context.registration.active && context.epoch === context.registration.history()
  } catch {
    return false
  }
}

function reference(registration: RegisteredDiagnostics, epoch: string, kind: string, id: string): string {
  // A secret-keyed private mapping yields stable opaque references after restart.
  // Neither the key, raw domain identity, nor mapping inputs reach the collector.
  return createHmac('sha256', registration.key)
    .update(JSON.stringify([epoch, kind, id]))
    .digest('hex')
    .slice(0, 32)
}

function bindIterable<T>(value: T, context: DiagnosticContext): T {
  if (!value || typeof value !== 'object' || !(Symbol.asyncIterator in value)) return value
  const bind = (target: object): object =>
    new Proxy(target, {
      get(target, property) {
        const member = Reflect.get(target, property, target)
        if (property === Symbol.asyncIterator && typeof member === 'function') {
          return () => bind(contexts.run(context, () => member.call(target)))
        }
        if (['next', 'return', 'throw'].includes(String(property)) && typeof member === 'function') {
          return (...args: unknown[]) => contexts.run(context, () => member.apply(target, args))
        }
        return member
      },
    })
  return bind(value) as T
}

function runContext<T>(context: DiagnosticContext, callback: () => T): T {
  const result = contexts.run(context, callback)
  if (result instanceof Promise) return result.then((value) => bindIterable(value, context)) as T
  return bindIterable(result, context)
}

export function runWithDiagnosticContext<T>(db: object, refs: DiagnosticOperationReferences, callback: () => T): T {
  const registration = registrations.get(db)
  if (!registration) return contexts.exit(callback)
  let epoch: string
  try {
    epoch = registration.history()
  } catch {
    return contexts.exit(callback)
  }
  if (refs.databaseLineage !== undefined && refs.databaseLineage !== epoch) return contexts.exit(callback)
  const parent = contexts.getStore()
  const sameParent = parent?.registration === registration && parent.epoch === epoch
  const requestUid =
    refs.requestUid && /^[a-f0-9]{64}$/.test(refs.requestUid)
      ? refs.requestUid
      : sameParent
        ? parent.requestUid
        : undefined
  const context: DiagnosticContext = {
    registration,
    owner: registration.owner ?? db,
    epoch,
    background: refs.background ?? (sameParent ? parent.background : true),
    ...(requestUid ? { requestUid } : {}),
    get operationRef() {
      return refs.operationId
        ? reference(registration, epoch, 'operation', refs.operationId)
        : sameParent
          ? parent.operationRef
          : undefined
    },
    get attemptRef() {
      return refs.attemptId
        ? reference(registration, epoch, 'attempt', refs.attemptId)
        : sameParent
          ? parent.attemptRef
          : undefined
    },
  }
  return runContext(context, callback)
}

export function runWithDiagnosticAttempt<T>(callback: () => T): T {
  const parent = contexts.getStore()
  return parent
    ? runContext(
        {
          ...parent,
          get operationRef() {
            return parent.operationRef
          },
          attemptRef: opaque(),
        },
        callback,
      )
    : callback()
}

/** App-local producers create known facts; this function stamps trusted provenance. */
export function recordDiagnosticEvent(input: Record<string, unknown>): void {
  const context = contexts.getStore()
  if (!context) return
  try {
    const current = context.registration.active && context.epoch === context.registration.history()
    const entry = projectDiagnosticEventV2({
      ...input,
      timestamp: Date.now(),
      source: 'server',
      level: input.level ?? 'info',
      correlation: !current
        ? 'unavailable'
        : context.operationRef
          ? 'operation'
          : context.requestUid
            ? 'request'
            : 'background',
      requestUid: current ? context.requestUid : undefined,
      operationRef: current ? context.operationRef : undefined,
      attemptRef: current ? context.attemptRef : undefined,
    })
    // A task from replaced history may finish after reset. Omit its evidence
    // altogether rather than associating old operations with unrelated history.
    if (entry && current) context.registration.record(entry, context)
  } catch {
    /* No diagnostic failure may change the observed operation. */
  }
}

export function recordDiagnosticEventForDatabase(
  db: object,
  input: Record<string, unknown>,
  refs: DiagnosticOperationReferences = {},
): void {
  runWithDiagnosticContext(db, refs, () => recordDiagnosticEvent(input))
}

export function registerDiagnosticContextHooks(app: FastifyInstance, db: object): void {
  // Callback-form continuation propagates ALS through parsing, handlers,
  // detached promises and stream iteration without a process-global bypass.
  app.addHook('onRequest', (request, _reply, done) => {
    if (isDiagnosticTransportUrl(request.url)) {
      done()
      return
    }
    runWithDiagnosticContext(db, { requestUid: readRequestTraceUid(request), background: false }, done)
  })
}

/** Tiny private mapping key, excluded from domain stores/exports. Failure falls back to process-only references. */
export async function loadDiagnosticReferenceKey(directory: string): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await realpath(directory)) !== path.resolve(directory)) return undefined
    const file = path.join(directory, 'correlation.key')
    try {
      handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const key = randomBytes(32)
      await handle.writeFile(key)
      await handle.sync()
      return key
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) return undefined
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) return undefined
      const bytes = Buffer.alloc(33)
      const { bytesRead } = await handle.read(bytes, 0, 33, 0)
      return bytesRead === 32 ? bytes.subarray(0, 32) : undefined
    }
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
