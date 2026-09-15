import { captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import { cloneJsonValue, dispatchUpdateMessageScoped, type ChatScopedSnapshot } from '../../chatCommands'
import { parseChatML } from '../../parser/chatML'
import { requestChatData } from '../request/request'
import { risuChatParser } from '../scripts'
import { resolveStablePostGenerationMessage, stablePostGenerationMessageTarget } from './stableTarget'
import type { Database } from '../../storage/database.svelte'
import type { IgpEffectMessageClaim } from '../../server/commands'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import { isClientChatOccupancyAuthorityCurrent, type ClientChatOccupancyAuthority } from '../../server/chatOccupancy'
import { get } from 'svelte/store'
import { generationOperationProjections } from '../../server/generationOperations'
import { commitClaimedIgpEffect, executeClaimedIgpEffect } from '../generationEffectLedger'
import {
  continueExtendOperationMatches,
  retainedGenerationInfoMatches,
  type IgpContinueExtendAuthority,
} from './igpTargetAuthority'

export interface IgpMessageTarget {
  characterId: string
  chatId: string
  messageId: string
  expectedData: string
  expectedGenerationId?: string
  /**
   * Continue-extend deliberately preserves the accepted assistant's generation
   * metadata. This binding authenticates the current operation independently
   * and snapshots the retained metadata so a same-text row replacement cannot
   * receive the accepted provider result.
   */
  continueExtendAuthority?: IgpContinueExtendAuthority
}

export interface EvaluateIgpOptions {
  /** A recovered effect has its own ready chat/model resource view. */
  database?: Database
  /** Bind a ledgered append to its lease so persistence also completes the effect. */
  igpEffect?: IgpEffectMessageClaim
  /** Exact effect ledger identity used by the scoped atomic IGP route. */
  effectLedgerRef?: ServerGenerationEffectLedgerRef
  /** Accepted operation authority; never inferred from a newer occupancy tuple. */
  chatOccupancyAuthority?: ClientChatOccupancyAuthority
  isCurrent?: () => boolean
  promptTemplate: string
  abortSignal: AbortSignal
  /** A ledger receipt is terminal only after the durable message command settles. */
  waitForPersistence?: boolean
  /**
   * Stable post-terminal row identity for server-backed generations. IGP only
   * appends while this exact derived text is still current, and carries the
   * same conditions into the durable message command.
   */
  target: IgpMessageTarget
}

function formatIgpAppendPayload(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'result' in value) {
    return formatIgpAppendPayload((value as { result?: unknown }).result)
  }
  if (value === null || value === undefined) return ''
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // Fall through to String for non-serializable objects.
  }
  return String(value)
}

function captureIgpTargetSnapshot(target: IgpMessageTarget): ChatScopedSnapshot | undefined {
  const messageTarget = stablePostGenerationMessageTarget(target.characterId, target.chatId, target.messageId)
  const resolution = resolveStablePostGenerationMessage(messageTarget)
  if (!resolution || resolution.message.data !== target.expectedData) return undefined
  const message = resolution.message
  if (target.continueExtendAuthority) {
    if (!retainedGenerationInfoMatches(message, target.continueExtendAuthority)) return undefined
  } else if (
    target.expectedGenerationId !== undefined &&
    message.generationInfo?.generationId !== target.expectedGenerationId
  ) {
    return undefined
  }

  return {
    selectedCharID: resolution.characterIndex,
    characterId: target.characterId,
    chatId: target.chatId,
    chat: cloneJsonValue(resolution.chat),
  }
}

