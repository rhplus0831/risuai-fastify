import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FastifyBaseLogger } from 'fastify'
import { getDatabaseLineage } from './databaseLineage.js'
import {
  scopeFromColumns,
  scopeSqlValues,
  type GenerationScopeColumns,
  type PersistedGenerationScope,
} from './generationScope.js'
import { emitProtocolMetric, protocolDurationMs, protocolNowMs } from './protocolMetrics.js'

export const GENERATION_OPERATION_PROTOCOL_VERSION = 1
export const GENERATION_OPERATION_RECENT_TERMINAL_LIMIT = 100
export const GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES = 8 * 1024 * 1024

export const GENERATION_OPERATION_STATES = [
  'cancel_requested',
  'accepted',
  'launching',
  'owned_by_job',
  'stopping',
  'finalizing',
  'retryable',
  'abandoned',
  'completed',
  'cancelled',
  'terminal_failed',
  'invalidated',
] as const

export type GenerationOperationState = (typeof GENERATION_OPERATION_STATES)[number]
export type GenerationOperationRequestOrigin = 'unbound' | 'accepted_send' | 'continue' | 'regenerate' | 'legacy'
export type GenerationOperationMode = 'send' | 'continue' | 'regenerate'
export type GenerationOperationTerminalOutcome = 'completed' | 'cancelled'
export type GenerationOperationAttemptStatus =
  | 'reserved'
  | 'running'
  | 'stopping'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'retryable_failed'
  | 'terminal_failed'
  | 'abandoned'

const TERMINAL_STATES = new Set<GenerationOperationState>(['completed', 'cancelled', 'terminal_failed', 'invalidated'])
const ATTEMPT_OWNING_STATES = new Set<GenerationOperationState>(['launching', 'owned_by_job', 'stopping', 'finalizing'])
const STARTUP_RESULT_STATES = new Set<GenerationOperationState>([
  'accepted',
  'launching',
  'owned_by_job',
  'stopping',
  'finalizing',
  'retryable',
  'abandoned',
])

const ALLOWED_TRANSITIONS: Readonly<Record<GenerationOperationState, ReadonlySet<GenerationOperationState>>> = {
  cancel_requested: new Set(['cancelled', 'invalidated']),
  accepted: new Set(['launching', 'cancelled', 'abandoned', 'invalidated']),
  launching: new Set(['owned_by_job', 'retryable', 'terminal_failed', 'cancelled', 'abandoned', 'invalidated']),
  owned_by_job: new Set(['stopping', 'finalizing', 'retryable', 'terminal_failed', 'abandoned', 'invalidated']),
  stopping: new Set(['finalizing', 'cancelled', 'abandoned', 'invalidated']),
  finalizing: new Set(['completed', 'cancelled', 'terminal_failed', 'abandoned', 'invalidated']),
  retryable: new Set(['launching', 'terminal_failed', 'cancelled', 'invalidated']),
  abandoned: new Set(['launching', 'terminal_failed', 'cancelled', 'invalidated']),
  completed: new Set(),
  cancelled: new Set(),
  terminal_failed: new Set(),
  invalidated: new Set(),
}

const ATTEMPT_STATUS_BY_TRANSITION: Readonly<
  Partial<Record<GenerationOperationState, Partial<Record<GenerationOperationState, GenerationOperationAttemptStatus>>>>
> = {
  launching: {
    owned_by_job: 'running',
    retryable: 'retryable_failed',
    terminal_failed: 'terminal_failed',
    cancelled: 'cancelled',
    abandoned: 'abandoned',
    invalidated: 'terminal_failed',
  },
  owned_by_job: {
    stopping: 'stopping',
    finalizing: 'finalizing',
    retryable: 'retryable_failed',
    terminal_failed: 'terminal_failed',
    abandoned: 'abandoned',
    invalidated: 'terminal_failed',
  },
  stopping: {
    finalizing: 'finalizing',
    cancelled: 'cancelled',
    abandoned: 'abandoned',
    invalidated: 'terminal_failed',
  },
  finalizing: {
    completed: 'completed',
    cancelled: 'cancelled',
    terminal_failed: 'terminal_failed',
    abandoned: 'abandoned',
    invalidated: 'terminal_failed',
  },
}

interface GenerationOperationRow extends GenerationScopeColumns {
  database_lineage: string
  operation_id: string
  protocol_version: number
  request_origin: GenerationOperationRequestOrigin
  creator_writer_session_id: string
  creator_writer_epoch: number
  effective_configuration_json: string | null
  effective_configuration_fingerprint: string | null
  binding_server_instance_id: string | null
  character_id: string | null
  chat_id: string | null
  mode: GenerationOperationMode | null
  accepted_message_id: string | null
  target_message_id: string | null
  client_draft_generation_json: string | null
  accepted_revision: number | null
  state: GenerationOperationState
  state_version: number
  projection_epoch: number
  current_attempt_no: number | null
  desired_terminal_outcome: GenerationOperationTerminalOutcome | null
  result_message_id: string | null
  failure_code: string | null
  failure_phase: string | null
  last_error: string | null
  provider_may_have_run: 0 | 1
  cancel_requested_at: string | null
  runner_settled_at: string | null
  terminal_at: string | null
  created_at: string
  updated_at: string
  attempt_no: number | null
  retry_request_id: string | null
  job_id: string | null
  attempt_status: GenerationOperationAttemptStatus | null
  server_instance_id: string | null
  actor_writer_session_id: string | null
  actor_writer_epoch: number | null
  accepted_effective_configuration_fingerprint: string | null
  launch_revision: number | null
  provider_dispatch_started_at: string | null
  provider_dispatch_finished_at: string | null
  attempt_runner_settled_at: string | null
  finalization_generation_id: string | null
  attempt_failure_code: string | null
  attempt_last_error: string | null
  attempt_created_at: string | null
  attempt_updated_at: string | null
}

interface StartupOperationRow {
  database_lineage: string
  operation_id: string
  state: GenerationOperationState
  state_version: number
  current_attempt_no: number | null
  accepted_message_id: string | null
  desired_terminal_outcome: GenerationOperationTerminalOutcome | null
  provider_may_have_run: 0 | 1
}

interface StartupAttemptRow {
  database_lineage: string
  operation_id: string
  attempt_no: number
  job_id: string
  server_instance_id: string
  actor_writer_session_id: string
  actor_writer_epoch: number
  status: GenerationOperationAttemptStatus
  provider_dispatch_started_at: string | null
  finalization_generation_id: string | null
}

interface StartupJournalRow {
  database_lineage: string
  operation_id: string
  operation_attempt_no: number
  actor_writer_session_id: string
  actor_writer_epoch: number
  accepted_message_id: string | null
  terminal_outcome: GenerationOperationTerminalOutcome | null
  generation_id: string
}

export interface GenerationOperationAttemptProjection {
  attemptNo: number
  retryRequestId: string
  jobId: string
  status: GenerationOperationAttemptStatus
  serverInstanceId: string
  actorWriterSessionId: string
  actorWriterEpoch: number
  acceptedEffectiveConfigurationFingerprint?: string
  launchRevision: number
  providerDispatchStartedAt?: string
  providerDispatchFinishedAt?: string
  runnerSettledAt?: string
  finalizationGenerationId?: string
  failureCode?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface GenerationOperationProjection {
  operationId: string
  protocolVersion: number
  requestOrigin: GenerationOperationRequestOrigin
  state: GenerationOperationState
  stateVersion: number
  projectionEpoch: number
  creatorWriterSessionId: string
  creatorWriterEpoch: number
  generationScope?: PersistedGenerationScope
  effectiveConfigurationFingerprint?: string
  bindingServerInstanceId?: string
  characterId?: string
  chatId?: string
  mode?: GenerationOperationMode
  acceptedMessageId?: string
  targetMessageId?: string
  clientDraftGeneration?: unknown
  acceptedRevision?: number
  currentAttempt?: GenerationOperationAttemptProjection
  desiredTerminalOutcome?: GenerationOperationTerminalOutcome
  resultMessageId?: string
  failureCode?: string
  failurePhase?: string
  lastError?: string
  providerMayHaveRun: boolean
  cancelRequestedAt?: string
  runnerSettledAt?: string
  terminalAt?: string
  createdAt: string
  updatedAt: string
  recoveryDisposition?: 'retryable'
}

export interface CreateGenerationOperationInput {
  databaseLineage: string
  operationId: string
  protocolVersion: number
  requestOrigin: GenerationOperationRequestOrigin
  creatorWriterSessionId: string
  creatorWriterEpoch: number
  generationScope?: PersistedGenerationScope
  effectiveConfiguration?: unknown
  effectiveConfigurationFingerprint?: string | null
  bindingServerInstanceId?: string | null
  characterId?: string | null
  chatId?: string | null
  mode?: GenerationOperationMode | null
  acceptedMessageId?: string | null
  targetMessageId?: string | null
  clientDraftGeneration?: unknown
  requestFingerprint?: string | null
  intent?: unknown
  acceptedRevision?: number | null
  state: 'cancel_requested' | 'accepted'
  cancelRequestedAt?: string | null
  createdAt?: string
}

export interface GenerationOperationTransitionInput {
  databaseLineage: string
  operationId: string
  expectedState: GenerationOperationState
  expectedStateVersion: number
  nextState: GenerationOperationState
  desiredTerminalOutcome?: GenerationOperationTerminalOutcome | null
  resultMessageId?: string | null
  failureCode?: string | null
  failurePhase?: string | null
  lastError?: string | null
  providerMayHaveRun?: boolean
  cancelRequestedAt?: string | null
  runnerSettledAt?: string | null
  terminalAt?: string | null
  finalizationGenerationId?: string | null
  updatedAt?: string
}

export interface GenerationOperationStoredRequest {
  requestFingerprint?: string
  intent?: unknown
  effectiveConfiguration?: unknown
  effectiveConfigurationFingerprint?: string
}

export interface GenerationOperationAttemptAcceptedConfiguration {
  effectiveConfiguration: unknown
  effectiveConfigurationFingerprint: string
}

export interface GenerationOperationLineage {
  databaseLineage: string
  operationId: string
  attemptNo: number
  jobId: string
}

export interface ReserveGenerationOperationAttemptInput {
  databaseLineage: string
  operationId: string
  expectedState: 'accepted' | 'retryable' | 'abandoned'
  expectedStateVersion: number
  retryRequestId: string
  jobId: string
  serverInstanceId: string
  actorWriterSessionId: string
  actorWriterEpoch: number
  launchRevision: number
  createdAt?: string
}

export interface BindCancelledGenerationOperationInput {
  databaseLineage: string
  operationId: string
  expectedStateVersion: number
  requestOrigin: Exclude<GenerationOperationRequestOrigin, 'unbound' | 'legacy'>
  bindingServerInstanceId: string
  characterId: string
  chatId: string
  mode: GenerationOperationMode
  acceptedMessageId?: string | null
  targetMessageId?: string | null
  clientDraftGeneration?: unknown
  generationScope?: PersistedGenerationScope
  effectiveConfiguration?: unknown
  effectiveConfigurationFingerprint?: string | null
  requestFingerprint: string
  intent: unknown
  updatedAt?: string
}

export type GenerationOperationMutationResult =
  | { status: 'applied'; operation: GenerationOperationProjection }
  | { status: 'stale'; operation?: GenerationOperationProjection }

export type GenerationOperationAttemptReservationResult =
  | { status: 'applied' | 'replayed'; operation: GenerationOperationProjection }
  | { status: 'stale'; operation?: GenerationOperationProjection }

export interface GenerationOperationStartupSweepResult {
  projectionEpoch: number
  examinedOperationCount: number
  completedFromResultCount: number
  cancelledFromResultCount: number
  finalizingFromJournalCount: number
  abandonedOperationCount: number
  cancelledOperationCount: number
  abandonedAttemptCount: number
  changedOperationCount: number
}

export interface ExpiredGenerationOccupancyRecoveryInput {
  databaseLineage: string
  chatId: string
  occupantSessionId: string
  occupancyEpoch: number
  nowMs: number
}

export interface ExpiredGenerationOccupancyRecoveryResult {
  examinedOperationCount: number
  completedFromResultCount: number
  terminalFailedCount: number
  skippedEffectCount: number
}

export class InvalidGenerationOperationTransitionError extends Error {
  constructor(
    readonly from: GenerationOperationState,
    readonly to: GenerationOperationState,
  ) {
    super(`Invalid generation operation transition: ${from} -> ${to}`)
    this.name = 'InvalidGenerationOperationTransitionError'
  }
}

export class GenerationOperationAttemptConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationOperationAttemptConflictError'
  }
}

