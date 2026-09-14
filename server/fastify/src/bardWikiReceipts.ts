import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BardWikiConfirmationCandidate, BardWikiGlobalSettings } from '@risuai/protocol'
import {
  BardWikiValidationError,
  getBardWikiReceiptSummary,
  getBardWikiChatSettings,
  type BardWikiReceiptSummary,
} from './bardWikiRepository.js'
import { enqueueBardWikiJob, getBardWikiJob, type BardWikiJob } from './bardWikiJobs.js'
import { readBardWikiGlobalSettings, resolveEffectiveBardWikiSettings } from './bardWikiSettings.js'
import { loadSettingsFromSqlite } from './repository.js'

export const BARDWIKI_EVENT_PROMPT_VERSION = 'bardwiki-event-v1'

export interface ExplicitBardWikiConfirmationInput {
  chatId: string
  userMessageId: string
  userContentHash: string
  assistantMessageId: string
  assistantContentHash: string
}

export interface ExplicitBardWikiConfirmationResult {
  receipt: BardWikiReceiptSummary
  job: Omit<BardWikiJob, 'payload'>
  created: boolean
}

export interface AutomaticBardWikiConfirmationInput {
  chatId: string
  acceptedUserMessageId?: string
  resultAssistantMessageId: string
  fallbackMessages?: readonly unknown[]
  /** Effective settings captured with the accepted generation operation. */
  acceptedSettings?: BardWikiGlobalSettings
}

export interface BardWikiSourcePair {
  chatId: string
  userMessageId: string
  userContent: string
  userContentHash: string
  assistantMessageId: string
  assistantContent: string
  assistantContentHash: string
}

export type BardWikiRebuildPolicy = 'missing' | 'full'

/** Enumerate eligible active transcript pairs in stable oldest-first source order. */
export function listBardWikiRebuildSourcePairs(
  db: DatabaseSync,
  chatId: string,
  policy: BardWikiRebuildPolicy = 'full',
): BardWikiSourcePair[] {
  if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) {
    throw new BardWikiValidationError('bardwiki_chat_not_found')
  }
  const rows = [...listActiveMessageRows(db, chatId)].reverse()
  const pairs: BardWikiSourcePair[] = []
  let previous: ActiveMessageRow | null = null
  for (const row of rows) {
    if (isSelectionBoundary(row)) {
      if (hasAllBeforeBoundary(row)) pairs.length = 0
      previous = null
      continue
    }
    if (previous?.role === 'user' && row.role === 'char') {
      const source: BardWikiSourcePair = {
        chatId,
        userMessageId: previous.uid,
        userContent: previous.data,
        userContentHash: hashBardWikiMessageContent(previous.data),
        assistantMessageId: row.uid,
        assistantContent: row.data,
        assistantContentHash: hashBardWikiMessageContent(row.data),
      }
      if (policy === 'full' || !hasAppliedExactReceipt(db, source)) pairs.push(source)
    }
    previous = row
  }
  return pairs
}

interface ActiveMessageRow {
  seq: number
  uid: string
  role: string
  data: string
  json: string
}

export function hashBardWikiMessageContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function getCurrentBardWikiConfirmationCandidate(
  db: DatabaseSync,
  chatId: string,
): BardWikiConfirmationCandidate | null {
  const rows = listActiveMessageRows(db, chatId)
  const assistant = rows[0]
  const user = rows[1]
  if (
    !assistant ||
    !user ||
    assistant.role !== 'char' ||
    user.role !== 'user' ||
    isSelectionBoundary(assistant) ||
    isSelectionBoundary(user)
  ) {
    return null
  }
  return {
    userMessageId: user.uid,
    userContentHash: hashBardWikiMessageContent(user.data),
    assistantMessageId: assistant.uid,
    assistantContentHash: hashBardWikiMessageContent(assistant.data),
  }
}

export function resolveExplicitBardWikiSourcePair(
  db: DatabaseSync,
  input: ExplicitBardWikiConfirmationInput,
): BardWikiSourcePair {
  return resolveBardWikiSourcePair(db, input, { requireCurrentAssistant: true })
}

