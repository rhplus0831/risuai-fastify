import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { DatabaseSync } from 'node:sqlite'
import { buildApp } from '../src/app.js'
import { setupAuthedClient } from './helpers/auth.js'
import { assertCommandMetricGate, type CommandMutationMetric } from './helpers/commandMetricGates.js'

// Cross-owner module deletion remains broader than the single-owner collection
// paths: it must remove the module definition and every persisted reference
// without falling back to the historical full-database rewrite.

interface Harness {
  app: FastifyInstance
  dataDir: string
}

const PREVIOUS_PROTOCOL_METRICS = process.env.RISU_PROTOCOL_METRICS

let harness: Harness
let assertion: string
let infoSpy: ReturnType<typeof vi.spyOn>
let metrics: CommandMutationMetric[]

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-phase6-ceiling-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    assetGc: false,
    memoryWorker: false,
  })
  return { app, dataDir }
}

function seedDatabase(): Record<string, unknown> {
  return {
    currentChar: 0,
    theme: 'dark',
    characterOrder: ['char-a', 'char-b'],
    enabledModules: ['mod-x'],
    modules: [
      { id: 'mod-x', name: 'Module X' },
      { id: 'mod-y', name: 'Module Y' },
    ],
    loadouts: [{ id: 'loadout-a', name: 'Loadout A', modules: ['mod-x', 'mod-y'] }],
    characters: [
      {
        type: 'character',
        chaId: 'char-a',
        name: 'A',
        chatPage: 0,
        globalLore: [],
        modules: ['mod-x'],
        chats: [
          {
            id: 'chat-a-1',
            name: 'A1',
            modules: ['mod-x'],
            localLore: [],
            message: [{ role: 'user', data: 'hello a1', chatId: 'msg-a-1' }],
          },
          { id: 'chat-a-2', name: 'A2', localLore: [], message: [] },
        ],
      },
      {
        type: 'character',
        chaId: 'char-b',
        name: 'B',
        chatPage: 0,
        globalLore: [],
        chats: [
          {
            id: 'chat-b-1',
            name: 'B1',
            localLore: [],
            message: [{ role: 'user', data: 'hello b1', chatId: 'shared-msg' }],
          },
        ],
      },
    ],
  }
}

async function importDatabase(database: unknown): Promise<number> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database },
  })
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  return (res.json() as { revision: number }).revision
}

interface CommandRequest {
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT'
  url: string
  headers?: Record<string, string>
  payload?: unknown
}

interface CommandResponse {
  statusCode: number
  json(): unknown
}

function inject(request: CommandRequest): Promise<CommandResponse> {
  const fn = harness.app.inject as unknown as (request: CommandRequest) => Promise<CommandResponse>
  return fn({ ...request, headers: { 'risu-auth': assertion, ...(request.headers ?? {}) } })
}

async function runCommand(
  request: CommandRequest,
): Promise<{ revision: number; metric: CommandMutationMetric; body: Record<string, unknown> }> {
  const before = metrics.length
  const res = await inject(request)
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200)
  const body = res.json() as Record<string, unknown>
  const metric = metrics.slice(before).find((entry) => entry.metric === 'command_mutation' && entry.status === 'ok')
  expect(metric, `missing command_mutation metric for ${request.url}`).toBeTruthy()
  return { revision: body.revision as number, metric: metric as CommandMutationMetric, body }
}

function readSettings(): Record<string, unknown> {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

function readCharacter(id: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? (JSON.parse(row.data_json) as Record<string, unknown>) : {}
  } finally {
    db.close()
  }
}

function readChat(id: string): Record<string, unknown> {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(id) as {
      data_json: string
    }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

function readCollection(table: string): unknown[] {
  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
  try {
    const rows = db.prepare(`SELECT data_json FROM ${table} ORDER BY position`).all() as Array<{
      data_json: string
    }>
    return rows.map((r) => JSON.parse(r.data_json))
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  process.env.RISU_PROTOCOL_METRICS = '1'
  metrics = []
  infoSpy = vi.spyOn(console, 'info').mockImplementation((message: unknown) => {
    if (typeof message !== 'string' || !message.startsWith('[protocol-metric] ')) return
    metrics.push(JSON.parse(message.slice('[protocol-metric] '.length)) as CommandMutationMetric)
  })
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
})

afterEach(async () => {
  infoSpy.mockRestore()
  if (PREVIOUS_PROTOCOL_METRICS === undefined) {
    delete process.env.RISU_PROTOCOL_METRICS
  } else {
    process.env.RISU_PROTOCOL_METRICS = PREVIOUS_PROTOCOL_METRICS
  }
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

describe('cross-owner module deletion', () => {
  it('DELETE modules/:id uses targeted collection writes and strips references across every table', async () => {
    const revision = await importDatabase(seedDatabase())

    const { metric } = await runCommand({
      method: 'DELETE',
      url: '/api/v1/commands/modules/mod-x',
      payload: { baseRevision: revision },
    })

    // `removeModuleReferences` now discovers the broad reference set once but
    // persists only the changed settings, collection, character, and chat rows.
    expect(metric.mutationPath).toBe('targeted-cross-owner')
    assertCommandMetricGate(metric)
    expect(readSettings().enabledModules).toEqual([])
    expect(readCharacter('char-a').modules).toEqual([])
    expect(readChat('chat-a-1').modules).toEqual([])
    expect((readCollection('loadouts')[0] as { modules: string[] }).modules).toEqual(['mod-y'])
    expect((readCollection('modules') as Array<{ id: string }>).map((m) => m.id)).toEqual(['mod-y'])
  })
})