export class GenerationEffectiveConfigurationTooLargeError extends Error {
  readonly statusCode = 413
  readonly code = 'generation_effective_configuration_too_large'

  constructor(
    readonly actualBytes: number,
    readonly maxBytes = GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES,
  ) {
    super(`Effective generation configuration exceeds ${maxBytes} bytes`)
    this.name = 'GenerationEffectiveConfigurationTooLargeError'
  }
}

export function createGenerationOperationTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS generation_operations (
      database_lineage TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      protocol_version INTEGER NOT NULL CHECK (protocol_version >= 0),
      request_origin TEXT NOT NULL
        CHECK (request_origin IN ('unbound', 'accepted_send', 'continue', 'regenerate', 'legacy')),
      creator_writer_session_id TEXT NOT NULL,
      creator_writer_epoch INTEGER NOT NULL CHECK (creator_writer_epoch >= 0),
      pre_occupancy_authority INTEGER NOT NULL DEFAULT 0 CHECK (pre_occupancy_authority IN (0, 1)),
      admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only')),
      occupancy_database_lineage TEXT,
      occupancy_session_id TEXT,
      occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0),
      occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only')),
      permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0),
      permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json)),
      effective_configuration_json TEXT
        CHECK (effective_configuration_json IS NULL OR json_valid(effective_configuration_json)),
      effective_configuration_fingerprint TEXT,
      binding_server_instance_id TEXT,

      character_id TEXT,
      chat_id TEXT,
      mode TEXT CHECK (mode IS NULL OR mode IN ('send', 'continue', 'regenerate')),
      accepted_message_id TEXT,
      target_message_id TEXT,
      client_draft_generation_json TEXT
        CHECK (client_draft_generation_json IS NULL OR json_valid(client_draft_generation_json)),

      request_fingerprint TEXT,
      intent_json TEXT CHECK (intent_json IS NULL OR json_valid(intent_json)),
      accepted_revision INTEGER CHECK (accepted_revision IS NULL OR accepted_revision >= 0),

      state TEXT NOT NULL CHECK (state IN (
        'cancel_requested',
        'accepted',
        'launching',
        'owned_by_job',
        'stopping',
        'finalizing',
        'retryable',
        'abandoned',
        'completed',
        'cancelled',
        'terminal_failed',
        'invalidated'
      )),
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
      projection_epoch INTEGER NOT NULL CHECK (projection_epoch > 0),
      current_attempt_no INTEGER CHECK (current_attempt_no IS NULL OR current_attempt_no > 0),

      desired_terminal_outcome TEXT
        CHECK (desired_terminal_outcome IS NULL OR desired_terminal_outcome IN ('completed', 'cancelled')),
      result_message_id TEXT,
      failure_code TEXT,
      failure_phase TEXT,
      last_error TEXT,
      provider_may_have_run INTEGER NOT NULL DEFAULT 0 CHECK (provider_may_have_run IN (0, 1)),

      cancel_requested_at TEXT,
      runner_settled_at TEXT,
      terminal_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      PRIMARY KEY (database_lineage, operation_id),
      CHECK (
        (
          request_origin = 'unbound'
          AND state = 'cancel_requested'
          AND request_fingerprint IS NULL
          AND intent_json IS NULL
          AND binding_server_instance_id IS NULL
        )
        OR request_origin = 'legacy'
        OR (
          character_id IS NOT NULL
          AND chat_id IS NOT NULL
          AND mode IS NOT NULL
          AND request_fingerprint IS NOT NULL
          AND intent_json IS NOT NULL
          AND binding_server_instance_id IS NOT NULL
        )
      ),
      CHECK (
        admission_kind IS NULL
        OR admission_kind = 'legacy_owner'
        OR (
          occupancy_database_lineage IS NOT NULL AND occupancy_session_id IS NOT NULL
          AND occupancy_epoch IS NOT NULL AND occupancy_claim_class IS NOT NULL
          AND permission_scope_version IS NOT NULL AND permission_scope_json IS NOT NULL
        )
      ),
      CHECK (
        request_origin IN ('unbound', 'legacy')
        OR mode IS NULL OR mode <> 'send'
        OR accepted_message_id IS NOT NULL
      ),
      CHECK (
        request_origin IN ('unbound', 'legacy')
        OR (request_origin = 'accepted_send' AND mode = 'send')
        OR request_origin = mode
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS generation_operations_one_live_chat
      ON generation_operations (database_lineage, chat_id)
      WHERE state IN ('accepted', 'launching', 'owned_by_job', 'stopping');

    CREATE TABLE IF NOT EXISTS generation_operation_attempts (
      database_lineage TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      retry_request_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      server_instance_id TEXT NOT NULL,
      actor_writer_session_id TEXT NOT NULL,
      actor_writer_epoch INTEGER NOT NULL CHECK (actor_writer_epoch >= 0),
      accepted_admission_kind TEXT CHECK (accepted_admission_kind IS NULL OR accepted_admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only')),
      accepted_occupancy_database_lineage TEXT,
      accepted_occupancy_session_id TEXT,
      accepted_occupancy_epoch INTEGER CHECK (accepted_occupancy_epoch IS NULL OR accepted_occupancy_epoch >= 0),
      accepted_occupancy_claim_class TEXT CHECK (accepted_occupancy_claim_class IS NULL OR accepted_occupancy_claim_class IN ('owner', 'chat_only')),
      accepted_permission_scope_version INTEGER CHECK (accepted_permission_scope_version IS NULL OR accepted_permission_scope_version > 0),
      accepted_permission_scope_json TEXT CHECK (accepted_permission_scope_json IS NULL OR json_valid(accepted_permission_scope_json)),
      accepted_effective_configuration_fingerprint TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'reserved', 'running', 'stopping', 'finalizing',
        'completed', 'cancelled', 'retryable_failed',
        'terminal_failed', 'abandoned'
      )),
      launch_revision INTEGER NOT NULL CHECK (launch_revision >= 0),
      provider_dispatch_started_at TEXT,
      provider_dispatch_finished_at TEXT,
      runner_settled_at TEXT,
      finalization_generation_id TEXT,
      failure_code TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (database_lineage, operation_id, attempt_no),
      UNIQUE (database_lineage, retry_request_id),
      UNIQUE (job_id),
      FOREIGN KEY (database_lineage, operation_id)
        REFERENCES generation_operations(database_lineage, operation_id)
    );

    CREATE TABLE IF NOT EXISTS generation_operation_projection_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL CHECK (epoch >= 0)
    );
  `)
  ensureGenerationOperationScopeColumns(db)
  ensureGenerationOperationConfigurationColumns(db)
  ensureGenerationAttemptScopeColumns(db)
  db.prepare('INSERT OR IGNORE INTO generation_operation_projection_state (id, epoch) VALUES (1, 0)').run()
}

function ensureGenerationOperationConfigurationColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(generation_operations)').all() as Array<{ name: string }>).map((row) => row.name),
  )
  if (!existing.has('effective_configuration_json')) {
    db.exec(
      'ALTER TABLE generation_operations ADD COLUMN effective_configuration_json TEXT CHECK (effective_configuration_json IS NULL OR json_valid(effective_configuration_json))',
    )
  }
  if (!existing.has('effective_configuration_fingerprint')) {
    db.exec('ALTER TABLE generation_operations ADD COLUMN effective_configuration_fingerprint TEXT')
  }
}

function ensureGenerationOperationScopeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(generation_operations)').all() as Array<{ name: string }>).map((row) => row.name),
  )
  const columns: ReadonlyArray<readonly [string, string]> = [
    [
      'pre_occupancy_authority',
      'ALTER TABLE generation_operations ADD COLUMN pre_occupancy_authority INTEGER NOT NULL DEFAULT 0 CHECK (pre_occupancy_authority IN (0, 1))',
    ],
    [
      'admission_kind',
      "ALTER TABLE generation_operations ADD COLUMN admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only'))",
    ],
    ['occupancy_database_lineage', 'ALTER TABLE generation_operations ADD COLUMN occupancy_database_lineage TEXT'],
    ['occupancy_session_id', 'ALTER TABLE generation_operations ADD COLUMN occupancy_session_id TEXT'],
    [
      'occupancy_epoch',
      'ALTER TABLE generation_operations ADD COLUMN occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0)',
    ],
    [
      'occupancy_claim_class',
      "ALTER TABLE generation_operations ADD COLUMN occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only'))",
    ],
    [
      'permission_scope_version',
      'ALTER TABLE generation_operations ADD COLUMN permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0)',
    ],
    [
      'permission_scope_json',
      'ALTER TABLE generation_operations ADD COLUMN permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json))',
    ],
  ]
  for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
}

function ensureGenerationAttemptScopeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(generation_operation_attempts)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  )
  const columns: ReadonlyArray<readonly [string, string]> = [
    [
      'accepted_admission_kind',
      "ALTER TABLE generation_operation_attempts ADD COLUMN accepted_admission_kind TEXT CHECK (accepted_admission_kind IS NULL OR accepted_admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only'))",
    ],
    [
      'accepted_occupancy_database_lineage',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_occupancy_database_lineage TEXT',
    ],
    [
      'accepted_occupancy_session_id',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_occupancy_session_id TEXT',
    ],
    [
      'accepted_occupancy_epoch',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_occupancy_epoch INTEGER CHECK (accepted_occupancy_epoch IS NULL OR accepted_occupancy_epoch >= 0)',
    ],
    [
      'accepted_occupancy_claim_class',
      "ALTER TABLE generation_operation_attempts ADD COLUMN accepted_occupancy_claim_class TEXT CHECK (accepted_occupancy_claim_class IS NULL OR accepted_occupancy_claim_class IN ('owner', 'chat_only'))",
    ],
    [
      'accepted_permission_scope_version',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_permission_scope_version INTEGER CHECK (accepted_permission_scope_version IS NULL OR accepted_permission_scope_version > 0)',
    ],
    [
      'accepted_permission_scope_json',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_permission_scope_json TEXT CHECK (accepted_permission_scope_json IS NULL OR json_valid(accepted_permission_scope_json))',
    ],
    [
      'accepted_effective_configuration_fingerprint',
      'ALTER TABLE generation_operation_attempts ADD COLUMN accepted_effective_configuration_fingerprint TEXT',
    ],
  ]
  for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
}

export function getGenerationOperationProjectionEpoch(db: DatabaseSync): number {
  const row = db.prepare('SELECT epoch FROM generation_operation_projection_state WHERE id = 1').get() as
    | { epoch: number }
    | undefined
  if (!row || !Number.isSafeInteger(row.epoch) || row.epoch < 0) {
    throw new Error('generation operation projection state is missing or invalid')
  }
  return row.epoch
}

export function bumpGenerationOperationProjectionEpoch(db: DatabaseSync): number {
  const row = db
    .prepare('UPDATE generation_operation_projection_state SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch')
    .get() as { epoch: number } | undefined
  if (!row || !Number.isSafeInteger(row.epoch) || row.epoch <= 0) {
    throw new Error('generation operation projection state is missing or invalid')
  }
  return row.epoch
}

export function canonicalizeGenerationOperationSemantics(value: unknown): string {
  const seen = new Set<object>()
  const serialize = (entry: unknown, inArray: boolean): string | undefined => {
    if (entry === null) return 'null'
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry)
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new TypeError('Generation operation semantics must contain finite numbers')
      return JSON.stringify(entry)
    }
    if (typeof entry === 'undefined' || typeof entry === 'function' || typeof entry === 'symbol') {
      return inArray ? 'null' : undefined
    }
    if (typeof entry === 'bigint') throw new TypeError('Generation operation semantics cannot contain bigint values')
    if (typeof entry !== 'object') throw new TypeError('Generation operation semantics must be JSON-compatible')
    if (seen.has(entry)) throw new TypeError('Generation operation semantics cannot contain cycles')
    seen.add(entry)
    try {
      if (Array.isArray(entry)) {
        return `[${entry.map((item) => serialize(item, true) ?? 'null').join(',')}]`
      }
      const record = entry as Record<string, unknown>
      const fields: string[] = []
      for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
        const serialized = serialize(record[key], false)
        if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`)
      }
      return `{${fields.join(',')}}`
    } finally {
      seen.delete(entry)
    }
  }
  const serialized = serialize(value, false)
  if (serialized === undefined) throw new TypeError('Generation operation semantics must be a JSON value')
  return serialized
}

