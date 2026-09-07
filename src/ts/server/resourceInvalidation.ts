import type { CommandEvent } from './commands'
import { captureClientSessionGeneration, isClientSessionGenerationCurrent } from '../clientSession'
import { lorebookPageOwner } from './lorebookPageOwner.svelte'
import {
  SERVER_SETTINGS_GROUP_BY_KEY,
  SERVER_SETTINGS_KEYS_BY_GROUP,
  isSettingsGroup,
  type SettingsGroup,
} from './settingsGroups'
import {
  fetchServerBulkCharacterLorebooks,
  fetchServerCharacterLorebook,
  fetchServerChatMessages,
  fetchServerGenerationChatMessages,
  fetchServerLegacyPreset,
} from './hydrationReads'
import {
  currentPromptTemplateOwnerId,
  ensurePromptTemplateHydrated,
  invalidatePromptTemplateHydration,
  isPromptTemplateHydrated,
  markPromptTemplateHydrationStale,
  markPromptTemplateProjectionApplied,
  resetPromptTemplateHydration,
} from './promptTemplateHydration'
import {
  fetchServerCharacter,
  fetchServerCharacterOrder,
  fetchServerCharacterSelection,
  fetchServerCharacters,
  fetchServerCollection,
  fetchServerCollections,
  fetchServerInlayCatalog,
  fetchServerShell,
  fetchServerSettings,
  fetchServerSettingsGroup,
  fetchServerStandaloneSetting,
} from './resourceReads'
import {
  applyCharacterOrderResource,
  applyCharacterResource,
  applyCharacterSelectionResource,
  applyCharactersResource,
  applyCollectionsResource,
  applyLegacyPresetCollectionResource,
  applyLegacyPresetRowResource,
  applySettingsResource,
  applySettingsGroupResource,
  applyStandaloneSettingResource,
  SERVER_COLLECTION_NAMES,
  captureCharacterListProjectionEpoch,
  captureCharacterLorebookBodyProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureChatBodyProjectionEpoch,
  captureCollectionProjectionEpoch,
  captureLegacyPresetResourceBaseline,
  captureSettingsGroupProjectionEpoch,
  captureSettingsProjectionEpoch,
  charactersResourceState,
  collectionsResourceState,
  hasCharacterLorebookBodyProjectionEpochChanged,
  hasChatBodyProjectionEpochChanged,
  hasNewerCharacterLorebookBodyResourceRevision,
  hasNewerChatBodyResourceRevision,
  isCharacterLorebookBodyResourceLoaded,
  isChatBodyResourceLoaded,
  markCharacterLorebookBodyResourceRevision,
  markCharacterLorebookProjectionApplied,
  markChatBodyResourceRevision,
  settingsResourceState,
  type ServerCollectionName,
  type ServerCollectionsResourcePayload,
  type ServerCharactersResourcePayload,
  type ServerLegacyPresetResourceBaseline,
} from './resourceState.svelte'
import { createDestructiveRefreshToken } from './staleStateGuards'
import { applyServerInlayCatalogResource, getServerInlayCatalogResource } from './inlayCatalog'
import { applyServerShellResource } from './shellHydration'
import { SERVER_SHELL_SETTINGS_KEYS } from '@risuai/protocol/shell-resource'
import type { ServerStandaloneSettingName } from '@risuai/protocol/standalone-settings'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
import {
  isBardWikiChatResourceLoaded,
  isBardWikiDocumentResourceLoaded,
  refreshAllLoadedBardWikiResources,
  refreshLoadedBardWikiChat,
} from './bardWikiResource'

export const FULL_RESOURCE_REFRESH_MAX_ATTEMPTS = 3

export type ServerResourceRefreshResult =
  | { status: 'ok'; revision: number; scope: 'shell' | 'full' | 'targeted' | 'none' }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }

export interface ServerResourceInvalidationHooks {
  reapplyPendingPresetProjections(): void
  reapplyPendingPromptTemplateStructuralProjections?(): void
  mergePendingAgentPresetSettings(value: Record<string, unknown>): Record<string, unknown>
  mergePendingAgentPresetLoadouts(
    value: NonNullable<ServerCollectionsResourcePayload['collections']['loadouts']>,
  ): NonNullable<ServerCollectionsResourcePayload['collections']['loadouts']>
  mergePendingAgentPresetCharacters(
    value: ServerCharactersResourcePayload['characters'],
  ): ServerCharactersResourcePayload['characters']
  mergePendingPluginCollection(
    value: NonNullable<ServerCollectionsResourcePayload['collections']['plugins']>,
  ): NonNullable<ServerCollectionsResourcePayload['collections']['plugins']>
  mergePendingPluginProvider(value: unknown): string
  mergePendingPluginStorage(value: Record<string, unknown>): Record<string, unknown>
  applyChatMessages(
    chatId: string,
    message: unknown[],
    hypaV3Data: unknown,
    alternates: unknown[],
    range?: { start: number; total: number },
    options?: { hypaV3DataIncluded?: boolean },
  ): boolean
  applyCharacterLorebook(characterId: string, globalLore: unknown[]): boolean
  markCharacterLorebookHydrated(characterId: string): void
  recordCanonicalCharacterLorebookScopes?(characters: ServerCharactersResourcePayload['characters']): void
  recordCanonicalLorebookCollections?(names: readonly ServerCollectionName[]): void
  triggerOpenChatGenerationReattach(): void
  clearActiveMessageTranslation(messageId: string): void
  refreshGreetingTranslations(characterId: string, minimumRevision: number): Promise<boolean>
}

export interface ServerResourceRefreshOptions {
  signal?: AbortSignal | null
  hooks?: Partial<ServerResourceInvalidationHooks>
  /** Fence the owner operation before applying a completed read. */
  isCurrent?: () => boolean
  /** Readers leave authoring bodies lazy and ignore persisted navigation. */
  mode?: 'reader'
  onFullProjectionApplied?: () => void
}

function refreshIsCurrent(options: ServerResourceRefreshOptions): boolean {
  return !options.signal?.aborted && (options.isCurrent?.() ?? true)
}

function captureRefreshOptions<T extends ServerResourceRefreshOptions>(options: T): T {
  const generation = captureClientSessionGeneration()
  return {
    ...options,
    isCurrent: () => isClientSessionGenerationCurrent(generation) && (options.isCurrent?.() ?? true),
  }
}

export interface ServerResourceInvalidationOptions extends ServerResourceRefreshOptions {
  appliedRevision?: number | null
}

export interface ServerResourceTargetRefreshInput {
  characterIds?: readonly string[]
  collections?: readonly ServerCollectionName[]
  inlayCatalog?: boolean
  settingsGroups?: readonly SettingsGroup[]
  standaloneSettings?: readonly ServerStandaloneSettingName[]
  minimumRevision?: number
}

interface RefreshPlan {
  bardWikiChatIds: Set<string>
  bardWikiDocumentIds: Map<string, Set<string>>
  inlayCatalog: boolean
  settings: boolean
  settingsGroups: Set<SettingsGroup>
  standaloneSettings: Set<ServerStandaloneSettingName>
  collections: Set<ServerCollectionName>
  allCharacters: boolean
  characterIds: Set<string>
  characterOrder: boolean
  characterSelectionIds: Set<string>
  chatIds: Set<string>
  generationChatMessageIds: Map<string, string>
  lorebookCharacterIds: Set<string>
  translatedMessageIds: Set<string>
  greetingTranslationCharacterIds: Set<string>
  promptTemplateOwnerIds: Set<string>
  legacyPresetIds: Set<string>
  refreshSelectedPromptTemplate: boolean
  full: boolean
}

type SettingsReadResult = Awaited<ReturnType<typeof fetchServerSettings>>
type SettingsGroupReadResult = Awaited<ReturnType<typeof fetchServerSettingsGroup>>
type StandaloneSettingReadResult = Awaited<ReturnType<typeof fetchServerStandaloneSetting>>
type CollectionReadResult = Awaited<ReturnType<typeof fetchServerCollection>>
type CharactersReadResult = Awaited<ReturnType<typeof fetchServerCharacters>>
type CharacterReadResult = Awaited<ReturnType<typeof fetchServerCharacter>>
type CharacterOrderReadResult = Awaited<ReturnType<typeof fetchServerCharacterOrder>>
type CharacterSelectionReadResult = Awaited<ReturnType<typeof fetchServerCharacterSelection>>
type ChatReadResult = Awaited<ReturnType<typeof fetchServerChatMessages>>
type LorebookReadResult = Awaited<ReturnType<typeof fetchServerCharacterLorebook>>
type BulkLorebookReadResult = Awaited<ReturnType<typeof fetchServerBulkCharacterLorebooks>>
type LegacyPresetReadResult = Awaited<ReturnType<typeof fetchServerLegacyPreset>>
type LegacyPresetCollectionReadResult =
  | {
      status: 'ok'
      revision: number
      shells: unknown[]
      presetRows: Record<string, unknown>[]
      baseline: ServerLegacyPresetResourceBaseline
    }
  | { status: 'error'; error: string }
  | { status: 'unavailable' }
type InlayCatalogReadResult = Awaited<ReturnType<typeof fetchServerInlayCatalog>>

interface ResourceReadFence {
  /** True when this request no longer owns the resident projection it started from. */
  isSuperseded(): boolean
}

