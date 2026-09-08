import { isUtf8 } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import path from 'node:path'
import { isDiagnosticTransportUrl } from '@risuai/protocol/remote-diagnostics'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ACTIVE_WRITER_SESSION_HEADER, readActiveWriterSessionId } from './activeWriter.js'
import type { RequestTraceMode } from './config.js'

export const REQUEST_UID_HEADER = 'X-Request-UID'
const CALLER_HEADER = 'x-risu-caller'
const INLINE_BODY_MAX_BYTES = 4 * 1024
const GZIP_BODY_PREVIEW_MAX_BYTES = 4 * 1024
const TRACE_BODY_MAX_GZIP_BYTES = 10 * 1024 * 1024
const TRACE_ENTRY_LIMIT = 5_000
const STARTUP_TELEMETRY_ROUTE = '/api/v1/telemetry/startup'
const gzipAsync = promisify(gzip)
const requestTraceUids = new WeakMap<FastifyRequest, string>()

export function readRequestTraceUid(request: FastifyRequest): string | undefined {
  return requestTraceUids.get(request)
}

export function ensureRequestTraceUid(request: FastifyRequest, reply: FastifyReply): string {
  const uid = requestTraceUids.get(request) ?? generateRequestUid()
  requestTraceUids.set(request, uid)
  request.headers[REQUEST_UID_HEADER.toLowerCase()] = uid
  reply.header(REQUEST_UID_HEADER, uid)
  reply.raw.setHeader(REQUEST_UID_HEADER, uid)
  return uid
}

interface RegisterRequestTraceOptions {
  dataDir: string
  mode: RequestTraceMode
  bodySidecarMaxGzipBytes?: number
  entryLimit?: number
}

interface RequestTraceState {
  uid: string
  startedAtMs: number
  sendStartedAtMs?: number
  processMs?: number
  logApiRequest: boolean
  responseBody?: PendingTraceBody
}

interface RequestTraceEntry {
  Method: string
  Url: string
  Route?: string
  Caller?: string
  'Request-Header': string
  'Request-Body'?: TraceBodyEntry
  'Response-Header': string
  'Response-Body'?: TraceBodyEntry
  'X-Request-UID': string
  Timing: {
    process: number
    send: number
  }
}

type HeaderRecord = Record<string, string | number | string[] | undefined>

type BodyTraceDirection = 'request' | 'response'

interface PendingTraceBody {
  value?: unknown
  contentType?: string
  contentLength?: number
  omittedReason?: string
}

type TraceBodyEntry =
  | {
      storage: 'inline'
      contentType?: string
      contentLength?: number
      bytes: number
      sha256: string
      redacted?: true
      text: string
    }
  | {
      storage: 'gzip'
      contentType?: string
      contentLength?: number
      bytes: number
      gzipBytes: number
      sha256: string
      redacted?: true
      path: string
      preview: string
    }
  | {
      storage: 'omitted'
      contentType?: string
      contentLength?: number
      bytes?: number
      gzipBytes?: number
      sha256?: string
      redacted?: true
      preview?: string
      reason: string
    }

interface TraceBodyText {
  text: string
  format: 'json' | 'text'
  redacted: boolean
}

const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'risu-auth',
  'sec-websocket-protocol',
  'set-cookie',
  'x-api-key',
  'xi-api-key',
])

const SENSITIVE_QUERY_PARAM_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'code',
  'id_token',
  'key',
  'password',
  'passwd',
  'refresh_token',
  'risu-auth',
  'secret',
  'session',
  'session_token',
  'sig',
  'signature',
  'token',
  'x-api-key',
  'xi-api-key',
])

const SENSITIVE_BODY_FIELD_NAMES = new Set([
  'access_token',
  'apikey',
  'api_key',
  'assertion',
  'auth',
  'authorization',
  'cookie',
  'id_token',
  'key',
  'password',
  'passwd',
  'private_key',
  'proxy_authorization',
  'refresh_token',
  'risu-auth',
  'secret',
  'session',
  'session_token',
  'set-cookie',
  'sig',
  'signature',
  'token',
  'x-api-key',
  'xi-api-key',
])

