import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { get } from 'svelte/store'
import { SvelteMap } from 'svelte/reactivity'
import { selectedCharID } from '../stores.svelte'
import {
  currentChatScopedSnapshot,
  dispatchReplaceTailMessagesScoped,
  dispatchUpdateMessageScoped,
  type ActiveChatTarget,
} from '../chatCommands'
import { safeStructuredClone } from '../polyfill'
import { createLatestOperationGuard } from '../server/staleStateGuards'
import type { Message } from '../storage/database.svelte'
import { clearPrererolls, PreUnreroll, Prereroll } from './prereroll'
import { selectCharacterOwner } from '../characterState'
import {
  charactersResourceState,
  getCharacterResourceOwner,
  getChatMetadataOwnerState,
} from '../server/resourceState.svelte'
import { getChatMessageOwnerState } from '../server/chatMessageHydration.svelte'

// Reroll *swipe* state machine, extracted out of `DefaultChatScreen.svelte` so it
// is unit-testable and so persisted reroll buffers (server alternate rows) can be
// reconstructed on chat-open (`seedRerollBufferFromAlternates`). Behaviour is
// preserved verbatim from the component; the swipe E2E is the safety net.
//
// `rerolls` is the swipe history: each entry is the message *tail slice* a swipe
// restores (the last assistant message group); `rerollid` is the active position.
// The active transcript tail is itself `rerolls[rerollid]`, so the active
// selection is durable for free (it is the persisted tail) and a swipe only
// repositions it — it never has to write the buffer (the buffer rows are owned by
// the server, written at generation time and matched back here by `uid`).

interface RerollState {
  rerolls: Message[][]
  rerollid: number
}

const rerollStates = new SvelteMap<string, RerollState>()
const rerollOperationGuard = createLatestOperationGuard<string>()

export interface RerollDeps {
  /** The component's send wrapper (owns the AbortController + send sound). */
  sendChatMain: (continued: boolean, regenerateMessageId?: string) => Promise<boolean>
  /** Close the chat input menu (component UI state). */
  closeMenu: () => void
}

export interface RerollCandidate {
  index: number
  active: boolean
  messages: readonly Message[]
}

type RerollOperation = {
  sourceGeneration: number
  token: ReturnType<typeof rerollOperationGuard.issue>
  target: ActiveChatTarget
}

function currentRerollTarget(): ActiveChatTarget | null {
  if (charactersResourceState.status !== 'ready') return null
  const selectedIndex = get(selectedCharID)
  const character = selectCharacterOwner(charactersResourceState.characters, selectedIndex)
  if (!character?.chaId || getCharacterResourceOwner(character.chaId) !== character) return null
  const chatPage = character.chatPage ?? -1
  const chat = character.chats?.[chatPage]
  if (!stableOwnerId(chat?.id) || !getChatMetadataOwnerState(chat.id)) return null
  return {
    selectedCharID: selectedIndex,
    chatPage,
    characterId: character.chaId,
    chatId: chat.id,
  }
}

function rerollTargetKey(target: ActiveChatTarget | null | undefined): string | null {
  if (!target || !stableOwnerId(target.characterId) || !stableOwnerId(target.chatId)) return null
  return `character:id:${target.characterId}|chat:id:${target.chatId}`
}

function currentRerollScopeTarget(): string | null {
  return rerollTargetKey(currentRerollTarget())
}

function beginRerollOperation(): RerollOperation | null {
  if (!canUseClientWriteAccess()) return null
  const sourceGeneration = captureClientSessionGeneration()
  const target = currentRerollTarget()
  const targetKey = rerollTargetKey(target)
  if (!target || !targetKey) return null
  return {
    sourceGeneration,
    token: rerollOperationGuard.issue(targetKey),
    target,
  }
}

function isCurrentRerollOperation(operation: RerollOperation): boolean {
  return (
    isClientWriteOperationCurrent(operation.sourceGeneration) &&
    rerollOperationGuard.isLatest(operation.token) &&
    currentRerollScopeTarget() === operation.token.target
  )
}

function rerollState(target: ActiveChatTarget | null | undefined): RerollState {
  const targetKey = rerollTargetKey(target)
  return (targetKey ? rerollStates.get(targetKey) : undefined) ?? { rerolls: [], rerollid: -1 }
}

function setRerollState(target: ActiveChatTarget, state: RerollState): void {
  const targetKey = rerollTargetKey(target)
  if (!targetKey) return
  rerollStates.set(targetKey, state)
}

function operationRerollState(operation: RerollOperation): RerollState {
  return rerollStates.get(operation.token.target) ?? { rerolls: [], rerollid: -1 }
}

function setOperationRerollState(operation: RerollOperation, state: RerollState): void {
  rerollStates.set(operation.token.target, state)
}