type CompletedTargetedRead =
  | { kind: 'inlayCatalog'; result: InlayCatalogReadResult }
  | { kind: 'settings'; fence: ResourceReadFence; result: SettingsReadResult }
  | { kind: 'settingsGroup'; group: SettingsGroup; fence: ResourceReadFence; result: SettingsGroupReadResult }
  | {
      kind: 'standaloneSetting'
      setting: ServerStandaloneSettingName
      fence: ResourceReadFence
      result: StandaloneSettingReadResult
    }
  | { kind: 'collection'; name: ServerCollectionName; fence: ResourceReadFence; result: CollectionReadResult }
  | {
      kind: 'legacyPresetRow'
      presetId: string
      baseline: ServerLegacyPresetResourceBaseline
      fence: ResourceReadFence
      result: LegacyPresetReadResult
    }
  | { kind: 'legacyPresetCollection'; fence: ResourceReadFence; result: LegacyPresetCollectionReadResult }
  | { kind: 'characters'; fence: ResourceReadFence; result: CharactersReadResult }
  | { kind: 'character'; characterId: string; fence: ResourceReadFence; result: CharacterReadResult }
  | { kind: 'characterOrder'; fence: ResourceReadFence; result: CharacterOrderReadResult }
  | {
      kind: 'characterSelection'
      characterId: string
      fence: ResourceReadFence
      result: CharacterSelectionReadResult
    }
  | { kind: 'chat'; chatId: string; projectionEpoch: number; result: ChatReadResult }
  | { kind: 'lorebook'; characterId: string; projectionEpoch: number; result: LorebookReadResult }
  | {
      kind: 'lorebooks'
      characterIds: string[]
      projectionEpochs: Map<string, number>
      result: BulkLorebookReadResult
    }

