import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { addAbortSignal } from 'node:stream'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { ActiveWriterState } from '../activeWriter.js'
import { readActiveWriterSessionId, requireActiveWriter } from '../activeWriter.js'
import type { AuthState } from '../auth.js'
import { requireAuth } from '../http.js'
import type { CommandEventOrigin, CommandEventSink } from '../commands/events.js'
import { COMMAND_EVENT_CATALOG } from '../commands/events.js'
import { TARGETED_MUTATION_PATHS, applyTargetedCommandMutation } from '../commands/mutations.js'
import { createModuleRecord, readStrictModuleRecords, validateStoredModuleRecord } from '../commands/modules.js'
import { RevisionMismatchError, ValidationError, writeSingleCollectionTable } from '../repository.js'
import { readJsonObject } from '../commands/characters.js'
import {
  CharacterPasswordInvalidError,
  CharacterPasswordRequiredError,
  importLocalCharacterFile,
  importLocalFileStream,
  importLocalModuleFile,
} from '../localFileImport.js'
import { LowLevelAccessImportError } from '../realmImport/characterCard.js'
import { appendRealmCharacter } from './realmImport.js'
import { importRateLimit } from '../routeRateLimits.js'
import { getMaintenanceCoordinator, MaintenanceBusyError, type MaintenanceLease } from '../maintenanceCoordinator.js'
import { attachMaintenanceAbort } from '../maintenanceRequest.js'
import type { LocalCharacterImportProgress, LocalFileImportResultFrame } from '@risuai/protocol/local-file-import'
import { getWritableBufferedBytes } from '../streamBackpressure.js'
import { setImmediate as yieldToIo } from 'node:timers/promises'

type ImportKind = 'character' | 'module'

interface ImportQuery {
  stream?: unknown
  baseRevision?: unknown
}

interface PendingImportBody {
  baseRevision?: unknown
  pendingImportToken?: unknown
  allowLowLevelAccess?: unknown
  password?: unknown
}

interface PendingLocalFileImport {
  kind: ImportKind
  fileName: string
  filePath: string
  tempDir: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_PENDING_IMPORT_TTL_MS = 10 * 60_000

export function registerLocalFileImportRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  activeWriterState: ActiveWriterState,
  options: {
    maxUploadBytes: number
    maxExpandedBytes?: number
    pendingImportTtlMs?: number
  },
): void {
  const pendingImports = new Map<string, PendingLocalFileImport>()
  const ttlMs = options.pendingImportTtlMs ?? DEFAULT_PENDING_IMPORT_TTL_MS

  app.addHook('onClose', async () => {
    const pending = [...pendingImports.values()]
    pendingImports.clear()
    await Promise.all(
      pending.map(async (entry) => {
        clearTimeout(entry.timer)
        await fs.promises.rm(entry.tempDir, { recursive: true, force: true }).catch(() => {})
      }),
    )
  })

  const requireImportAccess = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await requireAuth(authState, req, reply))) return
    requireActiveWriter(activeWriterState, req, reply)
  }

  app.post(
    '/api/v1/import/character-card',
    { config: { rateLimit: importRateLimit }, onRequest: requireImportAccess },
    async (req, reply) =>
      handleCharacterImportWithProgress({
        kind: 'character',
        req,
        reply,
        db,
        dataDir,
        eventSink,
        activeWriterState,
        pendingImports,
        ttlMs,
        options,
      }),
  )

  app.post(
    '/api/v1/import/module',
    { config: { rateLimit: importRateLimit }, onRequest: requireImportAccess },
    async (req, reply) =>
      handleLocalFileImport({
        kind: 'module',
        req,
        reply,
        db,
        dataDir,
        eventSink,
        activeWriterState,
        pendingImports,
        ttlMs,
        options,
      }),
  )
}

