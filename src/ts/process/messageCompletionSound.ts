import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  registerClientWriterLossHandler,
} from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import sendSound from '../../etc/send.mp3'
import type { Database } from '../storage/database.svelte'
import { settingsResourceState } from '../server/resourceState.svelte'

type CompletionAudioUnlockState = 'idle' | 'unlocking' | 'unlocked' | 'failed'

let completionAudioContext: AudioContext | null = null
let completionSoundBuffer: AudioBuffer | null = null
let completionSoundBufferPromise: Promise<AudioBuffer> | null = null
let activeCompletionSource: AudioBufferSourceNode | null = null
let activeFallbackElement: HTMLAudioElement | null = null
let activeFallbackEndedListener: (() => void) | null = null
let activeFallbackErrorListener: (() => void) | null = null
let completionAudioUnlockState: CompletionAudioUnlockState = 'idle'
let completionAudioUnlockInstalled = false
let completionAudioUnlockAttempt = 0
let stopWriterLossHandler: (() => void) | null = null
let latestPlaybackRequest = 0
let pendingPlaybackRequests = 0
let contextIdleTransition: Promise<void> | null = null
let warnedForNotAllowedError = false

const completionAudioUnlockListenerOptions: AddEventListenerOptions = {
  capture: true,
  passive: true,
}

type AudioContextConstructor = new () => AudioContext

function getAudioContextConstructor(): AudioContextConstructor | null {
  return typeof AudioContext === 'undefined' ? null : AudioContext
}

function displaySettingsOwner(): Partial<Database> | undefined {
  const status = settingsResourceState.groupStatuses.display ?? 'idle'
  if (status === 'ready') return settingsResourceState.value as Partial<Database>
  return undefined
}

function completionAudioIsEnabled(): boolean {
  const settings = displaySettingsOwner()
  return settings?.playMessage === true || settings?.playMessageOnTranslateEnd === true
}

function readPlaybackError(error: unknown): { name: string; message: string } {
  if (typeof error !== 'object' || error === null) {
    return { name: 'Error', message: String(error) }
  }

  const candidate = error as { message?: unknown; name?: unknown }
  return {
    name: typeof candidate.name === 'string' ? candidate.name : 'Error',
    message: typeof candidate.message === 'string' ? candidate.message : String(error),
  }
}

function warnForPlaybackFailure(error: unknown): void {
  const { name, message } = readPlaybackError(error)
  if (name === 'NotAllowedError') {
    if (warnedForNotAllowedError) return
    warnedForNotAllowedError = true
  }
  console.warn(`Completion ding playback failed (${name}): ${message}`)
}

function removeCompletionAudioUnlockListeners(): void {
  if (!completionAudioUnlockInstalled || typeof document === 'undefined') return
  completionAudioUnlockInstalled = false
  document.removeEventListener('pointerdown', unlockCompletionAudioContext, completionAudioUnlockListenerOptions)
  document.removeEventListener('keydown', unlockCompletionAudioContext, completionAudioUnlockListenerOptions)
}

function markCompletionAudioUnlockFailed(): void {
  completionAudioUnlockAttempt += 1
  completionAudioUnlockState = 'failed'
  installCompletionAudioUnlock()
}

function releaseCompletionSource(source: AudioBufferSourceNode): void {
  source.onended = null
  try {
    source.disconnect()
  } catch {
    // Some browsers throw when disconnecting an already-disconnected node.
  }
  if (activeCompletionSource === source) {
    activeCompletionSource = null
  }
}

function stopActiveCompletionSource(): void {
  const source = activeCompletionSource
  if (!source) return

  source.onended = null
  try {
    source.stop()
  } catch {
    // A source that already ended can throw when stopped again.
  } finally {
    releaseCompletionSource(source)
  }
}

function resetCompletionAudioContext(context: AudioContext): void {
  if (completionAudioContext !== context) return
  stopActiveCompletionSource()
  completionAudioContext = null
  completionSoundBuffer = null
  completionSoundBufferPromise = null
  contextIdleTransition = null
  markCompletionAudioUnlockFailed()
}

function closeFailedCompletionAudioContext(context: AudioContext): void {
  resetCompletionAudioContext(context)
  if (context.state === 'closed') return
  try {
    void context.close().catch(() => {})
  } catch {
    // Context cleanup is best effort after a failed idle suspension.
  }
}

