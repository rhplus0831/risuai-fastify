import type { DatabaseSync } from 'node:sqlite'
import { bumpRevision, getSchemaState } from '../db.js'
import {
  RevisionMismatchError,
  ValidationError,
  loadPersistedForCollectionMutation,
  loadPersistedForCharacterMutation,
  loadPersistedForSettingsMutation,
  loadCharacterSelectionRows,
  loadPersisted,
  loadPersistedForChatGenerationSettingsMutation,
  loadPersistedForChatMutation,
  loadPersistedWithMessages,
  replaceAllCharactersInTable,
  replaceAllCollectionsInTable,
  replaceAllSettingsInTable,
  stripChatMessages,
  syncChatMessages,
  writeCharacterSelectionRows,
  type CollectionFieldKey,
  type CharacterMutationTarget,
  type ChatGenerationSettingsMutationTarget,
  type ChatMutationTarget,
} from '../repository.js'
import {
  COMMAND_EVENT_CATALOG,
  persistCommandEvent,
  type CommandEvent,
  type CommandEventDraft,
  type CommandEventOrigin,
  type CommandEventSink,
} from './events.js'
import {
  beginTableWriteCapture,
  emitProtocolMetric,
  protocolDurationMs,
  protocolNowMs,
  takeTableWrites,
} from '../protocolMetrics.js'
import {
  loadCommandMutationReceipt,
  persistCommandMutationReceipt,
  type CommandMutationReceiptKey,
} from '../commandMutationReceipts.js'

export type { CommandMutationReceiptKey } from '../commandMutationReceipts.js'

export interface JsonCommandMutationResult<TExtra extends Record<string, unknown>> {
  revision: number
  event: CommandEvent
  extra: TExtra
}

export interface JsonCommandMutationArgs<TExtra extends Record<string, unknown>> {
  db: DatabaseSync
  dataDir: string
  baseRevision: number
  eventSink: CommandEventSink
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
  mutate: (database: unknown) => {
    event: CommandEventDraft
    extra?: TExtra
    /**
     * Optional extra SQLite writes to run INSIDE the same transaction, after the
     * active-message sync and before COMMIT — so they roll back atomically with
     * the JSON mutation + revision bump. Used for SQLite-only rows such as
     * reroll-buffer alternates.
     */
    sqlite?: (db: DatabaseSync) => void
  }
}

export interface MessageFreeJsonCommandMutationArgs<TExtra extends Record<string, unknown>> {
  db: DatabaseSync
  dataDir: string
  baseRevision: number
  eventSink: CommandEventSink
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
  mutate: (database: unknown) => {
    event: CommandEventDraft
    extra?: TExtra
  }
}

export interface TargetedCommandMutationArgs<TExtra extends Record<string, unknown>> {
  db: DatabaseSync
  dataDir: string
  baseRevision: number
  eventSink: CommandEventSink
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
  mutationPath: string
  writeDatabase?: boolean
  /**
   * For mutations that can validate and write entirely through targeted SQLite
   * reads/writers (for example appending a brand-new row), skip the broad
   * database shape load and pass `undefined` to the callback. Incompatible with
   * whole-database write-back and scoped reads.
   */
  skipDatabaseLoad?: boolean
  /**
   * Opt-in narrowed read for settings-only commands: load the single settings
   * row via `loadSettingsFromSqlite`, with broad fallback for missing or
   * legacy embedded-shape rows. Incompatible with whole-database write-back
   * and other scoped reads.
   */
  settingsScopedRead?: boolean
  /**
   * Opt-in narrowed read for collection command callbacks: load the settings
   * row plus only the requested collection field tables. Missing settings or
   * embedded non-requested corpus fields fall back to the broad loader, so
   * pre-extraction behavior remains representable. Incompatible with
   * whole-database write-back, skip-load, and other scoped reads.
   */
  collectionScopedRead?: readonly CollectionFieldKey[]
  /**
   * Opt-in narrowed read for callbacks that only locate one chat row and
   * mutate it / do kit-writer message writes load the target
   * chat row + its parent character via {@link loadPersistedForChatMutation},
   * skipping the collection tables, plugin storage, the assets scan, and the
   * sibling character/chat payload parse. Unknown ids and pre-extraction
   * states fall back to the broad `loadPersisted`, so error behavior and the
   * global dedup edge are unchanged. Incompatible with `writeDatabase` — a
   * scoped read must never be written back whole.
   */
  chatScopedRead?: ChatMutationTarget
  /**
   * Opt-in narrowed read for chat generation-settings commands: load the
   * target chat and parent character together with only the settings and
   * collection owners required for reference/module validation. Incompatible
   * with whole-database write-back, skip-load, and other scoped reads.
   */
  chatGenerationSettingsScopedRead?: ChatGenerationSettingsMutationTarget
  characterScopedRead?: CharacterMutationTarget
  mutate: (
    database: unknown,
    db: DatabaseSync,
  ) => {
    event: CommandEventDraft
    extra?: TExtra
  }
}

