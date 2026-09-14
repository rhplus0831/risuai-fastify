import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthState } from '../auth.js'
import { DATABASE_LINEAGE_HEADER, assertDatabaseLineage } from '../databaseLineage.js'
import {
  claimGenerationEffect,
  isGenerationEffectKind,
  listGenerationEffects,
  renewGenerationEffectClaim,
  settleGenerationEffect,
  type GenerationEffectDelivery,
  type GenerationEffectKind,
  type GenerationEffectProjection,
} from '../generationEffects.js'
import { requireAuth } from '../http.js'
import { ValidationError } from '../repository.js'
import { readActiveWriterSessionId } from '../activeWriter.js'
import {
  CHAT_ONLY_GENERATION_ALLOWLIST,
  CHAT_ONLY_GENERATION_SCOPE_VERSION,
  GenerationAdmissionError,
  admitGenerationInTransaction,
  assertPersistedGenerationScopeInTransaction,
} from '../generationScope.js'

const ORIGINATING_SESSION_EPHEMERAL_EFFECTS = new Set<GenerationEffectKind>(['notification', 'tts', 'completion_sound'])

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

function assertOriginatingSessionEffectIdentity(effect: GenerationEffectProjection, sessionId: string): void {
  const scope = effect.generationScope
  if (!scope || scope.admissionKind === 'legacy_owner') {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
  if (typeof scope.occupancySessionId !== 'string' || scope.occupancySessionId.length === 0) {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
  if (scope.occupancySessionId !== sessionId) {
    throw new GenerationAdmissionError(423, 'generation_effect_foreign_session')
  }

  const expectedClaimClass = scope.admissionKind === 'chat_only' ? 'chat_only' : 'owner'
  const permissionScopeMatches =
    scope.permissionScope?.length === CHAT_ONLY_GENERATION_ALLOWLIST.length &&
    scope.permissionScope.every((permission, index) => permission === CHAT_ONLY_GENERATION_ALLOWLIST[index])
  if (
    scope.occupancyDatabaseLineage !== effect.databaseLineage ||
    !Number.isSafeInteger(scope.occupancyEpoch) ||
    scope.occupancyEpoch! < 1 ||
    scope.occupancyClaimClass !== expectedClaimClass ||
    scope.permissionScopeVersion !== CHAT_ONLY_GENERATION_SCOPE_VERSION ||
    !permissionScopeMatches ||
    effect.keyType !== 'operation' ||
    effect.operationId === undefined ||
    effect.keyId !== effect.operationId ||
    !Number.isSafeInteger(effect.operationAttemptNo) ||
    effect.operationAttemptNo! < 1
  ) {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
}

function assertEffectControl(
  db: DatabaseSync,
  generationId: string,
  kind: GenerationEffectKind,
  sessionId: string,
): void {
  const effect = listGenerationEffects(db, generationId).find((candidate) => candidate.kind === kind)
  if (!effect) return
  if (effect.generationScope && effect.generationScope.admissionKind !== 'legacy_owner') {
    if (effect.effectClass === 'ephemeral' && ORIGINATING_SESSION_EPHEMERAL_EFFECTS.has(effect.kind)) {
      // These effects never write shared application state and deliberately do
      // not pin handoff. Keep their immutable accepted-operation/session fence,
      // but let that session terminally settle a late recovery after the live
      // occupancy epoch has advanced.
      assertOriginatingSessionEffectIdentity(effect, sessionId)
      return
    }
    const scopedSession = effect.generationScope.occupancySessionId
    if (scopedSession && scopedSession !== sessionId) {
      throw new GenerationAdmissionError(423, 'generation_effect_foreign_session')
    }
    assertPersistedGenerationScopeInTransaction(db, {
      ...effect.generationScope,
      databaseLineage: effect.databaseLineage,
      chatId: effect.chatId,
      sessionId,
    })
    return
  }
  admitGenerationInTransaction(db, {
    databaseLineage: effect.databaseLineage,
    chatId: effect.chatId,
    sessionId,
    interaction: 'send',
    chatOnlyEnabled: false,
  })
}

function readRequiredSessionId(req: FastifyRequest): string {
  const sessionId = readActiveWriterSessionId(req)
  if (!sessionId) throw new ValidationError('risu-writer-session header is required')
  return sessionId
}

function sendEffectError(reply: import('fastify').FastifyReply, error: unknown): unknown {
  if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
  if (error instanceof GenerationAdmissionError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  throw error
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
        assertEffectControl(db, generationId, req.params.effectKind, readRequiredSessionId(req))
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
        return sendEffectError(reply, error)
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
        assertEffectControl(db, generationId, req.params.effectKind, readRequiredSessionId(req))
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
        return sendEffectError(reply, error)
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
        assertEffectControl(db, generationId, req.params.effectKind, readRequiredSessionId(req))
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
        return sendEffectError(reply, error)
      }
    },
  )
}
