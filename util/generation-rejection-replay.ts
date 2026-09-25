/** Operator-run, offline generation guards. No application construction. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import Ajv, { type ErrorObject } from 'ajv'
import {
  generationInputSchemaId,
  generationInputSchemaPath,
  generationInputValidationOptions,
} from './generation-input-schema.js'
import type {
  GenerationInputValidationDomain,
  GenerationInputValidationError,
} from '../server/fastify/src/prompt/generationInputDecoder.js'
import type { AssembleInput } from '../server/fastify/src/prompt/assemble.js'
import type { ModelProfileStatusReason } from '@risuai/shared-core/model-profile-resolver'

const root = fileURLToPath(new URL('../', import.meta.url))
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const schema = JSON.parse(fs.readFileSync(generationInputSchemaPath, 'utf8'))
const knownKeys = new Set<string>(['database', 'currentChar', 'currentChat'])
function collectKeys(value: unknown): void {
  if (!record(value)) return
  if (record(value.properties)) Object.keys(value.properties).forEach((key) => knownKeys.add(key))
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(collectKeys)
    else collectKeys(child)
  }
}
collectKeys(schema)
const safeKey = (key: string, index: number) => (knownKeys.has(key) ? key : `<field-${index}>`)
const fieldRef = (field: string) =>
  createHash('sha256').update(`generation-input-field:${field}`).digest('hex').slice(0, 16)
const schemaFieldNames = new Map([...knownKeys].map((key) => [fieldRef(key), key]))
const schemaRoots = {
  preflight: 'GenerationPreflightInputs',
  database: 'FastifyDatabase',
  settings: 'GenerationSettings',
  provider: 'ProviderGenerationSettings',
  memory: 'MemoryGenerationSettings',
} as const
const ajv = new Ajv({ ...generationInputValidationOptions, allErrors: true })
ajv.addSchema({ $id: generationInputSchemaId, $defs: schema.$defs })
const validators = Object.fromEntries(
  Object.entries(schemaRoots).map(([domain, name]) => [
    domain,
    ajv.compile({ $ref: `${generationInputSchemaId}${schema[name].$ref}` }),
  ]),
)
const pointer = (location: string) =>
  location
    .replace(`${generationInputSchemaId}#`, '#')
    .replace(/^#?\//, '')
    .split('/')
    .filter(Boolean)
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
function at(value: unknown, segments: string[]): unknown {
  for (const key of segments)
    value =
      value !== null && typeof value === 'object' && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined
  return value
}
function variants(node: unknown): Record<string, unknown>[] {
  if (!record(node)) return []
  if (typeof node.$ref === 'string') return variants(at(schema, pointer(node.$ref)))
  if (Array.isArray(node.anyOf)) return node.anyOf.flatMap(variants)
  return [node]
}
// Consult the schema at each level: even a map key named "name" is private.
function privatePath(location: string, value: unknown, domain: GenerationInputValidationDomain): string {
  let nodes = variants(schema[schemaRoots[domain]])
  return (
    pointer(location)
      .map((key, index) => {
        const array = Array.isArray(value) || nodes.some((node) => node.type === 'array')
        const properties = nodes.filter((node) => record(node.properties) && Object.hasOwn(node.properties, key))
        const label = array
          ? '*'
          : properties.length
            ? safeKey(key, index)
            : `<field-${record(value) ? Math.max(0, Object.keys(value).indexOf(key)) : index}>`
        nodes = array
          ? nodes.flatMap((node) => variants(Array.isArray(node.items) ? node.items[Number(key)] : node.items))
          : properties.length
            ? properties.flatMap((node) => variants((node.properties as Record<string, unknown>)[key]))
            : nodes.flatMap((node) => variants(node.additionalProperties))
        value = at(value, [key])
        return `/${label}`
      })
      .join('') || '/'
  )
}
function safeValidation(error: GenerationInputValidationError, value: unknown) {
  return {
    domain: error.domain,
    instancePath: privatePath(error.instancePath, value, error.domain),
    validationOwner: error.validationOwner,
    validationFieldRef: error.validationFieldRef,
    field: error.validationFieldRef ? schemaFieldNames.get(error.validationFieldRef) : undefined,
    validationRule: error.validationRule,
    valueKind: error.valueKind,
  }
}
// Only finite literal fields qualify. Arbitrary strings outside the schema's
// literal vocabulary remain omitted, even if they failed an enum/const branch.
function literalValue(error: ErrorObject, value: unknown): Record<string, unknown> {
  if (!['enum', 'const', 'anyOf'].includes(error.keyword)) return {}
  const segments = pointer(error.schemaPath)
  const propertyEnd = segments.lastIndexOf('properties') + 2
  if (propertyEnd < 2) return {}
  const node = at(schema, segments.slice(0, propertyEnd))
  function literals(entry: unknown): unknown[] | undefined {
    if (!record(entry)) return undefined
    if (Object.hasOwn(entry, 'const')) return [entry.const]
    if (Array.isArray(entry.enum)) return entry.enum
    if (Array.isArray(entry.anyOf)) {
      const children = entry.anyOf.map(literals)
      return children.every((child) => child !== undefined) ? children.flat() : undefined
    }
    return undefined
  }
  const allowed = literals(node)
  const actual = at(value, pointer(error.instancePath))
  if (!allowed || (actual !== null && !['string', 'number', 'boolean'].includes(typeof actual))) return {}
  if (typeof actual === 'string' && actual !== '' && !allowed.includes(actual)) return { valueOmitted: true }
  return { value: actual }
}

async function modules() {
  const [
    db,
    repository,
    decoder,
    effective,
    routes,
    configurations,
    operations,
    scope,
    ownership,
    assembly,
    agents,
    lua,
    credentials,
    dispatch,
    models,
    toggles,
    agentResolver,
  ] = await Promise.all([
    import('../server/fastify/src/db.js'),
    import('../server/fastify/src/repository.js'),
    import('../server/fastify/src/prompt/generationInputDecoder.js'),
    import('../server/fastify/src/prompt/effectiveGenerationConfig.js'),
    import('../server/fastify/src/routes/generationChat.js'),
    import('../server/fastify/src/generationConfiguration.js'),
    import('../server/fastify/src/generationOperations.js'),
    import('../server/fastify/src/generationScope.js'),
    import('../server/fastify/src/databaseLineage.js'),
    import('../server/fastify/src/prompt/assemble.js'),
    import('../server/fastify/src/prompt/agentPresetExecution.js'),
    import('../server/fastify/src/prompt/luaRuntime.js'),
    import('../server/fastify/src/generationCredentials.js'),
    import('../server/fastify/src/prompt/chatDispatch.js'),
    import('@risuai/shared-core/model-types'),
    import('@risuai/shared-core/chat-generation-settings'),
    import('@risuai/shared-core/agent-preset-resolver'),
  ])
  const { bootPromptVariables } = await import('../server/fastify/src/prompt/promptVariablesBoot.js')
  bootPromptVariables()
  return {
    ...db,
    ...repository,
    ...decoder,
    ...effective,
    ...routes,
    ...operations,
    ...scope,
    ...ownership,
    ...assembly,
    ...agents,
    ...lua,
    ...credentials,
    ...dispatch,
    ...models,
    ...toggles,
    ...agentResolver,
    configurations,
  }
}
type Modules = Awaited<ReturnType<typeof modules>>
type Stage = 'P' | 'B' | 'K' | 'C' | 'D'
type Outcome = 'ready' | 'rejected' | 'defer' | 'pinned'
type Details = Record<string, unknown>
interface Verdict {
  outcome: Outcome
  code: string
  details?: Details
}
interface ChatReport extends Verdict {
  characterId: string
  chatId: string
  trashed: boolean
  firstFailingStage: Stage | null
  stagesRun: Stage[]
  hypaContextTruncationCheckRequired?: boolean
  historyTruncated?: boolean
  lowLevelLua: boolean
  suppressedLuaCalls: Record<string, number>
  fakeAgentDispatches: number
}
interface Options {
  dataDir: string
  chat?: string
  character?: string
  json?: string
  allPresets: boolean
  probeChat?: string
  keepScratch: boolean
}
const profileReasons = [
  'legacy-mode',
  'static-model',
  'missing-provider-id',
  'inferred-provider-id',
  'profile-not-found',
  'profile-model-missing',
  'credential-missing',
  'api-key-missing',
  'base-url-missing',
  'request-model-missing',
  'vertex-project-id-missing',
  'vertex-region-missing',
  'vertex-client-email-missing',
  'vertex-private-key-missing',
  'unsupported-provider-id',
  'unsupported-model',
  'provider-capability-incomplete',
  'provider-capability-unsupported',
] as const satisfies readonly ModelProfileStatusReason[]
const fixedErrors = new Set([
  'generation_credential_authority_missing',
  'generation_credential_unavailable',
  'generation_credential_identity_changed',
  'generation_configuration_invalid',
  'generation_configuration_version_unsupported',
  'generation_configuration_dependency_invalid',
  'generation_configuration_dependency_missing',
  'generation_configuration_dependency_corrupt',
  'generation_configuration_dependency_cycle',
  'generation_configuration_asset_index_invalid',
  'generation_configuration_chat_missing',
])
const validationInputs = new WeakMap<GenerationInputValidationError, unknown>()
function classify(m: Modules, error: unknown): Verdict {
  if (error instanceof m.GenerationInputValidationError) {
    // The observer receives exactly what the decoder checked, including nested
    // settings decodes during effective configuration composition.
    const raw = validationInputs.get(error)
    const normalized =
      error.domain === 'preflight'
        ? m.normalizeGenerationPreflightInputs(raw)
        : m.normalizeLegacyGenerationSettings(raw)
    const validation = safeValidation(error, normalized)
    const validator = validators[error.domain]
    const fields = new Map<string, Details>()
    if (raw !== undefined && !validator(normalized)) {
      for (const item of validator.errors ?? []) {
        const detail = {
          ...safeValidation(m.describeGenerationInputValidationError(normalized, item, error.domain), normalized),
          ...literalValue(item, normalized),
        }
        fields.set(
          JSON.stringify([detail.instancePath, detail.validationFieldRef, detail.validationRule, detail.valueKind]),
          detail,
        )
      }
    }
    return {
      outcome: 'rejected',
      code: 'generation_input_validation_failed',
      details: {
        validation,
        fields: [...fields.values()],
        ...(raw === undefined ? { explanations: 'input_unavailable' } : {}),
      },
    }
  }
  if (m.isChatGenerationSettingsIncompleteAssemblyError(error))
    return {
      outcome: 'rejected',
      code: 'chat_generation_settings_incomplete',
      details: {
        missing: error.body.missing.map((item) => ({
          code: item.code,
          field: item.field
            .split('.')
            .map((key, index) => (index > 1 ? `<field-${index}>` : safeKey(key, index)))
            .join('.'),
        })),
        staleSidebarToggleCount: error.body.staleSidebarToggleKeys.length,
      },
    }
  if (m.isModelProfileGenerationGuardAssemblyError(error)) {
    if (error.message.startsWith('Tokenizer \"'))
      return {
        outcome: 'rejected',
        code: 'tokenizer_unsupported',
        details: { field: 'customTokenizer', fieldRef: fieldRef('customTokenizer') },
      }
    const reasonSection = error.message.match(/\(reasons: ([a-z-]+(?:, [a-z-]+)*)(?:;|\))/)?.[1].split(', ') ?? []
    return {
      outcome: 'rejected',
      code: 'model_profile_generation_guard',
      details: { reasons: reasonSection.filter((reason) => (profileReasons as readonly string[]).includes(reason)) },
    }
  }
  if (m.isAgentPresetGenerationError(error))
    return {
      outcome: 'rejected',
      code: 'agent_preset_generation_failed',
      details: { failureKind: error.body.failureKind, phase: error.body.phase },
    }
  if (error instanceof m.ServerLuaFailureError)
    return {
      outcome: 'rejected',
      code: error.result.interactiveInvoked
        ? 'lua_interactive_unsupported'
        : error.result.timedOut
          ? 'lua_execution_timeout'
          : 'lua_execution_failed',
    }
  if (error instanceof m.GenerationEffectiveConfigurationTooLargeError)
    return {
      outcome: 'rejected',
      code: error.code,
      details: { actualBytes: error.actualBytes, maxBytes: error.maxBytes },
    }
  if (error instanceof m.EntityNotFoundError) return { outcome: 'defer', code: 'generation_target_missing' }
  if (error instanceof Error && fixedErrors.has(error.message)) return { outcome: 'rejected', code: error.message }
  return { outcome: 'defer', code: 'unexpected_error' }
}
const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1
}
const enumOrUnknown = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : 'unknown'
const age = (value: unknown, now: number) => {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? Math.max(0, Math.round((now - time) / 1000)) : null
}
function occupancy(m: Modules, db: DatabaseSync, chatId: string, now: number): Verdict | undefined {
  const lineage = m.getDatabaseOwnershipSnapshot(db).databaseLineage
  const pins = m.listGenerationOccupancyPins(db, chatId).map((pin) => {
    const sql = {
      generation_operation:
        'SELECT state AS status, request_origin AS origin, created_at, updated_at FROM generation_operations WHERE operation_id = ? AND chat_id = ?',
      generation_finalization:
        'SELECT status, created_at, updated_at FROM generation_finalization_retries WHERE generation_id = ? AND chat_id = ?',
      generation_effect:
        "SELECT status, effect_kind AS origin, created_at, updated_at FROM generation_effects WHERE generation_id || ':' || effect_kind = ? AND chat_id = ?",
      memory_job: 'SELECT status, kind AS origin, created_at, updated_at FROM memory_jobs WHERE id = ? AND chat_id = ?',
      bardwiki_job:
        'SELECT status, kind AS origin, created_at, updated_at FROM bardwiki_jobs WHERE id = ? AND chat_id = ?',
    }[pin.kind]
    if (!sql) throw new Error('unknown pin kind')
    const scoped = pin.kind === 'generation_operation' || pin.kind === 'generation_effect'
    const row =
      db.prepare(sql + (scoped ? ' AND database_lineage = ?' : '')).get(pin.id, chatId, ...(scoped ? [lineage] : [])) ??
      {}
    return {
      kind: pin.kind,
      status: enumOrUnknown(row.status, [
        'accepted',
        'launching',
        'running',
        'retryable',
        'pending',
        'claimed',
        'streaming',
        'finalizing',
        'failed',
        'ready',
        'owned_by_job',
        'stopping',
        'abandoned',
      ]),
      origin: enumOrUnknown(row.origin, [
        'unbound',
        'accepted_send',
        'continue',
        'regenerate',
        'legacy',
        'igp',
        'generated_translation',
        'summarize',
        'embed',
        'apply_turn',
        'reconcile_receipt',
        'rebuild_chat',
      ]),
      ageSeconds: age(row.created_at, now),
      idleSeconds: age(row.updated_at, now),
    }
  })
  const lease = db
    .prepare(
      'SELECT claim_class, claimed_at_ms, lease_expires_at_ms FROM chat_occupancies WHERE chat_id = ? AND database_lineage = ? AND occupant_session_id IS NOT NULL',
    )
    .get(chatId, lineage)
  const activeLease = lease && Number(lease.lease_expires_at_ms) > now
  if (!pins.length && !activeLease) return undefined
  return {
    outcome: 'pinned',
    code: pins.length ? 'chat_occupancy_recovery_blocked' : 'chat_occupied',
    details: {
      pins,
      ...(lease
        ? {
            lease: {
              status: activeLease ? 'active' : 'expired',
              origin: enumOrUnknown(lease.claim_class, ['owner', 'chat_only']),
              ageSeconds: age(lease.claimed_at_ms, now),
            },
          }
        : {}),
    },
  }
}
function preflight(
  m: Modules,
  db: DatabaseSync,
  dataDir: string,
  target: { characterId: string; chatId: string },
): { verdict?: Verdict; checkRequired?: boolean } {
  let raw: unknown
  try {
    raw = m.loadPersistedForGenerationPreflight(db, dataDir, target).preflightInputs
    if (!raw) return { verdict: { outcome: 'defer', code: 'generation_target_missing' } }
    const selected = m.decodeGenerationPreflightInputs(raw)
    const effective = m.resolveGenerationPreflightConfiguration(selected)
    return {
      checkRequired:
        !(effective.database.hypaV3 === true && selected.currentChar.supaMemory === true) &&
        selected.currentChat.hypaContextTruncationAcknowledged !== true,
    }
  } catch (error) {
    return { verdict: classify(m, error) }
  }
}
async function replayChat(
  m: Modules,
  db: DatabaseSync,
  options: Options,
  target: { characterId: string; chatId: string; trashed: boolean },
  now: number,
): Promise<ChatReport> {
  const report: ChatReport = {
    ...target,
    outcome: 'ready',
    code: 'ready',
    firstFailingStage: null,
    stagesRun: [],
    lowLevelLua: false,
    suppressedLuaCalls: {},
    fakeAgentDispatches: 0,
  }
  let stage: Stage = 'P'
  const fail = (verdict: Verdict) => Object.assign(report, verdict, { firstFailingStage: stage })
  try {
    report.stagesRun.push(stage)
    const pin = occupancy(m, db, target.chatId, now)
    if (pin) return fail(pin)
    stage = 'B'
    report.stagesRun.push(stage)
    const b = preflight(m, db, options.dataDir, target)
    if (b.verdict) return fail(b.verdict)
    report.hypaContextTruncationCheckRequired = b.checkRequired
    stage = 'K'
    report.stagesRun.push(stage)
    const captured = m.captureAcceptedEffectiveGenerationConfiguration(db, options.dataDir, target)
    const memory = new DatabaseSync(':memory:')
    let accepted: typeof captured
    try {
      m.configurations.createGenerationConfigurationTables(memory)
      memory.exec('BEGIN')
      const stored = m.configurations.storeGenerationConfiguration(memory, captured)
      const fingerprint = m.generationEffectiveConfigurationFingerprint(stored)
      accepted = m.configurations.resolveGenerationConfiguration(memory, stored, fingerprint)
    } finally {
      memory.close()
    }
    stage = 'C'
    report.stagesRun.push(stage)
    const input: AssembleInput = {
      characterId: target.characterId,
      chatId: target.chatId,
      mode: 'preview_prompt',
      acceptedEffectiveConfiguration: accepted,
    }
    const resources = m.createGenerationAssemblyResources(db, options.dataDir, input)
    const result = await m.assemblePrompt(input, {
      ...resources,
      loadMemoryDatabase: () => db,
      // No asset resolver: no asset bytes or asset-root write capability reaches Lua.
      signal: new AbortController().signal,
      offlineReplay: {
        onLowLevelAccess: () => {
          report.lowLevelLua = true
        },
        onSuppressedCall: (call) => increment(report.suppressedLuaCalls, call),
      },
      executeAgentPresetStep: (step) =>
        m.executeAgentPresetStep({
          ...step,
          dispatchProvider: async function* () {
            report.fakeAgentDispatches++
            yield { kind: 'token', content: '{}' }
          },
        }),
    })
    report.historyTruncated = result.state?.historyTruncated === true
    if (result.stopSending) return fail({ outcome: 'rejected', code: result.abortReason ?? 'assembly_stopped' })
    stage = 'D'
    report.stagesRun.push(stage)
    const profile = m.refreshAcceptedProfileCredential(db, accepted.database, accepted.resolvedMainProfile)
    const route = m.resolveChatProviderRoute(accepted.database, profile)
    if (route.routable === false) {
      const ollama =
        profile.modelInfo.format === m.LLMFormat.Ollama &&
        profile.modelId !== 'ollama-cloud' &&
        !m.resolveProfileOllamaBaseUrl(profile)
      return fail({ outcome: 'rejected', code: ollama ? 'ollama_base_url_required' : 'provider_route_unavailable' })
    }
    return report
  } catch (error) {
    return fail(classify(m, error))
  }
}

function chats(db: DatabaseSync): Array<{ characterId: string; chatId: string; trashed: boolean }> {
  return (
    db
      .prepare(
        `SELECT ch.id AS chatId, ch.character_id AS characterId,
    coalesce(json_extract(c.data_json, '$.trashTime'), 0) AS trashTime
    FROM chats ch LEFT JOIN characters c ON c.id = ch.character_id ORDER BY ch.character_id, ch.position, ch.id`,
      )
      .all() as Array<{ characterId: string; chatId: string; trashTime: number }>
  ).map(({ trashTime, ...row }) => ({ ...row, trashed: !!trashTime }))
}
function presetProbes(m: Modules, db: DatabaseSync, options: Options, targets: ReturnType<typeof chats>) {
  const target = options.probeChat
    ? targets.find((chat) => chat.chatId === options.probeChat)
    : targets.find((chat) => !chat.trashed)
  if (!target) return { outcome: 'defer', code: 'probe_chat_missing', probes: [] }
  const saved = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(target.chatId) as { data_json: string }
  const probes: Details[] = []
  for (const [table, selection] of [
    ['model_presets', 'modelPresetId'],
    ['prompt_presets', 'promptPresetId'],
  ] as const) {
    const rows = db.prepare(`SELECT data_json FROM ${table} ORDER BY position`).all() as Array<{ data_json: string }>
    for (const [index, row] of rows.entries()) {
      db.exec('SAVEPOINT replay_preset')
      try {
        const preset = JSON.parse(row.data_json)
        if (!record(preset) || typeof preset.id !== 'string' || !preset.id) {
          probes.push({ kind: table, index, outcome: 'rejected', code: 'preset_id_missing' })
          continue
        }
        const chat = JSON.parse(saved.data_json)
        const settings = { ...chat.generationSettings, configured: true, [selection]: preset.id }
        if (!Object.hasOwn(settings, 'jailbreakToggle')) settings.jailbreakToggle = false
        chat.generationSettings = settings
        const write = () =>
          db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), target.chatId)
        write()
        // Requirements consume owner metadata only, before strict decoding, just
        // like the client. Keep baseline bindings; this is not a preset cross product.
        const loaded = m.loadPersistedForGenerationPreflight(db, options.dataDir, target).preflightInputs
        if (record(loaded) && record(loaded.database)) {
          const database = loaded.database
          const char = record(loaded.currentChar) ? loaded.currentChar : {}
          const currentChat = record(loaded.currentChat) ? loaded.currentChat : {}
          const selectedPrompt = Array.isArray(database.promptPresets)
            ? database.promptPresets.filter((item) => record(item) && item.id === settings.promptPresetId)
            : []
          const required = m.resolveChatGenerationSettingsReadiness({
            ...database,
            settings,
            effectiveAgentPresetId: m.resolveEffectiveAgentPresetId(database, settings),
            personas: database.personas ?? [],
            moduleIntegration:
              selectedPrompt.length === 1 && typeof selectedPrompt[0].moduleIntergration === 'string'
                ? selectedPrompt[0].moduleIntergration
                : null,
            modelPresets: database.modelPresets ?? [],
            promptPresets: database.promptPresets ?? [],
            characterModuleIds: char.modules,
            chatModuleIds: currentChat.modules,
            enabledModuleIds: database.enabledModules,
          } as Parameters<typeof m.resolveChatGenerationSettingsReadiness>[0]).requirements.sidebarToggles
          const prior = record(settings.sidebarToggles) ? settings.sidebarToggles : {}
          settings.sidebarToggles = Object.fromEntries(
            required.map((toggle) => [
              toggle.key,
              typeof prior[toggle.key] === 'string'
                ? prior[toggle.key]
                : toggle.kind === 'text' || toggle.kind === 'textarea'
                  ? ''
                  : '0',
            ]),
          )
          write()
        }
        const b = preflight(m, db, options.dataDir, target)
        probes.push({ kind: table, index, stagesRun: ['B'], ...(b.verdict ?? { outcome: 'ready', code: 'ready' }) })
      } catch (error) {
        probes.push({ kind: table, index, ...classify(m, error) })
      } finally {
        db.exec('ROLLBACK TO replay_preset; RELEASE replay_preset')
      }
    }
  }
  return { characterId: target.characterId, chatId: target.chatId, probes }
}
function duplicates(db: DatabaseSync) {
  return ['model_presets', 'prompt_presets'].flatMap((table) =>
    (
      db
        .prepare(
          `SELECT count(*) AS count FROM ${table} WHERE json_type(data_json, '$.id') = 'text' GROUP BY json_extract(data_json, '$.id') HAVING count(*) > 1`,
        )
        .all() as Array<{ count: number }>
    ).map((row, index) => ({ kind: table, group: index, count: row.count, code: 'duplicate_preset_id' })),
  )
}

const notReplayed = [
  'http_auth_writer_admission_and_request_shape',
  'occupancy_session_entitlement_and_recovery',
  'send_continue_regenerate_specific_transforms_and_target_checks',
  'client_context_and_unsaved_edits',
  'historical_clock_randomness_and_original_request_state',
  'per_provider_api_key_checks',
  'provider_request_builders_and_dispatch',
  'provider_attempt_request_triggers_retries_and_fallbacks',
  'openrouter_free_model_resolution',
  'embedding_query_prefetch',
  'asset_and_inlay_bytes_no_asset_resolver',
  'memory_enqueue_and_persistent_mutations',
  'agent_provider_outputs_fake_json_object_and_after_main_steps',
  'lua_external_results_synthetic',
  'hypa_truncation_confirmation_client_capability_gate',
  'post_generation_finalization_and_effects',
]
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
async function journal(dataDir: string, scratch: string) {
  const file = path.join(dataDir, 'diagnostics/journal.sqlite')
  if (!fs.existsSync(file)) return { status: 'absent', fields: [] }
  let db: DatabaseSync | undefined
  try {
    const copy = path.join(scratch, 'journal.sqlite')
    await snapshot(file, copy)
    db = new DatabaseSync(copy, { readOnly: true })
    const counts = new Map<string, { validationFieldRef: string; field: string; count: number }>()
    function visit(value: unknown): void {
      if (!record(value)) return
      if (typeof value.validationFieldRef === 'string' && schemaFieldNames.has(value.validationFieldRef)) {
        const ref = value.validationFieldRef
        const item = counts.get(ref) ?? { validationFieldRef: ref, field: schemaFieldNames.get(ref)!, count: 0 }
        item.count++
        counts.set(ref, item)
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    for (const row of db.prepare('SELECT record FROM journal_records').iterate()) {
      try {
        visit(JSON.parse(String(row.record)))
      } catch {
        /* No raw journal content leaves the process. */
      }
    }
    return { status: 'read', fields: [...counts.values()] }
  } catch {
    return { status: 'unavailable', fields: [] }
  } finally {
    db?.close()
  }
}
function aggregates(reports: ChatReport[]) {
  const outcomes = { ready: 0, rejected: 0, defer: 0, pinned: 0 }
  const byStage: Record<string, number> = {},
    byCode: Record<string, number> = {},
    byFieldRef: Record<string, number> = {},
    suppressedLuaCalls: Record<string, number> = {}
  for (const report of reports) {
    outcomes[report.outcome]++
    increment(byStage, report.firstFailingStage ?? 'ready')
    increment(byCode, report.code)
    const fields = new Set<string>()
    for (const field of (report.details?.fields ?? []) as Details[])
      if (typeof field.validationFieldRef === 'string') fields.add(field.validationFieldRef)
    const validation = report.details?.validation
    if (record(validation) && typeof validation.validationFieldRef === 'string')
      fields.add(validation.validationFieldRef)
    if (typeof report.details?.fieldRef === 'string') fields.add(report.details.fieldRef)
    for (const field of fields) increment(byFieldRef, field)
    for (const [call, count] of Object.entries(report.suppressedLuaCalls))
      suppressedLuaCalls[call] = (suppressedLuaCalls[call] ?? 0) + count
  }
  return {
    chats: reports.length,
    outcomes,
    byStage,
    byCode,
    byFieldRef: Object.entries(byFieldRef).map(([validationFieldRef, chats]) => ({
      validationFieldRef,
      field: schemaFieldNames.get(validationFieldRef),
      chats,
    })),
    lowLevelLuaChats: reports.filter((chat) => chat.lowLevelLua).length,
    suppressedLuaCalls,
  }
}