export interface CharacterSelectionCommandMutationArgs {
  db: DatabaseSync
  baseRevision: number
  characterId: string
  lastInteraction: number
  eventSink: CommandEventSink
  eventOrigin?: CommandEventOrigin
  mutationReceiptKey?: CommandMutationReceiptKey
}

export function readBaseRevision(body: unknown): number {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be an object')
  }
  const baseRevision = (body as { baseRevision?: unknown }).baseRevision
  if (!Number.isInteger(baseRevision) || (baseRevision as number) < 0) {
    throw new ValidationError('baseRevision must be a non-negative integer')
  }
  return baseRevision as number
}

/** Targeted mutationPath labels used by narrow SQLite command writers. */
export const TARGETED_MUTATION_PATHS = {
  settings: 'targeted-settings',
  characterRow: 'targeted-character-row',
  chatRow: 'targeted-chat-row',
  collection: 'targeted-collection',
  crossOwner: 'targeted-cross-owner',
  pluginStorage: 'targeted-plugin-storage',
  inlayCatalog: 'targeted-inlay-catalog',
  bardWiki: 'targeted-bardwiki',
} as const

export type TargetedMutationPath = (typeof TARGETED_MUTATION_PATHS)[keyof typeof TARGETED_MUTATION_PATHS]

export function applyTargetedCommandMutation<TExtra extends Record<string, unknown> = {}>(
  args: TargetedCommandMutationArgs<TExtra>,
): JsonCommandMutationResult<TExtra> {
  const scopedReadCount = [
    args.settingsScopedRead,
    args.collectionScopedRead,
    args.chatScopedRead,
    args.chatGenerationSettingsScopedRead,
    args.characterScopedRead,
  ].filter(Boolean).length
  if (scopedReadCount > 1) {
    throw new Error('scoped reads cannot be combined')
  }
  if (args.collectionScopedRead && args.collectionScopedRead.length === 0) {
    throw new Error('collectionScopedRead requires at least one field')
  }
  if (
    args.skipDatabaseLoad &&
    (args.settingsScopedRead ||
      args.collectionScopedRead ||
      args.chatScopedRead ||
      args.chatGenerationSettingsScopedRead ||
      args.characterScopedRead)
  ) {
    throw new Error('skipDatabaseLoad cannot be combined with scoped reads')
  }
  if (args.skipDatabaseLoad && args.writeDatabase) {
    throw new Error('skipDatabaseLoad cannot be combined with writeDatabase')
  }
  if (args.chatScopedRead && args.writeDatabase) {
    throw new Error('chatScopedRead cannot be combined with writeDatabase')
  }
  if (args.chatGenerationSettingsScopedRead && args.writeDatabase) {
    throw new Error('chatGenerationSettingsScopedRead cannot be combined with writeDatabase')
  }
  if (args.settingsScopedRead && args.writeDatabase) {
    throw new Error('settingsScopedRead cannot be combined with writeDatabase')
  }
  if (args.collectionScopedRead && args.writeDatabase) {
    throw new Error('collectionScopedRead cannot be combined with writeDatabase')
  }
  if (args.characterScopedRead && args.writeDatabase) {
    // A scoped read holds only part of the character/chat corpus; writing it
    // back through replaceAll* writers would delete unrelated rows.
    throw new Error('scoped reads cannot be combined with writeDatabase')
  }
  let transactionOpen = false
  const totalStartedAt = protocolNowMs()
  let loadMs = 0
  let cloneMutateMs = 0
  let sqliteSyncMs = 0
  let dbJsonWriteMs = 0
  let eventEmitMs = 0

  args.db.exec('BEGIN IMMEDIATE')
  transactionOpen = true

  try {
    const replayed = loadMutationReceipt<TExtra>(args)
    if (replayed) {
      args.db.exec('COMMIT')
      transactionOpen = false
      emitMutationReplayMetric(replayed, args.mutationPath, totalStartedAt)
      return replayed
    }

    const { revision: currentRevision } = getSchemaState(args.db)
    if (args.baseRevision !== currentRevision) {
      throw new RevisionMismatchError(currentRevision)
    }

    const loadStartedAt = protocolNowMs()
    const persisted = args.skipDatabaseLoad
      ? undefined
      : args.settingsScopedRead
        ? loadPersistedForSettingsMutation(args.db, args.dataDir)
        : args.collectionScopedRead
          ? loadPersistedForCollectionMutation(args.db, args.dataDir, args.collectionScopedRead)
          : args.chatScopedRead
            ? loadPersistedForChatMutation(args.db, args.dataDir, args.chatScopedRead)
            : args.chatGenerationSettingsScopedRead
              ? loadPersistedForChatGenerationSettingsMutation(
                  args.db,
                  args.dataDir,
                  args.chatGenerationSettingsScopedRead,
                )
              : args.characterScopedRead
                ? loadPersistedForCharacterMutation(args.db, args.dataDir, args.characterScopedRead)
                : loadPersisted(args.db, args.dataDir)
    loadMs = protocolDurationMs(loadStartedAt)

    // The callback owns its targeted SQLite writes (kit writers); capture which
    // physical tables it — and any broad fallback — actually touched.
    beginTableWriteCapture()
    const cloneMutateStartedAt = protocolNowMs()
    const mutation = args.mutate(persisted?.database, args.db)
    cloneMutateMs = protocolDurationMs(cloneMutateStartedAt)

    const sqliteSyncStartedAt = protocolNowMs()
    if (args.writeDatabase) {
      if (!persisted) {
        throw new Error('writeDatabase requires a loaded database')
      }
      stripChatMessages(persisted)
      replaceAllCharactersInTable(args.db, persisted.database)
      replaceAllCollectionsInTable(args.db, persisted.database)
      replaceAllSettingsInTable(args.db, persisted.database)
    }
    const revision = bumpRevision(args.db)
    const event: CommandEvent = { ...mutation.event, revision }
    // Persist with the writer-session origin so reconnect replay
    // keeps own-echo suppression; the returned/route event stays origin-free.
    persistCommandEvent(args.db, liveCommandEvent(event, args.eventOrigin))
    const result: JsonCommandMutationResult<TExtra> = {
      revision,
      event,
      extra: (mutation.extra ?? {}) as TExtra,
    }
    persistMutationReceipt(args, result)
    sqliteSyncMs = protocolDurationMs(sqliteSyncStartedAt)
    const writtenTables = takeTableWrites()

    args.db.exec('COMMIT')
    transactionOpen = false
    const eventEmitStartedAt = protocolNowMs()
    args.eventSink.emit(liveCommandEvent(event, args.eventOrigin))
    eventEmitMs = protocolDurationMs(eventEmitStartedAt)
    emitProtocolMetric('command_mutation', {
      type: event.type,
      resource: event.resource,
      revision,
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'ok',
      mutationPath: args.mutationPath,
      ...(writtenTables ? { writtenTables } : {}),
    })

    return result
  } catch (err) {
    if (transactionOpen) {
      args.db.exec('ROLLBACK')
    }
    takeTableWrites()
    emitProtocolMetric('command_mutation', {
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      mutationPath: args.mutationPath,
    })
    throw err
  }
}

