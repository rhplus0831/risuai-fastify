import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { enqueueGenerationFinalizationRetry } from '../src/generationFinalizationRetry.js'
import {
  createGenerationOperation,
  reserveGenerationOperationAttempt,
  transitionGenerationOperation,
} from '../src/generationOperations.js'

const dataDirs: string[] = []
const apps: FastifyInstance[] = []

function config(dataDir: string) {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    bodyLimit: 1024 * 1024,
    importMaxBytes: Infinity,
    trustProxy: false,
    hubUrl: 'https://sv.risuai.xyz',
    agentDevAuthBypass: true,
  }
}

async function build(dataDir: string): Promise<FastifyInstance> {
  const { app } = await buildApp({
    config: config(dataDir),
    memoryWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  apps.push(app)
  return app
}

function createAccepted(db: DatabaseSync, lineage: string, operationId: string): void {
  createGenerationOperation(db, {
    databaseLineage: lineage,
    operationId,
    protocolVersion: 1,
    requestOrigin: 'accepted_send',
    creatorWriterSessionId: 'writer-a',
    creatorWriterEpoch: 1,
    bindingServerInstanceId: 'server-old',
    characterId: 'character-a',
    chatId: `chat-${operationId}`,
    mode: 'send',
    acceptedMessageId: `user-${operationId}`,
    requestFingerprint: operationId.padEnd(64, '0').slice(0, 64),
    intent: { mode: 'send', operationId },
    acceptedRevision: 1,
    state: 'accepted',
  })
}

function makeOwned(db: DatabaseSync, lineage: string, operationId: string): void {
  createAccepted(db, lineage, operationId)
  reserveGenerationOperationAttempt(db, {
    databaseLineage: lineage,
    operationId,
    expectedState: 'accepted',
    expectedStateVersion: 1,
    retryRequestId: operationId,
    jobId: `job-${operationId}`,
    serverInstanceId: 'server-old',
    actorWriterSessionId: 'writer-a',
    actorWriterEpoch: 1,
    launchRevision: 1,
  })
  transitionGenerationOperation(db, {
    databaseLineage: lineage,
    operationId,
    expectedState: 'launching',
    expectedStateVersion: 2,
    nextState: 'owned_by_job',
  })
}

afterEach(async () => {
  for (const app of apps.splice(0).reverse()) {
    try {
      await app.close()
    } catch {
      // A test may already have closed the pre-restart instance.
    }
  }
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

describe('generation operation startup reconciliation', () => {
  it('rebuilds after append/launch/finalization loss without redispatching provider work', async () => {
    process.env.LOG_LEVEL = 'silent'
    const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-operation-startup-'))
    dataDirs.push(dataDir)
    const firstApp = await build(dataDir)
    const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
    let lineage: string
    try {
      db.exec('PRAGMA foreign_keys = ON')
      lineage = getDatabaseLineage(db)

      createAccepted(db, lineage, 'accepted')
      db.prepare(
        `INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
         VALUES ('chat-accepted', 0, 'user-accepted', 'user', 'accepted before loss', NULL, ?, 0)`,
      ).run(JSON.stringify({ role: 'user', data: 'accepted before loss', chatId: 'user-accepted' }))

      makeOwned(db, lineage, 'dispatched')
      db.prepare(
        `UPDATE generation_operation_attempts
         SET provider_dispatch_started_at = '2026-08-11T00:00:00.000Z'
         WHERE operation_id = 'dispatched'`,
      ).run()

      // Process loss after owned_by_job commits but before the provider marker.
      makeOwned(db, lineage, 'owned-undispatched')

      makeOwned(db, lineage, 'stopping')
      transitionGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'stopping',
        expectedState: 'owned_by_job',
        expectedStateVersion: 3,
        nextState: 'stopping',
      })

      makeOwned(db, lineage, 'journal')
      transitionGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'journal',
        expectedState: 'owned_by_job',
        expectedStateVersion: 3,
        nextState: 'finalizing',
        desiredTerminalOutcome: 'completed',
      })
      enqueueGenerationFinalizationRetry(db, {
        generationId: 'job-journal',
        databaseLineage: lineage,
        operationId: 'journal',
        operationAttemptNo: 1,
        actorWriterSessionId: 'writer-a',
        actorWriterEpoch: 1,
        acceptedMessageId: 'user-journal',
        terminalOutcome: 'completed',
        chatId: 'chat-journal',
        mode: 'send',
        message: { role: 'char', data: 'saved exact result', chatId: 'assistant-journal' },
        chatVarMutations: [],
      })

      makeOwned(db, lineage, 'missing-journal')
      transitionGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'missing-journal',
        expectedState: 'owned_by_job',
        expectedStateVersion: 3,
        nextState: 'finalizing',
        desiredTerminalOutcome: 'completed',
      })

      makeOwned(db, lineage, 'persisted-result')
      db.prepare(
        `
          INSERT INTO messages (chat_id, seq, uid, role, data, disabled, json, alternate)
          VALUES (?, 0, ?, 'char', ?, NULL, ?, 0)
        `,
      ).run(
        'chat-persisted-result',
        'assistant-persisted-result',
        'already saved',
        JSON.stringify({
          role: 'char',
          data: 'already saved',
          chatId: 'assistant-persisted-result',
          generationInfo: {
            databaseLineage: lineage,
            operationId: 'persisted-result',
            operationAttemptNo: 1,
            jobId: 'job-persisted-result',
            generationId: 'job-persisted-result',
          },
        }),
      )

      makeOwned(db, lineage, 'retryable')
      transitionGenerationOperation(db, {
        databaseLineage: lineage,
        operationId: 'retryable',
        expectedState: 'owned_by_job',
        expectedStateVersion: 3,
        nextState: 'retryable',
        failureCode: 'provider_unavailable',
      })
    } finally {
      db.close()
    }

    await firstApp.close()
    apps.splice(apps.indexOf(firstApp), 1)
    const restarted = await build(dataDir)

    const verify = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
    try {
      const states = verify
        .prepare(
          `
            SELECT operation_id, state, current_attempt_no, failure_code, provider_may_have_run, result_message_id
            FROM generation_operations
            ORDER BY operation_id
          `,
        )
        .all()
      expect(states).toEqual([
        {
          operation_id: 'accepted',
          state: 'abandoned',
          current_attempt_no: null,
          failure_code: 'server_restarted',
          provider_may_have_run: 0,
          result_message_id: null,
        },
        {
          operation_id: 'dispatched',
          state: 'abandoned',
          current_attempt_no: null,
          failure_code: 'server_restarted',
          provider_may_have_run: 1,
          result_message_id: null,
        },
        {
          operation_id: 'journal',
          state: 'finalizing',
          current_attempt_no: 1,
          failure_code: null,
          provider_may_have_run: 0,
          result_message_id: null,
        },
        {
          operation_id: 'missing-journal',
          state: 'abandoned',
          current_attempt_no: null,
          failure_code: 'finalization_record_missing',
          provider_may_have_run: 0,
          result_message_id: null,
        },
        {
          operation_id: 'owned-undispatched',
          state: 'abandoned',
          current_attempt_no: null,
          failure_code: 'server_restarted',
          provider_may_have_run: 0,
          result_message_id: null,
        },
        {
          operation_id: 'persisted-result',
          state: 'completed',
          current_attempt_no: null,
          failure_code: null,
          provider_may_have_run: 0,
          result_message_id: 'assistant-persisted-result',
        },
        {
          operation_id: 'retryable',
          state: 'retryable',
          current_attempt_no: null,
          failure_code: 'provider_unavailable',
          provider_may_have_run: 0,
          result_message_id: null,
        },
        {
          operation_id: 'stopping',
          state: 'abandoned',
          current_attempt_no: null,
          failure_code: 'server_restarted',
          provider_may_have_run: 0,
          result_message_id: null,
        },
      ])
      expect(
        verify
          .prepare(
            `SELECT operation_id, status FROM generation_operation_attempts
             WHERE operation_id IN ('dispatched', 'journal', 'missing-journal', 'owned-undispatched', 'persisted-result', 'stopping')
             ORDER BY operation_id`,
          )
          .all(),
      ).toEqual([
        { operation_id: 'dispatched', status: 'abandoned' },
        { operation_id: 'journal', status: 'finalizing' },
        { operation_id: 'missing-journal', status: 'abandoned' },
        { operation_id: 'owned-undispatched', status: 'abandoned' },
        { operation_id: 'persisted-result', status: 'completed' },
        { operation_id: 'stopping', status: 'abandoned' },
      ])
      expect(verify.prepare("SELECT COUNT(*) AS count FROM messages WHERE uid = 'user-accepted'").get()).toEqual({
        count: 1,
      })
    } finally {
      verify.close()
    }

    const bootstrap = await restarted.inject({ method: 'GET', url: '/api/v1/bootstrap' })
    expect(bootstrap.statusCode).toBe(200)
    expect(bootstrap.json()).toMatchObject({
      generationOperationProtocol: { version: 1 },
      generationOperationProjectionEpoch: expect.any(Number),
      activeGenerationJobs: [],
      generationOperations: expect.arrayContaining([
        expect.objectContaining({
          operationId: 'dispatched',
          state: 'abandoned',
          recoveryDisposition: 'retryable',
          failureCode: 'server_restarted',
          providerMayHaveRun: true,
        }),
        expect.objectContaining({ operationId: 'journal', state: 'finalizing' }),
        expect.objectContaining({
          operationId: 'stopping',
          state: 'abandoned',
          recoveryDisposition: 'retryable',
          failureCode: 'server_restarted',
        }),
        expect.objectContaining({
          operationId: 'persisted-result',
          state: 'completed',
          resultMessageId: 'assistant-persisted-result',
        }),
      ]),
    })
  })
})
