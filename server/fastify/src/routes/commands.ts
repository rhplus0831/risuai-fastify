import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { isLocalStopStrings } from '@risuai/shared-core/local-stop-strings'
import { decompress as fflateDecompress } from 'fflate'
import type { AuthState } from '../auth.js'
import {
  COMMAND_EVENT_CATALOG,
  PRESET_COLLECTION_WITH_POINTER_RESOURCE,
  PRESET_POINTER_RESOURCE,
  REVISION_ONLY_RESOURCE,
  SETTINGS_WITH_HYPA_V3_PRESETS_RESOURCE,
  type CommandEvent,
  type CommandEventOrigin,
  type CommandEventSink,
} from '../commands/events.js'
import {
  applyCharacterSelectionCommandMutation,
  applyJsonCommandMutation,
  applyTargetedCommandMutation,
  readBaseRevision,
  TARGETED_MUTATION_PATHS,
} from '../commands/mutations.js'
import { readActiveWriterSessionId } from '../activeWriter.js'
import {
  COMMAND_MUTATION_ACK_MAX_REQUEST_COUNT,
  COMMAND_MUTATION_ID_HEADER,
  COMMAND_MUTATION_ID_MAX_LENGTH,
  CommandMutationIdConflictError,
  acknowledgeCommandMutationReceipts,
  commandMutationRequestFingerprint,
  loadCommandMutationReceipt,
  type CommandMutationReceiptKey,
} from '../commandMutationReceipts.js'
import { DATABASE_LINEAGE_HEADER, DatabaseLineageConflictError } from '../databaseLineage.js'
import { completeClaimedIgpEffectInTransaction } from '../generationEffects.js'
import { InitializeConflictError } from '../databaseInitialization.js'
import { MAX_REQUEST_HISTORY_LIMIT, pruneRequestHistory } from '../requestHistory.js'
import { maskProviderSecrets, resolveMaskedProviderSecretPlaceholders } from '../providerSecrets.js'
import {
  normalizeLegacyFallbackModels,
  normalizeLegacySeperateModels,
  normalizeModelRoleOverrides,
} from '@risuai/shared-core/model-roles'
import {
  ModelProfileRecordValidationError,
  normalizeModelProfileOrder,
  normalizeModelRuntimeDefaults,
  normalizeModelProfiles,
  normalizeModelRoleProfiles,
  readModelProfileOrder,
  readModelProfiles,
  readModelRuntimeDefaults,
  readModelRoleProfiles,
} from '@risuai/shared-core/model-profile-records'
import {
  normalizeProviderCredentials,
  ProviderCredentialRecordValidationError,
  readProviderCredentials,
} from '@risuai/shared-core/provider-credential-records'
import { normalizeChatGenerationTogglePresets } from '@risuai/shared-core/chat-generation-toggle-preset-records'
import { hypaV3PresetIndexFromStableId } from '@risuai/shared-core/hypa-v3-preset-selection-identity'
import {
  MAX_REGEX_OUTPUT_SIZE_LIMIT_MIB,
  MIN_REGEX_OUTPUT_SIZE_LIMIT_MIB,
} from '@risuai/shared-core/regex-output-size-limit'
import {
  MAX_DESKTOP_SIDEBAR_COLUMNS,
  MAX_MOBILE_SIDEBAR_COLUMNS,
  MIN_SIDEBAR_COLUMNS,
  isValidDesktopSidebarColumns,
  isValidMobileSidebarColumns,
} from '@risuai/shared-core/sidebar-columns'
import {
  createPromptItemRecord,
  normalizePromptItemRecord,
  PROMPT_SETTINGS_KEYS,
  readPromptItemId,
  readPromptItemPatch,
  readPromptSettingsPatch,
  requirePromptItemIndex,
  validateFullPromptItemIdList,
  type PromptItemRecord,
} from '../commands/prompts.js'
import {
  buildPersonaMutationCertificate,
  createPersonaRecord,
  ensureDatabaseObject as ensurePersonaDatabaseObject,
  ensurePersonaCollection,
  findPersonaIndex,
  mirrorLegacyProfile,
  readOptionalBoolean as readPersonaOptionalBoolean,
  readPersonaId,
  readPersonaPatch,
  requirePersonaIndex,
  requireSelectedPersonaIndex,
  saveSelectedPersonaSnapshot,
  selectedPersonaId,
  validateFullPersonaIdList,
  type PersonaMutationCertificate,
} from '../commands/personas.js'
import {
  applyPreset,
  createPresetRecord,
  ensureDatabaseObject,
  ensurePresetCollection,
  findPresetIndex,
  normalizePresetAgentSettings,
  readJsonObject,
  readOptionalBoolean,
  readOptionalString,
  readPresetPatch,
  readPresetId,
  requirePresetIndex,
  saveCurrentPresetSnapshot,
  selectedPresetId,
  validateFullPresetIdList,
  type PresetRecord,
} from '../commands/presets.js'
import {
  applyModelPreset,
  applyPromptPreset,
  createModelPresetRecord,
  createPromptPresetRecord,
  ensureDatabaseObject as ensureSplitPresetDatabaseObject,
  ensureModelPresetCollection,
  ensurePromptPresetCollection,
  extractLegacyBotPreset,
  findModelPresetIndex,
  findPromptPresetIndex,
  promptPresetAppliesPromptTemplate,
  readModelPresetId,
  readModelPresetPatch,
  readPromptPresetId,
  readPromptPresetPatch,
  requireModelPresetIndex,
  requirePromptPresetIndex,
  resolveModelPresetMaskedSecrets,
  selectedModelPresetId,
  selectedPromptPresetId,
  validateFullModelPresetIdList,
  validateFullPromptPresetIdList,
  validatePromptPresetRecommendedModelPreset,
  type LegacyBotPresetExtractionMode,
} from '../commands/splitPresets.js'
import {
  applyTranslatorPresetRecordPatch,
  createTranslatorPresetRecord,
  ensureDatabaseObject as ensureTranslatorPresetDatabaseObject,
  ensureTranslatorPresetCollection,
  findTranslatorPresetIndex,
  readOptionalBoolean as readTranslatorPresetOptionalBoolean,
  readTranslatorPresetId,
  readTranslatorPresetPatch,
  requireTranslatorPresetIndex,
  selectedTranslatorPresetId,
} from '../commands/translatorPresets.js'
import {
  createLoadoutRecord,
  ensureDatabaseObject as ensureLoadoutDatabaseObject,
  ensureLoadoutCollection,
  findLoadoutIndex,
  readLoadoutId,
  readLoadoutPatch,
  readOptionalBoolean as readLoadoutOptionalBoolean,
  readOptionalCharacterId,
  readOptionalTimestamp,
  requireLoadoutIndex,
} from '../commands/loadouts.js'
import { rehomeGenerationReferences, type GenerationReferenceCascadeResult } from '../commands/generationReferences.js'
import {
  type CharacterRecord,
  buildStrictPatchedCharacterRow,
  createCharacterRecord,
  ensureDatabaseObject as ensureCharacterDatabaseObject,
  findCharacterIndex,
  readAlternateGreetingMutation,
  readCharacterId,
  readCharacterOrder,
  readCharacterPatch,
  repairCharacterCollectionRow,
  requireCharacterIndex,
  readStrictCharacterRecord,
  remapAlternateGreetingIndex,
  selectedCharacterId,
  validateCharacterOrderAssetRefs,
  validateFullCharacterOrder,
} from '../commands/characters.js'
import {
  buildChatGenerationSettingsSparseReceipt,
  chatFolderIdExists,
  chatIdExists,
  createChatFolderRecord,
  createChatRecord,
  ensureCharacterChatFolders,
  ensureCharacterChats,
  requireChatLocationExact,
  requireStrictChatLocation,
  normalizeAllCharacterChats,
  readChatFolderId,
  readChatFolderIdList,
  readChatFolderPatch,
  readChatGenerationSettingsSave,
  readChatGenerationSettingsWrite,
  readChatId,
  readChatIdList,
  readChatPatch,
  readChatScriptstateDeleteKeys,
  readChatScriptstatePatch,
  readStrictCharacterChatFolders,
  readOptionalBoolean as readChatOptionalBoolean,
  readOptionalFolderByChatId,
  requireChatFolderIndex,
  requireChatLocation,
  selectChat,
  selectedChatId,
  selectedChatIdStrict,
  validateChatScriptstateCommand,
  validateFullChatFolderOrder,
  validateFullChatOrder,
  type ChatRecord,
  type ChatFolderRecord,
} from '../commands/chats.js'
import {
  createMessageRecord,
  ensureChatMessages,
  readGenerationResult,
  readMessageId,
  readMessagePatch,
  readReplacementMessages,
  readStrictStoredMessageRecord,
  readTruncateAfterMessageId,
  type MessageRecord,
  validateUniqueMessageIds,
} from '../commands/messages.js'
import {
  applyLorebookEntryWriteById,
  deleteLorebookEntryById,
  normalizeSelectedCharacterLorebooks,
  normalizeSelectedChatLorebooks,
  readCharacterId as readLorebookCharacterId,
  readChatId as readLorebookChatId,
  readGlobalLorebookPatch,
  readLorebookEntryWrite,
  readLorebookId,
  readLorebookIdList,
  readModuleId,
  readStrictGlobalLorebookCollection,
  reorderLorebookEntriesById,
  requireGlobalLorebookIndex,
  requireModule,
  validateFullLorebookOrder,
  validateGlobalLorebookCreate,
  validateLorebookEntries,
  validateStoredGlobalLorebook,
  validateStoredLorebookEntries,
} from '../commands/lorebooks.js'
import {
  applyScriptDefinitionCollectionMutation,
  applyTriggerDefinitionCollectionMutation,
  readCharacterScriptParent,
  readDefinitionCollectionMutation,
  readScriptDefinitions,
  readTriggerDefinitions,
  scriptDefinitionCollectionDigest,
} from '../commands/scriptDefinitions.js'
import {
  createModuleRecord,
  createModuleFolderRecord,
  findCharacterForModuleCommand,
  readCharacterId as readModuleCharacterId,
  readModuleEnabled,
  readModuleFolderAssignments,
  readModuleFolderIdList,
  readModuleFolderPatch,
  readModuleId as readCommandModuleId,
  readModuleIdList,
  readModulePatch,
  readStrictEnabledModules,
  readStrictModuleRecords,
  readStrictModuleFolders,
  removeModuleReferences,
  requireModuleIndex,
  validateCharacterModuleLinks,
  validateFullModuleOrder,
  validateFullModuleFolderOrder,
  validateModuleFolderReference,
  validateNormalModuleLinks,
  validateStoredModuleRecord,
} from '../commands/modules.js'
import {
  convertLegacyModelProfilesCommand,
  createAndBindModelProfileCommand,
  createModelProfileCommand,
  deleteModelProfileCommand,
  duplicateModelProfileCommand,
  reorderModelProfilesCommand,
  updateModelProfileCommand,
  updateModelRoleProfilesCommand,
  updateModelRuntimeDefaultsCommand,
} from '../commands/modelProfiles.js'
import {
  createProviderCredentialCommand,
  deleteProviderCredentialCommand,
  updateProviderCredentialCommand,
} from '../commands/providerCredentials.js'
import {
  createAgentCommand,
  createAgentPresetCommand,
  createAgentPresetStepCommand,
  deleteAgentCommand,
  deleteAgentPresetCommand,
  deleteAgentPresetStepCommand,
  duplicateAgentCommand,
  duplicateAgentPresetCommand,
  duplicateAgentPresetStepCommand,
  reorderAgentsCommand,
  reorderAgentPresetsCommand,
  reorderAgentPresetStepsCommand,
  setAgentPresetDefaultCommand,
  updateAgentCommand,
  updateAgentPresetCommand,
  updateAgentPresetStepCommand,
  readStrictAgentConfiguration,
} from '../commands/agentPresets.js'
import {
  createPluginRecord,
  readPluginEnabled,
  readPluginId,
  readPluginIdList,
  readPluginPatch,
  readPluginProvider,
  requirePluginIndex,
  validateFullPluginOrder,
  type PluginRecord,
} from '../commands/plugins.js'
import { readPluginStorageBulkPatch, readPluginStorageKey, readPluginStorageValue } from '../commands/pluginStorage.js'
import { validateOptionalServerAssetRef } from '../commands/assets.js'
import { requireAuth } from '../http.js'
import { getSchemaState } from '../db.js'
import type { ChatGenerationSettings } from '@risuai/shared-core/chat-generation-settings'
import {
  MODEL_PRESET_FIELDS,
  PROMPT_PRESET_FIELDS,
  PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS,
  PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS,
  PROMPT_PRESET_MODEL_PARAMETERS_OVERRIDE_KEY,
  clearPromptPresetRecommendedModelPresetReferences,
  databaseKeyForModelPresetField,
} from '@risuai/shared-core/preset-split'
import {
  activeMessageIdExistsOutsideChat,
  activeMessageIdExists,
  addAlternateMessage,
  appendChatMessage,
  clearAlternateMessages,
  deleteActiveMessageById,
  deleteChatHypaV3,
  deleteChatMessages,
  getChatMessages,
  replaceActiveChatMessages,
  resolveChatMessageIndexById,
  resolveActiveMessageLocationById,
  setChatHypaV3,
  truncateActiveChatMessages,
  updateActiveMessageById,
  writeGenerationChatMessage,
} from '../messageStore.js'
import {
  deleteCharacterChatRow,
  clearChatTranslatorPresetBindings,
  characterRowExists,
  chatRowExists,
  deleteCharacterRow,
  deletePluginStorageKey,
  deleteInlayCatalogEntry,
  EntityNotFoundError,
  extractSettings,
  initializeDefaultDatabase,
  insertCharacterChatRow,
  insertCharacterRow,
  loadCharacterAppendState,
  nextCharacterRowPosition,
  replacePluginStorage,
  RevisionMismatchError,
  ValidationError,
  upsertInlayCatalogEntry,
  writeCharacterChatRows,
  writePluginStorageKey,
  writePromptTemplateRow,
  writePromptTemplatesTable,
  writeSettingsOnly,
  writeSingleCharacterRow,
  writeSingleChatRow,
  writeSingleChatRowExact,
  writeSingleCollectionRow,
  writeSingleCollectionTable,
} from '../repository.js'
import { readLegacyStorageValue } from './legacyStorage.js'
import {
  deleteChangedGreetingTranslations,
  remapAlternateGreetingTranslations,
} from '../translation/greetingTranslationStore.js'
import type { MessageTranslationJobRegistry } from '../messageTranslationJobs.js'
import { runServerMessageTranslation } from '../translation/serverMessageTranslation.js'
import type { GreetingTranslationJobRegistry } from '../greetingTranslationJobs.js'
import { runServerGreetingTranslation } from '../translation/serverGreetingTranslation.js'
import {
  BARDWIKI_CONTEXT_POLICIES,
  BARDWIKI_DOCUMENT_KINDS,
  BARDWIKI_MEMORY_MODES,
  BARDWIKI_CONFIRMATION_POLICIES,
  BARDWIKI_REVIEW_STATES,
  BardWikiConflictError,
  BardWikiValidationError,
  createBardWikiDocument,
  deleteBardWikiDocument,
  updateBardWikiChatSettings,
  updateBardWikiDocument,
  type BardWikiChatSettingsPatch,
  type BardWikiDocumentKind,
  type BardWikiContextPolicy,
  type BardWikiReviewState,
} from '../bardWikiRepository.js'
import {
  createOrReuseExplicitBardWikiConfirmation,
  type ExplicitBardWikiConfirmationInput,
} from '../bardWikiReceipts.js'
import { isBardWikiGlobalSettings } from '@risuai/protocol'
import {
  applyBardWikiVaultImport,
  decodeBardWikiVault,
  planBardWikiVaultImport,
  type BardWikiVaultConflictStrategy,
  type BardWikiVaultExpectedTarget,
} from '../bardWikiVault.js'
import { enqueueBardWikiRebuild, previewBardWikiRebuild } from '../bardWikiRebuildHandler.js'

function commandEventOrigin(req: FastifyRequest): CommandEventOrigin | undefined {
  const writerSessionId = readActiveWriterSessionId(req)
  return writerSessionId ? { writerSessionId } : undefined
}

function commandMutationContext(req: FastifyRequest, eventSink: CommandEventSink) {
  const origin = commandEventOrigin(req)
  const mutationReceiptKey = readCommandMutationReceiptKey(req)
  return {
    eventSink,
    ...(origin ? { eventOrigin: origin } : {}),
    ...(mutationReceiptKey ? { mutationReceiptKey } : {}),
  }
}

function readCommandMutationReceiptKey(req: FastifyRequest): CommandMutationReceiptKey | undefined {
  const rawMutationId = req.headers[COMMAND_MUTATION_ID_HEADER]
  if (rawMutationId === undefined) return undefined
  if (Array.isArray(rawMutationId) || typeof rawMutationId !== 'string') {
    throw new ValidationError(`${COMMAND_MUTATION_ID_HEADER} must be a single header value`)
  }
  const mutationId = readCommandMutationId(rawMutationId, COMMAND_MUTATION_ID_HEADER)
  const writerSessionId = readActiveWriterSessionId(req)
  if (!writerSessionId) {
    throw new ValidationError(`${COMMAND_MUTATION_ID_HEADER} requires a valid risu-writer-session header`)
  }
  const rawDatabaseLineage = req.headers[DATABASE_LINEAGE_HEADER]
  if (Array.isArray(rawDatabaseLineage)) {
    throw new ValidationError(`${DATABASE_LINEAGE_HEADER} must be a single header value`)
  }
  const databaseLineage = readDatabaseLineage(rawDatabaseLineage, DATABASE_LINEAGE_HEADER)
  return {
    databaseLineage,
    writerSessionId,
    mutationId,
    requestFingerprint: commandMutationRequestFingerprint(req.method, req.url.split('?')[0] ?? req.url, req.body),
  }
}

