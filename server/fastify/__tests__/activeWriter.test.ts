import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { ACTIVE_WRITER_SESSION_HEADER } from '../src/activeWriter.js'
import { buildApp } from '../src/app.js'
import { setupAuthedClient } from './helpers/auth.js'
import { EXPECTED_DATABASE_LINEAGE_HEADER, EXPECTED_WRITER_EPOCH_HEADER } from '../src/routes/bootstrap.js'

interface Harness {
  app: FastifyInstance
  dataDir: string
}

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-active-writer-'))
  return { app: await buildHarnessApp(dataDir), dataDir }
}

async function buildHarnessApp(dataDir: string): Promise<FastifyInstance> {
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    memoryWorker: false,
  })
  return app
}

async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

async function bootstrapSession(app: FastifyInstance, sessionId: string): Promise<void> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, [ACTIVE_WRITER_SESSION_HEADER]: sessionId },
  })
  expect(res.statusCode).toBe(200)
}

function authedHeaders(sessionId?: string): Record<string, string> {
  return {
    'risu-auth': assertion,
    ...(sessionId ? { [ACTIVE_WRITER_SESSION_HEADER]: sessionId } : {}),
  }
}

function expectStaleWriter(res: { statusCode: number; json: () => unknown }): void {
  expect(res.statusCode).toBe(423)
  expect(res.json()).toMatchObject({ error: 'active_writer_stale' })
}

let harness: Harness
let assertion: string

beforeEach(async () => {
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
})

afterEach(async () => {
  await stopHarness(harness)
})

