/** @module-tag core */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import { MissingDatabaseRefusalError, openDatabase } from '../src/db.js'

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-missing-database-'))
  dataDirs.push(dataDir)
  return dataDir
}

function appConfig(dataDir: string, allowMissingDatabase = false): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    allowMissingDatabase,
    bodyLimit: 1024 * 1024,
    importMaxBytes: Infinity,
    trustProxy: false,
    staticRoot: null,
    hubUrl: 'https://sv.risuai.xyz',
  }
}

const evidenceCases: Array<{
  label: string
  expected: string
  create: (dataDir: string) => void
}> = [
  {
    label: 'a migrated legacy database marker',
    expected: 'db.json.migrated',
    create: (dataDir) => writeFileSync(path.join(dataDir, 'db.json.migrated'), 'migrated'),
  },
  {
    label: 'an invalid legacy database marker',
    expected: 'db.json.invalid',
    create: (dataDir) => writeFileSync(path.join(dataDir, 'db.json.invalid'), 'invalid'),
  },
  {
    label: 'a numbered invalid legacy database marker',
    expected: 'db.json.invalid.2',
    create: (dataDir) => writeFileSync(path.join(dataDir, 'db.json.invalid.2'), 'invalid'),
  },
  ...(['backups', 'assets', 'save'] as const).map((directory) => ({
    label: `a non-empty ${directory} directory`,
    expected: `${directory}/`,
    create: (dataDir: string) => {
      mkdirSync(path.join(dataDir, directory))
      writeFileSync(path.join(dataDir, directory, 'evidence'), 'prior use')
    },
  })),
  {
    label: 'a password auth file',
    expected: '__password',
    create: (dataDir) => writeFileSync(path.join(dataDir, '__password'), 'auth'),
  },
]

afterEach(() => {
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

describe.each(evidenceCases)('missing database guard: $label', ({ create, expected }) => {
  it('makes openDatabase refuse before creating any database files', () => {
    const dataDir = makeDataDir()
    create(dataDir)
    const entriesBefore = readdirSync(dataDir, { recursive: true }).sort()
    const databasePath = path.join(dataDir, 'risu.db')

    let error: unknown
    try {
      openDatabase(dataDir)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(MissingDatabaseRefusalError)
    expect((error as Error).message).toContain(expected)
    expect((error as Error).message).toContain(databasePath)
    expect((error as Error).message).toContain('Restore')
    expect((error as Error).message).toContain('RISU_API_ALLOW_MISSING_DATABASE=1')
    expect(existsSync(databasePath)).toBe(false)
    expect(readdirSync(dataDir, { recursive: true }).sort()).toEqual(entriesBefore)
  })

  it('makes buildApp refuse through the same database boundary', async () => {
    const dataDir = makeDataDir()
    create(dataDir)
    const entriesBefore = readdirSync(dataDir, { recursive: true }).sort()
    const databasePath = path.join(dataDir, 'risu.db')

    await expect(
      buildApp({
        config: appConfig(dataDir),
        memoryWorker: false,
        assetGc: false,
      }),
    ).rejects.toThrow(expected)

    expect(existsSync(databasePath)).toBe(false)
    expect(readdirSync(dataDir, { recursive: true }).sort()).toEqual(entriesBefore)
  })
})

describe('missing database guard exceptions', () => {
  it('allows an explicitly approved fresh start despite prior-install evidence', async () => {
    const dataDir = makeDataDir()
    mkdirSync(path.join(dataDir, 'assets'))
    writeFileSync(path.join(dataDir, 'assets', 'orphaned-asset'), 'prior use')

    const { app } = await buildApp({
      config: appConfig(dataDir, true),
      memoryWorker: false,
      assetGc: false,
    })
    try {
      expect(existsSync(path.join(dataDir, 'risu.db'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('boots normally with a genuinely new data directory and ignores empty evidence directories', async () => {
    const parentDir = makeDataDir()
    const dataDir = path.join(parentDir, 'new-data')
    mkdirSync(path.join(dataDir, 'backups'), { recursive: true })
    mkdirSync(path.join(dataDir, 'assets'))
    mkdirSync(path.join(dataDir, 'save'))

    const { app } = await buildApp({
      config: appConfig(dataDir),
      memoryWorker: false,
      assetGc: false,
    })
    try {
      expect(existsSync(path.join(dataDir, 'risu.db'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('creates a genuinely missing data directory normally', async () => {
    const parentDir = makeDataDir()
    const dataDir = path.join(parentDir, 'missing-data')

    const { app } = await buildApp({
      config: appConfig(dataDir),
      memoryWorker: false,
      assetGc: false,
    })
    try {
      expect(existsSync(path.join(dataDir, 'risu.db'))).toBe(true)
    } finally {
      await app.close()
    }
  })
})
