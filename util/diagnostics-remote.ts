import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { request } from 'node:https'
import { isAbsolute, resolve } from 'node:path'
import { Transform, Writable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import {
  REMOTE_DIAGNOSTICS_ERRORS,
  REMOTE_DIAGNOSTICS_MAX_BYTES,
  SUPPORT_DIAGNOSTICS_ENDPOINT,
  isRemoteDiagnosticsResponse,
  parseRemoteDiagnosticsQuery,
  type RemoteDiagnosticsError,
  type RemoteDiagnosticsResponse,
} from '@risuai/protocol/remote-diagnostics'

const MAX_CONFIG_BYTES = 4 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const MAX_INVESTIGATION_READS = 20
const QUERY_KEYS = new Set(['version', 'from', 'to', 'limit', 'requestUid', 'operationRef', 'category', 'cursor'])
const TLS_ERRORS = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

export interface RemoteDiagnosticsConfig {
  version: 1
  origin: string
  token: string
}

export type RemoteDiagnosticsHelperCategory =
  | RemoteDiagnosticsError
  | 'config-error'
  | 'server-unavailable'
  | 'tls-error'
  | 'timeout'
  | 'redirect-rejected'
  | 'bad-response'
  | 'response-too-large'

type RemoteDiagnosticsV2Response = Extract<RemoteDiagnosticsResponse, { version: 2 }>
type RemoteDiagnosticsV3Response = Extract<RemoteDiagnosticsResponse, { version: 3 }>
type RemoteDiagnosticsInvestigationResponse = RemoteDiagnosticsV2Response | RemoteDiagnosticsV3Response
type RemoteDiagnosticsInvestigationRecord = RemoteDiagnosticsInvestigationResponse['entries'][number]
type RemoteDiagnosticsLevel = RemoteDiagnosticsInvestigationRecord['entry']['level']
type CorrelationKind = 'request' | 'operation' | 'attempt' | 'background' | 'unavailable' | 'client-asserted'

export interface RemoteDiagnosticsInvestigation {
  version: 1
  source: {
    remoteVersion: 2 | 3
    serverTime: number
    identity: RemoteDiagnosticsInvestigationResponse['identity']
    sources: RemoteDiagnosticsInvestigationResponse['sources']
    clock: RemoteDiagnosticsInvestigationResponse['clock']
  }
  loss: RemoteDiagnosticsInvestigationResponse['loss']
  collection: {
    capture: RemoteDiagnosticsInvestigationResponse['capture']
    pending: number
    operationContinuity: RemoteDiagnosticsInvestigationResponse['collection']['operationContinuity']
    pagesRead: number
    entryCount: number
    snapshotSequence: number
    firstSequence: number | null
    lastSequence: number | null
    complete: true
  }
  counts: {
    byLevel: Record<RemoteDiagnosticsLevel, number>
    byCategory: Record<string, number>
  }
  correlationGroups: Array<{
    kind: CorrelationKind
    reference: string | null
    entryCount: number
    firstSequence: number
    lastSequence: number
  }>
  timeline: RemoteDiagnosticsInvestigationRecord[]
}

/** The only error information allowed to cross the helper's output boundary. */
export class RemoteDiagnosticsHelperError extends Error {
  constructor(readonly category: RemoteDiagnosticsHelperCategory) {
    super(category)
    this.name = 'RemoteDiagnosticsHelperError'
  }
}

function failure(category: RemoteDiagnosticsHelperCategory): RemoteDiagnosticsHelperError {
  return new RemoteDiagnosticsHelperError(category)
}

function validateConfig(value: unknown): RemoteDiagnosticsConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('config-error')
    const config = value as Record<string, unknown>
    if (
      Object.keys(config).length !== 3 ||
      config.version !== 1 ||
      typeof config.origin !== 'string' ||
      config.origin.length > 2048 ||
      typeof config.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.token)
    )
      throw failure('config-error')
    const origin = new URL(config.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== '/' ||
      ![origin.origin, `${origin.origin}/`].includes(config.origin)
    )
      throw failure('config-error')
    return { version: 1, origin: origin.origin, token: config.token }
  } catch {
    throw failure('config-error')
  }
}