async function handleCharacterImportWithProgress(args: Parameters<typeof handleLocalFileImport>[0]): Promise<unknown> {
  if (!args.req.headers.accept?.includes('text/event-stream')) return handleLocalFileImport(args)

  const { reply } = args
  let streaming = false
  let lastPhase: LocalCharacterImportProgress['phase'] | undefined
  let lastSentAt = 0
  const reportProgress = (progress: LocalCharacterImportProgress) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) return
    if (!streaming) {
      streaming = true
      reply.hijack()
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value)
      }
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      })
    }
    const now = Date.now()
    const complete = progress.totalBytes !== undefined && progress.completedBytes === progress.totalBytes
    if (progress.phase === lastPhase && !complete && now - lastSentAt < 100) return
    // Progress is disposable: skip it for slow readers without delaying the import.
    if (getWritableBufferedBytes(reply.raw) > 64 * 1024) return
    reply.raw.write(`event: progress\ndata: ${JSON.stringify(progress)}\n\n`)
    lastPhase = progress.phase
    lastSentAt = now
  }
  const finish = (result: LocalFileImportResultFrame) => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end(`event: result\ndata: ${JSON.stringify(result)}\n\n`)
    }
  }
  try {
    const body = await handleLocalFileImport({ ...args, reportProgress })
    if (!streaming) return body
    finish({ statusCode: reply.statusCode, body })
  } catch (error) {
    if (!streaming) throw error
    args.req.log.error({ err: error }, 'Local character import failed')
    finish({ statusCode: 500, body: { error: 'Character import failed' } })
  }
  return reply
}

