import { resolveGenerationConfiguration, overlayGenerationChatRuntime } from '../generationConfiguration.js'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthState } from '../auth.js'
import {
  DATABASE_LINEAGE_HEADER,
  DatabaseLineageConflictError,
  assertDatabaseLineage,
  getDatabaseOwnershipSnapshot,
} from '../databaseLineage.js'
import {
  abandonAuthorizedGenerationInlayPreparationInTransaction,
  beginAuthorizedGenerationInlayPreparationInTransaction,
  claimGenerationEffect,
  commitAuthorizedGenerationInlayFinalizationInTransaction,
  completeClaimedIgpEffectInTransaction,
  generationEffectHasExactAcceptedOperationBinding,
  generationEffectHasExactTerminalTranscriptBinding,
  isGenerationEffectKind,
  listGenerationEffects,
  renewGenerationEffectClaim,
  settleGenerationEffect,
  type GenerationEffectDelivery,
  type GenerationEffectKind,
  type GenerationEffectProjection,
} from '../generationEffects.js'
import {
  getGenerationOperationProjection,
  getGenerationOperationAttemptAcceptedConfiguration,
  getGenerationOperationStoredRequest,
} from '../generationOperations.js'
import { requireAuth } from '../http.js'
import { EntityNotFoundError, RevisionMismatchError, ValidationError } from '../repository.js'
import { readActiveWriterSessionId } from '../activeWriter.js'
import {
  CHAT_ONLY_GENERATION_ALLOWLIST,
  CHAT_ONLY_GENERATION_SCOPE_VERSION,
  GenerationAdmissionError,
  assertPersistedGenerationScopeInTransaction,
} from '../generationScope.js'
import { applyTargetedCommandMutation, readBaseRevision } from '../commands/mutations.js'
import { COMMAND_EVENT_CATALOG, type CommandEventSink } from '../commands/events.js'
import { readMessagePatch } from '../commands/messages.js'
import { getChatMessages, resolveActiveMessageLocationById, updateActiveMessageById } from '../messageStore.js'
import { ChatOccupancyError } from '../chatOccupancy.js'
import { CommandMutationIdConflictError, commandMutationRequestFingerprint } from '../commandMutationReceipts.js'
import { decodeGenerationDatabase } from '../prompt/generationInputDecoder.js'
import { parseChatML } from '../prompt/templates.js'
import { expandVariables, type ExpandContext } from '../prompt/variables.js'
import { dispatchChatProvider } from '../prompt/chatDispatch.js'
import { applyProfileBoundGenerationFields } from '../prompt/effectiveGenerationConfig.js'
import { assertModelProfileGenerationReady, resolveModelProfile } from '@risuai/shared-core/model-profile-resolver'
import { attachAbort } from '../requestAbort.js'
import { collectCompletionFrames } from './generation.js'
import { generationSubmitRateLimit } from '../routeRateLimits.js'
import type { ReportedClientContext } from '@risuai/protocol/client-context'

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

