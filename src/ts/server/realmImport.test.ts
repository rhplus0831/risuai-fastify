import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platformState = vi.hoisted(() => ({ isFastifyServer: true }))
const commandState = vi.hoisted(() => ({
  baseRevision: 7 as number | null,
  cachedRevision: null as number | null,
  reconciledEvents: [] as unknown[],
}))

vi.mock('../platform', async (importActual) => {
  const actual = await importActual<typeof import('../platform')>()
  return {
    ...actual,
    get isFastifyServer() {
      return platformState.isFastifyServer
    },
  }
})

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'realm-auth-token',
}))

vi.mock('./activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  handleActiveWriterStaleResponse: () => false,
}))

vi.mock('./commands', () => ({
  getServerCommandBaseRevision: async () => commandState.baseRevision,
  setCachedServerCommandRevision: (revision: number) => {
    commandState.cachedRevision = revision
  },
  withDirectServerCommandEventReconciliation: async (
    _matches: (event: unknown) => boolean,
    operation: (reconcile: (event: unknown) => Promise<void>) => Promise<unknown>,
  ) =>
    operation(async (event) => {
      commandState.reconciledEvents.push(event)
    }),
}))

import { importRealmCharacterFromServer } from './realmImport'

interface CapturedFetch {
  url: string
  headers: Record<string, string>
  body: unknown
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text))
      controller.close()
    },
  })
}

