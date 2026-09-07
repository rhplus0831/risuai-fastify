import { expect, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp, type BuildAppOptions } from '../src/app.js'
import { normalizeRisuSaveSnapshotDatabase } from '../src/risuSave/importSnapshot.js'
import { setupBrowserSmokeAuth } from './auth.js'

export const OBSERVER_SHELL_OVERRIDE_KEY = 'risu:fast-bootstrap-observer-shell'

export type ObserverShellMode = 'disabled' | 'enabled'

export interface FastBootstrapHarness {
  app: FastifyInstance
  assertion: string
  baseUrl: string
  dataDir: string
}

export async function startFastBootstrapHarness(
  database: Record<string, unknown>,
  options: {
    temporaryDirectoryPrefix?: string
    /** Default to an unowned API import; explicit modes retain owned/migration/empty producers. */
    databaseSeedMode?: 'unowned-import' | 'writer-import' | 'unowned-migration' | 'empty'
    generationChat?: BuildAppOptions['generationChat']
  } = {},
): Promise<FastBootstrapHarness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), options.temporaryDirectoryPrefix ?? 'risu-fast-bootstrap-matrix-'),
  )
  const databaseSeedMode = options.databaseSeedMode ?? 'unowned-import'
  if (databaseSeedMode === 'unowned-migration') {
    fs.writeFileSync(
      path.join(dataDir, 'db.json'),
      JSON.stringify({ _version: 1, database: normalizeRisuSaveSnapshotDatabase(database), assets: [] }),
    )
  }
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
      staticRoot: path.resolve('dist'),
      requestTrace: { mode: 'agent' },
    },
    assetGc: false,
    memoryWorker: false,
    generationChat: options.generationChat,
  })

  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fast-bootstrap browser harness did not bind to a TCP port')
    }
    const assertion = await setupBrowserSmokeAuth(app)
    if (databaseSeedMode === 'unowned-migration' || databaseSeedMode === 'empty') {
      const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
      try {
        expect(
          db.prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1').get(),
        ).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
        if (databaseSeedMode === 'unowned-migration') {
          expect(fs.existsSync(path.join(dataDir, 'db.json.migrated'))).toBe(true)
        } else {
          expect(db.prepare('SELECT data_json FROM settings WHERE id = 1').get()).toBeUndefined()
          expect(db.prepare('SELECT revision FROM schema_version WHERE id = 1').get()).toMatchObject({ revision: 0 })
          expect(
            db.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get(),
          ).toMatchObject({ epoch: 0 })
          const tables = db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('database_metadata', 'generation_operation_projection_state', 'schema_version') ORDER BY name",
            )
            .all() as Array<{ name: string }>
          for (const { name } of tables) {
            expect(
              db.prepare(`SELECT COUNT(*) AS rows FROM "${name.replaceAll('"', '""')}"`).get(),
              `${name} starts empty`,
            ).toMatchObject({ rows: 0 })
          }
          expect(fs.existsSync(path.join(dataDir, 'db.json'))).toBe(false)
          expect(fs.existsSync(path.join(dataDir, 'db.json.migrated'))).toBe(false)
        }
      } finally {
        db.close()
      }
    } else {
      await importFastBootstrapDatabase(app, assertion, database, { mode: databaseSeedMode, dataDir })
    }
    return { app, assertion, baseUrl: `http://127.0.0.1:${address.port}`, dataDir }
  } catch (error) {
    await app.close().catch(() => undefined)
    fs.rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

export async function closeFastBootstrapHarness(harness: FastBootstrapHarness): Promise<void> {
  await harness.app.close().catch(() => undefined)
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
}

export async function importFastBootstrapDatabase(
  app: FastifyInstance,
  assertion: string,
  database: Record<string, unknown>,
  options: { mode?: 'unowned-import' | 'writer-import'; dataDir?: string } = {},
): Promise<void> {
  // Authenticated imports are supported before the first writer is acquired.
  // Keep that API producer without inventing a foreign owner for the browser.
  // Re-seeding is allowed only while the harness is still actually unowned.
  const writerSession = options.mode === 'writer-import' ? `fast-bootstrap-import-${randomUUID()}` : undefined
  if (writerSession) {
    const registered = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
    })
    expect(registered.statusCode).toBe(200)
  } else {
    await expectUnownedImportFixture(app, assertion, options.dataDir)
  }
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion, ...(writerSession ? { 'risu-writer-session': writerSession } : {}) },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
  if (!writerSession) await expectUnownedImportFixture(app, assertion, options.dataDir)
}

async function expectUnownedImportFixture(app: FastifyInstance, assertion: string, dataDir?: string): Promise<void> {
  const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
  expect(bootstrap.statusCode).toBe(200)
  expect(bootstrap.json().writer, 'unowned fixture imports must not acquire or replace a writer').toEqual({
    sessionId: null,
    epoch: 0,
  })
  if (!dataDir) return
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
  try {
    expect(
      db.prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1').get(),
    ).toMatchObject({
      active_writer_session_id: null,
      writer_epoch: 0,
    })
  } finally {
    db.close()
  }
}

export async function setObserverShellMode(context: BrowserContext, mode: ObserverShellMode): Promise<void> {
  await context.addInitScript(
    ({ key, value }) => {
      try {
        sessionStorage.setItem(key, value)
      } catch {}
    },
    { key: OBSERVER_SHELL_OVERRIDE_KEY, value: mode },
  )
}

export function smallFastBootstrapFixture(): Record<string, unknown> {
  return {
    version: 1,
    didFirstSetup: true,
    formatversion: 5,
    currentChar: 0,
    characterOrder: ['fast-bootstrap-small-character'],
    characters: [
      {
        chaId: 'fast-bootstrap-small-character',
        type: 'character',
        name: 'Fast Bootstrap Small Character',
        chats: [
          {
            id: 'fast-bootstrap-small-chat',
            name: 'Fast Bootstrap Small Chat',
            note: '',
            localLore: [],
            message: [],
          },
        ],
        chatPage: 0,
        customscript: [],
        firstMessage: '',
        globalLore: [],
        viewScreen: 'none',
        emotionImages: [],
      },
    ],
    botPresets: [],
    loadouts: [],
    modules: [],
    personas: [],
    plugins: [],
    pluginCustomStorage: {},
    language: 'en',
  }
}