export async function replayGenerationRejections(options: Options) {
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(root)) throw new Error('repo_root_required')
  const original = fs.realpathSync(options.dataDir)
  const tempRoot = fs.realpathSync(os.tmpdir())
  if (tempRoot === original || tempRoot.startsWith(original + path.sep)) throw new Error('scratch_inside_source')
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'risu-generation-replay-'))
  fs.chmodSync(scratch, 0o700)
  const previousFetch = globalThis.fetch
  const fetchAttempts: Record<string, number> = Object.create(null)
  globalThis.fetch = async (input) => {
    let hostname = 'invalid_url'
    try {
      hostname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname
    } catch {
      /* Omit raw URLs. */
    }
    increment(fetchAttempts, hostname)
    throw new Error('replay_network_forbidden')
  }
  // Scripts can print arbitrary chat content; silence process output, including
  // protocol metrics and errors, until only our structured report remains.
  const stdout = process.stdout.write,
    stderr = process.stderr.write
  let suppressedOutputWrites = 0
  const silence = ((_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    suppressedOutputWrites++
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') queueMicrotask(() => done())
    return true
  }) as typeof process.stdout.write
  process.stdout.write = silence
  process.stderr.write = silence
  let db: DatabaseSync | undefined
  try {
    await snapshot(path.join(original, 'risu.db'), path.join(scratch, 'risu.db'))
    const m = await modules()
    const inspection = new DatabaseSync(path.join(scratch, 'risu.db'), { readOnly: true })
    let sourceSchema: ReturnType<typeof m.getSchemaState>
    try {
      sourceSchema = m.getSchemaState(inspection)
    } finally {
      inspection.close()
    }
    if (sourceSchema.version > m.CURRENT_SCHEMA_VERSION) throw new Error('schema_newer_than_code')
    db = m.openDatabase(scratch)
    const all = chats(db)
    const selected = all.filter(
      (chat) =>
        (!options.chat || chat.chatId === options.chat) &&
        (!options.character || chat.characterId === options.character),
    )
    const reports: ChatReport[] = []
    const now = Date.now()
    for (const target of selected)
      reports.push(
        await m.withGenerationInputValidationObserver(
          (error, value) => validationInputs.set(error, value),
          () => replayChat(m, db!, { ...options, dataDir: original }, target, now),
        ),
      )
    const presetResults = options.allPresets
      ? m.withGenerationInputValidationObserver(
          (error, value) => validationInputs.set(error, value),
          () => presetProbes(m, db!, { ...options, dataDir: original }, all),
        )
      : undefined
    const duplicatePresetIds = duplicates(db)
    const diagnosticsJournal = await journal(original, scratch)
    return {
      version: 1,
      capturedAt: new Date(now).toISOString(),
      snapshotMethod: 'stable_files_then_sqlite_backup',
      sourceSchemaVersion: sourceSchema.version,
      replaySchemaVersion: m.getSchemaState(db).version,
      outcome: Object.keys(fetchAttempts).length ? 'harness_defect' : 'completed',
      ...(selected.length === 0 ? { selection: 'no_matching_chats' } : {}),
      notReplayed,
      scratchKept: options.keepScratch,
      ...(options.keepScratch ? { scratchDirectory: scratch } : {}),
      chats: reports,
      aggregates: aggregates(reports),
      duplicatePresetIds,
      presetResults,
      diagnosticsJournal,
      fetchAttempts: Object.entries(fetchAttempts).map(([hostname, count]) => ({ hostname, count })),
      suppressedOutputWrites,
    }
  } finally {
    try {
      db?.close()
    } finally {
      globalThis.fetch = previousFetch
      process.stdout.write = stdout
      process.stderr.write = stderr
      if (!options.keepScratch) fs.rmSync(scratch, { recursive: true, force: true })
    }
  }
}
function parseArgs(args: string[]): Options {
  const values = new Map<string, string>(),
    flags = new Set<string>()
  if (args[0] === '--') args = args.slice(1)
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (values.has(flag) || flags.has(flag)) throw new Error('invalid_arguments')
    if (['--all-presets', '--keep-scratch'].includes(flag)) {
      flags.add(flag)
      continue
    }
    if (
      !['--data-dir', '--chat', '--character', '--json', '--probe-chat'].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      throw new Error('invalid_arguments')
    values.set(flag, args[++index])
  }
  if (!values.has('--data-dir')) throw new Error('data_dir_required')
  if (values.has('--probe-chat') && !flags.has('--all-presets')) throw new Error('probe_chat_requires_all_presets')
  const dataDir = fs.realpathSync(values.get('--data-dir')!)
  const json = values.get('--json')
  if (json) {
    const destination = path.join(fs.realpathSync(path.dirname(path.resolve(json))), path.basename(json))
    if (destination === dataDir || destination.startsWith(dataDir + path.sep)) throw new Error('output_inside_source')
    if (fs.existsSync(destination)) throw new Error('output_exists')
  }
  return {
    dataDir,
    chat: values.get('--chat'),
    character: values.get('--character'),
    json,
    allPresets: flags.has('--all-presets'),
    probeChat: values.get('--probe-chat'),
    keepScratch: flags.has('--keep-scratch'),
  }
}
function summaryDetails(details: unknown): Details {
  return record(details) ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== 'fields')) : {}
}
async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'pnpm replay:generation -- --data-dir DIR [--chat ID] [--character ID] [--json NEW_FILE] [--all-presets] [--probe-chat ID] [--keep-scratch]\n',
    )
    return
  }
  const options = parseArgs(process.argv.slice(2))
  const report = await replayGenerationRejections(options)
  if (options.json) fs.writeFileSync(options.json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write('Generation rejection replay (snapshot; offline preview)\n')
  process.stdout.write(`schema: ${report.sourceSchemaVersion} -> ${report.replaySchemaVersion}\n`)
  if (report.selection) process.stdout.write(`selection: ${report.selection}\n`)
  for (const chat of report.chats) {
    const { characterId, chatId, trashed, outcome, code, firstFailingStage, stagesRun, details } = chat
    process.stdout.write(
      JSON.stringify({
        characterId,
        chatId,
        trashed,
        outcome,
        stage: firstFailingStage,
        code,
        stagesRun,
        ...summaryDetails(details),
      }) + '\n',
    )
  }
  for (const key of [
    'aggregates',
    'duplicatePresetIds',
    'diagnosticsJournal',
    'fetchAttempts',
    'notReplayed',
  ] as const) {
    if (report[key] !== undefined) process.stdout.write(`${key}: ${JSON.stringify(report[key])}\n`)
  }
  if (report.presetResults) {
    for (const probe of report.presetResults.probes) {
      const { details, ...summary } = probe
      process.stdout.write(`preset: ${JSON.stringify({ ...summary, ...summaryDetails(details) })}\n`)
    }
    if ('code' in report.presetResults)
      process.stdout.write(
        `presets: ${JSON.stringify({ outcome: report.presetResults.outcome, code: report.presetResults.code })}\n`,
      )
  }
  if (report.scratchDirectory) process.stdout.write(`scratchDirectory: ${report.scratchDirectory}\n`)
  process.stdout.write(`outcome: ${report.outcome}\n`)
  if (report.outcome === 'harness_defect') process.exitCode = 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const codes = [
      'repo_root_required',
      'scratch_inside_source',
      'schema_newer_than_code',
      'invalid_arguments',
      'data_dir_required',
      'probe_chat_requires_all_presets',
      'output_inside_source',
      'output_exists',
      'source_database_missing',
      'source_changed_during_snapshot',
      'snapshot_integrity_failed',
      'snapshot_source_not_file',
    ]
    process.stderr.write(
      JSON.stringify({
        outcome: 'failed',
        code: error instanceof Error && codes.includes(error.message) ? error.message : 'replay_failed',
      }) + '\n',
    )
    process.exitCode = 1
  })
}
