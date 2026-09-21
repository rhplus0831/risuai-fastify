import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  beginRequestHistory,
  completeRequestHistory,
  createRequestHistoryTable,
  getRequestHistoryRecord,
  listRequestHistory,
  pruneRequestHistory,
  REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES,
  REQUEST_HISTORY_API_METADATA_MAX_BYTES,
  REQUEST_HISTORY_ERROR_MAX_BYTES,
  REQUEST_HISTORY_METADATA_MAX_BYTES,
  REQUEST_HISTORY_PROMPT_MAX_BYTES,
  REQUEST_HISTORY_RESPONSE_MAX_BYTES,
  REQUEST_HISTORY_SOURCE_MAX_BYTES,
  requestHistoryProfileSnapshot,
  wrapRequestHistoryFrames,
  type RequestHistoryProfileSnapshot,
} from '../src/requestHistory.js'
import type { CompletionStreamFrame } from '../src/generation/frames.js'
import type { ResolvedModelProfile } from '@risuai/shared-core/model-profile-resolver'

const profile: RequestHistoryProfileSnapshot = {
  id: 'profile-a',
  name: 'Profile A',
  role: 'chatMain',
  sourceKind: 'durable-profile',
  provider: 'openai',
  modelId: 'gpt-4o',
  requestModel: 'gpt-4o-2024-11-20',
}

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  createRequestHistoryTable(db)
})

afterEach(() => {
  db.close()
})