function getOrCreateCompletionAudioContext(): AudioContext | null {
  const AudioContextClass = getAudioContextConstructor()
  if (!AudioContextClass) return null

  if (!completionAudioContext || completionAudioContext.state === 'closed') {
    completionAudioContext = new AudioContextClass()
    completionSoundBuffer = null
    completionSoundBufferPromise = null
    contextIdleTransition = null
    completionAudioUnlockState = 'idle'
  }
  return completionAudioContext
}

function requestContextResume(context: AudioContext): Promise<void> {
  if (context.state === 'running') return Promise.resolve()
  return Promise.resolve(context.resume())
}

async function loadCompletionSoundBuffer(context: AudioContext): Promise<AudioBuffer> {
  if (completionSoundBuffer) return completionSoundBuffer
  if (completionSoundBufferPromise) return completionSoundBufferPromise

  const loadPromise = (async () => {
    const response = await fetch(sendSound)
    if (!response.ok) {
      throw new Error(`Completion ding request failed with status ${response.status}`)
    }
    const buffer = await context.decodeAudioData(await response.arrayBuffer())
    if (completionAudioContext !== context) {
      throw new Error('Completion audio context changed while loading the ding')
    }
    completionSoundBuffer = buffer
    return buffer
  })()

  completionSoundBufferPromise = loadPromise
  try {
    return await loadPromise
  } catch (error) {
    if (completionSoundBufferPromise === loadPromise) {
      completionSoundBufferPromise = null
    }
    throw error
  }
}

function suspendCompletionAudioContextWhenIdle(context: AudioContext): Promise<void> {
  if (
    completionAudioContext !== context ||
    activeCompletionSource ||
    pendingPlaybackRequests > 0 ||
    context.state !== 'running'
  ) {
    return Promise.resolve()
  }
  if (contextIdleTransition) return contextIdleTransition

  let trackedTransition: Promise<void>
  trackedTransition = Promise.resolve(context.suspend()).finally(() => {
    if (contextIdleTransition === trackedTransition) {
      contextIdleTransition = null
    }
  })
  contextIdleTransition = trackedTransition
  return trackedTransition
}

function suspendCompletionAudioContextAfterPlayback(context: AudioContext): void {
  void suspendCompletionAudioContextWhenIdle(context).catch((error) => {
    closeFailedCompletionAudioContext(context)
    warnForPlaybackFailure(error)
  })
}

/** Unlock the shared Web Audio context from a relevant user activation without playing media. */
export function unlockCompletionAudioContext(): void {
  if (!completionAudioIsEnabled() || completionAudioUnlockState === 'unlocking') return
  if (completionAudioUnlockState === 'unlocked' && completionAudioContext?.state !== 'closed') return

  let context: AudioContext | null
  let resumePromise: Promise<void>
  try {
    context = getOrCreateCompletionAudioContext()
    if (!context) return

    completionAudioUnlockState = 'unlocking'
    resumePromise = requestContextResume(context)
  } catch (error) {
    markCompletionAudioUnlockFailed()
    warnForPlaybackFailure(error)
    return
  }

  const attempt = ++completionAudioUnlockAttempt
  const bufferPromise = loadCompletionSoundBuffer(context)
  void (async () => {
    try {
      await Promise.all([resumePromise, bufferPromise])
    } catch (error) {
      if (completionAudioContext !== context || completionAudioUnlockAttempt !== attempt) return
      try {
        await suspendCompletionAudioContextWhenIdle(context)
      } catch (suspendError) {
        closeFailedCompletionAudioContext(context)
        warnForPlaybackFailure(suspendError)
        return
      }
      markCompletionAudioUnlockFailed()
      warnForPlaybackFailure(error)
      return
    }

    try {
      await suspendCompletionAudioContextWhenIdle(context)
    } catch (error) {
      if (completionAudioContext !== context || completionAudioUnlockAttempt !== attempt) return
      closeFailedCompletionAudioContext(context)
      warnForPlaybackFailure(error)
      return
    }

    if (completionAudioContext !== context || completionAudioUnlockAttempt !== attempt) return
    completionAudioUnlockState = 'unlocked'
    removeCompletionAudioUnlockListeners()
  })()
}

/** Install durable user-gesture unlocking for the shared completion-audio context. */
export function installCompletionAudioUnlock(): void {
  if (completionAudioUnlockInstalled || typeof document === 'undefined') return
  completionAudioUnlockInstalled = true
  document.addEventListener('pointerdown', unlockCompletionAudioContext, completionAudioUnlockListenerOptions)
  document.addEventListener('keydown', unlockCompletionAudioContext, completionAudioUnlockListenerOptions)
}

