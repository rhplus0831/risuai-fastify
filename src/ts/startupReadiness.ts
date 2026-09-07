import {
  STARTUP_TELEMETRY_MAX_ATTEMPTS,
  STARTUP_TELEMETRY_MAX_DURATION_MS,
  STARTUP_TELEMETRY_MILESTONES,
  type StartupAttemptSnapshot as ProtocolStartupAttemptSnapshot,
  type StartupCapability as ProtocolStartupCapability,
  type StartupCapabilityFailureSnapshot as ProtocolStartupCapabilityFailureSnapshot,
  type StartupCoordinatorSnapshot as ProtocolStartupCoordinatorSnapshot,
  type StartupReadinessSnapshot as ProtocolStartupReadinessSnapshot,
  type StartupRetryTarget as ProtocolStartupRetryTarget,
  type StartupStep as ProtocolStartupStep,
  type StartupTelemetryEvent,
  type StartupTelemetryFailureCode,
  type StartupTelemetryMilestone,
} from '@risuai/protocol/startup-telemetry'
import {
  canRenderClientReadView,
  canUseClientWriteAccess,
  clientSessionStore,
  demoteClientSession,
  isClientReadOnly,
  isClientSessionManaged,
  resetClientSessionForTests,
} from './clientSession'

export const STARTUP_MILESTONES = STARTUP_TELEMETRY_MILESTONES

export type StartupMilestone = StartupTelemetryMilestone

export const STARTUP_CAPABILITIES = [
  'canRenderShell',
  'canApplyRoutes',
  'canMutate',
  'pluginsReady',
  'canGenerate',
] as const

export type StartupCapability = ProtocolStartupCapability
export type StartupRetryTarget = ProtocolStartupRetryTarget
export type StartupStep = ProtocolStartupStep

export type StartupAttemptFailureCode = StartupTelemetryFailureCode

export type StartupAttemptSnapshot = ProtocolStartupAttemptSnapshot
export type StartupReadinessSnapshot = ProtocolStartupReadinessSnapshot
export type StartupCapabilityFailureSnapshot = ProtocolStartupCapabilityFailureSnapshot
export type StartupCoordinatorSnapshot = ProtocolStartupCoordinatorSnapshot

export const GENERATION_READINESS_BLOCKERS = [
  'writer-startup',
  'plugin-runtime',
  'generation-recovery',
  'chat-dependencies',
  'writer-capabilities-revoked',
] as const

export type GenerationReadinessBlocker = (typeof GENERATION_READINESS_BLOCKERS)[number]

export interface GenerationReadinessDiagnostic {
  ready: boolean
  blockers: GenerationReadinessBlocker[]
  phase: StartupMilestone | null
  failureCode?: StartupAttemptFailureCode
}

export interface StartupCoordinatorReadable {
  subscribe(run: (snapshot: StartupCoordinatorSnapshot) => void): () => void
}

export type StartupMilestoneRecordResult = 'duplicate' | 'pending' | 'transitioned'

const MARK_PREFIX = 'risu:startup:'
const MEASURE_PREFIX = 'risu:startup:entry-to-'

type StartupAttemptState = StartupAttemptSnapshot

const observedMilestoneTimes = new Map<StartupMilestone, number>()
const transitionTimes = new Map<StartupMilestone, number>()
const attempts: StartupAttemptState[] = []
const readinessListeners = new Set<() => void>()
const telemetryListeners = new Set<(event: Readonly<StartupTelemetryEvent>) => unknown>()
const capabilityFailures = new Map<StartupRetryTarget, StartupCapabilityFailureSnapshot>()
const completedStartupSteps = new Map<StartupStep, unknown>()
const inFlightStartupSteps = new Map<StartupStep, Promise<unknown>>()
const inFlightCapabilityRetries = new Map<StartupRetryTarget, Promise<unknown>>()
let nextAttemptId = 1
let observerShellEnabled = false
let writerCapabilitiesRevoked = false
let chatGenerationReady = false
let generationRecoveryReady = false
let pluginRuntimeCoherent = true

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : nowMs()
}

function currentMilestone(): StartupMilestone | null {
  for (let index = STARTUP_MILESTONES.length - 1; index >= 0; index -= 1) {
    const milestone = STARTUP_MILESTONES[index]
    if (transitionTimes.has(milestone)) return milestone
  }
  return null
}

