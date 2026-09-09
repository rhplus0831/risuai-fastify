import { decodeDisplaySourceDatabase, GenerationInputValidationError } from './prompt/generationInputDecoder.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyCustomScript as customscript,
  DisplaySourceDatabase as Database,
  FastifyMessage as Message,
} from './prompt/serverTypes.js'
import type { CbsConditions } from '@risuai/shared-core/risuchat-parser-helpers'
import { resolvePromptPresetRegexField } from '@risuai/shared-core/preset-split'
import { selectedPersonaIndexFromStableId } from '@risuai/shared-core/persona-selection-identity'
import {
  DISPLAY_SOURCE_PROTOCOL_VERSION,
  DISPLAY_SOURCE_TRANSFORM_VERSION,
  displaySourceNamespaceJson,
  normalizeDisplayDependencyValue,
  stableDisplayDependencyJson,
  type DisplaySourceRequest,
  type DisplaySourceResponse,
  type DisplaySourceResponseEntry,
  type DisplaySourceTarget,
} from '@risuai/protocol/display-source'
import { getSchemaState } from './db.js'
import { getDatabaseLineage, getDatabaseWriterMetadata } from './databaseLineage.js'
import { loadPersistedForDisplaySource } from './repository.js'
import { ValidationError } from './repository.js'
import { createLuaExecBudget, runLuaEditTrigger } from './prompt/luaRuntime.js'
import { createTriggerVarEngine } from './prompt/triggerVars.js'
import { getChatDefaultVariables } from './prompt/chatVarDefaults.js'
import { getActiveModules, getModuleAssets, getModuleTriggers } from './prompt/modules.js'
import { createTriggerExecutionBudget, runTrigger } from './prompt/triggers.js'
import { processScriptAsync } from './prompt/scripts.js'
import { isBoundedRegexError } from './prompt/boundedRegex.js'
import { emitProtocolMetric, protocolDurationMs, protocolNowMs } from './protocolMetrics.js'
import { DisplaySourceCache } from './displaySourceCache.js'
import { DisplaySourceQueue } from './displaySourceQueue.js'
import { resolvePromptModelId } from './prompt/promptScope.js'
import type { DiagnosticEventV2 } from '@risuai/protocol/remote-diagnostics'
import { recordDiagnosticEvent } from './diagnosticContext.js'
import {
  beginDisplaySourceDiagnostics,
  type DisplaySourceDiagnostics,
  type DisplayPerformanceTiming,
} from './displaySourceDiagnostics.js'

type DisplayDiagnosticEvent = Extract<DiagnosticEventV2, { category: 'display' }>
type DisplaySourceFailureStage = DisplayDiagnosticEvent['stage']
export type DisplaySourceFailureDiagnostic = Omit<
  DisplayDiagnosticEvent,
  'timestamp' | 'source' | 'level' | 'correlation' | 'requestUid' | 'operationRef' | 'attemptRef' | 'category'
>

const displaySourceFailureStages = new WeakMap<object, DisplaySourceFailureStage>()
const displaySourceTimingNames: Partial<Record<DisplaySourceFailureStage, DisplayPerformanceTiming>> = {
  revision: 'revisionMs',
  namespace: 'namespaceMs',
  'scope-load': 'scopeLoadMs',
  'scope-decode': 'scopeDecodeMs',
  'scope-resolution': 'scopeResolutionMs',
  'shared-dependencies': 'sharedDependencyMs',
  'target-preparation': 'sourceHashMs',
  postcondition: 'postconditionMs',
}

/** Attach a content-free stage without wrapping the error or changing route status classification. */
function runDisplaySourceStage<T>(
  stage: DisplaySourceFailureStage,
  operation: () => T,
  diagnostics?: DisplaySourceDiagnostics,
  timing = displaySourceTimingNames[stage],
): T {
  const startedAt = diagnostics ? protocolNowMs() : 0
  try {
    return operation()
  } catch (error) {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      if (!displaySourceFailureStages.has(error)) displaySourceFailureStages.set(error, stage)
    }
    throw error
  } finally {
    if (diagnostics && timing) diagnostics.addDuration(timing, protocolNowMs() - startedAt)
  }
}

