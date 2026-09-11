export type GenerationRecoveryObligationKind = 'submit' | 'retry' | 'cancel'

export type GenerationRecoveryObligationPhase = 'dispatching' | 'uncertain' | 'awaiting_transcript'

export type GenerationRecoveryObligationToken = string

export interface GenerationRecoveryObligationInput {
  chatId?: string
  operationId?: string
  kind: GenerationRecoveryObligationKind
  sourceGeneration: number
  retryRequestId?: string
  minimumStateVersion?: number
}

export interface CapturedGenerationRecoveryObligation extends GenerationRecoveryObligationInput {
  readonly token: GenerationRecoveryObligationToken
  readonly scopeVersion: number
  readonly localVersion: number
  readonly phase: GenerationRecoveryObligationPhase
  readonly terminalAuthority?: GenerationRecoveryTerminalAuthority
}

export interface GenerationRecoveryTerminalAuthority {
  readonly operationId: string
  readonly state: string
  readonly stateVersion: number
  readonly projectionEpoch?: number
  readonly attemptNo?: number
  readonly jobId?: string
  readonly resultMessageId?: string
}

export interface GenerationRecoveryOperationEvidence {
  operationId: string
  chatId?: string
  state: string
  stateVersion: number
  projectionEpoch?: number
  desiredTerminalOutcome?: 'completed' | 'cancelled'
  resultMessageId?: string
  currentAttempt?: {
    retryRequestId: string
    attemptNo?: number
    jobId?: string
  }
}

export interface GenerationRecoveryJobEvidence {
  chatId: string
  operationId?: string
  operationStateVersion?: number
}

interface MutableGenerationRecoveryObligation extends GenerationRecoveryObligationInput {
  token: GenerationRecoveryObligationToken
  scopeVersion: number
  localVersion: number
  phase: GenerationRecoveryObligationPhase
  terminalAuthority?: GenerationRecoveryTerminalAuthority
}

const obligations = new Map<GenerationRecoveryObligationToken, MutableGenerationRecoveryObligation>()
let nextTokenSequence = 0
let nextLocalVersion = 0
let currentScopeVersion = 0

function optionalIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function nextToken(): GenerationRecoveryObligationToken {
  // Never reset this sequence: a callback holding a token from a cleared
  // ownership scope must not address an obligation created in a later scope.
  nextTokenSequence += 1
  return `generation-recovery-${nextTokenSequence}`
}

function nextVersion(): number {
  nextLocalVersion += 1
  return nextLocalVersion
}

function capture(obligation: MutableGenerationRecoveryObligation): CapturedGenerationRecoveryObligation {
  return Object.freeze({
    ...obligation,
    ...(obligation.terminalAuthority ? { terminalAuthority: Object.freeze({ ...obligation.terminalAuthority }) } : {}),
  })
}

/** Establish recovery ownership synchronously, immediately before dispatch. */
export function beginGenerationRecoveryObligation(
  input: GenerationRecoveryObligationInput,
): GenerationRecoveryObligationToken {
  if (!Number.isSafeInteger(input.sourceGeneration) || input.sourceGeneration < 0) {
    throw new TypeError('Invalid generation recovery source generation.')
  }
  if (
    input.minimumStateVersion !== undefined &&
    (!Number.isSafeInteger(input.minimumStateVersion) || input.minimumStateVersion < 0)
  ) {
    throw new TypeError('Invalid generation recovery minimum state version.')
  }
  const token = nextToken()
  obligations.set(token, {
    token,
    scopeVersion: currentScopeVersion,
    localVersion: nextVersion(),
    phase: 'dispatching',
    kind: input.kind,
    sourceGeneration: input.sourceGeneration,
    ...(optionalIdentity(input.chatId) ? { chatId: optionalIdentity(input.chatId) } : {}),
    ...(optionalIdentity(input.operationId) ? { operationId: optionalIdentity(input.operationId) } : {}),
    ...(optionalIdentity(input.retryRequestId) ? { retryRequestId: optionalIdentity(input.retryRequestId) } : {}),
    ...(input.minimumStateVersion !== undefined ? { minimumStateVersion: input.minimumStateVersion } : {}),
  })
  return token
}

/**
 * Record that dispatch may have reached the server. Updating the local version
 * prevents an authority snapshot captured before this transition from clearing
 * the newly ambiguous request.
 */
export function markGenerationRecoveryObligationUncertain(token: GenerationRecoveryObligationToken): void {
  const obligation = obligations.get(token)
  if (!obligation || obligation.phase === 'awaiting_transcript') return
  obligation.phase = 'uncertain'
  obligation.localVersion = nextVersion()
}

/**
 * Settle a dispatch response. Terminal authority transferred by
 * `applyGenerationRecoveryOperation` remains until strict transcript hydration.
 */
export function settleGenerationRecoveryObligation(token: GenerationRecoveryObligationToken): void {
  const obligation = obligations.get(token)
  if (!obligation || obligation.phase === 'awaiting_transcript') return
  obligations.delete(token)
}

export function captureGenerationRecoveryObligations(): readonly CapturedGenerationRecoveryObligation[] {
  return [...obligations.values()].map(capture)
}

export function captureGenerationRecoveryScope(): number {
  return currentScopeVersion
}

export function isGenerationRecoveryScopeCurrent(
  captured: number | Pick<CapturedGenerationRecoveryObligation, 'scopeVersion'>,
): boolean {
  return (typeof captured === 'number' ? captured : captured.scopeVersion) === currentScopeVersion
}

