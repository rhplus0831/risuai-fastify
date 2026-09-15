import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import type { AuthState } from '../auth.js'
import type { CommandEventSink } from '../commands/events.js'
import { requireAuth } from '../http.js'
import {
  AutomaticBackupError,
  BackupDatabaseValidationError,
  EntityNotFoundError,
  WalCheckpointError,
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
} from '../repository.js'
import { reconcileGenerationOperationsAtStartup } from '../generationOperations.js'
import { reconcileGenerationEffectsAtStartup } from '../generationEffects.js'
import { MaintenanceBusyError } from '../maintenanceCoordinator.js'
import { attachMaintenanceAbort } from '../maintenanceRequest.js'
import { assertDatabaseReplacementAllowedInTransaction, ChatOccupancyError } from '../chatOccupancy.js'
import { listGenerationOccupancyPins } from '../generationScope.js'

interface CreateBody {
  label?: unknown
}

export function registerBackupRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  options: { automaticBackupRetention?: number; serverInstanceId?: string } = {},
): void {
  app.post('/api/v1/backups', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const body = (req.body ?? {}) as CreateBody
    let label: string | null = null
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== 'string') {
        reply.code(400)
        return { error: 'label must be a string' }
      }
      label = body.label
    }
    const requestAbort = attachMaintenanceAbort(req, reply)
    try {
      const manifest = await createBackup(db, dataDir, label, { signal: requestAbort.signal })
      reply.code(201)
      return manifest
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        reply.code(503)
        return { error: err.code }
      }
      if (err instanceof Error && err.name === 'AbortError') {
        reply.header('connection', 'close')
        reply.code(499)
        return { error: 'backup_aborted' }
      }
      if (err instanceof WalCheckpointError) {
        reply.code(503)
        return { error: err.code, detail: err.message }
      }
      throw err
    } finally {
      requestAbort.cleanup()
    }
  })

  app.get('/api/v1/backups', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    return { backups: listBackups(dataDir) }
  })

  app.post<{ Params: { id: string } }>('/api/v1/backups/:id/restore', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    const requestAbort = attachMaintenanceAbort(req, reply)
    try {
      const { revision, event, databaseLineage, writerEpoch } = await restoreBackup(db, dataDir, req.params.id, {
        automaticBackupRetention: options.automaticBackupRetention,
        signal: requestAbort.signal,
        beforeReplace: (innerDb) =>
          assertDatabaseReplacementAllowedInTransaction(innerDb, { pinQuery: listGenerationOccupancyPins }),
        onCommitted({ event }) {
          if (options.serverInstanceId) {
            reconcileGenerationOperationsAtStartup(db, options.serverInstanceId, req.log)
          }
          reconcileGenerationEffectsAtStartup(db)
          eventSink.emit(event)
        },
      })
      return { revision, event, databaseLineage, writerEpoch }
    } catch (err) {
      if (err instanceof ChatOccupancyError) {
        reply.code(err.statusCode)
        return { error: err.code, ...err.details }
      }
      if (err instanceof MaintenanceBusyError) {
        reply.code(503)
        return { error: err.code }
      }
      if (err instanceof Error && err.name === 'AbortError') {
        reply.header('connection', 'close')
        reply.code(499)
        return { error: 'backup_aborted' }
      }
      if (err instanceof EntityNotFoundError) {
        reply.code(404)
        return { error: err.message }
      }
      if (err instanceof BackupDatabaseValidationError) {
        reply.code(400)
        return { error: err.code }
      }
      if (err instanceof AutomaticBackupError) {
        reply.code(500)
        return { error: err.code }
      }
      throw err
    } finally {
      requestAbort.cleanup()
    }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/backups/:id', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      await deleteBackup(dataDir, req.params.id)
      return { id: req.params.id }
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        reply.code(503)
        return { error: err.code }
      }
      if (err instanceof EntityNotFoundError) {
        reply.code(404)
        return { error: err.message }
      }
      throw err
    }
  })
}