export function generationOperationRequestFingerprint(request: unknown): string {
  const semantics =
    isJsonRecord(request) && Object.hasOwn(request, 'baseRevision')
      ? Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'baseRevision'))
      : request
  return createHash('sha256').update(canonicalizeGenerationOperationSemantics(semantics), 'utf8').digest('hex')
}

export function generationEffectiveConfigurationFingerprint(configuration: unknown): string {
  const canonical = canonicalizeGenerationOperationSemantics(configuration)
  const bytes = Buffer.byteLength(canonical, 'utf8')
  if (bytes > GENERATION_EFFECTIVE_CONFIGURATION_MAX_BYTES) {
    throw new GenerationEffectiveConfigurationTooLargeError(bytes)
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function assertGenerationEffectiveConfigurationFingerprint(
  configuration: unknown,
  fingerprint: string | undefined,
): void {
  if (!fingerprint || generationEffectiveConfigurationFingerprint(configuration) !== fingerprint) {
    throw new Error('Accepted effective generation configuration fingerprint mismatch')
  }
}

export function createGenerationOperation(
  db: DatabaseSync,
  input: CreateGenerationOperationInput,
): GenerationOperationProjection {
  if (input.state === 'cancel_requested' && input.requestOrigin !== 'unbound') {
    throw new InvalidGenerationOperationTransitionError('accepted', 'cancel_requested')
  }
  if (input.state === 'accepted' && input.requestOrigin === 'unbound') {
    throw new InvalidGenerationOperationTransitionError('cancel_requested', 'accepted')
  }
  const now = normalizeTimestamp(input.createdAt)
  return withImmediateTransaction(db, () => insertGenerationOperationInTransaction(db, input, now))
}

/** Insert while the caller owns an open SQLite transaction. */
export function insertGenerationOperationInTransaction(
  db: DatabaseSync,
  input: CreateGenerationOperationInput,
  normalizedCreatedAt = normalizeTimestamp(input.createdAt),
): GenerationOperationProjection {
  if (input.state === 'cancel_requested' && input.requestOrigin !== 'unbound') {
    throw new InvalidGenerationOperationTransitionError('accepted', 'cancel_requested')
  }
  if (input.state === 'accepted' && input.requestOrigin === 'unbound') {
    throw new InvalidGenerationOperationTransitionError('cancel_requested', 'accepted')
  }
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  db.prepare(
    `
        INSERT INTO generation_operations (
          database_lineage, operation_id, protocol_version, request_origin,
          creator_writer_session_id, creator_writer_epoch,
          admission_kind, occupancy_database_lineage, occupancy_session_id, occupancy_epoch,
          occupancy_claim_class, permission_scope_version, permission_scope_json,
          effective_configuration_json, effective_configuration_fingerprint,
          binding_server_instance_id,
          character_id, chat_id, mode, accepted_message_id, target_message_id,
          client_draft_generation_json, request_fingerprint, intent_json, accepted_revision,
          state, state_version, projection_epoch, current_attempt_no,
          desired_terminal_outcome, result_message_id, failure_code, failure_phase, last_error,
          provider_may_have_run, cancel_requested_at, runner_settled_at, terminal_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?)
      `,
  ).run(
    input.databaseLineage,
    input.operationId,
    input.protocolVersion,
    input.requestOrigin,
    input.creatorWriterSessionId,
    input.creatorWriterEpoch,
    ...scopeSqlValues(input.generationScope),
    input.effectiveConfiguration === undefined ? null : JSON.stringify(input.effectiveConfiguration),
    input.effectiveConfigurationFingerprint ?? null,
    input.bindingServerInstanceId ?? null,
    input.characterId ?? null,
    input.chatId ?? null,
    input.mode ?? null,
    input.acceptedMessageId ?? null,
    input.targetMessageId ?? null,
    input.clientDraftGeneration === undefined ? null : JSON.stringify(input.clientDraftGeneration),
    input.requestFingerprint ?? null,
    input.intent === undefined ? null : JSON.stringify(input.intent),
    input.acceptedRevision ?? null,
    input.state,
    projectionEpoch,
    input.cancelRequestedAt ?? (input.state === 'cancel_requested' ? normalizedCreatedAt : null),
    normalizedCreatedAt,
    normalizedCreatedAt,
  )
  return requireGenerationOperationProjection(db, input.databaseLineage, input.operationId)
}

export function transitionGenerationOperation(
  db: DatabaseSync,
  input: GenerationOperationTransitionInput,
): GenerationOperationMutationResult {
  const updatedAt = normalizeTimestamp(input.updatedAt)
  return withImmediateTransaction(db, () => transitionGenerationOperationInTransaction(db, input, updatedAt))
}

/** Apply a guarded operation transition while the caller owns the transaction. */
export function transitionGenerationOperationInTransaction(
  db: DatabaseSync,
  input: GenerationOperationTransitionInput,
  normalizedUpdatedAt = normalizeTimestamp(input.updatedAt),
): GenerationOperationMutationResult {
  assertAllowedTransition(input.expectedState, input.nextState)
  if (input.nextState === 'launching') {
    throw new Error('Use reserveGenerationOperationAttempt for transitions to launching')
  }
  if (input.expectedState === 'cancel_requested' && input.nextState === 'cancelled') {
    throw new Error('Use bindCancelledGenerationOperation to bind a cancellation tombstone')
  }
  const current = getOperationStateRow(db, input.databaseLineage, input.operationId)
  if (!current || current.state !== input.expectedState || current.state_version !== input.expectedStateVersion) {
    return {
      status: 'stale',
      operation: getGenerationOperationProjection(db, input.databaseLineage, input.operationId),
    }
  }

  if (ATTEMPT_OWNING_STATES.has(input.nextState) && current.current_attempt_no === null) {
    throw new Error(`Generation operation ${input.nextState} requires a current attempt`)
  }
  const desiredTerminalOutcome =
    input.nextState === 'finalizing'
      ? (input.desiredTerminalOutcome ?? current.desired_terminal_outcome)
      : ATTEMPT_OWNING_STATES.has(input.nextState)
        ? current.desired_terminal_outcome
        : null
  if (input.nextState === 'finalizing' && desiredTerminalOutcome === null) {
    throw new Error('Generation operation finalizing transition requires a desired terminal outcome')
  }
  const currentAttemptNo = ATTEMPT_OWNING_STATES.has(input.nextState) ? current.current_attempt_no : null
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  const attemptStatus = ATTEMPT_STATUS_BY_TRANSITION[input.expectedState]?.[input.nextState]
  if (current.current_attempt_no !== null && attemptStatus) {
    const attemptResult = db
      .prepare(
        `
            UPDATE generation_operation_attempts
            SET status = ?,
                runner_settled_at = CASE WHEN ? THEN COALESCE(?, runner_settled_at) ELSE runner_settled_at END,
                finalization_generation_id = COALESCE(?, finalization_generation_id),
                failure_code = COALESCE(?, failure_code),
                last_error = COALESCE(?, last_error),
                updated_at = ?
            WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ?
          `,
      )
      .run(
        attemptStatus,
        isSettledAttemptStatus(attemptStatus) ? 1 : 0,
        input.runnerSettledAt ?? normalizedUpdatedAt,
        input.finalizationGenerationId ?? null,
        input.failureCode ?? null,
        input.lastError ?? null,
        normalizedUpdatedAt,
        input.databaseLineage,
        input.operationId,
        current.current_attempt_no,
      )
    if (attemptResult.changes !== 1) throw new Error('Generation operation current attempt is missing')
  }

  const terminalAt = TERMINAL_STATES.has(input.nextState)
    ? (input.terminalAt ?? current.terminal_at ?? normalizedUpdatedAt)
    : current.terminal_at
  const result = db
    .prepare(
      `
          UPDATE generation_operations
          SET state = ?, state_version = state_version + 1, projection_epoch = ?, current_attempt_no = ?,
              desired_terminal_outcome = ?, result_message_id = ?, failure_code = ?, failure_phase = ?,
              last_error = ?, provider_may_have_run = ?, cancel_requested_at = ?, runner_settled_at = ?,
              terminal_at = ?, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND state = ? AND state_version = ?
        `,
    )
    .run(
      input.nextState,
      projectionEpoch,
      currentAttemptNo,
      desiredTerminalOutcome,
      input.resultMessageId === undefined ? current.result_message_id : input.resultMessageId,
      input.failureCode === undefined ? current.failure_code : input.failureCode,
      input.failurePhase === undefined ? current.failure_phase : input.failurePhase,
      input.lastError === undefined ? current.last_error : input.lastError,
      input.providerMayHaveRun === undefined ? current.provider_may_have_run : input.providerMayHaveRun ? 1 : 0,
      input.cancelRequestedAt === undefined ? current.cancel_requested_at : input.cancelRequestedAt,
      input.runnerSettledAt === undefined ? current.runner_settled_at : input.runnerSettledAt,
      terminalAt,
      normalizedUpdatedAt,
      input.databaseLineage,
      input.operationId,
      input.expectedState,
      input.expectedStateVersion,
    )
  if (result.changes !== 1) {
    throw new Error('Generation operation transition guard changed during an immediate transaction')
  }
  return {
    status: 'applied',
    operation: requireGenerationOperationProjection(db, input.databaseLineage, input.operationId),
  }
}

export function bindCancelledGenerationOperation(
  db: DatabaseSync,
  input: BindCancelledGenerationOperationInput,
): GenerationOperationMutationResult {
  assertAllowedTransition('cancel_requested', 'cancelled')
  const updatedAt = normalizeTimestamp(input.updatedAt)
  return withImmediateTransaction(db, () => bindCancelledGenerationOperationInTransaction(db, input, updatedAt))
}

/** Bind a cancel-before-submit tombstone while the caller owns the transaction. */
export function bindCancelledGenerationOperationInTransaction(
  db: DatabaseSync,
  input: BindCancelledGenerationOperationInput,
  normalizedUpdatedAt = normalizeTimestamp(input.updatedAt),
): GenerationOperationMutationResult {
  const current = getOperationStateRow(db, input.databaseLineage, input.operationId)
  if (!current || current.state !== 'cancel_requested' || current.state_version !== input.expectedStateVersion) {
    return {
      status: 'stale',
      operation: getGenerationOperationProjection(db, input.databaseLineage, input.operationId),
    }
  }
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  const result = db
    .prepare(
      `
          UPDATE generation_operations
          SET request_origin = ?, binding_server_instance_id = ?, character_id = ?, chat_id = ?, mode = ?,
              admission_kind = ?, occupancy_database_lineage = ?, occupancy_session_id = ?, occupancy_epoch = ?,
              occupancy_claim_class = ?, permission_scope_version = ?, permission_scope_json = ?,
              effective_configuration_json = ?, effective_configuration_fingerprint = ?,
              accepted_message_id = ?, target_message_id = ?, client_draft_generation_json = ?,
              request_fingerprint = ?, intent_json = ?, accepted_revision = NULL,
              state = 'cancelled', state_version = state_version + 1, projection_epoch = ?,
              current_attempt_no = NULL, desired_terminal_outcome = NULL,
              runner_settled_at = ?, terminal_at = ?, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ?
            AND state = 'cancel_requested' AND state_version = ?
        `,
    )
    .run(
      input.requestOrigin,
      input.bindingServerInstanceId,
      input.characterId,
      input.chatId,
      input.mode,
      ...scopeSqlValues(input.generationScope),
      input.effectiveConfiguration === undefined ? null : JSON.stringify(input.effectiveConfiguration),
      input.effectiveConfigurationFingerprint ?? null,
      input.acceptedMessageId ?? null,
      input.targetMessageId ?? null,
      input.clientDraftGeneration === undefined ? null : JSON.stringify(input.clientDraftGeneration),
      input.requestFingerprint,
      JSON.stringify(input.intent),
      projectionEpoch,
      normalizedUpdatedAt,
      normalizedUpdatedAt,
      normalizedUpdatedAt,
      input.databaseLineage,
      input.operationId,
      input.expectedStateVersion,
    )
  if (result.changes !== 1) {
    throw new Error('Generation operation cancellation binding guard changed during an immediate transaction')
  }
  return {
    status: 'applied',
    operation: requireGenerationOperationProjection(db, input.databaseLineage, input.operationId),
  }
}

export function reserveGenerationOperationAttempt(
  db: DatabaseSync,
  input: ReserveGenerationOperationAttemptInput,
): GenerationOperationAttemptReservationResult {
  assertAllowedTransition(input.expectedState, 'launching')
  const createdAt = normalizeTimestamp(input.createdAt)
  return withImmediateTransaction(db, () => reserveGenerationOperationAttemptInTransaction(db, input, createdAt))
}

/** Reserve an exact attempt while the caller owns an immediate transaction. */
export function reserveGenerationOperationAttemptInTransaction(
  db: DatabaseSync,
  input: ReserveGenerationOperationAttemptInput,
  normalizedCreatedAt = normalizeTimestamp(input.createdAt),
): GenerationOperationAttemptReservationResult {
  assertAllowedTransition(input.expectedState, 'launching')
  const replay = db
    .prepare(
      `
          SELECT database_lineage, operation_id
          FROM generation_operation_attempts
          WHERE database_lineage = ? AND retry_request_id = ?
        `,
    )
    .get(input.databaseLineage, input.retryRequestId) as { database_lineage: string; operation_id: string } | undefined
  if (replay) {
    if (replay.operation_id !== input.operationId) {
      throw new GenerationOperationAttemptConflictError('retry request id belongs to another operation')
    }
    return {
      status: 'replayed',
      operation: requireGenerationOperationProjection(db, input.databaseLineage, input.operationId),
    }
  }

  const current = getOperationStateRow(db, input.databaseLineage, input.operationId)
  if (!current || current.state !== input.expectedState || current.state_version !== input.expectedStateVersion) {
    return {
      status: 'stale',
      operation: getGenerationOperationProjection(db, input.databaseLineage, input.operationId),
    }
  }
  if (current.current_attempt_no !== null)
    throw new Error('Non-running generation operation retained a current attempt')
  const nextAttempt = db
    .prepare(
      `
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attemptNo
          FROM generation_operation_attempts
          WHERE database_lineage = ? AND operation_id = ?
        `,
    )
    .get(input.databaseLineage, input.operationId) as { attemptNo: number }
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  const operationResult = db
    .prepare(
      `
          UPDATE generation_operations
          SET state = 'launching', state_version = state_version + 1, projection_epoch = ?,
              current_attempt_no = ?, desired_terminal_outcome = NULL,
              failure_code = NULL, failure_phase = NULL, last_error = NULL,
              runner_settled_at = NULL, terminal_at = NULL, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND state = ? AND state_version = ?
        `,
    )
    .run(
      projectionEpoch,
      nextAttempt.attemptNo,
      normalizedCreatedAt,
      input.databaseLineage,
      input.operationId,
      input.expectedState,
      input.expectedStateVersion,
    )
  if (operationResult.changes !== 1) {
    throw new Error('Generation operation attempt reservation guard changed during an immediate transaction')
  }
  db.prepare(
    `
        INSERT INTO generation_operation_attempts (
          database_lineage, operation_id, attempt_no, retry_request_id, job_id, server_instance_id,
          actor_writer_session_id, actor_writer_epoch,
          accepted_admission_kind, accepted_occupancy_database_lineage, accepted_occupancy_session_id,
          accepted_occupancy_epoch, accepted_occupancy_claim_class,
          accepted_permission_scope_version, accepted_permission_scope_json,
          accepted_effective_configuration_fingerprint,
          status, launch_revision,
          provider_dispatch_started_at, provider_dispatch_finished_at, runner_settled_at,
          finalization_generation_id, failure_code, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `,
  ).run(
    input.databaseLineage,
    input.operationId,
    nextAttempt.attemptNo,
    input.retryRequestId,
    input.jobId,
    input.serverInstanceId,
    input.actorWriterSessionId,
    input.actorWriterEpoch,
    current.admission_kind ?? null,
    current.occupancy_database_lineage ?? null,
    current.occupancy_session_id ?? null,
    current.occupancy_epoch ?? null,
    current.occupancy_claim_class ?? null,
    current.permission_scope_version ?? null,
    current.permission_scope_json ?? null,
    current.effective_configuration_fingerprint ?? null,
    input.launchRevision,
    normalizedCreatedAt,
    normalizedCreatedAt,
  )
  return {
    status: 'applied',
    operation: requireGenerationOperationProjection(db, input.databaseLineage, input.operationId),
  }
}

export function getGenerationOperationProjection(
  db: DatabaseSync,
  databaseLineage: string,
  operationId: string,
): GenerationOperationProjection | undefined {
  const row = selectGenerationOperationRows(db, 'WHERE o.database_lineage = ? AND o.operation_id = ?', [
    databaseLineage,
    operationId,
  ])[0]
  return row ? projectionFromRow(row) : undefined
}

export function getGenerationOperationStoredRequest(
  db: DatabaseSync,
  databaseLineage: string,
  operationId: string,
): GenerationOperationStoredRequest | undefined {
  const row = db
    .prepare(
      `
        SELECT request_fingerprint, intent_json,
               effective_configuration_json, effective_configuration_fingerprint
        FROM generation_operations
        WHERE database_lineage = ? AND operation_id = ?
      `,
    )
    .get(databaseLineage, operationId) as
    | {
        request_fingerprint: string | null
        intent_json: string | null
        effective_configuration_json: string | null
        effective_configuration_fingerprint: string | null
      }
    | undefined
  if (!row) return undefined
  return {
    ...(row.request_fingerprint !== null ? { requestFingerprint: row.request_fingerprint } : {}),
    ...(row.intent_json !== null ? { intent: JSON.parse(row.intent_json) as unknown } : {}),
    ...(row.effective_configuration_json !== null
      ? { effectiveConfiguration: JSON.parse(row.effective_configuration_json) as unknown }
      : {}),
    ...(row.effective_configuration_fingerprint !== null
      ? { effectiveConfigurationFingerprint: row.effective_configuration_fingerprint }
      : {}),
  }
}

/** Resolve configuration only when the exact historical attempt retained the
 * same immutable fingerprint as its parent accepted operation. */
export function getGenerationOperationAttemptAcceptedConfiguration(
  db: DatabaseSync,
  databaseLineage: string,
  operationId: string,
  attemptNo: number,
): GenerationOperationAttemptAcceptedConfiguration | undefined {
  const row = db
    .prepare(
      `
        SELECT o.effective_configuration_json, o.effective_configuration_fingerprint,
               a.accepted_effective_configuration_fingerprint
        FROM generation_operations o
        JOIN generation_operation_attempts a
          ON a.database_lineage = o.database_lineage AND a.operation_id = o.operation_id
        WHERE o.database_lineage = ? AND o.operation_id = ? AND a.attempt_no = ?
      `,
    )
    .get(databaseLineage, operationId, attemptNo) as
    | {
        effective_configuration_json: string | null
        effective_configuration_fingerprint: string | null
        accepted_effective_configuration_fingerprint: string | null
      }
    | undefined
  if (
    !row ||
    row.effective_configuration_json === null ||
    row.effective_configuration_fingerprint === null ||
    row.accepted_effective_configuration_fingerprint === null
  ) {
    return undefined
  }
  if (row.accepted_effective_configuration_fingerprint !== row.effective_configuration_fingerprint) {
    throw new Error('Accepted attempt effective generation configuration fingerprint mismatch')
  }
  return {
    effectiveConfiguration: JSON.parse(row.effective_configuration_json) as unknown,
    effectiveConfigurationFingerprint: row.effective_configuration_fingerprint,
  }
}

/**
 * Recognize only a completed translation target that crossed the v39 -> v40
 * migration without accepted configuration/occupancy columns. The migration's
 * parent-operation marker is authoritative; nullable child columns alone are
 * not enough because a malformed current row can also contain NULLs.
 */
export function hasPreOccupancyGeneratedTranslationAuthority(
  db: DatabaseSync,
  input: {
    databaseLineage: string
    operationId: string
    generationId: string
    effectKeyType: 'operation' | 'generation'
    effectKeyId: string
    effectAttemptNo?: number
    chatId: string
    messageId: string
  },
): boolean {
  if (
    (input.effectKeyType === 'operation' && input.effectKeyId !== input.operationId) ||
    (input.effectKeyType === 'generation' && input.effectKeyId !== input.generationId)
  ) {
    return false
  }
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS found
         FROM generation_operations AS o
         JOIN generation_operation_attempts AS a
           ON a.database_lineage = o.database_lineage
          AND a.operation_id = o.operation_id
          AND (a.job_id = ? OR a.finalization_generation_id = ?)
          AND (? IS NULL OR a.attempt_no = ?)
         JOIN messages AS m
           ON m.chat_id = ? AND m.uid = ? AND m.alternate = 0 AND m.role = 'char'
         WHERE o.database_lineage = ?
           AND o.operation_id = ?
           AND (
             (o.protocol_version >= 1 AND ? = 'operation')
             OR (o.protocol_version = 0 AND ? = 'generation')
           )
           AND o.chat_id = ?
           AND o.state = 'completed'
           AND o.result_message_id = ?
           AND o.pre_occupancy_authority = 1
           AND o.admission_kind IS NULL
           AND o.occupancy_database_lineage IS NULL
           AND o.occupancy_session_id IS NULL
           AND o.occupancy_epoch IS NULL
           AND o.occupancy_claim_class IS NULL
           AND o.permission_scope_version IS NULL
           AND o.permission_scope_json IS NULL
           AND o.effective_configuration_json IS NULL
           AND o.effective_configuration_fingerprint IS NULL
           AND a.accepted_admission_kind IS NULL
           AND a.accepted_occupancy_database_lineage IS NULL
           AND a.accepted_occupancy_session_id IS NULL
           AND a.accepted_occupancy_epoch IS NULL
           AND a.accepted_occupancy_claim_class IS NULL
           AND a.accepted_permission_scope_version IS NULL
           AND a.accepted_permission_scope_json IS NULL
           AND a.accepted_effective_configuration_fingerprint IS NULL
           AND json_valid(m.json)
           AND json_extract(m.json, '$.generationInfo.databaseLineage') = ?
           AND json_extract(m.json, '$.generationInfo.operationId') = ?
           AND (
             json_type(m.json, '$.generationInfo.operationAttemptNo') IS NOT NULL
             OR json_type(m.json, '$.generationInfo.attemptNo') IS NOT NULL
           )
           AND (
             json_type(m.json, '$.generationInfo.operationAttemptNo') IS NULL
             OR json_extract(m.json, '$.generationInfo.operationAttemptNo') = a.attempt_no
           )
           AND (
             json_type(m.json, '$.generationInfo.attemptNo') IS NULL
             OR json_extract(m.json, '$.generationInfo.attemptNo') = a.attempt_no
           )
           AND json_extract(m.json, '$.generationInfo.generationId') = ?
           AND (
             json_type(m.json, '$.generationInfo.jobId') IS NULL
             OR json_extract(m.json, '$.generationInfo.jobId') = ?
           )
         LIMIT 1`,
      )
      .get(
        input.generationId,
        input.generationId,
        input.effectAttemptNo ?? null,
        input.effectAttemptNo ?? null,
        input.chatId,
        input.messageId,
        input.databaseLineage,
        input.operationId,
        input.effectKeyType,
        input.effectKeyType,
        input.chatId,
        input.messageId,
        input.databaseLineage,
        input.operationId,
        input.generationId,
        input.generationId,
      ),
  )
}

export function generationOperationForRetryRequest(
  db: DatabaseSync,
  databaseLineage: string,
  retryRequestId: string,
): { operationId: string; attemptNo: number; jobId: string } | undefined {
  return db
    .prepare(
      `
        SELECT operation_id AS operationId, attempt_no AS attemptNo, job_id AS jobId
        FROM generation_operation_attempts
        WHERE database_lineage = ? AND retry_request_id = ?
      `,
    )
    .get(databaseLineage, retryRequestId) as { operationId: string; attemptNo: number; jobId: string } | undefined
}

/**
 * Commit the billing-risk marker immediately before the first provider call.
 * Repeated policy/fallback dispatches revalidate ownership without rewriting
 * the first-dispatch timestamp.
 */
export function markGenerationOperationProviderDispatchStarted(
  db: DatabaseSync,
  lineage: GenerationOperationLineage,
  updatedAt?: string,
): GenerationOperationProjection {
  const now = normalizeTimestamp(updatedAt)
  return withImmediateTransaction(db, () => {
    const current = requireCurrentAttempt(db, lineage)
    if (current.state !== 'owned_by_job' || current.cancel_requested_at !== null) {
      throw new GenerationOperationAttemptConflictError('generation operation is not dispatchable')
    }
    if (current.provider_dispatch_started_at === null) {
      const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
      const attempt = db
        .prepare(
          `
            UPDATE generation_operation_attempts
            SET provider_dispatch_started_at = ?, updated_at = ?
            WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ?
              AND job_id = ? AND status = 'running' AND provider_dispatch_started_at IS NULL
          `,
        )
        .run(now, now, lineage.databaseLineage, lineage.operationId, lineage.attemptNo, lineage.jobId)
      if (attempt.changes !== 1) {
        throw new GenerationOperationAttemptConflictError('generation attempt dispatch marker is stale')
      }
      db.prepare(
        `
          UPDATE generation_operations
          SET projection_epoch = ?, provider_may_have_run = 1, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND state = 'owned_by_job'
            AND current_attempt_no = ?
        `,
      ).run(projectionEpoch, now, lineage.databaseLineage, lineage.operationId, lineage.attemptNo)
    }
    return requireGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
  })
}

export function markGenerationOperationProviderDispatchFinished(
  db: DatabaseSync,
  lineage: GenerationOperationLineage,
  updatedAt?: string,
): GenerationOperationProjection {
  const now = normalizeTimestamp(updatedAt)
  return withImmediateTransaction(db, () => {
    const current = requireCurrentAttempt(db, lineage)
    if (current.provider_dispatch_finished_at === null) {
      const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
      db.prepare(
        `
          UPDATE generation_operation_attempts
          SET provider_dispatch_finished_at = ?, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ? AND job_id = ?
        `,
      ).run(now, now, lineage.databaseLineage, lineage.operationId, lineage.attemptNo, lineage.jobId)
      db.prepare(
        `
          UPDATE generation_operations
          SET projection_epoch = ?, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND current_attempt_no = ?
        `,
      ).run(projectionEpoch, now, lineage.databaseLineage, lineage.operationId, lineage.attemptNo)
    }
    return requireGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
  })
}

/** Validate current ownership without mutating the projection. */
export function assertGenerationOperationDispatchable(
  db: DatabaseSync,
  lineage: GenerationOperationLineage,
): GenerationOperationProjection {
  const current = requireCurrentAttempt(db, lineage)
  if (
    current.state !== 'owned_by_job' ||
    current.cancel_requested_at !== null ||
    current.attempt_status !== 'running'
  ) {
    throw new GenerationOperationAttemptConflictError('generation operation is not dispatchable')
  }
  return requireGenerationOperationProjection(db, lineage.databaseLineage, lineage.operationId)
}

/**
 * Finish a protocol finalization inside the transcript command transaction.
 * The caller has already written the exact result row but has not yet bumped
 * the domain revision or persisted its command event, so any later failure
 * rolls all three surfaces back together.
 */
export function completeGenerationOperationFinalizationInTransaction(
  db: DatabaseSync,
  input: GenerationOperationLineage & {
    terminalOutcome: GenerationOperationTerminalOutcome
    resultMessageId?: string
    updatedAt?: string
  },
): GenerationOperationProjection {
  const currentProjection = getGenerationOperationProjection(db, input.databaseLineage, input.operationId)
  if (
    currentProjection &&
    currentProjection.state === input.terminalOutcome &&
    currentProjection.resultMessageId === input.resultMessageId
  ) {
    return currentProjection
  }
  const current = requireCurrentAttempt(db, input)
  if (
    current.state !== 'finalizing' ||
    current.desired_terminal_outcome !== input.terminalOutcome ||
    current.attempt_status !== 'finalizing'
  ) {
    throw new GenerationOperationAttemptConflictError('generation finalization lineage is stale')
  }
  const now = normalizeTimestamp(input.updatedAt)
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  const attemptStatus: GenerationOperationAttemptStatus =
    input.terminalOutcome === 'completed' ? 'completed' : 'cancelled'
  db.prepare(
    `
      UPDATE generation_operation_attempts
      SET status = ?, runner_settled_at = COALESCE(runner_settled_at, ?), updated_at = ?
      WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ? AND job_id = ?
    `,
  ).run(attemptStatus, now, now, input.databaseLineage, input.operationId, input.attemptNo, input.jobId)
  const result = db
    .prepare(
      `
        UPDATE generation_operations
        SET state = ?, state_version = state_version + 1, projection_epoch = ?,
            current_attempt_no = NULL, desired_terminal_outcome = NULL,
            result_message_id = ?, failure_code = NULL, failure_phase = NULL,
            last_error = NULL, runner_settled_at = ?, terminal_at = ?, updated_at = ?
        WHERE database_lineage = ? AND operation_id = ? AND state = 'finalizing'
          AND current_attempt_no = ?
      `,
    )
    .run(
      input.terminalOutcome,
      projectionEpoch,
      input.resultMessageId ?? null,
      now,
      now,
      now,
      input.databaseLineage,
      input.operationId,
      input.attemptNo,
    )
  if (result.changes !== 1) {
    throw new GenerationOperationAttemptConflictError('generation finalization transition is stale')
  }
  return requireGenerationOperationProjection(db, input.databaseLineage, input.operationId)
}

export function listGenerationOperationProjections(
  db: DatabaseSync,
  databaseLineage = getDatabaseLineage(db),
  recentTerminalLimit = GENERATION_OPERATION_RECENT_TERMINAL_LIMIT,
): GenerationOperationProjection[] {
  if (!Number.isSafeInteger(recentTerminalLimit) || recentTerminalLimit < 0) {
    throw new RangeError('recentTerminalLimit must be a non-negative safe integer')
  }
  const rows = selectGenerationOperationRows(
    db,
    `
      WHERE o.database_lineage = ?
        AND (
          o.state NOT IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')
          OR o.operation_id IN (
            SELECT terminal.operation_id
            FROM generation_operations AS terminal
            WHERE terminal.database_lineage = ?
              AND terminal.state IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')
            ORDER BY terminal.updated_at DESC, terminal.operation_id ASC
            LIMIT ?
          )
        )
      ORDER BY o.projection_epoch ASC, o.operation_id ASC
    `,
    [databaseLineage, databaseLineage, recentTerminalLimit],
  )
  return rows.map(projectionFromRow)
}

/**
 * Freeze and reconcile non-live accepted work before an expired occupancy is
 * reassigned. This primitive deliberately runs inside the claimant's existing
 * `BEGIN IMMEDIATE` transaction: either transcript/journal inspection,
 * terminal dispositions, effect settlement, and the new claim commit together,
 * or none of them do. It never reserves an attempt or dispatches a provider.
 */
export function reconcileExpiredGenerationOccupancyInTransaction(
  db: DatabaseSync,
  input: ExpiredGenerationOccupancyRecoveryInput,
): ExpiredGenerationOccupancyRecoveryResult {
  if (!db.isTransaction) throw new Error('Expired occupancy recovery requires an immediate transaction')
  if (!Number.isSafeInteger(input.occupancyEpoch) || input.occupancyEpoch < 0) {
    throw new Error('Expired occupancy recovery epoch is invalid')
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error('Expired occupancy recovery time is invalid')
  }
  if (getDatabaseLineage(db) !== input.databaseLineage) return emptyExpiredOccupancyRecoveryResult()
  const occupancy = db
    .prepare(
      `SELECT 1 AS found
       FROM chat_occupancies
       WHERE database_lineage = ? AND chat_id = ? AND occupant_session_id = ?
         AND occupancy_epoch = ? AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?`,
    )
    .get(input.databaseLineage, input.chatId, input.occupantSessionId, input.occupancyEpoch, input.nowMs)
  if (!occupancy) return emptyExpiredOccupancyRecoveryResult()

  const operations = db
    .prepare(
      `SELECT operation_id, state, state_version
       FROM generation_operations
       WHERE database_lineage = ? AND chat_id = ?
         AND occupancy_database_lineage = ? AND occupancy_session_id = ? AND occupancy_epoch = ?
         AND state IN ('abandoned', 'retryable')
       ORDER BY operation_id`,
    )
    .all(
      input.databaseLineage,
      input.chatId,
      input.databaseLineage,
      input.occupantSessionId,
      input.occupancyEpoch,
    ) as Array<{ operation_id: string; state: 'abandoned' | 'retryable'; state_version: number }>

  const now = new Date(input.nowMs).toISOString()
  let projectionEpoch: number | undefined
  let completedFromResultCount = 0
  let terminalFailedCount = 0
  for (const operation of operations) {
    const pendingJournal = db
      .prepare(
        `SELECT 1 AS found
         FROM generation_finalization_retries
         WHERE database_lineage = ? AND operation_id = ? AND status = 'pending'
         LIMIT 1`,
      )
      .get(input.databaseLineage, operation.operation_id)
    if (pendingJournal) continue

    const result = db
      .prepare(
        `SELECT uid
         FROM messages
         WHERE chat_id = ? AND alternate = 0 AND json_valid(json)
           AND json_extract(json, '$.generationInfo.databaseLineage') = ?
           AND json_extract(json, '$.generationInfo.operationId') = ?
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get(input.chatId, input.databaseLineage, operation.operation_id) as { uid: string } | undefined
    projectionEpoch ??= bumpGenerationOperationProjectionEpoch(db)
    const nextState = result ? 'completed' : 'terminal_failed'
    const failureCode = result ? null : 'occupancy_recovery_expired'
    const attemptStatus = result ? 'completed' : 'terminal_failed'
    db.prepare(
      `UPDATE generation_operation_attempts
       SET status = ?, runner_settled_at = COALESCE(runner_settled_at, ?),
           failure_code = ?, last_error = NULL, updated_at = ?
       WHERE database_lineage = ? AND operation_id = ?
         AND attempt_no = (
           SELECT MAX(attempt_no) FROM generation_operation_attempts
           WHERE database_lineage = ? AND operation_id = ?
         )
         AND status IN ('reserved', 'running', 'stopping', 'finalizing', 'retryable_failed', 'abandoned')`,
    ).run(
      attemptStatus,
      now,
      failureCode,
      now,
      input.databaseLineage,
      operation.operation_id,
      input.databaseLineage,
      operation.operation_id,
    )
    const changed = db
      .prepare(
        `UPDATE generation_operations
         SET state = ?, state_version = state_version + 1, projection_epoch = ?,
             current_attempt_no = NULL, desired_terminal_outcome = NULL,
             result_message_id = ?, failure_code = ?, failure_phase = ?, last_error = NULL,
             runner_settled_at = COALESCE(runner_settled_at, ?), terminal_at = ?, updated_at = ?
         WHERE database_lineage = ? AND operation_id = ? AND state = ? AND state_version = ?`,
      )
      .run(
        nextState,
        projectionEpoch,
        result?.uid ?? null,
        failureCode,
        result ? null : 'occupancy_recovery',
        now,
        now,
        now,
        input.databaseLineage,
        operation.operation_id,
        operation.state,
        operation.state_version,
      )
    if (changed.changes !== 1) throw new Error('Expired occupancy operation recovery raced inside transaction')
    if (result) completedFromResultCount += 1
    else terminalFailedCount += 1
  }

  const skippedEffects = db
    .prepare(
      `UPDATE generation_effects
       SET status = 'skipped',
           claim_id = COALESCE(claim_id, 'occupancy-recovery:' || generation_id || ':' || effect_kind),
           delivery = COALESCE(delivery, CASE WHEN effect_kind = 'generated_translation' THEN 'server' ELSE 'late_recovery' END),
           reason = 'occupancy_recovery_expired', last_error = NULL,
           claimed_at = COALESCE(claimed_at, ?), lease_expires_at = NULL,
           settled_at = ?, updated_at = ?
       WHERE database_lineage = ? AND chat_id = ?
         AND occupancy_database_lineage = ? AND occupancy_session_id = ? AND occupancy_epoch = ?
         AND status IN ('pending', 'claimed')
         AND operation_id IN (
           SELECT operation_id FROM generation_operations
           WHERE database_lineage = ? AND chat_id = ?
             AND state IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')
             AND (
               generation_effects.effect_kind <> 'generated_translation'
               OR state <> 'completed'
               OR result_message_id IS NULL
               OR result_message_id <> generation_effects.message_id
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM generation_finalization_retries AS retry
           WHERE retry.database_lineage = generation_effects.database_lineage
             AND retry.operation_id = generation_effects.operation_id AND retry.status = 'pending'
         )`,
    )
    .run(
      now,
      now,
      now,
      input.databaseLineage,
      input.chatId,
      input.databaseLineage,
      input.occupantSessionId,
      input.occupancyEpoch,
      input.databaseLineage,
      input.chatId,
    )

  return {
    examinedOperationCount: operations.length,
    completedFromResultCount,
    terminalFailedCount,
    skippedEffectCount: Number(skippedEffects.changes),
  }
}

function emptyExpiredOccupancyRecoveryResult(): ExpiredGenerationOccupancyRecoveryResult {
  return {
    examinedOperationCount: 0,
    completedFromResultCount: 0,
    terminalFailedCount: 0,
    skippedEffectCount: 0,
  }
}

export function reconcileGenerationOperationsAtStartup(
  db: DatabaseSync,
  serverInstanceId: string,
  logger?: FastifyBaseLogger,
): GenerationOperationStartupSweepResult {
  const startedAt = protocolNowMs()
  const databaseLineage = getDatabaseLineage(db)
  const result = withImmediateTransaction(db, () =>
    reconcileGenerationOperationsLocked(db, databaseLineage, serverInstanceId),
  )
  emitProtocolMetric(
    'generation_operation_startup_sweep',
    {
      ...result,
      durationMs: protocolDurationMs(startedAt),
    },
    logger,
  )
  return result
}

function reconcileGenerationOperationsLocked(
  db: DatabaseSync,
  databaseLineage: string,
  serverInstanceId: string,
): GenerationOperationStartupSweepResult {
  const operations = db
    .prepare(
      `
        SELECT database_lineage, operation_id, state, state_version, current_attempt_no,
               accepted_message_id, desired_terminal_outcome, provider_may_have_run
        FROM generation_operations
        WHERE database_lineage = ?
          AND state NOT IN ('completed', 'cancelled', 'terminal_failed', 'invalidated')
        ORDER BY operation_id ASC
      `,
    )
    .all(databaseLineage) as unknown as StartupOperationRow[]
  const attempts = db
    .prepare(
      `
        SELECT database_lineage, operation_id, attempt_no, job_id, server_instance_id,
               actor_writer_session_id, actor_writer_epoch, status,
               provider_dispatch_started_at, finalization_generation_id
        FROM generation_operation_attempts
        WHERE database_lineage = ?
      `,
    )
    .all(databaseLineage) as unknown as StartupAttemptRow[]
  const attemptsByKey = new Map(
    attempts.map((attempt) => [attemptKey(attempt.operation_id, attempt.attempt_no), attempt]),
  )
  const journals = db
    .prepare(
      `
        SELECT database_lineage, operation_id, operation_attempt_no,
               actor_writer_session_id, actor_writer_epoch, accepted_message_id,
               terminal_outcome, generation_id
        FROM generation_finalization_retries
        WHERE database_lineage = ? AND operation_id IS NOT NULL AND status = 'pending'
      `,
    )
    .all(databaseLineage) as unknown as StartupJournalRow[]
  const results = db
    .prepare(
      `
        SELECT uid,
               json_extract(json, '$.generationInfo.operationId') AS operation_id
        FROM messages
        WHERE json_valid(json)
          AND json_extract(json, '$.generationInfo.databaseLineage') = ?
          AND json_type(json, '$.generationInfo.operationId') = 'text'
        ORDER BY chat_id ASC, seq ASC
      `,
    )
    .all(databaseLineage) as unknown as Array<{ uid: string; operation_id: string }>
  const resultMessageByOperation = new Map<string, string>()
  for (const persisted of results) {
    if (!resultMessageByOperation.has(persisted.operation_id)) {
      resultMessageByOperation.set(persisted.operation_id, persisted.uid)
    }
  }

  type Decision = {
    operation: StartupOperationRow
    state: GenerationOperationState
    attemptStatus?: GenerationOperationAttemptStatus
    desiredTerminalOutcome?: GenerationOperationTerminalOutcome | null
    resultMessageId?: string | null
    failureCode?: string | null
    providerMayHaveRun?: boolean
    terminal: boolean
  }
  const decisions: Decision[] = []
  let completedFromResultCount = 0
  let cancelledFromResultCount = 0
  let finalizingFromJournalCount = 0
  let abandonedOperationCount = 0
  let cancelledOperationCount = 0
  const protectedAttempts = new Set<string>()

  for (const operation of operations) {
    const attempt =
      operation.current_attempt_no === null
        ? undefined
        : attemptsByKey.get(attemptKey(operation.operation_id, operation.current_attempt_no))
    const persistedResult = resultMessageByOperation.get(operation.operation_id)
    if (persistedResult && STARTUP_RESULT_STATES.has(operation.state)) {
      const cancelled = operation.desired_terminal_outcome === 'cancelled'
      decisions.push({
        operation,
        state: cancelled ? 'cancelled' : 'completed',
        ...(attempt ? { attemptStatus: cancelled ? 'cancelled' : 'completed' } : {}),
        desiredTerminalOutcome: null,
        resultMessageId: persistedResult,
        failureCode: null,
        terminal: true,
      })
      if (cancelled) cancelledFromResultCount += 1
      else completedFromResultCount += 1
      if (attempt) protectedAttempts.add(attemptKey(attempt.operation_id, attempt.attempt_no))
      continue
    }

    const journal = attempt
      ? journals.find((candidate) => startupJournalMatches(operation, attempt, candidate))
      : undefined
    if (
      journal &&
      (operation.state === 'finalizing' || operation.state === 'owned_by_job' || operation.state === 'stopping')
    ) {
      protectedAttempts.add(attemptKey(attempt!.operation_id, attempt!.attempt_no))
      if (operation.state !== 'finalizing' || attempt!.status !== 'finalizing') {
        decisions.push({
          operation,
          state: 'finalizing',
          attemptStatus: 'finalizing',
          desiredTerminalOutcome: journal.terminal_outcome,
          terminal: false,
        })
        finalizingFromJournalCount += 1
      }
      continue
    }

    if (operation.state === 'accepted' || operation.state === 'launching' || operation.state === 'owned_by_job') {
      decisions.push({
        operation,
        state: 'abandoned',
        ...(attempt ? { attemptStatus: 'abandoned' } : {}),
        desiredTerminalOutcome: null,
        failureCode: 'server_restarted',
        providerMayHaveRun:
          operation.provider_may_have_run === 1 ||
          (attempt !== undefined && attempt.provider_dispatch_started_at !== null),
        terminal: false,
      })
      abandonedOperationCount += 1
      if (attempt) protectedAttempts.add(attemptKey(attempt.operation_id, attempt.attempt_no))
      continue
    }
    if (operation.state === 'stopping') {
      decisions.push({
        operation,
        state: 'abandoned',
        ...(attempt ? { attemptStatus: 'abandoned' } : {}),
        desiredTerminalOutcome: null,
        failureCode: 'server_restarted',
        providerMayHaveRun:
          operation.provider_may_have_run === 1 ||
          (attempt !== undefined && attempt.provider_dispatch_started_at !== null),
        terminal: false,
      })
      abandonedOperationCount += 1
      if (attempt) protectedAttempts.add(attemptKey(attempt.operation_id, attempt.attempt_no))
      continue
    }
    if (operation.state === 'finalizing') {
      decisions.push({
        operation,
        state: 'abandoned',
        ...(attempt ? { attemptStatus: 'abandoned' } : {}),
        desiredTerminalOutcome: null,
        failureCode: 'finalization_record_missing',
        providerMayHaveRun:
          operation.provider_may_have_run === 1 ||
          (attempt !== undefined && attempt.provider_dispatch_started_at !== null),
        terminal: false,
      })
      abandonedOperationCount += 1
      if (attempt) protectedAttempts.add(attemptKey(attempt.operation_id, attempt.attempt_no))
    }
  }

  const orphanedAttempts = attempts.filter(
    (attempt) =>
      attempt.server_instance_id !== serverInstanceId &&
      (attempt.status === 'reserved' || attempt.status === 'running') &&
      !protectedAttempts.has(attemptKey(attempt.operation_id, attempt.attempt_no)),
  )
  const changedOperationIds = new Set(decisions.map(({ operation }) => operation.operation_id))
  for (const attempt of orphanedAttempts) changedOperationIds.add(attempt.operation_id)
  if (changedOperationIds.size === 0) {
    return {
      projectionEpoch: getGenerationOperationProjectionEpoch(db),
      examinedOperationCount: operations.length,
      completedFromResultCount,
      cancelledFromResultCount,
      finalizingFromJournalCount,
      abandonedOperationCount,
      cancelledOperationCount,
      abandonedAttemptCount: 0,
      changedOperationCount: 0,
    }
  }

  const now = new Date().toISOString()
  const projectionEpoch = bumpGenerationOperationProjectionEpoch(db)
  for (const decision of decisions) {
    if (decision.operation.current_attempt_no !== null && decision.attemptStatus) {
      db.prepare(
        `
          UPDATE generation_operation_attempts
          SET status = ?,
              runner_settled_at = CASE WHEN ? THEN COALESCE(runner_settled_at, ?) ELSE runner_settled_at END,
              failure_code = ?, updated_at = ?
          WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ?
        `,
      ).run(
        decision.attemptStatus,
        isSettledAttemptStatus(decision.attemptStatus) ? 1 : 0,
        now,
        decision.failureCode ?? null,
        now,
        databaseLineage,
        decision.operation.operation_id,
        decision.operation.current_attempt_no,
      )
    }
    db.prepare(
      `
        UPDATE generation_operations
        SET state = ?, state_version = state_version + 1, projection_epoch = ?,
            current_attempt_no = ?, desired_terminal_outcome = ?, result_message_id = COALESCE(?, result_message_id),
            failure_code = ?, provider_may_have_run = ?, runner_settled_at = ?, terminal_at = ?, updated_at = ?
        WHERE database_lineage = ? AND operation_id = ? AND state = ? AND state_version = ?
      `,
    ).run(
      decision.state,
      projectionEpoch,
      ATTEMPT_OWNING_STATES.has(decision.state) ? decision.operation.current_attempt_no : null,
      decision.desiredTerminalOutcome ?? null,
      decision.resultMessageId ?? null,
      decision.failureCode ?? null,
      decision.providerMayHaveRun === undefined
        ? decision.operation.provider_may_have_run
        : decision.providerMayHaveRun
          ? 1
          : 0,
      decision.state === 'finalizing' ? null : now,
      decision.terminal ? now : null,
      now,
      databaseLineage,
      decision.operation.operation_id,
      decision.operation.state,
      decision.operation.state_version,
    )
  }
  for (const attempt of orphanedAttempts) {
    db.prepare(
      `
        UPDATE generation_operation_attempts
        SET status = 'abandoned', runner_settled_at = COALESCE(runner_settled_at, ?),
            failure_code = 'server_restarted', updated_at = ?
        WHERE database_lineage = ? AND operation_id = ? AND attempt_no = ?
          AND status IN ('reserved', 'running')
      `,
    ).run(now, now, databaseLineage, attempt.operation_id, attempt.attempt_no)
  }
  for (const operationId of changedOperationIds) {
    if (decisions.some((decision) => decision.operation.operation_id === operationId)) continue
    db.prepare(
      `
        UPDATE generation_operations
        SET projection_epoch = ?, updated_at = ?
        WHERE database_lineage = ? AND operation_id = ?
      `,
    ).run(projectionEpoch, now, databaseLineage, operationId)
  }
  return {
    projectionEpoch,
    examinedOperationCount: operations.length,
    completedFromResultCount,
    cancelledFromResultCount,
    finalizingFromJournalCount,
    abandonedOperationCount,
    cancelledOperationCount,
    abandonedAttemptCount: orphanedAttempts.length,
    changedOperationCount: changedOperationIds.size,
  }
}

function selectGenerationOperationRows(
  db: DatabaseSync,
  whereSql: string,
  params: Array<string | number | null>,
): GenerationOperationRow[] {
  return db
    .prepare(
      `
        SELECT o.*,
               a.attempt_no, a.retry_request_id, a.job_id, a.status AS attempt_status,
               a.server_instance_id, a.actor_writer_session_id, a.actor_writer_epoch,
               a.accepted_effective_configuration_fingerprint,
               a.launch_revision, a.provider_dispatch_started_at, a.provider_dispatch_finished_at,
               a.runner_settled_at AS attempt_runner_settled_at,
               a.finalization_generation_id, a.failure_code AS attempt_failure_code,
               a.last_error AS attempt_last_error, a.created_at AS attempt_created_at,
               a.updated_at AS attempt_updated_at
        FROM generation_operations AS o
        LEFT JOIN generation_operation_attempts AS a
          ON a.database_lineage = o.database_lineage
         AND a.operation_id = o.operation_id
         AND a.attempt_no = o.current_attempt_no
        ${whereSql}
      `,
    )
    .all(...params) as unknown as GenerationOperationRow[]
}

function projectionFromRow(row: GenerationOperationRow): GenerationOperationProjection {
  return {
    operationId: row.operation_id,
    protocolVersion: row.protocol_version,
    requestOrigin: row.request_origin,
    state: row.state,
    stateVersion: row.state_version,
    projectionEpoch: row.projection_epoch,
    creatorWriterSessionId: row.creator_writer_session_id,
    creatorWriterEpoch: row.creator_writer_epoch,
    ...(scopeFromColumns(row) ? { generationScope: scopeFromColumns(row)! } : {}),
    ...(row.effective_configuration_fingerprint !== null
      ? { effectiveConfigurationFingerprint: row.effective_configuration_fingerprint }
      : {}),
    ...(row.binding_server_instance_id !== null ? { bindingServerInstanceId: row.binding_server_instance_id } : {}),
    ...(row.character_id !== null ? { characterId: row.character_id } : {}),
    ...(row.chat_id !== null ? { chatId: row.chat_id } : {}),
    ...(row.mode !== null ? { mode: row.mode } : {}),
    ...(row.accepted_message_id !== null ? { acceptedMessageId: row.accepted_message_id } : {}),
    ...(row.target_message_id !== null ? { targetMessageId: row.target_message_id } : {}),
    ...(row.client_draft_generation_json !== null
      ? { clientDraftGeneration: JSON.parse(row.client_draft_generation_json) as unknown }
      : {}),
    ...(row.accepted_revision !== null ? { acceptedRevision: row.accepted_revision } : {}),
    ...(row.attempt_no !== null
      ? {
          currentAttempt: {
            attemptNo: row.attempt_no,
            retryRequestId: row.retry_request_id!,
            jobId: row.job_id!,
            status: row.attempt_status!,
            serverInstanceId: row.server_instance_id!,
            actorWriterSessionId: row.actor_writer_session_id!,
            actorWriterEpoch: row.actor_writer_epoch!,
            ...(row.accepted_effective_configuration_fingerprint !== null
              ? { acceptedEffectiveConfigurationFingerprint: row.accepted_effective_configuration_fingerprint }
              : {}),
            launchRevision: row.launch_revision!,
            ...(row.provider_dispatch_started_at !== null
              ? { providerDispatchStartedAt: row.provider_dispatch_started_at }
              : {}),
            ...(row.provider_dispatch_finished_at !== null
              ? { providerDispatchFinishedAt: row.provider_dispatch_finished_at }
              : {}),
            ...(row.attempt_runner_settled_at !== null ? { runnerSettledAt: row.attempt_runner_settled_at } : {}),
            ...(row.finalization_generation_id !== null
              ? { finalizationGenerationId: row.finalization_generation_id }
              : {}),
            ...(row.attempt_failure_code !== null ? { failureCode: row.attempt_failure_code } : {}),
            ...(row.attempt_last_error !== null ? { lastError: row.attempt_last_error } : {}),
            createdAt: row.attempt_created_at!,
            updatedAt: row.attempt_updated_at!,
          },
        }
      : {}),
    ...(row.desired_terminal_outcome !== null ? { desiredTerminalOutcome: row.desired_terminal_outcome } : {}),
    ...(row.result_message_id !== null ? { resultMessageId: row.result_message_id } : {}),
    ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
    ...(row.failure_phase !== null ? { failurePhase: row.failure_phase } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    providerMayHaveRun: row.provider_may_have_run === 1,
    ...(row.cancel_requested_at !== null ? { cancelRequestedAt: row.cancel_requested_at } : {}),
    ...(row.runner_settled_at !== null ? { runnerSettledAt: row.runner_settled_at } : {}),
    ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.state === 'retryable' || row.state === 'abandoned' ? { recoveryDisposition: 'retryable' as const } : {}),
  }
}

function getOperationStateRow(
  db: DatabaseSync,
  databaseLineage: string,
  operationId: string,
): GenerationOperationRow | undefined {
  return selectGenerationOperationRows(db, 'WHERE o.database_lineage = ? AND o.operation_id = ?', [
    databaseLineage,
    operationId,
  ])[0]
}

function requireGenerationOperationProjection(
  db: DatabaseSync,
  databaseLineage: string,
  operationId: string,
): GenerationOperationProjection {
  const operation = getGenerationOperationProjection(db, databaseLineage, operationId)
  if (!operation) throw new Error(`Generation operation is missing: ${operationId}`)
  return operation
}

function requireCurrentAttempt(db: DatabaseSync, lineage: GenerationOperationLineage): GenerationOperationRow {
  const current = getOperationStateRow(db, lineage.databaseLineage, lineage.operationId)
  if (
    !current ||
    current.current_attempt_no !== lineage.attemptNo ||
    current.attempt_no !== lineage.attemptNo ||
    current.job_id !== lineage.jobId
  ) {
    throw new GenerationOperationAttemptConflictError('generation attempt lineage is stale')
  }
  return current
}

function startupJournalMatches(
  operation: StartupOperationRow,
  attempt: StartupAttemptRow,
  journal: StartupJournalRow,
): boolean {
  return (
    journal.terminal_outcome !== null &&
    journal.operation_id === operation.operation_id &&
    journal.operation_attempt_no === attempt.attempt_no &&
    journal.actor_writer_session_id === attempt.actor_writer_session_id &&
    journal.actor_writer_epoch === attempt.actor_writer_epoch &&
    journal.accepted_message_id === operation.accepted_message_id &&
    (operation.desired_terminal_outcome === null || operation.desired_terminal_outcome === journal.terminal_outcome) &&
    journal.generation_id === (attempt.finalization_generation_id ?? attempt.job_id)
  )
}

function assertAllowedTransition(from: GenerationOperationState, to: GenerationOperationState): void {
  if (!ALLOWED_TRANSITIONS[from].has(to)) throw new InvalidGenerationOperationTransitionError(from, to)
}

function isSettledAttemptStatus(status: GenerationOperationAttemptStatus): boolean {
  return (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'retryable_failed' ||
    status === 'terminal_failed' ||
    status === 'abandoned'
  )
}

function attemptKey(operationId: string, attemptNo: number): string {
  return `${operationId}\u0000${attemptNo}`
}

function normalizeTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString()
  if (Number.isNaN(Date.parse(timestamp))) throw new TypeError('timestamp must be valid')
  return timestamp
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function withImmediateTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  let committed = false
  try {
    const result = run()
    db.exec('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (!committed) db.exec('ROLLBACK')
    throw error
  }
}
