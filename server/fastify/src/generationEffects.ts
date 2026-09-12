import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertDatabaseLineage, getDatabaseLineage } from './databaseLineage.js'
import { recordTableWrite } from './protocolMetrics.js'

export const GENERATION_EFFECT_LEDGER_VERSION = 1
export const GENERATION_EFFECT_CLAIM_LEASE_MS = 5 * 60_000
export const GENERATION_EFFECT_RECENT_ALERT_RECOVERY_MS = 60_000

export const GENERATION_EFFECT_KINDS = [
  'igp',
  'plugin_output',
  'generated_translation',
  'notification',
  'tts',
  'completion_sound',
  'emotion_image_state',
] as const

export type GenerationEffectKind = (typeof GENERATION_EFFECT_KINDS)[number]
export type GenerationEffectClass = 'durable' | 'ephemeral' | 'recomputed'
export type GenerationEffectKeyType = 'operation' | 'generation'
export type GenerationEffectStatus = 'pending' | 'claimed' | 'completed' | 'skipped' | 'failed'
export type GenerationEffectDelivery = 'server' | 'live_terminal' | 'late_recovery'

const EFFECT_CLASS: Readonly<Record<GenerationEffectKind, GenerationEffectClass>> = {
  igp: 'durable',
  plugin_output: 'durable',
  generated_translation: 'durable',
  notification: 'ephemeral',
  tts: 'ephemeral',
  completion_sound: 'ephemeral',
  emotion_image_state: 'recomputed',
}

const CLIENT_EFFECT_KINDS = new Set<GenerationEffectKind>([
  'igp',
  'plugin_output',
  'notification',
  'tts',
  'completion_sound',
  'emotion_image_state',
])

interface GenerationEffectRow {
  database_lineage: string
  key_type: GenerationEffectKeyType
  key_id: string
  effect_kind: GenerationEffectKind
  effect_class: GenerationEffectClass
  operation_id: string | null
  generation_id: string
  character_id: string
  chat_id: string
  message_id: string
  status: GenerationEffectStatus
  claim_id: string | null
  delivery: GenerationEffectDelivery | null
  reason: string | null
  last_error: string | null
  created_at: string
  claimed_at: string | null
  lease_expires_at: string | null
  settled_at: string | null
  updated_at: string
}

export interface GenerationEffectProjection {
  ledgerVersion: 1
  databaseLineage: string
  keyType: GenerationEffectKeyType
  keyId: string
  kind: GenerationEffectKind
  effectClass: GenerationEffectClass
  operationId?: string
  generationId: string
  characterId: string
  chatId: string
  messageId: string
  status: GenerationEffectStatus
  claimId?: string
  delivery?: GenerationEffectDelivery
  reason?: string
  lastError?: string
  createdAt: string
  claimedAt?: string
  leaseExpiresAt?: string
  settledAt?: string
  updatedAt: string
}

export interface GenerationEffectLedgerRef {
  version: 1
  databaseLineage: string
  keyType: GenerationEffectKeyType
  keyId: string
  generationId: string
  characterId: string
  chatId: string
  messageId: string
}

export interface EnsureGenerationEffectLedgerInput {
  databaseLineage: string
  operationId: string
  operationProtocolVersion: number
  generationId: string
  characterId: string
  chatId: string
  messageId: string
  createdAt?: string
}

export interface ClaimGenerationEffectInput {
  databaseLineage: string
  generationId: string
  kind: GenerationEffectKind
  delivery: GenerationEffectDelivery
  messageId?: string
  claimedAt?: string
  leaseMs?: number
  /** Permit a one-shot notification/sound claim shortly after completion.
   * The server still rejects stale recovery and every other ephemeral kind. */
  recoverRecentCompletionAlert?: boolean
}

export type ClaimGenerationEffectResult =
  | {
      status: 'claimed'
      effect: GenerationEffectProjection
      claimId: string
      leaseExpiresAt: string
      idempotencyKey: string
      reclaimed?: true
    }
  | { status: 'not_claimed'; effect?: GenerationEffectProjection; reason: string }

export interface RenewGenerationEffectClaimInput {
  databaseLineage: string
  generationId: string
  kind: GenerationEffectKind
  claimId: string
  renewedAt?: string
  leaseMs?: number
}

export interface SettleGenerationEffectInput {
  databaseLineage: string
  generationId: string
  kind: GenerationEffectKind
  claimId: string
  status: 'completed' | 'skipped' | 'failed'
  reason?: string | null
  lastError?: string | null
  settledAt?: string
}