function locateRerollTarget(target: ActiveChatTarget): { messages: Message[] } | null {
  if (!stableOwnerId(target.characterId) || !stableOwnerId(target.chatId)) return null
  const character = getCharacterResourceOwner(target.characterId)
  if (!character) return null
  const matchingChats = character.chats?.filter((chat) => chat.id === target.chatId) ?? []
  if (matchingChats.length !== 1 || !getChatMetadataOwnerState(target.chatId)) return null
  const transcript = getChatMessageOwnerState(target.chatId)
  return transcript ? { messages: transcript.messages } : null
}

function currentTailGenerationId(): string | undefined {
  const target = currentRerollTarget()
  return target ? locateRerollTarget(target)?.messages.at(-1)?.generationInfo?.generationId : undefined
}

/**
 * Retained as the send/navigation compatibility boundary. Selecting another
 * chat now selects that chat's own state instead of clearing a module-global
 * buffer, so there is no destructive work to perform here.
 */
export function resetRerollOnCharChange(target: ActiveChatTarget | null = currentRerollTarget()): void {
  const targetKey = rerollTargetKey(target)
  if (!target || !targetKey || rerollStates.has(targetKey)) return
  rerollStates.set(targetKey, { rerolls: [], rerollid: -1 })
}

/** Drop the swipe history — the send/continue confirm boundary. */
export function clearRerollBuffer(target: ActiveChatTarget | null = currentRerollTarget()): void {
  if (!canUseClientWriteAccess()) return
  if (!target) return
  setRerollState(target, { rerolls: [], rerollid: -1 })
}

/** Record the just-generated tail as the newest swipe candidate (post-send). */
export function recordGeneratedReroll(previousLength: number, target: ActiveChatTarget): void {
  if (!canUseClientWriteAccess()) return
  const message = locateRerollTarget(target)?.messages
  if (!message) return
  if (previousLength < message.length) {
    // Clone only the freshly generated tail. `message.slice(previousLength)` is a
    // cheap shallow array of the 1-2 new rows; deep-cloning that is O(tail) and
    // byte-identical to the former `safeStructuredClone(message).slice(...)`, which
    // deep-cloned the entire transcript just to keep its last rows.
    const generatedTail = safeStructuredClone(message.slice(previousLength))
    const state = rerollState(target)
    const generatedUid = candidateUid(generatedTail.at(-1))
    const existingIndex = generatedUid
      ? state.rerolls.findIndex((candidate) => candidateUid(candidate.at(-1)) === generatedUid)
      : -1
    if (existingIndex >= 0) {
      const rerolls = state.rerolls.slice()
      rerolls[existingIndex] = generatedTail
      setRerollState(target, { rerolls, rerollid: existingIndex })
    } else {
      const rerolls = [...state.rerolls, generatedTail]
      setRerollState(target, { rerolls, rerollid: rerolls.length - 1 })
    }
  }
}

/** Ensure a generation target owns an initialized reroll state entry. */
export function markRerollChar(target: ActiveChatTarget): void {
  resetRerollOnCharChange(target)
}

// ── guard-safe optimistic mutations ─────────────────────────────────────────────
// Scoped command helpers own the optimistic paint, durable dispatch, retained
// intent, and current-attempt rollback. Navigation supplies only stable IDs and
// detached candidate data.

/** Swap just the active tail message's `data` (prefetch reroll), then persist. */
function applyTailDataSwap(data: string, operation: RerollOperation): boolean {
  if (!isCurrentRerollOperation(operation)) return false
  const transcript = locateRerollTarget(operation.target)?.messages
  if (!transcript || transcript.length === 0) return false
  const messageId = uniqueMessageIdAt(transcript, transcript.length - 1)
  if (!messageId) return false
  const previous = currentChatScopedSnapshot()
  if (previous.characterId !== operation.target.characterId || previous.chatId !== operation.target.chatId) return false
  dispatchUpdateMessageScoped(messageId, { data }, previous)
  return true
}

/** Overwrite the last `slice.length` messages with a saved candidate, then persist. */
function applyTailSlice(slice: Message[], operation: RerollOperation): boolean {
  if (!isCurrentRerollOperation(operation)) return false
  const chatId = operation.target.chatId
  if (!stableOwnerId(chatId)) return false
  const transcript = locateRerollTarget(operation.target)?.messages
  if (!transcript || slice.length === 0 || slice.length > transcript.length) return false
  const start = transcript.length - slice.length
  const afterMessageId = start > 0 ? uniqueMessageIdAt(transcript, start - 1) : null
  if (start > 0 && !afterMessageId) return false
  const attemptedMessages = transcript.slice(0, start).concat(slice)
  if (!hasStableUniqueMessageIds(attemptedMessages)) return false
  const previous = currentChatScopedSnapshot()
  if (previous.characterId !== operation.target.characterId || previous.chatId !== operation.target.chatId) return false
  dispatchReplaceTailMessagesScoped(chatId, afterMessageId, safeStructuredClone(slice), previous)
  return true
}

