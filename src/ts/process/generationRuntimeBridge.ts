type GenerationOperationsModule = typeof import('../server/generationOperations')
type ChatHydrationModule = typeof import('../server/chatMessageHydration.svelte')
type ServerChatModule = typeof import('./request/serverChat')
type GenerationProcessModule = typeof import('./index.svelte')
type RecoveredEffectsModule = typeof import('./recoveredGenerationEffects')

export type GenerationOperationsRuntime = Pick<
  GenerationOperationsModule,
  | 'applyGenerationOperationBootstrap'
  | 'generationOperationProjections'
  | 'generationOperationStreamForActiveJob'
  | 'isProtocolGenerationOperationJob'
  | 'readGenerationOperationStatus'
  | 'replayGenerationRecoveryObligations'
  | 'retireGenerationOperationViewers'
  | 'retryGenerationOperation'
  | 'stopGenerationOperation'
>

export type ChatHydrationRuntime = Pick<
  ChatHydrationModule,
  'acknowledgeMessageMutationLocalEffect' | 'hydrateChatMessages' | 'stopChatMessageHydration'
>

export type ServerChatRuntime = Pick<ServerChatModule, 'cancelServerChatGeneration' | 'retireGenerationJobViewers'>

export type GenerationProcessRuntime = Pick<
  GenerationProcessModule,
  'clearActiveGenerationAbortController' | 'createActiveGenerationAbortController' | 'sendChat'
>

export type RecoveredEffectsRuntime = Pick<
  RecoveredEffectsModule,
  'reconcilePendingRecoveredGenerationEffects' | 'setPendingRecoveredGenerationEffects'
>

let generationOperationsRuntime: GenerationOperationsRuntime | null = null
let chatHydrationRuntime: ChatHydrationRuntime | null = null
let serverChatRuntime: ServerChatRuntime | null = null
let generationProcessRuntime: GenerationProcessRuntime | null = null
let recoveredEffectsRuntime: RecoveredEffectsRuntime | null = null

function requiredRuntime<T>(runtime: T | null, name: string): T {
  if (!runtime) throw new Error(`${name} runtime is not registered`)
  return runtime
}

export function registerGenerationOperationsRuntime(runtime: GenerationOperationsRuntime): void {
  generationOperationsRuntime = runtime
}

export function getGenerationOperationsRuntime(): GenerationOperationsRuntime {
  return requiredRuntime(generationOperationsRuntime, 'Generation operations')
}

export function registerChatHydrationRuntime(runtime: ChatHydrationRuntime): void {
  chatHydrationRuntime = runtime
}

export function getChatHydrationRuntime(): ChatHydrationRuntime {
  return requiredRuntime(chatHydrationRuntime, 'Chat hydration')
}

export function registerServerChatRuntime(runtime: ServerChatRuntime): void {
  serverChatRuntime = runtime
}

export function getServerChatRuntime(): ServerChatRuntime {
  return requiredRuntime(serverChatRuntime, 'Server chat')
}

export function registerGenerationProcessRuntime(runtime: GenerationProcessRuntime): void {
  generationProcessRuntime = runtime
}

export function getGenerationProcessRuntime(): GenerationProcessRuntime {
  return requiredRuntime(generationProcessRuntime, 'Generation process')
}

export function registerRecoveredEffectsRuntime(runtime: RecoveredEffectsRuntime): void {
  recoveredEffectsRuntime = runtime
}

export function getRecoveredEffectsRuntime(): RecoveredEffectsRuntime {
  return requiredRuntime(recoveredEffectsRuntime, 'Recovered effects')
}

export function resetGenerationRuntimeBridgeForTests(): void {
  generationOperationsRuntime = null
  chatHydrationRuntime = null
  serverChatRuntime = null
  generationProcessRuntime = null
  recoveredEffectsRuntime = null
}