function requiredInlayPreparationId(value: unknown): string {
  const preparationId = requiredIdentifier(value, 'preparationId')
  if (preparationId.length > 48 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(preparationId)) {
    throw new ValidationError('preparationId must contain 1-48 letters, numbers, dots, underscores, colons, or hyphens')
  }
  return preparationId
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new ValidationError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`)
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
    assertOriginatingSessionEffectIdentity(effect, sessionId)
    if (!generationEffectHasExactAcceptedOperationBinding(db, effect)) {
      throw new GenerationAdmissionError(409, 'generation_scope_invalid')
    }
    if (effect.effectClass === 'ephemeral' && ORIGINATING_SESSION_EPHEMERAL_EFFECTS.has(effect.kind)) {
      // These effects never write shared application state and deliberately do
      // not pin handoff. Keep their immutable accepted-operation/session fence,
      // but let that session terminally settle a late recovery after the live
      // occupancy epoch has advanced.
      return
    }
    assertPersistedGenerationScopeInTransaction(db, {
      ...effect.generationScope,
      databaseLineage: effect.databaseLineage,
      chatId: effect.chatId,
      sessionId,
    })
    return
  }
  // Compatibility effects are themselves recovery pins. Re-running fresh
  // generation admission here would reject the very pending row the current
  // owner is trying to settle. Preserve the historical contract directly:
  // only the active general owner controls a legacy ledger row.
  const ownership = getDatabaseOwnershipSnapshot(db)
  if (ownership.writer.sessionId !== null && ownership.writer.sessionId !== sessionId) {
    throw new GenerationAdmissionError(423, 'active_writer_stale', {
      reason: 'Compatibility generation effects require the active general owner.',
    })
  }
}

function readRequiredSessionId(req: FastifyRequest): string {
  const sessionId = readActiveWriterSessionId(req)
  if (!sessionId) throw new ValidationError('risu-writer-session header is required')
  return sessionId
}

function requireAuthorizedOwnerInlayEffect(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    operationId: string
    sessionId: string
    requireCurrentScope?: boolean
  },
): GenerationEffectProjection {
  const effect = listGenerationEffects(db, input.generationId, input.databaseLineage).find(
    (candidate) => candidate.kind === 'igp',
  )
  if (!effect) throw new EntityNotFoundError('generation_effects_not_found')
  assertOriginatingSessionEffectIdentity(effect, input.sessionId)
  if (
    effect.operationId !== input.operationId ||
    effect.generationScope?.admissionKind !== 'owner_occupancy' ||
    effect.generationScope.occupancyClaimClass !== 'owner' ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
  if (input.requireCurrentScope === true) {
    assertPersistedGenerationScopeInTransaction(db, {
      ...effect.generationScope,
      databaseLineage: effect.databaseLineage,
      chatId: effect.chatId,
      sessionId: input.sessionId,
    })
  }
  return effect
}

function sendEffectError(reply: import('fastify').FastifyReply, error: unknown): unknown {
  if (error instanceof ChatOccupancyError)
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  if (error instanceof DatabaseLineageConflictError) {
    return reply.code(409).send({ error: 'database_lineage_conflict', databaseLineage: error.databaseLineage })
  }
  if (error instanceof CommandMutationIdConflictError) {
    return reply.code(409).send({ error: 'mutation_id_conflict' })
  }
  if (error instanceof RevisionMismatchError) {
    return reply.code(409).send({ error: 'revision_conflict', currentRevision: error.currentRevision })
  }
  if (error instanceof ValidationError) return reply.code(400).send({ error: error.message })
  if (error instanceof EntityNotFoundError) return reply.code(404).send({ error: error.message })
  if (error instanceof GenerationAdmissionError) {
    return reply.code(error.statusCode).send({ error: error.code, ...error.details })
  }
  throw error
}

function claimedIgpAcceptedExecution(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
): {
  database: ReturnType<typeof decodeGenerationDatabase>
  acceptedTranscriptTail: unknown
  clientContext?: ReportedClientContext
} {
  if (
    effect.operationId === undefined ||
    effect.operationAttemptNo === undefined ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    throw new GenerationAdmissionError(409, 'generation_scope_invalid')
  }
  const accepted = getGenerationOperationAttemptAcceptedConfiguration(
    db,
    effect.databaseLineage,
    effect.operationId,
    effect.operationAttemptNo,
  )
  if (!accepted) throw new GenerationAdmissionError(409, 'operation_effective_configuration_missing')
  let configuration
  try {
    configuration = resolveGenerationConfiguration(
      db,
      accepted.effectiveConfiguration,
      accepted.effectiveConfigurationFingerprint,
    )
  } catch {
    throw new GenerationAdmissionError(409, 'operation_effective_configuration_invalid')
  }
  const stored = getGenerationOperationStoredRequest(db, effect.databaseLineage, effect.operationId)
  const intent = isRecord(stored?.intent) ? stored.intent : undefined
  const generation = intent && isRecord(intent.generation) ? intent.generation : undefined
  const clientContext = generation && isRecord(generation.clientContext) ? generation.clientContext : undefined
  return {
    database: decodeGenerationDatabase(structuredClone(configuration.database)),
    acceptedTranscriptTail: configuration.acceptedTranscriptTail,
    ...(clientContext ? { clientContext: clientContext as ReportedClientContext } : {}),
  }
}

function operationRetainsContinueTargetIdentity(
  operation: ReturnType<typeof getGenerationOperationProjection>,
  effect: GenerationEffectProjection,
): boolean {
  return (
    operation?.mode === 'continue' &&
    operation.requestOrigin === 'continue' &&
    operation.targetMessageId === effect.messageId
  )
}

function terminalMessageHasExactGeneratedIdentity(
  effect: GenerationEffectProjection,
  terminalMessage: Record<string, unknown>,
  retainedContinueTarget: boolean,
): boolean {
  if (terminalMessage.role !== 'char' || terminalMessage.chatId !== effect.messageId) return false
  if (retainedContinueTarget) return true

  const generationInfo = isRecord(terminalMessage.generationInfo) ? terminalMessage.generationInfo : undefined
  const terminalAttemptNo = generationInfo?.operationAttemptNo ?? generationInfo?.attemptNo
  return (
    generationInfo?.generationId === effect.generationId &&
    generationInfo.databaseLineage === effect.databaseLineage &&
    generationInfo.operationId === effect.operationId &&
    terminalAttemptNo === effect.operationAttemptNo &&
    generationInfo.jobId === effect.generationId &&
    generationInfo.effectLedgerKeyType === effect.keyType &&
    generationInfo.effectLedgerKeyId === effect.keyId &&
    generationInfo.effectLedgerCharacterId === effect.characterId &&
    generationInfo.effectLedgerChatId === effect.chatId
  )
}

function bindClaimedIgpTerminalTranscript(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
  acceptedDatabase: ReturnType<typeof decodeGenerationDatabase>,
  selectedCharID: number,
  chatPage: number,
  acceptedTranscriptTail: unknown,
): void {
  const invalid = (): never => {
    throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
  }
  const operationId = effect.operationId
  const effectAttemptNo = effect.operationAttemptNo
  if (operationId === undefined || effectAttemptNo === undefined) {
    throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
  }
  const operation = getGenerationOperationProjection(db, effect.databaseLineage, operationId)
  const currentChat = acceptedDatabase.characters[selectedCharID]?.chats[chatPage]
  const resolved = resolveActiveMessageLocationById(db, effect.messageId)
  const terminalMessages = getChatMessages(db, effect.chatId)
  if (resolved.ok === false) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
  const terminalLocation = resolved.location
  if (!operation || !currentChat) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
  if (
    operation.state !== 'completed' ||
    operation.characterId !== effect.characterId ||
    operation.chatId !== effect.chatId ||
    operation.resultMessageId !== effect.messageId ||
    terminalLocation.chatId !== effect.chatId ||
    !generationEffectHasExactTerminalTranscriptBinding(db, effect, terminalMessages)
  ) {
    invalid()
  }

  const terminalMessage = terminalLocation.message
  const retainedContinueTarget = operationRetainsContinueTargetIdentity(operation, effect)
  if (!terminalMessageHasExactGeneratedIdentity(effect, terminalMessage, retainedContinueTarget)) {
    invalid()
  }

  // New snapshots retain only the accepted identity. Keep existing persisted
  // operations compatible without rewriting their fingerprinted configuration.
  const acceptedTail =
    acceptedTranscriptTail === undefined
      ? currentChat.message.at(-1)
      : isRecord(acceptedTranscriptTail)
        ? acceptedTranscriptTail
        : undefined
  if (operation.mode === 'send' && operation.requestOrigin === 'accepted_send') {
    const acceptedUser = acceptedTail
    const terminalAcceptedUserIndexes = terminalMessages.flatMap((message, index) =>
      message.chatId === operation.acceptedMessageId ? [index] : [],
    )
    const terminalAcceptedUserIndex = terminalAcceptedUserIndexes[0]
    if (
      typeof operation.acceptedMessageId !== 'string' ||
      acceptedUser?.role !== 'user' ||
      acceptedUser.chatId !== operation.acceptedMessageId ||
      terminalAcceptedUserIndexes.length !== 1 ||
      terminalAcceptedUserIndex === undefined ||
      terminalMessages[terminalAcceptedUserIndex]?.role !== 'user' ||
      terminalAcceptedUserIndex >= terminalLocation.seq
    ) {
      invalid()
    }
  } else if (operation.mode === 'regenerate' && operation.requestOrigin === 'regenerate') {
    const acceptedTarget = acceptedTail
    if (
      typeof operation.targetMessageId !== 'string' ||
      operation.targetMessageId === effect.messageId ||
      acceptedTarget?.role !== 'char' ||
      acceptedTarget.chatId !== operation.targetMessageId
    ) {
      invalid()
    }
  } else if (operation.mode === 'continue' && operation.requestOrigin === 'continue') {
    const acceptedTarget = acceptedTail
    if (
      typeof operation.targetMessageId !== 'string' ||
      acceptedTarget?.role !== 'char' ||
      acceptedTarget.chatId !== operation.targetMessageId
    ) {
      invalid()
    }

    // Continue has two production dispositions. Extend replaces the accepted
    // assistant in place and therefore keeps its id. Append retains that exact
    // assistant and adds a distinct terminal result after it. The operation's
    // result/effect binding above independently authenticates the generated row.
    if (!retainedContinueTarget) {
      const terminalContinueTargetIndexes = terminalMessages.flatMap((message, index) =>
        message.chatId === operation.targetMessageId ? [index] : [],
      )
      const terminalContinueTargetIndex = terminalContinueTargetIndexes[0]
      if (
        terminalContinueTargetIndexes.length !== 1 ||
        terminalContinueTargetIndex === undefined ||
        terminalMessages[terminalContinueTargetIndex]?.role !== 'char' ||
        terminalContinueTargetIndex >= terminalLocation.seq
      ) {
        invalid()
      }
    }
  } else {
    invalid()
  }

  // The accepted snapshot remains authoritative for settings, definitions,
  // model profiles, and credentials. Only its operation-bound chat transcript
  // advances to the exact terminal Send/Reroll/Continue result for dynamic CBS
  // macros.
  currentChat.message = structuredClone(terminalMessages) as typeof currentChat.message
  overlayGenerationChatRuntime(db, currentChat as unknown as Record<string, unknown>)
}

export function registerGenerationEffectRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
): void {
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
        const sessionId = readRequiredSessionId(req)
        const claimId = requiredIdentifier(req.body.claimId, 'claimId')
        if (req.body.status !== 'completed' && req.body.status !== 'skipped' && req.body.status !== 'failed') {
          throw new ValidationError('status must be completed, skipped, or failed')
        }
        const currentEffect = listGenerationEffects(db, generationId, databaseLineage).find(
          (candidate) => candidate.kind === req.params.effectKind,
        )
        if (
          req.params.effectKind === 'igp' &&
          req.body.status === 'completed' &&
          currentEffect?.status === 'completed' &&
          currentEffect.claimId === claimId
        ) {
          if (currentEffect.generationScope && currentEffect.generationScope.admissionKind !== 'legacy_owner') {
            assertOriginatingSessionEffectIdentity(currentEffect, sessionId)
            if (!generationEffectHasExactAcceptedOperationBinding(db, currentEffect)) {
              throw new GenerationAdmissionError(409, 'generation_scope_invalid')
            }
          } else {
            assertEffectControl(db, generationId, req.params.effectKind, sessionId)
          }
          return { effect: currentEffect }
        }
        assertEffectControl(db, generationId, req.params.effectKind, sessionId)
        if (req.params.effectKind === 'igp' && req.body.status === 'completed') {
          throw new GenerationAdmissionError(409, 'generation_effect_atomic_commit_required')
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

  app.put<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId/igp/inlay-preparation',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const allowedKeys = new Set(['baseRevision', 'operationId', 'preparationId', 'expectedData'])
        if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
          throw new ValidationError('Generation inlay preparation contains unsupported fields')
        }
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const sessionId = readRequiredSessionId(req)
        const operationId = requiredIdentifier(req.body.operationId, 'operationId')
        const preparationId = requiredInlayPreparationId(req.body.preparationId)
        const expectedData = requiredString(req.body.expectedData, 'expectedData', true)
        const baseRevision = readBaseRevision(req.body)
        const effect = requireAuthorizedOwnerInlayEffect(db, {
          databaseLineage,
          generationId,
          operationId,
          sessionId,
        })
        const routePath = `/api/v1/generation-effects/${encodeURIComponent(generationId)}/igp/inlay-preparation`
        const normalizedBody = { baseRevision, operationId, preparationId, expectedData }
        const result = applyTargetedCommandMutation<{
          chatId: string
          messageId: string
          inlayPreparation: 'prepared'
          preparationId: string
        }>({
          db,
          dataDir,
          baseRevision,
          eventSink,
          mutationReceiptKey: {
            databaseLineage,
            writerSessionId: sessionId,
            mutationId: `generation-effect-inlay-prepare:${preparationId}`,
            requestFingerprint: commandMutationRequestFingerprint('PUT', routePath, normalizedBody),
          },
          mutationPath: 'generation-effect-inlay-prepare',
          chatScopedRead: { messageId: effect.messageId, exactChatRow: true },
          mutate(_database, targetDb) {
            const current = requireAuthorizedOwnerInlayEffect(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              sessionId,
              requireCurrentScope: true,
            })
            const prepared = beginAuthorizedGenerationInlayPreparationInTransaction(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              characterId: current.characterId,
              chatId: current.chatId,
              messageId: current.messageId,
              preparationId,
              expectedData,
            })
            if (!prepared) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.messageUpdated,
                id: current.messageId,
                parentId: current.chatId,
              },
              extra: {
                chatId: current.chatId,
                messageId: current.messageId,
                inlayPreparation: prepared,
                preparationId,
              },
            }
          },
        })
        return { revision: result.revision, event: result.event, ...result.extra }
      } catch (error) {
        return sendEffectError(reply, error)
      }
    },
  )

  app.put<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId/igp/inlay-finalization',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const allowedKeys = new Set(['baseRevision', 'operationId', 'preparationId', 'expectedData', 'finalData'])
        if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
          throw new ValidationError('Generation inlay finalization contains unsupported fields')
        }
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const sessionId = readRequiredSessionId(req)
        const operationId = requiredIdentifier(req.body.operationId, 'operationId')
        const preparationId = requiredInlayPreparationId(req.body.preparationId)
        const expectedData = requiredString(req.body.expectedData, 'expectedData', true)
        const finalData = requiredString(req.body.finalData, 'finalData', true)
        const baseRevision = readBaseRevision(req.body)
        const effect = requireAuthorizedOwnerInlayEffect(db, {
          databaseLineage,
          generationId,
          operationId,
          sessionId,
        })
        const routePath = `/api/v1/generation-effects/${encodeURIComponent(generationId)}/igp/inlay-finalization`
        const normalizedBody = { baseRevision, operationId, preparationId, expectedData, finalData }
        const result = applyTargetedCommandMutation<{
          chatId: string
          messageId: string
          inlayFinalization: 'committed' | 'deferred'
          preparationId: string
        }>({
          db,
          dataDir,
          baseRevision,
          eventSink,
          mutationReceiptKey: {
            databaseLineage,
            writerSessionId: sessionId,
            mutationId: `generation-effect-inlay-finalize:${preparationId}`,
            requestFingerprint: commandMutationRequestFingerprint('PUT', routePath, normalizedBody),
          },
          mutationPath: 'generation-effect-inlay-finalize',
          chatScopedRead: { messageId: effect.messageId, exactChatRow: true },
          mutate(_database, targetDb) {
            const current = requireAuthorizedOwnerInlayEffect(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              sessionId,
              requireCurrentScope: true,
            })
            const finalized = commitAuthorizedGenerationInlayFinalizationInTransaction(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              characterId: current.characterId,
              chatId: current.chatId,
              messageId: current.messageId,
              preparationId,
              expectedData,
              finalData,
            })
            if (!finalized) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.messageUpdated,
                id: current.messageId,
                parentId: current.chatId,
              },
              extra: {
                chatId: current.chatId,
                messageId: current.messageId,
                inlayFinalization: finalized,
                preparationId,
              },
            }
          },
        })
        return { revision: result.revision, event: result.event, ...result.extra }
      } catch (error) {
        return sendEffectError(reply, error)
      }
    },
  )

  app.put<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId/igp/inlay-abandonment',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const allowedKeys = new Set(['baseRevision', 'operationId', 'preparationId'])
        if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
          throw new ValidationError('Generation inlay abandonment contains unsupported fields')
        }
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const sessionId = readRequiredSessionId(req)
        const operationId = requiredIdentifier(req.body.operationId, 'operationId')
        const preparationId = requiredInlayPreparationId(req.body.preparationId)
        const baseRevision = readBaseRevision(req.body)
        requireAuthorizedOwnerInlayEffect(db, {
          databaseLineage,
          generationId,
          operationId,
          sessionId,
        })
        const routePath = `/api/v1/generation-effects/${encodeURIComponent(generationId)}/igp/inlay-abandonment`
        const normalizedBody = { baseRevision, operationId, preparationId }
        const result = applyTargetedCommandMutation<{
          chatId: string
          messageId: string
          inlayPreparation: 'abandoned'
          preparationId: string
        }>({
          db,
          dataDir,
          baseRevision,
          eventSink,
          mutationReceiptKey: {
            databaseLineage,
            writerSessionId: sessionId,
            mutationId: `generation-effect-inlay-abandon:${preparationId}`,
            requestFingerprint: commandMutationRequestFingerprint('PUT', routePath, normalizedBody),
          },
          mutationPath: 'generation-effect-inlay-abandon',
          skipDatabaseLoad: true,
          mutate(_database, targetDb) {
            const current = requireAuthorizedOwnerInlayEffect(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              sessionId,
            })
            const abandoned = abandonAuthorizedGenerationInlayPreparationInTransaction(targetDb, {
              databaseLineage,
              generationId,
              operationId,
              characterId: current.characterId,
              chatId: current.chatId,
              messageId: current.messageId,
              preparationId,
            })
            if (!abandoned) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.messageUpdated,
                id: current.messageId,
                parentId: current.chatId,
              },
              extra: {
                chatId: current.chatId,
                messageId: current.messageId,
                inlayPreparation: abandoned,
                preparationId,
              },
            }
          },
        })
        return { revision: result.revision, event: result.event, ...result.extra }
      } catch (error) {
        return sendEffectError(reply, error)
      }
    },
  )

  app.put<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId/igp/commit',
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        const allowedKeys = new Set(['baseRevision', 'claimId', 'data', 'expectedData', 'expectedGenerationId'])
        if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
          throw new ValidationError('IGP commit contains unsupported fields')
        }
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const sessionId = readRequiredSessionId(req)
        const claimId = requiredIdentifier(req.body.claimId, 'claimId')
        const expectedData = requiredString(req.body.expectedData, 'expectedData', true)
        const expectedGenerationId = requiredIdentifier(req.body.expectedGenerationId, 'expectedGenerationId')
        if (expectedGenerationId !== generationId) {
          throw new ValidationError('expectedGenerationId must match generationId')
        }
        const patch = readMessagePatch({ data: requiredString(req.body.data, 'data', true) })
        const baseRevision = readBaseRevision(req.body)
        const effect = listGenerationEffects(db, generationId, databaseLineage).find(
          (candidate) => candidate.kind === 'igp',
        )
        if (!effect) return reply.code(404).send({ error: 'generation_effects_not_found' })
        assertOriginatingSessionEffectIdentity(effect, sessionId)
        if (!generationEffectHasExactAcceptedOperationBinding(db, effect)) {
          throw new GenerationAdmissionError(409, 'generation_scope_invalid')
        }
        if (effect.claimId !== claimId || (effect.status !== 'claimed' && effect.status !== 'completed')) {
          throw new GenerationAdmissionError(409, 'generation_effect_claim_stale')
        }
        if (effect.status === 'claimed') assertEffectControl(db, generationId, 'igp', sessionId)

        const routePath = `/api/v1/generation-effects/${encodeURIComponent(generationId)}/igp/commit`
        const normalizedBody = {
          baseRevision,
          claimId,
          data: patch.data,
          expectedData,
          expectedGenerationId,
        }
        const result = applyTargetedCommandMutation<{ chatId: string; messageId: string }>({
          db,
          dataDir,
          baseRevision,
          eventSink,
          eventOrigin: { writerSessionId: sessionId },
          occupancyActorSessionId: sessionId,
          occupancyDirectChatIds: [effect.chatId],
          mutationReceiptKey: {
            databaseLineage,
            writerSessionId: sessionId,
            mutationId: `generation-effect-igp:${claimId}`,
            requestFingerprint: commandMutationRequestFingerprint('PUT', routePath, normalizedBody),
          },
          mutationPath: 'generation-effect-igp-commit',
          chatScopedRead: { messageId: effect.messageId, exactChatRow: true },
          mutate(_database, targetDb) {
            const currentEffect = listGenerationEffects(targetDb, generationId, databaseLineage).find(
              (candidate) => candidate.kind === 'igp',
            )
            if (
              !currentEffect ||
              currentEffect.status !== 'claimed' ||
              currentEffect.claimId !== claimId ||
              currentEffect.messageId !== effect.messageId ||
              currentEffect.chatId !== effect.chatId ||
              currentEffect.characterId !== effect.characterId ||
              !generationEffectHasExactAcceptedOperationBinding(targetDb, currentEffect)
            ) {
              throw new GenerationAdmissionError(409, 'generation_effect_claim_stale')
            }
            assertPersistedGenerationScopeInTransaction(targetDb, {
              ...currentEffect.generationScope!,
              databaseLineage,
              chatId: currentEffect.chatId,
              sessionId,
            })
            const resolved = resolveActiveMessageLocationById(targetDb, currentEffect.messageId)
            if (resolved.ok === false) {
              if (resolved.reason === 'ambiguous') {
                throw new ValidationError(`Ambiguous message id: ${currentEffect.messageId}`)
              }
              throw new EntityNotFoundError(`Message not found: ${currentEffect.messageId}`)
            }
            const character = targetDb
              .prepare('SELECT character_id AS characterId FROM chats WHERE id = ?')
              .get(resolved.location.chatId) as { characterId: string } | undefined
            const operation = getGenerationOperationProjection(targetDb, databaseLineage, currentEffect.operationId!)
            const retainedContinueTarget = operationRetainsContinueTargetIdentity(operation, currentEffect)
            if (
              resolved.location.chatId !== currentEffect.chatId ||
              character?.characterId !== currentEffect.characterId ||
              resolved.location.message.data !== expectedData ||
              !generationEffectHasExactTerminalTranscriptBinding(
                targetDb,
                currentEffect,
                getChatMessages(targetDb, currentEffect.chatId),
              ) ||
              !terminalMessageHasExactGeneratedIdentity(
                currentEffect,
                resolved.location.message,
                retainedContinueTarget,
              )
            ) {
              throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
            }
            if (
              !completeClaimedIgpEffectInTransaction(targetDb, {
                databaseLineage,
                generationId,
                claimId,
                characterId: currentEffect.characterId,
                chatId: currentEffect.chatId,
                messageId: currentEffect.messageId,
                message: resolved.location.message,
                expectedGenerationId,
                ...(retainedContinueTarget ? { allowRetainedGenerationMetadata: true } : {}),
              })
            ) {
              throw new GenerationAdmissionError(409, 'generation_effect_claim_stale')
            }
            const updated = updateActiveMessageById(targetDb, currentEffect.messageId, patch)
            if (!updated.ok) throw new GenerationAdmissionError(409, 'generation_effect_target_stale')
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.messageUpdated,
                id: currentEffect.messageId,
                parentId: currentEffect.chatId,
              },
              extra: { chatId: currentEffect.chatId, messageId: currentEffect.messageId },
            }
          },
        })
        return {
          revision: result.revision,
          event: result.event,
          ...result.extra,
          effect: listGenerationEffects(db, generationId, databaseLineage).find(
            (candidate) => candidate.kind === 'igp',
          ),
        }
      } catch (error) {
        return sendEffectError(reply, error)
      }
    },
  )

  app.post<{ Params: { generationId: string } }>(
    '/api/v1/generation-effects/:generationId/igp/completion',
    { config: { rateLimit: generationSubmitRateLimit } },
    async (req, reply) => {
      if (!(await requireAuth(authState, req, reply))) return
      try {
        const generationId = requiredIdentifier(req.params.generationId, 'generationId')
        if (!isRecord(req.body)) throw new ValidationError('request body must be an object')
        if (Object.keys(req.body).some((key) => key !== 'claimId')) {
          throw new ValidationError('IGP completion contains unsupported fields')
        }
        const databaseLineage = readRequestedDatabaseLineage(req)
        assertDatabaseLineage(db, databaseLineage)
        const sessionId = readRequiredSessionId(req)
        const claimId = requiredIdentifier(req.body.claimId, 'claimId')
        const effect = listGenerationEffects(db, generationId, databaseLineage).find(
          (candidate) => candidate.kind === 'igp',
        )
        if (!effect) return reply.code(404).send({ error: 'generation_effects_not_found' })
        assertOriginatingSessionEffectIdentity(effect, sessionId)
        assertEffectControl(db, generationId, 'igp', sessionId)
        if (effect.status !== 'claimed' || effect.claimId !== claimId) {
          throw new GenerationAdmissionError(409, 'generation_effect_claim_stale')
        }

        const accepted = claimedIgpAcceptedExecution(db, effect)
        const selectedCharacterId = effect.characterId
        const selectedCharID = accepted.database.characters.findIndex(
          (character) => character.chaId === selectedCharacterId,
        )
        const currentChar = accepted.database.characters[selectedCharID]
        const chatPage = currentChar?.chats.findIndex((chat) => chat.id === effect.chatId) ?? -1
        if (selectedCharID < 0 || !currentChar || chatPage < 0) {
          throw new GenerationAdmissionError(409, 'operation_effective_configuration_invalid')
        }
        bindClaimedIgpTerminalTranscript(
          db,
          effect,
          accepted.database,
          selectedCharID,
          chatPage,
          accepted.acceptedTranscriptTail,
        )
        currentChar.chatPage = chatPage
        accepted.database.currentChar = selectedCharID
        const promptTemplate = typeof accepted.database.igpPrompt === 'string' ? accepted.database.igpPrompt : ''
        if (!promptTemplate.trim()) return { status: 'skipped', reason: 'not_configured' }
        const igpContext: ExpandContext = {
          database: accepted.database,
          selectedCharID,
          chatPage,
          chara: currentChar,
          runVar: false,
          clientContext: accepted.clientContext,
        }
        // Preserve the browser IGP parser's two expansion passes: the full
        // template can generate ChatML structure, then each parsed row expands
        // again using the same immutable accepted-operation context.
        const formated = parseChatML(expandVariables(promptTemplate, igpContext).text, igpContext)
        if (!formated) throw new ValidationError('accepted IGP prompt must be valid ChatML')

        const profile = resolveModelProfile({ database: accepted.database, role: 'emotion' })
        assertModelProfileGenerationReady(profile)
        const executionDatabase = structuredClone(accepted.database)
        applyProfileBoundGenerationFields(executionDatabase, profile)
        executionDatabase.aiModel = profile.modelId
        executionDatabase.halfStreaming = false
        executionDatabase.useStreaming = false
        if (profile.runtimeOptions.maxResponse !== undefined) {
          executionDatabase.maxResponse = profile.runtimeOptions.maxResponse
        }
        if (profile.runtimeOptions.rawTemperature !== undefined) {
          executionDatabase.temperature = profile.runtimeOptions.rawTemperature
        }

        const requestAbort = attachAbort(req, reply)
        try {
          const frames = await dispatchChatProvider({
            credentialDb: db,
            database: executionDatabase,
            formated,
            profile,
            signal: requestAbort.signal,
            currentCharacterName: currentChar.name,
          })
          const result = await collectCompletionFrames(frames)
          if (result.type === 'fail') {
            return reply.code(200).send(result)
          }
          return reply.code(200).send(result)
        } finally {
          requestAbort.cleanup()
        }
      } catch (error) {
        try {
          return sendEffectError(reply, error)
        } catch (unexpected) {
          const message = unexpected instanceof Error ? unexpected.message : String(unexpected)
          return reply.code(400).send({ error: message || 'IGP provider dispatch failed' })
        }
      }
    },
  )
}
