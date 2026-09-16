/** Local, operator-run diagnostics. Never opens the application or runs migrations.
 * Usage: pnpm exec tsx util/dump-generation-diagnostics.ts --data-dir /srv/risu/data
 *   --character-id UUID --chat-id UUID --output /tmp/risu-diagnostic.json
 * Optional: --writer-session-id ID --request-uid UID
 * The request UID is only a report label; this does not read trace bodies.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const root = fileURLToPath(new URL('../', import.meta.url))
const MAX_ROWS = 20
const MAX_FIELDS = 160
const MAX_DEPTH = 6
const MAX_RAW_BYTES = 64 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')

// Only source-defined schema names may leave the process. User-defined object
// keys (plugin storage, variables, speaker IDs, etc.) get positional labels.
const knownKeys = new Set([
  'database',
  'translationSettings',
  'promptInfo',
  'resolvedMainProfile',
  'acceptedTranscriptTail',
  'acceptedBardWikiSettings',
  'speakerNames',
  'pluginCustomStorage',
])
function collectKeys(value: unknown): void {
  if (!record(value)) return
  if (record(value.properties)) Object.keys(value.properties).forEach((key) => knownKeys.add(key))
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(collectKeys)
    else collectKeys(child)
  }
}
collectKeys(
  JSON.parse(fs.readFileSync(path.join(root, 'server/fastify/src/prompt/generationInputSchema.json'), 'utf8')),
)
const safeKey = (key: string, index: number) => (knownKeys.has(key) ? key : `<field-${index}>`)
const schemaFieldNames = new Map(
  [...knownKeys].map((key) => [
    createHash('sha256').update(`generation-input-field:${key}`).digest('hex').slice(0, 16),
    key,
  ]),
)

export function sizeProfile(value: unknown) {
  const fields: Array<{ path: string; bytes: number; memberBytes: number; kind: string; count?: number }> = []
  let truncated = false
  function walk(entry: unknown, location: string, depth: number): void {
    const children = Array.isArray(entry)
      ? entry.map((value, index) => [String(index), value] as const)
      : record(entry)
        ? Object.entries(entry)
        : []
    const ranked = children
      .map(([key, child], index) => {
        const childBytes = bytes(child)
        return {
          key,
          child,
          index,
          bytes: childBytes,
          memberBytes: childBytes + (Array.isArray(entry) ? 0 : bytes(key) + 1),
        }
      })
      .sort((a, b) => b.memberBytes - a.memberBytes)
    if (ranked.length > MAX_ROWS) truncated = true
    const descendants: Array<{ child: unknown; path: string }> = []
    for (const item of ranked.slice(0, MAX_ROWS)) {
      if (fields.length >= MAX_FIELDS) {
        truncated = true
        return
      }
      const childPath = Array.isArray(entry)
        ? `${location}[${item.key}]`
        : `${location}.${safeKey(item.key, item.index)}`
      const kind = item.child === null ? 'null' : Array.isArray(item.child) ? 'array' : typeof item.child
      fields.push({
        path: childPath,
        bytes: item.bytes,
        memberBytes: item.memberBytes,
        kind,
        ...(kind === 'array'
          ? { count: (item.child as unknown[]).length }
          : kind === 'object'
            ? { count: Object.keys(item.child as object).length }
            : {}),
      })
      if ((kind === 'array' || kind === 'object') && item.bytes >= 1024) {
        if (depth < MAX_DEPTH) descendants.push({ child: item.child, path: childPath })
        else truncated = true
      }
    }
    // Report siblings before spending the output budget on deeper fields.
    for (const child of descendants) walk(child.child, child.path, depth + 1)
  }
  walk(value, '$', 0)
  return { bytes: bytes(value), fields, truncated }
}

export function safeError(error: unknown) {
  const e = error as Record<string, unknown> | null
  const allowedNames = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ValidationError',
    'EntityNotFoundError',
    'GenerationInputValidationError',
    'GenerationEffectiveConfigurationTooLargeError',
  ])
  const frames =
    error instanceof Error
      ? (error.stack ?? '')
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            // Ignore function names, exception messages, absolute paths, and eval frames.
            const match = line.match(
              /\/(server\/fastify\/src\/[A-Za-z0-9_./-]+\.[jt]s|util\/[A-Za-z0-9_./-]+\.[jt]s):(\d+):(\d+)/,
            )
            return match ? [`${match[1]}:${match[2]}:${match[3]}`] : []
          })
          .slice(0, 8)
      : []
  return {
    kind: e && typeof e.name === 'string' && allowedNames.has(e.name) ? e.name : 'Error',
    ...(e && ['ERR_SQLITE_ERROR', 'ERR_SQLITE_BUSY', 'ENOENT', 'EACCES', 'EEXIST'].includes(String(e.code))
      ? { code: e.code }
      : {}),
    ...(e && typeof e.errcode === 'number' ? { sqliteCode: e.errcode } : {}),
    ...(e?.name === 'GenerationInputValidationError' && typeof e.instancePath === 'string'
      ? {
          validationPath: e.instancePath
            .split('/')
            .map((key, i) => (i === 0 || /^\d+$/.test(key) ? key : safeKey(key, i)))
            .join('/'),
          ...(typeof e.validationFieldRef === 'string' && schemaFieldNames.has(e.validationFieldRef)
            ? { validationField: schemaFieldNames.get(e.validationFieldRef) }
            : {}),
        }
      : {}),
    frames,
  }
}

function probe<T>(run: () => T, summarize: (value: T) => unknown = sizeProfile): unknown {
  const start = performance.now()
  try {
    const result = summarize(run())
    return { status: 'ok', durationMs: Math.round(performance.now() - start), result }
  } catch (error) {
    return { status: 'error', error: safeError(error) }
  }
}

export interface DumpOptions {
  dataDir: string
  characterId: string
  chatId: string
  writerSessionId?: string
  requestUid?: string
}

export async function dumpGenerationDiagnostics(options: DumpOptions) {
  const db = new DatabaseSync(path.join(options.dataDir, 'risu.db'), { readOnly: true })
  const report: Record<string, unknown> = {
    version: 1,
    capturedAt: new Date().toISOString(),
    node: process.version,
    requestUid: options.requestUid,
    sourceReadOnly: true,
    limitations: [
      'Current persisted state, not the failed request body.',
      'No HTTP/auth, browser execution, provider calls, migrations, repairs, or runtime jobs are run.',
      'Read helpers attempting repair writes fail under query_only; errors omit messages and values.',
      'Field sizes overlap across nested paths. Raw JSON profiling is capped at 64 MiB per row.',
    ],
  }
  try {
    try {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (/^[a-f0-9]{40,64}$/.test(revision)) report.codeRevision = revision
    } catch {
      report.codeRevision = 'unavailable'
    }
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN')
    const sourceRows: Record<string, unknown> = {}
    // Identifiers below are fixed source literals. All operator input is bound.
    for (const [label, table, column, condition, args] of [
      ['settings', 'settings', 'data_json', 'id = 1', []],
      ['character', 'characters', 'data_json', 'id = ?', [options.characterId]],
      ['chat', 'chats', 'data_json', 'id = ?', [options.chatId]],
      ['hypa', 'chat_hypa_v3', 'json', 'chat_id = ?', [options.chatId]],
    ] as const) {
      sourceRows[label] = probe(
        () => {
          const size = db
            .prepare(`SELECT length(CAST(${column} AS BLOB)) AS bytes FROM ${table} WHERE ${condition}`)
            .get(...args) as { bytes: number } | undefined
          if (!size) return { present: false }
          if (size.bytes > MAX_RAW_BYTES) return { present: true, bytes: size.bytes, skipped: 'row-size-budget' }
          const row = db.prepare(`SELECT ${column} AS json FROM ${table} WHERE ${condition}`).get(...args) as {
            json: string
          }
          return { present: true, storedBytes: size.bytes, profile: sizeProfile(JSON.parse(row.json)) }
        },
        (value) => value,
      )
    }
    report.sourceRows = sourceRows
    report.activeMessages = probe(
      () =>
        db
          .prepare(
            'SELECT count(*) AS count, coalesce(sum(length(CAST(json AS BLOB))), 0) AS bytes, coalesce(max(length(CAST(json AS BLOB))), 0) AS largestRowBytes FROM messages WHERE chat_id = ? AND alternate = 0',
          )
          .get(options.chatId),
      (value) => value,
    )
    report.largestStoredConfigurations = probe(
      () =>
        db
          .prepare(
            'SELECT length(CAST(effective_configuration_json AS BLOB)) AS bytes, json_valid(effective_configuration_json) AS jsonValid FROM generation_operations WHERE effective_configuration_json IS NOT NULL ORDER BY bytes DESC LIMIT 20',
          )
          .all(),
      (value) => value,
    )

    // Imports are probed so schema/version/dependency failures still leave the
    // raw size evidence above in a usable report. No app construction/startup.
    try {
      const [
        { getSchemaState },
        { getDatabaseOwnershipSnapshot },
        { assessDatabaseInitialization },
        operations,
        effects,
        finalizations,
        { ChatOccupancyService },
        repository,
      ] = await Promise.all([
        import('../server/fastify/src/db.js'),
        import('../server/fastify/src/databaseLineage.js'),
        import('../server/fastify/src/databaseInitialization.js'),
        import('../server/fastify/src/generationOperations.js'),
        import('../server/fastify/src/generationEffects.js'),
        import('../server/fastify/src/generationFinalizationRetry.js'),
        import('../server/fastify/src/chatOccupancy.js'),
        import('../server/fastify/src/repository.js'),
      ])
      report.schema = probe(
        () => getSchemaState(db),
        (value) => value,
      )
      report.initialization = probe(
        () => assessDatabaseInitialization(db),
        (value) => ({ state: value.state }),
      )
      report.ownership = probe(
        () => getDatabaseOwnershipSnapshot(db),
        (value) => ({ writerEpoch: value.writer.epoch, hasWriter: value.writer.sessionId !== null }),
      )
      report.bootstrap = {
        operations: probe(() => operations.listGenerationOperationProjections(db)),
        occupancy: probe(() => new ChatOccupancyService(db).snapshot()),
        finalizations: probe(() =>
          finalizations.listGenerationFinalizationRetryProjections(db, {
            sessionId: options.writerSessionId ?? getDatabaseOwnershipSnapshot(db).writer.sessionId ?? undefined,
            includeLegacyOwner: true,
          }),
        ),
        effects: probe(() =>
          effects.listPendingClientGenerationEffects(db, undefined, new Date(), {
            sessionId: options.writerSessionId ?? getDatabaseOwnershipSnapshot(db).writer.sessionId ?? undefined,
            includeLegacyOwner: true,
          }),
        ),
      }
      report.characterHydration = probe(() =>
        repository.loadSingleCharacterRowForRead(db, options.dataDir, options.characterId),
      )
      report.translatorSettings = probe(() => repository.loadSettingsWithTranslatorPresetsFromSqlite(db))
      try {
        const { captureAcceptedEffectiveGenerationConfiguration } =
          await import('../server/fastify/src/routes/generationChat.js')
        const { createGenerationConfigurationTables, storeGenerationConfiguration } =
          await import('../server/fastify/src/generationConfiguration.js')
        report.effectiveConfiguration = probe(
          () => captureAcceptedEffectiveGenerationConfiguration(db, options.dataDir, options),
          (configuration) => {
            // Build the real persisted manifest in disposable memory. The source
            // connection remains read-only and no source migrations/repairs run.
            const scratch = new DatabaseSync(':memory:')
            let stored
            try {
              createGenerationConfigurationTables(scratch)
              scratch.exec('BEGIN')
              stored = storeGenerationConfiguration(scratch, configuration)
              report.configurationDependencies = scratch
                .prepare(
                  'SELECT kind, count(*) AS count, sum(length(CAST(json AS BLOB))) AS bytes FROM generation_configuration_dependencies GROUP BY kind',
                )
                .all()
            } finally {
              scratch.close()
            }
            const canonicalBytes = Buffer.byteLength(operations.canonicalizeGenerationOperationSemantics(stored))
            const expandedBytes = Buffer.byteLength(operations.canonicalizeGenerationOperationSemantics(configuration))
            const chat = configuration.database.characters
              .find((c) => c.chaId === options.characterId)
              ?.chats.find((c) => c.id === options.chatId)
            return {
              canonicalBytes,
              expandedBytes,
              storageVersion: stored.version,
              maxBytes: operations.GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES,
              exceedsLimit: canonicalBytes > operations.GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES,
              snapshotMessageCount: chat?.message.length,
              snapshotHasHypa: chat?.hypaV3Data !== undefined,
              profile: sizeProfile(configuration),
            }
          },
        )
      } catch (error) {
        report.effectiveConfiguration = { status: 'import-error', error: safeError(error) }
      }
    } catch (error) {
      report.applicationProbes = { status: 'import-error', error: safeError(error) }
    }
    return report
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
    db.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'pnpm exec tsx util/dump-generation-diagnostics.ts --data-dir PATH --character-id ID --chat-id ID [--writer-session-id ID] [--request-uid UID] [--output NEW_FILE]',
    )
    return
  }
  const flags = new Map<string, string>()
  const allowed = new Set([
    '--data-dir',
    '--character-id',
    '--chat-id',
    '--writer-session-id',
    '--request-uid',
    '--output',
  ])
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1]
    if (!allowed.has(flag) || flags.has(flag) || !value || value.startsWith('--')) throw new Error('Invalid arguments')
    flags.set(flag, value)
  }
  for (const key of ['--data-dir', '--character-id', '--chat-id'])
    if (!flags.has(key)) throw new Error('Missing argument')
  const requestUid = flags.get('--request-uid')
  if (requestUid && !/^[a-f0-9]{32,128}$/.test(requestUid)) throw new Error('Invalid request UID')
  const report = await dumpGenerationDiagnostics({
    dataDir: path.resolve(flags.get('--data-dir')!),
    characterId: flags.get('--character-id')!,
    chatId: flags.get('--chat-id')!,
    writerSessionId: flags.get('--writer-session-id'),
    requestUid,
  })
  const json = JSON.stringify(report, null, 2) + '\n'
  const output = flags.get('--output')
  if (output) fs.writeFileSync(output, json, { flag: 'wx', mode: 0o600 })
  else process.stdout.write(json)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ status: 'failed', error: safeError(error) }) + '\n')
    process.exitCode = 1
  })
}
