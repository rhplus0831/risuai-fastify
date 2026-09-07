import { parsePromptChatSseEvent, type PromptChatEvent } from '@risuai/protocol/generation-sse'
import { iterateSseEvents } from '../process/request/sseParse'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import type { ReaderGenerationIdentity } from './readerGenerationTypes'

type TerminalEvent = Extract<PromptChatEvent, { type: 'done' | 'error' }>

export type ReaderGenerationStreamResult =
  | { status: 'terminal'; event: TerminalEvent }
  | { status: 'unavailable'; error: string; httpStatus?: number }
  | { status: 'ended'; error: string }
  | { status: 'aborted' }

export const READER_GENERATION_REQUEST_TIMEOUT_MS = 15_000
export const READER_GENERATION_IDLE_TIMEOUT_MS = 45_000

interface ReaderGenerationStreamOptions {
  identity: ReaderGenerationIdentity
  signal: AbortSignal
  isCurrent: () => boolean
  onEvent: (event: PromptChatEvent) => void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function matchesSuppliedIdentity(value: Record<string, unknown>, identity: ReaderGenerationIdentity): boolean {
  return (['databaseLineage', 'operationId', 'attemptNo', 'jobId', 'characterId', 'chatId'] as const).every(
    (key) => !(key in value) || value[key] === identity[key],
  )
}

function matchesEventIdentity(event: PromptChatEvent, identity: ReaderGenerationIdentity): boolean {
  if (!matchesSuppliedIdentity(event, identity)) return false
  for (const key of ['generationInfo', 'generationProjection', 'generationDisplayProjection'] as const) {
    const nested = record((event as Record<string, unknown>)[key])
    if (nested && !matchesSuppliedIdentity(nested, identity)) return false
  }
  return true
}

function hasDurableIdentity(event: PromptChatEvent, identity: ReaderGenerationIdentity): boolean {
  return (
    event.databaseLineage === identity.databaseLineage &&
    event.operationId === identity.operationId &&
    event.attemptNo === identity.attemptNo &&
    event.jobId === identity.jobId
  )
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

/**
 * One authenticated viewer attempt. EOF, abort and cleanup retire only this
 * HTTP connection; operation discovery/retries and transcript reconciliation
 * belong to the reader coordinator. No generation control or effects run here.
 */
export async function observeReaderGenerationStream({
  identity: suppliedIdentity,
  signal,
  isCurrent,
  onEvent,
}: ReaderGenerationStreamOptions): Promise<ReaderGenerationStreamResult> {
  const identity = { ...suppliedIdentity }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutError: string | undefined
  let opened = false
  let iterator: ReturnType<typeof iterateSseEvents> | undefined
  let verifiedStream = false
  const current = (): boolean => !signal.aborted && isCurrent()
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  const assertCurrent = (): void => {
    if (!current()) controller.abort()
    if (controller.signal.aborted) throw new Error(timeoutError ?? 'Reader generation viewer detached.')
  }
  const armTimeout = (ms: number, error: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutError = error
      controller.abort()
    }, ms)
  }
  // Auth and fetch implementations need not settle promptly after abort. Fence
  // every continuation and race the wait itself, not just the network request.
  const wait = <T>(pending: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const abort = (): void => reject(new Error(timeoutError ?? 'Reader generation viewer detached.'))
      controller.signal.addEventListener('abort', abort, { once: true })
      pending.then(
        (value) => {
          controller.signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error: unknown) => {
          controller.signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
      if (controller.signal.aborted) abort()
    })
  const fetchRead = async (href: string, auth: string, accept: string): Promise<Response> => {
    const response = await wait(
      fetch(href, {
        method: 'GET',
        headers: { 'risu-auth': auth, accept },
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      }).then((value) => {
        // A non-cooperative fetch may resolve after this viewer has retired.
        if (controller.signal.aborted || !current()) cancelBody(value)
        return value
      }),
    )
    assertCurrent()
    return response
  }

  try {
    assertCurrent()
    if (
      !identity.databaseLineage ||
      !identity.operationId ||
      !identity.jobId ||
      !identity.characterId ||
      !identity.chatId ||
      !Number.isSafeInteger(identity.attemptNo) ||
      identity.attemptNo < 1 ||
      !Number.isSafeInteger(identity.projectionEpoch) ||
      identity.projectionEpoch < 0
    ) {
      return { status: 'unavailable', error: 'Incomplete reader generation stream identity.' }
    }
    armTimeout(READER_GENERATION_REQUEST_TIMEOUT_MS, 'Reader generation stream open timed out.')
    const auth = await wait(getNodeServerProxyAuth())
    assertCurrent()
    const href = `/api/v1/generation-operations/${encodeURIComponent(identity.operationId)}/stream?attemptNo=${identity.attemptNo}&jobId=${encodeURIComponent(identity.jobId)}&projectionEpoch=${identity.projectionEpoch}`
    const response = await fetchRead(href, auth, 'text/event-stream')
    assertCurrent()
    if (!response.ok) {
      cancelBody(response)
      return {
        status: 'unavailable',
        error: `Reader generation stream returned HTTP ${response.status}.`,
        httpStatus: response.status,
      }
    }
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      cancelBody(response)
      return { status: 'unavailable', error: 'Reader generation stream response is not an event stream.' }
    }
    opened = true
    iterator = iterateSseEvents(response.body, controller.signal)
    armTimeout(READER_GENERATION_IDLE_TIMEOUT_MS, 'Reader generation stream stopped responding.')
    while (true) {
      const next = await wait(iterator.next())
      assertCurrent()
      if (next.done) return { status: 'ended', error: 'Reader generation stream ended without a terminal event.' }
      // The shared parser yields comment-only heartbeat frames with empty data.
      armTimeout(READER_GENERATION_IDLE_TIMEOUT_MS, 'Reader generation stream stopped responding.')
      const frame = next.value
      if (!frame.data) continue
      let payload: unknown
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }
      let event = parsePromptChatSseEvent(frame.event, payload)
      if (!event || !matchesEventIdentity(event, identity)) continue
      if (hasDurableIdentity(event, identity)) {
        // Protected replay can predate the descriptor's epoch; terminal events
        // can advance it. The operation/attempt/job/lineage remain immutable.
        verifiedStream = true
      } else {
        // The registry itself emits these two transport wrappers without a
        // lineage envelope. They are usable only inside an already verified
        // stream, and may never establish token or terminal authority alone.
        if (
          !verifiedStream ||
          event.jobId !== identity.jobId ||
          !(event.type === 'replay_gap' || (event.type === 'done' && event.terminalSnapshot))
        ) {
          continue
        }
        event = {
          ...event,
          databaseLineage: identity.databaseLineage,
          operationId: identity.operationId,
          attemptNo: identity.attemptNo,
          jobId: identity.jobId,
        }
      }

      if (event.type === 'done' && event.terminalSnapshot) {
        const reference = event.terminalSnapshot
        const snapshotHref = `/api/v1/generate/chat/${encodeURIComponent(identity.jobId)}/terminal-snapshot`
        if (
          reference.version !== 1 ||
          reference.href !== snapshotHref ||
          !Number.isSafeInteger(reference.bytes) ||
          reference.bytes < 0
        ) {
          return { status: 'ended', error: 'Invalid reader generation terminal snapshot reference.' }
        }
        armTimeout(READER_GENERATION_REQUEST_TIMEOUT_MS, 'Reader generation terminal snapshot timed out.')
        const snapshotResponse = await fetchRead(snapshotHref, auth, 'application/json')
        assertCurrent()
        if (!snapshotResponse.ok) {
          cancelBody(snapshotResponse)
          return {
            status: 'ended',
            error: `Reader generation terminal snapshot returned HTTP ${snapshotResponse.status}.`,
          }
        }
        const snapshotPayload: unknown = await wait(snapshotResponse.json())
        assertCurrent()
        const snapshot = parsePromptChatSseEvent('done', snapshotPayload)
        if (
          !snapshot ||
          snapshot.type !== 'done' ||
          (record(snapshotPayload)?.type !== undefined && record(snapshotPayload)?.type !== 'done') ||
          snapshot.terminalSnapshot ||
          !matchesEventIdentity(snapshot, identity)
        ) {
          return { status: 'ended', error: 'Invalid reader generation terminal snapshot payload.' }
        }
        // Snapshot bodies may omit lineage. Supplied immutable fields were
        // checked above, and the verified wire envelope wins any overlap. A
        // registry reference has no epoch, preserving the snapshot's newer one.
        event = { ...snapshot, ...event }
      }

      assertCurrent()
      onEvent(event)
      assertCurrent()
      if (event.type === 'done' || event.type === 'error') return { status: 'terminal', event }
    }
  } catch (error) {
    if (!current()) return { status: 'aborted' }
    return {
      status: opened ? 'ended' : 'unavailable',
      error: timeoutError ?? (error instanceof Error ? error.message : 'Reader generation transport failed.'),
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    controller.abort()
    // Abort first so the shared iterator never waits for a source's potentially
    // stalled cancel callback when its consumer returns after a terminal frame.
    void iterator?.return(undefined).catch(() => {})
  }
}
