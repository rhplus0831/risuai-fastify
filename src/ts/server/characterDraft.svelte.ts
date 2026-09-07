import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  isClientSessionGenerationCurrent,
} from '../clientSession'
import { untrack } from 'svelte'
import { get } from 'svelte/store'
import {
  CHARACTER_PATCH_DELETABLE_KEYS,
  CHARACTER_PATCH_EXCLUDED_KEYS,
  applyAttemptedCharacterFieldRollback,
  applyCharacterPatchToRecord,
  cloneJsonValue,
  dispatchUpdateCharacter,
  isCharacterPatchValueCurrent,
  sanitizeCharacterPatch,
  type CharacterStateSnapshot,
} from '../characterCommands'
import { canUseServerCommands, type CharacterSnapshot, type ServerCommandTransportOptions } from './commands'
import { selectedCharID } from '../stores.svelte'
import { isServerCharacterShell, SERVER_CHARACTER_SHELL_MARKER, type character } from '../storage/database.svelte'
import {
  captureCharacterRowProjectionEpoch,
  charactersResourceState,
  getCharacterResourceOwner,
  markCharacterResourceOwnerChanged,
} from './resourceState.svelte'
import { mergeProjectionIntoDirtyDraft } from './staleStateGuards'
import { dispatchDurableMutation } from './durableMutationDispatch'
import { registerPendingOwnerMutationFlusher } from './pendingOwnerMutationRegistry'
import {
  acknowledgePendingMutation,
  stagePendingMutation,
  type DurableMutationIntent,
  type PendingMutationHandle,
} from './pendingMutationOutbox'
import { characterOwnerMutationKey } from './resourceOwnerMutationKeys'
import { normalizeScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import { subscribeServerCommandLocalEffectApplied } from './commandLocalEffectEvents'

interface PendingCharacterPatch {
  sessionGeneration: number
  characterId: string
  patch: CharacterSnapshot
  previous: CharacterStateSnapshot
  timer: ReturnType<typeof setTimeout> | null
  intent: DurableMutationIntent
  outbox: PendingMutationHandle
}

interface PendingCharacterAttempt {
  sequence: number
  characterId: string
  previous: CharacterStateSnapshot
  attempted: CharacterSnapshot
}

const pendingPatches = new Map<string, PendingCharacterPatch>()
const pendingCharacterAttempts: PendingCharacterAttempt[] = []
const activeCharacterDraftFailureSettlers = new Set<(attempt: PendingCharacterAttempt) => void>()
let nextCharacterAttemptSequence = 0
const CHARACTER_DRAFT_DELAY_MS = 300

function characterOwnerRows(): character[] {
  return charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
}

function uniqueCharacterOwner(characterId: string): character | undefined {
  if (!characterId) return undefined
  return charactersResourceState.status === 'ready' ? getCharacterResourceOwner(characterId) : undefined
}

function selectedCharacterOwner(index: number): character | undefined {
  if (index < 0) return undefined
  const candidate = characterOwnerRows()[index]
  return candidate?.chaId ? uniqueCharacterOwner(candidate.chaId) : undefined
}

function applyCharacterProjectionPatchById(characterId: string, patch: CharacterSnapshot): void {
  const owner = uniqueCharacterOwner(characterId)
  if (!owner) return
  const characters = characterOwnerRows()
  const index = characters.indexOf(owner)
  if (index < 0) return
  applyCharacterProjectionPatch(characters, index, patch)
  markCharacterResourceOwnerChanged(characterId)
}

export type CharacterDraftValue = Record<string, any> & CharacterSnapshot

export interface CharacterOwnerDraft {
  characterId: string | null
  value: CharacterDraftValue
  captureRecoveryDraft(): { characterId: string; value: CharacterDraftValue; baseline: CharacterDraftValue } | null
}

export interface CharacterOwnerDraftOptions {
  delayMs?: number
}

export function createCharacterOwnerDraft(
  keys: readonly string[],
  options: CharacterOwnerDraftOptions = {},
): CharacterOwnerDraft {
  const sessionGeneration = captureClientSessionGeneration()
  const delayMs = options.delayMs ?? CHARACTER_DRAFT_DELAY_MS
  const initialSelected = get(selectedCharID)
  const initialCharacter = selectedCharacterOwner(initialSelected)
  const initialCharacterId =
    initialCharacter && !isServerCharacterShell(initialCharacter) ? (initialCharacter.chaId ?? null) : null
  const initialSeed = currentCharacterDraftSeed(initialSelected, initialCharacterId, keys)
  let recoveryBaseline = cloneJsonValue(initialSeed.serverValue)
  const draft = $state<CharacterOwnerDraft>({
    characterId: initialCharacterId,
    value: cloneJsonValue(initialSeed.serverValue),
    captureRecoveryDraft() {
      if (!draft.characterId || snapshotJson(draft.value) === snapshotJson(recoveryBaseline)) return null
      return {
        characterId: draft.characterId,
        value: cloneJsonValue(draft.value),
        baseline: cloneJsonValue(recoveryBaseline),
      }
    },
  })
  let initialized = false
  let suppressDraftDispatch = false
  let previousServerSnapshot = ''
  let previousSeedSelected = Number.NaN
  let previousSeedCharacterId: string | null = null
  let previousSeedProjectionEpoch = -1
  const dirtyFields = new Set<keyof CharacterDraftValue & string>()
  const selectedCharMirror = $state({ value: get(selectedCharID) })
  let draftInitialized = false
  let previousDraftDispatchSnapshot = ''

  const settleFailedAttempt = (attempt: PendingCharacterAttempt): void => {
    if (draft.characterId !== attempt.characterId || dirtyFields.size === 0) return
    const previousProfile = characterAttemptPreviousProfile(attempt)
    if (!previousProfile) return
    const previousValue = normalizeCharacterDraft(pickCharacterFields(previousProfile, keys))
    let changed = false

    for (const key of Object.keys(attempt.attempted)) {
      if (!dirtyFields.has(key)) continue
      if (!isCharacterPatchValueCurrent(draft.value, key, attempt.attempted[key])) continue
      draft.value[key] = cloneJsonValue(previousValue[key])
      dirtyFields.delete(key)
      changed = true
    }

    if (!changed) return
    suppressDraftDispatch = true
    draft.value = { ...draft.value }
    previousDraftDispatchSnapshot = snapshotJson(draft.value)
    previousServerSnapshot = snapshotJson({ characterId: draft.characterId, value: draft.value })
    queueMicrotask(() => {
      suppressDraftDispatch = false
    })
  }

  $effect(() => {
    activeCharacterDraftFailureSettlers.add(settleFailedAttempt)
    return () => activeCharacterDraftFailureSettlers.delete(settleFailedAttempt)
  })

  $effect(() => {
    const unsubscribe = selectedCharID.subscribe((value) => {
      selectedCharMirror.value = value
    })
    return unsubscribe
  })

  $effect(() => {
    const selected = selectedCharMirror.value
    const selectedCharacter = selectedCharacterOwner(selected)
    const characterId =
      selectedCharacter && !isServerCharacterShell(selectedCharacter) ? (selectedCharacter.chaId ?? null) : null
    const identityChanged = !initialized || selected !== previousSeedSelected || characterId !== previousSeedCharacterId
    const projectionEpoch = characterId ? captureCharacterRowProjectionEpoch(characterId) : -1
    const ownerProjectionChanged = projectionEpoch !== previousSeedProjectionEpoch

    if (!identityChanged && !ownerProjectionChanged) return

    previousSeedSelected = selected
    previousSeedCharacterId = characterId
    previousSeedProjectionEpoch = projectionEpoch

    const { serverSnapshot, serverValue } = untrack(() => currentCharacterDraftSeed(selected, characterId, keys))

    if (identityChanged || !characterId) {
      recoveryBaseline = cloneJsonValue(serverValue)
      dirtyFields.clear()
    }

    const shouldSeedDraft =
      identityChanged ||
      ownerProjectionChanged ||
      untrack(() => {
        const draftSnapshot = snapshotJson({
          characterId: draft.characterId,
          value: draft.value,
        })
        return serverSnapshot !== previousServerSnapshot && serverSnapshot !== draftSnapshot
      })

    if (shouldSeedDraft) {
      suppressDraftDispatch = true
      if (!identityChanged && ownerProjectionChanged && dirtyFields.size > 0) {
        draft.characterId = characterId
        mergeProjectionIntoDirtyDraft({
          draft: draft.value,
          projection: serverValue,
          dirtyFields,
        })
        if (isClientSessionGenerationCurrent(sessionGeneration)) {
          reassertDirtyDraftFields(selected, characterId, draft.value, dirtyFields)
        }
      } else {
        recoveryBaseline = cloneJsonValue(serverValue)
        dirtyFields.clear()
        draft.characterId = characterId
        draft.value = cloneJsonValue(serverValue)
      }
      queueMicrotask(() => {
        suppressDraftDispatch = false
      })
      initialized = true
    }

    previousServerSnapshot = dirtyFields.size > 0 ? snapshotJson({ characterId, value: draft.value }) : serverSnapshot
  })

  $effect(() =>
    subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
      if (localEffect.kind !== 'characterPatch' || localEffect.characterId !== draft.characterId) return
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(localEffect.patch, key))
          recoveryBaseline[key] = cloneJsonValue(localEffect.patch[key])
      }

      for (const key of Array.from(dirtyFields)) {
        if (
          Object.prototype.hasOwnProperty.call(localEffect.patch, key) &&
          isCharacterPatchValueCurrent(draft.value, key, localEffect.patch[key])
        ) {
          dirtyFields.delete(key)
        }
      }
    }),
  )

  $effect(() => {
    const characterId = draft.characterId
    const draftSnapshot = snapshotJson(draft.value)
    if (!draftInitialized) {
      draftInitialized = true
      previousDraftDispatchSnapshot = draftSnapshot
      return
    }
    if (suppressDraftDispatch || !characterId) {
      previousDraftDispatchSnapshot = draftSnapshot
      return
    }
    if (draftSnapshot === previousDraftDispatchSnapshot) return
    const previousDraftValue = parseDraftSnapshot(previousDraftDispatchSnapshot)
    const changedFields = changedTopLevelDraftFields(previousDraftValue, draft.value)
    for (const key of changedFields) {
      dirtyFields.add(key)
    }
    previousDraftDispatchSnapshot = draftSnapshot

    untrack(() => {
      if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration)) return
      const character = uniqueCharacterOwner(characterId)
      if (!character || isServerCharacterShell(character)) return
      const previousProfile = scalarCharacterProfile(character as unknown as Record<string, unknown>)
      const changedPatch: CharacterSnapshot = {}
      for (const key of changedFields) {
        changedPatch[key] = cloneJsonValue(draft.value[key])
      }
      const patch = sanitizeCharacterPatch(changedPatch)
      applyCharacterProjectionPatchById(characterId, patch)
      if (canUseServerCommands() && Object.keys(patch).length > 0) {
        queueCharacterPatch(
          characterId,
          patch,
          selectedCharacterProfileSnapshot(characterId, previousProfile, get(selectedCharID)),
          delayMs,
        )
      }
      previousServerSnapshot = snapshotJson({ characterId, value: patch })
    })
  })

  return draft
}

