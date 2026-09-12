import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { getSchemaState } from '../db.js'
import { assertDatabaseLineage, getDatabaseLineage } from '../databaseLineage.js'
import { COMMAND_EVENT_CATALOG, type CommandEventOrigin, type CommandEventSink } from '../commands/events.js'
import { applyTargetedCommandMutation, type CommandMutationReceiptKey } from '../commands/mutations.js'
import type { GreetingTranslationJobHandle, GreetingTranslationJobRegistry } from '../greetingTranslationJobs.js'
import { EntityNotFoundError, ValidationError } from '../repository.js'
import { createDetachedAbort } from '../requestAbort.js'
import {
  readChatFolderId,
  readChatId,
  readStrictCharacterChatFolders,
  requireStrictChatLocation,
  selectedChatIdStrict,
  type ChatRecord,
} from '../commands/chats.js'
import { readStrictCharacterRecord, type CharacterRecord } from '../commands/characters.js'
import { ensureTranslatorPresetCollection } from '../commands/translatorPresets.js'
import { getGreetingTranslation, greetingSourceAtIndex, upsertGreetingTranslation } from './greetingTranslationStore.js'
import {
  resolveRawMessageTranslatorIdentity,
  translateRawMessageData,
  type RawMessageTranslation,
} from './rawMessageTranslation.js'

export interface RunServerGreetingTranslationInput {
  db: DatabaseSync
  dataDir: string
  eventSink: CommandEventSink
  greetingTranslationJobs?: GreetingTranslationJobRegistry
  characterId: string
  chatId: string
  greetingIndex: number
  jobId?: string
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
}

function readCharacter(db: DatabaseSync, _dataDir: string, characterId: string): CharacterRecord {
  try {
    const row = db.prepare('SELECT id, data_json FROM characters WHERE id = ?').get(characterId) as
      | { id: string; data_json: string }
      | undefined
    if (!row) throw new EntityNotFoundError(`Character not found: ${characterId}`)
    const character = readStrictCharacterRecord(JSON.parse(row.data_json), row.id)
    const chatRows = db
      .prepare('SELECT id, data_json FROM chats WHERE character_id = ? ORDER BY position')
      .all(characterId) as Array<{ id: string; data_json: string }>
    character.chats = chatRows.map(({ id, data_json }) => {
      const chat = JSON.parse(data_json) as unknown
      if (!isRecord(chat)) throw new ValidationError(`Chat row must be an object: ${id}`)
      if (chat.id !== id) throw new ValidationError(`chat.id must match chat row id: ${id}`)
      return chat as ChatRecord
    })
    readStrictCharacterChats(character)
    return character
  } catch (error) {
    if (error instanceof EntityNotFoundError) throw error
    throw new ValidationError(`Character could not be loaded: ${characterId}`)
  }
}

function readGreetingSource(character: CharacterRecord, characterId: string, greetingIndex: number): string {
  const source = greetingSourceAtIndex(character, greetingIndex)
  if (source === null) {
    throw new EntityNotFoundError(`Greeting not found: ${characterId}/${greetingIndex}`)
  }
  return source
}

function readCharacterChat(character: CharacterRecord, chatId: string): ChatRecord {
  const chat = readStrictCharacterChats(character).find((candidate) => candidate.id === chatId)
  if (!chat) throw new EntityNotFoundError(`Chat not found for character: ${chatId}`)
  return chat
}

function readStrictCharacterChats(character: CharacterRecord): ChatRecord[] {
  if (!Array.isArray(character.chats)) throw new ValidationError('character.chats must be an array')
  const folders = readStrictCharacterChatFolders(character)
  const folderIds = new Set(folders.map(({ id }) => id))
  const chats = character.chats as ChatRecord[]
  const seen = new Set<string>()
  chats.forEach((candidate, index) => {
    if (!isRecord(candidate)) throw new ValidationError(`character.chats[${index}] must be an object`)
    const id = readChatId(candidate.id, `character.chats[${index}].id`)
    if (seen.has(id)) throw new ValidationError(`Duplicate chat id: ${id}`)
    seen.add(id)
    requireStrictChatLocation([character], id)
    if (candidate.folderId !== undefined && candidate.folderId !== null) {
      const folderId = readChatFolderId(candidate.folderId, `chat ${id}.folderId`)
      if (!folderIds.has(folderId)) throw new ValidationError(`Unknown chat folder id: ${folderId}`)
    }
  })
  selectedChatIdStrict(character)
  return chats
}

