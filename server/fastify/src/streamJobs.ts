import { createHash, randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Readable } from 'node:stream'
import { filterResponseHeaders, normalizeForwardHeaders } from './proxy.js'
import {
  PluginNetworkTargetError,
  requestPluginNetworkWithRedirects,
  requestResolvedPluginNetworkTarget,
  type PluginDnsAddress,
  type PluginDnsResolver,
  type PluginNetworkRedirectDependencies,
  type PluginNetworkRequestOptions,
  type ResolvedPluginNetworkTarget,
} from './pluginNetwork.js'
import { STREAM_CLIENT_MAX_BUFFERED_BYTES } from './streamBackpressure.js'
import { SHARED_DEFAULT_REQUEST_TIMEOUT_MS, SHARED_MAX_REQUEST_TIMEOUT_MS } from './requestTimeouts.js'

export const PROXY_STREAM_DEFAULT_TIMEOUT_MS = SHARED_DEFAULT_REQUEST_TIMEOUT_MS
export const PROXY_STREAM_MAX_TIMEOUT_MS = SHARED_MAX_REQUEST_TIMEOUT_MS
/** Hard wall-clock lifetime even when useful stream activity refreshes the inactivity deadline. */
export const PROXY_STREAM_ABSOLUTE_LIFETIME_MS = PROXY_STREAM_MAX_TIMEOUT_MS
export const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15
export const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5
export const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60
export const PROXY_STREAM_GC_INTERVAL_MS = 60_000
export const PROXY_STREAM_DONE_GRACE_MS = 30_000
export const PROXY_STREAM_MAX_ACTIVE_JOBS = 64
export const PROXY_STREAM_MAX_PENDING_EVENTS = 512
export const PROXY_STREAM_MAX_PENDING_BYTES = 2 * 1024 * 1024
export const DURABLE_REPLAY_MAX_AGGREGATE_BYTES = 16 * 1024 * 1024
/** Maximum serialized durable terminal frame and on-disk snapshot size. */
export const DURABLE_TERMINAL_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024
export const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024

export type StreamJobEvent =
  | { type: 'job_accepted'; jobId: string }
  | {
      type: 'upstream_headers'
      status: number
      headers: Record<string, string>
    }
  | { type: 'done' }
  | { type: 'error'; status: number; message: string }
  | { type: 'ping'; ts: number }

export type StreamJobFrame = string | Buffer

export interface JobClient {
  send(frame: StreamJobFrame): void
  close(): void
  /** Resolves once a graceful transport close has finished, when observable. */
  readonly closeSettled?: Promise<void>
  readonly open: boolean
  readonly bufferedBytes?: number
}

export interface StreamJob {
  id: string
  createdAt: number
  updatedAt: number
  done: boolean
  cleanupAt: number
  clients: Set<JobClient>
  pendingEvents: StreamJobFrame[]
  pendingBytes: number
  replayEvents?: string[]
  replayBytes?: number
  replayFrameSequences?: number[]
  replayTruncated?: boolean
  replayEvictedEvents?: number
  replayEvictedBytes?: number
  replayTerminalSnapshot?: {
    bytes: number
    href: string
  }
  abortController: AbortController
  deadlineAt: number
  absoluteDeadlineAt: number
  heartbeatSec: number
  timeoutMs: number
  absoluteLifetimeMs: number
  slidingDeadline: boolean
  /**
   * Durable-generation extensions. Unused by the proxy stream job. `chatId` ties
   * the job to its chat for the one-job-per-chat submission lock and reload-resume
   * projection. `writerSessionId` records the active-writer identity present at
   * submission for diagnostics; completion does not re-check it because the job was
   * already authorized at submission.
   *
   * `mode` / `regenerateMessageId` ride the `activeGenerationJobs` projection so
   * a reloaded browser can reattach with the right generating mode.
   */
  chatId?: string
  writerSessionId?: string | null
  mode?: 'send' | 'continue' | 'regenerate'
  continueDisposition?: 'append' | 'extend'
  regenerateMessageId?: string
  /**
   * Durable operation lineage. Proxy jobs leave these fields unset. Every
   * durable chat generation created by the operation protocol (including the
   * compatibility route's server-created legacy claim) sets the complete
   * required envelope before it is registered or exposed to a viewer.
   */
  databaseLineage?: string
  operationId?: string
  operationProtocolVersion?: number
  writerEpoch?: number
  operationStateVersion?: number
  projectionEpoch?: number
  attemptNo?: number
  acceptedMessageId?: string
  targetMessageId?: string
  /**
   * Set when no-viewer pending frames were dropped at the cap. The
   * buffered prefix is gone, so a late viewer could never see a coherent
   * stream — the proxy runner aborts the upstream instead of draining the rest
   * of the response into a lossy window. Never set for durable jobs (their
   * replay buffer takes the no-client frames).
   */
  pendingOverflow?: boolean
}