export function generationEffectClass(kind: GenerationEffectKind): GenerationEffectClass {
  return EFFECT_CLASS[kind]
}

export function isGenerationEffectKind(value: unknown): value is GenerationEffectKind {
  return typeof value === 'string' && (GENERATION_EFFECT_KINDS as readonly string[]).includes(value)
}

export function createGenerationEffectLedgerTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_effects (
      database_lineage TEXT NOT NULL,
      key_type TEXT NOT NULL CHECK (key_type IN ('operation', 'generation')),
      key_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'igp', 'plugin_output', 'generated_translation',
        'notification', 'tts', 'completion_sound', 'emotion_image_state'
      )),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('durable', 'ephemeral', 'recomputed')),
      operation_id TEXT,
      generation_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'skipped', 'failed')),
      claim_id TEXT,
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('server', 'live_terminal', 'late_recovery')),
      reason TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      settled_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (database_lineage, key_type, key_id, effect_kind),
      UNIQUE (database_lineage, generation_id, effect_kind),
      CHECK (
        (key_type = 'operation' AND operation_id = key_id)
        OR key_type = 'generation'
      ),
      CHECK (
        (status = 'pending' AND claim_id IS NULL AND delivery IS NULL AND claimed_at IS NULL)
        OR (status <> 'pending' AND claim_id IS NOT NULL AND delivery IS NOT NULL AND claimed_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS generation_effects_pending
      ON generation_effects (database_lineage, status, updated_at);
  `)
  ensureGenerationEffectColumn(
    db,
    'lease_expires_at',
    'ALTER TABLE generation_effects ADD COLUMN lease_expires_at TEXT',
  )
  db.exec(`
    CREATE INDEX IF NOT EXISTS generation_effects_recoverable_claims
      ON generation_effects (database_lineage, status, lease_expires_at, effect_kind);
  `)
}

export function ensureGenerationEffectLedgerInTransaction(
  db: DatabaseSync,
  input: EnsureGenerationEffectLedgerInput,
): GenerationEffectLedgerRef {
  const keyType: GenerationEffectKeyType = input.operationProtocolVersion >= 1 ? 'operation' : 'generation'
  const keyId = keyType === 'operation' ? input.operationId : input.generationId
  const now = normalizeTimestamp(input.createdAt)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO generation_effects (
      database_lineage, key_type, key_id, effect_kind, effect_class,
      operation_id, generation_id, character_id, chat_id, message_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `)
  for (const kind of GENERATION_EFFECT_KINDS) {
    insert.run(
      input.databaseLineage,
      keyType,
      keyId,
      kind,
      EFFECT_CLASS[kind],
      input.operationId,
      input.generationId,
      input.characterId,
      input.chatId,
      input.messageId,
      now,
      now,
    )
  }
  return {
    version: GENERATION_EFFECT_LEDGER_VERSION,
    databaseLineage: input.databaseLineage,
    keyType,
    keyId,
    generationId: input.generationId,
    characterId: input.characterId,
    chatId: input.chatId,
    messageId: input.messageId,
  }
}

export function ensureGenerationEffectLedger(
  db: DatabaseSync,
  input: EnsureGenerationEffectLedgerInput,
): GenerationEffectLedgerRef {
  return withImmediateTransaction(db, () => ensureGenerationEffectLedgerInTransaction(db, input))
}

export function generationEffectLedgerRef(
  db: DatabaseSync,
  databaseLineage: string,
  generationId: string,
): GenerationEffectLedgerRef | undefined {
  const row = selectGenerationEffectRows(
    db,
    'WHERE database_lineage = ? AND generation_id = ? ORDER BY effect_kind LIMIT 1',
    [databaseLineage, generationId],
  )[0]
  return row
    ? {
        version: GENERATION_EFFECT_LEDGER_VERSION,
        databaseLineage: row.database_lineage,
        keyType: row.key_type,
        keyId: row.key_id,
        generationId: row.generation_id,
        characterId: row.character_id,
        chatId: row.chat_id,
        messageId: row.message_id,
      }
    : undefined
}

export function listGenerationEffects(
  db: DatabaseSync,
  generationId: string,
  databaseLineage = getDatabaseLineage(db),
): GenerationEffectProjection[] {
  return selectGenerationEffectRows(db, 'WHERE database_lineage = ? AND generation_id = ? ORDER BY effect_kind', [
    databaseLineage,
    generationId,
  ]).map(projectionFromRow)
}