function parseDraftSnapshot(snapshot: string): CharacterDraftValue {
  if (!snapshot || snapshot === '__undefined__') return {}
  return JSON.parse(snapshot) as CharacterDraftValue
}

function changedTopLevelDraftFields(
  previous: CharacterDraftValue,
  current: CharacterDraftValue,
): Array<keyof CharacterDraftValue & string> {
  const changed: Array<keyof CharacterDraftValue & string> = []
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)])
  for (const key of keys) {
    if (snapshotJson(previous[key]) !== snapshotJson(current[key])) {
      changed.push(key)
    }
  }
  return changed
}

function reassertDirtyDraftFields(
  _selected: number,
  characterId: string | null,
  draft: CharacterDraftValue,
  dirtyFields: ReadonlySet<keyof CharacterDraftValue & string>,
): void {
  if (!canUseClientWriteAccess()) return
  if (!characterId || dirtyFields.size === 0) return

  const patch: CharacterSnapshot = {}
  for (const key of dirtyFields) {
    patch[key] = cloneJsonValue(draft[key])
  }
  const sanitized = sanitizeCharacterPatch(patch)
  if (Object.keys(sanitized).length === 0) return

  const character = uniqueCharacterOwner(characterId)
  if (!character || isServerCharacterShell(character)) return
  const pending: CharacterSnapshot = {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (!isCharacterPatchValueCurrent(character as unknown as Record<string, unknown>, key, value)) {
      pending[key] = cloneJsonValue(value)
    }
  }
  if (Object.keys(pending).length > 0) applyCharacterProjectionPatchById(characterId, pending)
}