const DURABLE_REPLAY_PROTECTED_EVENTS = new Set([
  'prompt',
  'info',
  'message_patch',
  'side_effect',
  'agent_preset_progress',
  'post_generation_progress',
  'warning',
  'error',
  'done',
])

const DURABLE_REPLAY_ESSENTIAL_EVENTS = new Set(['prompt', 'info', 'error', 'done'])
const DURABLE_REPLAY_TOKEN_COMPACTION_FRAMES = 64

const PRIVATE_BLOCKS = (() => {
  const list = new net.BlockList()
  list.addRange('10.0.0.0', '10.255.255.255', 'ipv4')
  list.addRange('127.0.0.0', '127.255.255.255', 'ipv4')
  list.addRange('172.16.0.0', '172.31.255.255', 'ipv4')
  list.addRange('192.168.0.0', '192.168.255.255', 'ipv4')
  list.addRange('169.254.0.0', '169.254.255.255', 'ipv4')
  list.addRange('0.0.0.0', '0.255.255.255', 'ipv4')
  list.addAddress('::1', 'ipv6')
  list.addRange('fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ipv6')
  list.addRange('fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ipv6')
  // IPv4-mapped IPv6 forms of the private ranges (covers both the
  // ::ffff:10.0.0.1 dotted and ::ffff:a00:1 hex canonical notations).
  list.addRange('::ffff:10.0.0.0', '::ffff:10.255.255.255', 'ipv6')
  list.addRange('::ffff:127.0.0.0', '::ffff:127.255.255.255', 'ipv6')
  list.addRange('::ffff:172.16.0.0', '::ffff:172.31.255.255', 'ipv6')
  list.addRange('::ffff:192.168.0.0', '::ffff:192.168.255.255', 'ipv6')
  list.addRange('::ffff:169.254.0.0', '::ffff:169.254.255.255', 'ipv6')
  list.addRange('::ffff:0.0.0.0', '::ffff:0.255.255.255', 'ipv6')
  return list
})()

export function isLocalNetworkHost(hostname: string): boolean {
  if (typeof hostname !== 'string' || hostname.trim() === '') return false
  let normalized = hostname.toLowerCase().replace(/\.$/, '').split('%')[0]
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }
  if (normalized === 'localhost' || normalized.endsWith('.local')) {
    return true
  }
  const family = net.isIP(normalized)
  if (family === 4) return PRIVATE_BLOCKS.check(normalized, 'ipv4')
  if (family === 6) return PRIVATE_BLOCKS.check(normalized, 'ipv6')
  return false
}

const defaultLocalNetworkResolver: PluginDnsResolver = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses
    .filter((entry): entry is { address: string; family: 4 | 6 } => entry.family === 4 || entry.family === 6)
    .map((entry) => ({ address: entry.address, family: entry.family }))
}

/**
 * Resolves a local-network target once and requires every answer to stay in the
 * deliberate loopback/private/link-local boundary. The selected address is
 * pinned into the socket so a second DNS answer cannot pivot the request.
 */
export async function resolveLocalNetworkTarget(
  rawUrl: unknown,
  resolver: PluginDnsResolver = defaultLocalNetworkResolver,
): Promise<ResolvedPluginNetworkTarget> {
  const sanitized = sanitizeLocalTargetUrl(rawUrl)
  if (!sanitized) throw new PluginNetworkTargetError('Blocked non-local target URL', 400)

  const url = new URL(sanitized)
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .split('%')[0]
  const literalFamily = net.isIP(hostname)
  let addresses: readonly PluginDnsAddress[]
  try {
    addresses = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : await resolver(hostname)
  } catch {
    throw new PluginNetworkTargetError('Local network target could not be resolved', 502)
  }

  if (addresses.length === 0) {
    throw new PluginNetworkTargetError('Local network target could not be resolved', 502)
  }
  if (addresses.some((entry) => !isLocalNetworkHost(entry.address))) {
    throw new PluginNetworkTargetError('Local network target resolved outside the private network', 403)
  }

  const selected = addresses[0]
  return { url, address: selected.address, family: selected.family }
}

const defaultLocalRedirectDependencies: PluginNetworkRedirectDependencies = {
  resolveTarget: (rawUrl) => resolveLocalNetworkTarget(rawUrl),
  requestTarget: requestResolvedPluginNetworkTarget,
}

