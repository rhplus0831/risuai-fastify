import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import {
  canUseClientRecoveryAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { Sha256 } from '@aws-crypto/sha256-js'
import { sha256Hex as sharedSha256Hex } from '../sha256Fallback'
import {
  CHAT_GENERATION_SETTINGS_KEYS,
  serializeChatGenerationSettingsDigestInput,
  type ChatGenerationSettings,
  type SparseChatGenerationSettingsUpdate,
} from '../chatGenerationSettings'
import {
  serializePersonaCollectionDigestInput,
  serializePersonaIdsDigestInput,
  serializePersonaProfileDigestInput,
  type PersonaProfileDigestValue,
} from '../personaMutationCertificate'
import {
  AGENT_PRESET_SCHEMA_VERSION,
  normalizeAgentPresets,
  validateAgentPresetRecord,
  validateAgentPresetStepRecord,
  type AgentPresetRecord,
  type AgentPresetUseRecord,
  type AgentPresetStepRecord,
  type AgentRecord,
} from '../agentPresetRecords'
import type { MessageTranslation } from '../storage/database.svelte'
import type { AlternateGreetingMutation, ChatGreetingIndex } from '../alternateGreetingMutation'
import type { ModelRole } from '@risuai/shared-core/model-roles'
import type {
  ModelProfileOrderEntry,
  ModelProfileRecord,
  ModelProfileRecordRuntimeOptions,
  ModelRoleProfileBinding,
} from '../model/modelProfileRecords'
import type { ProviderCredentialRecord } from '../model/providerCredentialRecords'
import type { ScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import {
  serializeScriptDefinitionCollectionDigestInput,
  type ScriptDefinitionCollectionMutation,
} from './scriptDefinitionMutations'
import {
  activeWriterSessionHeader,
  handleActiveWriterStaleResponse,
  isActiveWriterStaleErrorBody,
  isWriterAccessLost,
  scheduleServerOwnershipReload,
} from './activeWriterSession'
import { isCanonicalLoadout } from './loadoutCanonical'
import { SERVER_SETTINGS_GROUP_BY_KEY, type SettingsGroup, type SettingsGroupProjectionEpochs } from './settingsGroups'
import {
  captureDestructiveRefreshEpoch,
  hasDestructiveRefreshEpochChanged,
  runRollbackUnlessDestructiveRefreshChanged as runProjectionRollback,
} from './staleStateGuards'
import {
  notifyServerCommandLocalEffectApplied,
  subscribeServerCommandLocalEffectApplied,
} from './commandLocalEffectEvents'
import type { DurableMutationRequest } from './pendingMutationOutbox'
import type { ServerInlayCatalogEntry } from './inlayCatalog'
import type { TranslatorPresetStep } from '../translator/presets'
import { beginPersistenceActivity } from './persistenceActivity.svelte'
import {
  normalizeCacheRole,
  normalizePromptRole,
  normalizePromptTemplate,
} from '../process/promptTemplateNormalization'
import { canMutate } from '../startupReadiness'
import type {
  BardWikiChatSettings,
  BardWikiContextPolicy,
  BardWikiDocument,
  BardWikiDocumentKind,
  BardWikiJobSummary,
  BardWikiReceiptSummary,
  BardWikiReviewState,
} from '@risuai/protocol'
import type { ModuleFolder } from '@risuai/protocol/module-organization'

export { notifyServerCommandLocalEffectApplied, subscribeServerCommandLocalEffectApplied }

const COMMAND_ENDPOINT = '/api/v1/commands'
const BOOTSTRAP_ENDPOINT = '/api/v1/bootstrap'
const MUTATION_RECEIPT_ACK_ENDPOINT = '/api/v1/commands/mutation-receipts/ack'
export const SERVER_MUTATION_ID_HEADER = 'risu-mutation-id'
export const SERVER_DATABASE_LINEAGE_HEADER = 'risu-database-lineage'
const AGENT_PRESET_COLLECTION_ACKNOWLEDGEMENT_CERTIFICATE = 'agent-preset-collection-v1'
const PRESET_REORDER_ACKNOWLEDGEMENT_CERTIFICATE = 'preset-reorder-v1'

type ServerCommandAccess = 'ordinary' | 'bootstrap-initialize' | 'pending-replay'

export {
  SERVER_SETTINGS_GROUP_BY_KEY,
  SERVER_SETTINGS_KEYS_BY_GROUP,
  SETTINGS_GROUPS,
  isSettingsGroup,
  type SettingsGroup,
  type SettingsGroupProjectionEpochs,
} from './settingsGroups'

export interface CommandEvent {
  type: string
  revision: number
  resource: string
  id?: string
  parentId?: string
  databaseLineage?: string
  operationId?: string
  sourceMessageId?: string
  jobId?: string
  origin?: {
    writerSessionId: string
  }
}

export interface ChatGenerationSettingsLocalEffect {
  kind: 'chatGenerationSettings'
  chatId: string
  characterId: string
  attemptedGenerationSettings: ChatGenerationSettings
  generationSettings: ChatGenerationSettings
  characterRowProjectionEpoch?: number
}

export interface CharacterPatchLocalEffect {
  kind: 'characterPatch'
  characterId: string
  patch: CharacterSnapshot
}

export interface CharacterSelectionLocalEffect {
  kind: 'characterSelection'
  characterId: string
  lastInteraction: number
}

export interface CharacterCollectionMutationLocalEffect {
  kind: 'characterCollectionMutation'
  operation: 'create' | 'createAndSelect' | 'delete'
  characterId: string
  selectedCharacterId: string | null
}

export interface ChatPatchLocalEffect {
  kind: 'chatPatch'
  characterId: string
  chatId: string
  patch: ChatSnapshot
  select: boolean
}

export interface ChatStructureMutationLocalEffect {
  kind: 'chatStructureMutation'
  operation: 'create' | 'delete' | 'fork' | 'reorder' | 'folderCreate' | 'folderDelete' | 'folderReorder'
  characterId: string
  targetId?: string
  attemptedIds?: string[]
  attemptedGenerationSettings?: ChatGenerationSettings | null
  generationSettings?: ChatGenerationSettings | null
  optimisticEpoch: number
  optimisticRowEpoch: number
}

export interface SettingsPatchLocalEffect {
  kind: 'settingsPatch'
  group: SettingsGroup
  attemptedPatch: SettingsPatch
  settings: SettingsPatch
  settingsProjectionEpoch: number
}

export interface SparseSettingsObjectUpdate {
  patch: Record<string, unknown>
  deleteKeys?: string[]
}

export interface PluginStorageLocalEffect {
  kind: 'pluginStorage'
  operation: 'put' | 'delete' | 'bulk'
  key?: string
}

export interface PluginCollectionMutationLocalEffect {
  kind: 'pluginCollectionMutation'
  operation: 'create' | 'update' | 'delete' | 'enable' | 'reorder'
  pluginId?: string
  pluginIds?: string[]
}

export interface PluginProviderLocalEffect {
  kind: 'pluginProvider'
  provider: string
}

export interface ModuleCollectionMutationLocalEffect {
  kind: 'moduleCollectionMutation'
  operation: 'create' | 'update' | 'reorder' | 'lorebooks' | 'scripts' | 'triggers'
  moduleId?: string
  moduleIds?: string[]
  collectionProjectionEpoch?: number
}

export type ModuleFolderSnapshot = ModuleFolder

export interface ModuleEnabledLocalEffect {
  kind: 'moduleEnabled'
  moduleId: string
  enabled: boolean
}

export type PromptItemMutationOperation = 'create' | 'update' | 'delete' | 'reorder' | 'enable'

export type PromptTemplateOwnerStateSnapshot = { enabled: true; items: PromptItemSnapshot[] } | { enabled: false }

/**
 * Client-only proof captured around one optimistic prompt-item write. It is
 * deliberately omitted from the command request body.
 */
export interface PromptItemOptimisticAcknowledgement {
  collectionProjectionEpoch: number
  ownerProjectionEpoch: number
  ownerState: PromptTemplateOwnerStateSnapshot
}

export interface PromptItemMutationLocalEffect {
  kind: 'promptItemMutation'
  operation: PromptItemMutationOperation
  promptPresetId: string | null
  itemId?: string
  itemIds?: string[]
  enabled?: boolean
  collectionProjectionEpoch: number
  ownerProjectionEpoch: number
  ownerState: PromptTemplateOwnerStateSnapshot
}

export interface SplitPresetPatchOptimisticAcknowledgement {
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  selectedPresetId: string | null
  selectedPromptPresetId?: string | null
  attemptedSettings: Record<string, unknown>
  selectedProjectionExpected: boolean
  ownerProjectionExpected?: boolean
  promptOwnerProjectionEpoch?: number
  promptOwnerRevision?: number
}

export interface SplitPresetPatchLocalEffect {
  kind: 'splitPresetPatch'
  presetKind: 'model' | 'prompt'
  presetId: string
  attemptedPatch: Record<string, unknown>
  preset: Record<string, unknown>
  attemptedSettings: Record<string, unknown>
  settings: Record<string, unknown>
  selectedProjectionApplied: boolean
  /** The canonical prompt-preset owner row was applied; this is not an aggregate mirror receipt. */
  ownerProjectionApplied: boolean
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  selectedPresetId: string | null
  selectedPromptPresetId?: string | null
  promptOwnerProjectionEpoch?: number
  promptOwnerRevision?: number
}

export type JsonFieldState = { present: false } | { present: true; value: unknown }

/** Client-only proof captured after one optimistic Agent Preset field PATCH. */
export interface AgentPresetPatchOptimisticAcknowledgement {
  settingsProjectionEpoch: number
  attemptedFields: Record<string, JsonFieldState>
}

export interface AgentPresetPatchLocalEffect {
  kind: 'agentPresetPatch'
  presetId: string
  settingsProjectionEpoch: number
  fields: Record<
    string,
    {
      attempted: JsonFieldState
      canonical: JsonFieldState
    }
  >
  updatedAt: number
}

export interface AgentPresetStepPatchLocalEffect {
  kind: 'agentPresetStepPatch'
  presetId: string
  stepId: string
  settingsProjectionEpoch: number
  fields: Record<
    string,
    {
      attempted: JsonFieldState
      canonical: JsonFieldState
    }
  >
  updatedAt: number
}

/** Client-only proof captured after an optimistic Agent Preset reorder/default write. */
export interface AgentPresetCollectionOptimisticAcknowledgement {
  settingsProjectionEpoch: number
  presetIds: string[]
  agentPresetDefaultId: string | null
}

export interface AgentPresetCollectionMutationLocalEffect {
  kind: 'agentPresetCollectionMutation'
  operation: 'reorder' | 'default'
  settingsProjectionEpoch: number
  presetIds: string[]
  agentPresetDefaultId: string | null
}

export type ReorderablePresetKind = 'legacy' | 'model'

/** Client-only proof captured around an optimistic legacy/model preset reorder. */
export interface PresetReorderOptimisticAcknowledgement {
  presetKind: ReorderablePresetKind
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  beforePresetIds: string[]
  attemptedPresetIds: string[]
  beforeSelectedPresetId: string | null
  attemptedSelectedPresetId: string | null
  settingsWritten: boolean
}

export interface PresetReorderLocalEffect {
  kind: 'presetReorder'
  presetKind: ReorderablePresetKind
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  presetIds: string[]
  selectedPresetId: string | null
  settingsWritten: boolean
}

/** Client-only proof captured after one optimistic legacy-preset PATCH. */
export interface LegacyPresetPatchOptimisticAcknowledgement {
  collectionProjectionEpoch: number
  attemptedFields: Record<string, JsonFieldState>
}

export interface LegacyPresetPatchLocalEffect {
  kind: 'legacyPresetPatch'
  presetId: string
  collectionProjectionEpoch: number
  fields: Record<
    string,
    {
      attempted: JsonFieldState
      canonical: JsonFieldState
    }
  >
}

export interface PersonaLegacyProfileProjection {
  username: string
  userIcon: string
  personaPrompt: string
  userNote: string
}

/** Client-only proof captured after one optimistic persona PATCH. */
export interface PersonaPatchOptimisticAcknowledgement {
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  attemptedPersona: PersonaSnapshot & { id: string }
  attemptedLegacyProfile: PersonaLegacyProfileProjection
  legacyProfileProjectionExpected: boolean
}

export interface PersonaPatchLocalEffect {
  kind: 'personaPatch'
  personaId: string
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  attemptedPatch: PersonaSnapshot
  attemptedPersona: PersonaSnapshot & { id: string }
  attemptedLegacyProfile: PersonaLegacyProfileProjection
  legacyProfileProjectionApplied: boolean
}

export type PersonaMutationOperation = 'create' | 'delete' | 'select' | 'reorder'

/** Client-only proof captured around one optimistic persona structure mutation. */
export interface PersonaMutationOptimisticAcknowledgement {
  operation: PersonaMutationOperation
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  beforePersonaIds: string[]
  attemptedPersonaIds: string[]
  attemptedPersonas: Array<PersonaSnapshot & { id: string }>
  beforeSelectedPersonaId: string | null
  attemptedSelectedPersonaId: string | null
  collectionWritten: boolean
  settingsWritten: boolean
  legacyProfileProjectionExpected: boolean
  attemptedLegacyProfile: PersonaProfileDigestValue | null
}

export interface PersonaMutationLocalEffect {
  kind: 'personaMutation'
  operation: PersonaMutationOperation
  targetPersonaId: string | null
  collectionProjectionEpoch: number
  settingsProjectionEpoch: number
  collectionWritten: boolean
  settingsWritten: boolean
}

/** Client-only proof captured after one optimistic translator-preset PATCH. */
export interface TranslatorPresetPatchOptimisticAcknowledgement {
  collectionProjectionEpoch: number
  languageSettingsProjectionEpoch: number
  selectedPresetId: string
  attemptedPreset: TranslatorPresetSnapshot & { id: string }
}

export interface TranslatorPresetPatchLocalEffect {
  kind: 'translatorPresetPatch'
  presetId: string
  collectionProjectionEpoch: number
  languageSettingsProjectionEpoch: number
  selectedPresetId: string
  attemptedPatch: TranslatorPresetSnapshot
  attemptedPreset: TranslatorPresetSnapshot & { id: string }
}

export interface LorebookMutationLocalEffect {
  kind: 'lorebookMutation'
  scope: 'global' | 'character' | 'chat'
  operation: 'replace' | 'upsert' | 'delete' | 'reorder'
  lorebookId?: string
  characterId?: string
  chatId?: string
  collectionProjectionEpoch?: number
  characterRowProjectionEpoch?: number
  characterLorebookProjectionEpoch?: number
}

export interface GlobalLorebookMutationLocalEffect {
  kind: 'globalLorebookMutation'
  operation: 'create' | 'update' | 'delete' | 'reorder' | 'select'
  lorebookId?: string
  lorebookIds?: string[]
  selectedLorebookId?: string | null
  collectionProjectionEpoch?: number
  pageProjectionEpoch?: number
}

export interface LoadoutMutationLocalEffect {
  kind: 'loadoutMutation'
  operation: 'create' | 'delete' | 'favorite' | 'touch'
  loadoutId: string
  loadoutsProjectionEpoch: number
  settingsProjectionEpoch?: number
  loadedName?: string
}

export interface CharacterDefinitionMutationLocalEffect {
  kind: 'characterDefinitionMutation'
  operation: 'scripts' | 'triggers'
  characterId: string
  optimisticRowEpoch: number
  definitions: Array<ScriptDefinitionSnapshot | TriggerDefinitionSnapshot>
}

export interface MessageTranslationLocalEffect {
  kind: 'messageTranslation'
  chatId: string
  messageId: string
  translation: MessageTranslation
}

export interface MessageMutationLocalEffect {
  kind: 'messageMutation'
  operation: 'append' | 'update' | 'delete' | 'truncate' | 'replaceTail' | 'replaceAll'
  chatId: string
  messageId?: string
  chatBodyProjectionEpoch: number
}

export interface CharacterRowMutationLocalEffect {
  kind: 'characterRowMutation'
  operation: 'chatFolderUpdate' | 'chatScriptstate'
  characterId: string
  targetId: string
}

export interface CharacterOrderLocalEffect {
  kind: 'characterOrder'
  attemptedOrder: CharacterOrderEntry[]
}

export type ServerCommandLocalEffect = (
  | ChatGenerationSettingsLocalEffect
  | CharacterPatchLocalEffect
  | CharacterSelectionLocalEffect
  | CharacterCollectionMutationLocalEffect
  | ChatPatchLocalEffect
  | ChatStructureMutationLocalEffect
  | SettingsPatchLocalEffect
  | PluginStorageLocalEffect
  | PluginCollectionMutationLocalEffect
  | PluginProviderLocalEffect
  | ModuleCollectionMutationLocalEffect
  | ModuleEnabledLocalEffect
  | PromptItemMutationLocalEffect
  | SplitPresetPatchLocalEffect
  | LegacyPresetPatchLocalEffect
  | PresetReorderLocalEffect
  | AgentPresetPatchLocalEffect
  | AgentPresetStepPatchLocalEffect
  | AgentPresetCollectionMutationLocalEffect
  | PersonaPatchLocalEffect
  | PersonaMutationLocalEffect
  | TranslatorPresetPatchLocalEffect
  | GlobalLorebookMutationLocalEffect
  | LorebookMutationLocalEffect
  | LoadoutMutationLocalEffect
  | CharacterDefinitionMutationLocalEffect
  | MessageTranslationLocalEffect
  | MessageMutationLocalEffect
  | CharacterRowMutationLocalEffect
  | CharacterOrderLocalEffect
) & {
  /** Non-enumerable transport proof captured when the optimistic command is enqueued. */
  readonly destructiveRefreshEpoch?: number
}

export type ServerCommandErrorReason =
  | 'database-lineage'
  | 'initialize-conflict'
  | 'invalid-request'
  | 'mutation-id-conflict'
  | 'not-found'
  | 'stale-writer'
  | 'unrecognized-rejection'

export type ServerCommandResult<T extends Record<string, unknown> = {}> =
  | ({ status: 'ok'; revision: number; event: CommandEvent } & T)
  | { status: 'conflict'; currentRevision: number }
  | {
      status: 'error'
      error: string
      reason?: ServerCommandErrorReason
    }
  | { status: 'unavailable' }

export interface UpsertServerInlayCatalogInput {
  aliases?: string[]
  assetId: string
  baseRevision: number
  height?: number
  name: string
  width?: number
}

export type BardWikiChatSettingsPatch = Partial<
  Pick<
    BardWikiChatSettings,
    | 'enabledOverride'
    | 'memoryModeOverride'
    | 'confirmationPolicyOverride'
    | 'canonicalUpdatesOverride'
    | 'totalTokenBudgetOverride'
    | 'hybridHypaTokenBudgetOverride'
    | 'hybridBardWikiTokenBudgetOverride'
    | 'maxDocumentsOverride'
    | 'maxLinkHopsOverride'
    | 'recentMessageCountOverride'
    | 'modelProfileIdOverride'
    | 'modelProfileIdIsSet'
    | 'promptPresetIdOverride'
    | 'promptPresetIdIsSet'
  >
>

export interface BardWikiDocumentCommandFields {
  kind?: BardWikiDocumentKind
  title?: string
  logicalPath?: string
  aliases?: string[]
  contextPolicy?: BardWikiContextPolicy
  reviewState?: BardWikiReviewState
  markdown?: string
}

export interface PatchBardWikiChatSettingsCommandInput {
  baseRevision: number
  chatId: string
  patch: BardWikiChatSettingsPatch
}

export interface CreateBardWikiDocumentCommandInput {
  baseRevision: number
  chatId: string
  document: Required<Pick<BardWikiDocumentCommandFields, 'kind' | 'title' | 'logicalPath' | 'markdown'>> &
    BardWikiDocumentCommandFields
}

export interface UpdateBardWikiDocumentCommandInput {
  baseRevision: number
  chatId: string
  documentId: string
  expectedVersion: number
  expectedContentHash: string
  patch: BardWikiDocumentCommandFields
}

export interface DeleteBardWikiDocumentCommandInput {
  baseRevision: number
  chatId: string
  documentId: string
  expectedVersion: number
  expectedContentHash: string
}

export interface ConfirmBardWikiAssistantCommandInput {
  baseRevision: number
  chatId: string
  userMessageId: string
  userContentHash: string
  assistantMessageId: string
  assistantContentHash: string
}

export type BardWikiRebuildPolicy = 'missing' | 'full'

export interface BardWikiRebuildPreview {
  chatId: string
  policy: BardWikiRebuildPolicy
  sourceCount: number
  replaceDerivedDocumentCount: number
  preserveUserDocumentCount: number
  activeJobId: string | null
}

export interface QueueBardWikiRebuildCommandInput {
  baseRevision: number
  chatId: string
  policy: BardWikiRebuildPolicy
  expectedSourceCount: number
}

export type BardWikiVaultConflictStrategy = 'skip' | 'rename' | 'replace'

export interface BardWikiVaultExpectedTarget {
  documentId: string
  version: number
  contentHash: string
}

export interface BardWikiVaultImportAction {
  sourceDocumentId: string
  targetDocumentId: string
  action: 'create' | 'replace' | 'noop' | 'skip'
  logicalPath: string
  conflict: 'id' | 'path' | 'id_and_path' | 'ambiguous' | null
}

export interface BardWikiVaultImportPlan {
  format: 'risu-bardwiki-vault'
  version: 1
  strategy: BardWikiVaultConflictStrategy
  creates: number
  replacements: number
  noops: number
  skips: number
  renames: number
  applicable: boolean
  actions: BardWikiVaultImportAction[]
}

export interface BardWikiVaultImportCommandInput {
  baseRevision?: number
  chatId: string
  dryRun: boolean
  strategy: BardWikiVaultConflictStrategy
  archiveBase64: string
  expectedTargets?: BardWikiVaultExpectedTarget[]
}

export interface DeleteServerInlayCatalogInput {
  assetId: string
  baseRevision: number
}

export type SettingsPatch = Record<string, unknown>

export type RuntimeSettingsPatch = SettingsPatch

export interface PatchRuntimeSettingsInput {
  baseRevision: number
  patch: RuntimeSettingsPatch
}

export interface PatchSettingsGroupInput {
  group: SettingsGroup
  baseRevision: number
  patch: SettingsPatch
  /** Opt in only when the attempted patch is already visible in the local projection. */
  acknowledgeOptimistic?: boolean
  /** Settings-group epoch captured before that optimistic projection write. */
  optimisticProjectionEpoch?: number
}

export interface PatchSettingsObjectFieldsInput {
  group: SettingsGroup
  key: string
  baseRevision: number
  update: SparseSettingsObjectUpdate
  attemptedObject: Record<string, unknown>
  optimisticProjectionEpoch: number
}

export interface PatchServerBackedSettingsInput {
  patch: SettingsPatch
  /** Opt in only when every patched value is already visible in the local projection. */
  acknowledgeOptimistic?: boolean
  /** Per-group epochs captured when those optimistic intents were created. */
  optimisticProjectionEpochs?: Readonly<SettingsGroupProjectionEpochs>
  rollback?: () => void
  signal?: AbortSignal | null
  keepalive?: boolean
  mutationId?: string
  databaseLineage?: string
  executionWrapper?: ServerCommandExecutionWrapper
  failureRollbackDisposition?: ServerCommandFailureRollbackDispositionResolver
}

export type PresetSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
}

export type PromptItemSnapshot = Record<string, unknown> & {
  id?: string
  type?: string
}

export type PersonaSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  displayName?: string
  icon?: string
  personaPrompt?: string
  note?: string
  largePortrait?: boolean
  modules?: string[]
}

export type TranslatorPresetSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  prompt?: string
  maxResponse?: number
  steps?: TranslatorPresetStep[]
}

export type LoadoutSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  lastUsed?: number
  favorite?: boolean
  characterIds?: string[]
  modules?: string[]
  globalVariables?: Record<string, string>
  presetName?: string
  modelPresetId?: string
  modelPresetName?: string
  promptPresetId?: string
  promptPresetName?: string
  agentPresetId?: string
  agentPresetName?: string
  togglePresetId?: string
  personaId?: string
}

export type CharacterSnapshot = Record<string, unknown> & {
  chaId?: string
  name?: string
  displayName?: string
  trashTime?: number | null
}

export type CharacterOrderEntry =
  | string
  | (Record<string, unknown> & {
      id: string
      name?: string
      color?: string
      data: string[]
      askBeforeOpening?: boolean
      imgFile?: string | null
      img?: string
    })

export type ChatSnapshot = Record<string, unknown> & {
  id?: string
  message?: unknown[]
  note?: string
  name?: string
  localLore?: unknown[]
  generationSettings?: ChatGenerationSettings
  folderId?: string | null
  bindedPersona?: string
  hypaContextTruncationAcknowledged?: boolean
  translatorPresetId?: string | null
  autoTranslate?: boolean | null
  autoTranslateBotOnly?: boolean | null
  bilingualDisplay?: boolean | null
  bilingualEmphasis?: 'original' | 'translation' | null
  bookmarks?: string[]
  bookmarkNames?: Record<string, string>
  modules?: string[]
}

export type LorebookEntrySnapshot = Record<string, unknown> & {
  id?: string
  key?: string
  secondkey?: string
  insertorder?: number
  comment?: string
  content?: string
  mode?: string
  alwaysActive?: boolean
  selective?: boolean
  folder?: string
}

export type GlobalLorebookSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  data?: LorebookEntrySnapshot[]
}

export interface SparseLorebookEntryUpdate {
  patch: LorebookEntrySnapshot
  deleteKeys?: string[]
}

export type ModuleSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  description?: string
  namespace?: string
  folderId?: string | null
  lowLevelAccess?: boolean
  scriptModelOverrides?: ScriptModelOverrides
  hideIcon?: boolean
  backgroundEmbedding?: string
  customModuleToggle?: string
  cjs?: string
}

export type PluginSnapshot = Record<string, unknown> & {
  name?: string
  script?: string
  arguments?: Record<string, 'int' | 'string' | string[]>
  realArg?: Record<string, string | number>
  customLink?: Array<{ link: string; hoverText?: string }>
  argMeta?: Record<string, Record<string, string>>
  version?: '3.0'
  displayName?: string
  versionOfPlugin?: string
  updateURL?: string
  enabled?: boolean
  allowedIPC?: string[]
}

export type ScriptDefinitionSnapshot = Record<string, unknown> & {
  id?: string
  comment?: string
  in?: string
  out?: string
  type?: string
  flag?: string
  ableFlag?: boolean
}

export type TriggerDefinitionSnapshot = Record<string, unknown> & {
  id?: string
  comment?: string
  type?: string
  conditions?: unknown[]
  effect?: unknown[]
}

export type ChatScriptstateValue = string | number | boolean
export type ChatScriptstatePatch = Record<string, ChatScriptstateValue>

export type ChatFolderSnapshot = Record<string, unknown> & {
  id?: string
  name?: string
  color?: string
  folded?: boolean
}

export type MessageSnapshot = Record<string, unknown> & {
  role?: 'user' | 'char'
  data?: string
  chatId?: string
  translation?: MessageTranslation | null
}

export interface PresetCommandInput {
  baseRevision: number
}

export interface CompleteOnboardingCommandInput {
  baseRevision: number
  modelPresetId: string
  promptPresetId: string
  modelPatch: ModelPresetSnapshot
  promptPatch: PromptPresetSnapshot
  settingsPatch: SettingsPatch
}

export interface CreatePresetCommandInput extends PresetCommandInput {
  preset: PresetSnapshot
}

export interface UpdatePresetCommandInput extends PresetCommandInput {
  presetId: string
  patch: PresetSnapshot
  optimisticAcknowledgement?: LegacyPresetPatchOptimisticAcknowledgement
}

export interface DeletePresetCommandInput extends PresetCommandInput {
  presetId: string
  selectPresetId?: string
  apply?: boolean
  saveCurrent?: boolean
}

export interface CopyPresetCommandInput extends PresetCommandInput {
  presetId: string
  newPresetId: string
  name?: string
  saveCurrent?: boolean
}

export interface SelectPresetCommandInput extends PresetCommandInput {
  presetId: string
  apply?: boolean
  saveCurrent?: boolean
}

export interface ImportPresetCommandInput extends PresetCommandInput {
  preset: PresetSnapshot
}

export interface ReorderPresetsCommandInput extends PresetCommandInput {
  presetIds: string[]
  optimisticAcknowledgement?: PresetReorderOptimisticAcknowledgement
}

export type ModelPresetSnapshot = Record<string, unknown>
export type PromptPresetSnapshot = Record<string, unknown>
export type AgentPresetSnapshot = Partial<AgentPresetRecord> & Record<string, unknown>
export type AgentPresetStepSnapshot = Partial<AgentPresetStepRecord> & Record<string, unknown>
export type AgentSnapshot = Partial<AgentRecord> & Record<string, unknown>
export type AgentPresetUseSnapshot = Partial<AgentPresetUseRecord> & Record<string, unknown>

function normalizePromptTemplateProperty<T extends Record<string, unknown>>(record: T): T {
  const normalized = { ...record }
  if (Object.prototype.hasOwnProperty.call(normalized, 'promptTemplate')) {
    const target = normalized as Record<string, unknown>
    target.promptTemplate = normalizePromptTemplate(target.promptTemplate)
  }
  return normalized
}

function normalizePromptItemSnapshot(item: PromptItemSnapshot): PromptItemSnapshot {
  const normalized = normalizePromptTemplate([item])?.[0]
  return normalized && typeof normalized === 'object' ? (normalized as PromptItemSnapshot) : { ...item }
}

function normalizePromptItemPatch(patch: PromptItemSnapshot): PromptItemSnapshot {
  const normalized = { ...patch }
  if (Object.prototype.hasOwnProperty.call(normalized, 'role2')) {
    normalized.role2 = normalizePromptRole(normalized.role2) ?? 'system'
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'role')) {
    if (normalized.type === 'cache') {
      normalized.role = normalizeCacheRole(normalized.role)
    } else if (normalized.type === 'plain' || normalized.type === 'jailbreak' || normalized.type === 'cot') {
      normalized.role = normalizePromptRole(normalized.role) ?? 'system'
    }
  }
  return normalized
}

export interface ModelPresetCommandInput {
  baseRevision: number
}

export interface CreateModelPresetCommandInput extends ModelPresetCommandInput {
  preset: ModelPresetSnapshot
}

export interface UpdateModelPresetCommandInput extends ModelPresetCommandInput {
  modelPresetId: string
  patch: ModelPresetSnapshot
  optimisticAcknowledgement?: SplitPresetPatchOptimisticAcknowledgement
}

export interface DeleteModelPresetCommandInput extends ModelPresetCommandInput {
  modelPresetId: string
  selectModelPresetId?: string
}

export interface SelectModelPresetCommandInput extends ModelPresetCommandInput {
  modelPresetId: string
}

export interface ImportModelPresetCommandInput extends ModelPresetCommandInput {
  preset: ModelPresetSnapshot
}

export interface ReorderModelPresetsCommandInput extends ModelPresetCommandInput {
  modelPresetIds: string[]
  optimisticAcknowledgement?: PresetReorderOptimisticAcknowledgement
}

export interface PromptPresetCommandInput {
  baseRevision: number
}

export interface CreatePromptPresetCommandInput extends PromptPresetCommandInput {
  preset: PromptPresetSnapshot
}

export interface UpdatePromptPresetCommandInput extends PromptPresetCommandInput {
  promptPresetId: string
  patch: PromptPresetSnapshot
  optimisticAcknowledgement?: SplitPresetPatchOptimisticAcknowledgement
}

export interface DeletePromptPresetCommandInput extends PromptPresetCommandInput {
  promptPresetId: string
  selectPromptPresetId?: string
}

export interface SelectPromptPresetCommandInput extends PromptPresetCommandInput {
  promptPresetId: string
}

export interface ImportPromptPresetCommandInput extends PromptPresetCommandInput {
  preset: PromptPresetSnapshot
}

export interface ReorderPromptPresetsCommandInput extends PromptPresetCommandInput {
  promptPresetIds: string[]
}

export interface AgentPresetCommandInput {
  baseRevision: number
}

export interface CreateAgentCommandInput extends AgentPresetCommandInput {
  agent: AgentSnapshot
}

export interface UpdateAgentCommandInput extends AgentPresetCommandInput {
  agentId: string
  patch: AgentSnapshot
}

export interface DuplicateAgentCommandInput extends AgentPresetCommandInput {
  agentId: string
  name?: string
}

export interface DeleteAgentCommandInput extends AgentPresetCommandInput {
  agentId: string
}

export interface ReorderAgentsCommandInput extends AgentPresetCommandInput {
  agentIds: string[]
}

export interface CreateAgentPresetUseCommandInput extends AgentPresetCommandInput {
  presetId: string
  use: AgentPresetUseSnapshot
}

export interface UpdateAgentPresetUseCommandInput extends AgentPresetCommandInput {
  presetId: string
  useId: string
  patch: AgentPresetUseSnapshot
}

export interface DeleteAgentPresetUseCommandInput extends AgentPresetCommandInput {
  presetId: string
  useId: string
}

export interface ReorderAgentPresetUsesCommandInput extends AgentPresetCommandInput {
  presetId: string
  useIds: string[]
}

export interface CreateAgentPresetCommandInput extends AgentPresetCommandInput {
  preset: AgentPresetSnapshot
}

export interface UpdateAgentPresetCommandInput extends AgentPresetCommandInput {
  presetId: string
  patch: AgentPresetSnapshot
  optimisticAcknowledgement?: AgentPresetPatchOptimisticAcknowledgement
}

export interface DuplicateAgentPresetCommandInput extends AgentPresetCommandInput {
  presetId: string
  name?: string
}

export interface DeleteAgentPresetCommandInput extends AgentPresetCommandInput {
  presetId: string
}

export interface ReorderAgentPresetsCommandInput extends AgentPresetCommandInput {
  presetIds: string[]
  optimisticAcknowledgement?: AgentPresetCollectionOptimisticAcknowledgement
}

export interface SetAgentPresetDefaultCommandInput extends AgentPresetCommandInput {
  agentPresetId: string | null
  optimisticAcknowledgement?: AgentPresetCollectionOptimisticAcknowledgement
}

