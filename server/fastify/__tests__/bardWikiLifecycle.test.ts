import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { getSchemaState, openDatabase } from '../src/db.js'
import { applyTargetedCommandMutation } from '../src/commands/mutations.js'
import { applyBardWikiVaultImport, encodeBardWikiVault, decodeBardWikiVault } from '../src/bardWikiVault.js'
import { createBardWikiRebuildHandler, enqueueBardWikiRebuild } from '../src/bardWikiRebuildHandler.js'
import { COMMAND_EVENT_CATALOG, createCommandEventSink } from '../src/commands/events.js'
import { createBardWikiApplyTurnHandler } from '../src/bardWikiApplyTurnHandler.js'
import { createBardWikiReconcileReceiptHandler } from '../src/bardWikiReconcileHandler.js'
import { createOrReuseExplicitBardWikiConfirmation, hashBardWikiMessageContent } from '../src/bardWikiReceipts.js'
import { getBardWikiJob } from '../src/bardWikiJobs.js'
import { getBardWikiDocument, getBardWikiReceiptSummary, updateBardWikiDocument } from '../src/bardWikiRepository.js'
import {
  deleteActiveMessageById,
  replaceActiveChatMessages,
  truncateActiveChatMessages,
  updateActiveMessageById,
  writeGenerationChatMessage,
} from '../src/messageStore.js'
import { BardWikiWorker } from '../src/bardWikiWorker.js'

const USER_TEXT = 'We enter the old tavern.'
const ASSISTANT_TEXT = 'Mira lights a lantern beside the door.'
const EVENT_DRAFT = JSON.stringify({
  title: 'Lantern at the Old Tavern',
  logicalPath: 'Events/Lantern at the Old Tavern',
  aliases: [],
  markdown: 'Mira lights a lantern at the [[Old Tavern]].',
})
const dataDirs: string[] = []

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

function createHarness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-lifecycle-'))
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
  insert.run(0, 'user-a', 'user', USER_TEXT, JSON.stringify({ chatId: 'user-a', role: 'user', data: USER_TEXT }))
  insert.run(
    1,
    'assistant-a',
    'char',
    ASSISTANT_TEXT,
    JSON.stringify({ chatId: 'assistant-a', role: 'char', data: ASSISTANT_TEXT }),
  )
  const confirmation = createOrReuseExplicitBardWikiConfirmation(db, {
    chatId: 'chat-a',
    userMessageId: 'user-a',
    userContentHash: hashBardWikiMessageContent(USER_TEXT),
    assistantMessageId: 'assistant-a',
    assistantContentHash: hashBardWikiMessageContent(ASSISTANT_TEXT),
  })
  const eventSink = createCommandEventSink()
  const worker = new BardWikiWorker({
    db,
    retry: { backoffBaseMs: 0 },
    handlers: {
      apply_turn: createBardWikiApplyTurnHandler({
        db,
        dataDir,
        eventSink,
        loadDatabase: () => createInitialDatabase(),
        analyze: async () => EVENT_DRAFT,
      }),
      reconcile_receipt: createBardWikiReconcileReceiptHandler({ db, eventSink }),
    },
  })
  return { dataDir, db, confirmation, eventSink, worker }
}