/** Pending browser work projected only to the active writer during bootstrap. */
export function listPendingClientGenerationEffects(
  db: DatabaseSync,
  databaseLineage = getDatabaseLineage(db),
  now: string | Date = new Date(),
): GenerationEffectProjection[] {
  const clientKinds = [...CLIENT_EFFECT_KINDS]
  const placeholders = clientKinds.map(() => '?').join(', ')
  return selectGenerationEffectRows(
    db,
    `WHERE database_lineage = ?
       AND (status = 'pending' OR (
         status = 'claimed' AND effect_class = 'durable'
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ))
       AND effect_kind IN (${placeholders})
     ORDER BY created_at, generation_id, effect_kind`,
    [databaseLineage, normalizeTimestamp(now), ...clientKinds],
  ).map(projectionFromRow)
}

export function listPendingServerGenerationEffects(
  db: DatabaseSync,
  databaseLineage = getDatabaseLineage(db),
  now: string | Date = new Date(),
): GenerationEffectProjection[] {
  return selectGenerationEffectRows(
    db,
    `WHERE database_lineage = ? AND effect_kind = 'generated_translation'
       AND (status = 'pending' OR (
         status = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ))
     ORDER BY created_at, generation_id`,
    [databaseLineage, normalizeTimestamp(now)],
  ).map(projectionFromRow)
}

export function claimGenerationEffect(
  db: DatabaseSync,
  input: ClaimGenerationEffectInput,
): ClaimGenerationEffectResult {
  return withImmediateTransaction(db, () => claimGenerationEffectInTransaction(db, input))
}

export function claimGenerationEffectInTransaction(
  db: DatabaseSync,
  input: ClaimGenerationEffectInput,
): ClaimGenerationEffectResult {
  const current = selectGenerationEffectRows(
    db,
    'WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?',
    [input.databaseLineage, input.generationId, input.kind],
  )[0]
  if (!current) return { status: 'not_claimed', reason: 'effect_not_found' }
  if (input.messageId !== undefined && current.message_id !== input.messageId) {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'message_mismatch' }
  }
  if (input.delivery !== 'server' && !CLIENT_EFFECT_KINDS.has(input.kind)) {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'server_owned' }
  }
  if (input.delivery === 'server' && input.kind !== 'generated_translation') {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'client_owned' }
  }
  const now = normalizeTimestamp(input.claimedAt)
  const leaseExpiresAt = claimLeaseExpiresAt(now, input.leaseMs)
  const reclaiming =
    current.status === 'claimed' &&
    current.effect_class === 'durable' &&
    (current.lease_expires_at === null || current.lease_expires_at <= now)
  if (current.status !== 'pending' && !reclaiming) {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'already_receipted' }
  }

  const claimId = randomUUID()
  const createdAt = Date.parse(current.created_at)
  const claimedAt = Date.parse(now)
  const recentCompletionAlert =
    input.recoverRecentCompletionAlert === true &&
    (input.kind === 'notification' || input.kind === 'completion_sound') &&
    Number.isFinite(createdAt) &&
    Number.isFinite(claimedAt) &&
    claimedAt >= createdAt &&
    claimedAt - createdAt <= GENERATION_EFFECT_RECENT_ALERT_RECOVERY_MS
  if (
    !reclaiming &&
    input.delivery === 'late_recovery' &&
    current.effect_class === 'ephemeral' &&
    !recentCompletionAlert
  ) {
    db.prepare(
      `UPDATE generation_effects
       SET status = 'skipped', claim_id = ?, delivery = ?, reason = 'late_recovery',
           claimed_at = ?, settled_at = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ? AND status = 'pending'`,
    ).run(claimId, input.delivery, now, now, now, input.databaseLineage, input.generationId, input.kind)
    const skipped = requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind)
    return { status: 'not_claimed', effect: projectionFromRow(skipped), reason: 'late_recovery_skipped' }
  }

  const result = db
    .prepare(
      `UPDATE generation_effects
       SET status = 'claimed', claim_id = ?, delivery = ?, claimed_at = ?,
           lease_expires_at = ?, settled_at = NULL, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?
         AND (${
           reclaiming
             ? "status = 'claimed' AND claim_id = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
             : "status = 'pending'"
         })`,
    )
    .run(
      claimId,
      input.delivery,
      now,
      leaseExpiresAt,
      now,
      input.databaseLineage,
      input.generationId,
      input.kind,
      ...(reclaiming ? [current.claim_id, now] : []),
    )
  if (result.changes !== 1) {
    const raced = requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind)
    return { status: 'not_claimed', effect: projectionFromRow(raced), reason: 'already_receipted' }
  }
  return {
    status: 'claimed',
    claimId,
    leaseExpiresAt,
    idempotencyKey: generationEffectIdempotencyKey(current),
    ...(reclaiming ? { reclaimed: true as const } : {}),
    effect: projectionFromRow(requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind)),
  }
}