export function registerRequestTrace(app: FastifyInstance, opts: RegisterRequestTraceOptions): void {
  const traceFilePath = path.join(opts.dataDir, 'trace', `${opts.mode}.jsonl`)
  const entryLimit = normalizeTraceEntryLimit(opts.entryLimit)
  const traceStates = new WeakMap<FastifyRequest, RequestTraceState>()
  const pendingWrites = new Set<Promise<void>>()
  let writeQueue = Promise.resolve()

  app.addHook('onRequest', async (request, reply) => {
    if (isDiagnosticTransportUrl(request.raw.url ?? request.url)) return
    const state: RequestTraceState = {
      uid: ensureRequestTraceUid(request, reply),
      startedAtMs: performance.now(),
      logApiRequest: isApiRequest(request.raw.url ?? request.url),
    }
    traceStates.set(request, state)
    installWriteHeadProbe(reply.raw, () => markSendStarted(state))
  })

  app.addHook('onSend', async (request, reply, payload) => {
    const state = traceStates.get(request)
    if (state) {
      markSendStarted(state)
      if (state.logApiRequest) {
        state.responseBody = captureResponseBodySource(request, reply, payload)
      }
    }
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    const state = traceStates.get(request)
    if (!state?.logApiRequest) return

    const finishedAtMs = performance.now()
    const sendStartedAtMs = state.sendStartedAtMs ?? finishedAtMs
    const processMs = state.processMs ?? sendStartedAtMs - state.startedAtMs
    const responseHeaders: HeaderRecord = {
      ...reply.getHeaders(),
      ...reply.raw.getHeaders(),
    }
    if (!hasHeader(responseHeaders, REQUEST_UID_HEADER)) {
      responseHeaders[REQUEST_UID_HEADER] = state.uid
    }

    const caller = resolveCaller(request)
    const route = resolveRoutePattern(request)
    const entry: RequestTraceEntry = {
      Method: request.method.toUpperCase(),
      Url: redactSensitiveQueryParams(request.raw.url ?? request.url),
      ...(route ? { Route: route } : {}),
      ...(caller ? { Caller: caller } : {}),
      'Request-Header': serializeHeaders(request.headers),
      'Response-Header': serializeHeaders(responseHeaders),
      'X-Request-UID': state.uid,
      Timing: {
        process: roundMs(processMs),
        send: roundMs(Math.max(0, finishedAtMs - sendStartedAtMs)),
      },
    }

    const write = writeQueue.then(async () => {
      const [requestBody, responseBody] = await Promise.all([
        createTraceBodyEntry({
          dataDir: opts.dataDir,
          mode: opts.mode,
          bodySidecarMaxGzipBytes: opts.bodySidecarMaxGzipBytes,
          uid: state.uid,
          direction: 'request',
          source: captureRequestBodySource(request),
          request,
        }),
        createTraceBodyEntry({
          dataDir: opts.dataDir,
          mode: opts.mode,
          bodySidecarMaxGzipBytes: opts.bodySidecarMaxGzipBytes,
          uid: state.uid,
          direction: 'response',
          source: state.responseBody ?? captureRawResponseBodySource(request, responseHeaders),
          request,
        }),
      ])
      if (requestBody) entry['Request-Body'] = requestBody
      if (responseBody) entry['Response-Body'] = responseBody

      await appendTraceEntry({
        traceFilePath,
        dataDir: opts.dataDir,
        mode: opts.mode,
        entry,
        entryLimit,
        request,
      })
    })
    writeQueue = write.catch(() => undefined)
    pendingWrites.add(write)
    try {
      await write
    } finally {
      pendingWrites.delete(write)
    }
  })

  app.addHook('onClose', async () => {
    await Promise.allSettled(pendingWrites)
  })
}

