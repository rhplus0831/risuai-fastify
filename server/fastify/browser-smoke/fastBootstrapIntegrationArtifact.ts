import fs from 'node:fs'
import path from 'node:path'
import {
  isStartupTelemetryEvent,
  STARTUP_TELEMETRY_MILESTONES,
  STARTUP_TELEMETRY_PROTOCOL_VERSION,
  type StartupCoordinatorSnapshot,
  type StartupReadinessSnapshot,
} from '@risuai/protocol/startup-telemetry'
import { routeKey } from '@risuai/shared-core/router-route'
import {
  directLinkBatches,
  directLinkCases,
  fastBootstrapDirectLinkBatchCount,
  requiredResourcePaths,
  resourceSurfacesForRoute,
} from './fastBootstrapDirectLinks.js'

export interface WorkspaceStartupCase {
  fixture: 'small' | 'large'
  startup: StartupReadinessSnapshot
  coordinator: StartupCoordinatorSnapshot
  earlyRequests: {
    mutationsBeforeWriterReady: number
    generationsBeforeChatReady: number
  }
  telemetry: BrowserStartupTelemetry[]
}

export interface BrowserStartupTelemetry {
  schemaVersion: number
  kind: string
  attemptCount: number
  milestone?: string
  entryDurationMs?: number
  attemptDurationMs?: number
  failureCode?: string
  failureMilestone?: string
  requestUid?: string
}

export interface DirectLinkCase {
  path: string
  requestedRouteKey: string
  finalRouteKey: string
  surfaces: string[]
  requiredPaths: string[]
  requestedPaths: string[]
}

export interface RecoveryJourney {
  scenario: 'event-gap' | 'response-lost-after-commit'
  initialRevision: number
  finalRevision: number
  retainedMutationId?: string
  commandAttempts: number
  receiptAcknowledgements: number
  resourceRefreshes: number
}

export interface WriterJourney {
  scenario: 'denial-then-takeover'
  readerCommandsBeforePromotion: number
  oldWriterCommandsAfterTakeover: number
  newWriterMutationAccepted: boolean
}

export interface OptionalRuntimeJourney {
  runtime: 'background-resources' | 'inlay-catalog'
  mode: 'failed' | 'slow'
  canRenderShell: boolean
  canMutate: boolean
  canGenerate: boolean
  localizedFailure: boolean
  retrySucceeded: boolean
}

export interface FastBootstrapRecoveryArtifact {
  schemaVersion: 1
  workspaceStartup: WorkspaceStartupCase[]
  recoveryJourneys: RecoveryJourney[]
  writerJourneys: WriterJourney[]
  optionalRuntimeJourneys: OptionalRuntimeJourney[]
}

export interface FastBootstrapIntegrationArtifact extends FastBootstrapRecoveryArtifact {
  runId: string
  directLinks: DirectLinkCase[]
}

export interface IndexedDirectLinkCase {
  caseIndex: number
  result: DirectLinkCase
}

export interface FastBootstrapDirectLinkBatchArtifact {
  schemaVersion: 1
  batchIndex: number
  batchCount: number
  totalCaseCount: number
  complete: boolean
  directLinks: IndexedDirectLinkCase[]
}

const finalJsonName = 'fast-bootstrap-integration.json'
const finalTextName = 'fast-bootstrap-integration.txt'
const recoveryPartialName = 'fast-bootstrap-integration.recovery.partial.json'
const directLinkPartialPattern = /^fast-bootstrap-integration\.direct-links-(\d+)-of-(\d+)\.partial\.json$/

export function fastBootstrapOutputDir(): string {
  return path.resolve('fast-bootstrap-results')
}

export function emptyFastBootstrapRecoveryArtifact(): FastBootstrapRecoveryArtifact {
  return {
    schemaVersion: 1,
    workspaceStartup: [],
    recoveryJourneys: [],
    writerJourneys: [],
    optionalRuntimeJourneys: [],
  }
}