async function regenerateFromCurrentTail(deps: RerollDeps, operation: RerollOperation): Promise<void> {
  if (!isCurrentRerollOperation(operation)) {
    return
  }
  let state = operationRerollState(operation)
  const activeMessages = locateRerollTarget(operation.target)?.messages
  if (!activeMessages) return
  if (state.rerolls.length === 0) {
    const rerolls = [safeStructuredClone([activeMessages.at(-1)]) as Message[]]
    state = { rerolls, rerollid: rerolls.length - 1 }
    setOperationRerollState(operation, state)
  }
  // Keep the target assistant authoritative until the server atomically accepts
  // the operation and replaces it at finalization. The shallow copy is used only
  // to calculate the post-regenerate tail boundary for the in-memory swipe buffer;
  // it is never installed or persisted.
  const cha = activeMessages.slice()
  if (cha.length === 0) {
    return
  }
  const targetMessage = cha.at(-1)
  const regenerateMessageId = targetMessage?.role === 'user' ? undefined : candidateUid(targetMessage)
  if (!regenerateMessageId) return
  deps.closeMenu()
  const saying = targetMessage?.saying
  let sayingQu = 2
  while (cha.length > 0 && cha.at(-1)?.role !== 'user') {
    if (cha.at(-1)?.saying === saying) {
      sayingQu -= 1
      if (sayingQu === 0) {
        break
      }
    }
    const msg = cha.pop()
    if (!msg) {
      return
    }
  }
  const generated = await deps.sendChatMain(false, regenerateMessageId)
  if (generated && isClientWriteOperationCurrent(operation.sourceGeneration))
    recordGeneratedReroll(cha.length, operation.target)
}

function applyNextPrefetchedReroll(operation: RerollOperation): boolean {
  if (!isCurrentRerollOperation(operation)) return false
  const genId = currentTailGenerationId()
  if (!genId) return false
  const r = Prereroll(genId)
  if (!r) return false
  return applyTailDataSwap(r, operation)
}

// Concurrency contract: callers MUST NOT invoke reroll/unReroll while a generation
// is in flight for the same chat (the component wrappers use chat-keyed activity). A swipe's
// dispatchReplaceMessages would otherwise race an in-flight regenerate's persist —
// the swap could remove the regenerate's target row before the server commits it.
// The server lock and client activity entry keep same-chat work mutually exclusive.
export async function reroll(deps: RerollDeps): Promise<void> {
  const operation = beginRerollOperation()
  if (!operation) return
  try {
    resetRerollOnCharChange(operation.target)
    if (!isCurrentRerollOperation(operation)) return
    if (applyNextPrefetchedReroll(operation)) return
    const state = operationRerollState(operation)
    if (state.rerollid < state.rerolls.length - 1) {
      if (Array.isArray(state.rerolls[state.rerollid + 1])) {
        if (!isCurrentRerollOperation(operation)) return
        const rerollid = state.rerollid + 1
        if (applyTailSlice(safeStructuredClone(state.rerolls[rerollid]), operation)) {
          setOperationRerollState(operation, { ...state, rerollid })
        }
      }
      return
    }
    await regenerateFromCurrentTail(deps, operation)
  } finally {
    rerollOperationGuard.clear(operation.token)
  }
}

/** Generate a fresh reroll candidate from the currently selected tail. */
export async function newReroll(deps: RerollDeps): Promise<void> {
  const operation = beginRerollOperation()
  if (!operation) return
  try {
    resetRerollOnCharChange(operation.target)
    if (!isCurrentRerollOperation(operation)) return
    if (applyNextPrefetchedReroll(operation)) return
    await regenerateFromCurrentTail(deps, operation)
  } finally {
    rerollOperationGuard.clear(operation.token)
  }
}

export async function unReroll(): Promise<void> {
  const operation = beginRerollOperation()
  if (!operation) return
  try {
    resetRerollOnCharChange(operation.target)
    if (!isCurrentRerollOperation(operation)) return
    const genId = currentTailGenerationId()
    if (genId) {
      const r = PreUnreroll(genId)
      if (r) {
        applyTailDataSwap(r, operation)
        return
      }
    }
    const state = operationRerollState(operation)
    if (state.rerollid <= 0) {
      return
    }
    if (Array.isArray(state.rerolls[state.rerollid - 1])) {
      if (!isCurrentRerollOperation(operation)) return
      const rerollid = state.rerollid - 1
      if (applyTailSlice(safeStructuredClone(state.rerolls[rerollid]), operation)) {
        setOperationRerollState(operation, { ...state, rerollid })
      }
    }
  } finally {
    rerollOperationGuard.clear(operation.token)
  }
}