export function applyMessageFreeJsonCommandMutation<TExtra extends Record<string, unknown> = {}>(
  args: MessageFreeJsonCommandMutationArgs<TExtra>,
): JsonCommandMutationResult<TExtra> {
  let transactionOpen = false
  const totalStartedAt = protocolNowMs()
  let loadMs = 0
  let cloneMutateMs = 0
  let sqliteSyncMs = 0
  let dbJsonWriteMs = 0
  let eventEmitMs = 0

  args.db.exec('BEGIN IMMEDIATE')
  transactionOpen = true

  try {
    const replayed = loadMutationReceipt<TExtra>(args)
    if (replayed) {
      args.db.exec('COMMIT')
      transactionOpen = false
      emitMutationReplayMetric(replayed, 'message-free', totalStartedAt)
      return replayed
    }

    const { revision: currentRevision } = getSchemaState(args.db)
    if (args.baseRevision !== currentRevision) {
      throw new RevisionMismatchError(currentRevision)
    }

    // Only use this path for commands that never inspect or mutate chat
    // messages; it intentionally reads message-free repository tables.
    const loadStartedAt = protocolNowMs()
    const persisted = loadPersisted(args.db, args.dataDir)
    loadMs = protocolDurationMs(loadStartedAt)

    const cloneMutateStartedAt = protocolNowMs()
    const mutation = args.mutate(persisted.database)
    cloneMutateMs = protocolDurationMs(cloneMutateStartedAt)

    beginTableWriteCapture()
    const sqliteSyncStartedAt = protocolNowMs()
    stripChatMessages(persisted)
    replaceAllCharactersInTable(args.db, persisted.database)
    replaceAllCollectionsInTable(args.db, persisted.database)
    replaceAllSettingsInTable(args.db, persisted.database)
    const revision = bumpRevision(args.db)
    const event: CommandEvent = { ...mutation.event, revision }
    // Persist with the writer-session origin so reconnect replay
    // keeps own-echo suppression; the returned/route event stays origin-free.
    persistCommandEvent(args.db, liveCommandEvent(event, args.eventOrigin))
    const result: JsonCommandMutationResult<TExtra> = {
      revision,
      event,
      extra: (mutation.extra ?? {}) as TExtra,
    }
    persistMutationReceipt(args, result)
    sqliteSyncMs = protocolDurationMs(sqliteSyncStartedAt)
    const writtenTables = takeTableWrites()

    args.db.exec('COMMIT')
    transactionOpen = false
    const eventEmitStartedAt = protocolNowMs()
    args.eventSink.emit(liveCommandEvent(event, args.eventOrigin))
    eventEmitMs = protocolDurationMs(eventEmitStartedAt)
    emitProtocolMetric('command_mutation', {
      type: event.type,
      resource: event.resource,
      revision,
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'ok',
      mutationPath: 'message-free',
      ...(writtenTables ? { writtenTables } : {}),
    })

    return result
  } catch (err) {
    if (transactionOpen) {
      args.db.exec('ROLLBACK')
    }
    takeTableWrites()
    emitProtocolMetric('command_mutation', {
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      mutationPath: 'message-free',
    })
    throw err
  }
}