export function displaySourceFailureDiagnostic(
  error: unknown,
  outcome: DisplayDiagnosticEvent['outcome'] = 'failed',
): DisplaySourceFailureDiagnostic {
  const stage =
    (error !== null && (typeof error === 'object' || typeof error === 'function')
      ? displaySourceFailureStages.get(error)
      : undefined) ?? 'unknown'
  if (error instanceof GenerationInputValidationError) {
    return {
      stage: 'scope-decode',
      outcome,
      failureKind: 'generation-input-validation',
      validationDomain: error.domain,
      validationOwner: error.validationOwner,
      ...(error.validationFieldRef ? { validationFieldRef: error.validationFieldRef } : {}),
      validationRule: error.validationRule,
      valueKind: error.valueKind,
    }
  }
  if (error instanceof SyntaxError) return { stage, outcome, failureKind: 'malformed-persistence' }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code?.startsWith('SQLITE_')) return { stage, outcome, failureKind: 'storage' }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { stage, outcome, failureKind: 'runtime' }
  }
  return { stage, outcome, failureKind: 'unknown' }
}

interface DisplaySourceServiceOptions {
  db: DatabaseSync
  dataDir: string
  cache?: DisplaySourceCache
}

interface DisplayScope {
  database: Database
  character: character
  chat: Chat
  chatId: string
  selectedCharID: number
  chatPage: number
}

interface TransformOutcome {
  displaySource: string
  ephemeralStateChanged: boolean
  stageDurations: Record<string, number>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Display source request aborted')
}

function cloneScriptstate(value: Chat['scriptstate']): Chat['scriptstate'] {
  return value === undefined ? undefined : structuredClone(value)
}

function installScriptstate(chat: Chat, value: Chat['scriptstate']): void {
  if (value === undefined || Object.keys(value).length === 0) {
    delete chat.scriptstate
    return
  }
  chat.scriptstate = structuredClone(value)
}

function activePromptPresetRegex(database: Database, chat: Chat): customscript[] {
  const promptPresetId = chat.generationSettings?.promptPresetId?.trim()
  if (!promptPresetId) return Array.isArray(database.presetRegex) ? database.presetRegex : []
  const presets = database.promptPresets as Array<{ id?: string }> | undefined
  const preset = presets?.find((candidate) => candidate?.id === promptPresetId)
  const resolved = resolvePromptPresetRegexField(preset)
  return resolved.present && Array.isArray(resolved.value) ? (resolved.value as customscript[]) : []
}

function selectedPersonaProfile(
  database: Database,
): { id: string; index: number; name: string; personaPrompt: string } | null {
  const personas = Array.isArray(database.personas)
    ? (database.personas as Array<{ id?: unknown; name?: unknown; personaPrompt?: unknown }>)
    : []
  const index = selectedPersonaIndexFromStableId(database)
  const persona = personas[index]
  if (!persona || typeof persona.id !== 'string') return null
  return {
    id: persona.id,
    index,
    name: typeof persona.name === 'string' ? persona.name : '',
    personaPrompt: typeof persona.personaPrompt === 'string' ? persona.personaPrompt : '',
  }
}

function displayScope(database: Database, characterId: string, chatId: string): DisplayScope | null {
  const characters = database.characters as character[]
  const selectedCharID = characters.findIndex((candidate) => candidate?.chaId === characterId)
  if (selectedCharID < 0) return null
  const character = characters[selectedCharID]
  const chatPage = character.chats?.findIndex((candidate) => candidate?.id === chatId) ?? -1
  if (chatPage < 0) return null
  const chat = character.chats[chatPage]
  database.presetRegex = structuredClone(activePromptPresetRegex(database, chat))
  return { database, character, chat, chatId, selectedCharID, chatPage }
}