export function requestLocalNetworkWithRedirects(
  rawUrl: string,
  options: PluginNetworkRequestOptions,
  dependencies: PluginNetworkRedirectDependencies = defaultLocalRedirectDependencies,
) {
  return requestPluginNetworkWithRedirects(rawUrl, options, dependencies)
}

export function sanitizeLocalTargetUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!isLocalNetworkHost(parsed.hostname)) return null
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return null
  }
}

export function normalizeStreamTimeoutMs(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return PROXY_STREAM_DEFAULT_TIMEOUT_MS
  const floored = Math.max(1, Math.floor(value))
  return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, floored)
}

export function normalizeHeartbeatSec(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw)
  if (!Number.isFinite(value)) return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC
  return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, Math.floor(value)))
}

export interface CreateJobOptions {
  /** Preallocated durable-attempt id. Omitted proxy jobs receive a new UUID. */
  id?: string
  timeoutMs: unknown
  absoluteLifetimeMs?: unknown
  heartbeatSec: unknown
  slidingDeadline?: boolean
  now?: number
}

export interface JobRegistryOptions {
  replayMaxEvents?: number
  replayMaxBytes?: number
  replayMaxAggregateBytes?: number
  replaySnapshotMaxBytes?: number
  replaySnapshotDir?: string
}

export class DurableTerminalSnapshotLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`durable terminal snapshot exceeded the ${maxBytes}-byte size cap`)
    this.name = 'DurableTerminalSnapshotLimitError'
  }
}

function serializedSseEventType(text: string): string | undefined {
  const firstLineEnd = text.search(/\r?\n/)
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)
  return firstLine.startsWith('event: ') ? firstLine.slice('event: '.length).trim() : undefined
}

function serializedSseData(text: string): unknown {
  const data = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('\n')
  if (data.length === 0) return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

function serializedJsonEventType(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const type = (parsed as { type?: unknown }).type
    return typeof type === 'string' ? type : undefined
  } catch {
    return undefined
  }
}

function isJsonStreamDeadlineActivityFrame(text: string): boolean {
  const type = serializedJsonEventType(text)
  if (!type || type === 'done' || type === 'error' || type === 'ping') return false
  if (type === 'upstream_headers' || type === 'progress' || type === 'info' || type === 'live') {
    return true
  }
  return false
}

