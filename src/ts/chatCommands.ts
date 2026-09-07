import {
  canUseClientWriteAccess,
  assertClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from './clientSession'
import { get } from 'svelte/store'
import { normalizeChatPageIndex } from '@risuai/shared-core/chat-page'
import {
  canUseServerCommands,
  createChatGenerationSettingsCommandDurableBody,
  appendMessageCommand,
  createChatCommand,
  createChatFolderCommand,
  deleteChatCommand,
  deleteChatFolderCommand,
  deleteMessageCommand,
  forkChatCommand,
  patchChatScriptstateCommand,
  peekAppliedServerResourceRevision,
  reorderChatFoldersCommand,
  reorderChatsCommand,
  resetChatsCommand,
  replaceTailMessagesCommand,
  replaceMessagesCommand,
  runServerCommand,
  runServerCommandSequence,
  saveChatGenerationSettingsCommand,
  truncateMessagesCommand,
  updateChatCommand,
  updateChatFolderCommand,
  updateMessageCommand,
  type ChatFolderSnapshot,
  type ChatScriptstatePatch,
  type ChatScriptstateValue,
  type ChatSnapshot,
  type DurableMutationReplayResult,
  type MessageSnapshot,
  type ServerCommandResult,
  type ServerCommandSequenceEntry,
  type ServerCommandTransportOptions,
  type SaveChatGenerationSettingsCommandInput,
} from './server/commands'
import {
  applyCharacterResource,
  applyChatFolderMetadataOwnerPatch,
  applyChatMetadataOwnerPatch,
  captureChatBodyProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  charactersResourceState,
  getCharacterResourceOwner,
  hasCharacterRowProjectionEpochChanged,
  restoreChatFolderMetadataOwnerSnapshot,
  restoreChatMetadataOwnerSnapshot,
} from './server/resourceState.svelte'
import { fetchServerCharacter } from './server/resourceReads'
import { isServerChatMessagePlaceholder } from './server/chatMessagePlaceholders'
import {
  invalidateOptimisticCreatedChatTranscript,
  isKnownHydratedChatTranscript,
  markOptimisticCreatedChatTranscript,
} from './server/chatStructureHydrationHooks'
import {
  applyAttemptedFieldRollback,
  applyAttemptedKeyedListRollback,
  captureDestructiveRefreshEpoch,
} from './server/staleStateGuards'
import {
  acknowledgePendingChatGenerationSettingsSave,
  clearPendingChatGenerationSettingsSave,
  registerPendingChatGenerationSettingsSave,
} from './server/chatGenerationSettingsResourceGuard'
import { markChatMessageMutationIntent } from './server/chatMessageMutationIntent'
import { reloadGuiDisplay, selectedCharID } from './stores.svelte'
import type { Chat, ChatFolder, Message, character } from './storage/database.svelte'
import {
  applySparseChatGenerationSettingsUpdate,
  diffChatGenerationSettings,
  type ChatGenerationSettings,
  type SparseChatGenerationSettingsUpdate,
} from './chatGenerationSettings'
import { v4 } from 'uuid'
import {
  dispatchDurableMutation,
  executePreparedDurableMutationWithinQueue,
  registerDurableMutationSettlementListener,
} from './server/durableMutationDispatch'
import {
  discardPendingMutation,
  isPendingMutationProjectionFenceCurrent,
  MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  pendingMutationIntentPayloadByteLength,
  pendingMutationModuleEnabledProjectionTarget,
  pendingMutationProjectionFence,
  recordPendingMutationProjectionTargets,
  stagePendingMutation,
  type DurableMutationRequestMethod,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './server/pendingMutationOutbox'
import { flushRegisteredPendingOwnerMutation } from './server/pendingOwnerMutationRegistry'
import {
  characterOwnerMutationKey,
  chatFolderResourceOwnerMutationKey,
  chatResourceOwnerMutationKey,
} from './server/resourceOwnerMutationKeys'
import { chatGenerationSettingsMutationDependencyKeys } from './server/chatGenerationSettingsMutationKeys'
import { translatorPresetOwnerMutationKey } from './server/translatorPresetMutationKeys'
import { registerRetainedChatProjection, type RetainedChatProjectionTarget } from './server/chatRetainedProjection'
import { alertError } from './alert'
import { language } from '../lang'
import { reportWriterAccessLostMutation } from './server/activeWriterSession'
import type { ActiveChatTarget } from './types/activeChatTarget'
import { guardActiveChatGenerationSettingsForSend } from './activeChatGenerationSettings'
import { planImportedChatRequests, type PlannedChatImportRequest } from './chatImportPlanning'

export type { ActiveChatTarget } from './types/activeChatTarget'

export interface ChatStateSnapshot {
  characters: character[]
  selectedCharID: number
}

export type AppendCurrentChatUserMessageResult =
  | { status: 'ok'; messageId: string }
  | { status: 'queued'; messageId: string; settlement: Promise<ChatMutationFinalOutcome> }
  | { status: 'error'; error: string }

export type DeleteMessageScopedFinalResult = { status: 'accepted' } | { status: 'failed'; error: string }

export type DeleteMessageScopedResult =
  | DeleteMessageScopedFinalResult
  | {
      status: 'queued'
      mutationId: string
      settlement: Promise<DeleteMessageScopedFinalResult>
    }

export type ChatImportDispatchResult = { status: 'ok' } | { status: 'error'; error: string }

export type ChatMutationResult = ServerCommandResult | CharacterOwnedDurableBatchResult

export type ChatMutationFinalOutcome =
  | { status: 'accepted' }
  | { status: 'failed'; result: Exclude<DurableMutationReplayResult, { status: 'ok' }> }

export type ChatMutationOutcome =
  | { status: 'accepted'; result: Extract<ChatMutationResult, { status: 'ok' }> }
  | {
      status: 'queued'
      result: Exclude<ChatMutationResult, { status: 'ok' }>
      mutationIds: readonly string[]
      settlement: Promise<ChatMutationFinalOutcome>
    }
  | { status: 'failed'; result: Exclude<ChatMutationResult, { status: 'ok' }> }

export type ChatGenerationSettingsSaveSettlement =
  | { status: 'accepted' }
  | { status: 'queued' }
  | { status: 'failed'; error: string }

export interface ChatGenerationSettingsSaveOperation {
  settlement: Promise<ChatGenerationSettingsSaveSettlement>
}

export const CHAT_IMPORT_TOO_LARGE_ERROR = 'chat_import_too_large'

export interface AppendCurrentChatUserMessageForSendOptions {
  expectedTarget?: ActiveChatTarget | null
}

export type OptimisticGenerationOperationAppendResult =
  | { status: 'ok'; messageId: string; rollback: () => void }
  | { status: 'error'; error: string }

export const CHAT_PATCH_ALLOWED_KEYS = new Set([
  'name',
  'note',
  'sdData',
  'lastMemory',
  'hypaContextTruncationAcknowledged',
  'suggestMessages',
  'bindedPersona',
  'fmIndex',
  'selectedDraftHookId',
  'translatorPresetId',
  'autoTranslate',
  'autoTranslateBotOnly',
  'bilingualDisplay',
  'bilingualEmphasis',
  'folderId',
  'lastDate',
  'bookmarks',
  'bookmarkNames',
  'modules',
  'pinned',
])

export const MESSAGE_PATCH_ALLOWED_KEYS = new Set([
  'role',
  'data',
  'translation',
  'saying',
  'time',
  'promptInfo',
  'name',
  'otherUser',
  'disabled',
  'isComment',
])

export const CHAT_FOLDER_PATCH_ALLOWED_KEYS = new Set(['name', 'color', 'folded'])

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Mutate only a character/chat/message projection that has already been
 * resolved through its stable owner. Unlike the retired trusted aggregate
 * scope, this cannot authorize settings or collection writes.
 */
function withChatOwnerProjectionWrite<T>(callback: () => T): T {
  return callback()
}

function freezeJsonValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeJsonValue(child)
  }
  return Object.freeze(value) as T
}

type DurableChatRequestBody = Record<string, unknown>
const ownedDurableChatRequestBodies = new WeakSet<object>()

function freezeDurableChatRequestBody<T extends DurableChatRequestBody>(body: T): T {
  if (ownedDurableChatRequestBodies.has(body)) return body
  return freezeOwnedDurableChatRequestBody(cloneJsonValue(body))
}

function freezeOwnedDurableChatRequestBody<T extends DurableChatRequestBody>(body: T): T {
  const frozen = freezeJsonValue(body)
  ownedDurableChatRequestBodies.add(frozen)
  return frozen
}

function durableChatMutationIntent(
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
  path: string,
  body: DurableChatRequestBody,
  dependencyKeys: string[] = [],
): DurableMutationIntent {
  return {
    version: 1,
    requests: [{ method, path, body }],
    ...(dependencyKeys.length > 0 ? { dependencyKeys } : {}),
  }
}

function dispatchCharacterOwnedDurableMutation<T extends Record<string, unknown>>(
  characterId: string | undefined,
  intent: DurableMutationIntent,
  dispatch: (options: ServerCommandTransportOptions) => Promise<ServerCommandResult<T>>,
  projectionTargets: readonly string[] = [],
): Promise<ServerCommandResult<T>> {
  if (!characterId || !canUseServerCommands()) return dispatch({})
  const outbox = stagePendingMutation(characterOwnerMutationKey(characterId), intent)
  if (projectionTargets.length > 0) recordPendingMutationProjectionTargets(outbox, projectionTargets)
  return dispatchDurableMutation(outbox, intent, dispatch)
}

interface CharacterOwnedDurableMutationOutcome<T extends Record<string, unknown>> {
  result: ServerCommandResult<T>
  retained: boolean
  mutationId?: string
  settlement?: Promise<ChatMutationFinalOutcome>
}

interface ChatMutationFinalSettlementTracker {
  mutationId: string
  settlement: Promise<ChatMutationFinalOutcome>
  cancel: () => void
}

function trackChatMutationFinalSettlement(outbox: PendingMutationHandle): ChatMutationFinalSettlementTracker | null {
  if (!outbox.databaseLineage) return null

  let cancel = () => {}
  const settlement = new Promise<ChatMutationFinalOutcome>((resolve) => {
    cancel = registerDurableMutationSettlementListener(outbox.mutationId, (finalSettlement, details) => {
      cancel()
      if (finalSettlement === 'accepted') {
        resolve({ status: 'accepted' })
        return
      }
      const result = details.result
      resolve({
        status: 'failed',
        result: result && result.status !== 'ok' ? result : { status: 'unavailable' },
      })
    })
  })
  return { mutationId: outbox.mutationId, settlement, cancel: () => cancel() }
}

function failedChatMutationResult(error: unknown): Exclude<ServerCommandResult, { status: 'ok' }> {
  return {
    status: 'error',
    error: error instanceof Error ? error.message : 'Unable to save the chat change',
    reason: 'invalid-request',
  }
}

function writerAccessLostChatMutationOutcome(): Promise<ChatMutationOutcome> {
  return Promise.resolve({
    status: 'failed',
    result: { status: 'error', error: language.writerAccessLostMutation },
  })
}

async function chatMutationOutcome(
  outcome: Promise<CharacterOwnedDurableMutationOutcome<Record<string, unknown>>>,
): Promise<ChatMutationOutcome> {
  const settled = await outcome
  if (settled.result.status === 'ok') return { status: 'accepted', result: settled.result }
  if (settled.retained && settled.mutationId && settled.settlement) {
    return {
      status: 'queued',
      result: settled.result,
      mutationIds: [settled.mutationId],
      settlement: settled.settlement,
    }
  }
  return { status: 'failed', result: settled.result }
}

function normalizedChatMutationOutcome<T extends Record<string, unknown>>(
  outcome: Promise<CharacterOwnedDurableMutationOutcome<T>>,
  rollback: () => void,
): Promise<ChatMutationOutcome> {
  const normalized = outcome.catch((error): CharacterOwnedDurableMutationOutcome<T> => {
    rollback()
    return { result: failedChatMutationResult(error), retained: false }
  })
  return chatMutationOutcome(normalized).then((settled) => {
    if (settled.status !== 'queued') return settled
    return {
      ...settled,
      settlement: settled.settlement.then((finalSettlement) => {
        if (finalSettlement.status === 'failed') rollback()
        return finalSettlement
      }),
    }
  })
}

async function chatBatchMutationOutcome(
  result: Promise<CharacterOwnedDurableBatchResult>,
): Promise<ChatMutationOutcome> {
  const settled = await result
  if (settled.status === 'ok') return { status: 'accepted', result: settled }
  if (settled.status === 'retained' && settled.mutationIds && settled.settlement) {
    return {
      status: 'queued',
      result: settled,
      mutationIds: settled.mutationIds,
      settlement: settled.settlement,
    }
  }
  return { status: 'failed', result: settled }
}

export interface CharacterOwnedDurableBatchStep {
  method: DurableMutationRequestMethod
  path: string
  body: DurableChatRequestBody
  /** The caller built this body entirely from detached snapshots or fresh scalar values. */
  bodyIsOwned?: boolean
  dependencyKeys?: string[]
  projectionTargets?: string[]
  command: (baseRevision: number, frozenBody: Readonly<DurableChatRequestBody>) => Promise<ServerCommandResult>
  rollback: () => void
  reapply?: (isProjectionTargetCurrent: (target: string) => boolean) => void
}

export type CharacterOwnedDurableBatchResult =
  | { status: 'ok'; acceptedCount: number }
  | {
      status: 'retained'
      acceptedCount: number
      failure: Exclude<ServerCommandResult, { status: 'ok' }>
      mutationIds?: readonly string[]
      settlement?: Promise<ChatMutationFinalOutcome>
    }
  | { status: 'failure'; acceptedCount: number; failure: Exclude<ServerCommandResult, { status: 'ok' }> }

/**
 * Freeze and pre-stage every row before reserving contiguous global-command
 * slots. Later rows reuse the first failure under their own durable locks, so
 * retryable batches retain every projection while terminal failures roll back
 * only the unaccepted suffix.
 */
export async function dispatchCharacterOwnedDurableBatch(
  characterId: string | undefined,
  steps: readonly CharacterOwnedDurableBatchStep[],
): Promise<CharacterOwnedDurableBatchResult> {
  if (!canUseClientWriteAccess()) return { status: 'failure', acceptedCount: 0, failure: { status: 'unavailable' } }
  return dispatchOwnedDurableBatch(
    characterId ? characterOwnerMutationKey(characterId) : undefined,
    steps,
    'Missing character mutation owner',
  )
}

/**
 * Generic form of the durable batch dispatcher for non-chat collections that
 * still need accepted-prefix settlement and suffix-only rollback.
 */
export async function dispatchOwnedDurableBatch(
  ownerKey: string | undefined,
  steps: readonly CharacterOwnedDurableBatchStep[],
  missingOwnerError = 'Missing durable mutation owner',
): Promise<CharacterOwnedDurableBatchResult> {
  if (!canUseClientWriteAccess()) return { status: 'failure', acceptedCount: 0, failure: { status: 'unavailable' } }
  if (steps.length === 0 || !canUseServerCommands()) return { status: 'ok', acceptedCount: 0 }
  const sessionGeneration = captureClientSessionGeneration()
  const canProject = () => canUseClientWriteAccess() && isClientSessionGenerationCurrent(sessionGeneration)

  const definitions = steps.map((step) => {
    const body = step.bodyIsOwned
      ? freezeOwnedDurableChatRequestBody(step.body)
      : freezeDurableChatRequestBody(step.body)
    const intent: DurableMutationIntent = {
      version: 1,
      requests: [{ method: step.method, path: step.path, body }],
      ...(step.dependencyKeys?.length ? { dependencyKeys: cloneJsonValue(step.dependencyKeys) } : {}),
    }
    return {
      ...step,
      body,
      intent,
      rollback: () => {
        if (canProject()) step.rollback()
      },
      reapply: step.reapply
        ? (isProjectionTargetCurrent: (target: string) => boolean) => {
            if (canProject()) step.reapply?.((target) => canProject() && isProjectionTargetCurrent(target))
          }
        : undefined,
    }
  })
  const oversized = definitions.some(
    ({ intent }) => pendingMutationIntentPayloadByteLength(intent) > MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
  )
  if (!ownerKey || oversized) {
    for (let index = definitions.length - 1; index >= 0; index -= 1) definitions[index].rollback()
    return {
      status: 'failure',
      acceptedCount: 0,
      failure: {
        status: 'error',
        error: oversized ? 'Pending mutation payload is too large' : missingOwnerError,
        reason: 'invalid-request',
      },
    }
  }

  const prepared: Array<
    (typeof definitions)[number] & {
      handle: PendingMutationHandle
    }
  > = []
  try {
    for (const definition of definitions) {
      const handle = stagePendingMutation(ownerKey, definition.intent)
      if (definition.projectionTargets?.length) {
        recordPendingMutationProjectionTargets(handle, definition.projectionTargets)
      }
      prepared.push({ ...definition, handle })
    }
  } catch (error) {
    await Promise.all(prepared.map(({ handle }) => discardPendingMutation(handle)))
    for (let index = definitions.length - 1; index >= 0; index -= 1) definitions[index].rollback()
    return {
      status: 'failure',
      acceptedCount: 0,
      failure: {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        reason: 'invalid-request',
      },
    }
  }

  let acceptedCount = 0
  let firstFailure: Exclude<ServerCommandResult, { status: 'ok' }> | undefined
  let readinessFailure: Exclude<ServerCommandResult, { status: 'ok' }> | undefined
  const durableScopeExpected = prepared.some(({ handle }) => handle.databaseLineage !== null)
  const batchReadiness = Promise.all(prepared.map(({ handle }) => handle.ready)).then((statuses) => {
    if (durableScopeExpected && statuses.some((status) => status !== 'persisted')) {
      readinessFailure = {
        status: 'error',
        error: 'Unable to persist the complete durable mutation batch',
        reason: 'invalid-request',
      }
    }
  })
  const outcomePromises = prepared.map(({ handle, intent, command, rollback, body }) =>
    dispatchPreparedCharacterOwnedDurableMutationWithOutcome(
      handle,
      intent,
      (transport) =>
        runServerCommand({
          command: async (baseRevision) => {
            await batchReadiness
            if (readinessFailure) {
              firstFailure ??= readinessFailure
              return firstFailure
            }
            if (firstFailure) return firstFailure
            const result = await command(baseRevision, body)
            if (result.status === 'ok') acceptedCount += 1
            else firstFailure ??= result
            return result
          },
          rollback,
          ...transport,
        }),
      () => firstFailure,
    ),
  )
  const settled = await Promise.allSettled(outcomePromises)
  const outcomes = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  settled.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !result.value.retained) return
    if (result.value.settlement) {
      const finalSettlement = result.value.settlement
      result.value.settlement = finalSettlement.then((outcome) => {
        if (outcome.status === 'failed') prepared[index].rollback()
        return outcome
      })
    }
    const { handle, projectionTargets, reapply } = prepared[index]
    if (!reapply) return
    const fences = new Map(
      (projectionTargets ?? []).map((target) => [target, pendingMutationProjectionFence(handle, target)]),
    )
    reapply((target) => {
      const fence = fences.get(target)
      return fence !== null && fence !== undefined && isPendingMutationProjectionFenceCurrent(fence)
    })
  })
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  const failure =
    firstFailure ??
    (rejected
      ? ({
          status: 'error',
          error: rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        } as const)
      : undefined)
  if (outcomes.some((outcome) => outcome.retained)) {
    const retainedOutcomeCount = outcomes.filter((outcome) => outcome.retained).length
    const retainedOutcomes = outcomes.filter(
      (
        outcome,
      ): outcome is CharacterOwnedDurableMutationOutcome<Record<string, unknown>> & {
        retained: true
        mutationId: string
        settlement: Promise<ChatMutationFinalOutcome>
      } => outcome.retained && Boolean(outcome.mutationId) && Boolean(outcome.settlement),
    )
    const mutationIds = retainedOutcomes.map((outcome) => outcome.mutationId)
    const settlement =
      retainedOutcomes.length === retainedOutcomeCount
        ? Promise.all(retainedOutcomes.map((outcome) => outcome.settlement)).then(
            (finalSettlements): ChatMutationFinalOutcome =>
              finalSettlements.find(
                (finalSettlement): finalSettlement is Extract<ChatMutationFinalOutcome, { status: 'failed' }> =>
                  finalSettlement.status === 'failed',
              ) ?? { status: 'accepted' },
          )
        : Promise.resolve<ChatMutationFinalOutcome>({ status: 'failed', result: { status: 'unavailable' } })
    return {
      status: 'retained',
      acceptedCount,
      failure: failure ?? { status: 'unavailable' },
      mutationIds,
      settlement,
    }
  }
  if (failure) return { status: 'failure', acceptedCount, failure }
  return { status: 'ok', acceptedCount }
}

async function dispatchCharacterOwnedDurableMutationWithOutcome<T extends Record<string, unknown>>(
  characterId: string | undefined,
  intent: DurableMutationIntent,
  dispatch: (options: ServerCommandTransportOptions) => Promise<ServerCommandResult<T>>,
  projectionTargets: readonly string[] = [],
): Promise<CharacterOwnedDurableMutationOutcome<T>> {
  if (!characterId || !canUseServerCommands()) {
    return { result: await dispatch({}), retained: false }
  }

  const outbox = stagePendingMutation(characterOwnerMutationKey(characterId), intent)
  if (projectionTargets.length > 0) recordPendingMutationProjectionTargets(outbox, projectionTargets)
  return dispatchPreparedCharacterOwnedDurableMutationWithOutcome(outbox, intent, dispatch)
}

async function dispatchPreparedCharacterOwnedDurableMutationWithOutcome<T extends Record<string, unknown>>(
  outbox: PendingMutationHandle,
  intent: DurableMutationIntent,
  dispatch: (options: ServerCommandTransportOptions) => Promise<ServerCommandResult<T>>,
  beforeExecuteResult?: () => Exclude<ServerCommandResult, { status: 'ok' }> | undefined,
): Promise<CharacterOwnedDurableMutationOutcome<T>> {
  const finalSettlement = trackChatMutationFinalSettlement(outbox)
  let retained = false
  try {
    const result = await dispatchDurableMutation(
      outbox,
      intent,
      (transport) =>
        dispatch({
          ...transport,
          failureRollbackDisposition: (failure) => {
            const disposition = transport.failureRollbackDisposition?.(failure) ?? 'rollback'
            if (disposition === 'retain') retained = true
            return disposition
          },
        }),
      {
        beforeExecuteResult: beforeExecuteResult
          ? () => beforeExecuteResult() as Exclude<ServerCommandResult<T>, { status: 'ok' }> | undefined
          : undefined,
      },
    )
    if (retained && finalSettlement) {
      return {
        result,
        retained,
        mutationId: finalSettlement.mutationId,
        settlement: finalSettlement.settlement,
      }
    }
    finalSettlement?.cancel()
    return { result, retained: false }
  } catch (error) {
    if (retained && finalSettlement) {
      return {
        result: { status: 'unavailable' },
        retained: true,
        mutationId: finalSettlement.mutationId,
        settlement: finalSettlement.settlement,
      }
    }
    finalSettlement?.cancel()
    throw error
  }
}

export function currentChatStateSnapshot(): ChatStateSnapshot {
  return {
    characters: cloneJsonValue(charactersResourceState.characters),
    selectedCharID: get(selectedCharID),
  }
}

export function restoreChatState(snapshot: ChatStateSnapshot): void {
  withChatOwnerProjectionWrite(() => {
    charactersResourceState.characters = cloneJsonValue(snapshot.characters)
    selectedCharID.set(snapshot.selectedCharID)
    reloadGuiDisplay()
  })
}

export function applyOptimisticCreatedChat(
  characterId: string | undefined,
  chat: Chat,
  snapshot: ChatCreateBaseline,
): boolean {
  if (!canUseClientWriteAccess()) return false
  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, snapshot.selectedCharID)
    if (!character?.chats) return
    const existingIndex = chat.id ? character.chats.findIndex((candidate) => candidate.id === chat.id) : -1
    if (existingIndex >= 0) {
      character.chatPage = existingIndex
      applied = true
      return
    }
    character.chats.unshift(chat)
    character.chatPage = 0
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

export function applyOptimisticResetChats(
  characterId: string | undefined,
  chat: Chat,
  snapshot: ChatResetBaseline,
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!chat.id) return false
  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, snapshot.selectedCharID)
    if (!character?.chats) return
    character.chats = [chat]
    character.chatPage = 0
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

export function applyOptimisticCreatedChatFolder(
  characterId: string | undefined,
  folder: ChatFolder,
  snapshot: ChatFolderCreateBaseline,
): boolean {
  if (!canUseClientWriteAccess()) return false
  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, snapshot.selectedCharID)
    if (!character) return
    character.chatFolders ??= []
    const existingIndex = folder.id ? character.chatFolders.findIndex((candidate) => candidate.id === folder.id) : -1
    if (existingIndex >= 0) {
      applied = true
      return
    }
    character.chatFolders.unshift(folder)
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

export interface OptimisticDeletedChatResult {
  applied: boolean
  selectedChatId: string | undefined
}

export function applyOptimisticDeletedChat(
  characterId: string | undefined,
  chatId: string | undefined,
  snapshot: ChatDeleteBaseline,
): OptimisticDeletedChatResult {
  if (!canUseClientWriteAccess()) return { applied: false, selectedChatId: undefined }
  const result: OptimisticDeletedChatResult = {
    applied: false,
    selectedChatId: undefined,
  }
  if (!chatId) return result

  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, snapshot.selectedCharID)
    const chats = character?.chats
    if (!character || !chats || chats.length <= 1) return
    const chatIndex = chats.findIndex((candidate) => candidate.id === chatId)
    if (chatIndex < 0) return
    const previouslySelectedChatId = chats[character.chatPage]?.id

    chats.splice(chatIndex, 1)
    const preservedSelectionIndex =
      previouslySelectedChatId && previouslySelectedChatId !== chatId
        ? chats.findIndex((candidate) => candidate.id === previouslySelectedChatId)
        : -1
    if (preservedSelectionIndex >= 0) character.chatPage = preservedSelectionIndex
    else character.chatPage = normalizeChatPageIndex(character.chatPage, character.chats?.length ?? 0)
    result.applied = true
    result.selectedChatId = chats[character.chatPage]?.id
    if ('kind' in snapshot && snapshot.characterId === character.chaId && snapshot.chatId === chatId) {
      // Bind selection ownership to this optimistic write, before any note
      // flushing or other async work can admit a newer user selection.
      snapshot.previousSelectedChatId = previouslySelectedChatId
      snapshot.attemptedSelectedChatId = result.selectedChatId
    }
  })
  if (result.applied) reloadGuiDisplay()
  return result
}

// Chat selection rollback only restores the owning character's `chatPage`.
// `selectedCharID` locates the row but is not restored, so a concurrent
// character switch is not clobbered.
export interface ChatSelectionSnapshot {
  characterId: string | undefined
  selectedCharID: number
  chatPage: number
}

export function currentChatSelectionSnapshot(): ChatSelectionSnapshot {
  const selectedChar = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedChar]
  const character = candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : candidate
  return {
    characterId: character?.chaId,
    selectedCharID: selectedChar,
    chatPage: character?.chatPage ?? 0,
  }
}

export function restoreChatSelection(snapshot: ChatSelectionSnapshot, attemptedChatId?: string): void {
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
    if (!character) return
    if (attemptedChatId !== undefined && selectedChatIdForCharacter(character) !== attemptedChatId) return
    character.chatPage = snapshot.chatPage
  })
}

function applyOptimisticChatSelection(chatId: string, snapshot: ChatSelectionSnapshot): void {
  const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
  const chatIndex = character?.chats?.findIndex((candidate) => candidate.id === chatId) ?? -1
  if (!character || chatIndex < 0 || character.chatPage === chatIndex) return

  withChatOwnerProjectionWrite(() => {
    const liveCharacter = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
    const liveChatIndex = liveCharacter?.chats?.findIndex((candidate) => candidate.id === chatId) ?? -1
    if (!liveCharacter || liveChatIndex < 0) return
    liveCharacter.chatPage = liveChatIndex
  })
}

// Narrow single-chat rollback. Message edit/delete/bookmark/replace/send and
// slash-command message mutation only touch the active chat row, so a rollback
// only needs that one chat — not a JSON clone of every character's whole chat
// history (the heavy `ChatStateSnapshot`). The full-collection snapshot stays
// for genuine restructures (create/delete/reorder/fork chats); this scoped pair
// is reserved for paths that mutate one chat in place.
export interface ChatScopedSnapshot {
  selectedCharID: number
  characterId: string | undefined
  chatId: string | undefined
  chat: Chat | undefined
}

interface PendingChatMetadataAttempt {
  sessionGeneration: number
  sequence: number
  chatId: string
  rollback: ChatRowMetadataSnapshot
  durability?: PendingDurableChatProjection
}

interface PendingChatFolderMetadataAttempt {
  sessionGeneration: number
  sequence: number
  folderId: string
  rollback: ChatFolderRowMetadataSnapshot
  durability?: PendingDurableChatProjection
}

interface PendingScopedTranscriptAttempt {
  sessionGeneration: number
  sequence: number
  chatKey: string
  previous: ChatScopedSnapshot
  attemptedMessages: Message[]
  reapply: (previousMessages: readonly Message[]) => Message[] | null
  rollback: (attempt: PendingScopedTranscriptAttempt) => void
  retainedProjection?: PendingRetainedChatProjection
  durability?: PendingDurableChatProjection
}

interface PendingRetainedChatProjection {
  release: () => void
  onInvalidated?: () => void
}

interface PendingDurableChatProjection {
  failureRollbackDisposition: NonNullable<ServerCommandTransportOptions['failureRollbackDisposition']>
  release: () => void
}

interface AppliedScopedMessagePatchAttempt {
  commandPatch: MessageSnapshot
  dispatcherAppliedKeys: Set<string>
}

const pendingChatMetadataAttempts = new Map<string, PendingChatMetadataAttempt[]>()
let nextChatMetadataAttemptSequence = 0
const pendingChatFolderMetadataAttempts = new Map<string, PendingChatFolderMetadataAttempt[]>()
let nextChatFolderMetadataAttemptSequence = 0
const pendingScopedTranscriptAttempts = new Map<string, PendingScopedTranscriptAttempt[]>()
let nextScopedTranscriptAttemptSequence = 0

function canProjectChatAttempt(attempt: { sessionGeneration: number }): boolean {
  return canUseClientWriteAccess() && isClientSessionGenerationCurrent(attempt.sessionGeneration)
}

function bindDurableChatProjectionAttempt(
  attempt: {
    sessionGeneration: number
    retainedProjection?: PendingRetainedChatProjection
    durability?: PendingDurableChatProjection
  },
  transport: ServerCommandTransportOptions,
  target: RetainedChatProjectionTarget,
  reapply: () => void,
  onAccepted: () => void,
  onDiscarded: () => void,
): void {
  if (attempt.durability || !transport.mutationId || !transport.failureRollbackDisposition) return

  let releaseSettlement = () => {}
  let durability: PendingDurableChatProjection
  const retainedProjection = attempt.retainedProjection ?? createPendingRetainedChatProjection(target, reapply)
  attempt.retainedProjection = retainedProjection
  retainedProjection.onInvalidated = () => {
    if (attempt.durability !== durability) return
    attempt.durability = undefined
    durability.release()
    onAccepted()
  }
  durability = {
    failureRollbackDisposition: transport.failureRollbackDisposition,
    release: () => {
      if (attempt.retainedProjection === retainedProjection) {
        attempt.retainedProjection = undefined
      }
      retainedProjection.onInvalidated = undefined
      retainedProjection.release()
      releaseSettlement()
    },
  }
  attempt.durability = durability
  releaseSettlement = registerDurableMutationSettlementListener(transport.mutationId, (settlement) => {
    if (attempt.durability !== durability) return
    attempt.durability = undefined
    durability.release()
    if (settlement === 'accepted') {
      onAccepted()
      return
    }
    onDiscarded()
    if (canProjectChatAttempt(attempt)) alertError(language.retainedChatMutationFailed)
  })
}

