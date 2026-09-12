import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { getSchemaState } from '../db.js'
import { assertDatabaseLineage, getDatabaseLineage } from '../databaseLineage.js'
import {
  EntityNotFoundError,
  ValidationError,
  loadPersistedForChatMutation,
  loadSettingsWithTranslatorPresetsFromSqlite,
} from '../repository.js'
import { normalizeAllCharacterChats, requireChatLocation } from '../commands/chats.js'
import { COMMAND_EVENT_CATALOG, type CommandEventOrigin, type CommandEventSink } from '../commands/events.js'
import { applyTargetedCommandMutation, type CommandMutationReceiptKey } from '../commands/mutations.js'
import { getChatMessages, resolveActiveMessageLocationById, updateActiveMessageById } from '../messageStore.js'
import { createDetachedAbort } from '../requestAbort.js'
import type { MessageTranslationJobHandle, MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import { getSourceValidGreetingTranslation, selectedGreeting } from './greetingTranslationStore.js'
import {
  resolveRawMessageTranslatorIdentity,
  translateRawMessageData,
  type RawMessageTranslation,
} from './rawMessageTranslation.js'

export interface RunServerMessageTranslationInput {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  messageTranslationJobs?: MessageTranslationJobRegistry
  messageId: string
  jobId?: string
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
}

interface LiveMessageSource {
  chatId: string
  messageIndex: number
  data: string
  translation: unknown
}

function readLiveMessageSource(db: DatabaseSync, messageId: string): LiveMessageSource {
  const resolved = resolveActiveMessageLocationById(db, messageId)
  if (resolved.ok === false) {
    if (resolved.reason === 'ambiguous') {
      throw new ValidationError(`Ambiguous message id: ${messageId}`)
    }
    throw new EntityNotFoundError(`Message not found: ${messageId}`)
  }
  const data = resolved.location.message.data
  if (typeof data !== 'string') {
    throw new ValidationError(`Message data for ${messageId} must be a string`)
  }
  return {
    chatId: resolved.location.chatId,
    messageIndex: resolved.location.seq,
    data,
    translation: structuredClone(resolved.location.message.translation),
  }
}

/**
 * Runs the same detached raw-message translation used by the HTTP command and
 * server-triggered generation completion. The provider request does not hold
 * the global revision; persistence rebases synchronously and is fenced by the
 * source text, prior translation, and last-registered job handle.
 */
export async function runServerMessageTranslation(input: RunServerMessageTranslationInput) {
  const { signal, cleanup } = createDetachedAbort()
  let translationJob: MessageTranslationJobHandle | undefined
  try {
    const databaseLineage = getDatabaseLineage(input.db)
    const source = readLiveMessageSource(input.db, input.messageId)
    translationJob = input.messageTranslationJobs?.register({
      chatId: source.chatId,
      messageId: input.messageId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    })
    const settings = loadSettingsWithTranslatorPresetsFromSqlite(input.db)
    if (settings === null) {
      throw new ValidationError('database is not initialized')
    }

    const persisted = loadPersistedForChatMutation(input.db, input.dataDir, { messageId: input.messageId })
    const characters = normalizeAllCharacterChats(persisted.database)
    const { character, chat } = requireChatLocation(characters, source.chatId)
    const greeting = selectedGreeting(character, chat)
    const characterId = typeof character.chaId === 'string' ? character.chaId : ''
    const translatorIdentity = resolveRawMessageTranslatorIdentity({ settings, character, chat })
    const greetingTranslation = characterId
      ? getSourceValidGreetingTranslation(
          input.db,
          characterId,
          greeting.greetingIndex,
          translatorIdentity.settingsHash,
          greeting.source,
        )
      : null
    const translation = await translateRawMessageData({
      settings,
      character,
      chat,
      text: source.data,
      historyContext: {
        messages: getChatMessages(input.db, source.chatId),
        messageIndex: source.messageIndex,
        greeting: {
          source: greeting.source,
          ...(greetingTranslation ? { translated: greetingTranslation.text } : {}),
        },
      },
      signal,
      requestHistory: {
        db: input.db,
        context: {
          characterId,
          ...(typeof character.name === 'string' ? { characterName: character.name } : {}),
          chatId: source.chatId,
          ...(typeof chat.name === 'string' ? { chatName: chat.name } : {}),
          messageId: input.messageId,
        },
        ...(chat.generationSettings?.sidebarToggles ? { toggles: { ...chat.generationSettings.sidebarToggles } } : {}),
      },
    })

    assertDatabaseLineage(input.db, databaseLineage)
    const result = applyTargetedCommandMutation<{
      chatId: string
      messageId: string
      translation: RawMessageTranslation
    }>({
      db: input.db,
      dataDir: input.dataDir,
      // No await occurs between this read and the synchronous transaction.
      // Rebase onto the current domain revision, then reject only if the
      // target message disappeared or its source text changed below.
      baseRevision: getSchemaState(input.db).revision,
      eventSink: input.eventSink,
      ...(input.eventOrigin ? { eventOrigin: input.eventOrigin } : {}),
      ...(input.mutationReceiptKey ? { mutationReceiptKey: input.mutationReceiptKey } : {}),
      mutationPath: 'targeted-message',
      chatScopedRead: { messageId: input.messageId },
      mutate(database, targetDb) {
        const characters = normalizeAllCharacterChats(database)
        const resolved = resolveActiveMessageLocationById(targetDb, input.messageId)
        if (resolved.ok === false) {
          if (resolved.reason === 'ambiguous') {
            throw new ValidationError(`Ambiguous message id: ${input.messageId}`)
          }
          throw new EntityNotFoundError(`Message not found: ${input.messageId}`)
        }
        const { location } = resolved
        requireChatLocation(characters, location.chatId)
        if (translationJob && !translationJob.isCurrent()) {
          throw new ValidationError(`Message translation is no longer current: ${input.messageId}`)
        }
        if (location.message.data !== source.data) {
          throw new ValidationError(`Message changed before translation could be saved: ${input.messageId}`)
        }
        if (!isDeepStrictEqual(location.message.translation, source.translation)) {
          throw new ValidationError(`Message translation changed before translation could be saved: ${input.messageId}`)
        }
        const updated = updateActiveMessageById(targetDb, input.messageId, { translation })
        if (updated.ok === false) {
          if (updated.reason === 'ambiguous') {
            throw new ValidationError(`Ambiguous message id: ${input.messageId}`)
          }
          throw new EntityNotFoundError(`Message not found: ${input.messageId}`)
        }
        return {
          event: {
            ...COMMAND_EVENT_CATALOG.messageUpdated,
            id: input.messageId,
            parentId: updated.chatId,
          },
          extra: { chatId: updated.chatId, messageId: input.messageId, translation },
        }
      },
    })

    translationJob?.succeed()
    return {
      revision: result.revision,
      event: result.event,
      jobId: translationJob?.jobId ?? input.jobId,
      ...result.extra,
    }
  } catch (error) {
    translationJob?.fail(error)
    throw error
  } finally {
    cleanup()
  }
}