async function handleLocalFileImport(args: {
  kind: ImportKind
  req: FastifyRequest
  reply: FastifyReply
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  activeWriterState: ActiveWriterState
  pendingImports: Map<string, PendingLocalFileImport>
  ttlMs: number
  options: { maxUploadBytes: number; maxExpandedBytes?: number }
  reportProgress?: (progress: LocalCharacterImportProgress) => void
}): Promise<unknown> {
  const writerEpoch = args.activeWriterState.epoch
  const writerSession = args.activeWriterState.sessionId
  const writerIsCurrent = () =>
    args.activeWriterState.epoch === writerEpoch && args.activeWriterState.sessionId === writerSession
  const staleWriter = () => {
    if (pending) consumePendingImport(args.pendingImports, pending)
    args.reply.code(423)
    return {
      error: 'active_writer_stale',
      reason: 'A newer browser session is now the active writer. Reload this session before saving.',
    }
  }
  let pending: PendingLocalFileImport | null = null
  let ownsUpload = false
  const requestAbort = attachMaintenanceAbort(args.req, args.reply)
  const coordinator = getMaintenanceCoordinator(args.dataDir)
  const intakeSignal = AbortSignal.any([requestAbort.signal, coordinator.shutdownSignal])
  let lease: MaintenanceLease | undefined
  try {
    const retry = args.req.isMultipart() ? null : readPendingImportBody(args.req.body)
    const baseRevision = args.req.isMultipart()
      ? readBaseRevisionQuery((args.req.query ?? {}) as ImportQuery)
      : readBaseRevision(retry?.baseRevision)
    let allowLowLevelAccess = retry?.allowLowLevelAccess === true
    let password = typeof retry?.password === 'string' ? retry.password : undefined

    // Reject busy owners, but temporary intake must still allow maintenance.
    coordinator.beginAssetStaging(intakeSignal).release()
    // Shutdown must wake req.file() even before a file stream/lease exists.
    addAbortSignal(intakeSignal, args.req.raw)
    let streamed: Awaited<ReturnType<typeof importLocalFileStream>> | undefined
    if (!retry && (args.req.query as ImportQuery)?.stream === '1') {
      // Preflight options precede the file, so consent/password are available
      // before consuming any asset payload. They never appear in URLs or logs.
      const file = await args.req.file({ limits: { fileSize: args.options.maxUploadBytes } })
      if (!file) throw new ValidationError('Import file missing')
      const field = file.fields.options
      if (!field || Array.isArray(field) || field.type !== 'field' || typeof field.value !== 'string')
        throw new ValidationError('Import options must precede the file')
      let parsedOptions: unknown
      try {
        parsedOptions = JSON.parse(field.value)
      } catch {
        throw new ValidationError('Invalid import options')
      }
      const options = readPendingImportBody(parsedOptions)
      allowLowLevelAccess = options.allowLowLevelAccess === true
      password = typeof options.password === 'string' ? options.password : undefined
      lease = coordinator.beginAssetStaging(intakeSignal)
      // Wake pending reads when shutdown or disconnect cancels a stalled upload.
      addAbortSignal(lease.signal, file.file)
      const source = async function* () {
        let size = 0
        for await (const chunk of file.file) {
          lease!.signal.throwIfAborted()
          size += chunk.length
          yield chunk as Buffer
        }
        if (file.file.truncated) throw new ValidationError('Import upload exceeds size limit')
        if (!size) throw new ValidationError('Import file is empty')
      }
      streamed = await importLocalFileStream({
        kind: args.kind,
        source: source(),
        maxExpandedBytes: args.options.maxExpandedBytes,
        db: args.db,
        dataDir: args.dataDir,
        fileName: file.filename,
        password,
        allowLowLevelAccess,
        signal: lease.signal,
        reportProgress: args.reportProgress,
      })
      // A receive-time authority change must not authorize a late commit.
      if (!writerIsCurrent()) return staleWriter()
    } else if (retry) {
      pending = takePendingImport(args.pendingImports, retry.pendingImportToken, args.kind, false)
    } else {
      pending = await receivePendingImport(args.req, args.kind, args.options.maxUploadBytes, args.ttlMs, intakeSignal)
      ownsUpload = true
    }

    // Conversion writes live assets across awaits, so retain this lease through
    // the final command (or failed conversion) and release before confirmation.
    lease ??= coordinator.beginAssetStaging(intakeSignal)
    lease.signal.throwIfAborted()
    const eventOrigin = commandEventOrigin(args.req)
    if (args.kind === 'character') {
      const imported =
        streamed && 'character' in streamed
          ? streamed
          : await importLocalCharacterFile({
              db: args.db,
              dataDir: args.dataDir,
              filePath: pending!.filePath,
              fileName: pending!.fileName,
              allowLowLevelAccess,
              password,
              maxExpandedBytes: args.options.maxExpandedBytes,
              reportProgress: args.reportProgress,
              signal: lease.signal,
            })
      args.reportProgress?.({ phase: 'commit' })
      if (args.reportProgress) await yieldToIo()
      lease.signal.throwIfAborted()
      if (!writerIsCurrent()) return staleWriter()
      const result = appendRealmCharacter({
        db: args.db,
        dataDir: args.dataDir,
        eventSink: args.eventSink,
        eventOrigin,
        baseRevision,
        character: imported.character,
      })
      if (pending) consumePendingImport(args.pendingImports, pending)
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
        importReport: imported.report,
      }
    }

    const imported =
      streamed && 'module' in streamed
        ? streamed
        : await importLocalModuleFile({
            db: args.db,
            dataDir: args.dataDir,
            filePath: pending!.filePath,
            fileName: pending!.fileName,
            allowLowLevelAccess,
            maxExpandedBytes: args.options.maxExpandedBytes,
          })
    lease.signal.throwIfAborted()
    if (!writerIsCurrent()) return staleWriter()
    const module = createModuleRecord(imported.module, 'module', { allowMcp: true }, { assetDb: args.db })
    const result = applyTargetedCommandMutation<{ moduleId: string }>({
      db: args.db,
      dataDir: args.dataDir,
      baseRevision,
      eventSink: args.eventSink,
      ...(eventOrigin ? { eventOrigin } : {}),
      mutationPath: TARGETED_MUTATION_PATHS.collection,
      collectionScopedRead: ['modules'],
      mutate(database, innerDb) {
        const target = readJsonObject(database, 'database')
        const modules = readStrictModuleRecords(target)
        modules.forEach((candidate, index) =>
          validateStoredModuleRecord(candidate, `module[${index}]`, { allowMcp: true }),
        )
        if (modules.some((candidate) => candidate.id === module.id)) {
          throw new ValidationError(`Module already exists: ${module.id}`)
        }
        modules.push(module)
        writeSingleCollectionTable(innerDb, 'modules', modules)
        return {
          event: { ...COMMAND_EVENT_CATALOG.moduleCreated, id: module.id },
          extra: { moduleId: module.id },
        }
      },
    })
    if (pending) consumePendingImport(args.pendingImports, pending)
    return { revision: result.revision, event: result.event, ...result.extra }
  } catch (error) {
    if (error instanceof MaintenanceBusyError) {
      if (ownsUpload && pending) consumePendingImport(args.pendingImports, pending)
      args.reply.code(503)
      return { error: error.code, code: error.code }
    }
    if (error instanceof LowLevelAccessImportError && pending) {
      const token = retainPendingImport(args.pendingImports, pending, args.ttlMs)
      args.reply.code(409)
      return {
        error: error.message,
        code: 'low_level_access_confirmation_required',
        pendingImportToken: token,
      }
    }
    if (error instanceof CharacterPasswordRequiredError && pending) {
      const token = retainPendingImport(args.pendingImports, pending, args.ttlMs)
      args.reply.code(409)
      return { error: error.message, code: 'character_password_required', pendingImportToken: token }
    }
    if (error instanceof CharacterPasswordInvalidError) {
      if (pending) retainPendingImport(args.pendingImports, pending, args.ttlMs)
      args.reply.code(400)
      return { error: error.message, code: 'character_password_invalid' }
    }
    if (error instanceof RevisionMismatchError) {
      if (pending) retainPendingImport(args.pendingImports, pending, args.ttlMs)
      args.reply.code(409)
      return { error: error.message, currentRevision: error.currentRevision }
    }
    if (error instanceof ValidationError) {
      if (pending) consumePendingImport(args.pendingImports, pending)
      args.reply.code(400)
      return { error: error.message }
    }
    if (ownsUpload && pending) consumePendingImport(args.pendingImports, pending)
    throw error
  } finally {
    lease?.release()
    requestAbort.cleanup()
  }
}

