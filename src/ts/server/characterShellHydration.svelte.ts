import { get } from 'svelte/store'
import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { selectedCharID } from '../stores.svelte'
import { isServerCharacterShell } from '../storage/database.svelte'
import { hydrateActiveCharacterLorebook, hydrateActiveChat } from './chatMessageHydration.svelte'
import { peekCachedServerCommandRevision } from './commands'
import { fetchServerCharacter } from './resourceReads'
import { charactersResourceState, applyCharacterResource, getCharacterResourceOwner } from './resourceState.svelte'

export const CHARACTER_SHELL_HYDRATION_TIMEOUT_MS = 15_000

export type CharacterShellHydrationStatus = 'idle' | 'loading' | 'ready' | 'error'
export type CharacterShellHydrationError = 'timeout' | 'unavailable' | 'invalid-response'

export interface CharacterShellHydrationRowState {
  status: CharacterShellHydrationStatus
  error: CharacterShellHydrationError | null
}

export interface CharacterShellHydrationOptions {
  signal?: AbortSignal | null
  supersede?: boolean
  timeoutMs?: number
  minimumRevision?: number
}

interface InFlightCharacterHydration {
  controller: AbortController
  promise: Promise<boolean>
  subscribers: Set<{ selectionFence?: SelectedCharacterHydrationFence }>
  minimumRevision: number
  settled: boolean
  target: unknown
}

interface SelectedCharacterHydrationFence {
  selectedIndex: number
  selectionRevision: number | null
}

export const characterShellHydrationState = $state<{
  rows: Record<string, CharacterShellHydrationRowState>
}>({ rows: {} })

const inFlight = new Map<string, InFlightCharacterHydration>()
let stopSelectionSubscription: (() => void) | null = null
let selectedRequestAbort: AbortController | null = null
let shellHydrationGeneration = 0

export function startSelectedCharacterShellHydration(): void {
  if (stopSelectionSubscription) return
  stopSelectionSubscription = selectedCharID.subscribe(() => {
    selectedRequestAbort?.abort()
    selectedRequestAbort = new AbortController()
    void hydrateSelectedCharacterShell({ signal: selectedRequestAbort.signal })
  })
}

export function stopSelectedCharacterShellHydration(): void {
  stopSelectionSubscription?.()
  stopSelectionSubscription = null
  selectedRequestAbort?.abort()
  selectedRequestAbort = null
  for (const request of inFlight.values()) request.controller.abort()
  shellHydrationGeneration += 1
  inFlight.clear()
}

export async function hydrateSelectedCharacterShell(options: CharacterShellHydrationOptions = {}): Promise<boolean> {
  const index = get(selectedCharID)
  if (index < 0) return false
  const character = charactersResourceState.characters[index]
  if (!character) return false
  if (!isServerCharacterShell(character)) return true
  const characterId = character?.chaId
  if (typeof characterId !== 'string' || characterId.trim() === '') return false
  if (getCharacterResourceOwner(characterId) !== character) return false
  return hydrateCharacterShell(characterId, options, {
    selectedIndex: index,
    selectionRevision: charactersResourceState.selectionRevision,
  })
}