function dynamicAssetFallbackRequired(scope: DisplayScope, modules: ReturnType<typeof getActiveModules>): boolean {
  if (!scope.database.dynamicAssets || !scope.database.dynamicAssetsEditDisplay) return false
  return (scope.character.additionalAssets?.length ?? 0) > 0 || getModuleAssets(modules).length > 0
}

function targetIsFresh(scope: DisplayScope, target: DisplaySourceTarget): boolean {
  if (target.index < 0) return true
  const message = scope.chat.message?.[target.index]
  if (!message) return false
  if (target.messageId && message.chatId !== target.messageId) return false
  if (target.role !== null && message.role !== target.role) return false
  return true
}

function sharedDependencyValue(
  scope: DisplayScope,
  modules: ReturnType<typeof getActiveModules>,
): Record<string, unknown> {
  const selectedPersona = selectedPersonaProfile(scope.database)
  return {
    character: {
      additionalAssets: scope.character.additionalAssets,
      chaId: scope.character.chaId,
      customscript: scope.character.customscript,
      defaultVariables: scope.character.defaultVariables,
      desc: scope.character.desc,
      firstMessage: scope.character.firstMessage,
      alternateGreetings: scope.character.alternateGreetings,
      emotionImages: scope.character.emotionImages,
      modules: scope.character.modules,
      name: scope.character.name,
      personality: scope.character.personality,
      scenario: scope.character.scenario,
      triggerscript: scope.character.triggerscript,
      type: scope.character.type,
    },
    chat: {
      generationSettings: scope.chat.generationSettings,
      id: scope.chat.id,
      fmIndex: scope.chat.fmIndex,
      message: scope.chat.message?.map((message) => ({
        chatId: message.chatId,
        data: message.data,
        name: message.name,
        role: message.role,
      })),
      modules: scope.chat.modules,
      scriptstate: scope.chat.scriptstate,
    },
    database: {
      dynamicAssets: scope.database.dynamicAssets,
      dynamicAssetsEditDisplay: scope.database.dynamicAssetsEditDisplay,
      enabledModules: scope.database.enabledModules,
      globalChatVariables: scope.database.globalChatVariables,
      globalscript: scope.database.globalscript,
      moduleIntergration: scope.database.moduleIntergration,
      presetRegex: scope.database.presetRegex,
      personaPrompt: selectedPersona?.personaPrompt ?? scope.database.personaPrompt,
      selectedPersona: selectedPersona?.index ?? -1,
      selectedPersonaId: selectedPersona?.id ?? null,
      templateDefaultVariables: scope.database.templateDefaultVariables,
      username: selectedPersona?.name ?? scope.database.username,
    },
    modules: modules.map((module) => ({
      assets: module.assets,
      id: module.id,
      customModuleToggle: module.customModuleToggle,
      lowLevelAccess: module.lowLevelAccess,
      namespace: module.namespace,
      regex: module.regex,
      trigger: module.trigger,
    })),
    transformVersion: DISPLAY_SOURCE_TRANSFORM_VERSION,
  }
}

function fingerprintSharedDependencies(
  scope: DisplayScope,
  modules: ReturnType<typeof getActiveModules>,
  diagnostics?: DisplaySourceDiagnostics,
): string {
  if (!diagnostics) return sha256(stableDisplayDependencyJson(sharedDependencyValue(scope, modules)))
  // Execute the same projection/canonicalization/serialization/hash exactly
  // once. Timing boundaries must not introduce a second serialization or a new key.
  const value = diagnostics.measurePreparation('dependencyBuildMs', () => sharedDependencyValue(scope, modules))
  const normalized = diagnostics.measurePreparation('dependencyNormalizeMs', () =>
    normalizeDisplayDependencyValue(value),
  )
  const json = diagnostics.measurePreparation('dependencySerializeMs', () => JSON.stringify(normalized) ?? 'null')
  const digest = diagnostics.measurePreparation('dependencyHashMs', () => sha256(json))
  diagnostics.dependencySize(json)
  diagnostics.inputCounts(() => ({
    activeModuleCount: modules.length,
    moduleAssetCount: modules.reduce((count, module) => count + (module.assets?.length ?? 0), 0),
    moduleRegexCount: modules.reduce((count, module) => count + (module.regex?.length ?? 0), 0),
    moduleTriggerCount: modules.reduce((count, module) => count + (module.trigger?.length ?? 0), 0),
    characterAssetCount: scope.character.additionalAssets?.length ?? 0,
    characterRegexCount: scope.character.customscript?.length ?? 0,
    characterTriggerCount: scope.character.triggerscript?.length ?? 0,
  }))
  return digest
}

