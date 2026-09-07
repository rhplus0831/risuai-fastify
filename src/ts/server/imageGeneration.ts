import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { Buffer } from 'buffer'
import { language } from '../../lang'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type { ImageGenerationCredential, ImageGenerationRequest } from '@risuai/protocol/image-generation-operation'

const IMAGE_GENERATION_ENDPOINT = '/api/v1/image-generation'
const MAX_IMAGE_RESPONSE_BYTES = 20 * 1024 * 1024
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function imageGenerationCredential(apiKey: string | null | undefined): ImageGenerationCredential {
  if (apiKey === MASKED_PROVIDER_SECRET) return { source: 'stored' }
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
    return { source: 'provided', apiKey }
  }
  return { source: 'none' }
}

export async function requestImageGeneration(
  request: ImageGenerationRequest,
  signal?: AbortSignal | null,
): Promise<string> {
  const operation = captureClientWriteOperation()
  const auth = await getNodeServerProxyAuth()
  assertClientWriteOperation(operation)
  const response = await fetch(IMAGE_GENERATION_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'risu-auth': auth,
    },
    body: JSON.stringify(request),
    signal: signal ?? undefined,
  })

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(language.errors.imageGenerationFailed(response.status))
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType)) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(language.errors.imageGenerationResponseMalformed)
  }

  const bytes = await readBoundedResponse(response, MAX_IMAGE_RESPONSE_BYTES)
  assertClientWriteOperation(operation)
  if (bytes.byteLength === 0) {
    throw new Error(language.errors.imageGenerationResponseEmpty)
  }
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(language.errors.imageGenerationResponseTooLarge)
  }

  const body = response.body
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(language.errors.imageGenerationResponseTooLarge)
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}