async function receivePendingImport(
  req: FastifyRequest,
  kind: ImportKind,
  maxUploadBytes: number,
  ttlMs: number,
  signal: AbortSignal,
): Promise<PendingLocalFileImport> {
  if (!req.isMultipart()) throw new ValidationError(`${kind} import requires a multipart file upload`)
  const file = await req.file({ limits: { fileSize: maxUploadBytes } })
  if (!file) throw new ValidationError(`${kind} import file missing`)
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `risu-${kind}-import-`))
  const filePath = path.join(tempDir, 'upload')
  try {
    await pipeline(file.file, fs.createWriteStream(filePath), { signal })
    if (file.file.truncated) throw new ValidationError(`${kind} import upload exceeds size limit`)
    if ((await fs.promises.stat(filePath)).size === 0) throw new ValidationError(`${kind} import file is empty`)
    const pending: PendingLocalFileImport = {
      kind,
      fileName: file.filename,
      filePath,
      tempDir,
      expiresAt: Date.now() + ttlMs,
      timer: setTimeout(() => {}, ttlMs),
    }
    pending.timer.unref()
    return pending
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function retainPendingImport(
  pendingImports: Map<string, PendingLocalFileImport>,
  pending: PendingLocalFileImport,
  ttlMs: number,
): string {
  for (const [existingToken, existing] of pendingImports) {
    if (existing === pending) return existingToken
  }
  clearTimeout(pending.timer)
  const token = randomBytes(24).toString('base64url')
  pending.expiresAt = Date.now() + ttlMs
  pending.timer = setTimeout(() => consumePendingImport(pendingImports, pending), ttlMs)
  pending.timer.unref()
  pendingImports.set(token, pending)
  return token
}

function takePendingImport(
  pendingImports: Map<string, PendingLocalFileImport>,
  tokenValue: unknown,
  kind: ImportKind,
  consume: boolean,
): PendingLocalFileImport {
  if (typeof tokenValue !== 'string' || tokenValue.length === 0) {
    throw new ValidationError('pendingImportToken must be a non-empty string')
  }
  const pending = pendingImports.get(tokenValue)
  if (!pending || pending.kind !== kind || pending.expiresAt <= Date.now()) {
    if (pending) consumePendingImport(pendingImports, pending)
    throw new ValidationError('Pending import token is invalid or expired')
  }
  if (consume) pendingImports.delete(tokenValue)
  return pending
}

function consumePendingImport(
  pendingImports: Map<string, PendingLocalFileImport>,
  pending: PendingLocalFileImport,
): void {
  for (const [token, candidate] of pendingImports) {
    if (candidate === pending) pendingImports.delete(token)
  }
  clearTimeout(pending.timer)
  void fs.promises.rm(pending.tempDir, { recursive: true, force: true })
}

function readPendingImportBody(value: unknown): PendingImportBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('import retry body must be an object')
  }
  const body = value as PendingImportBody
  if (body.allowLowLevelAccess !== undefined && typeof body.allowLowLevelAccess !== 'boolean') {
    throw new ValidationError('allowLowLevelAccess must be a boolean')
  }
  if (body.password !== undefined && typeof body.password !== 'string') {
    throw new ValidationError('password must be a string')
  }
  return body
}

function readBaseRevisionQuery(query: ImportQuery): number {
  const raw = query.baseRevision
  const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return readBaseRevision(parsed)
}

function readBaseRevision(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ValidationError('baseRevision must be a non-negative integer')
  }
  return value as number
}

function commandEventOrigin(req: FastifyRequest): CommandEventOrigin | undefined {
  const writerSessionId = readActiveWriterSessionId(req)
  return writerSessionId ? { writerSessionId } : undefined
}