/** Load only the coherent shell. Routes and deferred runtimes own every other slice. */
export async function loadInitialServerResources(
  options: ServerResourceRefreshOptions = {},
): Promise<ServerResourceRefreshResult> {
  options = captureRefreshOptions(options)
  const shell = await fetchServerShell(options.signal)
  if (!refreshIsCurrent(options)) return { status: 'unavailable' }
  if (shell.status !== 'ok') return failedRead(shell)
  const mergedCharacters = options.hooks?.mergePendingAgentPresetCharacters
    ? options.hooks.mergePendingAgentPresetCharacters(shell.characters.characters)
    : shell.characters.characters
  const payload = {
    ...shell,
    characters: {
      ...shell.characters,
      characters: mergedCharacters,
    },
  }
  try {
    if (!applyServerShellResource(payload)) {
      return { status: 'error', error: 'Server shell response was superseded before apply' }
    }
    return { status: 'ok', revision: shell.revision, scope: 'shell' }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Refresh all database resources at one common server revision. If concurrent
 * writes make the four reads disagree, retry the complete read set a bounded
 * number of times. Nothing is applied until one consistent set is available.
 */
export async function refreshAllServerResources(
  options: ServerResourceRefreshOptions = {},
): Promise<ServerResourceRefreshResult> {
  options = captureRefreshOptions(options)
  const requestFences = captureCompleteResourceReadFences()
  for (let attempt = 0; attempt < FULL_RESOURCE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
    if (!refreshIsCurrent(options)) return { status: 'unavailable' }
    const [settings, collections, characters, inlayCatalog] = await Promise.all([
      fetchServerSettings(options.signal),
      fetchServerCollections(options.signal),
      fetchServerCharacters(options.signal),
      fetchServerInlayCatalog(options.signal),
    ])
    if (!refreshIsCurrent(options)) return { status: 'unavailable' }

    if (settings.status !== 'ok') return failedRead(settings)
    if (collections.status !== 'ok') return failedRead(collections)
    if (characters.status !== 'ok') return failedRead(characters)
    if (inlayCatalog.status !== 'ok') return failedRead(inlayCatalog)

    const revisions = new Set([settings.revision, collections.revision, characters.revision, inlayCatalog.revision])
    if (revisions.size !== 1) continue

    const revision = settings.revision
    // Reader full refreshes keep their usable transcript until optional loaded
    // read owners have also succeeded. Do not re-stub chats before a failed
    // BardWiki read that would leave the refresh unacknowledged.
    const readerBardWiki =
      options.mode === 'reader'
        ? await refreshAllLoadedBardWikiResources(revision, options.signal, options.isCurrent)
        : null
    if (!refreshIsCurrent(options)) return { status: 'unavailable' }
    if (readerBardWiki && readerBardWiki.status !== 'ok') return readerBardWiki
    // Any full-refresh apply attempt can replace optimistic projections, even
    // when a later slice rejects the response. Invalidate local-effect tokens
    // before touching the first slice so partial failures also fail closed.
    createDestructiveRefreshToken('full-server-resource-refresh')
    try {
      // Compute every fence before applying any sibling. A successful settings
      // apply, for example, must not make the collections response from the
      // same consistent read set appear superseded.
      const superseded = {
        settings: requestFences.settings.isSuperseded(),
        collections: requestFences.collections.isSuperseded(),
        characters: requestFences.characters.isSuperseded(),
      }
      if (options.mode === 'reader' && Object.values(superseded).some(Boolean)) {
        return { status: 'error', error: 'Reader resource refresh was superseded before apply' }
      }
      const mergedSettings = withPendingAgentPresetSettings(
        withPendingPluginProvider(settings, options.hooks?.mergePendingPluginProvider),
        options.hooks?.mergePendingAgentPresetSettings,
      )
      const mergedCollections = withPendingCollections(collections, options.hooks)
      const mergedCharacters = withPendingAgentPresetCharacters(characters, options.hooks)
      const settingsApplied = !superseded.settings && applySettingsResource(mergedSettings)
      const collectionsApplied = !superseded.collections && applyCollectionsResource(mergedCollections)
      // A complete refresh is used for startup, revision gaps, restores, and
      // unknown resources. Character reads intentionally omit transcripts,
      // so retaining same-id resident bodies here could preserve stale chat
      // data across a restore. Leave the chats as API-hydration stubs.
      const charactersApplied =
        !superseded.characters && applyCharactersResource(mergedCharacters, { preserveResidentChatBodies: false })
      if (charactersApplied) options.onFullProjectionApplied?.()
      const inlayCatalogApplied = applyServerInlayCatalogResource(inlayCatalog, { force: true })
      options.hooks?.reapplyPendingPresetProjections?.()
      options.hooks?.reapplyPendingPromptTemplateStructuralProjections?.()
      if (collectionsApplied) resetPromptTemplateHydration()
      if (!superseded.settings && (settingsApplied || settingsFullAlreadyAtLeast(revision))) {
        hydrateLorebookPageOwnerFromResidentSettings()
      }
      if (collectionsApplied) options.hooks?.recordCanonicalLorebookCollections?.(SERVER_COLLECTION_NAMES)
      if (charactersApplied) options.hooks?.recordCanonicalCharacterLorebookScopes?.(mergedCharacters.characters)
      if (
        (!superseded.settings && !settingsApplied && !settingsFullAlreadyAtLeast(revision)) ||
        (!superseded.collections && !collectionsApplied && !collectionsAlreadyAtLeast(revision)) ||
        (!superseded.characters && !charactersApplied && !charactersAlreadyAtLeast(revision)) ||
        !inlayCatalogApplied
      ) {
        return { status: 'error', error: 'Failed to apply a complete server resource refresh' }
      }
      const bardWiki =
        readerBardWiki ?? (await refreshAllLoadedBardWikiResources(revision, options.signal, options.isCurrent))
      if (!refreshIsCurrent(options)) return { status: 'unavailable' }
      if (bardWiki.status !== 'ok') return bardWiki
      return {
        status: 'ok',
        revision: options.mode === 'reader' ? revision : Math.max(revision, bardWiki.revision),
        scope: 'full',
      }
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    status: 'error',
    error: `Server resource revisions did not converge after ${FULL_RESOURCE_REFRESH_MAX_ATTEMPTS} attempts`,
  }
}

/**
 * Refresh only the resource slices invalidated by one command event or a
 * coalesced, contiguous event batch. Unknown/sprawling resources, revision
 * gaps, and events missing required entity ids use a complete refresh.
 */
export async function refreshInvalidatedServerResources(
  events: CommandEvent | readonly CommandEvent[],
  options: ServerResourceInvalidationOptions = {},
): Promise<ServerResourceRefreshResult> {
  options = captureRefreshOptions(options)
  if (!refreshIsCurrent(options)) return { status: 'unavailable' }
  const batch = Array.isArray(events) ? [...events] : [events]
  if (batch.length === 0) {
    const revision = normalizeAppliedRevision(options.appliedRevision)
    return revision === null
      ? { status: 'error', error: 'At least one command event is required' }
      : { status: 'ok', revision, scope: 'none' }
  }

  const normalized = normalizeEventBatch(batch, options.appliedRevision)
  if (normalized.kind === 'error') return { status: 'error', error: normalized.error }
  if (normalized.kind === 'none') return { status: 'ok', revision: normalized.revision, scope: 'none' }
  if (normalized.kind === 'full') return refreshAllServerResources(options)

  const plan = createRefreshPlan()
  for (const event of normalized.events) {
    if (options.mode === 'reader' && event.resource === 'characterSelection') continue
    addEventToRefreshPlan(plan, event)
    if (plan.full) return refreshAllServerResources(options)
  }
  retainLoadedRefreshTargets(plan)

  const missingHook = missingRequiredHook(plan, options.hooks, options.mode)
  if (missingHook) {
    return { status: 'error', error: `Server resource invalidation requires the ${missingHook} hook` }
  }

  return executeTargetedRefreshPlan(plan, options, normalized.revision, normalized.revision)
}

/**
 * Re-read exact resource owners when a conservative optimistic rollback fence
 * cannot safely restore a field. Unlike command-event invalidation, this path
 * does not require a synthetic revision because every response is still
 * guarded by its owning resource revision during apply.
 */
export async function refreshServerResourceTargets(
  input: ServerResourceTargetRefreshInput,
  options: ServerResourceRefreshOptions = {},
): Promise<ServerResourceRefreshResult> {
  options = captureRefreshOptions(options)
  const plan = createRefreshPlan()
  for (const characterId of new Set(input.characterIds ?? [])) {
    if (!nonEmptyString(characterId)) return { status: 'error', error: 'Character id is required' }
    plan.characterIds.add(characterId)
  }
  for (const name of new Set(input.collections ?? [])) plan.collections.add(name)
  for (const group of new Set(input.settingsGroups ?? [])) plan.settingsGroups.add(group)
  for (const setting of new Set(input.standaloneSettings ?? [])) plan.standaloneSettings.add(setting)
  plan.inlayCatalog = input.inlayCatalog === true

  if (
    plan.characterIds.size === 0 &&
    plan.collections.size === 0 &&
    plan.settingsGroups.size === 0 &&
    plan.standaloneSettings.size === 0 &&
    !plan.inlayCatalog
  ) {
    return { status: 'ok', revision: 0, scope: 'none' }
  }

  const missingHook = missingRequiredHook(plan, options.hooks)
  if (missingHook) {
    return { status: 'error', error: `Server resource invalidation requires the ${missingHook} hook` }
  }

  return executeTargetedRefreshPlan(plan, options, input.minimumRevision)
}

async function executeTargetedRefreshPlan(
  plan: RefreshPlan,
  options: ServerResourceRefreshOptions,
  minimumRevision?: number,
  reportedRevision?: number,
): Promise<ServerResourceRefreshResult> {
  const completed = await runTargetedReads(plan, options.signal)
  if (!refreshIsCurrent(options)) return { status: 'unavailable' }
  // Snapshot supersession before applying any sibling result. Character-shell
  // applies advance their own projection epochs, but must not make a body read
  // from this same completed batch appear stale.
  const readSupersessions = snapshotTargetedReadSupersessions(completed)
  const failed = firstFailedTargetedRead(completed)
  if (failed) return failed
  if (
    options.mode === 'reader' &&
    (readSupersessions.generic.size > 0 ||
      readSupersessions.chatIds.size > 0 ||
      readSupersessions.characterLorebookIds.size > 0)
  ) {
    return { status: 'error', error: 'Reader resource refresh was superseded before apply' }
  }

  for (const entry of completed) {
    if (entry.result.status !== 'ok') continue
    if (minimumRevision !== undefined && entry.result.revision < minimumRevision) {
      return {
        status: 'error',
        error: `Server ${targetedReadLabel(entry)} response revision ${entry.result.revision} is older than event revision ${minimumRevision}`,
      }
    }
  }

  if (completed.length > 0) {
    try {
      let failedApply: string | null = null
      for (const entry of completed) {
        if (!refreshIsCurrent(options)) return { status: 'unavailable' }
        if (entry.result.status !== 'ok') continue
        if (!applyTargetedRead(entry, readSupersessions, options.hooks)) {
          failedApply = targetedReadLabel(entry)
          break
        }
      }
      options.hooks?.reapplyPendingPresetProjections?.()
      options.hooks?.reapplyPendingPromptTemplateStructuralProjections?.()
      if (failedApply) {
        return { status: 'error', error: `Failed to apply server ${failedApply} response` }
      }
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }

  const responseRevision =
    reportedRevision ??
    completed.reduce(
      (latest, entry) => (entry.result.status === 'ok' ? Math.max(latest, entry.result.revision) : latest),
      minimumRevision ?? 0,
    )
  const promptTemplateRefreshError = await refreshInvalidatedPromptTemplateOwners(plan, responseRevision, options)
  if (!refreshIsCurrent(options)) return { status: 'unavailable' }
  if (promptTemplateRefreshError) return { status: 'error', error: promptTemplateRefreshError }
  if (plan.promptTemplateOwnerIds.size > 0 || plan.refreshSelectedPromptTemplate) {
    options.hooks?.reapplyPendingPresetProjections?.()
    options.hooks?.reapplyPendingPromptTemplateStructuralProjections?.()
  }

  if (plan.chatIds.size > 0 || plan.generationChatMessageIds.size > 0) {
    options.hooks?.triggerOpenChatGenerationReattach?.()
  }
  for (const messageId of plan.translatedMessageIds) options.hooks?.clearActiveMessageTranslation?.(messageId)
  for (const characterId of plan.greetingTranslationCharacterIds) {
    const refreshed = await options.hooks?.refreshGreetingTranslations?.(
      characterId,
      minimumRevision ?? responseRevision,
    )
    if (!refreshIsCurrent(options)) return { status: 'unavailable' }
    if (!refreshed) {
      return { status: 'error', error: `Failed to refresh greeting translations for ${characterId}` }
    }
  }

  let bardWikiRevision = responseRevision
  for (const chatId of plan.bardWikiChatIds) {
    const documentIds = plan.bardWikiDocumentIds.get(chatId)
    const refreshed = await refreshLoadedBardWikiChat(
      chatId,
      documentIds ? [...documentIds] : [],
      minimumRevision ?? responseRevision,
      options.signal,
      options.isCurrent,
    )
    if (!refreshIsCurrent(options)) return { status: 'unavailable' }
    if (refreshed.status !== 'ok') return refreshed
    bardWikiRevision = Math.max(bardWikiRevision, refreshed.revision)
  }

  return { status: 'ok', revision: options.mode === 'reader' ? responseRevision : bardWikiRevision, scope: 'targeted' }
}

function createRefreshPlan(): RefreshPlan {
  return {
    bardWikiChatIds: new Set(),
    bardWikiDocumentIds: new Map(),
    inlayCatalog: false,
    settings: false,
    settingsGroups: new Set(),
    standaloneSettings: new Set(),
    collections: new Set(),
    allCharacters: false,
    characterIds: new Set(),
    characterOrder: false,
    characterSelectionIds: new Set(),
    chatIds: new Set(),
    generationChatMessageIds: new Map(),
    lorebookCharacterIds: new Set(),
    translatedMessageIds: new Set(),
    greetingTranslationCharacterIds: new Set(),
    promptTemplateOwnerIds: new Set(),
    legacyPresetIds: new Set(),
    refreshSelectedPromptTemplate: false,
    full: false,
  }
}

const SHELL_SETTINGS_GROUPS = new Set<SettingsGroup>(
  SERVER_SHELL_SETTINGS_KEYS.map((key) => SERVER_SETTINGS_GROUP_BY_KEY[key]).filter(
    (group): group is SettingsGroup => group !== undefined,
  ),
)

/**
 * A contiguous event advances the global cursor even when its resource is not
 * resident. Re-read loaded or actively loading projections: a pending route
 * read may predate this event. Gap/restore recovery bypasses this filter and
 * remains a complete authoritative refresh.
 */
function retainLoadedRefreshTargets(plan: RefreshPlan): void {
  for (const chatId of [...plan.bardWikiChatIds]) {
    if (!isBardWikiChatResourceLoaded(chatId)) {
      plan.bardWikiChatIds.delete(chatId)
      plan.bardWikiDocumentIds.delete(chatId)
    }
  }
  for (const [chatId, documentIds] of plan.bardWikiDocumentIds) {
    for (const documentId of [...documentIds]) {
      if (!isBardWikiDocumentResourceLoaded(chatId, documentId)) documentIds.delete(documentId)
    }
  }
  if (plan.settings && settingsResourceState.fullRevision === null) {
    plan.settings = false
    for (const group of Object.keys(settingsResourceState.groupStatuses)) {
      if (isSettingsGroup(group) && isLoadedOrLoading(settingsResourceState.groupStatuses[group])) {
        plan.settingsGroups.add(group)
      }
    }
    for (const group of SHELL_SETTINGS_GROUPS) plan.settingsGroups.add(group)
    for (const [setting, status] of Object.entries(settingsResourceState.standaloneStatuses)) {
      if (isLoadedOrLoading(status)) plan.standaloneSettings.add(setting as ServerStandaloneSettingName)
    }
  }

  for (const group of [...plan.settingsGroups]) {
    if (!isLoadedOrLoading(settingsResourceState.groupStatuses[group]) && !SHELL_SETTINGS_GROUPS.has(group)) {
      plan.settingsGroups.delete(group)
    }
  }
  for (const setting of [...plan.standaloneSettings]) {
    if (!isLoadedOrLoading(settingsResourceState.standaloneStatuses[setting])) plan.standaloneSettings.delete(setting)
  }
  for (const name of [...plan.collections]) {
    if (!isLoadedOrLoading(collectionsResourceState.statuses[name])) plan.collections.delete(name)
  }

  if (plan.inlayCatalog && getServerInlayCatalogResource() === null) plan.inlayCatalog = false

  for (const characterId of [...plan.characterIds]) {
    const resident = charactersResourceState.characters.find((candidate) => candidate?.chaId === characterId)
    if (!resident) {
      plan.characterIds.delete(characterId)
      continue
    }
    if ((resident as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true) {
      plan.characterIds.delete(characterId)
      plan.allCharacters = true
    }
  }
  for (const chatId of [...plan.chatIds]) {
    if (!isChatBodyResourceLoaded(chatId) && !residentChatBodyHasContent(chatId)) plan.chatIds.delete(chatId)
  }
  for (const chatId of [...plan.generationChatMessageIds.keys()]) {
    if (!isChatBodyResourceLoaded(chatId) && !residentChatBodyHasContent(chatId)) {
      plan.generationChatMessageIds.delete(chatId)
    }
  }
  for (const characterId of [...plan.lorebookCharacterIds]) {
    if (!isCharacterLorebookBodyResourceLoaded(characterId) && !residentCharacterLorebookIsLoaded(characterId)) {
      plan.lorebookCharacterIds.delete(characterId)
    }
  }
  for (const ownerId of [...plan.promptTemplateOwnerIds]) {
    if (!isPromptTemplateHydrated(ownerId)) plan.promptTemplateOwnerIds.delete(ownerId)
  }
  if (plan.refreshSelectedPromptTemplate && !isPromptTemplateHydrated(currentPromptTemplateOwnerId())) {
    plan.refreshSelectedPromptTemplate = false
  }
}

function residentChatBodyHasContent(chatId: string): boolean {
  return charactersResourceState.characters.some((character) =>
    character.chats?.some((chat) => chat.id === chatId && Array.isArray(chat.message) && chat.message.length > 0),
  )
}

function isLoadedOrLoading(status: string | undefined): boolean {
  return status === 'ready' || status === 'loading'
}

function residentCharacterLorebookIsLoaded(characterId: string): boolean {
  const character = charactersResourceState.characters.find((candidate) => candidate?.chaId === characterId)
  return (
    !!character &&
    (character as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] !== true &&
    Array.isArray(character.globalLore)
  )
}

function addEventToRefreshPlan(plan: RefreshPlan, event: CommandEvent): void {
  const addCharacter = (characterId: string | undefined): void => {
    if (!nonEmptyString(characterId)) {
      plan.full = true
      return
    }
    if (!plan.allCharacters) plan.characterIds.add(characterId)
  }
  const addChat = (chatId: string | undefined): void => {
    if (!nonEmptyString(chatId)) {
      plan.full = true
      return
    }
    plan.chatIds.add(chatId)
    plan.generationChatMessageIds.delete(chatId)
  }
  const addGenerationChat = (chatId: string | undefined, messageId: string | undefined): void => {
    if (!nonEmptyString(chatId)) {
      plan.full = true
      return
    }
    if (plan.chatIds.has(chatId)) return
    if (!nonEmptyString(messageId) || plan.generationChatMessageIds.has(chatId)) {
      // A missing anchor or two generation writes in one chat cannot be safely
      // represented by one suffix: later revision order need not match message
      // sequence order. Fall back to one authoritative full transcript.
      addChat(chatId)
      return
    }
    plan.generationChatMessageIds.set(chatId, messageId)
  }
  const addLorebook = (characterId: string | undefined): void => {
    if (!nonEmptyString(characterId)) {
      plan.full = true
      return
    }
    plan.lorebookCharacterIds.add(characterId)
  }
  const addAllCharacters = (): void => {
    plan.allCharacters = true
    plan.characterIds.clear()
  }
  const addFullSettings = (): void => {
    plan.settings = true
    plan.settingsGroups.clear()
  }
  const addSettingsGroup = (group: SettingsGroup): void => {
    if (plan.settings) return
    if (group === 'providers') {
      // The writable provider group is a superset of the read-only model
      // profile slice. One provider read therefore satisfies both
      // invalidations, regardless of which event reached the plan first.
      plan.settingsGroups.delete('models')
      plan.settingsGroups.add(group)
      return
    }
    if (group === 'models' && plan.settingsGroups.has('providers')) return
    plan.settingsGroups.add(group)
  }
  const addLegacyPresetId = (presetId: string | undefined): void => {
    if (nonEmptyString(presetId)) plan.legacyPresetIds.add(presetId)
  }
  const addChangedLegacyPresetIds = (): void => {
    switch (event.type) {
      case 'preset.reordered':
        return
      case 'preset.selected':
      case 'preset.deleted':
        // Selection changes only snapshot the outgoing preset. A deletion id
        // disappears from the authoritative shells and is filtered later.
        addLegacyPresetId(event.parentId)
        return
      default:
        addLegacyPresetId(event.id)
        addLegacyPresetId(event.parentId)
    }
  }

  switch (event.resource) {
    case 'bardWikiChat':
      if (!nonEmptyString(event.id)) {
        plan.full = true
        return
      }
      plan.bardWikiChatIds.add(event.id)
      return
    case 'bardWikiDocument':
      if (!nonEmptyString(event.id) || !nonEmptyString(event.parentId)) {
        plan.full = true
        return
      }
      plan.bardWikiChatIds.add(event.parentId)
      if (!plan.bardWikiDocumentIds.has(event.parentId)) plan.bardWikiDocumentIds.set(event.parentId, new Set())
      plan.bardWikiDocumentIds.get(event.parentId)?.add(event.id)
      return
    case 'asset':
    case 'revisionOnly':
      return
    case 'inlayCatalog':
      plan.inlayCatalog = true
      return
    case 'settings':
      if (!isSettingsGroup(event.id)) {
        plan.full = true
        return
      }
      addSettingsGroup(event.id)
      return
    case 'modelProfile':
    case 'providerCredential':
      addSettingsGroup('models')
      return
    case 'agentPreset':
      if (!isWellFormedAgentPresetEvent(event)) {
        plan.full = true
        return
      }
      addSettingsGroup('agents')
      return
    case 'prompt':
      addSettingsGroup('prompt')
      return
    case 'moduleEnabled':
      addSettingsGroup('modules')
      return
    case 'moduleFolders':
      addSettingsGroup('modules')
      return
    case 'moduleOrganization':
      addSettingsGroup('modules')
      plan.collections.add('modules')
      return
    case 'settingsWithHypaV3Presets':
      if (event.id !== 'memory') {
        plan.full = true
        return
      }
      addSettingsGroup('memory')
      plan.collections.add('hypaV3Presets')
      return
    case 'character':
      addAllCharacters()
      return
    case 'characterOrder':
      plan.characterOrder = true
      return
    case 'characterSelection':
      if (!nonEmptyString(event.id)) {
        plan.full = true
        return
      }
      plan.characterSelectionIds.add(event.id)
      return
    case 'characterRow':
      addCharacter(event.parentId ?? event.id)
      return
    case 'greetingTranslation':
      if (!nonEmptyString(event.id)) {
        plan.full = true
        return
      }
      plan.greetingTranslationCharacterIds.add(event.id)
      return
    case 'scriptDefinition':
    case 'triggerDefinition':
      addCharacter(event.id)
      return
    case 'chat':
    case 'chatFolder':
      addCharacter(event.parentId)
      return
    case 'chatTranscript':
      addCharacter(event.parentId)
      addChat(event.id)
      return
    case 'message':
      if (nonEmptyString(event.id)) plan.translatedMessageIds.add(event.id)
      addChat(event.parentId)
      return
    case 'generation':
      addGenerationChat(event.parentId, event.id)
      return
    case 'characterLorebook':
      addLorebook(event.id)
      return
    case 'presetRow':
      if (!nonEmptyString(event.id)) {
        plan.full = true
        return
      }
      addLegacyPresetId(event.id)
      return
    case 'presetCollection':
      plan.collections.add('botPresets')
      addChangedLegacyPresetIds()
      return
    case 'presetCollectionWithPointer':
      addFullSettings()
      plan.collections.add('botPresets')
      addChangedLegacyPresetIds()
      return
    case 'presetPointer':
      addFullSettings()
      addLegacyPresetId(event.parentId)
      return
    case 'preset':
    case 'presetApplied':
      addFullSettings()
      plan.collections.add('botPresets')
      addChangedLegacyPresetIds()
      return
    case 'modelPreset': {
      const hasEntityId = nonEmptyString(event.id) && event.parentId === undefined
      switch (event.type) {
        case 'modelPreset.created':
        case 'modelPreset.imported':
          if (!hasEntityId) break
          // These append a row without selecting or applying it.
          plan.collections.add('modelPresets')
          return
        case 'modelPreset.selected':
          if (!hasEntityId) break
          // Selection applies the preset to settings, but does not rewrite the
          // preset collection.
          addFullSettings()
          return
        case 'modelPreset.updated':
          if (!hasEntityId) break
          // An update can project a selected row into settings.
          addFullSettings()
          plan.collections.add('modelPresets')
          return
        case 'modelPreset.deleted':
          if (!hasEntityId) break
          // Deletion can move the selected pointer and atomically rehome chat,
          // loadout, and prompt-recommendation references.
          addFullSettings()
          plan.collections.add('modelPresets')
          plan.collections.add('promptPresets')
          plan.collections.add('loadouts')
          addAllCharacters()
          return
        case 'modelPreset.reordered':
          if (event.id !== undefined || event.parentId !== undefined) break
          // Reordering always rewrites the collection and can move the
          // selected preset's numeric settings pointer.
          addFullSettings()
          plan.collections.add('modelPresets')
          return
      }
      plan.full = true
      return
    }
    case 'promptPreset': {
      const hasEntityId = nonEmptyString(event.id) && event.parentId === undefined
      switch (event.type) {
        case 'promptPreset.created':
        case 'promptPreset.imported':
          if (!hasEntityId) break
          // Replacing the shell collection removes every resident prompt body,
          // including the still-selected owner's body.
          plan.collections.add('promptPresets')
          plan.refreshSelectedPromptTemplate = true
          return
        case 'promptPreset.selected':
          if (!hasEntityId) break
          // Selection applies settings and may replace the root prompt table,
          // but does not rewrite the preset collection.
          addFullSettings()
          plan.refreshSelectedPromptTemplate = true
          return
        case 'promptPreset.updated':
          if (!hasEntityId) break
          // Updating a selected preset can project both settings and its prompt body.
          addFullSettings()
          plan.collections.add('promptPresets')
          plan.refreshSelectedPromptTemplate = true
          return
        case 'promptPreset.deleted':
          if (!hasEntityId) break
          // Deletion can apply a replacement prompt body and atomically rehome
          // chat and loadout generation references.
          addFullSettings()
          plan.collections.add('promptPresets')
          plan.collections.add('loadouts')
          plan.refreshSelectedPromptTemplate = true
          addAllCharacters()
          return
        case 'promptPreset.reordered':
          if (event.id !== undefined || event.parentId !== undefined) break
          // Reordering moves the numeric pointer and replaces the body-free
          // shell collection, so restore the selected owner's prompt body.
          addFullSettings()
          plan.collections.add('promptPresets')
          plan.refreshSelectedPromptTemplate = true
          return
      }
      plan.full = true
      return
    }
    case 'legacyBotPreset':
      addFullSettings()
      plan.collections.add('botPresets')
      plan.collections.add('modelPresets')
      plan.collections.add('promptPresets')
      plan.refreshSelectedPromptTemplate = true
      return
    case 'promptItem':
      if (nonEmptyString(event.parentId)) {
        plan.promptTemplateOwnerIds.add(event.parentId)
      } else {
        plan.collections.add('promptTemplate')
      }
      return
    case 'persona':
      addFullSettings()
      plan.collections.add('personas')
      if (event.type === 'persona.deleted') {
        plan.collections.add('loadouts')
        addAllCharacters()
      }
      return
    case 'translatorPreset':
      addSettingsGroup('language')
      plan.collections.add('translatorPresets')
      return
    case 'loadout':
      if (
        event.type !== 'loadout.created' &&
        event.type !== 'loadout.updated' &&
        event.type !== 'loadout.deleted' &&
        event.type !== 'loadout.favorited' &&
        event.type !== 'loadout.touched'
      ) {
        plan.full = true
        return
      }
      if (event.type === 'loadout.touched') addSettingsGroup('sidebar')
      plan.collections.add('loadouts')
      return
    case 'globalLorebook':
      if (event.parentId !== undefined) {
        plan.full = true
        return
      }
      if (
        event.type === 'lorebook.created' ||
        event.type === 'lorebook.updated' ||
        event.type === 'lorebook.entries.replaced'
      ) {
        if (!nonEmptyString(event.id)) {
          plan.full = true
          return
        }
        plan.collections.add('loreBook')
        return
      }
      if (event.type === 'lorebook.selected') {
        if (!nonEmptyString(event.id)) {
          plan.full = true
          return
        }
        addFullSettings()
        return
      }
      if (event.type === 'lorebook.deleted') {
        if (!nonEmptyString(event.id)) {
          plan.full = true
          return
        }
        addFullSettings()
        plan.collections.add('loreBook')
        return
      }
      if (event.type === 'lorebook.reordered' && event.id === undefined) {
        addFullSettings()
        plan.collections.add('loreBook')
        return
      }
      plan.full = true
      return
    case 'moduleCreated':
    case 'moduleUpdated':
    case 'moduleReordered':
    case 'moduleScriptDefinition':
    case 'moduleTriggerDefinition':
      plan.collections.add('modules')
      return
    case 'module':
      addSettingsGroup('modules')
      plan.collections.add('modules')
      plan.collections.add('personas')
      plan.collections.add('loadouts')
      addAllCharacters()
      return
    case 'pluginCollection':
      plan.collections.add('plugins')
      return
    case 'pluginProvider':
      addSettingsGroup('providers')
      return
    case 'pluginCollectionWithProvider':
      addSettingsGroup('providers')
      plan.collections.add('plugins')
      return
    case 'plugin':
      // Compatibility with retained events from older servers.
      addFullSettings()
      plan.collections.add('plugins')
      return
    case 'pluginStorage':
      plan.collections.add('pluginCustomStorage')
      return
    case 'agentPresetDeleted':
      if (!isWellFormedAgentPresetDeleteEvent(event)) {
        plan.full = true
        return
      }
      addSettingsGroup('agents')
      plan.collections.add('loadouts')
      addAllCharacters()
      return
    case 'lorebook':
    case 'state':
    default:
      plan.full = true
  }
}

function isWellFormedAgentPresetEvent(event: CommandEvent): boolean {
  const hasId = nonEmptyString(event.id)
  const hasParentId = nonEmptyString(event.parentId)
  switch (event.type) {
    case 'agent.created':
    case 'agent.updated':
    case 'agent.deleted':
    case 'agentPreset.created':
    case 'agentPreset.updated':
      return hasId && event.parentId === undefined
    case 'agent.duplicated':
    case 'agentPreset.duplicated':
      return hasId && hasParentId
    case 'agent.reordered':
    case 'agentPreset.reordered':
      return event.id === undefined && event.parentId === undefined
    case 'agentPreset.default.updated':
      return (event.id === undefined || hasId) && event.parentId === undefined
    case 'agentPreset.step.created':
    case 'agentPreset.step.updated':
    case 'agentPreset.step.duplicated':
    case 'agentPreset.step.deleted':
    case 'agentPreset.use.created':
    case 'agentPreset.use.updated':
    case 'agentPreset.use.deleted':
      return hasId && hasParentId
    case 'agentPreset.use.reordered':
    case 'agentPreset.step.reordered':
      return hasId && event.parentId === undefined
    default:
      return false
  }
}

function isWellFormedAgentPresetDeleteEvent(event: CommandEvent): boolean {
  return event.type === 'agentPreset.deleted' && nonEmptyString(event.id) && event.parentId === undefined
}

interface CompleteResourceReadFences {
  settings: ResourceReadFence
  collections: ResourceReadFence
  characters: ResourceReadFence
}

function captureCompleteResourceReadFences(): CompleteResourceReadFences {
  return {
    settings: captureSettingsReadFence(),
    collections: captureResourceReadFence(
      () => SERVER_COLLECTION_NAMES.map((name) => [name, captureCollectionProjectionEpoch(name)] as const),
      () => snapshotFields(collectionsResourceState.values as Record<string, unknown>, SERVER_COLLECTION_NAMES),
    ),
    characters: captureCharactersReadFence({ preserveResidentBodies: false }),
  }
}

function captureSettingsReadFence(): ResourceReadFence {
  return captureResourceReadFence(
    () => captureSettingsProjectionEpoch(),
    () => settingsResourceState.value,
  )
}

function captureSettingsGroupReadFence(group: SettingsGroup): ResourceReadFence {
  const keys = SERVER_SETTINGS_KEYS_BY_GROUP[group]
  return captureResourceReadFence(
    () => captureSettingsGroupProjectionEpoch(group),
    () => snapshotFields(settingsResourceState.value as Record<string, unknown>, keys),
  )
}

function captureStandaloneSettingReadFence(setting: ServerStandaloneSettingName): ResourceReadFence {
  return captureResourceReadFence(
    () => settingsResourceState.standaloneRevisions[setting] ?? null,
    () => snapshotFields(settingsResourceState.value as Record<string, unknown>, [setting]),
  )
}

function captureCollectionReadFence(name: ServerCollectionName): ResourceReadFence {
  return captureResourceReadFence(
    () => captureCollectionProjectionEpoch(name),
    () => snapshotFields(collectionsResourceState.values as Record<string, unknown>, [name]),
  )
}

function captureCharactersReadFence(options: { preserveResidentBodies: boolean }): ResourceReadFence {
  return captureResourceReadFence(
    () => [
      captureCharacterListProjectionEpoch(),
      ...charactersResourceState.characters
        .filter((candidate) => nonEmptyString(candidate?.chaId))
        .map((candidate) => [candidate.chaId, captureCharacterRowProjectionEpoch(candidate.chaId)] as const),
    ],
    () => ({
      characters: options.preserveResidentBodies
        ? charactersResourceState.characters.map(characterRowSnapshotWithoutResidentBodies)
        : charactersResourceState.characters,
      characterOrder: charactersResourceState.characterOrder,
      currentChar: charactersResourceState.currentChar,
    }),
  )
}

function captureCharacterReadFence(characterId: string): ResourceReadFence {
  return captureResourceReadFence(
    () => [captureCharacterListProjectionEpoch(), captureCharacterRowProjectionEpoch(characterId)],
    () =>
      charactersResourceState.characters
        .filter((candidate) => candidate?.chaId === characterId)
        .map(characterRowSnapshotWithoutResidentBodies),
  )
}

function captureCharacterOrderReadFence(): ResourceReadFence {
  return captureResourceReadFence(
    () => captureCharacterListProjectionEpoch(),
    () => charactersResourceState.characterOrder,
  )
}

function captureCharacterSelectionReadFence(characterId: string): ResourceReadFence {
  return captureResourceReadFence(
    () => [captureCharacterListProjectionEpoch(), captureCharacterRowProjectionEpoch(characterId)],
    () => ({
      currentChar: charactersResourceState.currentChar,
      rows: charactersResourceState.characters
        .filter((candidate) => candidate?.chaId === characterId)
        .map((candidate) => ({ chaId: candidate.chaId, lastInteraction: candidate.lastInteraction })),
    }),
  )
}

function captureResourceReadFence(readProjection: () => unknown, readResident: () => unknown): ResourceReadFence {
  const projectionSnapshot = snapshotJson(readProjection())
  const residentSnapshot = snapshotJson(readResident())
  return {
    isSuperseded: () =>
      projectionSnapshot === null ||
      residentSnapshot === null ||
      snapshotJson(readProjection()) !== projectionSnapshot ||
      snapshotJson(readResident()) !== residentSnapshot,
  }
}

function snapshotFields(record: Record<string, unknown>, keys: readonly string[]): unknown[] {
  return keys.map((key) => [key, Object.prototype.hasOwnProperty.call(record, key), record[key]])
}

function characterRowSnapshotWithoutResidentBodies(candidate: ServerCharactersResourcePayload['characters'][number]) {
  return {
    ...candidate,
    chats: candidate.chats?.map(({ message: _message, hypaV3Data: _hypaV3Data, ...chat }) => chat),
  }
}

function snapshotJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return null
  }
}

async function runTargetedReads(
  plan: RefreshPlan,
  signal: AbortSignal | null | undefined,
): Promise<CompletedTargetedRead[]> {
  const reads: Array<Promise<CompletedTargetedRead>> = []
  if (plan.inlayCatalog) {
    reads.push(fetchServerInlayCatalog(signal).then((result) => ({ kind: 'inlayCatalog' as const, result })))
  }
  if (plan.settings) {
    const fence = captureSettingsReadFence()
    reads.push(fetchServerSettings(signal).then((result) => ({ kind: 'settings' as const, fence, result })))
  }
  for (const group of plan.settingsGroups) {
    const fence = captureSettingsGroupReadFence(group)
    reads.push(
      fetchServerSettingsGroup(group, signal).then((result) => ({
        kind: 'settingsGroup' as const,
        group,
        fence,
        result,
      })),
    )
  }
  for (const setting of plan.standaloneSettings) {
    const fence = captureStandaloneSettingReadFence(setting)
    reads.push(
      fetchServerStandaloneSetting(setting, signal).then((result) => ({
        kind: 'standaloneSetting' as const,
        setting,
        fence,
        result,
      })),
    )
  }
  for (const name of plan.collections) {
    if (name === 'botPresets') continue
    const fence = captureCollectionReadFence(name)
    reads.push(
      fetchServerCollection(name, signal).then((result) => ({ kind: 'collection' as const, name, fence, result })),
    )
  }
  const legacyPresetIds = [...plan.legacyPresetIds]
  const legacyPresetBaseline = captureLegacyPresetResourceBaseline(legacyPresetIds)
  const legacyPresetFence = captureCollectionReadFence('botPresets')
  if (plan.collections.has('botPresets')) {
    reads.push(
      readLegacyPresetCollection(legacyPresetIds, legacyPresetBaseline, signal).then((result) => ({
        kind: 'legacyPresetCollection' as const,
        fence: legacyPresetFence,
        result,
      })),
    )
  } else {
    for (const presetId of legacyPresetIds) {
      reads.push(
        fetchServerLegacyPreset(presetId, { signal }).then((result) => ({
          kind: 'legacyPresetRow' as const,
          presetId,
          baseline: legacyPresetBaseline,
          fence: legacyPresetFence,
          result,
        })),
      )
    }
  }
  if (plan.allCharacters) {
    const fence = captureCharactersReadFence({ preserveResidentBodies: true })
    reads.push(fetchServerCharacters(signal).then((result) => ({ kind: 'characters' as const, fence, result })))
  } else {
    for (const characterId of plan.characterIds) {
      const fence = captureCharacterReadFence(characterId)
      reads.push(
        fetchServerCharacter(characterId, signal).then((result) => ({
          kind: 'character' as const,
          characterId,
          fence,
          result,
        })),
      )
    }
    if (plan.characterOrder) {
      const fence = captureCharacterOrderReadFence()
      reads.push(
        fetchServerCharacterOrder(signal).then((result) => ({ kind: 'characterOrder' as const, fence, result })),
      )
    }
    for (const characterId of plan.characterSelectionIds) {
      const fence = captureCharacterSelectionReadFence(characterId)
      reads.push(
        fetchServerCharacterSelection(characterId, signal).then((result) => ({
          kind: 'characterSelection' as const,
          characterId,
          fence,
          result,
        })),
      )
    }
  }
  // The bulk chat endpoint intentionally omits alternates. Invalidation must
  // retain that authoritative swipe/reroll state, so fetch each changed chat
  // concurrently through the single-chat endpoint instead.
  for (const chatId of plan.chatIds) {
    const projectionEpoch = captureChatBodyProjectionEpoch(chatId)
    reads.push(
      fetchServerChatMessages(chatId, { signal }).then((result) => ({
        kind: 'chat' as const,
        chatId,
        projectionEpoch,
        result,
      })),
    )
  }
  for (const [chatId, messageId] of plan.generationChatMessageIds) {
    const projectionEpoch = captureChatBodyProjectionEpoch(chatId)
    reads.push(
      fetchServerGenerationChatMessages(chatId, messageId, { signal }).then((result) => ({
        kind: 'chat' as const,
        chatId,
        projectionEpoch,
        result,
      })),
    )
  }

  const lorebookCharacterIds = [...plan.lorebookCharacterIds]
  if (lorebookCharacterIds.length === 1) {
    const characterId = lorebookCharacterIds[0]
    const projectionEpoch = captureCharacterLorebookBodyProjectionEpoch(characterId)
    reads.push(
      fetchServerCharacterLorebook(characterId, { signal }).then((result) => ({
        kind: 'lorebook' as const,
        characterId,
        projectionEpoch,
        result,
      })),
    )
  } else if (lorebookCharacterIds.length > 1) {
    const projectionEpochs = new Map(
      lorebookCharacterIds.map((characterId) => [
        characterId,
        captureCharacterLorebookBodyProjectionEpoch(characterId),
      ]),
    )
    reads.push(
      fetchServerBulkCharacterLorebooks(lorebookCharacterIds, { signal }).then((result) => ({
        kind: 'lorebooks' as const,
        characterIds: lorebookCharacterIds,
        projectionEpochs,
        result,
      })),
    )
  }
  return Promise.all(reads)
}

async function readLegacyPresetCollection(
  changedPresetIds: readonly string[],
  baseline: ServerLegacyPresetResourceBaseline,
  signal: AbortSignal | null | undefined,
): Promise<LegacyPresetCollectionReadResult> {
  for (let attempt = 0; attempt < FULL_RESOURCE_REFRESH_MAX_ATTEMPTS; attempt += 1) {
    const collection = await fetchServerCollection('botPresets', signal)
    if (collection.status !== 'ok') return collection
    const shells = collection.collections.botPresets
    if (!Array.isArray(shells)) {
      return { status: 'error', error: 'Invalid legacy preset collection response' }
    }
    const shellIds = uniqueLegacyPresetIds(shells)
    if (!shellIds) return { status: 'error', error: 'Invalid legacy preset collection response' }

    const requestedIds = changedPresetIds.filter((presetId) => shellIds.has(presetId))
    const presetReads = await Promise.all(requestedIds.map((presetId) => fetchServerLegacyPreset(presetId, { signal })))
    const failed = presetReads.find((result) => result.status !== 'ok')
    if (failed) return failed
    const rows = presetReads as Array<Extract<LegacyPresetReadResult, { status: 'ok' }>>
    if (rows.some((result) => result.revision !== collection.revision)) continue
    if (
      rows.some((result, index) => result.presetId !== requestedIds[index] || result.preset.id !== requestedIds[index])
    ) {
      return { status: 'error', error: 'Invalid legacy preset row response' }
    }
    return {
      status: 'ok',
      revision: collection.revision,
      shells,
      presetRows: rows.map((result) => result.preset),
      baseline,
    }
  }

  return {
    status: 'error',
    error: `Legacy preset resource revisions did not converge after ${FULL_RESOURCE_REFRESH_MAX_ATTEMPTS} attempts`,
  }
}

function uniqueLegacyPresetIds(rows: readonly unknown[]): Set<string> | null {
  const ids = new Set<string>()
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const presetId = (candidate as Record<string, unknown>).id
    if (!nonEmptyString(presetId) || ids.has(presetId)) return null
    ids.add(presetId)
  }
  return ids
}

interface TargetedReadSupersessions {
  generic: Set<CompletedTargetedRead>
  chatIds: Set<string>
  characterLorebookIds: Set<string>
}

function snapshotTargetedReadSupersessions(completed: readonly CompletedTargetedRead[]): TargetedReadSupersessions {
  const supersessions: TargetedReadSupersessions = {
    generic: new Set(),
    chatIds: new Set(),
    characterLorebookIds: new Set(),
  }
  for (const entry of completed) {
    if ('fence' in entry && entry.fence.isSuperseded()) {
      supersessions.generic.add(entry)
    }
    if (entry.kind === 'chat') {
      if (hasChatBodyProjectionEpochChanged(entry.chatId, entry.projectionEpoch)) {
        supersessions.chatIds.add(entry.chatId)
      }
      continue
    }
    if (entry.kind === 'lorebook') {
      if (hasCharacterLorebookBodyProjectionEpochChanged(entry.characterId, entry.projectionEpoch)) {
        supersessions.characterLorebookIds.add(entry.characterId)
      }
      continue
    }
    if (entry.kind !== 'lorebooks') continue
    for (const characterId of entry.characterIds) {
      const projectionEpoch = entry.projectionEpochs.get(characterId)
      if (
        projectionEpoch !== undefined &&
        hasCharacterLorebookBodyProjectionEpochChanged(characterId, projectionEpoch)
      ) {
        supersessions.characterLorebookIds.add(characterId)
      }
    }
  }
  return supersessions
}

function applyTargetedRead(
  entry: CompletedTargetedRead,
  supersessions: TargetedReadSupersessions,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): boolean {
  switch (entry.kind) {
    case 'inlayCatalog':
      return (
        entry.result.status !== 'ok' ||
        applyServerInlayCatalogResource(entry.result) ||
        (getServerInlayCatalogResource()?.revision ?? -1) >= entry.result.revision
      )
    case 'settings': {
      if (supersessions.generic.has(entry)) return true
      const payload = withPendingAgentPresetSettings(
        withPendingPluginProvider(entry.result, hooks?.mergePendingPluginProvider),
        hooks?.mergePendingAgentPresetSettings,
      )
      if (payload.status !== 'ok') return true
      const applied = applySettingsResource(payload)
      const alreadyApplied = settingsFullAlreadyAtLeast(payload.revision)
      if (applied || alreadyApplied) hydrateLorebookPageOwnerFromResidentSettings()
      return applied || alreadyApplied
    }
    case 'settingsGroup': {
      if (entry.result.status === 'ok' && entry.result.group !== entry.group) return false
      if (supersessions.generic.has(entry)) return true
      const providerPayload =
        entry.group === 'providers'
          ? withPendingPluginProvider(entry.result, hooks?.mergePendingPluginProvider)
          : entry.result
      const payload =
        entry.group === 'agents'
          ? withPendingAgentPresetSettings(providerPayload, hooks?.mergePendingAgentPresetSettings)
          : providerPayload
      return (
        payload.status !== 'ok' ||
        applySettingsGroupResource(payload, SERVER_SETTINGS_KEYS_BY_GROUP[entry.group]) ||
        settingsGroupAlreadyAtLeast(entry.group, payload.revision)
      )
    }
    case 'standaloneSetting': {
      if (entry.result.status === 'ok' && entry.result.setting !== entry.setting) return false
      if (entry.result.status !== 'ok' || supersessions.generic.has(entry)) return true
      const applied = applyStandaloneSettingResource(entry.result)
      const alreadyApplied = (settingsResourceState.standaloneRevisions[entry.setting] ?? -1) >= entry.result.revision
      if (entry.setting === 'loreBookPage' && (applied || alreadyApplied)) {
        hydrateLorebookPageOwnerFromResidentSettings()
      }
      return applied || alreadyApplied
    }
    case 'collection': {
      if (entry.result.status !== 'ok') return true
      if (supersessions.generic.has(entry)) return true
      const payload =
        entry.name === 'pluginCustomStorage' || entry.name === 'plugins' || entry.name === 'loadouts'
          ? withPendingCollections(entry.result, hooks)
          : entry.result
      const applied = applyCollectionsResource(payload, entry.name)
      if (applied) hooks?.recordCanonicalLorebookCollections?.([entry.name])
      if (applied && entry.name === 'promptPresets') resetPromptTemplateHydration()
      const alreadyApplied = (collectionsResourceState.revisions[entry.name] ?? -1) >= entry.result.revision
      if (applied && entry.name === 'promptTemplate') {
        markPromptTemplateProjectionApplied(null, entry.result.revision)
      }
      return applied || alreadyApplied
    }
    case 'legacyPresetRow':
      if (entry.result.status !== 'ok') return true
      if (entry.result.presetId !== entry.presetId || entry.result.preset.id !== entry.presetId) return false
      if (supersessions.generic.has(entry)) return true
      return (
        applyLegacyPresetRowResource({
          revision: entry.result.revision,
          presetId: entry.presetId,
          preset: entry.result.preset,
          baseline: entry.baseline,
        }) || (collectionsResourceState.revisions.botPresets ?? -1) > entry.result.revision
      )
    case 'legacyPresetCollection':
      return (
        entry.result.status !== 'ok' ||
        supersessions.generic.has(entry) ||
        applyLegacyPresetCollectionResource(entry.result) ||
        (collectionsResourceState.revisions.botPresets ?? -1) > entry.result.revision
      )
    case 'characters': {
      if (supersessions.generic.has(entry)) return true
      const payload = withPendingAgentPresetCharacters(entry.result, hooks)
      if (payload.status !== 'ok') return true
      const applied = applyCharactersResource(payload)
      if (applied) hooks?.recordCanonicalCharacterLorebookScopes?.(payload.characters)
      return applied || charactersAlreadyAtLeast(payload.revision)
    }
    case 'character': {
      if (entry.result.status === 'ok' && entry.result.character?.chaId !== entry.characterId) return false
      if (supersessions.generic.has(entry)) return true
      const payload = withPendingAgentPresetCharacter(entry.result, hooks)
      if (payload.status !== 'ok') return true
      const applied = applyCharacterResource(payload)
      if (applied) hooks?.recordCanonicalCharacterLorebookScopes?.([payload.character])
      return applied || characterAlreadyAtLeast(entry.characterId, payload.revision)
    }
    case 'characterOrder':
      return (
        entry.result.status !== 'ok' ||
        supersessions.generic.has(entry) ||
        applyCharacterOrderResource(entry.result) ||
        (charactersResourceState.orderRevision ?? -1) >= entry.result.revision
      )
    case 'characterSelection':
      if (entry.result.status === 'ok' && entry.result.characterId !== entry.characterId) return false
      return (
        entry.result.status !== 'ok' ||
        supersessions.generic.has(entry) ||
        applyCharacterSelectionResource(entry.result) ||
        characterSelectionAlreadyAtLeast(entry.characterId, entry.result.revision)
      )
    case 'chat':
      return (
        entry.result.status !== 'ok' ||
        (entry.result.chatId === entry.chatId &&
          applyChatMessages(entry.result, supersessions.chatIds.has(entry.chatId), hooks))
      )
    case 'lorebook':
      return (
        entry.result.status !== 'ok' ||
        (entry.result.characterId === entry.characterId &&
          applyCharacterLorebook(entry.result, supersessions.characterLorebookIds.has(entry.characterId), hooks))
      )
    case 'lorebooks': {
      const result = entry.result
      if (result.status !== 'ok') return true
      const missing = new Set(result.missing)
      return entry.characterIds.every((characterId) => {
        const superseded = supersessions.characterLorebookIds.has(characterId)
        if (missing.has(characterId)) return superseded
        const character = result.characters.find((candidate) => candidate.characterId === characterId)
        return character
          ? applyCharacterLorebook({ status: 'ok', revision: result.revision, ...character }, superseded, hooks)
          : false
      })
    }
  }
}

function hydrateLorebookPageOwnerFromResidentSettings(): void {
  const revision = Math.max(
    settingsResourceState.loreBookPageRevision ?? -1,
    settingsResourceState.standaloneRevisions.loreBookPage ?? -1,
    settingsResourceState.fullRevision ?? -1,
  )
  if (revision < 0) return
  const settings = settingsResourceState.value as Record<string, unknown>
  lorebookPageOwner.hydrate({
    revision,
    setting: 'loreBookPage',
    state: Object.prototype.hasOwnProperty.call(settings, 'loreBookPage')
      ? { present: true, value: settings.loreBookPage }
      : { present: false },
  })
}

async function refreshInvalidatedPromptTemplateOwners(
  plan: RefreshPlan,
  minimumRevision: number,
  options: ServerResourceRefreshOptions,
): Promise<string | null> {
  const ownerIds = new Set(plan.promptTemplateOwnerIds)
  if (plan.refreshSelectedPromptTemplate) {
    const selectedOwnerId = currentPromptTemplateOwnerId()
    if (selectedOwnerId !== null) ownerIds.add(selectedOwnerId)
  }
  if (ownerIds.size === 0) return null
  if (options.mode === 'reader') {
    for (const ownerId of ownerIds) invalidatePromptTemplateHydration(ownerId)
    return null
  }

  const selectedOwnerId = currentPromptTemplateOwnerId()
  // Prompt-item events update an owner whose complete body is still resident.
  // Keep that body mounted while the forced read revalidates it so a routine
  // value-only acknowledgement cannot destroy the focused editor. Prompt-preset
  // events replace owner shells, so those still require a full invalidation.
  const retainedOwnerIds = plan.refreshSelectedPromptTemplate ? new Set<string>() : new Set(plan.promptTemplateOwnerIds)
  for (const ownerId of ownerIds) {
    if (retainedOwnerIds.has(ownerId)) markPromptTemplateHydrationStale(ownerId)
    else invalidatePromptTemplateHydration(ownerId)
  }
  const ownerIdList = [...ownerIds]
  const results = await Promise.all(
    ownerIdList.map((ownerId) =>
      ensurePromptTemplateHydrated({
        applyProjection: ownerId === selectedOwnerId,
        force: true,
        minimumRevision,
        promptPresetId: ownerId,
      }),
    ),
  )
  if (!refreshIsCurrent(options)) return 'Prompt-template refresh was superseded'
  results.forEach((applied, index) => {
    const ownerId = ownerIdList[index]
    if (!applied && retainedOwnerIds.has(ownerId)) invalidatePromptTemplateHydration(ownerId)
  })
  return results.every(Boolean) ? null : 'Failed to refresh an invalidated prompt-template owner'
}

function applyChatMessages(
  result: Extract<ChatReadResult, { status: 'ok' }>,
  superseded: boolean,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): boolean {
  if (superseded) return true
  const characterId = characterIdForChat(result.chatId)
  if (!characterId) return false
  if (hasNewerChatBodyResourceRevision(result.chatId, result.revision)) return true
  if (!hooks?.applyChatMessages) return false
  const range =
    typeof result.messageStart === 'number' && typeof result.messageTotal === 'number'
      ? { start: result.messageStart, total: result.messageTotal }
      : undefined
  const applied =
    typeof result.hypaV3DataIncluded === 'boolean'
      ? hooks.applyChatMessages(result.chatId, result.message, result.hypaV3Data, result.alternates, range, {
          hypaV3DataIncluded: result.hypaV3DataIncluded,
        })
      : hooks.applyChatMessages(result.chatId, result.message, result.hypaV3Data, result.alternates, range)
  if (applied) markChatBodyResourceRevision(result.chatId, result.revision)
  return applied
}

function applyCharacterLorebook(
  result: Extract<LorebookReadResult, { status: 'ok' }>,
  superseded: boolean,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): boolean {
  if (superseded) return true
  if (!charactersResourceState.characters.some((candidate) => candidate?.chaId === result.characterId)) return false
  if (hasNewerCharacterLorebookBodyResourceRevision(result.characterId, result.revision)) return true
  if (!hooks?.applyCharacterLorebook) return false
  const applied = hooks.applyCharacterLorebook(result.characterId, result.globalLore)
  if (applied) {
    hooks.markCharacterLorebookHydrated?.(result.characterId)
    markCharacterLorebookBodyResourceRevision(result.characterId, result.revision)
    markCharacterLorebookProjectionApplied(result.characterId)
  }
  return applied
}

function characterIdForChat(chatId: string): string | undefined {
  for (const character of charactersResourceState.characters) {
    if (character.chats?.some((candidate) => candidate?.id === chatId)) return character.chaId
  }
  return undefined
}

function withPendingCollections<T extends ServerCollectionsResourcePayload>(
  payload: T,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): T {
  const collections = { ...payload.collections }
  let changed = false
  if (Object.prototype.hasOwnProperty.call(collections, 'pluginCustomStorage')) {
    const current = collections.pluginCustomStorage
    const authoritative = current && typeof current === 'object' && !Array.isArray(current) ? current : {}
    collections.pluginCustomStorage = hooks?.mergePendingPluginStorage
      ? hooks.mergePendingPluginStorage(authoritative)
      : authoritative
    changed = true
  }
  if (Object.prototype.hasOwnProperty.call(collections, 'plugins')) {
    const authoritative = Array.isArray(collections.plugins) ? collections.plugins : []
    collections.plugins = hooks?.mergePendingPluginCollection
      ? hooks.mergePendingPluginCollection(authoritative)
      : authoritative
    changed = true
  }
  if (Object.prototype.hasOwnProperty.call(collections, 'loadouts')) {
    const authoritative = Array.isArray(collections.loadouts) ? collections.loadouts : []
    collections.loadouts = hooks?.mergePendingAgentPresetLoadouts
      ? hooks.mergePendingAgentPresetLoadouts(authoritative)
      : authoritative
    changed = true
  }
  if (!changed) return payload
  return {
    ...payload,
    collections,
  } as T
}

function withPendingAgentPresetSettings<T>(
  payload: T,
  mergePendingAgentPresetSettings: ServerResourceInvalidationHooks['mergePendingAgentPresetSettings'] | undefined,
): T {
  const settingsValue = (payload as { settings?: unknown }).settings
  if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) return payload
  return {
    ...payload,
    settings: mergePendingAgentPresetSettings
      ? mergePendingAgentPresetSettings(settingsValue as Record<string, unknown>)
      : settingsValue,
  } as T
}

function withPendingAgentPresetCharacters<T>(
  payload: T,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): T {
  const characters = (payload as { characters?: unknown }).characters
  if (!Array.isArray(characters)) return payload
  return {
    ...payload,
    characters: hooks?.mergePendingAgentPresetCharacters
      ? hooks.mergePendingAgentPresetCharacters(characters as ServerCharactersResourcePayload['characters'])
      : characters,
  } as T
}

function withPendingAgentPresetCharacter<T>(
  payload: T,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
): T {
  const character = (payload as { character?: unknown }).character
  if (!character || typeof character !== 'object' || Array.isArray(character)) return payload
  const merged = hooks?.mergePendingAgentPresetCharacters
    ? hooks.mergePendingAgentPresetCharacters([character] as ServerCharactersResourcePayload['characters'])
    : [character]
  if (!merged[0]) return payload
  return {
    ...payload,
    character: merged[0],
  } as T
}

function withPendingPluginProvider<T>(
  payload: T,
  mergePendingPluginProvider: ServerResourceInvalidationHooks['mergePendingPluginProvider'] | undefined,
): T {
  const settingsValue = (payload as { settings?: unknown }).settings
  if (!settingsValue || typeof settingsValue !== 'object' || Array.isArray(settingsValue)) return payload
  const settings = settingsValue as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(settings, 'currentPluginProvider')) return payload
  return {
    ...payload,
    settings: {
      ...settings,
      currentPluginProvider: mergePendingPluginProvider
        ? mergePendingPluginProvider(settings.currentPluginProvider)
        : settings.currentPluginProvider,
    },
  } as T
}

