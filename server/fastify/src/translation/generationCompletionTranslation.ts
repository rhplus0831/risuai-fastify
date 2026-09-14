import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeAllCharacterChats, requireChatLocation } from '../commands/chats.js'
import type { CommandEventSink } from '../commands/events.js'
import { safeTranslationError, type MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import { resolveActiveMessageLocationById } from '../messageStore.js'
import {
  chatCompletionNotificationSettingEnabled,
  type ChatCompletionNotificationContext,
  type PushNotificationService,
} from '../pushNotifications.js'
import { loadPersistedForChatMutation, loadSettingsFromSqlite } from '../repository.js'
import type { PostGenerationTranslationFrame } from '../prompt/sseEvents.js'
import type { AcceptedEffectiveGenerationConfiguration } from '../prompt/assemble.js'
import { isServerAutoTranslationEligible } from './serverAutoTranslationEligibility.js'
import { runServerMessageTranslation, type RunServerMessageTranslationInput } from './serverMessageTranslation.js'

export const DEFAULT_AUTO_TRANSLATE_NOTIFICATION_DEFER_CAP_SECONDS = 180

export type ServerMessageTranslationRunner = (
  input: RunServerMessageTranslationInput,
) => Promise<Awaited<ReturnType<typeof runServerMessageTranslation>>>

export interface GeneratedChatCompletionInput {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  messageTranslationJobs: MessageTranslationJobRegistry
  messageId: string
  chatId: string
  characterId?: string
  completedAt?: number
  /** Immutable server-derived configuration captured with the accepted attempt. */
  acceptedEffectiveConfiguration?: AcceptedEffectiveGenerationConfiguration
  pushNotifications?: false | PushNotificationService
  runMessageTranslation?: ServerMessageTranslationRunner
  onTranslationStarted?: (input: { chatId: string; messageId: string; jobId: string }) => void
  assertWriteAllowed?: RunServerMessageTranslationInput['assertWriteAllowed']
}

export interface GeneratedChatCompletionFollowup {
  translationStarted: boolean
  /** The provider/persistence promise remains live when the cap wins the race. */
  translation?: ReturnType<ServerMessageTranslationRunner>
  notification: 'immediate' | 'deferred' | 'disabled'
  frame?: PostGenerationTranslationFrame
  /** Latest command revision when the translation persisted before frame release. */
  revision?: number
}

export function autoTranslateNotificationDeferCapSeconds(settings: Record<string, unknown>): number {
  const raw = settings.autoTranslateNotificationDeferCapSeconds
  if (raw === undefined) return DEFAULT_AUTO_TRANSLATE_NOTIFICATION_DEFER_CAP_SECONDS
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_AUTO_TRANSLATE_NOTIFICATION_DEFER_CAP_SECONDS
  }
  return Math.floor(raw)
}

function notifyChatCompletion(
  pushNotifications: false | PushNotificationService | undefined,
  context: ChatCompletionNotificationContext,
): void {
  if (!pushNotifications) return
  void pushNotifications.sendChatCompletionNotification(context).catch(() => {
    // Best-effort: failed push delivery must not affect completion follow-up.
  })
}

function generatedMessageIsEligible(input: GeneratedChatCompletionInput, settings: Record<string, unknown>): boolean {
  const resolved = resolveActiveMessageLocationById(input.db, input.messageId)
  if (resolved.ok === false || resolved.location.chatId !== input.chatId) return false
  const database = input.acceptedEffectiveConfiguration
    ? structuredClone(input.acceptedEffectiveConfiguration.database)
    : loadPersistedForChatMutation(input.db, input.dataDir, { messageId: input.messageId }).database
  const characters = normalizeAllCharacterChats(database)
  const { chat } = requireChatLocation(characters, input.chatId)
  return isServerAutoTranslationEligible({
    chatAutoTranslate: chat.autoTranslate,
    messageText: resolved.location.message.data,
    translator: settings.translator,
    translatorType: settings.translatorType,
    autoTranslateCachedOnly: settings.autoTranslateCachedOnly,
  })
}

