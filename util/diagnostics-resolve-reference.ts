import { createHash, createHmac } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { DIAGNOSTIC_REFERENCE_KINDS, type DiagnosticReferenceKind } from '@risuai/protocol/remote-diagnostics'

// Same stable-file staging/backup approach as generation-rejection-replay.
// SQLite never receives a path in the operator's data directory.
async function snapshot(sourceFile: string, destination: string) {
  if (!fs.existsSync(sourceFile)) throw new Error('source_database_missing')
  sourceFile = fs.realpathSync(sourceFile)
  // Even a readOnly SQLite connection can create/write source WAL/SHM files.
  // Never give SQLite the original path. First stage DB + WAL/rollback journal
  // using file reads, accepting only an unchanged interval across the whole copy.
  // SQLite recovers the private staged image, then backup() produces the replay DB.
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), 'backup-input-'))
  const staged = path.join(staging, 'source.db')
  const suffixes = ['', '-wal', '-journal']
  const stamps = () =>
    suffixes.map((suffix) => {
      const stat = fs.statSync(sourceFile + suffix, { bigint: true, throwIfNoEntry: false })
      if (!stat) return null
      if (!stat.isFile()) throw new Error('snapshot_source_not_file')
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
    })
  try {
    let stable = false
    for (let attempt = 0; attempt < 3 && !stable; attempt++) {
      for (const suffix of suffixes) fs.rmSync(staged + suffix, { force: true })
      const before = stamps()
      if (!before[0]) throw new Error('source_database_missing')
      try {
        for (const [index, suffix] of suffixes.entries()) {
          if (before[index] !== null) {
            fs.copyFileSync(sourceFile + suffix, staged + suffix, fs.constants.COPYFILE_FICLONE)
            fs.chmodSync(staged + suffix, 0o600)
          }
        }
      } catch (error) {
        if (JSON.stringify(before) !== JSON.stringify(stamps())) continue
        throw error
      }
      stable = JSON.stringify(before) === JSON.stringify(stamps())
    }
    if (!stable) throw new Error('source_changed_during_snapshot')
    // No original SHM is needed: the private WAL index is rebuilt here. Recovery
    // and any checkpoint are confined to staging, including hot rollback journals.
    const source = new DatabaseSync(staged)
    try {
      const check = source.prepare('PRAGMA quick_check').all()
      if (check.length !== 1 || check[0].quick_check !== 'ok') throw new Error('snapshot_integrity_failed')
      await backup(source, destination)
    } finally {
      source.close()
    }
    fs.chmodSync(destination, 0o600)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

function argumentsFor(args: string[]) {
  const values = new Map<string, string>()
  for (let i = args[0] === '--' ? 1 : 0; i < args.length; i++) {
    const key = args[i]
    if (!['--data-dir', '--ref', '--kind'].includes(key) || values.has(key)) throw new Error('invalid-arguments')
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  const dataDir = values.get('--data-dir')
  const ref = values.get('--ref')
  const kind = values.get('--kind')
  if (
    !dataDir ||
    !ref ||
    !/^[a-f0-9]{32}$/.test(ref) ||
    (kind !== undefined && !DIAGNOSTIC_REFERENCE_KINDS.some((value) => value === kind))
  )
    throw new Error('invalid-arguments')
  return {
    dataDir: path.resolve(dataDir),
    ref,
    kinds: kind ? [kind as DiagnosticReferenceKind] : DIAGNOSTIC_REFERENCE_KINDS,
  }
}

/** Candidate SQL is closed and runs only against a read-only private copy. */
function* candidateIds(db: DatabaseSync, kind: DiagnosticReferenceKind): Generator<string> {
  const queries: Record<DiagnosticReferenceKind, readonly string[]> = {
    chat: ['SELECT id FROM chats'],
    character: ['SELECT id FROM characters'],
    preset: [
      ...['model_presets', 'prompt_presets', 'bot_presets', 'hypa_v3_presets', 'translator_presets'].map(
        (table) => `SELECT json_extract(data_json, '$.id') AS id FROM ${table}`,
      ),
      "SELECT json_extract(preset.value, '$.id') AS id FROM settings, json_each(settings.data_json, '$.agentPresets') AS preset WHERE settings.id = 1",
    ],
    profile: [
      "SELECT json_extract(profile.value, '$.id') AS id FROM settings, json_each(settings.data_json, '$.modelProfiles') AS profile WHERE settings.id = 1",
    ],
    operation: ['SELECT operation_id AS id FROM generation_operations'],
    attempt: [
      'SELECT job_id AS id FROM generation_operation_attempts',
      'SELECT finalization_generation_id AS id FROM generation_operation_attempts',
      'SELECT generation_id AS id FROM generation_finalization_retries',
    ],
  }
  for (const sql of queries[kind]) {
    for (const row of db.prepare(sql).iterate()) {
      if (typeof row.id === 'string') yield row.id
    }
  }
}

export async function resolveDiagnosticReference(
  args: string[],
): Promise<{ kind: DiagnosticReferenceKind; id: string } | null> {
  const { dataDir, ref, kinds } = argumentsFor(args)
  const key = fs.readFileSync(path.join(dataDir, 'diagnostics', 'correlation.key'))
  if (key.length !== 32) throw new Error('invalid-key')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-resolve-reference-'))
  let db: DatabaseSync | undefined
  let journal: DatabaseSync | undefined
  try {
    await snapshot(path.join(dataDir, 'risu.db'), path.join(scratch, 'risu.db'))
    await snapshot(path.join(dataDir, 'diagnostics', 'journal.sqlite'), path.join(scratch, 'journal.sqlite'))
    db = new DatabaseSync(path.join(scratch, 'risu.db'), { readOnly: true })
    journal = new DatabaseSync(path.join(scratch, 'journal.sqlite'), { readOnly: true })
    const metadata = journal.prepare('SELECT epoch, lineage_digest FROM journal_metadata WHERE id = 1').get()
    const lineage = db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get()?.lineage
    // The journal pagination epoch is random. Existing operation/attempt HMACs
    // use the history (database lineage) epoch; preserve that mapping exactly.
    if (
      !metadata ||
      !/^[a-f0-9]{32}$/.test(String(metadata.epoch)) ||
      typeof lineage !== 'string' ||
      createHash('sha256').update(lineage).digest('hex') !== metadata.lineage_digest
    )
      throw new Error('history-mismatch')
    for (const kind of kinds) {
      for (const id of candidateIds(db, kind)) {
        const candidate = createHmac('sha256', key)
          .update(JSON.stringify([lineage, kind, id]))
          .digest('hex')
          .slice(0, 32)
        if (candidate === ref) return { kind, id }
      }
    }
    return null
  } finally {
    journal?.close()
    db?.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function run() {
  try {
    const match = await resolveDiagnosticReference(process.argv.slice(2))
    process.stdout.write(match ? `${JSON.stringify(match)}\n` : 'not-found\n')
  } catch {
    process.stderr.write('resolve-error\n')
    process.exitCode = 1
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void run()
