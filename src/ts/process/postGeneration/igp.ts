import { captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import { cloneJsonValue, dispatchUpdateMessageScoped, type ChatScopedSnapshot } from '../../chatCommands'
import { parseChatML } from '../../parser/chatML'
import { requestChatData } from '../request/request'
import { risuChatParser } from '../scripts'
import { resolveStablePostGenerationMessage, stablePostGenerationMessageTarget } from './stableTarget'
import type { Database } from '../../storage/database.svelte'
import type { IgpEffectMessageClaim } from '../../server/commands'

export interface IgpMessageTarget {
  characterId: string
  chatId: string
  messageId: string
  expectedData: string
  expectedGenerationId?: string
}

export interface EvaluateIgpOptions {
  /** A recovered effect has its own ready chat/model resource view. */
  database?: Database
  /** Bind a ledgered append to its lease so persistence also completes the effect. */
  igpEffect?: IgpEffectMessageClaim
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
  if (
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

export async function evaluateIgp(opts: EvaluateIgpOptions): Promise<boolean> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = opts.isCurrent ?? (() => isClientWriteOperationCurrent(sourceGeneration))
  if (!isCurrent()) return false

  const parsed = risuChatParser(opts.promptTemplate ?? '')
  if (!parsed) return false
  const formated = parseChatML(parsed)
  const rq = await requestChatData(
    { formated, bias: {}, ...(opts.database ? { database: opts.database } : {}) },
    'emotion',
    opts.abortSignal,
  )
  if (!isCurrent() || opts.abortSignal.aborted) return false
  // Provider failures are diagnostics, never assistant text or a completed
  // append. The ledger owns recording this failed execution.
  if (rq.type === 'fail') throw new Error(rq.result)
  const appended = formatIgpAppendPayload(rq)
  const previous = captureIgpTargetSnapshot(opts.target)
  if (!previous) return false
  const outcome = dispatchUpdateMessageScoped(
    opts.target.messageId,
    { data: opts.target.expectedData + appended },
    previous,
    {
      expectedData: opts.target.expectedData,
      expectedChatId: opts.target.chatId,
      expectedGenerationId: opts.target.expectedGenerationId,
      igpEffect: opts.igpEffect,
    },
  )
  if (!outcome) return false
  if (!opts.waitForPersistence) {
    void outcome
    return true
  }
  const result = await outcome
  if (result.status === 'accepted') return true
  if (result.status === 'queued') return (await result.settlement).status === 'accepted'
  return false
}
