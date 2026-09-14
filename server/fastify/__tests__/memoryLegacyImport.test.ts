import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { backfillLegacyHypaV3MemoryRows, LEGACY_HYPA_V3_SUMMARY_MODEL } from '../src/memoryLegacyImport.js'
import {
  cancelMemoryJob,
  createMemoryJob,
  listMemoryChunks,
  listMemoryEmbeddings,
  listMemoryJobs,
  listMemorySummaries,
} from '../src/memoryRepository.js'
import { writePersistedWithMessages } from '../src/repository.js'
import { selectMemorySummaries } from '../src/memorySelectionService.js'
import { setupAuthedClient } from './helpers/auth.js'

process.env.LOG_LEVEL = 'silent'

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-memory-legacy-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

function legacyDatabase() {
  return {
    characters: [
      {
        chaId: 'char-1',
        chats: [
          {
            id: 'chat-1',
            message: [
              { role: 'user', data: 'hello', chatId: 'm-1' },
              { role: 'char', data: 'hi', chatId: 'm-2' },
              { role: 'user', data: 'remember the garden', chatId: 'm-3' },
            ],
            hypaV3Data: {
              summaries: [
                {
                  text: 'They greeted each other.',
                  chatMemos: ['m-1', 'm-2'],
                  isImportant: true,
                  categoryId: 'cat-lore',
                  tags: ['greeting', 'first-meet'],
                },
                {
                  text: 'The garden matters.',
                  chatMemos: ['m-3'],
                  isImportant: false,
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

function legacySummaryIndex(metadata: unknown): number {
  if (!metadata || typeof metadata !== 'object') return -1
  const value = (metadata as { summaryIndex?: unknown }).summaryIndex
  return typeof value === 'number' ? value : -1
}

function multipartRisuSave(bytes: Uint8Array) {
  const boundary = 'risu-memory-legacy-portable-boundary'
  const head = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="database.risu"',
      'Content-Type: application/octet-stream',
      '',
      '',
    ].join('\r\n'),
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('legacy Hypa V3 memory import', () => {
  it('backfills legacy summaries into summarized chunk and summary rows idempotently', () => {
    const db = openDatabase(makeDataDir())
    try {
      expect(backfillLegacyHypaV3MemoryRows(db, legacyDatabase())).toEqual({
        chunksCreated: 2,
        summariesCreated: 2,
        skippedSummaries: [],
      })
      expect(backfillLegacyHypaV3MemoryRows(db, legacyDatabase())).toEqual({
        chunksCreated: 0,
        summariesCreated: 0,
        skippedSummaries: [],
      })

      const chunks = listMemoryChunks(db, { chatId: 'chat-1' })
      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toMatchObject({
        chatId: 'chat-1',
        messageId: 'm-2',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'user: hello\nchar: hi',
        status: 'summarized',
      })

      const summaries = listMemorySummaries(db, {
        chatId: 'chat-1',
        model: LEGACY_HYPA_V3_SUMMARY_MODEL,
      })
      expect(summaries).toHaveLength(2)
      const summariesByIndex = [...summaries].sort((left, right) => {
        return legacySummaryIndex(left.metadata) - legacySummaryIndex(right.metadata)
      })
      expect(summariesByIndex[0]).toMatchObject({
        chatId: 'chat-1',
        chunkId: chunks[0].id,
        model: LEGACY_HYPA_V3_SUMMARY_MODEL,
        text: 'They greeted each other.',
        tokens: 0,
        metadata: {
          source: 'legacy-hypav3',
          summaryIndex: 0,
          chatMemos: ['m-1', 'm-2'],
          isImportant: true,
          categoryId: 'cat-lore',
          tags: ['greeting', 'first-meet'],
        },
      })
      expect(listMemoryEmbeddings(db)).toEqual([])
      expect(listMemoryJobs(db)).toEqual([])

      const selected = selectMemorySummaries({
        db,
        chatId: 'chat-1',
        summaryModel: 'configured-summary-model',
        embeddingModel: 'configured-embedding-model',
        queryVectors: [],
        availableTokens: 100,
        settings: { recentMemoryRatio: 1, similarMemoryRatio: 0 },
      })
      expect(selected.selectedSummaries.map((summary) => summary.text).sort()).toEqual([
        'The garden matters.',
        'They greeted each other.',
      ])
      expect(selected.importantSummaries.map((summary) => summary.text)).toEqual(['They greeted each other.'])
    } finally {
      db.close()
    }
  })

  it('salvages valid summaries and reports every malformed legacy summary', () => {
    const db = openDatabase(makeDataDir())
    const database = legacyDatabase()
    database.characters[0].chats[0].hypaV3Data.summaries.push(
      null as never,
      { text: '', chatMemos: [], isImportant: false },
      { text: 'Still salvageable.', chatMemos: ['m-3'], isImportant: false },
    )
    try {
      expect(backfillLegacyHypaV3MemoryRows(db, database)).toEqual({
        chunksCreated: 3,
        summariesCreated: 3,
        skippedSummaries: [
          {
            path: 'characters[0].chats[0].hypaV3Data.summaries[2]',
            reason: 'summary must be an object',
          },
          {
            path: 'characters[0].chats[0].hypaV3Data.summaries[3]',
            reason: 'summary.text must be a non-empty string',
          },
        ],
      })
      expect(
        listMemorySummaries(db, { chatId: 'chat-1' })
          .map((summary) => summary.text)
          .sort(),
      ).toEqual(['Still salvageable.', 'The garden matters.', 'They greeted each other.'])
    } finally {
      db.close()
    }
  })

  it('returns the legacy-memory salvage report from JSON imports', async () => {
    const dataDir = makeDataDir()
    const database = legacyDatabase()
    database.characters[0].chats[0].hypaV3Data.summaries.push(null as never, {
      text: '',
      chatMemos: [],
      isImportant: false,
    })
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
      assetGc: false,
    })
    try {
      const { assertion } = await setupAuthedClient(app)
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database },
      })

      expect(imported.statusCode).toBe(200)
      expect(imported.json().memoryLegacyReport).toEqual({
        chunksCreated: 2,
        summariesCreated: 2,
        skippedSummaries: [
          {
            path: 'characters[0].chats[0].hypaV3Data.summaries[2]',
            reason: 'summary must be an object',
          },
          {
            path: 'characters[0].chats[0].hypaV3Data.summaries[3]',
            reason: 'summary.text must be a non-empty string',
          },
        ],
      })
    } finally {
      await app.close()
    }
  })

  it('rejects replacement while a memory job pins the chat, then replaces all memory rows after cancellation', async () => {
    const dataDir = makeDataDir()
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
      assetGc: false,
    })
    try {
      const { assertion } = await setupAuthedClient(app)
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: legacyDatabase() },
      })
      expect(imported.statusCode).toBe(200)

      let db = openDatabase(dataDir)
      try {
        createMemoryJob(db, {
          id: 'old-job',
          chatId: 'chat-1',
          kind: 'summarize',
          payload: {},
        })
        expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(2)
        // The backfill must read messages that no longer live in db.json. The
        // import route splits messages in place, so the backfill must run against
        // the still-hydrated payload.
        const chunks = listMemoryChunks(db, { chatId: 'chat-1' })
        expect(chunks).toHaveLength(2)
        expect(chunks[0]).toMatchObject({
          chatId: 'chat-1',
          messageId: 'm-2',
          rangeStartSeq: 0,
          rangeEndSeq: 1,
          text: 'user: hello\nchar: hi',
          status: 'summarized',
        })
      } finally {
        db.close()
      }

      const blocked = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: { characters: [] } },
      })
      expect(blocked.statusCode).toBe(423)
      expect(blocked.json()).toMatchObject({
        error: 'chat_occupied',
        chatId: 'chat-1',
        conflictingChatIds: ['chat-1'],
        conflicts: [
          {
            chatId: 'chat-1',
            occupancy: null,
            blocking: [{ id: 'old-job', kind: 'memory_job' }],
          },
        ],
        safeRelease: expect.stringContaining('exact lineage/chat/epoch tuple'),
      })

      db = openDatabase(dataDir)
      try {
        expect(listMemoryChunks(db, { chatId: 'chat-1' })).toHaveLength(2)
        expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(2)
        expect(listMemoryJobs(db)).toEqual([expect.objectContaining({ id: 'old-job', status: 'pending' })])
        expect(cancelMemoryJob(db, 'old-job')).toMatchObject({ id: 'old-job', status: 'cancelled' })
      } finally {
        db.close()
      }

      const replaced = await app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: { characters: [] } },
      })
      expect(replaced.statusCode).toBe(200)

      db = openDatabase(dataDir)
      try {
        expect(listMemoryChunks(db)).toEqual([])
        expect(listMemorySummaries(db)).toEqual([])
        expect(listMemoryEmbeddings(db)).toEqual([])
        expect(listMemoryJobs(db)).toEqual([])
        expect(db.prepare('SELECT COUNT(*) AS count FROM memory_legacy_summary_tombstones').get()).toEqual({
          count: 0,
        })
      } finally {
        db.close()
      }
    } finally {
      await app.close()
    }
  })

  it('boot backfills legacy rows from an existing database', async () => {
    const dataDir = makeDataDir()
    const seedDb = openDatabase(dataDir)
    try {
      writePersistedWithMessages(seedDb, dataDir, {
        _version: 1,
        database: legacyDatabase(),
        assets: [],
      })
    } finally {
      seedDb.close()
    }
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
    })
    try {
      const db = openDatabase(dataDir)
      try {
        expect(listMemoryChunks(db, { chatId: 'chat-1' })).toHaveLength(2)
        expect(listMemorySummaries(db, { chatId: 'chat-1' })).toHaveLength(2)
        expect(listMemoryEmbeddings(db)).toEqual([])
        expect(listMemoryJobs(db)).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      await app.close()
    }
  })

  it('does not resurrect an explicitly deleted imported summary after restart', async () => {
    const dataDir = makeDataDir()
    const config = {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    }
    const first = await buildApp({ config, memoryWorker: false, assetGc: false })
    let deletedSummaryId = ''
    try {
      const { assertion } = await setupAuthedClient(first.app)
      const imported = await first.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: legacyDatabase() },
      })
      expect(imported.statusCode).toBe(200)

      const db = openDatabase(dataDir)
      try {
        deletedSummaryId =
          listMemorySummaries(db, { chatId: 'chat-1' }).find((summary) => summary.text === 'They greeted each other.')
            ?.id ?? ''
      } finally {
        db.close()
      }
      expect(deletedSummaryId).not.toBe('')

      const deleted = await first.app.inject({
        method: 'DELETE',
        url: `/api/v1/memory/summaries/${encodeURIComponent(deletedSummaryId)}`,
        headers: { 'risu-auth': assertion },
      })
      expect(deleted.statusCode).toBe(200)
    } finally {
      await first.app.close()
    }

    const restarted = await buildApp({ config, memoryWorker: false, assetGc: false })
    try {
      const db = openDatabase(dataDir)
      try {
        expect(listMemorySummaries(db, { chatId: 'chat-1' }).map((summary) => summary.text)).toEqual([
          'The garden matters.',
        ])
        expect(
          db
            .prepare('SELECT summary_id FROM memory_legacy_summary_tombstones WHERE summary_id = ?')
            .get(deletedSummaryId),
        ).toEqual({ summary_id: deletedSummaryId })
      } finally {
        db.close()
      }
    } finally {
      await restarted.app.close()
    }
  })

  it('keeps a deleted legacy summary absent after portable export, fresh import, and restart', async () => {
    const sourceDataDir = makeDataDir()
    const targetDataDir = makeDataDir()
    const configFor = (dataDir: string) => ({
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    })

    const source = await buildApp({
      config: configFor(sourceDataDir),
      memoryWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false },
    })
    let exportedBytes!: Uint8Array
    let deletedSummaryId = ''
    try {
      const { assertion } = await setupAuthedClient(source.app)
      const imported = await source.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion },
        payload: { database: legacyDatabase() },
      })
      expect(imported.statusCode).toBe(200)

      const sourceDb = openDatabase(sourceDataDir)
      try {
        deletedSummaryId =
          listMemorySummaries(sourceDb, { chatId: 'chat-1' }).find(
            (summary) => summary.text === 'They greeted each other.',
          )?.id ?? ''
      } finally {
        sourceDb.close()
      }
      expect(deletedSummaryId).not.toBe('')

      const deleted = await source.app.inject({
        method: 'DELETE',
        url: `/api/v1/memory/summaries/${encodeURIComponent(deletedSummaryId)}`,
        headers: { 'risu-auth': assertion },
      })
      expect(deleted.statusCode).toBe(200)

      const exported = await source.app.inject({
        method: 'GET',
        url: '/api/v1/export/risusave',
        headers: { 'risu-auth': assertion },
      })
      expect(exported.statusCode).toBe(200)
      exportedBytes = new Uint8Array(exported.rawPayload)
    } finally {
      await source.app.close()
    }

    const target = await buildApp({
      config: configFor(targetDataDir),
      memoryWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false },
    })
    try {
      const { assertion } = await setupAuthedClient(target.app)
      const upload = multipartRisuSave(exportedBytes)
      const imported = await target.app.inject({
        method: 'POST',
        url: '/api/v1/import/risusave',
        headers: { 'risu-auth': assertion, 'content-type': upload.contentType },
        payload: upload.payload,
      })
      expect(imported.statusCode).toBe(200)

      const targetDb = openDatabase(targetDataDir)
      try {
        expect(listMemorySummaries(targetDb, { chatId: 'chat-1' }).map((summary) => summary.text)).toEqual([
          'The garden matters.',
        ])
        expect(
          targetDb
            .prepare('SELECT summary_id FROM memory_legacy_summary_tombstones WHERE summary_id = ?')
            .get(deletedSummaryId),
        ).toEqual({ summary_id: deletedSummaryId })
      } finally {
        targetDb.close()
      }
    } finally {
      await target.app.close()
    }

    const restarted = await buildApp({
      config: configFor(targetDataDir),
      memoryWorker: false,
      assetGc: false,
      generationChat: { finalizationRetry: false },
    })
    try {
      const targetDb = openDatabase(targetDataDir)
      try {
        expect(listMemorySummaries(targetDb, { chatId: 'chat-1' }).map((summary) => summary.text)).toEqual([
          'The garden matters.',
        ])
        expect(
          targetDb
            .prepare('SELECT summary_id FROM memory_legacy_summary_tombstones WHERE summary_id = ?')
            .get(deletedSummaryId),
        ).toEqual({ summary_id: deletedSummaryId })
      } finally {
        targetDb.close()
      }
    } finally {
      await restarted.app.close()
    }
  })
})