function generateRequestUid(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function isApiRequest(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url
  return path === '/api' || path.startsWith('/api/')
}

function markSendStarted(state: RequestTraceState): void {
  if (state.sendStartedAtMs !== undefined) return
  const now = performance.now()
  state.sendStartedAtMs = now
  state.processMs = now - state.startedAtMs
}

function installWriteHeadProbe(raw: FastifyReply['raw'], onWriteHead: () => void): void {
  const originalWriteHead = raw.writeHead
  raw.writeHead = function writeHeadWithTrace(
    this: FastifyReply['raw'],
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ): FastifyReply['raw'] {
    onWriteHead()
    const args =
      headers !== undefined
        ? [statusCode, statusMessageOrHeaders, headers]
        : statusMessageOrHeaders !== undefined
          ? [statusCode, statusMessageOrHeaders]
          : [statusCode]
    return Reflect.apply(originalWriteHead, this, args) as FastifyReply['raw']
  } as typeof raw.writeHead
}

function serializeHeaders(headers: HeaderRecord): string {
  const normalized: Record<string, string | number | string[]> = {}
  for (const name of Object.keys(headers).sort((a, b) => a.localeCompare(b))) {
    const value = headers[name]
    if (value === undefined) continue
    normalized[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase()) ? '[redacted]' : value
  }
  return JSON.stringify(normalized)
}

function captureRequestBodySource(request: FastifyRequest): PendingTraceBody | undefined {
  const contentType = normalizeContentType(readHeaderString(request.headers['content-type']))
  const contentLength = readContentLength(request.headers['content-length'])

  if (request.routeOptions.url === STARTUP_TELEMETRY_ROUTE) {
    return {
      contentType,
      contentLength,
      omittedReason: 'telemetry-metadata',
    }
  }

  if (isMultipartContentType(contentType)) {
    return {
      contentType,
      contentLength,
      omittedReason: 'multipart',
    }
  }

  if (request.body === undefined || request.body === null) {
    return hasRequestBodySignal(request)
      ? {
          contentType,
          contentLength,
          omittedReason: 'unavailable',
        }
      : undefined
  }

  return {
    value: request.body,
    contentType,
    contentLength,
  }
}

function captureResponseBodySource(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): PendingTraceBody | undefined {
  if (request.method.toUpperCase() === 'HEAD') return undefined

  const headers: HeaderRecord = {
    ...reply.getHeaders(),
    ...reply.raw.getHeaders(),
  }
  const contentType = normalizeContentType(readHeaderString(readHeader(headers, 'content-type')))
  const contentLength = readContentLength(readHeader(headers, 'content-length'))

  if (isEventStreamContentType(contentType)) {
    return {
      contentType,
      contentLength,
      omittedReason: 'event-stream',
    }
  }

  if (payload === undefined || payload === null) {
    return contentLength && contentLength > 0
      ? {
          contentType,
          contentLength,
          omittedReason: 'unavailable',
        }
      : undefined
  }

  if (isStreamLike(payload)) {
    return {
      contentType,
      contentLength,
      omittedReason: 'stream',
    }
  }

  return {
    value: payload,
    contentType,
    contentLength,
  }
}

function captureRawResponseBodySource(request: FastifyRequest, headers: HeaderRecord): PendingTraceBody | undefined {
  if (request.method.toUpperCase() === 'HEAD') return undefined

  const contentType = normalizeContentType(readHeaderString(readHeader(headers, 'content-type')))
  const contentLength = readContentLength(readHeader(headers, 'content-length'))

  if (isEventStreamContentType(contentType)) {
    return {
      contentType,
      contentLength,
      omittedReason: 'event-stream',
    }
  }

  return contentLength && contentLength > 0
    ? {
        contentType,
        contentLength,
        omittedReason: 'unavailable',
      }
    : undefined
}

async function createTraceBodyEntry(opts: {
  dataDir: string
  mode: RequestTraceMode
  bodySidecarMaxGzipBytes?: number
  uid: string
  direction: BodyTraceDirection
  source?: PendingTraceBody
  request: FastifyRequest
}): Promise<TraceBodyEntry | undefined> {
  const source = opts.source
  if (!source) return undefined

  if (source.omittedReason) {
    return {
      storage: 'omitted',
      ...(source.contentType ? { contentType: source.contentType } : {}),
      ...(source.contentLength !== undefined ? { contentLength: source.contentLength } : {}),
      reason: source.omittedReason,
    }
  }

  const bodyText = traceBodyText(source.value, source.contentType)
  if ('omittedReason' in bodyText) {
    return {
      storage: 'omitted',
      ...(source.contentType ? { contentType: source.contentType } : {}),
      ...(source.contentLength !== undefined ? { contentLength: source.contentLength } : {}),
      ...(bodyText.bytes !== undefined ? { bytes: bodyText.bytes } : {}),
      reason: bodyText.omittedReason,
    }
  }

  const bodyBuffer = Buffer.from(bodyText.text, 'utf8')
  const base = {
    ...(source.contentType ? { contentType: source.contentType } : {}),
    ...(source.contentLength !== undefined ? { contentLength: source.contentLength } : {}),
    bytes: bodyBuffer.byteLength,
    sha256: sha256Hex(bodyBuffer),
    ...(bodyText.redacted ? { redacted: true as const } : {}),
  }

  if (bodyBuffer.byteLength <= INLINE_BODY_MAX_BYTES) {
    return {
      storage: 'inline',
      ...base,
      text: bodyText.text,
    }
  }

  try {
    const compressed = await gzipAsync(bodyBuffer)
    const bodySidecarMaxGzipBytes = normalizeBodySidecarMaxGzipBytes(opts.bodySidecarMaxGzipBytes)
    if (compressed.byteLength > bodySidecarMaxGzipBytes) {
      return {
        storage: 'omitted',
        ...base,
        gzipBytes: compressed.byteLength,
        preview: truncateUtf8Text(bodyText.text, GZIP_BODY_PREVIEW_MAX_BYTES),
        reason: 'compressed-too-large',
      }
    }

    const sidecar = await writeGzipBodySidecar({
      dataDir: opts.dataDir,
      mode: opts.mode,
      uid: opts.uid,
      direction: opts.direction,
      format: bodyText.format,
      compressed,
    })
    return {
      storage: 'gzip',
      ...base,
      gzipBytes: sidecar.gzipBytes,
      path: sidecar.relativePath,
      preview: truncateUtf8Text(bodyText.text, GZIP_BODY_PREVIEW_MAX_BYTES),
    }
  } catch (err) {
    opts.request.log.warn({ err, uid: opts.uid, direction: opts.direction }, 'failed to write request trace body')
    return {
      storage: 'omitted',
      ...(source.contentType ? { contentType: source.contentType } : {}),
      ...(source.contentLength !== undefined ? { contentLength: source.contentLength } : {}),
      bytes: bodyBuffer.byteLength,
      reason: 'sidecar-write-failed',
    }
  }
}

function traceBodyText(
  value: unknown,
  contentType: string | undefined,
): TraceBodyText | { omittedReason: string; bytes?: number } {
  if (Buffer.isBuffer(value)) {
    if (!isTextBodyContentType(contentType)) {
      return { omittedReason: 'non-text', bytes: value.byteLength }
    }
    if (!isUtf8(value)) {
      return { omittedReason: 'non-utf8', bytes: value.byteLength }
    }
    return redactTraceText(value.toString('utf8'), contentType)
  }

  if (ArrayBuffer.isView(value)) {
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return traceBodyText(buffer, contentType)
  }

  if (value instanceof ArrayBuffer) {
    return traceBodyText(Buffer.from(value), contentType)
  }

  if (typeof value === 'string') {
    return redactTraceText(value, contentType)
  }

  const redacted = normalizeAndRedactJsonValue(value)
  return {
    text: JSON.stringify(redacted.value),
    format: 'json',
    redacted: redacted.redacted,
  }
}

function redactTraceText(text: string, contentType: string | undefined): TraceBodyText {
  if (isUrlEncodedContentType(contentType)) {
    return redactUrlEncodedText(text)
  }

  if (isJsonContentType(contentType) || isJsonLikeText(text)) {
    try {
      const parsed = JSON.parse(text) as unknown
      const redacted = normalizeAndRedactJsonValue(parsed)
      return {
        text: JSON.stringify(redacted.value),
        format: 'json',
        redacted: redacted.redacted,
      }
    } catch {
      // Fall through to conservative text redaction. Malformed JSON is useful
      // in traces precisely because it failed parsing.
    }
  }

  const redacted = redactSecretLikeText(text)
  return {
    text: redacted.text,
    format: 'text',
    redacted: redacted.redacted,
  }
}

function redactUrlEncodedText(text: string): TraceBodyText {
  const params = new URLSearchParams(text)
  let redacted = false
  for (const key of Array.from(params.keys())) {
    if (isSensitiveBodyFieldName(key)) {
      params.set(key, '[redacted]')
      redacted = true
    }
  }
  return {
    text: params.toString(),
    format: 'text',
    redacted,
  }
}

function redactSecretLikeText(text: string): { text: string; redacted: boolean } {
  let redacted = false
  const next = text.replace(
    /\b(access[_-]?token|api[_-]?key|authorization|id[_-]?token|password|passwd|refresh[_-]?token|secret|session[_-]?token|x-api-key|xi-api-key)\b(\s*[:=]\s*)(["']?)[^\s"',;&]+/gi,
    (_match, key: string, separator: string, quote: string) => {
      redacted = true
      return `${key}${separator}${quote}[redacted]`
    },
  )
  return { text: next, redacted }
}

function normalizeAndRedactJsonValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): { value: unknown; redacted: boolean } {
  if (depth > 40) {
    return { value: '[max-depth]', redacted: false }
  }

  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return { value: null, redacted: false }
  }
  if (typeof value === 'bigint') {
    return { value: value.toString(), redacted: false }
  }
  if (value === null || typeof value !== 'object') {
    return { value, redacted: false }
  }
  if (value instanceof Date) {
    return { value: value.toISOString(), redacted: false }
  }
  if (Buffer.isBuffer(value)) {
    return { value: `[buffer ${value.byteLength} bytes]`, redacted: false }
  }
  if (ArrayBuffer.isView(value)) {
    return { value: `[binary ${value.byteLength} bytes]`, redacted: false }
  }
  if (value instanceof ArrayBuffer) {
    return { value: `[binary ${value.byteLength} bytes]`, redacted: false }
  }
  if (seen.has(value)) {
    return { value: '[circular]', redacted: false }
  }
  seen.add(value)

  if (Array.isArray(value)) {
    let redacted = false
    const items = value.map((entry) => {
      const next = normalizeAndRedactJsonValue(entry, seen, depth + 1)
      redacted ||= next.redacted
      return next.value
    })
    seen.delete(value)
    return { value: items, redacted }
  }

  let redacted = false
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveBodyFieldName(key)) {
      out[key] = '[redacted]'
      redacted = true
      continue
    }
    const next = normalizeAndRedactJsonValue(entry, seen, depth + 1)
    redacted ||= next.redacted
    out[key] = next.value
  }
  seen.delete(value)
  return { value: out, redacted }
}

