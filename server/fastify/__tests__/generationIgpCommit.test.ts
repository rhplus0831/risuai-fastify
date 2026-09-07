import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../src/commands/events.js'
import { getSchemaState } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { ensureGenerationEffectLedger, listGenerationEffects } from '../src/generationEffects.js'
import { setupAuthedClient } from './helpers/auth.js'

let app: FastifyInstance
let dataDir: string
let db: DatabaseSync
let assertion: string
let lineage: string
let revision: number
let events: CommandEventSink

const generationId = 'generation-a'
const messageId = 'message-a'
const chatId = 'chat-a'
const characterId = 'character-a'

function headers(writer = 'writer-a', mutationId?: string) {
  return {
    'risu-auth': assertion,
    'risu-writer-session': writer,
    'risu-database-lineage': lineage,
    ...(mutationId ? { 'risu-mutation-id': mutationId } : {}),
  }
}

function message() {
  const row = db.prepare('SELECT json FROM messages WHERE uid = ? AND alternate = 0').get(messageId) as { json: string }
  return JSON.parse(row.json) as Record<string, unknown>
}

function igp() {
  return listGenerationEffects(db, generationId, lineage).find((effect) => effect.kind === 'igp')!
}

function receiptCount() {
  return (db.prepare('SELECT COUNT(*) AS count FROM command_mutation_receipts').get() as { count: number }).count
}

function snapshot() {
  return {
    message: message(),
    effects: listGenerationEffects(db, generationId, lineage),
    revision: getSchemaState(db).revision,
    receipts: receiptCount(),
    events: events.list(),
  }
}

function setMessageInfo(generationInfo: unknown) {
  const next = { ...message(), generationInfo }
  db.prepare('UPDATE messages SET json = ? WHERE uid = ? AND alternate = 0').run(JSON.stringify(next), messageId)
}

function patch(payload: Record<string, unknown>, writer = 'writer-a', mutationId = 'igp-command') {
  return app.inject({
    method: 'PATCH',
    url: `/api/v1/commands/messages/${messageId}`,
    headers: headers(writer, mutationId),
    payload,
  })
}

function receipt(claimId: string, status = 'completed', writer = 'writer-a') {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/generation-effects/${generationId}/igp/receipt`,
    headers: headers(writer),
    payload: { claimId, status },
  })
}

async function claim(writer = 'writer-a', delivery = 'live_terminal') {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/generation-effects/${generationId}/igp/claims`,
    headers: headers(writer),
    payload: { delivery, messageId },
  })
  expect(response.statusCode, response.body).toBeLessThan(300)
  return response.json() as { status: string; claimId?: string; reason?: string }
}

async function takeover() {
  const discovery = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
  const observed = discovery.json()
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: {
      ...headers('writer-b'),
      'risu-expected-writer-epoch': String(observed.writer.epoch),
      'risu-expected-database-lineage': observed.databaseLineage,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
}

function patchBody(claimId: string, expectedData = 'R') {
  return {
    baseRevision: getSchemaState(db).revision,
    patch: { data: `${expectedData}[IGP]` },
    expectedData,
    expectedChatId: chatId,
    expectedGenerationId: generationId,
    igpEffect: { generationId, claimId },
  }
}

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-igp-commit-'))
  events = createCommandEventSink()
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
    commandEvents: events,
    assetGc: false,
    memoryWorker: false,
  }))
  ;({ assertion } = await setupAuthedClient(app))
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: {
      database: {
        characters: [
          {
            chaId: characterId,
            name: 'Character A',
            chatPage: 0,
            chatFolders: [],
            chats: [
              {
                id: chatId,
                name: 'Chat A',
                note: '',
                localLore: [],
                message: [
                  {
                    role: 'char',
                    chatId: messageId,
                    data: 'R',
                    generationInfo: { generationId },
                  },
                ],
              },
            ],
          },
        ],
        characterOrder: [characterId],
        modelProfiles: [],
        agentPresets: [],
      },
    },
  })
  expect(imported.statusCode, imported.body).toBe(200)
  db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  lineage = getDatabaseLineage(db)
  revision = getSchemaState(db).revision
  ensureGenerationEffectLedger(db, {
    databaseLineage: lineage,
    generationId,
    characterId,
    chatId,
    messageId,
    operationId: 'operation-a',
    operationProtocolVersion: 1,
  })
  const writer = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: headers() })
  expect(writer.statusCode, writer.body).toBe(200)
  events.clear()
})