function readSettingsWithTranslatorPresets(db: DatabaseSync): Record<string, unknown> | null {
  const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  if (!row) return null
  const settings = JSON.parse(row.data_json) as unknown
  if (!isRecord(settings)) throw new ValidationError('settings row must be an object')
  const presetRows = db.prepare('SELECT data_json FROM translator_presets ORDER BY position').all() as Array<{
    data_json: string
  }>
  if (presetRows.length > 0) settings.translatorPresets = presetRows.map(({ data_json }) => JSON.parse(data_json))
  ensureTranslatorPresetCollection(settings)
  return settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export async function runServerGreetingTranslation(input: RunServerGreetingTranslationInput) {
  const { signal, cleanup } = createDetachedAbort()
  let translationJob: GreetingTranslationJobHandle | undefined
  try {
    const databaseLineage = getDatabaseLineage(input.db)
    const character = readCharacter(input.db, input.dataDir, input.characterId)
    const chat = readCharacterChat(character, input.chatId)
    const source = readGreetingSource(character, input.characterId, input.greetingIndex)
    const settings = readSettingsWithTranslatorPresets(input.db)
    if (settings === null) throw new ValidationError('database is not initialized')
    const identity = resolveRawMessageTranslatorIdentity({ settings, character, chat })
    const priorRow = getGreetingTranslation(input.db, input.characterId, input.greetingIndex, identity.settingsHash)
    translationJob = input.greetingTranslationJobs?.register({
      characterId: input.characterId,
      chatId: input.chatId,
      greetingIndex: input.greetingIndex,
      settingsHash: identity.settingsHash,
      ...(input.jobId ? { jobId: input.jobId } : {}),
    })

    const translation = await translateRawMessageData({
      settings,
      character,
      chat,
      text: source,
      signal,
      requestHistory: {
        db: input.db,
        context: {
          characterId: input.characterId,
          chatId: input.chatId,
          ...(typeof character.name === 'string' ? { characterName: character.name } : {}),
        },
        metadata: { greetingIndex: input.greetingIndex },
      },
    })

    assertDatabaseLineage(input.db, databaseLineage)
    const result = applyTargetedCommandMutation<{
      characterId: string
      chatId: string
      greetingIndex: number
      settingsHash: string
      translation: RawMessageTranslation
    }>({
      db: input.db,
      dataDir: input.dataDir,
      baseRevision: getSchemaState(input.db).revision,
      eventSink: input.eventSink,
      ...(input.eventOrigin ? { eventOrigin: input.eventOrigin } : {}),
      ...(input.mutationReceiptKey ? { mutationReceiptKey: input.mutationReceiptKey } : {}),
      mutationPath: 'targeted-greeting-translation',
      skipDatabaseLoad: true,
      mutate(_database, targetDb) {
        const liveCharacter = readCharacter(targetDb, input.dataDir, input.characterId)
        readCharacterChat(liveCharacter, input.chatId)
        const liveSource = readGreetingSource(liveCharacter, input.characterId, input.greetingIndex)
        if (translationJob && !translationJob.isCurrent()) {
          throw new ValidationError(
            `Greeting translation is no longer current: ${input.characterId}/${input.greetingIndex}`,
          )
        }
        if (liveSource !== source) {
          throw new ValidationError(
            `Greeting changed before translation could be saved: ${input.characterId}/${input.greetingIndex}`,
          )
        }
        const livePriorRow = getGreetingTranslation(
          targetDb,
          input.characterId,
          input.greetingIndex,
          identity.settingsHash,
        )
        if (!isDeepStrictEqual(livePriorRow, priorRow)) {
          throw new ValidationError(
            `Greeting translation changed before translation could be saved: ${input.characterId}/${input.greetingIndex}`,
          )
        }
        upsertGreetingTranslation(targetDb, input.characterId, input.greetingIndex, translation)
        return {
          event: { ...COMMAND_EVENT_CATALOG.greetingTranslationUpdated, id: input.characterId },
          extra: {
            characterId: input.characterId,
            chatId: input.chatId,
            greetingIndex: input.greetingIndex,
            settingsHash: identity.settingsHash,
            translation,
          },
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