function applyCharacterProjectionPatch(characters: character[], index: number, patch: CharacterSnapshot): void {
  const character = characters[index]
  const deletesField = Object.entries(patch).some(
    ([field, value]) => value === null && CHARACTER_PATCH_DELETABLE_KEYS.has(field),
  )
  if (!deletesField) {
    applyCharacterPatchToRecord(character as unknown as Record<string, unknown>, patch)
    return
  }

  const next = { ...(character as unknown as Record<string, unknown>) }
  applyCharacterPatchToRecord(next, patch)
  characters[index] = next as unknown as (typeof characters)[number]
}

function currentCharacterDraftSeed(
  selected: number,
  characterId: string | null,
  keys: readonly string[],
): { serverSnapshot: string; serverValue: CharacterDraftValue } {
  const character = characterId ? uniqueCharacterOwner(characterId) : selectedCharacterOwner(selected)
  if (!character || isServerCharacterShell(character)) {
    const serverValue = normalizeCharacterDraft(pickCharacterFields({}, keys))
    return {
      serverSnapshot: snapshotJson({ characterId: null, value: serverValue }),
      serverValue,
    }
  }

  const serverValue = normalizeCharacterDraft(pickCharacterFields(character as unknown as CharacterSnapshot, keys))
  return {
    serverSnapshot: snapshotJson({ characterId, value: serverValue }),
    serverValue,
  }
}

