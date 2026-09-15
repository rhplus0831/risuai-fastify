import type { DatabaseSync } from 'node:sqlite'
import { getChatMessages } from './messageStore.js'

export interface GenerationFinalizationCommitMessage {
  role: 'user' | 'char'
  data: string
  chatId?: string
  generationInfo?: { generationId?: string }
}

export interface GenerationFinalizationCommitAttempt {
  generationId: string
  message: GenerationFinalizationCommitMessage
  targetSnapshot?: {
    kind: 'tail' | 'target-tail'
    transcriptLength: number
  }
}

interface PendingGenerationFinalizationRow {
  generation_id: string
  message_json: string
  target_snapshot_json: string | null
}

function rowMatchesMessage(row: unknown, message: GenerationFinalizationCommitMessage): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const record = row as Record<string, unknown>
  if (record.role !== message.role || record.data !== message.data) return false
  return message.chatId === undefined || record.chatId === message.chatId
}

export function generationFinalizationAlreadyCommitted(
  rows: readonly GenerationFinalizationCommitMessage[],
  attempt: GenerationFinalizationCommitAttempt,
): boolean {
  const snapshot = attempt.targetSnapshot
  if (!snapshot) {
    return rows.some(
      (row) =>
        row.generationInfo?.generationId === attempt.generationId ||
        (attempt.message.chatId !== undefined &&
          row.chatId === attempt.message.chatId &&
          rowMatchesMessage(row, attempt.message)),
    )
  }
  if (snapshot.kind === 'target-tail') {
    return (
      rows.length >= snapshot.transcriptLength &&
      rowMatchesMessage(rows[snapshot.transcriptLength - 1], attempt.message)
    )
  }
  return rows.length > snapshot.transcriptLength
    ? rowMatchesMessage(rows[snapshot.transcriptLength], attempt.message)
    : false
}

export function listUncommittedGenerationFinalizationIdsForChat(
  db: DatabaseSync,
  chatId: string,
  databaseLineage: string,
): string[] {
  const pending = db
    .prepare(
      `SELECT generation_id, message_json, target_snapshot_json
       FROM generation_finalization_retries
       WHERE chat_id = ? AND status = 'pending'
         AND (database_lineage = ? OR database_lineage IS NULL)
       ORDER BY generation_id`,
    )
    .all(chatId, databaseLineage) as unknown as PendingGenerationFinalizationRow[]
  if (pending.length === 0) return []
  const messages = getChatMessages(db, chatId) as unknown as GenerationFinalizationCommitMessage[]
  return pending.filter((row) => !pendingFinalizationAlreadyCommitted(messages, row)).map((row) => row.generation_id)
}

function pendingFinalizationAlreadyCommitted(
  messages: readonly GenerationFinalizationCommitMessage[],
  row: PendingGenerationFinalizationRow,
): boolean {
  try {
    const message = JSON.parse(row.message_json) as unknown
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      ((message as Record<string, unknown>).role !== 'user' && (message as Record<string, unknown>).role !== 'char') ||
      typeof (message as Record<string, unknown>).data !== 'string'
    ) {
      return false
    }
    let targetSnapshot: GenerationFinalizationCommitAttempt['targetSnapshot'] | undefined
    if (row.target_snapshot_json !== null) {
      const parsed = JSON.parse(row.target_snapshot_json) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        ((parsed as Record<string, unknown>).kind !== 'tail' &&
          (parsed as Record<string, unknown>).kind !== 'target-tail') ||
        !Number.isSafeInteger((parsed as Record<string, unknown>).transcriptLength) ||
        ((parsed as Record<string, unknown>).transcriptLength as number) < 0
      ) {
        return false
      }
      targetSnapshot = parsed as GenerationFinalizationCommitAttempt['targetSnapshot']
    }
    return generationFinalizationAlreadyCommitted(messages, {
      generationId: row.generation_id,
      message: message as GenerationFinalizationCommitMessage,
      ...(targetSnapshot ? { targetSnapshot } : {}),
    })
  } catch {
    return false
  }
}