function targetDependencyValue(
  sharedDependencyFingerprint: string,
  target: DisplaySourceTarget,
  sourceHash: string,
): Record<string, unknown> {
  return {
    cbsConditions: { firstmsg: target.firstMessage, chatRole: target.role },
    sharedDependencyFingerprint,
    sourceHash,
    target: {
      characterId: target.characterId,
      firstMessage: target.firstMessage,
      index: target.index,
      layer: target.layer,
      messageId: target.messageId,
      name: target.name,
      role: target.role,
      streaming: target.streaming,
    },
  }
}

function errorEntry(
  target: DisplaySourceTarget,
  status: 'client_fallback' | 'stale' | 'error',
  reason: string,
): DisplaySourceResponseEntry {
  return { requestKey: target.requestKey, status, sourceHash: target.sourceHash, reason }
}

export class DisplaySourceService {
  readonly cache: DisplaySourceCache

  private readonly db: DatabaseSync
  private readonly dataDir: string
  private readonly targetQueue = new DisplaySourceQueue()
  private queuedBatchCount = 0

  constructor(options: DisplaySourceServiceOptions) {
    this.db = options.db
    this.dataDir = options.dataDir
    this.cache = options.cache ?? new DisplaySourceCache()
  }

  currentRevision(): number {
    return getSchemaState(this.db).revision
  }

  async transformBatch(
    chatId: string,
    request: DisplaySourceRequest,
    signal?: AbortSignal,
    onResult?: (result: DisplaySourceResponse) => void,
  ): Promise<DisplaySourceResponse> {
    const enqueuedAt = protocolNowMs()
    const queueDepth = this.queuedBatchCount++
    const diagnostics = beginDisplaySourceDiagnostics(request.targets.length, enqueuedAt, queueDepth)
    let response: DisplaySourceResponse | undefined
    const queueTiming = { waitMs: 0 }
    const priority = new Map((request.priorityKeys ?? []).map((key, index) => [key, index]))
    if (diagnostics) diagnostics.priorityTargetCount = priority.size
    const targets = [...request.targets].sort(
      (a, b) => (priority.get(a.requestKey) ?? Infinity) - (priority.get(b.requestKey) ?? Infinity),
    )
    const iterator = this.transformPreparedBatch(
      chatId,
      { ...request, targets },
      queueTiming,
      queueDepth,
      signal,
      diagnostics,
    )
    let index = 0
    let waitingAt: number | undefined
    try {
      while (true) {
        waitingAt = protocolNowMs()
        const next = await this.targetQueue.run(
          priority.has(targets[index]?.requestKey) ? 0 : request.priorityKeys ? 2 : 1,
          async () => {
            queueTiming.waitMs += protocolDurationMs(waitingAt!)
            waitingAt = undefined
            if (diagnostics) diagnostics.queueWaitMs = queueTiming.waitMs
            return iterator.next()
          },
          signal,
        )
        if (next.done) {
          response = next.value
          return response
        }
        index += next.value.entries.length
        for (const entry of next.value.entries) diagnostics?.resultReady(priority.has(entry.requestKey))
        onResult?.(next.value)
      }
    } finally {
      if (waitingAt !== undefined) queueTiming.waitMs += protocolDurationMs(waitingAt)
      if (diagnostics) diagnostics.queueWaitMs = queueTiming.waitMs
      await iterator.return(undefined as never)
      this.queuedBatchCount--
      diagnostics?.finish(response, signal?.aborted === true)
    }
  }

