import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { buildApp } from '../src/app.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { createOrReuseAutomaticBardWikiConfirmation, hashBardWikiMessageContent } from '../src/bardWikiReceipts.js'
import { setupAuthedClient } from './helpers/auth.js'

const USER_TEXT = 'We enter the old tavern.'
const ASSISTANT_TEXT = 'Mira lights a lantern beside the door.'
let app: FastifyInstance
let dataDir: string
let assertion: string

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-confirmation-'))
  ;({ app } = await buildApp({
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
    bardWikiWorker: false,
  }))
  ;({ assertion } = await setupAuthedClient(app))
  seedConfirmationChat()
})

afterEach(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seedConfirmationChat(
  options: {
    enabled?: boolean
    assistantDisabled?: boolean
    assistantRole?: string
    confirmationPolicy?: 'manual' | 'automatic'
  } = {},
): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const initial = createInitialDatabase() as unknown as Record<string, unknown>
    initial.bardWiki = {
      ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
      enabledByDefault: options.enabled ?? true,
      memoryMode: 'bardwiki',
      confirmationPolicy: options.confirmationPolicy ?? 'manual',
    }
    db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(initial))
    db.prepare("INSERT INTO characters (id, position, data_json) VALUES ('character-a', 0, '{}')").run()
    db.prepare(
      "INSERT INTO chats (id, character_id, position, data_json) VALUES ('chat-a', 'character-a', 0, '{}')",
    ).run()
    const insert = db.prepare(
      `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
       VALUES ('chat-a', ?, ?, ?, ?, ?, ?, 0)`,
    )
    insert.run(
      0,
      'user-a',
      'user',
      USER_TEXT,
      null,
      JSON.stringify({ chatId: 'user-a', role: 'user', data: USER_TEXT }),
    )
    const assistantRole = options.assistantRole ?? 'char'
    const assistantDisabled = options.assistantDisabled === true
    insert.run(
      1,
      'assistant-a',
      assistantRole,
      ASSISTANT_TEXT,
      assistantDisabled ? 'true' : null,
      JSON.stringify({
        chatId: 'assistant-a',
        role: assistantRole,
        data: ASSISTANT_TEXT,
        ...(assistantDisabled ? { disabled: true } : {}),
      }),
    )
  } finally {
    db.close()
  }
}

function appendActiveMessage(seq: number, uid: string, role: 'user' | 'char', data: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    db.prepare(
      `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
       VALUES ('chat-a', ?, ?, ?, ?, NULL, ?, 0)`,
    ).run(seq, uid, role, data, JSON.stringify({ chatId: uid, role, data }))
  } finally {
    db.close()
  }
}

function confirmationBody(baseRevision = 0) {
  return {
    baseRevision,
    userMessageId: 'user-a',
    userContentHash: hashBardWikiMessageContent(USER_TEXT),
    assistantMessageId: 'assistant-a',
    assistantContentHash: hashBardWikiMessageContent(ASSISTANT_TEXT),
  }
}

async function confirm(body = confirmationBody(), headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/commands/bardwiki/chats/chat-a/confirmations',
    headers: { 'risu-auth': assertion, ...headers },
    payload: body,
  })
}