function createPendingRetainedChatProjection(
  target: RetainedChatProjectionTarget,
  reapply: () => void,
): PendingRetainedChatProjection {
  const retainedProjection: PendingRetainedChatProjection = { release: () => {} }
  retainedProjection.release = registerRetainedChatProjection(target, reapply, () => {
    retainedProjection.onInvalidated?.()
  })
  return retainedProjection
}

function releaseChatProjectionAttempt(attempt: {
  retainedProjection?: PendingRetainedChatProjection
  durability?: PendingDurableChatProjection
}): void {
  const durability = attempt.durability
  attempt.durability = undefined
  if (durability) {
    durability.release()
    return
  }
  const retainedProjection = attempt.retainedProjection
  attempt.retainedProjection = undefined
  retainedProjection?.release()
}

function trackDurableChatProjectionAttempt(
  attempt: {
    retainedProjection?: PendingRetainedChatProjection
    durability?: PendingDurableChatProjection
  },
  result: Promise<ServerCommandResult | null> | null,
  clear: () => void,
  reapply: () => void,
): void {
  if (!result) {
    releaseChatProjectionAttempt(attempt)
    clear()
    return
  }
  void result.then(
    (settled) => {
      if (settled && settled.status !== 'ok' && attempt.durability?.failureRollbackDisposition(settled) === 'retain') {
        reapply()
        return
      }
      releaseChatProjectionAttempt(attempt)
      clear()
    },
    () => {
      if (attempt.durability?.failureRollbackDisposition({ status: 'unavailable' }) === 'retain') {
        reapply()
        return
      }
      releaseChatProjectionAttempt(attempt)
      clear()
    },
  )
}

export interface ChatGenerationSettingsSnapshot {
  characterId: string | undefined
  chatId: string
  hadGenerationSettings: boolean
  generationSettings?: ChatGenerationSettings
  attemptedGenerationSettings?: ChatGenerationSettings
}

interface PendingChatGenerationSettingsJob {
  sessionGeneration: number
  intent: SparseChatGenerationSettingsUpdate
  originalTarget: ChatGenerationSettings
  fallbackRollback: ChatGenerationSettingsSnapshot
  options: ServerCommandTransportOptions
  pendingSave: ReturnType<typeof registerPendingChatGenerationSettingsSave>
  durableIntent: DurableMutationIntent
  outbox: PendingMutationHandle
  settle: (settlement: ChatGenerationSettingsSaveSettlement) => void
}

interface PreparedChatGenerationSettingsSave {
  job: PendingChatGenerationSettingsJob
  rollback: ChatGenerationSettingsSnapshot
  characterId: string | undefined
  characterRowProjectionEpoch: number | null
  appliedRevisionBefore: number | null
  commandInput: Omit<SaveChatGenerationSettingsCommandInput, 'baseRevision'>
  fullCommandInput: Omit<SaveChatGenerationSettingsCommandInput, 'baseRevision'>
  durableIntent: DurableMutationIntent
  standaloneDurableIntent: DurableMutationIntent
}

interface PendingChatGenerationSettingsQueue {
  confirmed: ChatGenerationSettingsSnapshot | null
  jobs: PendingChatGenerationSettingsJob[]
  tail: Promise<ServerCommandResult | null>
}

const pendingChatGenerationSettingsSaves = new Map<string, PendingChatGenerationSettingsQueue>()

export interface MutateChatScopedOptions {
  selectedChar?: number
  selectedChat?: number
}

export interface SetCurrentChatGreetingIndexOptions extends MutateChatScopedOptions {
  dispatch?: boolean
}

export interface SetCurrentChatSelectedDraftHookIdOptions extends MutateChatScopedOptions {
  dispatch?: boolean
}

export function currentChatScopedSnapshot(options: MutateChatScopedOptions = {}): ChatScopedSnapshot {
  const selectedChar = options.selectedChar ?? get(selectedCharID)
  if (charactersResourceState.status === 'ready') {
    const candidate = charactersResourceState.characters?.[selectedChar]
    const selectedChat = options.selectedChat ?? candidate?.chatPage
    const candidateChat = selectedChat === undefined ? undefined : candidate?.chats?.[selectedChat]
    const characterId = candidate?.chaId
    const chatId = candidateChat?.id
    if (!characterId || !chatId) {
      return { selectedCharID: selectedChar, characterId, chatId, chat: undefined }
    }
    const location = locateChatById(chatId, characterId)
    if (location) {
      return {
        selectedCharID: selectedChar,
        characterId,
        chatId,
        chat: cloneJsonValue(location.chat),
      }
    }
    return { selectedCharID: selectedChar, characterId, chatId, chat: undefined }
  }

  const aggregateCharacter = charactersResourceState.characters[selectedChar]
  const selectedChat = options.selectedChat ?? aggregateCharacter?.chatPage
  const aggregateChat = selectedChat === undefined ? undefined : aggregateCharacter?.chats?.[selectedChat]
  const characterId = aggregateCharacter?.chaId
  const chatId = aggregateChat?.id
  const chat = aggregateChat
  return {
    selectedCharID: selectedChar,
    characterId,
    chatId: chat?.id,
    chat: chat ? cloneJsonValue(chat) : undefined,
  }
}

export function captureActiveChatTarget(): ActiveChatTarget | null {
  const selectedChar = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedChar]
  const character = candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : candidate
  const chatPage = character?.chatPage ?? 0
  const chat = character?.chats?.[chatPage]
  if (!character || !chat) return null
  if (chat.id && locateChatById(chat.id, character.chaId)?.chat !== chat) return null

  return {
    selectedCharID: selectedChar,
    chatPage,
    characterId: character.chaId,
    chatId: chat.id,
  }
}

export function isActiveChatTargetFresh(target: ActiveChatTarget | null | undefined): boolean {
  if (!target) return false

  const selectedChar = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedChar]
  const character = candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : candidate
  const chatPage = character?.chatPage ?? 0
  const chat = character?.chats?.[chatPage]
  if (!character || !chat) return false
  if (chat.id && locateChatById(chat.id, character.chaId)?.chat !== chat) return false

  if (target.characterId !== undefined || character.chaId !== undefined) {
    if (target.characterId !== character.chaId) return false
  } else if (target.selectedCharID !== selectedChar) {
    return false
  }

  if (target.chatId !== undefined || chat.id !== undefined) {
    return target.chatId === chat.id
  }

  return target.chatPage === chatPage
}

export function restoreChatScopedState(snapshot: ChatScopedSnapshot): void {
  if (!snapshot.chat) return
  withChatOwnerProjectionWrite(() => {
    const chat = locateChatScopedSnapshot(snapshot)
    if (!chat) return
    const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
    if (!character?.chats) return
    const index = locateChatIndex(character, snapshot.chatId)
    if (index < 0) return
    character.chats[index] = cloneJsonValue(snapshot.chat) as Chat
  })
}

function locateChatScopedSnapshot(snapshot: ChatScopedSnapshot): Chat | undefined {
  const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
  if (!character?.chats) return undefined
  const index = locateChatIndex(character, snapshot.chatId)
  return index >= 0 ? character.chats[index] : undefined
}

export function currentChatGenerationSettingsSnapshot(chatId: string): ChatGenerationSettingsSnapshot | null {
  const location = locateChatById(chatId)
  if (!location) return null
  const chatRecord = location.chat as unknown as Record<string, unknown>
  return {
    characterId: location.character.chaId,
    chatId,
    hadGenerationSettings: Object.prototype.propertyIsEnumerable.call(chatRecord, 'generationSettings'),
    generationSettings: cloneJsonValue(location.chat.generationSettings),
  }
}

export function restoreChatGenerationSettings(snapshot: ChatGenerationSettingsSnapshot): void {
  withChatOwnerProjectionWrite(() => {
    const location = locateChatById(snapshot.chatId, snapshot.characterId)
    if (!location) return
    const row = location.chat as unknown as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(snapshot, 'attemptedGenerationSettings')) return

    const previous: Record<string, unknown> = {}
    if (snapshot.hadGenerationSettings) {
      previous.generationSettings = cloneJsonValue(snapshot.generationSettings)
    }

    applyAttemptedFieldRollback({
      target: row,
      previous,
      attempted: {
        generationSettings: cloneJsonValue(snapshot.attemptedGenerationSettings),
      },
      keys: ['generationSettings'],
      deleteMissingPrevious: true,
    })
  })
}

export async function waitForPendingChatGenerationSettingsSave(
  chatId: string | undefined,
): Promise<ServerCommandResult | null> {
  if (!chatId) return null
  const state = pendingChatGenerationSettingsSaves.get(chatId)
  if (!state) return null

  let tail = state.tail
  let result = await tail
  while (pendingChatGenerationSettingsSaves.get(chatId) === state && state.tail !== tail) {
    tail = state.tail
    result = await tail
  }
  return result
}

// Narrow scriptstate rollback. `setVar`/`setChatVar`/`/setvar`/`/addvar` only
// mutate the active chat's `scriptstate` map (and `v2SetAuthorNote` its `note`
// scalar), so the snapshot shallow-clones just that small key/value map plus an
// optional note — never the chat or the characters array.
export interface ChatScriptstateSnapshot {
  characterId: string | undefined
  chatId: string | undefined
  selectedCharID: number
  scriptstate: { [key: string]: string | number | boolean } | undefined
  note?: string
}

export function currentChatScriptstateSnapshot(includeNote = false): ChatScriptstateSnapshot {
  const selectedChar = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedChar]
  const character = candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : candidate
  const chat = character?.chats?.[character.chatPage]
  const snapshot: ChatScriptstateSnapshot = {
    characterId: character?.chaId,
    chatId: chat?.id,
    selectedCharID: selectedChar,
    scriptstate: chat?.scriptstate ? { ...chat.scriptstate } : undefined,
  }
  if (includeNote && chat) snapshot.note = chat.note ?? ''
  return snapshot
}

export function restoreChatScriptstate(snapshot: ChatScriptstateSnapshot): void {
  withChatOwnerProjectionWrite(() => {
    const chat = locateScriptstateChat(snapshot)
    if (!chat) return
    chat.scriptstate = snapshot.scriptstate ? { ...snapshot.scriptstate } : undefined
    if (snapshot.note !== undefined) chat.note = snapshot.note
  })
}

function restoreChatScriptstateAttempt(
  snapshot: ChatScriptstateSnapshot,
  attemptedPatch: ChatScriptstatePatch,
  attemptedDeleteKeys: readonly string[],
): void {
  withChatOwnerProjectionWrite(() => {
    const chat = locateScriptstateChat(snapshot)
    if (!chat) return

    const keys = new Set([...Object.keys(attemptedPatch), ...sanitizeScriptstateDeleteKeys(attemptedDeleteKeys)])
    if (keys.size === 0) return

    const previous: Record<string, ChatScriptstateValue | undefined> = {}
    const attempted: Record<string, ChatScriptstateValue | undefined> = {}
    const previousScriptstate = snapshot.scriptstate ?? {}
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(previousScriptstate, key)) {
        previous[key] = previousScriptstate[key]
      }
      attempted[key] = Object.prototype.hasOwnProperty.call(attemptedPatch, key) ? attemptedPatch[key] : undefined
    }

    const target = (chat.scriptstate ?? {}) as Record<string, ChatScriptstateValue | undefined>
    const rolledBack = applyAttemptedFieldRollback({
      target,
      previous,
      attempted,
      keys,
      deleteMissingPrevious: true,
    })
    if (rolledBack.length === 0) return

    if (Object.keys(target).length === 0) {
      delete chat.scriptstate
    } else {
      chat.scriptstate = target as Chat['scriptstate']
    }
  })
}

function restoreChatNoteAttempt(snapshot: ChatScriptstateSnapshot, attemptedNote: string): void {
  if (snapshot.note === undefined) return
  if (snapshot.characterId && snapshot.chatId && charactersResourceState.status === 'ready') {
    restoreChatMetadataOwnerSnapshot({
      characterId: snapshot.characterId,
      chatId: snapshot.chatId,
      metadata: { note: snapshot.note },
      attempted: { note: attemptedNote },
    })
    return
  }
  withChatOwnerProjectionWrite(() => {
    const chat = locateScriptstateChat(snapshot)
    if (!chat) return
    applyAttemptedFieldRollback({
      target: chat as unknown as Record<string, unknown>,
      previous: { note: snapshot.note },
      attempted: { note: attemptedNote },
      keys: ['note'],
      deleteMissingPrevious: true,
    })
  })
}

function locateSnapshotCharacter(characterId: string | undefined, fallbackIndex: number): character | undefined {
  if (characterId) return getCharacterResourceOwner(characterId)
  // Pre-hydration compatibility seam: old callers may capture a positional
  // snapshot before the server has assigned a stable character owner.
  return charactersResourceState.characters[fallbackIndex]
}

function characterOwnerAt(index: number): character | undefined {
  const candidate = charactersResourceState.characters[index]
  if (candidate?.chaId) return getCharacterResourceOwner(candidate.chaId)
  return charactersResourceState.status === 'ready' ? undefined : candidate
}

function locateChatIndex(character: character, chatId: string | undefined): number {
  // Prefer a stable id so a stale index can never clobber the wrong chat. Only
  // fall back to the active `chatPage` when the chat carried no id at all.
  if (chatId) {
    const matches = (character.chats ?? [])
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.id === chatId)
    return matches.length === 1 ? matches[0].index : -1
  }
  const page = character.chatPage ?? 0
  return page >= 0 && page < (character.chats?.length ?? 0) ? page : -1
}

function locateScriptstateChat(snapshot: ChatScriptstateSnapshot): Chat | undefined {
  const owner = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
  if (snapshot.chatId) {
    return locateChatById(snapshot.chatId, snapshot.characterId)?.chat
  }
  return owner?.chats?.[owner.chatPage]
}

function locateChatById(chatId: string, preferredCharacterId?: string): { character: character; chat: Chat } | null {
  let match: { character: character; chat: Chat } | null = null
  for (const character of charactersResourceState.characters) {
    const chats = character.chats?.filter((candidate) => candidate.id === chatId) ?? []
    if (chats.length > 1) return null
    if (chats.length === 0) continue
    if (!character.chaId || !getCharacterResourceOwner(character.chaId)) return null
    if (match) return null
    match = { character, chat: chats[0] }
  }
  if (preferredCharacterId && match?.character.chaId !== preferredCharacterId) return null
  return match
}

// Narrow chat-metadata-row rollback for the server-backed chat-metadata watcher.
// The watcher pushes only the small allowed scalar keys
// (`CHAT_PATCH_ALLOWED_KEYS`) of one chat row to the server, so its rollback only
// needs that one row's scalar metadata — not a JSON clone of every character's
// whole chat history (the heavy `ChatStateSnapshot`). `metadata` is exactly the
// scalar baseline the watcher already diffs, so restoring it re-writes only those
// scalars on the located chat and leaves message history, `localLore`,
// `scriptstate`, and every other chat/character row untouched.
export interface ChatRowMetadataSnapshot {
  selectedCharID: number
  characterId: string | undefined
  chatId: string
  metadata: ChatSnapshot
  attempted?: ChatSnapshot
}

/** Captured before an optimistic metadata write; contains only affected fields. */
export interface ChatMetadataPatchSnapshot extends ChatRowMetadataSnapshot {
  characterId: string
  attempted: ChatSnapshot
}

export function captureChatMetadataPatch(
  chatId: string,
  patch: ChatSnapshot,
  characterId?: string,
): ChatMetadataPatchSnapshot | null {
  const location = locateChatById(chatId, characterId)
  if (!location?.character.chaId) return null
  const snapshot = chatRowMetadataRollbackFromPrevious(
    chatId,
    patch,
    get(selectedCharID),
    location.character.chaId,
    location.chat,
  )
  return snapshot ? { ...snapshot, characterId: location.character.chaId, attempted: snapshot.attempted! } : null
}

export type ChatRowMetadataRollback = (snapshot: ChatRowMetadataSnapshot) => void

export function restoreChatRowMetadata(snapshot: ChatRowMetadataSnapshot): void {
  if (snapshot.characterId && charactersResourceState.status === 'ready') {
    if (!snapshot.attempted) {
      restoreChatMetadataOwnerSnapshot({
        characterId: snapshot.characterId,
        chatId: snapshot.chatId,
        metadata: snapshot.metadata,
      })
    } else {
      for (const key of CHAT_PATCH_ALLOWED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(snapshot.attempted, key)) continue
        restoreChatMetadataOwnerSnapshot({
          characterId: snapshot.characterId,
          chatId: snapshot.chatId,
          metadata: Object.prototype.hasOwnProperty.call(snapshot.metadata, key)
            ? { [key]: snapshot.metadata[key] }
            : {},
          attempted: { [key]: snapshot.attempted[key] },
        })
      }
    }
    return
  }
  // Pre-hydration compatibility seam for baselines captured before the
  // explicit character owner resource becomes ready.
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
    const chat = character?.chats?.find((candidate) => candidate.id === snapshot.chatId)
    if (!chat) return
    const row = chat as unknown as Record<string, unknown>
    if (snapshot.attempted) {
      applyAttemptedFieldRollback({
        target: row,
        previous: snapshot.metadata as Record<string, unknown>,
        attempted: snapshot.attempted as Record<string, unknown>,
        keys: CHAT_PATCH_ALLOWED_KEYS,
        deleteMissingPrevious: true,
      })
      return
    }
    for (const key of CHAT_PATCH_ALLOWED_KEYS) {
      if (key in snapshot.metadata) {
        row[key] = cloneJsonValue(snapshot.metadata[key])
      } else {
        // The optimistic change added this allowed key; remove it so the failed
        // command does not leave a stray scalar behind.
        delete row[key]
      }
    }
  })
}

export interface ChatFolderRowMetadataSnapshot {
  selectedCharID: number
  characterId: string | undefined
  folderId: string
  metadata: ChatFolderSnapshot
  attempted?: ChatFolderSnapshot
}

export interface ChatFolderMetadataPatchSnapshot extends ChatFolderRowMetadataSnapshot {
  characterId: string
  attempted: ChatFolderSnapshot
}

export function captureChatFolderMetadataPatch(
  folderId: string,
  patch: ChatFolderSnapshot,
  characterId?: string,
): ChatFolderMetadataPatchSnapshot | null {
  const match = locateLiveChatFolder(folderId, characterId)
  if (!match?.character.chaId) return null
  const snapshot = chatFolderMetadataRollbackFromPrevious(
    folderId,
    patch,
    get(selectedCharID),
    match.character.chaId,
    match.folder,
  )
  return snapshot ? { ...snapshot, characterId: match.character.chaId, attempted: snapshot.attempted! } : null
}

function locateLiveChatFolder(
  folderId: string,
  characterId?: string,
): { character: character; folder: ChatFolder } | null {
  // Resolve stable ownership without inspecting or copying any chat bodies.
  let match: { character: character; folder: ChatFolder } | null = null
  for (const owner of charactersResourceState.characters) {
    for (const folder of owner.chatFolders ?? []) {
      if (folder.id !== folderId) continue
      if (match || !owner.chaId || !getCharacterResourceOwner(owner.chaId)) return null
      match = { character: owner, folder }
    }
  }
  if (!match?.character.chaId || (characterId && match.character.chaId !== characterId)) return null
  return match
}

export type ChatFolderRowMetadataRollback = (snapshot: ChatFolderRowMetadataSnapshot) => void

export function restoreChatFolderRowMetadata(snapshot: ChatFolderRowMetadataSnapshot): void {
  if (snapshot.characterId && charactersResourceState.status === 'ready') {
    if (!snapshot.attempted) {
      restoreChatFolderMetadataOwnerSnapshot({
        characterId: snapshot.characterId,
        folderId: snapshot.folderId,
        metadata: snapshot.metadata,
      })
    } else {
      for (const key of CHAT_FOLDER_PATCH_ALLOWED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(snapshot.attempted, key)) continue
        restoreChatFolderMetadataOwnerSnapshot({
          characterId: snapshot.characterId,
          folderId: snapshot.folderId,
          metadata: Object.prototype.hasOwnProperty.call(snapshot.metadata, key)
            ? { [key]: snapshot.metadata[key] }
            : {},
          attempted: { [key]: snapshot.attempted[key] },
        })
      }
    }
    return
  }
  // Pre-hydration compatibility seam; normal rollback uses the stable folder
  // owner above.
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(snapshot.characterId, snapshot.selectedCharID)
    const folder = character?.chatFolders?.find((candidate) => candidate.id === snapshot.folderId)
    if (!folder) return
    if (snapshot.attempted) {
      applyAttemptedFieldRollback({
        target: folder as unknown as Record<string, unknown>,
        previous: snapshot.metadata as Record<string, unknown>,
        attempted: snapshot.attempted as Record<string, unknown>,
        keys: CHAT_FOLDER_PATCH_ALLOWED_KEYS,
        deleteMissingPrevious: true,
      })
      return
    }
    folder.name = snapshot.metadata.name as string | undefined
    folder.color = snapshot.metadata.color as string | undefined
    folder.folded = (snapshot.metadata.folded as boolean | undefined) ?? false
  })
}

interface ChatFolderLocation {
  character: character
  folder: ChatFolder
  folderIndex: number
}

interface ChatFolderDeleteRollback {
  selectedCharID: number
  characterId: string | undefined
  folderId: string
  folder: ChatFolder
  previousIndex: number
  affectedChats: Array<{
    chatId: string
    previousFolderId: string | null | undefined
    attemptedFolderId: string | null | undefined
  }>
}

interface ChatLocation {
  character: character
  chat: Chat
  chatIndex: number
}

interface ChatCreateRollback {
  selectedCharID: number
  characterId: string | undefined
  chatId: string
  previousChat: Chat | null
  attemptedChat: Chat
  previousSelectedChatId: string | undefined
  attemptedSelectedChatId: string | undefined
}

interface ChatImportedCreateRollback {
  selectedCharID: number
  characterId: string | undefined
  chatId: string
  attemptedChat: Chat
  previousSelectedChatId: string | undefined
}

interface ChatCreatedFolderRollback {
  selectedCharID: number
  characterId: string | undefined
  folderId: string
  attemptedFolder: ChatFolder
}

interface ChatDeleteRollback {
  selectedCharID: number
  characterId: string | undefined
  chatId: string
  chat: Chat
  previousIndex: number
  previousSelectedChatId: string | undefined
  attemptedSelectedChatId: string | undefined
}

interface ChatForkRollback {
  createdChat: ChatCreateRollback | null
  sourcePatch: ChatRowMetadataSnapshot | null
  createdFolder: ChatCreatedFolderRollback | null
}

interface ChatImportBatchRollbackStep<TRollback> {
  rollback: TRollback | null
  accepted: boolean
}

interface ChatImportBatchRollback {
  folders: Array<ChatImportBatchRollbackStep<ChatCreatedFolderRollback>>
  chats: Array<ChatImportBatchRollbackStep<ChatImportedCreateRollback>>
}

interface ChatFolderAssignmentRollback {
  previous: string | null | undefined
  previousHadValue: boolean
}

interface ChatReorderRollback {
  selectedCharID: number
  characterId: string | undefined
  previousIds: string[]
  previousFolderByChatId: Record<string, ChatFolderAssignmentRollback>
  attemptedIds: string[]
  attemptedFolderByChatId: Record<string, string | null>
}

/** Operation baselines contain only the affected structure and owned rows. */
export interface ChatCreateSnapshot extends ChatCreateRollback {
  kind: 'chat-create'
  characterId: string
  previousIds: string[]
}

export interface ChatFolderCreateSnapshot extends ChatCreatedFolderRollback {
  kind: 'chat-folder-create'
  characterId: string
  previousIds: string[]
  existed: boolean
}

export interface ChatDeleteSnapshot extends ChatDeleteRollback {
  kind: 'chat-delete'
  characterId: string
  projectionEpoch: number
}

export interface ChatFolderDeleteSnapshot extends ChatFolderDeleteRollback {
  kind: 'chat-folder-delete'
  characterId: string
}

export interface ChatOrderSnapshot {
  kind: 'chat-order'
  selectedCharID: number
  characterId: string
  previousIds: string[]
  previousFolderIds: string[]
  previousFolderByChatId: Record<string, ChatFolderAssignmentRollback>
}

export interface ChatForkSnapshot {
  kind: 'chat-fork'
  selectedCharID: number
  characterId: string
  sourceChatId: string
  previousSelectedChatId: string | undefined
  rollback: ChatForkRollback
}

export interface ChatResetSnapshot {
  kind: 'chat-reset'
  projectionEpoch: number
  selectedCharID: number
  characterId: string
  chats: Chat[]
  chatPage: number
}

export interface ChatImportSnapshot {
  kind: 'chat-import'
  selectedCharID: number
  characterId: string
  previousSelectedChatId: string | undefined
  previousChatIds: string[]
  previousFolderIds: string[]
}

type ChatCreateBaseline = ChatStateSnapshot | ChatCreateSnapshot | ChatImportSnapshot
type ChatFolderCreateBaseline = ChatStateSnapshot | ChatFolderCreateSnapshot | ChatImportSnapshot
type ChatDeleteBaseline = ChatStateSnapshot | ChatDeleteSnapshot
type ChatFolderDeleteBaseline = ChatStateSnapshot | ChatFolderDeleteSnapshot
type ChatOrderBaseline = ChatStateSnapshot | ChatOrderSnapshot
type ChatForkBaseline = ChatStateSnapshot | ChatForkSnapshot
type ChatResetBaseline = ChatStateSnapshot | ChatResetSnapshot

export function captureChatCreateSnapshot(characterId: string, chat: Chat, select = true): ChatCreateSnapshot | null {
  const owner = getCharacterResourceOwner(characterId)
  if (!owner || !chat.id) return null
  const previousChats = (owner.chats ?? []).filter((candidate) => candidate.id === chat.id)
  if (previousChats.length > 1) return null
  const previousChat = previousChats[0] ? cloneJsonValue(previousChats[0]) : null
  return {
    kind: 'chat-create',
    selectedCharID: get(selectedCharID),
    characterId,
    chatId: chat.id,
    previousIds: chatRowIds(owner.chats),
    previousChat,
    attemptedChat: previousChat ?? cloneJsonValue(chat),
    previousSelectedChatId: selectedChatIdForCharacter(owner),
    attemptedSelectedChatId: select ? chat.id : undefined,
  }
}

export function captureChatFolderCreateSnapshot(
  characterId: string,
  folder: ChatFolder,
): ChatFolderCreateSnapshot | null {
  const owner = getCharacterResourceOwner(characterId)
  if (!owner || !folder.id) return null
  const previousIds = chatFolderIds(owner.chatFolders)
  if (previousIds.filter((id) => id === folder.id).length > 1) return null
  return {
    kind: 'chat-folder-create',
    selectedCharID: get(selectedCharID),
    characterId,
    folderId: folder.id,
    attemptedFolder: cloneJsonValue(folder),
    previousIds,
    existed: previousIds.includes(folder.id),
  }
}

export function captureChatDeleteSnapshot(chatId: string, characterId?: string): ChatDeleteSnapshot | null {
  const location = locateChatById(chatId, characterId)
  if (!location?.character.chaId) return null
  const selectedChatId = selectedChatIdForCharacter(location.character)
  const previousIndex = location.character.chats.indexOf(location.chat)
  const nextPage = normalizeChatPageIndex(location.character.chatPage, location.character.chats.length - 1)
  const attemptedSelectedChatId =
    selectedChatId && selectedChatId !== chatId
      ? selectedChatId
      : location.character.chats[nextPage >= previousIndex ? nextPage + 1 : nextPage]?.id
  return {
    kind: 'chat-delete',
    projectionEpoch: captureCharacterRowProjectionEpoch(location.character.chaId),
    selectedCharID: get(selectedCharID),
    characterId: location.character.chaId,
    chatId,
    // Keep the removed row reachable so an already-running owner edit can
    // finish while deletion is pending; restoration reads its latest body.
    chat: location.chat,
    previousIndex,
    previousSelectedChatId: selectedChatId,
    // Direct projection callers use the same default post-delete selection.
    // The optimistic helper records its actual result at the write boundary.
    attemptedSelectedChatId,
  }
}

export function captureChatFolderDeleteSnapshot(
  folderId: string,
  characterId?: string,
): ChatFolderDeleteSnapshot | null {
  const location = locateLiveChatFolder(folderId, characterId)
  if (!location?.character.chaId) return null
  return {
    kind: 'chat-folder-delete',
    selectedCharID: get(selectedCharID),
    characterId: location.character.chaId,
    folderId,
    folder: cloneJsonValue(location.folder),
    previousIndex: location.character.chatFolders.indexOf(location.folder),
    affectedChats: location.character.chats.flatMap((chat) =>
      chat.id && chat.folderId === folderId
        ? [{ chatId: chat.id, previousFolderId: chat.folderId, attemptedFolderId: null }]
        : [],
    ),
  }
}

export function captureChatOrderSnapshot(characterId: string): ChatOrderSnapshot | null {
  const owner = getCharacterResourceOwner(characterId)
  if (!owner) return null
  const previousFolderByChatId: Record<string, ChatFolderAssignmentRollback> = {}
  for (const chat of owner.chats ?? []) {
    if (!chat.id) return null
    if (Object.prototype.hasOwnProperty.call(previousFolderByChatId, chat.id)) return null
    previousFolderByChatId[chat.id] = {
      previous: chat.folderId,
      previousHadValue: Object.prototype.hasOwnProperty.call(chat, 'folderId'),
    }
  }
  const previousFolderIds = chatFolderIds(owner.chatFolders)
  if (new Set(previousFolderIds).size !== previousFolderIds.length) return null
  return {
    kind: 'chat-order',
    selectedCharID: get(selectedCharID),
    characterId,
    previousIds: chatRowIds(owner.chats),
    previousFolderIds,
    previousFolderByChatId,
  }
}

export function captureChatForkSnapshot(
  sourceChatId: string,
  input: { chat: Chat; sourcePatch?: ChatSnapshot; folder?: ChatFolder; select?: boolean },
): ChatForkSnapshot | null {
  const location = locateChatById(sourceChatId)
  if (!location?.character.chaId) return null
  const characterId = location.character.chaId
  const createdChat = captureChatCreateSnapshot(characterId, input.chat, input.select !== false)
  if (!createdChat) return null
  const folder = input.folder ? captureChatFolderCreateSnapshot(characterId, input.folder) : null
  if (input.folder && !folder) return null
  return {
    kind: 'chat-fork',
    selectedCharID: get(selectedCharID),
    characterId,
    sourceChatId,
    previousSelectedChatId: selectedChatIdForCharacter(location.character),
    rollback: {
      createdChat,
      sourcePatch: input.sourcePatch ? captureChatMetadataPatch(sourceChatId, input.sourcePatch, characterId) : null,
      createdFolder: folder && !folder.existed ? folder : null,
    },
  }
}

export function captureChatResetSnapshot(characterId: string): ChatResetSnapshot | null {
  const owner = getCharacterResourceOwner(characterId)
  if (!owner) return null
  return {
    kind: 'chat-reset',
    projectionEpoch: captureCharacterRowProjectionEpoch(characterId),
    selectedCharID: get(selectedCharID),
    characterId,
    // Snapshot membership, while retaining the removed rows for pending edits.
    chats: [...(owner.chats ?? [])],
    chatPage: owner.chatPage ?? 0,
  }
}

export function captureChatImportSnapshot(characterId: string): ChatImportSnapshot | null {
  const owner = getCharacterResourceOwner(characterId)
  if (!owner) return null
  return {
    kind: 'chat-import',
    selectedCharID: get(selectedCharID),
    characterId,
    previousSelectedChatId: selectedChatIdForCharacter(owner),
    previousChatIds: chatRowIds(owner.chats),
    previousFolderIds: chatFolderIds(owner.chatFolders),
  }
}

