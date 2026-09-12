import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import {
  createBardWikiRebuildHandler,
  enqueueBardWikiRebuild,
  previewBardWikiRebuild,
} from '../src/bardWikiRebuildHandler.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { createCommandEventSink } from '../src/commands/events.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import {
  cancelBardWikiJob,
  claimNextBardWikiJob,
  getBardWikiJob,
  recoverRunningBardWikiJobs,
} from '../src/bardWikiJobs.js'
import {
  createBardWikiDocument,
  getBardWikiDocument,
  updateBardWikiDocument,
  listBardWikiDocumentVersions,
  listBardWikiDocuments,
  listBardWikiJobSummaries,
  listBardWikiReceiptSummaries,
} from '../src/bardWikiRepository.js'
import { BardWikiWorker } from '../src/bardWikiWorker.js'

const dataDirs: string[] = []

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function createHarness(pairCount: number, options: { batchSize?: number } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-rebuild-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  const initial = createInitialDatabase() as unknown as Record<string, unknown>
  initial.bardWiki = {
    ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
    enabledByDefault: true,
    memoryMode: 'bardwiki',
  }
  db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(initial))
  db.prepare("INSERT INTO characters (id, position, data_json) VALUES ('character-a', 0, '{}')").run()
  db.prepare(
    "INSERT INTO chats (id, character_id, position, data_json) VALUES ('chat-a', 'character-a', 0, '{}')",
  ).run()
  const insert = db.prepare(
    `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
     VALUES ('chat-a', ?, ?, ?, ?, NULL, ?, 0)`,
  )
  for (let index = 0; index < pairCount; index += 1) {
    const userId = `user-${index}`
    const assistantId = `assistant-${index}`
    const userData = `Question ${index}`
    const assistantData = `Answer ${index}`
    insert.run(index * 2, userId, 'user', userData, JSON.stringify({ chatId: userId, role: 'user', data: userData }))
    insert.run(
      index * 2 + 1,
      assistantId,
      'char',
      assistantData,
      JSON.stringify({ chatId: assistantId, role: 'char', data: assistantData }),
    )
  }
  const events = createCommandEventSink()
  const analyze = vi.fn(async (request: { source: { assistantMessageId: string; assistantContent: string } }) =>
    JSON.stringify({
      title: request.source.assistantMessageId,
      logicalPath: `Events/${request.source.assistantMessageId}`,
      aliases: [],
      markdown: `## ${request.source.assistantMessageId}\n${request.source.assistantContent}`,
    }),
  )
  const handler = createBardWikiRebuildHandler({
    db,
    dataDir,
    eventSink: events,
    loadDatabase: () => createInitialDatabase(),
    analyze,
    batchSize: options.batchSize ?? 3,
  })
  const worker = new BardWikiWorker({ db, retry: { backoffBaseMs: 0 }, handlers: { rebuild_chat: handler } })
  return { dataDir, db, events, analyze, handler, worker }
}

function createExistingDocuments(db: DatabaseSync) {
  const manual = createBardWikiDocument(db, {
    id: 'manual-document',
    chatId: 'chat-a',
    kind: 'concept',
    title: 'Manual',
    logicalPath: 'Manual/Note',
    markdown: '## Manual\nKeep me.',
    actor: 'user',
    commandRevision: 0,
  })
  const derived = createBardWikiDocument(db, {
    id: 'derived-document',
    chatId: 'chat-a',
    kind: 'location',
    title: 'Derived',
    logicalPath: 'Derived/Old',
    markdown: '## Derived\nReplace me.',
    actor: 'model',
    reason: 'canonical',
    commandRevision: 0,
  })
  return { manual, derived }
}