export function resolveBardWikiReceiptSourcePair(
  db: DatabaseSync,
  input: ExplicitBardWikiConfirmationInput,
): BardWikiSourcePair {
  return resolveBardWikiSourcePair(db, input, { requireCurrentAssistant: false })
}

function resolveBardWikiSourcePair(
  db: DatabaseSync,
  input: ExplicitBardWikiConfirmationInput,
  options: { requireCurrentAssistant: boolean },
): BardWikiSourcePair {
  if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(input.chatId)) {
    throw new BardWikiValidationError('bardwiki_chat_not_found')
  }
  const rows = listActiveMessageRows(db, input.chatId)
  const assistantIndex = options.requireCurrentAssistant
    ? 0
    : rows.findIndex((row) => row.uid === input.assistantMessageId)
  const assistant = assistantIndex < 0 ? undefined : rows[assistantIndex]
  const user = assistantIndex < 0 ? undefined : rows[assistantIndex + 1]
  if (
    !assistant ||
    !user ||
    isSelectionBoundary(assistant) ||
    isSelectionBoundary(user) ||
    assistant.role !== 'char' ||
    user.role !== 'user' ||
    assistant.uid !== input.assistantMessageId ||
    user.uid !== input.userMessageId
  ) {
    throw new BardWikiValidationError('bardwiki_source_not_active')
  }
  const userContentHash = hashBardWikiMessageContent(user.data)
  const assistantContentHash = hashBardWikiMessageContent(assistant.data)
  if (userContentHash !== input.userContentHash || assistantContentHash !== input.assistantContentHash) {
    throw new BardWikiValidationError('bardwiki_source_not_active')
  }
  return {
    chatId: input.chatId,
    userMessageId: user.uid,
    userContent: user.data,
    userContentHash,
    assistantMessageId: assistant.uid,
    assistantContent: assistant.data,
    assistantContentHash,
  }
}

export function createOrReuseExplicitBardWikiConfirmation(
  db: DatabaseSync,
  input: ExplicitBardWikiConfirmationInput,
): ExplicitBardWikiConfirmationResult {
  const source = resolveExplicitBardWikiSourcePair(db, input)
  const settings = resolveEffectiveBardWikiSettingsForChat(db, input.chatId)
  if (!settings.enabledByDefault) throw new BardWikiValidationError('bardwiki_disabled')

  return createOrReuseBardWikiConfirmationInTransaction(db, source, settings, 'explicit')
}

export function createOrReuseAutomaticBardWikiConfirmation(
  db: DatabaseSync,
  input: AutomaticBardWikiConfirmationInput,
): ExplicitBardWikiConfirmationResult | null {
  const settings = input.acceptedSettings
    ? structuredClone(input.acceptedSettings)
    : resolveEffectiveBardWikiSettingsForChat(db, input.chatId)
  if (!settings.enabledByDefault || settings.confirmationPolicy !== 'automatic') return null
  const source =
    resolveAutomaticBardWikiSourcePair(db, input) ??
    resolveAutomaticBardWikiSourcePairFromMessages(input.chatId, input.fallbackMessages, input.acceptedUserMessageId)
  if (!source) return null
  return createOrReuseBardWikiConfirmationInTransaction(db, source, settings, 'automatic')
}

export function resolveAutomaticBardWikiSourcePairFromMessages(
  chatId: string,
  messages: readonly unknown[] | undefined,
  acceptedUserMessageId?: string,
): BardWikiSourcePair | null {
  if (!messages || messages.length < 3) return null
  const acceptedUser = readActiveMessage(messages.at(-1))
  const sourceAssistant = readActiveMessage(messages.at(-2))
  const sourceUser = readActiveMessage(messages.at(-3))
  if (
    !acceptedUser ||
    !sourceAssistant ||
    !sourceUser ||
    acceptedUser.role !== 'user' ||
    (acceptedUserMessageId !== undefined && acceptedUser.uid !== acceptedUserMessageId) ||
    sourceAssistant.role !== 'char' ||
    sourceUser.role !== 'user' ||
    isSelectionBoundary(acceptedUser) ||
    isSelectionBoundary(sourceAssistant) ||
    isSelectionBoundary(sourceUser)
  ) {
    return null
  }
  return {
    chatId,
    userMessageId: sourceUser.uid,
    userContent: sourceUser.data,
    userContentHash: hashBardWikiMessageContent(sourceUser.data),
    assistantMessageId: sourceAssistant.uid,
    assistantContent: sourceAssistant.data,
    assistantContentHash: hashBardWikiMessageContent(sourceAssistant.data),
  }
}

