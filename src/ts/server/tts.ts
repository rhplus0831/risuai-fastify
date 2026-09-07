import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type { TtsSynthesisCredential, TtsSynthesisRequest } from '@risuai/protocol/tts-synthesis'

const TTS_SYNTHESIS_ENDPOINT = '/api/v1/tts/synthesize'

export interface TtsAudioResponse {
  audio: ArrayBuffer
  contentType: string
}

export interface RequestTtsSynthesisOptions {
  signal?: AbortSignal | null
}

export class TtsSynthesisRequestError extends Error {
  readonly status: number
  readonly code?: string
  readonly upstreamStatus?: number

  constructor(status: number, body: unknown) {
    super('tts_synthesis_failed')
    this.name = 'TtsSynthesisRequestError'
    this.status = status
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>
      if (typeof record.error === 'string') this.code = record.error
      if (Number.isInteger(record.upstreamStatus)) this.upstreamStatus = record.upstreamStatus as number
    }
  }
}

export function ttsGlobalCredential(apiKey: string | null | undefined): TtsSynthesisCredential {
  if (apiKey === MASKED_PROVIDER_SECRET) return { source: 'stored' }
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return { source: 'provided', apiKey }
  }
  return { source: 'none' }
}

export async function requestTtsSynthesis(
  request: TtsSynthesisRequest,
  options: RequestTtsSynthesisOptions = {},
): Promise<TtsAudioResponse> {
  const operation = captureClientWriteOperation()
  const auth = await getNodeServerProxyAuth()
  assertClientWriteOperation(operation)
  const response = await fetch(TTS_SYNTHESIS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'risu-auth': auth,
    },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: options.signal ?? undefined,
  })
  if (!response.ok) {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    throw new TtsSynthesisRequestError(response.status, body)
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    await response.body?.cancel().catch(() => undefined)
    throw new TtsSynthesisRequestError(502, { error: 'tts_upstream_invalid_response' })
  }
  const audio = await response.arrayBuffer()
  assertClientWriteOperation(operation)
  return {
    audio,
    contentType,
  }
}