async function writeGzipBodySidecar(opts: {
  dataDir: string
  mode: RequestTraceMode
  uid: string
  direction: BodyTraceDirection
  format: TraceBodyText['format']
  compressed: Buffer
}): Promise<{ relativePath: string; gzipBytes: number }> {
  const extension = opts.format === 'json' ? 'json' : 'txt'
  const relativePath = path.posix.join('trace', 'bodies', opts.mode, `${opts.uid}.${opts.direction}.${extension}.gz`)
  const fullPath = path.join(opts.dataDir, ...relativePath.split('/'))

  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, opts.compressed)

  return { relativePath, gzipBytes: opts.compressed.byteLength }
}

function normalizeBodySidecarMaxGzipBytes(raw: number | undefined): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : TRACE_BODY_MAX_GZIP_BYTES
}

function normalizeTraceEntryLimit(raw: number | undefined): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : TRACE_ENTRY_LIMIT
}

function readHeader(headers: HeaderRecord, name: string): string | number | string[] | undefined {
  const normalized = name.toLowerCase()
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalized) return value
  }
  return undefined
}

function readContentLength(value: string | number | string[] | undefined): number | undefined {
  const raw = readHeaderString(value)
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function hasRequestBodySignal(request: FastifyRequest): boolean {
  const contentLength = readContentLength(request.headers['content-length'])
  if (contentLength !== undefined) return contentLength > 0
  return readHeaderString(request.headers['transfer-encoding']) !== undefined
}

function normalizeContentType(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function baseContentType(contentType: string | undefined): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function isMultipartContentType(contentType: string | undefined): boolean {
  return baseContentType(contentType) === 'multipart/form-data'
}

function isEventStreamContentType(contentType: string | undefined): boolean {
  return baseContentType(contentType) === 'text/event-stream'
}

function isJsonContentType(contentType: string | undefined): boolean {
  const base = baseContentType(contentType)
  return base === 'application/json' || base === 'application/x-ndjson' || base.endsWith('+json')
}

function isUrlEncodedContentType(contentType: string | undefined): boolean {
  return baseContentType(contentType) === 'application/x-www-form-urlencoded'
}

function isTextBodyContentType(contentType: string | undefined): boolean {
  const base = baseContentType(contentType)
  if (!base || isEventStreamContentType(contentType) || isMultipartContentType(contentType)) return false
  return (
    base.startsWith('text/') ||
    isJsonContentType(contentType) ||
    isUrlEncodedContentType(contentType) ||
    base === 'application/graphql' ||
    base === 'application/javascript' ||
    base === 'application/xml' ||
    base.endsWith('+xml')
  )
}

function isJsonLikeText(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function isStreamLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const asyncIterable = value as { [Symbol.asyncIterator]?: unknown }
  return (
    typeof record.pipe === 'function' ||
    typeof record.getReader === 'function' ||
    typeof asyncIterable[Symbol.asyncIterator] === 'function'
  )
}

function isSensitiveBodyFieldName(rawName: string): boolean {
  const normalized = rawName.trim().toLowerCase()
  if (SENSITIVE_BODY_FIELD_NAMES.has(normalized)) return true

  const compact = normalized.replace(/[-_\s.]/g, '')
  return (
    compact === 'apikey' ||
    compact === 'authorization' ||
    compact === 'cookie' ||
    compact === 'privatekey' ||
    compact === 'risuauth' ||
    compact === 'setcookie' ||
    compact.endsWith('apikey') ||
    compact.endsWith('authorization') ||
    compact.endsWith('password') ||
    compact.endsWith('privatekey') ||
    compact.endsWith('secret') ||
    compact.endsWith('token')
  )
}

function truncateUtf8Text(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8')
}

function resolveRoutePattern(request: FastifyRequest): string | undefined {
  const route = request.routeOptions.url
  return typeof route === 'string' && route.trim() !== '' ? route : undefined
}

function resolveCaller(request: FastifyRequest): string | undefined {
  const explicit = readHeaderString(request.headers[CALLER_HEADER])
  if (explicit) {
    return `${CALLER_HEADER}=${redactSensitiveQueryParams(explicit)}`
  }

  const parts: string[] = []
  const referer = readHeaderString(request.headers.referer) ?? readHeaderString(request.headers.referrer)
  if (referer) {
    parts.push(`referer=${redactSensitiveQueryParams(referer)}`)
  }

  const userAgent = readHeaderString(request.headers['user-agent'])
  if (userAgent) {
    parts.push(`user-agent=${userAgent}`)
  }

  const writerSession = readActiveWriterSessionId(request)
  if (writerSession) {
    parts.push(`${ACTIVE_WRITER_SESSION_HEADER}=${writerSession}`)
  }

  return parts.length > 0 ? parts.join('; ') : undefined
}

function readHeaderString(value: string | number | string[] | undefined): string | undefined {
  const raw = Array.isArray(value)
    ? value.find((entry) => entry.trim() !== '')
    : typeof value === 'number'
      ? String(value)
      : value
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

function redactSensitiveQueryParams(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?')
  if (queryStart === -1) return rawUrl
  const hashStart = rawUrl.indexOf('#', queryStart + 1)
  const queryEnd = hashStart === -1 ? rawUrl.length : hashStart
  const query = rawUrl.slice(queryStart + 1, queryEnd)
  if (query === '') return rawUrl

  const redactedQuery = query
    .split('&')
    .map((part) => redactQueryParam(part))
    .join('&')
  return `${rawUrl.slice(0, queryStart + 1)}${redactedQuery}${rawUrl.slice(queryEnd)}`
}

function redactQueryParam(part: string): string {
  if (part === '') return part
  const separatorIndex = part.indexOf('=')
  const rawName = separatorIndex === -1 ? part : part.slice(0, separatorIndex)
  if (!isSensitiveQueryParamName(rawName)) return part
  return `${rawName}=[redacted]`
}

function isSensitiveQueryParamName(rawName: string): boolean {
  const normalized = decodeQueryComponent(rawName).trim().toLowerCase()
  if (SENSITIVE_QUERY_PARAM_NAMES.has(normalized)) return true

  const compact = normalized.replace(/[-_]/g, '')
  return (
    compact.includes('token') ||
    compact.includes('secret') ||
    compact.includes('password') ||
    compact === 'apikey' ||
    compact === 'authorization' ||
    compact === 'risuauth'
  )
}

function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return raw
  }
}

function hasHeader(headers: HeaderRecord, name: string): boolean {
  const normalizedName = name.toLowerCase()
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName)
}