afterEach(async () => {
  db?.close()
  await app?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('atomic IGP message commit', () => {
  it('cannot append again after an accepted PATCH loses its response and another writer reclaims recovery', async () => {
    const first = await claim()
    expect(first.status).toBe('claimed')
    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/commands/messages/${messageId}`,
      headers: headers('writer-a', 'igp-first'),
      payload: patchBody(first.claimId!),
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    // The browser never processes the accepted response or sends an effect
    // receipt. Durable SQLite state alone must close the receipt gap.
    expect(message().data).toBe('R[IGP]')
    db.prepare(
      "UPDATE generation_effects SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE generation_id = ? AND effect_kind = 'igp'",
    ).run(generationId)
    await takeover()
    const recovered = await claim('writer-b', 'late_recovery')
    if (recovered.status === 'claimed') {
      const duplicated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/commands/messages/${messageId}`,
        headers: headers('writer-b', 'igp-recovered'),
        payload: patchBody(recovered.claimId!, String(message().data)),
      })
      expect(duplicated.statusCode, duplicated.body).toBe(200)
    }
    expect({
      data: message().data,
      status: igp().status,
      recovery: recovered.status,
      revision: getSchemaState(db).revision,
    }).toEqual({
      data: 'R[IGP]',
      status: 'completed',
      recovery: 'not_claimed',
      revision: revision + 1,
    })
    expect(receiptCount()).toBe(1)
    expect(events.list()).toHaveLength(1)
  })

  it('replays the accepted command across writer transfer and acknowledges only the same completed IGP claim', async () => {
    const first = await claim()
    const body = patchBody(first.claimId!)
    const accepted = await patch(body)
    expect(accepted.statusCode, accepted.body).toBe(200)
    const committed = snapshot()
    expect(committed.effects.find((effect) => effect.kind === 'igp')).toMatchObject({
      status: 'completed',
      claimId: first.claimId,
    })
    await takeover()
    const replayed = await patch({ ...body, baseRevision: revision + 100 }, 'writer-b')
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.json()).toEqual(accepted.json())
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acknowledged = await receipt(first.claimId!, 'completed', 'writer-b')
      expect(acknowledged.statusCode, acknowledged.body).toBe(200)
      expect(acknowledged.json().effect).toEqual(igp())
    }
    expect((await receipt(first.claimId!, 'failed', 'writer-b')).statusCode).toBe(409)
    expect((await receipt('other-claim', 'completed', 'writer-b')).statusCode).toBe(409)
    expect(snapshot()).toEqual(committed)
    const duplicate = await patch(patchBody(first.claimId!, 'R[IGP]'), 'writer-b', 'different-mutation')
    expect(duplicate.statusCode).toBe(400)
    expect(snapshot()).toEqual(committed)
  })

  it.each([
    [
      'text precondition',
      (body: Record<string, unknown>) => {
        body.expectedData = 'changed elsewhere'
      },
    ],
    [
      'chat precondition',
      (body: Record<string, unknown>) => {
        body.expectedChatId = 'other-chat'
      },
    ],
    [
      'generation precondition',
      (body: Record<string, unknown>) => {
        body.expectedGenerationId = 'other-generation'
      },
    ],
    [
      'wrong claim',
      (body: Record<string, unknown>) => {
        body.igpEffect = { generationId, claimId: 'other-claim' }
      },
    ],
    [
      'wrong generation binding',
      (body: Record<string, unknown>) => {
        body.igpEffect = { generationId: 'other-generation', claimId: (body.igpEffect as { claimId: string }).claimId }
      },
    ],
    [
      'missing text precondition',
      (body: Record<string, unknown>) => {
        delete body.expectedData
      },
    ],
    [
      'missing chat precondition',
      (body: Record<string, unknown>) => {
        delete body.expectedChatId
      },
    ],
    [
      'missing modern generation precondition',
      (body: Record<string, unknown>) => {
        delete body.expectedGenerationId
      },
    ],
    [
      'non-data patch',
      (body: Record<string, unknown>) => {
        body.patch = { data: 'R[IGP]', role: 'user' }
      },
    ],
    [
      'missing binding claim',
      (body: Record<string, unknown>) => {
        body.igpEffect = { generationId }
      },
    ],
    [
      'missing binding generation',
      (body: Record<string, unknown>) => {
        body.igpEffect = { claimId: 'claim' }
      },
    ],
    [
      'non-object binding',
      (body: Record<string, unknown>) => {
        body.igpEffect = []
      },
    ],
    [
      'extra binding fields',
      (body: Record<string, unknown>) => {
        body.igpEffect = { ...(body.igpEffect as object), databaseLineage: lineage }
      },
    ],
  ] as const)('rejects %s without an orphan effect or mutation receipt', async (_name, change) => {
    const first = await claim()
    const body: Record<string, unknown> = patchBody(first.claimId!)
    change(body)
    const before = snapshot()
    const result = await patch(body)
    expect(result.statusCode, result.body).toBe(400)
    expect(snapshot()).toEqual(before)
  })

  it.each([
    ['message_id', 'other-message'],
    ['chat_id', 'other-chat'],
    ['character_id', 'other-character'],
    ['claim_id', 'replacement-claim'],
    ['status', 'pending'],
    ['status', 'failed'],
    ['status', 'skipped'],
    ['lease_expires_at', '2000-01-01T00:00:00.000Z'],
    ['lease_expires_at', null],
  ] as const)('rejects a stale or mismatched effect %s=%s', async (column, value) => {
    const first = await claim()
    if (column === 'status' && value === 'pending') {
      db.prepare(
        "UPDATE generation_effects SET status = 'pending', claim_id = NULL, delivery = NULL, claimed_at = NULL WHERE generation_id = ? AND effect_kind = 'igp'",
      ).run(generationId)
    } else {
      db.prepare(`UPDATE generation_effects SET ${column} = ? WHERE generation_id = ? AND effect_kind = 'igp'`).run(
        value,
        generationId,
      )
    }
    const before = snapshot()
    const result = await patch(patchBody(first.claimId!))
    expect(result.statusCode, result.body).toBe(400)
    expect(snapshot()).toEqual(before)
  })

  it.each([
    ['databaseLineage', 'other-lineage'],
    ['operationId', 'other-operation'],
    ['jobId', 'other-job'],
    ['effectLedgerKeyType', 'generation'],
    ['effectLedgerKeyId', 'other-effect'],
    ['effectLedgerCharacterId', 'other-character'],
    ['effectLedgerChatId', 'other-chat'],
  ])('rejects conflicting stored generation metadata %s', async (key, value) => {
    const first = await claim()
    setMessageInfo({ generationId, [key]: value })
    const before = snapshot()
    const result = await patch(patchBody(first.claimId!))
    expect(result.statusCode, result.body).toBe(400)
    expect(snapshot()).toEqual(before)
  })

  it('requires lineage even without a command mutation id, and rejects an obsolete writer', async () => {
    const first = await claim()
    const before = snapshot()
    for (const suppliedLineage of [undefined, '00000000-0000-4000-8000-000000000000']) {
      const requestHeaders: Record<string, string> = headers()
      if (suppliedLineage) requestHeaders['risu-database-lineage'] = suppliedLineage
      else delete requestHeaders['risu-database-lineage']
      const result = await app.inject({
        method: 'PATCH',
        url: `/api/v1/commands/messages/${messageId}`,
        headers: requestHeaders,
        payload: patchBody(first.claimId!),
      })
      expect(result.statusCode, result.body).toBe(suppliedLineage ? 409 : 400)
      expect(snapshot()).toEqual(before)
    }
    await takeover()
    const stale = await patch(patchBody(first.claimId!))
    expect(stale.statusCode, stale.body).toBe(423)
    expect(stale.json()).toMatchObject({ error: 'active_writer_stale' })
    expect(snapshot()).toEqual(before)
  })

  it.each(['message write', 'effect completion'])(
    'rolls back the message, effect and revision together when %s fails',
    async (failure) => {
      const first = await claim()
      db.exec(
        failure === 'message write'
          ? "CREATE TRIGGER fail_igp_commit BEFORE UPDATE ON messages WHEN NEW.uid = 'message-a' BEGIN SELECT RAISE(ABORT, 'injected IGP message failure'); END;"
          : "CREATE TRIGGER fail_igp_commit BEFORE UPDATE ON generation_effects WHEN NEW.effect_kind = 'igp' AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected IGP effect failure'); END;",
      )
      const before = snapshot()
      const body = patchBody(first.claimId!)
      const failed = await patch(body)
      expect(failed.statusCode).toBeGreaterThanOrEqual(400)
      expect(snapshot()).toEqual(before)
      db.exec('DROP TRIGGER fail_igp_commit')
      const retried = await patch(body)
      expect(retried.statusCode, retried.body).toBe(200)
      expect(message().data).toBe('R[IGP]')
      expect(igp().status).toBe('completed')
      expect(getSchemaState(db).revision).toBe(revision + 1)
      expect(receiptCount()).toBe(1)
      expect(events.list()).toHaveLength(1)
    },
  )

  it('accepts exact modern generation metadata and preserves it while completing IGP', async () => {
    const info = {
      generationId,
      databaseLineage: lineage,
      operationId: 'operation-a',
      jobId: generationId,
      effectLedgerKeyType: 'operation',
      effectLedgerKeyId: 'operation-a',
      effectLedgerCharacterId: characterId,
      effectLedgerChatId: chatId,
    }
    setMessageInfo(info)
    const first = await claim()
    const result = await patch(patchBody(first.claimId!))
    expect(result.statusCode, result.body).toBe(200)
    expect(message()).toMatchObject({ data: 'R[IGP]', generationInfo: info })
    expect(igp().status).toBe('completed')
  })

  it('supports a legacy effect whose exact message predates generation metadata', async () => {
    db.prepare('DELETE FROM generation_effects WHERE generation_id = ?').run(generationId)
    ensureGenerationEffectLedger(db, {
      databaseLineage: lineage,
      generationId,
      characterId,
      chatId,
      messageId,
      operationId: 'legacy-operation',
      operationProtocolVersion: 0,
    })
    setMessageInfo(undefined)
    const first = await claim()
    const body: Record<string, unknown> = patchBody(first.claimId!)
    delete body.expectedGenerationId
    const result = await patch(body)
    expect(result.statusCode, result.body).toBe(200)
    expect(message().data).toBe('R[IGP]')
    expect(igp()).toMatchObject({ status: 'completed', keyType: 'generation', keyId: generationId })
  })

  it('keeps ordinary message edits independent of the IGP ledger', async () => {
    await claim()
    const result = await patch({ baseRevision: revision, patch: { data: 'ordinary edit' } })
    expect(result.statusCode, result.body).toBe(200)
    expect(message().data).toBe('ordinary edit')
    expect(igp().status).toBe('claimed')
  })
})