describe('BardWiki historical rebuild', () => {
  it('previews scope, stages bounded ordered batches, reports progress, and atomically publishes', async () => {
    const harness = createHarness(10)
    const existing = createExistingDocuments(harness.db)
    try {
      expect(previewBardWikiRebuild(harness.db, 'chat-a', 'full')).toEqual({
        chatId: 'chat-a',
        policy: 'full',
        sourceCount: 10,
        replaceDerivedDocumentCount: 1,
        preserveUserDocumentCount: 1,
        activeJobId: null,
      })
      const queued = enqueueBardWikiRebuild(harness.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 10,
      })

      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, queued.id)).toMatchObject({
        status: 'pending',
        attemptCount: 0,
        progressCurrent: 3,
        progressTotal: 10,
      })
      expect(listBardWikiJobSummaries(harness.db, 'chat-a')[0]).toMatchObject({
        progressCurrent: 3,
        progressTotal: 10,
      })
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM bardwiki_rebuild_staging').get()).toEqual({ count: 3 })
      expect(
        listBardWikiDocuments(harness.db, 'chat-a')
          .map(({ id }) => id)
          .sort(),
      ).toEqual([existing.manual.id, existing.derived.id].sort())
      expect(getSchemaState(harness.db).revision).toBe(0)

      await harness.worker.tick()
      await harness.worker.tick()
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, queued.id)).toMatchObject({
        status: 'completed',
        progressCurrent: 10,
        progressTotal: 10,
      })
      expect(getSchemaState(harness.db).revision).toBe(1)
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.manual.id)).toMatchObject({
        markdown: '## Manual\nKeep me.',
      })
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.derived.id)).toBeNull()
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.derived.id, { includeDeleted: true })).not.toBeNull()
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(11)
      expect(listBardWikiReceiptSummaries(harness.db, 'chat-a')).toHaveLength(10)
      expect(harness.events.list()).toEqual([
        expect.objectContaining({
          type: 'bardwiki.rebuild.completed',
          resource: 'bardWikiChat',
          id: 'chat-a',
          jobId: queued.id,
          revision: 1,
        }),
      ])
      expect(harness.analyze.mock.calls.map(([request]) => request.source.assistantMessageId)).toEqual(
        Array.from({ length: 10 }, (_, index) => `assistant-${index}`),
      )
    } finally {
      harness.db.close()
    }
  })

  it('preserves the published corpus after provider failure or cancellation', async () => {
    const failed = createHarness(5, { batchSize: 2 })
    const failedExisting = createExistingDocuments(failed.db)
    try {
      const queued = enqueueBardWikiRebuild(failed.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 5,
      })
      failed.db.prepare('UPDATE bardwiki_jobs SET max_attempts = 1 WHERE id = ?').run(queued.id)
      await failed.worker.tick()
      failed.analyze.mockImplementation(async () => {
        throw new Error('provider down')
      })
      await failed.worker.tick()
      expect(getBardWikiJob(failed.db, queued.id)?.status).toBe('failed')
      expect(
        listBardWikiDocuments(failed.db, 'chat-a')
          .map(({ id }) => id)
          .sort(),
      ).toEqual([failedExisting.manual.id, failedExisting.derived.id].sort())
      expect(getSchemaState(failed.db).revision).toBe(0)
    } finally {
      failed.db.close()
    }

    const cancelled = createHarness(4, { batchSize: 2 })
    const cancelledExisting = createExistingDocuments(cancelled.db)
    try {
      const queued = enqueueBardWikiRebuild(cancelled.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 4,
      })
      await cancelled.worker.tick()
      expect(cancelBardWikiJob(cancelled.db, queued.id)?.status).toBe('cancelled')
      await expect(cancelled.worker.tick()).resolves.toBe(false)
      expect(
        listBardWikiDocuments(cancelled.db, 'chat-a')
          .map(({ id }) => id)
          .sort(),
      ).toEqual([cancelledExisting.manual.id, cancelledExisting.derived.id].sort())
      expect(getSchemaState(cancelled.db).revision).toBe(0)
    } finally {
      cancelled.db.close()
    }
  })

  it.each(['cancel', 'delete'] as const)(
    'rejects a late abort-insensitive provider result after target %s',
    async (action) => {
      const harness = createHarness(1)
      let release!: () => void
      let tick: Promise<boolean> | undefined
      try {
        const queued = enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 1 })
        harness.analyze.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return JSON.stringify({
            title: 'Old event',
            logicalPath: 'Events/Old',
            aliases: [],
            markdown: 'Obsolete output',
          })
        })
        tick = harness.worker.tick()
        await vi.waitFor(() => expect(harness.analyze).toHaveBeenCalledTimes(1))
        if (action === 'cancel') {
          cancelBardWikiJob(harness.db, queued.id)
          expect(harness.worker.abortRunningJob(queued.id)).toBe(true)
        } else harness.db.prepare('DELETE FROM chats WHERE id = ?').run('chat-a')
        release()
        await tick
        expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
        expect(harness.events.list()).toEqual([])
        if (action === 'cancel') {
          expect(getBardWikiJob(harness.db, queued.id)?.status).toBe('cancelled')
          const next = enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 1 })
          await harness.worker.tick()
          expect(getBardWikiJob(harness.db, next.id)?.status).toBe('completed')
        } else expect(getBardWikiJob(harness.db, queued.id)).toBeNull()
      } finally {
        release?.()
        await tick
        harness.db.close()
      }
    },
  )

  it('fails safely when the transcript changes after a checkpoint', async () => {
    const harness = createHarness(4, { batchSize: 2 })
    const existing = createExistingDocuments(harness.db)
    try {
      const queued = enqueueBardWikiRebuild(harness.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 4,
      })
      await harness.worker.tick()
      harness.db
        .prepare(
          `UPDATE messages SET data = 'changed', json = ?
           WHERE chat_id = 'chat-a' AND uid = 'assistant-0' AND alternate = 0`,
        )
        .run(JSON.stringify({ chatId: 'assistant-0', role: 'char', data: 'changed' }))
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, queued.id)).toMatchObject({
        status: 'failed',
        errorCode: 'bardwiki_source_changed',
      })
      expect(
        listBardWikiDocuments(harness.db, 'chat-a')
          .map(({ id }) => id)
          .sort(),
      ).toEqual([existing.manual.id, existing.derived.id].sort())
      // A changed source requires a fresh preview/build, which discards the old
      // checkpoint identity and remains a supported recovery action.
      const fresh = enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 4 })
      await harness.worker.tick()
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, fresh.id)?.status).toBe('completed')
      expect(
        listBardWikiDocuments(harness.db, 'chat-a').some((document) => document.markdown === '## assistant-0\nchanged'),
      ).toBe(true)
    } finally {
      harness.db.close()
    }
  })

  it('recovers a running checkpoint after restart without exposing partial staging', async () => {
    const harness = createHarness(3, { batchSize: 1 })
    try {
      const queued = enqueueBardWikiRebuild(harness.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 3,
      })
      await harness.worker.tick()
      expect(claimNextBardWikiJob(harness.db)).toMatchObject({ id: queued.id, status: 'running' })
      harness.db.close()
      harness.db = openDatabase(harness.dataDir)
      harness.worker = new BardWikiWorker({
        db: harness.db,
        retry: { backoffBaseMs: 0 },
        handlers: {
          rebuild_chat: createBardWikiRebuildHandler({
            db: harness.db,
            dataDir: harness.dataDir,
            eventSink: harness.events,
            loadDatabase: () => createInitialDatabase(),
            analyze: harness.analyze,
            batchSize: 1,
          }),
        },
      })
      expect(recoverRunningBardWikiJobs(harness.db, { backoffBaseMs: 0 })[0]).toMatchObject({
        id: queued.id,
        status: 'pending',
      })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(0)
      await harness.worker.tick()
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, queued.id)?.status).toBe('completed')
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(3)
      expect(harness.analyze).toHaveBeenCalledTimes(3)
    } finally {
      harness.db.close()
    }
  })

  it('publishes a new derived document while preserving a manually edited previous rebuild document', async () => {
    const harness = createHarness(1)
    try {
      enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 1 })
      await harness.worker.tick()
      const original = listBardWikiDocuments(harness.db, 'chat-a')[0]
      const manual = updateBardWikiDocument(harness.db, 'chat-a', original.id, {
        expectedVersion: original.version,
        expectedContentHash: original.contentHash,
        markdown: 'Manual correction that must survive every rebuild.',
        actor: 'user',
        commandRevision: 2,
      })
      const replacement = enqueueBardWikiRebuild(harness.db, {
        chatId: 'chat-a',
        policy: 'full',
        expectedSourceCount: 1,
      })
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, replacement.id)).toMatchObject({ status: 'completed' })
      expect(getBardWikiDocument(harness.db, 'chat-a', original.id)).toEqual(manual)
      const documents = listBardWikiDocuments(harness.db, 'chat-a')
      expect(documents).toHaveLength(2)
      expect(documents.find((document) => document.id !== original.id)?.markdown).toBe('## assistant-0\nAnswer 0')
      const third = enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 1 })
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, third.id)).toMatchObject({ status: 'completed' })
      expect(getBardWikiDocument(harness.db, 'chat-a', original.id)).toEqual(manual)
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(2)
    } finally {
      harness.db.close()
    }
  })

  it('keeps existing derived documents in missing-only merge mode', async () => {
    const harness = createHarness(1)
    const existing = createExistingDocuments(harness.db)
    try {
      const queued = enqueueBardWikiRebuild(harness.db, {
        chatId: 'chat-a',
        policy: 'missing',
        expectedSourceCount: 1,
      })
      await harness.worker.tick()
      expect(getBardWikiJob(harness.db, queued.id)?.status).toBe('completed')
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.derived.id)).not.toBeNull()
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(3)
      expect(listBardWikiDocumentVersions(harness.db, existing.manual.id)[0].actor).toBe('user')
    } finally {
      harness.db.close()
    }
  })
})