async function appendTraceEntry(opts: {
  traceFilePath: string
  dataDir: string
  mode: RequestTraceMode
  entry: RequestTraceEntry
  entryLimit: number
  request: FastifyRequest
}): Promise<void> {
  try {
    await fs.mkdir(path.dirname(opts.traceFilePath), { recursive: true })
    await fs.appendFile(opts.traceFilePath, `${JSON.stringify(opts.entry)}\n`, 'utf8')
    await trimTraceEntries(opts)
  } catch (err) {
    opts.request.log.warn({ err, traceFilePath: opts.traceFilePath }, 'failed to append request trace entry')
  }
}

async function trimTraceEntries(opts: {
  traceFilePath: string
  dataDir: string
  mode: RequestTraceMode
  entryLimit: number
  request: FastifyRequest
}): Promise<void> {
  const contents = await fs.readFile(opts.traceFilePath, 'utf8')
  const lines = contents.split('\n').filter((line) => line.length > 0)
  if (lines.length <= opts.entryLimit) return

  const removeCount = lines.length - opts.entryLimit
  const removedLines = lines.slice(0, removeCount)
  const keptLines = lines.slice(removeCount)
  await fs.writeFile(opts.traceFilePath, `${keptLines.join('\n')}\n`, 'utf8')
  await deleteTraceBodySidecars({
    dataDir: opts.dataDir,
    mode: opts.mode,
    lines: removedLines,
    request: opts.request,
  })
}