function missingRequiredHook(
  plan: RefreshPlan,
  hooks: Partial<ServerResourceInvalidationHooks> | undefined,
  mode?: 'reader',
): keyof ServerResourceInvalidationHooks | null {
  const hasChatReads = plan.chatIds.size > 0 || plan.generationChatMessageIds.size > 0
  if (hasChatReads && !hooks?.applyChatMessages) return 'applyChatMessages'
  if (hasChatReads && mode !== 'reader' && !hooks?.triggerOpenChatGenerationReattach) {
    return 'triggerOpenChatGenerationReattach'
  }
  if (plan.translatedMessageIds.size > 0 && !hooks?.clearActiveMessageTranslation) {
    return 'clearActiveMessageTranslation'
  }
  if (plan.greetingTranslationCharacterIds.size > 0 && !hooks?.refreshGreetingTranslations) {
    return 'refreshGreetingTranslations'
  }
  if (plan.lorebookCharacterIds.size > 0 && !hooks?.applyCharacterLorebook) return 'applyCharacterLorebook'
  if (plan.lorebookCharacterIds.size > 0 && !hooks?.markCharacterLorebookHydrated) {
    return 'markCharacterLorebookHydrated'
  }
  return null
}

function firstFailedTargetedRead(
  reads: readonly CompletedTargetedRead[],
): Exclude<ServerResourceRefreshResult, { status: 'ok' }> | null {
  for (const entry of reads) {
    if (entry.result.status === 'error') return { status: 'error', error: entry.result.error }
    if (entry.result.status === 'unavailable') return { status: 'unavailable' }
  }
  return null
}