function emitPerformanceEntries(milestone: StartupMilestone, atMs: number): void {
  const perf = globalThis.performance
  if (!perf?.mark) return

  const markName = `${MARK_PREFIX}${milestone}`
  try {
    perf.mark(markName, { startTime: atMs })
  } catch {
    perf.mark(markName)
  }

  if (milestone === 'entry' || !transitionTimes.has('entry') || !perf.measure) return
  const measureName = `${MEASURE_PREFIX}${milestone}`
  try {
    perf.measure(measureName, `${MARK_PREFIX}entry`, markName)
  } catch {
    // User Timing support must never affect startup behavior. The serializable
    // snapshot remains the source of truth when a browser rejects mark options.
  }
}

function notifyReadinessListeners(): void {
  for (const listener of readinessListeners) listener()
}

function emitStartupTelemetryEvent(event: StartupTelemetryEvent): void {
  for (const listener of telemetryListeners) {
    try {
      const result = listener(event)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => undefined)
      }
    } catch {
      // Measurement consumers must never change readiness state.
    }
  }
}

function boundedTelemetryDuration(durationMs: number): number {
  return Math.min(STARTUP_TELEMETRY_MAX_DURATION_MS, Math.max(0, durationMs))
}

function telemetryAttemptCount(): number {
  return Math.min(STARTUP_TELEMETRY_MAX_ATTEMPTS, attempts.length)
}

function hasTransitioned(milestone: StartupMilestone): boolean {
  return transitionTimes.has(milestone)
}

/**
 * Report whether optional startup work has settled without reintroducing a
 * global UI gate. This uses the semantic signal rather than the ordered public
 * phase so a localized earlier capability failure cannot keep bootstrap open.
 */
export function backgroundReady(): boolean {
  return observedMilestoneTimes.has('background-ready')
}

export function canRenderShell(): boolean {
  if (isClientSessionManaged()) return canRenderClientReadView()
  return hasTransitioned('writer-ready') || (observerShellEnabled && hasTransitioned('observer-ready'))
}

/** Configure the temporary Phase 6 observer rollout before startup publishes readiness. */
export function configureStartupObserverShell(enabled: boolean): void {
  if (observerShellEnabled === enabled) return
  observerShellEnabled = enabled
  clearReadyCapabilityFailures()
  notifyReadinessListeners()
}

export function canApplyRoutes(): boolean {
  if (isClientSessionManaged()) return canRenderClientReadView()
  return hasTransitioned('writer-ready') && !writerCapabilitiesRevoked
}

export function canMutate(): boolean {
  return hasTransitioned('writer-ready') && !writerCapabilitiesRevoked && canUseClientWriteAccess()
}

export function pluginsReady(): boolean {
  return hasTransitioned('plugins-ready') && pluginRuntimeCoherent
}

/** Keep capability selectors aligned with the live, reloadable plugin runtime. */
export function settleStartupPluginRuntimeReadiness(ready: boolean): void {
  if (pluginRuntimeCoherent === ready) return
  pluginRuntimeCoherent = ready
  clearReadyCapabilityFailures()
  notifyReadinessListeners()
}

export function canGenerate(): boolean {
  return (
    hasTransitioned('chat-ready') &&
    pluginsReady() &&
    generationRecoveryReady &&
    chatGenerationReady &&
    !writerCapabilitiesRevoked &&
    canUseClientWriteAccess()
  )
}

/** Privacy-safe reasons for a failed generation capability check. */
export function getGenerationReadinessDiagnostic(): GenerationReadinessDiagnostic {
  const blockers: GenerationReadinessBlocker[] = []
  if (!hasTransitioned('writer-ready')) blockers.push('writer-startup')
  if (!pluginsReady()) blockers.push('plugin-runtime')
  if (!generationRecoveryReady) blockers.push('generation-recovery')
  if (!hasTransitioned('chat-ready') || !chatGenerationReady) blockers.push('chat-dependencies')
  if (writerCapabilitiesRevoked || isClientReadOnly()) blockers.push('writer-capabilities-revoked')

  const failure = capabilityFailures.get('canGenerate') ?? capabilityFailures.get('pluginsReady')
  return {
    ready: blockers.length === 0,
    blockers,
    phase: currentMilestone(),
    ...(failure ? { failureCode: failure.failureCode } : {}),
  }
}