function locateSnapshotCharacterInState(
  snapshot: ChatStateSnapshot,
  characterId: string | undefined,
): character | undefined {
  if (characterId) {
    const matches = (snapshot.characters ?? []).filter((candidate) => candidate.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  }
  return snapshot.characters?.[snapshot.selectedCharID]
}

function selectedChatIdForCharacter(character: character | undefined): string | undefined {
  if (!character?.chats) return undefined
  return character.chats[character.chatPage]?.id
}

function selectChatById(character: character, chatId: string | undefined): boolean {
  if (!chatId) return false
  const indexes = (character.chats ?? [])
    .map((chat, index) => (chat.id === chatId ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length !== 1) return false
  character.chatPage = indexes[0]
  return true
}

function preserveOrRestoreChatSelection(
  character: character,
  preferredSelectedChatId: string | undefined,
  fallbackSelectedChatId: string | undefined,
): void {
  if (selectChatById(character, preferredSelectedChatId)) return
  if (selectChatById(character, fallbackSelectedChatId)) return
  character.chatPage = normalizeChatPageIndex(character.chatPage, character.chats?.length ?? 0)
}

function locateChatInState(snapshot: ChatStateSnapshot, chatId: string): ChatLocation | null {
  let match: ChatLocation | null = null
  for (const character of snapshot.characters ?? []) {
    const indexes = (character.chats ?? [])
      .map((candidate, index) => (candidate.id === chatId ? index : -1))
      .filter((index) => index >= 0)
    if (indexes.length === 0) continue
    if (indexes.length > 1 || match) return null
    const chatIndex = indexes[0]
    match = { character, chat: character.chats[chatIndex], chatIndex }
  }
  return match
}

function locateChatFolderInState(snapshot: ChatStateSnapshot, folderId: string): ChatFolderLocation | null {
  let match: ChatFolderLocation | null = null
  for (const character of snapshot.characters ?? []) {
    const folderIndexes = (character.chatFolders ?? [])
      .map((candidate, index) => (candidate.id === folderId ? index : -1))
      .filter((index) => index >= 0)
    if (folderIndexes.length === 0) continue
    if (folderIndexes.length > 1 || match) return null
    const folderIndex = folderIndexes[0]
    match = { character, folder: character.chatFolders[folderIndex], folderIndex }
  }
  return match
}

function characterIdForChatInState(snapshot: ChatStateSnapshot, chatId: string): string | undefined {
  return locateChatInState(snapshot, chatId)?.character.chaId
}

interface MessageLocation extends ChatLocation {
  message: Message
}

function locateMessageInState(snapshot: ChatStateSnapshot, messageId: string): MessageLocation | null {
  let match: MessageLocation | null = null
  for (const character of snapshot.characters ?? []) {
    for (const [chatIndex, chat] of (character.chats ?? []).entries()) {
      const messages = (chat.message ?? []).filter((message) => message.chatId === messageId)
      if (messages.length === 0) continue
      if (messages.length > 1 || match) return null
      match = { character, chat, chatIndex, message: messages[0] }
    }
  }
  return match
}

function characterIdForMessageInState(snapshot: ChatStateSnapshot, messageId: string): string | undefined {
  return locateMessageInState(snapshot, messageId)?.character.chaId
}

function chatScopedSnapshotFromState(
  snapshot: ChatStateSnapshot,
  location: ChatLocation | null,
): ChatScopedSnapshot | null {
  if (!location?.chat.id) return null
  return {
    selectedCharID: snapshot.selectedCharID,
    characterId: location.character.chaId,
    chatId: location.chat.id,
    chat: cloneJsonValue(location.chat),
  }
}

function chatScopedSnapshotForChatInState(snapshot: ChatStateSnapshot, chatId: string): ChatScopedSnapshot | null {
  return chatScopedSnapshotFromState(snapshot, locateChatInState(snapshot, chatId))
}

function chatScopedSnapshotForMessageInState(
  snapshot: ChatStateSnapshot,
  messageId: string,
): ChatScopedSnapshot | null {
  return chatScopedSnapshotFromState(snapshot, locateMessageInState(snapshot, messageId))
}

function chatCreateRollbackFromState(
  characterId: string,
  attemptedChat: Chat,
  previous: ChatCreateBaseline,
  select: boolean,
): ChatCreateRollback | null {
  if (!attemptedChat.id) return null
  if ('kind' in previous) {
    if (previous.characterId !== characterId) return null
    if (previous.kind === 'chat-create') return previous.chatId === attemptedChat.id ? previous : null
    // Import rekeys incoming identities before applying them. A collision is not
    // a newly imported row and must never be removed by its rollback.
    if (previous.previousChatIds.includes(attemptedChat.id)) return null
    return {
      selectedCharID: previous.selectedCharID,
      characterId,
      chatId: attemptedChat.id,
      previousChat: null,
      attemptedChat: cloneJsonValue(attemptedChat),
      previousSelectedChatId: previous.previousSelectedChatId,
      attemptedSelectedChatId: select ? attemptedChat.id : undefined,
    }
  }
  const previousCharacter = locateSnapshotCharacterInState(previous, characterId)
  const previousChat = previousCharacter?.chats?.find((candidate) => candidate.id === attemptedChat.id)
  const previousChatSnapshot = previousChat ? cloneJsonValue(previousChat) : null
  return {
    selectedCharID: previous.selectedCharID,
    characterId,
    chatId: attemptedChat.id,
    previousChat: previousChatSnapshot,
    attemptedChat: previousChatSnapshot ?? cloneJsonValue(attemptedChat),
    previousSelectedChatId: selectedChatIdForCharacter(previousCharacter),
    attemptedSelectedChatId: select ? attemptedChat.id : undefined,
  }
}

function importedChatCreateRollbackFromState(
  characterId: string,
  attemptedChat: Chat,
  previous: ChatStateSnapshot | ChatImportSnapshot,
  usedIndexes: Set<number>,
): ChatImportedCreateRollback | null {
  if (!attemptedChat.id) return null
  const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
  const attemptedSnapshot = snapshotJson(attemptedChat)
  const attemptedIndex =
    character?.chats?.findIndex((candidate, index) => {
      if (usedIndexes.has(index) || candidate.id !== attemptedChat.id) return false
      return snapshotJson(candidate) === attemptedSnapshot
    }) ?? -1
  if (attemptedIndex < 0) return null

  usedIndexes.add(attemptedIndex)
  const previousSelectedChatId =
    'kind' in previous
      ? previous.previousSelectedChatId
      : selectedChatIdForCharacter(locateSnapshotCharacterInState(previous, characterId))
  return {
    selectedCharID: previous.selectedCharID,
    characterId,
    chatId: attemptedChat.id,
    attemptedChat: cloneJsonValue(attemptedChat),
    previousSelectedChatId,
  }
}

function restoreCreatedChatAttempt(rollback: ChatCreateRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const chats = character?.chats
    if (!character || !chats) return

    const liveSelectedChatId = selectedChatIdForCharacter(character)
    const rolledBack = applyAttemptedKeyedListRollback<Chat, string>({
      list: chats,
      entries: [
        {
          key: rollback.chatId,
          previous: rollback.previousChat,
          attempted: rollback.attemptedChat,
        },
      ],
      getKey: (chat) => chat?.id,
    })
    if (rolledBack.length === 0) return
    character.chats = chats

    const preferredSelectedChatId =
      liveSelectedChatId === rollback.attemptedSelectedChatId ? rollback.previousSelectedChatId : liveSelectedChatId
    preserveOrRestoreChatSelection(character, preferredSelectedChatId, liveSelectedChatId)
  })
}

function restoreFailedCreatedChatAttempt(rollback: ChatCreateRollback | null): void {
  if (!rollback || rollback.previousChat !== null) {
    restoreCreatedChatAttempt(rollback)
    return
  }
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const chats = character?.chats
    if (!character || !chats) return

    const liveSelectedChatId = selectedChatIdForCharacter(character)
    const attemptedIndex = chats.findIndex((chat) => chat.id === rollback.chatId)
    if (attemptedIndex < 0) return
    chats.splice(attemptedIndex, 1)
    character.chats = chats

    const preferredSelectedChatId =
      liveSelectedChatId === rollback.chatId ? rollback.previousSelectedChatId : liveSelectedChatId
    preserveOrRestoreChatSelection(character, preferredSelectedChatId, rollback.previousSelectedChatId)
  })
}

function restoreResetChatsAttempt(characterId: string, attemptedChat: Chat, previous: ChatResetBaseline): void {
  const previousCharacter = 'kind' in previous ? previous : locateSnapshotCharacterInState(previous, characterId)
  if (!previousCharacter || ('kind' in previous && previous.characterId !== characterId)) return
  const previousChats = previousCharacter.chats ?? []
  const previousChatPage = previousCharacter.chatPage ?? 0
  const attemptedSnapshot = snapshotJson(attemptedChat)
  let restored = false

  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    if (!character || character.chats?.length !== 1) return
    if (snapshotJson(character.chats[0]) !== attemptedSnapshot) return
    character.chats = cloneJsonValue(previousChats)
    character.chatPage = previousChatPage
    restored = true
  })
  if (restored) reloadGuiDisplay()
}

function restoreImportedCreatedChatAttempt(rollback: ChatImportedCreateRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const chats = character?.chats
    if (!character || !chats) return

    const attemptedIndex = chats.findIndex((chat) => chat.id === rollback.chatId)
    if (attemptedIndex < 0) return
    const liveChat = chats[attemptedIndex]
    if (snapshotJson(liveChat) !== snapshotJson(rollback.attemptedChat)) return

    const liveSelectedChatId = selectedChatIdForCharacter(character)
    chats.splice(attemptedIndex, 1)
    character.chats = chats
    preserveOrRestoreChatSelection(character, liveSelectedChatId, rollback.previousSelectedChatId)
  })
}

function chatRowMetadataRollbackFromPrevious(
  chatId: string,
  patch: ChatSnapshot,
  selectedCharID: number,
  characterId: string | undefined,
  previousChat: Chat,
): ChatRowMetadataSnapshot | null {
  const previousRow = previousChat as unknown as Record<string, unknown>
  const metadata: ChatSnapshot = {}
  const attempted: ChatSnapshot = {}
  for (const key of CHAT_PATCH_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (Object.prototype.hasOwnProperty.call(previousRow, key)) {
      metadata[key] = cloneJsonValue(previousRow[key])
    }
    attempted[key] = cloneJsonValue(patch[key])
  }
  if (Object.keys(attempted).length === 0) return null

  return {
    selectedCharID,
    characterId,
    chatId,
    metadata,
    attempted,
  }
}

function chatMetadataRollbackFromPatch(
  chatId: string,
  patch: ChatSnapshot | undefined,
  previous: ChatStateSnapshot,
): ChatRowMetadataSnapshot | null {
  if (!patch || Object.keys(patch).length === 0) return null
  const location = locateChatInState(previous, chatId)
  if (!location) return null
  return chatRowMetadataRollbackFromPrevious(
    chatId,
    patch,
    previous.selectedCharID,
    location.character.chaId,
    location.chat,
  )
}

function chatScopedMetadataRollbackFromPatch(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatScopedSnapshot,
): ChatRowMetadataSnapshot | null {
  if (!previous.chat || (previous.chatId && previous.chatId !== chatId)) return null
  return chatRowMetadataRollbackFromPrevious(
    chatId,
    patch,
    previous.selectedCharID,
    previous.characterId,
    previous.chat,
  )
}

function chatFolderMetadataRollbackFromPatch(
  folderId: string,
  patch: ChatFolderSnapshot,
  previous: ChatStateSnapshot,
): ChatFolderRowMetadataSnapshot | null {
  const location = locateChatFolderInState(previous, folderId)
  if (!location) return null

  return chatFolderMetadataRollbackFromPrevious(
    folderId,
    patch,
    previous.selectedCharID,
    location.character.chaId,
    location.folder,
  )
}

function chatFolderMetadataRollbackFromPrevious(
  folderId: string,
  patch: ChatFolderSnapshot,
  selectedCharID: number,
  characterId: string | undefined,
  previousFolder: ChatFolder,
): ChatFolderRowMetadataSnapshot | null {
  const previousRow = previousFolder as unknown as Record<string, unknown>
  const metadata: ChatFolderSnapshot = {}
  const attempted: ChatFolderSnapshot = {}
  for (const key of CHAT_FOLDER_PATCH_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (Object.prototype.hasOwnProperty.call(previousRow, key)) {
      metadata[key] = cloneJsonValue(previousRow[key])
    }
    attempted[key] = cloneJsonValue(patch[key])
  }
  if (Object.keys(attempted).length === 0) return null

  return {
    selectedCharID,
    characterId,
    folderId,
    metadata,
    attempted,
  }
}

function restoreCreatedChatFolderAttempt(characterId: string, folder: ChatFolder, previous: ChatStateSnapshot): void {
  if (!folder.id) return
  const attempted = cloneJsonValue(folder)
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    const folders = character?.chatFolders
    if (!folders) return

    const rolledBack = applyAttemptedKeyedListRollback<ChatFolder, string>({
      list: folders,
      entries: [
        {
          key: folder.id,
          previous: null,
          attempted,
        },
      ],
      getKey: (candidate) => candidate?.id,
    })
    if (rolledBack.length > 0) character.chatFolders = folders
  })
}

function chatCreatedFolderRollbackFromState(
  characterId: string | undefined,
  folder: ChatFolder | undefined,
  previous: ChatFolderCreateBaseline,
): ChatCreatedFolderRollback | null {
  if (!folder?.id) return null
  if ('kind' in previous) {
    if (previous.characterId !== characterId) return null
    if (previous.kind === 'chat-folder-create') {
      return previous.folderId === folder.id && !previous.existed ? previous : null
    }
    if (previous.previousFolderIds.includes(folder.id)) return null
    return {
      selectedCharID: previous.selectedCharID,
      characterId,
      folderId: folder.id,
      attemptedFolder: cloneJsonValue(folder),
    }
  }
  const previousCharacter = locateSnapshotCharacterInState(previous, characterId)
  if (previousCharacter?.chatFolders?.some((candidate) => candidate.id === folder.id)) return null
  return {
    selectedCharID: previous.selectedCharID,
    characterId,
    folderId: folder.id,
    attemptedFolder: cloneJsonValue(folder),
  }
}

function restoreCreatedChatFolderAttemptIfUnreferenced(rollback: ChatCreatedFolderRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const folders = character?.chatFolders
    if (!character || !folders) return
    if (character.chats?.some((chat) => chat.folderId === rollback.folderId)) return

    const rolledBack = applyAttemptedKeyedListRollback<ChatFolder, string>({
      list: folders,
      entries: [
        {
          key: rollback.folderId,
          previous: null,
          attempted: rollback.attemptedFolder,
        },
      ],
      getKey: (candidate) => candidate?.id,
    })
    if (rolledBack.length > 0) character.chatFolders = folders
  })
}

function chatForkRollbackFromState(
  sourceChatId: string,
  previous: ChatForkBaseline,
  input: {
    chat: Chat
    sourcePatch?: ChatSnapshot
    folder?: ChatFolder
    select?: boolean
  },
): ChatForkRollback | null {
  if ('kind' in previous) return previous.sourceChatId === sourceChatId ? previous.rollback : null
  const sourceLocation = locateChatInState(previous, sourceChatId)
  if (!sourceLocation) return null
  const characterId = sourceLocation.character.chaId
  return {
    createdChat: chatCreateRollbackFromState(characterId, input.chat, previous, input.select !== false),
    sourcePatch: chatMetadataRollbackFromPatch(sourceChatId, input.sourcePatch, previous),
    createdFolder: chatCreatedFolderRollbackFromState(characterId, input.folder, previous),
  }
}

function restoreForkChatAttempt(rollback: ChatForkRollback | null): void {
  if (!rollback) return
  restoreFailedCreatedChatAttempt(rollback.createdChat)
  if (rollback.sourcePatch) restoreChatRowMetadata(rollback.sourcePatch)
  restoreCreatedChatFolderAttemptIfUnreferenced(rollback.createdFolder)
}

function restoreImportedChatBatchAttempt(rollback: ChatImportBatchRollback): void {
  for (let index = rollback.chats.length - 1; index >= 0; index -= 1) {
    const step = rollback.chats[index]
    if (!step.accepted) restoreImportedCreatedChatAttempt(step.rollback)
  }
  for (const step of rollback.folders) {
    if (!step.accepted) restoreCreatedChatFolderAttemptIfUnreferenced(step.rollback)
  }
}

function chatDeleteRollbackFromState(chatId: string, previous: ChatDeleteBaseline): ChatDeleteRollback | null {
  if ('kind' in previous) {
    if (previous.chatId !== chatId) return null
    return { ...previous }
  }
  const location = locateChatInState(previous, chatId)
  if (!location) return null

  return {
    selectedCharID: previous.selectedCharID,
    characterId: location.character.chaId,
    chatId,
    chat: cloneJsonValue(location.chat),
    previousIndex: location.chatIndex,
    previousSelectedChatId: selectedChatIdForCharacter(location.character),
    attemptedSelectedChatId: selectedChatIdForCharacter(
      locateSnapshotCharacter(location.character.chaId, previous.selectedCharID),
    ),
  }
}

function restoreDeletedChatAttempt(rollback: ChatDeleteRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const chats = character?.chats
    if (!character || !chats) return

    const liveSelectedChatId = selectedChatIdForCharacter(character)
    const rolledBack = applyAttemptedKeyedListRollback<Chat, string>({
      list: chats,
      entries: [
        {
          key: rollback.chatId,
          previous: rollback.chat,
          attempted: null,
          previousIndex: rollback.previousIndex,
        },
      ],
      getKey: (chat) => chat?.id,
    })
    if (rolledBack.length > 0) character.chats = chats

    const preferredSelectedChatId =
      liveSelectedChatId === rollback.attemptedSelectedChatId ? rollback.previousSelectedChatId : liveSelectedChatId
    preserveOrRestoreChatSelection(character, preferredSelectedChatId, liveSelectedChatId)
  })
}

function chatFolderDeleteRollbackFromState(
  folderId: string,
  previous: ChatFolderDeleteBaseline,
): ChatFolderDeleteRollback | null {
  if ('kind' in previous) return previous.folderId === folderId ? previous : null
  const location = locateChatFolderInState(previous, folderId)
  if (!location) return null

  const affectedChats = (location.character.chats ?? [])
    .filter((chat) => chat.id && chat.folderId === folderId)
    .map((chat) => ({
      chatId: chat.id as string,
      previousFolderId: chat.folderId,
      attemptedFolderId: null,
    }))

  return {
    selectedCharID: previous.selectedCharID,
    characterId: location.character.chaId,
    folderId,
    folder: cloneJsonValue(location.folder),
    previousIndex: location.folderIndex,
    affectedChats,
  }
}

function restoreDeletedChatFolderAttempt(rollback: ChatFolderDeleteRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const folders = character?.chatFolders
    if (!character || !folders) return

    const rolledBack = applyAttemptedKeyedListRollback<ChatFolder, string>({
      list: folders,
      entries: [
        {
          key: rollback.folderId,
          previous: rollback.folder,
          attempted: null,
          previousIndex: rollback.previousIndex,
        },
      ],
      getKey: (folder) => folder?.id,
    })
    if (rolledBack.length > 0) character.chatFolders = folders

    for (const chatRollback of rollback.affectedChats) {
      const chat = character.chats?.find((candidate) => candidate.id === chatRollback.chatId)
      if (!chat) continue
      applyAttemptedFieldRollback({
        target: chat as unknown as Record<string, unknown>,
        previous: { folderId: chatRollback.previousFolderId },
        attempted: { folderId: chatRollback.attemptedFolderId },
        keys: ['folderId'],
      })
    }
  })
}

function chatFolderIds(folders: readonly ChatFolder[] | undefined): string[] {
  return (folders ?? []).map((folder) => folder.id)
}

function chatFolderOrderFromBaseline(characterId: string, previous: ChatOrderBaseline): string[] | null {
  if ('kind' in previous) return previous.characterId === characterId ? previous.previousFolderIds : null
  const owner = locateSnapshotCharacterInState(previous, characterId)
  return owner ? chatFolderIds(owner.chatFolders) : null
}

function chatRowIds(chats: readonly Chat[] | undefined): string[] {
  return (chats ?? []).map((chat) => chat.id).filter(Boolean) as string[]
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function chatFolderAssignmentValue(chat: Chat): string | null {
  return chat.folderId ?? null
}

function changedChatFolderAssignmentsFromState(
  characterId: string,
  attemptedFolderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
): Record<string, string | null> | undefined {
  if ('kind' in previous) {
    const changed: Record<string, string | null> = {}
    for (const [chatId, folderId] of Object.entries(attemptedFolderByChatId)) {
      const baseline = previous.previousFolderByChatId[chatId]
      if (!baseline || (baseline.previous ?? null) !== folderId) changed[chatId] = folderId
    }
    return Object.keys(changed).length > 0 ? changed : undefined
  }
  const previousCharacter = locateSnapshotCharacterInState(previous, characterId)
  if (!previousCharacter?.chats) {
    return Object.keys(attemptedFolderByChatId).length > 0 ? cloneJsonValue(attemptedFolderByChatId) : undefined
  }

  const previousChatsById = new Map(
    previousCharacter.chats.filter((chat) => chat.id).map((chat) => [chat.id as string, chat]),
  )
  const changed: Record<string, string | null> = {}
  for (const [chatId, folderId] of Object.entries(attemptedFolderByChatId)) {
    const previousChat = previousChatsById.get(chatId)
    if (!previousChat || chatFolderAssignmentValue(previousChat) !== folderId) {
      changed[chatId] = folderId
    }
  }
  return Object.keys(changed).length > 0 ? changed : undefined
}

function chatReorderRollbackFromState(
  characterId: string,
  chatIds: string[],
  folderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
): ChatReorderRollback | null {
  if ('kind' in previous) {
    if (previous.characterId !== characterId) return null
    return {
      selectedCharID: previous.selectedCharID,
      characterId,
      previousIds: previous.previousIds,
      previousFolderByChatId: previous.previousFolderByChatId,
      attemptedIds: cloneJsonValue(chatIds),
      attemptedFolderByChatId: cloneJsonValue(folderByChatId),
    }
  }
  const previousCharacter = locateSnapshotCharacterInState(previous, characterId)
  if (!previousCharacter?.chats) return null

  const previousFolderByChatId: Record<string, ChatFolderAssignmentRollback> = {}
  for (const chat of previousCharacter.chats) {
    if (!chat.id) continue
    previousFolderByChatId[chat.id] = {
      previous: cloneJsonValue(chat.folderId),
      previousHadValue: Object.prototype.hasOwnProperty.call(chat, 'folderId'),
    }
  }

  return {
    selectedCharID: previous.selectedCharID,
    characterId,
    previousIds: chatRowIds(previousCharacter.chats),
    previousFolderByChatId,
    attemptedIds: cloneJsonValue(chatIds),
    attemptedFolderByChatId: cloneJsonValue(folderByChatId),
  }
}

function liveChatFolderAssignmentsMatch(
  chats: readonly Chat[],
  attemptedFolderByChatId: Record<string, string | null>,
): boolean {
  for (const chat of chats) {
    if (!chat.id) return false
    if (chatFolderAssignmentValue(chat) !== (attemptedFolderByChatId[chat.id] ?? null)) return false
  }
  return true
}

function restoreChatOrderAttempt(rollback: ChatReorderRollback | null): void {
  if (!rollback) return
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(rollback.characterId, rollback.selectedCharID)
    const chats = character?.chats
    if (!character || !chats) return
    if (!stringArraysEqual(chatRowIds(chats), rollback.attemptedIds)) return
    if (!liveChatFolderAssignmentsMatch(chats, rollback.attemptedFolderByChatId)) return

    const selectedBeforeRollback = selectedChatIdForCharacter(character)
    const liveChatsById = new Map(chats.map((chat) => [chat.id, chat]))
    const restored = rollback.previousIds.map((id) => liveChatsById.get(id))
    if (restored.some((chat) => !chat)) return

    for (const chat of restored) {
      if (!chat?.id) continue
      const folderRollback = rollback.previousFolderByChatId[chat.id]
      if (!folderRollback) continue
      if (folderRollback.previousHadValue) {
        chat.folderId = cloneJsonValue(folderRollback.previous)
      } else {
        delete (chat as unknown as Record<string, unknown>).folderId
      }
    }
    character.chats = restored as Chat[]
    preserveOrRestoreChatSelection(character, selectedBeforeRollback, undefined)
  })
}

function restoreChatFolderOrderAttempt(
  characterId: string,
  previousIds: string[],
  attemptedIds: string[],
  previous: ChatOrderBaseline,
): void {
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    const folders = character?.chatFolders
    if (!character || !folders) return
    if (!stringArraysEqual(chatFolderIds(folders), attemptedIds)) return

    const liveFoldersById = new Map(folders.map((folder) => [folder.id, folder]))
    const restored = previousIds.map((id) => liveFoldersById.get(id))
    if (restored.some((folder) => !folder)) return

    character.chatFolders = restored as ChatFolder[]
  })
}

function runChatCommandAsync<T extends Record<string, unknown>>(
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult<T>> | null {
  if (!canUseServerCommands()) return null
  return runServerCommand({ command, rollback, ...options })
}

function hasExistingDurableMutationTransport(options: ServerCommandTransportOptions): boolean {
  return !!(
    options.mutationId ||
    options.databaseLineage ||
    options.executionWrapper ||
    options.failureRollbackDisposition
  )
}

function moduleEnabledProjectionTargets(previousModules: unknown, attemptedModules: unknown): string[] {
  if (!Array.isArray(previousModules) || !Array.isArray(attemptedModules)) return []
  const previous = new Set(previousModules.filter((value): value is string => typeof value === 'string'))
  const attempted = new Set(attemptedModules.filter((value): value is string => typeof value === 'string'))
  return [...new Set([...previous, ...attempted])]
    .filter((moduleId) => previous.has(moduleId) !== attempted.has(moduleId))
    .map(pendingMutationModuleEnabledProjectionTarget)
}

export function runChatCommand<T extends Record<string, unknown>>(
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
  options: ServerCommandTransportOptions = {},
): void {
  if (!canUseClientWriteAccess()) return
  void runChatCommandAsync(command, rollback, options)
}

export function runMessageCommand<T extends Record<string, unknown>>(
  command: (baseRevision: number) => Promise<ServerCommandResult<T>>,
  rollback: () => void,
): void {
  if (!canUseClientWriteAccess()) return
  runChatCommand(command, rollback)
}

// Exported so other modules can serialize multi-resource command fan-out
// against a shared optimistic snapshot. The command layer enqueues the whole
// sequence as one unit, advances the base revision after each accepted step,
// and reconciles the accumulated events once after the sequence settles.
export function runOptimisticCommandSequence(
  commands: readonly ServerCommandSequenceEntry[],
  rollback: () => void,
): void {
  if (!canUseClientWriteAccess()) return
  void runServerCommandSequence(commands, rollback)
}

export async function runOptimisticCommandSequenceAsync(
  commands: readonly ServerCommandSequenceEntry[],
  rollback: () => void,
): Promise<ServerCommandResult | null> {
  if (!canUseClientWriteAccess()) return { status: 'unavailable' }
  return runServerCommandSequence(commands, rollback)
}

function rollbackChatStructureUnlessCharacterRowChanged(
  characterId: string | undefined,
  optimisticRowEpoch: number | undefined,
  rollback: () => void,
): void {
  if (
    characterId &&
    optimisticRowEpoch !== undefined &&
    hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch)
  ) {
    return
  }
  rollback()
}

function applyOptimisticForkAttempt(
  sourceChatId: string,
  previous: ChatForkBaseline,
  input: {
    chat: Chat
    sourcePatch?: ChatSnapshot
    folder?: ChatFolder
    select?: boolean
  },
): boolean {
  const sourceLocation = 'kind' in previous ? null : locateChatInState(previous, sourceChatId)
  const sourceCharacterId = 'kind' in previous ? previous.characterId : sourceLocation?.character.chaId
  const previousSelectedChatId =
    'kind' in previous ? previous.previousSelectedChatId : selectedChatIdForCharacter(sourceLocation?.character)
  const createdChatId = input.chat.id
  if (('kind' in previous ? previous.sourceChatId !== sourceChatId : !sourceLocation) || !createdChatId) return false

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(sourceCharacterId, previous.selectedCharID)
    if (!character) return
    // Detach any compatibility-facade proxies a legacy caller may have placed
    // back into the owner arrays before applying the stable-owner fork.
    if (!('kind' in previous)) {
      character.chats = cloneJsonValue(character.chats ?? [])
      character.chatFolders = cloneJsonValue(character.chatFolders ?? [])
    }
    const sourceChat = character.chats.find((candidate) => candidate.id === sourceChatId)
    if (!sourceChat) return

    const selectedBefore = selectedChatIdForCharacter(character)
    if (input.folder && !character.chatFolders?.some((candidate) => candidate.id === input.folder?.id)) {
      character.chatFolders ??= []
      character.chatFolders.unshift(cloneJsonValue(input.folder))
    }

    if (input.sourcePatch) {
      const sourceRow = sourceChat as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(input.sourcePatch)) {
        sourceRow[key] = cloneJsonValue(value)
      }
    }

    if (!character.chats.some((candidate) => candidate.id === createdChatId)) {
      character.chats.unshift(cloneJsonValue(input.chat))
    }

    if (input.select !== false && selectedBefore === previousSelectedChatId) {
      selectChatById(character, createdChatId)
    } else {
      preserveOrRestoreChatSelection(character, selectedBefore, previousSelectedChatId)
    }
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

function applyOptimisticChatOrderAttempt(
  characterId: string,
  chatIds: readonly string[],
  folderByChatId: Readonly<Record<string, string | null>>,
  selectedChatId: string | undefined,
  previous: ChatOrderBaseline,
): boolean {
  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    if (!character?.chats || chatIds.length !== character.chats.length) return
    if (
      chatIds.some((chatId) => typeof chatId !== 'string' || chatId.trim() === '') ||
      new Set(chatIds).size !== chatIds.length
    ) {
      return
    }

    const chatsById = new Map(character.chats.map((chat) => [chat.id, chat]))
    if (chatsById.size !== character.chats.length || chatIds.some((chatId) => !chatsById.has(chatId))) return

    const selectedBefore = selectedChatIdForCharacter(character)
    character.chats = chatIds.map((chatId) =>
      'kind' in previous ? chatsById.get(chatId)! : cloneJsonValue(chatsById.get(chatId))!,
    )
    for (const chat of character.chats) {
      if (chat.id && Object.prototype.hasOwnProperty.call(folderByChatId, chat.id)) {
        chat.folderId = folderByChatId[chat.id]
      }
    }
    if (selectedChatId !== undefined) {
      preserveOrRestoreChatSelection(character, selectedChatId, selectedBefore)
    } else {
      // The server keeps the numeric chatPage when no explicit selection is
      // supplied, so mirror that behavior after changing the row order.
      character.chatPage = normalizeChatPageIndex(character.chatPage, character.chats?.length ?? 0)
    }
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

function applyOptimisticChatFolderOrderAttempt(
  characterId: string,
  folderIds: readonly string[],
  selectedChatId: string | undefined,
  previous: ChatOrderBaseline,
): boolean {
  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    const folders = character?.chatFolders
    if (!character || !folders || folderIds.length !== folders.length) return
    if (
      folderIds.some((folderId) => typeof folderId !== 'string' || folderId.trim() === '') ||
      new Set(folderIds).size !== folderIds.length
    ) {
      return
    }

    const foldersById = new Map(folders.map((folder) => [folder.id, folder]))
    if (foldersById.size !== folders.length || folderIds.some((folderId) => !foldersById.has(folderId))) return

    const selectedBefore = selectedChatIdForCharacter(character)
    character.chatFolders = folderIds.map((folderId) =>
      'kind' in previous ? foldersById.get(folderId)! : cloneJsonValue(foldersById.get(folderId))!,
    )
    preserveOrRestoreChatSelection(character, selectedChatId ?? selectedBefore, selectedBefore)
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

function applyOptimisticDeletedChatFolderAttempt(folderId: string, previous: ChatFolderDeleteBaseline): boolean {
  const location = 'kind' in previous ? null : locateChatFolderInState(previous, folderId)
  if ('kind' in previous ? previous.folderId !== folderId : !location) return false
  const characterId = 'kind' in previous ? previous.characterId : location?.character.chaId

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(characterId, previous.selectedCharID)
    const folderIndex = character?.chatFolders?.findIndex((folder) => folder.id === folderId) ?? -1
    if (!character || folderIndex < 0) return
    character.chatFolders.splice(folderIndex, 1)
    for (const chat of character.chats ?? []) {
      if (chat.folderId === folderId) chat.folderId = null
    }
    applied = true
  })
  if (applied) reloadGuiDisplay()
  return applied
}