function stubRealmFetch(response: Response): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>
      calls.push({
        url: String(input),
        headers,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })
      return response
    }) as unknown as typeof fetch,
  )
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  platformState.isFastifyServer = true
  commandState.baseRevision = 7
  commandState.cachedRevision = null
  commandState.reconciledEvents = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Realm import server adapter', () => {
  it('reads progress SSE frames and returns the done payload', async () => {
    const calls = stubRealmFetch(
      new Response(
        streamOf(
          [
            'event: progress',
            'data: {"phase":"download","message":"Downloading Realm character","percent":12}',
            '',
            'event: done',
            'data: {"revision":9,"event":{"type":"character.created","resource":"character","revision":9,"id":"char-1"},"characterId":"char-1"}',
            '',
            '',
          ].join('\n'),
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const progress: unknown[] = []

    const result = await importRealmCharacterFromServer('realm-id', {
      onProgress: (frame) => progress.push(frame),
    })

    expect(result).toMatchObject({ status: 'ok', revision: 9, characterId: 'char-1' })
    expect(progress).toEqual([{ phase: 'download', message: 'Downloading Realm character', percent: 12 }])
    expect(calls[0]).toMatchObject({
      url: '/api/v1/import/realm-character',
      headers: {
        accept: 'text/event-stream',
        'risu-auth': 'realm-auth-token',
        'risu-writer-session': 'writer-a',
      },
      body: {
        id: 'realm-id',
        baseRevision: 7,
        allowLowLevelAccess: false,
        clientCapabilities: { realmProgressDelta: true },
      },
    })
    expect(commandState.cachedRevision).toBe(9)
    expect(commandState.reconciledEvents).toEqual([
      { type: 'character.created', resource: 'character', revision: 9, id: 'char-1' },
    ])
  })

  it('falls back to JSON parsing when progress is requested but JSON is returned', async () => {
    stubRealmFetch(
      jsonResponse({
        revision: 11,
        event: { type: 'character.created', resource: 'character', revision: 11, id: 'char-json' },
        characterId: 'char-json',
      }),
    )

    const result = await importRealmCharacterFromServer('realm-id', { onProgress: vi.fn() })

    expect(result).toMatchObject({ status: 'ok', revision: 11, characterId: 'char-json' })
    expect(commandState.cachedRevision).toBe(11)
  })

  it('reconstructs negotiated progress deltas and does not inherit a partial first frame', async () => {
    stubRealmFetch(
      new Response(
        streamOf(
          [
            'event: progress',
            'data: {"percent":1}',
            '',
            'event: progress',
            'data: {"phase":"download","message":"Downloading","percent":5}',
            '',
            'event: progress',
            'data: {"percent":12}',
            '',
            'event: progress',
            'data: {"phase":"assets","percent":35}',
            '',
            'event: progress',
            'data: {"message":"Saving assets","percent":50}',
            '',
            'event: done',
            'data: {"revision":9,"event":{"type":"character.created","resource":"character","revision":9,"id":"char-delta"},"characterId":"char-delta"}',
            '',
            '',
          ].join('\n'),
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const progress: unknown[] = []

    await expect(
      importRealmCharacterFromServer('realm-id', { onProgress: (frame) => progress.push(frame) }),
    ).resolves.toMatchObject({ status: 'ok', characterId: 'char-delta' })
    expect(progress).toEqual([
      { phase: 'download', message: 'Downloading', percent: 5 },
      { phase: 'download', message: 'Downloading', percent: 12 },
      { phase: 'assets', message: 'Downloading', percent: 35 },
      { phase: 'assets', message: 'Saving assets', percent: 50 },
    ])

    stubRealmFetch(
      new Response(
        streamOf(
          [
            'event: progress',
            'data: {"percent":99}',
            '',
            'event: done',
            'data: {"revision":10,"event":{"type":"character.created","resource":"character","revision":10,"id":"char-second"},"characterId":"char-second"}',
            '',
            '',
          ].join('\n'),
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    const secondProgress = vi.fn()
    await importRealmCharacterFromServer('realm-id-2', { onProgress: secondProgress })
    expect(secondProgress).not.toHaveBeenCalled()
  })

  it('sends a pending import token with confirmed low-level retries', async () => {
    const calls = stubRealmFetch(
      jsonResponse({
        revision: 12,
        event: { type: 'character.created', resource: 'character', revision: 12, id: 'char-confirmed' },
        characterId: 'char-confirmed',
      }),
    )

    const result = await importRealmCharacterFromServer('realm-id', {
      allowLowLevelAccess: true,
      pendingImportToken: 'pending-token',
    })

    expect(result).toMatchObject({ status: 'ok', revision: 12, characterId: 'char-confirmed' })
    expect(calls[0].body).toMatchObject({
      id: 'realm-id',
      baseRevision: 7,
      allowLowLevelAccess: true,
      pendingImportToken: 'pending-token',
      clientCapabilities: { realmProgressDelta: true },
    })
  })

  it('maps progress stream low-level-access and conflicts', async () => {
    stubRealmFetch(
      new Response(
        streamOf(['event: conflict', 'data: {"error":"Revision mismatch","currentRevision":15}', '', ''].join('\n')),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )

    await expect(importRealmCharacterFromServer('realm-id', { onProgress: vi.fn() })).resolves.toEqual({
      status: 'conflict',
      currentRevision: 15,
    })
    expect(commandState.cachedRevision).toBe(15)

    stubRealmFetch(
      new Response(
        streamOf(
          ['event: low_level_access', 'data: {"error":"confirm","pendingImportToken":"pending-token"}', '', ''].join(
            '\n',
          ),
        ),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    )

    await expect(importRealmCharacterFromServer('realm-id', { onProgress: vi.fn() })).resolves.toEqual({
      status: 'low-level-access',
      pendingImportToken: 'pending-token',
    })
  })
})

describe('Realm import writer lifecycle', () => {
  it('denies Reader import before sending transport', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(importRealmCharacterFromServer('realm-id')).resolves.toMatchObject({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves exact success without replaying old progress or projection after re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onProgress = vi.fn()
    const pending = importRealmCharacterFromServer('realm-id', { onProgress })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(
      new Response(
        streamOf(
          'event: progress\ndata: {"phase":"download","percent":12}\n\nevent: done\ndata: {"revision":9,"event":{"type":"character.created","resource":"character","revision":9,"id":"char-1"},"characterId":"char-1"}\n\n',
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    await expect(pending).resolves.toMatchObject({ status: 'ok', characterId: 'char-1' })
    expect(commandState.cachedRevision).toBeNull()
    expect(commandState.reconciledEvents).toEqual([])
    expect(onProgress).not.toHaveBeenCalled()
  })
})
