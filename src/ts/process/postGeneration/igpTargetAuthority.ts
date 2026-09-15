import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import type { Message, MessageGenerationInfo } from '../../storage/database.svelte'
import { safeStructuredClone } from '../../polyfill'
import type { GenerationOperationProjection } from '../../server/bootstrap'

export interface IgpContinueExtendAuthority {
  readonly kind: 'continue_extend'
  readonly operationId: string
  readonly operationAttemptNo: number
  readonly jobId: string
  readonly targetMessageId: string
  readonly resultMessageId: string
  readonly retainedGenerationInfo: MessageGenerationInfo | null
}

export interface IgpContinueExtendTargetIdentity {
  readonly characterId: string
  readonly chatId: string
  readonly messageId: string
  readonly expectedGenerationId?: string
}

export function retainedGenerationInfoMatches(message: Message, authority: IgpContinueExtendAuthority): boolean {
  return JSON.stringify(message.generationInfo ?? null) === JSON.stringify(authority.retainedGenerationInfo)
}

export function continueExtendOperationMatches(
  ref: ServerGenerationEffectLedgerRef,
  target: IgpContinueExtendTargetIdentity,
  authority: IgpContinueExtendAuthority,
  operation: GenerationOperationProjection | undefined,
): boolean {
  if (
    ref.keyType !== 'operation' ||
    target.expectedGenerationId !== undefined ||
    authority.kind !== 'continue_extend' ||
    authority.operationId !== ref.keyId ||
    !Number.isSafeInteger(authority.operationAttemptNo) ||
    authority.operationAttemptNo < 1 ||
    authority.jobId !== ref.generationId ||
    authority.targetMessageId !== target.messageId ||
    authority.resultMessageId !== target.messageId
  ) {
    return false
  }
  const attempt = operation?.currentAttempt
  return (
    operation?.operationId === authority.operationId &&
    operation.protocolVersion === 1 &&
    operation.state === 'completed' &&
    operation.mode === 'continue' &&
    operation.requestOrigin === 'continue' &&
    operation.characterId === target.characterId &&
    operation.chatId === target.chatId &&
    operation.targetMessageId === authority.targetMessageId &&
    operation.resultMessageId === authority.resultMessageId &&
    operation.generationScope?.admissionKind === 'owner_occupancy' &&
    operation.generationScope.occupancyClaimClass === 'owner' &&
    (attempt === undefined ||
      (attempt.attemptNo === authority.operationAttemptNo &&
        (attempt.finalizationGenerationId ?? attempt.jobId) === authority.jobId))
  )
}

/** Capture the only modern terminal disposition whose row intentionally does
 * not carry the current generation id. The completed operation projection and
 * effect attempt remain the authority; the assistant metadata is merely an
 * exact retained-state precondition. */
export function captureContinueExtendIgpAuthority(input: {
  ref: ServerGenerationEffectLedgerRef
  operationAttemptNo: number | undefined
  message: Message
  operation: GenerationOperationProjection | undefined
}): IgpContinueExtendAuthority | undefined {
  const { ref, operationAttemptNo, message, operation } = input
  if (
    message.role !== 'char' ||
    message.chatId !== ref.messageId ||
    message.generationInfo?.generationId === ref.generationId ||
    !Number.isSafeInteger(operationAttemptNo) ||
    operationAttemptNo === undefined ||
    operationAttemptNo < 1
  ) {
    return undefined
  }
  const authority: IgpContinueExtendAuthority = {
    kind: 'continue_extend',
    operationId: ref.keyId,
    operationAttemptNo,
    jobId: ref.generationId,
    targetMessageId: ref.messageId,
    resultMessageId: ref.messageId,
    retainedGenerationInfo: message.generationInfo === undefined ? null : safeStructuredClone(message.generationInfo),
  }
  return continueExtendOperationMatches(
    ref,
    { characterId: ref.characterId, chatId: ref.chatId, messageId: ref.messageId },
    authority,
    operation,
  )
    ? authority
    : undefined
}
