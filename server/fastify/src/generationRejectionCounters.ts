import type { FastifyReply } from 'fastify'
import { recordDiagnosticEvent } from './diagnosticContext.js'
import { GENERATION_REJECTION_CODES, type GenerationRejectionCode } from '@risuai/protocol/remote-diagnostics'

export const DIAGNOSTICS_PROCESS_STARTED_AT = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000))
const closedCodes: ReadonlySet<string> = new Set(GENERATION_REJECTION_CODES)
const counts = new Map<GenerationRejectionCode, number>()

/** Shared closed-code detection for counters and journal facts; never inspect rendered messages. */
export function generationRejectionCodes(payload: unknown): GenerationRejectionCode[] {
  try {
    if (!payload || typeof payload !== 'object') return []
    const body = payload as Record<string, unknown>
    const operation = body.operation as Record<string, unknown> | undefined
    const candidates = [body.error, body.reason, body.code, body.failureCode, operation?.failureCode]
    return [...new Set(candidates)].filter(
      (value): value is GenerationRejectionCode => typeof value === 'string' && closedCodes.has(value),
    )
  } catch {
    return []
  }
}

/** Count each closed code once per emitted rejection, never retain rendered messages. */
export function recordGenerationRejection(payload: unknown): void {
  for (const code of generationRejectionCodes(payload)) {
    counts.set(code, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(code) ?? 0) + 1))
  }
}

/** Shared HTTP response boundary; successful payloads without a rejection code do not increment. */
export function sendGenerationResponse(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  recordGenerationRejection(body)
  const codes = generationRejectionCodes(body)
  if (status >= 400 && codes.length)
    recordDiagnosticEvent(
      {
        category: 'generation',
        level: 'warn',
        stage: 'accepted',
        outcome: 'rejected',
        providerMayHaveRun: false,
      },
      codes.map((value, index) => ({
        id: index === 0 ? 'rejection.code' : `rejection.code.${index}`,
        type: 'rejection-code',
        value,
      })),
    )
  return reply.code(status).send(body)
}

export function generationRejectionSnapshot() {
  return { sinceStartedAt: DIAGNOSTICS_PROCESS_STARTED_AT, byCode: Object.fromEntries(counts) }
}