function occupancyIgpOriginIsCurrent(
  ref: ServerGenerationEffectLedgerRef,
  target: IgpMessageTarget,
  authority: ClientChatOccupancyAuthority,
): boolean {
  if (
    ref.keyType !== 'operation' ||
    ref.keyId.length === 0 ||
    ref.databaseLineage !== authority.databaseLineage ||
    ref.characterId !== target.characterId ||
    ref.chatId !== target.chatId ||
    ref.messageId !== target.messageId ||
    !isClientChatOccupancyAuthorityCurrent(authority)
  ) {
    return false
  }
  const operation = get(generationOperationProjections).find((candidate) => candidate.operationId === ref.keyId)
  const scope = operation?.generationScope
  const currentAttemptGenerationId =
    operation?.currentAttempt?.finalizationGenerationId ?? operation?.currentAttempt?.jobId
  const persistedTerminal = resolveStablePostGenerationMessage(
    stablePostGenerationMessageTarget(target.characterId, target.chatId, target.messageId),
  )
  const persistedGenerationInfo = persistedTerminal?.message.generationInfo
  const completedTerminalIdentityMatches =
    operation?.state === 'completed' &&
    persistedTerminal?.message.role === 'char' &&
    persistedTerminal.message.data === target.expectedData &&
    persistedGenerationInfo?.databaseLineage === ref.databaseLineage &&
    persistedGenerationInfo.operationId === ref.keyId &&
    Number.isSafeInteger(persistedGenerationInfo.attemptNo) &&
    persistedGenerationInfo.attemptNo! > 0 &&
    persistedGenerationInfo.jobId === ref.generationId &&
    persistedGenerationInfo.generationId === ref.generationId &&
    persistedGenerationInfo.effectLedgerKeyType === ref.keyType &&
    persistedGenerationInfo.effectLedgerKeyId === ref.keyId &&
    persistedGenerationInfo.effectLedgerCharacterId === ref.characterId &&
    persistedGenerationInfo.effectLedgerChatId === ref.chatId
  const retainedContinueIdentityMatches =
    target.continueExtendAuthority !== undefined &&
    persistedTerminal?.message.role === 'char' &&
    persistedTerminal.message.data === target.expectedData &&
    retainedGenerationInfoMatches(persistedTerminal.message, target.continueExtendAuthority) &&
    continueExtendOperationMatches(ref, target, target.continueExtendAuthority, operation)
  return (
    operation !== undefined &&
    operation.requestOrigin !== 'unbound' &&
    operation.requestOrigin !== 'legacy' &&
    operation.creatorWriterSessionId === authority.sessionId &&
    operation.characterId === ref.characterId &&
    operation.chatId === ref.chatId &&
    operation.resultMessageId === ref.messageId &&
    ((target.expectedGenerationId === ref.generationId &&
      (currentAttemptGenerationId === ref.generationId || completedTerminalIdentityMatches)) ||
      retainedContinueIdentityMatches) &&
    scope !== undefined &&
    scope.admissionKind !== 'legacy_owner' &&
    scope.occupancyDatabaseLineage === authority.databaseLineage &&
    scope.occupancySessionId === authority.sessionId &&
    scope.occupancyEpoch === authority.occupancyEpoch &&
    ((scope.admissionKind === 'owner_occupancy' && scope.occupancyClaimClass === 'owner') ||
      (scope.admissionKind === 'chat_only' && scope.occupancyClaimClass === 'chat_only')) &&
    scope.permissionScopeVersion === 1
  )
}

function applyAcceptedIgpData(target: IgpMessageTarget, data: string): boolean {
  const resolved = resolveStablePostGenerationMessage(
    stablePostGenerationMessageTarget(target.characterId, target.chatId, target.messageId),
  )
  if (!resolved) return false
  if (target.continueExtendAuthority) {
    if (!retainedGenerationInfoMatches(resolved.message, target.continueExtendAuthority)) return false
  } else if (
    target.expectedGenerationId !== undefined &&
    resolved.message.generationInfo?.generationId !== target.expectedGenerationId
  ) {
    return false
  }
  if (resolved.message.data === data) return true
  if (resolved.message.data !== target.expectedData) return false
  resolved.message.data = data
  return true
}

export type EvaluateIgpOutcome = 'updated' | 'not_configured' | 'target_changed'