export function resetFastBootstrapArtifactOutputs(outputDir = fastBootstrapOutputDir()): void {
  if (!fs.existsSync(outputDir)) return
  for (const name of fs.readdirSync(outputDir)) {
    if (
      name === finalJsonName ||
      name === finalTextName ||
      name === recoveryPartialName ||
      directLinkPartialPattern.test(name)
    ) {
      fs.unlinkSync(path.join(outputDir, name))
    }
  }
}

export function writeFastBootstrapRecoveryPartial(
  artifact: FastBootstrapRecoveryArtifact,
  outputDir = fastBootstrapOutputDir(),
  runId = process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID,
): string {
  requireRunId(runId)
  validateRecoveryArtifact(artifact)
  return writeJson(path.join(outputDir, recoveryPartialName), { ...artifact, runId })
}

export function writeFastBootstrapDirectLinkBatchPartial(
  artifact: FastBootstrapDirectLinkBatchArtifact,
  outputDir = fastBootstrapOutputDir(),
  runId = process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID,
): string {
  requireRunId(runId)
  validateDirectLinkBatchArtifact(artifact)
  const name = `fast-bootstrap-integration.direct-links-${artifact.batchIndex + 1}-of-${artifact.batchCount}.partial.json`
  return writeJson(path.join(outputDir, name), { ...artifact, runId })
}

