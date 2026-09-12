import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthState } from '../auth.js'
import { DATABASE_LINEAGE_HEADER, assertDatabaseLineage, getDatabaseLineage } from '../databaseLineage.js'
import {
  claimGenerationEffect,
  isGenerationEffectKind,
  listGenerationEffects,
  renewGenerationEffectClaim,
  settleGenerationEffect,
  type GenerationEffectDelivery,
} from '../generationEffects.js'
import { requireAuth } from '../http.js'
import { ValidationError } from '../repository.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new ValidationError(`${label} is required`)
  }
  return value
}

function readRequestedDatabaseLineage(req: FastifyRequest): string {
  const raw = req.headers[DATABASE_LINEAGE_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return requiredIdentifier(value, `${DATABASE_LINEAGE_HEADER} header`)
}

function clientDelivery(value: unknown): Exclude<GenerationEffectDelivery, 'server'> {
  if (value !== 'live_terminal' && value !== 'late_recovery') {
    throw new ValidationError('delivery must be live_terminal or late_recovery')
  }
  return value
}

export function registerGenerationEffectRoutes(app: FastifyInstance, db: DatabaseSync, authState: AuthState): void {
  app.get<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId',
    { exposeHeadRoute: false },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      const generationId = requiredIdentifier(req.params.generationId, 'generationId')
      const effects = listGenerationEffects(db, generationId)
      if (effects.length === 0) return reply.code(404).send({ error: 'generation_effects_not_found' })
      return { generationId, effects }
    },
  )

  app.post<{ Params: { generationId: string; effectKind: string } }>(
    '/api/v1/generation-effects/:generationId/:effectKind/claims',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isGenerationEffectKind(req.params.effectKind)) throw new ValidationError('invalid effectKind')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const delivery = clientDelivery(req.body.delivery)
        const messageId =
          req.body.messageId === undefined ? undefined : requiredIdentifier(req.body.messageId, 'messageId')
        const result = claimGenerationEffect(db, {
          databaseLineage,
          generationId,
          kind: req.params.effectKind,
          delivery,
          ...(messageId ? { messageId } : {}),
          ...(req.body.recoverRecentCompletionAlert === true ? { recoverRecentCompletionAlert: true } : {}),
        })
        return reply.code(result.status === 'claimed' ? 201 : 200).send(result)
      } catch (error) {
        if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
        throw error
      }
    },
  )

  app.put<{ Params: { generationId: string; effectKind: string } }>(
    '/api/v1/generation-effects/:generationId/:effectKind/lease',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isGenerationEffectKind(req.params.effectKind)) throw new ValidationError('invalid effectKind')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const claimId = requiredIdentifier(req.body.claimId, 'claimId')
        const effect = renewGenerationEffectClaim(db, {
          databaseLineage,
          generationId,
          kind: req.params.effectKind,
          claimId,
        })
        if (!effect) return reply.code(409).send({ error: 'generation_effect_claim_stale' })
        return { effect }
      } catch (error) {
        if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
        throw error
      }
    },
  )

  app.put<{ Params: { generationId: string; effectKind: string } }>(
    '/api/v1/generation-effects/:generationId/:effectKind/receipt',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isGenerationEffectKind(req.params.effectKind)) throw new ValidationError('invalid effectKind')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const claimId = requiredIdentifier(req.body.claimId, 'claimId')
        if (req.body.status !== 'completed' && req.body.status !== 'skipped' && req.body.status !== 'failed') {
          throw new ValidationError('status must be completed, skipped, or failed')
        }
        const effect = settleGenerationEffect(db, {
          databaseLineage,
          generationId,
          kind: req.params.effectKind,
          claimId,
          status: req.body.status,
          ...(typeof req.body.reason === 'string' ? { reason: req.body.reason } : {}),
          ...(typeof req.body.lastError === 'string' ? { lastError: req.body.lastError } : {}),
        })
        if (!effect) return reply.code(409).send({ error: 'generation_effect_claim_stale' })
        return { effect }
      } catch (error) {
        if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
        throw error
      }
    },
  )
}