/** Reads one private, bounded, ordinary file; symlinked path components are rejected. */
export function readRemoteDiagnosticsConfig(configPath: string | undefined): RemoteDiagnosticsConfig {
  let descriptor: number | undefined
  try {
    if (!configPath || configPath.length > 4096 || !isAbsolute(configPath)) throw failure('config-error')
    const path = resolve(configPath)
    if (realpathSync(path) !== path) throw failure('config-error')
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      stat.size < 1 ||
      stat.size > MAX_CONFIG_BYTES
    )
      throw failure('config-error')
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
    }
    if (bytes > MAX_CONFIG_BYTES) throw failure('config-error')
    return validateConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))))
  } catch {
    throw failure('config-error')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** No destination, output file, custom header, or arbitrary transport options exist. */
export function parseRemoteDiagnosticsArguments(args: readonly string[]): Record<string, string> {
  const input: Record<string, string> = Object.create(null)
  for (let index = args[0] === '--' ? 1 : 0; index < args.length; index++) {
    const match = /^--([a-zA-Z]+)(?:=(.*))?$/.exec(args[index])
    if (!match || !QUERY_KEYS.has(match[1]) || Object.hasOwn(input, match[1])) throw failure('invalid-query')
    const value = match[2] ?? args[++index]
    if (value === undefined || value.startsWith('--')) throw failure('invalid-query')
    input[match[1]] = value
  }
  if (!parseRemoteDiagnosticsQuery(input)) throw failure('invalid-query')
  return input
}

function parseCliArguments(args: readonly string[]): { investigate: boolean; query: Record<string, string> } {
  const investigateCount = args.filter((argument) => argument === '--investigate').length
  const malformedInvestigationFlag = args.some(
    (argument) => argument.startsWith('--investigate') && argument !== '--investigate',
  )
  if (investigateCount > 1 || malformedInvestigationFlag) throw failure('invalid-query')
  if (investigateCount === 0) return { investigate: false, query: parseRemoteDiagnosticsArguments(args) }

  const query = parseRemoteDiagnosticsArguments(args.filter((argument) => argument !== '--investigate'))
  if (
    query.cursor !== undefined ||
    (query.requestUid !== undefined && query.operationRef !== undefined) ||
    (query.version !== undefined && query.version !== '2' && query.version !== '3')
  )
    throw failure('invalid-query')
  return { investigate: true, query: { ...query, limit: '200' } }
}

function byteLimit(): Transform {
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length
      callback(bytes > REMOTE_DIAGNOSTICS_MAX_BYTES ? failure('response-too-large') : null, chunk)
    },
  })
}

function responseError(value: unknown): RemoteDiagnosticsError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return null
  const error = (value as { error?: unknown }).error
  return REMOTE_DIAGNOSTICS_ERRORS.find((category) => category === error) ?? null
}

/** Fetches only the fixed support route, with verified TLS and bounded wire/expanded bytes. */
export async function fetchRemoteDiagnostics(
  config: RemoteDiagnosticsConfig,
  input: Record<string, string> = {},
): Promise<RemoteDiagnosticsResponse> {
  const trustedConfig = validateConfig(config)
  const query = parseRemoteDiagnosticsQuery(input)
  if (!query) throw failure('invalid-query')
  // Fail closed before Node emits its insecure-TLS environment warning or opens a socket.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw failure('tls-error')
  const url = new URL(SUPPORT_DIAGNOSTICS_ENDPOINT, trustedConfig.origin)
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value)

  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false
    const finish = (error?: RemoteDiagnosticsHelperError, response?: RemoteDiagnosticsResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (error) {
        transport.destroy()
        rejectResponse(error)
      } else resolveResponse(response!)
    }
    const transport = request(
      url,
      {
        method: 'GET',
        agent: false,
        rejectUnauthorized: true,
        maxHeaderSize: 8192,
        headers: {
          Authorization: `Bearer ${trustedConfig.token}`,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400) {
          response.destroy()
          finish(failure('redirect-rejected'))
          return
        }
        const type = response.headers['content-type'] ?? ''
        const encoding = response.headers['content-encoding']?.toLowerCase() ?? 'identity'
        const length = response.headers['content-length']
        if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > REMOTE_DIAGNOSTICS_MAX_BYTES)) {
          response.destroy()
          finish(failure('response-too-large'))
          return
        }
        if (
          !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(type) ||
          !['identity', 'gzip', 'deflate', 'br'].includes(encoding)
        ) {
          response.destroy()
          finish(failure('bad-response'))
          return
        }
        const chunks: Buffer[] = []
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk)
            callback()
          },
        })
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'deflate'
              ? createInflate()
              : encoding === 'br'
                ? createBrotliDecompress()
                : new Transform({
                    transform(chunk, _encoding, callback) {
                      callback(null, chunk)
                    },
                  })
        void pipeline(response, byteLimit(), decoder, byteLimit(), sink).then(
          () => {
            try {
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
              if (status !== 200) {
                finish(
                  failure(status >= 400 && status <= 599 ? (responseError(value) ?? 'bad-response') : 'bad-response'),
                )
              } else if (!isRemoteDiagnosticsResponse(value) || value.version !== query.version) {
                finish(failure('bad-response'))
              } else finish(undefined, value)
            } catch {
              finish(failure('bad-response'))
            }
          },
          (error: unknown) => {
            finish(error instanceof RemoteDiagnosticsHelperError ? error : failure('bad-response'))
          },
        )
      },
    )
    const deadline = setTimeout(() => finish(failure('timeout')), REQUEST_TIMEOUT_MS)
    transport.on('error', (error: NodeJS.ErrnoException) => {
      finish(failure(TLS_ERRORS.has(error.code ?? '') ? 'tls-error' : 'server-unavailable'))
    })
    transport.end()
  })
}