export interface CreateAgentPresetStepCommandInput extends AgentPresetCommandInput {
  presetId: string
  step: AgentPresetStepSnapshot
}

export interface UpdateAgentPresetStepCommandInput extends AgentPresetCommandInput {
  presetId: string
  stepId: string
  patch: AgentPresetStepSnapshot
  optimisticAcknowledgement?: AgentPresetPatchOptimisticAcknowledgement
}

export interface DuplicateAgentPresetStepCommandInput extends AgentPresetCommandInput {
  presetId: string
  stepId: string
  name?: string
}

export interface DeleteAgentPresetStepCommandInput extends AgentPresetCommandInput {
  presetId: string
  stepId: string
}

export interface ReorderAgentPresetStepsCommandInput extends AgentPresetCommandInput {
  presetId: string
  stepIds: string[]
}

export type ModelProfileSnapshot = Omit<ModelProfileRecord, 'id'> & {
  id?: string
}

export type ModelRuntimeDefaultsSnapshot = ModelProfileRecordRuntimeOptions

export interface ModelProfileCommandInput {
  baseRevision: number
}

export interface CreateModelProfileCommandInput extends ModelProfileCommandInput {
  profile: ModelProfileSnapshot
}

export interface UpdateModelProfileCommandInput extends ModelProfileCommandInput {
  profileId: string
  profile: ModelProfileSnapshot
  expectedProfile: ModelProfileSnapshot
}

export interface DuplicateModelProfileCommandInput extends ModelProfileCommandInput {
  profileId: string
  name?: string
}

export interface ReorderModelProfilesCommandInput extends ModelProfileCommandInput {
  order: ModelProfileOrderEntry[]
}

export type ProviderCredentialSnapshot = Omit<ProviderCredentialRecord, 'id'> & {
  id?: string
}

export interface CreateProviderCredentialCommandInput extends ModelProfileCommandInput {
  credential: ProviderCredentialSnapshot
}

export interface UpdateProviderCredentialCommandInput extends ModelProfileCommandInput {
  credentialId: string
  credential: ProviderCredentialSnapshot
  expectedCredential: ProviderCredentialSnapshot
}

export interface DeleteProviderCredentialCommandInput extends ModelProfileCommandInput {
  credentialId: string
}

export interface DeleteModelProfileCommandInput extends ModelProfileCommandInput {
  profileId: string
  reassignments: Partial<Record<ModelRole, ModelRoleProfileBinding>>
}

export interface UpdateModelRoleProfilesCommandInput extends ModelProfileCommandInput {
  bindings: Partial<Record<ModelRole, ModelRoleProfileBinding>>
  modelPresetId?: string
}

export interface CreateAndBindModelProfileCommandInput extends ModelProfileCommandInput {
  role: ModelRole
  profile: ModelProfileSnapshot
}

export interface UpdateModelRuntimeDefaultsCommandInput extends ModelProfileCommandInput {
  runtimeDefaults: ModelRuntimeDefaultsSnapshot
}

export interface ConvertLegacyModelProfilesCommandInput extends ModelProfileCommandInput {}

export interface ExtractLegacyBotPresetCommandInput {
  baseRevision: number
  presetId: string
  mode: 'all' | 'model' | 'prompt'
}

export interface PatchPromptSettingsCommandInput {
  baseRevision: number
  patch: SettingsPatch
  acknowledgeOptimistic?: boolean
  optimisticProjectionEpoch?: number
}

interface PromptItemOptimisticCommandInput {
  optimisticAcknowledgement?: PromptItemOptimisticAcknowledgement
}

export interface CreatePromptItemCommandInput extends PromptItemOptimisticCommandInput {
  baseRevision: number
  promptPresetId?: string
  promptItem: PromptItemSnapshot
}

export interface UpdatePromptItemCommandInput extends PromptItemOptimisticCommandInput {
  baseRevision: number
  promptPresetId?: string
  itemId: string
  patch: PromptItemSnapshot
  deleteKeys?: string[]
}

export interface DeletePromptItemCommandInput extends PromptItemOptimisticCommandInput {
  baseRevision: number
  promptPresetId?: string
  itemId: string
}

export interface ReorderPromptItemsCommandInput extends PromptItemOptimisticCommandInput {
  baseRevision: number
  promptPresetId?: string
  itemIds: string[]
}

export interface EnablePromptItemsCommandInput extends PromptItemOptimisticCommandInput {
  baseRevision: number
  promptPresetId?: string
  enabled: boolean
}

export interface PersonaCommandInput {
  baseRevision: number
}

export interface CreatePersonaCommandInput extends PersonaCommandInput {
  persona: PersonaSnapshot
  mirrorLegacyProfile?: boolean
  optimisticAcknowledgement?: PersonaMutationOptimisticAcknowledgement
}

export interface UpdatePersonaCommandInput extends PersonaCommandInput {
  personaId: string
  patch: PersonaSnapshot
  mirrorLegacyProfile?: boolean
  optimisticAcknowledgement?: PersonaPatchOptimisticAcknowledgement
}

export interface DeletePersonaCommandInput extends PersonaCommandInput {
  personaId: string
  selectPersonaId?: string
  mirrorLegacyProfile?: boolean
  saveCurrent?: boolean
  optimisticAcknowledgement?: PersonaMutationOptimisticAcknowledgement
}

export interface SelectPersonaCommandInput extends PersonaCommandInput {
  personaId: string
  mirrorLegacyProfile?: boolean
  saveCurrent?: boolean
  optimisticAcknowledgement?: PersonaMutationOptimisticAcknowledgement
}

export interface ReorderPersonasCommandInput extends PersonaCommandInput {
  personaIds: string[]
  optimisticAcknowledgement?: PersonaMutationOptimisticAcknowledgement
}

export interface TranslatorPresetCommandInput {
  baseRevision: number
}

export interface CreateTranslatorPresetCommandInput extends TranslatorPresetCommandInput {
  preset: TranslatorPresetSnapshot
  select?: boolean
}

export interface UpdateTranslatorPresetCommandInput extends TranslatorPresetCommandInput {
  presetId: string
  patch: TranslatorPresetSnapshot
  optimisticAcknowledgement?: TranslatorPresetPatchOptimisticAcknowledgement
}

export interface DeleteTranslatorPresetCommandInput extends TranslatorPresetCommandInput {
  presetId: string
  selectPresetId?: string
}

export interface SelectTranslatorPresetCommandInput extends TranslatorPresetCommandInput {
  presetId: string
}

export interface LoadoutCommandInput {
  baseRevision: number
}

export interface CreateLoadoutCommandInput extends LoadoutCommandInput {
  loadout: LoadoutSnapshot
  acknowledgeOptimistic?: boolean
  loadoutsProjectionEpoch?: number
}

export interface UpdateLoadoutCommandInput extends LoadoutCommandInput {
  loadoutId: string
  patch: LoadoutSnapshot
}

export interface DeleteLoadoutCommandInput extends LoadoutCommandInput {
  loadoutId: string
  acknowledgeOptimistic?: boolean
  loadoutsProjectionEpoch?: number
}

export interface FavoriteLoadoutCommandInput extends LoadoutCommandInput {
  loadoutId: string
  favorite: boolean
  acknowledgeOptimistic?: boolean
  loadoutsProjectionEpoch?: number
}

export interface TouchLoadoutCommandInput extends LoadoutCommandInput {
  loadoutId: string
  lastUsed?: number
  characterId?: string
  acknowledgeOptimistic?: boolean
  loadoutsProjectionEpoch?: number
  settingsProjectionEpoch?: number
  loadedName?: string
}

export interface CharacterCommandInput {
  baseRevision: number
}

export interface CreateCharacterCommandInput extends CharacterCommandInput {
  character: CharacterSnapshot
  initialChat?: ChatSnapshot
}

export interface CreateAndSelectCharacterCommandInput extends CreateCharacterCommandInput {
  lastInteraction?: number
}

export interface UpdateCharacterCommandInput extends CharacterCommandInput {
  characterId: string
  patch: CharacterSnapshot
}

export interface MutateAlternateGreetingsCommandInput extends CharacterCommandInput {
  characterId: string
  alternateGreetings: string[]
  operation: AlternateGreetingMutation
  chatGreetingIndices: ChatGreetingIndex[]
}

export interface TranslateGreetingCommandInput extends CharacterCommandInput {
  characterId: string
  chatId: string
  greetingIndex: number
  jobId: string
}

export interface RecoverColdStorageCharacterCommandInput extends CharacterCommandInput {
  characterId: string
  key: string
}

export interface DeleteCharacterCommandInput extends CharacterCommandInput {
  characterId: string
}

export interface SelectCharacterCommandInput extends CharacterCommandInput {
  characterId: string
  lastInteraction?: number
}

export interface ReorderCharactersCommandInput extends CharacterCommandInput {
  characterOrder: CharacterOrderEntry[]
}

export interface ChatCommandInput {
  baseRevision: number
  optimisticEpoch?: number
  optimisticRowEpoch?: number
}

export interface CreateChatCommandInput extends ChatCommandInput {
  characterId: string
  chat: ChatSnapshot
  select?: boolean
  acknowledgeOptimistic?: boolean
}

export interface ResetChatsCommandInput extends ChatCommandInput {
  characterId: string
  chat: ChatSnapshot
}

export interface UpdateChatCommandInput extends ChatCommandInput {
  chatId: string
  patch: ChatSnapshot
  select?: boolean
}

export interface RecoverColdStorageChatCommandInput extends ChatCommandInput {
  chatId: string
  key: string
}

export interface SaveChatGenerationSettingsCommandInput extends ChatCommandInput {
  chatId: string
  generationSettings: ChatGenerationSettings
  sparseUpdate?: SparseChatGenerationSettingsUpdate
  sparseBaseGenerationSettings?: ChatGenerationSettings | null
  expectedCharacterId?: string
  optimisticCharacterRowEpoch?: number
}

export interface DeleteChatCommandInput extends ChatCommandInput {
  chatId: string
  acknowledgeOptimistic?: boolean
}

export interface ForkChatCommandInput extends ChatCommandInput {
  chatId: string
  chat: ChatSnapshot
  sourcePatch?: ChatSnapshot
  folder?: ChatFolderSnapshot
  select?: boolean
  acknowledgeOptimistic?: boolean
}

export interface ReorderChatsCommandInput extends ChatCommandInput {
  characterId: string
  chatIds: string[]
  folderByChatId?: Record<string, string | null>
  selectedChatId?: string
  acknowledgeOptimistic?: boolean
}

export interface CreateChatFolderCommandInput extends ChatCommandInput {
  characterId: string
  folder: ChatFolderSnapshot
  acknowledgeOptimistic?: boolean
}

export interface UpdateChatFolderCommandInput extends ChatCommandInput {
  folderId: string
  patch: ChatFolderSnapshot
}

export interface DeleteChatFolderCommandInput extends ChatCommandInput {
  folderId: string
  acknowledgeOptimistic?: boolean
}

export interface ReorderChatFoldersCommandInput extends ChatCommandInput {
  characterId: string
  folderIds: string[]
  selectedChatId?: string
  acknowledgeOptimistic?: boolean
}

export interface PatchChatScriptstateCommandInput extends ChatCommandInput {
  chatId: string
  patch: ChatScriptstatePatch
  deleteKeys?: string[]
}

export interface LorebookCommandInput {
  baseRevision: number
}

interface TopLevelGlobalLorebookOptimisticMutationInput {
  acknowledgeOptimistic?: boolean
  optimisticCollectionEpoch?: number
  optimisticPageEpoch?: number
  optimisticSelectedLorebookId?: string | null
}

export interface CreateGlobalLorebookCommandInput
  extends LorebookCommandInput, TopLevelGlobalLorebookOptimisticMutationInput {
  lorebook: GlobalLorebookSnapshot
}

export interface UpdateGlobalLorebookCommandInput
  extends LorebookCommandInput, TopLevelGlobalLorebookOptimisticMutationInput {
  lorebookId: string
  patch: Pick<GlobalLorebookSnapshot, 'name'>
}

export interface DeleteGlobalLorebookCommandInput
  extends LorebookCommandInput, TopLevelGlobalLorebookOptimisticMutationInput {
  lorebookId: string
}

export interface ReorderGlobalLorebooksCommandInput
  extends LorebookCommandInput, TopLevelGlobalLorebookOptimisticMutationInput {
  lorebookIds: string[]
}

export interface SelectGlobalLorebookCommandInput
  extends LorebookCommandInput, TopLevelGlobalLorebookOptimisticMutationInput {
  lorebookId: string
}

interface GlobalLorebookOptimisticMutationInput {
  acknowledgeOptimistic?: boolean
  optimisticEntries?: LorebookEntrySnapshot[]
  optimisticCollectionEpoch?: number
  optimisticEntryIndex?: number
  optimisticEntryCreated?: boolean
}

interface CharacterLorebookOptimisticMutationInput {
  acknowledgeOptimistic?: boolean
  optimisticEntries?: LorebookEntrySnapshot[]
  optimisticRowEpoch?: number
  optimisticLorebookEpoch?: number
  optimisticEntryIndex?: number
  optimisticEntryCreated?: boolean
}

interface ChatLorebookOptimisticMutationInput {
  acknowledgeOptimistic?: boolean
  optimisticEntries?: LorebookEntrySnapshot[]
  optimisticCharacterId?: string
  optimisticRowEpoch?: number
  optimisticEntryIndex?: number
  optimisticEntryCreated?: boolean
}

export interface ReplaceGlobalLorebookEntriesCommandInput
  extends LorebookCommandInput, GlobalLorebookOptimisticMutationInput {
  lorebookId: string
  entries: LorebookEntrySnapshot[]
}

export interface UpsertGlobalLorebookEntryCommandInput
  extends LorebookCommandInput, GlobalLorebookOptimisticMutationInput {
  lorebookId: string
  entryId: string
  entry: LorebookEntrySnapshot
  sparseUpdate?: SparseLorebookEntryUpdate
}

export interface DeleteGlobalLorebookEntryCommandInput
  extends LorebookCommandInput, GlobalLorebookOptimisticMutationInput {
  lorebookId: string
  entryId: string
}

export interface ReorderGlobalLorebookEntriesCommandInput
  extends LorebookCommandInput, GlobalLorebookOptimisticMutationInput {
  lorebookId: string
  entryIds: string[]
}

export interface ReplaceCharacterLorebooksCommandInput
  extends LorebookCommandInput, CharacterLorebookOptimisticMutationInput {
  characterId: string
  entries: LorebookEntrySnapshot[]
}

export interface UpsertCharacterLorebookEntryCommandInput
  extends LorebookCommandInput, CharacterLorebookOptimisticMutationInput {
  characterId: string
  entryId: string
  entry: LorebookEntrySnapshot
  sparseUpdate?: SparseLorebookEntryUpdate
}

export interface DeleteCharacterLorebookEntryCommandInput
  extends LorebookCommandInput, CharacterLorebookOptimisticMutationInput {
  characterId: string
  entryId: string
}

export interface ReorderCharacterLorebookEntriesCommandInput
  extends LorebookCommandInput, CharacterLorebookOptimisticMutationInput {
  characterId: string
  entryIds: string[]
}

export interface ReplaceChatLorebooksCommandInput extends LorebookCommandInput, ChatLorebookOptimisticMutationInput {
  chatId: string
  entries: LorebookEntrySnapshot[]
}

export interface UpsertChatLorebookEntryCommandInput extends LorebookCommandInput, ChatLorebookOptimisticMutationInput {
  chatId: string
  entryId: string
  entry: LorebookEntrySnapshot
  sparseUpdate?: SparseLorebookEntryUpdate
}

export interface DeleteChatLorebookEntryCommandInput extends LorebookCommandInput, ChatLorebookOptimisticMutationInput {
  chatId: string
  entryId: string
}

export interface ReorderChatLorebookEntriesCommandInput
  extends LorebookCommandInput, ChatLorebookOptimisticMutationInput {
  chatId: string
  entryIds: string[]
}

export interface ReplaceModuleLorebooksCommandInput extends LorebookCommandInput {
  moduleId: string
  entries: LorebookEntrySnapshot[]
}

export interface UpsertModuleLorebookEntryCommandInput extends LorebookCommandInput {
  moduleId: string
  entryId: string
  entry: LorebookEntrySnapshot
  sparseUpdate?: SparseLorebookEntryUpdate
}

export interface DeleteModuleLorebookEntryCommandInput extends LorebookCommandInput {
  moduleId: string
  entryId: string
}

export interface ReorderModuleLorebookEntriesCommandInput extends LorebookCommandInput {
  moduleId: string
  entryIds: string[]
}

export interface ScriptDefinitionCommandInput {
  baseRevision: number
}

export interface MutateGlobalScriptsCommandInput extends ScriptDefinitionCommandInput {
  mutation: ScriptDefinitionCollectionMutation
  expectedScripts: ScriptDefinitionSnapshot[]
  optimisticProjectionEpoch: number
}

export interface ReplaceCharacterScriptsCommandInput extends ScriptDefinitionCommandInput {
  characterId: string
  scripts: ScriptDefinitionSnapshot[]
  optimisticRowEpoch?: number
}

export interface MutateCharacterScriptsCommandInput extends ScriptDefinitionCommandInput {
  characterId: string
  mutation: ScriptDefinitionCollectionMutation
  expectedScripts: ScriptDefinitionSnapshot[]
  optimisticRowEpoch?: number
}

export interface ReplaceCharacterTriggersCommandInput extends ScriptDefinitionCommandInput {
  characterId: string
  triggers: TriggerDefinitionSnapshot[]
  optimisticRowEpoch?: number
}

export interface MutateCharacterTriggersCommandInput extends ScriptDefinitionCommandInput {
  characterId: string
  mutation: ScriptDefinitionCollectionMutation
  expectedTriggers: TriggerDefinitionSnapshot[]
  optimisticRowEpoch?: number
}

export interface ReplaceModuleScriptsCommandInput extends ScriptDefinitionCommandInput {
  moduleId: string
  scripts: ScriptDefinitionSnapshot[]
  optimisticCollectionEpoch?: number
}

export interface MutateModuleScriptsCommandInput extends ScriptDefinitionCommandInput {
  moduleId: string
  mutation: ScriptDefinitionCollectionMutation
  expectedScripts: ScriptDefinitionSnapshot[]
  optimisticCollectionEpoch?: number
}

export interface ReplaceModuleTriggersCommandInput extends ScriptDefinitionCommandInput {
  moduleId: string
  triggers: TriggerDefinitionSnapshot[]
  optimisticCollectionEpoch?: number
}

export interface MutateModuleTriggersCommandInput extends ScriptDefinitionCommandInput {
  moduleId: string
  mutation: ScriptDefinitionCollectionMutation
  expectedTriggers: TriggerDefinitionSnapshot[]
  optimisticCollectionEpoch?: number
}

export interface ModuleCommandInput {
  baseRevision: number
}

export interface CreateModuleCommandInput extends ModuleCommandInput {
  module: ModuleSnapshot
}

export interface UpdateModuleCommandInput extends ModuleCommandInput {
  moduleId: string
  patch: ModuleSnapshot
}

export interface DeleteModuleCommandInput extends ModuleCommandInput {
  moduleId: string
}

export interface EnableModuleCommandInput extends ModuleCommandInput {
  moduleId: string
  enabled: boolean
}

export interface ReorderModulesCommandInput extends ModuleCommandInput {
  moduleIds: string[]
  folderByModuleId?: Record<string, string | null>
}

export interface CreateModuleFolderCommandInput extends ModuleCommandInput {
  folder: ModuleFolderSnapshot
}

export interface UpdateModuleFolderCommandInput extends ModuleCommandInput {
  folderId: string
  patch: Pick<ModuleFolderSnapshot, 'name'>
}

export interface DeleteModuleFolderCommandInput extends ModuleCommandInput {
  folderId: string
}

export interface ReorderModuleFoldersCommandInput extends ModuleCommandInput {
  folderIds: string[]
}

export interface ReorderCharacterModulesCommandInput extends ModuleCommandInput {
  characterId: string
  moduleIds: string[]
}

export interface PluginCommandInput {
  baseRevision: number
}

export interface CreatePluginCommandInput extends PluginCommandInput {
  plugin: PluginSnapshot
}

export interface UpdatePluginCommandInput extends PluginCommandInput {
  pluginId: string
  patch: PluginSnapshot
}

export interface DeletePluginCommandInput extends PluginCommandInput {
  pluginId: string
}

export interface EnablePluginCommandInput extends PluginCommandInput {
  pluginId: string
  enabled: boolean
}

export interface SelectPluginProviderCommandInput extends PluginCommandInput {
  provider: string
}

export interface ReorderPluginsCommandInput extends PluginCommandInput {
  pluginIds: string[]
}

export interface PutPluginStorageCommandInput extends PluginCommandInput {
  key: string
  value: unknown
}

export interface DeletePluginStorageCommandInput extends PluginCommandInput {
  key: string
}

export interface BulkPluginStorageCommandInput extends PluginCommandInput {
  values?: Record<string, unknown>
  deleteKeys?: string[]
  clear?: boolean
}

export interface AppendMessageCommandInput extends ChatCommandInput {
  chatId: string
  message: MessageSnapshot
  optimisticChatBodyProjectionEpoch?: number
}

/** The server commits an IGP append and its exact effect receipt atomically. */
export interface IgpEffectMessageClaim {
  generationId: string
  claimId: string
}

export interface UpdateMessageCommandInput extends ChatCommandInput {
  messageId: string
  patch: MessageSnapshot
  expectedData?: string
  expectedChatId?: string
  expectedGenerationId?: string
  igpEffect?: IgpEffectMessageClaim
  optimisticChatId?: string
  optimisticChatBodyProjectionEpoch?: number
}

export interface TranslateMessageCommandInput extends ChatCommandInput {
  messageId: string
  jobId: string
}

export interface DeleteMessageCommandInput extends ChatCommandInput {
  messageId: string
  optimisticChatId?: string
  optimisticChatBodyProjectionEpoch?: number
}

export interface TruncateMessagesCommandInput extends ChatCommandInput {
  chatId: string
  afterMessageId?: string | null
  optimisticChatBodyProjectionEpoch?: number
}

export interface ReplaceTailMessagesCommandInput extends ChatCommandInput {
  chatId: string
  afterMessageId?: string | null
  messages: MessageSnapshot[]
  optimisticChatBodyProjectionEpoch?: number
}

export interface ReplaceMessagesCommandInput extends ChatCommandInput {
  chatId: string
  messages: MessageSnapshot[]
  optimisticChatBodyProjectionEpoch?: number
}

export interface PersistGenerationResultCommandInput extends ChatCommandInput {
  chatId: string
  generationResult: {
    message: MessageSnapshot
    targetMessageId?: string
  }
}

export interface RunServerPresetCommandInput<T extends Record<string, unknown> = {}> {
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>
  rollback?: () => void
  signal?: AbortSignal | null
  keepalive?: boolean
  mutationId?: string
  databaseLineage?: string
  executionWrapper?: ServerCommandExecutionWrapper
  failureRollbackDisposition?: ServerCommandFailureRollbackDispositionResolver
}

export type ServerCommandFactory = (baseRevision: number) => Promise<ServerCommandResult>

export interface ServerCommandSequenceStep {
  command: ServerCommandFactory
  /** Runs around this step before its base revision is acquired. */
  executionWrapper?: ServerCommandExecutionWrapper
}

export type ServerCommandSequenceEntry = ServerCommandFactory | ServerCommandSequenceStep

export interface ServerCommandTransportOptions {
  signal?: AbortSignal | null
  keepalive?: boolean
  mutationId?: string
  databaseLineage?: string
  executionWrapper?: ServerCommandExecutionWrapper
  failureRollbackDisposition?: ServerCommandFailureRollbackDispositionResolver
}

export type ServerCommandFailureRollbackDisposition = 'retain' | 'rollback'

export type ServerCommandFailureRollbackDispositionResolver = (
  result: Exclude<ServerCommandResult, { status: 'ok' }>,
) => ServerCommandFailureRollbackDisposition

export type ServerCommandExecutionWrapper = <T extends Record<string, unknown>>(
  execute: () => Promise<ServerCommandResult<T>>,
) => Promise<ServerCommandResult<T>>

export type ExternalServerRevisionOperationResult<T> = { status: 'executed'; value: T } | { status: 'unavailable' }

let cachedServerCommandRevision: number | null = null
// The command/base-revision cursor may move ahead of the browser projection:
// conflicts and server-owned mutations tell us the latest server revision
// without proving that its resource state was applied locally. SSE replay,
// gap detection, and already-applied skips must therefore use this separate
// resource cursor instead of `cachedServerCommandRevision`.
let appliedServerResourceRevision: number | null = null
type ServerCommandSuccessReconciler = (
  event: CommandEvent,
  coalescedEvents: readonly CommandEvent[],
  localEffects: ReadonlyMap<number, ServerCommandLocalEffect>,
) => Promise<void> | void
type ServerCommandConflictGapHandler = (currentRevision: number, appliedRevision: number) => void

interface ServerCommandReconciliationBatch {
  sessionGeneration: number
  pendingEvents: Map<number, CommandEvent>
  pendingLocalEffects: Map<number, ServerCommandLocalEffect>
  completion: Promise<void>
  resolveCompletion: () => void
  flushScheduled: boolean
  flushing: boolean
}

interface DirectServerCommandReconciliation {
  sessionGeneration: number
  matches: (event: CommandEvent) => boolean
  pendingEvents: Map<number, CommandEvent>
}

let serverCommandSuccessReconciler: ServerCommandSuccessReconciler | null = null
let serverCommandConflictGapHandler: ServerCommandConflictGapHandler | null = null
// Every command domain shares one server revision. Keep high-level mutations and
// external operations that may advance that revision in one client queue so two
// unrelated writes cannot dispatch with the same base revision and self-conflict.
let serverCommandExecutionTail: Promise<void> = Promise.resolve()
let queuedServerCommandExecutionCount = 0
let activeServerCommandReconciliationBatch: ServerCommandReconciliationBatch | null = null
const directServerCommandReconciliations = new Set<DirectServerCommandReconciliation>()
// A queued optimistic command can wait behind another request while a full
// refresh replaces its local patch. Keep the epoch captured at enqueue time in
// scope for every transport that the queued factory starts, so its eventual
// local effect fails closed and triggers an authoritative reread.
let activeQueuedCommandDestructiveRefreshEpoch: number | null = null
let activeQueuedClientSessionGeneration: number | null = null
let activeQueuedCommandMutation: { id: string; databaseLineage: string; requestIndex: number } | null = null

/**
 * Wait until command work enqueued before this call and its reconciliation has
 * settled. Tests use this instead of timer guesses when production deliberately
 * dispatches a mutation without exposing its promise to the caller.
 */
export async function drainServerCommandExecutionForTests(earlierWork?: PromiseLike<unknown>): Promise<void> {
  await earlierWork

  while (true) {
    const observedTail = serverCommandExecutionTail
    await observedTail
    const observedBatch = activeServerCommandReconciliationBatch
    if (observedBatch) await observedBatch.completion
    await Promise.resolve()

    if (observedTail === serverCommandExecutionTail && activeServerCommandReconciliationBatch === null) return
  }
}

async function withQueuedCommandExecutionContext<T>(
  epoch: number,
  mutationId: string | undefined,
  databaseLineage: string | undefined,
  task: () => Promise<T>,
  sessionGeneration = captureClientSessionGeneration(),
): Promise<T> {
  const previousSessionGeneration = activeQueuedClientSessionGeneration
  activeQueuedClientSessionGeneration = sessionGeneration
  const previousEpoch = activeQueuedCommandDestructiveRefreshEpoch
  const previousMutation = activeQueuedCommandMutation
  activeQueuedCommandDestructiveRefreshEpoch = epoch
  activeQueuedCommandMutation = mutationId
    ? {
        id: normalizeMutationId(mutationId),
        databaseLineage: normalizeDatabaseLineage(databaseLineage),
        requestIndex: 0,
      }
    : null
  try {
    return await task()
  } finally {
    activeQueuedCommandDestructiveRefreshEpoch = previousEpoch
    activeQueuedCommandMutation = previousMutation
    activeQueuedClientSessionGeneration = previousSessionGeneration
  }
}

function normalizeMutationId(value: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,96}$/.test(normalized)) {
    throw new TypeError('Server mutation id is invalid')
  }
  return normalized
}

function normalizeDatabaseLineage(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new TypeError('Server database lineage is invalid')
  }
  return normalized
}

function nextQueuedCommandMutationRequest(): { mutationId: string; databaseLineage: string } | null {
  const context = activeQueuedCommandMutation
  if (!context) return null
  const index = context.requestIndex
  context.requestIndex += 1
  return {
    mutationId: index === 0 ? context.id : `${context.id}.${index}`,
    databaseLineage: context.databaseLineage,
  }
}

/**
 * Execute a command without durable receipt headers while preserving its queue
 * and destructive-refresh context. This is used only when browser durability
 * is unavailable: the ordinary save should still run, but the server must not
 * retain a receipt that the browser can never acknowledge.
 */
export async function runServerCommandWithoutMutationReceipt<T>(execute: () => Promise<T>): Promise<T> {
  const previousMutation = activeQueuedCommandMutation
  activeQueuedCommandMutation = null
  try {
    return await execute()
  } finally {
    activeQueuedCommandMutation = previousMutation
  }
}

/** Execute an already-reserved queue task under the exact prepared receipt id. */
export async function runServerCommandWithMutationReceipt<T>(
  execute: () => Promise<T>,
  mutationId: string,
  databaseLineage: string,
): Promise<T> {
  const previousMutation = activeQueuedCommandMutation
  activeQueuedCommandMutation = {
    id: normalizeMutationId(mutationId),
    databaseLineage: normalizeDatabaseLineage(databaseLineage),
    requestIndex: 0,
  }
  try {
    return await execute()
  } finally {
    activeQueuedCommandMutation = previousMutation
  }
}

function enqueueServerRevisionExecution<T>(task: () => Promise<T>, onSettled?: () => void): Promise<T> {
  const execution = serverCommandExecutionTail.then(task)
  const settledExecution = onSettled ? execution.finally(onSettled) : execution
  serverCommandExecutionTail = settledExecution.then(
    () => undefined,
    () => undefined,
  )
  return settledExecution
}

function enqueueServerCommandExecution<T>(task: (batch: ServerCommandReconciliationBatch) => Promise<T>): Promise<T> {
  const finishPersistenceActivity = beginPersistenceActivity()
  const batch = getOrCreateServerCommandReconciliationBatch()
  queuedServerCommandExecutionCount += 1

  const settledExecution = enqueueServerRevisionExecution(
    () => task(batch),
    () => finishServerCommandExecution(batch),
  )
  return settledExecution
    .then(
      async (value) => {
        await batch.completion
        return value
      },
      async (error) => {
        await batch.completion
        throw error
      },
    )
    .finally(finishPersistenceActivity)
}

function getOrCreateServerCommandReconciliationBatch(): ServerCommandReconciliationBatch {
  if (activeServerCommandReconciliationBatch) return activeServerCommandReconciliationBatch

  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  activeServerCommandReconciliationBatch = {
    sessionGeneration: captureClientSessionGeneration(),
    pendingEvents: new Map(),
    pendingLocalEffects: new Map(),
    completion,
    resolveCompletion,
    flushScheduled: false,
    flushing: false,
  }
  return activeServerCommandReconciliationBatch
}

function finishServerCommandExecution(batch: ServerCommandReconciliationBatch): void {
  queuedServerCommandExecutionCount = Math.max(0, queuedServerCommandExecutionCount - 1)
  if (queuedServerCommandExecutionCount === 0) scheduleServerCommandReconciliationFlush(batch)
}

function scheduleServerCommandReconciliationFlush(batch: ServerCommandReconciliationBatch): void {
  if (
    activeServerCommandReconciliationBatch !== batch ||
    batch.flushScheduled ||
    batch.flushing ||
    queuedServerCommandExecutionCount > 0
  ) {
    return
  }
  batch.flushScheduled = true
  queueMicrotask(() => {
    batch.flushScheduled = false
    void flushServerCommandReconciliationBatch(batch)
  })
}

async function flushServerCommandReconciliationBatch(batch: ServerCommandReconciliationBatch): Promise<void> {
  if (activeServerCommandReconciliationBatch !== batch || batch.flushing || queuedServerCommandExecutionCount > 0) {
    return
  }

  if (!isClientSessionGenerationCurrent(batch.sessionGeneration)) {
    batch.pendingEvents.clear()
    batch.pendingLocalEffects.clear()
    completeServerCommandReconciliationBatch(batch)
    return
  }
  batch.flushing = true
  try {
    while (activeServerCommandReconciliationBatch === batch && queuedServerCommandExecutionCount === 0) {
      if (!isClientSessionGenerationCurrent(batch.sessionGeneration)) {
        batch.pendingEvents.clear()
        batch.pendingLocalEffects.clear()
        completeServerCommandReconciliationBatch(batch)
        return
      }
      const coalescedEvents = Array.from(batch.pendingEvents.values()).sort(
        (left, right) => left.revision - right.revision,
      )
      const latestEvent = coalescedEvents.at(-1)
      if (!latestEvent) {
        completeServerCommandReconciliationBatch(batch)
        return
      }

      // Reconcile accepted revisions together so bootstrap can apply safe
      // contiguous local effects and issue at most one authoritative refresh
      // for the remaining invalidations.
      const localEffects = new Map<number, ServerCommandLocalEffect>()
      for (const coalescedEvent of coalescedEvents) {
        const effect = batch.pendingLocalEffects.get(coalescedEvent.revision)
        if (effect) localEffects.set(coalescedEvent.revision, effect)
      }
      await reconcileServerCommandSuccessEvents(latestEvent, coalescedEvents, localEffects)
      for (const revision of batch.pendingEvents.keys()) {
        if (revision <= latestEvent.revision) {
          batch.pendingEvents.delete(revision)
          batch.pendingLocalEffects.delete(revision)
        }
      }
    }
  } finally {
    batch.flushing = false
    if (activeServerCommandReconciliationBatch === batch && queuedServerCommandExecutionCount === 0) {
      if (batch.pendingEvents.size === 0) {
        completeServerCommandReconciliationBatch(batch)
      } else {
        scheduleServerCommandReconciliationFlush(batch)
      }
    }
  }
}

