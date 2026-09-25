import type { FastifyReply } from 'fastify'
import { GENERATION_REJECTION_CODES, type GenerationRejectionCode } from '@risuai/protocol/remote-diagnostics'

export const DIAGNOSTICS_PROCESS_STARTED_AT = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000))
const closedCodes: ReadonlySet<string> = new Set(GENERATION_REJECTION_CODES)
const counts = new Map<GenerationRejectionCode, number>()

/** Count each closed code once per emitted rejection, never retain rendered messages. */
export function recordGenerationRejection(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const body = payload as Record<string, unknown>
  const operation = body.operation as Record<string, unknown> | undefined
  const candidates = [body.error, body.reason, body.code, body.failureCode, operation?.failureCode]
  for (const value of new Set(candidates)) {
    if (typeof value !== 'string' || !closedCodes.has(value)) continue
    const code = value as GenerationRejectionCode
    counts.set(code, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(code) ?? 0) + 1))
  }
}

/** Shared HTTP response boundary; successful payloads without a rejection code do not increment. */
export function sendGenerationResponse(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  recordGenerationRejection(body)
  return reply.code(status).send(body)
}

export function generationRejectionSnapshot() {
  return { sinceStartedAt: DIAGNOSTICS_PROCESS_STARTED_AT, byCode: Object.fromEntries(counts) }
}