describe('request history repository', () => {
  it('adds API metadata storage to an existing request-history table', () => {
    db.exec(`
      DROP TABLE request_history;
      CREATE TABLE request_history (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        prompt_json TEXT NOT NULL,
        context_json TEXT,
        toggles_json TEXT,
        response_text TEXT,
        metadata_json TEXT NOT NULL,
        error_text TEXT
      );
    `)

    createRequestHistoryTable(db)

    const columns = db.prepare('PRAGMA table_info(request_history)').all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('api_metadata_json')
  })

  it('retains the newest configured records and stores response metadata separately', () => {
    for (let index = 1; index <= 3; index += 1) {
      const handle = beginRequestHistory({
        db,
        limit: 2,
        id: `record-${index}`,
        startedAt: index,
        source: 'chat',
        profile,
        prompt: [{ role: 'user', content: `prompt-${index}` }],
        context: { characterId: 'char-a', chatId: 'chat-a' },
        toggles: { mode: index === 3 ? '1' : '0' },
        metadata: { attempt: index },
      })
      completeRequestHistory(handle, {
        status: 'success',
        response: `response-${index}`,
        metadata: { finishReason: 'stop' },
        apiMetadata: { usage: { outputTokens: index } },
        completedAt: index + 10,
      })
    }

    expect(listRequestHistory(db, 2).map((record) => record.id)).toEqual(['record-3', 'record-2'])
    const record = getRequestHistoryRecord(db, 'record-3')
    expect(record).toMatchObject({
      status: 'success',
      response: 'response-3',
      toggles: { mode: '1' },
      metadata: { attempt: 3, finishReason: 'stop', durationMs: 10 },
      apiMetadata: { usage: { outputTokens: 3 } },
    })
    expect(record?.metadata).not.toHaveProperty('response')
  })

  it(
    'redacts secret-shaped metadata, error text, and known credential values before persistence',
    { tags: 'core' },
    () => {
      const handle = beginRequestHistory({
        db,
        limit: 5,
        id: 'redacted',
        source: 'chat',
        profile,
        prompt: [{ role: 'user', content: 'do not persist opaque-credential-value' }],
        context: { characterName: 'Character opaque-credential-value', chatId: 'safe-chat' },
        toggles: { mode: 'safe-mode', api_key: 'toggle-secret' },
        metadata: { authorization: 'Bearer begin-secret', attempt: 3 },
        redactionValues: ['opaque-credential-value'],
      })

      const pendingRow = db.prepare('SELECT * FROM request_history WHERE id = ?').get('redacted')
      expect(pendingRow).toBeDefined()
      expect(JSON.stringify(pendingRow)).not.toMatch(/opaque-credential-value|begin-secret|toggle-secret/u)

      completeRequestHistory(handle, {
        status: 'error',
        response: 'echoed opaque-credential-value',
        error: 'Incorrect API key provided: sk-live-secret; password=hunter2; credential=opaque-credential-value',
        metadata: { access_token: 'metadata-token-secret', finishReason: 'provider-error' },
        apiMetadata: {
          api_key: 'sk-json-secret',
          nested: {
            access_token: 'token-json-secret',
            message: 'Authorization: Bearer upstream-secret',
          },
        },
      })

      const record = getRequestHistoryRecord(db, 'redacted')
      const serialized = JSON.stringify(record)
      expect(record).toMatchObject({
        prompt: [{ content: 'do not persist [redacted]' }],
        response: 'echoed [redacted]',
        context: { characterName: 'Character [redacted]', chatId: 'safe-chat' },
        toggles: { mode: 'safe-mode', api_key: '[redacted]' },
        metadata: {
          authorization: '[redacted]',
          access_token: '[redacted]',
          attempt: 3,
          finishReason: 'provider-error',
        },
        apiMetadata: {
          api_key: '[redacted]',
          nested: { access_token: '[redacted]', message: 'Authorization: Bearer [redacted]' },
        },
      })
      expect(record?.error).toContain('API key provided: [redacted]')
      expect(record?.error).toContain('password=[redacted]')
      const storedRow = db.prepare('SELECT * FROM request_history WHERE id = ?').get('redacted')
      expect(storedRow).toBeDefined()
      for (const representation of [serialized, JSON.stringify(storedRow)]) {
        expect(representation).not.toMatch(
          /opaque-credential-value|begin-secret|toggle-secret|sk-live-secret|hunter2|metadata-token-secret|sk-json-secret|token-json-secret|upstream-secret/u,
        )
      }
    },
  )

  it('uses zero as disable-and-clear', () => {
    beginRequestHistory({
      db,
      limit: 1,
      source: 'completion',
      profile,
      prompt: [],
    })
    expect(listRequestHistory(db, 1)).toHaveLength(1)
    expect(pruneRequestHistory(db, 0)).toBe(1)
    expect(listRequestHistory(db, 0)).toEqual([])
    expect(beginRequestHistory({ db, limit: 0, source: 'completion', profile, prompt: [] })).toBeNull()
  })

  it('accumulates streaming tokens and terminal frame metadata', async () => {
    const handle = beginRequestHistory({
      db,
      limit: 5,
      id: 'streamed',
      startedAt: 100,
      source: 'chat',
      profile,
      prompt: [{ role: 'user', content: 'hello' }],
    })
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: 'hello ' }
      yield { kind: 'token', content: 'world' }
      yield {
        kind: 'done',
        finishReason: 'length',
        alternates: ['alternate'],
        apiMetadata: { usage: { inputTokens: 5, outputTokens: 2 } },
      }
    }

    const received: CompletionStreamFrame[] = []
    for await (const frame of wrapRequestHistoryFrames(frames(), handle, new AbortController().signal)) {
      received.push(frame)
    }

    expect(received).toHaveLength(3)
    expect(getRequestHistoryRecord(db, 'streamed')).toMatchObject({
      status: 'success',
      response: 'hello world',
      metadata: {
        finishReason: 'length',
        alternates: ['alternate'],
        responseCharacters: 11,
      },
      apiMetadata: { usage: { inputTokens: 5, outputTokens: 2 } },
    })
  })

  it('completes history when the terminal frame is observed instead of when its consumer resumes', async () => {
    const handle = beginRequestHistory({
      db,
      limit: 5,
      id: 'paused-after-done',
      startedAt: Date.now(),
      source: 'chat',
      profile,
      prompt: [{ role: 'user', content: 'hello' }],
    })
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: 'provider result' }
      yield { kind: 'done', finishReason: 'stop' }
    }

    const iterator = wrapRequestHistoryFrames(frames(), handle, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ kind: 'token' })
    expect((await iterator.next()).value).toMatchObject({ kind: 'done' })

    const completedAt = getRequestHistoryRecord(db, 'paused-after-done')?.completedAt
    expect(getRequestHistoryRecord(db, 'paused-after-done')).toMatchObject({
      status: 'success',
      response: 'provider result',
      metadata: { finishReason: 'stop', responseCharacters: 15 },
    })
    expect(completedAt).toEqual(expect.any(Number))

    await iterator.return?.()
    expect(getRequestHistoryRecord(db, 'paused-after-done')?.completedAt).toBe(completedAt)
  })

  it('caps UTF-8 history fields and exposes honest truncation metadata', async () => {
    const handle = beginRequestHistory({
      db,
      limit: 5,
      id: 'bounded',
      startedAt: 100,
      source: 's'.repeat(REQUEST_HISTORY_SOURCE_MAX_BYTES + 10),
      profile: { ...profile, requestModel: 'r'.repeat(REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES) },
      prompt: { content: '😀'.repeat(Math.ceil(REQUEST_HISTORY_PROMPT_MAX_BYTES / 4) + 100) },
      context: { characterName: 'c'.repeat(REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES) },
      toggles: { oversized: 't'.repeat(REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES) },
      metadata: { beginPayload: 'm'.repeat(REQUEST_HISTORY_METADATA_MAX_BYTES) },
    })
    async function* frames(): AsyncGenerator<CompletionStreamFrame> {
      yield { kind: 'token', content: '가'.repeat(Math.ceil(REQUEST_HISTORY_RESPONSE_MAX_BYTES / 3)) }
      yield { kind: 'token', content: 'tail-that-must-not-grow-the-capture' }
      yield {
        kind: 'error',
        error: 'e'.repeat(REQUEST_HISTORY_ERROR_MAX_BYTES + 100),
        apiMetadata: { raw: 'a'.repeat(REQUEST_HISTORY_API_METADATA_MAX_BYTES) },
      }
    }

    for await (const _frame of wrapRequestHistoryFrames(frames(), handle, new AbortController().signal)) {
      // Drain the provider frames; capture must remain transparent to callers.
    }

    const record = getRequestHistoryRecord(db, 'bounded')
    expect(Buffer.byteLength(record?.source ?? '', 'utf8')).toBe(REQUEST_HISTORY_SOURCE_MAX_BYTES)
    expect(record?.profile.requestModel.length).toBeLessThan(REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES)
    expect(record?.context?.characterName?.length).toBeLessThan(REQUEST_HISTORY_AUXILIARY_JSON_MAX_BYTES)
    expect(record?.toggles).toMatchObject({ requestHistoryTruncated: 'true' })
    expect(record?.prompt).toMatchObject({ requestHistoryTruncated: true })
    expect(Buffer.byteLength(record?.response ?? '', 'utf8')).toBeLessThanOrEqual(REQUEST_HISTORY_RESPONSE_MAX_BYTES)
    expect(record?.response.endsWith('\ufffd')).toBe(false)
    expect(Buffer.byteLength(record?.error ?? '', 'utf8')).toBeLessThanOrEqual(REQUEST_HISTORY_ERROR_MAX_BYTES)
    expect(record?.apiMetadata).toMatchObject({ requestHistoryTruncated: true })
    expect(record?.metadata.requestHistoryTruncation).toMatchObject({
      source: { originalBytes: expect.any(Number), storedBytes: expect.any(Number), truncatedBytes: 10 },
      profile: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      prompt: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      context: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      toggles: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      response: {
        originalBytes: expect.any(Number),
        storedBytes: REQUEST_HISTORY_RESPONSE_MAX_BYTES,
        truncatedBytes: expect.any(Number),
      },
      metadata: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      apiMetadata: {
        originalBytes: expect.any(Number),
        storedBytes: expect.any(Number),
        truncatedBytes: expect.any(Number),
      },
      error: { originalBytes: expect.any(Number), storedBytes: expect.any(Number), truncatedBytes: 100 },
    })
  })

  it('prunes oldest rows when their retained UTF-8 bytes exceed the total budget', () => {
    for (let index = 1; index <= 3; index += 1) {
      const handle = beginRequestHistory({
        db,
        limit: 10,
        id: `byte-record-${index}`,
        startedAt: index,
        source: 'completion',
        profile,
        prompt: [{ role: 'user', content: `prompt-${index}` }],
      })
      completeRequestHistory(handle, { status: 'success', response: String(index).repeat(400), completedAt: index + 1 })
    }
    const rows = db
      .prepare(
        `SELECT id,
                length(CAST(id AS BLOB)) + length(CAST(source AS BLOB)) +
                length(CAST(profile_json AS BLOB)) + length(CAST(prompt_json AS BLOB)) +
                length(CAST(COALESCE(context_json, '') AS BLOB)) +
                length(CAST(COALESCE(toggles_json, '') AS BLOB)) +
                length(CAST(COALESCE(response_text, '') AS BLOB)) +
                length(CAST(metadata_json AS BLOB)) + length(CAST(api_metadata_json AS BLOB)) +
                length(CAST(COALESCE(error_text, '') AS BLOB)) AS bytes
         FROM request_history ORDER BY started_at DESC`,
      )
      .all() as Array<{ id: string; bytes: number }>
    const newestTwoBudget = rows[0].bytes + rows[1].bytes

    expect(pruneRequestHistory(db, 10, newestTwoBudget)).toBe(1)
    expect(listRequestHistory(db, 10).map((record) => record.id)).toEqual(['byte-record-3', 'byte-record-2'])
  })

  it('builds a credential-free resolved-profile snapshot', () => {
    const resolved = {
      role: 'chatMain',
      profileId: 'profile-secret',
      modelId: 'model-a',
      requestModel: 'wire-a',
      source: { kind: 'durable-profile', profileName: 'Safe name' },
      status: { providerId: 'openai' },
      providerCapability: { routable: true, provider: 'openai' },
      providerOptions: { apiKey: 'must-not-be-stored', requestModel: 'wire-a' },
    } as unknown as ResolvedModelProfile

    const snapshot = requestHistoryProfileSnapshot(resolved)
    expect(snapshot).toEqual({
      id: 'profile-secret',
      name: 'Safe name',
      role: 'chatMain',
      sourceKind: 'durable-profile',
      provider: 'openai',
      modelId: 'model-a',
      requestModel: 'wire-a',
    })
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-stored')
  })
})