function completeServerCommandReconciliationBatch(batch: ServerCommandReconciliationBatch): void {
  if (activeServerCommandReconciliationBatch !== batch) return
  activeServerCommandReconciliationBatch = null
  batch.resolveCompletion()
}

function recordDeferredServerCommandSuccessEvent(
  batch: ServerCommandReconciliationBatch,
  event: CommandEvent,
  localEffect?: ServerCommandLocalEffect,
): void {
  batch.pendingEvents.set(event.revision, event)
  // The SSE own echo can arrive before the command response. Upgrade the
  // already-recorded event when the response later supplies its authoritative
  // local effect, and never let the duplicate executeServerCommand notify drop it.
  if (localEffect) batch.pendingLocalEffects.set(event.revision, localEffect)
}

export function deferOwnServerCommandReconciliation(
  event: CommandEvent,
  localEffect?: ServerCommandLocalEffect,
): boolean {
  if (!canUseClientWriteAccess()) return false
  const batch = activeServerCommandReconciliationBatch
  if (batch && isClientSessionGenerationCurrent(batch.sessionGeneration)) {
    recordDeferredServerCommandSuccessEvent(batch, event, localEffect)
    return true
  }

  let deferred = false
  for (const direct of directServerCommandReconciliations) {
    if (!isClientSessionGenerationCurrent(direct.sessionGeneration) || !direct.matches(event)) continue
    direct.pendingEvents.set(event.revision, event)
    deferred = true
  }
  return deferred
}

function beginDirectServerCommandReconciliation(
  matches: (event: CommandEvent) => boolean,
): DirectServerCommandReconciliation {
  const direct = {
    matches,
    sessionGeneration: captureClientSessionGeneration(),
    pendingEvents: new Map<number, CommandEvent>(),
  }
  directServerCommandReconciliations.add(direct)
  return direct
}

async function finishDirectServerCommandReconciliation(
  direct: DirectServerCommandReconciliation | null,
  confirmedEvent: CommandEvent | null,
): Promise<void> {
  if (!direct) return
  directServerCommandReconciliations.delete(direct)
  await releaseDirectServerCommandEvents(direct, confirmedEvent)
}

async function releaseDirectServerCommandEvents(
  direct: DirectServerCommandReconciliation,
  confirmedEvent: CommandEvent | null,
  reactivate = false,
  beforeConfirmedOnly = false,
): Promise<void> {
  if (!isClientSessionGenerationCurrent(direct.sessionGeneration)) {
    direct.pendingEvents.clear()
    return
  }
  const pendingEvents = Array.from(direct.pendingEvents.values())
    .filter(
      (event) =>
        confirmedEvent === null ||
        (event.revision !== confirmedEvent.revision &&
          (!beforeConfirmedOnly || event.revision < confirmedEvent.revision)),
    )
    .sort((left, right) => left.revision - right.revision)
  for (const event of pendingEvents) direct.pendingEvents.delete(event.revision)
  const releasedEvents = pendingEvents.filter((event) => !deferOwnServerCommandReconciliation(event))
  if (reactivate) directServerCommandReconciliations.add(direct)
  const latestEvent = releasedEvents.at(-1)
  if (!latestEvent) return
  await reconcileServerCommandSuccessEvents(latestEvent, releasedEvents)
}

/**
 * Buffer matching own SSE echoes while a mutation outside the ordinary command
 * transport is waiting for and applying its authoritative response. The scope
 * remains active until response reconciliation finishes, so an echo arriving
 * during the resulting resource read cannot launch a duplicate read.
 *
 * Matching events that are not the confirmed response event are released back
 * through the normal reconciliation path. This keeps overlapping operations
 * and failed requests from swallowing unrelated own events.
 * Callers with an already-applied optimistic projection may attach its typed
 * local effect to the confirmed response event and avoid an authoritative read.
 */
export async function withDirectServerCommandEventReconciliation<T>(
  matches: (event: CommandEvent) => boolean,
  operation: (
    reconcileResponseEvent: (event: CommandEvent, localEffect?: ServerCommandLocalEffect) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const direct = beginDirectServerCommandReconciliation(matches)
  let confirmedEvent: CommandEvent | null = null
  try {
    return await operation(async (event, localEffect) => {
      if (!isClientSessionGenerationCurrent(direct.sessionGeneration)) return
      confirmedEvent = event
      // The Realm transport cannot know its new character id before parsing
      // the response, so its provisional matcher is intentionally broader.
      // Drain any unmatched earlier events first to preserve revision order.
      directServerCommandReconciliations.delete(direct)
      await releaseDirectServerCommandEvents(direct, confirmedEvent, true, true)
      if (!isClientSessionGenerationCurrent(direct.sessionGeneration)) return
      await notifyServerCommandSuccessReconciler(event, true, localEffect)
    })
  } finally {
    await finishDirectServerCommandReconciliation(direct, confirmedEvent)
  }
}

export function canUseServerCommands(): boolean {
  return canUseServerCommandAccess('ordinary')
}

function canUseServerCommandAccess(access: ServerCommandAccess): boolean {
  return (
    !isWriterAccessLost() &&
    (access === 'ordinary' ? canMutate() && canUseClientWriteAccess() : canUseClientRecoveryAccess())
  )
}

function queuedClientSessionIsCurrent(): boolean {
  return (
    activeQueuedClientSessionGeneration === null ||
    isClientSessionGenerationCurrent(activeQueuedClientSessionGeneration)
  )
}

function canExecuteServerCommandAccess(access: ServerCommandAccess): boolean {
  return canUseServerCommandAccess(access) && queuedClientSessionIsCurrent()
}

function runRollbackUnlessDestructiveRefreshChanged(rollback: (() => void) | null | undefined, epoch: number): boolean {
  return queuedClientSessionIsCurrent() && runProjectionRollback(rollback, epoch)
}

/**
 * Serialize an external operation whose response carries no command event with
 * the normal command revision lane. The operation must read its base revision
 * and ingest any authoritative response revision before resolving. Do not call
 * this from inside an already queued command operation, which would enqueue
 * behind itself.
 */
export function runExternalServerRevisionOperation<T>(
  operation: () => Promise<T>,
): Promise<ExternalServerRevisionOperationResult<T>> {
  if (!canUseServerCommands()) return Promise.resolve({ status: 'unavailable' })
  const sessionGeneration = captureClientSessionGeneration()
  return enqueueServerRevisionExecution(async () => {
    if (!canUseServerCommands() || !isClientSessionGenerationCurrent(sessionGeneration))
      return { status: 'unavailable' }
    return { status: 'executed', value: await operation() }
  })
}

export function settingsGroupForKey(key: string): SettingsGroup | null {
  return SERVER_SETTINGS_GROUP_BY_KEY[key] ?? null
}

export function setCachedServerCommandRevision(revision: number): void {
  if (
    Number.isInteger(revision) &&
    revision >= 0 &&
    (cachedServerCommandRevision === null || revision > cachedServerCommandRevision)
  ) {
    cachedServerCommandRevision = revision
  }
}

export function clearCachedServerCommandRevision(): void {
  cachedServerCommandRevision = null
}

export function setAppliedServerResourceRevision(revision: number): void {
  if (
    Number.isInteger(revision) &&
    revision >= 0 &&
    (appliedServerResourceRevision === null || revision > appliedServerResourceRevision)
  ) {
    appliedServerResourceRevision = revision
  }
}

export function clearAppliedServerResourceRevision(): void {
  appliedServerResourceRevision = null
}

export function peekAppliedServerResourceRevision(): number | null {
  return appliedServerResourceRevision
}

export function setServerCommandSuccessReconciler(reconciler: ServerCommandSuccessReconciler | null): void {
  serverCommandSuccessReconciler = reconciler
}

export function setServerCommandConflictGapHandler(handler: ServerCommandConflictGapHandler | null): void {
  serverCommandConflictGapHandler = handler
}

/**
 * Returns the latest server revision known to this client without issuing a
 * fetch. Commands use it as their base revision, and hydration uses it to reject
 * stale responses. It does not prove that the matching projection was applied.
 */
export function peekCachedServerCommandRevision(): number | null {
  return cachedServerCommandRevision
}

export async function getServerCommandBaseRevision(
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<number | null> {
  return getServerCommandBaseRevisionForAccess('ordinary', signal, keepalive)
}

const SERVER_COMMAND_REQUEST_TIMEOUT_MS = 30_000

/** Bound auth, HTTP and body parsing together. Timeout/cancellation is ambiguous:
 * callers retain durable intent and replay its exact receipt id. Detached network
 * work never publishes revisions or reads a later queue task's receipt context. */
async function requestServerCommandResponse(
  request: (auth: string, signal: AbortSignal) => Promise<Response>,
  isCurrent: () => boolean,
  signal?: AbortSignal | null,
  readBody = true,
): Promise<{ response: Response; body: unknown } | null> {
  if (signal?.aborted || !isCurrent()) return null
  const controller = new AbortController()
  let rejectCancelled!: (error: Error) => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject
  })
  const abort = () => {
    controller.abort()
    rejectCancelled(new Error('Server command request cancelled or timed out'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(abort, SERVER_COMMAND_REQUEST_TIMEOUT_MS)
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        const auth = await getNodeServerProxyAuth()
        controller.signal.throwIfAborted()
        if (!isCurrent()) return null
        const response = await request(auth, controller.signal)
        controller.signal.throwIfAborted()
        let body: unknown = null
        if (readBody) {
          try {
            body = await response.json()
          } catch {
            /* Classify malformed bodies by HTTP status. */
          }
        }
        controller.signal.throwIfAborted()
        return { response, body }
      })(),
    ])
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', abort)
  }
}

async function getServerCommandBaseRevisionForAccess(
  access: ServerCommandAccess,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<number | null> {
  if (!canExecuteServerCommandAccess(access)) return null
  const sessionGeneration = captureClientSessionGeneration()
  if (cachedServerCommandRevision !== null) return cachedServerCommandRevision

  try {
    const received = await requestServerCommandResponse(
      (auth, requestSignal) =>
        fetch(BOOTSTRAP_ENDPOINT, {
          method: 'GET',
          signal: requestSignal,
          headers: { 'risu-auth': auth },
          ...(keepalive ? { keepalive: true } : {}),
        }),
      () => canExecuteServerCommandAccess(access) && isClientSessionGenerationCurrent(sessionGeneration),
      signal,
    )
    if (
      !received ||
      !received.response.ok ||
      !canExecuteServerCommandAccess(access) ||
      !isClientSessionGenerationCurrent(sessionGeneration)
    )
      return null
    const body = received.body as { revision?: unknown } | null
    if (body && Number.isInteger(body.revision) && (body.revision as number) >= 0) {
      cachedServerCommandRevision = body.revision as number
      return cachedServerCommandRevision
    }
  } catch {
    return null
  }

  return null
}

export async function patchRuntimeSettings(
  input: PatchRuntimeSettingsInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return patchSettingsGroup(
    {
      group: 'runtime',
      ...input,
    },
    signal,
  )
}

export async function patchSettingsGroup(
  input: PatchSettingsGroupInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult> {
  return requestCommandJson(`/settings/${encodeURIComponent(input.group)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    keepalive,
    readLocalEffect:
      input.acknowledgeOptimistic === true
        ? (body, event) =>
            readSettingsPatchLocalEffect(body, event, input.group, input.patch, input.optimisticProjectionEpoch)
        : undefined,
  })
}

export async function patchSettingsObjectFieldsCommand(
  input: PatchSettingsObjectFieldsInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    group: SettingsGroup
    key: string
    certificate?: string
    patchedKeys?: string[]
    deletedKeys?: string[]
    canonicalValues?: Record<string, unknown>
    canonicalDeletedKeys?: string[]
  }>
> {
  return requestCommandJson(`/settings/${encodeURIComponent(input.group)}/objects/${encodeURIComponent(input.key)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.update.patch,
      ...(input.update.deleteKeys?.length ? { deleteKeys: input.update.deleteKeys } : {}),
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) => readSettingsObjectPatchLocalEffect(body, event, input),
  })
}

/**
 * First-run seed: ask a fresh server (whose persisted `database` is still
 * `null`) to create its default database. Must run before any other command,
 * which all require an existing database object. The server guards this
 * idempotently — it only writes when no database exists yet, so calling it
 * against an already-initialized server is a harmless no-op (`initialized: false`).
 */
export async function initializeServerDatabaseForBootstrap(
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ initialized: boolean }>> {
  return requestCommandJson(
    '/state/initialize',
    {
      method: 'POST',
      body: {},
      signal,
      // The idempotent already-initialized branch performs no mutation and is the
      // only command route that intentionally returns a revision without an event.
      allowEventlessSuccess: (body) =>
        body.initialized === false && !Object.prototype.hasOwnProperty.call(body, 'event'),
    },
    'bootstrap-initialize',
  )
}

/**
 * Commit every first-run settings owner in one server transaction. The
 * response event deliberately invalidates settings plus both split-preset
 * collections, so the caller only resolves after their canonical projections
 * have been applied.
 */
export async function completeOnboardingCommand(
  input: CompleteOnboardingCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ modelPresetId: string; promptPresetId: string }>> {
  return requestCommandJson('/onboarding', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      modelPresetId: input.modelPresetId,
      promptPresetId: input.promptPresetId,
      modelPatch: input.modelPatch,
      promptPatch: input.promptPatch,
      settingsPatch: input.settingsPatch,
    },
    signal,
  })
}

export async function patchServerBackedSettings(input: PatchServerBackedSettingsInput): Promise<ServerCommandResult> {
  if (!canUseServerCommands()) return { status: 'unavailable' }

  const grouped = groupSettingsPatch(input.patch)
  if (grouped.length === 0) return { status: 'unavailable' }

  const rollbackEpoch = captureDestructiveRefreshEpoch()
  const sessionGeneration = captureClientSessionGeneration()
  return enqueueServerCommandExecution(() =>
    withQueuedCommandExecutionContext(
      rollbackEpoch,
      input.mutationId,
      input.databaseLineage,
      async () => {
        if (!canExecuteServerCommandAccess('ordinary') && !input.executionWrapper) {
          runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
          return { status: 'unavailable' }
        }
        const deferredRollback = input.failureRollbackDisposition ? input.rollback : undefined
        const executionInput = input.failureRollbackDisposition ? { ...input, rollback: undefined } : input
        const execute = () =>
          canExecuteServerCommandAccess('ordinary')
            ? executeServerBackedSettingsPatch(executionInput, grouped, rollbackEpoch)
            : Promise.resolve({ status: 'unavailable' as const })
        let result: ServerCommandResult
        try {
          result = input.executionWrapper ? await input.executionWrapper(execute) : await execute()
        } catch (error) {
          if (
            input.failureRollbackDisposition &&
            input.failureRollbackDisposition({ status: 'unavailable' }) !== 'retain'
          ) {
            runRollbackUnlessDestructiveRefreshChanged(deferredRollback, rollbackEpoch)
          }
          throw error
        }
        if (
          result.status !== 'ok' &&
          (!input.failureRollbackDisposition || input.failureRollbackDisposition(result) === 'rollback')
        ) {
          runRollbackUnlessDestructiveRefreshChanged(deferredRollback, rollbackEpoch)
        }
        return result
      },
      sessionGeneration,
    ),
  )
}

async function executeServerBackedSettingsPatch(
  input: PatchServerBackedSettingsInput,
  grouped: Array<[SettingsGroup, SettingsPatch]>,
  rollbackEpoch: number,
): Promise<ServerCommandResult> {
  // A later group can fail after an earlier group was accepted. Callers only
  // expose one whole-patch rollback, so keep every event authoritative in that
  // case; its group read repairs any accepted key restored by the rollback.
  const acknowledgeOptimistic = input.acknowledgeOptimistic === true && grouped.length === 1
  let lastResult: ServerCommandResult = { status: 'unavailable' }
  for (const [group, patch] of grouped) {
    const baseRevision = await getServerCommandBaseRevision(input.signal, input.keepalive)
    if (baseRevision === null) {
      runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
      return { status: 'error', error: 'Unable to read server command revision' }
    }

    const result = await patchSettingsGroup(
      {
        group,
        baseRevision,
        patch,
        acknowledgeOptimistic,
        optimisticProjectionEpoch: input.optimisticProjectionEpochs?.[group],
      },
      input.signal,
      input.keepalive,
    )

    if (result.status !== 'ok') {
      runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
      return result
    }
    lastResult = result
  }

  return lastResult
}

export async function createPresetCommand(
  input: CreatePresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/presets', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
    },
    signal,
  })
}

export async function updatePresetCommand(
  input: UpdatePresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson(`/presets/${encodeURIComponent(input.presetId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    readLocalEffect: (body, event) =>
      readLegacyPresetPatchLocalEffect(body, event, {
        presetId: input.presetId,
        attemptedPatch: input.patch,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function deletePresetCommand(
  input: DeletePresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; selectedPresetId: string | null }>> {
  return requestCommandJson(`/presets/${encodeURIComponent(input.presetId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      presetId: input.selectPresetId,
      apply: input.apply,
      saveCurrent: input.saveCurrent,
    },
    signal,
  })
}

export async function copyPresetCommand(
  input: CopyPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; sourcePresetId: string }>> {
  return requestCommandJson(`/presets/${encodeURIComponent(input.presetId)}/copy`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      newPresetId: input.newPresetId,
      name: input.name,
      saveCurrent: input.saveCurrent,
    },
    signal,
  })
}

export async function selectPresetCommand(
  input: SelectPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/presets/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      presetId: input.presetId,
      apply: input.apply,
      saveCurrent: input.saveCurrent,
    },
    signal,
  })
}

export async function importPresetCommand(
  input: ImportPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/presets/import', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
    },
    signal,
  })
}

export async function reorderPresetsCommand(
  input: ReorderPresetsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedPresetId: string | null }>> {
  return requestCommandJson('/presets/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      presetIds: input.presetIds,
    },
    signal,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readPresetReorderLocalEffect(body, event, {
            presetKind: 'legacy',
            requestedPresetIds: input.presetIds,
            acknowledgement: input.optimisticAcknowledgement!,
          })
      : undefined,
  })
}

export async function createModelPresetCommand(
  input: CreateModelPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ modelPresetId: string }>> {
  return requestCommandJson('/model-presets', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
    },
    signal,
  })
}

export async function updateModelPresetCommand(
  input: UpdateModelPresetCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ modelPresetId: string }>> {
  return requestCommandJson(`/model-presets/${encodeURIComponent(input.modelPresetId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) =>
      readSplitPresetPatchLocalEffect(body, event, {
        presetKind: 'model',
        presetId: input.modelPresetId,
        attemptedPatch: input.patch,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function deleteModelPresetCommand(
  input: DeleteModelPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    modelPresetId: string
    selectedModelPresetId: string | null
    cascadedChatCount: number
    cascadedLoadoutCount: number
  }>
> {
  return requestCommandJson(`/model-presets/${encodeURIComponent(input.modelPresetId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      modelPresetId: input.selectModelPresetId,
    },
    signal,
  })
}

export async function selectModelPresetCommand(
  input: SelectModelPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ modelPresetId: string }>> {
  return requestCommandJson('/model-presets/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      modelPresetId: input.modelPresetId,
    },
    signal,
  })
}

export async function importModelPresetCommand(
  input: ImportModelPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ modelPresetId: string }>> {
  return requestCommandJson('/model-presets/import', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
    },
    signal,
  })
}

export async function reorderModelPresetsCommand(
  input: ReorderModelPresetsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedModelPresetId: string | null }>> {
  return requestCommandJson('/model-presets/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      modelPresetIds: input.modelPresetIds,
    },
    signal,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readPresetReorderLocalEffect(body, event, {
            presetKind: 'model',
            requestedPresetIds: input.modelPresetIds,
            acknowledgement: input.optimisticAcknowledgement!,
          })
      : undefined,
  })
}

export async function createPromptPresetCommand(
  input: CreatePromptPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ promptPresetId: string }>> {
  const preset = normalizePromptTemplateProperty(input.preset)
  return requestCommandJson('/prompt-presets', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset,
    },
    signal,
  })
}

export async function updatePromptPresetCommand(
  input: UpdatePromptPresetCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ promptPresetId: string }>> {
  const patch = normalizePromptTemplateProperty(input.patch)
  return requestCommandJson(`/prompt-presets/${encodeURIComponent(input.promptPresetId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) =>
      readSplitPresetPatchLocalEffect(body, event, {
        presetKind: 'prompt',
        presetId: input.promptPresetId,
        attemptedPatch: patch,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function deletePromptPresetCommand(
  input: DeletePromptPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    promptPresetId: string
    selectedPromptPresetId: string | null
    cascadedChatCount: number
    cascadedLoadoutCount: number
  }>
> {
  return requestCommandJson(`/prompt-presets/${encodeURIComponent(input.promptPresetId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      promptPresetId: input.selectPromptPresetId,
    },
    signal,
  })
}

export async function selectPromptPresetCommand(
  input: SelectPromptPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ promptPresetId: string }>> {
  return requestCommandJson('/prompt-presets/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      promptPresetId: input.promptPresetId,
    },
    signal,
  })
}

export async function importPromptPresetCommand(
  input: ImportPromptPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ promptPresetId: string }>> {
  const preset = normalizePromptTemplateProperty(input.preset)
  return requestCommandJson('/prompt-presets/import', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset,
    },
    signal,
  })
}

export async function reorderPromptPresetsCommand(
  input: ReorderPromptPresetsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedPromptPresetId: string | null }>> {
  return requestCommandJson('/prompt-presets/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      promptPresetIds: input.promptPresetIds,
    },
    signal,
  })
}

export async function createAgentCommand(
  input: CreateAgentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentId: string }>> {
  return requestCommandJson('/agents', {
    method: 'POST',
    body: { baseRevision: input.baseRevision, agent: input.agent },
    signal,
  })
}

export async function updateAgentCommand(
  input: UpdateAgentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentId: string }>> {
  return requestCommandJson(`/agents/${encodeURIComponent(input.agentId)}`, {
    method: 'PATCH',
    body: { baseRevision: input.baseRevision, patch: input.patch },
    signal,
  })
}

export async function duplicateAgentCommand(
  input: DuplicateAgentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentId: string; sourceAgentId: string }>> {
  return requestCommandJson(`/agents/${encodeURIComponent(input.agentId)}/duplicate`, {
    method: 'POST',
    body: { baseRevision: input.baseRevision, name: input.name },
    signal,
  })
}

export async function deleteAgentCommand(
  input: DeleteAgentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentId: string }>> {
  return requestCommandJson(`/agents/${encodeURIComponent(input.agentId)}`, {
    method: 'DELETE',
    body: { baseRevision: input.baseRevision },
    signal,
  })
}

export async function reorderAgentsCommand(
  input: ReorderAgentsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<Record<string, never>>> {
  return requestCommandJson('/agents/reorder', {
    method: 'POST',
    body: { baseRevision: input.baseRevision, agentIds: input.agentIds },
    signal,
  })
}

export async function createAgentPresetCommand(
  input: CreateAgentPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/agent-presets', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
    },
    signal,
  })
}

export async function createAgentPresetUseCommand(
  input: CreateAgentPresetUseCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; useId: string; agentId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}/uses`, {
    method: 'POST',
    body: { baseRevision: input.baseRevision, use: input.use },
    signal,
  })
}

export async function updateAgentPresetUseCommand(
  input: UpdateAgentPresetUseCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; useId: string; agentId: string }>> {
  return requestCommandJson(
    `/agent-presets/${encodeURIComponent(input.presetId)}/uses/${encodeURIComponent(input.useId)}`,
    {
      method: 'PATCH',
      body: { baseRevision: input.baseRevision, patch: input.patch },
      signal,
    },
  )
}

export async function deleteAgentPresetUseCommand(
  input: DeleteAgentPresetUseCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; useId: string }>> {
  return requestCommandJson(
    `/agent-presets/${encodeURIComponent(input.presetId)}/uses/${encodeURIComponent(input.useId)}`,
    {
      method: 'DELETE',
      body: { baseRevision: input.baseRevision },
      signal,
    },
  )
}

export async function reorderAgentPresetUsesCommand(
  input: ReorderAgentPresetUsesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}/uses/reorder`, {
    method: 'POST',
    body: { baseRevision: input.baseRevision, useIds: input.useIds },
    signal,
  })
}

export async function updateAgentPresetCommand(
  input: UpdateAgentPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readAgentPresetPatchLocalEffect(body, event, {
            kind: 'preset',
            presetId: input.presetId,
            attemptedPatch: input.patch,
            acknowledgement: input.optimisticAcknowledgement!,
          })
      : undefined,
  })
}

export async function duplicateAgentPresetCommand(
  input: DuplicateAgentPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; sourcePresetId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}/duplicate`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      name: input.name,
    },
    signal,
  })
}

export async function deleteAgentPresetCommand(
  input: DeleteAgentPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    presetId: string
    clearedDefault: boolean
    clearedChatCount: number
    clearedLoadoutCount: number
  }>
> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
  })
}

export async function reorderAgentPresetsCommand(
  input: ReorderAgentPresetsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentPresetDefaultId: string | null }>> {
  return requestCommandJson('/agent-presets/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      presetIds: input.presetIds,
    },
    signal,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readAgentPresetCollectionMutationLocalEffect(body, event, {
            operation: 'reorder',
            expectedPresetIds: input.presetIds,
            acknowledgement: input.optimisticAcknowledgement!,
          })
      : undefined,
  })
}

export async function setAgentPresetDefaultCommand(
  input: SetAgentPresetDefaultCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ agentPresetDefaultId: string | null }>> {
  return requestCommandJson('/agent-presets/default', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      agentPresetId: input.agentPresetId,
    },
    signal,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readAgentPresetCollectionMutationLocalEffect(body, event, {
            operation: 'default',
            expectedDefaultId: input.agentPresetId,
            acknowledgement: input.optimisticAcknowledgement!,
          })
      : undefined,
  })
}

export async function createAgentPresetStepCommand(
  input: CreateAgentPresetStepCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; stepId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}/steps`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      step: input.step,
    },
    signal,
  })
}

export async function updateAgentPresetStepCommand(
  input: UpdateAgentPresetStepCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; stepId: string }>> {
  return requestCommandJson(
    `/agent-presets/${encodeURIComponent(input.presetId)}/steps/${encodeURIComponent(input.stepId)}`,
    {
      method: 'PATCH',
      body: {
        baseRevision: input.baseRevision,
        patch: input.patch,
      },
      signal,
      readLocalEffect: input.optimisticAcknowledgement
        ? (body, event) =>
            readAgentPresetPatchLocalEffect(body, event, {
              kind: 'step',
              presetId: input.presetId,
              stepId: input.stepId,
              attemptedPatch: input.patch,
              acknowledgement: input.optimisticAcknowledgement!,
            })
        : undefined,
    },
  )
}

export async function duplicateAgentPresetStepCommand(
  input: DuplicateAgentPresetStepCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; stepId: string; sourceStepId: string }>> {
  return requestCommandJson(
    `/agent-presets/${encodeURIComponent(input.presetId)}/steps/${encodeURIComponent(input.stepId)}/duplicate`,
    {
      method: 'POST',
      body: {
        baseRevision: input.baseRevision,
        name: input.name,
      },
      signal,
    },
  )
}

export async function deleteAgentPresetStepCommand(
  input: DeleteAgentPresetStepCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; stepId: string }>> {
  return requestCommandJson(
    `/agent-presets/${encodeURIComponent(input.presetId)}/steps/${encodeURIComponent(input.stepId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
      },
      signal,
    },
  )
}

export async function reorderAgentPresetStepsCommand(
  input: ReorderAgentPresetStepsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson(`/agent-presets/${encodeURIComponent(input.presetId)}/steps/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      stepIds: input.stepIds,
    },
    signal,
  })
}

export async function createModelProfileCommand(
  input: CreateModelProfileCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileId: string }>> {
  return requestCommandJson('/model-profiles', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      profile: input.profile,
    },
    signal,
  })
}

export async function updateModelProfileCommand(
  input: UpdateModelProfileCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileId: string }>> {
  return requestCommandJson(`/model-profiles/${encodeURIComponent(input.profileId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      profile: input.profile,
      expectedProfile: input.expectedProfile,
    },
    signal,
  })
}

export async function duplicateModelProfileCommand(
  input: DuplicateModelProfileCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileId: string; sourceProfileId: string }>> {
  return requestCommandJson(`/model-profiles/${encodeURIComponent(input.profileId)}/duplicate`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      name: input.name,
    },
    signal,
  })
}

export async function reorderModelProfilesCommand(
  input: ReorderModelProfilesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileIds: string[]; order: ModelProfileOrderEntry[] }>> {
  return requestCommandJson('/model-profiles/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      order: input.order,
    },
    signal,
  })
}

export async function createProviderCredentialCommand(
  input: CreateProviderCredentialCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ credentialId: string }>> {
  return requestCommandJson('/provider-credentials', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      credential: input.credential,
    },
    signal,
  })
}

export async function updateProviderCredentialCommand(
  input: UpdateProviderCredentialCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ credentialId: string }>> {
  return requestCommandJson(`/provider-credentials/${encodeURIComponent(input.credentialId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      credential: input.credential,
      expectedCredential: input.expectedCredential,
    },
    signal,
  })
}

export async function deleteProviderCredentialCommand(
  input: DeleteProviderCredentialCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ credentialId: string }>> {
  return requestCommandJson(`/provider-credentials/${encodeURIComponent(input.credentialId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
  })
}

export async function deleteModelProfileCommand(
  input: DeleteModelProfileCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileId: string; reassignedRoles: ModelRole[] }>> {
  return requestCommandJson(`/model-profiles/${encodeURIComponent(input.profileId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      reassignments: input.reassignments,
    },
    signal,
  })
}

export async function updateModelRoleProfilesCommand(
  input: UpdateModelRoleProfilesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ roles: ModelRole[] }>> {
  return requestCommandJson('/model-role-profiles', {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      bindings: input.bindings,
      ...(input.modelPresetId ? { modelPresetId: input.modelPresetId } : {}),
    },
    signal,
  })
}

export async function createAndBindModelProfileCommand(
  input: CreateAndBindModelProfileCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileId: string; role: ModelRole }>> {
  return requestCommandJson('/model-profiles/create-and-bind', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      role: input.role,
      profile: input.profile,
    },
    signal,
  })
}

export async function updateModelRuntimeDefaultsCommand(
  input: UpdateModelRuntimeDefaultsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return requestCommandJson('/model-runtime-defaults', {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      runtimeDefaults: input.runtimeDefaults,
    },
    signal,
  })
}

export async function convertLegacyModelProfilesCommand(
  input: ConvertLegacyModelProfilesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ profileIdsByRole: Record<ModelRole, string>; convertedRoles: ModelRole[] }>> {
  return requestCommandJson('/model-profiles/convert-legacy', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
  })
}

export async function extractLegacyBotPresetCommand(
  input: ExtractLegacyBotPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    legacyPresetId: string
    modelPresetId?: string
    promptPresetId?: string
    reusedModelPreset?: boolean
  }>
> {
  return requestCommandJson(`/legacy-bot-presets/${encodeURIComponent(input.presetId)}/extract`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      mode: input.mode,
    },
    signal,
  })
}