function hasOptimisticCreatedChat(
  characterId: string,
  chatId: string,
  select: boolean,
  previousSelectedChatId: string | undefined,
): boolean {
  const character = getCharacterResourceOwner(characterId)
  if (character?.chats?.filter((chat) => chat.id === chatId).length !== 1) return false
  const liveSelectedChatId = selectedChatIdForCharacter(character)
  return select ? liveSelectedChatId === chatId : liveSelectedChatId === previousSelectedChatId
}

function isCanonicalOptimisticCreatedChat(chat: Chat): boolean {
  return (
    typeof chat.id === 'string' &&
    chat.id.trim() !== '' &&
    Array.isArray(chat.message) &&
    typeof chat.note === 'string' &&
    typeof chat.name === 'string' &&
    chat.name.trim() !== '' &&
    Array.isArray(chat.localLore)
  )
}

function isCanonicalOptimisticCreatedFolder(folder: ChatFolder | undefined): boolean {
  return (
    folder === undefined ||
    (typeof folder.id === 'string' && folder.id.trim() !== '' && typeof folder.folded === 'boolean')
  )
}

function hasOneLiveChatFolder(characterId: string, folderId: string): boolean {
  const character = getCharacterResourceOwner(characterId)
  return character?.chatFolders?.filter((folder) => folder.id === folderId).length === 1
}

export function dispatchCreateChat(characterId: string, chat: Chat, previous: ChatCreateBaseline, select = true): void {
  if (!canUseClientWriteAccess()) return
  void dispatchCreateChatWithOutcome(characterId, chat, previous, select)
}

export function dispatchCreateChatWithOutcome(
  characterId: string,
  chat: Chat,
  previous: ChatCreateBaseline,
  select = true,
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  // Explicit create seam: the existing compact create certificate still uses
  // the broad refresh epoch in server/commands.ts. All normal chat mutations
  // below use character-row or chat-body owner fences instead.
  const optimisticEpoch = captureDestructiveRefreshEpoch()
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const attemptedChat = cloneJsonValue(chat)
  const rollback = chatCreateRollbackFromState(characterId, attemptedChat, previous, select)
  let acknowledgeOptimistic =
    rollback?.previousChat === null &&
    !!attemptedChat.id &&
    isCanonicalOptimisticCreatedChat(attemptedChat) &&
    hasOptimisticCreatedChat(characterId, attemptedChat.id, select, rollback.previousSelectedChatId)
  if (acknowledgeOptimistic && attemptedChat.id) {
    acknowledgeOptimistic = markOptimisticCreatedChatTranscript(attemptedChat.id)
  }
  const body = freezeDurableChatRequestBody({ chat: toChatSnapshot(attemptedChat), select })
  const intent = durableChatMutationIntent('POST', `/characters/${encodeURIComponent(characterId)}/chats`, body)
  const rollbackAttempt = () => {
    rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () =>
      restoreFailedCreatedChatAttempt(rollback),
    )
    if (acknowledgeOptimistic && attemptedChat.id) invalidateOptimisticCreatedChatTranscript(attemptedChat.id)
  }
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        createChatCommand({
          baseRevision,
          characterId,
          chat: body.chat,
          select: body.select,
          acknowledgeOptimistic,
          optimisticEpoch,
          optimisticRowEpoch,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export async function dispatchResetChatsWithOutcome(
  characterId: string,
  chat: Chat,
  previous: ChatResetBaseline,
): Promise<ChatMutationOutcome> {
  const sessionGeneration = captureClientSessionGeneration()
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  flushRegisteredPendingOwnerMutation('chat-metadata', {})
  await flushPendingCharacterChatNoteOwnerMutations(characterId)
  if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration))
    return { status: 'failed', result: { status: 'unavailable' } }
  const attemptedChat = cloneJsonValue(chat)
  const body = freezeDurableChatRequestBody({ chat: toChatSnapshot(attemptedChat) })
  const intent = durableChatMutationIntent('PUT', `/characters/${encodeURIComponent(characterId)}/chats`, body)
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(
      characterId,
      'kind' in previous ? previous.projectionEpoch : undefined,
      () => restoreResetChatsAttempt(characterId, attemptedChat, previous),
    )
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        resetChatsCommand({
          baseRevision,
          characterId,
          chat: body.chat,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

function restoreRejectedImportedMessageSuffix(
  characterId: string,
  chatId: string,
  attemptedMessages: Message[],
  acceptedPrefixLength: number,
): void {
  if (acceptedPrefixLength >= attemptedMessages.length) return
  withChatOwnerProjectionWrite(() => {
    const location = locateChatById(chatId, characterId)
    const liveMessages = location?.chat.message
    if (!liveMessages || liveMessages.length < attemptedMessages.length) return
    if (snapshotJson(liveMessages.slice(0, attemptedMessages.length)) !== snapshotJson(attemptedMessages)) return
    liveMessages.splice(acceptedPrefixLength, attemptedMessages.length - acceptedPrefixLength)
  })
}

function importedChatDurableSteps(input: {
  characterId: string
  chat: Chat
  select: boolean
  rollbackCreate: () => void
  onCreateAccepted?: () => void
}): CharacterOwnedDurableBatchStep[] | null {
  const attemptedChat = cloneJsonValue(input.chat)
  const chatId = attemptedChat.id
  if (!chatId) return null
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const createPath = `/characters/${encodeURIComponent(input.characterId)}/chats`
  let createAccepted = false

  const createStep = (body: DurableChatRequestBody): CharacterOwnedDurableBatchStep => ({
    method: 'POST',
    path: createPath,
    body,
    command: async (baseRevision, frozenBody) => {
      const result = await createChatCommand({
        baseRevision,
        characterId: input.characterId,
        chat: frozenBody.chat as ChatSnapshot,
        select: frozenBody.select as boolean,
      })
      if (result.status === 'ok') {
        createAccepted = true
        input.onCreateAccepted?.()
      }
      return result
    },
    rollback: input.rollbackCreate,
  })

  const attemptedMessages = cloneJsonValue(attemptedChat.message ?? [])
  const metadataChat = cloneJsonValue(attemptedChat)
  metadataChat.message = []
  const messageSnapshots = attemptedMessages.map(toMessageSnapshot)
  const plan = planImportedChatRequests({
    characterId: input.characterId,
    chatId,
    fullChat: toChatSnapshot(attemptedChat),
    metadataChat: toChatSnapshot(metadataChat),
    messages: messageSnapshots,
    select: input.select,
    maxPayloadBytes: MAX_DURABLE_MUTATION_PAYLOAD_BYTES,
    payloadByteLength: (request: PlannedChatImportRequest<ChatSnapshot, MessageSnapshot>) =>
      pendingMutationIntentPayloadByteLength(
        durableChatMutationIntent(request.method, request.path, freezeDurableChatRequestBody(request.body)),
      ),
  })
  if (!plan) return null
  return [
    createStep(freezeDurableChatRequestBody(plan.create.body)),
    ...plan.tails.map<CharacterOwnedDurableBatchStep>((tail) => ({
      method: tail.method,
      path: tail.path,
      body: freezeDurableChatRequestBody(tail.body),
      command: (baseRevision, frozenBody) =>
        replaceTailMessagesCommand({
          baseRevision,
          chatId,
          afterMessageId: frozenBody.afterMessageId as string | null,
          messages: frozenBody.messages as MessageSnapshot[],
          optimisticChatBodyProjectionEpoch,
        }),
      rollback: () => {
        if (createAccepted) {
          restoreRejectedImportedMessageSuffix(input.characterId, chatId, attemptedMessages, tail.acceptedPrefixLength)
        }
      },
    })),
  ]
}

export async function dispatchCreateChatForImport(
  characterId: string,
  chat: Chat,
  previous: ChatStateSnapshot | ChatImportSnapshot,
  select = true,
): Promise<ChatImportDispatchResult> {
  if (!canUseClientWriteAccess()) return { status: 'error', error: 'client_write_access_required' }
  for (const message of chat.message ?? []) ensureMessageId(message)
  const attemptedChat = cloneJsonValue(chat)
  const rollback = chatCreateRollbackFromState(characterId, attemptedChat, previous, select)
  const steps = importedChatDurableSteps({
    characterId,
    chat: attemptedChat,
    select,
    rollbackCreate: () => restoreCreatedChatAttempt(rollback),
  })
  if (!steps) {
    restoreCreatedChatAttempt(rollback)
    return { status: 'error', error: CHAT_IMPORT_TOO_LARGE_ERROR }
  }
  const outcome = await dispatchCharacterOwnedDurableBatch(characterId, steps)
  // A persisted retryable create is already accepted locally. Reporting an
  // error would invite the import caller to submit the same projected chat a
  // second time while the exact first request is still queued.
  if (outcome.status === 'ok' || outcome.status === 'retained') return { status: 'ok' }
  return chatImportDispatchResult(outcome.failure)
}

export async function dispatchCreateImportedChats(
  characterId: string | undefined,
  folders: ChatFolder[],
  chats: Chat[],
  previous: ChatStateSnapshot | ChatImportSnapshot,
): Promise<ChatImportDispatchResult> {
  if (!canUseClientWriteAccess()) return { status: 'error', error: 'client_write_access_required' }
  if (!characterId) return { status: 'error', error: 'server_command_unavailable' }

  for (const chat of chats) {
    for (const message of chat.message ?? []) ensureMessageId(message)
  }
  const attemptedFolders = folders.map((folder) => cloneJsonValue(folder))
  const attemptedChats = chats.map((chat) => cloneJsonValue(chat))
  if (attemptedFolders.length === 0 && attemptedChats.length === 0) return { status: 'ok' }
  if (!canUseServerCommands()) return { status: 'ok' }
  const usedImportedChatIndexes = new Set<number>()
  const folderSteps: ChatImportBatchRollback['folders'] = attemptedFolders.map((folder) => ({
    rollback: chatCreatedFolderRollbackFromState(characterId, folder, previous),
    accepted: false,
  }))
  const chatSteps: ChatImportBatchRollback['chats'] = attemptedChats.map((chat) => ({
    rollback: importedChatCreateRollbackFromState(characterId, chat, previous, usedImportedChatIndexes),
    accepted: false,
  }))
  const rollbackBatch = () => restoreImportedChatBatchAttempt({ folders: folderSteps, chats: chatSteps })
  const cleanupRejectedFolders = () => {
    for (const step of folderSteps) {
      if (!step.accepted) restoreCreatedChatFolderAttemptIfUnreferenced(step.rollback)
    }
  }
  const durableSteps: CharacterOwnedDurableBatchStep[] = []

  for (const [index, folder] of attemptedFolders.entries()) {
    const body = freezeDurableChatRequestBody({ folder: toChatFolderSnapshot(folder) })
    const path = `/characters/${encodeURIComponent(characterId)}/chat-folders`
    const intent = durableChatMutationIntent('POST', path, body)
    if (pendingMutationIntentPayloadByteLength(intent) > MAX_DURABLE_MUTATION_PAYLOAD_BYTES) {
      rollbackBatch()
      return { status: 'error', error: CHAT_IMPORT_TOO_LARGE_ERROR }
    }
    durableSteps.push({
      method: 'POST',
      path,
      body,
      command: async (baseRevision, frozenBody) => {
        const result = await createChatFolderCommand({
          baseRevision,
          characterId,
          folder: frozenBody.folder as ChatFolderSnapshot,
        })
        if (result.status === 'ok') folderSteps[index].accepted = true
        return result
      },
      rollback: () => {
        if (!folderSteps[index].accepted) restoreCreatedChatFolderAttemptIfUnreferenced(folderSteps[index].rollback)
      },
    })
  }

  for (const [index, chat] of attemptedChats.entries()) {
    const steps = importedChatDurableSteps({
      characterId,
      chat,
      select: false,
      rollbackCreate: () => {
        if (!chatSteps[index].accepted) restoreImportedCreatedChatAttempt(chatSteps[index].rollback)
        cleanupRejectedFolders()
      },
      onCreateAccepted: () => {
        chatSteps[index].accepted = true
      },
    })
    if (!steps) {
      rollbackBatch()
      return { status: 'error', error: CHAT_IMPORT_TOO_LARGE_ERROR }
    }
    durableSteps.push(...steps)
  }

  const outcome = await dispatchCharacterOwnedDurableBatch(characterId, durableSteps)
  if (outcome.status === 'ok' || outcome.status === 'retained') return { status: 'ok' }
  // Individual step rollbacks can run while later optimistic chats still
  // reference an unaccepted folder. Revisit the whole rejected suffix after
  // every reserved batch slot has settled so those temporary references do
  // not leave rows in the UI that the server rejected.
  rollbackBatch()
  return chatImportDispatchResult(outcome.failure)
}

function chatImportDispatchResult(result: ServerCommandResult | null): ChatImportDispatchResult {
  if (!result || result.status === 'unavailable') {
    return { status: 'error', error: 'server_command_unavailable' }
  }
  if (result.status === 'conflict') {
    return { status: 'error', error: `revision_conflict:${result.currentRevision}` }
  }
  if (result.status === 'error') {
    return result
  }
  return { status: 'ok' }
}

function dispatchUpdateChatResult(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatStateSnapshot,
  select = false,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ServerCommandResult> | null {
  const commandPatch = sanitizeFrozenChatPatch(patch)
  if (Object.keys(commandPatch).length === 0 && !select) return null
  if (!canUseServerCommands()) return null
  const rollback = chatMetadataRollbackFromPatch(chatId, commandPatch, previous)
  const characterId = characterIdForChatInState(previous, chatId)
  const previousChat = locateChatInState(previous, chatId)?.chat as Chat | undefined
  const projectionTargets = Object.prototype.hasOwnProperty.call(commandPatch, 'modules')
    ? moduleEnabledProjectionTargets(previousChat?.modules, commandPatch.modules)
    : []
  const body = freezeDurableChatRequestBody({ patch: commandPatch, select })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}`, body)
  const execute = (transport: ServerCommandTransportOptions, rollbackAttempt: () => void) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatCommand({
          baseRevision,
          chatId,
          patch: body.patch,
          select: body.select,
        }),
      rollback: rollbackAttempt,
      ...transport,
    })
  if (!rollback) {
    return dispatchCharacterOwnedDurableMutation(
      characterId,
      intent,
      (transport) => execute(transport, () => {}),
      projectionTargets,
    )
  }

  const pendingAttempt = registerChatMetadataAttempt(chatId, rollback)
  const result = dispatchCharacterOwnedDurableMutation(
    characterId,
    intent,
    (transport) => {
      bindChatMetadataAttemptDurability(pendingAttempt, transport, rollbackRowMetadata)
      return execute(transport, () => rollbackChatMetadataAttempt(pendingAttempt, rollbackRowMetadata))
    },
    projectionTargets,
  )
  trackChatMetadataAttemptResult(pendingAttempt, result)
  return result
}

export function dispatchUpdateChat(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatStateSnapshot,
  select = false,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchUpdateChatWithOutcome(chatId, patch, previous, select, rollbackRowMetadata)
}

export function dispatchUpdateChatWithOutcome(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatStateSnapshot,
  select = false,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const commandPatch = sanitizeFrozenChatPatch(patch)
  if (Object.keys(commandPatch).length === 0 && !select) return
  const rollback = chatMetadataRollbackFromPatch(chatId, commandPatch, previous)
  return dispatchChatMetadataWithOutcome(
    chatId,
    commandPatch,
    rollback,
    characterIdForChatInState(previous, chatId),
    select,
    rollbackRowMetadata,
  )
}

/** Direct UI mutations capture affected fields before applying their optimistic patch. */
export function dispatchChatMetadataPatchWithOutcome(
  snapshot: ChatMetadataPatchSnapshot,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  return dispatchChatMetadataWithOutcome(
    snapshot.chatId,
    sanitizeFrozenChatPatch(snapshot.attempted),
    snapshot,
    snapshot.characterId,
    false,
    rollbackRowMetadata,
  )
}

function dispatchChatMetadataWithOutcome(
  chatId: string,
  commandPatch: ChatSnapshot,
  rollback: ChatRowMetadataSnapshot | null,
  characterId: string | undefined,
  select: boolean,
  rollbackRowMetadata: ChatRowMetadataRollback,
): Promise<ChatMutationOutcome> | undefined {
  if (Object.keys(commandPatch).length === 0 && !select) return
  const projectionTargets = Object.prototype.hasOwnProperty.call(commandPatch, 'modules')
    ? moduleEnabledProjectionTargets(rollback?.metadata.modules, commandPatch.modules)
    : []
  if (reportWriterAccessLostMutation()) {
    if (rollback) rollbackRowMetadata(rollback)
    return writerAccessLostChatMutationOutcome()
  }
  if (!canUseServerCommands()) return
  const body = freezeDurableChatRequestBody({ patch: commandPatch, select })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}`, body)
  const execute = (transport: ServerCommandTransportOptions, rollbackAttempt: () => void) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatCommand({
          baseRevision,
          chatId,
          patch: body.patch,
          select: body.select,
        }),
      rollback: rollbackAttempt,
      ...transport,
    })
  if (!rollback) {
    const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(
      characterId,
      intent,
      (transport) => execute(transport, () => {}),
      projectionTargets,
    ).catch(
      (error): CharacterOwnedDurableMutationOutcome<Record<string, unknown>> => ({
        result: failedChatMutationResult(error),
        retained: false,
      }),
    )
    return chatMutationOutcome(outcome)
  }

  const pendingAttempt = registerChatMetadataAttempt(chatId, rollback)
  const rollbackAttempt = () => rollbackChatMetadataAttempt(pendingAttempt, rollbackRowMetadata)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(
    characterId,
    intent,
    (transport) => {
      bindChatMetadataAttemptDurability(pendingAttempt, transport, rollbackRowMetadata)
      return execute(transport, rollbackAttempt)
    },
    projectionTargets,
  ).catch((error): CharacterOwnedDurableMutationOutcome<Record<string, unknown>> => {
    rollbackAttempt()
    return { result: failedChatMutationResult(error), retained: false }
  })
  const result = outcome.then((settled) => settled.result)
  trackChatMetadataAttemptResult(pendingAttempt, result)
  return chatMutationOutcome(outcome)
}

export function dispatchUpdateChatAsync(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatStateSnapshot,
  select = false,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ServerCommandResult> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  return dispatchUpdateChatResult(chatId, patch, previous, select, rollbackRowMetadata)
}

// Scalar-rollback variant of `dispatchUpdateChat` for chat selection: the
// same empty-patch select command, with the local optimistic write limited to the
// owning character's `chatPage` instead of cloning the whole characters array.
export function dispatchSelectChat(chatId: string, previous: ChatSelectionSnapshot): void {
  if (!canUseClientWriteAccess()) return
  if (!canUseServerCommands()) return
  applyOptimisticChatSelection(chatId, previous)
  const body = freezeDurableChatRequestBody({ patch: {}, select: true })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}`, body)
  void dispatchCharacterOwnedDurableMutation(previous.characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatCommand({
          baseRevision,
          chatId,
          patch: body.patch,
          select: body.select,
        }),
      rollback: () => restoreChatSelection(previous, chatId),
      ...transport,
    }),
  )
}

// Narrow-rollback variant of `dispatchUpdateChat` for the chat-metadata watcher.
// Identical command, but the rollback restores one chat row's scalar metadata
// instead of cloning the whole characters array.
export function dispatchUpdateChatRow(
  chatId: string,
  patch: ChatSnapshot,
  rollback: ChatRowMetadataSnapshot,
  options: ServerCommandTransportOptions = {},
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ServerCommandResult> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  const commandPatch = sanitizeFrozenChatPatch(patch)
  if (Object.keys(commandPatch).length === 0) return null
  const rollbackSnapshot: ChatRowMetadataSnapshot = {
    ...rollback,
    attempted: commandPatch,
  }
  if (!canUseServerCommands()) return null
  const body = freezeDurableChatRequestBody({ patch: commandPatch, select: false })
  const translatorPresetDependencyKeys =
    typeof commandPatch.translatorPresetId === 'string' && commandPatch.translatorPresetId.trim()
      ? [translatorPresetOwnerMutationKey(commandPatch.translatorPresetId)]
      : []
  const intent = durableChatMutationIntent(
    'PATCH',
    `/chats/${encodeURIComponent(chatId)}`,
    body,
    translatorPresetDependencyKeys,
  )
  const projectionTargets = Object.prototype.hasOwnProperty.call(commandPatch, 'modules')
    ? moduleEnabledProjectionTargets(rollback.metadata.modules, commandPatch.modules)
    : []
  const pendingAttempt = registerChatMetadataAttempt(chatId, rollbackSnapshot)
  const execute = (transport: ServerCommandTransportOptions) => {
    bindChatMetadataAttemptDurability(pendingAttempt, transport, rollbackRowMetadata)
    return runServerCommand({
      command: (baseRevision) =>
        updateChatCommand(
          {
            baseRevision,
            chatId,
            patch: body.patch,
            select: body.select,
          },
          transport.signal,
          transport.keepalive,
        ),
      rollback: () => rollbackChatMetadataAttempt(pendingAttempt, rollbackRowMetadata),
      ...transport,
    })
  }
  const result = hasExistingDurableMutationTransport(options)
    ? execute(options)
    : dispatchCharacterOwnedDurableMutation(
        rollback.characterId,
        intent,
        (transport) => execute({ ...options, ...transport }),
        projectionTargets,
      )
  trackChatMetadataAttemptResult(pendingAttempt, result)
  return result
}

// Chat-scoped-rollback variant of `dispatchUpdateChat` for paths that mutate the
// active chat row alongside its message history (e.g. bookmark toggles): a failed
// command restores that one chat row, not the whole characters array.
export function dispatchUpdateChatScoped(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatScopedSnapshot,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchUpdateChatScopedWithOutcome(chatId, patch, previous, rollbackRowMetadata)
}

export function dispatchUpdateChatScopedWithOutcome(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatScopedSnapshot,
  rollbackRowMetadata: ChatRowMetadataRollback = restoreChatRowMetadata,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const commandPatch = sanitizeFrozenChatPatch(patch)
  if (Object.keys(commandPatch).length === 0) return
  const rollback = chatScopedMetadataRollbackFromPatch(chatId, commandPatch, previous)
  if (reportWriterAccessLostMutation()) {
    if (rollback) rollbackRowMetadata(rollback)
    return writerAccessLostChatMutationOutcome()
  }
  if (!canUseServerCommands()) return
  const body = freezeDurableChatRequestBody({ patch: commandPatch, select: false })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}`, body)
  const projectionTargets = Object.prototype.hasOwnProperty.call(commandPatch, 'modules')
    ? moduleEnabledProjectionTargets(previous.chat?.modules, commandPatch.modules)
    : []
  const execute = (transport: ServerCommandTransportOptions, rollbackAttempt: () => void) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatCommand({
          baseRevision,
          chatId,
          patch: body.patch,
          select: body.select,
        }),
      rollback: rollbackAttempt,
      ...transport,
    })
  if (!rollback) {
    const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(
      previous.characterId,
      intent,
      (transport) => execute(transport, () => {}),
      projectionTargets,
    ).catch(
      (error): CharacterOwnedDurableMutationOutcome<Record<string, unknown>> => ({
        result: failedChatMutationResult(error),
        retained: false,
      }),
    )
    return chatMutationOutcome(outcome)
  }

  const pendingAttempt = registerChatMetadataAttempt(chatId, rollback)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(
    previous.characterId,
    intent,
    (transport) => {
      bindChatMetadataAttemptDurability(pendingAttempt, transport, rollbackRowMetadata)
      return execute(transport, () => rollbackChatMetadataAttempt(pendingAttempt, rollbackRowMetadata))
    },
    projectionTargets,
  ).catch((error): CharacterOwnedDurableMutationOutcome<Record<string, unknown>> => {
    rollbackChatMetadataAttempt(pendingAttempt, rollbackRowMetadata)
    return { result: failedChatMutationResult(error), retained: false }
  })
  const result = outcome.then((settled) => settled.result)
  trackChatMetadataAttemptResult(pendingAttempt, result)
  return chatMutationOutcome(outcome)
}

function registerChatMetadataAttempt(chatId: string, rollback: ChatRowMetadataSnapshot): PendingChatMetadataAttempt {
  const attempt = {
    sessionGeneration: captureClientSessionGeneration(),
    sequence: ++nextChatMetadataAttemptSequence,
    chatId,
    rollback,
  }
  const pending = pendingChatMetadataAttempts.get(chatId) ?? []
  pending.push(attempt)
  pendingChatMetadataAttempts.set(chatId, pending)
  return attempt
}

function rollbackChatMetadataAttempt(
  attempt: PendingChatMetadataAttempt,
  rollbackRowMetadata: ChatRowMetadataRollback,
): void {
  releaseChatProjectionAttempt(attempt)
  if (!canProjectChatAttempt(attempt)) {
    clearChatMetadataAttempt(attempt)
    return
  }
  rollbackRowMetadata(attempt.rollback)

  const failedAttempted = attempt.rollback.attempted
  if (failedAttempted) {
    const rebasedKeys = new Set<string>()
    for (const later of pendingChatMetadataAttempts.get(attempt.chatId) ?? []) {
      if (later.sequence <= attempt.sequence || !later.rollback.attempted || !canProjectChatAttempt(later)) continue
      for (const key of CHAT_PATCH_ALLOWED_KEYS) {
        if (rebasedKeys.has(key)) continue
        if (!Object.prototype.hasOwnProperty.call(failedAttempted, key)) continue
        if (!Object.prototype.hasOwnProperty.call(later.rollback.attempted, key)) continue
        const laterPrevious = Object.prototype.hasOwnProperty.call(later.rollback.metadata, key)
          ? later.rollback.metadata[key]
          : undefined
        if (snapshotJson(laterPrevious) !== snapshotJson(failedAttempted[key])) continue

        if (Object.prototype.hasOwnProperty.call(attempt.rollback.metadata, key)) {
          later.rollback.metadata[key] = cloneJsonValue(attempt.rollback.metadata[key])
        } else {
          delete later.rollback.metadata[key]
        }
        rebasedKeys.add(key)
      }
    }
  }

  clearChatMetadataAttempt(attempt)
}

function trackChatMetadataAttemptResult(
  attempt: PendingChatMetadataAttempt,
  result: Promise<ServerCommandResult> | null,
): void {
  trackDurableChatProjectionAttempt(
    attempt,
    result,
    () => clearChatMetadataAttempt(attempt),
    () => reapplyChatMetadataAttempt(attempt),
  )
}

function bindChatMetadataAttemptDurability(
  attempt: PendingChatMetadataAttempt,
  transport: ServerCommandTransportOptions,
  rollbackRowMetadata: ChatRowMetadataRollback,
): void {
  bindDurableChatProjectionAttempt(
    attempt,
    transport,
    { kind: 'character', characterId: attempt.rollback.characterId },
    () => reapplyChatMetadataAttempt(attempt),
    () => clearChatMetadataAttempt(attempt),
    () => rollbackChatMetadataAttempt(attempt, rollbackRowMetadata),
  )
}

function reapplyChatMetadataAttempt(attempt: PendingChatMetadataAttempt): void {
  if (!canProjectChatAttempt(attempt)) return
  const attempted = attempt.rollback.attempted
  if (!attempted || !attempt.rollback.characterId) return
  applyChatMetadataOwnerPatch(attempt.rollback.characterId, attempt.chatId, attempted)
}

function clearChatMetadataAttempt(attempt: PendingChatMetadataAttempt): void {
  const pending = pendingChatMetadataAttempts.get(attempt.chatId)
  if (!pending) return
  const next = pending.filter((candidate) => candidate.sequence !== attempt.sequence)
  if (next.length === 0) {
    pendingChatMetadataAttempts.delete(attempt.chatId)
  } else {
    pendingChatMetadataAttempts.set(attempt.chatId, next)
  }
}

export function setCurrentChatGreetingIndex(
  fmIndex: number,
  options: SetCurrentChatGreetingIndexOptions = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  const current = currentChatScopedSnapshot(options)
  const characterId = current.characterId
  const chatId = current.chatId
  if (!characterId || !chatId || !current.chat) return false

  const shouldDispatch = options.dispatch !== false
  if (!applyChatMetadataOwnerPatch(characterId, chatId, { fmIndex })) return false

  if (shouldDispatch) {
    dispatchUpdateChatScoped(chatId, { fmIndex }, current)
  }
  return true
}

export function setCurrentChatSelectedDraftHookId(
  hookId: string | null,
  options: SetCurrentChatSelectedDraftHookIdOptions = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  const current = currentChatScopedSnapshot(options)
  const characterId = current.characterId
  const chatId = current.chatId
  if (!characterId || !chatId || !current.chat) return false

  const shouldDispatch = options.dispatch !== false
  if (!applyChatMetadataOwnerPatch(characterId, chatId, { selectedDraftHookId: hookId ?? undefined })) return false

  if (shouldDispatch) {
    dispatchUpdateChatScoped(chatId, { selectedDraftHookId: hookId }, current)
  }
  return true
}

export type ChatTranslationSettingField =
  | 'translatorPresetId'
  | 'autoTranslate'
  | 'autoTranslateBotOnly'
  | 'bilingualDisplay'
  | 'bilingualEmphasis'

export type ChatTranslationSettingValueByField = {
  translatorPresetId: string | null
  autoTranslate: boolean
  autoTranslateBotOnly: boolean
  bilingualDisplay: boolean
  bilingualEmphasis: 'original' | 'translation'
}

export function setCurrentChatTranslationSettingWithOutcome<Field extends ChatTranslationSettingField>(
  field: Field,
  value: ChatTranslationSettingValueByField[Field],
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const previous = currentChatScopedSnapshot()
  const characterId = previous.characterId
  const chatId = previous.chatId
  if (!characterId || !chatId || !previous.chat) return
  if (!applyChatMetadataOwnerPatch(characterId, chatId, { [field]: value ?? undefined })) return

  return dispatchUpdateChatScopedWithOutcome(chatId, { [field]: value }, previous)
}

export function setCurrentChatPinnedWithOutcome(pinned: boolean): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const previous = currentChatScopedSnapshot()
  const characterId = previous.characterId
  const chatId = previous.chatId
  if (!characterId || !chatId || !previous.chat) return
  if (!applyChatMetadataOwnerPatch(characterId, chatId, { pinned })) return

  return dispatchUpdateChatScopedWithOutcome(chatId, { pinned }, previous)
}

function settledChatGenerationSettingsSaveOperation(
  settlement: ChatGenerationSettingsSaveSettlement,
): ChatGenerationSettingsSaveOperation {
  return { settlement: Promise.resolve(settlement) }
}

function pendingChatGenerationSettingsSaveOperation(): ChatGenerationSettingsSaveOperation & {
  settle: (settlement: ChatGenerationSettingsSaveSettlement) => void
} {
  let resolve!: (settlement: ChatGenerationSettingsSaveSettlement) => void
  let settled = false
  const settlement = new Promise<ChatGenerationSettingsSaveSettlement>((resolvePromise) => {
    resolve = resolvePromise
  })
  return {
    settlement,
    settle: (result) => {
      if (settled) return
      settled = true
      resolve(result)
    },
  }
}

