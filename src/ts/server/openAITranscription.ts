import { captureClientWriteOperation, assertClientWriteOperation } from '../clientWriteOperation'
import { language } from '../../lang'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'

const OPENAI_TRANSCRIPTION_ENDPOINT = '/api/v1/media/openai/transcriptions'
export const OPENAI_TRANSCRIPTION_MAX_FILE_BYTES = 25 * 1024 * 1024
export const OPENAI_TRANSCRIPTION_MAX_RESPONSE_CHARS = 4 * 1024 * 1024

export async function requestOpenAITranscription(file: File, signal?: AbortSignal | null): Promise<string> {
  if (!(file instanceof File) || file.size === 0 || file.size > OPENAI_TRANSCRIPTION_MAX_FILE_BYTES) {
    throw new Error(language.errors.openAITranscriptionFileSize)
  }

  const operation = captureClientWriteOperation()
  const auth = await getNodeServerProxyAuth()
  assertClientWriteOperation(operation)
  if (signal?.aborted) throw signal.reason ?? new DOMException('Transcription cancelled', 'AbortError')

  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetch(OPENAI_TRANSCRIPTION_ENDPOINT, {
    method: 'POST',
    headers: { 'risu-auth': auth },
    body: form,
    cache: 'no-store',
    signal: signal ?? undefined,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(language.errors.openAITranscriptionFailed(response.status))
  }

  const vtt = await response.text()
  if (vtt.length > OPENAI_TRANSCRIPTION_MAX_RESPONSE_CHARS || !/^WEBVTT(?:\s|$)/.test(vtt) || vtt.includes('\0')) {
    throw new Error(language.errors.openAITranscriptionResponseMalformed)
  }
  assertClientWriteOperation(operation)
  return vtt
}
