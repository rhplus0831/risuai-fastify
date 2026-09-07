import { expect, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
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
    /** Migrate an initialized fixture before app startup without installing a temporary writer. */
    databaseSeedMode?: 'writer-import' | 'unowned-migration'
  } = {},
): Promise<FastBootstrapHarness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), options.temporaryDirectoryPrefix ?? 'risu-fast-bootstrap-matrix-'),
  )
  if (options.databaseSeedMode === 'unowned-migration') {
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
  })

  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Fast-bootstrap browser harness did not bind to a TCP port')
    }
    const assertion = await setupBrowserSmokeAuth(app)
    if (options.databaseSeedMode === 'unowned-migration') {
      const db = new DatabaseSync(path.join(dataDir, 'risu.db'), { readOnly: true })
      try {
        expect(
          db.prepare('SELECT active_writer_session_id, writer_epoch FROM database_metadata WHERE id = 1').get(),
        ).toMatchObject({ active_writer_session_id: null, writer_epoch: 0 })
        expect(fs.existsSync(path.join(dataDir, 'db.json.migrated'))).toBe(true)
      } finally {
        db.close()
      }
    } else {
      await importFastBootstrapDatabase(app, assertion, database)
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
): Promise<void> {
  const writerSession = `fast-bootstrap-import-${randomUUID()}`
  const registered = await app.inject({
    method: 'GET',
    url: '/api/v1/bootstrap',
    headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
  })
  expect(registered.statusCode).toBe(200)
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion, 'risu-writer-session': writerSession },
    payload: { database },
  })
  expect(imported.statusCode).toBe(200)
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