/** Generation recovery is a separate dependency from selected-chat hydration. */
export function settleStartupGenerationRecoveryReadiness(ready: boolean): void {
  if (generationRecoveryReady === ready) return
  generationRecoveryReady = ready
  clearReadyCapabilityFailures()
  notifyReadinessListeners()
}

/**
 * Publish that initial chat dependency evaluation settled. The milestone may
 * advance even when no route-selected chat exists, while canGenerate remains
 * false until every generation dependency is coherent.
 */
export function settleStartupChatReadiness(ready: boolean): void {
  const changed = chatGenerationReady !== ready
  chatGenerationReady = ready
  recordStartupMilestone('chat-ready')
  if (changed) {
    clearReadyCapabilityFailures()
    notifyReadinessListeners()
  }
}

/**
 * Revoke writer-owned capabilities synchronously when this tab loses writer
 * ownership. Milestones remain monotonic diagnostic history; a fresh page
 * startup is responsible for establishing a new writer session.
 */
export function revokeStartupWriterCapabilities(): void {
  demoteClientSession()
  if (writerCapabilitiesRevoked) return
  writerCapabilitiesRevoked = true
  notifyReadinessListeners()
}

/** Re-open writer capabilities only after an in-place recovery reinstalls every writer fence. */
export function restoreStartupWriterCapabilities(): void {
  if (!canUseClientWriteAccess()) return
  if (!writerCapabilitiesRevoked || !hasTransitioned('writer-ready')) return
  writerCapabilitiesRevoked = false
  clearReadyCapabilityFailures()
  notifyReadinessListeners()
}

function retryTargetReady(target: StartupRetryTarget): boolean {
  switch (target) {
    case 'canRenderShell':
      return canRenderShell()
    case 'canApplyRoutes':
      return canApplyRoutes()
    case 'canMutate':
      return canMutate()
    case 'pluginsReady':
      return pluginsReady()
    case 'canGenerate':
      return canGenerate()
    case 'backgroundReady':
      return backgroundReady()
  }
}

function clearReadyCapabilityFailures(): void {
  for (const target of capabilityFailures.keys()) {
    if (retryTargetReady(target)) capabilityFailures.delete(target)
  }
}

function failureTargetsForMilestone(milestone: StartupMilestone): StartupRetryTarget[] {
  switch (milestone) {
    case 'entry':
    case 'shell-mounted':
    case 'observer-ready':
      return ['canRenderShell']
    case 'writer-ready':
      return ['canApplyRoutes', 'canMutate', 'canGenerate']
    case 'plugins-ready':
      return ['pluginsReady', 'canGenerate']
    case 'chat-ready':
      return ['canGenerate']
    case 'background-ready':
      return ['backgroundReady']
  }
}

export function startupRetryTargetForMilestone(milestone: StartupMilestone): StartupRetryTarget {
  return failureTargetsForMilestone(milestone)[0]
}

function flushObservedMilestones(): boolean {
  let transitioned = false
  for (const milestone of STARTUP_MILESTONES) {
    if (transitionTimes.has(milestone)) continue
    const observedAtMs = observedMilestoneTimes.get(milestone)
    if (observedAtMs === undefined) break

    const previousMilestoneIndex = STARTUP_MILESTONES.indexOf(milestone) - 1
    const previousAtMs =
      previousMilestoneIndex >= 0 ? (transitionTimes.get(STARTUP_MILESTONES[previousMilestoneIndex]) ?? 0) : 0
    const transitionAtMs = Math.max(previousAtMs, observedAtMs)
    transitionTimes.set(milestone, transitionAtMs)
    emitPerformanceEntries(milestone, transitionAtMs)
    emitStartupTelemetryEvent({
      kind: 'phase-ready',
      milestone,
      entryDurationMs: boundedTelemetryDuration(transitionAtMs - (transitionTimes.get('entry') ?? transitionAtMs)),
      attemptCount: telemetryAttemptCount(),
      observerShellEnabled,
    })
    transitioned = true
  }
  if (transitioned) {
    clearReadyCapabilityFailures()
    notifyReadinessListeners()
  }
  return transitioned
}

/**
 * Record that one semantic startup milestone has become ready. Signals may
 * arrive out of order; publication waits for every earlier milestone so the
 * externally visible timeline is always monotonic. The first signal wins.
 */