export function isGenerationRecoveryObligationCurrent(captured: CapturedGenerationRecoveryObligation): boolean {
  if (!isGenerationRecoveryScopeCurrent(captured)) return false
  const current = obligations.get(captured.token)
  return current?.localVersion === captured.localVersion && current.phase === captured.phase
}

export function settleCapturedGenerationRecoveryObligation(captured: CapturedGenerationRecoveryObligation): boolean {
  if (!isGenerationRecoveryScopeCurrent(captured)) return false
  const current = obligations.get(captured.token)
  if (
    !current ||
    current.localVersion !== captured.localVersion ||
    current.phase !== 'awaiting_transcript' ||
    captured.phase !== 'awaiting_transcript'
  ) {
    return false
  }
  obligations.delete(captured.token)
  return true
}

function operationIdentityMatches(
  obligation: MutableGenerationRecoveryObligation,
  operation: GenerationRecoveryOperationEvidence,
): boolean {
  if (!obligation.operationId || obligation.operationId !== operation.operationId) return false
  if (obligation.chatId && operation.chatId && obligation.chatId !== operation.chatId) return false
  if (operation.stateVersion < (obligation.minimumStateVersion ?? 0)) return false
  if (obligation.kind === 'retry') {
    return Boolean(obligation.retryRequestId && operation.currentAttempt?.retryRequestId === obligation.retryRequestId)
  }
  if (obligation.kind !== 'cancel') return true
  return (
    operation.state === 'cancel_requested' ||
    operation.state === 'stopping' ||
    operation.state === 'finalizing' ||
    operation.state === 'cancelled' ||
    operation.state === 'completed' ||
    operation.state === 'terminal_failed' ||
    operation.state === 'invalidated'
  )
}

function operationNeedsTranscriptHydration(operation: GenerationRecoveryOperationEvidence): boolean {
  return (
    operation.state === 'retryable' ||
    operation.state === 'abandoned' ||
    operation.state === 'completed' ||
    operation.state === 'cancelled' ||
    operation.state === 'terminal_failed' ||
    operation.state === 'invalidated'
  )
}

function terminalAuthority(operation: GenerationRecoveryOperationEvidence): GenerationRecoveryTerminalAuthority {
  return {
    operationId: operation.operationId,
    state: operation.state,
    stateVersion: operation.stateVersion,
    ...(operation.projectionEpoch !== undefined ? { projectionEpoch: operation.projectionEpoch } : {}),
    ...(operation.currentAttempt?.attemptNo !== undefined ? { attemptNo: operation.currentAttempt.attemptNo } : {}),
    ...(operation.currentAttempt?.jobId ? { jobId: operation.currentAttempt.jobId } : {}),
    ...(operation.resultMessageId ? { resultMessageId: operation.resultMessageId } : {}),
  }
}

function sameTerminalAuthority(
  left: GenerationRecoveryTerminalAuthority | undefined,
  right: GenerationRecoveryTerminalAuthority,
): boolean {
  return (
    left?.operationId === right.operationId &&
    left.state === right.state &&
    left.stateVersion === right.stateVersion &&
    left.projectionEpoch === right.projectionEpoch &&
    left.attemptNo === right.attemptNo &&
    left.jobId === right.jobId &&
    left.resultMessageId === right.resultMessageId
  )
}

/**
 * Apply an exact authoritative operation projection. Live authority consumes
 * the dispatch obligation; terminal authority transfers it to transcript
 * recovery so a response callback cannot clear it prematurely.
 */
export function applyGenerationRecoveryOperation(operation: GenerationRecoveryOperationEvidence): void {
  if (!operation.operationId || !Number.isSafeInteger(operation.stateVersion) || operation.stateVersion < 0) return
  for (const obligation of [...obligations.values()]) {
    if (!operationIdentityMatches(obligation, operation)) continue
    if (operationNeedsTranscriptHydration(operation) && (operation.chatId || obligation.chatId)) {
      const authority = terminalAuthority(operation)
      const authorityChanged = !sameTerminalAuthority(obligation.terminalAuthority, authority)
      if (obligation.phase !== 'awaiting_transcript' || authorityChanged) {
        obligation.localVersion = nextVersion()
      }
      obligation.phase = 'awaiting_transcript'
      obligation.terminalAuthority = authority
      if (!obligation.chatId && operation.chatId) obligation.chatId = operation.chatId
      continue
    }
    obligations.delete(obligation.token)
  }
}

/** A live job is sufficient authority only when it carries the exact protocol operation identity. */
export function applyGenerationRecoveryJob(job: GenerationRecoveryJobEvidence): void {
  if (!job.chatId) return
  for (const obligation of [...obligations.values()]) {
    if (obligation.kind !== 'submit' || obligation.phase === 'awaiting_transcript') continue
    if (!obligation.operationId || obligation.operationId !== job.operationId) continue
    if (obligation.chatId && obligation.chatId !== job.chatId) continue
    if (
      obligation.minimumStateVersion !== undefined &&
      (job.operationStateVersion === undefined || job.operationStateVersion < obligation.minimumStateVersion)
    )
      continue
    obligations.delete(obligation.token)
  }
}

export function hasGenerationRecoveryObligationsForTests(chatId?: string): boolean {
  return chatId ? [...obligations.values()].some((entry) => entry.chatId === chatId) : obligations.size > 0
}

/** Clear only when the durable database/writer ownership scope is replaced. */
export function resetGenerationRecoveryObligations(): void {
  currentScopeVersion += 1
  obligations.clear()
}
