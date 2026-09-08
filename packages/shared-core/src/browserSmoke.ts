import type { AppRoute } from './routerRoute.js'

export interface BrowserSmokeChatSnapshot {
  generationSettings?: {
    configured?: boolean
    promptPresetId?: string
    sidebarToggles?: Record<string, string>
  }
  id?: string
  message?: unknown[]
  translatorPresetId?: string | null
}

export interface BrowserSmokeCharacterSnapshot {
  chaId: string
  chats: BrowserSmokeChatSnapshot[]
  chatPage: number
  desc?: string
  firstMessage: string
  name: string
}

/** The browser-smoke consumer projection, not the application's database owner. */
export interface BrowserSmokeDatabaseSnapshot {
  characters: BrowserSmokeCharacterSnapshot[]
  language?: string
  showMemoryLimit?: boolean
  streamGeminiThoughts?: boolean
}

export interface BrowserSmokeRouteResourceLoadState {
  error: string | null
  errorKind?: 'component'
  offline?: boolean
  routeKey: string | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export type BrowserSmokeCommandResult =
  | { status: 'ok'; revision: number; event: unknown }
  | { status: 'conflict'; currentRevision: number }
  | { status: 'error'; error: string; reason?: string }
  | { status: 'unavailable' }

export interface FastifyBrowserSmokeLifecycleSnapshot {
  acceptedSendRecoveries: unknown[]
  activeGenerationJobs: unknown[]
  activeChatGenerations: unknown[]
  generationFinalizations: unknown[]
  generationJobLifecycles: Record<string, unknown>
  generationOperationCancellations: unknown[]
  generationOperations: unknown[]
  receiptAcknowledgements: Array<{
    mutationId: string
    requestCount: number
    databaseLineage: string
  }>
  outbox: Array<{
    key: string
    mutationId: string
    phase: string
    kind?: string
    requests: unknown[]
  }>
}

/** Read-only authority evidence captured by multi-session browser journeys. */
export interface BrowserSmokeClientSessionSnapshot {
  managed: boolean
  lifecycle: 'resolving' | 'reading' | 'promoting' | 'recovering-writer' | 'writing' | 'auth-required'
  connection: 'connecting' | 'live' | 'interrupted'
  generation: number
  sessionId: string | null
  databaseLineage: string | null
  writer: { sessionId: string | null; epoch: number } | null
  authenticated: boolean
  projectionReady: boolean
  recoveryAuthorized: boolean
}

export interface FastifyBrowserSmokeHook<
  StartupCoordinatorSnapshot,
  StartupReadinessSnapshot,
  StartupMilestone extends string,
> {
  activeWriterHeaders: () => Promise<Record<string, string>>
  clearResourceCache: () => Promise<void>
  getAppliedServerResourceRevision: () => number | null
  getPendingResourceCacheWriteCount: () => number
  getDatabaseSnapshot: () => BrowserSmokeDatabaseSnapshot
  getCurrentRoute: () => AppRoute
  getClientSessionSnapshot: () => BrowserSmokeClientSessionSnapshot
  getLifecycleSnapshot: () => Promise<FastifyBrowserSmokeLifecycleSnapshot>
  getRouteResourceLoadState: () => BrowserSmokeRouteResourceLoadState
  getStartupCoordinatorSnapshot: () => StartupCoordinatorSnapshot
  getGenerationReadinessDiagnostic: () => {
    ready: boolean
    blockers: string[]
    phase: StartupMilestone | null
    failureCode?: string
  }
  getStartupChatReadinessEvaluations: () => Array<{
    evaluationId: number
    sessionGeneration: number
    target: string
    phase: string
  }>
  getStartupSnapshot: () => StartupReadinessSnapshot
  isLoaded: () => boolean
  patchRuntimeSettings: (patch: Record<string, unknown>) => Promise<BrowserSmokeCommandResult>
  waitForLoaded: (timeoutMs?: number) => Promise<void>
  waitForStartupMilestone: (milestone: StartupMilestone, timeoutMs?: number) => Promise<void>
  selectCharacter: (index: number) => void
  getRerollCandidates: () => string[]
  swipeRerollBack: () => Promise<void>
  showAlert: (message: string) => void
  navigateTo: (path: string) => void
  setQuickSettingsOpen: (open: boolean) => void
  getReadingBoundarySnapshot: () => {
    selectedCharacterIndex: number
    currentCharacterIndex: number | undefined
    chatPages: Array<{ characterId: string; chatPage: number }>
    quickSettingsOpen: boolean
    customGuiSettingsOpen: boolean
    variableReload: number
    alert: unknown
  }
  restoreRestrictedOverlays: () => void
  probeInteractiveScriptAction: (input: {
    characterId: string
    chatId: string
    kind: 'trigger' | 'lua'
    name: string
  }) => Promise<{ triggerCount: number; sourceUnchanged: boolean; error: string | null }>
}
