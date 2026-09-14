import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { PersistedGenerationScope } from './generationScope.js'

export const BARDWIKI_DOCUMENT_KINDS = [
  'event',
  'character',
  'location',
  'scene',
  'faction',
  'item',
  'concept',
  'other',
] as const
export const BARDWIKI_CONTEXT_POLICIES = ['never', 'relevant', 'always', 'pinned'] as const
export const BARDWIKI_REVIEW_STATES = ['active', 'needs_review', 'archived'] as const
export const BARDWIKI_MEMORY_MODES = ['hypa', 'bardwiki', 'hybrid'] as const
export const BARDWIKI_CONFIRMATION_POLICIES = ['manual', 'automatic'] as const
export const BARDWIKI_RECEIPT_STATES = [
  'queued',
  'processing',
  'applied',
  'failed',
  'obsolete',
  'stale',
  'needs_review',
] as const
export const BARDWIKI_JOB_KINDS = ['apply_turn', 'reconcile_receipt', 'rebuild_chat'] as const
export const BARDWIKI_JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const

export const BARDWIKI_MAX_DOCUMENTS_PER_CHAT = 2_000
export const BARDWIKI_MAX_MARKDOWN_BYTES = 256 * 1024
export const BARDWIKI_MAX_TITLE_CODE_POINTS = 200
export const BARDWIKI_MAX_PATH_BYTES = 512
export const BARDWIKI_MAX_PATH_SEGMENTS = 16
export const BARDWIKI_MAX_PATH_SEGMENT_CODE_POINTS = 100
export const BARDWIKI_MAX_ALIASES = 32
export const BARDWIKI_MAX_ALIAS_CODE_POINTS = 100
export const BARDWIKI_MAX_LINKS_PER_DOCUMENT = 256
export const BARDWIKI_MAX_SEARCH_BODY_BYTES = 64 * 1024

const RESERVED_ROOT_PATHS = new Set(['.bardwiki', 'manifest.json', 'attachments'])
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/u
const WIKILINK_RE = /\[\[([^\]\r\n]+)\]\]/gu
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/gmu

export type BardWikiDocumentKind = (typeof BARDWIKI_DOCUMENT_KINDS)[number]
export type BardWikiContextPolicy = (typeof BARDWIKI_CONTEXT_POLICIES)[number]
export type BardWikiReviewState = (typeof BARDWIKI_REVIEW_STATES)[number]
export type BardWikiMemoryMode = (typeof BARDWIKI_MEMORY_MODES)[number]
export type BardWikiConfirmationPolicy = (typeof BARDWIKI_CONFIRMATION_POLICIES)[number]

export interface BardWikiChatSettings {
  chatId: string
  enabledOverride: boolean | null
  memoryModeOverride: BardWikiMemoryMode | null
  confirmationPolicyOverride: BardWikiConfirmationPolicy | null
  canonicalUpdatesOverride: boolean | null
  totalTokenBudgetOverride: number | null
  hybridHypaTokenBudgetOverride: number | null
  hybridBardWikiTokenBudgetOverride: number | null
  maxDocumentsOverride: number | null
  maxLinkHopsOverride: 0 | 1 | 2 | null
  recentMessageCountOverride: number | null
  modelProfileIdOverride: string | null
  modelProfileIdIsSet: boolean
  promptPresetIdOverride: string | null
  promptPresetIdIsSet: boolean
  createdAt: string
  updatedAt: string
}

export type BardWikiChatSettingsPatch = Partial<Omit<BardWikiChatSettings, 'chatId' | 'createdAt' | 'updatedAt'>>

export interface BardWikiDocument {
  id: string
  chatId: string
  kind: BardWikiDocumentKind
  title: string
  logicalPath: string
  normalizedPath: string
  aliases: string[]
  contextPolicy: BardWikiContextPolicy
  reviewState: BardWikiReviewState
  markdown: string
  contentHash: string
  version: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface BardWikiDocumentVersion {
  documentId: string
  version: number
  kind: BardWikiDocumentKind
  title: string
  logicalPath: string
  normalizedPath: string
  aliases: string[]
  contextPolicy: BardWikiContextPolicy
  reviewState: BardWikiReviewState
  markdown: string
  contentHash: string
  deleted: boolean
  actor: 'user' | 'model' | 'system'
  reason: 'create' | 'update' | 'delete' | 'analysis' | 'canonical' | 'reconcile' | 'rebuild' | 'import'
  receiptId: string | null
  jobId: string | null
  commandRevision: number
  createdAt: string
}

export interface BardWikiLink {
  sourceDocumentId: string
  sourceVersion: number
  ordinal: number
  rawTarget: string
  normalizedTarget: string
  resolvedDocumentId: string | null
}

export interface BardWikiReceiptSummary {
  id: string
  chatId: string
  userMessageId: string
  userContentHash: string
  assistantMessageId: string
  assistantContentHash: string
  confirmationMode: 'explicit' | 'automatic' | 'rebuild'
  state: (typeof BARDWIKI_RECEIPT_STATES)[number]
  eventDocumentId: string | null
  jobId: string | null
  errorCode: string | null
  errorSummary: string | null
  createdAt: string
  updatedAt: string
  appliedAt: string | null
}

export interface BardWikiJobSummary {
  id: string
  instanceId: string
  chatId: string
  receiptId: string | null
  kind: (typeof BARDWIKI_JOB_KINDS)[number]
  status: (typeof BARDWIKI_JOB_STATUSES)[number]
  errorCode: string | null
  errorSummary: string | null
  attemptCount: number
  maxAttempts: number
  progressCurrent: number | null
  progressTotal: number | null
  nextRunAt: string
  createdAt: string
  updatedAt: string
  operationId?: string
  operationAttemptNo?: number
  generationScope?: PersistedGenerationScope
}

export interface BardWikiDocumentWriteInput {
  id?: string
  chatId: string
  kind: BardWikiDocumentKind
  title: string
  logicalPath: string
  aliases?: readonly string[]
  contextPolicy?: BardWikiContextPolicy
  reviewState?: BardWikiReviewState
  markdown: string
  actor?: BardWikiDocumentVersion['actor']
  reason?: BardWikiDocumentVersion['reason']
  receiptId?: string | null
  jobId?: string | null
  commandRevision: number
}

export interface BardWikiDocumentUpdateInput {
  expectedVersion: number
  expectedContentHash: string
  kind?: BardWikiDocumentKind
  title?: string
  logicalPath?: string
  aliases?: readonly string[]
  contextPolicy?: BardWikiContextPolicy
  reviewState?: BardWikiReviewState
  markdown?: string
  actor?: BardWikiDocumentVersion['actor']
  reason?: BardWikiDocumentVersion['reason']
  receiptId?: string | null
  jobId?: string | null
  commandRevision: number
}

export class BardWikiValidationError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'BardWikiValidationError'
    this.code = code
  }
}