function queueCharacterPatch(
  characterId: string,
  patch: CharacterSnapshot,
  previous: CharacterStateSnapshot,
  delay: number,
): void {
  if (!canUseClientWriteAccess()) return
  const pendingPatch = pendingPatches.get(characterId)
  if (pendingPatch?.timer) clearTimeout(pendingPatch.timer)

  const commandPatch = sanitizeCharacterPatch({ ...(pendingPatch?.patch ?? {}), ...patch })
  if (Object.keys(commandPatch).length === 0) {
    if (pendingPatch) void acknowledgePendingMutation(pendingPatch.outbox)
    pendingPatches.delete(characterId)
    return
  }

  const intent = characterPatchDurableIntent(characterId, commandPatch)
  const nextPatch: PendingCharacterPatch = {
    sessionGeneration: captureClientSessionGeneration(),
    characterId,
    patch: commandPatch,
    previous: pendingPatch?.previous ?? previous,
    timer: null,
    intent,
    outbox: stagePendingMutation(characterOwnerMutationKey(characterId), intent, pendingPatch?.outbox),
  }

  nextPatch.timer = setTimeout(() => runPendingCharacterPatch(characterId), delay)
  pendingPatches.set(characterId, nextPatch)
}

export function flushPendingCharacterDraftPatches(options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  for (const characterId of Array.from(pendingPatches.keys())) {
    runPendingCharacterPatch(characterId, options)
  }
}

registerPendingOwnerMutationFlusher('character-draft', flushPendingCharacterDraftPatches)

function runPendingCharacterPatch(characterId: string, options: ServerCommandTransportOptions = {}): void {
  if (!canUseClientWriteAccess()) return
  const commandPatch = pendingPatches.get(characterId)
  if (!commandPatch || !isClientSessionGenerationCurrent(commandPatch.sessionGeneration)) return
  if (commandPatch.timer) clearTimeout(commandPatch.timer)
  pendingPatches.delete(characterId)

  const rollbackSnapshot = {
    ...commandPatch.previous,
    selectedCharID: get(selectedCharID),
    attemptedProfile: sanitizeCharacterPatch(commandPatch.patch),
  } as CharacterStateSnapshot

  const attempt = registerCharacterAttempt(commandPatch.characterId, rollbackSnapshot)
  const result = dispatchDurableMutation(commandPatch.outbox, commandPatch.intent, (transport) => {
    const dispatched = dispatchUpdateCharacter(
      commandPatch.characterId,
      commandPatch.patch,
      rollbackSnapshot,
      () => rollbackCharacterAttempt(attempt),
      { ...options, ...transport },
    )
    return dispatched ?? Promise.resolve({ status: 'unavailable' as const })
  })
  void result.then(
    () => clearCharacterAttempt(attempt),
    () => clearCharacterAttempt(attempt),
  )
}

function characterPatchDurableIntent(characterId: string, patch: CharacterSnapshot): DurableMutationIntent {
  return {
    version: 1,
    requests: [
      {
        method: 'PATCH',
        path: `/characters/${encodeURIComponent(characterId)}`,
        body: { patch: cloneJsonValue(patch) },
      },
    ],
  }
}