describe('active writer session guard', () => {
  it('reports null, own, and foreign durable ownership to read-only clients without SQLite writes', async () => {
    const monitor = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
    const dataVersion = () => monitor.prepare('PRAGMA data_version').get()
    try {
      const beforeEmptyRead = dataVersion()
      const empty = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
      expect(empty.statusCode).toBe(200)
      expect(empty.json()).toMatchObject({ writer: { sessionId: null, epoch: 0 }, writerEpoch: 0 })
      expect(dataVersion()).toEqual(beforeEmptyRead)

      await bootstrapSession(harness.app, 'session-a')
      const beforeOwnedReads = dataVersion()
      // A durable owner remains registered even without an event connection.
      for (const observerSession of [undefined, 'session-a', 'session-b']) {
        const response = await harness.app.inject({
          method: 'GET',
          url: '/api/v1/bootstrap',
          headers: {
            ...authedHeaders(),
            ...(observerSession ? { 'risu-writer-observer-session': observerSession } : {}),
          },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ writer: { sessionId: 'session-a', epoch: 1 }, writerEpoch: 1 })
        expect(response.json()).not.toHaveProperty('requestedWriterWasActive')
        expect(dataVersion()).toEqual(beforeOwnedReads)
      }
    } finally {
      monitor.close()
    }
  })

  it('lets only one acquisition use the same no-owner snapshot, preserving the winning disconnected writer', async () => {
    const discovery = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    const observed = discovery.json()
    expect(observed.writer).toEqual({ sessionId: null, epoch: 0 })
    const responses = await Promise.all(
      ['session-a', 'session-b'].map((sessionId) =>
        harness.app.inject({
          method: 'GET',
          url: '/api/v1/bootstrap',
          headers: { ...authedHeaders(sessionId), ...expectedWriterHeaders(observed) },
        }),
      ),
    )
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const winner = responses.find((response) => response.statusCode === 200)!.json()
    expect(winner.writer.epoch).toBe(1)
    expect(responses.find((response) => response.statusCode === 409)!.json()).toMatchObject({
      error: 'active_writer_changed',
    })
    const current = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    expect(current.json().writer).toEqual(winner.writer)
    expect(current.json().revision).toBe(observed.revision)
  })

  it('conditionally resumes the same writer and explicitly acquires a disconnected foreign writer', async () => {
    await bootstrapSession(harness.app, 'session-a')
    const discovery = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    const expected = expectedWriterHeaders(discovery.json())
    const resumed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { ...authedHeaders('session-a'), ...expected },
    })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json()).toMatchObject({
      writer: { sessionId: 'session-a', epoch: 1 },
      requestedWriterWasActive: true,
    })
    const promoted = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { ...authedHeaders('session-b'), ...expected },
    })
    expect(promoted.statusCode).toBe(200)
    expect(promoted.json()).toMatchObject({
      writer: { sessionId: 'session-b', epoch: 2 },
      requestedWriterWasActive: false,
    })
  })

  it('keeps connected-writer confirmation separate from the acquisition precondition', async () => {
    await bootstrapSession(harness.app, 'session-a')
    const connection = await connectWriterEvents(harness.app, 'session-a')
    try {
      expect(await readWriterFrame(connection.reader)).toEqual({ sessionId: 'session-a', epoch: 1 })
      const discovery = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
      const headers = { ...authedHeaders('session-b'), ...expectedWriterHeaders(discovery.json()) }
      const changed = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { ...headers, [EXPECTED_WRITER_EPOCH_HEADER]: '0', 'risu-disconnect-existing-writer': 'true' },
      })
      expect(changed.statusCode).toBe(409)
      expect(changed.json()).toMatchObject({ error: 'active_writer_changed' })
      const unconfirmed = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers })
      expect(unconfirmed.statusCode).toBe(409)
      expect(unconfirmed.json()).toMatchObject({ error: 'active_writer_connected' })
      const current = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
      expect(current.json().writer).toEqual({ sessionId: 'session-a', epoch: 1 })
      const confirmed = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { ...headers, 'risu-disconnect-existing-writer': 'true' },
      })
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json().writer).toEqual({ sessionId: 'session-b', epoch: 2 })
      expect(await readWriterFrame(connection.reader)).toEqual(confirmed.json().writer)
    } finally {
      connection.close()
    }
  })

  it('rejects an old database lineage even when the replacement preserves the writer epoch', async () => {
    await bootstrapSession(harness.app, 'session-a')
    const discovery = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    const observed = discovery.json()
    const replacement = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: authedHeaders('session-a'),
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(replacement.statusCode).toBe(200)
    const current = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    expect(current.json().writer).toEqual(observed.writer)
    expect(current.json().databaseLineage).not.toBe(observed.databaseLineage)
    const connection = await connectWriterEvents(harness.app, 'session-a')
    try {
      expect(await readWriterFrame(connection.reader)).toEqual(current.json().writer)
      const staleAcquisition = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: {
          ...authedHeaders('session-b'),
          ...expectedWriterHeaders(observed),
          'risu-disconnect-existing-writer': 'true',
        },
      })
      expect(staleAcquisition.statusCode).toBe(409)
      expect(staleAcquisition.json()).toMatchObject({ error: 'active_writer_changed' })
      const guardRejected = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/runtime',
        headers: authedHeaders('session-b'),
        payload: { baseRevision: replacement.json().revision, patch: { streamGeminiThoughts: true } },
      })
      expectStaleWriter(guardRejected)
      const guardAccepted = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/runtime',
        headers: authedHeaders('session-a'),
        payload: { baseRevision: replacement.json().revision, patch: { streamGeminiThoughts: true } },
      })
      expect(guardAccepted.statusCode).toBe(200)
      const stillOwned = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
      expect(stillOwned.json().writer).toEqual(observed.writer)
    } finally {
      connection.close()
    }
  })

  const malformedPreconditions: Array<[string, Record<string, string | string[]>]> = [
    ...['', '-1', '1.5', '1e2', '01', 'NaN', '9007199254740992'].map((epoch): [string, Record<string, string>] => [
      `epoch ${JSON.stringify(epoch)}`,
      { [EXPECTED_WRITER_EPOCH_HEADER]: epoch, [EXPECTED_DATABASE_LINEAGE_HEADER]: 'database-a' },
    ]),
    ['missing lineage', { [EXPECTED_WRITER_EPOCH_HEADER]: '1' }],
    ['missing epoch', { [EXPECTED_DATABASE_LINEAGE_HEADER]: 'database-a' }],
    ['empty lineage', { [EXPECTED_WRITER_EPOCH_HEADER]: '1', [EXPECTED_DATABASE_LINEAGE_HEADER]: '' }],
    ['whitespace lineage', { [EXPECTED_WRITER_EPOCH_HEADER]: '1', [EXPECTED_DATABASE_LINEAGE_HEADER]: ' ' }],
    [
      'duplicate epoch',
      { [EXPECTED_WRITER_EPOCH_HEADER]: ['1', '1'], [EXPECTED_DATABASE_LINEAGE_HEADER]: 'database-a' },
    ],
    [
      'duplicate lineage',
      { [EXPECTED_WRITER_EPOCH_HEADER]: '1', [EXPECTED_DATABASE_LINEAGE_HEADER]: ['database-a', 'database-a'] },
    ],
    [
      'missing writer intent',
      {
        [EXPECTED_WRITER_EPOCH_HEADER]: '1',
        [EXPECTED_DATABASE_LINEAGE_HEADER]: 'database-a',
        [ACTIVE_WRITER_SESSION_HEADER]: '',
      },
    ],
  ]
  it.each(malformedPreconditions)('rejects malformed acquisition preconditions: %s', async (_label, invalidHeaders) => {
    await bootstrapSession(harness.app, 'session-a')
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { ...authedHeaders('session-b'), ...invalidHeaders },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'invalid_expected_writer' })
    const current = await harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: authedHeaders() })
    expect(current.json().writer).toEqual({ sessionId: 'session-a', epoch: 1 })
  })

  it('persists writer ownership and epochs across a server restart', async () => {
    const writerA = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders('session-a'),
    })
    expect(writerA.statusCode).toBe(200)
    expect(writerA.json()).toMatchObject({ requestedWriterWasActive: true, writerEpoch: 1 })

    const writerB = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders('session-b'),
    })
    expect(writerB.statusCode).toBe(200)
    expect(writerB.json()).toMatchObject({ requestedWriterWasActive: false, writerEpoch: 2 })

    await harness.app.close()
    harness.app = await buildHarnessApp(harness.dataDir)

    const staleBeforeBootstrap = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: authedHeaders('session-a'),
      payload: { database: { shouldNotPersist: true } },
    })
    expectStaleWriter(staleBeforeBootstrap)

    const returningWriterA = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders('session-a'),
    })
    expect(returningWriterA.statusCode).toBe(200)
    expect(returningWriterA.json()).toMatchObject({ requestedWriterWasActive: false, writerEpoch: 3 })

    const passive = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders(),
    })
    expect(passive.statusCode).toBe(200)
    expect(passive.json()).toMatchObject({ writerEpoch: 3 })
    expect(passive.json()).not.toHaveProperty('requestedWriterWasActive')
  })

  it('lets the most recently bootstrapped session mutate and rejects stale command writers', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')
    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: authedHeaders('session-b'),
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(imported.statusCode).toBe(200)

    const stale = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: authedHeaders('session-a'),
      payload: { baseRevision: 1, patch: { streamGeminiThoughts: true } },
    })
    expectStaleWriter(stale)

    const active = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: authedHeaders('session-b'),
      payload: { baseRevision: 1, patch: { streamGeminiThoughts: true } },
    })
    expect(active.statusCode).toBe(200)
    expect(active.json().revision).toBe(2)
  })

  it('does not let passive bootstrap reads reclaim active-writer ownership', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    const imported = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/import/risusave',
      headers: authedHeaders('session-b'),
      payload: { database: { streamGeminiThoughts: false } },
    })
    expect(imported.statusCode).toBe(200)

    const passiveRefresh = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders(),
    })
    expect(passiveRefresh.statusCode).toBe(200)

    const staleAfterPassiveRefresh = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: authedHeaders('session-a'),
      payload: { baseRevision: 1, patch: { streamGeminiThoughts: true } },
    })
    expectStaleWriter(staleAfterPassiveRefresh)
  })

  it('rejects stale writers on import, asset upload, backups, and legacy storage writes', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: authedHeaders('session-a'),
        payload: { database: { greeting: 'stale' } },
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/import/realm-character',
        headers: authedHeaders('session-a'),
        payload: { id: 'realm-id', baseRevision: 0 },
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: {
          'risu-auth': assertion,
          [ACTIVE_WRITER_SESSION_HEADER]: 'session-a',
          'content-type': 'image/png',
        },
        payload: Buffer.from('stale-asset'),
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/assets/bulk',
        headers: authedHeaders('session-a'),
        payload: {
          assets: [{ contentType: 'image/png', data: Buffer.from('stale-asset').toString('base64') }],
        },
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/backups',
        headers: authedHeaders('session-a'),
        payload: { label: 'stale backup' },
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/storage/write',
        headers: {
          'risu-auth': assertion,
          [ACTIVE_WRITER_SESSION_HEADER]: 'session-a',
          'content-type': 'application/octet-stream',
          'file-path': Buffer.from('legacy-key').toString('hex'),
        },
        payload: Buffer.from('stale legacy bytes'),
      }),
    )

    const activeBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders('session-b'),
    })
    expect(activeBootstrap.statusCode).toBe(200)
    expect(activeBootstrap.json()).toMatchObject({ initialized: false, revision: 0 })

    const staleAssetId = createHash('sha256').update('stale-asset').digest('hex')
    expect(existsSync(path.join(harness.dataDir, 'assets', `${staleAssetId}.png`))).toBe(false)
    expect(existsSync(path.join(harness.dataDir, 'save', Buffer.from('legacy-key').toString('hex')))).toBe(false)
    const backups = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/backups',
      headers: authedHeaders('session-b'),
    })
    expect(backups.statusCode).toBe(200)
    expect(backups.json()).toEqual({ backups: [] })
  })

  it('rejects stale restore/delete backup and legacy storage remove mutations', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    const backup = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: authedHeaders('session-b'),
      payload: { label: 'active backup' },
    })
    expect(backup.statusCode).toBe(201)
    const backupId = backup.json().id as string

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${encodeURIComponent(backupId)}/restore`,
        headers: authedHeaders('session-a'),
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/backups/${encodeURIComponent(backupId)}`,
        headers: authedHeaders('session-a'),
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/storage/remove',
        headers: {
          'risu-auth': assertion,
          [ACTIVE_WRITER_SESSION_HEADER]: 'session-a',
          'file-path': Buffer.from('legacy-key').toString('hex'),
        },
      }),
    )
  })

  it('rejects stale memory job create and cancel mutations while keeping list reads open', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/memory/jobs',
        headers: authedHeaders('session-a'),
        payload: {
          chatId: 'chat-1',
          kind: 'summarize',
          payload: { chunkId: 'chunk-1', model: 'model-a' },
        },
      }),
    )

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/memory/jobs',
      headers: authedHeaders('session-b'),
      payload: {
        chatId: 'chat-1',
        kind: 'summarize',
        payload: { chunkId: 'chunk-1', model: 'model-a' },
      },
    })
    expect(created.statusCode).toBe(201)
    const jobId = created.json().job.id as string

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/memory/jobs?chatId=chat-1',
      headers: authedHeaders('session-a'),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().jobs).toHaveLength(1)

    expectStaleWriter(
      await harness.app.inject({
        method: 'DELETE',
        url: `/api/v1/memory/jobs/${encodeURIComponent(jobId)}`,
        headers: authedHeaders('session-a'),
      }),
    )

    const cancelled = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/memory/jobs/${encodeURIComponent(jobId)}`,
      headers: authedHeaders('session-b'),
    })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.json().job.status).toBe('cancelled')
  })

  it('rejects stale generation-time memory planning entrypoints', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/chat',
        headers: authedHeaders('session-a'),
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
          mode: 'preview_prompt',
        },
      }),
    )

    expectStaleWriter(
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/generate/preview-prompt',
        headers: authedHeaders('session-a'),
        payload: {
          chatId: 'chat-1',
          characterId: 'char-1',
        },
      }),
    )

    const activeBootstrap = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: authedHeaders('session-b'),
    })
    expect(activeBootstrap.statusCode).toBe(200)
    expect(activeBootstrap.json()).toMatchObject({
      activeGenerationJobs: [],
      generationOperations: [],
    })
  })

  it('keeps streaming observe and public asset exceptions outside the writer gate', async () => {
    await bootstrapSession(harness.app, 'session-a')
    await bootstrapSession(harness.app, 'session-b')

    expectStaleWriter(
      await harness.app.inject({
        method: 'DELETE',
        url: '/api/v1/generate/chat/job-1',
        headers: authedHeaders('session-a'),
      }),
    )

    const reattach = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/generate/chat/job-1/stream',
      headers: authedHeaders('session-a'),
    })
    expect(reattach.statusCode).toBe(404)

    const eventCursorError = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/events?sinceRevision=not-a-number',
      headers: authedHeaders('session-a'),
    })
    expect(eventCursorError.statusCode).toBe(400)

    const exists = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/assets/exists',
      headers: authedHeaders('session-a'),
      payload: { ids: [] },
    })
    expect(exists.statusCode).toBe(200)
  })
})

function expectedWriterHeaders(snapshot: {
  writer: { epoch: number }
  databaseLineage: string
}): Record<string, string> {
  return {
    [EXPECTED_WRITER_EPOCH_HEADER]: String(snapshot.writer.epoch),
    [EXPECTED_DATABASE_LINEAGE_HEADER]: snapshot.databaseLineage,
  }
}

async function connectWriterEvents(app: FastifyInstance, sessionId: string) {
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Event test server did not bind a TCP port')
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/events`, {
    headers: authedHeaders(sessionId),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  return {
    reader,
    close() {
      controller.abort()
      reader.releaseLock()
    },
  }
}

async function readWriterFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const decoder = new TextDecoder()
  let body = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('Event stream ended without a writer frame')
    body += decoder.decode(chunk.value, { stream: true })
    const frame = /event: writer\ndata: ([^\n]+)\n\n/u.exec(body)
    if (frame) return JSON.parse(frame[1]!)
  }
}