function readCommandMutationId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`)
  }
  const mutationId = value.trim()
  if (
    mutationId.length === 0 ||
    mutationId.length > COMMAND_MUTATION_ID_MAX_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(mutationId)
  ) {
    throw new ValidationError(
      `${label} must contain 1-${COMMAND_MUTATION_ID_MAX_LENGTH} letters, numbers, dots, underscores, colons, or hyphens`,
    )
  }
  return mutationId
}

function readDatabaseLineage(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new ValidationError(`${label} must be a valid database lineage UUID`)
  }
  return value.toLowerCase()
}

function readCommandMutationReceiptAcknowledgement(body: unknown): {
  databaseLineage: string
  mutationIds: string[]
  requestCount: number
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('request body must be an object')
  }
  const record = body as Record<string, unknown>
  const unsupportedKey = Object.keys(record).find(
    (key) => key !== 'mutationId' && key !== 'requestCount' && key !== 'databaseLineage',
  )
  if (unsupportedKey) {
    throw new ValidationError(`Unsupported mutation receipt acknowledgement field: ${unsupportedKey}`)
  }
  const mutationId = readCommandMutationId(record.mutationId, 'mutationId')
  const databaseLineage = readDatabaseLineage(record.databaseLineage, 'databaseLineage')
  const requestCount = record.requestCount
  if (
    !Number.isSafeInteger(requestCount) ||
    (requestCount as number) < 1 ||
    (requestCount as number) > COMMAND_MUTATION_ACK_MAX_REQUEST_COUNT
  ) {
    throw new ValidationError(`requestCount must be an integer from 1 to ${COMMAND_MUTATION_ACK_MAX_REQUEST_COUNT}`)
  }
  const mutationIds = Array.from({ length: requestCount as number }, (_, index) =>
    index === 0 ? mutationId : readCommandMutationId(`${mutationId}.${index}`, `derived mutation id ${index}`),
  )
  return { databaseLineage, mutationIds, requestCount: requestCount as number }
}

function emitCommandEventForRequest(req: FastifyRequest, eventSink: CommandEventSink, event: CommandEvent): void {
  const origin = commandEventOrigin(req)
  eventSink.emit(origin ? { ...event, origin } : event)
}

/** Coerce a value to an array for a collection-table write (mirrors the broad
 *  path, which treats a non-array collection field as empty). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** Read the one character row supplied by a targeted chat loader without
 * repairing or widening the mutation to the aggregate character collection. */
function readScopedCharacterRecords(database: unknown): CharacterRecord[] {
  const target = ensureCharacterDatabaseObject(database)
  if (!Array.isArray(target.characters)) return []
  const candidate = target.characters[0]
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    typeof (candidate as Record<string, unknown>).chaId !== 'string' ||
    !(candidate as Record<string, unknown>).chaId
  ) {
    return []
  }
  return [candidate as CharacterRecord]
}

function readStrictIdentityCollection<T extends Record<string, unknown>>(
  value: unknown,
  collectionLabel: string,
  idKey: string,
): T[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${collectionLabel} must be an array`)
  }
  const seen = new Set<string>()
  value.forEach((candidate, index) => {
    const record = readJsonObject(candidate, `${collectionLabel}[${index}]`) as T
    const id = record[idKey]
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError(`${collectionLabel}[${index}].${idKey} must be a non-empty string`)
    }
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate ${collectionLabel} id: ${id}`)
    }
    seen.add(id)
  })
  return value as T[]
}

function readStrictHypaV3PresetState(
  target: Record<string, unknown>,
  options: { validateNumericProjection?: boolean } = {},
): { presets: Record<string, unknown>[]; selectedId: string | null; selectedIndex: number } {
  const presets = readStrictIdentityCollection<Record<string, unknown>>(target.hypaV3Presets, 'hypaV3Presets', 'id')
  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index]
    if (typeof preset.name !== 'string') {
      throw new ValidationError(`hypaV3Presets[${index}].name must be a string`)
    }
    if (!isPlainObject(preset.settings)) {
      throw new ValidationError(`hypaV3Presets[${index}].settings must be an object`)
    }
  }
  validateHypaV3PresetSummaryModels(presets)

  const selectedId = target.selectedHypaV3PresetId
  if (presets.length === 0) {
    if (selectedId !== null) {
      throw new ValidationError('selectedHypaV3PresetId must be null when hypaV3Presets is empty')
    }
  } else if (typeof selectedId !== 'string' || selectedId.trim() === '') {
    throw new ValidationError('selectedHypaV3PresetId must identify an existing Hypa V3 preset')
  }

  const selectedIndex = hypaV3PresetIndexFromStableId(target)
  if (presets.length > 0 && selectedIndex === -1) {
    throw new ValidationError(`Unknown selectedHypaV3PresetId: ${String(selectedId)}`)
  }
  if (options.validateNumericProjection !== false && target.hypaV3PresetId !== selectedIndex) {
    throw new ValidationError('hypaV3PresetId must match the selectedHypaV3PresetId compatibility projection')
  }

  return { presets, selectedId: selectedId as string | null, selectedIndex }
}

function validateStrictSelectedIndex(target: Record<string, unknown>, key: string, collectionLength: number): number {
  const selected = target[key]
  if (!Number.isInteger(selected)) {
    throw new ValidationError(`${key} must be an integer`)
  }
  const index = selected as number
  if (collectionLength === 0) {
    if (index !== -1) throw new ValidationError(`${key} must be -1 when its collection is empty`)
    return index
  }
  if (index < 0 || index >= collectionLength) {
    throw new ValidationError(`${key} must select an existing record`)
  }
  return index
}

function assertStoredRecordAlreadyCanonical<T>(record: T, parse: (copy: T) => unknown, label: string): void {
  const copy = cloneJsonForCommandCertificate(record)
  const canonical = parse(copy)
  if (!isDeepStrictEqual(record, canonical)) {
    throw new ValidationError(`${label} must already be canonical; use an explicit import or recovery boundary`)
  }
}

function readStrictLegacyPresetCollection(
  target: Record<string, unknown>,
  options: { allowEmptyPendingFirstRecord?: boolean; allowInvalidSelectedPointer?: boolean } = {},
): PresetRecord[] {
  const presets = readStrictIdentityCollection<PresetRecord>(target.botPresets, 'botPresets', 'id')
  for (let index = 0; index < presets.length; index += 1) {
    if (presets[index].name !== undefined && typeof presets[index].name !== 'string') {
      throw new ValidationError(`botPresets[${index}].name must be a string`)
    }
  }
  if (
    !options.allowInvalidSelectedPointer &&
    !(options.allowEmptyPendingFirstRecord && presets.length === 0 && target.botPresetsId === 0)
  ) {
    validateStrictSelectedIndex(target, 'botPresetsId', presets.length)
  }
  return presets
}

function readStrictModelPresetCollection(
  target: Record<string, unknown>,
): ReturnType<typeof ensureModelPresetCollection> {
  const presets = readStrictIdentityCollection<ReturnType<typeof ensureModelPresetCollection>[number]>(
    target.modelPresets,
    'modelPresets',
    'id',
  )
  for (let index = 0; index < presets.length; index += 1) {
    if (presets[index].name !== undefined && typeof presets[index].name !== 'string') {
      throw new ValidationError(`modelPresets[${index}].name must be a string`)
    }
  }
  validateStrictSelectedIndex(target, 'modelPresetsId', presets.length)
  return presets
}

function readStrictPromptPresetCollection(
  target: Record<string, unknown>,
): ReturnType<typeof ensurePromptPresetCollection> {
  const presets = readStrictIdentityCollection<ReturnType<typeof ensurePromptPresetCollection>[number]>(
    target.promptPresets,
    'promptPresets',
    'id',
  )
  for (let index = 0; index < presets.length; index += 1) {
    const preset = presets[index]
    if (preset.name !== undefined && typeof preset.name !== 'string') {
      throw new ValidationError(`promptPresets[${index}].name must be a string`)
    }
    if (preset.archived !== undefined && typeof preset.archived !== 'boolean') {
      throw new ValidationError(`promptPresets[${index}].archived must be a boolean`)
    }
    if (
      preset.recommendedModelPresetId !== undefined &&
      preset.recommendedModelPresetId !== null &&
      (typeof preset.recommendedModelPresetId !== 'string' || preset.recommendedModelPresetId.trim() === '')
    ) {
      throw new ValidationError(`promptPresets[${index}].recommendedModelPresetId must be non-empty or null`)
    }
  }
  validateStrictSelectedIndex(target, 'promptPresetsId', presets.length)
  return presets
}

function readStrictPromptTemplateCollection(
  target: Record<string, unknown>,
  options: { allowMissing?: boolean } = {},
): PromptItemRecord[] {
  if (target.promptTemplate === undefined && options.allowMissing) return []
  const items = readStrictIdentityCollection<PromptItemRecord>(target.promptTemplate, 'promptTemplate', 'id')
  for (let index = 0; index < items.length; index += 1) {
    assertStoredRecordAlreadyCanonical(
      items[index],
      (record) => normalizePromptItemRecord(record),
      `promptTemplate[${index}]`,
    )
  }
  return items
}

function readStrictPluginCommandTarget(database: unknown): {
  target: Record<string, unknown>
  plugins: PluginRecord[]
} {
  const target = readJsonObject(database, 'database')
  if (typeof target.currentPluginProvider !== 'string') {
    throw new ValidationError('currentPluginProvider must be a string')
  }
  const plugins = readStrictIdentityCollection<PluginRecord>(target.plugins, 'plugins', 'name')
  for (let index = 0; index < plugins.length; index += 1) {
    createPluginRecord(plugins[index], `plugins[${index}]`)
  }
  return { target, plugins }
}

function readStrictPluginProviderTarget(database: unknown): Record<string, unknown> {
  const target = readJsonObject(database, 'database')
  if (typeof target.currentPluginProvider !== 'string') {
    throw new ValidationError('currentPluginProvider must be a string')
  }
  return target
}

function readStrictPluginStorageTarget(database: unknown): {
  target: Record<string, unknown>
  storage: Record<string, unknown>
} {
  const target = readJsonObject(database, 'database')
  const storage = readJsonObject(target.pluginCustomStorage, 'pluginCustomStorage')
  return { target, storage }
}

function readStrictCharacterCollection(database: unknown): CharacterRecord[] {
  const target = readJsonObject(database, 'database')
  if (!Array.isArray(target.characters)) {
    throw new ValidationError('characters must be an array')
  }
  const seen = new Set<string>()
  target.characters.forEach((candidate, index) => {
    const record = readJsonObject(candidate, `characters[${index}]`)
    const id = readCharacterId(record.chaId, `characters[${index}].chaId`)
    if (seen.has(id)) throw new ValidationError(`Duplicate character id: ${id}`)
    seen.add(id)
    readStrictCharacterRecord(record, id)
  })
  validateStrictSelectedIndex(target, 'currentChar', target.characters.length)
  return target.characters as CharacterRecord[]
}

function readStrictCharacterChats(
  character: CharacterRecord,
  globalChatIds: Set<string> = new Set<string>(),
): ChatRecord[] {
  if (!Array.isArray(character.chats)) {
    throw new ValidationError(`character ${character.chaId}.chats must be an array`)
  }
  const folders = readStrictChatFolders(character)
  const folderIds = new Set(folders.map((folder) => folder.id))
  const chats = character.chats as ChatRecord[]
  for (let index = 0; index < chats.length; index += 1) {
    const record = readJsonObject(chats[index], `character ${character.chaId}.chats[${index}]`)
    const id = readChatId(record.id, `character ${character.chaId}.chats[${index}].id`)
    if (globalChatIds.has(id)) throw new ValidationError(`Duplicate chat id: ${id}`)
    globalChatIds.add(id)
    requireStrictChatLocation([character], id)
    if (record.folderId !== undefined && record.folderId !== null) {
      const folderId = readChatFolderId(record.folderId, `chat ${id}.folderId`)
      if (!folderIds.has(folderId)) throw new ValidationError(`Unknown chat folder id: ${folderId}`)
    }
  }
  selectedChatIdStrict(character)
  return chats
}

function readStrictChatFolders(character: CharacterRecord): ChatFolderRecord[] {
  readStrictCharacterChatFolders(character)
  return character.chatFolders as ChatFolderRecord[]
}

function readStrictCharacterGraph(database: unknown): CharacterRecord[] {
  const characters = readStrictCharacterCollection(database)
  const chatIds = new Set<string>()
  const folderIds = new Set<string>()
  for (const character of characters) {
    const folders = readStrictChatFolders(character)
    for (const folder of folders) {
      if (folderIds.has(folder.id)) throw new ValidationError(`Duplicate chat folder id: ${folder.id}`)
      folderIds.add(folder.id)
    }
    readStrictCharacterChats(character, chatIds)
  }
  return characters
}

function requireStrictChatFolderIndex(
  characters: readonly CharacterRecord[],
  folderId: string,
): { character: CharacterRecord; characterIndex: number; folderIndex: number } {
  let found: { character: CharacterRecord; characterIndex: number; folderIndex: number } | undefined
  for (let characterIndex = 0; characterIndex < characters.length; characterIndex += 1) {
    const character = characters[characterIndex]
    const folders = readStrictChatFolders(character)
    const folderIndex = folders.findIndex((folder) => folder.id === folderId)
    if (folderIndex === -1) continue
    if (found) throw new ValidationError(`Duplicate chat folder id: ${folderId}`)
    readStrictCharacterChats(character)
    found = { character, characterIndex, folderIndex }
  }
  if (!found) throw new EntityNotFoundError(`Chat folder not found: ${folderId}`)
  return found
}

function validateStrictFullChatOrder(
  character: CharacterRecord,
  chatIds: readonly string[],
  folderByChatId: Record<string, string | null> = {},
): void {
  const chats = readStrictCharacterChats(character)
  const existing = new Set(chats.map((chat) => chat.id))
  const seen = new Set<string>()
  for (const chatId of chatIds) {
    if (!existing.has(chatId)) throw new ValidationError(`Unknown chat id in chatIds: ${chatId}`)
    if (seen.has(chatId)) throw new ValidationError(`Duplicate chat id in chatIds: ${chatId}`)
    seen.add(chatId)
  }
  if (seen.size !== existing.size) throw new ValidationError('chatIds must include every chat for the character')
  const folderIds = new Set(readStrictChatFolders(character).map((folder) => folder.id))
  for (const [chatId, folderId] of Object.entries(folderByChatId)) {
    if (!existing.has(chatId)) throw new ValidationError(`Unknown chat id in folderByChatId: ${chatId}`)
    if (folderId !== null && !folderIds.has(folderId)) {
      throw new ValidationError(`Unknown chat folder id in folderByChatId: ${folderId}`)
    }
  }
}

function validateStrictFullChatFolderOrder(character: CharacterRecord, folderIds: readonly string[]): void {
  const folders = readStrictChatFolders(character)
  const existing = new Set(folders.map((folder) => folder.id))
  const seen = new Set<string>()
  for (const folderId of folderIds) {
    if (!existing.has(folderId)) throw new ValidationError(`Unknown chat folder id in folderIds: ${folderId}`)
    if (seen.has(folderId)) throw new ValidationError(`Duplicate chat folder id in folderIds: ${folderId}`)
    seen.add(folderId)
  }
  if (seen.size !== existing.size) {
    throw new ValidationError('folderIds must include every chat folder for the character')
  }
}

function selectChatStrict(character: CharacterRecord, chatId: string): void {
  const chats = readStrictCharacterChats(character)
  const index = chats.findIndex((chat) => chat.id === chatId)
  if (index === -1) throw new EntityNotFoundError(`Chat not found for character ${character.chaId}: ${chatId}`)
  character.chatPage = index
}

function requireOrdinaryChatLocation(characters: readonly CharacterRecord[], chatId: string, db: DatabaseSync) {
  return chatRowExists(db, chatId)
    ? requireStrictChatLocation(characters, chatId)
    : requireChatLocationExact(characters, chatId)
}

function findJsonRecordById(
  values: unknown,
  id: string,
  idKey: 'id' | 'chaId' = 'id',
): Record<string, unknown> | undefined {
  if (!Array.isArray(values)) return undefined
  return values.find(
    (candidate): candidate is Record<string, unknown> =>
      !!candidate && typeof candidate === 'object' && !Array.isArray(candidate) && candidate[idKey] === id,
  )
}

function findRawChatRecord(database: Record<string, unknown>, chatId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(database.characters)) return undefined
  for (const candidate of database.characters) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const chat = findJsonRecordById((candidate as Record<string, unknown>).chats, chatId)
    if (chat) return chat
  }
  return undefined
}

function cloneJsonForCommandCertificate<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

const PRESET_REORDER_ACKNOWLEDGEMENT_CERTIFICATE = 'preset-reorder-v1' as const

function buildPresetReorderAcknowledgement(
  presetKind: 'legacy' | 'model',
  presetIds: readonly string[],
  settingsWritten: boolean,
  acknowledgementSafe: boolean,
):
  | {
      presetReorderCertificate: typeof PRESET_REORDER_ACKNOWLEDGEMENT_CERTIFICATE
      presetKind: 'legacy' | 'model'
      presetIds: string[]
      settingsWritten: boolean
    }
  | Record<string, never> {
  if (!acknowledgementSafe) return {}
  return {
    presetReorderCertificate: PRESET_REORDER_ACKNOWLEDGEMENT_CERTIFICATE,
    presetKind,
    presetIds: [...presetIds],
    settingsWritten,
  }
}

function readGlobalLorebookCommandTarget(database: unknown): {
  target: Record<string, unknown>
  lorebooks: ReturnType<typeof readStrictGlobalLorebookCollection>
} {
  const target = readJsonObject(database, 'database')
  const lorebooks = readStrictGlobalLorebookCollection(target)
  return { target, lorebooks }
}

function readScriptDefinitionCommandTarget(database: unknown): Record<string, unknown> {
  // Incoming script/trigger payloads are strictly validated before mutation.
  // The corpus-wide script-definition repair is validate-only for these routes.
  return readJsonObject(database, 'database')
}

function readModuleCollectionCommandTarget(database: unknown): {
  target: Record<string, unknown>
  modules: ReturnType<typeof readStrictModuleRecords>
} {
  const target = readJsonObject(database, 'database')
  const modules = readStrictModuleRecords(target)
  return { target, modules }
}

function readStrictModuleCommandTarget(database: unknown): {
  target: Record<string, unknown>
  modules: ReturnType<typeof readStrictModuleRecords>
  enabledModuleIds: string[]
} {
  const target = readJsonObject(database, 'database')
  const modules = readStrictModuleRecords(target)
  for (let index = 0; index < modules.length; index += 1) {
    validateStoredModuleRecord(modules[index], `module[${index}]`, { allowMcp: true })
  }
  const enabledModuleIds = readStrictEnabledModules(target)
  validateNormalModuleLinks(modules, enabledModuleIds, 'enabledModules')
  return { target, modules, enabledModuleIds }
}

function readStrictModuleLorebookTarget(database: unknown, moduleId: string) {
  const { modules } = readModuleCollectionCommandTarget(database)
  const module = requireModule(modules, moduleId)
  validateStoredModuleRecord(module, `module ${moduleId}`)
  const entries =
    module.lorebook === undefined ? [] : validateStoredLorebookEntries(module.lorebook, `module ${moduleId}.lorebook`)
  return { modules, module, entries }
}

function characterOrderIncludes(order: readonly unknown[], characterId: string): boolean {
  return order.some((entry) => {
    if (entry === characterId) return true
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const data = (entry as Record<string, unknown>).data
    return Array.isArray(data) && data.includes(characterId)
  })
}

function characterOrderWithout(order: readonly unknown[], characterId: string): unknown[] {
  const next: unknown[] = []
  for (const entry of order) {
    if (entry === characterId) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      next.push(entry)
      continue
    }
    const folder = entry as Record<string, unknown>
    const data = Array.isArray(folder.data) ? folder.data.filter((id) => id !== characterId) : folder.data
    if (Array.isArray(data) && data.length === 0) continue
    next.push({ ...folder, data })
  }
  return next
}

function updateCharacterOrderForPatchedRow(
  target: Record<string, unknown>,
  characterId: string,
  character: Record<string, unknown>,
): void {
  const currentOrder = Array.isArray(target.characterOrder) ? target.characterOrder : []
  const active = !character.trashTime && characterId !== '§temp'
  if (!active) {
    target.characterOrder = characterOrderWithout(currentOrder, characterId)
    return
  }
  target.characterOrder = characterOrderIncludes(currentOrder, characterId)
    ? currentOrder
    : [...currentOrder, characterId]
}

function applySelectedPromptPresetAfterModelPreset(target: Record<string, unknown>): void {
  const promptPresets = readStrictPromptPresetCollection(target)
  const promptPresetIndex = Number.isInteger(target.promptPresetsId as number) ? (target.promptPresetsId as number) : -1
  const promptPreset = promptPresetIndex >= 0 ? promptPresets[promptPresetIndex] : undefined
  if (promptPreset) {
    applyPromptPreset(target, promptPreset)
  }
}

const MODEL_PRESET_FIELD_NAMES = new Set<string>(MODEL_PRESET_FIELDS)
const PROMPT_PRESET_FIELD_NAMES = new Set<string>(PROMPT_PRESET_FIELDS)
const PROMPT_PRESET_MODEL_PARAMETER_FIELD_NAMES = new Set<string>(PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS)
const PROMPT_PRESET_MODEL_OTHER_FIELD_NAMES = new Set<string>(PROMPT_PRESET_MODEL_OTHERS_OVERRIDE_FIELDS)

function splitPresetSettingsProjectionKeys(kind: 'model' | 'prompt', patch: Record<string, unknown>): string[] {
  const keys = new Set<string>()
  if (kind === 'model') {
    for (const key of Object.keys(patch)) {
      if (MODEL_PRESET_FIELD_NAMES.has(key)) keys.add(databaseKeyForModelPresetField(key))
    }
    return [...keys]
  }

  for (const key of Object.keys(patch)) {
    if (key === 'regex' || key === 'presetRegex') {
      keys.add('presetRegex')
    } else if (key !== 'promptTemplate' && PROMPT_PRESET_FIELD_NAMES.has(key)) {
      keys.add(key)
    }
    if (PROMPT_PRESET_MODEL_PARAMETER_FIELD_NAMES.has(key) || PROMPT_PRESET_MODEL_OTHER_FIELD_NAMES.has(key)) {
      keys.add(databaseKeyForModelPresetField(key))
    }
    if (key === PROMPT_PRESET_MODEL_PARAMETERS_OVERRIDE_KEY) {
      for (const field of PROMPT_PRESET_MODEL_PARAMETER_OVERRIDE_FIELDS) {
        keys.add(databaseKeyForModelPresetField(field))
      }
    }
  }
  return [...keys]
}

function compactCanonicalOverrides(
  canonicalSource: Record<string, unknown>,
  optimisticSource: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const canonical = maskProviderSecrets(Object.fromEntries(keys.map((key) => [key, canonicalSource[key]]))) as Record<
    string,
    unknown
  >
  const optimistic = maskProviderSecrets(Object.fromEntries(keys.map((key) => [key, optimisticSource[key]]))) as Record<
    string,
    unknown
  >
  return Object.fromEntries(
    keys.filter((key) => !isDeepStrictEqual(canonical[key], optimistic[key])).map((key) => [key, canonical[key]]),
  )
}

function compactCanonicalPresetReceipt(
  canonicalSource: Record<string, unknown>,
  optimisticSource: Record<string, unknown>,
): { canonicalValues: Record<string, unknown>; canonicalDeletedKeys: string[] } {
  const canonical = maskLegacyPresetReceiptRow(canonicalSource)
  const optimistic = maskLegacyPresetReceiptRow(optimisticSource)
  const canonicalValues: Record<string, unknown> = {}
  const canonicalDeletedKeys: string[] = []
  const keys = new Set([...Object.keys(optimistic), ...Object.keys(canonical)])

  for (const key of keys) {
    if (key === 'id') continue
    const canonicalPresent = Object.prototype.hasOwnProperty.call(canonical, key)
    const optimisticPresent = Object.prototype.hasOwnProperty.call(optimistic, key)
    if (canonicalPresent === optimisticPresent && isDeepStrictEqual(canonical[key], optimistic[key])) continue
    if (canonicalPresent) canonicalValues[key] = canonical[key]
    else canonicalDeletedKeys.push(key)
  }

  return { canonicalValues, canonicalDeletedKeys }
}

function resolveMaskedLegacyPresetPatch(
  existingPreset: Record<string, unknown>,
  requestedPatch: Record<string, unknown>,
  presetId: string,
): Record<string, unknown> {
  const includesModelProfiles = Object.prototype.hasOwnProperty.call(requestedPatch, 'modelProfiles')
  const resolved = resolveMaskedProviderSecretPlaceholders(
    {
      botPresets: [existingPreset],
      modelProfiles: Array.isArray(existingPreset.modelProfiles) ? existingPreset.modelProfiles : [],
    },
    {
      botPresets: [{ ...requestedPatch, id: presetId }],
      ...(includesModelProfiles ? { modelProfiles: requestedPatch.modelProfiles } : {}),
    },
  ) as { botPresets: Record<string, unknown>[]; modelProfiles?: unknown }
  const resolvedPatch = resolved.botPresets[0] ?? { id: presetId }
  if (includesModelProfiles) resolvedPatch.modelProfiles = resolved.modelProfiles
  return resolvedPatch
}

function maskLegacyPresetReceiptRow(source: Record<string, unknown>): Record<string, unknown> {
  const envelope = maskProviderSecrets({
    botPresets: [source],
    modelProfiles: Array.isArray(source.modelProfiles) ? source.modelProfiles : [],
  }) as { botPresets: Record<string, unknown>[]; modelProfiles: unknown[] }
  const preset = envelope.botPresets[0] ?? {}
  if (Object.prototype.hasOwnProperty.call(source, 'modelProfiles')) {
    preset.modelProfiles = envelope.modelProfiles
  }
  return preset
}

function hasSplitPresetProjectionChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => !isDeepStrictEqual(before[key], after[key]))
}

/** The shared narrow write for every translator-preset route: a full
 *  `translator_presets` rewrite plus an unconditional `settings` write.
 *  Legacy translator prompt/max-response scalars remain untouched; the
 *  canonical preset rows own ordinary runtime behavior. */
function writeTranslatorPresetMutation(
  db: DatabaseSync,
  target: Record<string, unknown>,
  presets: readonly unknown[],
): void {
  writeSingleCollectionTable(db, 'translatorPresets', presets)
  writeSettingsOnly(db, extractSettings(target))
}

/** The shared narrow write for every loadouts route: a full `loadouts` rewrite
 *  (`ensureLoadoutCollection` reassigns the whole array by design, so even a
 *  field edit is a faithful one-table rewrite) plus a `settings` write only when
 *  `lastLoadedLoadoutName` actually moved (touch sets it; the rest leave it). */
function writeLoadoutMutation(
  db: DatabaseSync,
  target: Record<string, unknown>,
  loadouts: readonly unknown[],
  beforeLastLoaded: unknown,
): void {
  writeSingleCollectionTable(db, 'loadouts', loadouts)
  if (target.lastLoadedLoadoutName !== beforeLastLoaded) {
    writeSettingsOnly(db, extractSettings(target))
  }
}

function writeGenerationReferenceCascade(
  db: DatabaseSync,
  target: Record<string, unknown>,
  cascade: GenerationReferenceCascadeResult,
): void {
  for (const { chatId, chat } of cascade.changedChats) {
    writeSingleChatRow(db, chatId, chat)
  }
  if (cascade.changedLoadoutCount > 0) {
    writeSingleCollectionTable(db, 'loadouts', asArray(target.loadouts))
  }
}

/** Full `lore_books` rewrite (create/delete/reorder change the array) plus a
 *  `settings` write only when the `loreBookPage` pointer moved. Child lorebook
 *  repair is intentionally left to broad import/restore normalization. */
function writeLorebookTableMutation(
  db: DatabaseSync,
  target: Record<string, unknown>,
  lorebooks: readonly unknown[],
  beforeLoreBookPage: unknown,
): void {
  writeSingleCollectionTable(db, 'loreBook', lorebooks)
  if (target.loreBookPage !== beforeLoreBookPage) {
    writeSettingsOnly(db, extractSettings(target))
  }
}

function buildChatGenerationSettingsValidationContext(
  target: Record<string, unknown>,
  character: CharacterRecord,
  chat: Record<string, unknown>,
) {
  const characterModuleIds = Array.isArray(character.modules)
    ? character.modules.filter((id): id is string => typeof id === 'string')
    : []
  const chatModuleIds = Array.isArray(chat.modules)
    ? chat.modules.filter((id): id is string => typeof id === 'string')
    : []
  const { agents, presets: agentPresets, defaultId: effectiveAgentPresetId } = readStrictAgentConfiguration(target)
  const { modules, enabledModuleIds } = readStrictModuleCommandTarget(target)

  return {
    personas: ensurePersonaCollection(target),
    modelPresets: readStrictModelPresetCollection(target),
    promptPresets: readStrictPromptPresetCollection(target),
    agentPresets,
    agents,
    effectiveAgentPresetId,
    modules,
    enabledModuleIds,
    characterModuleIds,
    chatModuleIds,
  }
}

function cloneChatGenerationSettings(settings: ChatGenerationSettings | undefined): ChatGenerationSettings | undefined {
  if (!settings) return undefined
  return {
    ...settings,
    ...(settings.sidebarToggles ? { sidebarToggles: { ...settings.sidebarToggles } } : {}),
  }
}

function readOptionalPromptPresetIdFromBody(body: PromptCommandBody): string | undefined {
  return body.promptPresetId === undefined ? undefined : readPromptPresetId(body.promptPresetId, 'promptPresetId')
}

function requireSelectedPromptPresetCommandTarget(
  database: unknown,
  promptPresetId: string,
  options: { allowMissingPromptTemplate?: boolean } = {},
): {
  preset: ReturnType<typeof ensurePromptPresetCollection>[number]
  index: number
  items: PromptItemRecord[]
} {
  const target = ensureSplitPresetDatabaseObject(database)
  const presets = readStrictPromptPresetCollection(target)
  const index = requirePromptPresetIndex(presets, promptPresetId)
  const selectedId = selectedPromptPresetId(target, presets)
  if (selectedId !== promptPresetId) {
    throw new ValidationError(`Selected prompt preset changed before command reached the server: ${promptPresetId}`)
  }
  const preset = presets[index]
  const items = readStrictPromptTemplateCollection(preset, { allowMissing: options.allowMissingPromptTemplate })
  return { preset, index, items }
}

const COLLECTION_SCOPED_READS = {
  // Selected model-preset mutations reapply the selected prompt preset's
  // model overrides after the base model fields, so both collections must be
  // resident in the targeted mutation snapshot.
  modelPresets: ['modelPresets', 'promptPresets'],
  promptPresets: ['promptPresets'],
  // Recommendation writes validate their foreign key without broadening
  // unrelated prompt-preset mutations.
  promptPresetsWithModels: ['modelPresets', 'promptPresets'],
  promptTemplate: ['promptTemplate'],
  legacyBotPresetExtraction: ['botPresets', 'modelPresets', 'promptPresets'],
  onboarding: ['modelPresets', 'promptPresets'],
  presets: ['botPresets'],
  personas: ['personas'],
  // Persona create/update validates module links without broadening the write:
  // only the persona row/table is persisted by those commands.
  personasWithModules: ['personas', 'modules'],
  translatorPresets: ['translatorPresets'],
  loadouts: ['loadouts'],
  lorebooks: ['loreBook'],
  modules: ['modules'],
  plugins: ['plugins'],
  hypaV3Presets: ['hypaV3Presets'],
} as const

interface RuntimeSettingsCommandBody {
  baseRevision?: unknown
  patch?: unknown
}

interface OnboardingCommandBody {
  baseRevision?: unknown
  modelPresetId?: unknown
  promptPresetId?: unknown
  modelPatch?: unknown
  promptPatch?: unknown
  settingsPatch?: unknown
}

interface SparseObjectSettingsCommandBody extends RuntimeSettingsCommandBody {
  deleteKeys?: unknown
}

interface PresetCommandBody {
  baseRevision?: unknown
  preset?: unknown
  patch?: unknown
  presetId?: unknown
  newPresetId?: unknown
  presetIds?: unknown
  apply?: unknown
  saveCurrent?: unknown
  name?: unknown
}

interface ModelPresetCommandBody {
  baseRevision?: unknown
  preset?: unknown
  patch?: unknown
  modelPresetId?: unknown
  modelPresetIds?: unknown
  selectModelPresetId?: unknown
}

interface PromptPresetCommandBody {
  baseRevision?: unknown
  preset?: unknown
  patch?: unknown
  promptPresetId?: unknown
  promptPresetIds?: unknown
  selectPromptPresetId?: unknown
}

interface LegacyBotPresetCommandBody {
  baseRevision?: unknown
  mode?: unknown
}

interface PromptCommandBody {
  baseRevision?: unknown
  promptItem?: unknown
  patch?: unknown
  deleteKeys?: unknown
  itemIds?: unknown
  enabled?: unknown
  promptPresetId?: unknown
}

interface PersonaCommandBody {
  baseRevision?: unknown
  persona?: unknown
  patch?: unknown
  personaId?: unknown
  selectPersonaId?: unknown
  personaIds?: unknown
  mirrorLegacyProfile?: unknown
  saveCurrent?: unknown
}

interface TranslatorPresetCommandBody {
  baseRevision?: unknown
  preset?: unknown
  patch?: unknown
  presetId?: unknown
  selectPresetId?: unknown
  select?: unknown
}

interface LoadoutCommandBody {
  baseRevision?: unknown
  loadout?: unknown
  patch?: unknown
  favorite?: unknown
  lastUsed?: unknown
  characterId?: unknown
}

interface CharacterCommandBody {
  baseRevision?: unknown
  character?: unknown
  initialChat?: unknown
  patch?: unknown
  characterId?: unknown
  characterIds?: unknown
  characterOrder?: unknown
  lastInteraction?: unknown
}

interface ColdStorageRecoveryCommandBody {
  baseRevision?: unknown
  key?: unknown
}

const LEGACY_COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01'
const LEGACY_COLD_STORAGE_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/

function readColdStorageKey(value: unknown): string {
  if (typeof value !== 'string' || !LEGACY_COLD_STORAGE_KEY_RE.test(value)) {
    throw new ValidationError('key must be a valid cold-storage archive key')
  }
  return value
}

async function readColdStorageArchive(dataDir: string, key: string): Promise<unknown> {
  const compressed = await readLegacyStorageValue(dataDir, `coldstorage/${key}`)
  if (!compressed || compressed.length === 0) {
    throw new ValidationError(`Cold-storage archive not found for key: ${key}`)
  }

  try {
    const decompressed = await new Promise<Uint8Array>((resolve, reject) => {
      fflateDecompress(compressed, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    return JSON.parse(Buffer.from(decompressed).toString('utf8')) as unknown
  } catch {
    throw new ValidationError(`Cold-storage archive is corrupt for key: ${key}`)
  }
}

function readRecoveredCharacterArchive(archive: unknown, characterId: string): CharacterRecord {
  const envelope = readJsonObject(archive, 'archive')
  const rawCharacter = readJsonObject(envelope.character, 'archive.character')
  const archiveCharacterId = readCharacterId(rawCharacter.chaId, 'archive.character.chaId')
  if (archiveCharacterId !== characterId) {
    throw new ValidationError(`Cold-storage archive belongs to another character: ${archiveCharacterId}`)
  }
  if (!Array.isArray(rawCharacter.chats)) {
    throw new ValidationError('archive.character.chats must be an array')
  }
  rawCharacter.chats.forEach((rawChat, index) => {
    const chat = readJsonObject(rawChat, `archive.character.chats[${index}]`)
    if (!Array.isArray(chat.message)) {
      throw new ValidationError(`archive.character.chats[${index}].message must be an array`)
    }
  })

  const recovered = repairCharacterCollectionRow(rawCharacter)
  delete recovered.coldstorage
  delete recovered.coldStoragedChats
  for (const chat of ensureCharacterChats(recovered)) {
    ensureChatMessages(chat)
    if (chat.scriptstate !== undefined) {
      chat.scriptstate = readChatScriptstatePatch(chat.scriptstate)
    }
  }
  return recovered
}

function readRecoveredChatArchive(current: ChatRecord, archive: unknown): ChatRecord {
  const isLegacyMessageArray = Array.isArray(archive)
  const envelope = isLegacyMessageArray ? null : readJsonObject(archive, 'archive')
  const hasHypaV3Data = envelope !== null && Object.prototype.hasOwnProperty.call(envelope, 'hypaV3Data')
  const messages = isLegacyMessageArray ? archive : envelope!.message
  if (!Array.isArray(messages)) {
    throw new ValidationError('archive.message must be an array')
  }
  if (envelope?.localLore !== undefined && !Array.isArray(envelope.localLore)) {
    throw new ValidationError('archive.localLore must be an array when provided')
  }

  const recovered = createChatRecord(
    {
      ...current,
      message: messages,
      lastDate: Date.now(),
      ...(envelope
        ? {
            hypaV2Data: envelope.hypaV2Data,
            ...(hasHypaV3Data ? { hypaV3Data: envelope.hypaV3Data } : {}),
            scriptstate: readChatScriptstatePatch(envelope.scriptstate),
            localLore: envelope.localLore ?? [],
          }
        : {}),
    },
    'archive.chat',
  )
  if (!hasHypaV3Data) delete recovered.hypaV3Data
  ensureChatMessages(recovered)
  return recovered
}

interface ChatCommandBody {
  baseRevision?: unknown
  chat?: unknown
  generationSettings?: unknown
  patch?: unknown
  deleteKeys?: unknown
  chatIds?: unknown
  folderByChatId?: unknown
  selectedChatId?: unknown
  select?: unknown
  folder?: unknown
  sourcePatch?: unknown
}

function readInitialCharacterChat(value: unknown): ChatRecord | null {
  if (value === undefined || value === null) return null
  const chat = createChatRecord(value, 'initialChat')
  if (chat.message.length > 0) {
    throw new ValidationError('initialChat.message must be empty; create transcript messages with message commands')
  }
  if (chat.hypaV3Data !== undefined && chat.hypaV3Data !== null) {
    throw new ValidationError('initialChat.hypaV3Data must be empty')
  }
  return chat
}

interface ChatFolderCommandBody {
  baseRevision?: unknown
  folder?: unknown
  patch?: unknown
  folderIds?: unknown
  selectedChatId?: unknown
}

interface MessageCommandBody {
  baseRevision?: unknown
  chatId?: unknown
  message?: unknown
  patch?: unknown
  messages?: unknown
  afterMessageId?: unknown
  generationResult?: unknown
  expectedData?: unknown
  expectedChatId?: unknown
  expectedGenerationId?: unknown
  igpEffect?: unknown
  jobId?: unknown
}

function readIgpMessageEffect(value: unknown): { generationId: string; claimId: string } | undefined {
  if (value === undefined) return undefined
  const effect = readJsonObject(value, 'igpEffect')
  if (Object.keys(effect).some((key) => key !== 'generationId' && key !== 'claimId')) {
    throw new ValidationError('igpEffect supports only generationId and claimId')
  }
  return {
    generationId: readMessageId(effect.generationId, 'igpEffect.generationId'),
    claimId: readMessageId(effect.claimId, 'igpEffect.claimId'),
  }
}

function readOptionalMessageTranslationJobId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new ValidationError('jobId must be a non-empty string of at most 128 characters when provided')
  }
  return value
}

function readGreetingTranslationIndex(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new ValidationError('greetingIndex must be an integer at least -1')
  }
  const greetingIndex = Number(value)
  if (!Number.isSafeInteger(greetingIndex) || greetingIndex < -1) {
    throw new ValidationError('greetingIndex must be an integer at least -1')
  }
  return greetingIndex
}

function readOptionalMessageCondition(value: unknown, label: string, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ValidationError(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'} when provided`)
  }
  return value
}

function pruneChatBookmarkMetadata(
  targetDb: DatabaseSync,
  chat: ChatRecord,
  retainedMessages: ReadonlyArray<{ chatId?: unknown }>,
): void {
  const retainedIds = new Set(
    retainedMessages
      .map((message) => message.chatId)
      .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0),
  )
  const previousBookmarks = Array.isArray(chat.bookmarks) ? chat.bookmarks : undefined
  const previousBookmarkNames =
    chat.bookmarkNames && typeof chat.bookmarkNames === 'object' && !Array.isArray(chat.bookmarkNames)
      ? chat.bookmarkNames
      : undefined
  const bookmarks = previousBookmarks?.filter((messageId) => retainedIds.has(messageId))
  const bookmarkNames = previousBookmarkNames
    ? Object.fromEntries(Object.entries(previousBookmarkNames).filter(([messageId]) => retainedIds.has(messageId)))
    : undefined

  if (isDeepStrictEqual(previousBookmarks, bookmarks) && isDeepStrictEqual(previousBookmarkNames, bookmarkNames)) {
    return
  }
  if (bookmarks === undefined) delete chat.bookmarks
  else chat.bookmarks = bookmarks
  if (bookmarkNames === undefined) delete chat.bookmarkNames
  else chat.bookmarkNames = bookmarkNames
  writeSingleChatRowExact(targetDb, chat.id, chat)
}

interface ScriptDefinitionCommandBody {
  baseRevision?: unknown
  scripts?: unknown
  triggers?: unknown
}

interface ScriptDefinitionMutationCommandBody {
  baseRevision?: unknown
  mutation?: unknown
}

function readScriptDefinitionMutationCommandBody(input: unknown): ScriptDefinitionMutationCommandBody {
  const body = readJsonObject(input, 'body')
  for (const key of Object.keys(body)) {
    if (key !== 'baseRevision' && key !== 'mutation') {
      throw new ValidationError(`body.${key} is not supported for definition mutation commands`)
    }
  }
  return body
}

interface ModuleCommandBody {
  baseRevision?: unknown
  module?: unknown
  patch?: unknown
  moduleId?: unknown
  moduleIds?: unknown
  enabled?: unknown
  folderByModuleId?: unknown
}

interface ModuleFolderCommandBody {
  baseRevision?: unknown
  folder?: unknown
  patch?: unknown
  folderIds?: unknown
}

interface PluginCommandBody {
  baseRevision?: unknown
  plugin?: unknown
  patch?: unknown
  pluginId?: unknown
  pluginIds?: unknown
  provider?: unknown
  enabled?: unknown
}

interface PluginStorageCommandBody {
  baseRevision?: unknown
  value?: unknown
  values?: unknown
  deleteKeys?: unknown
  clear?: unknown
}

interface InlayCatalogCommandBody {
  aliases?: unknown
  assetId?: unknown
  baseRevision?: unknown
  height?: unknown
  name?: unknown
  width?: unknown
}

function readInlayCatalogAssetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError('assetId must be a sha256 hex string')
  }
  return value
}

function readInlayCatalogName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw new ValidationError('name must be a non-empty string no longer than 512 characters')
  }
  return value
}

function readInlayCatalogDimension(value: unknown, label: 'width' | 'height'): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`${label} must be a positive safe integer when provided`)
  }
  return value as number
}

function readInlayCatalogAliases(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new ValidationError('aliases must be an array containing at most 100 strings')
  }
  const aliases = value.map((alias) => {
    if (typeof alias !== 'string' || alias.length === 0 || alias.length > 512) {
      throw new ValidationError('aliases must contain non-empty strings no longer than 512 characters')
    }
    return alias
  })
  return Array.from(new Set(aliases))
}

export const SETTINGS_GROUPS = [
  'providers',
  'runtime',
  'prompt',
  'display',
  'language',
  'media',
  'memory',
  'modules',
  'advanced',
  'sidebar',
  'account',
  'data',
] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]
export const READ_ONLY_SETTINGS_GROUPS = ['agents', 'models'] as const
export const READABLE_SETTINGS_GROUPS = [...SETTINGS_GROUPS, ...READ_ONLY_SETTINGS_GROUPS] as const
export type ReadableSettingsGroup = (typeof READABLE_SETTINGS_GROUPS)[number]
type SettingValueKind = 'boolean' | 'number' | 'string' | 'stringOrNull' | 'object' | 'array' | 'arrayOrNull' | 'json'
const MODEL_PROFILE_SETTINGS_KEYS = [
  'providerCredentials',
  'modelProfiles',
  'modelProfileOrder',
  'modelRoleProfiles',
  'modelRuntimeDefaults',
] as const

export const SETTINGS_GROUP_KEYS: Record<ReadableSettingsGroup, readonly string[]> = {
  providers: [
    'apiType',
    'openAIKey',
    'proxyKey',
    'bias',
    'additionalParams',
    'applyAdditionalParamsToAll',
    'aiModel',
    'subModel',
    'modelRoles',
    'modelProfiles',
    'modelProfileOrder',
    'providerCredentials',
    'modelRoleProfiles',
    'modelRuntimeDefaults',
    'textgenWebUIStreamURL',
    'textgenWebUIBlockingURL',
    'hordeConfig',
    'novelai',
    'claudeAPIKey',
    'openrouterRequestModel',
    'openrouterKey',
    'openrouterMiddleOut',
    'openrouterFallback',
    'openrouterProvider',
    'useInstructPrompt',
    'instructChatTemplate',
    'JinjaTemplate',
    'nanogptKey',
    'nanogptRequestModel',
    'nanogptRequestModelName',
    'nanogptProvider',
    'nanogptSubscriptionState',
    'nanogptUseSubscriptionEndpoint',
    'customProxyRequestModel',
    'customAPIFormat',
    'proxyRequestModel',
    'mancerHeader',
    'reverseProxyOobaMode',
    'reverseProxyOobaArgs',
    'koboldURL',
    'ooba',
    'ainconfig',
    'NAIsettings',
    'NAIadventure',
    'NAIappendName',
    'huggingfaceKey',
    'cohereAPIKey',
    'ollamaURL',
    'ollamaModel',
    'ollamaModelSource',
    'ollamaInputMode',
    'ollamaRequestFormat',
    'ollamaApiKey',
    'ollamaModelName',
    'ollamaCloudModel',
    'ollamaCloudModelName',
    'ollamaThinkingMode',
    'google',
    'mistralKey',
    'claudeAws',
    'claudeCachingExperimental',
    'claude1HourCaching',
    'vertexPrivateKey',
    'vertexClientEmail',
    'vertexAccessToken',
    'vertexAccessTokenExpires',
    'vertexRegion',
    'OaiCompAPIKeys',
    'openAIFlexProcessing',
    'authRefreshes',
    'customModels',
    'dynamicModelRegistry',
    'modelTools',
    'currentPluginProvider',
    'forceReplaceUrl',
    'novellistAPI',
    'customTokenizer',
    'echoMessage',
    'echoDelay',
  ],
  models: MODEL_PROFILE_SETTINGS_KEYS,
  runtime: [
    'halfStreaming',
    'useStreaming',
    'streamGeminiThoughts',
    'maxContext',
    'maxResponse',
    'generationSeed',
    'temperature',
    'frequencyPenalty',
    'PresensePenalty',
    'top_p',
    'top_k',
    'min_p',
    'top_a',
    'repetition_penalty',
    'thinkingType',
    'deepseekThinkingType',
    'thinkingTokens',
    'adaptiveThinkingEffort',
    'deepseekReasoningEffort',
    'reasoningEffort',
    'verbosity',
    'seperateModelsForAxModels',
    'seperateModels',
    'doNotChangeSeperateModels',
    'seperateParametersEnabled',
    'seperateParameters',
    'seperateParametersByModel',
    'disableSeperateParameterChangeOnPresetChange',
    'epEnabled',
    'requestRetrys',
    'genTime',
    'requestLocation',
    'usePlainFetch',
    'antiClaudeOverload',
    'autoContinueChat',
    'autoContinueMinTokens',
    'removeIncompleteResponse',
    'localStopStrings',
    'newOAIHandle',
    'automaticCachePoint',
    'chainOfThought',
    'rememberToolUsage',
    'simplifiedToolUse',
    'useAutoSuggestions',
  ],
  prompt: PROMPT_SETTINGS_KEYS,
  display: [
    'theme',
    'guiHTML',
    'waifuWidth',
    'waifuWidth2',
    'textTheme',
    'customTextTheme',
    'font',
    'customFont',
    'zoomsize',
    'chatScreenWidth',
    'lineHeight',
    'iconsize',
    'textAreaSize',
    'textAreaTextSize',
    'sideBarSize',
    'desktopSidebarColumns',
    'mobileSidebarColumns',
    'assetWidth',
    'animationSpeed',
    'reducedMotion',
    'hypaV3ProgressOpenChatOnly',
    'chatDisplayTailCount',
    'chatLoadInitialPages',
    'chatLoadAdditionalPages',
    'memoryLimitThickness',
    'settingsCloseButtonSize',
    'fullScreen',
    'showMemoryLimit',
    'showFirstMessagePages',
    'hideRealm',
    'hideAllImages',
    'showFolderName',
    'playMessage',
    'playMessageOnTranslateEnd',
    'roundIcons',
    'textScreenColor',
    'textBorder',
    'textScreenRounded',
    'textScreenBorder',
    'showSavingIcon',
    'showPromptComparison',
    'promptDiffPrefs',
    'useChatCopy',
    'useAdditionalAssetsPreview',
    'useLegacyGUI',
    'hideApiKey',
    'unformatQuotes',
    'blockquoteStyling',
    'customQuotes',
    'customQuotesData',
    'menuSideBar',
    'notification',
    'autoTranslateNotificationDeferCapSeconds',
    'paragraphBreakBySentences',
    'paragraphBreakSentenceCount',
    'useChatSticker',
    'customCSS',
    'customGUI',
    'colorScheme',
    'colorSchemeName',
    'customColorScheme',
    'customBackground',
    'classicMaxWidth',
    'heightMode',
  ],
  language: [
    'language',
    'translator',
    'translatorType',
    'translatorInputLanguage',
    'htmlTranslation',
    'combineTranslation',
    'legacyTranslation',
    'translateBeforeHTMLFormatting',
    'translatorSendTextAsIs',
    'translatorExcludeThoughts',
    'translatorHistoryMaxTokens',
    'autoTranslateCachedOnly',
    'useAutoTranslateInput',
    'translatorPrompt',
    'translatorMaxResponse',
    'deeplOptions',
    'deeplXOptions',
    'noWaitForTranslate',
    'showTranslationLoading',
    'useExperimentalGoogleTranslator',
  ],
  media: [
    'sdProvider',
    'webUiUrl',
    'sdSteps',
    'sdCFG',
    'sdConfig',
    'NAIImgUrl',
    'NAIApiKey',
    'NAIImgModel',
    'NAII2I',
    'NAIREF',
    'NAIImgConfig',
    'gptVisionQuality',
    'imageCompression',
    'dynamicAssets',
    'dynamicAssetsEditDisplay',
    'newImageHandlingBeta',
    'legacyMediaFindings',
    'dallEQuality',
    'stabilityModel',
    'stabilityKey',
    'stabllityStyle',
    'comfyConfig',
    'comfyUiUrl',
    'falToken',
    'falModel',
    'falLora',
    'falLoraName',
    'falLoraScale',
    'ImagenModel',
    'ImagenImageSize',
    'ImagenAspectRatio',
    'ImagenPersonGeneration',
    'openaiCompatImage',
    'wavespeedImage',
    'elevenLabKey',
    'voicevoxUrl',
    'fishSpeechKey',
    'ttsAutoSpeech',
    'emotionProcesser',
  ],
  memory: [
    'bardWiki',
    'hypaV3Key',
    'hypaMemoryKey',
    'voyageApiKey',
    'hypaModel',
    'memoryAlgorithmType',
    'supaModelType',
    'hypaMemory',
    'hypav2',
    'hanuraiEnable',
    'legacyMemoryMigrationNoticeDismissed',
    'hypaV3',
    'hypaV3Presets',
    'hypaV3PresetId',
    'selectedHypaV3PresetId',
    'hypaCustomSettings',
    'showMenuHypaMemoryModal',
  ],
  modules: ['enabledModules', 'moduleFolders'],
  agents: ['agents', 'agentPresets', 'agentPresetDefaultId'],
  advanced: [
    'inputHooks',
    'loreBookDepth',
    'loreBookToken',
    'additionalPrompt',
    'descriptionPrefix',
    'emotionPrompt2',
    'enableCustomFlags',
    'customFlags',
    'keiServerURL',
    'presetChain',
    'assetMaxDifference',
    'keepSessionAlive',
    'useSayNothing',
    'showUnrecommended',
    'showGlobalLorebookAndRegex',
    'doNotWarnExternalServers',
    'useExperimental',
    'autofillRequestUrl',
    'allowAllExtentionFiles',
    'coldstorage',
    'enableDevTools',
    'enableScrollToActiveChar',
    'enableLorebookStubs',
    'promptInfoInsideChat',
    'promptTextInfoInsideChat',
    'enableRemoteSaving',
    'realmDirectOpen',
    'returnCSSError',
    'personaNote',
    'globalscript',
    'enableBookmark',
    'useTokenizerCaching',
    'auxModelUnderModelSettings',
    'pluginCompatibilityMode',
    'strictScriptCheck',
    'complexRegexCompatibilityMode',
    'complexRegexInputTimeoutMs',
    'complexRegexOutputTimeoutMs',
    'complexRegexDisplayTimeoutMs',
    'regexOutputSizeLimitMiB',
    'pluginDevelopMode',
    'showDeprecatedTriggerV1',
    'showDeprecatedTriggerV2',
    'checkCorruption',
    'toggleConfirmRecommendedPreset',
    'banCharacterset',
    'bulkEnabling',
    'saveSignatures',
    'inlayErrorResponse',
    'moduleIntergration',
  ],
  sidebar: [
    'askRemoval',
    'swipe',
    'instantRemove',
    'sendWithEnter',
    'fixedChatTextarea',
    'floatingChatInput',
    'clickToEdit',
    'disableAutoPopupMessageEditor',
    'useMonacoEditorOnDesktop',
    'useMonacoEditorOnMobile',
    'enableBlockPartialEdit',
    'longPressToPopupEditor',
    'enableDragPartialEdit',
    'botSettingAtStart',
    'showMenuChatList',
    'goCharacterOnImport',
    'sideMenuRerollButton',
    'requestInfoInsideChat',
    'localActivationInGlobalLorebook',
    'autoScrollToNewMessage',
    'alwaysScrollToNewMessage',
    'newMessageButtonStyle',
    'createFolderOnBranch',
    'hamburgerButtonBottom',
    'hotkeys',
    'enableRisuaiProTools',
    'globalChatVariables',
    'lastLoadedLoadoutName',
    'jailbreakToggle',
    'chatGenerationTogglePresets',
    'customSidebarItems',
  ],
  data: ['requestHistoryLimit'],
  account: ['account', 'didFirstSetup', 'username'],
}

