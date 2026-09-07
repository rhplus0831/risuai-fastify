import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authReset = vi.hoisted(() => ({ discard: vi.fn(async () => undefined), getAuth: vi.fn() }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: authReset.getAuth }))
vi.mock('../observerProjectionLifecycle', () => ({ discardObserverProjectionState: authReset.discard }))

import {
  beginClientSession,
  getClientSessionSnapshot,
  resetClientSessionForTests,
  settleClientReader,
} from '../clientSession'
import {
  fetchServerCharacter,
  fetchServerCharacters,
  fetchServerCollection,
  fetchServerSettings,
  fetchServerShell,
} from './resourceReads'
import {
  fetchServerBulkCharacterLorebooks,
  fetchServerBulkChatMessages,
  fetchServerCharacterLorebook,
  fetchServerChatMessages,
} from './hydrationReads'
import { fetchServerBootstrap, fetchServerBootstrapReadOnly } from './bootstrap'
import { clearCachedServerCommandRevision, peekCachedServerCommandRevision } from './commands'
import * as diagnostics from '../diagnostics'
import * as telemetry from './startupTelemetry'
import * as resourceCache from './resourceCache'

const readers = [
  ['shell', (signal: AbortSignal) => fetchServerShell(signal)],
  ['chat', (signal: AbortSignal) => fetchServerChatMessages('chat-a', { signal })],
  ['bulk chats', (signal: AbortSignal) => fetchServerBulkChatMessages(['chat-a'], { signal })],
  ['lorebook', (signal: AbortSignal) => fetchServerCharacterLorebook('char-a', { signal })],
  ['bulk lorebooks', (signal: AbortSignal) => fetchServerBulkCharacterLorebooks(['char-a'], { signal })],
] as const

function enterReader() {
  const operation = beginClientSession('reader-a')
  settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-a', epoch: 1 } })
}
function response401() {
  return new Response(JSON.stringify({ error: 'missing_auth' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  authReset.discard.mockClear()
  authReset.getAuth.mockReset().mockResolvedValue('reader-auth')
  enterReader()
})
afterEach(() => {
  resetClientSessionForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('reader read authentication continuations', () => {
  it('does not join an older session character transport with the same identity and revision', async () => {
    const responses: ((response: Response) => void)[] = []
    const fetch = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)))
    vi.stubGlobal('fetch', fetch)
    const previous = fetchServerCharacter('char-a')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    enterReader()
    const current = fetchServerCharacter('char-a')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    responses[0](response401())
    await previous
    expect(authReset.discard).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    responses[1](response401())
    await current
    expect(authReset.discard).toHaveBeenCalledOnce()
  })

  it('does not start a character transport after its authentication wait was superseded', async () => {
    let resolve!: (auth: string) => void
    authReset.getAuth.mockReturnValueOnce(
      new Promise<string>((finish) => {
        resolve = finish
      }),
    )
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = fetchServerCharacter('char-a')
    enterReader()
    resolve('reader-auth')
    expect(await request).toMatchObject({ status: 'error' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['settings', () => fetchServerSettings()],
    ['collections', () => fetchServerCollection('modules')],
    ['characters', () => fetchServerCharacters()],
    ['lorebook', () => fetchServerCharacterLorebook('char-a')],
  ] as const)('retains the original %s auth scope through asynchronous cache negotiation', async (_label, read) => {
    let resolve!: (value: null) => void
    const prepared = new Promise<null>((finish) => {
      resolve = finish
    })
    const prepare = vi.spyOn(resourceCache, 'prepareResourceCacheRequest').mockReturnValueOnce(prepared)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response401()),
    )
    const request = read()
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
    enterReader()
    resolve(null)
    await request
    expect(authReset.discard).not.toHaveBeenCalled()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it.each(readers)('revokes authentication for %s before an error body finishes loading', async (_label, read) => {
    let resolveBody!: (body: unknown) => void
    const response = response401()
    response.json = () =>
      new Promise((finish) => {
        resolveBody = finish
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )
    const request = read(new AbortController().signal)
    await vi.waitFor(() => expect(getClientSessionSnapshot().lifecycle).toBe('auth-required'))
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'))
    expect(authReset.discard).toHaveBeenCalledOnce()
    resolveBody({ error: 'missing_auth' })
    await request
  })

  it('does not send a superseded writer bootstrap after delayed authentication resolves', async () => {
    let resolve!: (auth: string) => void
    authReset.getAuth.mockReturnValueOnce(
      new Promise<string>((finish) => {
        resolve = finish
      }),
    )
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = fetchServerBootstrap()
    enterReader()
    resolve('reader-auth')
    expect(await request).toEqual({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['reader', 'writer'] as const)(
    'returns an old %s bootstrap result without restoring cleared cache or diagnostics',
    async (mode) => {
      let resolve!: (response: Response) => void
      const fetch = vi.fn(
        () =>
          new Promise<Response>((finish) => {
            resolve = finish
          }),
      )
      vi.stubGlobal('fetch', fetch)
      const configureDiagnostics = vi
        .spyOn(diagnostics, 'configureClientDiagnostics')
        .mockImplementation(() => undefined)
      const configureTelemetry = vi.spyOn(telemetry, 'configureStartupTelemetry').mockImplementation(() => undefined)
      const request = mode === 'reader' ? fetchServerBootstrapReadOnly() : fetchServerBootstrap()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      enterReader()
      clearCachedServerCommandRevision()
      resolve(
        new Response(JSON.stringify({ initialized: true, revision: 50 }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      expect(await request).toMatchObject({ status: 'ok', bootstrap: { revision: 50 } })
      expect(peekCachedServerCommandRevision()).toBeNull()
      expect(configureDiagnostics).not.toHaveBeenCalled()
      expect(configureTelemetry).not.toHaveBeenCalled()
    },
  )

  it.each(readers)(
    'ignores an old-generation %s 401 after a new authenticated session starts',
    async (_label, read) => {
      let resolve!: (response: Response) => void
      const fetch = vi.fn(
        () =>
          new Promise<Response>((finish) => {
            resolve = finish
          }),
      )
      vi.stubGlobal('fetch', fetch)
      const request = read(new AbortController().signal)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      enterReader()
      resolve(response401())
      await expect(request).resolves.toMatchObject({ status: 'error', error: 'missing_auth' })
      expect(authReset.discard).not.toHaveBeenCalled()
    },
  )

  it.each(readers)(
    'ignores an aborted %s 401 without clearing the still-authenticated projection',
    async (_label, read) => {
      let resolve!: (response: Response) => void
      const fetch = vi.fn(
        () =>
          new Promise<Response>((finish) => {
            resolve = finish
          }),
      )
      vi.stubGlobal('fetch', fetch)
      const controller = new AbortController()
      const request = read(controller.signal)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      controller.abort()
      resolve(response401())
      await request
      expect(authReset.discard).not.toHaveBeenCalled()
    },
  )

  it.each(readers)('hands a current %s auth rejection to the shared reset boundary', async (_label, read) => {
    authReset.discard.mockImplementationOnce(async () => {
      expect(getClientSessionSnapshot()).toMatchObject({ lifecycle: 'auth-required', authenticated: false })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response401()),
    )
    await read(new AbortController().signal)
    expect(authReset.discard).toHaveBeenCalledExactlyOnceWith('auth-loss')
  })

  it('preserves the HTTP status on read-only bootstrap for coordinator auth classification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response401()),
    )
    await expect(fetchServerBootstrapReadOnly(null, { cacheRevision: false })).resolves.toEqual({
      status: 'error',
      error: 'missing_auth',
      httpStatus: 401,
    })
  })
})