export async function patchPromptSettingsCommand(
  input: PatchPromptSettingsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult> {
  return patchSettingsGroup(
    {
      group: 'prompt',
      baseRevision: input.baseRevision,
      patch: input.patch,
      acknowledgeOptimistic: input.acknowledgeOptimistic === true,
      optimisticProjectionEpoch: input.optimisticProjectionEpoch,
    },
    signal,
    keepalive,
  )
}

export async function createPromptItemCommand(
  input: CreatePromptItemCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ itemId: string }>> {
  const promptItem = normalizePromptItemSnapshot(input.promptItem)
  return requestCommandJson('/prompt-items', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      ...(input.promptPresetId ? { promptPresetId: input.promptPresetId } : {}),
      promptItem,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPromptItemMutationLocalEffect(body, event, {
        operation: 'create',
        promptPresetId: input.promptPresetId,
        itemId: promptItem.id,
        promptItem,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function updatePromptItemCommand(
  input: UpdatePromptItemCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ itemId: string }>> {
  const patch = normalizePromptItemPatch(input.patch)
  return requestCommandJson(`/prompt-items/${encodeURIComponent(input.itemId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      ...(input.promptPresetId ? { promptPresetId: input.promptPresetId } : {}),
      patch,
      ...(input.deleteKeys?.length ? { deleteKeys: input.deleteKeys } : {}),
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) =>
      readPromptItemMutationLocalEffect(body, event, {
        operation: 'update',
        promptPresetId: input.promptPresetId,
        itemId: input.itemId,
        patch,
        deleteKeys: input.deleteKeys,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function deletePromptItemCommand(
  input: DeletePromptItemCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ itemId: string }>> {
  return requestCommandJson(`/prompt-items/${encodeURIComponent(input.itemId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      ...(input.promptPresetId ? { promptPresetId: input.promptPresetId } : {}),
    },
    signal,
    readLocalEffect: (body, event) =>
      readPromptItemMutationLocalEffect(body, event, {
        operation: 'delete',
        promptPresetId: input.promptPresetId,
        itemId: input.itemId,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function reorderPromptItemsCommand(
  input: ReorderPromptItemsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return requestCommandJson('/prompt-items/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      ...(input.promptPresetId ? { promptPresetId: input.promptPresetId } : {}),
      itemIds: input.itemIds,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPromptItemMutationLocalEffect(body, event, {
        operation: 'reorder',
        promptPresetId: input.promptPresetId,
        itemIds: input.itemIds,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function enablePromptItemsCommand(
  input: EnablePromptItemsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ enabled: boolean }>> {
  return requestCommandJson('/prompt-items/enable', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      ...(input.promptPresetId ? { promptPresetId: input.promptPresetId } : {}),
      enabled: input.enabled,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPromptItemMutationLocalEffect(body, event, {
        operation: 'enable',
        promptPresetId: input.promptPresetId,
        enabled: input.enabled,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function createPersonaCommand(
  input: CreatePersonaCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ personaId: string }>> {
  const acknowledgement = await preparePersonaMutationAcknowledgement({
    operation: 'create',
    targetPersonaId: typeof input.persona.id === 'string' ? input.persona.id : null,
    createdPersona: input.persona,
    mirrorLegacyProfile: input.mirrorLegacyProfile === true,
    acknowledgement: input.optimisticAcknowledgement,
  })
  return requestCommandJson('/personas', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      persona: input.persona,
      mirrorLegacyProfile: input.mirrorLegacyProfile,
    },
    signal,
    readLocalEffect: acknowledgement
      ? (body, event) => readPersonaMutationLocalEffect(body, event, acknowledgement)
      : undefined,
  })
}

export async function updatePersonaCommand(
  input: UpdatePersonaCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ personaId: string }>> {
  return requestCommandJson(`/personas/${encodeURIComponent(input.personaId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
      mirrorLegacyProfile: input.mirrorLegacyProfile,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) =>
      readPersonaPatchLocalEffect(body, event, {
        personaId: input.personaId,
        attemptedPatch: input.patch,
        mirrorLegacyProfile: input.mirrorLegacyProfile === true,
        acknowledgement: input.optimisticAcknowledgement,
      }),
  })
}

export async function deletePersonaCommand(
  input: DeletePersonaCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    personaId: string
    selectedPersonaId: string | null
    cascadedChatCount: number
    cascadedLoadoutCount: number
  }>
> {
  return requestCommandJson(`/personas/${encodeURIComponent(input.personaId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      selectPersonaId: input.selectPersonaId,
      mirrorLegacyProfile: input.mirrorLegacyProfile,
      saveCurrent: input.saveCurrent,
    },
    signal,
  })
}

export async function selectPersonaCommand(
  input: SelectPersonaCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ personaId: string }>> {
  const acknowledgement = await preparePersonaMutationAcknowledgement({
    operation: 'select',
    targetPersonaId: input.personaId,
    mirrorLegacyProfile: input.mirrorLegacyProfile ?? true,
    saveCurrent: input.saveCurrent ?? true,
    acknowledgement: input.optimisticAcknowledgement,
  })
  return requestCommandJson('/personas/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      personaId: input.personaId,
      mirrorLegacyProfile: input.mirrorLegacyProfile,
      saveCurrent: input.saveCurrent,
    },
    signal,
    readLocalEffect: acknowledgement
      ? (body, event) => readPersonaMutationLocalEffect(body, event, acknowledgement)
      : undefined,
  })
}

export async function reorderPersonasCommand(
  input: ReorderPersonasCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedPersonaId: string | null }>> {
  const acknowledgement = await preparePersonaMutationAcknowledgement({
    operation: 'reorder',
    targetPersonaId: null,
    requestedPersonaIds: input.personaIds,
    acknowledgement: input.optimisticAcknowledgement,
  })
  return requestCommandJson('/personas/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      personaIds: input.personaIds,
    },
    signal,
    readLocalEffect: acknowledgement
      ? (body, event) => readPersonaMutationLocalEffect(body, event, acknowledgement)
      : undefined,
  })
}

export async function createTranslatorPresetCommand(
  input: CreateTranslatorPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/translator-presets', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preset: input.preset,
      select: input.select,
    },
    signal,
  })
}

export async function updateTranslatorPresetCommand(
  input: UpdateTranslatorPresetCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ presetId: string; acknowledgedKeys: string[]; selectedPresetId: string | null }>> {
  return requestCommandJson(`/translator-presets/${encodeURIComponent(input.presetId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    keepalive,
    readLocalEffect: input.optimisticAcknowledgement
      ? (body, event) =>
          readTranslatorPresetPatchLocalEffect(body, event, {
            presetId: input.presetId,
            attemptedPatch: input.patch,
            acknowledgement: input.optimisticAcknowledgement,
          })
      : undefined,
  })
}

export async function deleteTranslatorPresetCommand(
  input: DeleteTranslatorPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string; selectedPresetId: string | null }>> {
  return requestCommandJson(`/translator-presets/${encodeURIComponent(input.presetId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
      selectPresetId: input.selectPresetId,
    },
    signal,
  })
}

export async function selectTranslatorPresetCommand(
  input: SelectTranslatorPresetCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ presetId: string }>> {
  return requestCommandJson('/translator-presets/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      presetId: input.presetId,
    },
    signal,
  })
}

export async function createLoadoutCommand(
  input: CreateLoadoutCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ loadoutId: string }>> {
  return requestCommandJson('/loadouts', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      loadout: input.loadout,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLoadoutMutationLocalEffect(body, event, {
            operation: 'create',
            expectedLoadoutId: input.loadout.id,
            expectedLoadout: input.loadout,
            loadoutsProjectionEpoch: input.loadoutsProjectionEpoch,
          })
      : undefined,
  })
}

export async function updateLoadoutCommand(
  input: UpdateLoadoutCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ loadoutId: string }>> {
  return requestCommandJson(`/loadouts/${encodeURIComponent(input.loadoutId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
  })
}

export async function deleteLoadoutCommand(
  input: DeleteLoadoutCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ loadoutId: string }>> {
  return requestCommandJson(`/loadouts/${encodeURIComponent(input.loadoutId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLoadoutMutationLocalEffect(body, event, {
            operation: 'delete',
            expectedLoadoutId: input.loadoutId,
            loadoutsProjectionEpoch: input.loadoutsProjectionEpoch,
          })
      : undefined,
  })
}

export async function favoriteLoadoutCommand(
  input: FavoriteLoadoutCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ loadoutId: string }>> {
  return requestCommandJson(`/loadouts/${encodeURIComponent(input.loadoutId)}/favorite`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      favorite: input.favorite,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLoadoutMutationLocalEffect(body, event, {
            operation: 'favorite',
            expectedLoadoutId: input.loadoutId,
            expectedFavorite: input.favorite,
            loadoutsProjectionEpoch: input.loadoutsProjectionEpoch,
          })
      : undefined,
  })
}

export async function touchLoadoutCommand(
  input: TouchLoadoutCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ loadoutId: string }>> {
  return requestCommandJson(`/loadouts/${encodeURIComponent(input.loadoutId)}/touch`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      lastUsed: input.lastUsed,
      characterId: input.characterId,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLoadoutMutationLocalEffect(body, event, {
            operation: 'touch',
            expectedLoadoutId: input.loadoutId,
            expectedLastUsed: input.lastUsed,
            expectedCharacterId: input.characterId,
            loadoutsProjectionEpoch: input.loadoutsProjectionEpoch,
            settingsProjectionEpoch: input.settingsProjectionEpoch,
            loadedName: input.loadedName,
          })
      : undefined,
  })
}

export async function createCharacterCommand(
  input: CreateCharacterCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string; selectedCharacterId: string | null }>> {
  return requestCommandJson('/characters', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      character: characterCreatePayload(input.character),
      ...(input.initialChat ? { initialChat: input.initialChat } : {}),
    },
    signal,
    readLocalEffect: (body, event) =>
      readCharacterCollectionMutationLocalEffect(body, event, 'create', input.character.chaId),
  })
}

export async function createAndSelectCharacterCommand(
  input: CreateAndSelectCharacterCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string; selectedCharacterId: string | null }>> {
  return requestCommandJson('/characters/create-and-select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      character: characterCreatePayload(input.character),
      lastInteraction: input.lastInteraction,
      ...(input.initialChat ? { initialChat: input.initialChat } : {}),
    },
    signal,
    readLocalEffect: (body, event) =>
      readCharacterCollectionMutationLocalEffect(body, event, 'createAndSelect', input.character.chaId),
  })
}

function characterCreatePayload(character: CharacterSnapshot): CharacterSnapshot {
  const payload = { ...character }
  delete payload.chats
  return payload
}

export async function updateCharacterCommand(
  input: UpdateCharacterCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) => readCharacterPatchLocalEffect(body, event, input.characterId, input.patch),
  })
}

export async function mutateAlternateGreetingsCommand(
  input: MutateAlternateGreetingsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string; chatGreetingIndices: ChatGreetingIndex[] }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/alternate-greetings`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      alternateGreetings: input.alternateGreetings,
      operation: input.operation,
    },
    signal,
    readLocalEffect: (body, event) => readAlternateGreetingMutationLocalEffect(body, event, input),
  })
}

export async function translateGreetingCommand(
  input: TranslateGreetingCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    characterId: string
    chatId: string
    greetingIndex: number
    jobId: string
    settingsHash: string
    translation: MessageTranslation
  }>
> {
  return requestCommandJson(
    `/characters/${encodeURIComponent(input.characterId)}/greetings/${input.greetingIndex}/translate`,
    {
      method: 'POST',
      body: {
        baseRevision: input.baseRevision,
        chatId: input.chatId,
        jobId: input.jobId,
      },
      signal,
      // Greeting translation is provider-bound and source-fenced, not staged
      // in the durable mutation lane. Reconcile its revision/event immediately.
      reconcileImmediately: true,
      deferOwnEventUntilResponse: (event) =>
        event.type === 'character.greetingTranslation.updated' &&
        event.resource === 'greetingTranslation' &&
        event.id === input.characterId,
    },
  )
}

export async function recoverColdStorageCharacterCommand(
  input: RecoverColdStorageCharacterCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string; character: CharacterSnapshot }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/recover-cold-storage`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      key: input.key,
    },
    signal,
  })
}

export async function deleteCharacterCommand(
  input: DeleteCharacterCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string; selectedCharacterId: string | null }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: (body, event) =>
      readCharacterCollectionMutationLocalEffect(body, event, 'delete', input.characterId),
  })
}

export async function selectCharacterCommand(
  input: SelectCharacterCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson('/characters/select', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      characterId: input.characterId,
      lastInteraction: input.lastInteraction,
    },
    signal,
    readLocalEffect: (body, event) =>
      readCharacterSelectionLocalEffect(body, event, input.characterId, input.lastInteraction),
  })
}

export async function reorderCharactersCommand(
  input: ReorderCharactersCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedCharacterId: string | null }>> {
  return requestCommandJson('/characters/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      characterOrder: input.characterOrder,
    },
    signal,
    readLocalEffect: (_body, event) => readCharacterOrderLocalEffect(event, input.characterOrder),
  })
}

export async function createChatCommand(
  input: CreateChatCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    chatId: string
    selectedChatId: string | null
    generationSettings: ChatGenerationSettings | null
  }>
> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/chats`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      chat: input.chat,
      select: input.select,
    },
    signal,
    readLocalEffect:
      input.acknowledgeOptimistic && isCanonicalOptimisticChatSnapshot(input.chat)
        ? (body, event) =>
            readChatStructureMutationLocalEffect(body, event, {
              operation: 'create',
              expectedCharacterId: input.characterId,
              expectedTargetId: input.chat.id,
              expectedChat: input.chat,
              expectedOptimisticEpoch: input.optimisticEpoch,
              expectedOptimisticRowEpoch: input.optimisticRowEpoch,
            })
        : undefined,
  })
}

export async function resetChatsCommand(
  input: ResetChatsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; selectedChatId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/chats`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      chat: input.chat,
    },
    signal,
  })
}

export async function updateChatCommand(
  input: UpdateChatCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ chatId: string; selectedChatId: string | null }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
      select: input.select,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) => readChatPatchLocalEffect(body, event, input),
  })
}

export async function recoverColdStorageChatCommand(
  input: RecoverColdStorageChatCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; characterId: string; chat: ChatSnapshot }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/recover-cold-storage`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      key: input.key,
    },
    signal,
  })
}

export async function saveChatGenerationSettingsCommand(
  input: SaveChatGenerationSettingsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    chatId: string
    characterId: string
    generationSettings?: ChatGenerationSettings
    certificate?: string
    patchedKeys?: string[]
    deletedKeys?: string[]
    sidebarTogglePatchedKeys?: string[]
    sidebarToggleDeletedKeys?: string[]
    prunedSidebarToggleKeys?: string[]
    acknowledgedGenerationSettings?: ChatGenerationSettings
  }>
> {
  const body = {
    baseRevision: input.baseRevision,
    ...createChatGenerationSettingsCommandDurableBody(input),
  }
  const result = await requestCommandJson<{
    chatId: string
    characterId: string
    generationSettings?: ChatGenerationSettings
    certificate?: string
    patchedKeys?: string[]
    deletedKeys?: string[]
    sidebarTogglePatchedKeys?: string[]
    sidebarToggleDeletedKeys?: string[]
    prunedSidebarToggleKeys?: string[]
  }>(`/chats/${encodeURIComponent(input.chatId)}/generation-settings`, {
    method: 'PUT',
    body,
    signal,
    keepalive,
    readLocalEffect: (responseBody, event) => readChatGenerationSettingsLocalEffect(responseBody, event, input),
  })
  if (result.status !== 'ok') return result
  const localEffect = readChatGenerationSettingsLocalEffect(result, result.event, input)
  return {
    ...result,
    acknowledgedGenerationSettings: localEffect ? cloneJsonValue(localEffect.generationSettings) : undefined,
  }
}

/** Exact replay-safe request body, excluding only the live base revision. */
export function createChatGenerationSettingsCommandDurableBody(
  input: Omit<SaveChatGenerationSettingsCommandInput, 'baseRevision'>,
): Record<string, unknown> {
  if (!input.sparseUpdate) {
    return { generationSettings: cloneJsonValue(input.generationSettings) }
  }
  return {
    baseGenerationSettingsDigest: sha256HexUtf8Sync(
      serializeChatGenerationSettingsDigestInput(input.sparseBaseGenerationSettings),
    ),
    patch: cloneJsonValue(input.sparseUpdate.patch),
    ...(input.sparseUpdate.deleteKeys?.length ? { deleteKeys: cloneJsonValue(input.sparseUpdate.deleteKeys) } : {}),
    ...(input.sparseUpdate.sidebarToggleDeleteKeys?.length
      ? { sidebarToggleDeleteKeys: cloneJsonValue(input.sparseUpdate.sidebarToggleDeleteKeys) }
      : {}),
  }
}

export async function deleteChatCommand(
  input: DeleteChatCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; selectedChatId: string | null }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readChatStructureMutationLocalEffect(body, event, {
            operation: 'delete',
            expectedTargetId: input.chatId,
            expectedOptimisticEpoch: input.optimisticEpoch,
            expectedOptimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function forkChatCommand(
  input: ForkChatCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    chatId: string
    sourceChatId: string
    selectedChatId: string | null
    generationSettings: ChatGenerationSettings | null
  }>
> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/fork`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      chat: input.chat,
      sourcePatch: input.sourcePatch,
      folder: input.folder,
      select: input.select,
    },
    signal,
    readLocalEffect:
      input.acknowledgeOptimistic &&
      isCanonicalOptimisticChatSnapshot(input.chat) &&
      (input.folder === undefined || isCanonicalOptimisticChatFolderSnapshot(input.folder))
        ? (body, event) =>
            readChatStructureMutationLocalEffect(body, event, {
              operation: 'fork',
              expectedTargetId: input.chat.id,
              expectedSourceChatId: input.chatId,
              expectedChat: input.chat,
              expectedOptimisticEpoch: input.optimisticEpoch,
              expectedOptimisticRowEpoch: input.optimisticRowEpoch,
            })
        : undefined,
  })
}

export async function reorderChatsCommand(
  input: ReorderChatsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedChatId: string | null }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/chats/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      chatIds: input.chatIds,
      folderByChatId: input.folderByChatId,
      selectedChatId: input.selectedChatId,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readChatStructureMutationLocalEffect(body, event, {
            operation: 'reorder',
            expectedCharacterId: input.characterId,
            expectedIds: input.chatIds,
            expectedOptimisticEpoch: input.optimisticEpoch,
            expectedOptimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function createChatFolderCommand(
  input: CreateChatFolderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/chat-folders`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      folder: input.folder,
    },
    signal,
    readLocalEffect:
      input.acknowledgeOptimistic && isCanonicalOptimisticChatFolderSnapshot(input.folder)
        ? (body, event) =>
            readChatStructureMutationLocalEffect(body, event, {
              operation: 'folderCreate',
              expectedCharacterId: input.characterId,
              expectedTargetId: input.folder.id,
              expectedOptimisticEpoch: input.optimisticEpoch,
              expectedOptimisticRowEpoch: input.optimisticRowEpoch,
            })
        : undefined,
  })
}

export async function updateChatFolderCommand(
  input: UpdateChatFolderCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson(`/chat-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) =>
      readCharacterRowMutationLocalEffect(body, event, 'chatFolderUpdate', input.folderId),
  })
}

export async function deleteChatFolderCommand(
  input: DeleteChatFolderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson(`/chat-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readChatStructureMutationLocalEffect(body, event, {
            operation: 'folderDelete',
            expectedTargetId: input.folderId,
            expectedOptimisticEpoch: input.optimisticEpoch,
            expectedOptimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function reorderChatFoldersCommand(
  input: ReorderChatFoldersCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedChatId: string | null }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/chat-folders/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      folderIds: input.folderIds,
      selectedChatId: input.selectedChatId,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readChatStructureMutationLocalEffect(body, event, {
            operation: 'folderReorder',
            expectedCharacterId: input.characterId,
            expectedIds: input.folderIds,
            expectedOptimisticEpoch: input.optimisticEpoch,
            expectedOptimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function patchChatScriptstateCommand(
  input: PatchChatScriptstateCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/scriptstate`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
      deleteKeys: input.deleteKeys,
    },
    signal,
    readLocalEffect: (body, event) => readCharacterRowMutationLocalEffect(body, event, 'chatScriptstate', input.chatId),
  })
}

export async function createGlobalLorebookCommand(
  input: CreateGlobalLorebookCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ lorebookId: string }>> {
  return requestCommandJson('/lorebooks', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      lorebook: input.lorebook,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readGlobalLorebookMutationLocalEffect(body, event, {
            operation: 'create',
            expectedLorebook: input.lorebook,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function updateGlobalLorebookCommand(
  input: UpdateGlobalLorebookCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ lorebookId: string }>> {
  return requestCommandJson(`/lorebooks/${encodeURIComponent(input.lorebookId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readGlobalLorebookMutationLocalEffect(body, event, {
            operation: 'update',
            expectedLorebookId: input.lorebookId,
            expectedPatch: input.patch,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function deleteGlobalLorebookCommand(
  input: DeleteGlobalLorebookCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ lorebookId: string }>> {
  return requestCommandJson(`/lorebooks/${encodeURIComponent(input.lorebookId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readGlobalLorebookMutationLocalEffect(body, event, {
            operation: 'delete',
            expectedLorebookId: input.lorebookId,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
            pageProjectionEpoch: input.optimisticPageEpoch,
          })
      : undefined,
  })
}

export async function reorderGlobalLorebooksCommand(
  input: ReorderGlobalLorebooksCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedLorebookId: string | null }>> {
  return requestCommandJson('/lorebooks/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      lorebookIds: input.lorebookIds,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readGlobalLorebookMutationLocalEffect(body, event, {
            operation: 'reorder',
            expectedLorebookIds: input.lorebookIds,
            expectedSelectedLorebookId: input.optimisticSelectedLorebookId,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
            pageProjectionEpoch: input.optimisticPageEpoch,
          })
      : undefined,
  })
}

export async function selectGlobalLorebookCommand(
  input: SelectGlobalLorebookCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ selectedLorebookId: string }>> {
  return requestCommandJson(`/lorebooks/${encodeURIComponent(input.lorebookId)}/select`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readGlobalLorebookMutationLocalEffect(body, event, {
            operation: 'select',
            expectedLorebookId: input.lorebookId,
            expectedSelectedLorebookId: input.lorebookId,
            pageProjectionEpoch: input.optimisticPageEpoch,
          })
      : undefined,
  })
}

export async function replaceGlobalLorebookEntriesCommand(
  input: ReplaceGlobalLorebookEntriesCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ lorebookId: string }>> {
  return requestCommandJson(`/lorebooks/${encodeURIComponent(input.lorebookId)}/entries`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      entries: input.entries,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'global',
            operation: 'replace',
            expectedTargetId: input.lorebookId,
            expectedEntries: input.entries,
            optimisticEntries: input.optimisticEntries,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

function lorebookEntryWriteBody(input: {
  baseRevision: number
  entry: LorebookEntrySnapshot
  sparseUpdate?: SparseLorebookEntryUpdate
}): Record<string, unknown> {
  if (!input.sparseUpdate) {
    return { baseRevision: input.baseRevision, entry: input.entry }
  }
  return {
    baseRevision: input.baseRevision,
    patch: input.sparseUpdate.patch,
    ...(input.sparseUpdate.deleteKeys?.length ? { deleteKeys: input.sparseUpdate.deleteKeys } : {}),
  }
}

export async function upsertGlobalLorebookEntryCommand(
  input: UpsertGlobalLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    lorebookId: string
    entryId: string
    entryIndex: number
    created: boolean
    patchedKeys?: string[]
    deletedKeys?: string[]
  }>
> {
  return requestCommandJson(
    `/lorebooks/${encodeURIComponent(input.lorebookId)}/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'PUT',
      body: lorebookEntryWriteBody(input),
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'global',
              operation: 'upsert',
              expectedTargetId: input.lorebookId,
              expectedEntryId: input.entryId,
              expectedEntry: input.entry,
              expectedSparseUpdate: input.sparseUpdate,
              expectedEntryIndex: input.optimisticEntryIndex,
              expectedEntryCreated: input.optimisticEntryCreated,
              optimisticEntries: input.optimisticEntries,
              collectionProjectionEpoch: input.optimisticCollectionEpoch,
            })
        : undefined,
    },
  )
}

export async function deleteGlobalLorebookEntryCommand(
  input: DeleteGlobalLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ lorebookId: string; entryId: string; entryIndex: number }>> {
  return requestCommandJson(
    `/lorebooks/${encodeURIComponent(input.lorebookId)}/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
      },
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'global',
              operation: 'delete',
              expectedTargetId: input.lorebookId,
              expectedEntryId: input.entryId,
              expectedEntryIndex: input.optimisticEntryIndex,
              optimisticEntries: input.optimisticEntries,
              collectionProjectionEpoch: input.optimisticCollectionEpoch,
            })
        : undefined,
    },
  )
}

export async function reorderGlobalLorebookEntriesCommand(
  input: ReorderGlobalLorebookEntriesCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ lorebookId: string }>> {
  return requestCommandJson(`/lorebooks/${encodeURIComponent(input.lorebookId)}/entries/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      entryIds: input.entryIds,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'global',
            operation: 'reorder',
            expectedTargetId: input.lorebookId,
            expectedEntryIds: input.entryIds,
            optimisticEntries: input.optimisticEntries,
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function replaceCharacterLorebooksCommand(
  input: ReplaceCharacterLorebooksCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/lorebooks`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      entries: input.entries,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'character',
            operation: 'replace',
            expectedTargetId: input.characterId,
            expectedEntries: input.entries,
            optimisticEntries: input.optimisticEntries,
            characterRowProjectionEpoch: input.optimisticRowEpoch,
            characterLorebookProjectionEpoch: input.optimisticLorebookEpoch,
          })
      : undefined,
  })
}

export async function upsertCharacterLorebookEntryCommand(
  input: UpsertCharacterLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    characterId: string
    entryId: string
    entryIndex: number
    created: boolean
    patchedKeys?: string[]
    deletedKeys?: string[]
  }>
> {
  return requestCommandJson(
    `/characters/${encodeURIComponent(input.characterId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'PUT',
      body: lorebookEntryWriteBody(input),
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'character',
              operation: 'upsert',
              expectedTargetId: input.characterId,
              expectedEntryId: input.entryId,
              expectedEntry: input.entry,
              expectedSparseUpdate: input.sparseUpdate,
              expectedEntryIndex: input.optimisticEntryIndex,
              expectedEntryCreated: input.optimisticEntryCreated,
              optimisticEntries: input.optimisticEntries,
              characterRowProjectionEpoch: input.optimisticRowEpoch,
              characterLorebookProjectionEpoch: input.optimisticLorebookEpoch,
            })
        : undefined,
    },
  )
}

export async function deleteCharacterLorebookEntryCommand(
  input: DeleteCharacterLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ characterId: string; entryId: string; entryIndex: number }>> {
  return requestCommandJson(
    `/characters/${encodeURIComponent(input.characterId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
      },
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'character',
              operation: 'delete',
              expectedTargetId: input.characterId,
              expectedEntryId: input.entryId,
              expectedEntryIndex: input.optimisticEntryIndex,
              optimisticEntries: input.optimisticEntries,
              characterRowProjectionEpoch: input.optimisticRowEpoch,
              characterLorebookProjectionEpoch: input.optimisticLorebookEpoch,
            })
        : undefined,
    },
  )
}

export async function reorderCharacterLorebookEntriesCommand(
  input: ReorderCharacterLorebookEntriesCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/lorebooks/entries/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      entryIds: input.entryIds,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'character',
            operation: 'reorder',
            expectedTargetId: input.characterId,
            expectedEntryIds: input.entryIds,
            optimisticEntries: input.optimisticEntries,
            characterRowProjectionEpoch: input.optimisticRowEpoch,
            characterLorebookProjectionEpoch: input.optimisticLorebookEpoch,
          })
      : undefined,
  })
}

export async function replaceChatLorebooksCommand(
  input: ReplaceChatLorebooksCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ chatId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/lorebooks`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      entries: input.entries,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'chat',
            operation: 'replace',
            expectedTargetId: input.chatId,
            expectedEntries: input.entries,
            optimisticEntries: input.optimisticEntries,
            expectedCharacterId: input.optimisticCharacterId,
            characterRowProjectionEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function upsertChatLorebookEntryCommand(
  input: UpsertChatLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    chatId: string
    entryId: string
    entryIndex: number
    created: boolean
    patchedKeys?: string[]
    deletedKeys?: string[]
  }>
> {
  return requestCommandJson(
    `/chats/${encodeURIComponent(input.chatId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'PUT',
      body: lorebookEntryWriteBody(input),
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'chat',
              operation: 'upsert',
              expectedTargetId: input.chatId,
              expectedEntryId: input.entryId,
              expectedEntry: input.entry,
              expectedSparseUpdate: input.sparseUpdate,
              expectedEntryIndex: input.optimisticEntryIndex,
              expectedEntryCreated: input.optimisticEntryCreated,
              optimisticEntries: input.optimisticEntries,
              expectedCharacterId: input.optimisticCharacterId,
              characterRowProjectionEpoch: input.optimisticRowEpoch,
            })
        : undefined,
    },
  )
}

export async function deleteChatLorebookEntryCommand(
  input: DeleteChatLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ chatId: string; entryId: string; entryIndex: number }>> {
  return requestCommandJson(
    `/chats/${encodeURIComponent(input.chatId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
      },
      signal,
      keepalive,
      readLocalEffect: input.acknowledgeOptimistic
        ? (body, event) =>
            readLorebookMutationLocalEffect(body, event, {
              scope: 'chat',
              operation: 'delete',
              expectedTargetId: input.chatId,
              expectedEntryId: input.entryId,
              expectedEntryIndex: input.optimisticEntryIndex,
              optimisticEntries: input.optimisticEntries,
              expectedCharacterId: input.optimisticCharacterId,
              characterRowProjectionEpoch: input.optimisticRowEpoch,
            })
        : undefined,
    },
  )
}

export async function reorderChatLorebookEntriesCommand(
  input: ReorderChatLorebookEntriesCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<ServerCommandResult<{ chatId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/lorebooks/entries/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      entryIds: input.entryIds,
    },
    signal,
    keepalive,
    readLocalEffect: input.acknowledgeOptimistic
      ? (body, event) =>
          readLorebookMutationLocalEffect(body, event, {
            scope: 'chat',
            operation: 'reorder',
            expectedTargetId: input.chatId,
            expectedEntryIds: input.entryIds,
            optimisticEntries: input.optimisticEntries,
            expectedCharacterId: input.optimisticCharacterId,
            characterRowProjectionEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function replaceModuleLorebooksCommand(
  input: ReplaceModuleLorebooksCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/lorebooks`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      entries: input.entries,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'lorebooks',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isCanonicalLorebookEntryArray(input.entries),
          })
      : undefined,
  })
}

export async function upsertModuleLorebookEntryCommand(
  input: UpsertModuleLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<
  ServerCommandResult<{
    moduleId: string
    entryId: string
    entryIndex: number
    created: boolean
    patchedKeys?: string[]
    deletedKeys?: string[]
  }>
> {
  return requestCommandJson(
    `/modules/${encodeURIComponent(input.moduleId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'PUT',
      body: lorebookEntryWriteBody(input),
      signal,
      keepalive,
      readLocalEffect: acknowledgeOptimistic
        ? (body, event) =>
            readModuleCollectionMutationLocalEffect(body, event, {
              operation: 'lorebooks',
              expectedModuleId: input.moduleId,
              expectedEntryId: input.entryId,
              entryResult: 'upsert',
              expectedSparseUpdate: input.sparseUpdate,
              hasCanonicalPayload:
                isCanonicalLorebookEntry(input.entry) &&
                (!input.sparseUpdate || lorebookEntryMatchesSparseUpdate(input.entry, input.sparseUpdate)),
            })
        : undefined,
    },
  )
}

export async function deleteModuleLorebookEntryCommand(
  input: DeleteModuleLorebookEntryCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string; entryId: string; entryIndex: number }>> {
  return requestCommandJson(
    `/modules/${encodeURIComponent(input.moduleId)}/lorebooks/entries/${encodeURIComponent(input.entryId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
      },
      signal,
      keepalive,
      readLocalEffect: acknowledgeOptimistic
        ? (body, event) =>
            readModuleCollectionMutationLocalEffect(body, event, {
              operation: 'lorebooks',
              expectedModuleId: input.moduleId,
              expectedEntryId: input.entryId,
              entryResult: 'delete',
            })
        : undefined,
    },
  )
}

export async function reorderModuleLorebookEntriesCommand(
  input: ReorderModuleLorebookEntriesCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/lorebooks/entries/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      entryIds: input.entryIds,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'lorebooks',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isUniqueStringArray(input.entryIds),
          })
      : undefined,
  })
}

export async function mutateGlobalScriptsCommand(
  input: MutateGlobalScriptsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
): Promise<
  ServerCommandResult<{
    group: SettingsGroup
    key: string
    certificate?: string
    operation?: string
    globalScriptsDigest?: string
    acknowledgedKeys?: string[]
    settings?: Record<string, unknown>
  }>
> {
  const expectedDigest = await sha256HexUtf8(serializeScriptDefinitionCollectionDigestInput(input.expectedScripts))
  return requestCommandJson('/settings/advanced/global-scripts', {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    },
    signal,
    keepalive,
    readLocalEffect: (body, event) => readGlobalScriptMutationLocalEffect(body, event, input, expectedDigest),
  })
}

export async function replaceCharacterScriptsCommand(
  input: ReplaceCharacterScriptsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/scripts`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      scripts: input.scripts,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readCharacterDefinitionMutationLocalEffect(body, event, {
            operation: 'scripts',
            expectedCharacterId: input.characterId,
            expectedDefinitions: input.scripts,
            optimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function mutateCharacterScriptsCommand(
  input: MutateCharacterScriptsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/scripts`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readCharacterDefinitionMutationLocalEffect(body, event, {
            operation: 'scripts',
            expectedCharacterId: input.characterId,
            expectedDefinitions: input.expectedScripts,
            optimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function replaceCharacterTriggersCommand(
  input: ReplaceCharacterTriggersCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/triggers`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      triggers: input.triggers,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readCharacterDefinitionMutationLocalEffect(body, event, {
            operation: 'triggers',
            expectedCharacterId: input.characterId,
            expectedDefinitions: input.triggers,
            optimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function mutateCharacterTriggersCommand(
  input: MutateCharacterTriggersCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/triggers`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readCharacterDefinitionMutationLocalEffect(body, event, {
            operation: 'triggers',
            expectedCharacterId: input.characterId,
            expectedDefinitions: input.expectedTriggers,
            optimisticRowEpoch: input.optimisticRowEpoch,
          })
      : undefined,
  })
}

export async function replaceModuleScriptsCommand(
  input: ReplaceModuleScriptsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/scripts`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      scripts: input.scripts,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'scripts',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isUniqueDefinitionArray(input.scripts),
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function mutateModuleScriptsCommand(
  input: MutateModuleScriptsCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/scripts`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'scripts',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isUniqueDefinitionArray(input.expectedScripts),
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function replaceModuleTriggersCommand(
  input: ReplaceModuleTriggersCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/triggers`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      triggers: input.triggers,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'triggers',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isUniqueDefinitionArray(input.triggers),
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function mutateModuleTriggersCommand(
  input: MutateModuleTriggersCommandInput,
  signal?: AbortSignal | null,
  keepalive = false,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}/triggers`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      mutation: input.mutation,
    },
    signal,
    keepalive,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'triggers',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: isUniqueDefinitionArray(input.expectedTriggers),
            collectionProjectionEpoch: input.optimisticCollectionEpoch,
          })
      : undefined,
  })
}

export async function createModuleCommand(
  input: CreateModuleCommandInput,
  signal?: AbortSignal | null,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson('/modules', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      module: input.module,
    },
    signal,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'create',
            expectedModuleId: input.module.id,
            hasCanonicalPayload: isCanonicalModuleCreate(input.module),
          })
      : undefined,
  })
}

export async function updateModuleCommand(
  input: UpdateModuleCommandInput,
  signal?: AbortSignal | null,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'update',
            expectedModuleId: input.moduleId,
            hasCanonicalPayload: Object.keys(input.patch).length > 0,
          })
      : undefined,
  })
}

export async function deleteModuleCommand(
  input: DeleteModuleCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ moduleId: string }>> {
  return requestCommandJson(`/modules/${encodeURIComponent(input.moduleId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
  })
}

export async function enableModuleCommand(
  input: EnableModuleCommandInput,
  signal?: AbortSignal | null,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ moduleId: string; enabled: boolean }>> {
  return requestCommandJson('/modules/enable', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      moduleId: input.moduleId,
      enabled: input.enabled,
    },
    signal,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) => readModuleEnabledLocalEffect(body, event, input.moduleId, input.enabled)
      : undefined,
  })
}

export async function reorderModulesCommand(
  input: ReorderModulesCommandInput,
  signal?: AbortSignal | null,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult> {
  return requestCommandJson('/modules/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      moduleIds: input.moduleIds,
      ...(input.folderByModuleId ? { folderByModuleId: input.folderByModuleId } : {}),
    },
    signal,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          readModuleCollectionMutationLocalEffect(body, event, {
            operation: 'reorder',
            expectedModuleIds: input.moduleIds,
          })
      : undefined,
  })
}

export async function createModuleFolderCommand(
  input: CreateModuleFolderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson('/module-folders', {
    method: 'POST',
    body: { baseRevision: input.baseRevision, folder: input.folder },
    signal,
  })
}

export async function updateModuleFolderCommand(
  input: UpdateModuleFolderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson(`/module-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'PATCH',
    body: { baseRevision: input.baseRevision, patch: input.patch },
    signal,
  })
}