/**
 * Starts the server-owned automatic translation after generation persistence,
 * then holds completion until translation settles or the configured cap wins.
 * Notification delivery shares that same first-settlement latch. A capped job
 * remains detached and retains the normal translation-job token fence.
 */
export async function handleGeneratedChatCompletion(
  input: GeneratedChatCompletionInput,
): Promise<GeneratedChatCompletionFollowup> {
  const context = { characterId: input.characterId, chatId: input.chatId }
  const notificationsEnabled = !!input.pushNotifications && chatCompletionNotificationSettingEnabled(input.db)
  let settings: Record<string, unknown> | null = null
  let eligible = false
  try {
    settings = input.acceptedEffectiveConfiguration
      ? input.acceptedEffectiveConfiguration.translationSettings
        ? {
            ...(structuredClone(input.acceptedEffectiveConfiguration.database) as unknown as Record<string, unknown>),
            ...structuredClone(input.acceptedEffectiveConfiguration.translationSettings),
          }
        : null
      : loadSettingsFromSqlite(input.db)
    eligible = settings !== null && generatedMessageIsEligible(input, settings)
  } catch {
    eligible = false
  }

  if (!eligible || !settings) {
    if (notificationsEnabled) notifyChatCompletion(input.pushNotifications, context)
    return {
      translationStarted: false,
      notification: notificationsEnabled ? 'immediate' : 'disabled',
    }
  }

  const jobId = randomUUID()
  const runTranslation = input.runMessageTranslation ?? runServerMessageTranslation
  let translation: ReturnType<ServerMessageTranslationRunner>
  try {
    translation = runTranslation({
      db: input.db,
      dataDir: input.dataDir,
      eventSink: input.eventSink,
      messageTranslationJobs: input.messageTranslationJobs,
      messageId: input.messageId,
      jobId,
      ...(input.acceptedEffectiveConfiguration
        ? { acceptedEffectiveConfiguration: input.acceptedEffectiveConfiguration }
        : {}),
      ...(input.assertWriteAllowed ? { assertWriteAllowed: input.assertWriteAllowed } : {}),
    })
  } catch (error) {
    if (notificationsEnabled) notifyChatCompletion(input.pushNotifications, context)
    return {
      translationStarted: true,
      notification: notificationsEnabled ? 'deferred' : 'disabled',
      frame: { status: 'failed', jobId, error: safeTranslationError(error) },
    }
  }
  input.onTranslationStarted?.({ chatId: input.chatId, messageId: input.messageId, jobId })

  let notificationSent = false
  let capTimer: ReturnType<typeof setTimeout> | undefined
  const notifyOnce = (): void => {
    if (!notificationsEnabled || notificationSent) return
    notificationSent = true
    if (capTimer) clearTimeout(capTimer)
    notifyChatCompletion(input.pushNotifications, context)
  }
  const settled = translation.then(
    (result) => ({ kind: 'succeeded' as const, result }),
    (error) => ({ kind: 'failed' as const, error }),
  )
  void settled.then(notifyOnce)

  const capSeconds = autoTranslateNotificationDeferCapSeconds(settings)
  const capped =
    capSeconds > 0
      ? new Promise<{ kind: 'running' }>((resolve) => {
          const elapsedMs = Math.max(0, Date.now() - (input.completedAt ?? Date.now()))
          capTimer = setTimeout(
            () => {
              notifyOnce()
              resolve({ kind: 'running' })
            },
            Math.max(0, capSeconds * 1000 - elapsedMs),
          )
          capTimer.unref?.()
        })
      : null
  const outcome = capped ? await Promise.race([settled, capped]) : await settled
  if (outcome.kind !== 'running' && capTimer) clearTimeout(capTimer)

  const frame: PostGenerationTranslationFrame =
    outcome.kind === 'succeeded'
      ? { status: 'succeeded', jobId, translation: outcome.result.translation }
      : outcome.kind === 'failed'
        ? { status: 'failed', jobId, error: safeTranslationError(outcome.error) }
        : { status: 'running', jobId }

  return {
    translationStarted: true,
    translation,
    notification: notificationsEnabled ? 'deferred' : 'disabled',
    frame,
    ...(outcome.kind === 'succeeded' ? { revision: outcome.result.revision } : {}),
  }
}