async function deleteTraceBodySidecars(opts: {
  dataDir: string
  mode: RequestTraceMode
  lines: string[]
  request: FastifyRequest
}): Promise<void> {
  const sidecarPaths = new Set<string>()
  for (const line of opts.lines) {
    for (const relativePath of extractTraceBodySidecarPaths(line)) {
      const fullPath = resolveTraceBodySidecarPath(opts.dataDir, opts.mode, relativePath)
      if (fullPath) sidecarPaths.add(fullPath)
    }
  }

  await Promise.all(
    Array.from(sidecarPaths).map(async (sidecarPath) => {
      try {
        await fs.rm(sidecarPath, { force: true })
      } catch (err) {
        opts.request.log.warn({ err, sidecarPath }, 'failed to delete trimmed request trace body')
      }
    }),
  )
}

function extractTraceBodySidecarPaths(line: string): string[] {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  if (!entry || typeof entry !== 'object') return []

  const paths: string[] = []
  collectTraceBodySidecarPath((entry as Record<string, unknown>)['Request-Body'], paths)
  collectTraceBodySidecarPath((entry as Record<string, unknown>)['Response-Body'], paths)
  return paths
}

function collectTraceBodySidecarPath(body: unknown, paths: string[]): void {
  if (!body || typeof body !== 'object') return
  const record = body as Record<string, unknown>
  if (record.storage === 'gzip' && typeof record.path === 'string') {
    paths.push(record.path)
  }
}

function resolveTraceBodySidecarPath(
  dataDir: string,
  mode: RequestTraceMode,
  relativePath: string,
): string | undefined {
  const normalized = path.posix.normalize(relativePath)
  const expectedPrefix = path.posix.join('trace', 'bodies', mode)
  if (
    path.posix.isAbsolute(relativePath) ||
    normalized !== relativePath ||
    normalized === expectedPrefix ||
    !normalized.startsWith(`${expectedPrefix}/`)
  ) {
    return undefined
  }

  const fullPath = path.resolve(dataDir, ...normalized.split('/'))
  const sidecarRoot = path.resolve(dataDir, 'trace', 'bodies', mode)
  const relativeToRoot = path.relative(sidecarRoot, fullPath)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return undefined
  }
  return fullPath
}

function roundMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value * 1000) / 1000
}