export function isStreamDeadlineActivityFrame(text: string): boolean {
  const type = serializedSseEventType(text)
  if (!type) return isJsonStreamDeadlineActivityFrame(text)
  if (type === 'done' || type === 'error') return false
  if (type !== 'token') return true
  const data = serializedSseData(text)
  if (!data || typeof data !== 'object') return false
  const content = (data as { content?: unknown }).content
  return typeof content === 'string' && content.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function formatSerializedSseFrame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

function terminalSnapshotReferenceFrame(job: StreamJob): string | undefined {
  const snapshot = job.replayTerminalSnapshot
  if (!snapshot) return undefined
  return formatSerializedSseFrame('done', {
    jobId: job.id,
    terminalSnapshot: {
      version: 1,
      href: snapshot.href,
      bytes: snapshot.bytes,
    },
  })
}

function replaceableReplaySnapshotKey(text: string): string | undefined {
  const type = serializedSseEventType(text)
  if (type === 'info' || type === 'agent_preset_progress') return type
  if (type !== 'post_generation_progress') return undefined
  const data = serializedSseData(text)
  if (!isRecord(data) || typeof data.phase !== 'string' || typeof data.runSeq !== 'number') return undefined
  return `${type}:${data.phase}:${data.runSeq}`
}

function closeJobClient(client: JobClient): void {
  try {
    client.close()
  } catch {
    // ignore
  }
}

function streamJobFrameBytes(frame: StreamJobFrame): number {
  return typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength
}

function sendBoundedJobClient(client: JobClient, frame: StreamJobFrame): boolean {
  if (!client.open) return false
  const bufferedBytes = typeof client.bufferedBytes === 'number' ? Math.max(0, client.bufferedBytes) : 0
  if (bufferedBytes + streamJobFrameBytes(frame) > STREAM_CLIENT_MAX_BUFFERED_BYTES) {
    closeJobClient(client)
    return false
  }
  try {
    client.send(frame)
  } catch {
    closeJobClient(client)
    return false
  }
  return client.open
}

export class JobRegistry {
  private readonly jobs = new Map<string, StreamJob>()
  private readonly replayMaxEvents: number
  private readonly replayMaxBytes: number
  private readonly replayMaxAggregateBytes: number
  private readonly replaySnapshotMaxBytes: number
  private readonly inactivityDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly absoluteDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private replayAggregateBytes = 0
  private nextReplaySequence = 1
  private replaySnapshotDir: string | undefined

  constructor(options: JobRegistryOptions = {}) {
    this.replayMaxEvents = Math.max(1, Math.floor(options.replayMaxEvents ?? PROXY_STREAM_MAX_PENDING_EVENTS))
    this.replayMaxBytes = Math.max(1, Math.floor(options.replayMaxBytes ?? PROXY_STREAM_MAX_PENDING_BYTES))
    this.replayMaxAggregateBytes = Math.max(
      1,
      Math.floor(options.replayMaxAggregateBytes ?? DURABLE_REPLAY_MAX_AGGREGATE_BYTES),
    )
    this.replaySnapshotMaxBytes = Math.max(
      1,
      Math.floor(options.replaySnapshotMaxBytes ?? DURABLE_TERMINAL_SNAPSHOT_MAX_BYTES),
    )
    this.replaySnapshotDir = options.replaySnapshotDir
  }

  size(): number {
    return this.jobs.size
  }

  has(id: string): boolean {
    return this.jobs.has(id)
  }

  get(id: string): StreamJob | undefined {
    return this.jobs.get(id)
  }

  list(): StreamJob[] {
    return Array.from(this.jobs.values())
  }

  replayMemoryBytes(): number {
    return this.replayAggregateBytes
  }

  private ensureReplaySnapshotDir(): string {
    if (!this.replaySnapshotDir) throw new Error('Durable replay requires a terminal snapshot directory')
    fs.mkdirSync(this.replaySnapshotDir, { recursive: true })
    return this.replaySnapshotDir
  }

  private replaySnapshotPath(jobId: string): string {
    const name = createHash('sha256').update(jobId).digest('hex')
    return path.join(this.ensureReplaySnapshotDir(), `${name}.json`)
  }

  private persistTerminalSnapshot(job: StreamJob, text: string): void {
    if (Buffer.byteLength(text) > this.replaySnapshotMaxBytes) {
      throw new DurableTerminalSnapshotLimitError(this.replaySnapshotMaxBytes)
    }
    const data = serializedSseData(text)
    if (!isRecord(data)) throw new Error('Durable terminal frame did not contain a JSON object payload')
    const payload = JSON.stringify(data)
    const payloadBytes = Buffer.byteLength(payload)
    if (payloadBytes > this.replaySnapshotMaxBytes) {
      throw new DurableTerminalSnapshotLimitError(this.replaySnapshotMaxBytes)
    }
    const target = this.replaySnapshotPath(job.id)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, target)
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        // Preserve the snapshot write failure.
      }
      throw error
    }
    job.replayTerminalSnapshot = {
      bytes: payloadBytes,
      href: `/api/v1/generate/chat/${encodeURIComponent(job.id)}/terminal-snapshot`,
    }
  }

  terminalSnapshotStream(jobId: string): { stream: Readable; bytes: number } | null {
    const job = this.jobs.get(jobId)
    if (!job?.replayTerminalSnapshot) return null
    const snapshotPath = this.replaySnapshotPath(jobId)
    try {
      const fd = fs.openSync(snapshotPath, 'r')
      return {
        stream: fs.createReadStream(snapshotPath, { fd, autoClose: true }),
        bytes: job.replayTerminalSnapshot.bytes,
      }
    } catch {
      return null
    }
  }

  readTerminalSnapshot(jobId: string): string | null {
    const job = this.jobs.get(jobId)
    if (!job?.replayTerminalSnapshot) return null
    const snapshotPath = this.replaySnapshotPath(jobId)
    try {
      return fs.readFileSync(snapshotPath, 'utf8')
    } catch {
      return null
    }
  }

  private removeTerminalSnapshot(job: StreamJob): void {
    if (!job.replayTerminalSnapshot || !this.replaySnapshotDir) return
    const name = createHash('sha256').update(job.id).digest('hex')
    try {
      fs.rmSync(path.join(this.replaySnapshotDir, `${name}.json`), { force: true })
    } catch {
      // Job cleanup is best-effort; an instance-scoped directory is also removed
      // during registry disposal.
    }
    job.replayTerminalSnapshot = undefined
  }

  private removeReplayFrame(job: StreamJob, index: number, truncated: boolean): string | undefined {
    if (!job.replayEvents || job.replayBytes === undefined || !job.replayFrameSequences) return undefined
    const [removed] = job.replayEvents.splice(index, 1)
    job.replayFrameSequences.splice(index, 1)
    if (!removed) return undefined
    const bytes = Buffer.byteLength(removed)
    job.replayBytes = Math.max(0, job.replayBytes - bytes)
    this.replayAggregateBytes = Math.max(0, this.replayAggregateBytes - bytes)
    if (truncated) {
      job.replayTruncated = true
      job.replayEvictedEvents = (job.replayEvictedEvents ?? 0) + 1
      job.replayEvictedBytes = (job.replayEvictedBytes ?? 0) + bytes
    }
    return removed
  }

  private compactTrailingTokenFrames(job: StreamJob): void {
    if (!job.replayEvents || job.replayBytes === undefined || !job.replayFrameSequences) return
    let start = job.replayEvents.length
    while (start > 0 && job.replayEvents.length - start < DURABLE_REPLAY_TOKEN_COMPACTION_FRAMES) {
      if (serializedSseEventType(job.replayEvents[start - 1]!) !== 'token') break
      start -= 1
    }
    const count = job.replayEvents.length - start
    if (count < DURABLE_REPLAY_TOKEN_COMPACTION_FRAMES) return

    const frames = job.replayEvents.slice(start)
    const payloads = frames.map((frame) => serializedSseData(frame))
    if (payloads.some((payload) => !isRecord(payload) || typeof payload.content !== 'string')) return
    const lastPayload = payloads.at(-1) as Record<string, unknown>
    const merged = formatSerializedSseFrame('token', {
      ...lastPayload,
      content: payloads.map((payload) => (payload as { content: string }).content).join(''),
    })
    const removedBytes = frames.reduce((total, frame) => total + Buffer.byteLength(frame), 0)
    const mergedBytes = Buffer.byteLength(merged)
    const sequence = job.replayFrameSequences[start] ?? this.nextReplaySequence++
    job.replayEvents.splice(start, count, merged)
    job.replayFrameSequences.splice(start, count, sequence)
    job.replayBytes += mergedBytes - removedBytes
    this.replayAggregateBytes += mergedBytes - removedBytes
  }

  private appendReplayFrame(job: StreamJob, text: string): void {
    if (!job.replayEvents || job.replayBytes === undefined || !job.replayFrameSequences) return
    const snapshotKey = replaceableReplaySnapshotKey(text)
    if (snapshotKey) {
      const existingSnapshotIndex = job.replayEvents.findIndex(
        (event) => replaceableReplaySnapshotKey(event) === snapshotKey,
      )
      if (existingSnapshotIndex !== -1) this.removeReplayFrame(job, existingSnapshotIndex, false)
    }

    job.replayEvents.push(text)
    job.replayFrameSequences.push(this.nextReplaySequence++)
    const bytes = Buffer.byteLength(text)
    job.replayBytes += bytes
    this.replayAggregateBytes += bytes
    if (serializedSseEventType(text) === 'token') this.compactTrailingTokenFrames(job)
    this.enforceReplayBudgets(job)
  }

  private terminalFrameIndex(job: StreamJob): number {
    return job.replayEvents?.findIndex((event) => serializedSseEventType(event) === 'done') ?? -1
  }

  private droppableFrameIndex(job: StreamJob, preferUnprotected: boolean): number {
    if (!job.replayEvents) return -1
    return job.replayEvents.findIndex((event) => {
      const eventType = serializedSseEventType(event)
      if (eventType === 'done') return false
      return !preferUnprotected || !eventType || !DURABLE_REPLAY_PROTECTED_EVENTS.has(eventType)
    })
  }

  private nonessentialFrameIndex(job: StreamJob): number {
    if (!job.replayEvents) return -1
    return job.replayEvents.findIndex((event) => {
      const eventType = serializedSseEventType(event)
      return !eventType || !DURABLE_REPLAY_ESSENTIAL_EVENTS.has(eventType)
    })
  }

  private oldestAggregateCandidate(
    predicate: (event: string) => boolean,
  ): { job: StreamJob; index: number; sequence: number } | undefined {
    let selected: { job: StreamJob; index: number; sequence: number } | undefined
    for (const job of this.jobs.values()) {
      if (!job.replayEvents || !job.replayFrameSequences) continue
      for (let index = 0; index < job.replayEvents.length; index += 1) {
        const event = job.replayEvents[index]
        const sequence = job.replayFrameSequences[index]
        if (event === undefined || sequence === undefined || !predicate(event)) continue
        if (!selected || sequence < selected.sequence) selected = { job, index, sequence }
      }
    }
    return selected
  }

  private enforceReplayBudgets(appendedJob: StreamJob): void {
    if (!appendedJob.replayEvents || appendedJob.replayBytes === undefined) return
    while (appendedJob.replayEvents.length > this.replayMaxEvents || appendedJob.replayBytes > this.replayMaxBytes) {
      const terminalIndex = this.terminalFrameIndex(appendedJob)
      if (terminalIndex !== -1 && appendedJob.replayTerminalSnapshot) {
        this.removeReplayFrame(appendedJob, terminalIndex, false)
        continue
      }
      const unprotectedIndex = this.droppableFrameIndex(appendedJob, true)
      const nonessentialIndex = this.nonessentialFrameIndex(appendedJob)
      const candidateIndex =
        unprotectedIndex !== -1
          ? unprotectedIndex
          : nonessentialIndex !== -1
            ? nonessentialIndex
            : this.droppableFrameIndex(appendedJob, false)
      if (candidateIndex === -1) break
      this.removeReplayFrame(appendedJob, candidateIndex, true)
    }

    while (this.replayAggregateBytes > this.replayMaxAggregateBytes) {
      const terminal = this.oldestAggregateCandidate((event) => serializedSseEventType(event) === 'done')
      if (terminal?.job.replayTerminalSnapshot) {
        this.removeReplayFrame(terminal.job, terminal.index, false)
        continue
      }
      const unprotected = this.oldestAggregateCandidate((event) => {
        const eventType = serializedSseEventType(event)
        return eventType !== 'done' && (!eventType || !DURABLE_REPLAY_PROTECTED_EVENTS.has(eventType))
      })
      const candidate =
        unprotected ??
        this.oldestAggregateCandidate((event) => {
          const eventType = serializedSseEventType(event)
          return !eventType || !DURABLE_REPLAY_ESSENTIAL_EVENTS.has(eventType)
        }) ??
        this.oldestAggregateCandidate((event) => serializedSseEventType(event) !== 'done')
      if (!candidate) break
      this.removeReplayFrame(candidate.job, candidate.index, true)
    }
  }

  private clearDeadlineTimer(timers: Map<string, ReturnType<typeof setTimeout>>, jobId: string): void {
    const timer = timers.get(jobId)
    if (!timer) return
    clearTimeout(timer)
    timers.delete(jobId)
  }

  private armDeadlineTimer(timers: Map<string, ReturnType<typeof setTimeout>>, job: StreamJob, delayMs: number): void {
    this.clearDeadlineTimer(timers, job.id)
    const timer = setTimeout(() => {
      timers.delete(job.id)
      if (this.jobs.get(job.id) !== job || job.done) return
      this.clearJobDeadlineTimers(job.id)
      if (job.abortController.signal.aborted) return
      job.abortController.abort()
    }, delayMs)
    timer.unref?.()
    timers.set(job.id, timer)
  }

  private armInactivityDeadline(job: StreamJob): void {
    this.armDeadlineTimer(this.inactivityDeadlineTimers, job, job.timeoutMs)
  }

  private clearJobDeadlineTimers(jobId: string): void {
    this.clearDeadlineTimer(this.inactivityDeadlineTimers, jobId)
    this.clearDeadlineTimer(this.absoluteDeadlineTimers, jobId)
  }

  create(opts: CreateJobOptions): StreamJob {
    const timeoutMs = normalizeStreamTimeoutMs(opts.timeoutMs)
    const absoluteLifetimeMs = normalizeStreamTimeoutMs(opts.absoluteLifetimeMs ?? PROXY_STREAM_ABSOLUTE_LIFETIME_MS)
    const heartbeatSec = normalizeHeartbeatSec(opts.heartbeatSec)
    const createdAt = opts.now ?? Date.now()
    const id = opts.id ?? randomUUID()
    if (this.jobs.has(id)) throw new Error(`Stream job already exists: ${id}`)
    const job: StreamJob = {
      id,
      createdAt,
      updatedAt: createdAt,
      done: false,
      cleanupAt: 0,
      clients: new Set(),
      pendingEvents: [],
      pendingBytes: 0,
      abortController: new AbortController(),
      deadlineAt: createdAt + timeoutMs,
      absoluteDeadlineAt: createdAt + absoluteLifetimeMs,
      heartbeatSec,
      timeoutMs,
      absoluteLifetimeMs,
      slidingDeadline: opts.slidingDeadline === true,
    }
    this.jobs.set(job.id, job)
    this.armInactivityDeadline(job)
    this.armDeadlineTimer(this.absoluteDeadlineTimers, job, absoluteLifetimeMs)
    return job
  }

  refreshDeadline(job: StreamJob, now?: number): void {
    if (job.done || job.abortController.signal.aborted) return
    const t = now ?? Date.now()
    job.updatedAt = t
    job.deadlineAt = t + job.timeoutMs
    this.armInactivityDeadline(job)
  }

  enableReplay(job: StreamJob): void {
    job.replayEvents = []
    job.replayBytes = 0
    job.replayFrameSequences = []
    job.replayTruncated = false
    job.replayEvictedEvents = 0
    job.replayEvictedBytes = 0
  }

  private pushFrame(job: StreamJob, frame: StreamJobFrame): void {
    if (job.clients.size === 0) {
      if (job.replayEvents) return
      job.pendingEvents.push(frame)
      job.pendingBytes += streamJobFrameBytes(frame)
      while (
        job.pendingEvents.length > PROXY_STREAM_MAX_PENDING_EVENTS ||
        job.pendingBytes > PROXY_STREAM_MAX_PENDING_BYTES
      ) {
        const removed = job.pendingEvents.shift()
        if (!removed) break
        job.pendingBytes -= streamJobFrameBytes(removed)
        job.pendingOverflow = true
      }
      return
    }
    const staleClients: JobClient[] = []
    for (const client of job.clients) {
      if (!sendBoundedJobClient(client, frame)) {
        staleClients.push(client)
      }
    }
    for (const client of staleClients) {
      this.detach(job.id, client)
    }
  }

  /**
   * Buffer (no client attached) or fan out an **already-serialized** frame
   * string. Generalizes {@link pushEvent} so the durable-generation runner can
   * buffer pre-formatted SSE frames (`event: …\ndata: …\n\n`) and replay them on
   * reattach without re-encoding — preserving the locked `/generate/chat` event
   * vocabulary and the browser's SSE parser unchanged. The proxy keeps the
   * `pushEvent` (JSON.stringify) path.
   */
  pushRaw(job: StreamJob, text: string, now?: number): void {
    const t = now ?? Date.now()
    job.updatedAt = t
    if (job.slidingDeadline && isStreamDeadlineActivityFrame(text)) {
      this.refreshDeadline(job, t)
    }
    let liveFrame = text
    if (job.replayEvents && serializedSseEventType(text) === 'done') {
      this.persistTerminalSnapshot(job, text)
      if (Buffer.byteLength(text) > this.replayMaxBytes) {
        liveFrame = terminalSnapshotReferenceFrame(job) ?? text
      }
    }
    this.appendReplayFrame(job, text)
    this.pushFrame(job, liveFrame)
  }

  pushBinary(job: StreamJob, bytes: Buffer, now?: number): void {
    const t = now ?? Date.now()
    job.updatedAt = t
    if (job.slidingDeadline && bytes.byteLength > 0) {
      this.refreshDeadline(job, t)
    }
    this.pushFrame(job, bytes)
  }

  pushEvent(job: StreamJob, event: StreamJobEvent, now?: number): void {
    this.pushRaw(job, JSON.stringify(event), now)
  }

  attach(jobId: string, client: JobClient): StreamJob | null {
    const job = this.jobs.get(jobId)
    if (!job) return null
    job.clients.add(client)
    const replayEvents = job.replayEvents ?? job.pendingEvents
    let clientOpen = true
    if (job.replayTruncated) {
      clientOpen = sendBoundedJobClient(
        client,
        formatSerializedSseFrame('replay_gap', {
          reason: 'replay_budget_exceeded',
          jobId: job.id,
          evictedEvents: job.replayEvictedEvents ?? 0,
          evictedBytes: job.replayEvictedBytes ?? 0,
        }),
      )
    }
    for (const text of replayEvents) {
      if (!clientOpen) break
      if (!sendBoundedJobClient(client, text)) {
        clientOpen = false
        break
      }
    }
    if (
      clientOpen &&
      job.replayTerminalSnapshot &&
      !replayEvents.some((event) => typeof event === 'string' && serializedSseEventType(event) === 'done')
    ) {
      const reference = terminalSnapshotReferenceFrame(job)
      if (reference && !sendBoundedJobClient(client, reference)) clientOpen = false
    }
    if (!clientOpen) {
      this.detach(job.id, client)
      return job
    }
    if (!job.replayEvents) {
      job.pendingEvents = []
      job.pendingBytes = 0
    }
    return job
  }

  detach(jobId: string, client: JobClient): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.clients.delete(client)
    if (job.done && job.clients.size === 0 && job.replayEvents === undefined) {
      this.cleanup(jobId)
    }
  }

  markDone(job: StreamJob, now?: number): void {
    if (job.done) return
    job.done = true
    job.cleanupAt = (now ?? Date.now()) + PROXY_STREAM_DONE_GRACE_MS
    this.clearJobDeadlineTimers(job.id)
  }

  cleanup(jobId: string): void {
    const job = this.jobs.get(jobId)
    this.clearJobDeadlineTimers(jobId)
    if (!job) return
    for (const client of job.clients) {
      try {
        client.close()
      } catch {
        // ignore
      }
    }
    if (job.replayBytes !== undefined) {
      this.replayAggregateBytes = Math.max(0, this.replayAggregateBytes - job.replayBytes)
      job.replayBytes = 0
      job.replayEvents = []
      job.replayFrameSequences = []
    }
    this.removeTerminalSnapshot(job)
    this.jobs.delete(jobId)
  }

  dispose(): void {
    for (const job of [...this.jobs.values()]) this.cleanup(job.id)
    for (const timer of this.inactivityDeadlineTimers.values()) clearTimeout(timer)
    for (const timer of this.absoluteDeadlineTimers.values()) clearTimeout(timer)
    this.inactivityDeadlineTimers.clear()
    this.absoluteDeadlineTimers.clear()
    if (this.replaySnapshotDir) {
      try {
        fs.rmSync(this.replaySnapshotDir, { recursive: true, force: true })
      } catch {
        // Best-effort shutdown cleanup.
      }
    }
    this.replaySnapshotDir = undefined
    this.replayAggregateBytes = 0
  }

  deleteJob(jobId: string, reason?: unknown): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    job.abortController.abort(reason)
    this.markDone(job)
    this.cleanup(jobId)
    return true
  }

  tickGc(now?: number): void {
    const t = now ?? Date.now()
    for (const [jobId, job] of this.jobs.entries()) {
      if (!job.done && (t >= job.deadlineAt || t >= job.absoluteDeadlineAt) && !job.abortController.signal.aborted) {
        job.abortController.abort()
      }
      if (job.done && job.clients.size === 0 && job.cleanupAt > 0 && t >= job.cleanupAt) {
        this.cleanup(jobId)
        continue
      }
      if (!job.done && t - job.updatedAt > Math.max(PROXY_STREAM_DEFAULT_TIMEOUT_MS, job.timeoutMs * 2)) {
        this.cleanup(jobId)
      }
    }
  }
}