function sameSnapshotMetadata(
  first: RemoteDiagnosticsInvestigationResponse,
  page: RemoteDiagnosticsInvestigationResponse,
): boolean {
  return (
    page.version === first.version &&
    page.pagination.snapshotSequence === first.pagination.snapshotSequence &&
    page.identity.build === first.identity.build &&
    page.identity.instanceId === first.identity.instanceId &&
    page.sources.server === first.sources.server &&
    page.sources.browser === first.sources.browser &&
    page.capture.from === first.capture.from &&
    page.capture.to === first.capture.to &&
    page.loss.dropped === first.loss.dropped &&
    page.loss.rejected === first.loss.rejected &&
    page.loss.pruned === first.loss.pruned &&
    page.loss.truncated === first.loss.truncated &&
    page.clock.ordering === first.clock.ordering &&
    page.clock.browserTime === first.clock.browserTime &&
    page.clock.skew === first.clock.skew &&
    page.collection.pending === first.collection.pending &&
    page.collection.operationContinuity === first.collection.operationContinuity
  )
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function correlationGroups(
  timeline: readonly RemoteDiagnosticsInvestigationRecord[],
): RemoteDiagnosticsInvestigation['correlationGroups'] {
  const groups = new Map<string, { kind: CorrelationKind; reference: string | null; sequences: number[] }>()
  const add = (kind: CorrelationKind, reference: string | null, sequence: number): void => {
    const key = `${kind}:${reference ?? ''}`
    const group = groups.get(key)
    if (group) group.sequences.push(sequence)
    else groups.set(key, { kind, reference, sequences: [sequence] })
  }
  for (const record of timeline) {
    const entry = record.entry
    let referenced = false
    if (entry.requestUid) {
      add('request', entry.requestUid, record.sequence)
      referenced = true
    }
    if (entry.operationRef) {
      add('operation', entry.operationRef, record.sequence)
      referenced = true
    }
    if (entry.attemptRef) {
      add('attempt', entry.attemptRef, record.sequence)
      referenced = true
    }
    if (!referenced) add(entry.correlation, null, record.sequence)
  }
  const kindOrder: CorrelationKind[] = [
    'request',
    'operation',
    'attempt',
    'background',
    'unavailable',
    'client-asserted',
  ]
  return [...groups.values()]
    .sort(
      (left, right) =>
        kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) ||
        (left.reference ?? '').localeCompare(right.reference ?? ''),
    )
    .map(({ kind, reference, sequences }) => ({
      kind,
      reference,
      entryCount: sequences.length,
      firstSequence: sequences[0],
      lastSequence: sequences.at(-1)!,
    }))
}