/** Select an existing candidate from the reroll list by absolute buffer index. */
export async function selectRerollCandidate(index: number): Promise<void> {
  const operation = beginRerollOperation()
  if (!operation) return
  try {
    resetRerollOnCharChange(operation.target)
    const state = operationRerollState(operation)
    if (!Number.isInteger(index) || index < 0 || index >= state.rerolls.length) return
    if (index === state.rerollid) return
    if (!isCurrentRerollOperation(operation)) return
    if (applyTailSlice(safeStructuredClone(state.rerolls[index]), operation)) {
      setOperationRerollState(operation, { ...state, rerollid: index })
    }
  } finally {
    rerollOperationGuard.clear(operation.token)
  }
}

/** The per-message id (stored, by historical misnomer, on `Message.chatId`). */
function candidateUid(message: Message | undefined): string | undefined {
  const uid = message?.chatId
  return typeof uid === 'string' && uid.trim() ? uid : undefined
}

function uniqueMessageIdAt(messages: readonly Message[], index: number): string | undefined {
  const id = candidateUid(messages[index])
  return id && messages.filter((message) => candidateUid(message) === id).length === 1 ? id : undefined
}

function hasStableUniqueMessageIds(messages: readonly Message[]): boolean {
  const ids = new Set<string>()
  for (const message of messages) {
    const id = candidateUid(message)
    if (!id || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

function stableOwnerId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Rebuild the swipe buffer from the chat's persisted reroll candidates (server
 * alternate rows) so rerolls survive a *reload*, not just a disconnect. Called on
 * active-chat hydration.
 *
 * The server buffers EVERY candidate of the live turn (Option X / the design
 * doc's "insert the new candidate as an alternate row and flip the active tail"),
 * so the active transcript tail is itself one of the candidates — matched back
 * here by `uid` and positioned as `rerollid`. A swipe then only repositions the
 * active tail (already durable as the persisted transcript); the buffer is never
 * rewritten by navigation. Order is informational only (the guarantee is "not
 * lost"); the server ships newest-added first, so we reverse for oldest-first.
 *
 * Reconciliation: when there are no persisted candidates we leave the live buffer
 * untouched (a fresh / already-cleared turn — a send/continue clears both sides at
 * the confirm boundary, so an empty `alternates` can never resurrect a buffer the
 * client just cleared).
 */
export function seedRerollBufferFromAlternates(
  activeMessages: unknown[],
  alternates: unknown[],
  target: ActiveChatTarget | null = currentRerollTarget(),
): void {
  if (!target) return
  if (!Array.isArray(alternates) || alternates.length === 0) return
  const activeTail = (activeMessages as Message[]).at(-1)
  if (!activeTail || activeTail.role === 'user') return

  const seen = new Set<string>()
  const candidates: Message[] = []
  // Server ships newest-added first → reverse to oldest-first for a natural swipe
  // order; dedup by uid (the buffer holds the active candidate too).
  for (const candidate of (alternates as Message[]).slice().reverse()) {
    const uid = candidateUid(candidate)
    if (!uid || seen.has(uid)) continue
    seen.add(uid)
    candidates.push(candidate)
  }
  if (candidates.length === 0) return

  // Position the active tail. It is normally already among the candidates (the
  // server buffers it) — swap in the live message (freshest content); otherwise
  // (legacy displaced-only rows) append it as the newest.
  const activeUid = candidateUid(activeTail)
  let activeIdx = activeUid ? candidates.findIndex((c) => candidateUid(c) === activeUid) : -1
  if (activeIdx === -1) {
    candidates.push(activeTail)
    activeIdx = candidates.length - 1
  } else {
    candidates[activeIdx] = activeTail
  }

  setRerollState(target, {
    rerolls: candidates.map((candidate) => [safeStructuredClone(candidate)]),
    rerollid: activeIdx,
  })
}

// ── test/observability accessors ────────────────────────────────────────────────
export function getRerollBuffer(target: ActiveChatTarget | null = currentRerollTarget()): Message[][] {
  return rerollState(target).rerolls
}
export function getRerollId(target: ActiveChatTarget | null = currentRerollTarget()): number {
  return rerollState(target).rerollid
}
export function getRerollCandidates(target: ActiveChatTarget | null = currentRerollTarget()): RerollCandidate[] {
  const state = rerollState(target)
  return state.rerolls.map((messages, index) => ({
    index,
    active: index === state.rerollid,
    messages,
  }))
}
export function resetRerollNavigation(): void {
  rerollStates.clear()
  clearPrererolls()
}