const BOOLEAN_SETTING_KEYS = new Set([
  'applyAdditionalParamsToAll',
  'askRemoval',
  'autoContinueChat',
  'autoScrollToNewMessage',
  'autoTranslateCachedOnly',
  'autofillRequestUrl',
  'automaticCachePoint',
  'blockquoteStyling',
  'botSettingAtStart',
  'bulkEnabling',
  'chainOfThought',
  'checkCorruption',
  'cipherChat',
  'classicMaxWidth',
  'claude1HourCaching',
  'claudeAws',
  'claudeCachingExperimental',
  'clickToEdit',
  'coldstorage',
  'combineTranslation',
  'createFolderOnBranch',
  'customQuotes',
  'disableAutoPopupMessageEditor',
  'useMonacoEditorOnDesktop',
  'useMonacoEditorOnMobile',
  'disableSeperateParameterChangeOnPresetChange',
  'doNotChangeFallbackModels',
  'doNotChangeSeperateModels',
  'doNotWarnExternalServers',
  'dynamicAssets',
  'dynamicAssetsEditDisplay',
  'dynamicModelRegistry',
  'epEnabled',
  'enableBlockPartialEdit',
  'enableBookmark',
  'enableCustomFlags',
  'enableDevTools',
  'enableDragPartialEdit',
  'enableLorebookStubs',
  'enableRemoteSaving',
  'enableRisuaiProTools',
  'enableScrollToActiveChar',
  'fallbackWhenBlankResponse',
  'fixedChatTextarea',
  'floatingChatInput',
  'fullScreen',
  'goCharacterOnImport',
  'hamburgerButtonBottom',
  'hideAllImages',
  'hideApiKey',
  'hideRealm',
  'htmlTranslation',
  'hanuraiEnable',
  'hypaMemory',
  'hypav2',
  'hypaV3',
  'imageCompression',
  'inlayErrorResponse',
  'instantRemove',
  'jailbreakToggle',
  'legacyMediaFindings',
  'legacyMemoryMigrationNoticeDismissed',
  'legacyTranslation',
  'localActivationInGlobalLorebook',
  'longPressToPopupEditor',
  'NAIadventure',
  'NAIappendName',
  'NAII2I',
  'NAIREF',
  'nanogptUseSubscriptionEndpoint',
  'newImageHandlingBeta',
  'newOAIHandle',
  'noWaitForTranslate',
  'openrouterFallback',
  'openrouterMiddleOut',
  'openAIFlexProcessing',
  'useInstructPrompt',
  'outputImageModal',
  'paragraphBreakBySentences',
  'personaNote',
  'playMessage',
  'playMessageOnTranslateEnd',
  'pluginCompatibilityMode',
  'pluginDevelopMode',
  'promptInfoInsideChat',
  'promptTextInfoInsideChat',
  'realmDirectOpen',
  'reducedMotion',
  'hypaV3ProgressOpenChatOnly',
  'rememberToolUsage',
  'removeIncompleteResponse',
  'returnCSSError',
  'roundIcons',
  'saveSignatures',
  'seperateModelsForAxModels',
  'seperateParametersByModel',
  'seperateParametersEnabled',
  'showDeprecatedTriggerV1',
  'showDeprecatedTriggerV2',
  'showFirstMessagePages',
  'showFolderName',
  'showGlobalLorebookAndRegex',
  'showMemoryLimit',
  'showMenuChatList',
  'showMenuHypaMemoryModal',
  'showPromptComparison',
  'showSavingIcon',
  'showTranslationLoading',
  'showUnrecommended',
  'sideMenuRerollButton',
  'simplifiedToolUse',
  'strictJsonSchema',
  'streamGeminiThoughts',
  'strictScriptCheck',
  'swipe',
  'textBorder',
  'textScreenRounded',
  'toggleConfirmRecommendedPreset',
  'translateBeforeHTMLFormatting',
  'translatorSendTextAsIs',
  'translatorExcludeThoughts',
  'ttsAutoSpeech',
  'unformatQuotes',
  'useAdditionalAssetsPreview',
  'useAutoSuggestions',
  'useAutoTranslateInput',
  'useChatCopy',
  'useChatSticker',
  'useExperimental',
  'useExperimentalGoogleTranslator',
  'halfStreaming',
  'useLegacyGUI',
  'usePlainFetch',
  'useSayNothing',
  'useStreaming',
  'useTokenizerCaching',
])

const NUMBER_SETTING_KEYS = new Set([
  'animationSpeed',
  'assetMaxDifference',
  'assetWidth',
  'autoContinueMinTokens',
  'autoTranslateNotificationDeferCapSeconds',
  'chatDisplayTailCount',
  'chatLoadInitialPages',
  'chatLoadAdditionalPages',
  'chatScreenWidth',
  'complexRegexInputTimeoutMs',
  'complexRegexOutputTimeoutMs',
  'complexRegexDisplayTimeoutMs',
  'regexOutputSizeLimitMiB',
  'customAPIFormat',
  'echoDelay',
  'falLoraScale',
  'frequencyPenalty',
  'genTime',
  'generationSeed',
  'iconsize',
  'lineHeight',
  'loreBookDepth',
  'loreBookToken',
  'maxContext',
  'maxResponse',
  'memoryLimitThickness',
  'min_p',
  'ollamaRequestFormat',
  'paragraphBreakSentenceCount',
  'PresensePenalty',
  'reasoningEffort',
  'repetition_penalty',
  'requestRetrys',
  'requestHistoryLimit',
  'sdCFG',
  'sdSteps',
  'settingsCloseButtonSize',
  'sideBarSize',
  'desktopSidebarColumns',
  'mobileSidebarColumns',
  'temperature',
  'textAreaSize',
  'textAreaTextSize',
  'thinkingTokens',
  'top_a',
  'top_k',
  'top_p',
  'translatorMaxResponse',
  'translatorHistoryMaxTokens',
  'verbosity',
  'vertexAccessTokenExpires',
  'waifuWidth',
  'waifuWidth2',
  'zoomsize',
])

const STRING_SETTING_KEYS = new Set([
  'additionalPrompt',
  'adaptiveThinkingEffort',
  'apiType',
  'autoSuggestPrompt',
  'autoSuggestPrefix',
  'claudeAPIKey',
  'cohereAPIKey',
  'complexRegexCompatibilityMode',
  'customBackground',
  'customCSS',
  'customFont',
  'customGUI',
  'customProxyRequestModel',
  'customTokenizer',
  'dallEQuality',
  'deepseekReasoningEffort',
  'deepseekThinkingType',
  'descriptionPrefix',
  'echoMessage',
  'emotionProcesser',
  'emotionPrompt2',
  'falLora',
  'falLoraName',
  'falModel',
  'falToken',
  'fishSpeechKey',
  'font',
  'forceReplaceUrl',
  'gptVisionQuality',
  'guiHTML',
  'heightMode',
  'hordeModel',
  'huggingfaceKey',
  'hypaMemoryKey',
  'hypaModel',
  'memoryAlgorithmType',
  'hypaV3Key',
  'ImagenAspectRatio',
  'ImagenImageSize',
  'ImagenModel',
  'ImagenPersonGeneration',
  'instructChatTemplate',
  'JinjaTemplate',
  'keepSessionAlive',
  'keiServerURL',
  'koboldURL',
  'language',
  'lastLoadedLoadoutName',
  'mancerHeader',
  'mistralKey',
  'nanogptKey',
  'nanogptProvider',
  'nanogptRequestModel',
  'nanogptRequestModelName',
  'nanogptSubscriptionState',
  'NAIApiKey',
  'NAIImgModel',
  'NAIImgUrl',
  'newMessageButtonStyle',
  'novellistAPI',
  'ollamaApiKey',
  'ollamaCloudModel',
  'ollamaCloudModelName',
  'ollamaInputMode',
  'ollamaModel',
  'ollamaModelName',
  'ollamaModelSource',
  'ollamaThinkingMode',
  'openAIKey',
  'openrouterKey',
  'openrouterRequestModel',
  'presetChain',
  'proxyKey',
  'proxyRequestModel',
  'requestLocation',
  'sdProvider',
  'stabllityStyle',
  'stabilityKey',
  'stabilityModel',
  'systemRoleReplacement',
  'supaModelType',
  'textgenWebUIBlockingURL',
  'textgenWebUIStreamURL',
  'textTheme',
  'theme',
  'thinkingType',
  'translator',
  'translatorInputLanguage',
  'translatorPrompt',
  'translatorType',
  'vertexAccessToken',
  'vertexClientEmail',
  'vertexPrivateKey',
  'vertexRegion',
  'voicevoxUrl',
  'voyageApiKey',
  'webUiUrl',
  'username',
])

const ARRAY_SETTING_KEYS = new Set([
  'additionalParams',
  'authRefreshes',
  'banCharacterset',
  'bias',
  'customFlags',
  'customQuotesData',
  'customModels',
  'chatGenerationTogglePresets',
  'customSidebarItems',
  'enabledModules',
  'moduleFolders',
  'globalscript',
  'hotkeys',
  'modelProfiles',
  'modelProfileOrder',
  'providerCredentials',
  'modelTools',
  'hypaV3Presets',
  'inputHooks',
])

const ARRAY_OR_NULL_SETTING_KEYS = new Set(['localStopStrings'])

const STRING_OR_NULL_SETTING_KEYS = new Set(['selectedHypaV3PresetId', 'textScreenBorder', 'textScreenColor'])

const OBJECT_SETTING_KEYS = new Set([
  'account',
  'ainconfig',
  'colorScheme',
  'customColorScheme',
  'comfyConfig',
  'customTextTheme',
  'deeplOptions',
  'deeplXOptions',
  'google',
  'globalChatVariables',
  'hordeConfig',
  'hypaCustomSettings',
  'fallbackModels',
  'modelRuntimeDefaults',
  'modelRoleProfiles',
  'modelRoles',
  'NAIImgConfig',
  'NAIsettings',
  'novelai',
  'OaiCompAPIKeys',
  'ooba',
  'openaiCompatImage',
  'openrouterProvider',
  'reverseProxyOobaArgs',
  'sdConfig',
  'seperateModels',
  'seperateParameters',
  'wavespeedImage',
])

const SPARSE_OBJECT_SETTING_GROUP_BY_KEY = {
  NAIImgConfig: 'media',
  wavespeedImage: 'media',
  seperateParameters: 'runtime',
} as const satisfies Record<string, SettingsGroup>

type SparseObjectSettingKey = keyof typeof SPARSE_OBJECT_SETTING_GROUP_BY_KEY

const SETTINGS_GROUP_KEY_SETS = Object.fromEntries(
  SETTINGS_GROUPS.map((group) => [group, new Set(SETTINGS_GROUP_KEYS[group])]),
) as Record<SettingsGroup, Set<string>>

const ONBOARDING_SETTINGS_KEYS = new Set([
  'textTheme',
  'claudeCachingExperimental',
  'translator',
  'translatorType',
  'useAutoTranslateInput',
  'didFirstSetup',
])