function inspect(sql: string): unknown[] {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

describe('explicit BardWiki confirmation', () => {
  it('projects only the current eligible source identity for the confirmation UI', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/bardwiki/chats/chat-a',
      headers: { 'risu-auth': assertion },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().confirmationCandidate).toEqual({
      userMessageId: 'user-a',
      userContentHash: hashBardWikiMessageContent(USER_TEXT),
      assistantMessageId: 'assistant-a',
      assistantContentHash: hashBardWikiMessageContent(ASSISTANT_TEXT),
    })
    expect(JSON.stringify(response.json().confirmationCandidate)).not.toContain(USER_TEXT)
    expect(JSON.stringify(response.json().confirmationCandidate)).not.toContain(ASSISTANT_TEXT)
  })

  it('atomically queues one exact-source receipt and identifier-only job', async () => {
    const response = await confirm()
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      revision: 1,
      event: {
        type: 'bardwiki.confirmation.queued',
        resource: 'bardWikiChat',
        id: 'chat-a',
        sourceMessageId: 'assistant-a',
        jobId: expect.any(String),
      },
      receipt: {
        chatId: 'chat-a',
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        confirmationMode: 'explicit',
        state: 'queued',
      },
      job: { kind: 'apply_turn', status: 'pending', receiptId: expect.any(String) },
      created: true,
    })
    expect(response.json().job).not.toHaveProperty('payload')
    const payload = inspect('SELECT payload_json FROM bardwiki_jobs')[0] as { payload_json: string }
    expect(payload.payload_json).not.toContain(USER_TEXT)
    expect(payload.payload_json).not.toContain(ASSISTANT_TEXT)
    expect(inspect('SELECT * FROM bardwiki_turn_receipts')).toHaveLength(1)
    expect(inspect('SELECT * FROM bardwiki_jobs')).toHaveLength(1)
  })

  it('reuses the exact tuple without duplicating the receipt or job', async () => {
    const first = await confirm()
    const duplicate = await confirm(confirmationBody(1))
    expect(first.statusCode).toBe(200)
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json()).toMatchObject({
      revision: 2,
      receipt: { id: first.json().receipt.id },
      job: { id: first.json().job.id },
      created: false,
    })
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toHaveLength(1)
    expect(inspect('SELECT id FROM bardwiki_jobs')).toHaveLength(1)
  })

  it('replays a mutation receipt without a second revision or wake authority', async () => {
    const writer = 'writer-a'
    const headers = {
      'risu-writer-session': writer,
      'risu-mutation-id': 'confirmation-mutation-a',
      'risu-database-lineage': databaseLineage(),
    }
    const first = await confirm(confirmationBody(), headers)
    const replay = await confirm(confirmationBody(), headers)
    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(first.json())
    expect(inspect('SELECT revision FROM schema_version WHERE id = 1')).toMatchObject([{ revision: 1 }])
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toHaveLength(1)
  })

  it('rejects stale ids or hashes without a revision or partial receipt', async () => {
    for (const patch of [
      { assistantMessageId: 'assistant-old' },
      { assistantContentHash: 'f'.repeat(64) },
      { userMessageId: 'user-old' },
      { userContentHash: 'e'.repeat(64) },
    ]) {
      const response = await confirm({ ...confirmationBody(), ...patch })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toEqual({ error: 'bardwiki_source_not_active' })
    }
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toEqual([])
    expect(inspect('SELECT revision FROM schema_version WHERE id = 1')).toMatchObject([{ revision: 0 }])
  })

  it.each([
    { assistantDisabled: true, assistantRole: 'char', label: 'disabled' },
    { assistantDisabled: false, assistantRole: 'user', label: 'non-assistant' },
  ])('rejects a $label target as non-active', async ({ assistantDisabled, assistantRole }) => {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
    dataDir = mkdtempSync(path.join(tmpdir(), 'risu-bardwiki-confirmation-invalid-'))
    ;({ app } = await buildApp({
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
      bardWikiWorker: false,
    }))
    ;({ assertion } = await setupAuthedClient(app))
    seedConfirmationChat({ assistantDisabled, assistantRole })
    const response = await confirm()
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'bardwiki_source_not_active' })
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toEqual([])
  })

  it('rejects a valid source when BardWiki is disabled', async () => {
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      db.prepare(
        "UPDATE settings SET data_json = json_set(data_json, '$.bardWiki.enabledByDefault', json('false'))",
      ).run()
    } finally {
      db.close()
    }
    const response = await confirm()
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ error: 'bardwiki_disabled' })
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toEqual([])
  })

  it('serializes concurrent confirmation so only one exact tuple is accepted initially', async () => {
    const [left, right] = await Promise.all([confirm(), confirm()])
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409])
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toHaveLength(1)
    expect(inspect('SELECT id FROM bardwiki_jobs')).toHaveLength(1)
  })
})

describe('automatic BardWiki confirmation', () => {
  it('anchors to the accepted send and queues only its exact preceding active turn', async () => {
    appendActiveMessage(2, 'user-b', 'user', 'What happens next?')
    appendActiveMessage(3, 'assistant-b', 'char', 'The door opens.')

    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      db.prepare(
        "UPDATE settings SET data_json = json_set(data_json, '$.bardWiki.confirmationPolicy', 'automatic')",
      ).run()
      db.exec('BEGIN IMMEDIATE')
      const result = createOrReuseAutomaticBardWikiConfirmation(db, {
        chatId: 'chat-a',
        acceptedUserMessageId: 'user-b',
        resultAssistantMessageId: 'assistant-b',
      })
      db.exec('COMMIT')

      expect(result).toMatchObject({
        created: true,
        receipt: {
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          confirmationMode: 'automatic',
          state: 'queued',
        },
        job: { kind: 'apply_turn', status: 'pending' },
      })
      expect(
        createOrReuseAutomaticBardWikiConfirmation(db, {
          chatId: 'chat-a',
          acceptedUserMessageId: 'user-b',
          resultAssistantMessageId: 'assistant-b',
        }),
      ).toMatchObject({ created: false, receipt: { id: result?.receipt.id }, job: { id: result?.job.id } })
    } finally {
      db.close()
    }
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toHaveLength(1)
    expect(inspect('SELECT id FROM bardwiki_jobs')).toHaveLength(1)
  })

  it('skips the first send, manual policy, and non-exact active lineage without residue', async () => {
    appendActiveMessage(2, 'user-b', 'user', 'What happens next?')
    appendActiveMessage(3, 'assistant-b', 'char', 'The door opens.')
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    try {
      expect(
        createOrReuseAutomaticBardWikiConfirmation(db, {
          chatId: 'chat-a',
          acceptedUserMessageId: 'user-b',
          resultAssistantMessageId: 'assistant-b',
        }),
      ).toBeNull()
      db.prepare(
        "UPDATE settings SET data_json = json_set(data_json, '$.bardWiki.confirmationPolicy', 'automatic')",
      ).run()
      expect(
        createOrReuseAutomaticBardWikiConfirmation(db, {
          chatId: 'chat-a',
          acceptedUserMessageId: 'wrong-user',
          resultAssistantMessageId: 'assistant-b',
        }),
      ).toBeNull()
      db.prepare("DELETE FROM messages WHERE uid IN ('user-a', 'assistant-a')").run()
      expect(
        createOrReuseAutomaticBardWikiConfirmation(db, {
          chatId: 'chat-a',
          acceptedUserMessageId: 'user-b',
          resultAssistantMessageId: 'assistant-b',
        }),
      ).toBeNull()
    } finally {
      db.close()
    }
    expect(inspect('SELECT id FROM bardwiki_turn_receipts')).toEqual([])
    expect(inspect('SELECT id FROM bardwiki_jobs')).toEqual([])
  })
})

function databaseLineage(): string {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    return getDatabaseLineage(db)
  } finally {
    db.close()
  }
}