function buildInvestigation(
  first: RemoteDiagnosticsInvestigationResponse,
  pagesRead: number,
  timeline: RemoteDiagnosticsInvestigationRecord[],
): RemoteDiagnosticsInvestigation {
  const byLevel: Record<RemoteDiagnosticsLevel, number> = { info: 0, warn: 0, error: 0 }
  const byCategory: Record<string, number> = Object.create(null)
  for (const record of timeline) {
    byLevel[record.entry.level]++
    increment(byCategory, record.entry.category)
  }
  return {
    version: 1,
    source: {
      remoteVersion: first.version,
      serverTime: first.serverTime,
      identity: first.identity,
      sources: first.sources,
      clock: first.clock,
    },
    loss: first.loss,
    collection: {
      capture: first.capture,
      pending: first.collection.pending,
      operationContinuity: first.collection.operationContinuity,
      pagesRead,
      entryCount: timeline.length,
      snapshotSequence: first.pagination.snapshotSequence,
      firstSequence: timeline[0]?.sequence ?? null,
      lastSequence: timeline.at(-1)?.sequence ?? null,
      complete: true,
    },
    counts: { byLevel, byCategory: sortedCounts(byCategory) },
    correlationGroups: correlationGroups(timeline),
    timeline,
  }
}

async function collectInvestigation(
  config: RemoteDiagnosticsConfig,
  first: RemoteDiagnosticsInvestigationResponse,
): Promise<RemoteDiagnosticsInvestigation> {
  let response = first
  const timeline: RemoteDiagnosticsInvestigationRecord[] = []
  const seenCursors = new Set<string>()

  for (let reads = 1; reads <= MAX_INVESTIGATION_READS; reads++) {
    if (!sameSnapshotMetadata(first, response)) throw failure('bad-response')

    let previousSequence = timeline.at(-1)?.sequence
    if (response.pagination.lastSequence !== (response.entries.at(-1)?.sequence ?? 0)) throw failure('bad-response')
    for (const record of response.entries) {
      if (previousSequence !== undefined && record.sequence <= previousSequence) throw failure('bad-response')
      previousSequence = record.sequence
    }
    timeline.push(...response.entries)

    const cursor = response.pagination.nextCursor
    if (cursor === null) return buildInvestigation(first, reads, timeline)
    if (seenCursors.has(cursor) || reads === MAX_INVESTIGATION_READS) throw failure('bad-response')
    seenCursors.add(cursor)
    const page = await fetchRemoteDiagnostics(config, { version: String(first.version), cursor })
    if (page.version !== 2 && page.version !== 3) throw failure('bad-response')
    response = page
  }
  throw failure('bad-response')
}

/** Collects one complete immutable snapshot, preferring safe v3 facts and falling back to an older v2 server. */
export async function investigateRemoteDiagnostics(
  config: RemoteDiagnosticsConfig,
  input: Record<string, string> = {},
): Promise<RemoteDiagnosticsInvestigation> {
  if (
    input.cursor !== undefined ||
    (input.requestUid !== undefined && input.operationRef !== undefined) ||
    (input.version !== undefined && input.version !== '2' && input.version !== '3')
  )
    throw failure('invalid-query')
  const preferredVersion = input.version === '2' ? 2 : 3
  const initial = (version: 2 | 3) => ({ ...input, version: String(version), limit: '200' })
  let first: RemoteDiagnosticsResponse
  try {
    first = await fetchRemoteDiagnostics(config, initial(preferredVersion))
  } catch (error) {
    if (
      preferredVersion !== 3 ||
      !(error instanceof RemoteDiagnosticsHelperError) ||
      error.category !== 'invalid-query'
    )
      throw error
    first = await fetchRemoteDiagnostics(config, initial(2))
  }
  if (first.version !== 2 && first.version !== 3) throw failure('bad-response')
  return collectInvestigation(config, first)
}

async function run(): Promise<void> {
  try {
    const { investigate, query } = parseCliArguments(process.argv.slice(2))
    const config = readRemoteDiagnosticsConfig(process.env.RISU_DIAGNOSTICS_REMOTE_CONFIG)
    const response = investigate
      ? await investigateRemoteDiagnostics(config, query)
      : await fetchRemoteDiagnostics(config, query)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  } catch (error) {
    const category = error instanceof RemoteDiagnosticsHelperError ? error.category : 'bad-response'
    process.stderr.write(`${category}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void run()