export function renewGenerationEffectClaim(
  db: DatabaseSync,
  input: RenewGenerationEffectClaimInput,
): GenerationEffectProjection | undefined {
  const now = normalizeTimestamp(input.renewedAt)
  const leaseExpiresAt = claimLeaseExpiresAt(now, input.leaseMs)
  const result = db
    .prepare(
      `UPDATE generation_effects
       SET lease_expires_at = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?
         AND status = 'claimed' AND claim_id = ?`,
    )
    .run(leaseExpiresAt, now, input.databaseLineage, input.generationId, input.kind, input.claimId)
  if (result.changes !== 1) return undefined
  return projectionFromRow(requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind))
}

export function settleGenerationEffect(
  db: DatabaseSync,
  input: SettleGenerationEffectInput,
): GenerationEffectProjection | undefined {
  const now = normalizeTimestamp(input.settledAt)
  const result = db
    .prepare(
      `UPDATE generation_effects
       SET status = ?, reason = ?, last_error = ?, settled_at = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?
         AND status = 'claimed' AND claim_id = ?`,
    )
    .run(
      input.status,
      input.reason ?? null,
      input.lastError ?? null,
      now,
      now,
      input.databaseLineage,
      input.generationId,
      input.kind,
      input.claimId,
    )
  if (result.changes !== 1) {
    // An IGP message command can complete this exact receipt atomically with
    // its text write. The callback's later receipt is an acknowledgement of
    // that commit, including after its original HTTP response was lost.
    if (input.kind !== 'igp' || input.status !== 'completed') return undefined
    const existing = selectGenerationEffectRows(
      db,
      "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp' AND status = 'completed' AND claim_id = ?",
      [input.databaseLineage, input.generationId, input.claimId],
    )[0]
    return existing ? projectionFromRow(existing) : undefined
  }
  return projectionFromRow(requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind))
}

/**
 * Complete IGP inside the message command's existing transaction. The caller
 * must roll back both this receipt and its text write if either fails; a
 * command mutation receipt handles a replay of the entire accepted command.
 */
export function completeClaimedIgpEffectInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    claimId: string
    characterId: string
    chatId: string
    messageId: string
    message: Record<string, unknown>
    expectedGenerationId?: string
  },
): boolean {
  if (!db.isTransaction) throw new Error('IGP completion requires the message command transaction')
  assertDatabaseLineage(db, input.databaseLineage)
  const effect = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'",
    [input.databaseLineage, input.generationId],
  )[0]
  const now = normalizeTimestamp()
  if (
    !effect ||
    effect.status !== 'claimed' ||
    effect.claim_id !== input.claimId ||
    effect.lease_expires_at === null ||
    effect.lease_expires_at <= now ||
    effect.character_id !== input.characterId ||
    effect.chat_id !== input.chatId ||
    effect.message_id !== input.messageId ||
    input.message.role !== 'char'
  )
    return false

  const info = input.message.generationInfo
  if (info !== undefined) {
    if (!info || typeof info !== 'object' || Array.isArray(info)) return false
    const metadata = info as Record<string, unknown>
    const expected = {
      generationId: input.generationId,
      databaseLineage: input.databaseLineage,
      operationId: effect.operation_id,
      jobId: input.generationId,
      effectLedgerKeyType: effect.key_type,
      effectLedgerKeyId: effect.key_id,
      effectLedgerCharacterId: input.characterId,
      effectLedgerChatId: input.chatId,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (key in metadata && metadata[key] !== value) return false
    }
    // Legacy ledger rows can predate message generation metadata. Modern rows
    // require the same generation precondition as the ordinary text command.
    if (metadata.generationId !== undefined && input.expectedGenerationId !== input.generationId) return false
  }
  const completed = settleGenerationEffect(db, {
    databaseLineage: input.databaseLineage,
    generationId: input.generationId,
    claimId: input.claimId,
    kind: 'igp',
    status: 'completed',
    settledAt: now,
  })
  if (!completed) return false
  recordTableWrite('generation_effects')
  return true
}

/**
 * Schema upgrades can find completed v29/v30 operations whose result predates
 * the effect table. Backfill their exact lineage without inventing effects for
 * cancelled or failed terminals.
 */
