import { recordDiagnosticErrorForDatabase } from './diagnosticFacts.js'
import { resolveGenerationConfiguration } from './generationConfiguration.js'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { assertDatabaseLineage, getDatabaseLineage } from './databaseLineage.js'
import { recordTableWrite } from './protocolMetrics.js'
import {
  generationScopeIsChatOnly,
  scopeFromColumns,
  scopeSqlValues,
  type GenerationScopeColumns,
  type PersistedGenerationScope,
} from './generationScope.js'
import { getGenerationOperationAttemptAcceptedConfiguration } from './generationOperations.js'
import {
  getAlternateMessages,
  getChatMessages,
  resolveActiveMessageLocationById,
  updateActiveMessageById,
} from './messageStore.js'

export const GENERATION_EFFECT_LEDGER_VERSION = 1
export const GENERATION_EFFECT_CLAIM_LEASE_MS = 5 * 60_000
export const GENERATION_EFFECT_RECENT_ALERT_RECOVERY_MS = 60_000
export const GENERATION_EFFECT_MAINTENANCE_INTERVAL_MS = 60 * 60_000
export const GENERATION_EFFECT_MAINTENANCE_SWEEP_LIMIT = 1000
export const GENERATION_EFFECT_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000
export const GENERATED_TRANSLATION_SERVER_OWNED_ERROR = 'generated_translation_server_owned'
export const GENERATED_TRANSLATION_PREREQUISITE_PENDING = 'generated_translation_prerequisite_pending'
export const GENERATION_INLAY_PREREQUISITE_PENDING = 'generation_inlay_prerequisite_pending'
export const GENERATION_INLAY_PREPARATION_INVALID = 'generation_inlay_preparation_invalid'
export const DEFERRED_GENERATION_INLAY_TARGET_STALE = 'deferred_generation_inlay_target_stale'

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
export type DeferredGenerationInlayFinalizationDisposition = 'none' | 'ready' | 'stale' | 'invalid'
export type DeferredGenerationInlayFinalizationDrainOutcome = 'none' | 'committed' | 'stale' | 'invalid'

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

interface GenerationEffectRow extends GenerationScopeColumns {
  database_lineage: string
  key_type: GenerationEffectKeyType
  key_id: string
  effect_kind: GenerationEffectKind
  effect_class: GenerationEffectClass
  operation_id: string | null
  operation_attempt_no: number | null
  generation_id: string
  character_id: string
  chat_id: string
  message_id: string
  terminal_transcript_fingerprint: string | null
  authorized_translation_fingerprint: string | null
  inlay_preparation_id: string | null
  inlay_preparation_expected_data: string | null
  deferred_inlay_expected_data: string | null
  deferred_inlay_final_data: string | null
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
  operationAttemptNo?: number
  generationId: string
  characterId: string
  chatId: string
  messageId: string
  generationScope?: PersistedGenerationScope
  inlayPreparationId?: string
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

export interface ListPendingClientGenerationEffectsOptions {
  /** Authenticated page session that may recover its own accepted effects. */
  sessionId?: string
  /** Keep pre-occupancy/legacy effects available to the current general owner. */
  includeLegacyOwner?: boolean
}

export interface EnsureGenerationEffectLedgerInput {
  databaseLineage: string
  operationId: string
  operationAttemptNo?: number
  operationProtocolVersion: number
  generationId: string
  characterId: string
  chatId: string
  messageId: string
  generationScope?: PersistedGenerationScope
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
  diagnosticError?: unknown
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
      operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0),
      generation_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      terminal_transcript_fingerprint TEXT,
      authorized_translation_fingerprint TEXT,
      inlay_preparation_id TEXT,
      inlay_preparation_expected_data TEXT,
      deferred_inlay_expected_data TEXT,
      deferred_inlay_final_data TEXT,
      admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only')),
      occupancy_database_lineage TEXT,
      occupancy_session_id TEXT,
      occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0),
      occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only')),
      permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0),
      permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json)),
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
  ensureGenerationEffectColumn(
    db,
    'terminal_transcript_fingerprint',
    'ALTER TABLE generation_effects ADD COLUMN terminal_transcript_fingerprint TEXT',
  )
  ensureGenerationEffectColumn(
    db,
    'authorized_translation_fingerprint',
    'ALTER TABLE generation_effects ADD COLUMN authorized_translation_fingerprint TEXT',
  )
  ensureGenerationEffectColumn(
    db,
    'inlay_preparation_id',
    'ALTER TABLE generation_effects ADD COLUMN inlay_preparation_id TEXT',
  )
  ensureGenerationEffectColumn(
    db,
    'inlay_preparation_expected_data',
    'ALTER TABLE generation_effects ADD COLUMN inlay_preparation_expected_data TEXT',
  )
  ensureGenerationEffectColumn(
    db,
    'deferred_inlay_expected_data',
    'ALTER TABLE generation_effects ADD COLUMN deferred_inlay_expected_data TEXT',
  )
  ensureGenerationEffectColumn(
    db,
    'deferred_inlay_final_data',
    'ALTER TABLE generation_effects ADD COLUMN deferred_inlay_final_data TEXT',
  )
  ensureGenerationEffectScopeColumns(db)
  db.exec(`
    CREATE INDEX IF NOT EXISTS generation_effects_recoverable_claims
      ON generation_effects (database_lineage, status, lease_expires_at, effect_kind);
    CREATE INDEX IF NOT EXISTS generation_effects_settled_retention
      ON generation_effects (database_lineage, COALESCE(settled_at, updated_at))
      WHERE status IN ('completed', 'skipped', 'failed');
  `)
}

function ensureGenerationEffectScopeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(generation_effects)').all() as Array<{ name: string }>).map((row) => row.name),
  )
  const columns: ReadonlyArray<readonly [string, string]> = [
    [
      'admission_kind',
      "ALTER TABLE generation_effects ADD COLUMN admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only'))",
    ],
    ['occupancy_database_lineage', 'ALTER TABLE generation_effects ADD COLUMN occupancy_database_lineage TEXT'],
    [
      'operation_attempt_no',
      'ALTER TABLE generation_effects ADD COLUMN operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0)',
    ],
    ['occupancy_session_id', 'ALTER TABLE generation_effects ADD COLUMN occupancy_session_id TEXT'],
    [
      'occupancy_epoch',
      'ALTER TABLE generation_effects ADD COLUMN occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0)',
    ],
    [
      'occupancy_claim_class',
      "ALTER TABLE generation_effects ADD COLUMN occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only'))",
    ],
    [
      'permission_scope_version',
      'ALTER TABLE generation_effects ADD COLUMN permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0)',
    ],
    [
      'permission_scope_json',
      'ALTER TABLE generation_effects ADD COLUMN permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json))',
    ],
  ]
  for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
}

