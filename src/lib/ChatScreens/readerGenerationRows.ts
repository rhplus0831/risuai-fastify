import type { Message } from '../../ts/storage/database.svelte'
import type { ReaderGenerationProjection } from '../../ts/server/readerGenerationTypes'

/** A Continue target already exists before generation; its ID alone is not a handoff. */
export function isReaderGenerationResult(message: Message, projection: ReaderGenerationProjection): boolean {
  if (message.role !== 'char' || !projection.generationId) return false
  const info = message.generationInfo
  if (info?.databaseLineage !== undefined && info.databaseLineage !== projection.databaseLineage) return false
  if (info?.jobId !== undefined && info.jobId !== projection.jobId) return false
  if (info?.operationId !== undefined && info.operationId !== projection.operationId) return false
  if (info?.attemptNo !== undefined && info.attemptNo !== projection.attemptNo) return false
  if (projection.resultMessageId && message.chatId !== projection.resultMessageId) return false
  if (info?.generationId !== undefined) return info.generationId === projection.generationId
  return message.chatId === projection.generationId && message.chatId !== projection.targetMessageId
}

export function readerGenerationRow(messages: Message[], projection: ReaderGenerationProjection | null) {
  if (!projection) return null
  const append =
    projection.mode === 'send' || (projection.mode === 'continue' && projection.continueDisposition === 'append')
  const resultIndex = messages.findIndex((message) => isReaderGenerationResult(message, projection))
  const index =
    resultIndex >= 0
      ? resultIndex
      : append
        ? -1
        : messages.findIndex((message) => message.chatId === projection.targetMessageId)
  return { append, index, canonical: resultIndex >= 0 }
}

export function readerGenerationKey(projection: ReaderGenerationProjection): string {
  return `reader-generation:${projection.operationId}:attempt:${projection.attemptNo}`
}