export function recordStartupMilestone(
  milestone: StartupMilestone,
  observedAtMs = nowMs(),
): StartupMilestoneRecordResult {
  if (observedMilestoneTimes.has(milestone)) return 'duplicate'
  observedMilestoneTimes.set(milestone, finiteTime(observedAtMs))
  const transitioned = flushObservedMilestones()
  return transitionTimes.has(milestone) && transitioned ? 'transitioned' : 'pending'
}

export function beginStartupAttempt(startedAtMs = nowMs()): number {
  const attemptId = nextAttemptId
  nextAttemptId += 1
  attempts.push({ attemptId, startedAtMs: finiteTime(startedAtMs) })
  notifyReadinessListeners()
  return attemptId
}

export function completeStartupAttempt(attemptId: number, completedAtMs = nowMs()): void {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId)
  if (!attempt || attempt.completedAtMs !== undefined || attempt.failedAtMs !== undefined) return
  attempt.completedAtMs = Math.max(attempt.startedAtMs, finiteTime(completedAtMs))
  emitStartupTelemetryEvent({
    kind: 'attempt-completed',
    attemptDurationMs: boundedTelemetryDuration(attempt.completedAtMs - attempt.startedAtMs),
    attemptCount: telemetryAttemptCount(),
    observerShellEnabled,
  })
  notifyReadinessListeners()
}

export function failStartupAttempt(
  attemptId: number,
  failureCode: StartupAttemptFailureCode,
  failureMilestone: StartupMilestone,
  failedAtMs = nowMs(),
): void {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId)
  if (!attempt || attempt.completedAtMs !== undefined || attempt.failedAtMs !== undefined) return
  attempt.failedAtMs = Math.max(attempt.startedAtMs, finiteTime(failedAtMs))
  attempt.failureCode = failureCode
  attempt.failureMilestone = failureMilestone
  const failure: StartupCapabilityFailureSnapshot = {
    attemptId,
    failureCode,
    failureMilestone,
    failedAtMs: attempt.failedAtMs,
  }
  recordCapabilityFailureSnapshot(failure)
  emitStartupTelemetryEvent({
    kind: 'attempt-failed',
    attemptDurationMs: boundedTelemetryDuration(attempt.failedAtMs - attempt.startedAtMs),
    attemptCount: telemetryAttemptCount(),
    observerShellEnabled,
    failureCode,
    failureMilestone,
  })
  notifyReadinessListeners()
}

function recordCapabilityFailureSnapshot(failure: StartupCapabilityFailureSnapshot): void {
  for (const target of failureTargetsForMilestone(failure.failureMilestone)) {
    if (!retryTargetReady(target)) capabilityFailures.set(target, failure)
  }
}

/** Record a localized capability failure without failing unrelated startup work. */
export function recordStartupCapabilityFailure(
  attemptId: number,
  failureCode: StartupAttemptFailureCode,
  failureMilestone: StartupMilestone,
  failedAtMs = nowMs(),
): void {
  const failure = {
    attemptId,
    failureCode,
    failureMilestone,
    failedAtMs: finiteTime(failedAtMs),
  }
  recordCapabilityFailureSnapshot(failure)
  emitStartupTelemetryEvent({
    kind: 'diagnostic-failure',
    attemptCount: telemetryAttemptCount(),
    observerShellEnabled,
    failureCode,
    failureMilestone,
  })
  notifyReadinessListeners()
}

/** Subscribe a best-effort metadata sink. Listener failures are isolated from readiness. */
export function subscribeStartupTelemetryEvents(
  listener: (event: Readonly<StartupTelemetryEvent>) => unknown,
): () => void {
  telemetryListeners.add(listener)
  return () => telemetryListeners.delete(listener)
}

/**
 * Run one startup step at most once after it succeeds. Concurrent callers share
 * the same in-flight work, while a failed step remains retryable. This lets a
 * later startup attempt resume at the failed capability without replaying
 * already successful listeners, timers, or recovery work.
 */