export function applyCharacterSelectionCommandMutation(
  args: CharacterSelectionCommandMutationArgs,
): JsonCommandMutationResult<{ characterId: string }> {
  let transactionOpen = false
  const totalStartedAt = protocolNowMs()
  let loadMs = 0
  let cloneMutateMs = 0
  let sqliteSyncMs = 0
  let dbJsonWriteMs = 0
  let eventEmitMs = 0

  args.db.exec('BEGIN IMMEDIATE')
  transactionOpen = true

  try {
    const replayed = loadMutationReceipt<{ characterId: string }>(args)
    if (replayed) {
      args.db.exec('COMMIT')
      transactionOpen = false
      emitMutationReplayMetric(replayed, 'targeted-character-selection', totalStartedAt)
      return replayed
    }

    const { revision: currentRevision } = getSchemaState(args.db)
    if (args.baseRevision !== currentRevision) {
      throw new RevisionMismatchError(currentRevision)
    }

    const loadStartedAt = protocolNowMs()
    const rows = loadCharacterSelectionRows(args.db, args.characterId)
    loadMs = protocolDurationMs(loadStartedAt)

    const cloneMutateStartedAt = protocolNowMs()
    rows.character.lastInteraction = args.lastInteraction
    rows.settings.currentChar = rows.position
    cloneMutateMs = protocolDurationMs(cloneMutateStartedAt)

    beginTableWriteCapture()
    const sqliteSyncStartedAt = protocolNowMs()
    writeCharacterSelectionRows(args.db, rows)
    const revision = bumpRevision(args.db)
    const event: CommandEvent = {
      ...COMMAND_EVENT_CATALOG.characterSelected,
      id: args.characterId,
      revision,
    }
    // Persist with the writer-session origin so reconnect replay
    // keeps own-echo suppression; the returned/route event stays origin-free.
    persistCommandEvent(args.db, liveCommandEvent(event, args.eventOrigin))
    const result: JsonCommandMutationResult<{ characterId: string }> = {
      revision,
      event,
      extra: { characterId: args.characterId },
    }
    persistMutationReceipt(args, result)
    sqliteSyncMs = protocolDurationMs(sqliteSyncStartedAt)
    const writtenTables = takeTableWrites()

    args.db.exec('COMMIT')
    transactionOpen = false
    const eventEmitStartedAt = protocolNowMs()
    args.eventSink.emit(liveCommandEvent(event, args.eventOrigin))
    eventEmitMs = protocolDurationMs(eventEmitStartedAt)
    emitProtocolMetric('command_mutation', {
      type: event.type,
      resource: event.resource,
      revision,
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'ok',
      mutationPath: 'targeted-character-selection',
      ...(writtenTables ? { writtenTables } : {}),
    })

    return result
  } catch (err) {
    if (transactionOpen) {
      args.db.exec('ROLLBACK')
    }
    takeTableWrites()
    emitProtocolMetric('command_mutation', {
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      mutationPath: 'targeted-character-selection',
    })
    throw err
  }
}