export function dispatchSaveChatGenerationSettingsWithOutcome(
  chatId: string,
  generationSettings: ChatGenerationSettings,
  options: ServerCommandTransportOptions = {},
): ChatGenerationSettingsSaveOperation | null {
  if (!canUseClientWriteAccess()) return null
  const commandSettings = cloneJsonValue(generationSettings)
  const rollbackSnapshot = currentChatGenerationSettingsSnapshot(chatId)
  if (!rollbackSnapshot) return null
  const intent = diffChatGenerationSettings(
    rollbackSnapshot.hadGenerationSettings ? rollbackSnapshot.generationSettings : undefined,
    commandSettings,
  )
  if (!intent) return settledChatGenerationSettingsSaveOperation({ status: 'accepted' })
  if (reportWriterAccessLostMutation()) {
    return settledChatGenerationSettingsSaveOperation({
      status: 'failed',
      error: language.writerAccessLostMutation,
    })
  }
  const rollback: ChatGenerationSettingsSnapshot = {
    ...rollbackSnapshot,
    attemptedGenerationSettings: commandSettings,
  }

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const location = locateChatById(chatId, rollback.characterId)
    if (!location) return
    location.chat.generationSettings = cloneJsonValue(commandSettings)
    applied = true
  })
  if (!applied) return null

  if (!canUseServerCommands()) {
    restoreChatGenerationSettings(rollback)
    return settledChatGenerationSettingsSaveOperation({
      status: 'failed',
      error: language.writerAccessLostMutation,
    })
  }
  let state = pendingChatGenerationSettingsSaves.get(chatId)
  if (!state) {
    state = {
      confirmed: cloneJsonValue(rollbackSnapshot),
      jobs: [],
      tail: Promise.resolve(null),
    }
    pendingChatGenerationSettingsSaves.set(chatId, state)
  }
  const durableIntent = chatGenerationSettingsFullDurableIntent(chatId, commandSettings)
  const durableKey = chatResourceOwnerMutationKey(chatId, rollback.characterId)
  const operation = pendingChatGenerationSettingsSaveOperation()
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(durableKey, durableIntent)
  } catch (error) {
    restoreChatGenerationSettings(rollback)
    if (state.jobs.length === 0) pendingChatGenerationSettingsSaves.delete(chatId)
    operation.settle({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    return operation
  }
  const job: PendingChatGenerationSettingsJob = {
    sessionGeneration: captureClientSessionGeneration(),
    intent,
    originalTarget: commandSettings,
    fallbackRollback: rollback,
    options,
    pendingSave: registerPendingChatGenerationSettingsSave(chatId, commandSettings),
    durableIntent,
    outbox,
    settle: operation.settle,
  }
  state.jobs.push(job)
  enqueueChatGenerationSettingsSave(chatId, state, job)
  return operation
}

export function dispatchSaveChatGenerationSettings(
  chatId: string,
  generationSettings: ChatGenerationSettings,
  options: ServerCommandTransportOptions = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  return dispatchSaveChatGenerationSettingsWithOutcome(chatId, generationSettings, options) !== null
}

function enqueueChatGenerationSettingsSave(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  job: PendingChatGenerationSettingsJob,
): void {
  // Reserve the shared server revision queue in the same task as the UI edit.
  // The execution wrapper services any retained head before this job.
  const next = executeChatGenerationSettingsQueueSlot(chatId, state, job)
  state.tail = next
  void next.then(
    () => {
      if (pendingChatGenerationSettingsSaves.get(chatId) === state && state.tail === next && state.jobs.length === 0) {
        pendingChatGenerationSettingsSaves.delete(chatId)
      }
    },
    () => {
      if (pendingChatGenerationSettingsSaves.get(chatId) === state && state.tail === next && state.jobs.length === 0) {
        pendingChatGenerationSettingsSaves.delete(chatId)
      }
    },
  )
}

function executeChatGenerationSettingsQueueSlot(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  reservedJob: PendingChatGenerationSettingsJob,
): Promise<ServerCommandResult> {
  let activePrepared: PreparedChatGenerationSettingsSave | null = null
  const completed: Array<{ prepared: PreparedChatGenerationSettingsSave; result: ServerCommandResult }> = []
  let retainOptimisticFailure = false

  const queued = runServerCommand({
    command: (baseRevision) => {
      if (!activePrepared) throw new Error('Chat generation settings command ran before preparation')
      return saveChatGenerationSettingsCommand(
        { baseRevision, ...activePrepared.commandInput },
        activePrepared.job.options.signal,
        activePrepared.job.options.keepalive,
      )
    },
    rollback: () => {
      if (activePrepared) restoreChatGenerationSettings(activePrepared.rollback)
    },
    failureRollbackDisposition: () => (retainOptimisticFailure ? 'retain' : 'rollback'),
    executionWrapper: async (execute) => {
      let lastResult: ServerCommandResult = { status: 'unavailable' }
      while (state.jobs.length > 0) {
        const head = state.jobs[0]!
        if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(head.sessionGeneration)) {
          retainOptimisticFailure = true
          return { status: 'unavailable' }
        }
        const prepared = prepareChatGenerationSettingsSave(chatId, state, head)
        activePrepared = prepared
        const outcome = await executePreparedDurableMutationWithinQueue(
          {
            handle: head.outbox,
            intent: prepared.durableIntent,
            standaloneIntent: prepared.standaloneDurableIntent,
            onStandaloneIntent: () => {
              prepared.commandInput = prepared.fullCommandInput
            },
          },
          execute,
        )
        head.outbox = outcome.handle
        head.durableIntent = outcome.intent
        retainOptimisticFailure = outcome.settlement === 'retained'
        if (outcome.disposition === 'retained-without-send') {
          if (outcome.settlement === 'retained') {
            finishRetainedChatGenerationSettingsSave(chatId, state, head, prepared)
          } else {
            await finishChatGenerationSettingsSave(chatId, state, head, prepared, { status: 'unavailable' })
          }
          return { status: 'unavailable' }
        }

        lastResult = outcome.result
        if (outcome.result.status !== 'ok' && outcome.settlement === 'retained') {
          finishRetainedChatGenerationSettingsSave(chatId, state, head, prepared)
          return outcome.result
        }
        await finishChatGenerationSettingsSave(chatId, state, head, prepared, outcome.result)
        completed.push({ prepared, result: outcome.result })
        if (head === reservedJob) return lastResult
      }
      return lastResult
    },
  })
  return queued.then(async (result) => {
    const latest = completed.at(-1)
    if (latest && chatGenerationSettingsSaveNeedsReseed(latest.prepared, latest.result)) {
      await reseedChatGenerationSettingsQueue(chatId, latest.prepared.characterId, state)
    }
    return result
  })
}

function finishRetainedChatGenerationSettingsSave(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  job: PendingChatGenerationSettingsJob,
  prepared: PreparedChatGenerationSettingsSave,
): void {
  if (state.jobs[0] !== job) return
  state.jobs.shift()
  state.confirmed = {
    characterId: prepared.characterId,
    chatId,
    hadGenerationSettings: true,
    generationSettings: cloneJsonValue(prepared.fullCommandInput.generationSettings),
  }
  projectChatGenerationSettingsQueue(chatId, state)
  job.settle({ status: 'queued' })
}

function prepareChatGenerationSettingsSave(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  job: PendingChatGenerationSettingsJob,
): PreparedChatGenerationSettingsSave {
  const confirmed = state.confirmed ? cloneJsonValue(state.confirmed) : null
  const confirmedSettings = confirmed?.hadGenerationSettings ? confirmed.generationSettings : undefined
  const attemptedSettings = confirmed
    ? applySparseChatGenerationSettingsUpdate(confirmedSettings, job.intent)
    : cloneJsonValue(job.originalTarget)
  const sparseUpdate = confirmed ? diffChatGenerationSettings(confirmedSettings, attemptedSettings) : null
  const rollback = confirmed
    ? {
        ...confirmed,
        attemptedGenerationSettings: cloneJsonValue(attemptedSettings),
      }
    : {
        ...cloneJsonValue(job.fallbackRollback),
        attemptedGenerationSettings: cloneJsonValue(attemptedSettings),
      }

  const characterId = rollback.characterId
  const characterRowProjectionEpoch = characterId ? captureCharacterRowProjectionEpoch(characterId) : null
  const appliedRevisionBefore = peekAppliedServerResourceRevision()
  const fullCommandInput: Omit<SaveChatGenerationSettingsCommandInput, 'baseRevision'> = {
    chatId,
    generationSettings: attemptedSettings,
  }
  let commandInput = fullCommandInput
  if (sparseUpdate && characterId && characterRowProjectionEpoch !== null) {
    commandInput = {
      chatId,
      generationSettings: attemptedSettings,
      sparseUpdate,
      sparseBaseGenerationSettings: confirmedSettings ?? null,
      expectedCharacterId: characterId,
      optimisticCharacterRowEpoch: characterRowProjectionEpoch,
    }
  }

  return {
    job,
    rollback,
    characterId,
    characterRowProjectionEpoch,
    appliedRevisionBefore,
    commandInput,
    fullCommandInput,
    durableIntent: chatGenerationSettingsCommandDurableIntent(commandInput),
    standaloneDurableIntent: chatGenerationSettingsCommandDurableIntent(fullCommandInput),
  }
}

async function finishChatGenerationSettingsSave(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  job: PendingChatGenerationSettingsJob,
  prepared: PreparedChatGenerationSettingsSave,
  result: ServerCommandResult,
): Promise<void> {
  if (state.jobs[0] !== job) return
  state.jobs.shift()
  const settlement: ChatGenerationSettingsSaveSettlement =
    result.status === 'ok'
      ? { status: 'accepted' }
      : { status: 'failed', error: chatGenerationSettingsSaveFailureMessage(result) }
  if (result.status === 'ok') {
    acknowledgePendingChatGenerationSettingsSave(job.pendingSave)
  } else {
    clearPendingChatGenerationSettingsSave(job.pendingSave)
  }

  const resultRecord = result?.status === 'ok' ? (result as unknown as Record<string, unknown>) : null
  const acknowledged = resultRecord?.acknowledgedGenerationSettings
  const acknowledgementValid = isChatGenerationSettingsValue(acknowledged)
  if ((result?.status === 'ok' && !acknowledgementValid) || chatGenerationSettingsSaveNeedsReseed(prepared, result)) {
    await reseedChatGenerationSettingsQueue(chatId, prepared.characterId, state)
    job.settle(settlement)
    return
  }

  if (resultRecord && acknowledgementValid) {
    state.confirmed = {
      characterId:
        typeof resultRecord.characterId === 'string' ? resultRecord.characterId : prepared.rollback.characterId,
      chatId,
      hadGenerationSettings: true,
      generationSettings: cloneJsonValue(acknowledged),
    }
  }
  projectChatGenerationSettingsQueue(chatId, state)
  job.settle(settlement)
}

function chatGenerationSettingsSaveFailureMessage(result: ServerCommandResult): string {
  if (result.status === 'error') return result.error || 'Chat generation settings could not be saved.'
  if (result.status === 'conflict') return `Server revision conflict (${result.currentRevision}).`
  return 'Server commands are unavailable.'
}

function chatGenerationSettingsSaveNeedsReseed(
  prepared: PreparedChatGenerationSettingsSave,
  result: ServerCommandResult,
): boolean {
  const projectionChanged =
    prepared.characterId !== undefined &&
    prepared.characterRowProjectionEpoch !== null &&
    hasCharacterRowProjectionEpochChanged(prepared.characterId, prepared.characterRowProjectionEpoch)
  const appliedRevision = peekAppliedServerResourceRevision()
  const acknowledgementWasOvertaken =
    appliedRevision !== null &&
    (result.status === 'ok'
      ? appliedRevision > result.revision
      : prepared.appliedRevisionBefore === null || appliedRevision > prepared.appliedRevisionBefore)
  return acknowledgementWasOvertaken || projectionChanged
}

function chatGenerationSettingsFullDurableIntent(
  chatId: string,
  generationSettings: ChatGenerationSettings,
): DurableMutationIntent {
  return {
    version: 1,
    dependencyKeys: chatGenerationSettingsMutationDependencyKeys(generationSettings),
    requests: [
      {
        method: 'PUT',
        path: `/chats/${encodeURIComponent(chatId)}/generation-settings`,
        body: { generationSettings: cloneJsonValue(generationSettings) },
      },
    ],
  }
}

function chatGenerationSettingsCommandDurableIntent(
  input: Omit<SaveChatGenerationSettingsCommandInput, 'baseRevision'>,
): DurableMutationIntent {
  return {
    version: 1,
    dependencyKeys: chatGenerationSettingsMutationDependencyKeys(input.generationSettings),
    requests: [
      {
        method: 'PUT',
        path: `/chats/${encodeURIComponent(input.chatId)}/generation-settings`,
        body: createChatGenerationSettingsCommandDurableBody(input),
      },
    ],
  }
}

async function reseedChatGenerationSettingsQueue(
  chatId: string,
  characterId: string | undefined,
  state: PendingChatGenerationSettingsQueue,
): Promise<void> {
  for (const pending of state.jobs) clearPendingChatGenerationSettingsSave(pending.pendingSave)
  state.confirmed = null
  if (!characterId) {
    restoreUnknownChatGenerationSettingsGuards(chatId, state)
    return
  }

  const result = await fetchServerCharacter(characterId)
  if (result.status !== 'ok') {
    restoreUnknownChatGenerationSettingsGuards(chatId, state)
    return
  }
  // Jobs can be appended while the recovery read is in flight. Release every
  // current guard immediately before applying this authoritative row, then
  // replay all still-pending intents over the freshly read base.
  for (const pending of state.jobs) clearPendingChatGenerationSettingsSave(pending.pendingSave)
  if (!applyCharacterResource(result)) {
    restoreUnknownChatGenerationSettingsGuards(chatId, state)
    return
  }
  const authoritative = currentChatGenerationSettingsSnapshot(chatId)
  if (!authoritative || authoritative.characterId !== characterId) {
    restoreUnknownChatGenerationSettingsGuards(chatId, state)
    return
  }
  state.confirmed = cloneJsonValue(authoritative)
  projectChatGenerationSettingsQueue(chatId, state, true)
}

function restoreUnknownChatGenerationSettingsGuards(chatId: string, state: PendingChatGenerationSettingsQueue): void {
  const live = currentChatGenerationSettingsSnapshot(chatId)
  if (!live?.generationSettings) return
  for (const pending of state.jobs) {
    clearPendingChatGenerationSettingsSave(pending.pendingSave)
    pending.pendingSave = registerPendingChatGenerationSettingsSave(chatId, live.generationSettings)
  }
}

function projectChatGenerationSettingsQueue(
  chatId: string,
  state: PendingChatGenerationSettingsQueue,
  replaceAllPendingTokens = false,
): void {
  if (!canUseClientWriteAccess() || state.jobs.some((job) => !isClientSessionGenerationCurrent(job.sessionGeneration)))
    return
  if (!state.confirmed) return
  const projected = projectPendingChatGenerationSettings(state.confirmed, state.jobs)
  writeChatGenerationSettingsProjection(projected)
  if (replaceAllPendingTokens) {
    let settings = state.confirmed.hadGenerationSettings
      ? cloneJsonValue(state.confirmed.generationSettings)
      : undefined
    for (const pending of state.jobs) {
      settings = applySparseChatGenerationSettingsUpdate(settings, pending.intent)
      pending.pendingSave = registerPendingChatGenerationSettingsSave(chatId, settings)
    }
    return
  }
  const latestJob = state.jobs.at(-1)
  if (latestJob?.pendingSave && projected.generationSettings) {
    clearPendingChatGenerationSettingsSave(latestJob.pendingSave)
    latestJob.pendingSave = registerPendingChatGenerationSettingsSave(chatId, projected.generationSettings)
  }
}

function projectPendingChatGenerationSettings(
  confirmed: ChatGenerationSettingsSnapshot,
  jobs: readonly PendingChatGenerationSettingsJob[],
): ChatGenerationSettingsSnapshot {
  let projected = confirmed.hadGenerationSettings ? cloneJsonValue(confirmed.generationSettings) : undefined
  for (const pending of jobs) projected = applySparseChatGenerationSettingsUpdate(projected, pending.intent)
  return {
    characterId: confirmed.characterId,
    chatId: confirmed.chatId,
    hadGenerationSettings: jobs.length > 0 || confirmed.hadGenerationSettings,
    generationSettings: projected,
  }
}

function writeChatGenerationSettingsProjection(snapshot: ChatGenerationSettingsSnapshot): void {
  withChatOwnerProjectionWrite(() => {
    const location = locateChatById(snapshot.chatId, snapshot.characterId)
    if (!location) return
    if (snapshot.hadGenerationSettings) {
      location.chat.generationSettings = cloneJsonValue(snapshot.generationSettings)
    } else {
      delete (location.chat as unknown as Record<string, unknown>).generationSettings
    }
  })
}

function isChatGenerationSettingsValue(value: unknown): value is ChatGenerationSettings {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).jailbreakToggle === 'boolean'
  )
}

export function dispatchCompatibleChatUpdate(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  prepareCompatibleChatUpdate(previousChat, nextChat, previous).dispatch()
}

// Narrow-rollback variant of `dispatchCompatibleChatUpdate` for the slash-command
// message mutation path. Same per-resource factories, but a failed sequence
// restores only the one active chat row instead of the whole characters array.
export function dispatchCompatibleChatUpdateScoped(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatScopedSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous).dispatch()
}

export async function dispatchCompatibleChatUpdateScopedAsync(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatScopedSnapshot,
): Promise<CharacterOwnedDurableBatchResult | null> {
  if (!canUseClientWriteAccess()) return { status: 'failure', acceptedCount: 0, failure: { status: 'unavailable' } }
  return prepareCompatibleChatUpdateScoped(previousChat, nextChat, previous).dispatchAsync()
}

export interface CompatibleChatUpdatePreparation {
  commandCount: number
  dispatch: () => void
  dispatchAsync: () => Promise<CharacterOwnedDurableBatchResult | null>
}

interface CompatibleChatUpdateStep extends CharacterOwnedDurableBatchStep {}

interface CompatibleMessageListUpdate {
  method: DurableMutationRequestMethod
  path: string
  body: DurableChatRequestBody
  command: CharacterOwnedDurableBatchStep['command']
  attemptedMessages: Message[]
}

export function mutateChatWithScopedCommand(
  mutate: (chat: Chat, character: character) => void,
  options: MutateChatScopedOptions = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  const selectedChar = options.selectedChar ?? get(selectedCharID)
  const character = characterOwnerAt(selectedChar)
  if (!character?.chats) return false
  const selectedChat = options.selectedChat ?? character.chatPage
  const chat = character.chats?.[selectedChat]
  if (!chat) return false

  const previousChat = cloneJsonValue(chat) as Chat
  const scopedRollback: ChatScopedSnapshot = {
    selectedCharID: selectedChar,
    characterId: character.chaId,
    chatId: previousChat.id,
    chat: previousChat,
  }

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const liveCharacter = characterOwnerAt(selectedChar)
    const liveChat = liveCharacter?.chats?.[selectedChat]
    if (!liveCharacter || !liveChat) return
    mutate(liveChat, liveCharacter)
    ensureCompatibleAppendedMessageId(previousChat, liveChat)
    applied = true
  })
  if (!applied) return false

  const nextChat = characterOwnerAt(selectedChar)?.chats?.[selectedChat]
  if (!nextChat) return false
  dispatchCompatibleChatUpdateScoped(previousChat, cloneJsonValue(nextChat) as Chat, scopedRollback)
  return true
}

export async function mutateChatWithScopedCommandAsync(
  mutate: (chat: Chat, character: character) => void,
  options: MutateChatScopedOptions = {},
): Promise<boolean> {
  if (!canUseClientWriteAccess()) return false
  const selectedChar = options.selectedChar ?? get(selectedCharID)
  const character = characterOwnerAt(selectedChar)
  if (!character?.chats) return false
  const selectedChat = options.selectedChat ?? character.chatPage
  const chat = character.chats?.[selectedChat]
  if (!chat) return false

  const previousChat = cloneJsonValue(chat) as Chat
  const scopedRollback: ChatScopedSnapshot = {
    selectedCharID: selectedChar,
    characterId: character.chaId,
    chatId: previousChat.id,
    chat: previousChat,
  }

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const liveCharacter = characterOwnerAt(selectedChar)
    const liveChat = liveCharacter?.chats?.[selectedChat]
    if (!liveCharacter || !liveChat) return
    mutate(liveChat, liveCharacter)
    ensureCompatibleAppendedMessageId(previousChat, liveChat)
    applied = true
  })
  if (!applied) return false

  const nextChat = characterOwnerAt(selectedChar)?.chats?.[selectedChat]
  if (!nextChat) return false
  await dispatchCompatibleChatUpdateScopedAsync(previousChat, cloneJsonValue(nextChat) as Chat, scopedRollback)
  return true
}

export function prepareCompatibleChatUpdate(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatStateSnapshot,
): CompatibleChatUpdatePreparation {
  const chatId = nextChat?.id ?? previousChat?.id
  const scoped: ChatScopedSnapshot = {
    selectedCharID: previous.selectedCharID,
    characterId: chatId ? characterIdForChatInState(previous, chatId) : undefined,
    chatId,
    chat: previousChat ? cloneJsonValue(previousChat) : undefined,
  }
  return prepareCompatibleChatUpdateScoped(previousChat, nextChat, scoped)
}

// Compatibility bridges can fan one legacy chat replacement into several
// revisioned resources. Freeze and pre-stage every child row before the first
// request so retryable failures retain the whole projection and terminal
// failures roll back only the unaccepted suffix.
export function prepareCompatibleChatUpdateScoped(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatScopedSnapshot,
): CompatibleChatUpdatePreparation {
  const { steps, rejectedMessages } = buildCompatibleChatUpdateScopedSteps(previousChat, nextChat, previous)
  const rollbackRejectedMessages = () => {
    if (rejectedMessages) restoreScopedMessageListAttempt(previous, rejectedMessages)
  }
  return {
    commandCount: steps.length,
    dispatch: () => {
      rollbackRejectedMessages()
      if (steps.length > 0) void dispatchCharacterOwnedDurableBatch(previous.characterId, steps)
    },
    dispatchAsync: () => {
      rollbackRejectedMessages()
      return steps.length > 0 ? dispatchCharacterOwnedDurableBatch(previous.characterId, steps) : Promise.resolve(null)
    },
  }
}

interface CompatibleChatUpdatePlan {
  steps: CompatibleChatUpdateStep[]
  rejectedMessages: Message[] | null
}

function buildCompatibleChatUpdateScopedSteps(
  previousChat: Chat | undefined,
  nextChat: Chat | undefined,
  previous: ChatScopedSnapshot,
): CompatibleChatUpdatePlan {
  const steps: CompatibleChatUpdateStep[] = []
  const chatId = nextChat?.id ?? previousChat?.id
  if (!chatId || !previousChat || !nextChat) return { steps, rejectedMessages: null }

  const metadataPatch = sanitizeChatPatch(changedChatMetadata(previousChat, nextChat))
  if (Object.keys(metadataPatch).length > 0) {
    const rollback = chatMetadataRollbackFromScopedPatch(chatId, metadataPatch, previous)
    const body = freezeDurableChatRequestBody({ patch: metadataPatch, select: false })
    steps.push({
      method: 'PATCH',
      path: `/chats/${encodeURIComponent(chatId)}`,
      body,
      projectionTargets: Object.prototype.hasOwnProperty.call(metadataPatch, 'modules')
        ? moduleEnabledProjectionTargets(previousChat.modules, nextChat.modules)
        : [],
      command: (baseRevision, frozenBody) =>
        updateChatCommand({
          baseRevision,
          chatId,
          patch: frozenBody.patch as ChatSnapshot,
          select: frozenBody.select as boolean,
        }),
      rollback: () => {
        if (rollback) restoreChatRowMetadata(rollback)
      },
    })
  }

  const previousMessages = previousChat.message ?? []
  const nextMessages = nextChat.message ?? []
  const messagesChanged = snapshotJson(previousMessages) !== snapshotJson(nextMessages)
  const messageUpdate = buildCompatibleMessageListUpdate(chatId, previousMessages, nextMessages)
  const rejectedMessages =
    !messageUpdate &&
    messagesChanged &&
    ((previousMessages.length === 0 && !isKnownHydratedChatTranscript(chatId)) ||
      hasServerChatMessagePlaceholders(nextMessages))
      ? cloneJsonValue(nextMessages)
      : null
  if (messageUpdate) {
    steps.push({
      method: messageUpdate.method,
      path: messageUpdate.path,
      body: messageUpdate.body,
      command: messageUpdate.command,
      rollback: () => restoreScopedMessageListAttempt(previous, messageUpdate.attemptedMessages),
    })
  }

  const scriptstatePatch = changedScriptstatePatch(previousChat.scriptstate, nextChat.scriptstate)
  const commandPatch = sanitizeScriptstatePatch(scriptstatePatch.patch)
  const commandDeleteKeys = sanitizeScriptstateDeleteKeys(scriptstatePatch.deleteKeys)
  if (Object.keys(commandPatch).length > 0 || commandDeleteKeys.length > 0) {
    const scriptstateSnapshot = chatScriptstateSnapshotFromScoped(previous, chatId)
    const body = freezeDurableChatRequestBody({ patch: commandPatch, deleteKeys: commandDeleteKeys })
    steps.push({
      method: 'PATCH',
      path: `/chats/${encodeURIComponent(chatId)}/scriptstate`,
      body,
      command: (baseRevision, frozenBody) =>
        patchChatScriptstateCommand({
          baseRevision,
          chatId,
          patch: frozenBody.patch as ChatScriptstatePatch,
          deleteKeys: frozenBody.deleteKeys as string[],
        }),
      rollback: () => restoreChatScriptstateAttempt(scriptstateSnapshot, commandPatch, commandDeleteKeys),
    })
  }

  return { steps, rejectedMessages }
}

function buildCompatibleMessageListUpdate(
  chatId: string,
  previousMessages: Message[],
  nextMessages: Message[],
): CompatibleMessageListUpdate | null {
  if (snapshotJson(previousMessages) === snapshotJson(nextMessages)) return null
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)

  const narrowUpdate = buildNarrowCompatibleMessageListUpdate(
    chatId,
    previousMessages,
    nextMessages,
    optimisticChatBodyProjectionEpoch,
  )
  if (narrowUpdate) return narrowUpdate
  // Bootstrap resources deliberately represent every unopened transcript as
  // an unmarked empty array. A broad replacement diffed from that shell would
  // make the server delete its real rows. The one-message append above is safe:
  // its server command appends after the persisted tail without consulting the
  // incomplete local prefix.
  if (previousMessages.length === 0 && !isKnownHydratedChatTranscript(chatId)) return null
  if (hasServerChatMessagePlaceholders(nextMessages)) return null

  for (const message of nextMessages) {
    ensureMessageId(message)
  }
  const attemptedMessages = cloneJsonValue(nextMessages)
  const messages = attemptedMessages.map(toMessageSnapshot)
  const body = freezeDurableChatRequestBody({ messages })
  return {
    method: 'PUT',
    path: `/chats/${encodeURIComponent(chatId)}/messages`,
    body,
    command: (baseRevision, frozenBody) =>
      replaceMessagesCommand({
        baseRevision,
        chatId,
        messages: frozenBody.messages as MessageSnapshot[],
        optimisticChatBodyProjectionEpoch,
      }),
    attemptedMessages,
  }
}

function buildNarrowCompatibleMessageListUpdate(
  chatId: string,
  previousMessages: Message[],
  nextMessages: Message[],
  optimisticChatBodyProjectionEpoch: number,
): CompatibleMessageListUpdate | null {
  const appendedMessage = singleMessageAppend(previousMessages, nextMessages)
  if (appendedMessage) {
    ensureMessageId(appendedMessage)
    const message = toMessageSnapshot(appendedMessage)
    const body = freezeDurableChatRequestBody({ message })
    return {
      method: 'POST',
      path: `/chats/${encodeURIComponent(chatId)}/messages`,
      body,
      command: (baseRevision, frozenBody) =>
        appendMessageCommand({
          baseRevision,
          chatId,
          message: frozenBody.message as MessageSnapshot,
          optimisticChatBodyProjectionEpoch,
        }),
      attemptedMessages: cloneJsonValue(nextMessages),
    }
  }

  const messagePatch = singleMessagePatch(previousMessages, nextMessages)
  if (messagePatch) {
    const body = freezeDurableChatRequestBody({ patch: messagePatch.patch })
    return {
      method: 'PATCH',
      path: `/messages/${encodeURIComponent(messagePatch.messageId)}`,
      body,
      command: (baseRevision, frozenBody) =>
        updateMessageCommand({
          baseRevision,
          messageId: messagePatch.messageId,
          patch: frozenBody.patch as MessageSnapshot,
          optimisticChatId: chatId,
          optimisticChatBodyProjectionEpoch,
        }),
      attemptedMessages: cloneJsonValue(nextMessages),
    }
  }

  const truncation = prefixTruncation(previousMessages, nextMessages)
  if (truncation) {
    const body = freezeDurableChatRequestBody({ afterMessageId: truncation.afterMessageId })
    return {
      method: 'POST',
      path: `/chats/${encodeURIComponent(chatId)}/messages/truncate`,
      body,
      command: (baseRevision, frozenBody) =>
        truncateMessagesCommand({
          baseRevision,
          chatId,
          afterMessageId: frozenBody.afterMessageId as string | null,
          optimisticChatBodyProjectionEpoch,
        }),
      attemptedMessages: cloneJsonValue(nextMessages),
    }
  }

  const deletedMessageId = singleMessageDelete(previousMessages, nextMessages)
  if (deletedMessageId) {
    return {
      method: 'DELETE',
      path: `/messages/${encodeURIComponent(deletedMessageId)}`,
      body: {},
      command: (baseRevision) =>
        deleteMessageCommand({
          baseRevision,
          messageId: deletedMessageId,
          optimisticChatId: chatId,
          optimisticChatBodyProjectionEpoch,
        }),
      attemptedMessages: cloneJsonValue(nextMessages),
    }
  }

  const replacement = tailReplacementAfterKnownAnchor(previousMessages, nextMessages)
  if (!replacement) return null

  for (const message of replacement.messages) {
    ensureMessageId(message)
  }
  const messages = replacement.messages.map(toMessageSnapshot)
  const body = freezeDurableChatRequestBody({ afterMessageId: replacement.afterMessageId, messages })
  return {
    method: 'POST',
    path: `/chats/${encodeURIComponent(chatId)}/messages/tail`,
    body,
    command: (baseRevision, frozenBody) =>
      replaceTailMessagesCommand({
        baseRevision,
        chatId,
        afterMessageId: frozenBody.afterMessageId as string | null,
        messages: frozenBody.messages as MessageSnapshot[],
        optimisticChatBodyProjectionEpoch,
      }),
    attemptedMessages: cloneJsonValue(nextMessages),
  }
}

function singleMessageAppend(previousMessages: Message[], nextMessages: Message[]): Message | null {
  if (nextMessages.length !== previousMessages.length + 1) return null
  if (!messagePrefixMatches(previousMessages, nextMessages, previousMessages.length)) return null

  const appendedMessage = nextMessages[nextMessages.length - 1]
  return isServerChatMessagePlaceholder(appendedMessage) ? null : appendedMessage
}

function ensureCompatibleAppendedMessageId(previousChat: Chat, nextChat: Chat): void {
  const appendedMessage = singleMessageAppend(previousChat.message ?? [], nextChat.message ?? [])
  if (appendedMessage) ensureMessageId(appendedMessage)
}

function singleMessagePatch(
  previousMessages: Message[],
  nextMessages: Message[],
): { messageId: string; patch: MessageSnapshot } | null {
  if (previousMessages.length !== nextMessages.length) return null

  let changedIndex = -1
  for (let index = 0; index < previousMessages.length; index += 1) {
    const previousId = knownPersistedMessageId(previousMessages[index])
    const nextId = knownPersistedMessageId(nextMessages[index])
    if (!previousId || previousId !== nextId) return null

    if (snapshotJson(previousMessages[index]) !== snapshotJson(nextMessages[index])) {
      if (changedIndex >= 0) return null
      changedIndex = index
    }
  }
  if (changedIndex < 0) return null

  const changedFields = changedMessageFields(previousMessages[changedIndex], nextMessages[changedIndex])
  if (!messagePatchCanRepresentChange(changedFields)) return null

  const patch = sanitizeMessagePatch(changedFields)
  if (Object.keys(patch).length === 0) return null

  const messageId = knownPersistedMessageId(previousMessages[changedIndex])
  return messageId ? { messageId, patch } : null
}