export async function deleteModuleFolderCommand(
  input: DeleteModuleFolderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ folderId: string }>> {
  return requestCommandJson(`/module-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'DELETE',
    body: { baseRevision: input.baseRevision },
    signal,
  })
}

export async function reorderModuleFoldersCommand(
  input: ReorderModuleFoldersCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return requestCommandJson('/module-folders/reorder', {
    method: 'POST',
    body: { baseRevision: input.baseRevision, folderIds: input.folderIds },
    signal,
  })
}

export async function reorderCharacterModulesCommand(
  input: ReorderCharacterModulesCommandInput,
  signal?: AbortSignal | null,
  acknowledgeOptimistic = false,
): Promise<ServerCommandResult<{ characterId: string }>> {
  return requestCommandJson(`/characters/${encodeURIComponent(input.characterId)}/modules/reorder`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      moduleIds: input.moduleIds,
    },
    signal,
    readLocalEffect: acknowledgeOptimistic
      ? (body, event) =>
          event.type === 'character.modules.reordered' && event.parentId === undefined
            ? readCharacterPatchLocalEffect(body, event, input.characterId, { modules: input.moduleIds })
            : undefined
      : undefined,
  })
}

export async function createPluginCommand(
  input: CreatePluginCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ pluginId: string }>> {
  return requestCommandJson('/plugins', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      plugin: input.plugin,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPluginCollectionMutationLocalEffect(body, event, {
        operation: 'create',
        expectedPluginId: input.plugin.name,
      }),
  })
}

export async function updatePluginCommand(
  input: UpdatePluginCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ pluginId: string }>> {
  return requestCommandJson(`/plugins/${encodeURIComponent(input.pluginId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPluginCollectionMutationLocalEffect(body, event, {
        operation: 'update',
        expectedPluginId: input.pluginId,
        hasMutation: Object.keys(input.patch).length > 0,
      }),
  })
}

export async function deletePluginCommand(
  input: DeletePluginCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ pluginId: string }>> {
  return requestCommandJson(`/plugins/${encodeURIComponent(input.pluginId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPluginCollectionMutationLocalEffect(body, event, {
        operation: 'delete',
        expectedPluginId: input.pluginId,
      }),
  })
}

export async function enablePluginCommand(
  input: EnablePluginCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ pluginId: string; enabled: boolean }>> {
  return requestCommandJson(`/plugins/${encodeURIComponent(input.pluginId)}/enable`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      enabled: input.enabled,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPluginCollectionMutationLocalEffect(body, event, {
        operation: 'enable',
        expectedPluginId: input.pluginId,
        expectedEnabled: input.enabled,
      }),
  })
}

export async function selectPluginProviderCommand(
  input: SelectPluginProviderCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ provider: string }>> {
  return requestCommandJson('/plugins/provider', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      provider: input.provider,
    },
    signal,
    readLocalEffect: (body, event) => readPluginProviderLocalEffect(body, event, input.provider),
  })
}

export async function reorderPluginsCommand(
  input: ReorderPluginsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return requestCommandJson('/plugins/reorder', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      pluginIds: input.pluginIds,
    },
    signal,
    readLocalEffect: (body, event) =>
      readPluginCollectionMutationLocalEffect(body, event, {
        operation: 'reorder',
        expectedPluginIds: input.pluginIds,
      }),
  })
}

export async function putPluginStorageCommand(
  input: PutPluginStorageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ key: string }>> {
  return requestCommandJson(`/plugin-storage/${encodeURIComponent(input.key)}`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      value: input.value,
    },
    signal,
    readLocalEffect: (body, event) => readPluginStorageLocalEffect(body, event, 'put', input.key),
  })
}

export async function deletePluginStorageCommand(
  input: DeletePluginStorageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ key: string }>> {
  return requestCommandJson(`/plugin-storage/${encodeURIComponent(input.key)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: (body, event) => readPluginStorageLocalEffect(body, event, 'delete', input.key),
  })
}

export async function bulkPluginStorageCommand(
  input: BulkPluginStorageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult> {
  return requestCommandJson('/plugin-storage/bulk', {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      values: input.values ?? {},
      deleteKeys: input.deleteKeys ?? [],
      clear: input.clear ?? false,
    },
    signal,
    readLocalEffect: (body, event) => readPluginStorageLocalEffect(body, event, 'bulk'),
  })
}

export async function appendMessageCommand(
  input: AppendMessageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; messageId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/messages`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      message: input.message,
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'append',
        expectedChatId: input.chatId,
        expectedMessageId: input.message.chatId,
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function updateMessageCommand(
  input: UpdateMessageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; messageId: string }>> {
  return requestCommandJson(`/messages/${encodeURIComponent(input.messageId)}`, {
    method: 'PATCH',
    body: {
      baseRevision: input.baseRevision,
      patch: input.patch,
      ...(input.expectedData !== undefined ? { expectedData: input.expectedData } : {}),
      ...(input.expectedChatId !== undefined ? { expectedChatId: input.expectedChatId } : {}),
      ...(input.expectedGenerationId !== undefined ? { expectedGenerationId: input.expectedGenerationId } : {}),
      ...(input.igpEffect ? { igpEffect: input.igpEffect } : {}),
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'update',
        expectedChatId: input.optimisticChatId,
        expectedMessageId: input.messageId,
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function translateMessageCommand(
  input: TranslateMessageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; messageId: string; jobId: string; translation: MessageTranslation }>> {
  return requestCommandJson(`/messages/${encodeURIComponent(input.messageId)}/translate`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      jobId: input.jobId,
    },
    signal,
    // Raw translation deliberately runs outside the global mutation queue;
    // reconcile its accepted response even if unrelated queued edits exist.
    reconcileImmediately: true,
    readLocalEffect: (body, event) => readMessageTranslationLocalEffect(body, event, input.messageId),
    deferOwnEventUntilResponse: (event) =>
      event.type === 'message.updated' && event.resource === 'message' && event.id === input.messageId,
  })
}

export async function deleteMessageCommand(
  input: DeleteMessageCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; messageId: string }>> {
  return requestCommandJson(`/messages/${encodeURIComponent(input.messageId)}`, {
    method: 'DELETE',
    body: {
      baseRevision: input.baseRevision,
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'delete',
        expectedChatId: input.optimisticChatId,
        expectedMessageId: input.messageId,
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function truncateMessagesCommand(
  input: TruncateMessagesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; afterMessageId: string | null; removedCount: number }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/messages/truncate`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      afterMessageId: input.afterMessageId ?? null,
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'truncate',
        expectedChatId: input.chatId,
        expectedAfterMessageId: input.afterMessageId ?? null,
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function replaceTailMessagesCommand(
  input: ReplaceTailMessagesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; afterMessageId: string | null; replacedCount: number }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/messages/tail`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      afterMessageId: input.afterMessageId ?? null,
      messages: input.messages,
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'replaceTail',
        expectedChatId: input.chatId,
        expectedAfterMessageId: input.afterMessageId ?? null,
        expectedMessageIds: input.messages.map((message) => message.chatId),
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function replaceMessagesCommand(
  input: ReplaceMessagesCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/messages`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      messages: input.messages,
    },
    signal,
    readLocalEffect: (body, event) =>
      readMessageMutationLocalEffect(body, event, {
        operation: 'replaceAll',
        expectedChatId: input.chatId,
        expectedMessageIds: input.messages.map((message) => message.chatId),
        expectedChatBodyProjectionEpoch: input.optimisticChatBodyProjectionEpoch,
      }),
  })
}

export async function persistGenerationResultCommand(
  input: PersistGenerationResultCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ chatId: string; messageId: string }>> {
  return requestCommandJson(`/chats/${encodeURIComponent(input.chatId)}/generation-result`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      generationResult: input.generationResult,
    },
    signal,
  })
}

export async function patchBardWikiChatSettingsCommand(
  input: PatchBardWikiChatSettingsCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ settings: BardWikiChatSettings }>> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(input.chatId)}/settings`, {
    method: 'PATCH',
    body: { baseRevision: input.baseRevision, patch: input.patch },
    signal,
  })
}

export async function createBardWikiDocumentCommand(
  input: CreateBardWikiDocumentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ document: BardWikiDocument }>> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(input.chatId)}/documents`, {
    method: 'POST',
    body: { baseRevision: input.baseRevision, document: input.document },
    signal,
  })
}

export async function updateBardWikiDocumentCommand(
  input: UpdateBardWikiDocumentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ document: BardWikiDocument }>> {
  return requestCommandJson(
    `/bardwiki/chats/${encodeURIComponent(input.chatId)}/documents/${encodeURIComponent(input.documentId)}`,
    {
      method: 'PATCH',
      body: {
        baseRevision: input.baseRevision,
        expectedVersion: input.expectedVersion,
        expectedContentHash: input.expectedContentHash,
        patch: input.patch,
      },
      signal,
    },
  )
}

export async function deleteBardWikiDocumentCommand(
  input: DeleteBardWikiDocumentCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ document: BardWikiDocument }>> {
  return requestCommandJson(
    `/bardwiki/chats/${encodeURIComponent(input.chatId)}/documents/${encodeURIComponent(input.documentId)}`,
    {
      method: 'DELETE',
      body: {
        baseRevision: input.baseRevision,
        expectedVersion: input.expectedVersion,
        expectedContentHash: input.expectedContentHash,
      },
      signal,
    },
  )
}

export async function confirmBardWikiAssistantCommand(
  input: ConfirmBardWikiAssistantCommandInput,
  signal?: AbortSignal | null,
): Promise<
  ServerCommandResult<{
    receipt: BardWikiReceiptSummary
    job: BardWikiJobSummary
    created: boolean
  }>
> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(input.chatId)}/confirmations`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      userMessageId: input.userMessageId,
      userContentHash: input.userContentHash,
      assistantMessageId: input.assistantMessageId,
      assistantContentHash: input.assistantContentHash,
    },
    signal,
  })
}

export async function previewBardWikiRebuildCommand(
  chatId: string,
  policy: BardWikiRebuildPolicy,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ preview: BardWikiRebuildPreview }>> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(chatId)}/rebuilds`, {
    method: 'POST',
    body: { preview: true, policy },
    signal,
    allowEventlessSuccess: (body) => isExactBardWikiRebuildPreviewReceipt(body, chatId, policy),
  })
}