export function mergeFastBootstrapArtifactOutputs({
  outputDir = fastBootstrapOutputDir(),
  required = false,
  runId = process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID,
}: {
  outputDir?: string
  required?: boolean
  runId?: string
} = {}): FastBootstrapIntegrationArtifact | null {
  // A previous successful merge must not survive an incomplete or malformed rerun.
  for (const name of [finalJsonName, finalTextName]) fs.rmSync(path.join(outputDir, name), { force: true })
  const recoveryPath = path.join(outputDir, recoveryPartialName)
  const batchPaths = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir)
        .filter((name) => directLinkPartialPattern.test(name))
        .sort()
        .map((name) => path.join(outputDir, name))
    : []

  if (!required && !fs.existsSync(recoveryPath) && batchPaths.length === 0) return null

  const issues: string[] = []
  if (!isNonemptyString(runId)) {
    if (required) requireRunId(runId)
    return null
  }
  let recovery = emptyFastBootstrapRecoveryArtifact()
  if (!fs.existsSync(recoveryPath)) issues.push(`missing ${recoveryPartialName}`)
  else {
    try {
      recovery = readRecoveryArtifact(recoveryPath, runId)
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }
  checkRecoveryCompleteness(recovery, issues)
  const batches: FastBootstrapDirectLinkBatchArtifact[] = []
  for (const batchPath of batchPaths) {
    try {
      batches.push(readDirectLinkBatchArtifact(batchPath, runId))
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }

  const byBatchIndex = new Map<number, FastBootstrapDirectLinkBatchArtifact>()
  for (const batch of batches) {
    if (byBatchIndex.has(batch.batchIndex)) issues.push(`duplicate direct-link batch ${batch.batchIndex + 1}`)
    else byBatchIndex.set(batch.batchIndex, batch)
  }
  for (let batchIndex = 0; batchIndex < fastBootstrapDirectLinkBatchCount; batchIndex += 1) {
    const batch = byBatchIndex.get(batchIndex)
    if (!batch) issues.push(`missing direct-link batch ${batchIndex + 1}/${fastBootstrapDirectLinkBatchCount}`)
    else if (!batch.complete)
      issues.push(`incomplete direct-link batch ${batchIndex + 1}/${fastBootstrapDirectLinkBatchCount}`)
  }

  const expectedCases = directLinkCases()
  const expectedBatches = directLinkBatches(expectedCases)
  const byCaseIndex = new Map<number, DirectLinkCase>()
  for (const batch of batches) {
    if (batch.batchCount !== fastBootstrapDirectLinkBatchCount) {
      issues.push(`direct-link batch ${batch.batchIndex + 1} reports batchCount=${batch.batchCount}`)
    }
    if (batch.totalCaseCount !== expectedCases.length) {
      issues.push(`direct-link batch ${batch.batchIndex + 1} reports totalCaseCount=${batch.totalCaseCount}`)
    }
    const expectedIndices = new Set(expectedBatches[batch.batchIndex]?.cases.map((entry) => entry.caseIndex))
    for (const entry of batch.directLinks) {
      if (!expectedCases[entry.caseIndex]) issues.push(`out-of-range direct-link case index ${entry.caseIndex}`)
      else if (!expectedIndices.has(entry.caseIndex)) {
        issues.push(`direct-link case index ${entry.caseIndex} belongs to a different batch`)
      }
      if (byCaseIndex.has(entry.caseIndex)) issues.push(`duplicate direct-link case index ${entry.caseIndex}`)
      else byCaseIndex.set(entry.caseIndex, entry.result)
    }
  }

  const directLinks: DirectLinkCase[] = []
  for (let caseIndex = 0; caseIndex < expectedCases.length; caseIndex += 1) {
    const result = byCaseIndex.get(caseIndex)
    if (!result) {
      issues.push(`missing direct-link case index ${caseIndex}`)
      continue
    }
    checkDirectLinkSemantics(result, expectedCases[caseIndex]!, caseIndex, issues)
    directLinks.push(result)
  }

  const artifact: FastBootstrapIntegrationArtifact = { ...recovery, runId, directLinks }
  if (issues.length > 0 && required) throw new Error(`Fast-bootstrap artifact merge failed: ${issues.join('; ')}`)
  if (issues.length > 0) return null
  writeFastBootstrapIntegrationArtifact(artifact, outputDir)
  return artifact
}

function writeFastBootstrapIntegrationArtifact(
  artifact: FastBootstrapIntegrationArtifact,
  outputDir = fastBootstrapOutputDir(),
): { json: string; text: string } {
  const json = `${JSON.stringify(artifact, null, 2)}\n`
  const text = formatIntegrationArtifact(artifact)
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(path.join(outputDir, finalJsonName), json)
  fs.writeFileSync(path.join(outputDir, finalTextName), text)
  return { json, text }
}

export function formatIntegrationArtifact(artifact: FastBootstrapIntegrationArtifact): string {
  const lines = [
    'Fast-bootstrap integration matrix',
    `run_id\t${artifact.runId}`,
    'fixture\treader_ms\twriter_ms\tbackground_ms',
  ]
  for (const entry of artifact.workspaceStartup) {
    lines.push(
      [
        entry.fixture,
        formatNumber(entry.startup.durationsFromEntry['reader-ready']),
        formatNumber(entry.startup.durationsFromEntry['writer-ready']),
        formatNumber(entry.startup.durationsFromEntry['background-ready']),
      ].join('\t'),
    )
  }
  lines.push('', 'Direct links', 'path\trequested_route_key\tfinal_route_key\tsurfaces\trequired_paths')
  for (const entry of artifact.directLinks) {
    lines.push(
      [
        entry.path,
        entry.requestedRouteKey,
        entry.finalRouteKey,
        entry.surfaces.join(','),
        entry.requiredPaths.join(','),
      ].join('\t'),
    )
  }
  lines.push(
    '',
    'Recovery',
    'scenario\tinitial_revision\tfinal_revision\tcommand_attempts\treceipt_acks\tresource_refreshes',
  )
  for (const entry of artifact.recoveryJourneys) {
    lines.push(
      [
        entry.scenario,
        entry.initialRevision,
        entry.finalRevision,
        entry.commandAttempts,
        entry.receiptAcknowledgements,
        entry.resourceRefreshes,
      ].join('\t'),
    )
  }
  lines.push('', 'Writer journeys', 'scenario\treader_commands_before_promotion\told_writer_commands\taccepted')
  for (const entry of artifact.writerJourneys) {
    lines.push(
      [
        entry.scenario,
        entry.readerCommandsBeforePromotion,
        entry.oldWriterCommandsAfterTakeover,
        entry.newWriterMutationAccepted,
      ].join('\t'),
    )
  }
  lines.push(
    '',
    'Optional runtimes',
    'runtime\tmode\tcan_render_shell\tcan_mutate\tcan_generate\tlocalized_failure\tretry_succeeded',
  )
  for (const entry of artifact.optionalRuntimeJourneys) {
    lines.push(
      [
        entry.runtime,
        entry.mode,
        entry.canRenderShell,
        entry.canMutate,
        entry.canGenerate,
        entry.localizedFailure,
        entry.retrySucceeded,
      ].join('\t'),
    )
  }
  return `${lines.join('\n')}\n`
}

function readRecoveryArtifact(file: string, runId: string): FastBootstrapRecoveryArtifact {
  const value = readJson(file)
  validateCurrentRun(value, runId, file)
  validateRecoveryArtifact(value)
  return value
}

function readDirectLinkBatchArtifact(file: string, runId: string): FastBootstrapDirectLinkBatchArtifact {
  const value = readJson(file)
  validateCurrentRun(value, runId, file)
  validateDirectLinkBatchArtifact(value)
  const name = `fast-bootstrap-integration.direct-links-${value.batchIndex + 1}-of-${value.batchCount}.partial.json`
  if (path.basename(file) !== name)
    throw new Error(`direct-link batch filename does not match payload: ${path.basename(file)}`)
  return value
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`could not read ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateRecoveryArtifact(value: unknown): asserts value is FastBootstrapRecoveryArtifact {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('invalid Fast-bootstrap recovery artifact schema')
  const validators = {
    workspaceStartup: isWorkspaceStartupCase,
    recoveryJourneys: isRecoveryJourney,
    writerJourneys: isWriterJourney,
    optionalRuntimeJourneys: isOptionalRuntimeJourney,
  }
  for (const [field, validEntry] of Object.entries(validators)) {
    if (!Array.isArray(value[field])) throw new Error(`invalid Fast-bootstrap recovery artifact field ${field}`)
    if (!value[field].every(validEntry)) throw new Error(`invalid Fast-bootstrap recovery artifact entry in ${field}`)
  }
}

function checkRecoveryCompleteness(artifact: FastBootstrapRecoveryArtifact, issues: string[]): void {
  const identities = [
    ['workspaceStartup', artifact.workspaceStartup.map((entry) => entry.fixture), ['small', 'large']],
    [
      'recoveryJourneys',
      artifact.recoveryJourneys.map((entry) => entry.scenario),
      ['event-gap', 'response-lost-after-commit'],
    ],
    ['writerJourneys', artifact.writerJourneys.map((entry) => entry.scenario), ['denial-then-takeover']],
    [
      'optionalRuntimeJourneys',
      artifact.optionalRuntimeJourneys.map((entry) => `${entry.runtime}/${entry.mode}`),
      ['background-resources/slow', 'background-resources/failed', 'inlay-catalog/slow', 'inlay-catalog/failed'],
    ],
  ] as const
  for (const [field, actual, expected] of identities) {
    if (!sameIdentities(actual, expected))
      issues.push(`incomplete or duplicate ${field} identities: expected ${expected.join(', ')}`)
  }
}

function checkDirectLinkSemantics(
  result: DirectLinkCase,
  definition: ReturnType<typeof directLinkCases>[number],
  caseIndex: number,
  issues: string[],
): void {
  const expected = {
    path: definition.path,
    requestedRouteKey: routeKey(definition.route),
    finalRouteKey: routeKey(definition.finalRoute ?? definition.route),
  }
  for (const field of ['path', 'requestedRouteKey', 'finalRouteKey'] as const) {
    if (result[field] !== expected[field]) issues.push(`direct-link case index ${caseIndex} has incorrect ${field}`)
  }
  if (!sameIdentities(result.surfaces, resourceSurfacesForRoute(definition.route))) {
    issues.push(`direct-link case index ${caseIndex} has incorrect surfaces`)
  }
  if (!sameIdentities(result.requiredPaths, requiredResourcePaths(definition.route))) {
    issues.push(`direct-link case index ${caseIndex} has incorrect requiredPaths`)
  }
  if (
    !['/api/v1/resources/shell', ...result.requiredPaths].every((requested) =>
      result.requestedPaths.includes(requested),
    )
  ) {
    issues.push(`direct-link case index ${caseIndex} is missing requestedPaths evidence`)
  }
}

function isWorkspaceStartupCase(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { startup, coordinator, earlyRequests, telemetry } = value
  if (
    (value.fixture !== 'small' && value.fixture !== 'large') ||
    !isRecord(startup) ||
    startup.schemaVersion !== 1 ||
    startup.phase !== 'background-ready' ||
    !isRecord(startup.timestamps) ||
    !isRecord(startup.durationsFromEntry) ||
    !STARTUP_TELEMETRY_MILESTONES.every(
      (milestone) =>
        isNonnegativeNumber((startup.timestamps as Record<string, unknown>)[milestone]) &&
        isNonnegativeNumber((startup.durationsFromEntry as Record<string, unknown>)[milestone]),
    ) ||
    (startup.timestamps['reader-ready'] as number) > (startup.timestamps['writer-ready'] as number) ||
    !Array.isArray(startup.attempts) ||
    startup.attempts.length === 0 ||
    !startup.attempts.every(
      (attempt) =>
        isRecord(attempt) &&
        isCount(attempt.attemptId) &&
        attempt.attemptId > 0 &&
        isNonnegativeNumber(attempt.startedAtMs) &&
        isNonnegativeNumber(attempt.completedAtMs) &&
        attempt.completedAtMs >= attempt.startedAtMs &&
        attempt.failedAtMs === undefined,
    ) ||
    !isRecord(coordinator) ||
    coordinator.schemaVersion !== 1 ||
    coordinator.writerCapabilitiesRevoked !== false ||
    !isRecord(coordinator.capabilities) ||
    coordinator.capabilities.canRenderShell !== true ||
    coordinator.capabilities.canApplyRoutes !== true ||
    coordinator.capabilities.canMutate !== true ||
    typeof coordinator.capabilities.pluginsReady !== 'boolean' ||
    typeof coordinator.capabilities.canGenerate !== 'boolean' ||
    !isRecord(coordinator.failures) ||
    !Object.values(coordinator.failures).every(
      (failure) =>
        isRecord(failure) &&
        isCount(failure.attemptId) &&
        isNonnegativeNumber(failure.failedAtMs) &&
        isStartupTelemetryEvent({
          kind: 'diagnostic-failure',
          attemptCount: failure.attemptId,
          failureCode: failure.failureCode,
          failureMilestone: failure.failureMilestone,
        }),
    ) ||
    !isStringArray(coordinator.completedSteps) ||
    coordinator.completedSteps.length === 0 ||
    !isRecord(earlyRequests) ||
    earlyRequests.mutationsBeforeWriterReady !== 0 ||
    earlyRequests.generationsBeforeChatReady !== 0 ||
    !Array.isArray(telemetry) ||
    !telemetry.every(isBrowserStartupTelemetry)
  )
    return false
  return (
    sameIdentities(
      telemetry.filter((entry) => entry.kind === 'phase-ready').map((entry) => entry.milestone),
      STARTUP_TELEMETRY_MILESTONES,
    ) && telemetry.filter((entry) => entry.kind === 'attempt-completed').length === 1
  )
}

function isBrowserStartupTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { schemaVersion, requestUid, ...event } = value
  return (
    schemaVersion === STARTUP_TELEMETRY_PROTOCOL_VERSION &&
    event.kind !== 'attempt-failed' &&
    (requestUid === undefined || isNonemptyString(requestUid)) &&
    isStartupTelemetryEvent(event)
  )
}

function isRecoveryJourney(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isCount(value.initialRevision) ||
    !isCount(value.finalRevision) ||
    value.finalRevision !== value.initialRevision + 1 ||
    !isCount(value.commandAttempts) ||
    !isCount(value.receiptAcknowledgements) ||
    !isCount(value.resourceRefreshes)
  )
    return false
  if (value.scenario === 'event-gap') {
    return value.commandAttempts === 1 && value.receiptAcknowledgements === 0 && value.resourceRefreshes >= 4
  }
  return (
    value.scenario === 'response-lost-after-commit' &&
    isNonemptyString(value.retainedMutationId) &&
    value.commandAttempts >= 2 &&
    value.receiptAcknowledgements === 1
  )
}

function isWriterJourney(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.scenario === 'denial-then-takeover' &&
    value.readerCommandsBeforePromotion === 0 &&
    value.oldWriterCommandsAfterTakeover === 0 &&
    value.newWriterMutationAccepted === true
  )
}

function isOptionalRuntimeJourney(value: unknown): boolean {
  if (
    !isRecord(value) ||
    (value.runtime !== 'background-resources' && value.runtime !== 'inlay-catalog') ||
    (value.mode !== 'slow' && value.mode !== 'failed')
  )
    return false
  return (
    value.canRenderShell === true &&
    value.canMutate === true &&
    typeof value.canGenerate === 'boolean' &&
    (value.runtime !== 'background-resources' || value.canGenerate) &&
    value.localizedFailure === (value.mode === 'failed') &&
    value.retrySucceeded === (value.runtime === 'inlay-catalog' || value.mode === 'slow')
  )
}

function sameIdentities(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((identity) => actual.includes(identity))
  )
}

function requireRunId(runId: unknown): asserts runId is string {
  if (!isNonemptyString(runId)) throw new Error('missing current Fast-bootstrap artifact run ID')
}

function validateCurrentRun(value: unknown, runId: string, file: string): void {
  if (!isRecord(value) || value.runId !== runId) {
    throw new Error(`stale or missing run ID in ${path.basename(file)}`)
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isCount(value: unknown): value is number {
  return isNonnegativeNumber(value) && Number.isSafeInteger(value)
}

function validateDirectLinkBatchArtifact(value: unknown): asserts value is FastBootstrapDirectLinkBatchArtifact {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error('invalid Fast-bootstrap direct-link artifact schema')
  if (!Number.isInteger(value.batchIndex) || (value.batchIndex as number) < 0) {
    throw new Error('invalid Fast-bootstrap direct-link artifact field batchIndex')
  }
  for (const field of ['batchCount', 'totalCaseCount']) {
    if (!Number.isInteger(value[field]) || (value[field] as number) < 1) {
      throw new Error(`invalid Fast-bootstrap direct-link artifact field ${field}`)
    }
  }
  if ((value.batchIndex as number) >= (value.batchCount as number)) {
    throw new Error('invalid Fast-bootstrap direct-link artifact batch index')
  }
  if (typeof value.complete !== 'boolean' || !Array.isArray(value.directLinks)) {
    throw new Error('invalid Fast-bootstrap direct-link artifact payload')
  }
  for (const entry of value.directLinks) {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.caseIndex) ||
      (entry.caseIndex as number) < 0 ||
      !isDirectLinkCase(entry.result)
    ) {
      throw new Error('invalid Fast-bootstrap direct-link artifact entry')
    }
  }
}

function isDirectLinkCase(value: unknown): value is DirectLinkCase {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.requestedRouteKey === 'string' &&
    typeof value.finalRouteKey === 'string' &&
    isStringArray(value.surfaces) &&
    isStringArray(value.requiredPaths) &&
    isStringArray(value.requestedPaths)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function writeJson(file: string, value: unknown): string {
  const output = `${JSON.stringify(value, null, 2)}\n`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, output)
  return output
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? '' : value.toFixed(2)
}