function prefixTruncation(
  previousMessages: Message[],
  nextMessages: Message[],
): { afterMessageId: string | null } | null {
  if (nextMessages.length >= previousMessages.length) return null
  if (!messagePrefixMatches(previousMessages, nextMessages, nextMessages.length)) return null
  if (nextMessages.length === 0) return { afterMessageId: null }

  const afterMessageId = knownPersistedMessageId(nextMessages[nextMessages.length - 1])
  return afterMessageId ? { afterMessageId } : null
}

function singleMessageDelete(previousMessages: Message[], nextMessages: Message[]): string | null {
  if (nextMessages.length !== previousMessages.length - 1) return null

  for (let index = 0; index < previousMessages.length; index += 1) {
    const deletedMessageId = knownPersistedMessageId(previousMessages[index])
    if (!deletedMessageId) continue
    if (messageListMatchesAfterRemovingIndex(previousMessages, nextMessages, index)) {
      return deletedMessageId
    }
  }

  return null
}

function messageListMatchesAfterRemovingIndex(
  previousMessages: Message[],
  nextMessages: Message[],
  removedIndex: number,
): boolean {
  let nextIndex = 0
  for (let previousIndex = 0; previousIndex < previousMessages.length; previousIndex += 1) {
    if (previousIndex === removedIndex) continue
    if (snapshotJson(previousMessages[previousIndex]) !== snapshotJson(nextMessages[nextIndex])) return false
    nextIndex += 1
  }
  return nextIndex === nextMessages.length
}

function tailReplacementAfterKnownAnchor(
  previousMessages: Message[],
  nextMessages: Message[],
): { afterMessageId: string; messages: Message[] } | null {
  const commonPrefixLength = unchangedMessagePrefixLength(previousMessages, nextMessages)
  let anchorIndex = commonPrefixLength - 1
  while (anchorIndex >= 0 && !knownPersistedMessageId(previousMessages[anchorIndex])) {
    anchorIndex -= 1
  }
  if (anchorIndex < 0) return null

  const previousTail = previousMessages.slice(anchorIndex + 1)
  const nextTail = nextMessages.slice(anchorIndex + 1)
  if (previousTail.some(isServerChatMessagePlaceholder) || nextTail.some(isServerChatMessagePlaceholder)) {
    return null
  }
  if (snapshotJson(previousTail) === snapshotJson(nextTail)) return null

  const afterMessageId = knownPersistedMessageId(previousMessages[anchorIndex])
  if (!afterMessageId) return null
  return {
    afterMessageId,
    messages: nextTail,
  }
}

function knownPersistedMessageId(message: Message | undefined): string | null {
  if (!message || isServerChatMessagePlaceholder(message)) return null
  return typeof message.chatId === 'string' && message.chatId.length > 0 ? message.chatId : null
}

function unchangedMessagePrefixLength(previousMessages: Message[], nextMessages: Message[]): number {
  const length = Math.min(previousMessages.length, nextMessages.length)
  let index = 0
  while (index < length && snapshotJson(previousMessages[index]) === snapshotJson(nextMessages[index])) {
    index += 1
  }
  return index
}

function messagePrefixMatches(previousMessages: Message[], nextMessages: Message[], length: number): boolean {
  return unchangedMessagePrefixLength(previousMessages, nextMessages) >= length
}

function changedMessageFields(previousMessage: Message, nextMessage: Message): MessageSnapshot {
  const patch: MessageSnapshot = {}
  const previousRecord = previousMessage as unknown as Record<string, unknown>
  const nextRecord = nextMessage as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)])
  for (const key of keys) {
    const previousValue = previousRecord[key]
    const nextValue = nextRecord[key]
    if (snapshotJson(previousValue) !== snapshotJson(nextValue)) {
      patch[key] = cloneJsonValue(nextValue)
    }
  }
  return patch
}

function messagePatchCanRepresentChange(patch: MessageSnapshot): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (!MESSAGE_PATCH_ALLOWED_KEYS.has(key) || value === undefined) return false
  }
  return true
}

function chatMetadataRollbackFromScopedPatch(
  chatId: string,
  patch: ChatSnapshot,
  previous: ChatScopedSnapshot,
): ChatRowMetadataSnapshot | null {
  if (!previous.chat || Object.keys(patch).length === 0) return null
  const metadata: ChatSnapshot = {}
  const attempted: ChatSnapshot = {}
  const previousRow = previous.chat as unknown as Record<string, unknown>
  for (const key of CHAT_PATCH_ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (Object.prototype.hasOwnProperty.call(previousRow, key)) {
      metadata[key] = cloneJsonValue(previousRow[key])
    }
    attempted[key] = cloneJsonValue(patch[key])
  }
  if (Object.keys(attempted).length === 0) return null
  return {
    selectedCharID: previous.selectedCharID,
    characterId: previous.characterId,
    chatId,
    metadata,
    attempted,
  }
}

function chatScriptstateSnapshotFromScoped(previous: ChatScopedSnapshot, chatId: string): ChatScriptstateSnapshot {
  return {
    characterId: previous.characterId,
    chatId,
    selectedCharID: previous.selectedCharID,
    scriptstate: previous.chat?.scriptstate ? { ...previous.chat.scriptstate } : undefined,
  }
}

export function dispatchDeleteChat(chatId: string, previous: ChatDeleteBaseline): void {
  if (!canUseClientWriteAccess()) return
  void dispatchDeleteChatWithOutcome(chatId, previous)
}

export async function dispatchDeleteChatWithOutcome(
  chatId: string,
  previous: ChatDeleteBaseline,
): Promise<ChatMutationOutcome | undefined> {
  const sessionGeneration = captureClientSessionGeneration()
  if (!canUseClientWriteAccess()) return { status: 'failed', result: { status: 'unavailable' } }
  if (!canUseServerCommands()) return
  const rollback = chatDeleteRollbackFromState(chatId, previous)
  const optimisticRowEpoch =
    'kind' in previous
      ? previous.projectionEpoch
      : rollback?.characterId
        ? captureCharacterRowProjectionEpoch(rollback.characterId)
        : undefined
  flushRegisteredPendingOwnerMutation('chat-metadata', {})
  await flushPendingChatNoteOwnerMutation(chatId)
  if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration))
    return { status: 'failed', result: { status: 'unavailable' } }
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'DELETE',
        path: `/chats/${encodeURIComponent(chatId)}`,
        body: {},
      },
    ],
  }
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(rollback?.characterId, optimisticRowEpoch, () =>
      restoreDeletedChatAttempt(rollback),
    )
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(chatResourceOwnerMutationKey(chatId, rollback?.characterId), intent)
  } catch (error) {
    rollbackAttempt()
    return Promise.resolve({ status: 'failed', result: failedChatMutationResult(error) })
  }
  const outcome = dispatchPreparedCharacterOwnedDurableMutationWithOutcome(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        deleteChatCommand({
          baseRevision,
          chatId,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function dispatchForkChat(
  sourceChatId: string,
  previous: ChatForkBaseline,
  input: {
    chat: Chat
    sourcePatch?: ChatSnapshot
    folder?: ChatFolder
    select?: boolean
  },
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchForkChatWithOutcome(sourceChatId, previous, input)
}

export function dispatchForkChatWithOutcome(
  sourceChatId: string,
  previous: ChatForkBaseline,
  input: {
    chat: Chat
    sourcePatch?: ChatSnapshot
    folder?: ChatFolder
    select?: boolean
  },
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  // Explicit create seam: forking creates a new chat (and optionally a folder),
  // whose current compact certificate still requires the broad refresh epoch.
  const optimisticEpoch = captureDestructiveRefreshEpoch()
  const attemptedChat = cloneJsonValue(input.chat)
  const attemptedSourcePatch = input.sourcePatch ? sanitizeFrozenChatPatch(input.sourcePatch) : undefined
  const attemptedFolder = input.folder ? cloneJsonValue(input.folder) : undefined
  const rollback = chatForkRollbackFromState(sourceChatId, previous, {
    chat: attemptedChat,
    sourcePatch: attemptedSourcePatch,
    folder: attemptedFolder,
    select: input.select,
  })
  const optimisticRowEpoch = rollback?.createdChat?.characterId
    ? captureCharacterRowProjectionEpoch(rollback.createdChat.characterId)
    : undefined
  const optimisticApplied = applyOptimisticForkAttempt(sourceChatId, previous, {
    chat: attemptedChat,
    sourcePatch: attemptedSourcePatch,
    folder: attemptedFolder,
    select: input.select,
  })
  let acknowledgeOptimistic =
    optimisticApplied &&
    isCanonicalOptimisticCreatedChat(attemptedChat) &&
    isCanonicalOptimisticCreatedFolder(attemptedFolder)
  if (acknowledgeOptimistic && attemptedChat.id) {
    acknowledgeOptimistic = markOptimisticCreatedChatTranscript(attemptedChat.id)
  }
  const characterId =
    rollback?.createdChat?.characterId ??
    ('kind' in previous ? previous.characterId : locateChatInState(previous, sourceChatId)?.character.chaId)
  const body = freezeDurableChatRequestBody({
    chat: toChatSnapshot(attemptedChat),
    ...(attemptedSourcePatch ? { sourcePatch: attemptedSourcePatch } : {}),
    ...(attemptedFolder ? { folder: toChatFolderSnapshot(attemptedFolder) } : {}),
    ...(input.select !== undefined ? { select: input.select } : {}),
  })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(sourceChatId)}/fork`, body)
  const rollbackAttempt = () => {
    rollbackChatStructureUnlessCharacterRowChanged(rollback?.createdChat?.characterId, optimisticRowEpoch, () =>
      restoreForkChatAttempt(rollback),
    )
    if (acknowledgeOptimistic && attemptedChat.id) invalidateOptimisticCreatedChatTranscript(attemptedChat.id)
  }
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        forkChatCommand({
          baseRevision,
          chatId: sourceChatId,
          chat: body.chat,
          sourcePatch: body.sourcePatch,
          folder: body.folder,
          select: body.select,
          acknowledgeOptimistic,
          optimisticEpoch,
          optimisticRowEpoch,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function dispatchReorderChats(characterId: string, previous: ChatOrderBaseline, selectedChatId?: string): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderChatsWithOutcome(characterId, previous, selectedChatId)
}

export function dispatchReorderChatsWithOutcome(
  characterId: string,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const character = getCharacterResourceOwner(characterId)
  if (!character) return
  const folderByChatId: Record<string, string | null> = {}
  for (const chat of character.chats) {
    if (!chat.id) continue
    folderByChatId[chat.id] = chat.folderId ?? null
  }
  return dispatchReorderChatsByIdsWithOutcome(
    characterId,
    character.chats.map((chat) => chat.id).filter(Boolean) as string[],
    folderByChatId,
    previous,
    selectedChatId,
  )
}

export function dispatchReorderChatsByIds(
  characterId: string,
  chatIds: string[],
  folderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderChatsByIdsWithOutcome(characterId, chatIds, folderByChatId, previous, selectedChatId)
}

export function dispatchReorderChatsByIdsWithOutcome(
  characterId: string,
  chatIds: string[],
  folderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const rollback = chatReorderRollbackFromState(characterId, chatIds, folderByChatId, previous)
  const attemptedIds = rollback?.attemptedIds ?? cloneJsonValue(chatIds)
  const attemptedFolderByChatId = rollback?.attemptedFolderByChatId ?? cloneJsonValue(folderByChatId)
  const changedFolderByChatId = changedChatFolderAssignmentsFromState(characterId, attemptedFolderByChatId, previous)
  applyOptimisticChatOrderAttempt(characterId, attemptedIds, changedFolderByChatId ?? {}, selectedChatId, previous)
  const body = freezeDurableChatRequestBody({
    chatIds: attemptedIds,
    ...(changedFolderByChatId !== undefined ? { folderByChatId: changedFolderByChatId } : {}),
    ...(selectedChatId !== undefined ? { selectedChatId } : {}),
  })
  const intent = durableChatMutationIntent('POST', `/characters/${encodeURIComponent(characterId)}/chats/reorder`, body)
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () =>
      restoreChatOrderAttempt(rollback),
    )
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        reorderChatsCommand({
          baseRevision,
          characterId,
          chatIds: body.chatIds,
          folderByChatId: body.folderByChatId,
          selectedChatId: body.selectedChatId,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function dispatchReorderChatFoldersAndChatsByIds(
  characterId: string,
  folderIds: string[],
  chatIds: string[],
  folderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
    characterId,
    folderIds,
    chatIds,
    folderByChatId,
    previous,
    selectedChatId,
  )
}

export function dispatchReorderChatFoldersAndChatsByIdsWithOutcome(
  characterId: string,
  folderIds: string[],
  chatIds: string[],
  folderByChatId: Record<string, string | null>,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const attemptedFolderIds = cloneJsonValue(folderIds)
  const attemptedChatIds = cloneJsonValue(chatIds)
  const attemptedFolderByChatId = cloneJsonValue(folderByChatId)
  const previousFolderIds = chatFolderOrderFromBaseline(characterId, previous)
  const chatRollback = chatReorderRollbackFromState(characterId, attemptedChatIds, attemptedFolderByChatId, previous)
  const changedFolderByChatId = changedChatFolderAssignmentsFromState(characterId, attemptedFolderByChatId, previous)
  applyOptimisticChatFolderOrderAttempt(characterId, attemptedFolderIds, selectedChatId, previous)
  applyOptimisticChatOrderAttempt(characterId, attemptedChatIds, changedFolderByChatId ?? {}, selectedChatId, previous)

  const folderBody = freezeDurableChatRequestBody({
    folderIds: attemptedFolderIds,
    ...(selectedChatId !== undefined ? { selectedChatId } : {}),
  })
  const chatBody = freezeDurableChatRequestBody({
    chatIds: attemptedChatIds,
    ...(changedFolderByChatId !== undefined ? { folderByChatId: changedFolderByChatId } : {}),
    ...(selectedChatId !== undefined ? { selectedChatId } : {}),
  })
  return chatBatchMutationOutcome(
    dispatchCharacterOwnedDurableBatch(characterId, [
      {
        method: 'POST',
        path: `/characters/${encodeURIComponent(characterId)}/chat-folders/reorder`,
        body: folderBody,
        command: (baseRevision, frozenBody) =>
          reorderChatFoldersCommand({
            baseRevision,
            characterId,
            folderIds: frozenBody.folderIds as string[],
            selectedChatId: frozenBody.selectedChatId as string | undefined,
          }),
        rollback: () =>
          rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () => {
            if (previousFolderIds) {
              restoreChatFolderOrderAttempt(characterId, previousFolderIds, attemptedFolderIds, previous)
            }
          }),
      },
      {
        method: 'POST',
        path: `/characters/${encodeURIComponent(characterId)}/chats/reorder`,
        body: chatBody,
        command: (baseRevision, frozenBody) =>
          reorderChatsCommand({
            baseRevision,
            characterId,
            chatIds: frozenBody.chatIds as string[],
            folderByChatId: frozenBody.folderByChatId as Record<string, string | null> | undefined,
            selectedChatId: frozenBody.selectedChatId as string | undefined,
          }),
        rollback: () =>
          rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () =>
            restoreChatOrderAttempt(chatRollback),
          ),
      },
    ]),
  )
}

export function dispatchCreateChatFolder(
  characterId: string,
  folder: ChatFolder,
  previous: ChatFolderCreateBaseline,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchCreateChatFolderWithOutcome(characterId, folder, previous)
}

export function dispatchCreateChatFolderWithOutcome(
  characterId: string,
  folder: ChatFolder,
  previous: ChatFolderCreateBaseline,
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  // Explicit create seam retained for the compact folder-create certificate.
  const optimisticEpoch = captureDestructiveRefreshEpoch()
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const attemptedFolder = freezeJsonValue(cloneJsonValue(folder))
  const rollback = chatCreatedFolderRollbackFromState(characterId, attemptedFolder, previous)
  const acknowledgeOptimistic =
    !!rollback &&
    isCanonicalOptimisticCreatedFolder(attemptedFolder) &&
    hasOneLiveChatFolder(characterId, attemptedFolder.id)
  const body = freezeDurableChatRequestBody({ folder: toChatFolderSnapshot(attemptedFolder) })
  const intent = durableChatMutationIntent('POST', `/characters/${encodeURIComponent(characterId)}/chat-folders`, body)
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () =>
      restoreCreatedChatFolderAttemptIfUnreferenced(rollback),
    )
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        createChatFolderCommand({
          baseRevision,
          characterId,
          folder: body.folder,
          acknowledgeOptimistic,
          optimisticEpoch,
          optimisticRowEpoch,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function dispatchUpdateChatFolder(
  folderId: string,
  patch: ChatFolderSnapshot,
  previous: ChatStateSnapshot,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback = restoreChatFolderRowMetadata,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchUpdateChatFolderWithOutcome(folderId, patch, previous, rollbackFolderMetadata)
}

export function dispatchUpdateChatFolderWithOutcome(
  folderId: string,
  patch: ChatFolderSnapshot,
  previous: ChatStateSnapshot,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback = restoreChatFolderRowMetadata,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  if (!canUseServerCommands()) return
  const folderLocation = locateChatFolderInState(previous, folderId)
  if (!folderLocation) return
  const rollback = chatFolderMetadataRollbackFromPatch(folderId, patch, previous)
  const attemptedPatch = freezeJsonValue(cloneJsonValue(patch))
  if (Object.keys(attemptedPatch).length === 0) return
  const characterId = rollback?.characterId ?? folderLocation.character.chaId
  return dispatchChatFolderMetadataWithOutcome(folderId, attemptedPatch, rollback, characterId, rollbackFolderMetadata)
}

export function dispatchChatFolderMetadataPatchWithOutcome(
  snapshot: ChatFolderMetadataPatchSnapshot,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback = restoreChatFolderRowMetadata,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  if (reportWriterAccessLostMutation()) {
    rollbackFolderMetadata(snapshot)
    return writerAccessLostChatMutationOutcome()
  }
  if (!canUseServerCommands()) return
  return dispatchChatFolderMetadataWithOutcome(
    snapshot.folderId,
    freezeJsonValue(cloneJsonValue(snapshot.attempted)),
    snapshot,
    snapshot.characterId,
    rollbackFolderMetadata,
  )
}

function dispatchChatFolderMetadataWithOutcome(
  folderId: string,
  attemptedPatch: ChatFolderSnapshot,
  rollback: ChatFolderRowMetadataSnapshot | null,
  characterId: string | undefined,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback,
): Promise<ChatMutationOutcome> | undefined {
  if (Object.keys(attemptedPatch).length === 0) return
  const body = freezeDurableChatRequestBody({ patch: attemptedPatch })
  const intent = durableChatMutationIntent('PATCH', `/chat-folders/${encodeURIComponent(folderId)}`, body)
  const execute = (transport: ServerCommandTransportOptions, rollbackAttempt: () => void) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatFolderCommand({
          baseRevision,
          folderId,
          patch: body.patch,
        }),
      rollback: rollbackAttempt,
      ...transport,
    })
  if (!rollback) {
    const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
      execute(transport, () => {}),
    )
    return normalizedChatMutationOutcome(outcome, () => {})
  }

  const pendingAttempt = registerChatFolderMetadataAttempt(folderId, rollback)
  const rollbackAttempt = () => rollbackChatFolderMetadataAttempt(pendingAttempt, rollbackFolderMetadata)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) => {
    bindChatFolderMetadataAttemptDurability(pendingAttempt, transport, rollbackFolderMetadata)
    return execute(transport, rollbackAttempt)
  }).catch((error): CharacterOwnedDurableMutationOutcome<Record<string, unknown>> => {
    rollbackAttempt()
    return { result: failedChatMutationResult(error), retained: false }
  })
  const result = outcome.then((settled) => settled.result)
  trackChatFolderMetadataAttemptResult(pendingAttempt, result)
  return chatMutationOutcome(outcome)
}

// Narrow-rollback variant of `dispatchUpdateChatFolder` for the chat-metadata
// watcher. The rollback restores one folder row's scalar metadata instead of the
// whole characters array.
export function dispatchUpdateChatFolderRow(
  folderId: string,
  patch: ChatFolderSnapshot,
  rollback: ChatFolderRowMetadataSnapshot,
  options: ServerCommandTransportOptions = {},
  rollbackFolderMetadata: ChatFolderRowMetadataRollback = restoreChatFolderRowMetadata,
): Promise<ServerCommandResult> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  const attemptedPatch = freezeJsonValue(cloneJsonValue(patch))
  if (Object.keys(attemptedPatch).length === 0) return null
  if (!canUseServerCommands()) return null
  const body = freezeDurableChatRequestBody({ patch: attemptedPatch })
  const intent = durableChatMutationIntent('PATCH', `/chat-folders/${encodeURIComponent(folderId)}`, body)
  const attemptedRollback =
    Object.keys(attemptedPatch).length > 0 || rollback.attempted
      ? {
          ...rollback,
          attempted: { ...(rollback.attempted ?? {}), ...attemptedPatch },
        }
      : rollback
  const pendingAttempt = registerChatFolderMetadataAttempt(folderId, attemptedRollback)
  const execute = (transport: ServerCommandTransportOptions) => {
    bindChatFolderMetadataAttemptDurability(pendingAttempt, transport, rollbackFolderMetadata)
    return runServerCommand({
      command: (baseRevision) =>
        updateChatFolderCommand(
          {
            baseRevision,
            folderId,
            patch: body.patch,
          },
          transport.signal,
          transport.keepalive,
        ),
      rollback: () => rollbackChatFolderMetadataAttempt(pendingAttempt, rollbackFolderMetadata),
      ...transport,
    })
  }
  const result = hasExistingDurableMutationTransport(options)
    ? execute(options)
    : dispatchCharacterOwnedDurableMutation(rollback.characterId, intent, (transport) =>
        execute({ ...options, ...transport }),
      )
  trackChatFolderMetadataAttemptResult(pendingAttempt, result)
  return result
}

function registerChatFolderMetadataAttempt(
  folderId: string,
  rollback: ChatFolderRowMetadataSnapshot,
): PendingChatFolderMetadataAttempt {
  const attempt = {
    sessionGeneration: captureClientSessionGeneration(),
    sequence: ++nextChatFolderMetadataAttemptSequence,
    folderId,
    rollback,
  }
  const pending = pendingChatFolderMetadataAttempts.get(folderId) ?? []
  pending.push(attempt)
  pendingChatFolderMetadataAttempts.set(folderId, pending)
  return attempt
}

function rollbackChatFolderMetadataAttempt(
  attempt: PendingChatFolderMetadataAttempt,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback,
): void {
  releaseChatProjectionAttempt(attempt)
  if (!canProjectChatAttempt(attempt)) {
    clearChatFolderMetadataAttempt(attempt)
    return
  }
  rollbackFolderMetadata(attempt.rollback)

  const failedAttempted = attempt.rollback.attempted
  if (failedAttempted) {
    const rebasedKeys = new Set<string>()
    for (const later of pendingChatFolderMetadataAttempts.get(attempt.folderId) ?? []) {
      if (later.sequence <= attempt.sequence || !later.rollback.attempted || !canProjectChatAttempt(later)) continue
      for (const key of CHAT_FOLDER_PATCH_ALLOWED_KEYS) {
        if (rebasedKeys.has(key)) continue
        if (!Object.prototype.hasOwnProperty.call(failedAttempted, key)) continue
        if (!Object.prototype.hasOwnProperty.call(later.rollback.attempted, key)) continue
        const laterPrevious = Object.prototype.hasOwnProperty.call(later.rollback.metadata, key)
          ? later.rollback.metadata[key]
          : undefined
        if (snapshotJson(laterPrevious) !== snapshotJson(failedAttempted[key])) continue

        if (Object.prototype.hasOwnProperty.call(attempt.rollback.metadata, key)) {
          later.rollback.metadata[key] = cloneJsonValue(attempt.rollback.metadata[key])
        } else {
          delete later.rollback.metadata[key]
        }
        rebasedKeys.add(key)
      }
    }
  }

  clearChatFolderMetadataAttempt(attempt)
}

function trackChatFolderMetadataAttemptResult(
  attempt: PendingChatFolderMetadataAttempt,
  result: Promise<ServerCommandResult> | null,
): void {
  trackDurableChatProjectionAttempt(
    attempt,
    result,
    () => clearChatFolderMetadataAttempt(attempt),
    () => reapplyChatFolderMetadataAttempt(attempt),
  )
}

function bindChatFolderMetadataAttemptDurability(
  attempt: PendingChatFolderMetadataAttempt,
  transport: ServerCommandTransportOptions,
  rollbackFolderMetadata: ChatFolderRowMetadataRollback,
): void {
  bindDurableChatProjectionAttempt(
    attempt,
    transport,
    { kind: 'character', characterId: attempt.rollback.characterId },
    () => reapplyChatFolderMetadataAttempt(attempt),
    () => clearChatFolderMetadataAttempt(attempt),
    () => rollbackChatFolderMetadataAttempt(attempt, rollbackFolderMetadata),
  )
}

function reapplyChatFolderMetadataAttempt(attempt: PendingChatFolderMetadataAttempt): void {
  if (!canProjectChatAttempt(attempt)) return
  const attempted = attempt.rollback.attempted
  if (!attempted || !attempt.rollback.characterId) return
  applyChatFolderMetadataOwnerPatch(attempt.rollback.characterId, attempt.folderId, attempted)
}

function clearChatFolderMetadataAttempt(attempt: PendingChatFolderMetadataAttempt): void {
  const pending = pendingChatFolderMetadataAttempts.get(attempt.folderId)
  if (!pending) return
  const next = pending.filter((candidate) => candidate.sequence !== attempt.sequence)
  if (next.length === 0) {
    pendingChatFolderMetadataAttempts.delete(attempt.folderId)
  } else {
    pendingChatFolderMetadataAttempts.set(attempt.folderId, next)
  }
}

export function dispatchDeleteChatFolder(folderId: string, previous: ChatFolderDeleteBaseline): void {
  if (!canUseClientWriteAccess()) return
  void dispatchDeleteChatFolderWithOutcome(folderId, previous)
}

export function dispatchDeleteChatFolderWithOutcome(
  folderId: string,
  previous: ChatFolderDeleteBaseline,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  if (!canUseServerCommands()) return
  flushRegisteredPendingOwnerMutation('chat-metadata', {})
  const rollback = chatFolderDeleteRollbackFromState(folderId, previous)
  const optimisticRowEpoch = rollback?.characterId
    ? captureCharacterRowProjectionEpoch(rollback.characterId)
    : undefined
  applyOptimisticDeletedChatFolderAttempt(folderId, previous)
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'DELETE',
        path: `/chat-folders/${encodeURIComponent(folderId)}`,
        body: {},
      },
    ],
  }
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(rollback?.characterId, optimisticRowEpoch, () =>
      restoreDeletedChatFolderAttempt(rollback),
    )
  let outbox: PendingMutationHandle
  try {
    outbox = stagePendingMutation(chatFolderResourceOwnerMutationKey(folderId, rollback?.characterId), intent)
  } catch (error) {
    rollbackAttempt()
    return Promise.resolve({ status: 'failed', result: failedChatMutationResult(error) })
  }
  const outcome = dispatchPreparedCharacterOwnedDurableMutationWithOutcome(outbox, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        deleteChatFolderCommand({
          baseRevision,
          folderId,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function dispatchReorderChatFolders(
  characterId: string,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderChatFoldersWithOutcome(characterId, previous, selectedChatId)
}

export function dispatchReorderChatFoldersWithOutcome(
  characterId: string,
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const character = getCharacterResourceOwner(characterId)
  if (!character) return
  return dispatchReorderChatFoldersByIdsWithOutcome(
    characterId,
    character.chatFolders.map((folder) => folder.id),
    previous,
    selectedChatId,
  )
}

export function dispatchReorderChatFoldersByIds(
  characterId: string,
  folderIds: string[],
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): void {
  if (!canUseClientWriteAccess()) return
  void dispatchReorderChatFoldersByIdsWithOutcome(characterId, folderIds, previous, selectedChatId)
}

export function dispatchReorderChatFoldersByIdsWithOutcome(
  characterId: string,
  folderIds: string[],
  previous: ChatOrderBaseline,
  selectedChatId?: string,
): Promise<ChatMutationOutcome> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const previousIds = chatFolderOrderFromBaseline(characterId, previous)
  const attemptedIds = cloneJsonValue(folderIds)
  applyOptimisticChatFolderOrderAttempt(characterId, attemptedIds, selectedChatId, previous)
  const body = freezeDurableChatRequestBody({
    folderIds: attemptedIds,
    ...(selectedChatId !== undefined ? { selectedChatId } : {}),
  })
  const intent = durableChatMutationIntent(
    'POST',
    `/characters/${encodeURIComponent(characterId)}/chat-folders/reorder`,
    body,
  )
  const rollbackAttempt = () =>
    rollbackChatStructureUnlessCharacterRowChanged(characterId, optimisticRowEpoch, () => {
      if (previousIds) restoreChatFolderOrderAttempt(characterId, previousIds, attemptedIds, previous)
    })
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        reorderChatFoldersCommand({
          baseRevision,
          characterId,
          folderIds: body.folderIds,
          selectedChatId: body.selectedChatId,
        }),
      rollback: rollbackAttempt,
      ...transport,
    }),
  )
  return normalizedChatMutationOutcome(outcome, rollbackAttempt)
}

export function toChatSnapshot(chat: Chat): ChatSnapshot {
  return cloneJsonValue(chat) as unknown as ChatSnapshot
}

export function toChatFolderSnapshot(folder: ChatFolder): ChatFolderSnapshot {
  return cloneJsonValue(folder) as unknown as ChatFolderSnapshot
}

export function dispatchAppendMessage(chatId: string, message: Message, previous: ChatStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  ensureMessageId(message)
  const scoped = chatScopedSnapshotForChatInState(previous, chatId)
  if (!scoped) return
  const attemptedMessages = messagesAfterAppend(scoped.chat?.message ?? [], message)
  if (!attemptedMessages) return
  const pendingAttempt = registerScopedTranscriptAttempt(
    scoped,
    attemptedMessages,
    (previousMessages) => messagesAfterAppend(previousMessages, message),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  markChatMessageMutationIntent(chatId)
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const body = freezeOwnedDurableChatRequestBody({ message: toMessageSnapshot(message) })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages`, body)
  const result = dispatchCharacterOwnedDurableMutation(scoped.characterId, intent, (transport) => {
    bindScopedTranscriptAttemptDurability(pendingAttempt, transport)
    return runServerCommand({
      command: (baseRevision) =>
        appendMessageCommand({
          baseRevision,
          chatId,
          message: body.message,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback: () => {
        if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
      },
      ...transport,
    })
  })
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
}

export function appendCurrentChatEmptyCharMessage(): void {
  if (!canUseClientWriteAccess()) return
  const selectedChar = get(selectedCharID)
  const message: Message = {
    role: 'char',
    data: '',
  }
  const messageId = ensureMessageId(message)
  let chatId: string | undefined
  let characterId: string | undefined
  let applied = false

  withChatOwnerProjectionWrite(() => {
    const liveCharacter = characterOwnerAt(selectedChar)
    const liveChat = liveCharacter?.chats?.[liveCharacter.chatPage]
    if (!liveChat) return
    liveChat.message ??= []
    liveChat.message.push(message)
    chatId = liveChat.id
    characterId = liveCharacter.chaId
    applied = true
  })

  if (!applied || !chatId) return
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const body = freezeDurableChatRequestBody({ message: toMessageSnapshot(message) })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages`, body)

  void dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        appendMessageCommand({
          baseRevision,
          chatId: chatId!,
          message: body.message,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback: () =>
        removeOptimisticCurrentChatMessage({
          selectedCharID: selectedChar,
          characterId,
          chatId,
          messageId,
        }),
      ...transport,
    }),
  )
}

export async function appendCurrentChatUserMessageForSend(
  input: string | Message,
  options: AppendCurrentChatUserMessageForSendOptions = {},
): Promise<AppendCurrentChatUserMessageResult> {
  if (!canUseClientWriteAccess()) return { status: 'error', error: 'client_write_access_required' }
  if (options.expectedTarget !== undefined && !isActiveChatTargetFresh(options.expectedTarget)) {
    return { status: 'error', error: 'The active chat changed before the message could be appended.' }
  }

  const readiness = guardActiveChatGenerationSettingsForSend()
  if (readiness.status === 'error') {
    return { status: 'error', error: readiness.error }
  }
  if (options.expectedTarget !== undefined && !isActiveChatTargetFresh(options.expectedTarget)) {
    return { status: 'error', error: 'The active chat changed before the message could be appended.' }
  }

  const selectedChar = get(selectedCharID)
  const message: Message =
    typeof input === 'string'
      ? {
          role: 'user',
          data: input,
          time: Date.now(),
        }
      : input
  const messageId = ensureMessageId(message)
  let chatId: string | undefined
  let characterId: string | undefined
  let applied = false

  withChatOwnerProjectionWrite(() => {
    const character = characterOwnerAt(selectedChar)
    const chat = character?.chats?.[character.chatPage]
    if (!chat) return
    chat.message ??= []
    chat.message.push(message)
    characterId = character.chaId
    chatId = chat.id
    applied = true
  })

  if (!applied) {
    return { status: 'error', error: 'No current chat is selected.' }
  }

  if (!canUseServerCommands()) {
    return { status: 'ok', messageId }
  }

  if (!chatId) {
    removeOptimisticCurrentChatMessage({
      selectedCharID: selectedChar,
      characterId,
      chatId,
      messageId,
    })
    return { status: 'error', error: 'The current chat has no server id.' }
  }

  const rollbackAppend = () =>
    removeOptimisticCurrentChatMessage({
      selectedCharID: selectedChar,
      characterId,
      chatId,
      messageId,
    })
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const body = freezeOwnedDurableChatRequestBody({ message: toMessageSnapshot(message) })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages`, body)

  const outcome = await dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        appendMessageCommand({
          baseRevision,
          chatId,
          message: body.message,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback: rollbackAppend,
      ...transport,
    }),
  )
  if (outcome.retained && outcome.settlement) {
    return { status: 'queued', messageId, settlement: outcome.settlement }
  }
  const { result } = outcome

  if (result.status === 'ok') {
    return { status: 'ok', messageId: result.messageId ?? messageId }
  }
  if (result.status === 'conflict') {
    return { status: 'error', error: `Server revision conflict (${result.currentRevision}).` }
  }
  if (result.status === 'unavailable') {
    return { status: 'error', error: 'Server commands are unavailable.' }
  }
  return { status: 'error', error: result.error }
}

/**
 * Apply the exact protocol-v1 user row after its complete operation request is
 * staged in the encrypted outbox. This helper deliberately does not dispatch a
 * message command: the generation-operation endpoint owns the append and
 * generation intent in one transaction.
 */
export function appendOptimisticGenerationOperationUserMessage(
  target: ActiveChatTarget,
  message: Message,
): OptimisticGenerationOperationAppendResult {
  if (!canUseClientWriteAccess()) return { status: 'error', error: 'client_write_access_required' }
  if (!isActiveChatTargetFresh(target)) {
    return { status: 'error', error: 'The active chat changed before the message could be staged.' }
  }
  const messageId = message.chatId
  if (!messageId) return { status: 'error', error: 'The accepted message id is missing.' }

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(target.characterId, target.selectedCharID)
    if (!character) return
    const chatIndex = locateChatIndex(character, target.chatId)
    if (chatIndex < 0) return
    const chat = character.chats[chatIndex]
    chat.message ??= []
    if (chat.message.some((candidate) => candidate.chatId === messageId)) return
    chat.message.push(message)
    applied = true
  })
  if (!applied) return { status: 'error', error: 'The accepted message could not be staged in the active chat.' }
  if (target.chatId) markChatMessageMutationIntent(target.chatId)

  return {
    status: 'ok',
    messageId,
    rollback: () =>
      removeOptimisticCurrentChatMessage({
        selectedCharID: target.selectedCharID,
        characterId: target.characterId,
        chatId: target.chatId,
        messageId,
      }),
  }
}

