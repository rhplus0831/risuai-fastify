import { expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { createCommandEventSink, type CommandEventSink } from '../../src/commands/events.js'
import { openDatabase } from '../../src/db.js'
import { loadPersisted } from '../../src/repository.js'

export interface Harness {
  app: FastifyInstance
  dataDir: string
  commandEvents: CommandEventSink
}

export function readAllDatabaseRows(dataDir: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string
    }>
    return Object.fromEntries(
      tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as unknown[]]),
    )
  } finally {
    db.close()
  }
}

export async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-commands-'))
  const commandEvents = createCommandEventSink()
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    commandEvents,
  })
  return { app, dataDir, commandEvents }
}

export async function stopHarness(h: Harness): Promise<void> {
  await h.app.close()
  rmSync(h.dataDir, { recursive: true, force: true })
}

/** Open a temporary db handle, call loadPersisted, close the handle. */
export function loadPersistedFromDir(dataDir: string) {
  const db = openDatabase(dataDir)
  try {
    return loadPersisted(db, dataDir)
  } finally {
    db.close()
  }
}

export async function importDatabase(
  app: FastifyInstance,
  assertion: string,
  database: Record<string, unknown>,
): Promise<number> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    // Minimal fixtures need one recognized core key to pass the
    // risusave_empty_database import guard.
    payload: { database: { characters: [], ...database } },
  })
  expect(imported.statusCode).toBe(200)
  return imported.json().revision as number
}

type JsonRowTable = 'characters' | 'chats' | 'modules'

export function readJsonRow(dataDir: string, table: JsonRowTable, id: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    if (table === 'modules') {
      const rows = db.prepare('SELECT data_json FROM modules ORDER BY position').all() as Array<{
        data_json: string
      }>
      const row = rows
        .map((candidate) => JSON.parse(candidate.data_json) as Record<string, unknown>)
        .find((candidate) => candidate.id === id)
      expect(row, `modules row ${id} should exist`).toBeTruthy()
      return row!
    }
    const row = db.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(id) as { data_json: string } | undefined
    expect(row, `${table} row ${id} should exist`).toBeTruthy()
    return JSON.parse(row!.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

export function writeJsonRow(dataDir: string, table: JsonRowTable, id: string, value: Record<string, unknown>): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    if (table === 'modules') {
      const rows = db.prepare('SELECT position, data_json FROM modules ORDER BY position').all() as Array<{
        position: number
        data_json: string
      }>
      const row = rows.find((candidate) => (JSON.parse(candidate.data_json) as Record<string, unknown>).id === id)
      expect(row, `modules row ${id} should exist`).toBeTruthy()
      db.prepare('UPDATE modules SET data_json = ? WHERE position = ?').run(JSON.stringify(value), row!.position)
      return
    }
    db.prepare(`UPDATE ${table} SET data_json = ? WHERE id = ?`).run(JSON.stringify(value), id)
  } finally {
    db.close()
  }
}

export function updateSettingsRow(dataDir: string, mutator: (settings: Record<string, unknown>) => void): void {
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    const settings = JSON.parse(row.data_json) as Record<string, unknown>
    mutator(settings)
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
  } finally {
    db.close()
  }
}

// The bootstrap ships chat stubs; read persisted messages via per-chat hydration.
export async function persistedChatMessages(
  app: FastifyInstance,
  assertion: string,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().message as Array<Record<string, unknown>>
}

export async function projectedCharacterRow(
  app: FastifyInstance,
  assertion: string,
  characterId: string,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/characters/${encodeURIComponent(characterId)}`,
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  return res.json().character as Record<string, unknown>
}

export async function uploadAsset(
  app: FastifyInstance,
  assertion: string,
  bytes = Buffer.from('asset-bytes'),
  contentType = 'image/png',
): Promise<{ assetId: string; revision: number }> {
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: {
      'risu-auth': assertion,
      'content-type': contentType,
    },
    payload: bytes,
  })
  expect(uploaded.statusCode).toBe(201)
  return uploaded.json() as { assetId: string; revision: number }
}