  private async *transformPreparedBatch(
    chatId: string,
    request: DisplaySourceRequest,
    queueTiming: { waitMs: number },
    queueDepth: number,
    signal?: AbortSignal,
    diagnostics?: DisplaySourceDiagnostics,
  ): AsyncGenerator<DisplaySourceResponse, DisplaySourceResponse, void> {
    const startedAt = protocolNowMs()
    throwIfAborted(signal)
    const initialRevision = runDisplaySourceStage('revision', () => getSchemaState(this.db).revision, diagnostics)
    if (request.baseRevision !== initialRevision) {
      if (diagnostics) diagnostics.outcome = 'stale'
      throw new ValidationError(`Display source base revision is stale; current revision is ${initialRevision}`)
    }

    const { databaseLineage, activeWriterEpoch, contextFingerprint } = runDisplaySourceStage(
      'namespace',
      () => {
        const databaseLineage = getDatabaseLineage(this.db)
        const activeWriterEpoch = getDatabaseWriterMetadata(this.db).epoch
        const namespaceJson = displaySourceNamespaceJson({
          databaseLineage,
          activeWriterEpoch,
          context: request.context,
        })
        const contextFingerprint = sha256(namespaceJson)
        this.cache.activate(contextFingerprint)
        return { databaseLineage, activeWriterEpoch, contextFingerprint }
      },
      diagnostics,
    )

    const primaryTarget = request.targets[0]
    if (!primaryTarget) throw new ValidationError('Display source request has no targets')
    const scopeLoadStartedAt = protocolNowMs()
    let database: Database
    try {
      database = this.loadScopeDatabase(chatId, primaryTarget.characterId, diagnostics)
    } catch (error) {
      throwIfAborted(signal)
      if (!(error instanceof GenerationInputValidationError)) throw error
      recordDiagnosticEvent({
        category: 'display',
        level: 'warn',
        ...displaySourceFailureDiagnostic(error, 'handled-fallback'),
      })
      const stale = this.postconditionResponse(
        request,
        initialRevision,
        databaseLineage,
        activeWriterEpoch,
        contextFingerprint,
        diagnostics,
      )
      if (stale) return stale
      const entries = request.targets.map((target) => errorEntry(target, 'client_fallback', 'scope_input_incompatible'))
      emitProtocolMetric('display_source_batch', {
        status: 'client_fallback',
        targetCount: request.targets.length,
        okCount: 0,
        fallbackCount: entries.length,
        durationMs: protocolDurationMs(startedAt),
        queueWaitMs: queueTiming.waitMs,
        queueDepth,
        scopeLoadMs: protocolDurationMs(scopeLoadStartedAt),
        revision: initialRevision,
        cache: this.cache.stats(),
      })
      return {
        protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION,
        revision: initialRevision,
        contextFingerprint,
        entries,
      }
    }
    const scopeLoadMs = protocolDurationMs(scopeLoadStartedAt)
    const scope = runDisplaySourceStage(
      'scope-resolution',
      () => (primaryTarget ? displayScope(database, primaryTarget.characterId, chatId) : null),
      diagnostics,
    )
    if (!scope) throw new ValidationError('Display source chat or character was not found')
    if (diagnostics) diagnostics.transcriptMessageCount = scope.chat.message?.length ?? 0
    const entries: DisplaySourceResponseEntry[] = []
    const { luaExecBudget, triggerBudget, modules, dynamicAssetFallback } = runDisplaySourceStage(
      'shared-dependencies',
      () => {
        const luaExecBudget = createLuaExecBudget()
        // Foreground work can suspend this batch between targets. Charge its
        // script budget for its own processing, not another batch's queue turn.
        const triggerBudget = createTriggerExecutionBudget({ now: () => protocolNowMs() - queueTiming.waitMs })
        const modules = getActiveModules(scope.database, scope.character, scope.chat)
        const dynamicAssetFallback = dynamicAssetFallbackRequired(scope, modules)
        return { luaExecBudget, triggerBudget, modules, dynamicAssetFallback }
      },
      diagnostics,
      'moduleResolutionMs',
    )
    const sharedDependencyStartedAt = protocolNowMs()
    const sharedDependencyFingerprint = runDisplaySourceStage(
      'shared-dependencies',
      () => fingerprintSharedDependencies(scope, modules, diagnostics),
      diagnostics,
    )
    const sharedDependencyMs = protocolDurationMs(sharedDependencyStartedAt)
    let targetFingerprintMs = 0
    let batchCacheHitCount = 0
    let batchCacheMissCount = 0
    let batchInflightJoinCount = 0
    let streamingBypassCount = 0

    for (const target of request.targets) {
      throwIfAborted(signal)
      const before = this.postconditionResponse(
        request,
        initialRevision,
        databaseLineage,
        activeWriterEpoch,
        contextFingerprint,
        diagnostics,
      )
      if (before) return before
      const entry = await (async (): Promise<DisplaySourceResponseEntry> => {
        throwIfAborted(signal)
        if (diagnostics) diagnostics.visitedTargetCount++
        if (target.characterId !== scope.character.chaId || !targetIsFresh(scope, target)) {
          return errorEntry(target, 'stale', 'target_identity_changed')
        }
        const actualSourceHash = runDisplaySourceStage('target-preparation', () => sha256(target.source), diagnostics)
        if (actualSourceHash !== target.sourceHash) {
          return errorEntry(target, 'error', 'source_hash_mismatch')
        }
        if (dynamicAssetFallback) {
          return errorEntry(target, 'client_fallback', 'dynamic_asset_similarity_required')
        }

        const targetFingerprintStartedAt = protocolNowMs()
        const dependencyFingerprint = runDisplaySourceStage(
          'target-preparation',
          () =>
            sha256(
              stableDisplayDependencyJson(targetDependencyValue(sharedDependencyFingerprint, target, actualSourceHash)),
            ),
          diagnostics,
          'targetFingerprintMs',
        )
        targetFingerprintMs += protocolDurationMs(targetFingerprintStartedAt)
        try {
          const execute = async () => {
            diagnostics?.transformStarted(target.streaming === true)
            const outcome = await this.transformTarget(
              scope,
              target,
              request.context,
              luaExecBudget,
              triggerBudget,
              modules,
              signal,
              diagnostics,
            )
            emitProtocolMetric('display_source_transform', {
              status: 'ok',
              characterId: target.characterId,
              chatId: scope.chat.id,
              durationMs: Object.values(outcome.stageDurations).reduce((sum, duration) => sum + duration, 0),
              outputBytes: Buffer.byteLength(outcome.displaySource, 'utf8'),
              ephemeralStateChanged: outcome.ephemeralStateChanged,
              ...outcome.stageDurations,
            })
            return {
              value: { displaySource: outcome.displaySource, dependencyFingerprint },
              cacheable: true,
            }
          }
          const result = target.streaming
            ? { ...(await execute()).value, cacheStatus: 'miss' as const }
            : await this.cache.resolve(contextFingerprint, dependencyFingerprint, execute)
          if (target.streaming) streamingBypassCount += 1
          else if (result.cacheStatus === 'hit') batchCacheHitCount += 1
          else if (result.cacheStatus === 'inflight_join') batchInflightJoinCount += 1
          else batchCacheMissCount += 1
          if (diagnostics && result.cacheStatus === 'hit') diagnostics.cacheHitCount++
          if (diagnostics && result.cacheStatus === 'inflight_join') diagnostics.inflightJoinCount++
          return {
            requestKey: target.requestKey,
            status: 'ok',
            sourceHash: target.sourceHash,
            dependencyFingerprint: result.dependencyFingerprint,
            displaySource: result.displaySource,
          }
        } catch (error) {
          throwIfAborted(signal)
          const reason = isBoundedRegexError(error) ? 'bounded_regex_rejected' : 'transform_failed'
          return errorEntry(target, isBoundedRegexError(error) ? 'client_fallback' : 'error', reason)
        }
      })()
      throwIfAborted(signal)
      const stale = this.postconditionResponse(
        request,
        initialRevision,
        databaseLineage,
        activeWriterEpoch,
        contextFingerprint,
        diagnostics,
      )
      if (stale) return stale
      entries.push(entry)
      yield {
        protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION,
        revision: initialRevision,
        contextFingerprint,
        entries: [entry],
      }
    }

    const revision = initialRevision
    const stale = this.postconditionResponse(
      request,
      initialRevision,
      databaseLineage,
      activeWriterEpoch,
      contextFingerprint,
      diagnostics,
    )
    if (stale) return stale

    emitProtocolMetric('display_source_batch', {
      status: 'ok',
      targetCount: request.targets.length,
      okCount: entries.filter((entry) => entry.status === 'ok').length,
      fallbackCount: entries.filter((entry) => entry.status === 'client_fallback').length,
      durationMs: protocolDurationMs(startedAt),
      queueWaitMs: queueTiming.waitMs,
      queueDepth,
      scopeLoadMs,
      sharedDependencyMs,
      targetFingerprintMs,
      transcriptMessageCount: scope.chat.message?.length ?? 0,
      batchCacheHitCount,
      batchCacheMissCount,
      batchInflightJoinCount,
      streamingBypassCount,
      revision,
      cache: this.cache.stats(),
    })
    return { protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION, revision, contextFingerprint, entries }
  }

