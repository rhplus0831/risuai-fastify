import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openDatabase, getSchemaState, CURRENT_SCHEMA_VERSION } from '../src/db.js'
import {
  DisplayModuleBodyCache,
  fingerprintDisplayModule,
  getDisplayModuleVersion,
  readDisplayModules,
} from '../src/displayModuleCache.js'
import { DisplaySourceDiagnostics } from '../src/displaySourceDiagnostics.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'display-modules-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const db = openDatabase(dir)
  cleanups.push(() => db.close())
  const write = (position: number, value: unknown) =>
    db
      .prepare('INSERT OR REPLACE INTO modules (position, data_json) VALUES (?, ?)')
      .run(position, JSON.stringify(value))
  return { db, dir, write }
}
const module = (id = 'module', output = 'after') => ({
  id,
  namespace: 'namespace',
  assets: [['asset', 'path', 'png']],
  regex: [{ in: 'before', out: output, type: 'editdisplay', flag: '' }],
  trigger: [{ effect: [{ type: 'setvar', value: '1' }] }],
})

it('reuses frozen selected bodies and digests across chat-only revisions without reading/parsing JSON', () => {
  const { db, write } = fixture()
  write(0, module())
  const cold = new DisplaySourceDiagnostics(1, 0, 0)
  const [first] = readDisplayModules(db, ['module'], cold)
  const digest = fingerprintDisplayModule(first!, cold)
  db.exec('UPDATE schema_version SET revision = revision + 1')
  db.exec("INSERT INTO settings (id, data_json) VALUES (1, '{}')")
  const warm = new DisplaySourceDiagnostics(1, 0, 0)
  const [second] = readDisplayModules(db, ['namespace'], warm)
  expect(second).toBe(first)
  expect(fingerprintDisplayModule(second!, warm)).toBe(digest)
  expect(warm.preparation).toMatchObject({ moduleBodyCacheHitCount: 1, moduleDigestCacheHitCount: 1 })
  expect(warm.preparation.loads?.modules?.jsonValues).toBeUndefined()
  expect(warm.preparation.loads?.modules?.parseMs).toBeUndefined()
  expect(warm.preparation.moduleSerializeMs).toBeUndefined()
  expect(cold.preparation.loads?.modules?.jsonValues).toBe(1)
  expect(() => ((second!.assets as string[][])[0]![0] = 'mutated')).toThrow()
  expect(() => ((second!.trigger as { effect: { value: string }[] }[])[0]!.effect[0]!.value = 'mutated')).toThrow()
})

it('invalidates direct SQL writes on either connection, collection replacement, and rollback without token ABA', () => {
  const { db, dir, write } = fixture()
  write(0, module())
  const read = () => readDisplayModules(db, ['namespace'])
  const [first] = read()
  const digest = fingerprintDisplayModule(first!)
  const other = openDatabase(dir)
  cleanups.push(() => other.close())
  other.exec(`UPDATE modules SET data_json = json_set(data_json, '$.regex[0].out', 'changed')`)
  const [changed] = read()
  expect(changed).not.toBe(first)
  expect(fingerprintDisplayModule(changed!)).not.toBe(digest)
  const committedVersion = getDisplayModuleVersion(db)
  db.exec('BEGIN')
  write(0, module('module', 'uncommitted'))
  const rolledBackVersion = getDisplayModuleVersion(db)
  const [uncommitted] = read()
  db.exec('ROLLBACK')
  expect(getDisplayModuleVersion(db)).toBe(committedVersion)
  expect(read()[0]).toEqual(changed)
  write(0, module('module', 'committed'))
  expect(getDisplayModuleVersion(db)).not.toBe(rolledBackVersion)
  expect(read()[0]).not.toEqual(uncommitted)
  db.exec('DELETE FROM modules')
  expect(read()).toEqual([])
  write(0, module('replacement'))
  expect(read()[0]?.id).toBe('replacement')
})

it('preserves position ordering, duplicate rows, namespace activation, and mutable legacy digest correctness', () => {
  const { db, write } = fixture()
  write(4, module('duplicate', 'later'))
  write(1, module('duplicate', 'first'))
  write(2, { id: 'inactive', regex: 'incompatible' })
  const rows = readDisplayModules(db, ['duplicate', 'namespace'])
  expect(rows.map((row) => (row.regex as { out: string }[])[0]!.out)).toEqual(['first', 'later'])
  expect(readDisplayModules(db, ['absent'])).toEqual([])
  const legacy = module()
  const before = fingerprintDisplayModule(legacy)
  legacy.regex[0]!.out = 'new'
  expect(fingerprintDisplayModule(legacy)).not.toBe(before)
})

it('bounds retained bodies, evicts least recently used entries, and rejects retired admissions', () => {
  const cache = new DisplayModuleBodyCache(1024, 2)
  cache.activate('a')
  expect(cache.put('a', 1, { id: 'a' }, 10)).toBe(true)
  expect(cache.put('a', 2, { id: 'b' }, 10)).toBe(true)
  cache.get(1)
  cache.put('a', 3, { id: 'c' }, 10)
  expect(cache.get(2)).toBeUndefined()
  expect(cache.stats().entries).toBe(2)
  expect(cache.stats().chargedBytes).toBeLessThanOrEqual(1024)
  expect(cache.put('a', 4, { assets: ['large'] }, 1024)).toBe(false)
  cache.activate('b')
  expect(cache.get(1)).toBeUndefined()
  expect(cache.put('a', 5, { id: 'stale' }, 10)).toBe(false)
  expect(cache.stats()).toEqual({ entries: 0, chargedBytes: 0 })
})

it('migrates v38 module content tracking without changing domain revision or module JSON', () => {
  const { db, dir, write } = fixture()
  write(0, module())
  for (const name of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER display_modules_${name}`)
  db.exec('ALTER TABLE database_metadata DROP COLUMN module_content_version')
  db.exec('UPDATE schema_version SET version = 38, revision = 123')
  const migrated = openDatabase(dir)
  cleanups.push(() => migrated.close())
  expect(getSchemaState(migrated)).toEqual({ version: CURRENT_SCHEMA_VERSION, revision: 123 })
  expect(readDisplayModules(migrated, ['module'])).toEqual([module()])
  const version = getDisplayModuleVersion(migrated)
  db.exec('UPDATE modules SET data_json = data_json')
  expect(getDisplayModuleVersion(migrated)).not.toBe(version)
})
