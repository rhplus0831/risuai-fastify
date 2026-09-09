import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'bootstrap-auth-token',
  getNodeServerDiagnosticsAuth: async () => 'bootstrap-auth-token',
}))

const telemetry = vi.hoisted(() => ({ configure: vi.fn() }))
vi.mock('./startupTelemetry', () => ({ configureStartupTelemetry: telemetry.configure }))

import {
  DISCONNECT_EXISTING_WRITER_HEADER,
  EXPECTED_DATABASE_LINEAGE_HEADER,
  EXPECTED_WRITER_EPOCH_HEADER,
  fetchServerBootstrap,
  fetchServerBootstrapReadOnly,
} from './bootstrap'
import { ACTIVE_WRITER_SESSION_HEADER } from './activeWriterSession'
import { clearCachedServerCommandRevision, peekCachedServerCommandRevision } from './commands'
import {
  __browserDiagnosticsTestHooks,
  getBrowserDiagnosticsSnapshot,
  resetBrowserDiagnosticsSession,
} from './browserDiagnostics'

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  writerSessionHeader: string | null
  observerSessionHeader: string | null
  disconnectExistingWriterHeader: string | null
  expectedWriterEpochHeader: string | null
  expectedDatabaseLineageHeader: string | null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubBootstrapFetch(body: unknown | (() => unknown)): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      calls.push({
        url: String(input),
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        writerSessionHeader: headers?.[ACTIVE_WRITER_SESSION_HEADER] ?? null,
        observerSessionHeader: headers?.['risu-writer-observer-session'] ?? null,
        disconnectExistingWriterHeader: headers?.[DISCONNECT_EXISTING_WRITER_HEADER] ?? null,
        expectedWriterEpochHeader: headers?.[EXPECTED_WRITER_EPOCH_HEADER] ?? null,
        expectedDatabaseLineageHeader: headers?.[EXPECTED_DATABASE_LINEAGE_HEADER] ?? null,
      })
      const value = typeof body === 'function' ? body() : body
      return value instanceof Response ? value : jsonResponse(value)
    }) as unknown as typeof fetch,
  )
  return calls
}

beforeEach(() => {
  clearCachedServerCommandRevision()
  telemetry.configure.mockClear()
})

afterEach(() => {
  resetBrowserDiagnosticsSession()
  vi.unstubAllGlobals()
})

