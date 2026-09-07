import { canUseClientWriteAccess, captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import type { BardWikiJobSummary } from '@risuai/protocol'
import { activeWriterSessionHeader, handleActiveWriterStaleResponse } from '../../server/activeWriterSession'
import { getNodeServerProxyAuth } from '../../storage/fastifyStorage'

export type ServerBardWikiJobResult =
  | { status: 'ok'; job: BardWikiJobSummary }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export function retryServerBardWikiJob(jobId: string, signal?: AbortSignal | null): Promise<ServerBardWikiJobResult> {
  return mutateBardWikiJob(`/api/v1/bardwiki/jobs/${encodeURIComponent(jobId)}/retry`, 'POST', signal)
}

export function cancelServerBardWikiJob(jobId: string, signal?: AbortSignal | null): Promise<ServerBardWikiJobResult> {
  return mutateBardWikiJob(`/api/v1/bardwiki/jobs/${encodeURIComponent(jobId)}`, 'DELETE', signal)
}

async function mutateBardWikiJob(
  path: string,
  method: 'POST' | 'DELETE',
  signal?: AbortSignal | null,
): Promise<ServerBardWikiJobResult> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  const sourceGeneration = captureClientSessionGeneration()
  let response: Response
  try {
    const auth = await getNodeServerProxyAuth()
    if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'unavailable' }
    response = await fetch(path, {
      method,
      signal: signal ?? undefined,
      headers: {
        'risu-auth': auth,
        ...activeWriterSessionHeader(),
      },
    })
  } catch (error) {
    return { status: 'error', error: `Network error: ${error instanceof Error ? error.message : String(error)}` }
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // Reduced to the status below.
  }
  if (!response.ok) {
    handleActiveWriterStaleResponse(response, body, sourceGeneration)
    return { status: 'error', error: readError(body, `HTTP ${response.status}`) }
  }
  if (!isRecord(body) || !isBardWikiJobSummary(body.job)) {
    return { status: 'error', error: 'Invalid BardWiki job response' }
  }
  return { status: 'ok', job: body.job }
}

function isBardWikiJobSummary(value: unknown): value is BardWikiJobSummary {
  if (!isRecord(value)) return false
  return (
    nonEmpty(value.id) &&
    nonEmpty(value.instanceId) &&
    nonEmpty(value.chatId) &&
    (value.receiptId === null || nonEmpty(value.receiptId)) &&
    ['apply_turn', 'reconcile_receipt', 'rebuild_chat'].includes(value.kind as string) &&
    ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(value.status as string) &&
    (value.errorCode === null || typeof value.errorCode === 'string') &&
    (value.errorSummary === null || typeof value.errorSummary === 'string') &&
    nonNegativeInteger(value.attemptCount) &&
    Number.isInteger(value.maxAttempts) &&
    (value.maxAttempts as number) > 0 &&
    (value.progressCurrent === null || nonNegativeInteger(value.progressCurrent)) &&
    (value.progressTotal === null || nonNegativeInteger(value.progressTotal)) &&
    typeof value.nextRunAt === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function readError(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}
