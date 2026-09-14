import { get, writable } from 'svelte/store'
import { captureActiveChatTarget } from '../chatCommands'
import {
  findGenerationOperationIdForTarget,
  stopChatOccupancyGeneration,
  stopGenerationOperation,
  type GenerationOperationCancellationResult,
} from '../server/generationOperations'
import { findChatGenerationActivity } from './generationActivity.svelte'
import { abortInputHookActivity } from './inputHookActivity.svelte'
import { activeGenerationJobs } from './reattach'
import { getServerChatRuntime } from './generationRuntimeBridge'

export const abortChat = writable(false)

/** Stop only the exact operation admitted by this page's occupied-chat authority. */
export function abortChatOccupancyGeneration(
  target: NonNullable<ReturnType<typeof captureActiveChatTarget>>,
): Promise<GenerationOperationCancellationResult> {
  return stopChatOccupancyGeneration(target)
}

/**
 * Route an explicit composer Stop to the exact protocol operation whenever one
 * owns the active chat. The generation viewer remains attached through the
 * canonical cancelled terminal so its persisted snapshot can be reconciled.
 */
export function abortActiveGeneration(): void {
  abortChat.set(true)
  const target = captureActiveChatTarget()
  const activity = findChatGenerationActivity(target)
  const operationId = activity?.operationId ?? findGenerationOperationIdForTarget(target)
  if (operationId) {
    void stopGenerationOperation(operationId)
    return
  }
  if (activity?.controller) {
    activity.controller.abort()
    return
  }

  if (abortInputHookActivity(target)) return

  // A bootstrap-discovered durable job can be visible for a brief moment before
  // its reattach controller is installed. Let Stop cancel that exact chat too.
  if (target?.chatId) {
    const job = get(activeGenerationJobs).find((candidate) => candidate.chatId === target.chatId)
    if (!job) return
    if (job.operationId) {
      void stopGenerationOperation(job.operationId)
      return
    }
    void getServerChatRuntime().cancelServerChatGeneration(job.jobId)
  }
}