describe('server runtime bootstrap helper', () => {
  it('negotiates browser uploads independently and suppresses the legacy startup transport only when supported', async () => {
    stubBootstrapFetch({
      initialized: true,
      revision: 1,
      databaseLineage: 'synthetic-lineage',
      browserDiagnostics: { version: 1 },
      startupTelemetry: { version: 2, sampleRate: 1 },
    })
    const current = await fetchServerBootstrapReadOnly()
    expect(current).toMatchObject({ status: 'ok', bootstrap: { browserDiagnostics: { version: 1 } } })
    expect(telemetry.configure).toHaveBeenLastCalledWith(undefined)
    await __browserDiagnosticsTestHooks.settled()
    expect(getBrowserDiagnosticsSnapshot().enabled).toBe(true)

    stubBootstrapFetch({
      initialized: true,
      revision: 1,
      browserDiagnostics: { version: 2 },
      startupTelemetry: { version: 2, sampleRate: 1 },
    })
    const older = await fetchServerBootstrapReadOnly()
    expect(older.status).toBe('ok')
    if (older.status === 'ok') expect(older.bootstrap).not.toHaveProperty('browserDiagnostics')
    expect(telemetry.configure).toHaveBeenLastCalledWith({ version: 2, sampleRate: 1 })
    expect(getBrowserDiagnosticsSnapshot().enabled).toBe(false)
  })
  it.each([
    { sessionId: null, epoch: 0 },
    { sessionId: 'writer-a', epoch: 3 },
    { sessionId: 'writer-b', epoch: 4 },
  ])('reads explicit ownership $sessionId at epoch $epoch without writer intent', async (writer) => {
    const calls = stubBootstrapFetch({
      initialized: true,
      revision: 12,
      writerEpoch: writer.epoch,
      writer,
      databaseLineage: 'database-a',
    })
    await expect(fetchServerBootstrapReadOnly(null, { cacheRevision: false })).resolves.toMatchObject({
      status: 'ok',
      bootstrap: { writer },
    })
    expect(calls[0]).toMatchObject({
      writerSessionHeader: null,
      disconnectExistingWriterHeader: null,
      expectedWriterEpochHeader: null,
      expectedDatabaseLineageHeader: null,
    })
    expect(peekCachedServerCommandRevision()).toBeNull()
  })

  it('keeps missing legacy ownership metadata unknown', async () => {
    stubBootstrapFetch({ initialized: true, revision: 4, writerEpoch: 0 })
    const result = await fetchServerBootstrapReadOnly()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('Expected compatible legacy bootstrap')
    expect(result.bootstrap).not.toHaveProperty('writer')
  })

  it('sends both conditional acquisition headers and retains the explicit disconnect handshake', async () => {
    const calls = stubBootstrapFetch({
      initialized: true,
      revision: 9,
      writer: { sessionId: 'writer-new', epoch: 5 },
      writerEpoch: 5,
    })
    await expect(
      fetchServerBootstrap(null, {
        expectedWriter: { epoch: 4, databaseLineage: 'database-a' },
        disconnectExistingWriter: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', bootstrap: { writer: { sessionId: 'writer-new', epoch: 5 } } })
    expect(calls[0]).toMatchObject({
      expectedWriterEpochHeader: '4',
      expectedDatabaseLineageHeader: 'database-a',
      disconnectExistingWriterHeader: 'true',
      observerSessionHeader: null,
    })
    expect(calls[0].writerSessionHeader).toEqual(expect.any(String))
    await fetchServerBootstrap()
    expect(calls[1]).toMatchObject({
      expectedWriterEpochHeader: null,
      expectedDatabaseLineageHeader: null,
      disconnectExistingWriterHeader: null,
    })
  })

  it('serializes the no-owner epoch as zero for initial conditional acquisition', async () => {
    const calls = stubBootstrapFetch({ initialized: false, revision: 0, writer: { sessionId: 'writer-new', epoch: 1 } })
    await fetchServerBootstrap(null, { expectedWriter: { epoch: 0, databaseLineage: 'database-a' } })
    expect(calls[0].expectedWriterEpochHeader).toBe('0')
    expect(calls[0].expectedDatabaseLineageHeader).toBe('database-a')
  })

  it('distinguishes a lost acquisition race from connected-writer confirmation without caching its revision', async () => {
    stubBootstrapFetch({ initialized: true, revision: 8 })
    await fetchServerBootstrapReadOnly()
    stubBootstrapFetch(
      new Response(JSON.stringify({ error: 'active_writer_changed', revision: 99 }), {
        status: 409,
        headers: { 'content-type': 'application/json', 'X-Request-UID': 'changed-request' },
      }),
    )
    await expect(
      fetchServerBootstrap(null, { expectedWriter: { epoch: 1, databaseLineage: 'database-a' } }),
    ).resolves.toEqual({
      status: 'error',
      error: 'active_writer_changed',
      requestUid: 'changed-request',
      httpStatus: 409,
    })
    expect(peekCachedServerCommandRevision()).toBe(8)
  })

  it.each([
    null,
    [],
    {},
    { epoch: 1 },
    { sessionId: null },
    { sessionId: '', epoch: 1 },
    { sessionId: ' writer-a ', epoch: 1 },
    { sessionId: 'a'.repeat(129), epoch: 1 },
    { sessionId: 12, epoch: 1 },
    { sessionId: 'writer-a', epoch: -1 },
    { sessionId: 'writer-a', epoch: 1.5 },
    { sessionId: 'writer-a', epoch: '1' },
    { sessionId: 'writer-a', epoch: null },
    { sessionId: 'writer-a', epoch: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed present writer metadata without caching: %j', async (writer) => {
    stubBootstrapFetch({ initialized: true, revision: 99, writer })
    await expect(fetchServerBootstrapReadOnly()).resolves.toEqual({
      status: 'error',
      error: 'Invalid bootstrap writer metadata',
    })
    expect(peekCachedServerCommandRevision()).toBeNull()
  })

  it('rejects contradictory writer epochs before updating a cached revision', async () => {
    stubBootstrapFetch({ initialized: true, revision: 8 })
    await fetchServerBootstrapReadOnly()
    stubBootstrapFetch({ initialized: true, revision: 99, writerEpoch: 5, writer: { sessionId: 'writer-a', epoch: 4 } })
    await expect(fetchServerBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid bootstrap writer metadata',
    })
    expect(peekCachedServerCommandRevision()).toBe(8)
  })

  it('fetches runtime metadata with auth, registers the writer, and caches revision', async () => {
    const calls = stubBootstrapFetch({
      initialized: true,
      revision: 12,
      schemaVersion: 17,
      assetBaseUrl: '/api/v1/assets',
      requestedWriterWasActive: true,
      databaseLineage: 'database-a',
      writerEpoch: 3,
      generationOperationProtocol: { version: 1 },
      startupTelemetry: { version: 2, sampleRate: 1 },
      generationOperationProjectionEpoch: 21,
      generationOperations: [
        {
          operationId: 'operation-a',
          protocolVersion: 1,
          requestOrigin: 'accepted_send',
          state: 'abandoned',
          stateVersion: 4,
          projectionEpoch: 21,
          creatorWriterSessionId: 'writer-a',
          creatorWriterEpoch: 3,
          characterId: 'character-a',
          chatId: 'chat-a',
          mode: 'send',
          acceptedMessageId: 'message-a',
          clientDraftGeneration: {
            databaseLineage: 'database-a',
            writerSessionId: 'writer-a',
            transcriptIdentity: 'chat-a',
            sequence: 4,
          },
          failureCode: 'server_restarted',
          providerMayHaveRun: true,
          recoveryDisposition: 'retryable',
        },
      ],
      activeGenerationJobs: [
        {
          chatId: 'chat-a',
          jobId: 'job-a',
          mode: 'continue',
          databaseLineage: 'database-a',
          operationId: 'operation-a',
          writerSessionId: 'writer-a',
          writerEpoch: 3,
          operationStateVersion: 3,
          projectionEpoch: 21,
          attemptNo: 1,
          targetMessageId: 'message-target-a',
        },
      ],
      generationFinalizations: [
        {
          generationId: 'generation-a',
          databaseLineage: 'database-a',
          operationId: 'operation-a',
          operationAttemptNo: 1,
          actorWriterSessionId: 'writer-a',
          actorWriterEpoch: 3,
          acceptedMessageId: 'message-source-a',
          terminalOutcome: 'completed',
          chatId: 'chat-a',
          messageId: 'message-a',
          mode: 'continue',
          state: 'stalled',
          failureCount: 3,
          nextAttemptAt: '2026-08-11T00:00:30.000Z',
          provisionalMessage: { role: 'char', data: 'provisional', chatId: 'message-a' },
          projectionFence: {
            mode: 'continue',
            kind: 'target-tail',
            transcriptLength: 1,
            target: { message: { role: 'char', data: 'before', chatId: 'message-a' } },
          },
        },
      ],
      activeMessageTranslations: [
        { chatId: 'chat-a', messageId: 'message-a', jobId: 'translation-a', status: 'running' },
      ],
    })

    await expect(fetchServerBootstrap()).resolves.toEqual({
      status: 'ok',
      bootstrap: {
        initialized: true,
        revision: 12,
        schemaVersion: 17,
        assetBaseUrl: '/api/v1/assets',
        requestedWriterWasActive: true,
        databaseLineage: 'database-a',
        writerEpoch: 3,
        generationOperationProtocol: { version: 1 },
        startupTelemetry: { version: 2, sampleRate: 1 },
        generationOperationProjectionEpoch: 21,
        generationOperations: [
          {
            operationId: 'operation-a',
            protocolVersion: 1,
            requestOrigin: 'accepted_send',
            state: 'abandoned',
            stateVersion: 4,
            projectionEpoch: 21,
            creatorWriterSessionId: 'writer-a',
            creatorWriterEpoch: 3,
            characterId: 'character-a',
            chatId: 'chat-a',
            mode: 'send',
            acceptedMessageId: 'message-a',
            clientDraftGeneration: {
              databaseLineage: 'database-a',
              writerSessionId: 'writer-a',
              transcriptIdentity: 'chat-a',
              sequence: 4,
            },
            failureCode: 'server_restarted',
            providerMayHaveRun: true,
            recoveryDisposition: 'retryable',
          },
        ],
        activeGenerationJobs: [
          {
            chatId: 'chat-a',
            jobId: 'job-a',
            mode: 'continue',
            databaseLineage: 'database-a',
            operationId: 'operation-a',
            writerSessionId: 'writer-a',
            writerEpoch: 3,
            operationStateVersion: 3,
            projectionEpoch: 21,
            attemptNo: 1,
            targetMessageId: 'message-target-a',
          },
        ],
        generationFinalizations: [
          {
            generationId: 'generation-a',
            databaseLineage: 'database-a',
            operationId: 'operation-a',
            operationAttemptNo: 1,
            actorWriterSessionId: 'writer-a',
            actorWriterEpoch: 3,
            acceptedMessageId: 'message-source-a',
            terminalOutcome: 'completed',
            chatId: 'chat-a',
            messageId: 'message-a',
            mode: 'continue',
            state: 'stalled',
            failureCount: 3,
            nextAttemptAt: '2026-08-11T00:00:30.000Z',
            provisionalMessage: { role: 'char', data: 'provisional', chatId: 'message-a' },
            projectionFence: {
              mode: 'continue',
              kind: 'target-tail',
              transcriptLength: 1,
              target: { message: { role: 'char', data: 'before', chatId: 'message-a' } },
            },
          },
        ],
        activeGreetingTranslations: [],
        activeMessageTranslations: [
          { chatId: 'chat-a', messageId: 'message-a', jobId: 'translation-a', status: 'running' },
        ],
      },
    })
    expect(peekCachedServerCommandRevision()).toBe(12)
    expect(calls).toEqual([
      {
        url: '/api/v1/bootstrap',
        method: 'GET',
        authHeader: 'bootstrap-auth-token',
        writerSessionHeader: expect.any(String),
        observerSessionHeader: null,
        disconnectExistingWriterHeader: null,
        expectedWriterEpochHeader: null,
        expectedDatabaseLineageHeader: null,
      },
    ])
  })

  it('requires an explicit retry before disconnecting a connected writer', async () => {
    let requestCount = 0
    const calls = stubBootstrapFetch(() => {
      requestCount += 1
      if (requestCount === 1) {
        return jsonResponse(
          {
            error: 'active_writer_connected',
            reason: 'Another browser session is still connected.',
          },
          409,
        )
      }
      return {
        initialized: true,
        revision: 8,
        databaseLineage: 'database-a',
        requestedWriterWasActive: false,
        writerEpoch: 2,
      }
    })

    await expect(fetchServerBootstrap()).resolves.toEqual({
      status: 'active-writer-connected',
      error: 'active_writer_connected',
    })
    await expect(fetchServerBootstrap(null, { disconnectExistingWriter: true })).resolves.toMatchObject({
      status: 'ok',
      bootstrap: {
        revision: 8,
        requestedWriterWasActive: false,
        writerEpoch: 2,
      },
    })
    expect(calls.map((call) => call.disconnectExistingWriterHeader)).toEqual([null, 'true'])
  })

  it('performs read-only bootstrap without writer ownership or optional revision caching', async () => {
    const calls = stubBootstrapFetch({
      initialized: false,
      revision: 0,
      databaseLineage: 'database-a',
      writerEpoch: 3,
    })

    const expected = {
      status: 'ok',
      bootstrap: {
        initialized: false,
        revision: 0,
        schemaVersion: undefined,
        assetBaseUrl: undefined,
        requestedWriterWasActive: undefined,
        databaseLineage: 'database-a',
        writerEpoch: 3,
        generationOperationProtocol: undefined,
        generationOperationProjectionEpoch: undefined,
        generationOperations: [],
        activeGenerationJobs: [],
        activeGreetingTranslations: [],
        activeMessageTranslations: [],
      },
    }
    await expect(fetchServerBootstrapReadOnly(null, { cacheRevision: false })).resolves.toEqual(expected)
    await expect(fetchServerBootstrapReadOnly(null, { cacheRevision: false })).resolves.toEqual(expected)
    expect(peekCachedServerCommandRevision()).toBeNull()
    expect(calls[0].writerSessionHeader).toBeNull()
    expect(calls[0].observerSessionHeader).toEqual(expect.any(String))
    expect(calls[0].observerSessionHeader).not.toBe('')
    expect(calls[1].observerSessionHeader).toBe(calls[0].observerSessionHeader)
  })

  it('drops malformed runtime job entries', async () => {
    stubBootstrapFetch({
      initialized: true,
      revision: 3,
      activeGenerationJobs: [
        { chatId: 'chat-a', jobId: 'job-a', mode: 'regenerate', regenerateMessageId: 'message-a' },
        { chatId: 'chat-b' },
        'invalid',
      ],
      generationOperations: [
        {
          operationId: 'operation-valid',
          protocolVersion: 1,
          requestOrigin: 'accepted_send',
          state: 'retryable',
          stateVersion: 2,
          projectionEpoch: 3,
          creatorWriterSessionId: 'writer-a',
          creatorWriterEpoch: 1,
          providerMayHaveRun: false,
          recoveryDisposition: 'retryable',
        },
        { operationId: 'missing-fields' },
      ],
      activeMessageTranslations: [{ chatId: 'chat-a', messageId: 'message-a' }, { chatId: 'chat-b' }, null],
    })

    const result = await fetchServerBootstrap()
    expect(result).toMatchObject({ status: 'ok' })
    if (result.status !== 'ok') return
    expect(result.bootstrap.activeGenerationJobs).toEqual([
      { chatId: 'chat-a', jobId: 'job-a', mode: 'regenerate', regenerateMessageId: 'message-a' },
    ])
    expect(result.bootstrap.activeMessageTranslations).toEqual([
      {
        chatId: 'chat-a',
        messageId: 'message-a',
        jobId: 'legacy:chat-a:message-a',
        status: 'running',
      },
    ])
    expect(result.bootstrap.generationOperations).toEqual([
      {
        operationId: 'operation-valid',
        protocolVersion: 1,
        requestOrigin: 'accepted_send',
        state: 'retryable',
        stateVersion: 2,
        projectionEpoch: 3,
        creatorWriterSessionId: 'writer-a',
        creatorWriterEpoch: 1,
        providerMayHaveRun: false,
        recoveryDisposition: 'retryable',
      },
    ])
  })

  it('maps HTTP failures and network failures to status:error', async () => {
    stubBootstrapFetch(jsonResponse({ error: 'missing_auth' }, 401))
    await expect(fetchServerBootstrap()).resolves.toEqual({ status: 'error', error: 'missing_auth', httpStatus: 401 })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    await expect(fetchServerBootstrap()).resolves.toEqual({ status: 'error', error: 'Network error: offline' })
  })

  it('requires initialized and a non-negative integer revision', async () => {
    stubBootstrapFetch({ revision: 1 })
    await expect(fetchServerBootstrap()).resolves.toEqual({
      status: 'error',
      error: 'Invalid bootstrap initialization state',
    })

    vi.unstubAllGlobals()
    stubBootstrapFetch({ initialized: true, revision: 'invalid' })
    await expect(fetchServerBootstrap()).resolves.toEqual({ status: 'error', error: 'Invalid bootstrap revision' })
  })
})