export interface RunStreamJobArg {
  targetUrl: string
  method: string
  headers: Record<string, string>
  bodyBuffer?: Buffer
  clientIp: string
}

export async function runStreamJob(registry: JobRegistry, job: StreamJob, arg: RunStreamJobArg): Promise<void> {
  const targetUrl = sanitizeLocalTargetUrl(arg.targetUrl)
  if (!targetUrl) {
    registry.pushEvent(job, {
      type: 'error',
      status: 400,
      message: 'Blocked non-local target URL',
    })
    registry.markDone(job)
    return
  }

  const headers = normalizeForwardHeaders(arg.headers)
  if (!headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = arg.clientIp
  }

  try {
    const upstream = await requestLocalNetworkWithRedirects(targetUrl, {
      method: arg.method,
      headers,
      body: arg.bodyBuffer,
      signal: job.abortController.signal,
    })

    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (typeof value === 'string') responseHeaders.set(name, value)
      else if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry)
    }

    registry.pushEvent(job, {
      type: 'upstream_headers',
      status: upstream.statusCode ?? 502,
      headers: filterResponseHeaders(responseHeaders),
    })

    if (upstream.readable) {
      for await (const value of upstream) {
        if (job.abortController.signal.aborted) break
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        if (chunk.length > 0) {
          registry.pushBinary(job, chunk)
        }
        // No-viewer buffer overflow the pending window already
        // dropped frames, so a later viewer would see a corrupt stream.
        // Stop consuming the upstream instead of pulling the whole response
        // through a lossy 2 MB window until the deadline.
        if (job.pendingOverflow && job.clients.size === 0) {
          job.abortController.abort()
          registry.pushEvent(job, {
            type: 'error',
            status: 503,
            message: 'Proxy stream buffer overflowed with no attached viewer',
          })
          registry.markDone(job)
          return
        }
      }
    }

    registry.pushEvent(job, { type: 'done' })
    registry.markDone(job)
  } catch (err) {
    if (err instanceof PluginNetworkTargetError) {
      registry.pushEvent(job, { type: 'error', status: err.statusCode, message: err.message })
      registry.markDone(job)
      return
    }
    const name = (err as { name?: string } | null)?.name
    const message = name === 'AbortError' ? 'Proxy stream job aborted' : `${err}`
    registry.pushEvent(job, { type: 'error', status: 504, message })
    registry.markDone(job)
  }
}