export async function queueBardWikiRebuildCommand(
  input: QueueBardWikiRebuildCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ job: BardWikiJobSummary }>> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(input.chatId)}/rebuilds`, {
    method: 'POST',
    body: {
      baseRevision: input.baseRevision,
      preview: false,
      confirm: true,
      policy: input.policy,
      expectedSourceCount: input.expectedSourceCount,
    },
    signal,
  })
}

export async function importBardWikiVaultCommand(
  input: BardWikiVaultImportCommandInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ dryRun: boolean; plan: BardWikiVaultImportPlan }>> {
  return requestCommandJson(`/bardwiki/chats/${encodeURIComponent(input.chatId)}/imports`, {
    method: 'POST',
    body: {
      ...(input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }),
      dryRun: input.dryRun,
      strategy: input.strategy,
      archiveBase64: input.archiveBase64,
      expectedTargets: input.expectedTargets ?? [],
    },
    signal,
    allowEventlessSuccess:
      input.dryRun === true ? (body) => isExactBardWikiVaultDryRunReceipt(body, input.strategy) : undefined,
  })
}

function isExactBardWikiRebuildPreviewReceipt(
  body: Record<string, unknown>,
  expectedChatId: string,
  expectedPolicy: BardWikiRebuildPolicy,
): boolean {
  if (!isJsonValueEqual(Object.keys(body).sort(), ['preview', 'revision'])) return false
  if (!isPlainJsonRecord(body.preview)) return false
  const preview = body.preview
  if (
    !isJsonValueEqual(Object.keys(preview).sort(), [
      'activeJobId',
      'chatId',
      'policy',
      'preserveUserDocumentCount',
      'replaceDerivedDocumentCount',
      'sourceCount',
    ]) ||
    preview.chatId !== expectedChatId ||
    preview.policy !== expectedPolicy ||
    !isNonNegativeInteger(preview.sourceCount) ||
    !isNonNegativeInteger(preview.replaceDerivedDocumentCount) ||
    !isNonNegativeInteger(preview.preserveUserDocumentCount) ||
    (preview.activeJobId !== null && !nonEmptyString(preview.activeJobId))
  ) {
    return false
  }
  return true
}

function isExactBardWikiVaultDryRunReceipt(
  body: Record<string, unknown>,
  expectedStrategy: BardWikiVaultConflictStrategy,
): boolean {
  if (!isJsonValueEqual(Object.keys(body).sort(), ['dryRun', 'plan', 'revision']) || body.dryRun !== true) return false
  if (!isPlainJsonRecord(body.plan)) return false
  const plan = body.plan
  if (
    !isJsonValueEqual(Object.keys(plan).sort(), [
      'actions',
      'applicable',
      'creates',
      'format',
      'noops',
      'renames',
      'replacements',
      'skips',
      'strategy',
      'version',
    ]) ||
    plan.format !== 'risu-bardwiki-vault' ||
    plan.version !== 1 ||
    plan.strategy !== expectedStrategy ||
    !isNonNegativeInteger(plan.creates) ||
    !isNonNegativeInteger(plan.replacements) ||
    !isNonNegativeInteger(plan.noops) ||
    !isNonNegativeInteger(plan.skips) ||
    !isNonNegativeInteger(plan.renames) ||
    typeof plan.applicable !== 'boolean' ||
    !Array.isArray(plan.actions) ||
    !plan.actions.every(isExactBardWikiVaultImportAction)
  ) {
    return false
  }

  const actionCounts = { create: 0, replace: 0, noop: 0, skip: 0 }
  for (const action of plan.actions as BardWikiVaultImportAction[]) actionCounts[action.action] += 1
  return (
    plan.creates === actionCounts.create &&
    plan.replacements === actionCounts.replace &&
    plan.noops === actionCounts.noop &&
    plan.skips === actionCounts.skip &&
    (plan.renames as number) <= actionCounts.create
  )
}

function isExactBardWikiVaultImportAction(value: unknown): value is BardWikiVaultImportAction {
  if (!isPlainJsonRecord(value)) return false
  return (
    isJsonValueEqual(Object.keys(value).sort(), [
      'action',
      'conflict',
      'logicalPath',
      'sourceDocumentId',
      'targetDocumentId',
    ]) &&
    nonEmptyString(value.sourceDocumentId) &&
    nonEmptyString(value.targetDocumentId) &&
    nonEmptyString(value.logicalPath) &&
    (value.action === 'create' || value.action === 'replace' || value.action === 'noop' || value.action === 'skip') &&
    (value.conflict === null ||
      value.conflict === 'id' ||
      value.conflict === 'path' ||
      value.conflict === 'id_and_path' ||
      value.conflict === 'ambiguous')
  )
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

export async function upsertServerInlayCatalogCommand(
  input: UpsertServerInlayCatalogInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ asset: ServerInlayCatalogEntry }>> {
  return requestCommandJson(`/inlay-assets/${encodeURIComponent(input.assetId)}`, {
    method: 'PUT',
    body: {
      baseRevision: input.baseRevision,
      name: input.name,
      aliases: input.aliases ?? [],
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    },
    signal,
  })
}

export async function deleteServerInlayCatalogCommand(
  input: DeleteServerInlayCatalogInput,
  signal?: AbortSignal | null,
): Promise<ServerCommandResult<{ assetId: string }>> {
  return requestCommandJson(`/inlay-assets/${encodeURIComponent(input.assetId)}`, {
    method: 'DELETE',
    body: { baseRevision: input.baseRevision },
    signal,
  })
}

export async function runServerPresetCommand<T extends Record<string, unknown> = {}>(
  input: RunServerPresetCommandInput<T>,
): Promise<ServerCommandResult<T>> {
  return runServerCommand(input)
}

export async function runServerCommand<T extends Record<string, unknown> = {}>(
  input: RunServerPresetCommandInput<T>,
): Promise<ServerCommandResult<T>> {
  if (!canUseServerCommands()) return { status: 'unavailable' }

  const rollbackEpoch = captureDestructiveRefreshEpoch()
  const sessionGeneration = captureClientSessionGeneration()
  return enqueueServerCommandExecution(() =>
    withQueuedCommandExecutionContext(
      rollbackEpoch,
      input.mutationId,
      input.databaseLineage,
      async () => {
        if (!canExecuteServerCommandAccess('ordinary') && !input.executionWrapper) {
          runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
          return { status: 'unavailable' }
        }
        let executionStarted = false
        const deferredRollback = input.failureRollbackDisposition ? input.rollback : undefined
        const executionInput = input.failureRollbackDisposition ? { ...input, rollback: undefined } : input
        const execute = () => {
          if (!canExecuteServerCommandAccess('ordinary')) return Promise.resolve({ status: 'unavailable' as const })
          executionStarted = true
          return executeServerCommand(executionInput, rollbackEpoch)
        }
        let result: ServerCommandResult<T>
        try {
          result = input.executionWrapper ? await input.executionWrapper(execute) : await execute()
        } catch (error) {
          if (
            (input.failureRollbackDisposition &&
              input.failureRollbackDisposition({ status: 'unavailable' }) !== 'retain') ||
            (!input.failureRollbackDisposition && !executionStarted)
          ) {
            runRollbackUnlessDestructiveRefreshChanged(deferredRollback ?? input.rollback, rollbackEpoch)
          }
          throw error
        }
        if (
          result.status !== 'ok' &&
          input.failureRollbackDisposition &&
          input.failureRollbackDisposition(result) === 'rollback'
        ) {
          runRollbackUnlessDestructiveRefreshChanged(deferredRollback, rollbackEpoch)
        } else if (!executionStarted && result.status !== 'ok' && !input.failureRollbackDisposition) {
          // Durable dependency wrappers can retain a successor without sending
          // it when an older owner mutation is still transiently blocked. The
          // normal executor did not run in that branch, so restore the optimistic
          // projection here instead of leaving a UI value that was never sent.
          runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
        }
        return result
      },
      sessionGeneration,
    ),
  )
}

/**
 * Run a multi-resource optimistic mutation as one queue unit. Every accepted
 * response advances the shared revision cursor before the next factory runs,
 * while response events remain deferred until the whole sequence finishes.
 * This prevents unrelated queued commands from interleaving between steps and
 * lets bootstrap reconcile the accumulated events once.
 *
 * A failure rolls back inside the queue task, before its accepted earlier
 * events are flushed through reconciliation. `null` means every step was
 * accepted (or there was no work to dispatch); otherwise the first failure is
 * returned and later factories are skipped.
 */
export async function runServerCommandSequence(
  commands: readonly ServerCommandSequenceEntry[],
  rollback?: (isCurrent: () => boolean) => void | Promise<void>,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult | null> {
  if (commands.length === 0) return null
  if (!canUseServerCommands()) return { status: 'unavailable' }

  return runServerCommandSequenceWithAccess('ordinary', commands, rollback, options)
}

function runServerCommandSequenceWithAccess(
  access: ServerCommandAccess,
  commands: readonly ServerCommandSequenceEntry[],
  rollback?: (isCurrent: () => boolean) => void | Promise<void>,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult | null> {
  if (commands.length === 0) return Promise.resolve(null)
  if (!canUseServerCommandAccess(access)) return Promise.resolve({ status: 'unavailable' })

  const rollbackEpoch = captureDestructiveRefreshEpoch()
  const sessionGeneration = captureClientSessionGeneration()
  return enqueueServerCommandExecution((batch) =>
    withQueuedCommandExecutionContext(
      rollbackEpoch,
      options.mutationId,
      options.databaseLineage,
      async () => {
        if (!canExecuteServerCommandAccess(access)) return { status: 'unavailable' }
        return executeServerCommandSequence(commands, rollback, rollbackEpoch, batch, access)
      },
      sessionGeneration,
    ),
  )
}

export type DurableMutationReplayResult =
  | { status: 'ok' }
  | { status: 'conflict'; currentRevision: number }
  | {
      status: 'error'
      error: string
      reason?: ServerCommandErrorReason
    }
  | { status: 'unavailable' }

/** Reserve replay in the same command queue as live edits before acquiring any
 * durable key locks. A lock held while waiting for this queue can deadlock a
 * live successor already waiting for that lock inside the queue. */
export function enqueueDurableMutationReplay<T>(execute: () => Promise<T>): Promise<T | undefined> {
  if (!canUseServerCommandAccess('pending-replay')) return Promise.resolve(undefined)
  const epoch = captureDestructiveRefreshEpoch()
  const generation = captureClientSessionGeneration()
  return enqueueServerCommandExecution(() =>
    withQueuedCommandExecutionContext(
      epoch,
      undefined,
      undefined,
      async () => (canExecuteServerCommandAccess('pending-replay') ? execute() : undefined),
      generation,
    ),
  )
}

/** Replay one encrypted outbox entry against the current revision cursor. */
export async function replayDurableMutationRequests(
  requests: readonly DurableMutationRequest[],
  mutationId: string,
  databaseLineage: string,
): Promise<DurableMutationReplayResult> {
  if (requests.length === 0) return { status: 'ok' }
  if (!canUseServerCommandAccess('pending-replay')) return { status: 'unavailable' }
  const sessionGeneration = captureClientSessionGeneration()
  const factories = requests.map(
    (request): ServerCommandFactory =>
      (baseRevision) =>
        requestCommandJson(
          request.path,
          {
            method: request.method,
            body: { ...cloneJsonValue(request.body), baseRevision },
          },
          'pending-replay',
        ),
  )
  const options = { mutationId, databaseLineage }
  let failed = await runServerCommandSequenceWithAccess('pending-replay', factories, undefined, options)
  // A different live writer may have advanced the revision while this tab was
  // gone. The 409 response advances the cached cursor; replay the same stable
  // receipt ids once so already-accepted prefix requests dedupe transactionally.
  if (!isClientSessionGenerationCurrent(sessionGeneration)) return { status: 'unavailable' }
  if (failed?.status === 'conflict') {
    failed = await runServerCommandSequenceWithAccess('pending-replay', factories, undefined, options)
  }
  return failed ?? { status: 'ok' }
}

/**
 * Replay an older durable generation from inside a successor's existing queue
 * task. Calling the public replay helper here would enqueue behind the current
 * task and deadlock; this variant temporarily swaps only the receipt sequence
 * while preserving the active rollback epoch and reconciliation batch.
 */
export async function replayDurableMutationRequestsInline(
  requests: readonly DurableMutationRequest[],
  mutationId: string,
  databaseLineage: string,
): Promise<DurableMutationReplayResult> {
  if (requests.length === 0) return { status: 'ok' }
  if (!canUseServerCommandAccess('pending-replay')) return { status: 'unavailable' }
  const reconciliationBatch = activeServerCommandReconciliationBatch
  const rollbackEpoch = activeQueuedCommandDestructiveRefreshEpoch
  if (!reconciliationBatch || rollbackEpoch === null) return { status: 'unavailable' }

  const normalizedMutationId = normalizeMutationId(mutationId)
  const normalizedDatabaseLineage = normalizeDatabaseLineage(databaseLineage)
  const factories = requests.map(
    (request): ServerCommandFactory =>
      (baseRevision) =>
        requestCommandJson(
          request.path,
          {
            method: request.method,
            body: { ...cloneJsonValue(request.body), baseRevision },
          },
          'pending-replay',
        ),
  )
  const executeAttempt = async (): Promise<ServerCommandResult | null> => {
    const previousMutation = activeQueuedCommandMutation
    activeQueuedCommandMutation = {
      id: normalizedMutationId,
      databaseLineage: normalizedDatabaseLineage,
      requestIndex: 0,
    }
    try {
      return await executeServerCommandSequence(
        factories,
        undefined,
        rollbackEpoch,
        reconciliationBatch,
        'pending-replay',
      )
    } finally {
      activeQueuedCommandMutation = previousMutation
    }
  }

  let failed = await executeAttempt()
  if (failed?.status === 'conflict') failed = await executeAttempt()
  return failed ?? { status: 'ok' }
}

export async function acknowledgeServerMutationReceipts(
  mutationId: string,
  requestCount: number,
  databaseLineage: string,
): Promise<boolean> {
  if (!canUseClientRecoveryAccess() || isWriterAccessLost()) return false
  const sessionGeneration = captureClientSessionGeneration()
  const normalizedMutationId = normalizeMutationId(mutationId)
  const normalizedDatabaseLineage = normalizeDatabaseLineage(databaseLineage)
  if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 100) {
    throw new RangeError('Server mutation receipt request count is invalid')
  }
  try {
    const received = await requestServerCommandResponse(
      (auth, signal) =>
        fetch(MUTATION_RECEIPT_ACK_ENDPOINT, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'risu-auth': auth,
            ...activeWriterSessionHeader(),
          },
          body: JSON.stringify({
            mutationId: normalizedMutationId,
            requestCount,
            databaseLineage: normalizedDatabaseLineage,
          }),
        }),
      () =>
        canUseClientRecoveryAccess() && !isWriterAccessLost() && isClientSessionGenerationCurrent(sessionGeneration),
      undefined,
      false,
    )
    return received?.response.ok ?? false
  } catch (error) {
    console.warn('Unable to acknowledge durable server mutation receipts', error)
    return false
  }
}

async function executeServerCommandSequence(
  commands: readonly ServerCommandSequenceEntry[],
  rollback: ((isCurrent: () => boolean) => void | Promise<void>) | undefined,
  rollbackEpoch: number,
  reconciliationBatch: ServerCommandReconciliationBatch,
  access: ServerCommandAccess = 'ordinary',
): Promise<ServerCommandResult | null> {
  const acceptedRevisions: number[] = []
  for (const entry of commands) {
    if (!canExecuteServerCommandAccess(access)) return { status: 'unavailable' }
    // The sequence owns rollback so it runs exactly once for the first failed
    // step. executeServerCommand still normalizes thrown factories to an error
    // result and defers every accepted event into this sequence's active batch.
    const command = typeof entry === 'function' ? entry : entry.command
    const execute = () => executeServerCommand({ command }, rollbackEpoch, access)
    let result: ServerCommandResult
    try {
      result =
        typeof entry === 'function' || !entry.executionWrapper ? await execute() : await entry.executionWrapper(execute)
    } catch (error) {
      console.error('Server command sequence execution wrapper rejected:', error)
      const message = error instanceof Error ? error.message : String(error)
      result = { status: 'error', error: `Command execution wrapper rejected: ${message}` }
    }
    if (result.status === 'ok') {
      if (Number.isInteger(result.event?.revision)) acceptedRevisions.push(result.event.revision)
      continue
    }

    // The sequence rollback restores every optimistic step, including steps
    // the server already accepted. Their events must remain in the batch so
    // reconciliation reads the authoritative resources again, but their local
    // effects can no longer acknowledge the now-rolled-back projection.
    for (const revision of acceptedRevisions) {
      reconciliationBatch.pendingLocalEffects.delete(revision)
    }
    const rollbackIsCurrent = () => queuedClientSessionIsCurrent() && !hasDestructiveRefreshEpochChanged(rollbackEpoch)
    if (rollback && rollbackIsCurrent()) {
      await rollback(rollbackIsCurrent)
    }
    return result
  }
  return null
}

async function executeServerCommand<T extends Record<string, unknown>>(
  input: RunServerPresetCommandInput<T>,
  rollbackEpoch: number,
  access: ServerCommandAccess = 'ordinary',
): Promise<ServerCommandResult<T>> {
  if (!canExecuteServerCommandAccess(access)) {
    runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
    return { status: 'unavailable' }
  }
  let result: ServerCommandResult<T>
  try {
    const baseRevision = await getServerCommandBaseRevisionForAccess(access, input.signal, input.keepalive)
    if (baseRevision === null) {
      runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
      return { status: 'error', error: 'Unable to read server command revision' }
    }

    if (!canExecuteServerCommandAccess(access)) return { status: 'unavailable' }
    result = await input.command(baseRevision)
  } catch (error) {
    // A command-factory rejection must roll back and surface as an error result.
    // Without this, the fire-and-forget runners (`void runServerCommand(...)`)
    // swallowed the rejection and the optimistic write silently diverged from
    // the server.
    console.error('Server command factory rejected:', error)
    runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', error: `Command factory rejected: ${message}` }
  }

  if (result.status !== 'ok') {
    runRollbackUnlessDestructiveRefreshChanged(input.rollback, rollbackEpoch)
  } else if (queuedClientSessionIsCurrent()) {
    // requestCommandJson already advances this cursor, but custom command
    // factories are also supported. Trust their accepted revision so the next
    // queued factory does not reuse a stale baseRevision.
    setCachedServerCommandRevision(result.revision)
    await notifyServerCommandSuccessReconciler(result.event)
  }
  return result
}

function groupSettingsPatch(patch: SettingsPatch): Array<[SettingsGroup, SettingsPatch]> {
  const groups = new Map<SettingsGroup, SettingsPatch>()
  for (const [key, value] of Object.entries(patch)) {
    const group = settingsGroupForKey(key)
    if (!group || value === undefined) continue
    const groupPatch = groups.get(group) ?? {}
    groupPatch[key] = value
    groups.set(group, groupPatch)
  }
  return Array.from(groups.entries())
}

async function requestCommandJson<T extends Record<string, unknown> = {}>(
  path: string,
  init: {
    method: string
    body: unknown
    signal?: AbortSignal | null
    keepalive?: boolean
    reconcileImmediately?: boolean
    readLocalEffect?: (body: unknown, event: CommandEvent) => ServerCommandLocalEffect | undefined
    deferOwnEventUntilResponse?: (event: CommandEvent) => boolean
    allowEventlessSuccess?: (body: Record<string, unknown>) => boolean
  },
  access: ServerCommandAccess = 'ordinary',
): Promise<ServerCommandResult<T>> {
  const sessionGeneration = captureClientSessionGeneration()
  const destructiveRefreshEpoch = activeQueuedCommandDestructiveRefreshEpoch ?? captureDestructiveRefreshEpoch()
  if (!canExecuteServerCommandAccess(access) || !isClientSessionGenerationCurrent(sessionGeneration))
    return { status: 'unavailable' }

  const directReconciliation = init.deferOwnEventUntilResponse
    ? beginDirectServerCommandReconciliation(init.deferOwnEventUntilResponse)
    : null
  let confirmedEvent: CommandEvent | null = null
  try {
    let response: Response
    let body: unknown
    try {
      const received = await requestServerCommandResponse(
        (auth, signal) => {
          const mutation = nextQueuedCommandMutationRequest()
          const requestInit: RequestInit = {
            method: init.method,
            signal,
            headers: {
              'content-type': 'application/json',
              'risu-auth': auth,
              ...activeWriterSessionHeader(),
              ...(mutation
                ? {
                    [SERVER_MUTATION_ID_HEADER]: mutation.mutationId,
                    [SERVER_DATABASE_LINEAGE_HEADER]: mutation.databaseLineage,
                  }
                : {}),
            },
            body: JSON.stringify(init.body),
          }
          if (init.keepalive) requestInit.keepalive = true
          return fetch(`${COMMAND_ENDPOINT}${path}`, requestInit)
        },
        () => canExecuteServerCommandAccess(access) && isClientSessionGenerationCurrent(sessionGeneration),
        init.signal,
      )
      if (!received) return { status: 'unavailable' }
      ;({ response, body } = received)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'error', error: `Network error: ${message}` }
    }

    if (response.status === 409 && isDatabaseLineageConflict(body)) {
      if (isClientSessionGenerationCurrent(sessionGeneration)) scheduleServerOwnershipReload()
      return {
        status: 'error',
        error: errorMessageFromBody(body, 'HTTP 409'),
        reason: 'database-lineage',
      }
    }

    if (response.status === 409 && isMutationIdConflict(body)) {
      return {
        status: 'error',
        error: errorMessageFromBody(body, 'HTTP 409'),
        reason: 'mutation-id-conflict',
      }
    }

    if (response.status === 409 && isInitializeConflict(body)) {
      return {
        status: 'error',
        error: 'initialize_conflict',
        reason: 'initialize-conflict',
      }
    }

    if (response.status === 409) {
      const currentRevision = readCurrentRevision(body)
      if (currentRevision !== null && isClientSessionGenerationCurrent(sessionGeneration)) {
        const appliedRevision = peekAppliedServerResourceRevision()
        setCachedServerCommandRevision(currentRevision)
        if (appliedRevision !== null && currentRevision > appliedRevision) {
          serverCommandConflictGapHandler?.(currentRevision, appliedRevision)
        }
      }
      return currentRevision === null
        ? { status: 'error', error: errorMessageFromBody(body, 'HTTP 409') }
        : { status: 'conflict', currentRevision }
    }

    if (response.status === 423 && isActiveWriterStaleErrorBody(body)) {
      if (isClientSessionGenerationCurrent(sessionGeneration)) handleActiveWriterStaleResponse(response, body)
      return { status: 'error', error: errorMessageFromBody(body, 'HTTP 423'), reason: 'stale-writer' }
    }

    if (response.status === 400 && isStableCommandErrorBody(body)) {
      return {
        status: 'error',
        error: errorMessageFromBody(body, 'HTTP 400'),
        reason: 'invalid-request',
      }
    }

    if (response.status === 404 && isStableCommandErrorBody(body)) {
      return {
        status: 'error',
        error: errorMessageFromBody(body, 'HTTP 404'),
        reason: 'not-found',
      }
    }

    if (response.status === 400 || response.status === 404 || response.status === 423) {
      return {
        status: 'error',
        error: errorMessageFromBody(body, `HTTP ${response.status}`),
        reason: 'unrecognized-rejection',
      }
    }

    if (!response.ok) {
      return {
        status: 'error',
        error: errorMessageFromBody(body, `HTTP ${response.status}`),
      }
    }

    const receipt = readCommandSuccessReceipt(body, init.allowEventlessSuccess)
    if (!receipt) {
      return { status: 'error', error: 'Invalid command response' }
    }

    if (!isClientSessionGenerationCurrent(sessionGeneration) || !queuedClientSessionIsCurrent()) {
      return { status: 'ok', ...(body as { revision: number; event: CommandEvent } & T) }
    }
    setCachedServerCommandRevision(receipt.revision)
    if (receipt.event) {
      const parsedLocalEffect = init.readLocalEffect?.(body, receipt.event)
      let localEffect: ServerCommandLocalEffect | undefined
      if (parsedLocalEffect) {
        localEffect = { ...parsedLocalEffect }
        Object.defineProperty(localEffect, 'destructiveRefreshEpoch', {
          value: parsedLocalEffect.destructiveRefreshEpoch ?? destructiveRefreshEpoch,
          enumerable: false,
        })
      }
      await notifyServerCommandSuccessReconciler(receipt.event, init.reconcileImmediately, localEffect)
      confirmedEvent = receipt.event
    }

    return { status: 'ok', ...(body as { revision: number; event: CommandEvent } & T) }
  } finally {
    await finishDirectServerCommandReconciliation(directReconciliation, confirmedEvent)
  }
}

async function notifyServerCommandSuccessReconciler(
  event: CommandEvent | null | undefined,
  reconcileImmediately = false,
  localEffect?: ServerCommandLocalEffect,
): Promise<void> {
  // Some compatibility command factories return a minimal `{ status: 'ok' }`
  // result. They have no authoritative event to reconcile.
  if (!event) return
  if (!reconcileImmediately && deferOwnServerCommandReconciliation(event, localEffect)) return
  await reconcileServerCommandSuccessEvents(
    event,
    [event],
    localEffect ? new Map([[event.revision, localEffect]]) : new Map(),
  )
}

async function reconcileServerCommandSuccessEvents(
  event: CommandEvent,
  coalescedEvents: readonly CommandEvent[],
  localEffects: ReadonlyMap<number, ServerCommandLocalEffect> = new Map(),
): Promise<void> {
  try {
    await serverCommandSuccessReconciler?.(event, coalescedEvents, localEffects)
  } catch (error) {
    console.warn('Server command projection reconcile failed', error)
  }
}

function readChatGenerationSettingsLocalEffect(
  body: unknown,
  event: CommandEvent | null | undefined,
  input: SaveChatGenerationSettingsCommandInput,
): ChatGenerationSettingsLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !event || typeof event !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    record.chatId !== input.chatId ||
    typeof record.characterId !== 'string' ||
    record.characterId.trim() === '' ||
    event.type !== 'chat.updated' ||
    event.resource !== 'characterRow' ||
    event.id !== input.chatId ||
    event.parentId !== record.characterId ||
    !isChatGenerationSettingsSnapshot(input.generationSettings)
  ) {
    return undefined
  }

  if (input.sparseUpdate) {
    if (
      !isProjectionEpoch(input.optimisticCharacterRowEpoch) ||
      !nonEmptyString(input.expectedCharacterId) ||
      record.characterId !== input.expectedCharacterId ||
      (input.sparseBaseGenerationSettings !== null &&
        !isChatGenerationSettingsSnapshot(input.sparseBaseGenerationSettings)) ||
      !isSparseChatGenerationSettingsUpdateProof(input.sparseUpdate, input.generationSettings)
    ) {
      return undefined
    }
  } else if (
    input.optimisticCharacterRowEpoch !== undefined ||
    input.expectedCharacterId !== undefined ||
    input.sparseBaseGenerationSettings !== undefined
  ) {
    return undefined
  }

  let canonicalGenerationSettings: ChatGenerationSettings
  if (Object.prototype.hasOwnProperty.call(record, 'generationSettings')) {
    if (!isChatGenerationSettingsSnapshot(record.generationSettings)) return undefined
    canonicalGenerationSettings = cloneJsonValue(record.generationSettings)
  } else {
    if (!input.sparseUpdate || record.certificate !== 'chat-generation-settings-sparse-v1') return undefined
    if (
      !isUniqueStringArray(record.patchedKeys) ||
      !isUniqueStringArray(record.deletedKeys) ||
      !isUniqueStringArray(record.sidebarTogglePatchedKeys) ||
      !isUniqueStringArray(record.sidebarToggleDeletedKeys) ||
      !isUniqueStringArray(record.prunedSidebarToggleKeys) ||
      !isJsonValueEqual([...record.patchedKeys].sort(), Object.keys(input.sparseUpdate.patch).sort()) ||
      !isJsonValueEqual([...record.deletedKeys].sort(), [...(input.sparseUpdate.deleteKeys ?? [])].sort()) ||
      !isJsonValueEqual(
        [...record.sidebarTogglePatchedKeys].sort(),
        Object.keys(input.sparseUpdate.patch.sidebarToggles ?? {}).sort(),
      ) ||
      !isJsonValueEqual(
        [...record.sidebarToggleDeletedKeys].sort(),
        [...(input.sparseUpdate.sidebarToggleDeleteKeys ?? [])].sort(),
      )
    ) {
      return undefined
    }

    const attemptedToggles = input.generationSettings.sidebarToggles ?? {}
    if (
      record.prunedSidebarToggleKeys.some(
        (key) =>
          !Object.prototype.hasOwnProperty.call(attemptedToggles, key) ||
          (input.sparseUpdate?.sidebarToggleDeleteKeys ?? []).includes(key),
      )
    ) {
      return undefined
    }
    canonicalGenerationSettings = cloneJsonValue(input.generationSettings)
    if (canonicalGenerationSettings.sidebarToggles) {
      for (const key of record.prunedSidebarToggleKeys) delete canonicalGenerationSettings.sidebarToggles[key]
    }
    if (!isChatGenerationSettingsSnapshot(canonicalGenerationSettings)) return undefined
  }

  return {
    kind: 'chatGenerationSettings',
    chatId: record.chatId,
    characterId: record.characterId,
    attemptedGenerationSettings: cloneJsonValue(input.generationSettings),
    generationSettings: canonicalGenerationSettings,
    ...(input.sparseUpdate ? { characterRowProjectionEpoch: input.optimisticCharacterRowEpoch } : {}),
  }
}

async function sha256HexUtf8(value: string): Promise<string> {
  return sharedSha256Hex(value)
}

export function sha256HexUtf8Sync(value: string): string {
  const hash = new Sha256()
  hash.update(new TextEncoder().encode(value))
  return bytesToHex(hash.digestSync())
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const CHAT_GENERATION_SETTINGS_KEY_SET = new Set<string>(CHAT_GENERATION_SETTINGS_KEYS)

function isChatGenerationSettingsSnapshot(value: unknown): value is ChatGenerationSettings {
  if (!isPlainJsonRecord(value) || !isJsonValue(value)) return false
  if (Object.keys(value).some((key) => !CHAT_GENERATION_SETTINGS_KEY_SET.has(key))) return false
  if (typeof value.jailbreakToggle !== 'boolean') return false
  if (value.configured !== undefined && typeof value.configured !== 'boolean') return false
  for (const key of ['personaId', 'modelPresetId', 'promptPresetId', 'agentPresetId', 'togglePresetId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  if (value.sidebarToggles !== undefined) {
    if (!isPlainJsonRecord(value.sidebarToggles)) return false
    if (
      Object.entries(value.sidebarToggles).some(
        ([key, toggleValue]) => key.trim() === '' || typeof toggleValue !== 'string',
      )
    ) {
      return false
    }
  }
  return true
}

function isSparseChatGenerationSettingsUpdateProof(
  update: SparseChatGenerationSettingsUpdate,
  attempted: ChatGenerationSettings,
): boolean {
  if (!isPlainJsonRecord(update.patch) || !isJsonValue(update.patch)) return false
  const patchedKeys = Object.keys(update.patch)
  const deletedKeys = update.deleteKeys ?? []
  const sidebarToggleDeletedKeys = update.sidebarToggleDeleteKeys ?? []
  if (
    patchedKeys.length + deletedKeys.length + sidebarToggleDeletedKeys.length === 0 ||
    patchedKeys.some((key) => !CHAT_GENERATION_SETTINGS_KEY_SET.has(key)) ||
    !isUniqueStringArray(deletedKeys) ||
    deletedKeys.some(
      (key) =>
        !CHAT_GENERATION_SETTINGS_KEY_SET.has(key) ||
        key === 'jailbreakToggle' ||
        Object.prototype.hasOwnProperty.call(update.patch, key),
    ) ||
    !isUniqueStringArray(sidebarToggleDeletedKeys) ||
    (deletedKeys.includes('sidebarToggles') &&
      (Object.prototype.hasOwnProperty.call(update.patch, 'sidebarToggles') || sidebarToggleDeletedKeys.length > 0))
  ) {
    return false
  }

  const sidebarPatch = update.patch.sidebarToggles
  if (sidebarPatch !== undefined) {
    if (
      !isPlainJsonRecord(sidebarPatch) ||
      Object.entries(sidebarPatch).some(
        ([key, value]) => key.trim() === '' || typeof value !== 'string' || sidebarToggleDeletedKeys.includes(key),
      )
    ) {
      return false
    }
  }
  for (const [key, value] of Object.entries(update.patch)) {
    if (key === 'sidebarToggles') continue
    if (!Object.prototype.hasOwnProperty.call(attempted, key) || !isJsonValueEqual(attempted[key], value)) return false
  }
  if (deletedKeys.some((key) => Object.prototype.hasOwnProperty.call(attempted, key))) return false
  for (const [key, value] of Object.entries(sidebarPatch ?? {})) {
    if (attempted.sidebarToggles?.[key] !== value) return false
  }
  if (
    sidebarToggleDeletedKeys.some((key) => Object.prototype.hasOwnProperty.call(attempted.sidebarToggles ?? {}, key))
  ) {
    return false
  }
  return true
}

function readSettingsPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  group: SettingsGroup,
  attemptedPatch: SettingsPatch,
  optimisticProjectionEpoch?: unknown,
): SettingsPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (record.revision !== event.revision) return undefined
  if (!isProjectionEpoch(optimisticProjectionEpoch)) return undefined
  const settingsProjectionEpoch = optimisticProjectionEpoch as number
  const acknowledgedKeys = record.acknowledgedKeys
  const overrides = record.settings
  if (!isUniqueStringArray(acknowledgedKeys)) return undefined
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return undefined

  const attemptedKeys = Object.keys(attemptedPatch).sort()
  const sortedAcknowledgedKeys = [...acknowledgedKeys].sort()
  if (attemptedKeys.length === 0 || !isJsonValueEqual(attemptedKeys, sortedAcknowledgedKeys)) return undefined
  if (attemptedKeys.some((key) => SERVER_SETTINGS_GROUP_BY_KEY[key] !== group)) return undefined
  if (attemptedKeys.some((key) => !isJsonValue(attemptedPatch[key]))) return undefined

  const writesHypaV3Presets = Object.prototype.hasOwnProperty.call(attemptedPatch, 'hypaV3Presets')
  const expectedResource = writesHypaV3Presets ? 'settingsWithHypaV3Presets' : 'settings'
  if (
    event.type !== 'settings.updated' ||
    event.resource !== expectedResource ||
    event.id !== group ||
    event.parentId !== undefined
  ) {
    return undefined
  }

  const acknowledgedKeySet = new Set(acknowledgedKeys)
  const canonicalSettings = cloneJsonValue(attemptedPatch)
  for (const [key, value] of Object.entries(overrides)) {
    if (!acknowledgedKeySet.has(key) || !isJsonValue(value)) return undefined
    canonicalSettings[key] = cloneJsonValue(value)
  }

  return {
    kind: 'settingsPatch',
    group,
    attemptedPatch: cloneJsonValue(attemptedPatch),
    settings: canonicalSettings,
    settingsProjectionEpoch,
  }
}

const SPARSE_SETTINGS_OBJECT_KEYS = new Set(['NAIImgConfig', 'wavespeedImage', 'seperateParameters'])

function readSettingsObjectPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: PatchSettingsObjectFieldsInput,
): SettingsPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    record.certificate !== 'settings-object-patch-v1' ||
    record.group !== input.group ||
    record.key !== input.key ||
    event.type !== 'settings.updated' ||
    event.resource !== 'settings' ||
    event.id !== input.group ||
    event.parentId !== undefined ||
    SERVER_SETTINGS_GROUP_BY_KEY[input.key] !== input.group ||
    !SPARSE_SETTINGS_OBJECT_KEYS.has(input.key) ||
    !isProjectionEpoch(input.optimisticProjectionEpoch) ||
    !isPlainJsonRecord(input.update.patch) ||
    !isJsonValue(input.update.patch) ||
    !isPlainJsonRecord(input.attemptedObject) ||
    !isJsonValue(input.attemptedObject)
  ) {
    return undefined
  }

  const requestedPatchedKeys = Object.keys(input.update.patch).sort()
  const requestedDeletedKeys = [...(input.update.deleteKeys ?? [])].sort()
  if (
    requestedPatchedKeys.length + requestedDeletedKeys.length === 0 ||
    requestedPatchedKeys.some((key) => !nonEmptyString(key)) ||
    !isUniqueStringArray(input.update.deleteKeys ?? []) ||
    requestedDeletedKeys.some((key) => Object.prototype.hasOwnProperty.call(input.update.patch, key)) ||
    requestedPatchedKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(input.attemptedObject, key) ||
        !isJsonValueEqual(input.attemptedObject[key], input.update.patch[key]),
    ) ||
    requestedDeletedKeys.some((key) => Object.prototype.hasOwnProperty.call(input.attemptedObject, key)) ||
    !isUniqueStringArray(record.patchedKeys) ||
    !isUniqueStringArray(record.deletedKeys) ||
    !isJsonValueEqual([...record.patchedKeys].sort(), requestedPatchedKeys) ||
    !isJsonValueEqual([...record.deletedKeys].sort(), requestedDeletedKeys)
  ) {
    return undefined
  }

  if (!isPlainJsonRecord(record.canonicalValues) || !isJsonValue(record.canonicalValues)) return undefined
  if (!isUniqueStringArray(record.canonicalDeletedKeys)) return undefined
  const requestedKeySet = new Set([...requestedPatchedKeys, ...requestedDeletedKeys])
  const canonicalValueKeys = Object.keys(record.canonicalValues)
  const canonicalDeletedKeys = record.canonicalDeletedKeys
  if (
    canonicalValueKeys.some((key) => !requestedKeySet.has(key)) ||
    canonicalDeletedKeys.some(
      (key) => !requestedKeySet.has(key) || Object.prototype.hasOwnProperty.call(record.canonicalValues, key),
    )
  ) {
    return undefined
  }

  const canonicalObject = cloneJsonValue(input.attemptedObject)
  for (const [key, value] of Object.entries(record.canonicalValues)) {
    canonicalObject[key] = cloneJsonValue(value)
  }
  for (const key of canonicalDeletedKeys) delete canonicalObject[key]

  return {
    kind: 'settingsPatch',
    group: input.group,
    attemptedPatch: { [input.key]: cloneJsonValue(input.attemptedObject) },
    settings: { [input.key]: canonicalObject },
    settingsProjectionEpoch: input.optimisticProjectionEpoch,
  }
}

function readPresetReorderLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    presetKind: ReorderablePresetKind
    requestedPresetIds: string[]
    acknowledgement: PresetReorderOptimisticAcknowledgement
  },
): PresetReorderLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined

  const record = body as Record<string, unknown>
  const acknowledgement = input.acknowledgement
  const expectedType = input.presetKind === 'legacy' ? 'preset.reordered' : 'modelPreset.reordered'
  const expectedResource =
    input.presetKind === 'legacy'
      ? acknowledgement.settingsWritten
        ? 'presetCollectionWithPointer'
        : 'presetCollection'
      : 'modelPreset'
  const selectedResponseKey = input.presetKind === 'legacy' ? 'selectedPresetId' : 'selectedModelPresetId'

  if (
    record.revision !== event.revision ||
    record.presetReorderCertificate !== PRESET_REORDER_ACKNOWLEDGEMENT_CERTIFICATE ||
    record.presetKind !== input.presetKind ||
    event.type !== expectedType ||
    event.resource !== expectedResource ||
    event.id !== undefined ||
    event.parentId !== undefined ||
    acknowledgement.presetKind !== input.presetKind ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.settingsProjectionEpoch) ||
    !isUniqueStringArray(acknowledgement.beforePresetIds) ||
    !isUniqueStringArray(acknowledgement.attemptedPresetIds) ||
    !isUniqueStringArray(input.requestedPresetIds) ||
    !isUniqueStringArray(record.presetIds) ||
    !isNullableNonEmptyString(acknowledgement.beforeSelectedPresetId) ||
    !isNullableNonEmptyString(acknowledgement.attemptedSelectedPresetId) ||
    typeof acknowledgement.settingsWritten !== 'boolean' ||
    typeof record.settingsWritten !== 'boolean'
  ) {
    return undefined
  }

  const beforePresetIds = acknowledgement.beforePresetIds
  const attemptedPresetIds = acknowledgement.attemptedPresetIds
  const beforeSelectedPresetId = acknowledgement.beforeSelectedPresetId
  const attemptedSelectedPresetId = acknowledgement.attemptedSelectedPresetId
  if (
    !isJsonValueEqual(input.requestedPresetIds, attemptedPresetIds) ||
    !isJsonValueEqual(record.presetIds, attemptedPresetIds) ||
    !isJsonValueEqual([...beforePresetIds].sort(), [...attemptedPresetIds].sort()) ||
    (beforeSelectedPresetId !== null && !beforePresetIds.includes(beforeSelectedPresetId)) ||
    (attemptedSelectedPresetId !== null && !attemptedPresetIds.includes(attemptedSelectedPresetId)) ||
    attemptedSelectedPresetId !== beforeSelectedPresetId
  ) {
    return undefined
  }

  const beforeSelectedIndex = beforeSelectedPresetId === null ? -1 : beforePresetIds.indexOf(beforeSelectedPresetId)
  const attemptedSelectedIndex =
    attemptedSelectedPresetId === null ? -1 : attemptedPresetIds.indexOf(attemptedSelectedPresetId)
  const expectedSettingsWritten = beforeSelectedIndex !== attemptedSelectedIndex
  if (
    acknowledgement.settingsWritten !== expectedSettingsWritten ||
    record.settingsWritten !== expectedSettingsWritten ||
    record[selectedResponseKey] !== attemptedSelectedPresetId
  ) {
    return undefined
  }

  return {
    kind: 'presetReorder',
    presetKind: input.presetKind,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    settingsProjectionEpoch: acknowledgement.settingsProjectionEpoch,
    presetIds: [...attemptedPresetIds],
    selectedPresetId: attemptedSelectedPresetId,
    settingsWritten: expectedSettingsWritten,
  }
}

function readLegacyPresetPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    presetId: string
    attemptedPatch: Record<string, unknown>
    acknowledgement?: LegacyPresetPatchOptimisticAcknowledgement
  },
): LegacyPresetPatchLocalEffect | undefined {
  const acknowledgement = input.acknowledgement
  if (!acknowledgement || !body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    record.presetId !== input.presetId ||
    event.type !== 'preset.updated' ||
    event.resource !== 'presetRow' ||
    event.id !== input.presetId ||
    event.parentId !== undefined ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isPlainJsonRecord(acknowledgement.attemptedFields)
  ) {
    return undefined
  }

  const acknowledgedKeys = record.acknowledgedKeys
  const canonicalValues = record.canonicalValues
  const canonicalDeletedKeys = record.canonicalDeletedKeys
  if (
    !isUniqueStringArray(acknowledgedKeys) ||
    !isPlainJsonRecord(canonicalValues) ||
    !isUniqueStringArray(canonicalDeletedKeys)
  ) {
    return undefined
  }

  const attemptedKeys = Object.keys(input.attemptedPatch).sort()
  if (
    attemptedKeys.length === 0 ||
    !isJsonValueEqual(attemptedKeys, [...acknowledgedKeys].sort()) ||
    attemptedKeys.some((key) => !nonEmptyString(key) || !isJsonValue(input.attemptedPatch[key]))
  ) {
    return undefined
  }

  const attemptedFields: Record<string, JsonFieldState> = {}
  for (const [key, state] of Object.entries(acknowledgement.attemptedFields)) {
    if (!nonEmptyString(key) || key === 'id') return undefined
    const parsedState = readJsonFieldState(state)
    if (!parsedState) return undefined
    attemptedFields[key] = parsedState
  }
  const expectedAttemptedFieldKeys = [
    ...new Set([...attemptedKeys.filter((key) => key !== 'id'), 'agents', 'agentPresets', 'agentPresetDefaultId']),
  ].sort()
  if (!isJsonValueEqual(Object.keys(attemptedFields).sort(), expectedAttemptedFieldKeys)) {
    return undefined
  }

  const canonicalValueKeys = Object.keys(canonicalValues)
  const canonicalDeletedKeySet = new Set(canonicalDeletedKeys)
  const canonicalKeys = [...canonicalValueKeys, ...canonicalDeletedKeys]
  if (
    canonicalKeys.some(
      (key) => !nonEmptyString(key) || key === 'id' || !Object.prototype.hasOwnProperty.call(attemptedFields, key),
    ) ||
    canonicalValueKeys.some((key) => canonicalDeletedKeySet.has(key) || !isJsonValue(canonicalValues[key]))
  ) {
    return undefined
  }

  const fields: LegacyPresetPatchLocalEffect['fields'] = {}
  for (const key of canonicalValueKeys) {
    fields[key] = {
      attempted: cloneJsonValue(attemptedFields[key]),
      canonical: { present: true, value: cloneJsonValue(canonicalValues[key]) },
    }
  }
  for (const key of canonicalDeletedKeys) {
    fields[key] = {
      attempted: cloneJsonValue(attemptedFields[key]),
      canonical: { present: false },
    }
  }

  return {
    kind: 'legacyPresetPatch',
    presetId: input.presetId,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    fields,
  }
}

type PersonaMutationAcknowledgementPreparation =
  | {
      operation: 'create'
      targetPersonaId: string | null
      createdPersona: PersonaSnapshot
      mirrorLegacyProfile: boolean
      acknowledgement?: PersonaMutationOptimisticAcknowledgement
    }
  | {
      operation: 'delete'
      targetPersonaId: string
      requestedSelectedPersonaId?: string
      mirrorLegacyProfile: boolean
      saveCurrent: boolean
      acknowledgement?: PersonaMutationOptimisticAcknowledgement
    }
  | {
      operation: 'select'
      targetPersonaId: string
      mirrorLegacyProfile: boolean
      saveCurrent: boolean
      acknowledgement?: PersonaMutationOptimisticAcknowledgement
    }
  | {
      operation: 'reorder'
      targetPersonaId: null
      requestedPersonaIds: string[]
      acknowledgement?: PersonaMutationOptimisticAcknowledgement
    }

interface PreparedPersonaMutationAcknowledgement {
  acknowledgement: PersonaMutationOptimisticAcknowledgement
  targetPersonaId: string | null
  personaProjectionDigest: string
  legacyProfileDigest: string | null
}

const PERSONA_PROFILE_DIGEST_KEYS: readonly (keyof PersonaProfileDigestValue)[] = [
  'name',
  'icon',
  'personaPrompt',
  'note',
]

async function preparePersonaMutationAcknowledgement(
  input: PersonaMutationAcknowledgementPreparation,
): Promise<PreparedPersonaMutationAcknowledgement | undefined> {
  const acknowledgement = input.acknowledgement
  if (
    !acknowledgement ||
    acknowledgement.operation !== input.operation ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.settingsProjectionEpoch) ||
    !isUniqueStringArray(acknowledgement.beforePersonaIds) ||
    !isUniqueStringArray(acknowledgement.attemptedPersonaIds) ||
    !Array.isArray(acknowledgement.attemptedPersonas) ||
    !isJsonValue(acknowledgement.attemptedPersonas) ||
    acknowledgement.attemptedPersonas.some((persona) => !isPlainJsonRecord(persona) || !nonEmptyString(persona.id)) ||
    !isJsonValueEqual(
      acknowledgement.attemptedPersonas.map((persona) => persona.id),
      acknowledgement.attemptedPersonaIds,
    ) ||
    !isNullablePersonaId(acknowledgement.beforeSelectedPersonaId) ||
    !isNullablePersonaId(acknowledgement.attemptedSelectedPersonaId) ||
    !selectedPersonaIdBelongsToList(acknowledgement.beforePersonaIds, acknowledgement.beforeSelectedPersonaId) ||
    !selectedPersonaIdBelongsToList(acknowledgement.attemptedPersonaIds, acknowledgement.attemptedSelectedPersonaId) ||
    typeof acknowledgement.collectionWritten !== 'boolean' ||
    typeof acknowledgement.settingsWritten !== 'boolean' ||
    typeof acknowledgement.legacyProfileProjectionExpected !== 'boolean' ||
    !isNullablePersonaProfileDigestValue(acknowledgement.attemptedLegacyProfile)
  ) {
    return undefined
  }

  const beforePersonaIds = [...acknowledgement.beforePersonaIds]
  const attemptedPersonaIds = [...acknowledgement.attemptedPersonaIds]
  const beforeSelectedPersonaId = acknowledgement.beforeSelectedPersonaId
  let expectedSelectedPersonaId: string | null
  let expectedCollectionWritten: boolean
  let expectedLegacyProfileProjection: boolean

  switch (input.operation) {
    case 'create': {
      if (
        !nonEmptyString(input.targetPersonaId) ||
        input.createdPersona.id !== input.targetPersonaId ||
        beforePersonaIds.includes(input.targetPersonaId) ||
        !isJsonValueEqual(attemptedPersonaIds, [...beforePersonaIds, input.targetPersonaId])
      ) {
        return undefined
      }
      expectedSelectedPersonaId = input.targetPersonaId
      expectedCollectionWritten = true
      expectedLegacyProfileProjection = input.mirrorLegacyProfile
      if (
        expectedLegacyProfileProjection &&
        !isJsonValueEqual(
          acknowledgement.attemptedLegacyProfile,
          personaProfileDigestValueFromPersona(input.createdPersona),
        )
      ) {
        return undefined
      }
      break
    }
    case 'delete': {
      if (
        !nonEmptyString(input.targetPersonaId) ||
        !beforePersonaIds.includes(input.targetPersonaId) ||
        !isJsonValueEqual(
          attemptedPersonaIds,
          beforePersonaIds.filter((personaId) => personaId !== input.targetPersonaId),
        ) ||
        attemptedPersonaIds.length === 0
      ) {
        return undefined
      }
      if (input.requestedSelectedPersonaId !== undefined) {
        if (
          !nonEmptyString(input.requestedSelectedPersonaId) ||
          !attemptedPersonaIds.includes(input.requestedSelectedPersonaId)
        ) {
          return undefined
        }
        expectedSelectedPersonaId = input.requestedSelectedPersonaId
      } else if (beforeSelectedPersonaId === input.targetPersonaId) {
        expectedSelectedPersonaId = attemptedPersonaIds[0] ?? null
      } else {
        expectedSelectedPersonaId = beforeSelectedPersonaId ?? attemptedPersonaIds[0] ?? null
      }
      expectedCollectionWritten = true
      expectedLegacyProfileProjection = input.mirrorLegacyProfile && expectedSelectedPersonaId !== null
      break
    }
    case 'select': {
      if (
        !nonEmptyString(input.targetPersonaId) ||
        !attemptedPersonaIds.includes(input.targetPersonaId) ||
        !isJsonValueEqual(attemptedPersonaIds, beforePersonaIds)
      ) {
        return undefined
      }
      expectedSelectedPersonaId = input.targetPersonaId
      expectedCollectionWritten = input.saveCurrent
      expectedLegacyProfileProjection = input.mirrorLegacyProfile
      break
    }
    case 'reorder': {
      if (
        !isJsonValueEqual(attemptedPersonaIds, input.requestedPersonaIds) ||
        !isUniqueStringArray(input.requestedPersonaIds) ||
        !isJsonValueEqual([...attemptedPersonaIds].sort(), [...beforePersonaIds].sort())
      ) {
        return undefined
      }
      expectedSelectedPersonaId = beforeSelectedPersonaId ?? attemptedPersonaIds[0] ?? null
      expectedCollectionWritten = true
      expectedLegacyProfileProjection = false
      break
    }
  }

  const expectedSettingsWritten = true
  const expectedLegacyProfile = expectedLegacyProfileProjection
  if (
    acknowledgement.attemptedSelectedPersonaId !== expectedSelectedPersonaId ||
    acknowledgement.collectionWritten !== expectedCollectionWritten ||
    acknowledgement.settingsWritten !== expectedSettingsWritten ||
    acknowledgement.legacyProfileProjectionExpected !== expectedLegacyProfileProjection ||
    expectedLegacyProfile !== (acknowledgement.attemptedLegacyProfile !== null)
  ) {
    return undefined
  }

  const stableAcknowledgement: PersonaMutationOptimisticAcknowledgement = {
    ...acknowledgement,
    beforePersonaIds,
    attemptedPersonaIds,
    attemptedPersonas: cloneJsonValue(acknowledgement.attemptedPersonas),
    attemptedLegacyProfile: acknowledgement.attemptedLegacyProfile
      ? { ...acknowledgement.attemptedLegacyProfile }
      : null,
  }
  const [personaProjectionDigest, legacyProfileDigest] = await Promise.all([
    sha256HexUtf8(
      stableAcknowledgement.collectionWritten
        ? serializePersonaCollectionDigestInput(stableAcknowledgement.attemptedPersonas)
        : serializePersonaIdsDigestInput(stableAcknowledgement.attemptedPersonaIds),
    ),
    stableAcknowledgement.attemptedLegacyProfile
      ? sha256HexUtf8(serializePersonaProfileDigestInput(stableAcknowledgement.attemptedLegacyProfile))
      : Promise.resolve(null),
  ])

  return {
    acknowledgement: stableAcknowledgement,
    targetPersonaId: input.targetPersonaId,
    personaProjectionDigest,
    legacyProfileDigest,
  }
}

function readPersonaMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  prepared: PreparedPersonaMutationAcknowledgement,
): PersonaMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const acknowledgement = prepared.acknowledgement
  const expectedEventType: Record<PersonaMutationOperation, string> = {
    create: 'persona.created',
    delete: 'persona.deleted',
    select: 'persona.selected',
    reorder: 'persona.reordered',
  }
  const targetExpected = acknowledgement.operation !== 'reorder'
  if (
    record.revision !== event.revision ||
    record.personaMutationCertificate !== 'persona-mutation-v1' ||
    record.operation !== acknowledgement.operation ||
    record.personaProjectionDigest !== prepared.personaProjectionDigest ||
    record.selectedPersonaId !== acknowledgement.attemptedSelectedPersonaId ||
    record.collectionWritten !== acknowledgement.collectionWritten ||
    record.settingsWritten !== acknowledgement.settingsWritten ||
    record.legacyProfileProjectionApplied !== acknowledgement.legacyProfileProjectionExpected ||
    record.legacyProfileDigest !== prepared.legacyProfileDigest ||
    event.type !== expectedEventType[acknowledgement.operation] ||
    event.resource !== 'persona' ||
    event.parentId !== undefined ||
    (targetExpected
      ? record.personaId !== prepared.targetPersonaId || event.id !== prepared.targetPersonaId
      : record.personaId !== undefined || event.id !== undefined)
  ) {
    return undefined
  }

  return {
    kind: 'personaMutation',
    operation: acknowledgement.operation,
    targetPersonaId: prepared.targetPersonaId,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    settingsProjectionEpoch: acknowledgement.settingsProjectionEpoch,
    collectionWritten: acknowledgement.collectionWritten,
    settingsWritten: acknowledgement.settingsWritten,
  }
}

function isNullablePersonaId(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
}

function selectedPersonaIdBelongsToList(personaIds: readonly string[], selectedPersonaId: string | null): boolean {
  return selectedPersonaId === null || personaIds.includes(selectedPersonaId)
}

function isNullablePersonaProfileDigestValue(value: unknown): value is PersonaProfileDigestValue | null {
  if (value === null) return true
  if (!isPlainJsonRecord(value)) return false
  return (
    isJsonValueEqual(Object.keys(value).sort(), [...PERSONA_PROFILE_DIGEST_KEYS].sort()) &&
    PERSONA_PROFILE_DIGEST_KEYS.every((key) => typeof value[key] === 'string')
  )
}

function personaProfileDigestValueFromPersona(persona: PersonaSnapshot): PersonaProfileDigestValue {
  return {
    name: typeof persona.name === 'string' ? persona.name : '',
    icon: typeof persona.icon === 'string' ? persona.icon : '',
    personaPrompt: typeof persona.personaPrompt === 'string' ? persona.personaPrompt : '',
    note: typeof persona.note === 'string' ? persona.note : '',
  }
}

function readPersonaPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    personaId: string
    attemptedPatch: PersonaSnapshot
    mirrorLegacyProfile: boolean
    acknowledgement?: PersonaPatchOptimisticAcknowledgement
  },
): PersonaPatchLocalEffect | undefined {
  const acknowledgement = input.acknowledgement
  if (!acknowledgement || !body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    record.personaId !== input.personaId ||
    event.type !== 'persona.updated' ||
    event.resource !== 'persona' ||
    event.id !== input.personaId ||
    event.parentId !== undefined ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.settingsProjectionEpoch) ||
    typeof acknowledgement.legacyProfileProjectionExpected !== 'boolean' ||
    (!input.mirrorLegacyProfile && acknowledgement.legacyProfileProjectionExpected) ||
    typeof record.legacyProfileProjectionApplied !== 'boolean' ||
    record.legacyProfileProjectionApplied !== acknowledgement.legacyProfileProjectionExpected
  ) {
    return undefined
  }

  const acknowledgedKeys = record.acknowledgedKeys
  const attemptedKeys = Object.keys(input.attemptedPatch).sort()
  if (
    !isUniqueStringArray(acknowledgedKeys) ||
    attemptedKeys.length === 0 ||
    !isJsonValueEqual(attemptedKeys, [...acknowledgedKeys].sort()) ||
    attemptedKeys.some((key) => !isJsonValue(input.attemptedPatch[key]))
  ) {
    return undefined
  }

  const attemptedPersona = acknowledgement.attemptedPersona
  if (
    !isPlainJsonRecord(attemptedPersona) ||
    !isJsonValue(attemptedPersona) ||
    attemptedPersona.id !== input.personaId ||
    attemptedKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(attemptedPersona, key) ||
        !isJsonValueEqual(attemptedPersona[key], input.attemptedPatch[key]),
    )
  ) {
    return undefined
  }

  const attemptedLegacyProfile = acknowledgement.attemptedLegacyProfile
  const legacyKeys: Array<keyof PersonaLegacyProfileProjection> = ['username', 'userIcon', 'personaPrompt', 'userNote']
  if (
    !isPlainJsonRecord(attemptedLegacyProfile) ||
    !isJsonValueEqual(Object.keys(attemptedLegacyProfile).sort(), [...legacyKeys].sort()) ||
    legacyKeys.some((key) => typeof attemptedLegacyProfile[key] !== 'string')
  ) {
    return undefined
  }

  if (acknowledgement.legacyProfileProjectionExpected) {
    const expectedLegacyProfile: PersonaLegacyProfileProjection = {
      username: typeof attemptedPersona.name === 'string' ? attemptedPersona.name : '',
      userIcon: typeof attemptedPersona.icon === 'string' ? attemptedPersona.icon : '',
      personaPrompt: typeof attemptedPersona.personaPrompt === 'string' ? attemptedPersona.personaPrompt : '',
      userNote: typeof attemptedPersona.note === 'string' ? attemptedPersona.note : '',
    }
    if (legacyKeys.some((key) => attemptedLegacyProfile[key] !== expectedLegacyProfile[key])) return undefined
  }

  return {
    kind: 'personaPatch',
    personaId: input.personaId,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    settingsProjectionEpoch: acknowledgement.settingsProjectionEpoch,
    attemptedPatch: cloneJsonValue(input.attemptedPatch),
    attemptedPersona: cloneJsonValue(attemptedPersona as PersonaSnapshot & { id: string }),
    attemptedLegacyProfile: cloneJsonValue(attemptedLegacyProfile as PersonaLegacyProfileProjection),
    legacyProfileProjectionApplied: record.legacyProfileProjectionApplied,
  }
}

function readTranslatorPresetPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    presetId: string
    attemptedPatch: TranslatorPresetSnapshot
    acknowledgement: TranslatorPresetPatchOptimisticAcknowledgement
  },
): TranslatorPresetPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const acknowledgement = input.acknowledgement
  if (
    record.revision !== event.revision ||
    record.presetId !== input.presetId ||
    event.type !== 'translatorPreset.updated' ||
    event.resource !== 'translatorPreset' ||
    event.id !== input.presetId ||
    event.parentId !== undefined ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.languageSettingsProjectionEpoch) ||
    !nonEmptyString(acknowledgement.selectedPresetId) ||
    record.selectedPresetId !== acknowledgement.selectedPresetId
  ) {
    return undefined
  }

  const acknowledgedKeys = record.acknowledgedKeys
  const attemptedKeys = Object.keys(input.attemptedPatch).sort()
  const allowedKeys = new Set(['name', 'prompt', 'maxResponse', 'steps'])
  if (
    !isUniqueStringArray(acknowledgedKeys) ||
    attemptedKeys.length === 0 ||
    attemptedKeys.some((key) => !allowedKeys.has(key) || !isJsonValue(input.attemptedPatch[key]))
  ) {
    return undefined
  }

  const attemptedPreset = acknowledgement.attemptedPreset
  if (
    !isCanonicalTranslatorPreset(attemptedPreset) ||
    attemptedPreset.id !== input.presetId ||
    attemptedKeys.some((key) => !isJsonValueEqual(attemptedPreset[key], input.attemptedPatch[key]))
  ) {
    return undefined
  }

  const attemptedKeySet = new Set(attemptedKeys)
  const acknowledgedKeySet = new Set(acknowledgedKeys)
  const extraAcknowledgedKeys = acknowledgedKeys.filter((key) => !attemptedKeySet.has(key))
  const firstAttemptedStep = attemptedPreset.steps?.[0]
  // The server canonicalizes a steps patch by adding its first-step legacy
  // mirrors before issuing the key certificate. No other certificate expansion
  // is implied by the attempted patch.
  const hasOnlyImpliedStepMirrorKeys =
    extraAcknowledgedKeys.length === 0 ||
    (attemptedKeySet.has('steps') &&
      firstAttemptedStep !== undefined &&
      extraAcknowledgedKeys.every((key) => {
        if (key === 'prompt') return attemptedPreset.prompt === firstAttemptedStep.prompt
        if (key === 'maxResponse') return attemptedPreset.maxResponse === firstAttemptedStep.maxResponse
        return false
      }))
  if (attemptedKeys.some((key) => !acknowledgedKeySet.has(key)) || !hasOnlyImpliedStepMirrorKeys) {
    return undefined
  }

  return {
    kind: 'translatorPresetPatch',
    presetId: input.presetId,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    languageSettingsProjectionEpoch: acknowledgement.languageSettingsProjectionEpoch,
    selectedPresetId: acknowledgement.selectedPresetId,
    attemptedPatch: cloneJsonValue(input.attemptedPatch),
    attemptedPreset: cloneJsonValue(attemptedPreset),
  }
}

function readAgentPresetCollectionMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  input:
    | {
        operation: 'reorder'
        expectedPresetIds: string[]
        acknowledgement: AgentPresetCollectionOptimisticAcknowledgement
      }
    | {
        operation: 'default'
        expectedDefaultId: string | null
        acknowledgement: AgentPresetCollectionOptimisticAcknowledgement
      },
): AgentPresetCollectionMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const acknowledgement = input.acknowledgement
  const expectedType = input.operation === 'reorder' ? 'agentPreset.reordered' : 'agentPreset.default.updated'
  if (
    record.revision !== event.revision ||
    record.certificate !== AGENT_PRESET_COLLECTION_ACKNOWLEDGEMENT_CERTIFICATE ||
    event.type !== expectedType ||
    event.resource !== 'agentPreset' ||
    event.parentId !== undefined ||
    !isProjectionEpoch(acknowledgement.settingsProjectionEpoch) ||
    !isUniqueStringArray(acknowledgement.presetIds) ||
    !isUniqueStringArray(record.agentPresetIds) ||
    !isJsonValueEqual(record.agentPresetIds, acknowledgement.presetIds)
  ) {
    return undefined
  }

  const expectedDefaultId = acknowledgement.agentPresetDefaultId
  if (
    (expectedDefaultId !== null && !nonEmptyString(expectedDefaultId)) ||
    (expectedDefaultId !== null && !acknowledgement.presetIds.includes(expectedDefaultId)) ||
    record.agentPresetDefaultId !== expectedDefaultId ||
    event.id !== (input.operation === 'default' ? (expectedDefaultId ?? undefined) : undefined)
  ) {
    return undefined
  }
  if (
    (input.operation === 'reorder' && !isJsonValueEqual(input.expectedPresetIds, acknowledgement.presetIds)) ||
    (input.operation === 'default' && input.expectedDefaultId !== expectedDefaultId)
  ) {
    return undefined
  }

  return {
    kind: 'agentPresetCollectionMutation',
    operation: input.operation,
    settingsProjectionEpoch: acknowledgement.settingsProjectionEpoch,
    presetIds: [...acknowledgement.presetIds],
    agentPresetDefaultId: expectedDefaultId,
  }
}

function readAgentPresetPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    presetId: string
    attemptedPatch: Record<string, unknown>
    acknowledgement: AgentPresetPatchOptimisticAcknowledgement
  } & ({ kind: 'preset' } | { kind: 'step'; stepId: string }),
): AgentPresetPatchLocalEffect | AgentPresetStepPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const expectedType = input.kind === 'preset' ? 'agentPreset.updated' : 'agentPreset.step.updated'
  const expectedId = input.kind === 'preset' ? input.presetId : input.stepId
  const expectedParentId = input.kind === 'preset' ? undefined : input.presetId
  if (
    record.revision !== event.revision ||
    record.presetId !== input.presetId ||
    (input.kind === 'step' && record.stepId !== input.stepId) ||
    event.type !== expectedType ||
    event.resource !== 'agentPreset' ||
    event.id !== expectedId ||
    event.parentId !== expectedParentId ||
    !isProjectionEpoch(input.acknowledgement.settingsProjectionEpoch) ||
    !isPlainJsonRecord(input.acknowledgement.attemptedFields)
  ) {
    return undefined
  }

  const allowedKeys =
    input.kind === 'preset'
      ? new Set(['name', 'description', 'moduleIntergration', 'finalOutputTemplate', 'enabled', 'maxConcurrency'])
      : new Set([
          'name',
          'enabled',
          'phase',
          'dependencies',
          'instruction',
          'model',
          'runtime',
          'inputScopes',
          'outputKey',
          'outputFormat',
          'destination',
          'failurePolicy',
        ])
  const attemptedKeys = Object.keys(input.attemptedPatch).sort()
  if (
    attemptedKeys.length === 0 ||
    attemptedKeys.some((key) => !allowedKeys.has(key) || !isJsonValue(input.attemptedPatch[key])) ||
    !isJsonValueEqual(Object.keys(input.acknowledgement.attemptedFields).sort(), attemptedKeys)
  ) {
    return undefined
  }

  const attemptedFields: Record<string, JsonFieldState> = {}
  for (const key of attemptedKeys) {
    const state = readJsonFieldState(input.acknowledgement.attemptedFields[key])
    if (!state?.present || !isJsonValueEqual(state.value, input.attemptedPatch[key])) return undefined
    attemptedFields[key] = state
  }

  const acknowledgedKeys = record.acknowledgedKeys
  const canonicalValues = record.canonicalValues
  const canonicalDeletedKeys = record.canonicalDeletedKeys
  const updatedAt = record.updatedAt
  if (
    !isUniqueStringArray(acknowledgedKeys) ||
    !isJsonValueEqual([...acknowledgedKeys].sort(), attemptedKeys) ||
    !isPlainJsonRecord(canonicalValues) ||
    !isUniqueStringArray(canonicalDeletedKeys) ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined
  }

  const canonicalValueKeys = Object.keys(canonicalValues)
  const canonicalDeletedKeySet = new Set(canonicalDeletedKeys)
  const canonicalKeys = [...canonicalValueKeys, ...canonicalDeletedKeys].sort()
  if (
    !isJsonValueEqual(canonicalKeys, attemptedKeys) ||
    canonicalValueKeys.some(
      (key) => !allowedKeys.has(key) || canonicalDeletedKeySet.has(key) || !isJsonValue(canonicalValues[key]),
    ) ||
    canonicalDeletedKeys.some(
      (key) =>
        !allowedKeys.has(key) ||
        (input.kind === 'preset' &&
          key !== 'description' &&
          key !== 'moduleIntergration' &&
          key !== 'finalOutputTemplate' &&
          key !== 'maxConcurrency'),
    ) ||
    (input.kind === 'step' && canonicalDeletedKeys.length > 0)
  ) {
    return undefined
  }
  if (!isCanonicalAgentPresetPatchReceipt(input.kind, canonicalValues)) return undefined

  const fields: AgentPresetPatchLocalEffect['fields'] = {}
  for (const key of canonicalValueKeys) {
    fields[key] = {
      attempted: cloneJsonValue(attemptedFields[key]),
      canonical: { present: true, value: cloneJsonValue(canonicalValues[key]) },
    }
  }
  for (const key of canonicalDeletedKeys) {
    fields[key] = {
      attempted: cloneJsonValue(attemptedFields[key]),
      canonical: { present: false },
    }
  }

  const common = {
    presetId: input.presetId,
    settingsProjectionEpoch: input.acknowledgement.settingsProjectionEpoch,
    fields,
    updatedAt,
  }
  return input.kind === 'preset'
    ? { kind: 'agentPresetPatch', ...common }
    : { kind: 'agentPresetStepPatch', stepId: input.stepId, ...common }
}

function isCanonicalAgentPresetPatchReceipt(
  kind: 'preset' | 'step',
  canonicalValues: Record<string, unknown>,
): boolean {
  if (kind === 'preset') {
    const candidate = {
      id: '__receipt_preset__',
      name: 'Receipt Preset',
      enabled: true,
      version: AGENT_PRESET_SCHEMA_VERSION,
      steps: [],
      ...cloneJsonValue(canonicalValues),
    }
    const normalized = normalizeAgentPresets([candidate])[0]
    return (
      !!normalized &&
      validateAgentPresetRecord(normalized).length === 0 &&
      canonicalFieldsMatchNormalizedRecord(canonicalValues, normalized as unknown as Record<string, unknown>)
    )
  }

  const canonicalPhase = canonicalValues.phase
  const phase =
    canonicalPhase === 'afterMain' ||
    (!Object.hasOwn(canonicalValues, 'phase') && canonicalValues.destination === 'finalOutput')
      ? 'afterMain'
      : 'beforeMain'
  const step = {
    id: '__receipt_step__',
    name: 'Receipt Step',
    enabled: true,
    phase,
    dependencies: [],
    instruction: '',
    model: { mode: 'inheritMain' },
    runtime: {},
    inputScopes: [],
    outputKey: 'receipt_step',
    outputFormat: 'text',
    destination: phase === 'afterMain' ? 'intermediate' : 'promptOutput',
    failurePolicy: { mode: 'required' },
    ...cloneJsonValue(canonicalValues),
  }
  const normalized = normalizeAgentPresets([
    {
      id: '__receipt_preset__',
      name: 'Receipt Preset',
      enabled: true,
      version: AGENT_PRESET_SCHEMA_VERSION,
      steps: [step],
    },
  ])[0]?.steps[0]
  return (
    !!normalized &&
    validateAgentPresetStepRecord(normalized).length === 0 &&
    canonicalFieldsMatchNormalizedRecord(canonicalValues, normalized as unknown as Record<string, unknown>)
  )
}

function canonicalFieldsMatchNormalizedRecord(
  canonicalValues: Record<string, unknown>,
  normalized: Record<string, unknown>,
): boolean {
  return Object.entries(canonicalValues).every(
    ([key, value]) => Object.hasOwn(normalized, key) && isJsonValueEqual(normalized[key], value),
  )
}

function isCanonicalTranslatorPreset(value: unknown): value is TranslatorPresetSnapshot & { id: string } {
  if (!isPlainJsonRecord(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    (!isJsonValueEqual(keys, ['id', 'maxResponse', 'name', 'prompt']) &&
      !isJsonValueEqual(keys, ['id', 'maxResponse', 'name', 'prompt', 'steps'])) ||
    !nonEmptyString(record.id) ||
    typeof record.name !== 'string' ||
    typeof record.prompt !== 'string' ||
    typeof record.maxResponse !== 'number' ||
    !Number.isFinite(record.maxResponse)
  ) {
    return false
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'steps')) return true
  if (!Array.isArray(record.steps) || record.steps.length === 0 || record.steps.length > 5) return false
  const stepIds = new Set<string>()
  const outputKeys = new Set<string>()
  for (const value of record.steps) {
    if (!isPlainJsonRecord(value)) return false
    const step = value as Record<string, unknown>
    const expectedKeys =
      step.outputKey === undefined
        ? ['enabled', 'id', 'maxResponse', 'model', 'name', 'prompt']
        : ['enabled', 'id', 'maxResponse', 'model', 'name', 'outputKey', 'prompt']
    if (
      !isJsonValueEqual(Object.keys(step).sort(), expectedKeys) ||
      !nonEmptyString(step.id) ||
      stepIds.has(step.id) ||
      !nonEmptyString(step.name) ||
      typeof step.enabled !== 'boolean' ||
      typeof step.prompt !== 'string' ||
      typeof step.maxResponse !== 'number' ||
      !Number.isFinite(step.maxResponse) ||
      !isPlainJsonRecord(step.model)
    ) {
      return false
    }
    stepIds.add(step.id)
    const model = step.model as Record<string, unknown>
    if (
      (model.mode === 'inheritTranslate' && !isJsonValueEqual(Object.keys(model), ['mode'])) ||
      (model.mode === 'modelProfile' &&
        (!isJsonValueEqual(Object.keys(model).sort(), ['mode', 'profileId']) || !nonEmptyString(model.profileId))) ||
      (model.mode !== 'inheritTranslate' && model.mode !== 'modelProfile')
    ) {
      return false
    }
    if (step.outputKey !== undefined) {
      if (
        typeof step.outputKey !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(step.outputKey) ||
        outputKeys.has(step.outputKey)
      ) {
        return false
      }
      outputKeys.add(step.outputKey)
    }
  }
  const firstStep = record.steps[0] as Record<string, unknown>
  return record.prompt === firstStep.prompt && record.maxResponse === firstStep.maxResponse
}

function readSplitPresetPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: {
    presetKind: 'model' | 'prompt'
    presetId: string
    attemptedPatch: Record<string, unknown>
    acknowledgement?: SplitPresetPatchOptimisticAcknowledgement
  },
): SplitPresetPatchLocalEffect | undefined {
  const acknowledgement = input.acknowledgement
  if (!acknowledgement || !body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const expectedType = input.presetKind === 'model' ? 'modelPreset.updated' : 'promptPreset.updated'
  const expectedResource = input.presetKind === 'model' ? 'modelPreset' : 'promptPreset'
  if (
    record.revision !== event.revision ||
    event.type !== expectedType ||
    event.resource !== expectedResource ||
    event.id !== input.presetId ||
    event.parentId !== undefined ||
    record[`${input.presetKind}PresetId`] !== input.presetId ||
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.settingsProjectionEpoch)
  ) {
    return undefined
  }

  const acknowledgedKeys = record.acknowledgedKeys
  const presetOverrides = record.preset
  const settingsOverrides = record.settings
  if (
    !isUniqueStringArray(acknowledgedKeys) ||
    !presetOverrides ||
    typeof presetOverrides !== 'object' ||
    Array.isArray(presetOverrides) ||
    !settingsOverrides ||
    typeof settingsOverrides !== 'object' ||
    Array.isArray(settingsOverrides) ||
    typeof record.selectedProjectionApplied !== 'boolean' ||
    typeof record.ownerProjectionApplied !== 'boolean'
  ) {
    return undefined
  }

  const attemptedKeys = Object.keys(input.attemptedPatch).sort()
  if (
    attemptedKeys.length === 0 ||
    !isJsonValueEqual(attemptedKeys, [...acknowledgedKeys].sort()) ||
    attemptedKeys.some((key) => !isJsonValue(input.attemptedPatch[key])) ||
    Object.values(acknowledgement.attemptedSettings).some((value) => !isJsonValue(value)) ||
    record.selectedProjectionApplied !== acknowledgement.selectedProjectionExpected ||
    record.ownerProjectionApplied !== (acknowledgement.ownerProjectionExpected ?? false)
  ) {
    return undefined
  }

  const acknowledgedKeySet = new Set(acknowledgedKeys)
  const attemptedSettingsKeySet = new Set(Object.keys(acknowledgement.attemptedSettings))
  const preset = cloneJsonValue(input.attemptedPatch)
  for (const [key, value] of Object.entries(presetOverrides as Record<string, unknown>)) {
    if (!acknowledgedKeySet.has(key) || !isJsonValue(value)) return undefined
    preset[key] = cloneJsonValue(value)
  }
  const settings = cloneJsonValue(acknowledgement.attemptedSettings)
  for (const [key, value] of Object.entries(settingsOverrides as Record<string, unknown>)) {
    if (!attemptedSettingsKeySet.has(key) || !isJsonValue(value)) return undefined
    settings[key] = cloneJsonValue(value)
  }

  if (input.presetKind === 'model') {
    const selectedPromptPresetId = record.selectedPromptPresetId
    const expectedPromptPresetId = acknowledgement.selectedProjectionExpected
      ? (acknowledgement.selectedPromptPresetId ?? null)
      : null
    if (selectedPromptPresetId !== expectedPromptPresetId || record.ownerProjectionApplied !== false) return undefined
  } else if (record.selectedPromptPresetId !== undefined) {
    return undefined
  }

  const ownerExpected = acknowledgement.ownerProjectionExpected === true
  if (
    ownerExpected &&
    (!isProjectionEpoch(acknowledgement.promptOwnerProjectionEpoch) ||
      !isProjectionEpoch(acknowledgement.promptOwnerRevision))
  ) {
    return undefined
  }

  return {
    kind: 'splitPresetPatch',
    presetKind: input.presetKind,
    presetId: input.presetId,
    attemptedPatch: cloneJsonValue(input.attemptedPatch),
    preset,
    attemptedSettings: cloneJsonValue(acknowledgement.attemptedSettings),
    settings,
    selectedProjectionApplied: record.selectedProjectionApplied,
    ownerProjectionApplied: record.ownerProjectionApplied,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    settingsProjectionEpoch: acknowledgement.settingsProjectionEpoch,
    selectedPresetId: acknowledgement.selectedPresetId,
    ...(input.presetKind === 'model' ? { selectedPromptPresetId: acknowledgement.selectedPromptPresetId ?? null } : {}),
    ...(ownerExpected
      ? {
          promptOwnerProjectionEpoch: acknowledgement.promptOwnerProjectionEpoch,
          promptOwnerRevision: acknowledgement.promptOwnerRevision,
        }
      : {}),
  }
}

interface ReadPromptItemMutationLocalEffectOptions {
  operation: PromptItemMutationOperation
  promptPresetId?: unknown
  itemId?: unknown
  itemIds?: unknown
  promptItem?: unknown
  patch?: unknown
  deleteKeys?: unknown
  enabled?: unknown
  acknowledgement?: PromptItemOptimisticAcknowledgement
}

function readPromptItemMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadPromptItemMutationLocalEffectOptions,
): PromptItemMutationLocalEffect | undefined {
  const acknowledgement = options.acknowledgement
  if (!acknowledgement || !body || typeof body !== 'object' || Array.isArray(body)) return undefined
  let promptPresetId: string | null = null
  if (options.promptPresetId !== undefined) {
    if (!nonEmptyString(options.promptPresetId)) return undefined
    promptPresetId = options.promptPresetId
  }
  if (
    !isProjectionEpoch(acknowledgement.collectionProjectionEpoch) ||
    !isProjectionEpoch(acknowledgement.ownerProjectionEpoch) ||
    !isCanonicalPromptTemplateOwnerState(acknowledgement.ownerState)
  ) {
    return undefined
  }

  const expectedType = {
    create: 'prompt.item.created',
    update: 'prompt.item.updated',
    delete: 'prompt.item.deleted',
    reorder: 'prompt.item.reordered',
    enable: 'prompt.item.enabled',
  }[options.operation]
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    event.type !== expectedType ||
    event.resource !== 'promptItem' ||
    event.parentId !== (promptPresetId ?? undefined)
  ) {
    return undefined
  }

  const ownerItems = acknowledgement.ownerState.enabled ? acknowledgement.ownerState.items : null
  const baseEffect = {
    kind: 'promptItemMutation' as const,
    operation: options.operation,
    promptPresetId,
    collectionProjectionEpoch: acknowledgement.collectionProjectionEpoch,
    ownerProjectionEpoch: acknowledgement.ownerProjectionEpoch,
    ownerState: cloneJsonValue(acknowledgement.ownerState),
  }

  if (options.operation === 'create') {
    if (
      !nonEmptyString(options.itemId) ||
      !isCanonicalPromptItem(options.promptItem) ||
      options.promptItem.id !== options.itemId ||
      record.itemId !== options.itemId ||
      event.id !== options.itemId ||
      !ownerItems
    ) {
      return undefined
    }
    const finalItem = ownerItems.find((item) => item.id === options.itemId)
    if (!finalItem || !isJsonValueEqual(finalItem, options.promptItem)) return undefined
    return { ...baseEffect, itemId: options.itemId }
  }

  if (options.operation === 'update') {
    if (
      !nonEmptyString(options.itemId) ||
      !isCanonicalPromptItemPatch(options.patch, options.deleteKeys) ||
      record.itemId !== options.itemId ||
      event.id !== options.itemId ||
      !ownerItems
    ) {
      return undefined
    }
    const finalItem = ownerItems.find((item) => item.id === options.itemId)
    if (!finalItem || !promptItemMatchesSparseUpdate(finalItem, options.patch, options.deleteKeys)) return undefined
    return { ...baseEffect, itemId: options.itemId }
  }

  if (options.operation === 'delete') {
    if (
      !nonEmptyString(options.itemId) ||
      record.itemId !== options.itemId ||
      event.id !== options.itemId ||
      !ownerItems ||
      ownerItems.some((item) => item.id === options.itemId)
    ) {
      return undefined
    }
    return { ...baseEffect, itemId: options.itemId }
  }

  if (options.operation === 'reorder') {
    if (
      event.id !== undefined ||
      !isUniqueStringArray(options.itemIds) ||
      !ownerItems ||
      !isJsonValueEqual(
        ownerItems.map((item) => item.id),
        options.itemIds,
      )
    ) {
      return undefined
    }
    return { ...baseEffect, itemIds: [...options.itemIds] }
  }

  if (
    event.id !== undefined ||
    typeof options.enabled !== 'boolean' ||
    typeof record.enabled !== 'boolean' ||
    record.enabled !== options.enabled ||
    acknowledgement.ownerState.enabled !== options.enabled
  ) {
    return undefined
  }
  return { ...baseEffect, enabled: options.enabled }
}

function isCanonicalPromptTemplateOwnerState(value: unknown): value is PromptTemplateOwnerStateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.enabled === false) {
    return Object.keys(record).length === 1
  }
  return record.enabled === true && Object.keys(record).length === 2 && isCanonicalPromptItemArray(record.items)
}

function isCanonicalPromptItemArray(value: unknown): value is PromptItemSnapshot[] {
  if (!Array.isArray(value)) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (!isCanonicalPromptItem(item) || seen.has(item.id)) return false
    seen.add(item.id)
  }
  return true
}

function isCanonicalPromptItem(value: unknown): value is PromptItemSnapshot & { id: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isJsonValue(value) &&
    nonEmptyString((value as PromptItemSnapshot).id)
  )
}

function isCanonicalPromptItemPatch(patch: unknown, deleteKeys: unknown): patch is PromptItemSnapshot {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !isJsonValue(patch)) return false
  const patchKeys = Object.keys(patch)
  const normalizedDeleteKeys = deleteKeys === undefined ? [] : deleteKeys
  if (
    !isUniqueStringArray(normalizedDeleteKeys) ||
    patchKeys.some((key) => key.trim() === '' || key === 'id') ||
    normalizedDeleteKeys.some((key) => key === 'id' || Object.prototype.hasOwnProperty.call(patch, key))
  ) {
    return false
  }
  return patchKeys.length > 0 || normalizedDeleteKeys.length > 0
}

function promptItemMatchesSparseUpdate(finalItem: PromptItemSnapshot, patch: unknown, deleteKeys: unknown): boolean {
  const patchRecord = patch as Record<string, unknown>
  for (const [key, value] of Object.entries(patchRecord)) {
    if (!isJsonValueEqual(finalItem[key], value)) return false
  }
  for (const key of (deleteKeys === undefined ? [] : deleteKeys) as string[]) {
    if (Object.prototype.hasOwnProperty.call(finalItem, key)) return false
  }
  return true
}

function readPluginStorageLocalEffect(
  body: unknown,
  event: CommandEvent,
  operation: PluginStorageLocalEffect['operation'],
  expectedKey?: string,
): PluginStorageLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (event.resource !== 'pluginStorage') return undefined

  const expectedType =
    operation === 'put'
      ? 'pluginStorage.updated'
      : operation === 'delete'
        ? 'pluginStorage.deleted'
        : 'pluginStorage.bulkUpdated'
  if (event.type !== expectedType) return undefined

  if (operation === 'bulk') {
    if (event.id !== undefined) return undefined
    return { kind: 'pluginStorage', operation }
  }

  const key = (body as Record<string, unknown>).key
  if (key !== expectedKey || event.id !== expectedKey) return undefined
  return { kind: 'pluginStorage', operation, key: expectedKey }
}

interface ReadPluginCollectionMutationLocalEffectOptions {
  operation: PluginCollectionMutationLocalEffect['operation']
  expectedPluginId?: unknown
  expectedPluginIds?: unknown
  expectedEnabled?: boolean
  hasMutation?: boolean
}

function readPluginCollectionMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadPluginCollectionMutationLocalEffectOptions,
): PluginCollectionMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (event.resource !== 'pluginCollection') return undefined

  const expectedType =
    options.operation === 'create'
      ? 'plugin.created'
      : options.operation === 'update'
        ? 'plugin.updated'
        : options.operation === 'delete'
          ? 'plugin.deleted'
          : options.operation === 'enable'
            ? 'plugin.enabled'
            : 'plugin.reordered'
  if (event.type !== expectedType) return undefined

  if (options.operation === 'reorder') {
    if (event.id !== undefined || !isUniqueStringArray(options.expectedPluginIds)) return undefined
    return {
      kind: 'pluginCollectionMutation',
      operation: options.operation,
      pluginIds: [...options.expectedPluginIds],
    }
  }

  if (!nonEmptyString(options.expectedPluginId)) return undefined
  const record = body as Record<string, unknown>
  if (record.pluginId !== options.expectedPluginId || event.id !== options.expectedPluginId) return undefined
  if (options.operation === 'update' && options.hasMutation !== true) return undefined
  if (options.operation === 'enable' && record.enabled !== options.expectedEnabled) return undefined
  return {
    kind: 'pluginCollectionMutation',
    operation: options.operation,
    pluginId: options.expectedPluginId,
  }
}

function readPluginProviderLocalEffect(
  body: unknown,
  event: CommandEvent,
  expectedProvider: string,
): PluginProviderLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (!nonEmptyString(expectedProvider) && expectedProvider !== '') return undefined
  if (
    event.type !== 'plugin.provider.selected' ||
    event.resource !== 'pluginProvider' ||
    event.id !== expectedProvider ||
    (body as Record<string, unknown>).provider !== expectedProvider
  ) {
    return undefined
  }
  return { kind: 'pluginProvider', provider: expectedProvider }
}

interface ReadGlobalLorebookMutationLocalEffectOptions {
  operation: GlobalLorebookMutationLocalEffect['operation']
  expectedLorebook?: unknown
  expectedLorebookId?: unknown
  expectedLorebookIds?: unknown
  expectedPatch?: unknown
  expectedSelectedLorebookId?: unknown
  collectionProjectionEpoch?: unknown
  pageProjectionEpoch?: unknown
}

function readGlobalLorebookMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadGlobalLorebookMutationLocalEffectOptions,
): GlobalLorebookMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined

  const expectedType =
    options.operation === 'create'
      ? 'lorebook.created'
      : options.operation === 'update'
        ? 'lorebook.updated'
        : options.operation === 'delete'
          ? 'lorebook.deleted'
          : options.operation === 'reorder'
            ? 'lorebook.reordered'
            : 'lorebook.selected'
  if (event.type !== expectedType || event.resource !== 'globalLorebook' || event.parentId !== undefined) {
    return undefined
  }

  const record = body as Record<string, unknown>
  if (options.operation === 'create') {
    if (!isCanonicalGlobalLorebookCreate(options.expectedLorebook)) return undefined
    const lorebook = options.expectedLorebook as GlobalLorebookSnapshot
    if (
      record.lorebookId !== lorebook.id ||
      event.id !== lorebook.id ||
      !isProjectionEpoch(options.collectionProjectionEpoch)
    ) {
      return undefined
    }
    return {
      kind: 'globalLorebookMutation',
      operation: options.operation,
      lorebookId: lorebook.id,
      collectionProjectionEpoch: options.collectionProjectionEpoch,
    }
  }

  if (options.operation === 'update') {
    if (
      !nonEmptyString(options.expectedLorebookId) ||
      !isCanonicalGlobalLorebookNamePatch(options.expectedPatch) ||
      record.lorebookId !== options.expectedLorebookId ||
      event.id !== options.expectedLorebookId ||
      !isProjectionEpoch(options.collectionProjectionEpoch)
    ) {
      return undefined
    }
    return {
      kind: 'globalLorebookMutation',
      operation: options.operation,
      lorebookId: options.expectedLorebookId,
      collectionProjectionEpoch: options.collectionProjectionEpoch,
    }
  }

  if (options.operation === 'delete') {
    if (
      !nonEmptyString(options.expectedLorebookId) ||
      record.lorebookId !== options.expectedLorebookId ||
      event.id !== options.expectedLorebookId ||
      !isProjectionEpoch(options.collectionProjectionEpoch) ||
      !isProjectionEpoch(options.pageProjectionEpoch)
    ) {
      return undefined
    }
    return {
      kind: 'globalLorebookMutation',
      operation: options.operation,
      lorebookId: options.expectedLorebookId,
      collectionProjectionEpoch: options.collectionProjectionEpoch,
      pageProjectionEpoch: options.pageProjectionEpoch,
    }
  }

  if (options.operation === 'reorder') {
    if (
      event.id !== undefined ||
      !isUniqueStringArray(options.expectedLorebookIds) ||
      !isNullableNonEmptyString(options.expectedSelectedLorebookId) ||
      (options.expectedSelectedLorebookId !== null &&
        !options.expectedLorebookIds.includes(options.expectedSelectedLorebookId)) ||
      record.selectedLorebookId !== options.expectedSelectedLorebookId ||
      !isProjectionEpoch(options.collectionProjectionEpoch) ||
      !isProjectionEpoch(options.pageProjectionEpoch)
    ) {
      return undefined
    }
    return {
      kind: 'globalLorebookMutation',
      operation: options.operation,
      lorebookIds: [...options.expectedLorebookIds],
      selectedLorebookId: options.expectedSelectedLorebookId,
      collectionProjectionEpoch: options.collectionProjectionEpoch,
      pageProjectionEpoch: options.pageProjectionEpoch,
    }
  }

  if (
    !nonEmptyString(options.expectedLorebookId) ||
    options.expectedSelectedLorebookId !== options.expectedLorebookId ||
    record.selectedLorebookId !== options.expectedLorebookId ||
    event.id !== options.expectedLorebookId ||
    !isProjectionEpoch(options.pageProjectionEpoch)
  ) {
    return undefined
  }
  return {
    kind: 'globalLorebookMutation',
    operation: options.operation,
    lorebookId: options.expectedLorebookId,
    selectedLorebookId: options.expectedLorebookId,
    pageProjectionEpoch: options.pageProjectionEpoch,
  }
}

interface ReadLorebookMutationLocalEffectOptions {
  scope: LorebookMutationLocalEffect['scope']
  operation: LorebookMutationLocalEffect['operation']
  expectedTargetId: unknown
  expectedCharacterId?: unknown
  expectedEntries?: unknown
  expectedEntryId?: unknown
  expectedEntry?: unknown
  expectedSparseUpdate?: unknown
  expectedEntryIndex?: unknown
  expectedEntryCreated?: unknown
  expectedEntryIds?: unknown
  optimisticEntries?: unknown
  collectionProjectionEpoch?: unknown
  characterRowProjectionEpoch?: unknown
  characterLorebookProjectionEpoch?: unknown
}

function readLorebookMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadLorebookMutationLocalEffectOptions,
): LorebookMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (!nonEmptyString(options.expectedTargetId)) return undefined
  if (!isCanonicalLorebookEntryArray(options.optimisticEntries)) return undefined

  const optimisticEntries = options.optimisticEntries as LorebookEntrySnapshot[]
  const optimisticIds = optimisticEntries.map((entry) => entry.id as string)
  if (options.operation === 'replace') {
    if (
      !isCanonicalLorebookEntryArray(options.expectedEntries) ||
      !isJsonValueEqual(options.expectedEntries, optimisticEntries)
    ) {
      return undefined
    }
  } else if (options.operation === 'upsert') {
    if (
      !nonEmptyString(options.expectedEntryId) ||
      !isCanonicalLorebookEntry(options.expectedEntry) ||
      (options.expectedEntry as LorebookEntrySnapshot).id !== options.expectedEntryId ||
      !Number.isInteger(options.expectedEntryIndex) ||
      (options.expectedEntryIndex as number) < 0 ||
      typeof options.expectedEntryCreated !== 'boolean'
    ) {
      return undefined
    }
    const optimisticMatches = optimisticEntries.filter((entry) => entry.id === options.expectedEntryId)
    if (
      optimisticMatches.length !== 1 ||
      !isJsonValueEqual(optimisticMatches[0], options.expectedEntry) ||
      optimisticEntries.findIndex((entry) => entry.id === options.expectedEntryId) !== options.expectedEntryIndex
    ) {
      return undefined
    }
    if (
      options.expectedSparseUpdate !== undefined &&
      (options.expectedEntryCreated !== false ||
        !isCanonicalSparseLorebookEntryUpdate(options.expectedSparseUpdate) ||
        !lorebookEntryMatchesSparseUpdate(options.expectedEntry as LorebookEntrySnapshot, options.expectedSparseUpdate))
    ) {
      return undefined
    }
  } else if (options.operation === 'delete') {
    if (
      !nonEmptyString(options.expectedEntryId) ||
      !Number.isInteger(options.expectedEntryIndex) ||
      (options.expectedEntryIndex as number) < 0 ||
      optimisticEntries.some((entry) => entry.id === options.expectedEntryId)
    ) {
      return undefined
    }
  } else if (
    !isUniqueStringArray(options.expectedEntryIds) ||
    !isJsonValueEqual(options.expectedEntryIds, optimisticIds)
  ) {
    return undefined
  }

  const record = body as Record<string, unknown>
  const targetResponseKey =
    options.scope === 'global' ? 'lorebookId' : options.scope === 'character' ? 'characterId' : 'chatId'
  const expectedResource =
    options.scope === 'global' ? 'globalLorebook' : options.scope === 'character' ? 'characterLorebook' : 'characterRow'
  if (
    event.type !== 'lorebook.entries.replaced' ||
    event.resource !== expectedResource ||
    event.id !== options.expectedTargetId ||
    record[targetResponseKey] !== options.expectedTargetId
  ) {
    return undefined
  }

  if (options.scope === 'chat') {
    if (!nonEmptyString(options.expectedCharacterId) || event.parentId !== options.expectedCharacterId) {
      return undefined
    }
  } else if (event.parentId !== undefined) {
    return undefined
  }

  if (options.operation === 'upsert' || options.operation === 'delete') {
    if (
      record.entryId !== options.expectedEntryId ||
      record.entryIndex !== options.expectedEntryIndex ||
      (options.operation === 'upsert' ? record.created !== options.expectedEntryCreated : record.created !== undefined)
    ) {
      return undefined
    }
    if (options.operation === 'upsert' && options.expectedSparseUpdate !== undefined) {
      if (!isCanonicalSparseLorebookEntryUpdate(options.expectedSparseUpdate)) return undefined
      if (!hasExactSparseLorebookEntryCertificate(record, options.expectedSparseUpdate)) return undefined
    }
  }

  if (options.scope === 'global') {
    if (!isProjectionEpoch(options.collectionProjectionEpoch)) return undefined
    return {
      kind: 'lorebookMutation',
      scope: options.scope,
      operation: options.operation,
      lorebookId: options.expectedTargetId,
      collectionProjectionEpoch: options.collectionProjectionEpoch,
    }
  }

  if (!isProjectionEpoch(options.characterRowProjectionEpoch)) return undefined
  if (options.scope === 'character') {
    if (!isProjectionEpoch(options.characterLorebookProjectionEpoch)) return undefined
    return {
      kind: 'lorebookMutation',
      scope: options.scope,
      operation: options.operation,
      characterId: options.expectedTargetId,
      characterRowProjectionEpoch: options.characterRowProjectionEpoch,
      characterLorebookProjectionEpoch: options.characterLorebookProjectionEpoch,
    }
  }

  return {
    kind: 'lorebookMutation',
    scope: options.scope,
    operation: options.operation,
    characterId: options.expectedCharacterId as string,
    chatId: options.expectedTargetId,
    characterRowProjectionEpoch: options.characterRowProjectionEpoch,
  }
}

interface ReadModuleCollectionMutationLocalEffectOptions {
  operation: ModuleCollectionMutationLocalEffect['operation']
  expectedModuleId?: unknown
  expectedModuleIds?: unknown
  expectedEntryId?: unknown
  entryResult?: 'upsert' | 'delete'
  expectedSparseUpdate?: unknown
  hasCanonicalPayload?: boolean
  collectionProjectionEpoch?: unknown
}

function readModuleCollectionMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadModuleCollectionMutationLocalEffectOptions,
): ModuleCollectionMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (options.hasCanonicalPayload === false) return undefined

  const expectedType =
    options.operation === 'create'
      ? 'module.created'
      : options.operation === 'update'
        ? 'module.updated'
        : options.operation === 'reorder'
          ? 'module.reordered'
          : options.operation === 'lorebooks'
            ? 'lorebook.entries.replaced'
            : options.operation === 'scripts'
              ? 'scriptDefinitions.replaced'
              : 'triggerDefinitions.replaced'
  const expectedResource =
    options.operation === 'create'
      ? 'moduleCreated'
      : options.operation === 'reorder'
        ? 'moduleReordered'
        : options.operation === 'scripts'
          ? 'moduleScriptDefinition'
          : options.operation === 'triggers'
            ? 'moduleTriggerDefinition'
            : 'moduleUpdated'
  if (event.type !== expectedType || event.resource !== expectedResource || event.parentId !== undefined) {
    return undefined
  }

  const record = body as Record<string, unknown>
  if (record.revision !== event.revision) return undefined

  if (options.operation === 'reorder') {
    if (event.id !== undefined || !isUniqueStringArray(options.expectedModuleIds)) return undefined
    return {
      kind: 'moduleCollectionMutation',
      operation: options.operation,
      moduleIds: [...options.expectedModuleIds],
    }
  }

  if (!nonEmptyString(options.expectedModuleId)) return undefined
  if (record.moduleId !== options.expectedModuleId || event.id !== options.expectedModuleId) return undefined
  if (options.expectedEntryId !== undefined) {
    if (
      !nonEmptyString(options.expectedEntryId) ||
      record.entryId !== options.expectedEntryId ||
      !Number.isInteger(record.entryIndex) ||
      (record.entryIndex as number) < 0 ||
      (options.entryResult === 'upsert'
        ? typeof record.created !== 'boolean'
        : options.entryResult === 'delete'
          ? record.created !== undefined
          : false)
    ) {
      return undefined
    }
    if (
      options.entryResult === 'upsert' &&
      options.expectedSparseUpdate !== undefined &&
      (!isCanonicalSparseLorebookEntryUpdate(options.expectedSparseUpdate) ||
        !hasExactSparseLorebookEntryCertificate(record, options.expectedSparseUpdate))
    ) {
      return undefined
    }
  }
  const definitionOperation = options.operation === 'scripts' || options.operation === 'triggers'
  if (definitionOperation && !isProjectionEpoch(options.collectionProjectionEpoch)) return undefined

  return {
    kind: 'moduleCollectionMutation',
    operation: options.operation,
    moduleId: options.expectedModuleId,
    ...(definitionOperation ? { collectionProjectionEpoch: options.collectionProjectionEpoch as number } : {}),
  }
}

function readModuleEnabledLocalEffect(
  body: unknown,
  event: CommandEvent,
  expectedModuleId: unknown,
  expectedEnabled: unknown,
): ModuleEnabledLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (!nonEmptyString(expectedModuleId) || typeof expectedEnabled !== 'boolean') return undefined
  const record = body as Record<string, unknown>
  if (
    event.type !== 'module.enabled' ||
    event.resource !== 'moduleEnabled' ||
    event.id !== expectedModuleId ||
    event.parentId !== undefined ||
    record.moduleId !== expectedModuleId ||
    record.enabled !== expectedEnabled
  ) {
    return undefined
  }
  return { kind: 'moduleEnabled', moduleId: expectedModuleId, enabled: expectedEnabled }
}

interface ReadLoadoutMutationLocalEffectOptions {
  operation: LoadoutMutationLocalEffect['operation']
  expectedLoadoutId: unknown
  expectedLoadout?: unknown
  expectedFavorite?: unknown
  expectedLastUsed?: unknown
  expectedCharacterId?: unknown
  loadoutsProjectionEpoch?: unknown
  settingsProjectionEpoch?: unknown
  loadedName?: unknown
}

function readLoadoutMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadLoadoutMutationLocalEffectOptions,
): LoadoutMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (!nonEmptyString(options.expectedLoadoutId)) return undefined
  if (!isProjectionEpoch(options.loadoutsProjectionEpoch)) return undefined
  const expectedType = {
    create: 'loadout.created',
    delete: 'loadout.deleted',
    favorite: 'loadout.favorited',
    touch: 'loadout.touched',
  }[options.operation]
  if (
    event.type !== expectedType ||
    event.resource !== 'loadout' ||
    event.id !== options.expectedLoadoutId ||
    event.parentId !== undefined ||
    (body as Record<string, unknown>).loadoutId !== options.expectedLoadoutId
  ) {
    return undefined
  }

  if (options.operation === 'create') {
    if (!isCanonicalLoadout(options.expectedLoadout) || options.expectedLoadout.id !== options.expectedLoadoutId) {
      return undefined
    }
    return {
      kind: 'loadoutMutation',
      operation: 'create',
      loadoutId: options.expectedLoadoutId,
      loadoutsProjectionEpoch: options.loadoutsProjectionEpoch,
    }
  }

  if (options.operation === 'delete') {
    return {
      kind: 'loadoutMutation',
      operation: 'delete',
      loadoutId: options.expectedLoadoutId,
      loadoutsProjectionEpoch: options.loadoutsProjectionEpoch,
    }
  }

  if (options.operation === 'favorite') {
    if (typeof options.expectedFavorite !== 'boolean') return undefined
    return {
      kind: 'loadoutMutation',
      operation: 'favorite',
      loadoutId: options.expectedLoadoutId,
      loadoutsProjectionEpoch: options.loadoutsProjectionEpoch,
    }
  }

  if (
    typeof options.expectedLastUsed !== 'number' ||
    !Number.isFinite(options.expectedLastUsed) ||
    (options.expectedCharacterId !== undefined && !nonEmptyString(options.expectedCharacterId)) ||
    !isProjectionEpoch(options.settingsProjectionEpoch) ||
    !nonEmptyString(options.loadedName)
  ) {
    return undefined
  }
  return {
    kind: 'loadoutMutation',
    operation: 'touch',
    loadoutId: options.expectedLoadoutId,
    loadoutsProjectionEpoch: options.loadoutsProjectionEpoch,
    settingsProjectionEpoch: options.settingsProjectionEpoch,
    loadedName: options.loadedName,
  }
}

function isProjectionEpoch(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isCanonicalGlobalLorebookCreate(value: unknown): value is GlobalLorebookSnapshot & {
  id: string
  name: string
  data: LorebookEntrySnapshot[]
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as GlobalLorebookSnapshot
  return nonEmptyString(record.id) && nonEmptyString(record.name) && isCanonicalLorebookEntryArray(record.data)
}

function isCanonicalGlobalLorebookNamePatch(value: unknown): value is Pick<GlobalLorebookSnapshot, 'name'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && nonEmptyString(record.name)
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value)
}

function isCanonicalModuleCreate(value: ModuleSnapshot): boolean {
  return (
    nonEmptyString(value.id) &&
    typeof value.name === 'string' &&
    value.name.trim() !== '' &&
    typeof value.description === 'string'
  )
}

function readGlobalScriptMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: MutateGlobalScriptsCommandInput,
  expectedDigest: string,
): SettingsPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (
    record.certificate !== 'global-script-mutation-v1' ||
    record.group !== 'advanced' ||
    record.key !== 'globalscript' ||
    record.operation !== input.mutation.op ||
    record.globalScriptsDigest !== expectedDigest ||
    !isUniqueDefinitionArray(input.expectedScripts)
  ) {
    return undefined
  }
  return readSettingsPatchLocalEffect(
    body,
    event,
    'advanced',
    { globalscript: input.expectedScripts },
    input.optimisticProjectionEpoch,
  )
}

function readCharacterDefinitionMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: {
    operation: CharacterDefinitionMutationLocalEffect['operation']
    expectedCharacterId: unknown
    expectedDefinitions: unknown
    optimisticRowEpoch: unknown
  },
): CharacterDefinitionMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (
    !nonEmptyString(options.expectedCharacterId) ||
    !isUniqueDefinitionArray(options.expectedDefinitions) ||
    !isProjectionEpoch(options.optimisticRowEpoch)
  ) {
    return undefined
  }
  const expectedType = options.operation === 'scripts' ? 'scriptDefinitions.replaced' : 'triggerDefinitions.replaced'
  const record = body as Record<string, unknown>
  if (
    record.revision !== event.revision ||
    event.type !== expectedType ||
    event.resource !== 'characterRow' ||
    event.id !== options.expectedCharacterId ||
    event.parentId !== undefined ||
    record.characterId !== options.expectedCharacterId
  ) {
    return undefined
  }
  return {
    kind: 'characterDefinitionMutation',
    operation: options.operation,
    characterId: options.expectedCharacterId,
    optimisticRowEpoch: options.optimisticRowEpoch,
    definitions: cloneJsonValue(options.expectedDefinitions) as Array<
      ScriptDefinitionSnapshot | TriggerDefinitionSnapshot
    >,
  }
}

function isUniqueDefinitionArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const ids: string[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const id = (candidate as Record<string, unknown>).id
    if (!nonEmptyString(id)) return false
    ids.push(id)
  }
  return new Set(ids).size === ids.length
}

function isCanonicalLorebookEntryArray(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(isCanonicalLorebookEntry)) return false
  const ids = value.map((entry) => (entry as Record<string, unknown>).id as string)
  return new Set(ids).size === ids.length
}

function isCanonicalLorebookEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    nonEmptyString(record.id) &&
    typeof record.key === 'string' &&
    typeof record.secondkey === 'string' &&
    typeof record.insertorder === 'number' &&
    Number.isFinite(record.insertorder) &&
    typeof record.comment === 'string' &&
    typeof record.content === 'string' &&
    typeof record.mode === 'string' &&
    typeof record.alwaysActive === 'boolean' &&
    typeof record.selective === 'boolean' &&
    (record.folder === undefined || typeof record.folder === 'string')
  )
}

function isCanonicalSparseLorebookEntryUpdate(value: unknown): value is SparseLorebookEntryUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isJsonValue(value)) return false
  const record = value as Record<string, unknown>
  if (!Object.keys(record).every((key) => key === 'patch' || key === 'deleteKeys')) return false
  if (!record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch) || !isJsonValue(record.patch)) {
    return false
  }

  const patch = record.patch as Record<string, unknown>
  const patchedKeys = Object.keys(patch)
  const deleteKeys = record.deleteKeys === undefined ? [] : record.deleteKeys
  if (
    !isUniqueStringArray(deleteKeys) ||
    patchedKeys.some((key) => key.trim() === '' || key === 'id') ||
    deleteKeys.some((key) => key === 'id' || Object.prototype.hasOwnProperty.call(patch, key))
  ) {
    return false
  }
  return patchedKeys.length > 0 || deleteKeys.length > 0
}

function lorebookEntryMatchesSparseUpdate(entry: LorebookEntrySnapshot, update: SparseLorebookEntryUpdate): boolean {
  if (!isCanonicalSparseLorebookEntryUpdate(update)) return false
  for (const [key, value] of Object.entries(update.patch)) {
    if (!isJsonValueEqual(entry[key], value)) return false
  }
  for (const key of update.deleteKeys ?? []) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) return false
  }
  return true
}

function hasExactSparseLorebookEntryCertificate(
  record: Record<string, unknown>,
  update: SparseLorebookEntryUpdate,
): boolean {
  if (!isCanonicalSparseLorebookEntryUpdate(update) || record.created !== false) return false
  if (!isUniqueStringArray(record.patchedKeys) || !isUniqueStringArray(record.deletedKeys)) return false
  return (
    isJsonValueEqual(record.patchedKeys, Object.keys(update.patch).sort()) &&
    isJsonValueEqual(record.deletedKeys, [...(update.deleteKeys ?? [])].sort())
  )
}

function readMessageTranslationLocalEffect(
  body: unknown,
  event: CommandEvent,
  expectedMessageId: string,
): MessageTranslationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const chatId = record.chatId
  const messageId = record.messageId
  if (typeof chatId !== 'string' || chatId.trim() === '') return undefined
  if (messageId !== expectedMessageId) return undefined
  if (
    event.type !== 'message.updated' ||
    event.resource !== 'message' ||
    event.id !== messageId ||
    event.parentId !== chatId
  ) {
    return undefined
  }
  if (!isMessageTranslation(record.translation)) return undefined
  return {
    kind: 'messageTranslation',
    chatId,
    messageId,
    translation: cloneJsonValue(record.translation),
  }
}

function isMessageTranslation(value: unknown): value is MessageTranslation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.source === 'raw' &&
    typeof record.text === 'string' &&
    typeof record.sourceHash === 'string' &&
    typeof record.targetLanguage === 'string' &&
    typeof record.inputLanguage === 'string' &&
    (record.translatorType === 'google' ||
      record.translatorType === 'deepl' ||
      record.translatorType === 'deeplX' ||
      record.translatorType === 'llm') &&
    typeof record.settingsHash === 'string' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt)
  )
}

interface ReadMessageMutationLocalEffectOptions {
  operation: MessageMutationLocalEffect['operation']
  expectedChatId?: string
  expectedMessageId?: string
  expectedAfterMessageId?: string | null
  expectedMessageIds?: Array<string | undefined>
  expectedChatBodyProjectionEpoch?: number
}

function readMessageMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadMessageMutationLocalEffectOptions,
): MessageMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const chatId = record.chatId
  if (typeof chatId !== 'string' || chatId.trim() === '') return undefined
  if (!isProjectionEpoch(options.expectedChatBodyProjectionEpoch)) return undefined
  const chatBodyProjectionEpoch = options.expectedChatBodyProjectionEpoch as number
  if ((options.operation === 'update' || options.operation === 'delete') && !nonEmptyString(options.expectedChatId)) {
    return undefined
  }
  if (options.expectedChatId !== undefined && chatId !== options.expectedChatId) return undefined
  if (event.resource !== 'message' || event.parentId !== chatId) return undefined

  const expectedType =
    options.operation === 'append'
      ? 'message.appended'
      : options.operation === 'update'
        ? 'message.updated'
        : options.operation === 'delete'
          ? 'message.deleted'
          : options.operation === 'truncate'
            ? 'message.truncated'
            : 'messages.replaced'
  if (event.type !== expectedType) return undefined

  if (options.operation === 'append' || options.operation === 'update' || options.operation === 'delete') {
    const messageId = record.messageId
    if (
      typeof options.expectedMessageId !== 'string' ||
      options.expectedMessageId.trim() === '' ||
      messageId !== options.expectedMessageId ||
      event.id !== options.expectedMessageId
    ) {
      return undefined
    }
    return {
      kind: 'messageMutation',
      operation: options.operation,
      chatId,
      messageId,
      chatBodyProjectionEpoch,
    }
  }

  if (event.id !== undefined) return undefined
  if (options.operation === 'truncate' || options.operation === 'replaceTail') {
    if (record.afterMessageId !== options.expectedAfterMessageId) return undefined
    if (!Number.isInteger(record.replacedCount ?? record.removedCount)) return undefined
  }
  if (options.operation === 'replaceTail') {
    if (!isUniqueStringArray(options.expectedMessageIds)) return undefined
  }
  if (options.operation === 'replaceAll' && !isNonEmptyStringArray(options.expectedMessageIds, true)) return undefined
  return { kind: 'messageMutation', operation: options.operation, chatId, chatBodyProjectionEpoch }
}

function readCharacterRowMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  operation: CharacterRowMutationLocalEffect['operation'],
  expectedTargetId: string,
): CharacterRowMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const responseKey = operation === 'chatFolderUpdate' ? 'folderId' : 'chatId'
  if ((body as Record<string, unknown>)[responseKey] !== expectedTargetId) return undefined
  const expectedType = operation === 'chatFolderUpdate' ? 'chatFolder.updated' : 'chat.scriptstate.updated'
  if (
    event.type !== expectedType ||
    event.resource !== 'characterRow' ||
    event.id !== expectedTargetId ||
    typeof event.parentId !== 'string' ||
    event.parentId.trim() === ''
  ) {
    return undefined
  }
  return {
    kind: 'characterRowMutation',
    operation,
    characterId: event.parentId,
    targetId: expectedTargetId,
  }
}

interface ReadChatStructureMutationLocalEffectOptions {
  operation: ChatStructureMutationLocalEffect['operation']
  expectedCharacterId?: unknown
  expectedTargetId?: unknown
  expectedSourceChatId?: unknown
  expectedIds?: unknown
  expectedChat?: ChatSnapshot
  expectedOptimisticEpoch?: unknown
  expectedOptimisticRowEpoch?: unknown
}

function readChatStructureMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  options: ReadChatStructureMutationLocalEffectOptions,
): ChatStructureMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (
    !Number.isInteger(options.expectedOptimisticEpoch) ||
    hasDestructiveRefreshEpochChanged(options.expectedOptimisticEpoch as number)
  ) {
    return undefined
  }
  if (!Number.isInteger(options.expectedOptimisticRowEpoch)) return undefined
  if (!nonEmptyString(event.parentId)) return undefined
  if (options.expectedCharacterId !== undefined && event.parentId !== options.expectedCharacterId) return undefined

  const expectedType =
    options.operation === 'create'
      ? 'chat.created'
      : options.operation === 'delete'
        ? 'chat.deleted'
        : options.operation === 'fork'
          ? 'chat.forked'
          : options.operation === 'reorder'
            ? 'chat.reordered'
            : options.operation === 'folderCreate'
              ? 'chatFolder.created'
              : options.operation === 'folderDelete'
                ? 'chatFolder.deleted'
                : 'chatFolder.reordered'
  const allowsTranscriptResource = options.operation === 'create' || options.operation === 'fork'
  if (
    event.type !== expectedType ||
    (event.resource !== 'characterRow' && !(allowsTranscriptResource && event.resource === 'chatTranscript'))
  ) {
    return undefined
  }

  if (options.operation === 'reorder' || options.operation === 'folderReorder') {
    if (event.id !== undefined || !isUniqueStringArray(options.expectedIds)) return undefined
    return {
      kind: 'chatStructureMutation',
      operation: options.operation,
      characterId: event.parentId,
      attemptedIds: [...options.expectedIds],
      optimisticEpoch: options.expectedOptimisticEpoch as number,
      optimisticRowEpoch: options.expectedOptimisticRowEpoch as number,
    }
  }

  if (!nonEmptyString(options.expectedTargetId) || event.id !== options.expectedTargetId) return undefined
  const record = body as Record<string, unknown>
  const responseKey =
    options.operation === 'folderCreate' || options.operation === 'folderDelete' ? 'folderId' : 'chatId'
  if (record[responseKey] !== options.expectedTargetId) return undefined
  if (
    options.operation === 'fork' &&
    (!nonEmptyString(options.expectedSourceChatId) || record.sourceChatId !== options.expectedSourceChatId)
  ) {
    return undefined
  }

  if (options.operation === 'create' || options.operation === 'fork') {
    if (!options.expectedChat || !Object.prototype.hasOwnProperty.call(record, 'generationSettings')) {
      return undefined
    }
    const canonicalGenerationSettings = record.generationSettings
    if (
      canonicalGenerationSettings !== null &&
      (!canonicalGenerationSettings ||
        typeof canonicalGenerationSettings !== 'object' ||
        Array.isArray(canonicalGenerationSettings))
    ) {
      return undefined
    }
    return {
      kind: 'chatStructureMutation',
      operation: options.operation,
      characterId: event.parentId,
      targetId: options.expectedTargetId,
      attemptedGenerationSettings: cloneJsonValue(options.expectedChat.generationSettings ?? null),
      generationSettings: cloneJsonValue(canonicalGenerationSettings as ChatGenerationSettings | null),
      optimisticEpoch: options.expectedOptimisticEpoch as number,
      optimisticRowEpoch: options.expectedOptimisticRowEpoch as number,
    }
  }

  return {
    kind: 'chatStructureMutation',
    operation: options.operation,
    characterId: event.parentId,
    targetId: options.expectedTargetId,
    optimisticEpoch: options.expectedOptimisticEpoch as number,
    optimisticRowEpoch: options.expectedOptimisticRowEpoch as number,
  }
}

function isCanonicalOptimisticChatSnapshot(chat: ChatSnapshot): boolean {
  return (
    nonEmptyString(chat.id) &&
    Array.isArray(chat.message) &&
    typeof chat.note === 'string' &&
    typeof chat.name === 'string' &&
    chat.name.trim() !== '' &&
    Array.isArray(chat.localLore)
  )
}

function isCanonicalOptimisticChatFolderSnapshot(folder: ChatFolderSnapshot): boolean {
  return nonEmptyString(folder.id) && typeof folder.folded === 'boolean'
}

function readCharacterOrderLocalEffect(
  event: CommandEvent,
  attemptedOrder: CharacterOrderEntry[],
): CharacterOrderLocalEffect | undefined {
  if (event.type !== 'character.reordered' || event.resource !== 'characterOrder' || event.id !== undefined) {
    return undefined
  }
  if (!Array.isArray(attemptedOrder)) return undefined
  return { kind: 'characterOrder', attemptedOrder: cloneJsonValue(attemptedOrder) }
}

function isNonEmptyStringArray(value: unknown, allowEmpty = false): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  )
}

function isUniqueStringArray(value: unknown): value is string[] {
  return isNonEmptyStringArray(value, true) && new Set(value).size === value.length
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readJsonFieldState(value: unknown): JsonFieldState | null {
  if (!isPlainJsonRecord(value) || typeof value.present !== 'boolean') return null
  const keys = Object.keys(value).sort()
  if (!value.present) return isJsonValueEqual(keys, ['present']) ? { present: false } : null
  if (!isJsonValueEqual(keys, ['present', 'value']) || !isJsonValue(value.value)) return null
  return { present: true, value: cloneJsonValue(value.value) }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object') return false
  if (ancestors.has(value)) return false

  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false

  ancestors.add(value)
  let valid = true
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonValue(value[index], ancestors)) {
        valid = false
        break
      }
    }
  } else {
    valid = Object.values(value).every((entry) => isJsonValue(entry, ancestors))
  }
  ancestors.delete(value)
  return valid
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function readCharacterCollectionMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  operation: CharacterCollectionMutationLocalEffect['operation'],
  expectedCharacterId: unknown,
): CharacterCollectionMutationLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (!nonEmptyString(expectedCharacterId)) return undefined

  const record = body as Record<string, unknown>
  const characterId = record.characterId
  if (!nonEmptyString(characterId) || characterId !== expectedCharacterId) return undefined
  let selectedCharacterId: string | null
  if (record.selectedCharacterId === null) {
    selectedCharacterId = null
  } else if (nonEmptyString(record.selectedCharacterId)) {
    selectedCharacterId = record.selectedCharacterId
  } else {
    return undefined
  }

  const expectedType =
    operation === 'create'
      ? 'character.created'
      : operation === 'createAndSelect'
        ? 'character.createdAndSelected'
        : 'character.deleted'
  if (
    event.type !== expectedType ||
    event.resource !== 'character' ||
    event.id !== characterId ||
    event.parentId !== undefined
  ) {
    return undefined
  }
  if (operation === 'createAndSelect' ? selectedCharacterId !== characterId : selectedCharacterId === characterId) {
    return undefined
  }

  return {
    kind: 'characterCollectionMutation',
    operation,
    characterId,
    selectedCharacterId,
  }
}

function readCharacterPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  expectedCharacterId: string,
  patch: CharacterSnapshot,
): CharacterPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const characterId = (body as Record<string, unknown>).characterId
  if (characterId !== expectedCharacterId) return undefined
  if (event.resource !== 'characterRow' || event.id !== characterId) return undefined
  if (Object.keys(patch).length === 0) return undefined
  return {
    kind: 'characterPatch',
    characterId,
    patch: cloneJsonValue(patch),
  }
}

function readAlternateGreetingMutationLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: MutateAlternateGreetingsCommandInput,
): CharacterPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  if (
    record.characterId !== input.characterId ||
    record.certificate !== 'alternate-greeting-index-cascade-v1' ||
    event.type !== 'character.alternateGreetings.updated' ||
    event.resource !== 'characterRow' ||
    event.id !== input.characterId ||
    event.parentId !== undefined ||
    !isJsonValueEqual(record.chatGreetingIndices, input.chatGreetingIndices)
  ) {
    return undefined
  }
  return {
    kind: 'characterPatch',
    characterId: input.characterId,
    patch: { alternateGreetings: cloneJsonValue(input.alternateGreetings) },
  }
}

function readCharacterSelectionLocalEffect(
  body: unknown,
  event: CommandEvent,
  expectedCharacterId: string,
  lastInteraction: number | undefined,
): CharacterSelectionLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const characterId = (body as Record<string, unknown>).characterId
  if (characterId !== expectedCharacterId) return undefined
  if (event.resource !== 'characterSelection' || event.id !== characterId) return undefined
  if (typeof lastInteraction !== 'number' || !Number.isFinite(lastInteraction)) return undefined
  return {
    kind: 'characterSelection',
    characterId,
    lastInteraction,
  }
}

function readChatPatchLocalEffect(
  body: unknown,
  event: CommandEvent,
  input: UpdateChatCommandInput,
): ChatPatchLocalEffect | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const chatId = (body as Record<string, unknown>).chatId
  if (chatId !== input.chatId) return undefined
  if (event.resource !== 'characterRow' || event.id !== chatId) return undefined
  if (typeof event.parentId !== 'string' || event.parentId.trim() === '') return undefined
  const select = input.select === true
  if (Object.keys(input.patch).length === 0 && !select) return undefined
  return {
    kind: 'chatPatch',
    characterId: event.parentId,
    chatId,
    patch: cloneJsonValue(input.patch),
    select,
  }
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isJsonValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function readCommandEvent(body: unknown): CommandEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const event = (body as { event?: unknown }).event
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const record = event as Record<string, unknown>
  if (typeof record.type !== 'string') return null
  if (!Number.isInteger(record.revision) || (record.revision as number) < 0) return null
  if (typeof record.resource !== 'string') return null
  for (const key of ['id', 'parentId', 'databaseLineage', 'operationId', 'sourceMessageId', 'jobId'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return null
  }
  if (record.origin !== undefined && !isCommandEventOrigin(record.origin)) return null
  const parsed: CommandEvent = {
    type: record.type,
    revision: record.revision as number,
    resource: record.resource,
  }
  if (typeof record.id === 'string') parsed.id = record.id
  if (typeof record.parentId === 'string') parsed.parentId = record.parentId
  if (typeof record.databaseLineage === 'string') parsed.databaseLineage = record.databaseLineage
  if (typeof record.operationId === 'string') parsed.operationId = record.operationId
  if (typeof record.sourceMessageId === 'string') parsed.sourceMessageId = record.sourceMessageId
  if (typeof record.jobId === 'string') parsed.jobId = record.jobId
  if (isCommandEventOrigin(record.origin)) parsed.origin = record.origin
  return parsed
}

function isCommandEventOrigin(value: unknown): value is { writerSessionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const writerSessionId = (value as { writerSessionId?: unknown }).writerSessionId
  return typeof writerSessionId === 'string' && writerSessionId.trim() !== ''
}

function readCommandSuccessReceipt(
  body: unknown,
  allowEventlessSuccess?: (body: Record<string, unknown>) => boolean,
): { revision: number; event: CommandEvent | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const revision = record.revision
  if (!Number.isInteger(revision) || (revision as number) < 0) return null

  const event = readCommandEvent(record)
  if (event) {
    if (event.revision !== revision) return null
  } else if (!allowEventlessSuccess?.(record)) {
    return null
  }

  return { revision: revision as number, event }
}

function readCurrentRevision(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const currentRevision = (body as { currentRevision?: unknown }).currentRevision
  return Number.isInteger(currentRevision) ? (currentRevision as number) : null
}

function isDatabaseLineageConflict(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'database_lineage_conflict'
}

function isMutationIdConflict(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'mutation_id_conflict'
}

function isInitializeConflict(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'initialize_conflict'
}

/** Validation/not-found command handlers return exactly `{ error: string }`.
 * Fastify route misses and proxy/deployment-skew errors use other envelopes and
 * must not be mistaken for a conclusive command rejection. */
function isStableCommandErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const record = body as Record<string, unknown>
  return Object.keys(record).length === 1 && typeof record.error === 'string' && record.error.trim().length > 0
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string') return record.error
    if (typeof record.reason === 'string') return record.reason
  }
  return fallback
}