function readActiveMessage(value: unknown): ActiveMessageRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.chatId !== 'string' ||
    record.chatId.length === 0 ||
    (record.role !== 'user' && record.role !== 'char') ||
    typeof record.data !== 'string'
  ) {
    return null
  }
  return {
    seq: 0,
    uid: record.chatId,
    role: record.role,
    data: record.data,
    json: JSON.stringify(record),
  }
}

export function resolveAutomaticBardWikiSourcePair(
  db: DatabaseSync,
  input: AutomaticBardWikiConfirmationInput,
): BardWikiSourcePair | null {
  const rows = listActiveMessageRows(db, input.chatId)
  const resultAssistant = rows[0]
  const acceptedUser = rows[1]
  const sourceAssistant = rows[2]
  const sourceUser = rows[3]
  if (
    !resultAssistant ||
    !acceptedUser ||
    !sourceAssistant ||
    !sourceUser ||
    resultAssistant.uid !== input.resultAssistantMessageId ||
    resultAssistant.role !== 'char' ||
    (input.acceptedUserMessageId !== undefined && acceptedUser.uid !== input.acceptedUserMessageId) ||
    acceptedUser.role !== 'user' ||
    sourceAssistant.role !== 'char' ||
    sourceUser.role !== 'user' ||
    isSelectionBoundary(resultAssistant) ||
    isSelectionBoundary(acceptedUser) ||
    isSelectionBoundary(sourceAssistant) ||
    isSelectionBoundary(sourceUser)
  ) {
    return null
  }
  return {
    chatId: input.chatId,
    userMessageId: sourceUser.uid,
    userContent: sourceUser.data,
    userContentHash: hashBardWikiMessageContent(sourceUser.data),
    assistantMessageId: sourceAssistant.uid,
    assistantContent: sourceAssistant.data,
    assistantContentHash: hashBardWikiMessageContent(sourceAssistant.data),
  }
}

function createOrReuseBardWikiConfirmationInTransaction(
  db: DatabaseSync,
  source: BardWikiSourcePair,
  settings: BardWikiGlobalSettings,
  confirmationMode: BardWikiReceiptSummary['confirmationMode'],
): ExplicitBardWikiConfirmationResult {
  const existing = findExactReceipt(db, source)
  if (existing) {
    const existingJob = existing.jobId ? getBardWikiJob(db, existing.jobId) : null
    if (existingJob) return { receipt: existing, job: toJobSummary(existingJob), created: false }
    if (existing.state !== 'queued') {
      throw new BardWikiValidationError('bardwiki_confirmation_inconsistent')
    }
    const repairedJob = insertApplyTurnJob(db, existing.id, source, settings, existing.confirmationMode)
    linkReceiptJob(db, existing.id, repairedJob.id)
    return {
      receipt: requireReceipt(db, existing.id),
      job: toJobSummary(repairedJob),
      created: false,
    }
  }

  const receiptId = randomUUID()
  db.prepare(
    `INSERT INTO bardwiki_turn_receipts (
      id, chat_id, user_message_id, user_content_hash, assistant_message_id,
      assistant_content_hash, confirmation_mode, state, change_set_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    receiptId,
    source.chatId,
    source.userMessageId,
    source.userContentHash,
    source.assistantMessageId,
    source.assistantContentHash,
    confirmationMode,
    randomUUID(),
  )
  const job = insertApplyTurnJob(db, receiptId, source, settings, confirmationMode)
  linkReceiptJob(db, receiptId, job.id)
  return {
    receipt: requireReceipt(db, receiptId),
    job: toJobSummary(job),
    created: true,
  }
}

function listActiveMessageRows(db: DatabaseSync, chatId: string): ActiveMessageRow[] {
  return db
    .prepare(
      `SELECT seq, uid, role, data, json
       FROM messages
       WHERE chat_id = ? AND alternate = 0
       ORDER BY seq DESC`,
    )
    .all(chatId) as unknown as ActiveMessageRow[]
}

function isSelectionBoundary(row: ActiveMessageRow): boolean {
  let message: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true
    message = parsed as Record<string, unknown>
  } catch {
    return true
  }
  return message.disabled === true || message.disabled === 'allBefore' || message.isComment === true
}

function hasAllBeforeBoundary(row: ActiveMessageRow): boolean {
  try {
    const parsed = JSON.parse(row.json) as { disabled?: unknown }
    return parsed.disabled === 'allBefore'
  } catch {
    return false
  }
}

function hasAppliedExactReceipt(db: DatabaseSync, source: BardWikiSourcePair): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM bardwiki_turn_receipts
         WHERE chat_id = ? AND user_message_id = ? AND user_content_hash = ?
           AND assistant_message_id = ? AND assistant_content_hash = ? AND state = 'applied'`,
      )
      .get(
        source.chatId,
        source.userMessageId,
        source.userContentHash,
        source.assistantMessageId,
        source.assistantContentHash,
      ) !== undefined
  )
}