function registerCharacterAttempt(characterId: string, snapshot: CharacterStateSnapshot): PendingCharacterAttempt {
  const attempted = sanitizeCharacterPatch(
    (snapshot as CharacterStateSnapshot & { attemptedProfile?: CharacterSnapshot }).attemptedProfile ?? {},
  )
  const attempt = {
    sequence: ++nextCharacterAttemptSequence,
    characterId,
    previous: snapshot,
    attempted,
  }
  pendingCharacterAttempts.push(attempt)
  return attempt
}

function rollbackCharacterAttempt(attempt: PendingCharacterAttempt): void {
  rollbackCharacterDraftAttempt(attempt.previous)
  for (const settleDraft of activeCharacterDraftFailureSettlers) settleDraft(attempt)
  rebaseLaterCharacterAttempts(attempt)
  clearCharacterAttempt(attempt)
}

function rebaseLaterCharacterAttempts(failed: PendingCharacterAttempt): void {
  const failedPrevious = characterAttemptPreviousProfile(failed)
  if (!failedPrevious) return

  for (const key of Object.keys(failed.attempted)) {
    let rebased = false
    for (const later of pendingCharacterAttempts) {
      if (later.sequence <= failed.sequence || later.characterId !== failed.characterId) continue
      if (!Object.prototype.hasOwnProperty.call(later.attempted, key)) continue
      const laterPrevious = characterAttemptPreviousProfile(later)
      if (!laterPrevious || !sameFieldValue(laterPrevious, failed.attempted, key)) continue
      copyFieldValue(laterPrevious, failedPrevious, key)
      rebased = true
      break
    }

    if (rebased) continue
    const queued = pendingPatches.get(failed.characterId)
    const queuedPrevious = queued ? characterSnapshotProfile(queued.previous) : undefined
    if (
      queued &&
      queuedPrevious &&
      Object.prototype.hasOwnProperty.call(queued.patch, key) &&
      sameFieldValue(queuedPrevious, failed.attempted, key)
    ) {
      copyFieldValue(queuedPrevious, failedPrevious, key)
    }
  }
}

function characterAttemptPreviousProfile(attempt: PendingCharacterAttempt): CharacterSnapshot | undefined {
  return characterSnapshotProfile(attempt.previous)
}

function characterSnapshotProfile(snapshot: CharacterStateSnapshot): CharacterSnapshot | undefined {
  return (snapshot as CharacterStateSnapshot & { profile?: CharacterSnapshot }).profile
}

function sameFieldValue(left: CharacterSnapshot, right: CharacterSnapshot, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(right, key)) {
    return !Object.prototype.hasOwnProperty.call(left, key)
  }
  return isCharacterPatchValueCurrent(left, key, right[key])
}

function copyFieldValue(target: CharacterSnapshot, source: CharacterSnapshot, key: string): void {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = cloneJsonValue(source[key])
  } else {
    delete target[key]
  }
}

function clearCharacterAttempt(attempt: PendingCharacterAttempt): void {
  const index = pendingCharacterAttempts.findIndex((candidate) => candidate.sequence === attempt.sequence)
  if (index !== -1) pendingCharacterAttempts.splice(index, 1)
}

function scalarCharacterProfile(character: Record<string, unknown>): CharacterSnapshot {
  const profile: CharacterSnapshot = {}
  for (const [key, value] of Object.entries(character)) {
    if (key === SERVER_CHARACTER_SHELL_MARKER) continue
    if (CHARACTER_PATCH_EXCLUDED_KEYS.has(key) || value === undefined) continue
    profile[key] = cloneJsonValue(value)
  }
  return profile
}

function selectedCharacterProfileSnapshot(
  characterId: string,
  profile: CharacterSnapshot,
  selected: number,
): CharacterStateSnapshot {
  return {
    characters: [],
    characterOrder: [],
    currentChar: charactersResourceState.currentChar,
    selectedCharID: selected,
    profileCharacterId: characterId,
    profile,
  } as CharacterStateSnapshot
}

function pickCharacterFields(character: CharacterSnapshot, keys: readonly string[]): CharacterDraftValue {
  const picked: CharacterDraftValue = {}
  for (const key of keys) {
    picked[key] = cloneJsonValue(character[key])
  }
  return picked
}