export function registerCommandRoutes(
  app: FastifyInstance,
  db: DatabaseSync,
  authState: AuthState,
  dataDir: string,
  eventSink: CommandEventSink,
  messageTranslationJobs?: MessageTranslationJobRegistry,
  greetingTranslationJobs?: GreetingTranslationJobRegistry,
  bardWikiJobs?: { wakeWorker?: () => void },
): void {
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url
    if (!path.startsWith('/api/v1/commands/') || req.headers[COMMAND_MUTATION_ID_HEADER] === undefined) return
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const receiptKey = readCommandMutationReceiptKey(req)
      if (!receiptKey) return
      const receipt = loadCommandMutationReceipt(db, receiptKey)
      if (!receipt) return
      return reply.send({
        revision: receipt.revision,
        event: receipt.event,
        ...receipt.extra,
      })
    } catch (error) {
      return reply.send(sendCommandError(reply, error))
    }
  })

  // First-run seed: a fresh server starts with `database: null`, which every
  // command path rejects (they require an existing object). The server creates
  // its default database here once before any ordinary command runs. Idempotent
  // and clobber-safe — a no-op when a database already exists, so it can never
  // overwrite real data.
  app.post('/api/v1/commands/state/initialize', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new ValidationError('request body must be an object')
      }
      const body = req.body as { database?: unknown }
      if (Object.prototype.hasOwnProperty.call(body, 'database')) {
        throw new ValidationError('database payload is no longer accepted for state initialization')
      }
      const result = initializeDefaultDatabase(db)
      if (!result.initialized) {
        // Already initialized: report the live revision so the client can sync
        // its cursor; no write happened, so no event is emitted.
        return { revision: result.revision, initialized: false }
      }
      if (!result.event) {
        throw new Error('state initialization did not produce a command event')
      }
      emitCommandEventForRequest(req, eventSink, result.event)
      return { revision: result.revision, initialized: true, event: result.event }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/onboarding', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = readJsonObject(req.body ?? {}, 'body') as OnboardingCommandBody
      const baseRevision = readBaseRevision(body)
      const modelPresetId = readModelPresetId(body.modelPresetId)
      const promptPresetId = readPromptPresetId(body.promptPresetId)
      const requestedModelPatch = readJsonObject(body.modelPatch, 'modelPatch')
      const requestedPromptPatch = readJsonObject(body.promptPatch, 'promptPatch')
      if (Object.keys(requestedModelPatch).length === 0 || Object.keys(requestedPromptPatch).length === 0) {
        throw new ValidationError('onboarding preset patches must not be empty')
      }
      const modelPatch = readModelPresetPatch(requestedModelPatch)
      const promptPatch = readPromptPresetPatch(requestedPromptPatch)
      if (Object.prototype.hasOwnProperty.call(modelPatch, 'id') && modelPatch.id !== modelPresetId) {
        throw new ValidationError('modelPatch.id must match modelPresetId')
      }
      if (Object.prototype.hasOwnProperty.call(promptPatch, 'id') && promptPatch.id !== promptPresetId) {
        throw new ValidationError('promptPatch.id must match promptPresetId')
      }
      const settingsPatch = readOnboardingSettingsPatch(body.settingsPatch)
      validateSettingsAssetRefs(db, settingsPatch)

      const result = applyTargetedCommandMutation<{ modelPresetId: string; promptPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.onboarding,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const modelPresets = ensureModelPresetCollection(target)
          const promptPresets = ensurePromptPresetCollection(target)
          if (selectedModelPresetId(target, modelPresets) !== modelPresetId) {
            throw new ValidationError(`Selected model preset changed before onboarding completed: ${modelPresetId}`)
          }
          if (selectedPromptPresetId(target, promptPresets) !== promptPresetId) {
            throw new ValidationError(`Selected prompt preset changed before onboarding completed: ${promptPresetId}`)
          }

          const modelIndex = requireModelPresetIndex(modelPresets, modelPresetId)
          const promptIndex = requirePromptPresetIndex(promptPresets, promptPresetId)
          const resolvedModelPatch = resolveModelPresetMaskedSecrets(modelPresets[modelIndex], modelPatch)
          modelPresets[modelIndex] = {
            ...modelPresets[modelIndex],
            ...resolvedModelPatch,
            id: modelPresetId,
          }
          promptPresets[promptIndex] = {
            ...promptPresets[promptIndex],
            ...promptPatch,
            id: promptPresetId,
          }
          validatePromptPresetRecommendedModelPreset(
            promptPresets[promptIndex],
            modelPresets,
            `promptPresets.${promptPresetId}`,
          )

          applyModelPreset(target, modelPresets[modelIndex])
          applyPromptPreset(target, promptPresets[promptIndex])
          // Completion is applied only after both owner rows and their selected
          // projections have been constructed successfully. All writes below
          // remain inside applyTargetedCommandMutation's SQLite transaction.
          applySettingsPatch(target, settingsPatch)

          writeSingleCollectionRow(innerDb, 'modelPresets', modelIndex, modelPresets[modelIndex])
          writeSingleCollectionRow(innerDb, 'promptPresets', promptIndex, promptPresets[promptIndex])
          writeSettingsOnly(innerDb, extractSettings(target))

          return {
            event: COMMAND_EVENT_CATALOG.onboardingCompleted,
            extra: { modelPresetId, promptPresetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/mutation-receipts/ack', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const writerSessionId = readActiveWriterSessionId(req)
      if (!writerSessionId) {
        throw new ValidationError('mutation receipt acknowledgement requires a valid risu-writer-session header')
      }
      const acknowledgement = readCommandMutationReceiptAcknowledgement(req.body)
      const acknowledged = acknowledgeCommandMutationReceipts(
        db,
        acknowledgement.databaseLineage,
        acknowledgement.mutationIds,
      )
      return {
        acknowledged,
        requested: acknowledgement.requestCount,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/settings/:group', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const group = readSettingsGroup((req.params as { group?: unknown }).group)
      const body = (req.body ?? {}) as RuntimeSettingsCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = group === 'prompt' ? readPromptSettingsPatch(body.patch) : readSettingsGroupPatch(group, body.patch)
      const requestedPatch = body.patch as Record<string, unknown>
      const writesHypaV3Presets = Object.prototype.hasOwnProperty.call(patch, 'hypaV3Presets')
      const writesSelectedHypaV3PresetId = Object.prototype.hasOwnProperty.call(patch, 'selectedHypaV3PresetId')
      const writesHypaV3PresetId = Object.prototype.hasOwnProperty.call(patch, 'hypaV3PresetId')
      const writesHypaV3Identity = writesHypaV3Presets || writesSelectedHypaV3PresetId || writesHypaV3PresetId
      if (writesHypaV3PresetId && !writesSelectedHypaV3PresetId) {
        throw new ValidationError('hypaV3PresetId is derived and requires selectedHypaV3PresetId in the same patch')
      }
      validateSettingsAssetRefs(db, patch)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        ...(writesHypaV3Identity
          ? { collectionScopedRead: COLLECTION_SCOPED_READS.hypaV3Presets }
          : { settingsScopedRead: true }),
        mutate(database, innerDb) {
          let appliedPatch = patch
          if (writesHypaV3Identity) {
            const target = readJsonObject(database, 'database')
            readStrictHypaV3PresetState(target)
            const proposed = {
              ...target,
              ...(writesHypaV3Presets ? { hypaV3Presets: patch.hypaV3Presets } : {}),
              ...(writesSelectedHypaV3PresetId ? { selectedHypaV3PresetId: patch.selectedHypaV3PresetId } : {}),
            }
            const { selectedId, selectedIndex } = readStrictHypaV3PresetState(proposed, {
              validateNumericProjection: false,
            })
            if (writesHypaV3PresetId && patch.hypaV3PresetId !== selectedIndex) {
              throw new ValidationError('hypaV3PresetId must match the selectedHypaV3PresetId compatibility projection')
            }
            appliedPatch = {
              ...patch,
              selectedHypaV3PresetId: selectedId,
              hypaV3PresetId: selectedIndex,
            }
          }
          applySettingsPatch(database, appliedPatch)
          writeSettingsOnly(innerDb, extractSettings(database as Record<string, unknown>))
          if (Object.prototype.hasOwnProperty.call(patch, 'requestHistoryLimit')) {
            pruneRequestHistory(innerDb, (database as Record<string, unknown>).requestHistoryLimit)
          }
          // The `memory` group's `hypaV3Presets` is a collection field, not a
          // settings scalar, so co-write only that one collection table when the
          // patch carries it; every other settings group is settings-only.
          if (writesHypaV3Presets) {
            writeSingleCollectionTable(
              innerDb,
              'hypaV3Presets',
              (database as Record<string, unknown>).hypaV3Presets as readonly unknown[],
            )
          }
          const target = database as Record<string, unknown>
          const acknowledgedKeys = Object.keys(patch)
          const canonicalSettings = maskProviderSecrets(
            Object.fromEntries(acknowledgedKeys.map((key) => [key, target[key]])),
          )
          const settings = Object.fromEntries(
            acknowledgedKeys
              .filter((key) => !isDeepStrictEqual(canonicalSettings[key], requestedPatch[key]))
              .map((key) => [key, canonicalSettings[key]]),
          )
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.settingsUpdated,
              ...(writesHypaV3Presets ? { resource: SETTINGS_WITH_HYPA_V3_PRESETS_RESOURCE } : {}),
              id: group,
            },
            extra: {
              // Name every accepted key, but return values only when storage
              // normalization or secret masking changed what the client sent.
              // The client already holds verbatim accepted values and can
              // reconstruct the canonical patch without echoing large data.
              acknowledgedKeys,
              settings,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/settings/:group/objects/:key', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { group?: unknown; key?: unknown }
      const group = readSettingsGroup(params.group)
      const key = readSparseObjectSettingKey(group, params.key)
      const body = readJsonObject(req.body ?? {}, 'body') as SparseObjectSettingsCommandBody
      const baseRevision = readBaseRevision(body)
      const update = readSparseObjectSettingUpdate(body)
      const result = applyTargetedCommandMutation<{
        group: SettingsGroup
        key: string
        certificate?: string
        patchedKeys?: string[]
        deletedKeys?: string[]
        canonicalValues?: Record<string, unknown>
        canonicalDeletedKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        settingsScopedRead: true,
        mutate(database, innerDb) {
          const target = database as Record<string, unknown>
          const current = isPlainObject(target[key]) ? target[key] : {}
          const requested = { ...current, ...update.patch }
          for (const deletedKey of update.deleteKeys) delete requested[deletedKey]

          const resolved = resolveMaskedProviderSecretPlaceholders(database, { [key]: requested })
          const sanitized = readSettingsGroupPatch(group, resolved)
          validateSettingsAssetRefs(db, sanitized)
          const resolvedRequested = sanitized[key] as Record<string, unknown>
          const clientAttempted = maskSparseObjectSettingForReceipt(key, resolvedRequested)
          for (const [field, value] of Object.entries(update.patch)) clientAttempted[field] = value
          for (const deletedKey of update.deleteKeys) delete clientAttempted[deletedKey]

          applySettingsPatch(database, sanitized)
          writeSettingsOnly(innerDb, extractSettings(target))

          const canonical = maskSparseObjectSettingForReceipt(key, target[key])
          const receipt = compactSparseObjectSettingReceipt({
            requested: clientAttempted,
            canonical,
            requestedKeys: new Set([...Object.keys(update.patch), ...update.deleteKeys]),
          })
          return {
            event: { ...COMMAND_EVENT_CATALOG.settingsUpdated, id: group },
            extra: {
              group,
              key,
              ...(receipt
                ? {
                    certificate: 'settings-object-patch-v1',
                    patchedKeys: Object.keys(update.patch).sort(),
                    deletedKeys: [...update.deleteKeys].sort(),
                    canonicalValues: receipt.canonicalValues,
                    canonicalDeletedKeys: receipt.canonicalDeletedKeys,
                  }
                : {}),
            },
          }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/settings/advanced/global-scripts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = readScriptDefinitionMutationCommandBody(req.body ?? {})
      const baseRevision = readBaseRevision(body)
      const mutation = readDefinitionCollectionMutation(body.mutation)
      const result = applyTargetedCommandMutation<{
        group: 'advanced'
        key: 'globalscript'
        certificate: 'global-script-mutation-v1'
        operation: typeof mutation.op
        globalScriptsDigest: string
        acknowledgedKeys: ['globalscript']
        settings: Record<string, never>
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        settingsScopedRead: true,
        mutate(database, innerDb) {
          const target = database as Record<string, unknown>
          const scripts = applyScriptDefinitionCollectionMutation(target.globalscript, mutation, 'globalscript')
          validateSettingsAssetRefs(db, { globalscript: scripts })
          target.globalscript = scripts
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.settingsUpdated, id: 'advanced' },
            extra: {
              group: 'advanced',
              key: 'globalscript',
              certificate: 'global-script-mutation-v1',
              operation: mutation.op,
              globalScriptsDigest: scriptDefinitionCollectionDigest(scripts),
              acknowledgedKeys: ['globalscript'],
              settings: {},
            },
          }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-profiles', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = createModelProfileCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/provider-credentials', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = createProviderCredentialCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/provider-credentials/:credentialId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = updateProviderCredentialCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        credentialId: (req.params as { credentialId?: unknown }).credentialId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/provider-credentials/:credentialId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = deleteProviderCredentialCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        credentialId: (req.params as { credentialId?: unknown }).credentialId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-profiles/create-and-bind', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = createAndBindModelProfileCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-profiles/convert-legacy', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = convertLegacyModelProfilesCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-profiles/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = reorderModelProfilesCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/model-profiles/:profileId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = updateModelProfileCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        profileId: (req.params as { profileId?: unknown }).profileId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-profiles/:profileId/duplicate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = duplicateModelProfileCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        profileId: (req.params as { profileId?: unknown }).profileId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/model-profiles/:profileId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = deleteModelProfileCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        profileId: (req.params as { profileId?: unknown }).profileId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/model-role-profiles', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = updateModelRoleProfilesCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/model-runtime-defaults', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = updateModelRuntimeDefaultsCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agents', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const body = req.body ?? {}
      const result = createAgentCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/agents/:agentId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const body = req.body ?? {}
      const result = updateAgentCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        agentId: (req.params as { agentId?: unknown }).agentId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/agents/:agentId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const body = req.body ?? {}
      const result = deleteAgentCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        agentId: (req.params as { agentId?: unknown }).agentId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agents/:agentId/duplicate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const body = req.body ?? {}
      const result = duplicateAgentCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        agentId: (req.params as { agentId?: unknown }).agentId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agents/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return
    try {
      const body = req.body ?? {}
      const result = reorderAgentsCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = createAgentPresetCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/agent-presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = updateAgentPresetCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/agent-presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = deleteAgentPresetCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/:presetId/duplicate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = duplicateAgentPresetCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = reorderAgentPresetsCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/default', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = setAgentPresetDefaultCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/:presetId/uses', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const result = createAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/agent-presets/:presetId/uses/:useId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const params = req.params as { presetId?: unknown; useId?: unknown }
      const result = updateAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        presetId: params.presetId as string,
        stepId: params.useId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/agent-presets/:presetId/uses/:useId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const params = req.params as { presetId?: unknown; useId?: unknown }
      const result = deleteAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        presetId: params.presetId as string,
        stepId: params.useId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/:presetId/uses/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const result = reorderAgentPresetStepsCommand({
        db,
        dataDir,
        baseRevision: readBaseRevision(body),
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  // Retained compatibility endpoints for clients that still call preset uses "steps".
  app.post('/api/v1/commands/agent-presets/:presetId/steps', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = createAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/agent-presets/:presetId/steps/:stepId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const params = req.params as { presetId?: unknown; stepId?: unknown }
      const result = updateAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: params.presetId as string,
        stepId: params.stepId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/agent-presets/:presetId/steps/:stepId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const params = req.params as { presetId?: unknown; stepId?: unknown }
      const result = deleteAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: params.presetId as string,
        stepId: params.stepId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/:presetId/steps/:stepId/duplicate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const params = req.params as { presetId?: unknown; stepId?: unknown }
      const result = duplicateAgentPresetStepCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: params.presetId as string,
        stepId: params.stepId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/agent-presets/:presetId/steps/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = req.body ?? {}
      const baseRevision = readBaseRevision(body)
      const result = reorderAgentPresetStepsCommand({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        body,
        presetId: (req.params as { presetId?: unknown }).presetId as string,
      })
      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/presets', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createPresetRecord(readJsonObject(body.preset, 'preset'), 'New Preset', {
        assetDb: db,
      })
      const result = applyTargetedCommandMutation<{ presetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = readStrictLegacyPresetCollection(target, { allowEmptyPendingFirstRecord: true })
          if (findPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate preset id: ${preset.id}`)
          }
          presets.push(preset)
          // Append does not move the selected pointer, so the one collection
          // table is the only write.
          writeSingleCollectionTable(innerDb, 'botPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.presetCreated, id: preset.id },
            extra: { presetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readPresetId((req.params as { presetId?: unknown }).presetId)
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const requestedPatch = readJsonObject(body.patch, 'patch')
      if (Object.prototype.hasOwnProperty.call(requestedPatch, 'id') && requestedPatch.id !== presetId) {
        throw new ValidationError('patch.id must match presetId')
      }
      const result = applyTargetedCommandMutation<{
        presetId: string
        acknowledgedKeys: string[]
        canonicalValues: Record<string, unknown>
        canonicalDeletedKeys: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = readStrictLegacyPresetCollection(target)
          const index = requirePresetIndex(presets, presetId)
          const patch = readPresetPatch(resolveMaskedLegacyPresetPatch(presets[index], requestedPatch, presetId), {
            assetDb: db,
          })
          const optimisticPreset = {
            ...presets[index],
            ...requestedPatch,
            id: presetId,
          }
          presets[index] = {
            ...presets[index],
            ...patch,
            id: presetId,
          }
          if (Object.prototype.hasOwnProperty.call(patch, 'agentPresets')) {
            normalizePresetAgentSettings(presets[index])
          }
          writeSingleCollectionRow(innerDb, 'botPresets', index, presets[index])
          const receipt = compactCanonicalPresetReceipt(presets[index], optimisticPreset)
          return {
            event: { ...COMMAND_EVENT_CATALOG.presetUpdated, id: presetId },
            extra: {
              presetId,
              acknowledgedKeys: Object.keys(requestedPatch),
              ...receipt,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readPresetId((req.params as { presetId?: unknown }).presetId)
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const selectPresetId = body.presetId === undefined ? undefined : readPresetId(body.presetId, 'presetId')
      const apply = readOptionalBoolean(body.apply, 'apply', false)
      const saveCurrent = readOptionalBoolean(body.saveCurrent, 'saveCurrent', false)
      const result = applyTargetedCommandMutation<{
        presetId: string
        selectedPresetId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = readStrictLegacyPresetCollection(target)
          if (presets.length <= 1) {
            throw new ValidationError('Cannot delete the only preset')
          }
          const beforeSelected = target.botPresetsId
          const currentSelectedId = selectedPresetId(target, presets)
          if (saveCurrent) {
            saveCurrentPresetSnapshot(target, presets)
          }
          const deletedIndex = requirePresetIndex(presets, presetId)
          const deletedWasSelected = currentSelectedId === presetId
          presets.splice(deletedIndex, 1)

          let nextSelectedId = selectPresetId
          if (!nextSelectedId && deletedWasSelected) {
            nextSelectedId = presets[0]?.id
          } else if (!nextSelectedId) {
            nextSelectedId = currentSelectedId ?? presets[0]?.id
          }

          const selectedIndex = nextSelectedId ? requirePresetIndex(presets, nextSelectedId) : -1
          target.botPresetsId = selectedIndex
          let applied = false
          if (apply && selectedIndex >= 0) {
            applyPreset(target, presets[selectedIndex])
            applied = true
          }

          // The splice shifts positions, so the preset table is always rewritten.
          writeSingleCollectionTable(innerDb, 'botPresets', presets)
          if (applied || target.botPresetsId !== beforeSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          const pointerChanged = target.botPresetsId !== beforeSelected

          return {
            event: {
              ...COMMAND_EVENT_CATALOG.presetDeleted,
              ...(!applied
                ? {
                    resource: pointerChanged ? PRESET_COLLECTION_WITH_POINTER_RESOURCE : 'presetCollection',
                  }
                : {}),
              id: presetId,
              ...(saveCurrent && currentSelectedId && currentSelectedId !== presetId
                ? { parentId: currentSelectedId }
                : {}),
            },
            extra: {
              presetId,
              selectedPresetId: selectedIndex >= 0 ? presets[selectedIndex].id : null,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/presets/:presetId/copy', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readPresetId((req.params as { presetId?: unknown }).presetId)
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const newPresetId = readPresetId(body.newPresetId, 'newPresetId')
      const name = readOptionalString(body.name, 'name')
      const saveCurrent = readOptionalBoolean(body.saveCurrent, 'saveCurrent', false)
      const result = applyTargetedCommandMutation<{ presetId: string; sourcePresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = readStrictLegacyPresetCollection(target)
          const savedPresetId = saveCurrent ? selectedPresetId(target, presets) : null
          if (saveCurrent) {
            saveCurrentPresetSnapshot(target, presets)
          }
          const index = requirePresetIndex(presets, presetId)
          if (findPresetIndex(presets, newPresetId) !== -1) {
            throw new ValidationError(`Duplicate preset id: ${newPresetId}`)
          }
          const copy = {
            ...presets[index],
            id: newPresetId,
            name: name ?? `${presets[index].name ?? 'Preset'} Copy`,
          }
          presets.push(copy)
          // Copy (and the optional save-current snapshot) only touches the
          // preset collection; the selected pointer is unchanged.
          writeSingleCollectionTable(innerDb, 'botPresets', presets)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.presetCopied,
              id: copy.id,
              ...(savedPresetId ? { parentId: savedPresetId } : {}),
            },
            extra: { presetId: copy.id, sourcePresetId: presetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/presets/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const presetId = readPresetId(body.presetId, 'presetId')
      const apply = readOptionalBoolean(body.apply, 'apply', true)
      const saveCurrent = readOptionalBoolean(body.saveCurrent, 'saveCurrent', true)
      const result = applyTargetedCommandMutation<{ presetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = readStrictLegacyPresetCollection(target, { allowInvalidSelectedPointer: true })
          const beforeSelected = target.botPresetsId
          const previousSelectedId = selectedPresetId(target, presets)
          if (saveCurrent) {
            saveCurrentPresetSnapshot(target, presets)
          }
          const index = requirePresetIndex(presets, presetId)
          target.botPresetsId = index
          let applied = false
          if (apply) {
            applyPreset(target, presets[index])
            applied = true
          }
          // The preset table is rewritten only when save-current snapshotted the
          // outgoing preset into it; the pointer + applied scalars live in settings.
          if (saveCurrent) {
            writeSingleCollectionTable(innerDb, 'botPresets', presets)
          }
          if (applied || target.botPresetsId !== beforeSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          const pointerChanged = target.botPresetsId !== beforeSelected
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.presetSelected,
              ...(!applied
                ? {
                    resource: saveCurrent
                      ? pointerChanged
                        ? PRESET_COLLECTION_WITH_POINTER_RESOURCE
                        : 'presetCollection'
                      : pointerChanged
                        ? PRESET_POINTER_RESOURCE
                        : REVISION_ONLY_RESOURCE,
                  }
                : {}),
              id: presetId,
              ...(saveCurrent && previousSelectedId ? { parentId: previousSelectedId } : {}),
            },
            extra: { presetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/presets/import', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createPresetRecord(readJsonObject(body.preset, 'preset'), 'Imported', {
        assetDb: db,
      })
      const result = applyTargetedCommandMutation<{ presetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const presets = ensurePresetCollection(target)
          if (findPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate preset id: ${preset.id}`)
          }
          presets.push(preset)
          writeSingleCollectionTable(innerDb, 'botPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.presetImported, id: preset.id },
            extra: { presetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/presets/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PresetCommandBody
      const baseRevision = readBaseRevision(body)
      if (!Array.isArray(body.presetIds)) {
        throw new ValidationError('presetIds must be an array')
      }
      const presetIds = body.presetIds
      const result = applyTargetedCommandMutation<{ selectedPresetId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.presets,
        mutate(database, innerDb) {
          const target = ensureDatabaseObject(database)
          const rawPresets = cloneJsonForCommandCertificate(target.botPresets)
          const rawSelected = target.botPresetsId
          const presets = readStrictLegacyPresetCollection(target)
          const acknowledgementSafe =
            Array.isArray(rawPresets) && isDeepStrictEqual(rawPresets, presets) && rawSelected === target.botPresetsId
          const beforeSelected = target.botPresetsId
          const currentSelectedId = selectedPresetId(target, presets)
          validateFullPresetIdList(presets, presetIds)
          const byId = new Map(presets.map((preset) => [preset.id, preset]))
          const reordered = presetIds.map((id) => byId.get(id)!)
          target.botPresets = reordered
          target.botPresetsId = currentSelectedId
            ? requirePresetIndex(reordered, currentSelectedId)
            : reordered.length > 0
              ? 0
              : -1
          writeSingleCollectionTable(innerDb, 'botPresets', reordered)
          const settingsWritten = target.botPresetsId !== beforeSelected
          // `botPresetsId` is a settings scalar; co-write settings only when the
          // reorder moved the selected preset to a new index.
          if (settingsWritten) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.presetReordered,
              ...(settingsWritten ? { resource: PRESET_COLLECTION_WITH_POINTER_RESOURCE } : {}),
            },
            extra: {
              selectedPresetId: selectedPresetId(target, reordered),
              ...buildPresetReorderAcknowledgement(
                'legacy',
                reordered.map((preset) => preset.id),
                settingsWritten,
                acknowledgementSafe,
              ),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-presets', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createModelPresetRecord(readJsonObject(body.preset, 'preset'), 'New Model Preset')
      const result = applyTargetedCommandMutation<{ modelPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modelPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictModelPresetCollection(target)
          if (findModelPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate model preset id: ${preset.id}`)
          }
          presets.push(resolveModelPresetMaskedSecrets(undefined, preset) as typeof preset)
          writeSingleCollectionTable(innerDb, 'modelPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.modelPresetCreated, id: preset.id },
            extra: { modelPresetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/model-presets/:modelPresetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const modelPresetId = readModelPresetId((req.params as { modelPresetId?: unknown }).modelPresetId)
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const requestedPatch = readJsonObject(body.patch, 'patch')
      const patch = readModelPresetPatch(requestedPatch)
      if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== modelPresetId) {
        throw new ValidationError('patch.id must match modelPresetId')
      }
      const result = applyTargetedCommandMutation<{ modelPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modelPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictModelPresetCollection(target)
          const index = requireModelPresetIndex(presets, modelPresetId)
          const projectionKeys = splitPresetSettingsProjectionKeys('model', patch)
          const selectedProjectionCandidate = target.modelPresetsId === index && projectionKeys.length > 0
          const optimisticPreset = {
            ...presets[index],
            ...requestedPatch,
            id: modelPresetId,
          }
          const optimisticTarget = { ...target }
          if (selectedProjectionCandidate) {
            applyModelPreset(optimisticTarget, optimisticPreset)
            applySelectedPromptPresetAfterModelPreset(optimisticTarget)
          }
          const resolvedPatch = resolveModelPresetMaskedSecrets(presets[index], patch)
          presets[index] = {
            ...presets[index],
            ...resolvedPatch,
            id: modelPresetId,
          }
          const canonicalTarget = { ...target }
          if (selectedProjectionCandidate) {
            applyModelPreset(canonicalTarget, presets[index])
            applySelectedPromptPresetAfterModelPreset(canonicalTarget)
          }
          const selectedProjectionApplied =
            selectedProjectionCandidate && hasSplitPresetProjectionChange(target, canonicalTarget, projectionKeys)
          const selectedPromptPreset = selectedProjectionApplied
            ? selectedPromptPresetId(target, readStrictPromptPresetCollection(target))
            : null
          writeSingleCollectionRow(innerDb, 'modelPresets', index, presets[index])
          if (selectedProjectionApplied) {
            applyModelPreset(target, presets[index])
            applySelectedPromptPresetAfterModelPreset(target)
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          const acknowledgedKeys = Object.keys(patch)
          return {
            event: { ...COMMAND_EVENT_CATALOG.modelPresetUpdated, id: modelPresetId },
            extra: {
              modelPresetId,
              acknowledgedKeys,
              preset: compactCanonicalOverrides(presets[index], requestedPatch, acknowledgedKeys),
              settings: selectedProjectionApplied
                ? compactCanonicalOverrides(target, optimisticTarget, projectionKeys)
                : {},
              selectedProjectionApplied,
              ownerProjectionApplied: false,
              selectedPromptPresetId: selectedPromptPreset,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/model-presets/:modelPresetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const modelPresetId = readModelPresetId((req.params as { modelPresetId?: unknown }).modelPresetId)
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const selectModelPresetId =
        body.modelPresetId === undefined ? undefined : readModelPresetId(body.modelPresetId, 'modelPresetId')
      const result = applyTargetedCommandMutation<{
        modelPresetId: string
        selectedModelPresetId: string | null
        cascadedChatCount: number
        cascadedLoadoutCount: number
        clearedPromptRecommendationCount: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictModelPresetCollection(target)
          const promptPresets = readStrictPromptPresetCollection(target)
          const deletedIndex = findModelPresetIndex(presets, modelPresetId)
          if (deletedIndex === -1) {
            const selectedId = selectedModelPresetId(target, presets)
            const replacementId = selectModelPresetId ?? selectedId
            const replacementPreset = replacementId
              ? (presets.find((preset) => preset.id === replacementId) ?? null)
              : null
            const cascade = rehomeGenerationReferences(target, 'modelPreset', modelPresetId, replacementPreset)
            const clearedPromptRecommendationCount = clearPromptPresetRecommendedModelPresetReferences(
              promptPresets,
              modelPresetId,
            )
            writeGenerationReferenceCascade(innerDb, target, cascade)
            if (clearedPromptRecommendationCount > 0) {
              writeSingleCollectionTable(innerDb, 'promptPresets', promptPresets)
            }
            return {
              event: { ...COMMAND_EVENT_CATALOG.modelPresetDeleted, id: modelPresetId },
              extra: {
                modelPresetId,
                selectedModelPresetId: selectedId,
                cascadedChatCount: cascade.changedChatCount,
                cascadedLoadoutCount: cascade.changedLoadoutCount,
                clearedPromptRecommendationCount,
              },
            }
          }
          if (presets.length <= 1) {
            throw new ValidationError('Cannot delete the only model preset')
          }
          const beforeSelected = target.modelPresetsId
          const currentSelectedId = selectedModelPresetId(target, presets)
          const deletedWasSelected = currentSelectedId === modelPresetId
          presets.splice(deletedIndex, 1)
          const nextSelectedId =
            selectModelPresetId ?? (deletedWasSelected ? presets[0]?.id : (currentSelectedId ?? presets[0]?.id))
          const nextSelectedIndex = nextSelectedId ? requireModelPresetIndex(presets, nextSelectedId) : -1
          target.modelPresetsId = nextSelectedIndex
          if (nextSelectedIndex >= 0) {
            applyModelPreset(target, presets[nextSelectedIndex])
            applySelectedPromptPresetAfterModelPreset(target)
          }
          const cascade = rehomeGenerationReferences(
            target,
            'modelPreset',
            modelPresetId,
            nextSelectedIndex >= 0 ? presets[nextSelectedIndex] : null,
          )
          const clearedPromptRecommendationCount = clearPromptPresetRecommendedModelPresetReferences(
            promptPresets,
            modelPresetId,
          )
          writeSingleCollectionTable(innerDb, 'modelPresets', presets)
          if (clearedPromptRecommendationCount > 0) {
            writeSingleCollectionTable(innerDb, 'promptPresets', promptPresets)
          }
          if (target.modelPresetsId !== beforeSelected || deletedWasSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          writeGenerationReferenceCascade(innerDb, target, cascade)
          return {
            event: { ...COMMAND_EVENT_CATALOG.modelPresetDeleted, id: modelPresetId },
            extra: {
              modelPresetId,
              selectedModelPresetId: selectedModelPresetId(target, presets),
              cascadedChatCount: cascade.changedChatCount,
              cascadedLoadoutCount: cascade.changedLoadoutCount,
              clearedPromptRecommendationCount,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-presets/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const modelPresetId = readModelPresetId(body.modelPresetId, 'modelPresetId')
      const result = applyTargetedCommandMutation<{ modelPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modelPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictModelPresetCollection(target)
          const beforeSelected = target.modelPresetsId
          const nextSelectedIndex = requireModelPresetIndex(presets, modelPresetId)
          target.modelPresetsId = nextSelectedIndex
          applyModelPreset(target, presets[nextSelectedIndex])
          applySelectedPromptPresetAfterModelPreset(target)
          if (target.modelPresetsId !== beforeSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.modelPresetSelected, id: modelPresetId },
            extra: { modelPresetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-presets/import', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createModelPresetRecord(readJsonObject(body.preset, 'preset'), 'Imported Model')
      const result = applyTargetedCommandMutation<{ modelPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modelPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = ensureModelPresetCollection(target)
          if (findModelPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate model preset id: ${preset.id}`)
          }
          presets.push(resolveModelPresetMaskedSecrets(undefined, preset) as typeof preset)
          writeSingleCollectionTable(innerDb, 'modelPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.modelPresetImported, id: preset.id },
            extra: { modelPresetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/model-presets/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModelPresetCommandBody
      const baseRevision = readBaseRevision(body)
      if (!Array.isArray(body.modelPresetIds)) {
        throw new ValidationError('modelPresetIds must be an array')
      }
      const modelPresetIds = body.modelPresetIds
      const result = applyTargetedCommandMutation<{ selectedModelPresetId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modelPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const rawPresets = cloneJsonForCommandCertificate(target.modelPresets)
          const rawSelected = target.modelPresetsId
          const presets = readStrictModelPresetCollection(target)
          const acknowledgementSafe =
            Array.isArray(rawPresets) && isDeepStrictEqual(rawPresets, presets) && rawSelected === target.modelPresetsId
          const beforeSelected = target.modelPresetsId
          const currentSelectedId = selectedModelPresetId(target, presets)
          validateFullModelPresetIdList(presets, modelPresetIds)
          const byId = new Map(presets.map((preset) => [preset.id, preset]))
          const reordered = modelPresetIds.map((id) => byId.get(id as string)!)
          target.modelPresets = reordered
          target.modelPresetsId = currentSelectedId
            ? requireModelPresetIndex(reordered, currentSelectedId)
            : reordered.length > 0
              ? 0
              : -1
          writeSingleCollectionTable(innerDb, 'modelPresets', reordered)
          const settingsWritten = target.modelPresetsId !== beforeSelected
          if (settingsWritten) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: COMMAND_EVENT_CATALOG.modelPresetReordered,
            extra: {
              selectedModelPresetId: selectedModelPresetId(target, reordered),
              ...buildPresetReorderAcknowledgement(
                'model',
                reordered.map((preset) => preset.id),
                settingsWritten,
                acknowledgementSafe,
              ),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-presets', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createPromptPresetRecord(readJsonObject(body.preset, 'preset'), 'New Prompt Preset')
      const result = applyTargetedCommandMutation<{ promptPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: Object.prototype.hasOwnProperty.call(preset, 'recommendedModelPresetId')
          ? COLLECTION_SCOPED_READS.promptPresetsWithModels
          : COLLECTION_SCOPED_READS.promptPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictPromptPresetCollection(target)
          if (findPromptPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate prompt preset id: ${preset.id}`)
          }
          if (Object.prototype.hasOwnProperty.call(preset, 'recommendedModelPresetId')) {
            validatePromptPresetRecommendedModelPreset(preset, readStrictModelPresetCollection(target))
          }
          presets.push(preset)
          writeSingleCollectionTable(innerDb, 'promptPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.promptPresetCreated, id: preset.id },
            extra: { promptPresetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/prompt-presets/:promptPresetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const promptPresetId = readPromptPresetId((req.params as { promptPresetId?: unknown }).promptPresetId)
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const requestedPatch = readJsonObject(body.patch, 'patch')
      const patch = readPromptPresetPatch(requestedPatch)
      if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== promptPresetId) {
        throw new ValidationError('patch.id must match promptPresetId')
      }
      const result = applyTargetedCommandMutation<{ promptPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: Object.prototype.hasOwnProperty.call(patch, 'recommendedModelPresetId')
          ? COLLECTION_SCOPED_READS.promptPresetsWithModels
          : COLLECTION_SCOPED_READS.promptPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictPromptPresetCollection(target)
          const index = requirePromptPresetIndex(presets, promptPresetId)
          const projectionKeys = splitPresetSettingsProjectionKeys('prompt', patch)
          const selected = target.promptPresetsId === index
          const selectedProjectionCandidate = selected && projectionKeys.length > 0
          const touchesPromptTemplate = Object.prototype.hasOwnProperty.call(patch, 'promptTemplate')
          const optimisticPreset = {
            ...presets[index],
            ...requestedPatch,
            id: promptPresetId,
          }
          const optimisticTarget = { ...target }
          if (selected && (selectedProjectionCandidate || touchesPromptTemplate)) {
            applyPromptPreset(optimisticTarget, optimisticPreset)
          }
          const nextPreset = {
            ...presets[index],
            ...patch,
            id: promptPresetId,
          }
          if (Object.prototype.hasOwnProperty.call(patch, 'recommendedModelPresetId')) {
            validatePromptPresetRecommendedModelPreset(nextPreset, readStrictModelPresetCollection(target))
          }
          presets[index] = nextPreset
          const canonicalTarget = { ...target }
          if (selected && (selectedProjectionCandidate || touchesPromptTemplate)) {
            applyPromptPreset(canonicalTarget, presets[index])
          }
          const selectedProjectionApplied =
            selectedProjectionCandidate && hasSplitPresetProjectionChange(target, canonicalTarget, projectionKeys)
          writeSingleCollectionRow(innerDb, 'promptPresets', index, presets[index])
          if (selected && (selectedProjectionApplied || touchesPromptTemplate)) {
            applyPromptPreset(target, presets[index])
          }
          if (selectedProjectionApplied) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          const acknowledgedKeys = Object.keys(patch)
          const ownerProjectionApplied =
            selected && touchesPromptTemplate && promptPresetAppliesPromptTemplate(presets[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.promptPresetUpdated, id: promptPresetId },
            extra: {
              promptPresetId,
              acknowledgedKeys,
              preset: compactCanonicalOverrides(presets[index], requestedPatch, acknowledgedKeys),
              settings: selectedProjectionApplied
                ? compactCanonicalOverrides(target, optimisticTarget, projectionKeys)
                : {},
              selectedProjectionApplied,
              ownerProjectionApplied,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/prompt-presets/:promptPresetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const promptPresetId = readPromptPresetId((req.params as { promptPresetId?: unknown }).promptPresetId)
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const selectPromptPresetId =
        body.promptPresetId === undefined ? undefined : readPromptPresetId(body.promptPresetId, 'promptPresetId')
      const result = applyTargetedCommandMutation<{
        promptPresetId: string
        selectedPromptPresetId: string | null
        cascadedChatCount: number
        cascadedLoadoutCount: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictPromptPresetCollection(target)
          const deletedIndex = findPromptPresetIndex(presets, promptPresetId)
          if (deletedIndex === -1) {
            const selectedId = selectedPromptPresetId(target, presets)
            const replacementId = selectPromptPresetId ?? selectedId
            const replacementPreset = replacementId
              ? (presets.find((preset) => preset.id === replacementId) ?? null)
              : null
            const cascade = rehomeGenerationReferences(target, 'promptPreset', promptPresetId, replacementPreset)
            writeGenerationReferenceCascade(innerDb, target, cascade)
            return {
              event: { ...COMMAND_EVENT_CATALOG.promptPresetDeleted, id: promptPresetId },
              extra: {
                promptPresetId,
                selectedPromptPresetId: selectedId,
                cascadedChatCount: cascade.changedChatCount,
                cascadedLoadoutCount: cascade.changedLoadoutCount,
              },
            }
          }
          if (presets.length <= 1) {
            throw new ValidationError('Cannot delete the only prompt preset')
          }
          const beforeSelected = target.promptPresetsId
          const currentSelectedId = selectedPromptPresetId(target, presets)
          const deletedWasSelected = currentSelectedId === promptPresetId
          presets.splice(deletedIndex, 1)
          const nextSelectedId =
            selectPromptPresetId ?? (deletedWasSelected ? presets[0]?.id : (currentSelectedId ?? presets[0]?.id))
          const nextSelectedIndex = nextSelectedId ? requirePromptPresetIndex(presets, nextSelectedId) : -1
          target.promptPresetsId = nextSelectedIndex
          if (nextSelectedIndex >= 0) {
            applyPromptPreset(target, presets[nextSelectedIndex])
          }
          const cascade = rehomeGenerationReferences(
            target,
            'promptPreset',
            promptPresetId,
            nextSelectedIndex >= 0 ? presets[nextSelectedIndex] : null,
          )
          writeSingleCollectionTable(innerDb, 'promptPresets', presets)
          if (target.promptPresetsId !== beforeSelected || deletedWasSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          writeGenerationReferenceCascade(innerDb, target, cascade)
          return {
            event: { ...COMMAND_EVENT_CATALOG.promptPresetDeleted, id: promptPresetId },
            extra: {
              promptPresetId,
              selectedPromptPresetId: selectedPromptPresetId(target, presets),
              cascadedChatCount: cascade.changedChatCount,
              cascadedLoadoutCount: cascade.changedLoadoutCount,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-presets/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const promptPresetId = readPromptPresetId(body.promptPresetId, 'promptPresetId')
      const result = applyTargetedCommandMutation<{ promptPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.promptPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictPromptPresetCollection(target)
          const beforeSelected = target.promptPresetsId
          const nextSelectedIndex = requirePromptPresetIndex(presets, promptPresetId)
          target.promptPresetsId = nextSelectedIndex
          applyPromptPreset(target, presets[nextSelectedIndex])
          if (target.promptPresetsId !== beforeSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.promptPresetSelected, id: promptPresetId },
            extra: { promptPresetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-presets/import', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createPromptPresetRecord(readJsonObject(body.preset, 'preset'), 'Imported Prompt')
      const result = applyTargetedCommandMutation<{ promptPresetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: Object.prototype.hasOwnProperty.call(preset, 'recommendedModelPresetId')
          ? COLLECTION_SCOPED_READS.promptPresetsWithModels
          : COLLECTION_SCOPED_READS.promptPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = ensurePromptPresetCollection(target)
          if (findPromptPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate prompt preset id: ${preset.id}`)
          }
          if (Object.prototype.hasOwnProperty.call(preset, 'recommendedModelPresetId')) {
            validatePromptPresetRecommendedModelPreset(preset, ensureModelPresetCollection(target))
          }
          presets.push(preset)
          writeSingleCollectionTable(innerDb, 'promptPresets', presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.promptPresetImported, id: preset.id },
            extra: { promptPresetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-presets/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptPresetCommandBody
      const baseRevision = readBaseRevision(body)
      if (!Array.isArray(body.promptPresetIds)) {
        throw new ValidationError('promptPresetIds must be an array')
      }
      const promptPresetIds = body.promptPresetIds
      const result = applyTargetedCommandMutation<{ selectedPromptPresetId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.promptPresets,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const presets = readStrictPromptPresetCollection(target)
          const beforeSelected = target.promptPresetsId
          const currentSelectedId = selectedPromptPresetId(target, presets)
          validateFullPromptPresetIdList(presets, promptPresetIds)
          const byId = new Map(presets.map((preset) => [preset.id, preset]))
          const reordered = promptPresetIds.map((id) => byId.get(id as string)!)
          target.promptPresets = reordered
          target.promptPresetsId = currentSelectedId
            ? requirePromptPresetIndex(reordered, currentSelectedId)
            : reordered.length > 0
              ? 0
              : -1
          writeSingleCollectionTable(innerDb, 'promptPresets', reordered)
          if (target.promptPresetsId !== beforeSelected) {
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: COMMAND_EVENT_CATALOG.promptPresetReordered,
            extra: { selectedPromptPresetId: selectedPromptPresetId(target, reordered) },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/legacy-bot-presets/:presetId/extract', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readPresetId((req.params as { presetId?: unknown }).presetId)
      const body = (req.body ?? {}) as LegacyBotPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const mode = readLegacyBotPresetExtractionMode(body.mode)
      const result = applyTargetedCommandMutation<{
        legacyPresetId: string
        modelPresetId?: string
        promptPresetId?: string
        reusedModelPreset?: boolean
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.legacyBotPresetExtraction,
        mutate(database, innerDb) {
          const target = ensureSplitPresetDatabaseObject(database)
          const extraction = extractLegacyBotPreset(target, presetId, mode)
          writeSingleCollectionTable(innerDb, 'botPresets', asArray(target.botPresets))
          writeSingleCollectionTable(innerDb, 'modelPresets', asArray(target.modelPresets))
          writeSingleCollectionTable(innerDb, 'promptPresets', asArray(target.promptPresets))
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.legacyBotPresetExtracted, id: presetId },
            extra: extraction,
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/prompt-settings', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readPromptSettingsPatch(body.patch)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        settingsScopedRead: true,
        mutate(database, innerDb) {
          applySettingsPatch(database, patch)
          writeSettingsOnly(innerDb, extractSettings(database as Record<string, unknown>))
          return {
            event: COMMAND_EVENT_CATALOG.promptSettingsUpdated,
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-items', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      const promptPresetId = readOptionalPromptPresetIdFromBody(body)
      const promptItem = createPromptItemRecord(body.promptItem)
      const result = applyTargetedCommandMutation<{ itemId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: promptPresetId
          ? COLLECTION_SCOPED_READS.promptPresets
          : COLLECTION_SCOPED_READS.promptTemplate,
        mutate(database, innerDb) {
          const scoped = promptPresetId ? requireSelectedPromptPresetCommandTarget(database, promptPresetId) : undefined
          const items = scoped ? scoped.items : readStrictPromptTemplateCollection(ensureDatabaseObject(database))
          if (items.some((item) => item.id === promptItem.id)) {
            throw new ValidationError(`Duplicate prompt item id: ${promptItem.id}`)
          }
          items.push(promptItem)
          if (scoped) {
            writeSingleCollectionRow(innerDb, 'promptPresets', scoped.index, scoped.preset)
          } else {
            writePromptTemplatesTable(innerDb, items)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.promptItemCreated,
              id: promptItem.id,
              ...(promptPresetId ? { parentId: promptPresetId } : {}),
            },
            extra: { itemId: promptItem.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/prompt-items/:itemId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const itemId = readPromptItemId((req.params as { itemId?: unknown }).itemId)
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      const promptPresetId = readOptionalPromptPresetIdFromBody(body)
      const { patch, deleteKeys } = readPromptItemPatch(body.patch, body.deleteKeys, itemId)
      const result = applyTargetedCommandMutation<{ itemId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: promptPresetId
          ? COLLECTION_SCOPED_READS.promptPresets
          : COLLECTION_SCOPED_READS.promptTemplate,
        mutate(database, innerDb) {
          const scoped = promptPresetId ? requireSelectedPromptPresetCommandTarget(database, promptPresetId) : undefined
          const items = scoped ? scoped.items : readStrictPromptTemplateCollection(ensureDatabaseObject(database))
          const index = requirePromptItemIndex(items, itemId)
          const updated = { ...items[index] }
          for (const key of deleteKeys) delete updated[key]
          Object.assign(updated, patch)
          updated.id = itemId
          items[index] = normalizePromptItemRecord(updated)
          if (scoped) {
            writeSingleCollectionRow(innerDb, 'promptPresets', scoped.index, scoped.preset)
          } else {
            writePromptTemplateRow(innerDb, index, items[index])
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.promptItemUpdated,
              id: itemId,
              ...(promptPresetId ? { parentId: promptPresetId } : {}),
            },
            extra: { itemId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/prompt-items/:itemId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const itemId = readPromptItemId((req.params as { itemId?: unknown }).itemId)
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      const promptPresetId = readOptionalPromptPresetIdFromBody(body)
      const result = applyTargetedCommandMutation<{ itemId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: promptPresetId
          ? COLLECTION_SCOPED_READS.promptPresets
          : COLLECTION_SCOPED_READS.promptTemplate,
        mutate(database, innerDb) {
          let scoped: ReturnType<typeof requireSelectedPromptPresetCommandTarget> | undefined
          let items: PromptItemRecord[]
          if (promptPresetId) {
            const target = ensureSplitPresetDatabaseObject(database)
            const presets = readStrictPromptPresetCollection(target)
            const presetIndex = findPromptPresetIndex(presets, promptPresetId)
            if (presetIndex === -1) {
              return {
                event: {
                  ...COMMAND_EVENT_CATALOG.promptItemDeleted,
                  id: itemId,
                  parentId: promptPresetId,
                },
                extra: { itemId },
              }
            }
            const presetItems = readStrictPromptTemplateCollection(presets[presetIndex])
            if (!presetItems.some((item) => item.id === itemId)) {
              return {
                event: {
                  ...COMMAND_EVENT_CATALOG.promptItemDeleted,
                  id: itemId,
                  parentId: promptPresetId,
                },
                extra: { itemId },
              }
            }
            scoped = requireSelectedPromptPresetCommandTarget(database, promptPresetId)
            items = scoped.items
          } else {
            items = readStrictPromptTemplateCollection(ensureDatabaseObject(database), { allowMissing: true })
            if (!items.some((item) => item.id === itemId)) {
              return {
                event: { ...COMMAND_EVENT_CATALOG.promptItemDeleted, id: itemId },
                extra: { itemId },
              }
            }
          }
          const index = requirePromptItemIndex(items, itemId)
          items.splice(index, 1)
          if (scoped) {
            writeSingleCollectionRow(innerDb, 'promptPresets', scoped.index, scoped.preset)
          } else {
            writePromptTemplatesTable(innerDb, items)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.promptItemDeleted,
              id: itemId,
              ...(promptPresetId ? { parentId: promptPresetId } : {}),
            },
            extra: { itemId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-items/enable', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      if (typeof body.enabled !== 'boolean') {
        throw new ValidationError('enabled must be a boolean')
      }
      const enabled = body.enabled
      const promptPresetId = readOptionalPromptPresetIdFromBody(body)
      const result = applyTargetedCommandMutation<{ enabled: boolean }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: promptPresetId
          ? COLLECTION_SCOPED_READS.promptPresets
          : COLLECTION_SCOPED_READS.promptTemplate,
        mutate(database, innerDb) {
          const scoped = promptPresetId
            ? requireSelectedPromptPresetCommandTarget(database, promptPresetId, {
                allowMissingPromptTemplate: enabled,
              })
            : undefined
          if (scoped) {
            if (enabled) {
              if (scoped.preset.promptTemplate === undefined) scoped.preset.promptTemplate = []
            } else {
              delete scoped.preset.promptTemplate
            }
            writeSingleCollectionRow(innerDb, 'promptPresets', scoped.index, scoped.preset)
          } else {
            const target = ensureDatabaseObject(database)
            // enable toggles whether the prompt-items collection exists at all:
            // enabling ensures the array, disabling clears it. Either way it is a
            // single-table write — the `prompt_templates` rows, never another table.
            if (enabled) {
              const items = readStrictPromptTemplateCollection(target, { allowMissing: true })
              if (target.promptTemplate === undefined) target.promptTemplate = items
              writePromptTemplatesTable(innerDb, items)
            } else {
              delete target.promptTemplate
              writePromptTemplatesTable(innerDb, [])
            }
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.promptItemsEnabled,
              ...(promptPresetId ? { parentId: promptPresetId } : {}),
            },
            extra: { enabled },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/prompt-items/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PromptCommandBody
      const baseRevision = readBaseRevision(body)
      if (!Array.isArray(body.itemIds)) {
        throw new ValidationError('itemIds must be an array')
      }
      const itemIds = body.itemIds
      const promptPresetId = readOptionalPromptPresetIdFromBody(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: promptPresetId
          ? COLLECTION_SCOPED_READS.promptPresets
          : COLLECTION_SCOPED_READS.promptTemplate,
        mutate(database, innerDb) {
          const scoped = promptPresetId ? requireSelectedPromptPresetCommandTarget(database, promptPresetId) : undefined
          const target = ensureDatabaseObject(database)
          const items = scoped ? scoped.items : readStrictPromptTemplateCollection(target)
          validateFullPromptItemIdList(items, itemIds)
          const byId = new Map(items.map((item) => [item.id, item]))
          const reordered = itemIds.map((id) => byId.get(id)!)
          if (scoped) {
            scoped.preset.promptTemplate = reordered
            writeSingleCollectionRow(innerDb, 'promptPresets', scoped.index, scoped.preset)
          } else {
            target.promptTemplate = reordered
            writePromptTemplatesTable(innerDb, reordered)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.promptItemReordered,
              ...(promptPresetId ? { parentId: promptPresetId } : {}),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/personas', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PersonaCommandBody
      const baseRevision = readBaseRevision(body)
      const persona = createPersonaRecord(body.persona, { assetDb: db })
      const mirror = readPersonaOptionalBoolean(body.mirrorLegacyProfile, 'mirrorLegacyProfile', false)
      const result = applyTargetedCommandMutation<{ personaId: string } & PersonaMutationCertificate>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.personasWithModules,
        mutate(database, innerDb) {
          const target = ensurePersonaDatabaseObject(database)
          validateNormalModuleLinks(
            readStrictModuleCommandTarget(target).modules,
            persona.modules ?? [],
            'persona.modules',
          )
          const personas = ensurePersonaCollection(target)
          if (personas.length > 0) requireSelectedPersonaIndex(target, personas)
          if (findPersonaIndex(personas, persona.id) !== -1) {
            throw new ValidationError(`Duplicate persona id: ${persona.id}`)
          }
          personas.push(persona)
          writeSingleCollectionTable(innerDb, 'personas', personas)
          // A newly created row becomes selected in the normal row-owner flow;
          // mirroring the legacy scalar aliases remains opt-in compatibility.
          target.selectedPersonaId = persona.id
          target.selectedPersona = personas.length - 1
          if (mirror) {
            mirrorLegacyProfile(target, persona)
          }
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.personaCreated, id: persona.id },
            extra: {
              personaId: persona.id,
              ...buildPersonaMutationCertificate({
                operation: 'create',
                database: target,
                personas,
                collectionWritten: true,
                settingsWritten: true,
                legacyProfileProjectionApplied: mirror,
              }),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/personas/:personaId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const personaId = readPersonaId((req.params as { personaId?: unknown }).personaId)
      const body = (req.body ?? {}) as PersonaCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readPersonaPatch(body.patch, { assetDb: db })
      const mirror = readPersonaOptionalBoolean(body.mirrorLegacyProfile, 'mirrorLegacyProfile', false)
      if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== personaId) {
        throw new ValidationError('patch.id must match personaId')
      }
      const result = applyTargetedCommandMutation<{
        personaId: string
        acknowledgedKeys: string[]
        legacyProfileProjectionApplied: boolean
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.personasWithModules,
        mutate(database, innerDb) {
          const target = ensurePersonaDatabaseObject(database)
          if (Array.isArray(patch.modules)) {
            validateNormalModuleLinks(readStrictModuleCommandTarget(target).modules, patch.modules, 'patch.modules')
          }
          const personas = ensurePersonaCollection(target)
          const index = requirePersonaIndex(personas, personaId)
          const selectedIndex = requireSelectedPersonaIndex(target, personas)
          personas[index] = {
            ...personas[index],
            ...patch,
            id: personaId,
          }
          writeSingleCollectionRow(innerDb, 'personas', index, personas[index])
          // Editing the selected persona with mirroring refreshes the legacy
          // profile scalars; co-write settings only then.
          const legacyProfileProjectionApplied = mirror && selectedIndex === index
          if (legacyProfileProjectionApplied) {
            mirrorLegacyProfile(target, personas[index])
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.personaUpdated, id: personaId },
            extra: {
              personaId,
              acknowledgedKeys: Object.keys(patch),
              legacyProfileProjectionApplied,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/personas/:personaId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const personaId = readPersonaId((req.params as { personaId?: unknown }).personaId)
      const body = (req.body ?? {}) as PersonaCommandBody
      const baseRevision = readBaseRevision(body)
      const selectPersonaId =
        body.selectPersonaId === undefined ? undefined : readPersonaId(body.selectPersonaId, 'selectPersonaId')
      // Persona rows own normal profile state. Legacy scalar projection remains
      // available only to explicitly named migration/compatibility callers.
      const mirror = readPersonaOptionalBoolean(body.mirrorLegacyProfile, 'mirrorLegacyProfile', false)
      const saveCurrent = readPersonaOptionalBoolean(body.saveCurrent, 'saveCurrent', false)
      const result = applyTargetedCommandMutation<
        { personaId: string; cascadedChatCount: number; cascadedLoadoutCount: number } & PersonaMutationCertificate
      >({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        mutate(database, innerDb) {
          const target = ensurePersonaDatabaseObject(database)
          const personas = ensurePersonaCollection(target)
          requireSelectedPersonaIndex(target, personas)
          const deletedIndex = findPersonaIndex(personas, personaId)
          if (deletedIndex === -1) {
            const selectedId = selectedPersonaId(target, personas)
            const replacementId = selectPersonaId ?? selectedId
            const replacementPersona = replacementId
              ? (personas.find((persona) => persona.id === replacementId) ?? null)
              : null
            const cascade = rehomeGenerationReferences(target, 'persona', personaId, replacementPersona)
            writeGenerationReferenceCascade(innerDb, target, cascade)
            return {
              event: { ...COMMAND_EVENT_CATALOG.personaDeleted, id: personaId },
              extra: {
                personaId,
                cascadedChatCount: cascade.changedChatCount,
                cascadedLoadoutCount: cascade.changedLoadoutCount,
                ...buildPersonaMutationCertificate({
                  operation: 'delete',
                  database: target,
                  personas,
                  collectionWritten: false,
                  settingsWritten: false,
                  legacyProfileProjectionApplied: false,
                }),
              },
            }
          }
          if (personas.length <= 1) {
            throw new ValidationError('Cannot delete the only persona')
          }
          if (saveCurrent) {
            saveSelectedPersonaSnapshot(target, personas)
          }
          const currentSelectedId = selectedPersonaId(target, personas)
          const deletedWasSelected = currentSelectedId === personaId
          personas.splice(deletedIndex, 1)

          let nextSelectedId = selectPersonaId
          if (!nextSelectedId && deletedWasSelected) {
            nextSelectedId = personas[0]?.id
          } else if (!nextSelectedId) {
            nextSelectedId = currentSelectedId ?? personas[0]?.id
          }

          const selectedIndex = nextSelectedId ? requirePersonaIndex(personas, nextSelectedId) : -1
          target.selectedPersonaId = nextSelectedId ?? null
          target.selectedPersona = selectedIndex
          let mirrored = false
          if (mirror && selectedIndex >= 0) {
            mirrorLegacyProfile(target, personas[selectedIndex])
            mirrored = true
          }

          // The splice shifts positions, so the persona table is always rewritten.
          writeSingleCollectionTable(innerDb, 'personas', personas)
          // Stable identity is authoritative; the numeric field is persisted in
          // the same transaction as a derived compatibility projection.
          writeSettingsOnly(innerDb, extractSettings(target))
          const cascade = rehomeGenerationReferences(
            target,
            'persona',
            personaId,
            selectedIndex >= 0 ? personas[selectedIndex] : null,
          )
          writeGenerationReferenceCascade(innerDb, target, cascade)

          return {
            event: { ...COMMAND_EVENT_CATALOG.personaDeleted, id: personaId },
            extra: {
              personaId,
              cascadedChatCount: cascade.changedChatCount,
              cascadedLoadoutCount: cascade.changedLoadoutCount,
              ...buildPersonaMutationCertificate({
                operation: 'delete',
                database: target,
                personas,
                collectionWritten: true,
                settingsWritten: true,
                legacyProfileProjectionApplied: mirrored,
              }),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/personas/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PersonaCommandBody
      const baseRevision = readBaseRevision(body)
      const personaId = readPersonaId(body.personaId, 'personaId')
      // Do not snapshot or mirror legacy profile scalars during ordinary row
      // deletion/selection. Older import/export callers can opt in explicitly.
      const mirror = readPersonaOptionalBoolean(body.mirrorLegacyProfile, 'mirrorLegacyProfile', false)
      const saveCurrent = readPersonaOptionalBoolean(body.saveCurrent, 'saveCurrent', false)
      const result = applyTargetedCommandMutation<{ personaId: string } & PersonaMutationCertificate>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.personas,
        mutate(database, innerDb) {
          const target = ensurePersonaDatabaseObject(database)
          const personas = ensurePersonaCollection(target)
          requireSelectedPersonaIndex(target, personas)
          if (saveCurrent) {
            saveSelectedPersonaSnapshot(target, personas)
          }
          const index = requirePersonaIndex(personas, personaId)
          target.selectedPersonaId = personaId
          target.selectedPersona = index
          let mirrored = false
          if (mirror) {
            mirrorLegacyProfile(target, personas[index])
            mirrored = true
          }
          // The persona table is rewritten only when save-current snapshotted the
          // outgoing persona into it; the pointer + mirror scalars live in settings.
          if (saveCurrent) {
            writeSingleCollectionTable(innerDb, 'personas', personas)
          }
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.personaSelected, id: personaId },
            extra: {
              personaId,
              ...buildPersonaMutationCertificate({
                operation: 'select',
                database: target,
                personas,
                collectionWritten: saveCurrent,
                settingsWritten: true,
                legacyProfileProjectionApplied: mirrored,
              }),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/personas/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PersonaCommandBody
      const baseRevision = readBaseRevision(body)
      if (!Array.isArray(body.personaIds)) {
        throw new ValidationError('personaIds must be an array')
      }
      const personaIds = body.personaIds
      const result = applyTargetedCommandMutation<PersonaMutationCertificate>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.personas,
        mutate(database, innerDb) {
          const target = ensurePersonaDatabaseObject(database)
          const personas = ensurePersonaCollection(target)
          const currentSelectedId = selectedPersonaId(target, personas)
          validateFullPersonaIdList(personas, personaIds)
          const byId = new Map(personas.map((persona) => [persona.id, persona]))
          const reordered = personaIds.map((id) => byId.get(id)!)
          target.personas = reordered
          target.selectedPersonaId = currentSelectedId
          target.selectedPersona = currentSelectedId
            ? requirePersonaIndex(reordered, currentSelectedId)
            : reordered.length > 0
              ? 0
              : -1
          writeSingleCollectionTable(innerDb, 'personas', reordered)
          // Co-persist the stable owner and numeric compatibility projection
          // with the reordered rows even when the selected index is unchanged.
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: COMMAND_EVENT_CATALOG.personaReordered,
            extra: buildPersonaMutationCertificate({
              operation: 'reorder',
              database: target,
              personas: reordered,
              collectionWritten: true,
              settingsWritten: true,
              legacyProfileProjectionApplied: false,
            }),
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/translator-presets', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as TranslatorPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const preset = createTranslatorPresetRecord(body.preset)
      const select = readTranslatorPresetOptionalBoolean(body.select, 'select', false)
      const result = applyTargetedCommandMutation<{ presetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.translatorPresets,
        mutate(database, innerDb) {
          const target = ensureTranslatorPresetDatabaseObject(database)
          const presets = ensureTranslatorPresetCollection(target)
          if (findTranslatorPresetIndex(presets, preset.id) !== -1) {
            throw new ValidationError(`Duplicate translator preset id: ${preset.id}`)
          }
          presets.push(preset)
          if (select) {
            target.translatorPresetId = preset.id
          }
          writeTranslatorPresetMutation(innerDb, target, presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.translatorPresetCreated, id: preset.id },
            extra: { presetId: preset.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/translator-presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readTranslatorPresetId((req.params as { presetId?: unknown }).presetId, 'presetId')
      const body = (req.body ?? {}) as TranslatorPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readTranslatorPresetPatch(body.patch)
      if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== presetId) {
        throw new ValidationError('patch.id must match presetId')
      }
      const requestedAcknowledgedKeys = Object.keys(patch)
      const result = applyTargetedCommandMutation<{
        presetId: string
        acknowledgedKeys: string[]
        selectedPresetId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.translatorPresets,
        mutate(database, innerDb) {
          const target = ensureTranslatorPresetDatabaseObject(database)
          const rawPresets = target.translatorPresets
          const rawSelectedId = target.translatorPresetId
          const presets = ensureTranslatorPresetCollection(target)
          const acknowledgementSafe =
            Array.isArray(rawPresets) &&
            isDeepStrictEqual(rawPresets, presets) &&
            rawSelectedId === target.translatorPresetId
          const index = requireTranslatorPresetIndex(presets, presetId)
          presets[index] = applyTranslatorPresetRecordPatch(presets[index], patch)
          writeTranslatorPresetMutation(innerDb, target, presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.translatorPresetUpdated, id: presetId },
            extra: {
              presetId,
              // Collection normalization may repair sibling rows, selection,
              // or legacy mirrors before applying the requested patch. An
              // empty key certificate deliberately forces the client down the
              // authoritative reconciliation path for that broader mutation.
              acknowledgedKeys: acknowledgementSafe ? requestedAcknowledgedKeys : [],
              selectedPresetId: selectedTranslatorPresetId(target, presets),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/translator-presets/:presetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const presetId = readTranslatorPresetId((req.params as { presetId?: unknown }).presetId, 'presetId')
      const body = (req.body ?? {}) as TranslatorPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const selectPresetId =
        body.selectPresetId === undefined ? undefined : readTranslatorPresetId(body.selectPresetId, 'selectPresetId')
      const result = applyTargetedCommandMutation<{
        presetId: string
        selectedPresetId: string | null
        cascadedChatIds: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.translatorPresets,
        mutate(database, innerDb) {
          const target = ensureTranslatorPresetDatabaseObject(database)
          const presets = ensureTranslatorPresetCollection(target)
          const deletedIndex = findTranslatorPresetIndex(presets, presetId)
          if (deletedIndex === -1) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.translatorPresetDeleted, resource: 'state', id: presetId },
              extra: {
                presetId,
                selectedPresetId: selectedTranslatorPresetId(target, presets),
                cascadedChatIds: [],
              },
            }
          }
          if (presets.length <= 1) {
            throw new ValidationError('Cannot delete the only translator preset')
          }
          const currentSelectedId = selectedTranslatorPresetId(target, presets)
          const deletedWasSelected = currentSelectedId === presetId
          presets.splice(deletedIndex, 1)

          let nextSelectedId = selectPresetId
          if (!nextSelectedId && deletedWasSelected) {
            nextSelectedId = presets[0]?.id
          } else if (!nextSelectedId) {
            nextSelectedId = currentSelectedId ?? presets[0]?.id
          }

          const selectedIndex = nextSelectedId ? requireTranslatorPresetIndex(presets, nextSelectedId) : -1
          target.translatorPresetId = selectedIndex >= 0 ? presets[selectedIndex].id : presets[0]?.id
          const cascadedChatIds = clearChatTranslatorPresetBindings(innerDb, presetId)
          writeTranslatorPresetMutation(innerDb, target, presets)

          return {
            event: { ...COMMAND_EVENT_CATALOG.translatorPresetDeleted, resource: 'state', id: presetId },
            extra: {
              presetId,
              selectedPresetId: selectedTranslatorPresetId(target, presets),
              cascadedChatIds,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/translator-presets/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as TranslatorPresetCommandBody
      const baseRevision = readBaseRevision(body)
      const presetId = readTranslatorPresetId(body.presetId, 'presetId')
      const result = applyTargetedCommandMutation<{ presetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.translatorPresets,
        mutate(database, innerDb) {
          const target = ensureTranslatorPresetDatabaseObject(database)
          const presets = ensureTranslatorPresetCollection(target)
          requireTranslatorPresetIndex(presets, presetId)
          target.translatorPresetId = presetId
          writeTranslatorPresetMutation(innerDb, target, presets)
          return {
            event: { ...COMMAND_EVENT_CATALOG.translatorPresetSelected, id: presetId },
            extra: { presetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/loadouts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as LoadoutCommandBody
      const baseRevision = readBaseRevision(body)
      const loadout = createLoadoutRecord(body.loadout)
      const result = applyTargetedCommandMutation<{ loadoutId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.loadouts,
        mutate(database, innerDb) {
          const target = ensureLoadoutDatabaseObject(database)
          const loadouts = ensureLoadoutCollection(target)
          const beforeLastLoaded = target.lastLoadedLoadoutName
          if (findLoadoutIndex(loadouts, loadout.id) !== -1) {
            throw new ValidationError(`Duplicate loadout id: ${loadout.id}`)
          }
          loadouts.push(loadout)
          writeLoadoutMutation(innerDb, target, loadouts, beforeLastLoaded)
          return {
            event: { ...COMMAND_EVENT_CATALOG.loadoutCreated, id: loadout.id },
            extra: { loadoutId: loadout.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/loadouts/:loadoutId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const loadoutId = readLoadoutId((req.params as { loadoutId?: unknown }).loadoutId)
      const body = (req.body ?? {}) as LoadoutCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readLoadoutPatch(body.patch)
      if (Object.prototype.hasOwnProperty.call(patch, 'id') && patch.id !== loadoutId) {
        throw new ValidationError('patch.id must match loadoutId')
      }
      const result = applyTargetedCommandMutation<{ loadoutId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.loadouts,
        mutate(database, innerDb) {
          const target = ensureLoadoutDatabaseObject(database)
          const loadouts = ensureLoadoutCollection(target)
          const beforeLastLoaded = target.lastLoadedLoadoutName
          const index = requireLoadoutIndex(loadouts, loadoutId)
          loadouts[index] = {
            ...loadouts[index],
            ...patch,
            id: loadoutId,
          }
          writeLoadoutMutation(innerDb, target, loadouts, beforeLastLoaded)
          return {
            event: { ...COMMAND_EVENT_CATALOG.loadoutUpdated, id: loadoutId },
            extra: { loadoutId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/loadouts/:loadoutId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const loadoutId = readLoadoutId((req.params as { loadoutId?: unknown }).loadoutId)
      const body = (req.body ?? {}) as LoadoutCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ loadoutId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.loadouts,
        mutate(database, innerDb) {
          const target = ensureLoadoutDatabaseObject(database)
          const loadouts = ensureLoadoutCollection(target)
          const beforeLastLoaded = target.lastLoadedLoadoutName
          const index = requireLoadoutIndex(loadouts, loadoutId)
          loadouts.splice(index, 1)
          writeLoadoutMutation(innerDb, target, loadouts, beforeLastLoaded)
          return {
            event: { ...COMMAND_EVENT_CATALOG.loadoutDeleted, id: loadoutId },
            extra: { loadoutId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/loadouts/:loadoutId/favorite', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const loadoutId = readLoadoutId((req.params as { loadoutId?: unknown }).loadoutId)
      const body = (req.body ?? {}) as LoadoutCommandBody
      const baseRevision = readBaseRevision(body)
      const favorite = readLoadoutOptionalBoolean(body.favorite, 'favorite', true)
      const result = applyTargetedCommandMutation<{ loadoutId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.loadouts,
        mutate(database, innerDb) {
          const target = ensureLoadoutDatabaseObject(database)
          const loadouts = ensureLoadoutCollection(target)
          const beforeLastLoaded = target.lastLoadedLoadoutName
          const index = requireLoadoutIndex(loadouts, loadoutId)
          loadouts[index].favorite = favorite
          writeLoadoutMutation(innerDb, target, loadouts, beforeLastLoaded)
          return {
            event: { ...COMMAND_EVENT_CATALOG.loadoutFavorited, id: loadoutId },
            extra: { loadoutId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/loadouts/:loadoutId/touch', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const loadoutId = readLoadoutId((req.params as { loadoutId?: unknown }).loadoutId)
      const body = (req.body ?? {}) as LoadoutCommandBody
      const baseRevision = readBaseRevision(body)
      const lastUsed = readOptionalTimestamp(body.lastUsed, 'lastUsed')
      const characterId = readOptionalCharacterId(body.characterId)
      const result = applyTargetedCommandMutation<{ loadoutId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.loadouts,
        mutate(database, innerDb) {
          const target = ensureLoadoutDatabaseObject(database)
          const loadouts = ensureLoadoutCollection(target)
          const beforeLastLoaded = target.lastLoadedLoadoutName
          const index = requireLoadoutIndex(loadouts, loadoutId)
          const loadout = loadouts[index]
          loadout.lastUsed = lastUsed
          if (characterId && !loadout.characterIds.includes(characterId)) {
            loadout.characterIds.push(characterId)
          }
          target.lastLoadedLoadoutName = loadout.name
          writeLoadoutMutation(innerDb, target, loadouts, beforeLastLoaded)
          return {
            event: { ...COMMAND_EVENT_CATALOG.loadoutTouched, id: loadoutId },
            extra: { loadoutId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      // Fingerprint the submitted intent before creation normalizes its fields.
      const mutationContext = commandMutationContext(req, eventSink)
      const character = createCharacterRecord(body.character, { assetDb: db })
      const initialChat = readInitialCharacterChat(body.initialChat)
      const result = applyTargetedCommandMutation<{
        characterId: string
        selectedCharacterId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...mutationContext,
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const { settings: target, characters } = loadCharacterAppendState(innerDb)
          validateStrictSelectedIndex(target, 'currentChar', characters.length)
          const characterOrder = readCharacterOrder(target.characterOrder)
          validateFullCharacterOrder(characters, characterOrder)
          if (characterRowExists(innerDb, character.chaId)) {
            throw new ValidationError(`Duplicate character id: ${character.chaId}`)
          }
          if (initialChat && chatRowExists(innerDb, initialChat.id)) {
            throw new ValidationError(`Duplicate chat id: ${initialChat.id}`)
          }
          character.chats = initialChat ? [initialChat] : []
          character.chatFolders = []
          character.chatPage = initialChat ? 0 : -1
          insertCharacterRow(innerDb, nextCharacterRowPosition(innerDb), character)
          if (initialChat) insertCharacterChatRow(innerDb, character.chaId, 0, initialChat)
          characters.push(character)
          updateCharacterOrderForPatchedRow(target, character.chaId, character)
          writeSettingsOnly(innerDb, target)
          return {
            event: { ...COMMAND_EVENT_CATALOG.characterCreated, id: character.chaId },
            extra: {
              characterId: character.chaId,
              selectedCharacterId: selectedCharacterId(target, characters),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/create-and-select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      // Fingerprint the submitted intent before creation normalizes its fields.
      const mutationContext = commandMutationContext(req, eventSink)
      const character = createCharacterRecord(body.character, { assetDb: db })
      const initialChat = readInitialCharacterChat(body.initialChat)
      const lastInteraction = readSelectionLastInteraction(body.lastInteraction)
      character.lastInteraction = lastInteraction
      const result = applyTargetedCommandMutation<{
        characterId: string
        selectedCharacterId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...mutationContext,
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const { settings: target, characters } = loadCharacterAppendState(innerDb)
          validateStrictSelectedIndex(target, 'currentChar', characters.length)
          const characterOrder = readCharacterOrder(target.characterOrder)
          validateFullCharacterOrder(characters, characterOrder)
          if (characterRowExists(innerDb, character.chaId)) {
            throw new ValidationError(`Duplicate character id: ${character.chaId}`)
          }
          if (initialChat && chatRowExists(innerDb, initialChat.id)) {
            throw new ValidationError(`Duplicate chat id: ${initialChat.id}`)
          }
          character.chats = initialChat ? [initialChat] : []
          character.chatFolders = []
          character.chatPage = initialChat ? 0 : -1
          insertCharacterRow(innerDb, nextCharacterRowPosition(innerDb), character)
          if (initialChat) insertCharacterChatRow(innerDb, character.chaId, 0, initialChat)
          characters.push(character)
          updateCharacterOrderForPatchedRow(target, character.chaId, character)
          target.currentChar = requireCharacterIndex(characters, character.chaId)
          writeSettingsOnly(innerDb, target)
          return {
            event: { ...COMMAND_EVENT_CATALOG.characterCreatedAndSelected, id: character.chaId },
            extra: {
              characterId: character.chaId,
              selectedCharacterId: selectedCharacterId(target, characters),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/characters/:characterId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readCharacterPatch(body.patch, { assetDb: db })
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = Array.isArray(target.characters) ? target.characters : []
          let index = characters.findIndex(
            (character) =>
              !!character &&
              typeof character === 'object' &&
              !Array.isArray(character) &&
              (character as Record<string, unknown>).chaId === characterId,
          )
          if (index === -1 && characters.length === 1 && characterRowExists(innerDb, characterId)) {
            index = 0
          }
          if (index === -1) {
            throw new EntityNotFoundError(`Character not found: ${characterId}`)
          }
          const resolvedContainer = resolveMaskedProviderSecretPlaceholders(target, {
            characters: [{ chaId: characterId, ...patch }],
          })
          const resolvedRow = (resolvedContainer.characters as Array<Record<string, unknown>>)[0]
          const resolvedPatch = { ...resolvedRow }
          delete resolvedPatch.chaId
          const before = structuredClone(characters[index]) as Record<string, unknown>
          const patched = buildStrictPatchedCharacterRow(characters[index], resolvedPatch, characterId)
          characters[index] = patched
          writeSingleCharacterRow(innerDb, characterId, patched)
          deleteChangedGreetingTranslations(innerDb, characterId, before, patched)
          const updatesTrashState = Object.prototype.hasOwnProperty.call(resolvedPatch, 'trashTime')
          if (updatesTrashState) {
            updateCharacterOrderForPatchedRow(target, characterId, patched)
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: {
              ...(updatesTrashState
                ? COMMAND_EVENT_CATALOG.characterTrashUpdated
                : COMMAND_EVENT_CATALOG.characterUpdated),
              id: characterId,
            },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/characters/:characterId/alternate-greetings', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      let appliedGreetingMutation:
        | { type: 'delete'; index: number }
        | { type: 'swap'; firstIndex: number; secondIndex: number }
        | null = null
      const result = applyTargetedCommandMutation<{
        characterId: string
        certificate: 'alternate-greeting-index-cascade-v1'
        chatGreetingIndices: Array<{ chatId: string; fmIndex: number }>
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = readStrictCharacterGraph(target)
          const character = characters[requireCharacterIndex(characters, characterId)]
          const currentGreetings = Array.isArray(character.alternateGreetings)
            ? character.alternateGreetings.filter((value): value is string => typeof value === 'string')
            : []
          const mutation = readAlternateGreetingMutation(body, currentGreetings.length)
          appliedGreetingMutation = mutation.operation
          character.alternateGreetings = mutation.alternateGreetings
          const chats = readStrictCharacterChats(character)
          const chatGreetingIndices = chats.map((chat) => {
            const fmIndex = remapAlternateGreetingIndex(chat.fmIndex, currentGreetings.length, mutation.operation)
            chat.fmIndex = fmIndex
            return { chatId: chat.id, fmIndex }
          })

          writeCharacterChatRows(innerDb, characterId, chats as Record<string, unknown>[])
          writeSingleCharacterRow(innerDb, characterId, character)
          remapAlternateGreetingTranslations(innerDb, characterId, mutation.operation)
          return {
            event: { ...COMMAND_EVENT_CATALOG.alternateGreetingsUpdated, id: characterId },
            extra: {
              characterId,
              certificate: 'alternate-greeting-index-cascade-v1' as const,
              chatGreetingIndices,
            },
          }
        },
      })
      if (appliedGreetingMutation) {
        greetingTranslationJobs?.invalidateAlternateMutation(characterId, appliedGreetingMutation)
      }

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/greetings/:greetingIndex/translate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { characterId?: unknown; greetingIndex?: unknown }
      const characterId = readCharacterId(params.characterId)
      const greetingIndex = readGreetingTranslationIndex(params.greetingIndex)
      const body = (req.body ?? {}) as MessageCommandBody
      readBaseRevision(body)
      const chatId = readChatId(body.chatId)
      const requestedJobId = readOptionalMessageTranslationJobId(body.jobId)
      return await runServerGreetingTranslation({
        db,
        dataDir,
        greetingTranslationJobs,
        characterId,
        chatId,
        greetingIndex,
        ...(requestedJobId ? { jobId: requestedJobId } : {}),
        ...commandMutationContext(req, eventSink),
      })
    } catch (err) {
      if (
        err instanceof RevisionMismatchError ||
        err instanceof ValidationError ||
        err instanceof EntityNotFoundError
      ) {
        return sendCommandError(reply, err)
      }
      const message = err instanceof Error && err.message.length > 0 ? err.message : String(err)
      return sendCommandError(reply, new ValidationError(message || 'Greeting translation failed'))
    }
  })

  app.post('/api/v1/commands/characters/:characterId/recover-cold-storage', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ColdStorageRecoveryCommandBody
      const baseRevision = readBaseRevision(body)
      const key = readColdStorageKey(body.key)
      const archive = await readColdStorageArchive(dataDir, key)
      const recoveredCharacter = readRecoveredCharacterArchive(archive, characterId)
      const result = applyTargetedCommandMutation<{
        characterId: string
        character: CharacterRecord
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = normalizeAllCharacterChats(target)
          const characterIndex = requireCharacterIndex(characters, characterId)
          const current = characters[characterIndex]
          if (current.coldstorage !== key) {
            throw new ValidationError(`Cold-storage pointer no longer matches key: ${key}`)
          }

          const otherChatIds = new Set<string>()
          for (const character of characters) {
            if (character.chaId === characterId) continue
            for (const chat of ensureCharacterChats(character)) otherChatIds.add(chat.id)
          }
          const recoveredChats = ensureCharacterChats(recoveredCharacter)
          for (const chat of recoveredChats) {
            if (otherChatIds.has(chat.id)) {
              throw new ValidationError(`Duplicate chat id outside recovered character: ${chat.id}`)
            }
          }

          const currentChats = ensureCharacterChats(current)
          const recoveredChatById = new Map(recoveredChats.map((chat) => [chat.id, chat]))
          const preservedHypaChatIds = new Set<string>()
          for (const chat of currentChats) {
            deleteCharacterChatRow(innerDb, chat.id, characterId)
            deleteChatMessages(innerDb, chat.id)
            const recoveredChat = recoveredChatById.get(chat.id)
            if (recoveredChat && !Object.prototype.hasOwnProperty.call(recoveredChat, 'hypaV3Data')) {
              preservedHypaChatIds.add(chat.id)
            } else {
              deleteChatHypaV3(innerDb, chat.id)
            }
          }

          characters[characterIndex] = recoveredCharacter
          writeSingleCharacterRow(innerDb, characterId, recoveredCharacter)
          for (let index = 0; index < recoveredChats.length; index++) {
            const chat = recoveredChats[index]
            const messages = ensureChatMessages(chat)
            for (const message of messages) {
              if (activeMessageIdExists(innerDb, message.chatId)) {
                throw new ValidationError(`Duplicate message id outside recovered character: ${message.chatId}`)
              }
            }
            insertCharacterChatRow(innerDb, characterId, index, chat)
            replaceActiveChatMessages(innerDb, chat.id, messages)
            if (chat.hypaV3Data !== undefined && chat.hypaV3Data !== null) {
              setChatHypaV3(innerDb, chat.id, chat.hypaV3Data)
            } else if (!preservedHypaChatIds.has(chat.id)) {
              deleteChatHypaV3(innerDb, chat.id)
            }
          }

          return {
            event: { ...COMMAND_EVENT_CATALOG.coldStorageCharacterRecovered, id: characterId },
            extra: { characterId, character: recoveredCharacter },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/characters/:characterId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        characterId: string
        selectedCharacterId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        // Character deletion does not hydrate messages; it removes character,
        // chat, message, and hypa rows directly, then persists settings pointers.
        // Sibling character-row repairs mutate the clone only and are discarded.
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = readStrictCharacterCollection(target)
          const index = findCharacterIndex(characters, characterId)
          if (index === -1) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.characterDeleted, id: characterId },
              extra: {
                characterId,
                selectedCharacterId: selectedCharacterId(target, characters),
              },
            }
          }
          const character = characters[index]
          const removedChatIds = readStrictCharacterChats(character).map((chat) => chat.id)
          const selectedIndex = target.currentChar as number
          const characterOrder = readCharacterOrder(target.characterOrder)
          validateFullCharacterOrder(characters, characterOrder)
          characters.splice(index, 1)
          if (characters.length === 0) target.currentChar = -1
          else if (selectedIndex === index) target.currentChar = Math.min(index, characters.length - 1)
          else if (selectedIndex > index) target.currentChar = selectedIndex - 1
          target.characterOrder = characterOrderWithout(characterOrder, characterId)
          // The chats.character_id ON DELETE CASCADE removes the chat rows with
          // the character row; no explicit chats DELETE needed.
          deleteCharacterRow(innerDb, characterId)
          for (const chatId of removedChatIds) {
            deleteChatMessages(innerDb, chatId)
            deleteChatHypaV3(innerDb, chatId)
          }
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.characterDeleted, id: characterId },
            extra: {
              characterId,
              selectedCharacterId: selectedCharacterId(target, characters),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      const characterId = readCharacterId(body.characterId)
      const lastInteraction = readSelectionLastInteraction(body.lastInteraction)
      const result = applyCharacterSelectionCommandMutation({
        db,
        baseRevision,
        characterId,
        lastInteraction,
        ...commandMutationContext(req, eventSink),
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as CharacterCommandBody
      const baseRevision = readBaseRevision(body)
      const order =
        body.characterOrder !== undefined
          ? readCharacterOrder(body.characterOrder)
          : readCharacterOrder(body.characterIds)
      validateCharacterOrderAssetRefs(db, order)
      const result = applyTargetedCommandMutation<{ selectedCharacterId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = readStrictCharacterCollection(target)
          validateFullCharacterOrder(characters, order)
          // `characterOrder` is a settings scalar; reorder edits presentation
          // order, not `characters` table positions.
          target.characterOrder = order
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: COMMAND_EVENT_CATALOG.characterReordered,
            extra: { selectedCharacterId: selectedCharacterId(target, characters) },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/chats', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const chat = createChatRecord(body.chat)
      const chatMessages = readReplacementMessages(chat.message)
      chat.message = chatMessages
      const selectCreated = readChatOptionalBoolean(body.select, 'select') ?? true
      const result = applyTargetedCommandMutation<{
        chatId: string
        selectedChatId: string | null
        generationSettings: object | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const { target, modules } = readStrictModuleCommandTarget(database)
          const characters = readStrictCharacterGraph(target)
          const character = characters[requireCharacterIndex(characters, characterId)]
          const previousSelectedChatId = selectedChatIdStrict(character)
          const chats = readStrictCharacterChats(character)
          if (chatIdExists(characters, chat.id)) {
            throw new ValidationError(`Duplicate chat id: ${chat.id}`)
          }
          for (const message of chatMessages) {
            if (activeMessageIdExists(innerDb, message.chatId as string)) {
              throw new ValidationError(`Duplicate message id: ${message.chatId}`)
            }
          }
          if (chat.modules) {
            validateNormalModuleLinks(modules, chat.modules, 'chat.modules')
          }
          if (chat.folderId) {
            const folders = readStrictChatFolders(character)
            if (!folders.some((folder) => folder.id === chat.folderId)) {
              throw new ValidationError(`Unknown chat folder id: ${chat.folderId}`)
            }
          }
          if (Object.prototype.hasOwnProperty.call(chat, 'generationSettings')) {
            chat.generationSettings = readChatGenerationSettingsSave(
              chat.generationSettings,
              buildChatGenerationSettingsValidationContext(target, character, chat),
            )
          }
          chats.unshift(chat)
          if (selectCreated) {
            character.chatPage = 0
          } else if (previousSelectedChatId) {
            selectChatStrict(character, previousSelectedChatId)
          }
          writeCharacterChatRows(innerDb, characterId, character.chats as Record<string, unknown>[])
          insertCharacterChatRow(innerDb, characterId, 0, chat as Record<string, unknown>)
          replaceActiveChatMessages(innerDb, chat.id, chatMessages)
          if (chat.hypaV3Data !== undefined && chat.hypaV3Data !== null) {
            setChatHypaV3(innerDb, chat.id, chat.hypaV3Data)
          }
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...(chatMessages.length > 0
                ? COMMAND_EVENT_CATALOG.chatCreatedWithTranscript
                : COMMAND_EVENT_CATALOG.chatCreated),
              id: chat.id,
              parentId: characterId,
            },
            extra: {
              chatId: chat.id,
              selectedChatId: selectedChatIdStrict(character),
              generationSettings: chat.generationSettings ?? null,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/characters/:characterId/chats', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const chat = createChatRecord(body.chat)
      if (chat.message.length > 0) {
        throw new ValidationError('chat.message must be empty when resetting chats')
      }
      if (chat.hypaV3Data !== undefined && chat.hypaV3Data !== null) {
        throw new ValidationError('chat.hypaV3Data must be empty when resetting chats')
      }

      const result = applyTargetedCommandMutation<{
        chatId: string
        selectedChatId: string
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const { target, modules } = readStrictModuleCommandTarget(database)
          const characters = readStrictCharacterGraph(target)
          const character = characters[requireCharacterIndex(characters, characterId)]
          if (chatIdExists(characters, chat.id)) {
            throw new ValidationError(`Duplicate chat id: ${chat.id}`)
          }
          if (chat.modules) {
            validateNormalModuleLinks(modules, chat.modules, 'chat.modules')
          }
          if (chat.folderId) {
            const folders = readStrictChatFolders(character)
            if (!folders.some((folder) => folder.id === chat.folderId)) {
              throw new ValidationError(`Unknown chat folder id: ${chat.folderId}`)
            }
          }
          if (Object.prototype.hasOwnProperty.call(chat, 'generationSettings')) {
            chat.generationSettings = readChatGenerationSettingsSave(
              chat.generationSettings,
              buildChatGenerationSettingsValidationContext(target, character, chat),
            )
          }

          const removedChatIds = readStrictCharacterChats(character).map((candidate) => candidate.id)
          character.chats = [chat]
          character.chatPage = 0

          for (const removedChatId of removedChatIds) {
            deleteCharacterChatRow(innerDb, removedChatId, characterId)
            deleteChatMessages(innerDb, removedChatId)
            deleteChatHypaV3(innerDb, removedChatId)
          }
          insertCharacterChatRow(innerDb, characterId, 0, chat as Record<string, unknown>)
          writeSingleCharacterRow(innerDb, characterId, character)

          return {
            event: { ...COMMAND_EVENT_CATALOG.chatsReset, id: chat.id, parentId: characterId },
            extra: { chatId: chat.id, selectedChatId: chat.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/chats/:chatId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const selectUpdated = readChatOptionalBoolean(body.select, 'select') ?? false
      const patch = readChatPatch(body.patch, { allowEmpty: selectUpdated })
      const hasModulePatch = Object.prototype.hasOwnProperty.call(patch, 'modules')
      const result = applyTargetedCommandMutation<{
        chatId: string
        selectedChatId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        ...(hasModulePatch ? {} : { chatScopedRead: { chatId, exactChatRow: true } }),
        mutate(database, innerDb) {
          const target = hasModulePatch
            ? readStrictModuleCommandTarget(database).target
            : ensureCharacterDatabaseObject(database)
          const characters = hasModulePatch ? readStrictCharacterGraph(target) : readScopedCharacterRecords(target)
          const { character, chatIndex } = hasModulePatch
            ? requireStrictChatLocation(characters, chatId)
            : requireOrdinaryChatLocation(characters, chatId, innerDb)
          if (hasModulePatch) {
            const modules = readStrictModuleRecords(target)
            validateNormalModuleLinks(modules, patch.modules as string[], 'patch.modules')
          }
          if (patch.folderId) {
            const folders = readStrictChatFolders(character)
            if (!folders.some((folder) => folder.id === patch.folderId)) {
              throw new ValidationError(`Unknown chat folder id: ${patch.folderId}`)
            }
          }
          const chats = hasModulePatch ? readStrictCharacterChats(character) : (character.chats as ChatRecord[])
          const updatedChat = {
            ...chats[chatIndex],
            ...patch,
            id: chatId,
          }
          if (patch.translatorPresetId === null) delete updatedChat.translatorPresetId
          chats[chatIndex] = updatedChat
          ;(hasModulePatch ? writeSingleChatRow : writeSingleChatRowExact)(innerDb, chatId, chats[chatIndex])
          // The parent character row is rewritten only when `select:true` moves
          // its `chatPage` pointer.
          if (selectUpdated) {
            character.chatPage = chatIndex
            writeSingleCharacterRow(innerDb, character.chaId as string, character)
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.chatUpdated, id: chatId, parentId: character.chaId },
            extra: {
              chatId,
              selectedChatId: selectedChatIdStrict(character),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/recover-cold-storage', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ColdStorageRecoveryCommandBody
      const baseRevision = readBaseRevision(body)
      const key = readColdStorageKey(body.key)
      const archive = await readColdStorageArchive(dataDir, key)
      const result = applyTargetedCommandMutation<{
        chatId: string
        characterId: string
        chat: ChatRecord
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        chatScopedRead: { chatId },
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = normalizeAllCharacterChats(target)
          const { character, chat } = requireChatLocation(characters, chatId)
          const currentMessages = getChatMessages(innerDb, chatId)
          if (currentMessages[0]?.data !== `${LEGACY_COLD_STORAGE_HEADER}${key}`) {
            throw new ValidationError(`Cold-storage pointer no longer matches key: ${key}`)
          }

          const recoveredChat = readRecoveredChatArchive(chat, archive)
          const messages = ensureChatMessages(recoveredChat)
          for (const message of messages) {
            if (activeMessageIdExistsOutsideChat(innerDb, message.chatId, chatId)) {
              throw new ValidationError(`Duplicate message id outside recovered chat: ${message.chatId}`)
            }
          }

          writeSingleChatRow(innerDb, chatId, recoveredChat)
          replaceActiveChatMessages(innerDb, chatId, messages)
          if (Object.prototype.hasOwnProperty.call(recoveredChat, 'hypaV3Data')) {
            if (recoveredChat.hypaV3Data !== undefined && recoveredChat.hypaV3Data !== null) {
              setChatHypaV3(innerDb, chatId, recoveredChat.hypaV3Data)
            } else {
              deleteChatHypaV3(innerDb, chatId)
            }
          }

          const characterId = character.chaId as string
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.coldStorageChatRecovered,
              id: chatId,
              parentId: characterId,
            },
            extra: { chatId, characterId, chat: recoveredChat },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/chats/:chatId/generation-settings', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        chatId: string
        characterId: string
        generationSettings?: ChatGenerationSettings
        certificate?: string
        patchedKeys?: string[]
        deletedKeys?: string[]
        sidebarTogglePatchedKeys?: string[]
        sidebarToggleDeletedKeys?: string[]
        prunedSidebarToggleKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        mutate(database, innerDb) {
          const { target } = readStrictModuleCommandTarget(database)
          const characters = readStrictCharacterGraph(target)
          const { character, chat } = requireStrictChatLocation(characters, chatId)
          const write = readChatGenerationSettingsWrite(
            body,
            chat.generationSettings,
            buildChatGenerationSettingsValidationContext(target, character, chat),
          )
          chat.generationSettings = write.canonical
          writeSingleChatRow(innerDb, chatId, chat)
          const sparseReceipt = write.mode === 'sparse' ? buildChatGenerationSettingsSparseReceipt(write) : null
          return {
            event: { ...COMMAND_EVENT_CATALOG.chatUpdated, id: chatId, parentId: character.chaId },
            extra: {
              chatId,
              characterId: character.chaId,
              // Legacy full writes keep their authoritative response shape.
              // Sparse writes prove exact application with value-free key lists;
              // an unrepresentable future normalization falls back to the full value.
              ...(write.mode === 'full' || !sparseReceipt
                ? { generationSettings: chat.generationSettings }
                : sparseReceipt),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/chats/:chatId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        chatId: string
        selectedChatId: string | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        // Chat deletion works on metadata only; orphan message/hypa rows are
        // removed with targeted deletes. Global sibling id de-dup mutates the
        // clone only and is discarded.
        mutate(database, innerDb) {
          const target = ensureCharacterDatabaseObject(database)
          const characters = readStrictCharacterGraph(target)
          if (!chatIdExists(characters, chatId)) {
            const currentCharacterIndex = Number.isInteger(target.currentChar as number)
              ? (target.currentChar as number)
              : -1
            const currentCharacter = characters[currentCharacterIndex]
            return {
              event: { ...COMMAND_EVENT_CATALOG.chatDeleted, id: chatId },
              extra: {
                chatId,
                selectedChatId: currentCharacter ? selectedChatIdStrict(currentCharacter) : null,
              },
            }
          }
          const { character, chatIndex } = requireStrictChatLocation(characters, chatId)
          const chats = readStrictCharacterChats(character)
          if (chats.length <= 1) {
            throw new ValidationError('Cannot delete the only chat for a character')
          }
          const previousSelectedChatId = selectedChatIdStrict(character)
          chats.splice(chatIndex, 1)
          if (previousSelectedChatId && previousSelectedChatId !== chatId) {
            selectChatStrict(character, previousSelectedChatId)
          } else {
            character.chatPage = Math.min(chatIndex, chats.length - 1)
          }
          const characterId = character.chaId as string
          deleteCharacterChatRow(innerDb, chatId, characterId)
          writeCharacterChatRows(innerDb, characterId, chats as Record<string, unknown>[])
          writeSingleCharacterRow(innerDb, characterId, character)
          deleteChatMessages(innerDb, chatId)
          deleteChatHypaV3(innerDb, chatId)
          return {
            event: { ...COMMAND_EVENT_CATALOG.chatDeleted, id: chatId, parentId: character.chaId },
            extra: { chatId, selectedChatId: selectedChatIdStrict(character) },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/fork', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const sourceChatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const forkedChat = createChatRecord(body.chat)
      const forkedMessages = readReplacementMessages(forkedChat.message)
      forkedChat.message = forkedMessages
      const sourcePatch = body.sourcePatch === undefined ? {} : readChatPatch(body.sourcePatch, { allowEmpty: true })
      const folder = body.folder === undefined ? null : createChatFolderRecord(body.folder)
      const selectFork = readChatOptionalBoolean(body.select, 'select') ?? true
      const result = applyTargetedCommandMutation<{
        chatId: string
        sourceChatId: string
        selectedChatId: string | null
        generationSettings: object | null
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const { target, modules } = readStrictModuleCommandTarget(database)
          const characters = readStrictCharacterGraph(target)
          const { character, chatIndex } = requireStrictChatLocation(characters, sourceChatId)
          const previousSelectedChatId = selectedChatIdStrict(character)
          const chats = readStrictCharacterChats(character)
          const folders = readStrictChatFolders(character)
          if (folder) {
            if (chatFolderIdExists(characters, folder.id)) {
              throw new ValidationError(`Duplicate chat folder id: ${folder.id}`)
            }
            folders.unshift(folder)
          }
          if (sourcePatch.folderId) {
            if (!folders.some((existing) => existing.id === sourcePatch.folderId)) {
              throw new ValidationError(`Unknown chat folder id: ${sourcePatch.folderId}`)
            }
          }
          if (sourcePatch.modules) {
            validateNormalModuleLinks(modules, sourcePatch.modules as string[], 'sourcePatch.modules')
          }
          const inheritedGenerationSettings = cloneChatGenerationSettings(chats[chatIndex].generationSettings)
          chats[chatIndex] = {
            ...chats[chatIndex],
            ...sourcePatch,
            id: sourceChatId,
          }

          const nextChat = forkedChat
          if (chatIdExists(characters, nextChat.id)) {
            throw new ValidationError(`Duplicate chat id: ${nextChat.id}`)
          }
          // Message-id uniqueness is checked directly against the message store
          // with a targeted query; the fork path does not hydrate unrelated messages.
          for (const message of forkedMessages) {
            if (activeMessageIdExists(innerDb, message.chatId as string)) {
              throw new ValidationError(`Duplicate message id: ${message.chatId}`)
            }
          }
          if (nextChat.modules) {
            validateNormalModuleLinks(modules, nextChat.modules, 'chat.modules')
          }
          if (nextChat.folderId && !folders.some((existing) => existing.id === nextChat.folderId)) {
            throw new ValidationError(`Unknown chat folder id: ${nextChat.folderId}`)
          }
          if (Object.prototype.hasOwnProperty.call(nextChat, 'generationSettings')) {
            nextChat.generationSettings = readChatGenerationSettingsSave(
              nextChat.generationSettings,
              buildChatGenerationSettingsValidationContext(target, character, nextChat),
            )
          } else if (inheritedGenerationSettings) {
            nextChat.generationSettings = inheritedGenerationSettings
          }
          chats.unshift(nextChat)
          if (selectFork) {
            character.chatPage = 0
          } else if (previousSelectedChatId) {
            selectChatStrict(character, previousSelectedChatId)
          }
          // Surgical fork persistence, scoped to the source character: re-stamp
          // its existing chat-row positions (source chat's `sourcePatch` rides
          // along) — the `unshift`ed new chat is a no-op UPDATE until it is
          // INSERTed at position 0 — then persist the forked chat's messages to
          // the message store and write the character row (`chatPage`/folder).
          // Existing chats' messages are untouched (UPDATE, not DELETE+reINSERT).
          const characterId = character.chaId as string
          writeCharacterChatRows(innerDb, characterId, character.chats as Record<string, unknown>[])
          insertCharacterChatRow(innerDb, characterId, 0, nextChat as Record<string, unknown>)
          replaceActiveChatMessages(innerDb, nextChat.id, forkedMessages)
          if (nextChat.hypaV3Data !== undefined && nextChat.hypaV3Data !== null) {
            setChatHypaV3(innerDb, nextChat.id, nextChat.hypaV3Data)
          }
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...(forkedMessages.length > 0
                ? COMMAND_EVENT_CATALOG.chatForkedWithTranscript
                : COMMAND_EVENT_CATALOG.chatForked),
              id: nextChat.id,
              parentId: character.chaId,
            },
            extra: {
              chatId: nextChat.id,
              sourceChatId,
              selectedChatId: selectedChatIdStrict(character),
              generationSettings: nextChat.generationSettings ?? null,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/chats/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const chatIds = readChatIdList(body.chatIds)
      const folderByChatId = readOptionalFolderByChatId(body.folderByChatId)
      const selectedId =
        body.selectedChatId === undefined ? undefined : readChatId(body.selectedChatId, 'selectedChatId')
      const result = applyTargetedCommandMutation<{ selectedChatId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const characters = readStrictCharacterGraph(database)
          const character = characters[requireCharacterIndex(characters, characterId)]
          validateStrictFullChatOrder(character, chatIds, folderByChatId)
          const chats = readStrictCharacterChats(character)
          const chatById = new Map(chats.map((chat) => [chat.id, chat]))
          character.chats = chatIds.map((chatId) => {
            const chat = chatById.get(chatId)!
            if (Object.prototype.hasOwnProperty.call(folderByChatId, chatId)) {
              chat.folderId = folderByChatId[chatId]
            }
            return chat
          })
          if (selectedId) {
            selectChatStrict(character, selectedId)
          }
          // Reorder shifts only this character's chat-row positions (+ folderId
          // where folderByChatId moved a chat); the character row carries the
          // `chatPage` pointer. No other character or collection is touched.
          writeCharacterChatRows(innerDb, characterId, character.chats as Record<string, unknown>[])
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.chatReordered, parentId: characterId },
            extra: { selectedChatId: selectedChatIdStrict(character) },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/chat-folders', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ChatFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const folder = createChatFolderRecord(body.folder)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const characters = readStrictCharacterGraph(database)
          const character = characters[requireCharacterIndex(characters, characterId)]
          const folders = readStrictChatFolders(character)
          if (chatFolderIdExists(characters, folder.id)) {
            throw new ValidationError(`Duplicate chat folder id: ${folder.id}`)
          }
          // `chatFolders` lives in the character row.
          folders.unshift(folder)
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.chatFolderCreated,
              id: folder.id,
              parentId: characterId,
            },
            extra: { folderId: folder.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/chat-folders/:folderId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const folderId = readChatFolderId((req.params as { folderId?: unknown }).folderId)
      const body = (req.body ?? {}) as ChatFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readChatFolderPatch(body.patch)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const characters = readStrictCharacterGraph(database)
          const { character, folderIndex } = requireStrictChatFolderIndex(characters, folderId)
          const folders = readStrictChatFolders(character)
          folders[folderIndex] = {
            ...folders[folderIndex],
            ...patch,
            id: folderId,
          }
          writeSingleCharacterRow(innerDb, character.chaId as string, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.chatFolderUpdated,
              id: folderId,
              parentId: character.chaId,
            },
            extra: { folderId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/chat-folders/:folderId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const folderId = readChatFolderId((req.params as { folderId?: unknown }).folderId)
      const body = (req.body ?? {}) as ChatFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const characters = readStrictCharacterGraph(database)
          if (!chatFolderIdExists(characters, folderId)) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.chatFolderDeleted, id: folderId },
              extra: { folderId },
            }
          }
          const { character, folderIndex } = requireStrictChatFolderIndex(characters, folderId)
          const folders = readStrictChatFolders(character)
          folders.splice(folderIndex, 1)
          // The folder lives on the character row (`chatFolders`); deleting it
          // re-homes only the chat rows whose `folderId` pointed at it. Iterate
          // the already-validated `character.chats` directly.
          const reHomed: Record<string, unknown>[] = []
          for (const chat of character.chats as Record<string, unknown>[]) {
            if (chat.folderId === folderId) {
              chat.folderId = null
              reHomed.push(chat)
            }
          }
          writeSingleCharacterRow(innerDb, character.chaId as string, character)
          for (const chat of reHomed) {
            writeSingleChatRow(innerDb, chat.id as string, chat)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.chatFolderDeleted,
              id: folderId,
              parentId: character.chaId,
            },
            extra: { folderId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/chat-folders/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ChatFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const folderIds = readChatFolderIdList(body.folderIds)
      const selectedId =
        body.selectedChatId === undefined ? undefined : readChatId(body.selectedChatId, 'selectedChatId')
      const result = applyTargetedCommandMutation<{ selectedChatId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        mutate(database, innerDb) {
          const characters = readStrictCharacterGraph(database)
          const character = characters[requireCharacterIndex(characters, characterId)]
          validateStrictFullChatFolderOrder(character, folderIds)
          const folders = readStrictChatFolders(character)
          const folderById = new Map(folders.map((folder) => [folder.id, folder]))
          // `chatFolders` and `chatPage` (via selectChat) live in the character
          // row; reordering folders touches no chat row.
          character.chatFolders = folderIds.map((folderId) => folderById.get(folderId)!)
          if (selectedId) {
            selectChatStrict(character, selectedId)
          }
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.chatFolderReordered, parentId: characterId },
            extra: { selectedChatId: selectedChatIdStrict(character) },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/chats/:chatId/scriptstate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as ChatCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readChatScriptstatePatch(body.patch)
      const deleteKeys = readChatScriptstateDeleteKeys(body.deleteKeys)
      validateChatScriptstateCommand(patch, deleteKeys)
      const result = applyTargetedCommandMutation<{ chatId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        // This callback only locates + rewrites the one chat row.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, innerDb) {
          const characters = readScopedCharacterRecords(database)
          const { character, chat } = requireOrdinaryChatLocation(characters, chatId, innerDb)
          // This path updates only the chat row's `scriptstate`; sibling chat
          // normalization is validate-only.
          chat.scriptstate ??= {}
          for (const key of deleteKeys) {
            delete chat.scriptstate[key]
          }
          Object.assign(chat.scriptstate, patch)
          if (Object.keys(chat.scriptstate).length === 0) {
            delete chat.scriptstate
          }
          writeSingleChatRowExact(innerDb, chatId, chat)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.chatScriptstateUpdated,
              id: chatId,
              parentId: character.chaId,
            },
            extra: { chatId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/messages', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const message = createMessageRecord(body.message)
      const result = applyTargetedCommandMutation<{ chatId: string; messageId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // Chat is located for validation only; writes go to the message store.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          requireOrdinaryChatLocation(characters, chatId, targetDb)
          if (activeMessageIdExists(targetDb, message.chatId)) {
            throw new ValidationError(`Duplicate message id: ${message.chatId}`)
          }
          appendChatMessage(targetDb, chatId, message)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.messageAppended,
              id: message.chatId,
              parentId: chatId,
            },
            extra: { chatId, messageId: message.chatId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/messages/:messageId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const messageId = readMessageId((req.params as { messageId?: unknown }).messageId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readMessagePatch(body.patch)
      const expectedData = readOptionalMessageCondition(body.expectedData, 'expectedData', true)
      const expectedChatId = readOptionalMessageCondition(body.expectedChatId, 'expectedChatId')
      const expectedGenerationId = readOptionalMessageCondition(body.expectedGenerationId, 'expectedGenerationId')
      const igpEffect = readIgpMessageEffect(body.igpEffect)
      const igpLineage = igpEffect
        ? readDatabaseLineage(req.headers[DATABASE_LINEAGE_HEADER], DATABASE_LINEAGE_HEADER)
        : undefined
      if (
        igpEffect &&
        (Object.keys(patch).length !== 1 ||
          typeof patch.data !== 'string' ||
          expectedData === undefined ||
          expectedChatId === undefined)
      ) {
        throw new ValidationError('IGP commits require a data-only patch, expectedData and expectedChatId')
      }
      const result = applyTargetedCommandMutation<{ chatId: string; messageId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // The loader resolves the parent chat from the message id;
        // a missing message falls back broad and the callback throws as before.
        chatScopedRead: { messageId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          const resolved = resolveActiveMessageLocationById(targetDb, messageId)
          if (resolved.ok === false) {
            if (resolved.reason === 'ambiguous') {
              throw new ValidationError(`Ambiguous message id: ${messageId}`)
            }
            throw new EntityNotFoundError(`Message not found: ${messageId}`)
          }
          const { location } = resolved
          const { character } = requireOrdinaryChatLocation(characters, location.chatId, targetDb)
          readStrictStoredMessageRecord(location.message, messageId)
          const liveGenerationInfo = location.message.generationInfo
          const liveGenerationId =
            liveGenerationInfo && typeof liveGenerationInfo === 'object' && !Array.isArray(liveGenerationInfo)
              ? (liveGenerationInfo as Record<string, unknown>).generationId
              : undefined
          if (
            (expectedData !== undefined && location.message.data !== expectedData) ||
            (expectedChatId !== undefined && location.chatId !== expectedChatId) ||
            (expectedGenerationId !== undefined && liveGenerationId !== expectedGenerationId)
          ) {
            throw new ValidationError('message finalization precondition no longer matches')
          }
          if (
            igpEffect &&
            !completeClaimedIgpEffectInTransaction(targetDb, {
              ...igpEffect,
              databaseLineage: igpLineage!,
              characterId: character.chaId,
              chatId: location.chatId,
              messageId,
              message: location.message,
              expectedGenerationId,
            })
          ) {
            throw new ValidationError('IGP effect claim or message identity no longer matches')
          }
          const updated = updateActiveMessageById(targetDb, messageId, patch)
          if (updated.ok === false) {
            if (updated.reason === 'ambiguous') {
              throw new ValidationError(`Ambiguous message id: ${messageId}`)
            }
            throw new EntityNotFoundError(`Message not found: ${messageId}`)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.messageUpdated,
              id: messageId,
              parentId: updated.chatId,
            },
            extra: { chatId: updated.chatId, messageId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/messages/:messageId/translate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const messageId = readMessageId((req.params as { messageId?: unknown }).messageId)
      const body = (req.body ?? {}) as MessageCommandBody
      // Keep validating the command envelope, but translation uses the message
      // text itself as its concurrency precondition. Holding the global
      // revision across a provider request would block or conflict with every
      // unrelated edit made while translation is running.
      readBaseRevision(body)
      const requestedJobId = readOptionalMessageTranslationJobId(body.jobId)
      return await runServerMessageTranslation({
        db,
        dataDir,
        messageTranslationJobs,
        messageId,
        ...(requestedJobId ? { jobId: requestedJobId } : {}),
        ...commandMutationContext(req, eventSink),
      })
    } catch (err) {
      if (
        err instanceof RevisionMismatchError ||
        err instanceof ValidationError ||
        err instanceof EntityNotFoundError
      ) {
        return sendCommandError(reply, err)
      }
      const message = err instanceof Error && err.message.length > 0 ? err.message : String(err)
      return sendCommandError(reply, new ValidationError(message || 'Message translation failed'))
    }
  })

  app.delete('/api/v1/commands/messages/:messageId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const messageId = readMessageId((req.params as { messageId?: unknown }).messageId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ chatId: string; messageId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // Same message-id-resolved scoped read as the PATCH route.
        chatScopedRead: { messageId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          const resolved = resolveActiveMessageLocationById(targetDb, messageId)
          if (resolved.ok === false) {
            if (resolved.reason === 'ambiguous') {
              throw new ValidationError(`Ambiguous message id: ${messageId}`)
            }
            throw new EntityNotFoundError(`Message not found: ${messageId}`)
          }
          const { location } = resolved
          const { chat } = requireOrdinaryChatLocation(characters, location.chatId, targetDb)
          const deleted = deleteActiveMessageById(targetDb, messageId)
          if (deleted.ok === false) {
            if (deleted.reason === 'ambiguous') {
              throw new ValidationError(`Ambiguous message id: ${messageId}`)
            }
            throw new EntityNotFoundError(`Message not found: ${messageId}`)
          }
          pruneChatBookmarkMetadata(targetDb, chat, getChatMessages(targetDb, deleted.chatId))
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.messageDeleted,
              id: messageId,
              parentId: deleted.chatId,
            },
            extra: { chatId: deleted.chatId, messageId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/messages/truncate', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const afterMessageId = readTruncateAfterMessageId(body)
      if (Object.prototype.hasOwnProperty.call(body, 'preserveRemovedAsAlternates')) {
        throw new ValidationError('preserveRemovedAsAlternates is no longer supported')
      }
      const result = applyTargetedCommandMutation<{
        chatId: string
        afterMessageId: string | null
        removedCount: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // Chat is located for validation only; truncate hits the message store.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          const { chat } = requireOrdinaryChatLocation(characters, chatId, targetDb)
          const truncated = truncateActiveChatMessages(targetDb, chatId, afterMessageId)
          if (truncated.ok === false) {
            if (truncated.reason === 'ambiguous-after') {
              throw new ValidationError(`Ambiguous message id: ${truncated.afterMessageId}`)
            }
            throw new EntityNotFoundError(`Message not found for chat ${chatId}: ${truncated.afterMessageId}`)
          }
          pruneChatBookmarkMetadata(targetDb, chat, getChatMessages(targetDb, chatId))
          return {
            event: { ...COMMAND_EVENT_CATALOG.messageTruncated, parentId: chatId },
            extra: { chatId, afterMessageId, removedCount: truncated.removedCount },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/messages/tail', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const afterMessageId = readTruncateAfterMessageId(body)
      const replacement = readReplacementMessages(body.messages)
      const result = applyTargetedCommandMutation<{
        chatId: string
        afterMessageId: string | null
        replacedCount: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // Chat is located for validation only; replacement hits the message store.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          const { chat } = requireOrdinaryChatLocation(characters, chatId, targetDb)
          const base = getChatMessages(targetDb, chatId)
          let keepCount = 0
          if (afterMessageId !== null) {
            const resolved = resolveChatMessageIndexById(base, afterMessageId)
            if (resolved.ok === false) {
              if (resolved.reason === 'ambiguous') {
                throw new ValidationError(`Ambiguous message id: ${afterMessageId}`)
              }
              throw new EntityNotFoundError(`Message not found for chat ${chatId}: ${afterMessageId}`)
            }
            keepCount = resolved.index + 1
          }
          const next = [...base.slice(0, keepCount), ...replacement]
          validateUniqueMessageIds(next as MessageRecord[])
          for (const message of replacement) {
            if (activeMessageIdExistsOutsideChat(targetDb, message.chatId, chatId)) {
              throw new ValidationError(`Duplicate message id: ${message.chatId}`)
            }
          }
          replaceActiveChatMessages(targetDb, chatId, next)
          pruneChatBookmarkMetadata(targetDb, chat, next)
          return {
            event: { ...COMMAND_EVENT_CATALOG.messagesReplaced, parentId: chatId },
            extra: {
              chatId,
              afterMessageId,
              replacedCount: base.length - keepCount,
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/chats/:chatId/messages', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const replacement = readReplacementMessages(body.messages)
      const result = applyTargetedCommandMutation<{ chatId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-message',
        // Chat is located for validation only; replacement hits the message store.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          const { chat } = requireOrdinaryChatLocation(characters, chatId, targetDb)
          validateUniqueMessageIds(replacement)
          for (const message of replacement) {
            if (activeMessageIdExistsOutsideChat(targetDb, message.chatId, chatId)) {
              throw new ValidationError(`Duplicate message id: ${message.chatId}`)
            }
          }
          replaceActiveChatMessages(targetDb, chatId, replacement)
          pruneChatBookmarkMetadata(targetDb, chat, replacement)
          return {
            event: { ...COMMAND_EVENT_CATALOG.messagesReplaced, parentId: chatId },
            extra: { chatId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/generation-result', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as MessageCommandBody
      const baseRevision = readBaseRevision(body)
      const generationResult = readGenerationResult(body.generationResult)
      const result = applyTargetedCommandMutation<{ chatId: string; messageId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: 'targeted-generation',
        // Chat is located for validation only; persistence hits the message store.
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, targetDb) {
          const characters = readScopedCharacterRecords(database)
          requireOrdinaryChatLocation(characters, chatId, targetDb)
          const write = writeGenerationChatMessage(
            targetDb,
            chatId,
            generationResult.message,
            generationResult.targetMessageId,
          )
          if (write.ok === false) {
            switch (write.reason) {
              case 'missing-target':
                throw new EntityNotFoundError(`Message not found for chat ${chatId}: ${write.targetMessageId}`)
              case 'duplicate':
                throw new ValidationError(`Duplicate message id: ${write.messageId}`)
              case 'ambiguous':
                throw new ValidationError(`Ambiguous message id: ${write.messageId}`)
            }
          }
          if (generationResult.targetMessageId || write.displaced) {
            if (write.displaced) addAlternateMessage(targetDb, chatId, write.displaced)
            addAlternateMessage(targetDb, chatId, generationResult.message)
          } else {
            clearAlternateMessages(targetDb, chatId)
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.generationPersisted,
              id: write.messageId,
              parentId: chatId,
            },
            extra: { chatId, messageId: write.messageId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/lorebooks', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as { baseRevision?: unknown; lorebook?: unknown }
      const baseRevision = readBaseRevision(body)
      // Validate-only constructor rejects missing entry ids rather than minting them.
      const lorebook = validateGlobalLorebookCreate(body.lorebook)
      const result = applyTargetedCommandMutation<{ lorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { target, lorebooks } = readGlobalLorebookCommandTarget(database)
          lorebooks.forEach((candidate, index) => validateStoredGlobalLorebook(candidate, `loreBook[${index}]`))
          const beforeLoreBookPage = target.loreBookPage
          if (lorebooks.some((candidate) => candidate.id === lorebook.id)) {
            throw new ValidationError(`Duplicate lorebook id: ${lorebook.id}`)
          }
          lorebooks.push(lorebook)
          // The global lorebook collection rewrite is faithful; child lorebook
          // repair remains a broad import/restore concern.
          writeLorebookTableMutation(innerDb, target, lorebooks, beforeLoreBookPage)
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookCreated, id: lorebook.id },
            extra: { lorebookId: lorebook.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/lorebooks/:lorebookId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const lorebookId = readLorebookId((req.params as { lorebookId?: unknown }).lorebookId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; patch?: unknown }
      const baseRevision = readBaseRevision(body)
      const patch = readGlobalLorebookPatch(body.patch)
      const result = applyTargetedCommandMutation<{ lorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = requireGlobalLorebookIndex(lorebooks, lorebookId)
          validateStoredGlobalLorebook(lorebooks[index], `loreBook[${index}]`)
          Object.assign(lorebooks[index], patch)
          // The clean case: one lorebook's metadata, no pointer move, no child
          // repair persisted — a single-row UPDATE.
          writeSingleCollectionRow(innerDb, 'loreBook', index, lorebooks[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookUpdated, id: lorebookId },
            extra: { lorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/lorebooks/:lorebookId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const lorebookId = readLorebookId((req.params as { lorebookId?: unknown }).lorebookId)
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ lorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { target, lorebooks } = readGlobalLorebookCommandTarget(database)
          const beforeLoreBookPage = target.loreBookPage
          const index = lorebooks.findIndex((lorebook) => lorebook.id === lorebookId)
          if (index === -1) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.lorebookDeleted, id: lorebookId },
              extra: { lorebookId },
            }
          }
          lorebooks.forEach((candidate, candidateIndex) =>
            validateStoredGlobalLorebook(candidate, `loreBook[${candidateIndex}]`),
          )
          if (lorebooks.length === 1) {
            throw new ValidationError('Cannot delete the last lorebook')
          }
          lorebooks.splice(index, 1)
          target.loreBookPage = 0
          writeLorebookTableMutation(innerDb, target, lorebooks, beforeLoreBookPage)
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookDeleted, id: lorebookId },
            extra: { lorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/lorebooks/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as { baseRevision?: unknown; lorebookIds?: unknown }
      const baseRevision = readBaseRevision(body)
      const lorebookIds = readLorebookIdList(body.lorebookIds)
      const result = applyTargetedCommandMutation<{ selectedLorebookId: string | null }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { target, lorebooks } = readGlobalLorebookCommandTarget(database)
          lorebooks.forEach((candidate, index) => validateStoredGlobalLorebook(candidate, `loreBook[${index}]`))
          const beforeLoreBookPage = target.loreBookPage
          validateFullLorebookOrder(lorebooks, lorebookIds)
          const byId = new Map(lorebooks.map((lorebook) => [lorebook.id, lorebook]))
          const reordered = lorebookIds.map((id) => byId.get(id))
          target.loreBook = reordered
          const currentPage = Number.isInteger(target.loreBookPage as number) ? (target.loreBookPage as number) : 0
          const selectedLorebookId = lorebooks[currentPage]?.id ?? null
          target.loreBookPage = Math.max(
            0,
            lorebookIds.findIndex((id) => id === selectedLorebookId),
          )
          writeLorebookTableMutation(innerDb, target, reordered, beforeLoreBookPage)
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookReordered },
            extra: { selectedLorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/lorebooks/:lorebookId/select', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const lorebookId = readLorebookId((req.params as { lorebookId?: unknown }).lorebookId)
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ selectedLorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { target, lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = requireGlobalLorebookIndex(lorebooks, lorebookId)
          // `loreBookPage` is a settings scalar; child lorebook repair remains
          // a broad import/restore concern.
          target.loreBookPage = index
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookSelected, id: lorebookId },
            extra: { selectedLorebookId: lorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/lorebooks/:lorebookId/entries', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const lorebookId = readLorebookId((req.params as { lorebookId?: unknown }).lorebookId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entries?: unknown }
      const baseRevision = readBaseRevision(body)
      const entries = validateLorebookEntries(body.entries)
      const result = applyTargetedCommandMutation<{ lorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = requireGlobalLorebookIndex(lorebooks, lorebookId)
          validateStoredGlobalLorebook(lorebooks[index], `loreBook[${index}]`)
          lorebooks[index].data = entries
          // Replacing one lorebook's entries: no pointer move, no child repair
          // persisted — a single-row UPDATE.
          writeSingleCollectionRow(innerDb, 'loreBook', index, lorebooks[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
            extra: { lorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/lorebooks/:lorebookId/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { lorebookId?: unknown; entryId?: unknown }
      const lorebookId = readLorebookId(params.lorebookId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryWrite = readLorebookEntryWrite(body, entryId)
      const result = applyTargetedCommandMutation<{
        lorebookId: string
        entryId: string
        entryIndex: number
        created: boolean
        patchedKeys?: string[]
        deletedKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = requireGlobalLorebookIndex(lorebooks, lorebookId)
          validateStoredGlobalLorebook(lorebooks[index], `loreBook[${index}]`)
          const written = applyLorebookEntryWriteById(lorebooks[index].data, entryId, entryWrite)
          const certified = written.patchedKeys && written.deletedKeys
          writeSingleCollectionRow(innerDb, 'loreBook', index, lorebooks[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
            extra: {
              lorebookId,
              entryId,
              entryIndex: written.index,
              created: written.created,
              ...(certified ? { patchedKeys: written.patchedKeys, deletedKeys: written.deletedKeys } : {}),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/lorebooks/:lorebookId/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { lorebookId?: unknown; entryId?: unknown }
      const lorebookId = readLorebookId(params.lorebookId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        lorebookId: string
        entryId: string
        entryIndex: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = lorebooks.findIndex((lorebook) => lorebook.id === lorebookId)
          if (index === -1) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
              extra: { lorebookId, entryId, entryIndex: -1 },
            }
          }
          validateStoredGlobalLorebook(lorebooks[index], `loreBook[${index}]`)
          if (!lorebooks[index].data.some((entry) => entry.id === entryId)) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
              extra: { lorebookId, entryId, entryIndex: -1 },
            }
          }
          const deleted = deleteLorebookEntryById(lorebooks[index].data, entryId)
          writeSingleCollectionRow(innerDb, 'loreBook', index, lorebooks[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
            extra: { lorebookId, entryId, entryIndex: deleted.index },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/lorebooks/:lorebookId/entries/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const lorebookId = readLorebookId((req.params as { lorebookId?: unknown }).lorebookId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entryIds?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryIds = readLorebookIdList(body.entryIds, 'entryIds')
      const result = applyTargetedCommandMutation<{ lorebookId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.lorebooks,
        mutate(database, innerDb) {
          const { lorebooks } = readGlobalLorebookCommandTarget(database)
          const index = requireGlobalLorebookIndex(lorebooks, lorebookId)
          validateStoredGlobalLorebook(lorebooks[index], `loreBook[${index}]`)
          reorderLorebookEntriesById(lorebooks[index].data, entryIds)
          writeSingleCollectionRow(innerDb, 'loreBook', index, lorebooks[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced, id: lorebookId },
            extra: { lorebookId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/characters/:characterId/lorebooks', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readLorebookCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entries?: unknown }
      const baseRevision = readBaseRevision(body)
      const entries = validateLorebookEntries(body.entries)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const { character } = normalizeSelectedCharacterLorebooks(database, characterId)
          character.globalLore = entries
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            // `globalLore` lives in one character row; a foreign refresh ships
            // only that character via the per-character `characterLorebook`
            // resource (not the broad global `lorebook` re-ship).
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: characterId,
              resource: 'characterLorebook',
            },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/characters/:characterId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { characterId?: unknown; entryId?: unknown }
      const characterId = readLorebookCharacterId(params.characterId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryWrite = readLorebookEntryWrite(body, entryId)
      const result = applyTargetedCommandMutation<{
        characterId: string
        entryId: string
        entryIndex: number
        created: boolean
        patchedKeys?: string[]
        deletedKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const { character, entries } = normalizeSelectedCharacterLorebooks(database, characterId)
          const written = applyLorebookEntryWriteById(entries, entryId, entryWrite)
          character.globalLore = entries
          const certified = written.patchedKeys && written.deletedKeys
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: characterId,
              resource: 'characterLorebook',
            },
            extra: {
              characterId,
              entryId,
              entryIndex: written.index,
              created: written.created,
              ...(certified ? { patchedKeys: written.patchedKeys, deletedKeys: written.deletedKeys } : {}),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/characters/:characterId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { characterId?: unknown; entryId?: unknown }
      const characterId = readLorebookCharacterId(params.characterId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        characterId: string
        entryId: string
        entryIndex: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const rawTarget = readJsonObject(database, 'database')
          if (!findJsonRecordById(rawTarget.characters, characterId, 'chaId')) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: characterId,
                resource: 'characterLorebook',
              },
              extra: { characterId, entryId, entryIndex: -1 },
            }
          }
          const { character, entries } = normalizeSelectedCharacterLorebooks(database, characterId)
          if (!entries.some((entry) => entry.id === entryId)) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: characterId,
                resource: 'characterLorebook',
              },
              extra: { characterId, entryId, entryIndex: -1 },
            }
          }
          const deleted = deleteLorebookEntryById(entries, entryId)
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: characterId,
              resource: 'characterLorebook',
            },
            extra: { characterId, entryId, entryIndex: deleted.index },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/lorebooks/entries/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readLorebookCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entryIds?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryIds = readLorebookIdList(body.entryIds, 'entryIds')
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const { character, entries } = normalizeSelectedCharacterLorebooks(database, characterId)
          reorderLorebookEntriesById(entries, entryIds)
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: characterId,
              resource: 'characterLorebook',
            },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/chats/:chatId/lorebooks', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readLorebookChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entries?: unknown }
      const baseRevision = readBaseRevision(body)
      const entries = validateLorebookEntries(body.entries)
      const result = applyTargetedCommandMutation<{ chatId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, innerDb) {
          const { chat, parentId } = normalizeSelectedChatLorebooks(database, chatId)
          chat.localLore = entries
          writeSingleChatRowExact(innerDb, chatId, chat)
          return {
            // `localLore` lives in one chat row, so refresh only its parent
            // character instead of the broad global lorebook projection.
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: chatId,
              parentId,
              resource: 'characterRow',
            },
            extra: { chatId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/chats/:chatId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { chatId?: unknown; entryId?: unknown }
      const chatId = readLorebookChatId(params.chatId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryWrite = readLorebookEntryWrite(body, entryId)
      const result = applyTargetedCommandMutation<{
        chatId: string
        entryId: string
        entryIndex: number
        created: boolean
        patchedKeys?: string[]
        deletedKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, innerDb) {
          const { chat, entries, parentId } = normalizeSelectedChatLorebooks(database, chatId)
          const written = applyLorebookEntryWriteById(entries, entryId, entryWrite)
          chat.localLore = entries
          const certified = written.patchedKeys && written.deletedKeys
          writeSingleChatRowExact(innerDb, chatId, chat)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: chatId,
              parentId,
              resource: 'characterRow',
            },
            extra: {
              chatId,
              entryId,
              entryIndex: written.index,
              created: written.created,
              ...(certified ? { patchedKeys: written.patchedKeys, deletedKeys: written.deletedKeys } : {}),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/chats/:chatId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { chatId?: unknown; entryId?: unknown }
      const chatId = readLorebookChatId(params.chatId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        chatId: string
        entryId: string
        entryIndex: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, innerDb) {
          const rawTarget = readJsonObject(database, 'database')
          if (!findRawChatRecord(rawTarget, chatId)) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: chatId,
                resource: 'characterRow',
              },
              extra: { chatId, entryId, entryIndex: -1 },
            }
          }
          const { chat, entries, parentId } = normalizeSelectedChatLorebooks(database, chatId)
          if (!entries.some((entry) => entry.id === entryId)) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: chatId,
                parentId,
                resource: 'characterRow',
              },
              extra: { chatId, entryId, entryIndex: -1 },
            }
          }
          const deleted = deleteLorebookEntryById(entries, entryId)
          writeSingleChatRowExact(innerDb, chatId, chat)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: chatId,
              parentId,
              resource: 'characterRow',
            },
            extra: { chatId, entryId, entryIndex: deleted.index },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/chats/:chatId/lorebooks/entries/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readLorebookChatId((req.params as { chatId?: unknown }).chatId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entryIds?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryIds = readLorebookIdList(body.entryIds, 'entryIds')
      const result = applyTargetedCommandMutation<{ chatId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.chatRow,
        chatScopedRead: { chatId, exactChatRow: true },
        mutate(database, innerDb) {
          const { chat, entries, parentId } = normalizeSelectedChatLorebooks(database, chatId)
          reorderLorebookEntriesById(entries, entryIds)
          writeSingleChatRowExact(innerDb, chatId, chat)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: chatId,
              parentId,
              resource: 'characterRow',
            },
            extra: { chatId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/module-folders', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModuleFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const folder = createModuleFolderRecord(body.folder)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const folders = readStrictModuleFolders(target)
          if (folders.some((candidate) => candidate.id === folder.id)) {
            throw new ValidationError(`Module folder already exists: ${folder.id}`)
          }
          folders.push(folder)
          target.moduleFolders = folders
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleFolderCreated, id: folder.id },
            extra: { folderId: folder.id },
          }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/module-folders/:folderId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const folderId = readCommandModuleId((req.params as { folderId?: unknown }).folderId, 'folderId')
      const body = (req.body ?? {}) as ModuleFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readModuleFolderPatch(body.patch)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const folders = readStrictModuleFolders(target)
          const matches = folders
            .map((folder, index) => ({ folder, index }))
            .filter(({ folder }) => folder.id === folderId)
          if (matches.length === 0) throw new EntityNotFoundError(`Module folder not found: ${folderId}`)
          if (matches.length !== 1) throw new ValidationError(`Duplicate module folder id: ${folderId}`)
          folders[matches[0].index] = { ...matches[0].folder, ...patch, id: folderId }
          target.moduleFolders = folders
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleFolderUpdated, id: folderId },
            extra: { folderId },
          }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/module-folders/:folderId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const folderId = readCommandModuleId((req.params as { folderId?: unknown }).folderId, 'folderId')
      const body = (req.body ?? {}) as ModuleFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ folderId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.crossOwner,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const folders = readStrictModuleFolders(target)
          const matches = folders
            .map((folder, index) => ({ folder, index }))
            .filter(({ folder }) => folder.id === folderId)
          if (matches.length === 0) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.moduleFolderDeleted, id: folderId },
              extra: { folderId },
            }
          }
          if (matches.length !== 1) throw new ValidationError(`Duplicate module folder id: ${folderId}`)
          folders.splice(matches[0].index, 1)
          target.moduleFolders = folders

          const modules = readStrictModuleRecords(target)
          let modulesChanged = false
          for (const module of modules) {
            if (module.folderId !== folderId) continue
            delete module.folderId
            modulesChanged = true
          }
          writeSettingsOnly(innerDb, extractSettings(target))
          if (modulesChanged) writeSingleCollectionTable(innerDb, 'modules', modules)
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleFolderDeleted, id: folderId },
            extra: { folderId },
          }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/module-folders/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModuleFolderCommandBody
      const baseRevision = readBaseRevision(body)
      const folderIds = readModuleFolderIdList(body.folderIds)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const folders = readStrictModuleFolders(target)
          validateFullModuleFolderOrder(folders, folderIds)
          const byId = new Map(folders.map((folder) => [folder.id, folder]))
          target.moduleFolders = folderIds.map((folderId) => byId.get(folderId)!)
          writeSettingsOnly(innerDb, extractSettings(target))
          return { event: { ...COMMAND_EVENT_CATALOG.moduleFolderReordered } }
        },
      })

      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/modules', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const module = createModuleRecord(body.module, 'module', { allowMcp: true }, { assetDb: db })
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          modules.forEach((candidate, index) =>
            validateStoredModuleRecord(candidate, `module[${index}]`, { allowMcp: true }),
          )
          if (modules.some((candidate) => candidate.id === module.id)) {
            throw new ValidationError(`Module already exists: ${module.id}`)
          }
          validateModuleFolderReference(module, readStrictModuleFolders(target))
          modules.push(module)
          writeSingleCollectionTable(innerDb, 'modules', modules)
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleCreated, id: module.id },
            extra: { moduleId: module.id },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/modules/:moduleId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readCommandModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readModulePatch(body.patch, { assetDb: db })
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          const index = requireModuleIndex(modules, moduleId)
          validateStoredModuleRecord(modules[index], `module ${moduleId}`)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete modules[index][key]
            } else {
              modules[index][key] = value
            }
          }
          validateModuleFolderReference(modules[index], readStrictModuleFolders(target), `module ${moduleId}`)
          validateStoredModuleRecord(modules[index], `module ${moduleId}`)
          writeSingleCollectionRow(innerDb, 'modules', index, modules[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleUpdated, id: moduleId },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/modules/:moduleId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readCommandModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.crossOwner,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          const index = modules.findIndex((module) => module.id === moduleId)
          if (index === -1) {
            return {
              event: { ...COMMAND_EVENT_CATALOG.moduleDeleted, id: moduleId },
              extra: { moduleId },
            }
          }
          validateStoredModuleRecord(modules[index], `module ${moduleId}`, { allowMcp: true })
          modules.splice(index, 1)
          const removed = removeModuleReferences(target, moduleId)
          writeSingleCollectionTable(innerDb, 'modules', modules)
          if (removed.settingsChanged) writeSettingsOnly(innerDb, extractSettings(target))
          for (const changedIndex of removed.changedPersonaIndexes) {
            writeSingleCollectionRow(innerDb, 'personas', changedIndex, asArray(target.personas)[changedIndex])
          }
          for (const changedIndex of removed.changedLoadoutIndexes) {
            writeSingleCollectionRow(innerDb, 'loadouts', changedIndex, asArray(target.loadouts)[changedIndex])
          }
          for (const changed of removed.changedCharacters) {
            writeSingleCharacterRow(innerDb, changed.characterId, changed.character)
          }
          for (const changed of removed.changedChats) {
            writeSingleChatRowExact(innerDb, changed.chatId, changed.chat)
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleDeleted, id: moduleId },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/modules/enable', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const moduleId = readCommandModuleId(body.moduleId)
      const enabled = readModuleEnabled(body.enabled)
      const result = applyTargetedCommandMutation<{ moduleId: string; enabled: boolean }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          const index = requireModuleIndex(modules, moduleId, { allowMcp: true })
          validateStoredModuleRecord(modules[index], `module ${moduleId}`, { allowMcp: true })
          const enabledModules = new Set(readStrictEnabledModules(target))
          if (enabled) {
            enabledModules.add(moduleId)
          } else {
            enabledModules.delete(moduleId)
          }
          // `enabledModules` is a settings scalar; the event carries the narrow
          // `moduleEnabled` resource so a foreign refresh ships only it.
          target.enabledModules = Array.from(enabledModules)
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleEnabled, id: moduleId },
            extra: { moduleId, enabled },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/modules/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const moduleIds = readModuleIdList(body.moduleIds)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          modules.forEach((candidate, index) =>
            validateStoredModuleRecord(candidate, `module[${index}]`, { allowMcp: true }),
          )
          validateFullModuleOrder(modules, moduleIds)
          const folderByModuleId =
            body.folderByModuleId === undefined
              ? null
              : readModuleFolderAssignments(body.folderByModuleId, modules, readStrictModuleFolders(target))
          const byId = new Map(modules.map((module) => [module.id, module]))
          const reordered = moduleIds.map((id) => {
            const module = byId.get(id)!
            if (folderByModuleId) {
              const folderId = folderByModuleId[id]
              if (folderId === null) delete module.folderId
              else module.folderId = folderId
            }
            return module
          })
          target.modules = reordered
          writeSingleCollectionTable(innerDb, 'modules', reordered)
          return {
            event: { ...COMMAND_EVENT_CATALOG.moduleReordered },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/characters/:characterId/modules/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readModuleCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ModuleCommandBody
      const baseRevision = readBaseRevision(body)
      const moduleIds = readModuleIdList(body.moduleIds)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: {
          characterId,
          exactCharacterRow: true,
          collectionFields: COLLECTION_SCOPED_READS.modules,
        },
        mutate(database, innerDb) {
          const target = readJsonObject(database, 'database')
          const modules = readStrictModuleRecords(target)
          const character = findCharacterForModuleCommand(target, characterId)
          validateCharacterModuleLinks(modules, moduleIds)
          character.modules = moduleIds
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.characterModulesReordered,
              id: characterId,
            },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/plugins', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const plugin = createPluginRecord(body.plugin)
      const result = applyTargetedCommandMutation<{ pluginId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.plugins,
        mutate(database, innerDb) {
          const { plugins } = readStrictPluginCommandTarget(database)
          if (plugins.some((candidate) => candidate.name === plugin.name)) {
            throw new ValidationError(`Plugin already exists: ${plugin.name}`)
          }
          plugins.push(plugin)
          writeSingleCollectionTable(innerDb, 'plugins', plugins)
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginCreated, id: plugin.name },
            extra: { pluginId: plugin.name },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/plugins/:pluginId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const pluginId = readPluginId((req.params as { pluginId?: unknown }).pluginId)
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readPluginPatch(body.patch)
      const result = applyTargetedCommandMutation<{ pluginId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.plugins,
        mutate(database, innerDb) {
          const { plugins } = readStrictPluginCommandTarget(database)
          const index = requirePluginIndex(plugins, pluginId)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete plugins[index][key]
            } else {
              plugins[index][key] = value
            }
          }
          writeSingleCollectionRow(innerDb, 'plugins', index, plugins[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginUpdated, id: pluginId },
            extra: { pluginId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/plugins/:pluginId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const pluginId = readPluginId((req.params as { pluginId?: unknown }).pluginId)
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ pluginId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.plugins,
        mutate(database, innerDb) {
          const { target, plugins } = readStrictPluginCommandTarget(database)
          const index = requirePluginIndex(plugins, pluginId)
          plugins.splice(index, 1)
          // The deleted plugin shifts later positions, so rewrite the one table.
          writeSingleCollectionTable(innerDb, 'plugins', plugins)
          // `currentPluginProvider` is a settings scalar; co-write settings only
          // when deleting the active provider clears the pointer.
          const clearsProvider = target.currentPluginProvider === pluginId
          if (clearsProvider) {
            target.currentPluginProvider = ''
            writeSettingsOnly(innerDb, extractSettings(target))
          }
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.pluginDeleted,
              // Clearing the active provider is the sole plugin-record command
              // that also changes settings. Keep authoritative reconciliation
              // for both affected slices without reading unrelated settings.
              ...(clearsProvider ? { resource: 'pluginCollectionWithProvider' } : {}),
              id: pluginId,
            },
            extra: { pluginId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/plugins/:pluginId/enable', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const pluginId = readPluginId((req.params as { pluginId?: unknown }).pluginId)
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const enabled = readPluginEnabled(body.enabled)
      const result = applyTargetedCommandMutation<{ pluginId: string; enabled: boolean }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.plugins,
        mutate(database, innerDb) {
          const { plugins } = readStrictPluginCommandTarget(database)
          const index = requirePluginIndex(plugins, pluginId)
          plugins[index].enabled = enabled
          writeSingleCollectionRow(innerDb, 'plugins', index, plugins[index])
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginEnabled, id: pluginId },
            extra: { pluginId, enabled },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/plugins/provider', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const provider = readPluginProvider(body.provider)
      const result = applyTargetedCommandMutation<{ provider: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.settings,
        settingsScopedRead: true,
        mutate(database, innerDb) {
          const target = readStrictPluginProviderTarget(database)
          target.currentPluginProvider = provider
          writeSettingsOnly(innerDb, extractSettings(target))
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginProviderSelected, id: provider },
            extra: { provider },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/plugins/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PluginCommandBody
      const baseRevision = readBaseRevision(body)
      const pluginIds = readPluginIdList(body.pluginIds)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.plugins,
        mutate(database, innerDb) {
          const { target, plugins } = readStrictPluginCommandTarget(database)
          validateFullPluginOrder(plugins, pluginIds)
          const byId = new Map(plugins.map((plugin) => [plugin.name, plugin]))
          const reordered = pluginIds.map((id) => byId.get(id))
          target.plugins = reordered
          writeSingleCollectionTable(innerDb, 'plugins', reordered)
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginReordered },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/inlay-assets/:assetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const assetId = readInlayCatalogAssetId((req.params as { assetId?: unknown }).assetId)
      const body = (req.body ?? {}) as InlayCatalogCommandBody
      const baseRevision = readBaseRevision(body)
      const name = readInlayCatalogName(body.name)
      const aliases = readInlayCatalogAliases(body.aliases)
      const width = readInlayCatalogDimension(body.width, 'width')
      const height = readInlayCatalogDimension(body.height, 'height')
      const result = applyTargetedCommandMutation<{ asset: ReturnType<typeof upsertInlayCatalogEntry> }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.inlayCatalog,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const asset = upsertInlayCatalogEntry(innerDb, { assetId, aliases, name, width, height })
          return {
            event: { ...COMMAND_EVENT_CATALOG.inlayCatalogUpserted, id: assetId },
            extra: { asset },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/inlay-assets/:assetId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const assetId = readInlayCatalogAssetId((req.params as { assetId?: unknown }).assetId)
      const body = (req.body ?? {}) as InlayCatalogCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ assetId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.inlayCatalog,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          if (!deleteInlayCatalogEntry(innerDb, assetId)) {
            throw new EntityNotFoundError(`Inlay catalog asset not found: ${assetId}`)
          }
          return {
            event: { ...COMMAND_EVENT_CATALOG.inlayCatalogDeleted, id: assetId },
            extra: { assetId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/plugin-storage/:key', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const key = readPluginStorageKey((req.params as { key?: unknown }).key)
      const body = (req.body ?? {}) as PluginStorageCommandBody
      const baseRevision = readBaseRevision(body)
      const value = readPluginStorageValue(body.value)
      const result = applyTargetedCommandMutation<{ key: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.pluginStorage,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          writePluginStorageKey(innerDb, key, value)
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginStorageUpdated, id: key },
            extra: { key },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/plugin-storage/:key', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const key = readPluginStorageKey((req.params as { key?: unknown }).key)
      const body = (req.body ?? {}) as PluginStorageCommandBody
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{ key: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.pluginStorage,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          deletePluginStorageKey(innerDb, key)
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginStorageDeleted, id: key },
            extra: { key },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/plugin-storage/bulk', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const body = (req.body ?? {}) as PluginStorageCommandBody
      const baseRevision = readBaseRevision(body)
      const patch = readPluginStorageBulkPatch(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.pluginStorage,
        mutate(database, innerDb) {
          const { storage: currentStorage } = readStrictPluginStorageTarget(database)
          const storage = patch.clear ? {} : { ...currentStorage }
          for (const key of patch.deleteKeys) {
            delete storage[key]
          }
          for (const [key, value] of Object.entries(patch.values)) {
            storage[key] = value
          }
          replacePluginStorage(innerDb, storage)
          return {
            event: { ...COMMAND_EVENT_CATALOG.pluginStorageBulkUpdated },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/modules/:moduleId/lorebooks', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entries?: unknown }
      const baseRevision = readBaseRevision(body)
      const entries = validateLorebookEntries(body.entries)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules, module } = readStrictModuleLorebookTarget(database, moduleId)
          module.lorebook = entries
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            // Only the `modules` table is written, so a foreign refresh ships
            // just `modules` via the module-scoped resource (not the broad
            // global `lorebook` re-ship).
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: moduleId,
              resource: 'moduleUpdated',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/modules/:moduleId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { moduleId?: unknown; entryId?: unknown }
      const moduleId = readModuleId(params.moduleId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryWrite = readLorebookEntryWrite(body, entryId)
      const result = applyTargetedCommandMutation<{
        moduleId: string
        entryId: string
        entryIndex: number
        created: boolean
        patchedKeys?: string[]
        deletedKeys?: string[]
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules, module, entries } = readStrictModuleLorebookTarget(database, moduleId)
          const written = applyLorebookEntryWriteById(entries, entryId, entryWrite)
          module.lorebook = entries
          const certified = written.patchedKeys && written.deletedKeys
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: moduleId,
              resource: 'moduleUpdated',
            },
            extra: {
              moduleId,
              entryId,
              entryIndex: written.index,
              created: written.created,
              ...(certified ? { patchedKeys: written.patchedKeys, deletedKeys: written.deletedKeys } : {}),
            },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/modules/:moduleId/lorebooks/entries/:entryId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { moduleId?: unknown; entryId?: unknown }
      const moduleId = readModuleId(params.moduleId)
      const entryId = readLorebookId(params.entryId, 'entryId')
      const body = (req.body ?? {}) as { baseRevision?: unknown }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation<{
        moduleId: string
        entryId: string
        entryIndex: number
      }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules } = readModuleCollectionCommandTarget(database)
          const module = modules.find((candidate) => candidate.id === moduleId && !candidate.mcp)
          if (!module) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: moduleId,
                resource: 'moduleUpdated',
              },
              extra: { moduleId, entryId, entryIndex: -1 },
            }
          }
          validateStoredModuleRecord(module, `module ${moduleId}`)
          const entries =
            module.lorebook === undefined
              ? []
              : validateStoredLorebookEntries(module.lorebook, `module ${moduleId}.lorebook`)
          if (!entries.some((entry) => entry.id === entryId)) {
            return {
              event: {
                ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
                id: moduleId,
                resource: 'moduleUpdated',
              },
              extra: { moduleId, entryId, entryIndex: -1 },
            }
          }
          const deleted = deleteLorebookEntryById(entries, entryId)
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: moduleId,
              resource: 'moduleUpdated',
            },
            extra: { moduleId, entryId, entryIndex: deleted.index },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/modules/:moduleId/lorebooks/entries/reorder', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as { baseRevision?: unknown; entryIds?: unknown }
      const baseRevision = readBaseRevision(body)
      const entryIds = readLorebookIdList(body.entryIds, 'entryIds')
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules, module, entries } = readStrictModuleLorebookTarget(database, moduleId)
          reorderLorebookEntriesById(entries, entryIds)
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.lorebookEntriesReplaced,
              id: moduleId,
              resource: 'moduleUpdated',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/characters/:characterId/scripts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ScriptDefinitionCommandBody
      const baseRevision = readBaseRevision(body)
      const scripts = readScriptDefinitions(body.scripts)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const target = readScriptDefinitionCommandTarget(database)
          const character = readCharacterScriptParent(target, characterId)
          character.customscript = scripts
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.scriptDefinitionsReplaced, id: characterId },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/characters/:characterId/triggers', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = (req.body ?? {}) as ScriptDefinitionCommandBody
      const baseRevision = readBaseRevision(body)
      const triggers = readTriggerDefinitions(body.triggers)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const target = readScriptDefinitionCommandTarget(database)
          const character = readCharacterScriptParent(target, characterId)
          character.triggerscript = triggers
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.triggerDefinitionsReplaced, id: characterId },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/modules/:moduleId/scripts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as ScriptDefinitionCommandBody
      const baseRevision = readBaseRevision(body)
      const scripts = readScriptDefinitions(body.scripts)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules } = readModuleCollectionCommandTarget(database)
          const module = requireModule(modules, moduleId)
          module.regex = scripts
          // Module script updates rewrite only the `modules` table; corpus-wide
          // character repairs are validate-only.
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            // Only the `modules` table is rewritten, so emit a module-scoped
            // resource shipping `modules`.
            event: {
              ...COMMAND_EVENT_CATALOG.scriptDefinitionsReplaced,
              id: moduleId,
              resource: 'moduleScriptDefinition',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.put('/api/v1/commands/modules/:moduleId/triggers', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = (req.body ?? {}) as ScriptDefinitionCommandBody
      const baseRevision = readBaseRevision(body)
      const triggers = readTriggerDefinitions(body.triggers)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules } = readModuleCollectionCommandTarget(database)
          const module = requireModule(modules, moduleId)
          module.trigger = triggers
          // Module trigger updates rewrite only the `modules` table; corpus-wide
          // character repairs are validate-only.
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            // Only the `modules` table is rewritten, so emit a module-scoped
            // resource shipping `modules`.
            event: {
              ...COMMAND_EVENT_CATALOG.triggerDefinitionsReplaced,
              id: moduleId,
              resource: 'moduleTriggerDefinition',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/characters/:characterId/scripts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = readScriptDefinitionMutationCommandBody(req.body ?? {})
      const baseRevision = readBaseRevision(body)
      const mutation = readDefinitionCollectionMutation(body.mutation)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const target = readScriptDefinitionCommandTarget(database)
          const character = readCharacterScriptParent(target, characterId)
          character.customscript = applyScriptDefinitionCollectionMutation(character.customscript, mutation)
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.scriptDefinitionsReplaced, id: characterId },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/characters/:characterId/triggers', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const characterId = readCharacterId((req.params as { characterId?: unknown }).characterId)
      const body = readScriptDefinitionMutationCommandBody(req.body ?? {})
      const baseRevision = readBaseRevision(body)
      const mutation = readDefinitionCollectionMutation(body.mutation)
      const result = applyTargetedCommandMutation<{ characterId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.characterRow,
        characterScopedRead: { characterId, exactCharacterRow: true },
        mutate(database, innerDb) {
          const target = readScriptDefinitionCommandTarget(database)
          const character = readCharacterScriptParent(target, characterId)
          character.triggerscript = applyTriggerDefinitionCollectionMutation(character.triggerscript, mutation)
          writeSingleCharacterRow(innerDb, characterId, character)
          return {
            event: { ...COMMAND_EVENT_CATALOG.triggerDefinitionsReplaced, id: characterId },
            extra: { characterId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/modules/:moduleId/scripts', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = readScriptDefinitionMutationCommandBody(req.body ?? {})
      const baseRevision = readBaseRevision(body)
      const mutation = readDefinitionCollectionMutation(body.mutation)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules } = readModuleCollectionCommandTarget(database)
          const module = requireModule(modules, moduleId)
          module.regex = applyScriptDefinitionCollectionMutation(module.regex, mutation)
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.scriptDefinitionsReplaced,
              id: moduleId,
              resource: 'moduleScriptDefinition',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/modules/:moduleId/triggers', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const moduleId = readModuleId((req.params as { moduleId?: unknown }).moduleId)
      const body = readScriptDefinitionMutationCommandBody(req.body ?? {})
      const baseRevision = readBaseRevision(body)
      const mutation = readDefinitionCollectionMutation(body.mutation)
      const result = applyTargetedCommandMutation<{ moduleId: string }>({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.collection,
        collectionScopedRead: COLLECTION_SCOPED_READS.modules,
        mutate(database, innerDb) {
          const { modules } = readModuleCollectionCommandTarget(database)
          const module = requireModule(modules, moduleId)
          module.trigger = applyTriggerDefinitionCollectionMutation(module.trigger, mutation)
          writeSingleCollectionRow(innerDb, 'modules', modules.indexOf(module), module)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.triggerDefinitionsReplaced,
              id: moduleId,
              resource: 'moduleTriggerDefinition',
            },
            extra: { moduleId },
          }
        },
      })

      return {
        revision: result.revision,
        event: result.event,
        ...result.extra,
      }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/bardwiki/chats/:chatId/settings', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readBardWikiId((req.params as { chatId?: unknown }).chatId, 'chatId')
      const body = readBardWikiSettingsCommandBody(req.body)
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const settings = updateBardWikiChatSettings(innerDb, chatId, body.patch)
          return {
            event: { ...COMMAND_EVENT_CATALOG.bardWikiSettingsUpdated, id: chatId },
            extra: { settings },
          }
        },
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/bardwiki/chats/:chatId/confirmations', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readBardWikiId((req.params as { chatId?: unknown }).chatId, 'chatId')
      const body = readBardWikiConfirmationCommandBody(req.body, chatId)
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const confirmation = createOrReuseExplicitBardWikiConfirmation(innerDb, body.confirmation)
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.bardWikiConfirmationQueued,
              id: chatId,
              jobId: confirmation.job.id,
              sourceMessageId: confirmation.receipt.assistantMessageId,
            },
            extra: {
              receipt: confirmation.receipt,
              job: confirmation.job,
              created: confirmation.created,
            },
          }
        },
      })
      bardWikiJobs?.wakeWorker?.()
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/bardwiki/chats/:chatId/documents', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readBardWikiId((req.params as { chatId?: unknown }).chatId, 'chatId')
      const body = readBardWikiCreateDocumentCommandBody(req.body)
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const document = createBardWikiDocument(innerDb, {
            chatId,
            ...body.document,
            commandRevision: baseRevision + 1,
          })
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.bardWikiDocumentCreated,
              id: document.id,
              parentId: chatId,
            },
            extra: { document },
          }
        },
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.patch('/api/v1/commands/bardwiki/chats/:chatId/documents/:documentId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { chatId?: unknown; documentId?: unknown }
      const chatId = readBardWikiId(params.chatId, 'chatId')
      const documentId = readBardWikiId(params.documentId, 'documentId')
      const body = readBardWikiUpdateDocumentCommandBody(req.body)
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const document = updateBardWikiDocument(innerDb, chatId, documentId, {
            expectedVersion: body.expectedVersion,
            expectedContentHash: body.expectedContentHash,
            ...body.patch,
            commandRevision: baseRevision + 1,
          })
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.bardWikiDocumentUpdated,
              id: document.id,
              parentId: chatId,
            },
            extra: { document },
          }
        },
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.delete('/api/v1/commands/bardwiki/chats/:chatId/documents/:documentId', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const params = req.params as { chatId?: unknown; documentId?: unknown }
      const chatId = readBardWikiId(params.chatId, 'chatId')
      const documentId = readBardWikiId(params.documentId, 'documentId')
      const body = readBardWikiDeleteDocumentCommandBody(req.body)
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const document = deleteBardWikiDocument(innerDb, chatId, documentId, {
            expectedVersion: body.expectedVersion,
            expectedContentHash: body.expectedContentHash,
            commandRevision: baseRevision + 1,
          })
          return {
            event: {
              ...COMMAND_EVENT_CATALOG.bardWikiDocumentDeleted,
              id: document.id,
              parentId: chatId,
            },
            extra: { document },
          }
        },
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/bardwiki/chats/:chatId/imports', { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readBardWikiId((req.params as { chatId?: unknown }).chatId, 'chatId')
      const body = readBardWikiImportCommandBody(req.body)
      const vault = decodeBardWikiVault(body.archive)
      if (body.dryRun) {
        return {
          revision: getSchemaState(db).revision,
          dryRun: true,
          plan: planBardWikiVaultImport(db, chatId, vault, body.strategy, body.expectedTargets),
        }
      }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const plan = applyBardWikiVaultImport(
            innerDb,
            chatId,
            vault,
            body.strategy,
            body.expectedTargets,
            baseRevision + 1,
          )
          return {
            event: { ...COMMAND_EVENT_CATALOG.bardWikiVaultImported, id: chatId },
            extra: { dryRun: false, plan },
          }
        },
      })
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })

  app.post('/api/v1/commands/bardwiki/chats/:chatId/rebuilds', async (req, reply) => {
    if (!(await requireAuth(authState, req, reply))) return

    try {
      const chatId = readBardWikiId((req.params as { chatId?: unknown }).chatId, 'chatId')
      const body = readBardWikiRebuildCommandBody(req.body)
      if (body.preview === true) {
        return {
          revision: getSchemaState(db).revision,
          preview: previewBardWikiRebuild(db, chatId, body.policy),
        }
      }
      const baseRevision = readBaseRevision(body)
      const result = applyTargetedCommandMutation({
        db,
        dataDir,
        baseRevision,
        ...commandMutationContext(req, eventSink),
        mutationPath: TARGETED_MUTATION_PATHS.bardWiki,
        skipDatabaseLoad: true,
        mutate(_database, innerDb) {
          const enqueued = enqueueBardWikiRebuild(innerDb, {
            chatId,
            policy: body.policy,
            expectedSourceCount: body.expectedSourceCount,
          })
          const { payload: _payload, ...job } = enqueued
          return {
            event: { ...COMMAND_EVENT_CATALOG.bardWikiRebuildQueued, id: chatId, jobId: job.id },
            extra: { job },
          }
        },
      })
      bardWikiJobs?.wakeWorker?.()
      return { revision: result.revision, event: result.event, ...result.extra }
    } catch (err) {
      return sendCommandError(reply, err)
    }
  })
}

function readBardWikiId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ValidationError(`${label} must be a valid non-empty string`)
  }
  return value
}

function readBardWikiObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnsupportedBardWikiFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unsupported) throw new ValidationError(`Unsupported ${label} field: ${unsupported}`)
}

function readBardWikiSettingsCommandBody(value: unknown): {
  baseRevision?: unknown
  patch: BardWikiChatSettingsPatch
} {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(body, ['baseRevision', 'patch'], 'BardWiki settings command')
  const source = readBardWikiObject(body.patch, 'patch')
  const allowed = [
    'enabledOverride',
    'memoryModeOverride',
    'confirmationPolicyOverride',
    'canonicalUpdatesOverride',
    'totalTokenBudgetOverride',
    'hybridHypaTokenBudgetOverride',
    'hybridBardWikiTokenBudgetOverride',
    'maxDocumentsOverride',
    'maxLinkHopsOverride',
    'recentMessageCountOverride',
    'modelProfileIdOverride',
    'modelProfileIdIsSet',
    'promptPresetIdOverride',
    'promptPresetIdIsSet',
  ] as const
  rejectUnsupportedBardWikiFields(source, allowed, 'BardWiki settings patch')
  if (Object.keys(source).length === 0) throw new ValidationError('patch must include at least one setting')
  const patch: BardWikiChatSettingsPatch = {}
  for (const [key, raw] of Object.entries(source)) {
    switch (key) {
      case 'enabledOverride':
      case 'canonicalUpdatesOverride':
        if (raw !== null && typeof raw !== 'boolean') throw new ValidationError(`${key} must be boolean or null`)
        patch[key] = raw as boolean | null
        break
      case 'memoryModeOverride':
        if (raw !== null && (typeof raw !== 'string' || !BARDWIKI_MEMORY_MODES.includes(raw as never))) {
          throw new ValidationError('memoryModeOverride is unsupported')
        }
        patch.memoryModeOverride = raw as BardWikiChatSettingsPatch['memoryModeOverride']
        break
      case 'confirmationPolicyOverride':
        if (raw !== null && (typeof raw !== 'string' || !BARDWIKI_CONFIRMATION_POLICIES.includes(raw as never))) {
          throw new ValidationError('confirmationPolicyOverride is unsupported')
        }
        patch.confirmationPolicyOverride = raw as BardWikiChatSettingsPatch['confirmationPolicyOverride']
        break
      case 'modelProfileIdIsSet':
      case 'promptPresetIdIsSet':
        if (typeof raw !== 'boolean') throw new ValidationError(`${key} must be a boolean`)
        patch[key] = raw
        break
      case 'modelProfileIdOverride':
      case 'promptPresetIdOverride':
        if (raw !== null && typeof raw !== 'string') throw new ValidationError(`${key} must be string or null`)
        patch[key] = raw as string | null
        break
      default:
        if (raw !== null && !Number.isSafeInteger(raw)) throw new ValidationError(`${key} must be integer or null`)
        ;(patch as Record<string, unknown>)[key] = raw
    }
  }
  return { baseRevision: body.baseRevision, patch }
}

function readBardWikiConfirmationCommandBody(
  value: unknown,
  chatId: string,
): { baseRevision?: unknown; confirmation: ExplicitBardWikiConfirmationInput } {
  const body = readBardWikiObject(value ?? {}, 'body')
  const allowed = [
    'baseRevision',
    'userMessageId',
    'userContentHash',
    'assistantMessageId',
    'assistantContentHash',
  ] as const
  rejectUnsupportedBardWikiFields(body, allowed, 'BardWiki confirmation command')
  return {
    baseRevision: body.baseRevision,
    confirmation: {
      chatId,
      userMessageId: readBardWikiId(body.userMessageId, 'userMessageId'),
      userContentHash: readBardWikiExpectedHash(body.userContentHash),
      assistantMessageId: readBardWikiId(body.assistantMessageId, 'assistantMessageId'),
      assistantContentHash: readBardWikiExpectedHash(body.assistantContentHash),
    },
  }
}

function readBardWikiCreateDocumentCommandBody(value: unknown): {
  baseRevision?: unknown
  document: BardWikiDocumentCommandFields &
    Required<Pick<BardWikiDocumentCommandFields, 'kind' | 'title' | 'logicalPath' | 'markdown'>>
} {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(body, ['baseRevision', 'document'], 'BardWiki create command')
  return {
    baseRevision: body.baseRevision,
    document: readBardWikiDocumentFields(body.document, false) as BardWikiDocumentCommandFields &
      Required<Pick<BardWikiDocumentCommandFields, 'kind' | 'title' | 'logicalPath' | 'markdown'>>,
  }
}

function readBardWikiUpdateDocumentCommandBody(value: unknown): {
  baseRevision?: unknown
  expectedVersion: number
  expectedContentHash: string
  patch: BardWikiDocumentCommandFields
} {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(
    body,
    ['baseRevision', 'expectedVersion', 'expectedContentHash', 'patch'],
    'BardWiki update command',
  )
  const expectedVersion = readBardWikiExpectedVersion(body.expectedVersion)
  const expectedContentHash = readBardWikiExpectedHash(body.expectedContentHash)
  const patch = readBardWikiDocumentFields(body.patch, true)
  if (Object.keys(patch).length === 0) throw new ValidationError('patch must include at least one document field')
  return { baseRevision: body.baseRevision, expectedVersion, expectedContentHash, patch }
}

function readBardWikiDeleteDocumentCommandBody(value: unknown): {
  baseRevision?: unknown
  expectedVersion: number
  expectedContentHash: string
} {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(
    body,
    ['baseRevision', 'expectedVersion', 'expectedContentHash'],
    'BardWiki delete command',
  )
  return {
    baseRevision: body.baseRevision,
    expectedVersion: readBardWikiExpectedVersion(body.expectedVersion),
    expectedContentHash: readBardWikiExpectedHash(body.expectedContentHash),
  }
}

function readBardWikiImportCommandBody(value: unknown): {
  baseRevision?: unknown
  dryRun: boolean
  strategy: BardWikiVaultConflictStrategy
  archive: Uint8Array
  expectedTargets: BardWikiVaultExpectedTarget[]
} {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(
    body,
    ['baseRevision', 'dryRun', 'strategy', 'archiveBase64', 'expectedTargets'],
    'BardWiki import command',
  )
  if (typeof body.dryRun !== 'boolean') throw new ValidationError('dryRun must be a boolean')
  if (body.strategy !== 'skip' && body.strategy !== 'rename' && body.strategy !== 'replace') {
    throw new ValidationError('strategy must be skip, rename, or replace')
  }
  if (
    typeof body.archiveBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body.archiveBase64)
  ) {
    throw new ValidationError('archiveBase64 must be canonical base64')
  }
  const archive = Buffer.from(body.archiveBase64, 'base64')
  if (archive.toString('base64') !== body.archiveBase64)
    throw new ValidationError('archiveBase64 must be canonical base64')
  const rawTargets = body.expectedTargets ?? []
  if (!Array.isArray(rawTargets) || rawTargets.length > 2_000) {
    throw new ValidationError('expectedTargets must be a bounded array')
  }
  const expectedTargets = rawTargets.map((target, index): BardWikiVaultExpectedTarget => {
    const object = readBardWikiObject(target, `expectedTargets[${index}]`)
    rejectUnsupportedBardWikiFields(object, ['documentId', 'version', 'contentHash'], 'BardWiki import target')
    return {
      documentId: readBardWikiId(object.documentId, `expectedTargets[${index}].documentId`),
      version: readBardWikiExpectedVersion(object.version),
      contentHash: readBardWikiExpectedHash(object.contentHash),
    }
  })
  if (new Set(expectedTargets.map(({ documentId }) => documentId)).size !== expectedTargets.length) {
    throw new ValidationError('expectedTargets must not contain duplicate document ids')
  }
  if (!body.dryRun && body.baseRevision === undefined) throw new ValidationError('baseRevision is required for import')
  return {
    baseRevision: body.baseRevision,
    dryRun: body.dryRun,
    strategy: body.strategy,
    archive,
    expectedTargets,
  }
}

function readBardWikiRebuildCommandBody(value: unknown):
  | { baseRevision?: unknown; preview: true; policy: 'missing' | 'full' }
  | {
      baseRevision?: unknown
      preview: false
      policy: 'missing' | 'full'
      expectedSourceCount: number
    } {
  const body = readBardWikiObject(value ?? {}, 'body')
  rejectUnsupportedBardWikiFields(
    body,
    ['baseRevision', 'preview', 'confirm', 'policy', 'expectedSourceCount'],
    'BardWiki rebuild command',
  )
  if (body.policy !== 'missing' && body.policy !== 'full') {
    throw new ValidationError('policy must be missing or full')
  }
  if (body.preview === true) {
    if (body.confirm !== undefined || body.expectedSourceCount !== undefined || body.baseRevision !== undefined) {
      throw new ValidationError('rebuild preview does not accept confirmation fields')
    }
    return { preview: true, policy: body.policy }
  }
  if (body.preview !== false || body.confirm !== true) {
    throw new ValidationError('rebuild must be previewed or explicitly confirmed')
  }
  if (!Number.isSafeInteger(body.expectedSourceCount) || (body.expectedSourceCount as number) < 0) {
    throw new ValidationError('expectedSourceCount must be a non-negative integer')
  }
  if (body.baseRevision === undefined) throw new ValidationError('baseRevision is required for rebuild')
  return {
    baseRevision: body.baseRevision,
    preview: false,
    policy: body.policy,
    expectedSourceCount: body.expectedSourceCount as number,
  }
}

interface BardWikiDocumentCommandFields {
  kind?: BardWikiDocumentKind
  title?: string
  logicalPath?: string
  aliases?: string[]
  contextPolicy?: BardWikiContextPolicy
  reviewState?: BardWikiReviewState
  markdown?: string
}

function readBardWikiDocumentFields(value: unknown, partial: boolean): BardWikiDocumentCommandFields {
  const source = readBardWikiObject(value, partial ? 'patch' : 'document')
  const allowed = ['kind', 'title', 'logicalPath', 'aliases', 'contextPolicy', 'reviewState', 'markdown'] as const
  rejectUnsupportedBardWikiFields(source, allowed, partial ? 'BardWiki document patch' : 'BardWiki document')
  const result: Record<string, unknown> = {}
  for (const key of allowed) {
    const raw = source[key]
    if (raw === undefined) continue
    if (key === 'aliases') {
      if (!Array.isArray(raw) || !raw.every((alias) => typeof alias === 'string')) {
        throw new ValidationError('aliases must be an array of strings')
      }
      result.aliases = raw
    } else if (key === 'kind') {
      if (typeof raw !== 'string' || !BARDWIKI_DOCUMENT_KINDS.includes(raw as never)) {
        throw new ValidationError('kind is unsupported')
      }
      result.kind = raw
    } else if (key === 'contextPolicy') {
      if (typeof raw !== 'string' || !BARDWIKI_CONTEXT_POLICIES.includes(raw as never)) {
        throw new ValidationError('contextPolicy is unsupported')
      }
      result.contextPolicy = raw
    } else if (key === 'reviewState') {
      if (typeof raw !== 'string' || !BARDWIKI_REVIEW_STATES.includes(raw as never)) {
        throw new ValidationError('reviewState is unsupported')
      }
      result.reviewState = raw
    } else {
      if (typeof raw !== 'string') throw new ValidationError(`${key} must be a string`)
      result[key] = raw
    }
  }
  if (!partial) {
    for (const required of ['kind', 'title', 'logicalPath', 'markdown'] as const) {
      if (result[required] === undefined) throw new ValidationError(`document.${required} is required`)
    }
  }
  return result as BardWikiDocumentCommandFields
}

function readBardWikiExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ValidationError('expectedVersion must be a positive integer')
  }
  return value as number
}

function readBardWikiExpectedHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ValidationError('expectedContentHash must be a SHA-256 hex string')
  }
  return value
}

function readSettingsGroup(group: unknown): SettingsGroup {
  if (typeof group !== 'string' || !SETTINGS_GROUPS.includes(group as SettingsGroup)) {
    throw new ValidationError(`Unsupported settings group: ${String(group)}`)
  }
  return group as SettingsGroup
}

function readSparseObjectSettingKey(group: SettingsGroup, key: unknown): SparseObjectSettingKey {
  if (
    typeof key !== 'string' ||
    !Object.prototype.hasOwnProperty.call(SPARSE_OBJECT_SETTING_GROUP_BY_KEY, key) ||
    SPARSE_OBJECT_SETTING_GROUP_BY_KEY[key as keyof typeof SPARSE_OBJECT_SETTING_GROUP_BY_KEY] !== group
  ) {
    throw new ValidationError(`Unsupported sparse ${group} object setting: ${String(key)}`)
  }
  return key as SparseObjectSettingKey
}

function readSparseObjectSettingUpdate(body: SparseObjectSettingsCommandBody): {
  patch: Record<string, unknown>
  deleteKeys: string[]
} {
  const unsupportedKeys = Object.keys(body).filter(
    (key) => key !== 'baseRevision' && key !== 'patch' && key !== 'deleteKeys',
  )
  if (unsupportedKeys.length > 0) {
    throw new ValidationError(`Unsupported sparse object setting field: ${unsupportedKeys[0]}`)
  }
  const patch = body.patch === undefined ? {} : { ...readJsonObject(body.patch, 'patch') }
  for (const [key, value] of Object.entries(patch)) {
    if (key.trim() === '') throw new ValidationError('patch keys must be non-empty strings')
    validateJsonValue(`patch.${key}`, value)
  }
  const rawDeleteKeys = body.deleteKeys
  if (rawDeleteKeys !== undefined && !Array.isArray(rawDeleteKeys)) {
    throw new ValidationError('deleteKeys must be an array')
  }
  const deleteKeyValues: unknown[] = Array.isArray(rawDeleteKeys) ? rawDeleteKeys : []
  const deleteKeys = deleteKeyValues.map((key, index) => {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new ValidationError(`deleteKeys[${index}] must be a non-empty string`)
    }
    return key
  })
  if (new Set(deleteKeys).size !== deleteKeys.length) {
    throw new ValidationError('deleteKeys must not contain duplicates')
  }
  if (deleteKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key))) {
    throw new ValidationError('patch and deleteKeys must not overlap')
  }
  if (Object.keys(patch).length === 0 && deleteKeys.length === 0) {
    throw new ValidationError('sparse object setting update must include at least one field')
  }
  return { patch, deleteKeys }
}

function maskSparseObjectSettingForReceipt(key: string, value: unknown): Record<string, unknown> {
  const masked = maskProviderSecrets({ [key]: value }) as Record<string, unknown>
  return isPlainObject(masked[key]) ? (masked[key] as Record<string, unknown>) : {}
}

function compactSparseObjectSettingReceipt(input: {
  requested: Record<string, unknown>
  canonical: Record<string, unknown>
  requestedKeys: Set<string>
}): { canonicalValues: Record<string, unknown>; canonicalDeletedKeys: string[] } | null {
  const canonicalValues: Record<string, unknown> = {}
  const canonicalDeletedKeys: string[] = []
  const keys = new Set([...Object.keys(input.requested), ...Object.keys(input.canonical)])
  for (const key of keys) {
    const requestedPresent = Object.prototype.hasOwnProperty.call(input.requested, key)
    const canonicalPresent = Object.prototype.hasOwnProperty.call(input.canonical, key)
    if (
      requestedPresent === canonicalPresent &&
      (!requestedPresent || isDeepStrictEqual(input.requested[key], input.canonical[key]))
    ) {
      continue
    }
    if (!input.requestedKeys.has(key)) return null
    if (canonicalPresent) canonicalValues[key] = input.canonical[key]
    else canonicalDeletedKeys.push(key)
  }
  return { canonicalValues, canonicalDeletedKeys: canonicalDeletedKeys.sort() }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readOnboardingSettingsPatch(patch: unknown): Record<string, unknown> {
  if (!isPlainObject(patch)) {
    throw new ValidationError('settingsPatch must be an object')
  }
  if (patch.didFirstSetup !== true) {
    throw new ValidationError('settingsPatch.didFirstSetup must be true')
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!ONBOARDING_SETTINGS_KEYS.has(key)) {
      throw new ValidationError(`Unsupported onboarding setting: ${key}`)
    }
    const group = SETTINGS_GROUPS.find((candidate) => SETTINGS_GROUP_KEY_SETS[candidate].has(key))
    if (!group) throw new ValidationError(`Unsupported onboarding setting: ${key}`)
    validateSettingValue(key, value)
    sanitized[key] = sanitizeSettingValue(key, value)
  }
  return sanitized
}

function readSettingsGroupPatch(group: SettingsGroup, patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('patch must be an object')
  }

  const entries = Object.entries(patch as Record<string, unknown>)
  if (entries.length === 0) {
    throw new ValidationError('patch must include at least one setting')
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (!SETTINGS_GROUP_KEY_SETS[group].has(key)) {
      throw new ValidationError(`Unsupported ${group} setting: ${key}`)
    }
    if (key === 'moduleFolders') {
      throw new ValidationError('moduleFolders must be changed through module folder commands')
    }
    validateSettingValue(key, value)
    sanitized[key] = sanitizeSettingValue(key, value)
  }

  return sanitized
}

function validateSettingValue(key: string, value: unknown): void {
  if (key === 'localStopStrings' && !isLocalStopStrings(value)) {
    throw new ValidationError('localStopStrings must be an array of strings or null')
  }
  if (key === 'bardWiki' && !isBardWikiGlobalSettings(value)) {
    throw new ValidationError('bardWiki must match the BardWiki global settings contract')
  }
  if (key === 'hypaV3Presets') validateHypaV3PresetSummaryModels(value)
  if (key === 'complexRegexCompatibilityMode' && value !== 'strict' && value !== 'worker') {
    throw new ValidationError('complexRegexCompatibilityMode must be strict or worker')
  }
  if (
    ['complexRegexInputTimeoutMs', 'complexRegexOutputTimeoutMs', 'complexRegexDisplayTimeoutMs'].includes(key) &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new ValidationError(`${key} must be a non-negative finite number`)
  }
  if (
    key === 'regexOutputSizeLimitMiB' &&
    (!Number.isSafeInteger(value) ||
      (value as number) < MIN_REGEX_OUTPUT_SIZE_LIMIT_MIB ||
      (value as number) > MAX_REGEX_OUTPUT_SIZE_LIMIT_MIB)
  ) {
    throw new ValidationError(
      `regexOutputSizeLimitMiB must be an integer from ${MIN_REGEX_OUTPUT_SIZE_LIMIT_MIB} to ${MAX_REGEX_OUTPUT_SIZE_LIMIT_MIB}`,
    )
  }
  if (
    key === 'requestHistoryLimit' &&
    (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_REQUEST_HISTORY_LIMIT)
  ) {
    throw new ValidationError(`requestHistoryLimit must be an integer from 0 to ${MAX_REQUEST_HISTORY_LIMIT}`)
  }
  if (key === 'desktopSidebarColumns' && !isValidDesktopSidebarColumns(value)) {
    throw new ValidationError(
      `desktopSidebarColumns must be an integer from ${MIN_SIDEBAR_COLUMNS} to ${MAX_DESKTOP_SIDEBAR_COLUMNS}`,
    )
  }
  if (key === 'mobileSidebarColumns' && !isValidMobileSidebarColumns(value)) {
    throw new ValidationError(
      `mobileSidebarColumns must be an integer from ${MIN_SIDEBAR_COLUMNS} to ${MAX_MOBILE_SIDEBAR_COLUMNS}`,
    )
  }
  const kind = settingValueKind(key)
  if (kind === 'json') {
    validateJsonValue(key, value)
    return
  }
  if (kind === 'boolean' && typeof value !== 'boolean') {
    throw new ValidationError(`${key} must be a boolean`)
  }
  if (kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ValidationError(`${key} must be a finite number`)
  }
  if (kind === 'string' && typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string`)
  }
  if (kind === 'stringOrNull' && value !== null && typeof value !== 'string') {
    throw new ValidationError(`${key} must be a string or null`)
  }
  if (kind === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new ValidationError(`${key} must be an object`)
  }
  if (kind === 'array' && !Array.isArray(value)) {
    throw new ValidationError(`${key} must be an array`)
  }
  if (kind === 'arrayOrNull' && value !== null && !Array.isArray(value)) {
    throw new ValidationError(`${key} must be an array or null`)
  }
  validateJsonValue(key, value)
}

function validateHypaV3PresetSummaryModels(value: unknown): void {
  if (!Array.isArray(value)) return
  for (const [index, preset] of value.entries()) {
    if (!isPlainObject(preset) || !isPlainObject(preset.settings)) continue
    const model = preset.settings.summarizationModel
    if (model !== undefined && model !== 'subModel' && model !== 'memory') {
      throw new ValidationError(`hypaV3Presets[${index}].settings.summarizationModel must be subModel or memory`)
    }
  }
}

function sanitizeSettingValue(key: string, value: unknown): unknown {
  if (key === 'providerCredentials') {
    return readSettingsProviderCredentials(value)
  }
  if (key === 'modelProfiles') {
    return readSettingsModelProfiles(value)
  }
  if (key === 'modelProfileOrder') {
    try {
      return readModelProfileOrder(value, referencedProfilesForOrder(value))
    } catch (error) {
      throwModelProfileValidationError(error)
    }
  }
  if (key === 'modelRoleProfiles') {
    return readSettingsModelRoleProfiles(value)
  }
  if (key === 'modelRuntimeDefaults') {
    return readSettingsModelRuntimeDefaults(value)
  }
  if (key === 'customSidebarItems') {
    return readCustomSidebarItems(value)
  }
  if (key === 'chatGenerationTogglePresets') {
    return normalizeChatGenerationTogglePresets(value)
  }
  if (key === 'keepSessionAlive') {
    return readKeepSessionAlive(value)
  }
  return value
}

function readKeepSessionAlive(value: unknown): 'off' | 'sound' {
  if (value === 'pip') return 'sound'
  if (value === 'off' || value === 'sound') return value
  throw new ValidationError('keepSessionAlive must be off or sound')
}

function readSettingsModelProfiles(value: unknown): unknown {
  try {
    return readModelProfiles(value)
  } catch (error) {
    throwModelProfileValidationError(error)
  }
}

function readSettingsProviderCredentials(value: unknown): unknown {
  try {
    return readProviderCredentials(value)
  } catch (error) {
    if (error instanceof ProviderCredentialRecordValidationError) {
      throw new ValidationError(error.message)
    }
    throw error
  }
}

function readSettingsModelRoleProfiles(value: unknown): unknown {
  try {
    return readModelRoleProfiles(value)
  } catch (error) {
    throwModelProfileValidationError(error)
  }
}

function readSettingsModelRuntimeDefaults(value: unknown): unknown {
  try {
    return readModelRuntimeDefaults(value)
  } catch (error) {
    throwModelProfileValidationError(error)
  }
}

function throwModelProfileValidationError(error: unknown): never {
  if (error instanceof ModelProfileRecordValidationError) {
    throw new ValidationError(error.message)
  }
  throw error
}

const CUSTOM_SIDEBAR_ITEM_TYPES = new Set(['model', 'loadout', 'setting'])

function readCustomSidebarItems(value: unknown): Array<{
  id: string
  type: string
  subType: string
  label: string
}> {
  if (!Array.isArray(value)) {
    throw new ValidationError('customSidebarItems must be an array')
  }

  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError(`customSidebarItems[${index}] must be an object`)
    }
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.trim() === '') {
      throw new ValidationError(`customSidebarItems[${index}].id must be a non-empty string`)
    }
    if (typeof record.type !== 'string' || !CUSTOM_SIDEBAR_ITEM_TYPES.has(record.type)) {
      throw new ValidationError(`customSidebarItems[${index}].type is unsupported`)
    }
    if (typeof record.subType !== 'string') {
      throw new ValidationError(`customSidebarItems[${index}].subType must be a string`)
    }
    if (record.type === 'setting' && record.subType.trim() === '') {
      throw new ValidationError(`customSidebarItems[${index}].subType must be a non-empty string for setting items`)
    }
    if (typeof record.label !== 'string') {
      throw new ValidationError(`customSidebarItems[${index}].label must be a string`)
    }

    return {
      id: record.id,
      type: record.type,
      subType: record.subType,
      label: record.label,
    }
  })
}

function readSelectionLastInteraction(value: unknown): number {
  if (value === undefined) return Date.now()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('lastInteraction must be a finite number')
  }
  return value
}

function readLegacyBotPresetExtractionMode(value: unknown): LegacyBotPresetExtractionMode {
  if (value === 'all' || value === 'model' || value === 'prompt') return value
  throw new ValidationError('mode must be one of all, model, or prompt')
}

function validateSettingsAssetRefs(db: DatabaseSync, patch: Record<string, unknown>): void {
  if ('customBackground' in patch) {
    validateOptionalServerAssetRef(db, patch.customBackground, 'customBackground')
  }
}

function settingValueKind(key: string): SettingValueKind {
  if (BOOLEAN_SETTING_KEYS.has(key)) return 'boolean'
  if (NUMBER_SETTING_KEYS.has(key)) return 'number'
  if (STRING_SETTING_KEYS.has(key)) return 'string'
  if (STRING_OR_NULL_SETTING_KEYS.has(key)) return 'stringOrNull'
  if (OBJECT_SETTING_KEYS.has(key)) return 'object'
  if (ARRAY_SETTING_KEYS.has(key)) return 'array'
  if (ARRAY_OR_NULL_SETTING_KEYS.has(key)) return 'arrayOrNull'
  return 'json'
}

function validateJsonValue(key: string, value: unknown): void {
  try {
    JSON.stringify(value)
  } catch {
    throw new ValidationError(`${key} must be JSON-serializable`)
  }
  if (value === undefined) {
    throw new ValidationError(`${key} must be JSON-serializable`)
  }
}

function applySettingsPatch(database: unknown, patch: Record<string, unknown>): void {
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new ValidationError('database must be an object before settings commands can run')
  }

  const target = database as Record<string, unknown>
  const resolvedPatch = resolveMaskedProviderSecretPlaceholders(database, patch)
  const nextProfiles = normalizeModelProfiles(resolvedPatch.modelProfiles ?? target.modelProfiles)
  for (const [key, value] of Object.entries(resolvedPatch)) {
    target[key] = normalizeSettingsPatchValue(key, value, nextProfiles)
  }
  if (Object.prototype.hasOwnProperty.call(resolvedPatch, 'modelProfiles')) {
    target.modelProfileOrder = normalizeModelProfileOrder(target.modelProfileOrder, nextProfiles)
  }
}

function normalizeSettingsPatchValue(
  key: string,
  value: unknown,
  profiles = normalizeModelProfiles(undefined),
): unknown {
  if (key === 'providerCredentials') return normalizeProviderCredentials(value)
  if (key === 'modelRoles') return normalizeModelRoleOverrides(value)
  if (key === 'modelProfiles') return normalizeModelProfiles(value)
  if (key === 'modelProfileOrder') return normalizeModelProfileOrder(value, profiles)
  if (key === 'modelRoleProfiles') return normalizeModelRoleProfiles(value)
  if (key === 'modelRuntimeDefaults') return normalizeModelRuntimeDefaults(value)
  if (key === 'seperateModels') return normalizeLegacySeperateModels(value)
  if (key === 'fallbackModels') return normalizeLegacyFallbackModels(value)
  if (key === 'seperateParameters') return normalizeSeperateParametersValue(value)
  return value
}

function referencedProfilesForOrder(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((entry) => {
    if (!isPlainObject(entry) || entry.kind !== 'profile' || typeof entry.profileId !== 'string') return []
    const id = entry.profileId.trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    return [{ id, name: id }]
  })
}

function normalizeSeperateParametersValue(value: unknown): Record<string, unknown> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  return {
    memory: recordOrBlank(source.memory),
    emotion: recordOrBlank(source.emotion),
    translate: recordOrBlank(source.translate),
    otherAx: recordOrBlank(source.otherAx),
    scriptMain: recordOrBlank(source.scriptMain),
    scriptAux: recordOrBlank(source.scriptAux),
    overrides: recordOrBlank(source.overrides),
  }
}

function recordOrBlank(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function sendCommandError(
  reply: FastifyReply,
  err: unknown,
): { error: string; currentRevision?: number; databaseLineage?: string } {
  if (err instanceof DatabaseLineageConflictError) {
    reply.code(409)
    return { error: 'database_lineage_conflict', databaseLineage: err.databaseLineage }
  }
  if (err instanceof CommandMutationIdConflictError) {
    reply.code(409)
    return { error: 'mutation_id_conflict' }
  }
  if (err instanceof RevisionMismatchError) {
    reply.code(409)
    return { error: 'revision_conflict', currentRevision: err.currentRevision }
  }
  if (err instanceof InitializeConflictError) {
    reply.code(409)
    return { error: err.code }
  }
  if (err instanceof BardWikiConflictError) {
    reply.code(409)
    return { error: err.code }
  }
  if (err instanceof BardWikiValidationError) {
    if (err.code === 'bardwiki_chat_not_found' || err.code === 'bardwiki_document_not_found') reply.code(404)
    else if (err.code === 'bardwiki_limit_exceeded') reply.code(413)
    else if (
      err.code === 'bardwiki_disabled' ||
      err.code === 'bardwiki_source_not_active' ||
      err.code === 'bardwiki_import_conflict' ||
      err.code === 'bardwiki_rebuild_active' ||
      err.code === 'bardwiki_rebuild_preview_stale'
    )
      reply.code(409)
    else reply.code(400)
    return { error: err.code }
  }
  if (err instanceof ValidationError) {
    reply.code(400)
    return { error: err.message }
  }
  if (err instanceof EntityNotFoundError) {
    reply.code(404)
    return { error: err.message }
  }
  throw err
}
