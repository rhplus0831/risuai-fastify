/** @module-tag core */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { setupAuthedClient } from './helpers/auth.js'

interface Harness {
  app: FastifyInstance
  assertion: string
  dataDir: string
}

let harness: Harness

beforeEach(async () => {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-state-initialize-race-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Number.POSITIVE_INFINITY,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    assetGc: false,
    bardWikiWorker: false,
    memoryWorker: false,
  })
  const { assertion } = await setupAuthedClient(app)
  harness = { app, assertion, dataDir }
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

it('serializes concurrent first-run initialization into one canonical database', async () => {
  const request = () =>
    harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/state/initialize',
      headers: { 'risu-auth': harness.assertion },
      payload: {},
    })
  const responses = await Promise.all([request(), request()])
  expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200])
  const results = responses.map((response) => response.json<{ initialized: boolean; revision: number }>())
  expect(results.map(({ initialized }) => initialized).sort()).toEqual([false, true])
  expect(results.map(({ revision }) => revision)).toEqual([1, 1])

  const headers = { 'risu-auth': harness.assertion }
  const [bootstrap, characters] = await Promise.all([
    harness.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers }),
    harness.app.inject({ method: 'GET', url: '/api/v1/characters', headers }),
  ])
  expect(bootstrap.statusCode).toBe(200)
  expect(characters.statusCode).toBe(200)
  const bootstrapBody = bootstrap.json<{ initialized: boolean; revision: number; databaseLineage: string }>()
  const characterBody = characters.json<{
    revision: number
    characters: Array<{ id?: string; chaId?: string }>
  }>()
  expect(bootstrapBody).toMatchObject({ initialized: true, revision: 1 })
  expect(characterBody.revision).toBe(1)
  const characterIds = characterBody.characters.map(characterId)

  const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'), { readOnly: true })
  try {
    expect(db.prepare('SELECT COUNT(*) AS count FROM settings').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM database_metadata').get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_events WHERE type = 'state.initialized'").get()).toEqual({
      count: 1,
    })
    expect(
      (db.prepare('SELECT id FROM characters ORDER BY position').all() as Array<{ id: string }>).map(({ id }) => id),
    ).toEqual(characterIds)
    expect(db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get()).toEqual({
      lineage: bootstrapBody.databaseLineage,
    })
  } finally {
    db.close()
  }
})

function characterId(character: { id?: string; chaId?: string }): string {
  const id = character.chaId ?? character.id
  if (!id) throw new Error('Canonical character is missing its id')
  return id
}