  private loadScopeDatabase(chatId: string, characterId: string, diagnostics?: DisplaySourceDiagnostics): Database {
    const persisted = runDisplaySourceStage(
      'scope-load',
      () => loadPersistedForDisplaySource(this.db, this.dataDir, { chatId, characterId }, diagnostics),
      diagnostics,
    )
    if (!persisted.database || typeof persisted.database !== 'object') {
      throw new ValidationError('Server database is not initialized')
    }
    return runDisplaySourceStage('scope-decode', () => decodeDisplaySourceDatabase(persisted.database), diagnostics)
  }

  private async transformTarget(
    scope: DisplayScope,
    target: DisplaySourceTarget,
    clientContext: DisplaySourceRequest['context'],
    luaExecBudget: ReturnType<typeof createLuaExecBudget>,
    triggerBudget: ReturnType<typeof createTriggerExecutionBudget>,
    modules: ReturnType<typeof getActiveModules>,
    signal?: AbortSignal,
    diagnostics?: DisplaySourceDiagnostics,
  ): Promise<TransformOutcome> {
    const stageDurations: Record<string, number> = {}
    const measure = async <T>(stage: 'lua' | 'trigger' | 'regex', operation: () => Promise<T>): Promise<T> => {
      const startedAt = protocolNowMs()
      try {
        return await operation()
      } finally {
        stageDurations[`${stage}Ms`] = protocolDurationMs(startedAt)
        diagnostics?.addDuration(`${stage}Ms`, stageDurations[`${stage}Ms`])
      }
    }
    let data = target.source
    const { beforeScriptstate, cbsConditions, model, varEngine } = runDisplaySourceStage(
      'target-preparation',
      () => {
        const beforeScriptstate = cloneScriptstate(scope.chat.scriptstate)
        const cbsConditions: CbsConditions = {
          firstmsg: target.firstMessage,
          ...(target.role === null ? {} : { chatRole: target.role }),
        }
        const model = resolvePromptModelId(scope.database, 'chatMain')
        const varEngine = createTriggerVarEngine({
          chat: scope.chat,
          database: scope.database,
          selectedCharID: scope.selectedCharID,
          chatPage: scope.chatPage,
          defaultVariables: getChatDefaultVariables(scope.character, scope.database),
        })
        return { beforeScriptstate, cbsConditions, model, varEngine }
      },
      diagnostics,
      'targetSetupMs',
    )
    try {
      try {
        data = await measure('lua', () =>
          runLuaEditTrigger(
            scope.character,
            'editdisplay',
            data,
            { index: target.index },
            {
              chat: scope.chat,
              database: scope.database,
              selectedCharID: scope.selectedCharID,
              chatPage: scope.chatPage,
              varEngine,
              model,
              signal,
              execBudget: luaExecBudget,
              requestHistoryDb: this.db,
              assetDataDir: this.dataDir,
              moduleTriggers: getModuleTriggers(modules),
            },
          ),
        )
      } catch {
        throwIfAborted(signal)
        installScriptstate(scope.chat, beforeScriptstate)
        data = target.source
      }

      try {
        const triggerResult = await measure('trigger', () =>
          runTrigger(
            {
              modules,
              model,
              database: scope.database,
              selectedCharID: scope.selectedCharID,
              chatPage: scope.chatPage,
              signal,
              triggerBudget,
              clientContext,
            },
            scope.character,
            'display',
            {
              chat: scope.chat,
              displayMode: true,
              displayData: data,
              triggerBudget,
            },
          ),
        )
        if (!triggerResult?.aborted) data = triggerResult?.displayData ?? data
      } catch {
        throwIfAborted(signal)
        // The browser catches the display-trigger stage and continues.
      }

      const fakeInjectTarget = { role: target.role ?? 'char', data: target.source } as Message
      data = await measure('regex', () =>
        processScriptAsync(
          {
            database: scope.database,
            selectedCharID: scope.selectedCharID,
            chatPage: scope.chatPage,
            chara: scope.character,
            runVar: false,
            role: target.role ?? undefined,
            cbsConditions,
            signal,
            clientContext,
          },
          scope.character,
          data,
          'editdisplay',
          cbsConditions,
          target.index,
          scope.chat,
          { injectTarget: fakeInjectTarget },
        ),
      )
      const ephemeralStateChanged = !isDeepStrictEqual(beforeScriptstate, scope.chat.scriptstate)
      return {
        displaySource: data,
        ephemeralStateChanged,
        stageDurations,
      }
    } finally {
      const cleanupStartedAt = diagnostics ? protocolNowMs() : 0
      // `editDisplay` is a render-time projection, so it may be retried, cached,
      // skipped, or evaluated out of transcript order. Lua chat-variable writes
      // stay visible to the remaining stages of this target, but every target
      // starts from the same authoritative snapshot: always discard its delta
      // before another target runs, and never persist display-time scriptstate.
      try {
        installScriptstate(scope.chat, beforeScriptstate)
      } finally {
        diagnostics?.addDuration('targetCleanupMs', protocolNowMs() - cleanupStartedAt)
      }
    }
  }

