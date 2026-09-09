import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { normalizeDisplayDependencyValue } from '@risuai/protocol/display-source'
import {
  parseDisplaySourceJson,
  readDisplaySourceData,
  type DisplaySourceDiagnostics,
} from './displaySourceDiagnostics.js'

type ModuleRecord = Record<string, unknown>

/** Live metadata, deliberately excluded from backup table replacement. Random
 * tokens also prevent ABA when a transaction populates the cache then rolls back.
 */
export function createDisplayModuleVersioning(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(database_metadata)').all()
  if (!columns.some((column) => column.name === 'module_content_version')) {
    db.exec("ALTER TABLE database_metadata ADD COLUMN module_content_version TEXT NOT NULL DEFAULT ''")
  }
  db.exec(`
    UPDATE database_metadata SET module_content_version = lower(hex(randomblob(16)))
    WHERE module_content_version = '';
  `)
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS display_modules_${operation.toLowerCase()}
      AFTER ${operation} ON modules BEGIN
        UPDATE database_metadata SET module_content_version = lower(hex(randomblob(16))) WHERE id = 1;
      END;
    `)
  }
}

export function getDisplayModuleVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT module_content_version FROM database_metadata WHERE id = 1').get()
  if (typeof row?.module_content_version !== 'string' || !row.module_content_version) {
    throw new Error('database module content version is missing')
  }
  return row.module_content_version
}

/** Only graphs admitted here may carry a reusable digest. Freezing just the
 * root is insufficient: asset tuples, regexes and trigger effects are shared.
 */
const immutableModules = new WeakSet<object>()
const moduleDigests = new WeakMap<object, string>()

function freezeModule(value: ModuleRecord): number {
  const pending: object[] = [value]
  let nodes = 0
  while (pending.length) {
    const node = pending.pop()!
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') pending.push(child)
    }
    Object.freeze(node)
    nodes++
  }
  immutableModules.add(value)
  return nodes
}

export class DisplayModuleBodyCache {
  private version: string | undefined
  private readonly entries = new Map<number, { value: ModuleRecord; charge: number }>()
  private bytes = 0

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntries = 256,
  ) {}

  activate(version: string): void {
    if (this.version === version) return
    this.version = version
    this.entries.clear()
    this.bytes = 0
  }

  get(position: number): ModuleRecord | undefined {
    const entry = this.entries.get(position)
    if (!entry) return undefined
    this.entries.delete(position)
    this.entries.set(position, entry)
    return entry.value
  }

  put(version: string, position: number, value: ModuleRecord, jsonLength: number): boolean {
    if (version !== this.version || this.maxEntries < 1 || jsonLength * 4 > this.maxBytes) return false
    // A conservative charge, not a V8 heap measurement: allow for UTF-16 strings,
    // property storage and each array/object. Do not retain the serialized JSON.
    const charge = jsonLength * 4 + freezeModule(value) * 64
    if (charge > this.maxBytes) return false
    const previous = this.entries.get(position)
    if (previous) {
      this.bytes -= previous.charge
      this.entries.delete(position)
    }
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + charge > this.maxBytes)) {
      const key = this.entries.keys().next().value!
      this.bytes -= this.entries.get(key)!.charge
      this.entries.delete(key)
    }
    this.entries.set(position, { value, charge })
    this.bytes += charge
    return true
  }

  stats(): { entries: number; chargedBytes: number } {
    return { entries: this.entries.size, chargedBytes: this.bytes }
  }
}

const bodyCaches = new WeakMap<DatabaseSync, DisplayModuleBodyCache>()

/** Display-only: generation continues to load private, mutable module bodies.
 * Query indexed positions first so a warm hit never materializes the large JSON.
 */
export function readDisplayModules(
  db: DatabaseSync,
  identifiers: readonly string[],
  diagnostics?: DisplaySourceDiagnostics,
): ModuleRecord[] {
  if (!identifiers.length) return []
  const measurement = diagnostics?.load('modules')
  const version = readDisplaySourceData(measurement, () => getDisplayModuleVersion(db))
  let cache = bodyCaches.get(db)
  if (!cache) bodyCaches.set(db, (cache = new DisplayModuleBodyCache()))
  cache.activate(version)
  const selection = JSON.stringify(identifiers)
  const rows = readDisplaySourceData(measurement, () =>
    db
      .prepare(
        `
    SELECT position FROM modules
    WHERE json_extract(data_json, '$.id') IN (SELECT value FROM json_each(?))
       OR json_extract(data_json, '$.namespace') IN (SELECT value FROM json_each(?))
    ORDER BY position
  `,
      )
      .all(selection, selection),
  )
  const readBody = db.prepare('SELECT data_json FROM modules WHERE position = ?')
  const result: ModuleRecord[] = []
  for (const row of rows) {
    const position = row.position as number
    const hit = cache.get(position)
    diagnostics?.incrementPreparation(hit ? 'moduleBodyCacheHitCount' : 'moduleBodyCacheMissCount')
    if (hit) {
      result.push(hit)
      continue
    }
    const json = readDisplaySourceData(measurement, () => readBody.get(position)?.data_json)
    if (typeof json !== 'string') continue
    const value = parseDisplaySourceJson(json, measurement)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const module = value as ModuleRecord
    const admit = () => cache!.put(version, position, module, json.length)
    const cached = diagnostics ? diagnostics.measurePreparation('moduleFreezeMs', admit) : admit()
    if (!cached) diagnostics?.incrementPreparation('moduleBodyCacheBypassCount')
    result.push(module)
  }
  // Another SQLite handle can commit during synchronous reads. Retire anything
  // loaded across that boundary; the service also fences every streamed result.
  const current = readDisplaySourceData(measurement, () => getDisplayModuleVersion(db))
  if (current !== version) cache.activate(current)
  return result
}

export function fingerprintDisplayModule(module: object, diagnostics?: DisplaySourceDiagnostics): string {
  const cached = moduleDigests.get(module)
  diagnostics?.incrementPreparation(cached ? 'moduleDigestCacheHitCount' : 'moduleDigestCacheMissCount')
  if (cached) return cached
  const fields = module as ModuleRecord
  const value = {
    assets: fields.assets,
    id: fields.id,
    customModuleToggle: fields.customModuleToggle,
    lowLevelAccess: fields.lowLevelAccess,
    namespace: fields.namespace,
    regex: fields.regex,
    trigger: fields.trigger,
  }
  const normalize = () => normalizeDisplayDependencyValue(value)
  const normalized = diagnostics ? diagnostics.measurePreparation('moduleNormalizeMs', normalize) : normalize()
  const serialize = () => JSON.stringify(normalized) ?? 'null'
  const json = diagnostics ? diagnostics.measurePreparation('moduleSerializeMs', serialize) : serialize()
  const hash = () => createHash('sha256').update(json).digest('hex')
  const digest = diagnostics ? diagnostics.measurePreparation('moduleHashMs', hash) : hash()
  if (immutableModules.has(module)) moduleDigests.set(module, digest)
  return digest
}
