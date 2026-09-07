import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../../clientSession'
import { type character, type Database, type MessageGenerationInfo } from '../../storage/database.svelte'
import { settingsResourceState } from '../../server/resourceState.svelte'
import { loadAndTrimCharEmotion } from './charEmotionStore'
import { applyEmotionFromResponse } from './emotionFromResponse'
import { runEmotionEmbeddingFallback } from './emotionFallbackEmbedding'
import { runEmotionLlmFallback } from './emotionFallbackLlm'
import { runImggenStableDiff } from './imggenStableDiff'
import { fireDesktopNotification, type DesktopNotificationInput } from './notification'
import { finalizeStage4, type StageTimings } from './stage4Finalize'
import type { DispatchSuccessReq } from '../dispatch/dispatchRequest'
import type { StablePostGenerationMessageTarget } from './stableTarget'
import type { ServerGenerationEffectLedgerRef } from '@risuai/protocol/generation-sse'
import {
  completedGenerationEffect,
  runLedgeredGenerationEffect,
  skippedGenerationEffect,
} from '../generationEffectLedger'
import { yieldBeforeCompletionEffect } from '../completionEffectScheduling'

export type RunStage4Result = { status: 'resend' } | { status: 'done' }

export interface RunStage4Args {
  database: Database
  req: DispatchSuccessReq
  currentChar: character
  result: string
  resendChat: boolean
  emoChanged: boolean
  abortSignal: AbortSignal
  target: StablePostGenerationMessageTarget | null
  /** Mutated: `stage3Duration`, `stage4Start`, `stage4Duration` written. */
  stageTimings: StageTimings
  /** Mutated: `stageTiming.stage3` written before stage 4 starts; `finalizeStage4` later writes all four stages. */
  generationInfo: MessageGenerationInfo
  throwError: (msg: string) => void
  setProcessStage: (n: number) => void
  effectLedger?: ServerGenerationEffectLedgerRef
  effectDelivery?: 'live_terminal' | 'late_recovery'
}

/**
 * Run the stage-4 closeout: write stage 3 duration into `generationInfo`,
 * transition to stage 4, then either resend (delegating the recursive
 * `sendChat` call back to the coordinator), drive the
 * notification / provider-emotion / emotion-fallback / imggen routing, or
 * finalize stage 4 cleanly.
 *
 * The discriminated-union return lets `resend` ask the coordinator to release
 * the chat-keyed activity lease and recurse into `sendChat` (the helper avoids the
 * circular import that direct recursion would
 * introduce); `done` means the helper has already called `finalizeStage4`
 * (default path) or intentionally skipped it (emotion-fallback paths,
 * preserving production behavior verbatim).
 */
export async function runStage4(args: RunStage4Args): Promise<RunStage4Result> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientSessionGenerationCurrent(sourceGeneration) && canUseClientWriteAccess()
  if (!isCurrent()) return { status: 'done' }
  const {
    req,
    currentChar,
    result,
    resendChat,
    abortSignal,
    target,
    stageTimings,
    generationInfo,
    throwError,
    setProcessStage,
  } = args
  let emoChanged = args.emoChanged

  stageTimings.stage3Duration = Date.now() - stageTimings.stage3Start

  if (generationInfo.stageTiming) {
    generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
  }
  setProcessStage(4)
  stageTimings.stage4Start = Date.now()

  if (resendChat) {
    await Promise.all([
      runLedgeredGenerationEffect(args.effectLedger, 'notification', args.effectDelivery ?? 'live_terminal', () =>
        skippedGenerationEffect('resend'),
      ),
      runLedgeredGenerationEffect(
        args.effectLedger,
        'emotion_image_state',
        args.effectDelivery ?? 'live_terminal',
        () => skippedGenerationEffect('resend', false),
      ),
    ])
    if (!isCurrent()) return { status: 'done' }
    finalizeStage4({ stageTimings, generationInfo, target })
    return { status: 'resend' }
  }

  await runLedgeredGenerationEffect(
    args.effectLedger,
    'notification',
    args.effectDelivery ?? 'live_terminal',
    async (effectContext) => {
      if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed')
      if (
        settingsResourceState.status !== 'ready' ||
        !(settingsResourceState.value as Record<string, unknown>).notification
      ) {
        return skippedGenerationEffect('not_configured')
      }
      await fireDesktopNotification(chatCompletionNotificationInput(currentChar, result))
      return completedGenerationEffect(undefined)
    },
  )

  if (!isCurrent()) return { status: 'done' }
  if (
    !currentChar.inlayViewScreen &&
    !abortSignal.aborted &&
    (currentChar.viewScreen === 'emotion' || currentChar.viewScreen === 'imggen')
  ) {
    await yieldBeforeCompletionEffect()
  }
  if (!isCurrent()) return { status: 'done' }
  const stateEffect = await runLedgeredGenerationEffect(
    args.effectLedger,
    'emotion_image_state',
    args.effectDelivery ?? 'live_terminal',
    async (effectContext) => {
      if (!isCurrent() || !effectContext.isCurrent()) return skippedGenerationEffect('writer_session_changed', false)
      if (req.special && applyEmotionFromResponse({ emotion: req.special.emotion, currentChar })) {
        emoChanged = true
      }

      if (currentChar.inlayViewScreen || abortSignal.aborted) {
        return skippedGenerationEffect('current_state_not_applicable', false)
      }
      if (currentChar.viewScreen === 'emotion' && !emoChanged) {
        const { tempEmotion, charemotions } = loadAndTrimCharEmotion(currentChar.chaId)

        if (
          settingsResourceState.status === 'ready' &&
          (settingsResourceState.value as Record<string, unknown>).emotionProcesser === 'embedding'
        ) {
          await runEmotionEmbeddingFallback({
            isCurrent: effectContext.isCurrent,
            result,
            currentChar,
            tempEmotion,
            charemotions,
          })
          return completedGenerationEffect(true)
        }

        await runEmotionLlmFallback({
          isCurrent: effectContext.isCurrent,
          database: args.database,
          result,
          currentChar,
          abortSignal: AbortSignal.any([abortSignal, effectContext.signal]),
          throwError,
          emotionPrompt2:
            settingsResourceState.status === 'ready'
              ? ((settingsResourceState.value as Record<string, unknown>).emotionPrompt2 as string | undefined)
              : undefined,
          tempEmotion,
          charemotions,
        })
        return completedGenerationEffect(true)
      }
      if (currentChar.viewScreen === 'imggen') {
        await runImggenStableDiff({
          currentChar,
          target,
          abortSignal: AbortSignal.any([abortSignal, effectContext.signal]),
        })
        return completedGenerationEffect(false)
      }
      return skippedGenerationEffect('current_state_not_applicable', false)
    },
  )
  if (!isCurrent()) return { status: 'done' }
  if (stateEffect.value === true) return { status: 'done' }

  finalizeStage4({ stageTimings, generationInfo, target })
  return { status: 'done' }
}

function chatCompletionNotificationInput(currentChar: character, defaultBody: string): DesktopNotificationInput {
  const customBody = currentChar.customNotificationMessage?.trim()
  const customIcon = currentChar.notificationImage?.trim()
  return {
    body: customBody || defaultBody,
    ...(customIcon || currentChar.image ? { icon: customIcon || currentChar.image } : {}),
  }
}