export function reconcileGenerationEffectsAtStartup(db: DatabaseSync): number {
  const databaseLineage = getDatabaseLineage(db)
  const rows = db
    .prepare(
      `SELECT o.operation_id AS operationId, o.protocol_version AS protocolVersion,
              o.character_id AS characterId, o.chat_id AS chatId,
              o.result_message_id AS messageId,
              COALESCE(a.finalization_generation_id, a.job_id) AS generationId
       FROM generation_operations AS o
       LEFT JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = o.current_attempt_no
       WHERE o.database_lineage = ? AND o.state = 'completed'
         AND o.character_id IS NOT NULL AND o.chat_id IS NOT NULL
         AND o.result_message_id IS NOT NULL
         AND COALESCE(a.finalization_generation_id, a.job_id) IS NOT NULL`,
    )
    .all(databaseLineage) as Array<{
    operationId: string
    protocolVersion: number
    characterId: string
    chatId: string
    messageId: string
    generationId: string
  }>
  let inserted = 0
  withImmediateTransaction(db, () => {
    for (const row of rows) {
      const before = db
        .prepare('SELECT COUNT(*) AS count FROM generation_effects WHERE database_lineage = ? AND generation_id = ?')
        .get(databaseLineage, row.generationId) as { count: number }
      ensureGenerationEffectLedgerInTransaction(db, {
        databaseLineage,
        operationId: row.operationId,
        operationProtocolVersion: row.protocolVersion,
        generationId: row.generationId,
        characterId: row.characterId,
        chatId: row.chatId,
        messageId: row.messageId,
      })
      if (before.count === 0) {
        const now = new Date().toISOString()
        db.prepare(
          `UPDATE generation_effects
           SET status = 'skipped', claim_id = ?, delivery = 'server',
               reason = 'pre_ledger_terminal', claimed_at = ?, settled_at = ?, updated_at = ?
           WHERE database_lineage = ? AND generation_id = ? AND status = 'pending'`,
        ).run(randomUUID(), now, now, now, databaseLineage, row.generationId)
        inserted += GENERATION_EFFECT_KINDS.length
      }
    }
  })
  return inserted
}

function selectGenerationEffectRows(
  db: DatabaseSync,
  whereSql: string,
  params: Array<string | number | null>,
): GenerationEffectRow[] {
  return db.prepare(`SELECT * FROM generation_effects ${whereSql}`).all(...params) as unknown as GenerationEffectRow[]
}

function requireGenerationEffectRow(
  db: DatabaseSync,
  databaseLineage: string,
  generationId: string,
  kind: GenerationEffectKind,
): GenerationEffectRow {
  const row = selectGenerationEffectRows(db, 'WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?', [
    databaseLineage,
    generationId,
    kind,
  ])[0]
  if (!row) throw new Error('generation effect row is missing')
  return row
}

function projectionFromRow(row: GenerationEffectRow): GenerationEffectProjection {
  return {
    ledgerVersion: GENERATION_EFFECT_LEDGER_VERSION,
    databaseLineage: row.database_lineage,
    keyType: row.key_type,
    keyId: row.key_id,
    kind: row.effect_kind,
    effectClass: row.effect_class,
    ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
    generationId: row.generation_id,
    characterId: row.character_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    status: row.status,
    ...(row.claim_id !== null ? { claimId: row.claim_id } : {}),
    ...(row.delivery !== null ? { delivery: row.delivery } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    updatedAt: row.updated_at,
  }
}

function normalizeTimestamp(value?: string | Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

function claimLeaseExpiresAt(claimedAt: string, leaseMs = GENERATION_EFFECT_CLAIM_LEASE_MS): string {
  const normalizedLeaseMs =
    Number.isFinite(leaseMs) && leaseMs > 0 ? Math.floor(leaseMs) : GENERATION_EFFECT_CLAIM_LEASE_MS
  return new Date(Date.parse(claimedAt) + normalizedLeaseMs).toISOString()
}

function generationEffectIdempotencyKey(row: GenerationEffectRow): string {
  return ['generation-effect-v1', row.database_lineage, row.key_type, row.key_id, row.effect_kind]
    .map(encodeURIComponent)
    .join(':')
}

function ensureGenerationEffectColumn(db: DatabaseSync, column: string, alterSql: string): void {
  const columns = db.prepare('PRAGMA table_info(generation_effects)').all() as Array<{ name: string }>
  if (!columns.some((candidate) => candidate.name === column)) db.exec(alterSql)
}

function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  let committed = false
  try {
    const result = fn()
    db.exec('COMMIT')
    committed = true
    return result
  } finally {
    if (!committed) db.exec('ROLLBACK')
  }
}