function normalizeCharacterDraft(value: CharacterSnapshot): CharacterDraftValue {
  value.name ??= ''
  if (Object.prototype.hasOwnProperty.call(value, 'displayName')) {
    value.displayName ??= ''
  }
  value.desc ??= ''
  value.firstMessage ??= ''
  value.customNotificationMessage ??= ''
  value.image ??= ''
  value.notificationImage ??= ''
  value.ccAssets ??= []
  value.largePortrait ??= false
  value.viewScreen ??= 'none'
  value.emotionImages ??= []
  value.inlayViewScreen ??= false
  value.newGenData ??= {
    prompt: '',
    negative: '',
    instructions: '',
    emotionInstructions: '',
  }
  value.additionalAssets ??= []
  value.prebuiltAssetCommand ??= false
  value.prebuiltAssetStyle ??= ''
  value.prebuiltAssetExclude ??= []
  value.lowLevelAccess ??= false
  value.scriptModelOverrides = normalizeScriptModelOverrides(value.scriptModelOverrides)
  value.hideChatIcon ??= false
  value.utilityBot ??= false
  value.escapeOutput ??= false
  value.backgroundHTML ??= ''
  value.virtualscript ??= ''
  value.ttsMode ??= ''
  value.ttsSpeech ??= ''
  value.voicevoxConfig ??= {
    speaker: '',
    SPEED_SCALE: 1,
    PITCH_SCALE: 0,
    VOLUME_SCALE: 1,
    INTONATION_SCALE: 1,
  }
  value.naittsConfig ??= {
    customvoice: false,
    voice: 'Aini',
    version: 'v2',
  }
  value.oaiVoice ??= ''
  value.oaiTTSConfig ??= {
    enabled: false,
    format: 'mp3',
  }
  value.hfTTS ??= {
    model: '',
    language: 'en',
  }
  value.gptSoVitsConfig ??= {
    url: '',
    use_auto_path: false,
    ref_audio_path: '',
    use_long_audio: false,
    ref_audio_data: {
      fileName: '',
      assetId: '',
    },
    volume: 1.0,
    text_lang: 'auto',
    text: 'en',
    use_prompt: false,
    prompt_lang: 'en',
    top_p: 1,
    temperature: 0.7,
    speed: 1,
    top_k: 5,
    text_split_method: 'cut0',
  }
  value.fishSpeechConfig ??= {
    model: {
      _id: '',
      title: '',
      description: '',
    },
    chunk_length: 200,
    normalize: false,
  }
  value.ttsReadOnlyQuoted ??= false
  value.bias ??= []
  value.exampleMessage ??= ''
  value.creatorNotes ??= ''
  value.systemPrompt ??= ''
  value.replaceGlobalNote ??= ''
  value.additionalText ??= ''
  value.personality ??= ''
  value.scenario ??= ''
  value.defaultVariables ??= ''
  value.translatorNote ??= ''
  const additionalData =
    value.additionalData && typeof value.additionalData === 'object'
      ? (value.additionalData as Record<string, unknown>)
      : {}
  additionalData.creator ??= ''
  additionalData.character_version ??= ''
  value.additionalData = additionalData
  value.nickname ??= ''
  value.depth_prompt ??= {
    depth: 4,
    prompt: '',
  }
  value.alternateGreetings ??= []
  value.removedQuotes ??= false
  value.lorePlus ??= false
  return value
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function rollbackCharacterDraftAttempt(snapshot: CharacterStateSnapshot): void {
  const profileSnapshot = snapshot as CharacterStateSnapshot & {
    profileCharacterId?: string
    profile?: CharacterSnapshot
    attemptedProfile?: CharacterSnapshot
  }

  if (!profileSnapshot.profileCharacterId || !profileSnapshot.profile) return
  const character = uniqueCharacterOwner(profileSnapshot.profileCharacterId)
  if (!character) return
  if (profileSnapshot.attemptedProfile) {
    applyAttemptedCharacterFieldRollback({
      target: character as unknown as Record<string, unknown>,
      previous: profileSnapshot.profile,
      attempted: profileSnapshot.attemptedProfile,
    })
  } else {
    Object.assign(character, cloneJsonValue(profileSnapshot.profile))
  }
  markCharacterResourceOwnerChanged(profileSnapshot.profileCharacterId)
}