export class BardWikiConflictError extends Error {
  readonly code: string

  constructor(code: 'bardwiki_document_conflict' | 'bardwiki_path_conflict', message = code) {
    super(message)
    this.name = 'BardWikiConflictError'
    this.code = code
  }
}

export function createBardWikiTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bardwiki_chat_settings (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      enabled_override INTEGER CHECK (enabled_override IS NULL OR enabled_override IN (0, 1)),
      memory_mode_override TEXT CHECK (
        memory_mode_override IS NULL OR memory_mode_override IN ('hypa', 'bardwiki', 'hybrid')
      ),
      confirmation_policy_override TEXT CHECK (
        confirmation_policy_override IS NULL OR confirmation_policy_override IN ('manual', 'automatic')
      ),
      canonical_updates_override INTEGER CHECK (
        canonical_updates_override IS NULL OR canonical_updates_override IN (0, 1)
      ),
      total_token_budget_override INTEGER CHECK (
        total_token_budget_override IS NULL OR total_token_budget_override BETWEEN 0 AND 32768
      ),
      hybrid_hypa_token_budget_override INTEGER CHECK (
        hybrid_hypa_token_budget_override IS NULL OR hybrid_hypa_token_budget_override BETWEEN 0 AND 32768
      ),
      hybrid_bardwiki_token_budget_override INTEGER CHECK (
        hybrid_bardwiki_token_budget_override IS NULL OR hybrid_bardwiki_token_budget_override BETWEEN 0 AND 32768
      ),
      max_documents_override INTEGER CHECK (
        max_documents_override IS NULL OR max_documents_override BETWEEN 1 AND 32
      ),
      max_link_hops_override INTEGER CHECK (
        max_link_hops_override IS NULL OR max_link_hops_override BETWEEN 0 AND 2
      ),
      recent_message_count_override INTEGER CHECK (
        recent_message_count_override IS NULL OR recent_message_count_override BETWEEN 1 AND 50
      ),
      model_profile_id_override TEXT,
      model_profile_id_is_set INTEGER NOT NULL DEFAULT 0 CHECK (model_profile_id_is_set IN (0, 1)),
      prompt_preset_id_override TEXT,
      prompt_preset_id_is_set INTEGER NOT NULL DEFAULT 0 CHECK (prompt_preset_id_is_set IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS bardwiki_documents (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('event', 'character', 'location', 'scene', 'faction', 'item', 'concept', 'other')
      ),
      title TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
      context_policy TEXT NOT NULL CHECK (context_policy IN ('never', 'relevant', 'always', 'pinned')),
      review_state TEXT NOT NULL CHECK (review_state IN ('active', 'needs_review', 'archived')),
      markdown TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bardwiki_documents_live_path
      ON bardwiki_documents (chat_id, normalized_path)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_bardwiki_documents_chat_live
      ON bardwiki_documents (chat_id, deleted_at, normalized_path, id);

    CREATE TABLE IF NOT EXISTS bardwiki_turn_receipts (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      user_content_hash TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      assistant_content_hash TEXT NOT NULL,
      confirmation_mode TEXT NOT NULL CHECK (confirmation_mode IN ('explicit', 'automatic', 'rebuild')),
      state TEXT NOT NULL CHECK (
        state IN ('queued', 'processing', 'applied', 'failed', 'obsolete', 'stale', 'needs_review')
      ),
      change_set_id TEXT NOT NULL UNIQUE,
      event_document_id TEXT REFERENCES bardwiki_documents(id) ON DELETE SET NULL,
      job_id TEXT,
      error_code TEXT,
      error_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      applied_at TEXT,
      UNIQUE (
        chat_id,
        user_message_id,
        user_content_hash,
        assistant_message_id,
        assistant_content_hash
      )
    );
    CREATE INDEX IF NOT EXISTS idx_bardwiki_receipts_chat_state
      ON bardwiki_turn_receipts (chat_id, state, updated_at, id);

    CREATE TABLE IF NOT EXISTS bardwiki_jobs (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      receipt_id TEXT REFERENCES bardwiki_turn_receipts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('apply_turn', 'reconcile_receipt', 'rebuild_chat')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 16384),
      error_code TEXT,
      error_summary TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
      next_run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      operation_id TEXT,
      operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0),
      admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only')),
      occupancy_database_lineage TEXT,
      occupancy_session_id TEXT,
      occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0),
      occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only')),
      permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0),
      permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bardwiki_jobs_status_due
      ON bardwiki_jobs (status, next_run_at, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_bardwiki_jobs_chat_status
      ON bardwiki_jobs (chat_id, status, updated_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bardwiki_jobs_active_receipt_kind
      ON bardwiki_jobs (receipt_id, kind)
      WHERE receipt_id IS NOT NULL AND status IN ('pending', 'running');

    CREATE TABLE IF NOT EXISTS bardwiki_document_versions (
      document_id TEXT NOT NULL REFERENCES bardwiki_documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version >= 1),
      kind TEXT NOT NULL CHECK (
        kind IN ('event', 'character', 'location', 'scene', 'faction', 'item', 'concept', 'other')
      ),
      title TEXT NOT NULL,
      logical_path TEXT NOT NULL,
      normalized_path TEXT NOT NULL,
      aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
      context_policy TEXT NOT NULL CHECK (context_policy IN ('never', 'relevant', 'always', 'pinned')),
      review_state TEXT NOT NULL CHECK (review_state IN ('active', 'needs_review', 'archived')),
      markdown TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
      actor TEXT NOT NULL CHECK (actor IN ('user', 'model', 'system')),
      reason TEXT NOT NULL CHECK (
        reason IN ('create', 'update', 'delete', 'analysis', 'canonical', 'reconcile', 'rebuild', 'import')
      ),
      receipt_id TEXT REFERENCES bardwiki_turn_receipts(id) ON DELETE SET NULL,
      job_id TEXT REFERENCES bardwiki_jobs(id) ON DELETE SET NULL,
      command_revision INTEGER NOT NULL CHECK (command_revision >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (document_id, version)
    );

    CREATE TABLE IF NOT EXISTS bardwiki_document_sources (
      document_id TEXT NOT NULL,
      document_version INTEGER NOT NULL,
      receipt_id TEXT NOT NULL REFERENCES bardwiki_turn_receipts(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content_hash TEXT NOT NULL,
      PRIMARY KEY (document_id, document_version, receipt_id, message_id, role),
      FOREIGN KEY (document_id, document_version)
        REFERENCES bardwiki_document_versions(document_id, version) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bardwiki_sources_message
      ON bardwiki_document_sources (message_id, content_hash, receipt_id);

    CREATE TABLE IF NOT EXISTS bardwiki_links (
      source_document_id TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      raw_target TEXT NOT NULL,
      normalized_target TEXT NOT NULL,
      resolved_document_id TEXT REFERENCES bardwiki_documents(id) ON DELETE SET NULL,
      PRIMARY KEY (source_document_id, source_version, ordinal),
      FOREIGN KEY (source_document_id, source_version)
        REFERENCES bardwiki_document_versions(document_id, version) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bardwiki_links_target
      ON bardwiki_links (normalized_target, resolved_document_id);

    CREATE TABLE IF NOT EXISTS bardwiki_change_manifest (
      receipt_id TEXT NOT NULL REFERENCES bardwiki_turn_receipts(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES bardwiki_documents(id) ON DELETE CASCADE,
      before_version INTEGER,
      before_hash TEXT,
      after_version INTEGER,
      after_hash TEXT,
      PRIMARY KEY (receipt_id, document_id)
    );

    CREATE TABLE IF NOT EXISTS bardwiki_document_search (
      document_id TEXT PRIMARY KEY REFERENCES bardwiki_documents(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      title_terms TEXT NOT NULL,
      alias_terms TEXT NOT NULL,
      heading_terms TEXT NOT NULL,
      body_terms TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bardwiki_search_chat ON bardwiki_document_search (chat_id, document_id);

    CREATE TABLE IF NOT EXISTS bardwiki_rebuild_staging (
      rebuild_job_id TEXT NOT NULL REFERENCES bardwiki_jobs(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      change_json TEXT NOT NULL CHECK (json_valid(change_json)),
      PRIMARY KEY (rebuild_job_id, ordinal)
    );
  `)
  ensureBardWikiJobScopeColumns(db)
}

function ensureBardWikiJobScopeColumns(db: DatabaseSync): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(bardwiki_jobs)').all() as Array<{ name: string }>).map((row) => row.name),
  )
  const columns: ReadonlyArray<readonly [string, string]> = [
    ['operation_id', 'ALTER TABLE bardwiki_jobs ADD COLUMN operation_id TEXT'],
    [
      'operation_attempt_no',
      'ALTER TABLE bardwiki_jobs ADD COLUMN operation_attempt_no INTEGER CHECK (operation_attempt_no IS NULL OR operation_attempt_no > 0)',
    ],
    [
      'admission_kind',
      "ALTER TABLE bardwiki_jobs ADD COLUMN admission_kind TEXT CHECK (admission_kind IS NULL OR admission_kind IN ('legacy_owner', 'owner_occupancy', 'chat_only'))",
    ],
    ['occupancy_database_lineage', 'ALTER TABLE bardwiki_jobs ADD COLUMN occupancy_database_lineage TEXT'],
    ['occupancy_session_id', 'ALTER TABLE bardwiki_jobs ADD COLUMN occupancy_session_id TEXT'],
    [
      'occupancy_epoch',
      'ALTER TABLE bardwiki_jobs ADD COLUMN occupancy_epoch INTEGER CHECK (occupancy_epoch IS NULL OR occupancy_epoch >= 0)',
    ],
    [
      'occupancy_claim_class',
      "ALTER TABLE bardwiki_jobs ADD COLUMN occupancy_claim_class TEXT CHECK (occupancy_claim_class IS NULL OR occupancy_claim_class IN ('owner', 'chat_only'))",
    ],
    [
      'permission_scope_version',
      'ALTER TABLE bardwiki_jobs ADD COLUMN permission_scope_version INTEGER CHECK (permission_scope_version IS NULL OR permission_scope_version > 0)',
    ],
    [
      'permission_scope_json',
      'ALTER TABLE bardwiki_jobs ADD COLUMN permission_scope_json TEXT CHECK (permission_scope_json IS NULL OR json_valid(permission_scope_json))',
    ],
  ]
  for (const [name, sql] of columns) if (!existing.has(name)) db.exec(sql)
}

export function normalizeBardWikiText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function normalizeBardWikiMatch(value: string): string {
  return normalizeBardWikiText(value).toLowerCase()
}

export function normalizeBardWikiPath(value: string): { logicalPath: string; normalizedPath: string } {
  if (typeof value !== 'string') throw new BardWikiValidationError('bardwiki_invalid_path')
  const slashNormalized = value
    .normalize('NFKC')
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
  if (slashNormalized.startsWith('/') || slashNormalized.endsWith('/')) {
    throw new BardWikiValidationError('bardwiki_invalid_path')
  }
  const segments = slashNormalized.split('/').map((segment) => normalizeBardWikiText(segment))
  if (
    segments.length === 0 ||
    segments.length > BARDWIKI_MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        CONTROL_CHARACTER_RE.test(segment) ||
        /[. ]$/u.test(segment) ||
        [...segment].length > BARDWIKI_MAX_PATH_SEGMENT_CODE_POINTS,
    )
  ) {
    throw new BardWikiValidationError('bardwiki_invalid_path')
  }
  if (RESERVED_ROOT_PATHS.has(segments[0].toLowerCase())) {
    throw new BardWikiValidationError('bardwiki_invalid_path')
  }
  const logicalPath = segments.join('/')
  if (Buffer.byteLength(logicalPath, 'utf8') > BARDWIKI_MAX_PATH_BYTES) {
    throw new BardWikiValidationError('bardwiki_invalid_path')
  }
  return { logicalPath, normalizedPath: logicalPath.toLowerCase() }
}

export function normalizeBardWikiTitle(value: string): string {
  const title = normalizeBardWikiText(value)
  if (title.length === 0 || [...title].length > BARDWIKI_MAX_TITLE_CODE_POINTS || CONTROL_CHARACTER_RE.test(title)) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki title is invalid')
  }
  return title
}

export function normalizeBardWikiAliases(values: readonly string[] = []): string[] {
  if (!Array.isArray(values) || values.length > BARDWIKI_MAX_ALIASES) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki alias limit exceeded')
  }
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const alias = normalizeBardWikiText(value)
    if (alias.length === 0 || [...alias].length > BARDWIKI_MAX_ALIAS_CODE_POINTS || CONTROL_CHARACTER_RE.test(alias)) {
      throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki alias is invalid')
    }
    const key = alias.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      aliases.push(alias)
    }
  }
  return aliases
}

export function requireBardWikiMarkdown(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > BARDWIKI_MAX_MARKDOWN_BYTES) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki Markdown limit exceeded')
  }
  return value.replace(/\r\n?/gu, '\n')
}

export function hashBardWikiDocumentContent(
  input: Pick<
    BardWikiDocument,
    'kind' | 'title' | 'logicalPath' | 'aliases' | 'contextPolicy' | 'reviewState' | 'markdown'
  > & { deleted?: boolean },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: input.kind,
        title: input.title,
        logicalPath: input.logicalPath,
        aliases: input.aliases,
        contextPolicy: input.contextPolicy,
        reviewState: input.reviewState,
        markdown: input.markdown,
        deleted: input.deleted === true,
      }),
    )
    .digest('hex')
}

export function extractBardWikiLinks(markdown: string): Array<{ rawTarget: string; normalizedTarget: string }> {
  const links: Array<{ rawTarget: string; normalizedTarget: string }> = []
  for (const match of markdown.matchAll(WIKILINK_RE)) {
    const rawTarget = normalizeBardWikiText(match[1].split('|', 1)[0])
    const targetWithoutHeading = normalizeBardWikiText(rawTarget.split('#', 1)[0])
    if (!targetWithoutHeading) continue
    links.push({ rawTarget, normalizedTarget: normalizeBardWikiMatch(targetWithoutHeading) })
    if (links.length > BARDWIKI_MAX_LINKS_PER_DOCUMENT) {
      throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki wikilink limit exceeded')
    }
  }
  return links
}

export function extractBardWikiHeadings(markdown: string): string[] {
  return [...markdown.matchAll(HEADING_RE)].map((match) => normalizeBardWikiText(match[1])).filter(Boolean)
}

export function getBardWikiChatSettings(db: DatabaseSync, chatId: string): BardWikiChatSettings | null {
  const raw: unknown = db.prepare('SELECT * FROM bardwiki_chat_settings WHERE chat_id = ?').get(chatId)
  const row = raw as BardWikiChatSettingsRow | undefined
  return row ? mapChatSettingsRow(row) : null
}

export function updateBardWikiChatSettings(
  db: DatabaseSync,
  chatId: string,
  patch: BardWikiChatSettingsPatch,
): BardWikiChatSettings {
  requireExistingChat(db, chatId)
  const current = getBardWikiChatSettings(db, chatId)
  const next = {
    enabledOverride: patch.enabledOverride !== undefined ? patch.enabledOverride : (current?.enabledOverride ?? null),
    memoryModeOverride:
      patch.memoryModeOverride !== undefined ? patch.memoryModeOverride : (current?.memoryModeOverride ?? null),
    confirmationPolicyOverride:
      patch.confirmationPolicyOverride !== undefined
        ? patch.confirmationPolicyOverride
        : (current?.confirmationPolicyOverride ?? null),
    canonicalUpdatesOverride:
      patch.canonicalUpdatesOverride !== undefined
        ? patch.canonicalUpdatesOverride
        : (current?.canonicalUpdatesOverride ?? null),
    totalTokenBudgetOverride:
      patch.totalTokenBudgetOverride !== undefined
        ? patch.totalTokenBudgetOverride
        : (current?.totalTokenBudgetOverride ?? null),
    hybridHypaTokenBudgetOverride:
      patch.hybridHypaTokenBudgetOverride !== undefined
        ? patch.hybridHypaTokenBudgetOverride
        : (current?.hybridHypaTokenBudgetOverride ?? null),
    hybridBardWikiTokenBudgetOverride:
      patch.hybridBardWikiTokenBudgetOverride !== undefined
        ? patch.hybridBardWikiTokenBudgetOverride
        : (current?.hybridBardWikiTokenBudgetOverride ?? null),
    maxDocumentsOverride:
      patch.maxDocumentsOverride !== undefined ? patch.maxDocumentsOverride : (current?.maxDocumentsOverride ?? null),
    maxLinkHopsOverride:
      patch.maxLinkHopsOverride !== undefined ? patch.maxLinkHopsOverride : (current?.maxLinkHopsOverride ?? null),
    recentMessageCountOverride:
      patch.recentMessageCountOverride !== undefined
        ? patch.recentMessageCountOverride
        : (current?.recentMessageCountOverride ?? null),
    modelProfileIdOverride:
      patch.modelProfileIdOverride !== undefined
        ? normalizeOptionalReference(patch.modelProfileIdOverride)
        : (current?.modelProfileIdOverride ?? null),
    modelProfileIdIsSet: patch.modelProfileIdIsSet ?? current?.modelProfileIdIsSet ?? false,
    promptPresetIdOverride:
      patch.promptPresetIdOverride !== undefined
        ? normalizeOptionalReference(patch.promptPresetIdOverride)
        : (current?.promptPresetIdOverride ?? null),
    promptPresetIdIsSet: patch.promptPresetIdIsSet ?? current?.promptPresetIdIsSet ?? false,
  }
  validateChatSettings(next)
  db.prepare(
    `INSERT INTO bardwiki_chat_settings (
      chat_id, enabled_override, memory_mode_override, confirmation_policy_override,
      canonical_updates_override, total_token_budget_override, hybrid_hypa_token_budget_override,
      hybrid_bardwiki_token_budget_override, max_documents_override, max_link_hops_override,
      recent_message_count_override, model_profile_id_override, model_profile_id_is_set,
      prompt_preset_id_override, prompt_preset_id_is_set
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      enabled_override = excluded.enabled_override,
      memory_mode_override = excluded.memory_mode_override,
      confirmation_policy_override = excluded.confirmation_policy_override,
      canonical_updates_override = excluded.canonical_updates_override,
      total_token_budget_override = excluded.total_token_budget_override,
      hybrid_hypa_token_budget_override = excluded.hybrid_hypa_token_budget_override,
      hybrid_bardwiki_token_budget_override = excluded.hybrid_bardwiki_token_budget_override,
      max_documents_override = excluded.max_documents_override,
      max_link_hops_override = excluded.max_link_hops_override,
      recent_message_count_override = excluded.recent_message_count_override,
      model_profile_id_override = excluded.model_profile_id_override,
      model_profile_id_is_set = excluded.model_profile_id_is_set,
      prompt_preset_id_override = excluded.prompt_preset_id_override,
      prompt_preset_id_is_set = excluded.prompt_preset_id_is_set,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).run(
    chatId,
    booleanToSql(next.enabledOverride),
    next.memoryModeOverride,
    next.confirmationPolicyOverride,
    booleanToSql(next.canonicalUpdatesOverride),
    next.totalTokenBudgetOverride,
    next.hybridHypaTokenBudgetOverride,
    next.hybridBardWikiTokenBudgetOverride,
    next.maxDocumentsOverride,
    next.maxLinkHopsOverride,
    next.recentMessageCountOverride,
    next.modelProfileIdOverride,
    next.modelProfileIdIsSet ? 1 : 0,
    next.promptPresetIdOverride,
    next.promptPresetIdIsSet ? 1 : 0,
  )
  return getBardWikiChatSettings(db, chatId) as BardWikiChatSettings
}

export function getBardWikiDocument(
  db: DatabaseSync,
  chatId: string,
  documentId: string,
  options: { includeDeleted?: boolean } = {},
): BardWikiDocument | null {
  const raw: unknown = db
    .prepare(
      `SELECT * FROM bardwiki_documents
       WHERE chat_id = ? AND id = ?${options.includeDeleted === true ? '' : ' AND deleted_at IS NULL'}`,
    )
    .get(chatId, documentId)
  const row = raw as BardWikiDocumentRow | undefined
  return row ? mapDocumentRow(row) : null
}

export function listBardWikiDocuments(
  db: DatabaseSync,
  chatId: string,
  options: { includeDeleted?: boolean } = {},
): BardWikiDocument[] {
  const rows = db
    .prepare(
      `SELECT * FROM bardwiki_documents
       WHERE chat_id = ?${options.includeDeleted === true ? '' : ' AND deleted_at IS NULL'}
       ORDER BY normalized_path, id`,
    )
    .all(chatId) as unknown as BardWikiDocumentRow[]
  return rows.map(mapDocumentRow)
}

export function listBardWikiDocumentVersions(
  db: DatabaseSync,
  documentId: string,
  limit = 100,
): BardWikiDocumentVersion[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const rows = db
    .prepare('SELECT * FROM bardwiki_document_versions WHERE document_id = ? ORDER BY version DESC LIMIT ?')
    .all(documentId, safeLimit) as unknown as BardWikiDocumentVersionRow[]
  return rows.map(mapDocumentVersionRow)
}

export function getBardWikiDocumentVersion(
  db: DatabaseSync,
  documentId: string,
  version: number,
): BardWikiDocumentVersion | null {
  const row = db
    .prepare('SELECT * FROM bardwiki_document_versions WHERE document_id = ? AND version = ?')
    .get(documentId, version) as unknown as BardWikiDocumentVersionRow | undefined
  return row ? mapDocumentVersionRow(row) : null
}

export function listBardWikiDocumentVersionPage(
  db: DatabaseSync,
  documentId: string,
  input: { limit: number; beforeVersion?: number },
): { versions: BardWikiDocumentVersion[]; nextBeforeVersion: number | null } {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)))
  const rows = db
    .prepare(
      `SELECT * FROM bardwiki_document_versions
       WHERE document_id = ?${input.beforeVersion === undefined ? '' : ' AND version < ?'}
       ORDER BY version DESC LIMIT ?`,
    )
    .all(
      documentId,
      ...(input.beforeVersion === undefined ? [limit + 1] : [input.beforeVersion, limit + 1]),
    ) as unknown as BardWikiDocumentVersionRow[]
  const hasNext = rows.length > limit
  const versions = rows.slice(0, limit).map(mapDocumentVersionRow)
  return {
    versions,
    nextBeforeVersion: hasNext && versions.length > 0 ? versions[versions.length - 1].version : null,
  }
}

export function listBardWikiReceiptSummaries(db: DatabaseSync, chatId: string, limit = 100): BardWikiReceiptSummary[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const rows = db
    .prepare(
      `SELECT id, chat_id, user_message_id, user_content_hash, assistant_message_id,
              assistant_content_hash, confirmation_mode, state, event_document_id,
              job_id, error_code, error_summary, created_at, updated_at, applied_at
       FROM bardwiki_turn_receipts WHERE chat_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(chatId, safeLimit) as unknown as BardWikiReceiptSummaryRow[]
  return rows.map(mapReceiptSummaryRow)
}

export function getBardWikiReceiptSummary(db: DatabaseSync, receiptId: string): BardWikiReceiptSummary | null {
  const row = db
    .prepare(
      `SELECT id, chat_id, user_message_id, user_content_hash, assistant_message_id,
              assistant_content_hash, confirmation_mode, state, event_document_id,
              job_id, error_code, error_summary, created_at, updated_at, applied_at
       FROM bardwiki_turn_receipts WHERE id = ?`,
    )
    .get(receiptId) as unknown as BardWikiReceiptSummaryRow | undefined
  return row ? mapReceiptSummaryRow(row) : null
}

function mapReceiptSummaryRow(row: BardWikiReceiptSummaryRow): BardWikiReceiptSummary {
  return {
    id: row.id,
    chatId: row.chat_id,
    userMessageId: row.user_message_id,
    userContentHash: row.user_content_hash,
    assistantMessageId: row.assistant_message_id,
    assistantContentHash: row.assistant_content_hash,
    confirmationMode: row.confirmation_mode,
    state: row.state,
    eventDocumentId: row.event_document_id,
    jobId: row.job_id,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
  }
}

export function listBardWikiJobSummaries(db: DatabaseSync, chatId: string, limit = 100): BardWikiJobSummary[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const rows = db
    .prepare(
      `SELECT id, instance_id, chat_id, receipt_id, kind, status, error_code,
              error_summary, attempt_count, max_attempts,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceCursor') END AS progress_current,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceTotal') END AS progress_total,
              next_run_at, created_at, updated_at
       FROM bardwiki_jobs WHERE chat_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(chatId, safeLimit) as unknown as BardWikiJobSummaryRow[]
  return rows.map(mapJobSummaryRow)
}

export function listBardWikiJobSnapshotSummaries(db: DatabaseSync, terminalLimit = 50): BardWikiJobSummary[] {
  const active = db
    .prepare(
      `SELECT id, instance_id, chat_id, receipt_id, kind, status, error_code,
              error_summary, attempt_count, max_attempts,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceCursor') END AS progress_current,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceTotal') END AS progress_total,
              next_run_at, created_at, updated_at
       FROM bardwiki_jobs WHERE status IN ('pending', 'running')
       ORDER BY created_at, id`,
    )
    .all() as unknown as BardWikiJobSummaryRow[]
  const terminal = db
    .prepare(
      `SELECT id, instance_id, chat_id, receipt_id, kind, status, error_code,
              error_summary, attempt_count, max_attempts,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceCursor') END AS progress_current,
              CASE WHEN kind = 'rebuild_chat' THEN json_extract(payload_json, '$.sourceTotal') END AS progress_total,
              next_run_at, created_at, updated_at
       FROM bardwiki_jobs WHERE status IN ('completed', 'failed', 'cancelled')
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(Math.max(0, Math.min(100, Math.trunc(terminalLimit)))) as unknown as BardWikiJobSummaryRow[]
  return [...active, ...terminal].map(mapJobSummaryRow)
}

function mapJobSummaryRow(row: BardWikiJobSummaryRow): BardWikiJobSummary {
  return {
    id: row.id,
    instanceId: row.instance_id,
    chatId: row.chat_id,
    receiptId: row.receipt_id,
    kind: row.kind,
    status: row.status,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listBardWikiLinks(db: DatabaseSync, documentId: string, version?: number): BardWikiLink[] {
  const resolvedVersion =
    version ??
    (
      db.prepare('SELECT version FROM bardwiki_documents WHERE id = ?').get(documentId) as
        | { version: number }
        | undefined
    )?.version
  if (resolvedVersion === undefined) return []
  return (
    db
      .prepare(
        `SELECT source_document_id, source_version, ordinal, raw_target, normalized_target, resolved_document_id
         FROM bardwiki_links WHERE source_document_id = ? AND source_version = ? ORDER BY ordinal`,
      )
      .all(documentId, resolvedVersion) as unknown as BardWikiLinkRow[]
  ).map(mapLinkRow)
}

export function createBardWikiDocument(db: DatabaseSync, input: BardWikiDocumentWriteInput): BardWikiDocument {
  requireExistingChat(db, input.chatId)
  const count = db.prepare('SELECT COUNT(*) AS count FROM bardwiki_documents WHERE chat_id = ?').get(input.chatId) as {
    count: number
  }
  if (count.count >= BARDWIKI_MAX_DOCUMENTS_PER_CHAT) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'BardWiki document limit exceeded')
  }
  const normalized = normalizeDocumentWrite(input)
  const id = input.id ?? randomUUID()
  const contentHash = hashBardWikiDocumentContent(normalized)
  try {
    db.prepare(
      `INSERT INTO bardwiki_documents (
        id, chat_id, kind, title, logical_path, normalized_path, aliases_json,
        context_policy, review_state, markdown, content_hash, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      id,
      input.chatId,
      normalized.kind,
      normalized.title,
      normalized.logicalPath,
      normalized.normalizedPath,
      JSON.stringify(normalized.aliases),
      normalized.contextPolicy,
      normalized.reviewState,
      normalized.markdown,
      contentHash,
    )
  } catch (error) {
    throwPathConflict(error)
  }
  const created = requireDocument(db, input.chatId, id, true)
  insertDocumentVersion(db, created, {
    actor: input.actor ?? 'user',
    reason: input.reason ?? 'create',
    receiptId: input.receiptId ?? null,
    jobId: input.jobId ?? null,
    commandRevision: requireRevision(input.commandRevision),
    deleted: false,
  })
  replaceDocumentProjections(db, created)
  resolveBardWikiLinksForChat(db, input.chatId)
  return requireDocument(db, input.chatId, id, true)
}

export function updateBardWikiDocument(
  db: DatabaseSync,
  chatId: string,
  documentId: string,
  input: BardWikiDocumentUpdateInput,
): BardWikiDocument {
  const existing = requireDocument(db, chatId, documentId)
  requireDocumentFence(existing, input.expectedVersion, input.expectedContentHash)
  const normalized = normalizeDocumentWrite({
    chatId,
    commandRevision: input.commandRevision,
    kind: input.kind ?? existing.kind,
    title: input.title ?? existing.title,
    logicalPath: input.logicalPath ?? existing.logicalPath,
    aliases: input.aliases ?? existing.aliases,
    contextPolicy: input.contextPolicy ?? existing.contextPolicy,
    reviewState: input.reviewState ?? existing.reviewState,
    markdown: input.markdown ?? existing.markdown,
  })
  const nextVersion = existing.version + 1
  const contentHash = hashBardWikiDocumentContent(normalized)
  try {
    const result = db
      .prepare(
        `UPDATE bardwiki_documents
         SET kind = ?, title = ?, logical_path = ?, normalized_path = ?, aliases_json = ?,
             context_policy = ?, review_state = ?, markdown = ?, content_hash = ?, version = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND chat_id = ? AND deleted_at IS NULL AND version = ? AND content_hash = ?`,
      )
      .run(
        normalized.kind,
        normalized.title,
        normalized.logicalPath,
        normalized.normalizedPath,
        JSON.stringify(normalized.aliases),
        normalized.contextPolicy,
        normalized.reviewState,
        normalized.markdown,
        contentHash,
        nextVersion,
        documentId,
        chatId,
        input.expectedVersion,
        input.expectedContentHash,
      )
    if (result.changes !== 1) throw new BardWikiConflictError('bardwiki_document_conflict')
  } catch (error) {
    if (error instanceof BardWikiConflictError) throw error
    throwPathConflict(error)
  }
  const updated = requireDocument(db, chatId, documentId)
  insertDocumentVersion(db, updated, {
    actor: input.actor ?? 'user',
    reason: input.reason ?? 'update',
    receiptId: input.receiptId ?? null,
    jobId: input.jobId ?? null,
    commandRevision: requireRevision(input.commandRevision),
    deleted: false,
  })
  replaceDocumentProjections(db, updated)
  resolveBardWikiLinksForChat(db, chatId)
  return updated
}

export function deleteBardWikiDocument(
  db: DatabaseSync,
  chatId: string,
  documentId: string,
  input: Pick<BardWikiDocumentUpdateInput, 'expectedVersion' | 'expectedContentHash' | 'commandRevision'> & {
    actor?: BardWikiDocumentVersion['actor']
    reason?: BardWikiDocumentVersion['reason']
    receiptId?: string | null
    jobId?: string | null
  },
): BardWikiDocument {
  const existing = requireDocument(db, chatId, documentId)
  requireDocumentFence(existing, input.expectedVersion, input.expectedContentHash)
  const nextVersion = existing.version + 1
  const contentHash = hashBardWikiDocumentContent({ ...existing, deleted: true })
  const result = db
    .prepare(
      `UPDATE bardwiki_documents
       SET content_hash = ?, version = ?, deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND chat_id = ? AND deleted_at IS NULL AND version = ? AND content_hash = ?`,
    )
    .run(contentHash, nextVersion, documentId, chatId, input.expectedVersion, input.expectedContentHash)
  if (result.changes !== 1) throw new BardWikiConflictError('bardwiki_document_conflict')
  const deleted = requireDocument(db, chatId, documentId, true)
  insertDocumentVersion(db, deleted, {
    actor: input.actor ?? 'user',
    reason: input.reason ?? 'delete',
    receiptId: input.receiptId ?? null,
    jobId: input.jobId ?? null,
    commandRevision: requireRevision(input.commandRevision),
    deleted: true,
  })
  db.prepare('DELETE FROM bardwiki_document_search WHERE document_id = ?').run(documentId)
  resolveBardWikiLinksForChat(db, chatId)
  return deleted
}

export function rebuildBardWikiSearchForChat(db: DatabaseSync, chatId: string): void {
  db.prepare('DELETE FROM bardwiki_document_search WHERE chat_id = ?').run(chatId)
  for (const document of listBardWikiDocuments(db, chatId)) upsertDocumentSearch(db, document)
  resolveBardWikiLinksForChat(db, chatId)
}

/** Recreate every derived BardWiki projection after a database replacement. */
export function rebuildAllBardWikiDerivedState(db: DatabaseSync): void {
  db.exec('DELETE FROM bardwiki_document_search')
  const chats = db.prepare('SELECT DISTINCT chat_id FROM bardwiki_documents ORDER BY chat_id').all() as Array<{
    chat_id: string
  }>
  for (const { chat_id: chatId } of chats) rebuildBardWikiSearchForChat(db, chatId)
}

export function resolveBardWikiLinksForChat(db: DatabaseSync, chatId: string): void {
  const documents = listBardWikiDocuments(db, chatId)
  const targets = new Map<string, string | null>()
  const addTarget = (key: string, id: string) => {
    const existing = targets.get(key)
    targets.set(key, existing === undefined || existing === id ? id : null)
  }
  for (const document of documents) {
    addTarget(document.normalizedPath, document.id)
    addTarget(normalizeBardWikiMatch(document.title), document.id)
    for (const alias of document.aliases) addTarget(normalizeBardWikiMatch(alias), document.id)
  }
  const update = db.prepare(
    'UPDATE bardwiki_links SET resolved_document_id = ? WHERE source_document_id = ? AND source_version = ? AND ordinal = ?',
  )
  const links = db
    .prepare(
      `SELECT links.* FROM bardwiki_links AS links
       JOIN bardwiki_documents AS documents ON documents.id = links.source_document_id
       WHERE documents.chat_id = ?
       ORDER BY links.source_document_id, links.source_version, links.ordinal`,
    )
    .all(chatId) as unknown as BardWikiLinkRow[]
  for (const link of links.map(mapLinkRow)) {
    update.run(targets.get(link.normalizedTarget) ?? null, link.sourceDocumentId, link.sourceVersion, link.ordinal)
  }
}

interface BardWikiChatSettingsRow {
  chat_id: string
  enabled_override: number | null
  memory_mode_override: BardWikiMemoryMode | null
  confirmation_policy_override: BardWikiConfirmationPolicy | null
  canonical_updates_override: number | null
  total_token_budget_override: number | null
  hybrid_hypa_token_budget_override: number | null
  hybrid_bardwiki_token_budget_override: number | null
  max_documents_override: number | null
  max_link_hops_override: 0 | 1 | 2 | null
  recent_message_count_override: number | null
  model_profile_id_override: string | null
  model_profile_id_is_set: number
  prompt_preset_id_override: string | null
  prompt_preset_id_is_set: number
  created_at: string
  updated_at: string
}

interface BardWikiDocumentRow {
  id: string
  chat_id: string
  kind: BardWikiDocumentKind
  title: string
  logical_path: string
  normalized_path: string
  aliases_json: string
  context_policy: BardWikiContextPolicy
  review_state: BardWikiReviewState
  markdown: string
  content_hash: string
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface BardWikiDocumentVersionRow {
  document_id: string
  version: number
  kind: BardWikiDocumentKind
  title: string
  logical_path: string
  normalized_path: string
  aliases_json: string
  context_policy: BardWikiContextPolicy
  review_state: BardWikiReviewState
  markdown: string
  content_hash: string
  deleted: number
  actor: BardWikiDocumentVersion['actor']
  reason: BardWikiDocumentVersion['reason']
  receipt_id: string | null
  job_id: string | null
  command_revision: number
  created_at: string
}

interface BardWikiLinkRow {
  source_document_id: string
  source_version: number
  ordinal: number
  raw_target: string
  normalized_target: string
  resolved_document_id: string | null
}

interface BardWikiReceiptSummaryRow {
  id: string
  chat_id: string
  user_message_id: string
  user_content_hash: string
  assistant_message_id: string
  assistant_content_hash: string
  confirmation_mode: BardWikiReceiptSummary['confirmationMode']
  state: BardWikiReceiptSummary['state']
  event_document_id: string | null
  job_id: string | null
  error_code: string | null
  error_summary: string | null
  created_at: string
  updated_at: string
  applied_at: string | null
}

interface BardWikiJobSummaryRow {
  id: string
  instance_id: string
  chat_id: string
  receipt_id: string | null
  kind: BardWikiJobSummary['kind']
  status: BardWikiJobSummary['status']
  error_code: string | null
  error_summary: string | null
  attempt_count: number
  max_attempts: number
  progress_current: number | null
  progress_total: number | null
  next_run_at: string
  created_at: string
  updated_at: string
}

function mapChatSettingsRow(row: BardWikiChatSettingsRow): BardWikiChatSettings {
  return {
    chatId: row.chat_id,
    enabledOverride: row.enabled_override === null ? null : row.enabled_override === 1,
    memoryModeOverride: row.memory_mode_override,
    confirmationPolicyOverride: row.confirmation_policy_override,
    canonicalUpdatesOverride: row.canonical_updates_override === null ? null : row.canonical_updates_override === 1,
    totalTokenBudgetOverride: row.total_token_budget_override,
    hybridHypaTokenBudgetOverride: row.hybrid_hypa_token_budget_override,
    hybridBardWikiTokenBudgetOverride: row.hybrid_bardwiki_token_budget_override,
    maxDocumentsOverride: row.max_documents_override,
    maxLinkHopsOverride: row.max_link_hops_override,
    recentMessageCountOverride: row.recent_message_count_override,
    modelProfileIdOverride: row.model_profile_id_override,
    modelProfileIdIsSet: row.model_profile_id_is_set === 1,
    promptPresetIdOverride: row.prompt_preset_id_override,
    promptPresetIdIsSet: row.prompt_preset_id_is_set === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDocumentRow(row: BardWikiDocumentRow): BardWikiDocument {
  return {
    id: row.id,
    chatId: row.chat_id,
    kind: row.kind,
    title: row.title,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    aliases: parseStringArray(row.aliases_json),
    contextPolicy: row.context_policy,
    reviewState: row.review_state,
    markdown: row.markdown,
    contentHash: row.content_hash,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function mapDocumentVersionRow(row: BardWikiDocumentVersionRow): BardWikiDocumentVersion {
  return {
    documentId: row.document_id,
    version: row.version,
    kind: row.kind,
    title: row.title,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    aliases: parseStringArray(row.aliases_json),
    contextPolicy: row.context_policy,
    reviewState: row.review_state,
    markdown: row.markdown,
    contentHash: row.content_hash,
    deleted: row.deleted === 1,
    actor: row.actor,
    reason: row.reason,
    receiptId: row.receipt_id,
    jobId: row.job_id,
    commandRevision: row.command_revision,
    createdAt: row.created_at,
  }
}

function mapLinkRow(row: BardWikiLinkRow): BardWikiLink {
  return {
    sourceDocumentId: row.source_document_id,
    sourceVersion: row.source_version,
    ordinal: row.ordinal,
    rawTarget: row.raw_target,
    normalizedTarget: row.normalized_target,
    resolvedDocumentId: row.resolved_document_id,
  }
}

function parseStringArray(json: string): string[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Invalid BardWiki string-array row')
  }
  return parsed
}

function normalizeDocumentWrite(input: Omit<BardWikiDocumentWriteInput, 'id'>): {
  kind: BardWikiDocumentKind
  title: string
  logicalPath: string
  normalizedPath: string
  aliases: string[]
  contextPolicy: BardWikiContextPolicy
  reviewState: BardWikiReviewState
  markdown: string
} {
  if (!BARDWIKI_DOCUMENT_KINDS.includes(input.kind)) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki document kind')
  }
  const path = normalizeBardWikiPath(input.logicalPath)
  const contextPolicy = input.contextPolicy ?? 'relevant'
  const reviewState = input.reviewState ?? 'active'
  if (!BARDWIKI_CONTEXT_POLICIES.includes(contextPolicy) || !BARDWIKI_REVIEW_STATES.includes(reviewState)) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki document metadata')
  }
  return {
    kind: input.kind,
    title: normalizeBardWikiTitle(input.title),
    ...path,
    aliases: normalizeBardWikiAliases(input.aliases),
    contextPolicy,
    reviewState,
    markdown: requireBardWikiMarkdown(input.markdown),
  }
}

function requireExistingChat(db: DatabaseSync, chatId: string): void {
  if (typeof chatId !== 'string' || !chatId || !db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) {
    throw new BardWikiValidationError('bardwiki_chat_not_found')
  }
}

function requireDocument(
  db: DatabaseSync,
  chatId: string,
  documentId: string,
  includeDeleted = false,
): BardWikiDocument {
  const document = getBardWikiDocument(db, chatId, documentId, { includeDeleted })
  if (!document) throw new BardWikiValidationError('bardwiki_document_not_found')
  return document
}

function requireDocumentFence(document: BardWikiDocument, expectedVersion: number, expectedContentHash: string): void {
  if (document.version !== expectedVersion || document.contentHash !== expectedContentHash) {
    throw new BardWikiConflictError('bardwiki_document_conflict')
  }
}

function requireRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki command revision')
  }
  return revision
}

function validateChatSettings(settings: Omit<BardWikiChatSettings, 'chatId' | 'createdAt' | 'updatedAt'>): void {
  if (
    (settings.enabledOverride !== null && typeof settings.enabledOverride !== 'boolean') ||
    (settings.canonicalUpdatesOverride !== null && typeof settings.canonicalUpdatesOverride !== 'boolean') ||
    (settings.memoryModeOverride !== null && !BARDWIKI_MEMORY_MODES.includes(settings.memoryModeOverride)) ||
    (settings.confirmationPolicyOverride !== null &&
      !BARDWIKI_CONFIRMATION_POLICIES.includes(settings.confirmationPolicyOverride))
  ) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki chat settings')
  }
  requireOptionalInteger(settings.totalTokenBudgetOverride, 0, 32_768)
  requireOptionalInteger(settings.hybridHypaTokenBudgetOverride, 0, 32_768)
  requireOptionalInteger(settings.hybridBardWikiTokenBudgetOverride, 0, 32_768)
  requireOptionalInteger(settings.maxDocumentsOverride, 1, 32)
  requireOptionalInteger(settings.maxLinkHopsOverride, 0, 2)
  requireOptionalInteger(settings.recentMessageCountOverride, 1, 50)
  if (typeof settings.modelProfileIdIsSet !== 'boolean' || typeof settings.promptPresetIdIsSet !== 'boolean') {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki reference override')
  }
}

function requireOptionalInteger(value: number | null, minimum: number, maximum: number): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki numeric setting')
  }
}

function normalizeOptionalReference(value: string | null): string | null {
  if (value === null) return null
  const normalized = normalizeBardWikiText(value)
  if (!normalized || [...normalized].length > 200 || CONTROL_CHARACTER_RE.test(normalized)) {
    throw new BardWikiValidationError('bardwiki_limit_exceeded', 'Invalid BardWiki reference override')
  }
  return normalized
}

function booleanToSql(value: boolean | null): 0 | 1 | null {
  return value === null ? null : value ? 1 : 0
}

function insertDocumentVersion(
  db: DatabaseSync,
  document: BardWikiDocument,
  metadata: Pick<BardWikiDocumentVersion, 'actor' | 'reason' | 'receiptId' | 'jobId' | 'commandRevision' | 'deleted'>,
): void {
  db.prepare(
    `INSERT INTO bardwiki_document_versions (
      document_id, version, kind, title, logical_path, normalized_path, aliases_json,
      context_policy, review_state, markdown, content_hash, deleted, actor, reason,
      receipt_id, job_id, command_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.version,
    document.kind,
    document.title,
    document.logicalPath,
    document.normalizedPath,
    JSON.stringify(document.aliases),
    document.contextPolicy,
    document.reviewState,
    document.markdown,
    document.contentHash,
    metadata.deleted ? 1 : 0,
    metadata.actor,
    metadata.reason,
    metadata.receiptId,
    metadata.jobId,
    metadata.commandRevision,
  )
}

function replaceDocumentProjections(db: DatabaseSync, document: BardWikiDocument): void {
  const links = extractBardWikiLinks(document.markdown)
  const insertLink = db.prepare(
    `INSERT INTO bardwiki_links (
      source_document_id, source_version, ordinal, raw_target, normalized_target
    ) VALUES (?, ?, ?, ?, ?)`,
  )
  for (const [ordinal, link] of links.entries()) {
    insertLink.run(document.id, document.version, ordinal, link.rawTarget, link.normalizedTarget)
  }
  upsertDocumentSearch(db, document)
}

function upsertDocumentSearch(db: DatabaseSync, document: BardWikiDocument): void {
  const bodyTerms = truncateUtf8(normalizeBardWikiMatch(document.markdown), BARDWIKI_MAX_SEARCH_BODY_BYTES)
  db.prepare(
    `INSERT INTO bardwiki_document_search (
      document_id, chat_id, title_terms, alias_terms, heading_terms, body_terms
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      title_terms = excluded.title_terms,
      alias_terms = excluded.alias_terms,
      heading_terms = excluded.heading_terms,
      body_terms = excluded.body_terms`,
  ).run(
    document.id,
    document.chatId,
    normalizeBardWikiMatch(document.title),
    document.aliases.map(normalizeBardWikiMatch).join('\n'),
    extractBardWikiHeadings(document.markdown).map(normalizeBardWikiMatch).join('\n'),
    bodyTerms,
  )
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let bytes = 0
  let result = ''
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + size > maxBytes) break
    result += codePoint
    bytes += size
  }
  return result
}

function throwPathConflict(error: unknown): never {
  if (
    error instanceof Error &&
    /UNIQUE constraint failed: bardwiki_documents\.chat_id, bardwiki_documents\.normalized_path/u.test(error.message)
  ) {
    throw new BardWikiConflictError('bardwiki_path_conflict')
  }
  throw error
}