export function resolveEffectiveBardWikiSettingsForChat(db: DatabaseSync, chatId: string): BardWikiGlobalSettings {
  const settings = loadSettingsFromSqlite(db)
  const global = readBardWikiGlobalSettings(
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).bardWiki
      : undefined,
  )
  return resolveEffectiveBardWikiSettings(global, getBardWikiChatSettings(db, chatId))
}

function findExactReceipt(db: DatabaseSync, source: BardWikiSourcePair): BardWikiReceiptSummary | null {
  const row = db
    .prepare(
      `SELECT id FROM bardwiki_turn_receipts
       WHERE chat_id = ? AND user_message_id = ? AND user_content_hash = ?
         AND assistant_message_id = ? AND assistant_content_hash = ?`,
    )
    .get(
      source.chatId,
      source.userMessageId,
      source.userContentHash,
      source.assistantMessageId,
      source.assistantContentHash,
    ) as { id: string } | undefined
  return row ? requireReceipt(db, row.id) : null
}

function requireReceipt(db: DatabaseSync, receiptId: string): BardWikiReceiptSummary {
  const receipt = getBardWikiReceiptSummary(db, receiptId)
  if (!receipt) throw new Error('BardWiki receipt disappeared during confirmation')
  return receipt
}

function insertApplyTurnJob(
  db: DatabaseSync,
  receiptId: string,
  source: BardWikiSourcePair,
  settings: BardWikiGlobalSettings,
  confirmationMode: BardWikiReceiptSummary['confirmationMode'],
): BardWikiJob {
  return enqueueBardWikiJob(db, {
    chatId: source.chatId,
    receiptId,
    kind: 'apply_turn',
    payload: {
      receiptId,
      expectedUserContentHash: source.userContentHash,
      expectedAssistantContentHash: source.assistantContentHash,
      modelProfileId: settings.modelProfileId,
      promptPresetId: settings.promptPresetId,
      promptVersion: BARDWIKI_EVENT_PROMPT_VERSION,
      canonicalEnabled: settings.canonicalUpdates,
      repairAttemptCount: 0,
      ...(confirmationMode === 'automatic' ? { acceptedSettings: settings } : {}),
    },
  })
}

function linkReceiptJob(db: DatabaseSync, receiptId: string, jobId: string): void {
  db.prepare(
    `UPDATE bardwiki_turn_receipts
     SET job_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND state = 'queued'`,
  ).run(jobId, receiptId)
}

function toJobSummary(job: BardWikiJob): Omit<BardWikiJob, 'payload'> {
  const { payload: _payload, ...summary } = job
  return summary
}