  private staleResponse(
    request: DisplaySourceRequest,
    contextFingerprint: string,
    reason: string,
  ): DisplaySourceResponse {
    return {
      protocolVersion: DISPLAY_SOURCE_PROTOCOL_VERSION,
      revision: getSchemaState(this.db).revision,
      contextFingerprint,
      entries: request.targets.map((target) => errorEntry(target, 'stale', reason)),
    }
  }

  private postconditionResponse(
    request: DisplaySourceRequest,
    initialRevision: number,
    databaseLineage: string,
    activeWriterEpoch: number,
    contextFingerprint: string,
    diagnostics?: DisplaySourceDiagnostics,
  ): DisplaySourceResponse | null {
    if (
      runDisplaySourceStage('postcondition', () => getSchemaState(this.db).revision, diagnostics) !== initialRevision
    ) {
      return this.staleResponse(request, contextFingerprint, 'revision_changed_during_transform')
    }
    const { currentLineage, currentWriterEpoch } = runDisplaySourceStage(
      'postcondition',
      () => ({
        currentLineage: getDatabaseLineage(this.db),
        currentWriterEpoch: getDatabaseWriterMetadata(this.db).epoch,
      }),
      diagnostics,
    )
    if (currentLineage === databaseLineage && currentWriterEpoch === activeWriterEpoch) return null
    const currentNamespace = sha256(
      displaySourceNamespaceJson({
        databaseLineage: currentLineage,
        activeWriterEpoch: currentWriterEpoch,
        context: request.context,
      }),
    )
    this.cache.activate(currentNamespace)
    return this.staleResponse(request, contextFingerprint, 'display_namespace_retired')
  }
}
