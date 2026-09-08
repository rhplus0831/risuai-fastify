import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import type { character, Chat } from '../storage/database.svelte'
import { safeStructuredClone } from '../safeStructuredClone'
import {
  captureBrowserDiagnosticsGeneration,
  isBrowserDiagnosticsGenerationCurrent,
  recordBrowserDiagnostic,
} from '../server/browserDiagnostics'

export type ChatOutputListenerArg = {
  char: character
  chat: Chat
  characterIndex: number
  chatIndex: number
  messageIndex: number
  /** Stable across durable generation-effect lease reclaim. */
  effectIdempotencyKey?: string
}

export type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>

export const chatOutputListeners = new Set<ChatOutputListener>()
let runtimeReady = () => true

export function setChatOutputRuntimeReadyPredicate(predicate: () => boolean): void {
  runtimeReady = predicate
}

export function isChatOutputRuntimeReady(): boolean {
  return runtimeReady()
}

export function addChatOutputListener(mode: string, listener: ChatOutputListener): void {
  if (mode !== 'output') throw new Error(`chat listener mode ${mode} not found`)
  chatOutputListeners.add(listener)
}

export function removeChatOutputListener(mode: string, listener: ChatOutputListener): void {
  if (mode !== 'output') throw new Error(`chat listener mode ${mode} not found`)
  chatOutputListeners.delete(listener)
}

export async function runChatOutputListeners(
  arg: ChatOutputListenerArg,
  context: { isCurrent?: () => boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const generation = captureClientSessionGeneration()
  const isCurrent = () =>
    isClientWriteOperationCurrent(generation) && !context.signal?.aborted && context.isCurrent?.() !== false
  if (!canUseClientWriteAccess() || !isCurrent() || !runtimeReady() || chatOutputListeners.size === 0) return

  const snapshot: ChatOutputListenerArg = {
    char: safeStructuredClone(arg.char),
    chat: safeStructuredClone(arg.chat),
    characterIndex: arg.characterIndex,
    chatIndex: arg.chatIndex,
    messageIndex: arg.messageIndex,
    ...(arg.effectIdempotencyKey ? { effectIdempotencyKey: arg.effectIdempotencyKey } : {}),
  }
  const diagnosticGeneration = captureBrowserDiagnosticsGeneration()
  const startedAt = performance.now()
  let runs = 0
  let failures = 0
  for (const listener of chatOutputListeners) {
    if (!isCurrent()) return
    runs = Math.min(1_000_000_000, runs + 1)
    try {
      await listener(snapshot)
      if (!isCurrent()) return
    } catch (error) {
      if (!isCurrent()) return
      failures = Math.min(1_000_000_000, failures + 1)
      console.error(error)
    }
  }
  try {
    if (runs === 0 || !isBrowserDiagnosticsGenerationCurrent(diagnosticGeneration)) return
    recordBrowserDiagnostic({
      category: 'script',
      level: failures > 0 ? 'warn' : 'info',
      runtime: 'plugin',
      hook: 'onOutput',
      runs,
      failures,
      durationMs: Math.min(86_400_000, Math.max(0, performance.now() - startedAt)),
      // Plugin callbacks can write through several APIs. Do not inspect their
      // arguments or claim that an unmeasured transcript/host call was unchanged.
      comparison: 'unavailable',
    })
  } catch {
    // Evidence cannot affect output effects or their durable acknowledgement.
  }
}
