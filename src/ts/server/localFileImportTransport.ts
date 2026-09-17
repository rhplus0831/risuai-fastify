import {
  isLocalCharacterImportProgress,
  isLocalFileImportResultFrame,
  type LocalCharacterImportProgress,
  type LocalFileImportResultFrame,
} from '@risuai/protocol/local-file-import'
import { parseSseEvent } from '../process/request/sseParse'

export type LocalFileImportProgress =
  | LocalCharacterImportProgress
  | { phase: 'prepare' | 'processing' | 'refresh' }
  | { phase: 'upload'; completedBytes: number; totalBytes?: number }

export const LOCAL_CHARACTER_IMPORT_DUPLEX_PROGRESS_MAX_BYTES = 64 * 1024 * 1024

export function reportLocalFileImportProgress(
  callback: ((progress: LocalFileImportProgress) => void) | undefined,
  progress: LocalFileImportProgress,
): void {
  try {
    callback?.(progress)
  } catch {
    // A display failure must not change the outcome of a server mutation.
  }
}

/** XHR exposes both multipart upload bytes and incremental SSE response text. */
export function sendLocalCharacterImport(input: {
  url: string
  body: FormData | string
  headers: Record<string, string>
  signal?: AbortSignal | null
  serverProgress?: boolean
  onProgress: (progress: LocalFileImportProgress) => void
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error('request aborted'))
      return
    }
    const xhr = new XMLHttpRequest()
    let offset = 0
    let result: LocalFileImportResultFrame | undefined
    let serverProgressStarted = false
    const report = (progress: LocalFileImportProgress) => reportLocalFileImportProgress(input.onProgress, progress)
    const abort = () => xhr.abort()
    const cleanup = () => input.signal?.removeEventListener('abort', abort)
    const fail = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const isStream = () => xhr.getResponseHeader('content-type')?.includes('text/event-stream')
    const readFrames = () => {
      if (!isStream()) return
      const text = xhr.responseText
      // The server emits LF separators; retain incomplete frames across progress events.
      let end = text.indexOf('\n\n', offset)
      while (end !== -1) {
        const frame = parseSseEvent(text.slice(offset, end))
        offset = end + 2
        if (frame.event === 'progress' || frame.event === 'result') {
          const payload: unknown = JSON.parse(frame.data)
          if (frame.event === 'progress' && isLocalCharacterImportProgress(payload) && !result) {
            serverProgressStarted = true
            report(payload)
          } else if (frame.event === 'result' && isLocalFileImportResultFrame(payload)) {
            result = payload
          } else {
            throw new Error('Invalid character import progress response')
          }
        }
        end = text.indexOf('\n\n', offset)
      }
    }

    xhr.open('POST', input.url)
    for (const [key, value] of Object.entries(input.headers)) xhr.setRequestHeader(key, value)
    if (input.serverProgress !== false) xhr.setRequestHeader('accept', 'text/event-stream')
    if (input.body instanceof FormData) {
      report({ phase: 'upload', completedBytes: 0 })
      xhr.upload.onprogress = (event) => {
        if (!serverProgressStarted) {
          report({
            phase: 'upload',
            completedBytes: event.loaded,
            ...(event.lengthComputable ? { totalBytes: event.total } : {}),
          })
        }
      }
      xhr.upload.onload = () => {
        if (!serverProgressStarted) report({ phase: 'processing' })
      }
    } else {
      report({ phase: 'processing' })
    }
    xhr.onprogress = () => {
      try {
        readFrames()
      } catch (error) {
        fail(error)
        xhr.abort()
      }
    }
    xhr.onload = () => {
      cleanup()
      try {
        readFrames()
        if (isStream()) {
          if (!result) throw new Error('Character import progress stream ended without a result')
          resolve(
            new Response(JSON.stringify(result.body), {
              status: result.statusCode,
              headers: { 'content-type': 'application/json' },
            }),
          )
        } else {
          // Early HTTP failures and servers without progress support retain JSON semantics.
          const headers = new Headers()
          for (const line of xhr
            .getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/)) {
            const separator = line.indexOf(':')
            if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
          }
          resolve(new Response(xhr.responseText, { status: xhr.status, headers }))
        }
      } catch (error) {
        fail(error)
      }
    }
    xhr.onerror = () => fail(new Error('request failed'))
    xhr.onabort = () => fail(new Error('request aborted'))
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      xhr.send(input.body)
    } catch (error) {
      fail(error)
    }
  })
}