function releaseFallbackElement(element: HTMLAudioElement): void {
  if (activeFallbackElement !== element) return
  activeFallbackElement = null
  if (activeFallbackEndedListener) {
    element.removeEventListener('ended', activeFallbackEndedListener)
    activeFallbackEndedListener = null
  }
  if (activeFallbackErrorListener) {
    element.removeEventListener('error', activeFallbackErrorListener)
    activeFallbackErrorListener = null
  }

  try {
    element.pause()
  } catch {
    // Playback may already have stopped or failed to initialize.
  }
  try {
    element.removeAttribute('src')
    element.load()
  } catch {
    // Unloading is best effort on older media implementations.
  }
}

function playFallbackCompletionDing(): void {
  if (typeof Audio === 'undefined') return

  if (activeFallbackElement) {
    releaseFallbackElement(activeFallbackElement)
  }

  let element: HTMLAudioElement | null = null
  try {
    element = new Audio(sendSound)
    activeFallbackElement = element
    element.preload = 'auto'
    element.currentTime = 0

    const release = () => releaseFallbackElement(element!)
    const fail = (error: unknown) => {
      if (activeFallbackElement !== element) return
      warnForPlaybackFailure(error)
      release()
    }
    const handleError = () => fail(new Error('HTML audio playback failed'))
    activeFallbackEndedListener = release
    activeFallbackErrorListener = handleError
    element.addEventListener('ended', release, { once: true })
    element.addEventListener('error', handleError, { once: true })

    const playPromise = element.play()
    if (playPromise) {
      void playPromise.catch(fail)
    }
  } catch (error) {
    if (element && activeFallbackElement === element) {
      releaseFallbackElement(element)
    }
    warnForPlaybackFailure(error)
  }
}

async function playWebAudioCompletionDing(context: AudioContext, request: number, operation: number): Promise<void> {
  pendingPlaybackRequests += 1
  try {
    const idleTransition = contextIdleTransition
    if (idleTransition) {
      await idleTransition
    }

    if (!isClientWriteOperationCurrent(operation)) return
    const resumePromise = requestContextResume(context)
    const bufferPromise = loadCompletionSoundBuffer(context)
    const [, buffer] = await Promise.all([resumePromise, bufferPromise])
    if (
      !isClientWriteOperationCurrent(operation) ||
      completionAudioContext !== context ||
      latestPlaybackRequest !== request
    )
      return

    stopActiveCompletionSource()
    if (latestPlaybackRequest !== request) return

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    activeCompletionSource = source
    source.onended = () => {
      releaseCompletionSource(source)
      suspendCompletionAudioContextAfterPlayback(context)
    }

    try {
      source.start()
    } catch (error) {
      releaseCompletionSource(source)
      throw error
    }

    completionAudioUnlockState = 'unlocked'
    removeCompletionAudioUnlockListeners()
  } catch (error) {
    if (isClientWriteOperationCurrent(operation) && latestPlaybackRequest === request) {
      markCompletionAudioUnlockFailed()
      warnForPlaybackFailure(error)
    }
  } finally {
    pendingPlaybackRequests -= 1
    if (!activeCompletionSource) {
      suspendCompletionAudioContextAfterPlayback(context)
    }
  }
}

/** Play the completion ding without applying a feature setting gate. */
export function playCompletionDing(): void {
  if (!canUseClientWriteAccess()) return
  const operation = captureClientSessionGeneration()
  stopWriterLossHandler?.()
  stopWriterLossHandler = registerClientWriterLossHandler(() => {
    latestPlaybackRequest += 1
    stopActiveCompletionSource()
    if (activeFallbackElement) releaseFallbackElement(activeFallbackElement)
    stopWriterLossHandler?.()
    stopWriterLossHandler = null
  })
  const AudioContextClass = getAudioContextConstructor()
  if (!AudioContextClass) {
    playFallbackCompletionDing()
    return
  }

  let context: AudioContext | null
  try {
    context = getOrCreateCompletionAudioContext()
  } catch (error) {
    markCompletionAudioUnlockFailed()
    warnForPlaybackFailure(error)
    return
  }
  if (!context) return

  if (activeFallbackElement) {
    releaseFallbackElement(activeFallbackElement)
  }
  const request = ++latestPlaybackRequest
  void playWebAudioCompletionDing(context, request, operation)
}

/** Play the user-configured ding for one successfully completed chat generation. */
export function playMessageCompletionSoundIfEnabled(): boolean {
  if (
    !canUseClientWriteAccess() ||
    displaySettingsOwner()?.playMessage !== true ||
    (getAudioContextConstructor() === null && typeof Audio === 'undefined')
  ) {
    return false
  }

  playCompletionDing()
  return true
}