describe('BardWiki source lifecycle', () => {
  it.each([
    {
      mutation: 'edit',
      apply: (harness: ReturnType<typeof createHarness>) =>
        updateActiveMessageById(harness.db, 'assistant-a', { data: `${ASSISTANT_TEXT} Edited.` }),
    },
    {
      mutation: 'delete',
      apply: (harness: ReturnType<typeof createHarness>) => deleteActiveMessageById(harness.db, 'assistant-a'),
    },
    {
      mutation: 'truncate',
      apply: (harness: ReturnType<typeof createHarness>) => truncateActiveChatMessages(harness.db, 'chat-a', 'user-a'),
    },
    {
      mutation: 'active replacement',
      apply: (harness: ReturnType<typeof createHarness>) =>
        writeGenerationChatMessage(
          harness.db,
          'chat-a',
          { chatId: 'assistant-b', role: 'char', data: 'Replacement.' },
          'assistant-a',
        ),
    },
    {
      mutation: 'transcript replacement',
      apply: (harness: ReturnType<typeof createHarness>) =>
        replaceActiveChatMessages(harness.db, 'chat-a', [
          { chatId: 'user-a', role: 'user', data: USER_TEXT },
          { chatId: 'assistant-b', role: 'char', data: 'Replacement.' },
        ]),
    },
  ])('cancels pending work and obsoletes its receipt on source $mutation', ({ apply }) => {
    const harness = createHarness()
    try {
      apply(harness)
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)).toMatchObject({
        state: 'obsolete',
        errorCode: 'bardwiki_source_changed',
      })
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)).toMatchObject({
        status: 'cancelled',
        errorCode: 'bardwiki_source_changed',
      })
      expect(
        harness.db.prepare("SELECT COUNT(*) AS count FROM bardwiki_jobs WHERE kind = 'reconcile_receipt'").get(),
      ).toEqual({ count: 0 })
    } finally {
      harness.db.close()
    }
  })

  it('safely inverts an applied change set when every document still matches its after-fence', async () => {
    const harness = createHarness()
    try {
      await harness.worker.tick()
      const applied = getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)!
      expect(applied.state).toBe('applied')
      expect(applied.eventDocumentId).toBeTruthy()

      updateActiveMessageById(harness.db, 'assistant-a', { data: `${ASSISTANT_TEXT} Edited.` })
      expect(getBardWikiReceiptSummary(harness.db, applied.id)?.state).toBe('stale')
      expect(harness.db.prepare("SELECT status FROM bardwiki_jobs WHERE kind = 'reconcile_receipt'").get()).toEqual({
        status: 'pending',
      })

      await harness.worker.tick()

      expect(getBardWikiReceiptSummary(harness.db, applied.id)).toMatchObject({
        state: 'obsolete',
        errorCode: 'bardwiki_source_changed',
      })
      expect(
        getBardWikiDocument(harness.db, 'chat-a', applied.eventDocumentId!, { includeDeleted: true }),
      ).toMatchObject({
        deletedAt: expect.any(String),
        version: 2,
      })
      expect(getSchemaState(harness.db).revision).toBe(2)
      expect(harness.eventSink.list().map((event) => event.type)).toEqual([
        'bardwiki.document.created',
        'bardwiki.reconciliation.completed',
      ])
    } finally {
      harness.db.close()
    }
  })

  it('preserves later manual Markdown and escalates every affected live document to needs_review', async () => {
    const harness = createHarness()
    try {
      await harness.worker.tick()
      const applied = getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)!
      const event = getBardWikiDocument(harness.db, 'chat-a', applied.eventDocumentId!)!
      const manualMarkdown = `${event.markdown}\n\nManual correction that must survive.`
      updateBardWikiDocument(harness.db, 'chat-a', event.id, {
        expectedVersion: event.version,
        expectedContentHash: event.contentHash,
        markdown: manualMarkdown,
        commandRevision: 1,
      })

      updateActiveMessageById(harness.db, 'user-a', { data: `${USER_TEXT} Edited.` })
      await harness.worker.tick()

      expect(getBardWikiReceiptSummary(harness.db, applied.id)).toMatchObject({
        state: 'needs_review',
        errorCode: 'bardwiki_reconcile_needs_review',
      })
      expect(getBardWikiDocument(harness.db, 'chat-a', event.id)).toMatchObject({
        reviewState: 'needs_review',
        markdown: manualMarkdown,
        version: 3,
      })
      expect(getSchemaState(harness.db).revision).toBe(2)
    } finally {
      harness.db.close()
    }
  })

  it('preserves a vault replacement through queued source reconciliation and the next full rebuild', async () => {
    const harness = createHarness()
    const source = createHarness()
    try {
      await harness.worker.tick()
      await source.worker.tick()
      const applied = getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)!
      const target = getBardWikiDocument(harness.db, 'chat-a', applied.eventDocumentId!)!
      const sourceReceipt = getBardWikiReceiptSummary(source.db, source.confirmation.receipt.id)!
      const sourceDocument = getBardWikiDocument(source.db, 'chat-a', sourceReceipt.eventDocumentId!)!
      const markdown = 'Imported manual correction that must survive reconciliation and rebuilding.'
      updateBardWikiDocument(source.db, 'chat-a', sourceDocument.id, {
        expectedVersion: sourceDocument.version,
        expectedContentHash: sourceDocument.contentHash,
        markdown,
        commandRevision: 1,
      })
      const vault = decodeBardWikiVault(encodeBardWikiVault(source.db, 'chat-a'))
      updateActiveMessageById(harness.db, 'user-a', { data: USER_TEXT + ' Changed source.' })
      const revision = getSchemaState(harness.db).revision
      applyTargetedCommandMutation({
        db: harness.db,
        dataDir: harness.dataDir,
        baseRevision: revision,
        eventSink: harness.eventSink,
        mutationPath: 'targeted-bardwiki',
        skipDatabaseLoad: true,
        mutate(_database, db) {
          const plan = applyBardWikiVaultImport(
            db,
            'chat-a',
            vault,
            'replace',
            [{ documentId: target.id, version: target.version, contentHash: target.contentHash }],
            revision + 1,
          )
          expect(plan.replacements).toBe(1)
          return { event: { ...COMMAND_EVENT_CATALOG.bardWikiVaultImported, id: 'chat-a' } }
        },
      })
      await harness.worker.tick()
      const reviewed = getBardWikiDocument(harness.db, 'chat-a', target.id)!
      expect(reviewed).toMatchObject({ markdown, reviewState: 'needs_review' })
      const rebuild = enqueueBardWikiRebuild(harness.db, { chatId: 'chat-a', policy: 'full', expectedSourceCount: 1 })
      const worker = new BardWikiWorker({
        db: harness.db,
        handlers: {
          rebuild_chat: createBardWikiRebuildHandler({
            db: harness.db,
            dataDir: harness.dataDir,
            loadDatabase: () => createInitialDatabase(),
            analyze: async () => EVENT_DRAFT,
          }),
        },
      })
      await worker.tick()
      expect(getBardWikiJob(harness.db, rebuild.id)?.status).toBe('completed')
      expect(getBardWikiDocument(harness.db, 'chat-a', target.id)).toEqual(reviewed)
      expect(getBardWikiReceiptSummary(harness.db, applied.id)?.state).toBe('needs_review')
    } finally {
      harness.db.close()
      source.db.close()
    }
  })

  it('cancels a running provider result changed through the authoritative message boundary', async () => {
    const harness = createHarness()
    let analyzeCalls = 0
    try {
      const worker = new BardWikiWorker({
        db: harness.db,
        retry: { backoffBaseMs: 0 },
        handlers: {
          apply_turn: createBardWikiApplyTurnHandler({
            db: harness.db,
            dataDir: harness.dataDir,
            loadDatabase: () => createInitialDatabase(),
            analyze: async () => {
              analyzeCalls += 1
              updateActiveMessageById(harness.db, 'assistant-a', { data: `${ASSISTANT_TEXT} Changed.` })
              return EVENT_DRAFT
            },
          }),
        },
      })
      await worker.tick()
      expect(analyzeCalls).toBe(1)
      expect(getBardWikiJob(harness.db, harness.confirmation.job.id)?.status).toBe('cancelled')
      expect(getBardWikiReceiptSummary(harness.db, harness.confirmation.receipt.id)?.state).toBe('obsolete')
      expect(harness.db.prepare('SELECT * FROM bardwiki_documents').all()).toEqual([])
      expect(getSchemaState(harness.db).revision).toBe(0)
    } finally {
      harness.db.close()
    }
  })
})