export function ensureGenerationEffectLedgerInTransaction(
  db: DatabaseSync,
  input: EnsureGenerationEffectLedgerInput,
): GenerationEffectLedgerRef {
  const keyType: GenerationEffectKeyType = input.operationProtocolVersion >= 1 ? 'operation' : 'generation'
  const keyId = keyType === 'operation' ? input.operationId : input.generationId
  const now = normalizeTimestamp(input.createdAt)
  const chatOnlyIgpConfigured = generationScopeIsChatOnly(input.generationScope)
    ? acceptedIgpConfigured(db, input.databaseLineage, input.operationId)
    : undefined
  const terminalTranscriptFingerprint = generationEffectTerminalTranscriptFingerprint(
    getChatMessages(db, input.chatId),
    getAlternateMessages(db, input.chatId),
    input.messageId,
  )
  const insert = db.prepare(`
    INSERT OR IGNORE INTO generation_effects (
      database_lineage, key_type, key_id, effect_kind, effect_class,
      operation_id, operation_attempt_no, generation_id, character_id, chat_id, message_id,
      terminal_transcript_fingerprint,
      admission_kind, occupancy_database_lineage, occupancy_session_id, occupancy_epoch,
      occupancy_claim_class, permission_scope_version, permission_scope_json,
      status, claim_id, delivery, reason, claimed_at, settled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const kind of GENERATION_EFFECT_KINDS) {
    const unsupportedChatOnlyScope =
      generationScopeIsChatOnly(input.generationScope) && (kind === 'plugin_output' || kind === 'emotion_image_state')
    const notConfigured = kind === 'igp' && chatOnlyIgpConfigured === false
    const skipped = unsupportedChatOnlyScope || notConfigured
    const reason = unsupportedChatOnlyScope ? 'unsupported_chat_only_scope' : notConfigured ? 'not_configured' : null
    insert.run(
      input.databaseLineage,
      keyType,
      keyId,
      kind,
      EFFECT_CLASS[kind],
      input.operationId,
      input.operationAttemptNo ?? null,
      input.generationId,
      input.characterId,
      input.chatId,
      input.messageId,
      terminalTranscriptFingerprint,
      ...scopeSqlValues(input.generationScope),
      skipped ? 'skipped' : 'pending',
      skipped ? 'scope-filter' : null,
      skipped ? 'server' : null,
      reason,
      skipped ? now : null,
      skipped ? now : null,
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

/**
 * Return an answer only when the accepted operation retained a readable
 * immutable configuration. An absent or malformed snapshot must not guess that
 * IGP was disabled: leaving the effect pending preserves the recovery fence.
 */
function acceptedIgpConfigured(db: DatabaseSync, databaseLineage: string, operationId: string): boolean | undefined {
  const row = db
    .prepare(
      `SELECT effective_configuration_json AS effectiveConfigurationJson, effective_configuration_fingerprint AS fingerprint
       FROM generation_operations
       WHERE database_lineage = ? AND operation_id = ?`,
    )
    .get(databaseLineage, operationId) as
    | { effectiveConfigurationJson: string | null; fingerprint: string | null }
    | undefined
  if (!row?.effectiveConfigurationJson) return undefined
  try {
    const configuration = resolveGenerationConfiguration(
      db,
      JSON.parse(row.effectiveConfigurationJson),
      row.fingerprint ?? undefined,
    )
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return undefined
    const database = (configuration as { database?: unknown }).database
    if (!database || typeof database !== 'object' || Array.isArray(database)) return undefined
    const prompt = (database as { igpPrompt?: unknown }).igpPrompt
    return typeof prompt === 'string' && prompt.trim().length > 0
  } catch {
    return undefined
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

/** Pending browser work, optionally narrowed to one recovery session. */
export function listPendingClientGenerationEffects(
  db: DatabaseSync,
  databaseLineage = getDatabaseLineage(db),
  now: string | Date = new Date(),
  options: ListPendingClientGenerationEffectsOptions = { includeLegacyOwner: true },
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
  )
    .map(projectionFromRow)
    .filter((effect) => generationEffectVisibleToRecoverySession(db, effect, options))
}

function generationEffectVisibleToRecoverySession(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
  options: ListPendingClientGenerationEffectsOptions,
): boolean {
  if (!effect.generationScope || effect.generationScope.admissionKind === 'legacy_owner') {
    return options.includeLegacyOwner === true
  }
  return (
    typeof options.sessionId === 'string' &&
    options.sessionId.length > 0 &&
    effect.generationScope.occupancySessionId === options.sessionId &&
    generationEffectHasExactAcceptedOperationBinding(db, effect)
  )
}

/**
 * Verify that a modern effect retained the same target and immutable authority
 * as both its accepted operation and the exact accepted attempt. This is used
 * at recovery/commit boundaries where trusting only the ledger row would let a
 * corrupt or partially migrated row widen completion authority.
 */
export function generationEffectHasExactAcceptedOperationBinding(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
): boolean {
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind === 'legacy_owner' ||
    effect.keyType !== 'operation' ||
    effect.operationId === undefined ||
    effect.keyId !== effect.operationId ||
    effect.operationAttemptNo === undefined
  ) {
    return false
  }
  const row = db
    .prepare(
      `SELECT o.protocol_version AS protocolVersion,
              o.character_id AS characterId, o.chat_id AS chatId,
              o.result_message_id AS resultMessageId, o.state AS operationState,
              o.creator_writer_session_id AS creatorSessionId,
              o.admission_kind, o.occupancy_database_lineage,
              o.occupancy_session_id, o.occupancy_epoch, o.occupancy_claim_class,
              o.permission_scope_version, o.permission_scope_json,
              a.job_id AS jobId,
              a.status AS attemptStatus,
              a.actor_writer_session_id AS attemptActorSessionId,
              a.finalization_generation_id AS finalizationGenerationId,
              a.accepted_admission_kind AS attempt_admission_kind,
              a.accepted_occupancy_database_lineage AS attempt_occupancy_database_lineage,
              a.accepted_occupancy_session_id AS attempt_occupancy_session_id,
              a.accepted_occupancy_epoch AS attempt_occupancy_epoch,
              a.accepted_occupancy_claim_class AS attempt_occupancy_claim_class,
              a.accepted_permission_scope_version AS attempt_permission_scope_version,
              a.accepted_permission_scope_json AS attempt_permission_scope_json
       FROM generation_operations AS o
       JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = ?
       WHERE o.database_lineage = ? AND o.operation_id = ?`,
    )
    .get(effect.operationAttemptNo, effect.databaseLineage, effect.operationId) as unknown as
    | (GenerationScopeColumns & {
        protocolVersion: number
        characterId: string | null
        chatId: string | null
        resultMessageId: string | null
        operationState: string
        creatorSessionId: string
        jobId: string
        attemptStatus: string
        attemptActorSessionId: string
        finalizationGenerationId: string | null
        attempt_admission_kind: GenerationScopeColumns['admission_kind']
        attempt_occupancy_database_lineage: string | null
        attempt_occupancy_session_id: string | null
        attempt_occupancy_epoch: number | null
        attempt_occupancy_claim_class: GenerationScopeColumns['occupancy_claim_class']
        attempt_permission_scope_version: number | null
        attempt_permission_scope_json: string | null
      })
    | undefined
  if (!row) return false
  const attemptScope = scopeFromColumns({
    admission_kind: row.attempt_admission_kind,
    occupancy_database_lineage: row.attempt_occupancy_database_lineage,
    occupancy_session_id: row.attempt_occupancy_session_id,
    occupancy_epoch: row.attempt_occupancy_epoch,
    occupancy_claim_class: row.attempt_occupancy_claim_class,
    permission_scope_version: row.attempt_permission_scope_version,
    permission_scope_json: row.attempt_permission_scope_json,
  })
  return (
    row.protocolVersion >= 1 &&
    row.operationState === 'completed' &&
    row.attemptStatus === 'completed' &&
    row.characterId === effect.characterId &&
    row.chatId === effect.chatId &&
    row.resultMessageId === effect.messageId &&
    scope.occupancyDatabaseLineage === effect.databaseLineage &&
    row.creatorSessionId === scope.occupancySessionId &&
    row.attemptActorSessionId === scope.occupancySessionId &&
    (row.finalizationGenerationId === effect.generationId ||
      (row.finalizationGenerationId === null && row.jobId === effect.generationId)) &&
    generationScopesEqual(scopeFromColumns(row), scope) &&
    generationScopesEqual(attemptScope, scope)
  )
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function generationEffectTerminalTranscriptFingerprint(
  messages: readonly unknown[],
  alternateMessages: readonly unknown[],
  targetMessageId: string,
): string {
  const canonical = messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message
    const record = message as Record<string, unknown>
    if (record.chatId !== targetMessageId || !Object.hasOwn(record, 'translation')) return message
    const { translation: _authorizedGeneratedTranslation, ...unchanged } = record
    return unchanged
  })
  return sha256Json({ active: canonical, alternates: alternateMessages })
}

function acceptedOwnerInlayMode(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
): 'emotion' | 'imggen' | undefined {
  if (effect.operationId === undefined || effect.operationAttemptNo === undefined) return undefined
  const accepted = getGenerationOperationAttemptAcceptedConfiguration(
    db,
    effect.databaseLineage,
    effect.operationId,
    effect.operationAttemptNo,
  )
  if (!accepted) return undefined
  try {
    accepted.effectiveConfiguration = resolveGenerationConfiguration(
      db,
      accepted.effectiveConfiguration,
      accepted.effectiveConfigurationFingerprint,
    )
  } catch {
    return undefined
  }
  if (
    !accepted.effectiveConfiguration ||
    typeof accepted.effectiveConfiguration !== 'object' ||
    Array.isArray(accepted.effectiveConfiguration)
  ) {
    return undefined
  }
  const database = (accepted.effectiveConfiguration as Record<string, unknown>).database
  if (!database || typeof database !== 'object' || Array.isArray(database)) return undefined
  const characters = (database as Record<string, unknown>).characters
  if (!Array.isArray(characters)) return undefined
  const matches = characters.filter(
    (character): character is Record<string, unknown> =>
      !!character &&
      typeof character === 'object' &&
      !Array.isArray(character) &&
      (character as Record<string, unknown>).chaId === effect.characterId,
  )
  const character = matches[0]
  if (matches.length !== 1 || !character || character.inlayViewScreen !== true) return undefined
  return character.viewScreen === 'emotion' || character.viewScreen === 'imggen' ? character.viewScreen : undefined
}

function exactGeneratedImageInlayAssetIds(expectedData: string, finalData: string): string[] | undefined {
  const sourcePattern = /<ImgGen="(.+?)">|\{\{ImgGen="(.+?)"\}\}/gi
  const matches = Array.from(expectedData.matchAll(sourcePattern))
  if (matches.length === 0 || finalData === expectedData) return undefined

  let sourceOffset = 0
  let candidates = new Map<number, string[]>([[0, []]])
  for (const match of matches) {
    const matchOffset = match.index
    if (matchOffset === undefined) return undefined
    const literal = expectedData.slice(sourceOffset, matchOffset)
    const next = new Map<number, string[]>()
    for (const [candidateOffset, assetIds] of candidates) {
      if (!finalData.startsWith(literal, candidateOffset)) continue
      const replacementOffset = candidateOffset + literal.length
      const replacement = /^\{\{inlay::([0-9a-f]{64})\}\}/.exec(finalData.slice(replacementOffset))
      if (replacement) {
        next.set(replacementOffset + replacement[0].length, [...assetIds, replacement[1]])
      }
    }
    if (next.size === 0) return undefined
    candidates = next
    sourceOffset = matchOffset + match[0].length
  }
  const trailing = expectedData.slice(sourceOffset)
  for (const [candidateOffset, assetIds] of candidates) {
    if (assetIds.length === matches.length && finalData.slice(candidateOffset) === trailing) return assetIds
  }
  return undefined
}

function exactSupportedOwnerInlayTransformation(
  db: DatabaseSync,
  mode: 'emotion' | 'imggen',
  expectedData: string,
  finalData: string,
): boolean {
  if (mode === 'emotion') {
    return finalData !== expectedData && finalData === expectedData.replace(/<Emotion="(.+?)">/gi, '{{emotion::$1}}')
  }
  const assetIds = exactGeneratedImageInlayAssetIds(expectedData, finalData)
  if (!assetIds) return false
  return assetIds.every((assetId) => {
    const asset = db.prepare('SELECT content_type AS contentType FROM assets WHERE id = ?').get(assetId) as
      | { contentType: string }
      | undefined
    return asset?.contentType.startsWith('image/') === true
  })
}

function ownerInlaySourceMatchesMode(mode: 'emotion' | 'imggen', data: string): boolean {
  return mode === 'emotion' ? /<Emotion="(.+?)">/i.test(data) : /<ImgGen="(.+?)">|\{\{ImgGen="(.+?)"\}\}/i.test(data)
}

type PreparedGenerationInlayDisposition = 'none' | 'ready' | 'stale' | 'invalid'

function preparedGenerationInlayDisposition(
  db: DatabaseSync,
  row: GenerationEffectRow,
): PreparedGenerationInlayDisposition {
  const preparationId = row.inlay_preparation_id
  const expectedData = row.inlay_preparation_expected_data
  if (preparationId === null && expectedData === null) return 'none'
  if (preparationId === null || expectedData === null || row.effect_kind !== 'igp' || row.status !== 'pending') {
    return 'invalid'
  }
  const effect = projectionFromRow(row)
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind !== 'owner_occupancy' ||
    scope.occupancyClaimClass !== 'owner' ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    return 'invalid'
  }
  const mode = acceptedOwnerInlayMode(db, effect)
  if (!mode || !ownerInlaySourceMatchesMode(mode, expectedData)) return 'invalid'
  const resolved = resolveActiveMessageLocationById(db, effect.messageId)
  if (
    resolved.ok === false ||
    resolved.location.chatId !== effect.chatId ||
    resolved.location.message.role !== 'char'
  ) {
    return 'invalid'
  }
  if (
    resolved.location.message.data !== expectedData ||
    !generationEffectHasExactTerminalTranscriptBinding(db, effect, getChatMessages(db, effect.chatId))
  ) {
    return 'stale'
  }
  return 'ready'
}

/**
 * Reserve the exact operation-bound owner inlay before any browser image
 * provider starts. The marker lives on the dependent IGP row, so every live
 * or recovered IGP claim observes the same SQLite serialization point.
 */
export function beginAuthorizedGenerationInlayPreparationInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    operationId: string
    characterId: string
    chatId: string
    messageId: string
    preparationId: string
    expectedData: string
  },
): 'prepared' | undefined {
  if (!db.isTransaction) throw new Error('Generation inlay preparation requires the message command transaction')
  assertDatabaseLineage(db, input.databaseLineage)
  const row = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp' AND operation_id = ?",
    [input.databaseLineage, input.generationId, input.operationId],
  )[0]
  if (!row || row.status !== 'pending') return undefined
  const effect = projectionFromRow(row)
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind !== 'owner_occupancy' ||
    scope.occupancyClaimClass !== 'owner' ||
    effect.characterId !== input.characterId ||
    effect.chatId !== input.chatId ||
    effect.messageId !== input.messageId ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    return undefined
  }
  const mode = acceptedOwnerInlayMode(db, effect)
  if (!mode || !ownerInlaySourceMatchesMode(mode, input.expectedData)) return undefined
  const messages = getChatMessages(db, input.chatId)
  const targets = messages.filter((message) => message.chatId === input.messageId)
  if (
    targets.length !== 1 ||
    targets[0]?.role !== 'char' ||
    targets[0].data !== input.expectedData ||
    !generationEffectHasExactTerminalTranscriptBinding(db, effect, messages)
  ) {
    return undefined
  }
  if (row.inlay_preparation_id !== null || row.inlay_preparation_expected_data !== null) {
    return row.inlay_preparation_id === input.preparationId &&
      row.inlay_preparation_expected_data === input.expectedData
      ? 'prepared'
      : undefined
  }
  const prepared = db
    .prepare(
      `UPDATE generation_effects
       SET inlay_preparation_id = ?, inlay_preparation_expected_data = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'
         AND operation_id = ? AND status = 'pending'
         AND inlay_preparation_id IS NULL AND inlay_preparation_expected_data IS NULL`,
    )
    .run(
      input.preparationId,
      input.expectedData,
      normalizeTimestamp(),
      input.databaseLineage,
      input.generationId,
      input.operationId,
    )
  if (prepared.changes !== 1) return undefined
  recordTableWrite('generation_effects')
  return 'prepared'
}

/** Clear only the exact unfinished browser provider obligation; no transcript
 * field is accepted from the caller and no message is written. */
export function abandonAuthorizedGenerationInlayPreparationInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    operationId: string
    characterId: string
    chatId: string
    messageId: string
    preparationId: string
  },
): 'abandoned' | undefined {
  if (!db.isTransaction) throw new Error('Generation inlay abandonment requires the message command transaction')
  assertDatabaseLineage(db, input.databaseLineage)
  const row = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp' AND operation_id = ?",
    [input.databaseLineage, input.generationId, input.operationId],
  )[0]
  if (!row || row.status !== 'pending') return undefined
  const effect = projectionFromRow(row)
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind !== 'owner_occupancy' ||
    scope.occupancyClaimClass !== 'owner' ||
    effect.characterId !== input.characterId ||
    effect.chatId !== input.chatId ||
    effect.messageId !== input.messageId ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect) ||
    row.inlay_preparation_id !== input.preparationId ||
    row.inlay_preparation_expected_data === null
  ) {
    return undefined
  }
  const abandoned = db
    .prepare(
      `UPDATE generation_effects
       SET inlay_preparation_id = NULL, inlay_preparation_expected_data = NULL, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'
         AND operation_id = ? AND status = 'pending' AND inlay_preparation_id = ?
         AND inlay_preparation_expected_data IS NOT NULL`,
    )
    .run(normalizeTimestamp(), input.databaseLineage, input.generationId, input.operationId, input.preparationId)
  if (abandoned.changes !== 1) return undefined
  recordTableWrite('generation_effects')
  return 'abandoned'
}

/**
 * Classify a persisted deferred inlay without granting it any new authority.
 * Once the exact accepted operation/effect tuple and deterministic transform
 * still validate, any drift from the immutable terminal transcript makes the
 * old inlay and its dependent IGP permanently stale. Retiring those effects is
 * fail-closed: it does not write either the old or derived transcript.
 *
 * Partial payloads, corrupt scope/bindings, and missing or ambiguous targets
 * remain invalid so recovery cannot convert uncertain persistence into a stale
 * acknowledgement.
 */
export function deferredGenerationInlayFinalizationDisposition(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
  },
): DeferredGenerationInlayFinalizationDisposition {
  const translation = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [input.databaseLineage, input.generationId],
  )[0]
  if (!translation) return 'invalid'
  const expectedData = translation.deferred_inlay_expected_data
  const finalData = translation.deferred_inlay_final_data
  if (expectedData === null && finalData === null) return 'none'
  if (expectedData === null || finalData === null || translation.operation_id === null) return 'invalid'

  const igp = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp' AND operation_id = ?",
    [input.databaseLineage, input.generationId, translation.operation_id],
  )[0]
  if (!igp || igp.status !== 'pending') return 'invalid'
  const effect = projectionFromRow(igp)
  const translationEffect = projectionFromRow(translation)
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind !== 'owner_occupancy' ||
    scope.occupancyClaimClass !== 'owner' ||
    translationEffect.keyType !== effect.keyType ||
    translationEffect.keyId !== effect.keyId ||
    translationEffect.operationId !== effect.operationId ||
    translationEffect.operationAttemptNo !== effect.operationAttemptNo ||
    translationEffect.characterId !== effect.characterId ||
    translationEffect.chatId !== effect.chatId ||
    translationEffect.messageId !== effect.messageId ||
    translation.terminal_transcript_fingerprint !== igp.terminal_transcript_fingerprint ||
    !generationScopesEqual(translationEffect.generationScope, effect.generationScope) ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    return 'invalid'
  }
  const mode = acceptedOwnerInlayMode(db, effect)
  if (!mode || !exactSupportedOwnerInlayTransformation(db, mode, expectedData, finalData)) return 'invalid'

  const resolved = resolveActiveMessageLocationById(db, effect.messageId)
  if (
    resolved.ok === false ||
    resolved.location.chatId !== effect.chatId ||
    resolved.location.message.role !== 'char'
  ) {
    return 'invalid'
  }
  return generationEffectHasExactTerminalTranscriptBinding(db, effect, getChatMessages(db, effect.chatId))
    ? 'ready'
    : 'stale'
}

/**
 * Commit the browser-owned display inlay transformation only when it is the
 * exact deterministic successor of a modern owner operation's immutable
 * terminal transcript. Advancing the ledger fingerprints in the same
 * transaction lets the later IGP effect consume this one authorized state;
 * an ordinary transcript edit has no such path and remains stale.
 */
export function commitAuthorizedGenerationInlayFinalizationInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    operationId: string
    characterId: string
    chatId: string
    messageId: string
    expectedData: string
    finalData: string
    preparationId?: string
  },
): 'committed' | 'deferred' | undefined {
  if (!db.isTransaction) throw new Error('Generation inlay finalization requires the message command transaction')
  assertDatabaseLineage(db, input.databaseLineage)
  const row = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp' AND operation_id = ?",
    [input.databaseLineage, input.generationId, input.operationId],
  )[0]
  if (!row || row.status !== 'pending') return undefined
  const hasPreparation = row.inlay_preparation_id !== null || row.inlay_preparation_expected_data !== null
  if (
    (hasPreparation &&
      (input.preparationId === undefined ||
        row.inlay_preparation_id !== input.preparationId ||
        row.inlay_preparation_expected_data !== input.expectedData)) ||
    (!hasPreparation && input.preparationId !== undefined)
  ) {
    return undefined
  }
  const effect = projectionFromRow(row)
  const scope = effect.generationScope
  if (
    !scope ||
    scope.admissionKind !== 'owner_occupancy' ||
    scope.occupancyClaimClass !== 'owner' ||
    effect.characterId !== input.characterId ||
    effect.chatId !== input.chatId ||
    effect.messageId !== input.messageId ||
    !generationEffectHasExactAcceptedOperationBinding(db, effect)
  ) {
    return undefined
  }
  const messages = getChatMessages(db, input.chatId)
  const targets = messages.filter((message) => message.chatId === input.messageId)
  if (
    targets.length !== 1 ||
    targets[0]?.role !== 'char' ||
    targets[0].data !== input.expectedData ||
    !generationEffectHasExactTerminalTranscriptBinding(db, effect, messages)
  ) {
    return undefined
  }
  const mode = acceptedOwnerInlayMode(db, effect)
  if (!mode || !exactSupportedOwnerInlayTransformation(db, mode, input.expectedData, input.finalData)) return undefined

  const translation = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [input.databaseLineage, input.generationId],
  )[0]
  if (translation && (translation.status === 'pending' || translation.status === 'claimed')) {
    if (!hasUnfinishedGeneratedTranslationPrerequisite(db, row)) return undefined
    if (
      (translation.deferred_inlay_expected_data !== null &&
        translation.deferred_inlay_expected_data !== input.expectedData) ||
      (translation.deferred_inlay_final_data !== null && translation.deferred_inlay_final_data !== input.finalData)
    ) {
      return undefined
    }
    const deferred = db
      .prepare(
        `UPDATE generation_effects
         SET deferred_inlay_expected_data = ?, deferred_inlay_final_data = ?, updated_at = ?
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'
           AND status IN ('pending', 'claimed')
           AND (deferred_inlay_expected_data IS NULL OR deferred_inlay_expected_data = ?)
           AND (deferred_inlay_final_data IS NULL OR deferred_inlay_final_data = ?)`,
      )
      .run(
        input.expectedData,
        input.finalData,
        normalizeTimestamp(),
        input.databaseLineage,
        input.generationId,
        input.expectedData,
        input.finalData,
      )
    if (deferred.changes !== 1) return undefined
    if (input.preparationId !== undefined) {
      const consumed = db
        .prepare(
          `UPDATE generation_effects
           SET inlay_preparation_id = NULL, inlay_preparation_expected_data = NULL, updated_at = ?
           WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'
             AND operation_id = ? AND status = 'pending'
             AND inlay_preparation_id = ? AND inlay_preparation_expected_data = ?`,
        )
        .run(
          normalizeTimestamp(),
          input.databaseLineage,
          input.generationId,
          input.operationId,
          input.preparationId,
          input.expectedData,
        )
      if (consumed.changes !== 1) return undefined
    }
    recordTableWrite('generation_effects')
    return 'deferred'
  }

  if (
    translation &&
    ((translation.deferred_inlay_expected_data !== null &&
      translation.deferred_inlay_expected_data !== input.expectedData) ||
      (translation.deferred_inlay_final_data !== null && translation.deferred_inlay_final_data !== input.finalData))
  ) {
    return undefined
  }

  const targetTranslation = targets[0]?.translation
  let rebasedTranslation = targetTranslation
  if (targetTranslation !== undefined && targetTranslation !== null) {
    if (
      typeof targetTranslation !== 'object' ||
      Array.isArray(targetTranslation) ||
      (targetTranslation as Record<string, unknown>).source !== 'raw' ||
      (targetTranslation as Record<string, unknown>).sourceHash !==
        createHash('sha256').update(input.expectedData).digest('hex')
    ) {
      return undefined
    }
    rebasedTranslation = {
      ...(targetTranslation as Record<string, unknown>),
      sourceHash: createHash('sha256').update(input.finalData).digest('hex'),
    }
  }
  const updated = updateActiveMessageById(db, input.messageId, {
    data: input.finalData,
    ...(targetTranslation !== undefined ? { translation: rebasedTranslation } : {}),
  })
  if (updated.ok === false || updated.chatId !== input.chatId) return undefined
  const fingerprint = generationEffectTerminalTranscriptFingerprint(
    getChatMessages(db, input.chatId),
    getAlternateMessages(db, input.chatId),
    input.messageId,
  )
  const updatedTarget = getChatMessages(db, input.chatId).find((message) => message.chatId === input.messageId)
  const authorizedTranslationFingerprint =
    updatedTarget && Object.hasOwn(updatedTarget, 'translation') ? sha256Json(updatedTarget.translation) : null
  const advanced = db
    .prepare(
      `UPDATE generation_effects
       SET terminal_transcript_fingerprint = ?,
           authorized_translation_fingerprint = CASE
             WHEN effect_kind = 'generated_translation' AND status = 'completed' AND delivery = 'server' THEN ?
             ELSE authorized_translation_fingerprint
           END,
           deferred_inlay_expected_data = CASE
             WHEN effect_kind = 'generated_translation' THEN NULL
             ELSE deferred_inlay_expected_data
           END,
           deferred_inlay_final_data = CASE
             WHEN effect_kind = 'generated_translation' THEN NULL
             ELSE deferred_inlay_final_data
           END
       WHERE database_lineage = ? AND generation_id = ? AND operation_id = ?
         AND character_id = ? AND chat_id = ? AND message_id = ?`,
    )
    .run(
      fingerprint,
      authorizedTranslationFingerprint,
      input.databaseLineage,
      input.generationId,
      input.operationId,
      input.characterId,
      input.chatId,
      input.messageId,
    )
  if (advanced.changes < 1) return undefined
  if (input.preparationId !== undefined) {
    const consumed = db
      .prepare(
        `UPDATE generation_effects
         SET inlay_preparation_id = NULL, inlay_preparation_expected_data = NULL, updated_at = ?
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'
           AND operation_id = ? AND status = 'pending'
           AND inlay_preparation_id = ? AND inlay_preparation_expected_data = ?`,
      )
      .run(
        normalizeTimestamp(),
        input.databaseLineage,
        input.generationId,
        input.operationId,
        input.preparationId,
        input.expectedData,
      )
    if (consumed.changes !== 1) return undefined
  }
  recordTableWrite('generation_effects')
  return 'committed'
}

/**
 * Drain a previously validated owner inlay after generated translation reaches
 * a terminal receipt. The caller owns the surrounding targeted message
 * mutation, so the transcript write, revision, event, and receipt stay one
 * publication boundary.
 */
export function commitDeferredGenerationInlayFinalizationInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
  },
): DeferredGenerationInlayFinalizationDrainOutcome {
  if (!db.isTransaction) throw new Error('Deferred generation inlay finalization requires a message transaction')
  const translation = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [input.databaseLineage, input.generationId],
  )[0]
  if (!translation) return 'invalid'
  const expectedData = translation.deferred_inlay_expected_data
  const finalData = translation.deferred_inlay_final_data
  if (expectedData === null && finalData === null) return 'none'
  if (
    expectedData === null ||
    finalData === null ||
    (translation.status !== 'completed' && translation.status !== 'skipped' && translation.status !== 'failed') ||
    translation.operation_id === null
  ) {
    return 'invalid'
  }
  const disposition = deferredGenerationInlayFinalizationDisposition(db, input)
  if (disposition === 'stale') {
    const now = normalizeTimestamp()
    const cleared = db
      .prepare(
        `UPDATE generation_effects
         SET deferred_inlay_expected_data = NULL, deferred_inlay_final_data = NULL,
             reason = COALESCE(reason, ?), updated_at = ?
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'
           AND status IN ('completed', 'skipped', 'failed')
           AND deferred_inlay_expected_data = ? AND deferred_inlay_final_data = ?`,
      )
      .run(
        DEFERRED_GENERATION_INLAY_TARGET_STALE,
        now,
        input.databaseLineage,
        input.generationId,
        expectedData,
        finalData,
      )
    const skippedIgp = db
      .prepare(
        `UPDATE generation_effects
         SET status = 'skipped', claim_id = ?, delivery = 'server', reason = ?, last_error = NULL,
             claimed_at = ?, lease_expires_at = NULL, settled_at = ?, updated_at = ?
         WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'igp'
           AND operation_id = ? AND status = 'pending'`,
      )
      .run(
        randomUUID(),
        DEFERRED_GENERATION_INLAY_TARGET_STALE,
        now,
        now,
        now,
        input.databaseLineage,
        input.generationId,
        translation.operation_id,
      )
    if (cleared.changes !== 1 || skippedIgp.changes !== 1) return 'invalid'
    recordTableWrite('generation_effects')
    return 'stale'
  }
  if (disposition !== 'ready') return 'invalid'
  return commitAuthorizedGenerationInlayFinalizationInTransaction(db, {
    databaseLineage: input.databaseLineage,
    generationId: input.generationId,
    operationId: translation.operation_id,
    characterId: translation.character_id,
    chatId: translation.chat_id,
    messageId: translation.message_id,
    expectedData,
    finalData,
  }) === 'committed'
    ? 'committed'
    : 'invalid'
}

/**
 * Terminally settle a claimed generated translation when its exact deferred
 * inlay has already become stale. The failed/skipped translation receipt,
 * deferred payload retirement, and dependent IGP skip share one SQLite
 * transaction and do not touch the newer transcript.
 */
export function settleStaleDeferredGenerationInlayFinalization(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    claimId: string
    status: 'failed' | 'skipped'
    lastError?: string
  },
): DeferredGenerationInlayFinalizationDrainOutcome {
  return withImmediateTransaction(db, () => {
    if (deferredGenerationInlayFinalizationDisposition(db, input) !== 'stale') return 'invalid'
    const settled = settleGenerationEffect(db, {
      databaseLineage: input.databaseLineage,
      generationId: input.generationId,
      kind: 'generated_translation',
      claimId: input.claimId,
      status: input.status,
      reason: DEFERRED_GENERATION_INLAY_TARGET_STALE,
      lastError: input.lastError ?? null,
    })
    if (!settled) return 'invalid'
    recordTableWrite('generation_effects')
    const drained = commitDeferredGenerationInlayFinalizationInTransaction(db, input)
    if (drained !== 'stale') {
      throw new Error('Stale deferred generation inlay disposition changed inside its terminal transaction')
    }
    return drained
  })
}

export function generationEffectHasDeferredInlayFinalization(
  db: DatabaseSync,
  databaseLineage: string,
  generationId: string,
): boolean {
  const translation = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [databaseLineage, generationId],
  )[0]
  return Boolean(
    translation &&
    (translation.deferred_inlay_expected_data !== null || translation.deferred_inlay_final_data !== null),
  )
}

/** Retire an orphaned deferred inlay after the exact target has disappeared. */
export function clearDeferredGenerationInlayFinalization(
  db: DatabaseSync,
  databaseLineage: string,
  generationId: string,
): void {
  const cleared = db
    .prepare(
      `UPDATE generation_effects
       SET deferred_inlay_expected_data = NULL, deferred_inlay_final_data = NULL, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'
         AND (deferred_inlay_expected_data IS NOT NULL OR deferred_inlay_final_data IS NOT NULL)`,
    )
    .run(normalizeTimestamp(), databaseLineage, generationId)
  if (cleared.changes > 0) recordTableWrite('generation_effects')
}

function generationEffectHasExactAuthorizedTranslation(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
  translation: unknown,
): boolean {
  const row = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [effect.databaseLineage, effect.generationId],
  )[0]
  if (!row) return false
  const translationEffect = projectionFromRow(row)
  return (
    row.status === 'completed' &&
    row.delivery === 'server' &&
    typeof row.authorized_translation_fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(row.authorized_translation_fingerprint) &&
    row.authorized_translation_fingerprint === sha256Json(translation) &&
    translationEffect.keyType === effect.keyType &&
    translationEffect.keyId === effect.keyId &&
    translationEffect.operationId === effect.operationId &&
    translationEffect.operationAttemptNo === effect.operationAttemptNo &&
    translationEffect.characterId === effect.characterId &&
    translationEffect.chatId === effect.chatId &&
    translationEffect.messageId === effect.messageId &&
    generationScopesEqual(translationEffect.generationScope, effect.generationScope) &&
    generationEffectHasExactAcceptedOperationBinding(db, translationEffect)
  )
}

/**
 * Verify that the active transcript and reroll candidates are still the exact
 * post-assembly terminal state persisted by finalization. The sole canonical
 * exception is the target's exact server-receipted generated translation;
 * every other message field and alternate remains part of the fingerprint.
 */
export function generationEffectHasExactTerminalTranscriptBinding(
  db: DatabaseSync,
  effect: GenerationEffectProjection,
  messages: readonly unknown[],
): boolean {
  if (effect.operationId === undefined || effect.operationAttemptNo === undefined) return false
  const row = db
    .prepare(
      `SELECT terminal_transcript_fingerprint AS terminalTranscriptFingerprint
       FROM generation_effects
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?
         AND key_type = ? AND key_id = ? AND operation_id = ? AND operation_attempt_no = ?
         AND character_id = ? AND chat_id = ? AND message_id = ?`,
    )
    .get(
      effect.databaseLineage,
      effect.generationId,
      effect.kind,
      effect.keyType,
      effect.keyId,
      effect.operationId,
      effect.operationAttemptNo,
      effect.characterId,
      effect.chatId,
      effect.messageId,
    ) as { terminalTranscriptFingerprint: string | null } | undefined
  const targetMessages = messages.filter(
    (message) =>
      !!message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).chatId === effect.messageId,
  ) as Array<Record<string, unknown>>
  if (targetMessages.length !== 1) return false
  const targetTranslation = targetMessages[0]?.translation
  const translationReceipt = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [effect.databaseLineage, effect.generationId],
  )[0]
  if (
    (targetTranslation === undefined && translationReceipt?.authorized_translation_fingerprint !== null) ||
    (targetTranslation !== undefined && !generationEffectHasExactAuthorizedTranslation(db, effect, targetTranslation))
  ) {
    return false
  }
  return (
    typeof row?.terminalTranscriptFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(row.terminalTranscriptFingerprint) &&
    row.terminalTranscriptFingerprint ===
      generationEffectTerminalTranscriptFingerprint(messages, getAlternateMessages(db, effect.chatId), effect.messageId)
  )
}

/**
 * Automatic browser translation must not supersede the durable server job for
 * the exact generated row. Explicit translation commands remain independent:
 * they intentionally retain the ordinary last-registered-job semantics.
 */
export function automaticMessageTranslationIsServerOwned(
  db: DatabaseSync,
  messageId: string,
  databaseLineage = getDatabaseLineage(db),
): boolean {
  return selectGenerationEffectRows(
    db,
    `WHERE database_lineage = ? AND message_id = ? AND effect_kind = 'generated_translation'
       AND status IN ('pending', 'claimed', 'completed')
     ORDER BY created_at DESC`,
    [databaseLineage, messageId],
  ).some((row) => {
    const effect = projectionFromRow(row)
    return (
      generationEffectHasExactAcceptedOperationBinding(db, effect) &&
      generationEffectHasExactTerminalTranscriptBinding(db, effect, getChatMessages(db, effect.chatId))
    )
  })
}

function generationScopesEqual(
  left: PersistedGenerationScope | undefined,
  right: PersistedGenerationScope | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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
  if (!current) {
    // Completion publishes its ledger atomically. Missing rows for a completed
    // result were pruned, or recovery completed the operation without effects.
    // Use the existing terminal response so older clients do not retry forever.
    // Separate the attempt lookups to use the unique job index and the
    // finalization-generation index without scanning the operation history.
    const completed = db
      .prepare(
        `SELECT 1 FROM (
           SELECT database_lineage, operation_id FROM generation_operation_attempts WHERE job_id = ?
           UNION ALL
           SELECT database_lineage, operation_id FROM generation_operation_attempts
             INDEXED BY generation_operation_attempts_finalization_generation
             WHERE finalization_generation_id = ?
         ) AS attempt
         JOIN generation_operations AS operation
           ON operation.database_lineage = attempt.database_lineage
          AND operation.operation_id = attempt.operation_id
         WHERE operation.database_lineage = ? AND operation.state = 'completed'
           AND operation.result_message_id IS NOT NULL
         LIMIT 1`,
      )
      .get(input.generationId, input.generationId, input.databaseLineage)
    return { status: 'not_claimed', reason: completed ? 'already_receipted' : 'effect_not_found' }
  }
  if (input.messageId !== undefined && current.message_id !== input.messageId) {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'message_mismatch' }
  }
  if (input.delivery !== 'server' && !CLIENT_EFFECT_KINDS.has(input.kind)) {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'server_owned' }
  }
  if (input.delivery === 'server' && input.kind !== 'generated_translation') {
    return { status: 'not_claimed', effect: projectionFromRow(current), reason: 'client_owned' }
  }
  if (input.kind === 'igp') {
    const inlayPreparation = preparedGenerationInlayDisposition(db, current)
    if (inlayPreparation !== 'none') {
      return {
        status: 'not_claimed',
        effect: projectionFromRow(current),
        reason:
          inlayPreparation === 'invalid' ? GENERATION_INLAY_PREPARATION_INVALID : GENERATION_INLAY_PREREQUISITE_PENDING,
      }
    }
  }
  if (input.kind === 'igp' && hasUnfinishedGeneratedTranslationPrerequisite(db, current)) {
    return {
      status: 'not_claimed',
      effect: projectionFromRow(current),
      reason: GENERATED_TRANSLATION_PREREQUISITE_PENDING,
    }
  }
  const now = normalizeTimestamp(input.claimedAt)
  const leaseExpiresAt = claimLeaseExpiresAt(now, input.leaseMs)
  if (
    current.status === 'claimed' &&
    current.effect_class !== 'durable' &&
    (current.lease_expires_at === null || current.lease_expires_at <= now)
  ) {
    db.prepare(
      `UPDATE generation_effects
       SET status = 'skipped', reason = 'claim_lease_expired', lease_expires_at = NULL,
           settled_at = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?`,
    ).run(now, now, input.databaseLineage, input.generationId, input.kind)
    return {
      status: 'not_claimed',
      effect: projectionFromRow(requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind)),
      reason: 'already_receipted',
    }
  }
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

/**
 * Generated translation is an ordered predecessor of IGP because IGP can
 * change the translated row's source text. Keep the browser-owned effect
 * unclaimed while the exact modern sibling can still commit, including an
 * expired server claim that startup recovery may reclaim.
 */
function hasUnfinishedGeneratedTranslationPrerequisite(db: DatabaseSync, current: GenerationEffectRow): boolean {
  const currentEffect = projectionFromRow(current)
  if (!currentEffect.generationScope || currentEffect.generationScope.admissionKind === 'legacy_owner') return false
  const translation = selectGenerationEffectRows(
    db,
    "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation'",
    [current.database_lineage, current.generation_id],
  )[0]
  if (!translation || (translation.status !== 'pending' && translation.status !== 'claimed')) return false
  const translationEffect = projectionFromRow(translation)
  return (
    translationEffect.keyType === currentEffect.keyType &&
    translationEffect.keyId === currentEffect.keyId &&
    translationEffect.operationId === currentEffect.operationId &&
    translationEffect.operationAttemptNo === currentEffect.operationAttemptNo &&
    translationEffect.characterId === currentEffect.characterId &&
    translationEffect.chatId === currentEffect.chatId &&
    translationEffect.messageId === currentEffect.messageId &&
    translation.terminal_transcript_fingerprint === current.terminal_transcript_fingerprint &&
    generationScopesEqual(translationEffect.generationScope, currentEffect.generationScope)
  )
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
         AND status = 'claimed' AND claim_id = ?
         AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    )
    .run(leaseExpiresAt, now, input.databaseLineage, input.generationId, input.kind, input.claimId, now)
  if (result.changes !== 1) return undefined
  return projectionFromRow(requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind))
}

export interface GenerationEffectSweepOptions {
  now?: string | Date
  maxPerSweep?: number
}

export interface PruneSettledGenerationEffectsOptions extends GenerationEffectSweepOptions {
  retentionMs?: number
}

function generationEffectSweepLimit(value = GENERATION_EFFECT_MAINTENANCE_SWEEP_LIMIT): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('maxPerSweep must be a positive safe integer')
  return value
}

/** Abandoned one-shot effects must never be delivered again, including after restart. */
export function settleExpiredNonDurableGenerationEffectClaims(
  db: DatabaseSync,
  options: GenerationEffectSweepOptions = {},
): number {
  const now = normalizeTimestamp(options.now)
  const result = db
    .prepare(
      `UPDATE generation_effects
       SET status = 'skipped', reason = 'claim_lease_expired', lease_expires_at = NULL,
           settled_at = ?, updated_at = ?
       WHERE rowid IN (
         SELECT rowid FROM generation_effects INDEXED BY generation_effects_recoverable_claims
         WHERE database_lineage = ? AND status = 'claimed'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           AND effect_kind IN ('notification', 'tts', 'completion_sound', 'emotion_image_state')
         ORDER BY lease_expires_at, effect_kind
         LIMIT ?
       )`,
    )
    .run(now, now, getDatabaseLineage(db), now, generationEffectSweepLimit(options.maxPerSweep))
  return Number(result.changes)
}

/** Keep receipts until neither the operation nor a sibling effect can still use them. */
export function pruneSettledGenerationEffects(
  db: DatabaseSync,
  options: PruneSettledGenerationEffectsOptions = {},
): number {
  const retentionMs = options.retentionMs ?? GENERATION_EFFECT_TERMINAL_RETENTION_MS
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error('retentionMs must be a non-negative safe integer')
  }
  const maxPerSweep = generationEffectSweepLimit(options.maxPerSweep)
  const cutoff = new Date(Date.parse(normalizeTimestamp(options.now)) - retentionMs).toISOString()
  const result = db
    .prepare(
      `DELETE FROM generation_effects WHERE rowid IN (
         SELECT effect.rowid FROM generation_effects AS effect INDEXED BY generation_effects_settled_retention
         WHERE effect.database_lineage = ? AND effect.status IN ('completed', 'skipped', 'failed')
           AND COALESCE(effect.settled_at, effect.updated_at) < ?
           AND NOT EXISTS (
             SELECT 1 FROM generation_operations AS operation
             WHERE operation.database_lineage = effect.database_lineage
               AND operation.operation_id = effect.operation_id
               AND operation.state NOT IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')
           )
           AND NOT EXISTS (
             SELECT 1 FROM generation_finalization_retries AS retry
             WHERE retry.database_lineage = effect.database_lineage
               AND retry.operation_id = effect.operation_id AND retry.status = 'pending'
           )
           AND NOT EXISTS (
             SELECT 1 FROM generation_effects AS sibling
             WHERE sibling.database_lineage = effect.database_lineage
               AND sibling.generation_id = effect.generation_id AND sibling.status IN ('pending', 'claimed')
           )
         ORDER BY COALESCE(effect.settled_at, effect.updated_at), effect.rowid
         LIMIT ?
       )`,
    )
    .run(getDatabaseLineage(db), cutoff, maxPerSweep)
  return Number(result.changes)
}

export function settleGenerationEffect(
  db: DatabaseSync,
  input: SettleGenerationEffectInput,
): GenerationEffectProjection | undefined {
  const now = normalizeTimestamp(input.settledAt)
  let authorizedTranslationFingerprint: string | null = null
  if (input.kind === 'generated_translation' && input.status === 'completed') {
    const claimed = selectGenerationEffectRows(
      db,
      "WHERE database_lineage = ? AND generation_id = ? AND effect_kind = 'generated_translation' AND status = 'claimed' AND claim_id = ?",
      [input.databaseLineage, input.generationId, input.claimId],
    )[0]
    if (claimed) {
      const targets = getChatMessages(db, claimed.chat_id).filter((message) => message.chatId === claimed.message_id)
      const translation = targets.length === 1 ? targets[0]?.translation : undefined
      if (translation !== undefined) authorizedTranslationFingerprint = sha256Json(translation)
    }
  }
  const result = db
    .prepare(
      `UPDATE generation_effects
       SET status = ?, reason = ?, last_error = ?, authorized_translation_fingerprint = ?,
           settled_at = ?, updated_at = ?
       WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?
         AND status = 'claimed' AND claim_id = ?`,
    )
    .run(
      input.status,
      input.reason ?? null,
      input.lastError ?? null,
      authorizedTranslationFingerprint,
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
  const settled = projectionFromRow(
    requireGenerationEffectRow(db, input.databaseLineage, input.generationId, input.kind),
  )
  if (input.status === 'failed') {
    recordDiagnosticErrorForDatabase(
      db,
      { category: 'generation', level: 'error', stage: 'post-generation', outcome: 'failed', providerMayHaveRun: true },
      input.diagnosticError,
      {
        databaseLineage: input.databaseLineage,
        operationId: settled.operationId,
        attemptId: input.generationId,
        background: true,
      },
    )
  }
  return settled
}

/** Complete the generated-translation receipt in the message write transaction. */
export function completeClaimedGeneratedTranslationEffectInTransaction(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    generationId: string
    claimId: string
  },
): boolean {
  if (!db.isTransaction) throw new Error('Generated translation completion requires the message command transaction')
  const completed = settleGenerationEffect(db, {
    ...input,
    kind: 'generated_translation',
    status: 'completed',
  })
  if (!completed) return false
  recordTableWrite('generation_effects')
  return true
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
    /** Exact Continue-extend rows retain their accepted assistant metadata. */
    allowRetainedGenerationMetadata?: boolean
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

  let retainedContinueTarget = false
  if (input.allowRetainedGenerationMetadata === true) {
    const operation = db
      .prepare(
        `SELECT mode, request_origin AS requestOrigin, target_message_id AS targetMessageId,
                result_message_id AS resultMessageId
         FROM generation_operations
         WHERE database_lineage = ? AND operation_id = ?`,
      )
      .get(input.databaseLineage, effect.operation_id) as
      | { mode: string; requestOrigin: string; targetMessageId: string | null; resultMessageId: string | null }
      | undefined
    retainedContinueTarget = Boolean(
      operation?.mode === 'continue' &&
      operation.requestOrigin === 'continue' &&
      operation.targetMessageId === input.messageId &&
      operation.resultMessageId === input.messageId &&
      generationEffectHasExactAcceptedOperationBinding(db, projectionFromRow(effect)),
    )
    if (!retainedContinueTarget) return false
  }

  const info = input.message.generationInfo
  if (info !== undefined && !retainedContinueTarget) {
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
 * cancelled or failed terminals. The marker commits with the backfill so a
 * later restart never recreates receipts deleted by retention.
 */
export function reconcileGenerationEffectsAtStartup(db: DatabaseSync): number {
  return withImmediateTransaction(db, () => {
    const databaseLineage = getDatabaseLineage(db)
    const backfilled = db
      .prepare('SELECT 1 FROM database_metadata WHERE id = 1 AND generation_effects_backfill_lineage = ?')
      .get(databaseLineage)
    if (backfilled) return 0
    const rows = db
      .prepare(
        `SELECT o.operation_id AS operationId, o.protocol_version AS protocolVersion,
              o.character_id AS characterId, o.chat_id AS chatId,
              o.result_message_id AS messageId,
              a.attempt_no AS operationAttemptNo,
              COALESCE(a.finalization_generation_id, a.job_id) AS generationId,
              o.admission_kind, o.occupancy_database_lineage,
              o.occupancy_session_id, o.occupancy_epoch, o.occupancy_claim_class,
              o.permission_scope_version, o.permission_scope_json
       FROM generation_operations AS o
       LEFT JOIN generation_operation_attempts AS a
         ON a.database_lineage = o.database_lineage
        AND a.operation_id = o.operation_id
        AND a.attempt_no = (
          SELECT MAX(candidate.attempt_no)
          FROM generation_operation_attempts AS candidate
          WHERE candidate.database_lineage = o.database_lineage
            AND candidate.operation_id = o.operation_id
            AND candidate.status = 'completed'
        )
       WHERE o.database_lineage = ? AND o.state = 'completed'
         AND o.character_id IS NOT NULL AND o.chat_id IS NOT NULL
         AND o.result_message_id IS NOT NULL
         AND COALESCE(a.finalization_generation_id, a.job_id) IS NOT NULL`,
      )
      .all(databaseLineage) as unknown as Array<
      {
        operationId: string
        protocolVersion: number
        characterId: string
        chatId: string
        messageId: string
        operationAttemptNo: number
        generationId: string
      } & GenerationScopeColumns
    >
    let inserted = 0
    for (const row of rows) {
      const existingKinds = new Set(
        (
          db
            .prepare(
              `SELECT effect_kind AS effectKind FROM generation_effects
               WHERE database_lineage = ? AND generation_id = ?`,
            )
            .all(databaseLineage, row.generationId) as unknown as Array<{ effectKind: GenerationEffectKind }>
        ).map((effect) => effect.effectKind),
      )
      ensureGenerationEffectLedgerInTransaction(db, {
        databaseLineage,
        operationId: row.operationId,
        operationAttemptNo: row.operationAttemptNo,
        operationProtocolVersion: row.protocolVersion,
        generationId: row.generationId,
        characterId: row.characterId,
        chatId: row.chatId,
        messageId: row.messageId,
        generationScope: scopeFromColumns(row),
      })
      for (const kind of GENERATION_EFFECT_KINDS) {
        if (existingKinds.has(kind)) continue
        const now = new Date().toISOString()
        const settled = db
          .prepare(
            `UPDATE generation_effects
           SET status = 'skipped', claim_id = ?, delivery = 'server',
               reason = 'pre_ledger_terminal', last_error = NULL,
               claimed_at = ?, lease_expires_at = NULL, settled_at = ?, updated_at = ?
           WHERE database_lineage = ? AND generation_id = ? AND effect_kind = ?`,
          )
          .run(randomUUID(), now, now, now, databaseLineage, row.generationId, kind)
        inserted += Number(settled.changes)
      }
    }
    db.prepare('UPDATE database_metadata SET generation_effects_backfill_lineage = ? WHERE id = 1').run(databaseLineage)
    return inserted
  })
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
    ...(row.operation_attempt_no !== null ? { operationAttemptNo: row.operation_attempt_no } : {}),
    generationId: row.generation_id,
    characterId: row.character_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    ...(scopeFromColumns(row) ? { generationScope: scopeFromColumns(row)! } : {}),
    ...(row.inlay_preparation_id !== null ? { inlayPreparationId: row.inlay_preparation_id } : {}),
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