/**
 * Durably clear the captured active transcript before an append-and-generate
 * operation. A retained replacement is not complete until replay settles, so
 * callers must not append or generate from the replacement before this helper
 * resolves true.
 */
export async function clearCurrentChatMessagesBeforeSend(target: ActiveChatTarget): Promise<boolean> {
  if (!canUseClientWriteAccess()) return false
  if (!isActiveChatTargetFresh(target)) return false
  const previous = currentChatScopedSnapshot()
  const chatId = previous.chatId
  if (!chatId || chatId !== target.chatId) return false

  const pending = dispatchReplaceMessagesScoped(chatId, [], previous)
  if (!pending) return false

  const outcome = await pending
  if (outcome.status === 'accepted') return true
  if (outcome.status === 'failed') return false

  try {
    return (await outcome.settlement).status === 'accepted'
  } catch {
    return false
  }
}

function removeOptimisticCurrentChatMessage(input: {
  selectedCharID: number
  characterId: string | undefined
  chatId: string | undefined
  messageId: string
}): void {
  withChatOwnerProjectionWrite(() => {
    const character = locateSnapshotCharacter(input.characterId, input.selectedCharID)
    if (!character?.chats) return
    const chatIndex = locateChatIndex(character, input.chatId)
    if (chatIndex < 0 && input.chatId !== undefined) return
    const chat = chatIndex >= 0 ? character.chats[chatIndex] : character.chats[character.chatPage ?? 0]
    if (!chat?.message) return
    const messageIndex = chat.message.findIndex((message) => message.chatId === input.messageId)
    if (messageIndex >= 0) {
      chat.message.splice(messageIndex, 1)
    }
  })
}

function restoreScopedMessagePatchAttempt(
  previous: ChatScopedSnapshot,
  messageId: string,
  attemptedPatch: MessageSnapshot,
): void {
  if (!previous.chat) return
  withChatOwnerProjectionWrite(() => {
    const liveChat = locateChatScopedSnapshot(previous)
    const liveMessages = liveChat?.message
    if (!liveMessages) return

    const liveMessageIndex = findMessageIndexById(liveMessages, messageId)
    if (liveMessageIndex < 0) return

    const previousMessages = previous.chat?.message ?? []
    const previousMessageById = previousMessages.find((message) => message.chatId === messageId)
    const previousMessageAtLiveIndex = previousMessages[liveMessageIndex]
    const previousMessage =
      previousMessageById ?? (previousMessageAtLiveIndex?.chatId ? undefined : previousMessageAtLiveIndex)
    if (!previousMessage) return

    applyAttemptedFieldRollback({
      target: liveMessages[liveMessageIndex] as unknown as Record<string, unknown>,
      previous: previousMessage as unknown as Record<string, unknown>,
      attempted: attemptedPatch as Record<string, unknown>,
      keys: MESSAGE_PATCH_ALLOWED_KEYS,
      deleteMissingPrevious: true,
    })
  })
}

function applyScopedMessagePatchAttempt(
  previous: ChatScopedSnapshot,
  messageId: string,
  attemptedPatch: MessageSnapshot,
): AppliedScopedMessagePatchAttempt {
  const commandPatch: MessageSnapshot = {}
  const dispatcherAppliedKeys = new Set<string>()
  if (!previous.chat) return { commandPatch, dispatcherAppliedKeys }
  withChatOwnerProjectionWrite(() => {
    const liveChat = locateChatScopedSnapshot(previous)
    const liveMessages = liveChat?.message
    if (!liveMessages) return

    const liveMessageIndex = findMessageIndexById(liveMessages, messageId)
    if (liveMessageIndex < 0) return

    const previousMessages = previous.chat?.message ?? []
    const previousMessageById = previousMessages.find((message) => message.chatId === messageId)
    const previousMessageAtLiveIndex = previousMessages[liveMessageIndex]
    const previousMessage =
      previousMessageById ?? (previousMessageAtLiveIndex?.chatId ? undefined : previousMessageAtLiveIndex)
    if (!previousMessage) return

    const liveMessage = liveMessages[liveMessageIndex] as unknown as Record<string, unknown>
    const previousRecord = previousMessage as unknown as Record<string, unknown>
    const attemptedRecord = attemptedPatch as Record<string, unknown>
    for (const key of MESSAGE_PATCH_ALLOWED_KEYS) {
      if (!Object.prototype.propertyIsEnumerable.call(attemptedRecord, key)) continue

      const attemptedValue = attemptedRecord[key]
      if (snapshotJson(liveMessage[key]) === snapshotJson(attemptedValue)) {
        commandPatch[key] = cloneJsonValue(attemptedValue)
        continue
      }

      const previousHasKey = Object.prototype.propertyIsEnumerable.call(previousRecord, key)
      const liveHasKey = Object.prototype.propertyIsEnumerable.call(liveMessage, key)
      if (previousHasKey) {
        if (snapshotJson(liveMessage[key]) !== snapshotJson(previousRecord[key])) continue
      } else if (liveHasKey) {
        continue
      }

      liveMessage[key] = cloneJsonValue(attemptedValue)
      commandPatch[key] = cloneJsonValue(attemptedValue)
      dispatcherAppliedKeys.add(key)
    }
  })
  return { commandPatch, dispatcherAppliedKeys }
}

function restoreScopedMessageListAttempt(previous: ChatScopedSnapshot, attemptedMessages: Message[] | null): void {
  if (!previous.chat || !attemptedMessages) return
  const previousMessages = cloneJsonValue(previous.chat.message ?? [])
  const previousBookmarks = chatBookmarkMetadata(previous.chat)
  const attemptedBookmarks = prunedChatBookmarkMetadata(previous.chat, attemptedMessages)
  withChatOwnerProjectionWrite(() => {
    const liveChat = locateChatScopedSnapshot(previous)
    if (!liveChat) return
    if (snapshotJson(liveChat.message ?? []) !== snapshotJson(attemptedMessages)) return
    liveChat.message = previousMessages
    if (sameChatBookmarkMetadata(chatBookmarkMetadata(liveChat), attemptedBookmarks)) {
      applyChatBookmarkMetadata(liveChat, previousBookmarks)
    }
  })
}

function applyScopedMessageListAttempt(previous: ChatScopedSnapshot, attemptedMessages: Message[] | null): void {
  if (!previous.chat || !attemptedMessages) return
  const previousMessages = previous.chat.message ?? []
  const previousBookmarks = chatBookmarkMetadata(previous.chat)
  const attemptedBookmarks = prunedChatBookmarkMetadata(previous.chat, attemptedMessages)
  withChatOwnerProjectionWrite(() => {
    const liveChat = locateChatScopedSnapshot(previous)
    if (!liveChat) return

    // Apply a caller's derived attempt only while the captured transcript is
    // still current. Callers that already mutated optimistically are a no-op,
    // and a newer concurrent transcript is never replaced.
    const liveMessages = liveChat.message ?? []
    const liveSnapshot = snapshotJson(liveMessages)
    if (liveSnapshot === snapshotJson(attemptedMessages)) {
      if (sameChatBookmarkMetadata(chatBookmarkMetadata(liveChat), previousBookmarks)) {
        applyChatBookmarkMetadata(liveChat, attemptedBookmarks)
      }
      return
    }
    if (liveSnapshot !== snapshotJson(previousMessages)) return

    liveChat.message = cloneJsonValue(attemptedMessages)
    if (sameChatBookmarkMetadata(chatBookmarkMetadata(liveChat), previousBookmarks)) {
      applyChatBookmarkMetadata(liveChat, attemptedBookmarks)
    }
  })
}

interface ChatBookmarkMetadata {
  bookmarks?: string[]
  bookmarkNames?: Record<string, string>
}

function chatBookmarkMetadata(chat: Chat): ChatBookmarkMetadata {
  return {
    ...(Array.isArray(chat.bookmarks) ? { bookmarks: cloneJsonValue(chat.bookmarks) } : {}),
    ...(chat.bookmarkNames && typeof chat.bookmarkNames === 'object'
      ? { bookmarkNames: cloneJsonValue(chat.bookmarkNames) }
      : {}),
  }
}

function prunedChatBookmarkMetadata(chat: Chat, messages: readonly Message[]): ChatBookmarkMetadata {
  const retainedIds = new Set(messages.map((message) => message.chatId).filter((id): id is string => !!id))
  const metadata = chatBookmarkMetadata(chat)
  if (metadata.bookmarks) {
    metadata.bookmarks = metadata.bookmarks.filter((messageId) => retainedIds.has(messageId))
  }
  if (metadata.bookmarkNames) {
    metadata.bookmarkNames = Object.fromEntries(
      Object.entries(metadata.bookmarkNames).filter(([messageId]) => retainedIds.has(messageId)),
    )
  }
  return metadata
}

function sameChatBookmarkMetadata(left: ChatBookmarkMetadata, right: ChatBookmarkMetadata): boolean {
  return snapshotJson(left) === snapshotJson(right)
}

function applyChatBookmarkMetadata(chat: Chat, metadata: ChatBookmarkMetadata): void {
  if (metadata.bookmarks === undefined) {
    delete chat.bookmarks
  } else {
    chat.bookmarks = cloneJsonValue(metadata.bookmarks)
  }
  if (metadata.bookmarkNames === undefined) {
    delete chat.bookmarkNames
  } else {
    chat.bookmarkNames = cloneJsonValue(metadata.bookmarkNames)
  }
}

function registerScopedTranscriptAttempt(
  previous: ChatScopedSnapshot,
  attemptedMessages: Message[] | null,
  reapply: (previousMessages: readonly Message[]) => Message[] | null,
  rollback: (attempt: PendingScopedTranscriptAttempt) => void,
): PendingScopedTranscriptAttempt | null {
  if (!previous.chat || !attemptedMessages) return null
  const chatKey = previous.chatId ?? `${previous.characterId ?? previous.selectedCharID}:active`
  const attempt: PendingScopedTranscriptAttempt = {
    sessionGeneration: captureClientSessionGeneration(),
    sequence: ++nextScopedTranscriptAttemptSequence,
    chatKey,
    previous,
    attemptedMessages,
    reapply,
    rollback,
  }
  attempt.retainedProjection = createPendingRetainedChatProjection({ kind: 'chat-body', chatId: previous.chatId }, () =>
    reapplyScopedTranscriptAttempt(attempt),
  )
  attempt.retainedProjection.onInvalidated = () => {
    releaseChatProjectionAttempt(attempt)
    clearScopedTranscriptAttempt(attempt)
  }
  const pending = pendingScopedTranscriptAttempts.get(chatKey) ?? []
  pending.push(attempt)
  pendingScopedTranscriptAttempts.set(chatKey, pending)
  return attempt
}

function rollbackScopedTranscriptAttempt(attempt: PendingScopedTranscriptAttempt): void {
  releaseChatProjectionAttempt(attempt)
  if (!canProjectChatAttempt(attempt)) {
    clearScopedTranscriptAttempt(attempt)
    return
  }
  const liveChatBeforeRollback = locateChatScopedSnapshot(attempt.previous)
  const liveMessagesBeforeRollback = liveChatBeforeRollback
    ? cloneJsonValue(liveChatBeforeRollback.message ?? [])
    : null
  attempt.rollback(attempt)

  const liveChatAfterRollback = locateChatScopedSnapshot(attempt.previous)
  const liveMessagesAfterRollback = liveChatAfterRollback ? cloneJsonValue(liveChatAfterRollback.message ?? []) : null
  let visibleProjectionFollowsRebase =
    liveMessagesBeforeRollback !== null &&
    liveMessagesAfterRollback !== null &&
    snapshotJson(attempt.attemptedMessages) !== snapshotJson(attempt.previous.chat?.message ?? []) &&
    snapshotJson(liveMessagesBeforeRollback) === snapshotJson(attempt.attemptedMessages) &&
    snapshotJson(liveMessagesAfterRollback) === snapshotJson(attempt.previous.chat?.message ?? [])

  let previousBeforeFailedAttempt = cloneJsonValue(attempt.previous.chat?.message ?? [])
  let oldAttemptedMessages = attempt.attemptedMessages
  for (const later of pendingScopedTranscriptAttempts.get(attempt.chatKey) ?? []) {
    if (later.sequence <= attempt.sequence || !later.previous.chat || !canProjectChatAttempt(later)) continue
    if (snapshotJson(later.previous.chat.message ?? []) !== snapshotJson(oldAttemptedMessages)) break

    const rebasedAttemptedMessages = later.reapply(previousBeforeFailedAttempt)
    if (!rebasedAttemptedMessages) break
    const oldLaterAttemptedMessages = later.attemptedMessages
    let rebasedVisibleProjection = false
    withChatOwnerProjectionWrite(() => {
      const liveChat = locateChatScopedSnapshot(later.previous)
      if (!liveChat) return
      const liveMessages = liveChat.message ?? []
      const stillShowsLaterAttempt = snapshotJson(liveMessages) === snapshotJson(oldLaterAttemptedMessages)
      const showsRestoredPredecessor =
        visibleProjectionFollowsRebase && snapshotJson(liveMessages) === snapshotJson(previousBeforeFailedAttempt)
      if (stillShowsLaterAttempt || showsRestoredPredecessor) {
        liveChat.message = cloneJsonValue(rebasedAttemptedMessages)
        rebasedVisibleProjection = true
      }
    })
    visibleProjectionFollowsRebase = rebasedVisibleProjection
    later.previous.chat.message = cloneJsonValue(previousBeforeFailedAttempt)
    later.attemptedMessages = cloneJsonValue(rebasedAttemptedMessages)
    previousBeforeFailedAttempt = rebasedAttemptedMessages
    oldAttemptedMessages = oldLaterAttemptedMessages
  }

  clearScopedTranscriptAttempt(attempt)
}

function trackScopedTranscriptAttemptResult(
  attempt: PendingScopedTranscriptAttempt | null,
  result: Promise<ServerCommandResult | null> | null,
): void {
  if (!attempt) return
  trackDurableChatProjectionAttempt(
    attempt,
    result,
    () => clearScopedTranscriptAttempt(attempt),
    () => reapplyScopedTranscriptAttempt(attempt),
  )
}

function bindScopedTranscriptAttemptDurability(
  attempt: PendingScopedTranscriptAttempt | null,
  transport: ServerCommandTransportOptions,
): void {
  if (!attempt) return
  bindDurableChatProjectionAttempt(
    attempt,
    transport,
    { kind: 'chat-body', chatId: attempt.previous.chatId },
    () => reapplyScopedTranscriptAttempt(attempt),
    () => clearScopedTranscriptAttempt(attempt),
    () => rollbackScopedTranscriptAttempt(attempt),
  )
}

function reapplyScopedTranscriptAttempt(attempt: PendingScopedTranscriptAttempt): void {
  if (!canProjectChatAttempt(attempt)) return
  withChatOwnerProjectionWrite(() => {
    const chat = locateChatScopedSnapshot(attempt.previous)
    if (!chat) return
    const reapplied = attempt.reapply(chat.message ?? [])
    if (reapplied) chat.message = cloneJsonValue(reapplied)
  })
}

function clearScopedTranscriptAttempt(attempt: PendingScopedTranscriptAttempt): void {
  releaseChatProjectionAttempt(attempt)
  const pending = pendingScopedTranscriptAttempts.get(attempt.chatKey)
  if (!pending) return
  const next = pending.filter((candidate) => candidate.sequence !== attempt.sequence)
  if (next.length === 0) {
    pendingScopedTranscriptAttempts.delete(attempt.chatKey)
  } else {
    pendingScopedTranscriptAttempts.set(attempt.chatKey, next)
  }
}

function messagesAfterAppend(previousMessages: readonly Message[], message: Message): Message[] | null {
  if (!message.chatId || previousMessages.some((candidate) => candidate.chatId === message.chatId)) return null
  return cloneJsonValue([...previousMessages, message])
}

function attemptedMessagesAfterDelete(previous: ChatScopedSnapshot, messageId: string): Message[] | null {
  return messagesAfterDelete(previous.chat?.message ?? [], messageId)
}

function messagesAfterDelete(previousMessages: readonly Message[], messageId: string): Message[] | null {
  const messages = cloneJsonValue([...previousMessages])
  const index = findMessageIndexById(messages, messageId)
  if (index < 0) return null
  messages.splice(index, 1)
  return messages
}

function attemptedMessagesAfterTruncate(previous: ChatScopedSnapshot, afterMessageId: string | null): Message[] | null {
  return messagesAfterTruncate(previous.chat?.message ?? [], afterMessageId)
}

function messagesAfterTruncate(previousMessages: readonly Message[], afterMessageId: string | null): Message[] | null {
  const messages = cloneJsonValue([...previousMessages])
  if (afterMessageId === null) return []
  const index = findMessageIndexById(messages, afterMessageId)
  if (index < 0) return null
  return messages.slice(0, index + 1)
}

function attemptedMessagesAfterReplaceTail(
  previous: ChatScopedSnapshot,
  afterMessageId: string | null,
  messages: Message[],
): Message[] | null {
  return messagesAfterReplaceTail(previous.chat?.message ?? [], afterMessageId, messages)
}

function messagesAfterReplaceTail(
  previousMessagesInput: readonly Message[],
  afterMessageId: string | null,
  messages: readonly Message[],
): Message[] | null {
  const previousMessages = cloneJsonValue([...previousMessagesInput])
  if (afterMessageId === null) return cloneJsonValue([...messages])
  const index = findMessageIndexById(previousMessages, afterMessageId)
  if (index < 0) return null
  return previousMessages.slice(0, index + 1).concat(cloneJsonValue([...messages]))
}

function findMessageIndexById(messages: readonly Message[], messageId: string): number {
  return messages.findIndex((message) => message.chatId === messageId)
}

interface ChatBodyProjectionFence {
  chatId: string
  projectionEpoch: number
}

function captureChatBodyProjectionFenceForScopedSnapshot(
  previous: ChatScopedSnapshot,
): ChatBodyProjectionFence | undefined {
  const chatId = previous.chatId ?? previous.chat?.id
  return chatId ? { chatId, projectionEpoch: captureChatBodyProjectionEpoch(chatId) } : undefined
}

function captureChatBodyProjectionFenceForMessage(
  previous: ChatStateSnapshot,
  messageId: string,
): ChatBodyProjectionFence | undefined {
  const chatId = locateMessageInState(previous, messageId)?.chat.id
  if (!chatId) return undefined
  return { chatId, projectionEpoch: captureChatBodyProjectionEpoch(chatId) }
}