export function applyJsonCommandMutation<TExtra extends Record<string, unknown> = {}>(
  args: JsonCommandMutationArgs<TExtra>,
): JsonCommandMutationResult<TExtra> {
  let transactionOpen = false
  const totalStartedAt = protocolNowMs()
  let loadMs = 0
  let cloneMutateMs = 0
  let sqliteSyncMs = 0
  let dbJsonWriteMs = 0
  let eventEmitMs = 0

  args.db.exec('BEGIN IMMEDIATE')
  transactionOpen = true

  try {
    const replayed = loadMutationReceipt<TExtra>(args)
    if (replayed) {
      args.db.exec('COMMIT')
      transactionOpen = false
      emitMutationReplayMetric(replayed, 'hydrated', totalStartedAt)
      return replayed
    }

    const { revision: currentRevision } = getSchemaState(args.db)
    if (args.baseRevision !== currentRevision) {
      throw new RevisionMismatchError(currentRevision)
    }

    // Hydrate messages so the mutate callback sees the full `chat.message[]`.
    const loadStartedAt = protocolNowMs()
    const hydrated = loadPersistedWithMessages(args.db, args.dataDir)
    loadMs = protocolDurationMs(loadStartedAt)
    const cloneMutateStartedAt = protocolNowMs()
    const nextDatabase = cloneJsonValue(hydrated.database)
    const mutation = args.mutate(nextDatabase)
    cloneMutateMs = protocolDurationMs(cloneMutateStartedAt)

    // Persist only chats whose messages changed: a message append is one row
    // insert, unrelated chats are not rewritten, and non-message commands write
    // nothing to the messages table. Repository table writes wait until COMMIT.
    beginTableWriteCapture()
    const sqliteSyncStartedAt = protocolNowMs()
    syncChatMessages(args.db, hydrated.database, nextDatabase)
    // Extra SQLite-only writes, such as the reroll buffer, commit or roll back
    // with the message sync and revision bump.
    mutation.sqlite?.(args.db)
    const messageFree = stripChatMessages({ ...hydrated, database: nextDatabase })
    replaceAllCharactersInTable(args.db, messageFree.database)
    replaceAllCollectionsInTable(args.db, messageFree.database)
    replaceAllSettingsInTable(args.db, messageFree.database)

    const revision = bumpRevision(args.db)
    const event: CommandEvent = { ...mutation.event, revision }
    // Persist with the writer-session origin so reconnect replay
    // keeps own-echo suppression; the returned/route event stays origin-free.
    persistCommandEvent(args.db, liveCommandEvent(event, args.eventOrigin))
    const result: JsonCommandMutationResult<TExtra> = {
      revision,
      event,
      extra: (mutation.extra ?? {}) as TExtra,
    }
    persistMutationReceipt(args, result)
    sqliteSyncMs = protocolDurationMs(sqliteSyncStartedAt)
    const writtenTables = takeTableWrites()

    args.db.exec('COMMIT')
    transactionOpen = false
    const eventEmitStartedAt = protocolNowMs()
    args.eventSink.emit(liveCommandEvent(event, args.eventOrigin))
    eventEmitMs = protocolDurationMs(eventEmitStartedAt)
    emitProtocolMetric('command_mutation', {
      type: event.type,
      resource: event.resource,
      revision,
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'ok',
      mutationPath: 'hydrated',
      ...(writtenTables ? { writtenTables } : {}),
    })

    return result
  } catch (err) {
    if (transactionOpen) {
      args.db.exec('ROLLBACK')
    }
    takeTableWrites()
    emitProtocolMetric('command_mutation', {
      loadMs,
      cloneMutateMs,
      sqliteSyncMs,
      dbJsonWriteMs,
      eventEmitMs,
      totalMs: protocolDurationMs(totalStartedAt),
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      mutationPath: 'hydrated',
    })
    throw err
  }
}