function failedRead(
  result: { status: 'error'; error: string } | { status: 'unavailable' },
): Exclude<ServerResourceRefreshResult, { status: 'ok' }> {
  return result.status === 'error' ? { status: 'error', error: result.error } : { status: 'unavailable' }
}

function targetedReadLabel(entry: CompletedTargetedRead): string {
  switch (entry.kind) {
    case 'inlayCatalog':
      return 'inlay catalog'
    case 'settings':
      return 'settings'
    case 'settingsGroup':
      return `${entry.group} settings`
    case 'standaloneSetting':
      return `${entry.setting} setting`
    case 'collection':
      return `${entry.name} collection`
    case 'legacyPresetRow':
      return `legacy preset ${entry.presetId}`
    case 'legacyPresetCollection':
      return 'legacy preset collection'
    case 'characters':
      return 'characters'
    case 'character':
      return `character ${entry.characterId}`
    case 'characterOrder':
      return 'character order'
    case 'characterSelection':
      return `character ${entry.characterId} selection`
    case 'chat':
      return `chat ${entry.chatId}`
    case 'lorebook':
      return `character ${entry.characterId} lorebook`
    case 'lorebooks':
      return `${entry.characterIds.length} character lorebooks`
  }
}

type NormalizedEventBatch =
  | { kind: 'targeted'; events: CommandEvent[]; revision: number }
  | { kind: 'full' }
  | { kind: 'none'; revision: number }
  | { kind: 'error'; error: string }