export async function evaluateIgpOutcome(opts: EvaluateIgpOptions): Promise<EvaluateIgpOutcome> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = opts.isCurrent ?? (() => isClientWriteOperationCurrent(sourceGeneration))
  if (!isCurrent()) return 'target_changed'

  let rq: Awaited<ReturnType<typeof requestChatData>>
  if (opts.igpEffect && opts.effectLedgerRef && opts.chatOccupancyAuthority) {
    if (!occupancyIgpOriginIsCurrent(opts.effectLedgerRef, opts.target, opts.chatOccupancyAuthority)) {
      return 'target_changed'
    }
    const execution = await executeClaimedIgpEffect(
      opts.effectLedgerRef,
      opts.igpEffect,
      opts.chatOccupancyAuthority,
      opts.abortSignal,
    )
    if (execution.status === 'skipped') return execution.reason
    rq = { type: 'success' as const, result: execution.result }
  } else {
    const parsed = risuChatParser(opts.promptTemplate ?? '', opts.database ? { db: opts.database } : undefined)
    if (!parsed) return 'not_configured'
    const formated = parseChatML(parsed, (content) =>
      risuChatParser(content, opts.database ? { db: opts.database } : undefined),
    )
    rq = await requestChatData(
      { formated, bias: {}, ...(opts.database ? { database: opts.database } : {}) },
      'emotion',
      opts.abortSignal,
    )
  }
  if (!isCurrent() || opts.abortSignal.aborted) return 'target_changed'
  // Provider failures are diagnostics, never assistant text or a completed
  // append. The ledger owns recording this failed execution.
  if (rq.type === 'fail') throw new Error(rq.result)
  const appended = formatIgpAppendPayload(rq)
  const previous = captureIgpTargetSnapshot(opts.target)
  if (!previous) return 'target_changed'
  const committedData = opts.target.expectedData + appended
  if (opts.igpEffect && opts.effectLedgerRef && opts.chatOccupancyAuthority) {
    if (!occupancyIgpOriginIsCurrent(opts.effectLedgerRef, opts.target, opts.chatOccupancyAuthority)) {
      return 'target_changed'
    }
    const commit = await commitClaimedIgpEffect(
      opts.effectLedgerRef,
      opts.igpEffect,
      opts.chatOccupancyAuthority,
      {
        data: committedData,
        expectedData: opts.target.expectedData,
        expectedGenerationId: opts.effectLedgerRef.generationId,
      },
      opts.abortSignal,
    )
    if (commit === 'target_stale') return 'target_changed'
    // An ambiguous response deliberately completes through the same-claim
    // receipt. If the commit landed that receipt proves it; otherwise the
    // claimed effect remains recoverable without repainting unconfirmed data.
    if (commit !== 'accepted') return 'updated'
    if (
      !isCurrent() ||
      !occupancyIgpOriginIsCurrent(opts.effectLedgerRef, opts.target, opts.chatOccupancyAuthority) ||
      !applyAcceptedIgpData(opts.target, committedData)
    ) {
      return 'target_changed'
    }
    return 'updated'
  }
  const outcome = dispatchUpdateMessageScoped(opts.target.messageId, { data: committedData }, previous, {
    expectedData: opts.target.expectedData,
    expectedChatId: opts.target.chatId,
    expectedGenerationId: opts.target.expectedGenerationId,
    igpEffect: opts.igpEffect,
  })
  if (!outcome) return 'target_changed'
  if (!opts.waitForPersistence) {
    void outcome
    return 'updated'
  }
  const result = await outcome
  if (result.status === 'accepted') return 'updated'
  if (result.status === 'queued') {
    return (await result.settlement).status === 'accepted' ? 'updated' : 'target_changed'
  }
  return 'target_changed'
}

export async function evaluateIgp(opts: EvaluateIgpOptions): Promise<boolean> {
  return (await evaluateIgpOutcome(opts)) === 'updated'
}