interface MutationReceiptArgs {
  db: DatabaseSync
  mutationReceiptKey?: CommandMutationReceiptKey
}

function loadMutationReceipt<TExtra extends Record<string, unknown>>(
  args: MutationReceiptArgs,
): JsonCommandMutationResult<TExtra> | undefined {
  if (!args.mutationReceiptKey) return undefined
  return loadCommandMutationReceipt<TExtra>(args.db, args.mutationReceiptKey)
}

function persistMutationReceipt<TExtra extends Record<string, unknown>>(
  args: MutationReceiptArgs,
  result: JsonCommandMutationResult<TExtra>,
): void {
  if (!args.mutationReceiptKey) return
  persistCommandMutationReceipt(args.db, args.mutationReceiptKey, result)
}

function emitMutationReplayMetric<TExtra extends Record<string, unknown>>(
  result: JsonCommandMutationResult<TExtra>,
  mutationPath: string,
  totalStartedAt: number,
): void {
  emitProtocolMetric('command_mutation', {
    type: result.event.type,
    resource: result.event.resource,
    revision: result.revision,
    loadMs: 0,
    cloneMutateMs: 0,
    sqliteSyncMs: 0,
    dbJsonWriteMs: 0,
    eventEmitMs: 0,
    totalMs: protocolDurationMs(totalStartedAt),
    status: 'ok',
    mutationPath,
    idempotentReplay: true,
    writtenTables: [],
  })
}

function liveCommandEvent(event: CommandEvent, origin?: CommandEventOrigin): CommandEvent {
  return origin ? { ...event, origin } : event
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}
