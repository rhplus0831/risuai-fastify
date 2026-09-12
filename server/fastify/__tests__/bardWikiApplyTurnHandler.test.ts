import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { createBardWikiApplyTurnHandler } from '../src/bardWikiApplyTurnHandler.js'
import { createBackup, restoreBackup } from '../src/repository.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { createCommandEventSink } from '../src/commands/events.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { cancelBardWikiJob, getBardWikiJob } from '../src/bardWikiJobs.js'
import { createOrReuseExplicitBardWikiConfirmation, hashBardWikiMessageContent } from '../src/bardWikiReceipts.js'
import {
  createBardWikiDocument,
  getBardWikiReceiptSummary,
  getBardWikiDocument,
  listBardWikiDocuments,
  listBardWikiLinks,
  updateBardWikiDocument,
} from '../src/bardWikiRepository.js'
import { BardWikiWorker } from '../src/bardWikiWorker.js'
import { buildBardWikiQuery } from '../src/prompt/bardWikiQuery.js'
import { loadBardWikiPromptSnapshot } from '../src/prompt/bardWikiPromptRepository.js'
import { selectBardWikiPromptRows } from '../src/prompt/bardWikiSelection.js'

const USER_TEXT = 'We enter the old tavern.'
const ASSISTANT_TEXT = 'Mira lights a lantern beside the door.'
const VALID_DRAFT = JSON.stringify({
  title: 'Lantern at the Old Tavern',
  logicalPath: 'Events/Lantern at the Old Tavern',
  aliases: ['Lantern Night'],
  markdown: '## Lantern at the Old Tavern\n\nMira lights a lantern beside the door at the [[Old Tavern]].',
})
const dataDirs: string[] = []

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function createHarness(options: { maxAttempts?: number; pathCollision?: boolean; canonicalUpdates?: boolean } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-apply-turn-'))
  dataDirs.push(dataDir)
  const db = openDatabase(dataDir)
  const initial = createInitialDatabase() as unknown as Record<string, unknown>
  initial.bardWiki = {
    ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
    enabledByDefault: true,
    memoryMode: 'bardwiki',
    canonicalUpdates: options.canonicalUpdates ?? false,
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
  insert.run(0, 'user-a', 'user', USER_TEXT, JSON.stringify({ chatId: 'user-a', role: 'user', data: USER_TEXT }))
  insert.run(
    1,
    'assistant-a',
    'char',
    ASSISTANT_TEXT,
    JSON.stringify({ chatId: 'assistant-a', role: 'char', data: ASSISTANT_TEXT }),
  )
  if (options.pathCollision) {
    createBardWikiDocument(db, {
      id: 'manual-a',
      chatId: 'chat-a',
      kind: 'event',
      title: 'Existing',
      logicalPath: 'Events/Lantern at the Old Tavern',
      markdown: 'Existing note.',
      commandRevision: 0,
    })
  }
  const confirmation = createOrReuseExplicitBardWikiConfirmation(db, {
    chatId: 'chat-a',
    userMessageId: 'user-a',
    userContentHash: hashBardWikiMessageContent(USER_TEXT),
    assistantMessageId: 'assistant-a',
    assistantContentHash: hashBardWikiMessageContent(ASSISTANT_TEXT),
  })
  if (options.maxAttempts !== undefined) {
    db.prepare('UPDATE bardwiki_jobs SET max_attempts = ? WHERE id = ?').run(options.maxAttempts, confirmation.job.id)
  }
  return { dataDir, db, confirmation }
}

function workerFor(
  harness: ReturnType<typeof createHarness>,
  options: Parameters<typeof createBardWikiApplyTurnHandler>[0],
) {
  return new BardWikiWorker({
    db: harness.db,
    retry: { backoffBaseMs: 0 },
    handlers: { apply_turn: createBardWikiApplyTurnHandler(options) },
  })
}

describe('BardWiki apply-turn handler', () => {
  it('commits one forced event document, provenance, manifest, revision, event, and prompt-search row', async () => {
    const harness = createHarness({ pathCollision: true })
    const commandEvents = createCommandEventSink()
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        eventSink: commandEvents,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
      })
      await expect(worker.tick()).resolves.toBe(true)

      const job = getBardWikiJob(harness.db, harness.confirmation.job.id)
      const receipt = getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)
      expect(job?.status).toBe('completed')
      expect(receipt).toMatchObject({ state: 'applied', eventDocumentId: expect.any(String), errorCode: null })
      const documents = listBardWikiDocuments(harness.db, 'chat-a')
      expect(documents).toHaveLength(2)
      const event = documents.find((document) => document.id === receipt?.eventDocumentId)
      expect(event).toMatchObject({
        kind: 'event',
        contextPolicy: 'relevant',
        reviewState: 'active',
        title: 'Lantern at the Old Tavern',
        logicalPath: expect.stringContaining('~event-'),
      })
      expect(listBardWikiLinks(harness.db, event!.id)).toMatchObject([
        { rawTarget: 'Old Tavern', normalizedTarget: 'old tavern' },
      ])
      expect(harness.db.prepare('SELECT role, message_id FROM bardwiki_document_sources ORDER BY role').all()).toEqual([
        { role: 'assistant', message_id: 'assistant-a' },
        { role: 'user', message_id: 'user-a' },
      ])
      expect(harness.db.prepare('SELECT after_version, after_hash FROM bardwiki_change_manifest').all()).toMatchObject([
        { after_version: 1, after_hash: event!.contentHash },
      ])
      expect(getSchemaState(harness.db).revision).toBe(1)
      expect(commandEvents.list()).toMatchObject([
        {
          type: 'bardwiki.document.created',
          resource: 'bardWikiDocument',
          revision: 1,
          id: event!.id,
          parentId: 'chat-a',
          jobId: job!.id,
          sourceMessageId: 'assistant-a',
        },
      ])

      const query = buildBardWikiQuery({
        currentInput: 'Mira lantern tavern',
        recentMessages: [],
        recentMessageCount: 12,
      })
      const snapshot = loadBardWikiPromptSnapshot(harness.db, { chatId: 'chat-a', query, maxLinkHops: 1 })
      const selection = selectBardWikiPromptRows({
        snapshot,
        query,
        maxDocuments: 8,
        maxLinkHops: 1,
        tokenBudget: 2_048,
        countRowTokens: (content) => Math.ceil(content.length / 4),
      })
      expect(selection.rows.some((row) => row.documentId === event!.id)).toBe(true)
    } finally {
      harness.db.close()
    }
  })

  it('uses exactly one repair call for validation errors and commits only the repaired draft', async () => {
    const harness = createHarness()
    const requests: Array<{ repair?: unknown }> = []
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async (request) => {
          requests.push(request)
          return request.repair ? VALID_DRAFT : '{"title": 5}'
        },
      })
      await worker.tick()
      expect(requests).toHaveLength(2)
      expect(requests[1].repair).toMatchObject({ validationErrors: expect.any(Array) })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(1)
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('completed')
    } finally {
      harness.db.close()
    }
  })

  it('commits the event and bounded canonical creates/section updates as one versioned change set', async () => {
    const harness = createHarness({ canonicalUpdates: true })
    const commandEvents = createCommandEventSink()
    try {
      const existing = createBardWikiDocument(harness.db, {
        id: 'character-mira',
        chatId: 'chat-a',
        kind: 'character',
        title: 'Mira',
        logicalPath: 'Characters/Mira',
        aliases: [],
        markdown: '## Profile\n\nA traveler.\n\n### Traits\n\nOld traits.\n\n### History\n\nOld history.',
        commandRevision: 0,
      })
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        eventSink: commandEvents,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
        compileCanonical: async () =>
          JSON.stringify([
            {
              op: 'upsert_h3',
              documentId: existing.id,
              baseVersion: existing.version,
              baseHash: existing.contentHash,
              heading: 'Traits',
              markdown: 'Carries a lantern and watches the [[Old Tavern]].',
            },
            {
              op: 'create',
              kind: 'location',
              title: 'Old Tavern',
              logicalPath: 'Locations/Old Tavern',
              aliases: ['The Tavern'],
              sections: [{ heading: 'Overview', markdown: 'An old tavern with a lantern by the door.' }],
            },
          ]),
      })

      await expect(worker.tick()).resolves.toBe(true)

      const documents = listBardWikiDocuments(harness.db, 'chat-a')
      expect(documents).toHaveLength(3)
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.id)).toMatchObject({
        version: 2,
        markdown: expect.stringContaining('### Traits\n\nCarries a lantern'),
      })
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.id)?.markdown).toContain('### History\n\nOld history.')
      expect(documents.find((document) => document.kind === 'location')).toMatchObject({
        contextPolicy: 'relevant',
        reviewState: 'active',
        markdown: '### Overview\n\nAn old tavern with a lantern by the door.',
      })
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM bardwiki_change_manifest').get()).toEqual({ count: 3 })
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM bardwiki_document_sources').get()).toEqual({ count: 6 })
      expect(getSchemaState(harness.db).revision).toBe(1)
      expect(harness.db.prepare('SELECT COUNT(*) AS count FROM command_events').get()).toEqual({ count: 1 })
      expect(commandEvents.list()).toMatchObject([
        {
          type: 'bardwiki.change_set.applied',
          resource: 'bardWikiChat',
          revision: 1,
          id: 'chat-a',
          jobId: harness.confirmation.job.id,
          sourceMessageId: 'assistant-a',
        },
      ])
    } finally {
      harness.db.close()
    }
  })

  it('recompiles once from a fresh snapshot when a concurrent manual edit changes a canonical fence', async () => {
    const harness = createHarness({ canonicalUpdates: true })
    try {
      const existing = createBardWikiDocument(harness.db, {
        id: 'character-mira',
        chatId: 'chat-a',
        kind: 'character',
        title: 'Mira',
        logicalPath: 'Characters/Mira',
        markdown: '### Traits\n\nOld traits.\n\n### Notes\n\nKeep this.',
        commandRevision: 0,
      })
      let compileCalls = 0
      let manualEditApplied = false
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
        compileCanonical: async (request) => {
          compileCalls += 1
          const snapshot = request.documents.find((document) => document.id === existing.id)!
          return JSON.stringify([
            {
              op: 'upsert_h3',
              documentId: snapshot.id,
              baseVersion: snapshot.version,
              baseHash: snapshot.contentHash,
              heading: 'Traits',
              markdown: `Compiler pass ${compileCalls}.`,
            },
          ])
        },
        hooks: {
          afterProvider: () => {
            if (manualEditApplied) return
            manualEditApplied = true
            updateBardWikiDocument(harness.db, 'chat-a', existing.id, {
              expectedVersion: existing.version,
              expectedContentHash: existing.contentHash,
              markdown: '### Traits\n\nManual interim.\n\n### Notes\n\nManual note survives.',
              commandRevision: 0,
            })
          },
        },
      })

      await worker.tick()

      expect(compileCalls).toBe(2)
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.id)).toMatchObject({
        version: 3,
        markdown: expect.stringContaining('### Traits\n\nCompiler pass 2.'),
      })
      expect(getBardWikiDocument(harness.db, 'chat-a', existing.id)?.markdown).toContain(
        '### Notes\n\nManual note survives.',
      )
      expect(getSchemaState(harness.db).revision).toBe(1)
    } finally {
      harness.db.close()
    }
  })

  it('rolls back the event when canonical output remains invalid after one repair', async () => {
    const harness = createHarness({ canonicalUpdates: true, maxAttempts: 1 })
    let compilerCalls = 0
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
        compileCanonical: async () => {
          compilerCalls += 1
          return '[{"op":"replace_all"}]'
        },
      })
      await worker.tick()
      expect(compilerCalls).toBe(2)
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)).toMatchObject({
        status: 'failed',
        errorCode: 'bardwiki_model_output_invalid',
      })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
      expect(harness.db.prepare('SELECT * FROM bardwiki_change_manifest').all()).toEqual([])
      expect(getSchemaState(harness.db).revision).toBe(0)
    } finally {
      harness.db.close()
    }
  })

  it('fails invalid output after one repair without partial domain writes', async () => {
    const harness = createHarness({ maxAttempts: 1 })
    let calls = 0
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => {
          calls += 1
          return 'not json'
        },
      })
      await worker.tick()
      expect(calls).toBe(2)
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)).toMatchObject({
        status: 'failed',
        errorCode: 'bardwiki_model_output_invalid',
      })
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)).toMatchObject({
        state: 'failed',
        errorCode: 'bardwiki_model_output_invalid',
      })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
      expect(getSchemaState(harness.db).revision).toBe(0)
    } finally {
      harness.db.close()
    }
  })

  it('classifies provider timeout/unavailability without attempting schema repair', async () => {
    const harness = createHarness({ maxAttempts: 1 })
    let calls = 0
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => {
          calls += 1
          throw new Error('provider deadline exceeded')
        },
      })
      await worker.tick()
      expect(calls).toBe(1)
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)).toMatchObject({
        status: 'failed',
        errorCode: 'bardwiki_model_unavailable',
      })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
    } finally {
      harness.db.close()
    }
  })

  it('aborts only the addressed running job and preserves its cancelled receipt', async () => {
    const harness = createHarness()
    let started!: () => void
    const didStart = new Promise<void>((resolve) => {
      started = resolve
    })
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: (request) =>
          new Promise((_resolve, reject) => {
            started()
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
          }),
      })
      const tick = worker.tick()
      await didStart
      expect(cancelBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('cancelled')
      expect(worker.abortRunningJob(harness.confirmation.job.id)).toBe(true)
      await tick
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('cancelled')
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)).toMatchObject({
        state: 'failed',
        errorCode: 'cancelled',
      })
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
    } finally {
      harness.db.close()
    }
  })

  it('marks source changes before or after provider work obsolete without writes', async () => {
    for (const mutateDuringProvider of [false, true]) {
      const harness = createHarness()
      let calls = 0
      try {
        if (!mutateDuringProvider) mutateAssistant(harness.db)
        const worker = workerFor(harness, {
          db: harness.db,
          dataDir: harness.dataDir,
          loadDatabase: () => createInitialDatabase(),
          analyze: async () => {
            calls += 1
            if (mutateDuringProvider) mutateAssistant(harness.db)
            return VALID_DRAFT
          },
        })
        await worker.tick()
        expect(calls).toBe(mutateDuringProvider ? 1 : 0)
        expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)).toMatchObject({
          state: 'obsolete',
          errorCode: 'bardwiki_source_changed',
        })
        expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
        expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('completed')
      } finally {
        harness.db.close()
      }
    }
  })

  it.each(['afterProvider', 'beforeCommit'] as const)('recovers a crash at %s without partial rows', async (point) => {
    const harness = createHarness()
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
        hooks: {
          [point]: () => {
            throw new Error(`crash-${point}`)
          },
        },
      })
      await worker.tick()
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('pending')
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)?.state).toBe('queued')
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
      expect(getSchemaState(harness.db).revision).toBe(0)
    } finally {
      harness.db.close()
    }
  })

  it('fences apply-turn output across restore and resumes the restored receipt', async () => {
    const harness = createHarness()
    let release!: () => void
    let calls = 0
    const worker = workerFor(harness, {
      db: harness.db,
      dataDir: harness.dataDir,
      loadDatabase: () => createInitialDatabase(),
      analyze: async () => {
        calls += 1
        if (calls === 1)
          await new Promise<void>((resolve) => {
            release = resolve
          })
        return VALID_DRAFT
      },
    })
    const old = worker.tick()
    try {
      await vi.waitFor(() => expect(calls).toBe(1))
      const backup = await createBackup(harness.db, harness.dataDir, 'running analysis')
      await restoreBackup(harness.db, harness.dataDir, backup.id)
      const restored = getBardWikiJob(harness.db, harness.confirmation.job.id)
      const receipt = getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)
      release()
      await old
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)).toEqual(restored)
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)).toEqual(receipt)
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toEqual([])
      await worker.tick()
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('completed')
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)?.state).toBe('applied')
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(1)
      expect(calls).toBe(2)
    } finally {
      release?.()
      await old
      await worker.stop()
      harness.db.close()
    }
  })

  it('converges commit-before-operational-completion replay to one event identity', async () => {
    const harness = createHarness()
    let crash = true
    try {
      const worker = workerFor(harness, {
        db: harness.db,
        dataDir: harness.dataDir,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => VALID_DRAFT,
        hooks: {
          afterCommit: () => {
            if (crash) {
              crash = false
              throw new Error('crash-after-commit')
            }
          },
        },
      })
      await worker.tick()
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('pending')
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)?.state).toBe('applied')
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(1)
      expect(getSchemaState(harness.db).revision).toBe(1)

      await worker.tick()
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('completed')
      expect(listBardWikiDocuments(harness.db, 'chat-a')).toHaveLength(1)
      expect(getSchemaState(harness.db).revision).toBe(1)
      expect(harness.db.prepare('SELECT * FROM command_events').all()).toHaveLength(1)
    } finally {
      harness.db.close()
    }
  })
})

function mutateAssistant(db: DatabaseSync): void {
  const changed = `${ASSISTANT_TEXT} Changed.`
  db.prepare("UPDATE messages SET data = ?, json = ? WHERE uid = 'assistant-a' AND alternate = 0").run(
    changed,
    JSON.stringify({ chatId: 'assistant-a', role: 'char', data: changed }),
  )
}
