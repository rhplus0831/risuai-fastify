import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDatabase } from '../src/db.js'
import { enqueueBardWikiJob, getBardWikiJob } from '../src/bardWikiJobs.js'
import { BardWikiWorker } from '../src/bardWikiWorker.js'
import { enqueueMemoryJob, getMemoryJob } from '../src/memoryRepository.js'
import { MemoryWorker } from '../src/memoryWorker.js'
import type { MemoryEvent } from '../src/memoryEvents.js'

const dataDirs: string[] = []
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

afterEach(() => {
  vi.useRealTimers()
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function makeDb() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-worker-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  for (const chatId of ['chat-a', 'chat-b']) {
    db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run(`character-${chatId}`, '{}')
    db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)').run(
      chatId,
      `character-${chatId}`,
      '{}',
    )
  }
  db.prepare(
    `INSERT INTO bardwiki_turn_receipts (
      id, chat_id, user_message_id, user_content_hash, assistant_message_id,
      assistant_content_hash, confirmation_mode, state, change_set_id
    ) VALUES ('receipt-a', 'chat-a', 'user-a', ?, 'assistant-a', ?, 'explicit', 'queued', 'changes-a')`,
  ).run(HASH_A, HASH_B)
  return db
}

function enqueueApply(db: ReturnType<typeof makeDb>, id = 'bard-a') {
  return enqueueBardWikiJob(db, {
    id,
    chatId: 'chat-a',
    receiptId: 'receipt-a',
    kind: 'apply_turn',
    payload: {
      receiptId: 'receipt-a',
      expectedUserContentHash: HASH_A,
      expectedAssistantContentHash: HASH_B,
      modelProfileId: null,
      promptPresetId: null,
      promptVersion: 'bardwiki-event-v1',
      canonicalEnabled: false,
      repairAttemptCount: 0,
    },
    nextRunAt: '2026-08-29T00:00:00.000Z',
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('BardWiki worker lane', () => {
  it('uses independent single-flight ownership so blocked BardWiki work cannot block Hypa', async () => {
    const db = makeDb()
    const blocked = deferred()
    try {
      enqueueApply(db)
      enqueueMemoryJob(db, {
        id: 'hypa-a',
        chatId: 'chat-b',
        kind: 'chunk',
        payload: {},
        nextRunAt: '2026-08-29T00:00:00.000Z',
      })
      const bardWorker = new BardWikiWorker({
        db,
        retry: { now: '2026-08-29T00:00:00.000Z' },
        handlers: { apply_turn: () => blocked.promise },
      })
      const memoryWorker = new MemoryWorker({ db, retry: { now: '2026-08-29T00:00:00.000Z' } })

      const bardTick = bardWorker.tick()
      await flushMicrotasks()
      expect(getBardWikiJob(db, 'bard-a')?.status).toBe('running')
      await expect(memoryWorker.tick()).resolves.toBe(true)
      expect(getMemoryJob(db, 'hypa-a')?.status).toBe('completed')
      expect(getBardWikiJob(db, 'bard-a')?.status).toBe('running')

      blocked.resolve()
      await bardTick
      expect(getBardWikiJob(db, 'bard-a')?.status).toBe('completed')
    } finally {
      db.close()
    }
  })

  it('drains its current handler and stops all scheduling before SQLite closes', async () => {
    vi.useFakeTimers()
    const db = makeDb()
    const gate = deferred()
    const handler = vi.fn(() => gate.promise)
    const worker = new BardWikiWorker({
      db,
      pollIntervalMs: 10,
      terminalRetention: false,
      handlers: { apply_turn: handler },
    })
    try {
      enqueueApply(db)
      worker.start()
      worker.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(handler).toHaveBeenCalledTimes(1)
      let stopped = false
      const stopping = worker.stop().then(() => {
        stopped = true
      })
      await flushMicrotasks()
      expect(stopped).toBe(false)
      gate.resolve()
      await stopping
      expect(getBardWikiJob(db, 'bard-a')?.status).toBe('completed')
      enqueueApply(db, 'bard-b')
      await vi.advanceTimersByTimeAsync(100)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(worker.isRunning).toBe(false)
      expect(worker.isProcessing).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      gate.resolve()
      await worker.stop()
      db.close()
    }
  })

  it('emits payload-free running and terminal status', async () => {
    const db = makeDb()
    const events: MemoryEvent[] = []
    try {
      enqueueApply(db, 'bard-a')
      const worker = new BardWikiWorker({
        db,
        retry: { now: '2026-08-29T00:00:00.000Z' },
        onEvent: (event) => events.push(event),
      })
      await expect(worker.tick()).resolves.toBe(true)
      expect(events).toMatchObject([
        { type: 'bardwiki.job', job: { id: 'bard-a', status: 'running' } },
        { type: 'bardwiki.job', job: { id: 'bard-a', status: 'completed' } },
      ])
      expect(JSON.stringify(events)).not.toContain('expectedUserContentHash')
    } finally {
      db.close()
    }
  })
})