export function runStartupStep<T>(step: StartupStep, operation: () => Promise<T> | T): Promise<T> {
  if (completedStartupSteps.has(step)) {
    return Promise.resolve(completedStartupSteps.get(step) as T)
  }
  const existing = inFlightStartupSteps.get(step)
  if (existing) return existing as Promise<T>

  const running = Promise.resolve()
    .then(operation)
    .then((value) => {
      completedStartupSteps.set(step, value)
      notifyReadinessListeners()
      return value
    })
    .finally(() => {
      inFlightStartupSteps.delete(step)
    })
  inFlightStartupSteps.set(step, running)
  return running
}

/**
 * Deduplicate a targeted retry. The operation resumes through runStartupStep(),
 * so already successful work remains cached even when an error occurred after
 * an earlier capability became ready.
 */
export function retryStartupCapability<T>(target: StartupRetryTarget, operation: () => Promise<T> | T): Promise<T> {
  const existing = inFlightCapabilityRetries.get(target)
  if (existing) return existing as Promise<T>

  const running = Promise.resolve()
    .then(operation)
    .finally(() => {
      inFlightCapabilityRetries.delete(target)
    })
  inFlightCapabilityRetries.set(target, running)
  return running
}

export function getStartupCoordinatorSnapshot(): StartupCoordinatorSnapshot {
  return {
    schemaVersion: 1,
    capabilities: {
      canRenderShell: canRenderShell(),
      canApplyRoutes: canApplyRoutes(),
      canMutate: canMutate(),
      pluginsReady: pluginsReady(),
      canGenerate: canGenerate(),
    },
    observerShellEnabled,
    writerCapabilitiesRevoked,
    failures: Object.fromEntries(
      [...capabilityFailures].map(([target, failure]) => [target, { ...failure }]),
    ) as Partial<Record<StartupRetryTarget, StartupCapabilityFailureSnapshot>>,
    completedSteps: [...completedStartupSteps.keys()],
  }
}

/** Svelte-compatible coordinator view for capability consumers. */
export const startupCoordinatorStore: StartupCoordinatorReadable = {
  subscribe(run) {
    const listener = () => run(getStartupCoordinatorSnapshot())
    readinessListeners.add(listener)
    listener()
    return () => readinessListeners.delete(listener)
  },
}

clientSessionStore.subscribe(() => {
  clearReadyCapabilityFailures()
  notifyReadinessListeners()
})

export function getStartupReadinessSnapshot(): StartupReadinessSnapshot {
  const timestamps = Object.fromEntries(transitionTimes) as Partial<Record<StartupMilestone, number>>
  const entryAtMs = timestamps.entry
  const durationsFromEntry = Object.fromEntries(
    [...transitionTimes].map(([milestone, atMs]) => [milestone, entryAtMs === undefined ? 0 : atMs - entryAtMs]),
  ) as Partial<Record<StartupMilestone, number>>

  return {
    schemaVersion: 1,
    phase: currentMilestone(),
    timestamps,
    durationsFromEntry,
    attempts: attempts.map((attempt) => ({ ...attempt })),
  }
}

export function waitForStartupMilestone(milestone: StartupMilestone, timeoutMs = 10_000): Promise<void> {
  if (transitionTimes.has(milestone)) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      readinessListeners.delete(onReadinessChange)
      reject(new Error(`Timed out waiting for startup milestone: ${milestone}`))
    }, timeoutMs)
    const onReadinessChange = () => {
      if (!transitionTimes.has(milestone)) return
      globalThis.clearTimeout(timeout)
      readinessListeners.delete(onReadinessChange)
      resolve()
    }
    readinessListeners.add(onReadinessChange)
  })
}

/** Test-only reset for the module singleton. */
export function resetStartupReadinessForTests(): void {
  observedMilestoneTimes.clear()
  transitionTimes.clear()
  attempts.length = 0
  readinessListeners.clear()
  capabilityFailures.clear()
  completedStartupSteps.clear()
  inFlightStartupSteps.clear()
  inFlightCapabilityRetries.clear()
  nextAttemptId = 1
  observerShellEnabled = false
  writerCapabilitiesRevoked = false
  chatGenerationReady = false
  generationRecoveryReady = false
  pluginRuntimeCoherent = true
  resetClientSessionForTests()

  const perf = globalThis.performance
  for (const milestone of STARTUP_MILESTONES) {
    perf?.clearMarks?.(`${MARK_PREFIX}${milestone}`)
    if (milestone !== 'entry') perf?.clearMeasures?.(`${MEASURE_PREFIX}${milestone}`)
  }
}
