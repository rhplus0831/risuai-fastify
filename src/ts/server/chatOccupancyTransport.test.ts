import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ read: vi.fn(async () => 'occupancy-auth') }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: auth.read }))
vi.mock('./browserDiagnostics', () => ({
  recordBrowserDiagnostic: vi.fn(),
  resetBrowserDiagnosticsSession: vi.fn(),
}))

import {
  beginClientSession,
  captureClientSessionGeneration,
  requireClientAuthentication,
  resetClientSessionForTests,
  settleClientReader,
} from '../clientSession'
import {
  CHAT_OCCUPANCY_REQUEST_TIMEOUT_MS,
  claimChatOccupancy,
  fetchChatOccupancySnapshot,
  normalizeChatOccupancies,
  releaseChatOccupancy,
  renewChatOccupancy,
  switchChatOccupancy,
} from './chatOccupancyTransport'

function projection(chatId = 'chat/a', occupancyEpoch = 3) {
  return {
    databaseLineage: 'database-a',
    chatId,
    occupantSessionId: 'reader-a',
    occupancyEpoch,
    claimClass: 'chat_only' as const,
    state: 'occupied' as const,
    claimedAtMs: 1_000,
    leaseExpiresAtMs: 91_000,
    updatedAtMs: 1_000,
    releasedAtMs: null,
  }
}

function scope() {
  return { databaseLineage: 'database-a', sessionId: 'reader-a', generation: captureClientSessionGeneration() }
}

function becomeReader() {
  const operation = beginClientSession('reader-a')
  settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'owner-a', epoch: 1 } })
}

function response(body: unknown, status = 200, requestUid?: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(requestUid ? { 'X-Request-UID': requestUid } : {}) },
  })
}

beforeEach(() => {
  auth.read.mockReset()
  auth.read.mockResolvedValue('occupancy-auth')
  vi.stubGlobal('fetch', vi.fn())
  becomeReader()
})

afterEach(() => {
  resetClientSessionForTests()
  vi.unstubAllGlobals()
})

describe('chat occupancy transport', () => {
  it('fetches a lineage-coherent no-store snapshot with page identity headers', async () => {
    const snapshot = { version: 1 as const, databaseLineage: 'database-a', occupancies: [projection()] }
    vi.mocked(fetch).mockResolvedValue(response(snapshot, 200, 'request-snapshot'))

    await expect(fetchChatOccupancySnapshot(scope())).resolves.toEqual({
      status: 'ok',
      snapshot,
      requestUid: 'request-snapshot',
    })
    expect(fetch).toHaveBeenCalledWith('/api/v1/chat-occupancies', {
      method: 'GET',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
      headers: {
        'risu-auth': 'occupancy-auth',
        'risu-writer-session': 'reader-a',
        'risu-database-lineage': 'database-a',
      },
    })
  })

  it('uses exact protocol bodies, encoded chat paths, lineage/session, and epoch headers', async () => {
    const occupied = projection()
    vi.mocked(fetch).mockImplementation(async () => response(occupied))
    const current = scope()

    await claimChatOccupancy(current, {
      chatId: 'chat/a',
      expectedOccupancyEpoch: 2,
      claimClass: 'chat_only',
    })
    await renewChatOccupancy(current, occupied)
    await releaseChatOccupancy(current, occupied)
    vi.mocked(fetch).mockResolvedValueOnce(response(projection('chat/b', 4)))
    await expect(
      switchChatOccupancy(current, {
        sourceChatId: 'chat/a',
        targetChatId: 'chat/b',
        occupancyEpoch: 3,
      }),
    ).resolves.toMatchObject({ status: 'ok', occupancy: projection('chat/b', 4) })
    await normalizeChatOccupancies(current, occupied)

    const requests = vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url, init }))
    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ['/api/v1/chat-occupancies/chat%2Fa/claim', 'POST'],
      ['/api/v1/chat-occupancies/chat%2Fa/lease', 'PUT'],
      ['/api/v1/chat-occupancies/chat%2Fa', 'DELETE'],
      ['/api/v1/chat-occupancies/switch', 'POST'],
      ['/api/v1/chat-occupancies/normalize', 'POST'],
    ])
    for (const { init } of requests) {
      expect(init?.headers).toMatchObject({
        'risu-auth': 'occupancy-auth',
        'risu-writer-session': 'reader-a',
        'risu-database-lineage': 'database-a',
        'risu-chat-occupancy-epoch': expect.any(String),
        'content-type': 'application/json',
      })
    }
    expect(requests.map(({ init }) => (init?.headers as Record<string, string>)['risu-chat-occupancy-epoch'])).toEqual([
      '2',
      '3',
      '3',
      '3',
      '3',
    ])
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { version: 1, claimClass: 'chat_only' },
      { version: 1 },
      { version: 1 },
      { version: 1, sourceChatId: 'chat/a', targetChatId: 'chat/b' },
      { version: 1, selectedChatId: 'chat/a' },
    ])
  })

  it('preserves structured conflict details and rejects malformed success projections', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      response(
        {
          error: 'chat_occupied',
          chatId: 'chat/a',
          safeRelease: 'Use the current occupant session.',
        },
        423,
        'request-conflict',
      ),
    )
    await expect(
      claimChatOccupancy(scope(), { chatId: 'chat/a', expectedOccupancyEpoch: 0, claimClass: 'chat_only' }),
    ).resolves.toEqual({
      status: 'error',
      error: 'chat_occupied',
      httpStatus: 423,
      requestUid: 'request-conflict',
      details: { chatId: 'chat/a', safeRelease: 'Use the current occupant session.' },
    })

    vi.mocked(fetch).mockResolvedValueOnce(response({ ...projection(), databaseLineage: 'database-b' }))
    await expect(renewChatOccupancy(scope(), projection())).resolves.toMatchObject({
      status: 'error',
      error: 'Invalid chat occupancy mutation response',
    })
  })

  it('fences auth-delayed requests after the client session generation is replaced', async () => {
    let releaseAuth!: (value: string) => void
    auth.read.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseAuth = resolve
      }),
    )
    const request = fetchChatOccupancySnapshot(scope())
    requireClientAuthentication()
    releaseAuth('late-auth')

    await expect(request).resolves.toEqual({ status: 'unavailable', reason: 'superseded' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a pending auth acquisition without dispatching fetch', async () => {
    auth.read.mockReturnValueOnce(new Promise(() => undefined))
    const controller = new AbortController()
    const request = fetchChatOccupancySnapshot(scope(), controller.signal)
    controller.abort()

    await expect(request).resolves.toEqual({ status: 'unavailable', reason: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds a pending auth acquisition at the transport deadline', async () => {
    vi.useFakeTimers()
    auth.read.mockReturnValueOnce(new Promise(() => undefined))
    const request = fetchChatOccupancySnapshot(scope())
    await vi.advanceTimersByTimeAsync(CHAT_OCCUPANCY_REQUEST_TIMEOUT_MS)

    await expect(request).resolves.toEqual({ status: 'error', error: 'Network error: Request timed out' })
    expect(fetch).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('rejects snapshots from another database lineage', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ version: 1, databaseLineage: 'database-b', occupancies: [] }))
    await expect(fetchChatOccupancySnapshot(scope())).resolves.toMatchObject({
      status: 'error',
      error: 'Invalid chat occupancy snapshot response',
    })
  })
})