function normalizeEventBatch(
  events: readonly CommandEvent[],
  appliedRevisionInput: number | null | undefined,
): NormalizedEventBatch {
  if (events.some((event) => !Number.isInteger(event.revision) || event.revision < 0)) {
    return { kind: 'error', error: 'Command event revisions must be non-negative integers' }
  }
  const appliedRevision = normalizeAppliedRevision(appliedRevisionInput)
  if (appliedRevisionInput !== undefined && appliedRevisionInput !== null && appliedRevision === null) {
    return { kind: 'error', error: 'Applied revision must be a non-negative integer or null' }
  }
  if (appliedRevisionInput === null) return { kind: 'full' }

  const sorted = [...events].sort((left, right) => left.revision - right.revision)
  const relevant = appliedRevision === null ? sorted : sorted.filter((event) => event.revision > appliedRevision)
  if (relevant.length === 0) {
    return appliedRevision === null
      ? { kind: 'error', error: 'At least one unapplied command event is required' }
      : { kind: 'none', revision: appliedRevision }
  }

  const revisions = Array.from(new Set(relevant.map((event) => event.revision))).sort((left, right) => left - right)
  if (appliedRevision !== null && revisions[0] !== appliedRevision + 1) return { kind: 'full' }
  for (let index = 1; index < revisions.length; index += 1) {
    if (revisions[index] !== revisions[index - 1] + 1) return { kind: 'full' }
  }

  return { kind: 'targeted', events: relevant, revision: revisions.at(-1) as number }
}

