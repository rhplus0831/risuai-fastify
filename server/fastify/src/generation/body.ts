import { providerDiagnosticRead, recordProviderDiagnosticFailure } from './providerDiagnostics.js'

/**
 * Bounded buffering for upstream provider bodies.
 *
 * Non-streaming adapters buffer the whole response (`.json()` / `.text()`),
 * which is unbounded if a misbehaving or misconfigured upstream keeps
 * sending. Every buffered read in `generation/` goes through this helper so
 * the cap lives in one place. 32 MB is far past any legitimate completion or
 * embedding payload while still preventing an effectively-unbounded
 * allocation.
 */
export const MAX_BUFFERED_BODY_BYTES = 32 * 1024 * 1024

/** Read a response body as text, throwing once `maxBytes` is exceeded. */
export async function readBoundedBodyText(
  response: Response,
  maxBytes: number = MAX_BUFFERED_BODY_BYTES,
): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await providerDiagnosticRead(reader)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        recordProviderDiagnosticFailure('invalid-response')
        throw new Error(`upstream body exceeded the ${maxBytes}-byte buffer cap`)
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => {
      // swallow — only reached when the cap throws mid-stream
    })
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/** `response.json()` with the same byte cap as {@link readBoundedBodyText}. */
export async function readBoundedBodyJson(
  response: Response,
  maxBytes: number = MAX_BUFFERED_BODY_BYTES,
): Promise<unknown> {
  return JSON.parse(await readBoundedBodyText(response, maxBytes)) as unknown
}