// Every message export lowers legacy structural snapshots to one stable chat
// owner before it dispatches. No normal transcript failure restores the broad
// character collection.
function dispatchSanitizedUpdateMessageWith(
  messageId: string,
  commandPatch: MessageSnapshot,
  characterId: string | undefined,
  rollback: () => void,
  optimisticProjection?: ChatBodyProjectionFence,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ServerCommandResult> | null {
  if (Object.keys(commandPatch).length === 0) return null
  if (optimisticProjection) markChatMessageMutationIntent(optimisticProjection.chatId)
  const body = freezeDurableChatRequestBody({ patch: commandPatch })
  const intent = durableChatMutationIntent('PATCH', `/messages/${encodeURIComponent(messageId)}`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        updateMessageCommand({
          baseRevision,
          messageId,
          patch: body.patch,
          optimisticChatId: optimisticProjection?.chatId,
          optimisticChatBodyProjectionEpoch: optimisticProjection?.projectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
}

function dispatchSanitizedUpdateMessageWithOutcome(
  messageId: string,
  commandPatch: MessageSnapshot,
  characterId: string | undefined,
  rollback: () => void,
  optimisticProjection?: ChatBodyProjectionFence,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
  preconditions: MessageUpdatePreconditions = {},
): Promise<ChatMutationOutcome> | null {
  if (Object.keys(commandPatch).length === 0) return null
  if (optimisticProjection) markChatMessageMutationIntent(optimisticProjection.chatId)
  const body = freezeDurableChatRequestBody({
    patch: commandPatch,
    ...(preconditions.expectedData !== undefined ? { expectedData: preconditions.expectedData } : {}),
    ...(preconditions.expectedChatId !== undefined ? { expectedChatId: preconditions.expectedChatId } : {}),
    ...(preconditions.expectedGenerationId !== undefined
      ? { expectedGenerationId: preconditions.expectedGenerationId }
      : {}),
  })
  const intent = durableChatMutationIntent('PATCH', `/messages/${encodeURIComponent(messageId)}`, body)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        updateMessageCommand({
          baseRevision,
          messageId,
          patch: body.patch,
          expectedData: body.expectedData,
          expectedChatId: body.expectedChatId,
          expectedGenerationId: body.expectedGenerationId,
          optimisticChatId: optimisticProjection?.chatId,
          optimisticChatBodyProjectionEpoch: optimisticProjection?.projectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
  return normalizedChatMutationOutcome(outcome, rollback)
}

function dispatchUpdateMessageWith(
  messageId: string,
  patch: MessageSnapshot,
  characterId: string | undefined,
  rollback: () => void,
  optimisticProjection?: ChatBodyProjectionFence,
): void {
  dispatchSanitizedUpdateMessageWith(
    messageId,
    sanitizeMessagePatch(patch),
    characterId,
    rollback,
    optimisticProjection,
  )
}

export function dispatchUpdateMessage(messageId: string, patch: MessageSnapshot, previous: ChatStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  const scoped = chatScopedSnapshotForMessageInState(previous, messageId)
  if (!scoped) return
  void dispatchUpdateMessageScoped(messageId, patch, scoped, { optimisticPatchAlreadyApplied: true })
}

export interface MessageUpdatePreconditions {
  /** Reject the command if the durable message text is no longer this exact value. */
  expectedData?: string
  /** Reject the command if the message has moved to a different chat. */
  expectedChatId?: string
  /** Reject the command if the row no longer belongs to this generation. */
  expectedGenerationId?: string
}

export interface DispatchUpdateMessageScopedOptions extends MessageUpdatePreconditions {
  /** The caller already painted the supplied patch and owns rolling it back if persistence fails. */
  optimisticPatchAlreadyApplied?: boolean
}

export function dispatchUpdateMessageScoped(
  messageId: string,
  patch: MessageSnapshot,
  previous: ChatScopedSnapshot,
  options: DispatchUpdateMessageScopedOptions = {},
): Promise<ChatMutationOutcome> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const optimisticProjection = captureChatBodyProjectionFenceForScopedSnapshot(previous)
  const { commandPatch, dispatcherAppliedKeys } = applyScopedMessagePatchAttempt(
    previous,
    messageId,
    sanitizeMessagePatch(patch),
  )
  if (Object.keys(commandPatch).length === 0) return null

  const attemptedMessages = cloneJsonValue(locateChatScopedSnapshot(previous)?.message ?? [])
  const rollbackKeys = options.optimisticPatchAlreadyApplied
    ? new Set(Object.keys(commandPatch))
    : dispatcherAppliedKeys
  const ledgerPrevious = scopedMessagePatchBaseline(previous, messageId, attemptedMessages, rollbackKeys)
  const pendingAttempt = registerScopedTranscriptAttempt(
    ledgerPrevious,
    attemptedMessages,
    (previousMessages) => messagesAfterPatch(previousMessages, messageId, commandPatch),
    (attempt) => restoreScopedMessagePatchAttempt(attempt.previous, messageId, commandPatch),
  )
  const outcome = dispatchSanitizedUpdateMessageWithOutcome(
    messageId,
    commandPatch,
    previous.characterId,
    () => (pendingAttempt ? rollbackScopedTranscriptAttempt(pendingAttempt) : undefined),
    optimisticProjection,
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
    options,
  )
  const result = outcome?.then((settled) => settled.result as ServerCommandResult) ?? null
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
  return outcome
}

function scopedMessagePatchBaseline(
  previous: ChatScopedSnapshot,
  messageId: string,
  attemptedMessages: readonly Message[],
  rollbackKeys: ReadonlySet<string>,
): ChatScopedSnapshot {
  if (!previous.chat) return previous
  const baselineMessages = cloneJsonValue([...attemptedMessages])
  const baselineIndex = findMessageIndexById(baselineMessages, messageId)
  if (baselineIndex < 0) return previous

  const previousMessages = previous.chat.message ?? []
  const previousById = previousMessages.find((message) => message.chatId === messageId)
  const previousAtIndex = previousMessages[baselineIndex]
  const previousMessage = previousById ?? (previousAtIndex?.chatId ? undefined : previousAtIndex)
  if (!previousMessage) return previous

  const baselineMessage = baselineMessages[baselineIndex] as unknown as Record<string, unknown>
  const previousRecord = previousMessage as unknown as Record<string, unknown>
  for (const key of rollbackKeys) {
    if (Object.prototype.hasOwnProperty.call(previousRecord, key)) {
      baselineMessage[key] = cloneJsonValue(previousRecord[key])
    } else {
      delete baselineMessage[key]
    }
  }
  return {
    ...previous,
    chat: {
      ...previous.chat,
      message: baselineMessages,
    },
  }
}

function messagesAfterPatch(
  previousMessages: readonly Message[],
  messageId: string,
  patch: MessageSnapshot,
): Message[] | null {
  const messages = cloneJsonValue([...previousMessages])
  const index = findMessageIndexById(messages, messageId)
  if (index < 0) return null
  const target = messages[index] as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    target[key] = cloneJsonValue(value)
  }
  return messages
}

function dispatchDeleteMessageWith(
  messageId: string,
  characterId: string | undefined,
  rollback: () => void,
  optimisticProjection?: ChatBodyProjectionFence,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ServerCommandResult> | null {
  if (optimisticProjection) markChatMessageMutationIntent(optimisticProjection.chatId)
  const body = freezeDurableChatRequestBody({})
  const intent = durableChatMutationIntent('DELETE', `/messages/${encodeURIComponent(messageId)}`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        deleteMessageCommand({
          baseRevision,
          messageId,
          optimisticChatId: optimisticProjection?.chatId,
          optimisticChatBodyProjectionEpoch: optimisticProjection?.projectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
}

export function dispatchDeleteMessage(messageId: string, previous: ChatStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  const scoped = chatScopedSnapshotForMessageInState(previous, messageId)
  if (!scoped) return
  void dispatchDeleteMessageScoped(messageId, scoped)
}

interface ScopedDeleteSettlementResult {
  status: string
  currentRevision?: number
  error?: string
  reason?: string
}

function isMissingMessageDeleteResult(result: ScopedDeleteSettlementResult | null | undefined): boolean {
  return result?.status === 'error' && result.reason === 'not-found'
}

function scopedDeleteFailureMessage(result: ScopedDeleteSettlementResult | null | undefined): string {
  if (result?.status === 'error') return result.error || 'The message could not be deleted.'
  if (result?.status === 'conflict') return `Server revision conflict (${result.currentRevision}).`
  return 'Server commands are unavailable.'
}

export async function dispatchDeleteMessageScoped(
  messageId: string,
  previous: ChatScopedSnapshot,
): Promise<DeleteMessageScopedResult> {
  if (!canUseClientWriteAccess()) return { status: 'failed', error: 'client_write_access_required' }
  const optimisticProjection = captureChatBodyProjectionFenceForScopedSnapshot(previous)
  const attemptedMessages = attemptedMessagesAfterDelete(previous, messageId)
  const pendingAttempt = registerScopedTranscriptAttempt(
    previous,
    attemptedMessages,
    (previousMessages) => messagesAfterDelete(previousMessages, messageId),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(previous, attemptedMessages)

  let transcriptAttemptOpen = pendingAttempt !== null
  const acceptTranscriptAttempt = () => {
    if (!pendingAttempt || !transcriptAttemptOpen) return
    transcriptAttemptOpen = false
    clearScopedTranscriptAttempt(pendingAttempt)
  }
  const rollbackTranscriptAttempt = () => {
    if (!pendingAttempt || !transcriptAttemptOpen) return
    transcriptAttemptOpen = false
    rollbackScopedTranscriptAttempt(pendingAttempt)
  }

  if (!canUseServerCommands()) {
    rollbackTranscriptAttempt()
    return { status: 'failed', error: 'Server commands are unavailable.' }
  }

  if (optimisticProjection) markChatMessageMutationIntent(optimisticProjection.chatId)
  const body = freezeDurableChatRequestBody({})
  const intent = durableChatMutationIntent('DELETE', `/messages/${encodeURIComponent(messageId)}`, body)
  let outbox: PendingMutationHandle | null = null
  try {
    if (previous.characterId) {
      outbox = stagePendingMutation(characterOwnerMutationKey(previous.characterId), intent)
    }
  } catch (error) {
    rollbackTranscriptAttempt()
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }

  let resolveFinalSettlement!: (result: DeleteMessageScopedFinalResult) => void
  const finalSettlement = new Promise<DeleteMessageScopedFinalResult>((resolve) => {
    resolveFinalSettlement = resolve
  })
  let finalSettlementResolved = false
  let settlementCleanup = () => {}
  let releaseProjection = () => {}
  const settleFinal = (result: DeleteMessageScopedFinalResult) => {
    if (finalSettlementResolved) return
    finalSettlementResolved = true
    settlementCleanup()
    releaseProjection()
    resolveFinalSettlement(result)
  }

  if (outbox?.databaseLineage) {
    releaseProjection = registerRetainedChatProjection(
      { kind: 'chat-body', chatId: previous.chatId },
      () => {
        if (pendingAttempt && transcriptAttemptOpen) reapplyScopedTranscriptAttempt(pendingAttempt)
      },
      () => {
        rollbackTranscriptAttempt()
        settleFinal({ status: 'failed', error: 'The queued message deletion lost server ownership.' })
      },
    )
    settlementCleanup = registerDurableMutationSettlementListener(outbox.mutationId, (settlement, details) => {
      if (settlement === 'accepted' || isMissingMessageDeleteResult(details.result)) {
        acceptTranscriptAttempt()
        settleFinal({ status: 'accepted' })
        return
      }
      rollbackTranscriptAttempt()
      settleFinal({ status: 'failed', error: scopedDeleteFailureMessage(details.result) })
    })
  }

  let retained = false
  const dispatch = (transport: ServerCommandTransportOptions) =>
    runServerCommand({
      command: (baseRevision) =>
        deleteMessageCommand({
          baseRevision,
          messageId,
          optimisticChatId: optimisticProjection?.chatId,
          optimisticChatBodyProjectionEpoch: optimisticProjection?.projectionEpoch,
        }),
      rollback: rollbackTranscriptAttempt,
      ...transport,
      failureRollbackDisposition: (failure) => {
        // Deleting an exact stable id is idempotent. A not-found response is
        // authoritative proof that the optimistic absence is already correct;
        // restoring the captured row would create a client-only ghost.
        if (isMissingMessageDeleteResult(failure)) return 'retain'
        const disposition = transport.failureRollbackDisposition?.(failure) ?? 'rollback'
        if (disposition === 'retain') retained = true
        return disposition
      },
    })

  let result: ServerCommandResult
  try {
    result = outbox ? await dispatchDurableMutation(outbox, intent, dispatch) : await dispatch({})
  } catch (error) {
    if (retained && outbox) {
      if (pendingAttempt) reapplyScopedTranscriptAttempt(pendingAttempt)
      return { status: 'queued', mutationId: outbox.mutationId, settlement: finalSettlement }
    }
    rollbackTranscriptAttempt()
    settlementCleanup()
    releaseProjection()
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }

  if (result.status === 'ok' || isMissingMessageDeleteResult(result)) {
    acceptTranscriptAttempt()
    settlementCleanup()
    releaseProjection()
    return { status: 'accepted' }
  }
  if (retained && outbox) {
    if (pendingAttempt) reapplyScopedTranscriptAttempt(pendingAttempt)
    return { status: 'queued', mutationId: outbox.mutationId, settlement: finalSettlement }
  }

  rollbackTranscriptAttempt()
  settlementCleanup()
  releaseProjection()
  return { status: 'failed', error: scopedDeleteFailureMessage(result) }
}

function dispatchTruncateMessagesWith(
  chatId: string,
  afterMessageId: string | null,
  characterId: string | undefined,
  rollback: () => void,
  optimisticChatBodyProjectionEpoch: number,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ServerCommandResult | null> {
  if (!canUseServerCommands()) return Promise.resolve(null)
  markChatMessageMutationIntent(chatId)
  const body = freezeDurableChatRequestBody({ afterMessageId })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages/truncate`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        truncateMessagesCommand({
          baseRevision,
          chatId,
          afterMessageId: body.afterMessageId,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
}

function dispatchTruncateMessagesWithOutcome(
  chatId: string,
  afterMessageId: string | null,
  characterId: string | undefined,
  rollback: () => void,
  optimisticChatBodyProjectionEpoch: number,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ChatMutationOutcome> | null {
  if (!canUseServerCommands()) return null
  markChatMessageMutationIntent(chatId)
  const body = freezeDurableChatRequestBody({ afterMessageId })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages/truncate`, body)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        truncateMessagesCommand({
          baseRevision,
          chatId,
          afterMessageId: body.afterMessageId,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
  return normalizedChatMutationOutcome(outcome, rollback)
}

export function dispatchTruncateMessages(
  chatId: string,
  afterMessageId: string | null,
  previous: ChatStateSnapshot,
): Promise<ServerCommandResult | null> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  const scoped = chatScopedSnapshotForChatInState(previous, chatId)
  if (!scoped) return Promise.resolve(null)
  const attemptedMessages = attemptedMessagesAfterTruncate(scoped, afterMessageId)
  const pendingAttempt = registerScopedTranscriptAttempt(
    scoped,
    attemptedMessages,
    (previousMessages) => messagesAfterTruncate(previousMessages, afterMessageId),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(scoped, attemptedMessages)
  const result = dispatchTruncateMessagesWith(
    chatId,
    afterMessageId,
    scoped.characterId,
    () => {
      if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
    },
    captureChatBodyProjectionEpoch(chatId),
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
  )
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
  return result ?? Promise.resolve(null)
}

export function dispatchTruncateMessagesScoped(
  chatId: string,
  afterMessageId: string | null,
  previous: ChatScopedSnapshot,
): Promise<ChatMutationOutcome> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const attemptedMessages = attemptedMessagesAfterTruncate(previous, afterMessageId)
  const pendingAttempt = registerScopedTranscriptAttempt(
    previous,
    attemptedMessages,
    (previousMessages) => messagesAfterTruncate(previousMessages, afterMessageId),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(previous, attemptedMessages)
  const outcome = dispatchTruncateMessagesWithOutcome(
    chatId,
    afterMessageId,
    previous.characterId,
    () => {
      if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
    },
    optimisticChatBodyProjectionEpoch,
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
  )
  const result = outcome?.then((settled) => settled.result as ServerCommandResult) ?? null
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
  return outcome
}

function dispatchReplaceTailMessagesWith(
  chatId: string,
  afterMessageId: string | null,
  messages: Message[],
  characterId: string | undefined,
  rollback: () => void,
  optimisticChatBodyProjectionEpoch: number,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ServerCommandResult> | null {
  if (!prepareReplaceTailMessages(messages)) return null
  markChatMessageMutationIntent(chatId)
  const body = freezeDurableChatRequestBody({
    afterMessageId,
    messages: messages.map(toMessageSnapshot),
  })
  const intent = durableChatMutationIntent('POST', `/chats/${encodeURIComponent(chatId)}/messages/tail`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        replaceTailMessagesCommand({
          baseRevision,
          chatId,
          afterMessageId: body.afterMessageId,
          messages: body.messages,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
}

export function dispatchReplaceTailMessages(
  chatId: string,
  afterMessageId: string | null,
  messages: Message[],
  previous: ChatStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  const scoped = chatScopedSnapshotForChatInState(previous, chatId)
  if (!scoped || !prepareReplaceTailMessages(messages)) return
  const attemptedMessages = attemptedMessagesAfterReplaceTail(scoped, afterMessageId, messages)
  const replacementMessages = cloneJsonValue(messages)
  const pendingAttempt = registerScopedTranscriptAttempt(
    scoped,
    attemptedMessages,
    (previousMessages) => messagesAfterReplaceTail(previousMessages, afterMessageId, replacementMessages),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(scoped, attemptedMessages)
  const result = dispatchReplaceTailMessagesWith(
    chatId,
    afterMessageId,
    messages,
    scoped.characterId,
    () => {
      if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
    },
    captureChatBodyProjectionEpoch(chatId),
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
  )
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
}

export function dispatchReplaceTailMessagesScoped(
  chatId: string,
  afterMessageId: string | null,
  messages: Message[],
  previous: ChatScopedSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  if (!prepareReplaceTailMessages(messages)) return
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const attemptedMessages = attemptedMessagesAfterReplaceTail(previous, afterMessageId, messages)
  const replacementMessages = cloneJsonValue(messages)
  const pendingAttempt = registerScopedTranscriptAttempt(
    previous,
    attemptedMessages,
    (previousMessages) => messagesAfterReplaceTail(previousMessages, afterMessageId, replacementMessages),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(previous, attemptedMessages)
  const result = dispatchReplaceTailMessagesWith(
    chatId,
    afterMessageId,
    messages,
    previous.characterId,
    () => {
      if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
    },
    optimisticChatBodyProjectionEpoch,
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
  )
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
}

function dispatchReplaceMessagesWith(
  chatId: string,
  messages: Message[],
  characterId: string | undefined,
  rollback: () => void,
  optimisticChatBodyProjectionEpoch: number,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ServerCommandResult> | null {
  if (!prepareReplaceMessages(messages)) return null
  markChatMessageMutationIntent(chatId)
  const body = freezeDurableChatRequestBody({ messages: messages.map(toMessageSnapshot) })
  const intent = durableChatMutationIntent('PUT', `/chats/${encodeURIComponent(chatId)}/messages`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        replaceMessagesCommand({
          baseRevision,
          chatId,
          messages: body.messages,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
}

function dispatchReplaceMessagesWithOutcome(
  chatId: string,
  messages: Message[],
  characterId: string | undefined,
  rollback: () => void,
  optimisticChatBodyProjectionEpoch: number,
  onTransport?: (transport: ServerCommandTransportOptions) => void,
): Promise<ChatMutationOutcome> | null {
  if (!prepareReplaceMessages(messages)) return null
  markChatMessageMutationIntent(chatId)
  const body = freezeDurableChatRequestBody({ messages: messages.map(toMessageSnapshot) })
  const intent = durableChatMutationIntent('PUT', `/chats/${encodeURIComponent(chatId)}/messages`, body)
  const outcome = dispatchCharacterOwnedDurableMutationWithOutcome(characterId, intent, (transport) => {
    onTransport?.(transport)
    return runServerCommand({
      command: (baseRevision) =>
        replaceMessagesCommand({
          baseRevision,
          chatId,
          messages: body.messages,
          optimisticChatBodyProjectionEpoch,
        }),
      rollback,
      ...transport,
    })
  })
  return normalizedChatMutationOutcome(outcome, rollback)
}

function hasServerChatMessagePlaceholders(messages: readonly Message[]): boolean {
  return messages.some(isServerChatMessagePlaceholder)
}

export function dispatchReplaceMessages(chatId: string, messages: Message[], previous: ChatStateSnapshot): void {
  if (!canUseClientWriteAccess()) return
  const scoped = chatScopedSnapshotForChatInState(previous, chatId)
  if (!scoped) return
  void dispatchReplaceMessagesScoped(chatId, messages, scoped)
}

export function dispatchReplaceMessagesScoped(
  chatId: string,
  messages: Message[],
  previous: ChatScopedSnapshot,
): Promise<ChatMutationOutcome> | undefined {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'failed', result: { status: 'unavailable' } })
  if (!prepareReplaceMessages(messages)) return
  const optimisticChatBodyProjectionEpoch = captureChatBodyProjectionEpoch(chatId)
  const attemptedMessages = cloneJsonValue(messages)
  const pendingAttempt = registerScopedTranscriptAttempt(
    previous,
    attemptedMessages,
    () => cloneJsonValue(attemptedMessages),
    (attempt) => restoreScopedMessageListAttempt(attempt.previous, attempt.attemptedMessages),
  )
  applyScopedMessageListAttempt(previous, attemptedMessages)
  const outcome = dispatchReplaceMessagesWithOutcome(
    chatId,
    messages,
    previous.characterId,
    () => {
      if (pendingAttempt) rollbackScopedTranscriptAttempt(pendingAttempt)
    },
    optimisticChatBodyProjectionEpoch,
    (transport) => bindScopedTranscriptAttemptDurability(pendingAttempt, transport),
  )
  const result = outcome?.then((settled) => settled.result as ServerCommandResult) ?? null
  trackScopedTranscriptAttemptResult(pendingAttempt, result)
  return outcome ?? undefined
}

function prepareReplaceTailMessages(messages: Message[]): boolean {
  if (hasServerChatMessagePlaceholders(messages)) {
    console.warn('Skipped replaceTailMessagesCommand for a partially hydrated chat transcript tail.')
    return false
  }
  for (const message of messages) {
    ensureMessageId(message)
  }
  return true
}

function prepareReplaceMessages(messages: Message[]): boolean {
  if (hasServerChatMessagePlaceholders(messages)) {
    console.warn('Skipped replaceMessagesCommand for a partially hydrated chat transcript.')
    return false
  }
  for (const message of messages) {
    ensureMessageId(message)
  }
  return true
}

function dispatchPatchChatScriptstateWith(
  chatId: string,
  patch: ChatScriptstatePatch,
  deleteKeys: string[],
  characterId: string | undefined,
  rollback: () => void,
): Promise<ServerCommandResult> | null {
  const commandPatch = sanitizeScriptstatePatch(patch)
  const commandDeleteKeys = sanitizeScriptstateDeleteKeys(deleteKeys)
  if (Object.keys(commandPatch).length === 0 && commandDeleteKeys.length === 0) return null
  if (!canUseServerCommands()) return null
  const body = freezeDurableChatRequestBody({ patch: commandPatch, deleteKeys: commandDeleteKeys })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}/scriptstate`, body)
  return dispatchCharacterOwnedDurableMutation(characterId, intent, (transport) =>
    runServerCommand({
      command: (baseRevision) =>
        patchChatScriptstateCommand({
          baseRevision,
          chatId,
          patch: body.patch,
          deleteKeys: body.deleteKeys,
        }),
      rollback,
      ...transport,
    }),
  )
}

export function dispatchPatchChatScriptstate(
  chatId: string,
  patch: ChatScriptstatePatch,
  deleteKeys: string[],
  previous: ChatStateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  const scoped = chatScopedSnapshotForChatInState(previous, chatId)
  if (!scoped?.chat) return
  dispatchPatchChatScriptstateScoped(chatId, patch, deleteKeys, {
    characterId: scoped.characterId,
    chatId,
    selectedCharID: scoped.selectedCharID,
    scriptstate: scoped.chat.scriptstate ? { ...scoped.chat.scriptstate } : undefined,
  })
}

// Scriptstate-scoped rollback variant for single-key var writes (`setVar`,
// `setChatVar`, `/setvar`, `/addvar`): a failed patch restores only the active
// chat's `scriptstate` map (and optional `note`), never the whole array.
export function dispatchPatchChatScriptstateScoped(
  chatId: string,
  patch: ChatScriptstatePatch,
  deleteKeys: string[],
  previous: ChatScriptstateSnapshot,
): void {
  if (!canUseClientWriteAccess()) return
  const commandPatch = sanitizeScriptstatePatch(patch)
  const commandDeleteKeys = sanitizeScriptstateDeleteKeys(deleteKeys)
  void dispatchPatchChatScriptstateWith(chatId, commandPatch, commandDeleteKeys, previous.characterId, () =>
    restoreChatScriptstateAttempt(previous, commandPatch, commandDeleteKeys),
  )
}

export function dispatchCurrentChatScriptstatePatch(
  patch: ChatScriptstatePatch,
  deleteKeys: string[] = [],
  previous: ChatScriptstateSnapshot = currentChatScriptstateSnapshot(),
): void {
  if (!canUseClientWriteAccess()) return
  const chatId = currentSelectedChatId()
  if (!chatId) return
  dispatchPatchChatScriptstateScoped(chatId, patch, deleteKeys, previous)
}

export function setChatScriptstateValue(chatId: string | undefined, key: string, value: unknown): boolean {
  if (!canUseClientWriteAccess()) return false
  return patchChatScriptstateValue(chatId, { [key]: value })
}

export function patchChatScriptstateValue(
  chatId: string | undefined,
  patch: Record<string, unknown>,
  deleteKeys: readonly string[] = [],
): boolean {
  if (!canUseClientWriteAccess()) return false
  if (!chatId) return false

  const commandPatch = sanitizeScriptstatePatch(patch)
  const commandDeleteKeys = sanitizeScriptstateDeleteKeys(deleteKeys)
  if (Object.keys(commandPatch).length === 0 && commandDeleteKeys.length === 0) return false

  const location = locateChatById(chatId)
  if (!location) return false
  if (!wouldChangeScriptstate(location.chat.scriptstate, commandPatch, commandDeleteKeys)) return false

  const previous = currentChatScriptstateSnapshotForChat(chatId)
  if (!previous) return false

  let applied = false
  withChatOwnerProjectionWrite(() => {
    const liveLocation = locateChatById(chatId)
    if (!liveLocation) return
    applyScriptstatePatchToChat(liveLocation.chat, commandPatch, commandDeleteKeys)
    applied = true
  })
  if (!applied) return false

  dispatchPatchChatScriptstateScoped(chatId, commandPatch, commandDeleteKeys, previous)
  return true
}

// Author-note write (`v2SetAuthorNote`) with a scriptstate-scoped rollback. The
// note is a chat-row scalar, so the command is a chat update, but the rollback
// reuses the pass's `ChatScriptstateSnapshot` (which also restores `note`).
export function dispatchUpdateChatNoteScoped(
  chatId: string,
  note: string,
  previous: ChatScriptstateSnapshot,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult> | null {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!canUseServerCommands()) return null
  if (appliedChatNoteRollbacks.get(chatId)?.rollback === previous) appliedChatNoteRollbacks.delete(chatId)
  const body = freezeDurableChatRequestBody({ patch: sanitizeChatPatch({ note }), select: false })
  const intent = durableChatMutationIntent('PATCH', `/chats/${encodeURIComponent(chatId)}`, body)
  const execute = (transport: ServerCommandTransportOptions) =>
    runServerCommand({
      command: (baseRevision) =>
        updateChatCommand(
          {
            baseRevision,
            chatId,
            patch: body.patch,
            select: body.select,
          },
          transport.signal,
          transport.keepalive,
        ),
      rollback: () => restoreChatNoteAttempt(previous, note),
      ...transport,
    })
  return hasExistingDurableMutationTransport(options)
    ? execute(options)
    : dispatchCharacterOwnedDurableMutation(previous.characterId, intent, (transport) =>
        execute({ ...options, ...transport }),
      )
}

export interface StagedChatNoteMutation {
  sessionGeneration: number
  chatId: string
  characterId?: string
  note: string
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
}

interface PendingChatNoteOwnerMutation {
  mutation: StagedChatNoteMutation
  rollback: ChatScriptstateSnapshot
  owner: Chat
}

interface AppliedChatNoteRollback {
  note: string
  owner: Chat
  rollback: ChatScriptstateSnapshot
}

// Author-note editors debounce outside this module, but the staged durable
// mutation still belongs to one globally stable chat owner. Keep that exact
// owner here so chat deletion/reset can drain only affected notes without
// walking the process-wide owner mutation registry.
const appliedChatNoteRollbacks = new Map<string, AppliedChatNoteRollback>()
const pendingChatNoteOwnerMutations = new Map<string, PendingChatNoteOwnerMutation>()

async function flushPendingChatNoteOwnerMutation(
  chatId: string,
  options: ServerCommandTransportOptions = {},
): Promise<boolean> {
  const pending = pendingChatNoteOwnerMutations.get(chatId)
  if (!pending || !canUseClientWriteAccess() || !isClientSessionGenerationCurrent(pending.mutation.sessionGeneration))
    return false
  const live = locateChatById(chatId, pending.rollback.characterId)
  if (live && live.chat !== pending.owner) return false
  const persistence = await pending.mutation.outbox.ready
  if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(pending.mutation.sessionGeneration)) return false
  if (pendingChatNoteOwnerMutations.get(chatId) === pending) pendingChatNoteOwnerMutations.delete(chatId)
  if (persistence === 'unavailable') {
    await dispatchStagedChatNoteMutation(pending.mutation, pending.rollback, options)
  }
  return true
}

async function flushPendingCharacterChatNoteOwnerMutations(
  characterId: string,
  options: ServerCommandTransportOptions = {},
): Promise<void> {
  const owners = Array.from(pendingChatNoteOwnerMutations).filter(
    ([, pending]) => (pending.mutation.characterId ?? pending.rollback.characterId) === characterId,
  )
  for (const [chatId, pending] of owners) {
    if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(pending.mutation.sessionGeneration)) return
    const live = locateChatById(chatId, characterId)
    if (live && live.chat !== pending.owner) continue
    const persistence = await pending.mutation.outbox.ready
    if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(pending.mutation.sessionGeneration)) return
    if (pendingChatNoteOwnerMutations.get(chatId) === pending) pendingChatNoteOwnerMutations.delete(chatId)
    if (persistence === 'unavailable') {
      await dispatchStagedChatNoteMutation(pending.mutation, pending.rollback, options)
    }
  }
}

export function stageChatNoteMutation(input: {
  chatId: string
  characterId?: string
  note: string
  previous?: PendingMutationHandle | null
}): StagedChatNoteMutation {
  assertClientWriteAccess()
  const intent: DurableMutationIntent = {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/chats/${encodeURIComponent(input.chatId)}`,
        body: { patch: { note: input.note }, select: false },
      },
    ],
  }
  const mutation: StagedChatNoteMutation = {
    sessionGeneration: captureClientSessionGeneration(),
    chatId: input.chatId,
    ...(input.characterId ? { characterId: input.characterId } : {}),
    note: input.note,
    intent,
    outbox: stagePendingMutation(chatResourceOwnerMutationKey(input.chatId, input.characterId), intent, input.previous),
  }
  const applied = appliedChatNoteRollbacks.get(input.chatId)
  appliedChatNoteRollbacks.delete(input.chatId)
  const previousPending = input.previous ? pendingChatNoteOwnerMutations.get(input.chatId) : undefined
  const owner = previousPending?.owner ?? (applied?.note === input.note ? applied.owner : undefined)
  const rollback = previousPending?.rollback ?? (applied?.note === input.note ? applied.rollback : undefined)
  if (owner && rollback && (!input.characterId || rollback.characterId === input.characterId)) {
    pendingChatNoteOwnerMutations.set(input.chatId, { mutation, rollback, owner })
  }
  return mutation
}

export function dispatchStagedChatNoteMutation(
  mutation: StagedChatNoteMutation,
  previous: ChatScriptstateSnapshot,
  options: ServerCommandTransportOptions = {},
): Promise<ServerCommandResult> {
  if (!canUseClientWriteAccess()) return Promise.resolve({ status: 'unavailable' })
  if (!isClientSessionGenerationCurrent(mutation.sessionGeneration)) return Promise.resolve({ status: 'unavailable' })
  if (pendingChatNoteOwnerMutations.get(mutation.chatId)?.mutation === mutation) {
    pendingChatNoteOwnerMutations.delete(mutation.chatId)
  }
  return dispatchDurableMutation(mutation.outbox, mutation.intent, (transport) => {
    return (
      dispatchUpdateChatNoteScoped(mutation.chatId, mutation.note, previous, {
        ...options,
        ...transport,
      }) ?? Promise.resolve({ status: 'unavailable' as const })
    )
  })
}

/** Apply an author-note edit optimistically without starting its transport. */
export function applyChatNoteValueLocally(chatId: string | undefined, note: string): ChatScriptstateSnapshot | null {
  if (!canUseClientWriteAccess()) return null
  if (!chatId) return null

  const location = locateChatById(chatId)
  if (!location || (location.chat.note ?? '') === note) return null

  const previous = currentChatScriptstateSnapshotForChat(chatId, true)
  if (!previous?.characterId) return null
  if (!applyChatMetadataOwnerPatch(previous.characterId, chatId, { note })) return null
  appliedChatNoteRollbacks.set(chatId, { note, owner: location.chat, rollback: previous })
  return previous
}

interface SetChatNoteValueOptions extends ServerCommandTransportOptions {
  onResult?: (result: ServerCommandResult) => void
}

export function setChatNoteValue(
  chatId: string | undefined,
  note: string,
  options: SetChatNoteValueOptions = {},
): boolean {
  if (!canUseClientWriteAccess()) return false
  const previous = applyChatNoteValueLocally(chatId, note)
  if (!previous) return false

  const result = dispatchUpdateChatNoteScoped(chatId!, note, previous, options)
  if (result && options.onResult) void result.then(options.onResult)
  return true
}

export function currentSelectedChatId(): string | undefined {
  const selectedChar = get(selectedCharID)
  const candidate = charactersResourceState.characters[selectedChar]
  const character = candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : candidate
  const chat = character?.chats?.[character.chatPage]
  return chat?.id
}

function currentChatScriptstateSnapshotForChat(chatId: string, includeNote = false): ChatScriptstateSnapshot | null {
  const location = locateChatById(chatId)
  if (!location) return null
  const snapshot: ChatScriptstateSnapshot = {
    characterId: location.character.chaId,
    chatId,
    selectedCharID: get(selectedCharID),
    scriptstate: location.chat.scriptstate ? { ...location.chat.scriptstate } : undefined,
  }
  if (includeNote) snapshot.note = location.chat.note ?? ''
  return snapshot
}

function sanitizeScriptstateDeleteKeys(deleteKeys: readonly string[]): string[] {
  const sanitized: string[] = []
  const seen = new Set<string>()
  for (const key of deleteKeys) {
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    sanitized.push(key)
  }
  return sanitized
}

function applyScriptstatePatchToChat(
  chat: Chat,
  patch: ChatScriptstatePatch,
  deleteKeys: readonly string[] = [],
): void {
  chat.scriptstate ??= {}
  for (const key of deleteKeys) {
    delete chat.scriptstate[key]
  }
  Object.assign(chat.scriptstate, cloneJsonValue(patch))
  if (Object.keys(chat.scriptstate).length === 0) {
    delete chat.scriptstate
  }
}

function wouldChangeScriptstate(
  scriptstate: Chat['scriptstate'] | undefined,
  patch: ChatScriptstatePatch,
  deleteKeys: readonly string[],
): boolean {
  const current = scriptstate ?? {}
  for (const key of deleteKeys) {
    if (Object.prototype.propertyIsEnumerable.call(current, key)) return true
  }
  for (const [key, value] of Object.entries(patch)) {
    if (snapshotJson(current[key]) !== snapshotJson(value)) return true
  }
  return false
}

export function ensureMessageId(message: Message): string {
  if (!message.chatId) {
    message.chatId = v4()
  }
  return message.chatId
}

export function toMessageSnapshot(message: Message): MessageSnapshot {
  return cloneJsonValue(message) as unknown as MessageSnapshot
}

export function sanitizeChatPatch(patch: ChatSnapshot): ChatSnapshot {
  const sanitized: ChatSnapshot = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!CHAT_PATCH_ALLOWED_KEYS.has(key) || value === undefined) continue
    sanitized[key] = cloneJsonValue(value)
  }
  return sanitized
}

function sanitizeFrozenChatPatch(patch: ChatSnapshot): ChatSnapshot {
  return freezeJsonValue(sanitizeChatPatch(patch))
}

export function sanitizeMessagePatch(patch: MessageSnapshot): MessageSnapshot {
  const sanitized: MessageSnapshot = {}
  for (const [key, value] of Object.entries(patch)) {
    if (!MESSAGE_PATCH_ALLOWED_KEYS.has(key) || value === undefined) continue
    sanitized[key] = cloneJsonValue(value)
  }
  return sanitized
}

export function sanitizeScriptstatePatch(patch: Record<string, unknown>): ChatScriptstatePatch {
  const sanitized: ChatScriptstatePatch = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key.length === 0 || value === undefined) continue
    if (!isScriptstateValue(value)) continue
    sanitized[key] = cloneJsonValue(value)
  }
  return sanitized
}

function isScriptstateValue(value: unknown): value is ChatScriptstateValue {
  return (
    typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  )
}

export function changedChatMetadata(previous: Chat, current: Chat): ChatSnapshot {
  const patch: ChatSnapshot = {}
  const previousRecord = (previous ?? {}) as unknown as Record<string, unknown>
  const currentRecord = (current ?? {}) as unknown as Record<string, unknown>
  const orderedKeys = chatMetadataPatchKeyOrder(previousRecord, currentRecord)
  const orderedKeySet = new Set(orderedKeys)
  const changedValues = new Map<string, unknown>()

  // Diff only the server-accepted metadata keys. The old shape deep-cloned the
  // entire chat row before `sanitizeChatPatch` immediately stripped transcript,
  // lorebook, and memory payloads; comparing raw allowed values preserves the
  // JSON patch decision while cloning only values that enter the patch.
  for (const key of CHAT_PATCH_ALLOWED_KEYS) {
    if (!orderedKeySet.has(key)) continue
    const previousValue = sanitizedChatMetadataValue(previousRecord, key)
    const currentValue = sanitizedChatMetadataValue(currentRecord, key)
    const currentSnapshotJson = snapshotJson(currentValue)
    if (snapshotJson(previousValue) !== currentSnapshotJson) {
      const patchValue = currentSnapshotJson === JSON_UNDEFINED_SNAPSHOT ? undefined : cloneJsonValue(currentValue)
      changedValues.set(key, patchValue)
    }
  }

  // Emit changed keys in the same order as the old
  // sanitize(previous)->sanitize(current) key union, so serialized patches stay
  // byte-identical while the expensive comparison remains allowlist-scoped.
  for (const key of orderedKeys) {
    if (changedValues.has(key)) {
      patch[key] = changedValues.get(key)
    }
  }
  return patch
}

function chatMetadataPatchKeyOrder(
  previousRecord: Record<string, unknown>,
  currentRecord: Record<string, unknown>,
): string[] {
  const orderedKeys: string[] = []
  const seen = new Set<string>()
  const appendKeys = (record: Record<string, unknown>) => {
    for (const key of Object.keys(record)) {
      if (seen.has(key) || !CHAT_PATCH_ALLOWED_KEYS.has(key)) continue
      if (!hasSanitizedChatMetadataValue(record, key)) continue
      seen.add(key)
      orderedKeys.push(key)
    }
  }
  appendKeys(previousRecord)
  appendKeys(currentRecord)
  return orderedKeys
}

function sanitizedChatMetadataValue(record: Record<string, unknown>, key: string): unknown {
  return hasSanitizedChatMetadataValue(record, key) ? record[key] : undefined
}

function hasSanitizedChatMetadataValue(record: Record<string, unknown>, key: string): boolean {
  return (
    Object.prototype.propertyIsEnumerable.call(record, key) && snapshotJson(record[key]) !== JSON_UNDEFINED_SNAPSHOT
  )
}

function changedScriptstatePatch(
  previous: Chat['scriptstate'] | undefined,
  current: Chat['scriptstate'] | undefined,
): { patch: ChatScriptstatePatch; deleteKeys: string[] } {
  const patch: ChatScriptstatePatch = {}
  const deleteKeys: string[] = []
  const previousState = previous ?? {}
  const currentState = current ?? {}
  const keys = new Set([...Object.keys(previousState), ...Object.keys(currentState)])
  for (const key of keys) {
    if (!(key in currentState)) {
      deleteKeys.push(key)
      continue
    }
    if (snapshotJson(previousState[key]) !== snapshotJson(currentState[key])) {
      patch[key] = currentState[key]
    }
  }
  return { patch: sanitizeScriptstatePatch(patch), deleteKeys }
}

const JSON_UNDEFINED_SNAPSHOT = '__undefined__'

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? JSON_UNDEFINED_SNAPSHOT : snapshot
}