function normalizeAppliedRevision(value: number | null | undefined): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null
}

function settingsFullAlreadyAtLeast(revision: number): boolean {
  return (settingsResourceState.fullRevision ?? -1) >= revision
}

function settingsGroupAlreadyAtLeast(group: SettingsGroup, revision: number): boolean {
  return (
    Math.max(settingsResourceState.fullRevision ?? -1, settingsResourceState.groupRevisions[group] ?? -1) >= revision
  )
}

function collectionsAlreadyAtLeast(revision: number): boolean {
  return (collectionsResourceState.revision ?? -1) >= revision
}

function charactersAlreadyAtLeast(revision: number): boolean {
  return (charactersResourceState.revision ?? -1) >= revision
}

function characterAlreadyAtLeast(characterId: string, revision: number): boolean {
  return (
    Math.max(charactersResourceState.listRevision ?? -1, charactersResourceState.rowRevisions[characterId] ?? -1) >=
    revision
  )
}

function characterSelectionAlreadyAtLeast(characterId: string, revision: number): boolean {
  return (
    charactersResourceState.characters.some((candidate) => candidate?.chaId === characterId) &&
    (charactersResourceState.selectionRevision ?? -1) >= revision &&
    (charactersResourceState.rowRevisions[characterId] ?? -1) >= revision
  )
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