export async function hydrateCharacterShell(
  characterId: string,
  options: CharacterShellHydrationOptions = {},
  selectionFence?: SelectedCharacterHydrationFence,
): Promise<boolean> {
  const existing = getCharacterResourceOwner(characterId)
  if (!isServerCharacterShell(existing)) return !!existing
  if (options.signal?.aborted) return false

  const current = inFlight.get(characterId)
  const baselineRevision = Math.max(peekCachedServerCommandRevision() ?? 0, options.minimumRevision ?? 0)
  if (
    current &&
    current.target === existing &&
    !options.supersede &&
    !current.controller.signal.aborted &&
    current.minimumRevision >= baselineRevision
  ) {
    return subscribeToCharacterHydration(characterId, current, options.signal, selectionFence)
  }
  if (current) {
    current.controller.abort()
    inFlight.delete(characterId)
  }

  const generation = shellHydrationGeneration
  const writerGeneration = canUseClientWriteAccess() ? captureClientSessionGeneration() : null
  const targetShell = existing
  const controller = new AbortController()
  const shared: InFlightCharacterHydration = {
    controller,
    promise: null!,
    subscribers: new Set(),
    minimumRevision: baselineRevision,
    settled: false,
    target: existing,
  }
  const targetHasSubscriber = () =>
    [...shared.subscribers].some((subscriber) =>
      targetStillMatches(characterId, targetShell, subscriber.selectionFence),
    )
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  setCharacterShellHydrationState(characterId, 'loading', null)
  const request = (async () => {
    let result: Awaited<ReturnType<typeof fetchServerCharacter>>
    let stopWaitingForAbort = () => {}
    try {
      // Authentication and other subordinate reads may ignore transport abort.
      // Retire this attempt without making Retry wait for their completion.
      const cancelled = new Promise<Awaited<ReturnType<typeof fetchServerCharacter>>>((resolve) => {
        const abort = () => resolve({ status: 'unavailable' })
        controller.signal.addEventListener('abort', abort, { once: true })
        stopWaitingForAbort = () => controller.signal.removeEventListener('abort', abort)
        if (controller.signal.aborted) abort()
      })
      result = await Promise.race([fetchServerCharacter(characterId, controller.signal), cancelled])
    } catch (error) {
      if (generation === shellHydrationGeneration && !controller.signal.aborted) {
        if (targetHasSubscriber()) {
          setCharacterShellHydrationState(characterId, 'error', 'unavailable')
        }
        shellHydrationWarning(characterId, error instanceof Error ? error.message : String(error))
      }
      return false
    } finally {
      stopWaitingForAbort()
    }
    if (generation !== shellHydrationGeneration || controller.signal.aborted) {
      if (timedOut && targetHasSubscriber()) {
        setCharacterShellHydrationState(characterId, 'error', 'timeout')
        shellHydrationWarning(characterId, 'request timed out')
      }
      return false
    }
    if (result.status !== 'ok') {
      const error = result.status === 'unavailable' ? 'unavailable' : 'invalid-response'
      if (targetHasSubscriber()) {
        setCharacterShellHydrationState(characterId, 'error', error)
      }
      shellHydrationWarning(characterId, result.status === 'error' ? result.error : 'server resource read unavailable')
      return false
    }
    if (isOlderThanRevision(result.revision, baselineRevision)) {
      if (targetStillMatches(characterId, targetShell)) {
        setCharacterShellHydrationState(characterId, 'error', 'invalid-response')
      }
      return false
    }
    if (!targetHasSubscriber()) {
      return false
    }

    const applied = applyCharacterResource(result)
    if (!applied) {
      if (targetHasSubscriber()) {
        setCharacterShellHydrationState(characterId, 'error', 'invalid-response')
      }
      return false
    }
    setCharacterShellHydrationState(characterId, 'ready', null)
    if (writerGeneration !== null && isClientWriteOperationCurrent(writerGeneration)) {
      void hydrateActiveChat()
      void hydrateActiveCharacterLorebook()
    }
    return true
  })().finally(() => {
    shared.settled = true
    clearTimeout(timeout)
    if (inFlight.get(characterId)?.promise === request) {
      inFlight.delete(characterId)
    }
  })

  shared.promise = request
  inFlight.set(characterId, shared)
  return subscribeToCharacterHydration(characterId, shared, options.signal, selectionFence)
}

function subscribeToCharacterHydration(
  characterId: string,
  shared: InFlightCharacterHydration,
  signal?: AbortSignal | null,
  selectionFence?: SelectedCharacterHydrationFence,
): Promise<boolean> {
  const subscriber = { selectionFence }
  shared.subscribers.add(subscriber)
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (complete: () => void) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      shared.subscribers.delete(subscriber)
      if (!shared.settled && shared.subscribers.size === 0) {
        if (inFlight.get(characterId) === shared) inFlight.delete(characterId)
        shared.controller.abort()
      }
      complete()
    }
    const abort = () => finish(() => resolve(false))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    shared.promise.then(
      (result) =>
        finish(() => resolve(result && (!selectionFence || selectedTargetStillMatches(characterId, selectionFence)))),
      (error) => finish(() => reject(error)),
    )
  })
}

export function retryCharacterShellHydration(characterId: string): Promise<boolean> {
  return hydrateCharacterShell(characterId, { supersede: true })
}

export function resetCharacterShellHydrationStateForTests(): void {
  clearCharacterShellHydrationState()
}

/** Abort and forget optional detail reads whose auth/lineage scope is obsolete. */
export function clearCharacterShellHydrationState(): void {
  stopSelectedCharacterShellHydration()
  characterShellHydrationState.rows = {}
}

function isOlderThanRevision(revision: number, comparisonRevision: number | null): boolean {
  return comparisonRevision !== null && revision < comparisonRevision
}

function targetStillMatches(
  characterId: string,
  targetShell: unknown,
  selectionFence?: SelectedCharacterHydrationFence,
): boolean {
  const currentTarget = getCharacterResourceOwner(characterId)
  // Chat-message and lorebook hydration intentionally mutate nested body fields
  // on the same shell while this row request is in flight. Preserve those
  // independently fenced writes, but reject any actual row replacement.
  if (!isServerCharacterShell(currentTarget) || currentTarget !== targetShell) return false
  if (!selectionFence) return true
  return selectedTargetStillMatches(characterId, selectionFence)
}

function selectedTargetStillMatches(characterId: string, selectionFence: SelectedCharacterHydrationFence): boolean {
  const currentTarget = getCharacterResourceOwner(characterId)
  if (!currentTarget) return false
  return (
    get(selectedCharID) === selectionFence.selectedIndex &&
    charactersResourceState.currentChar === selectionFence.selectedIndex &&
    charactersResourceState.selectionRevision === selectionFence.selectionRevision &&
    charactersResourceState.characters[selectionFence.selectedIndex] === currentTarget
  )
}

function normalizedTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : CHARACTER_SHELL_HYDRATION_TIMEOUT_MS
}

function setCharacterShellHydrationState(
  characterId: string,
  status: CharacterShellHydrationStatus,
  error: CharacterShellHydrationError | null,
): void {
  characterShellHydrationState.rows[characterId] = { status, error }
}

function shellHydrationWarning(characterId: string, message: string): void {
  console.warn(`character ${characterId} hydration failed: ${message}`)
}
