import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routeKey } from '@risuai/shared-core/router-route'
import {
  directLinkBatches,
  directLinkCases,
  requiredResourcePaths,
  resourceSurfacesForRoute,
} from '../browser-smoke/fastBootstrapDirectLinks.js'
import globalSetup from '../browser-smoke/globalSetup.js'
import {
  emptyFastBootstrapRecoveryArtifact,
  mergeFastBootstrapArtifactOutputs,
  resetFastBootstrapArtifactOutputs,
  writeFastBootstrapDirectLinkBatchPartial,
  writeFastBootstrapRecoveryPartial,
  type FastBootstrapDirectLinkBatchArtifact,
  type FastBootstrapRecoveryArtifact,
  type RolloutStartupCase,
} from '../browser-smoke/fastBootstrapIntegrationArtifact.js'

const temporaryDirectories: string[] = []
const currentRunId = 'current-playwright-invocation'
const recoveryName = 'fast-bootstrap-integration.recovery.partial.json'
const finalNames = ['fast-bootstrap-integration.json', 'fast-bootstrap-integration.txt']

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Fast-bootstrap integration artifact merge', () => {
  it('merges the complete current-run matrix in manifest order with redirect semantics', () => {
    const outputDir = writeCompleteMatrix()
    const merged = mergeFastBootstrapArtifactOutputs({ outputDir, required: true, runId: currentRunId })

    expect(merged?.runId).toBe(currentRunId)
    expect(merged?.startupRollout).toHaveLength(4)
    expect(merged?.recoveryJourneys).toHaveLength(3)
    expect(merged?.writerJourneys).toHaveLength(1)
    expect(merged?.optionalRuntimeJourneys).toHaveLength(4)
    expect(merged?.directLinks.map((entry) => entry.path)).toEqual(directLinkCases().map((entry) => entry.path))
    expect(merged?.directLinks.find((entry) => entry.path === '/fast-bootstrap-not-found')).toMatchObject({
      requestedRouteKey: 'not-found',
      finalRouteKey: 'home',
    })
    expect(merged?.directLinks.find((entry) => entry.path === '/playground/inlays')).toMatchObject({
      requestedRouteKey: 'playground:14',
      finalRouteKey: 'inlay',
    })
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, finalNames[0]!), 'utf8'))).toEqual(merged)
    expect(fs.readFileSync(path.join(outputDir, finalNames[1]!), 'utf8')).toContain(
      'Direct links\npath\trequested_route_key',
    )
    expect(fs.readFileSync(path.join(outputDir, finalNames[1]!), 'utf8')).toContain(`run_id\t${currentRunId}`)
  })

  it('does not promote empty recovery evidence to a required final artifact', () => {
    const outputDir = writeCompleteMatrix()
    writeFastBootstrapRecoveryPartial(emptyFastBootstrapRecoveryArtifact(), outputDir, currentRunId)
    expectRequiredFailure(outputDir, 'incomplete or duplicate startupRollout identities')
    expect(fs.existsSync(path.join(outputDir, recoveryName))).toBe(true)
  })

  const missingIdentities: Array<readonly [keyof Omit<FastBootstrapRecoveryArtifact, 'schemaVersion'>, number]> = [
    ...[0, 1, 2, 3].map((index) => ['startupRollout', index] as const),
    ...[0, 1, 2].map((index) => ['recoveryJourneys', index] as const),
    ['writerJourneys', 0],
    ...[0, 1, 2, 3].map((index) => ['optionalRuntimeJourneys', index] as const),
  ]
  it.each(missingIdentities)('requires %s identity at position %i', (field, index) => {
    const outputDir = writeCompleteMatrix()
    editJson<FastBootstrapRecoveryArtifact>(outputDir, recoveryName, (artifact) => {
      artifact[field].splice(index, 1)
    })
    expectRequiredFailure(outputDir, `incomplete or duplicate ${field} identities`)
  })

  it.each(['startupRollout', 'recoveryJourneys', 'writerJourneys', 'optionalRuntimeJourneys'] as const)(
    'rejects duplicate %s identities even when the count is unchanged',
    (field) => {
      const outputDir = writeCompleteMatrix()
      editJson<FastBootstrapRecoveryArtifact>(outputDir, recoveryName, (artifact) => {
        const entries = artifact[field] as unknown[]
        if (entries.length === 1) entries.push(entries[0])
        else entries[entries.length - 1] = entries[0]
      })
      expectRequiredFailure(outputDir, `incomplete or duplicate ${field} identities`)
    },
  )

  it('retains focused recovery and incomplete batch diagnostics without final files', () => {
    const outputDir = temporaryOutputDir()
    const recovery = emptyFastBootstrapRecoveryArtifact()
    recovery.writerJourneys = completeRecoveryArtifact().writerJourneys
    writeFastBootstrapRecoveryPartial(recovery, outputDir, currentRunId)
    const batch = completeBatchArtifact(directLinkBatches()[0]!)
    batch.complete = false
    batch.directLinks.splice(1)
    writeFastBootstrapDirectLinkBatchPartial(batch, outputDir, currentRunId)

    expect(mergeFastBootstrapArtifactOutputs({ outputDir, runId: currentRunId })).toBeNull()
    expect(fs.readdirSync(outputDir).sort()).toEqual([batchName(0), recoveryName].sort())
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, batchName(0)), 'utf8')).directLinks).toHaveLength(1)
    expectRequiredFailure(outputDir, 'incomplete direct-link batch 1/4')
  })

  it('returns no artifact for a run that does not execute the integration specs', () => {
    const outputDir = temporaryOutputDir()
    expect(mergeFastBootstrapArtifactOutputs({ outputDir, runId: currentRunId })).toBeNull()
    expect(fs.readdirSync(outputDir)).toEqual([])
  })

  it('rejects a missing batch and removes a previously successful final while retaining partials', () => {
    const outputDir = writeCompleteMatrix()
    mergeFastBootstrapArtifactOutputs({ outputDir, required: true, runId: currentRunId })
    fs.unlinkSync(path.join(outputDir, batchName(3)))
    expectRequiredFailure(outputDir, 'missing direct-link batch 4/4')
    expect(fs.existsSync(path.join(outputDir, batchName(0)))).toBe(true)
  })

  it.each(['path', 'requestedRouteKey', 'finalRouteKey', 'surfaces', 'requiredPaths', 'requestedPaths'] as const)(
    'rejects fabricated direct-link %s evidence',
    (field) => {
      const outputDir = writeCompleteMatrix()
      editJson<FastBootstrapDirectLinkBatchArtifact>(outputDir, batchName(0), (batch) => {
        // Case 4 is a character route with an actual required resource path.
        const result = batch.directLinks.find((entry) => entry.caseIndex === 4)!.result
        Object.assign(result, { [field]: typeof result[field] === 'string' ? 'fabricated' : [] })
      })
      expectRequiredFailure(outputDir, field)
    },
  )

  it('requires every declared route resource to have actually been requested', () => {
    const outputDir = writeCompleteMatrix()
    editJson<FastBootstrapDirectLinkBatchArtifact>(outputDir, batchName(0), (batch) => {
      batch.directLinks.find((entry) => entry.caseIndex === 4)!.result.requestedPaths = ['/api/v1/resources/shell']
    })
    expectRequiredFailure(outputDir, 'missing requestedPaths evidence')
  })

  it('rejects using a redirect source key as its final route', () => {
    const outputDir = writeCompleteMatrix()
    editJson<FastBootstrapDirectLinkBatchArtifact>(outputDir, batchName(3), (batch) => {
      const result = batch.directLinks.find((entry) => entry.caseIndex === 3)!.result
      result.finalRouteKey = result.requestedRouteKey
    })
    expectRequiredFailure(outputDir, 'incorrect finalRouteKey')
  })

  it.each([
    [
      'duplicate case',
      'duplicate direct-link case index',
      (batch: FastBootstrapDirectLinkBatchArtifact) => batch.directLinks.push(batch.directLinks[0]!),
    ],
    [
      'out-of-range case',
      'out-of-range direct-link case index',
      (batch: FastBootstrapDirectLinkBatchArtifact) =>
        batch.directLinks.push({ ...batch.directLinks[0]!, caseIndex: directLinkCases().length }),
    ],
    [
      'false complete flag',
      'incomplete direct-link batch',
      (batch: FastBootstrapDirectLinkBatchArtifact) => {
        batch.complete = false
      },
    ],
    [
      'missing case',
      'missing direct-link case index',
      (batch: FastBootstrapDirectLinkBatchArtifact) => batch.directLinks.pop(),
    ],
    [
      'wrong total count',
      'reports totalCaseCount=',
      (batch: FastBootstrapDirectLinkBatchArtifact) => {
        batch.totalCaseCount += 1
      },
    ],
  ] as const)('rejects %s', (_label, issue, mutate) => {
    const outputDir = writeCompleteMatrix()
    editJson(outputDir, batchName(0), mutate)
    expectRequiredFailure(outputDir, issue)
  })

  it('rejects globally complete cases placed in the wrong batches', () => {
    const outputDir = writeCompleteMatrix()
    const batches = directLinkBatches().map(completeBatchArtifact)
    const first = batches[0]!.directLinks[0]!
    batches[0]!.directLinks[0] = batches[1]!.directLinks[0]!
    batches[1]!.directLinks[0] = first
    for (const batch of batches) writeFastBootstrapDirectLinkBatchPartial(batch, outputDir, currentRunId)
    expectRequiredFailure(outputDir, 'belongs to a different batch')
  })

  it('rejects a batch payload claiming another file identity', () => {
    const outputDir = writeCompleteMatrix()
    editJson<FastBootstrapDirectLinkBatchArtifact>(outputDir, batchName(0), (batch) => {
      batch.batchIndex = 1
    })
    expectRequiredFailure(outputDir, 'batch filename does not match payload')
  })

  it('rejects an unexpected additional batch family', () => {
    const outputDir = writeCompleteMatrix()
    const batch = { ...completeBatchArtifact(directLinkBatches()[0]!), batchCount: 5, batchIndex: 4 }
    writeFastBootstrapDirectLinkBatchPartial(batch, outputDir, currentRunId)
    expectRequiredFailure(outputDir, 'reports batchCount=5')
  })

  it.each([recoveryName, batchName(0)])('rejects stale run provenance in %s', (name) => {
    const outputDir = writeCompleteMatrix()
    editJson<{ runId: string }>(outputDir, name, (artifact) => {
      artifact.runId = 'previous-playwright-invocation'
    })
    expectRequiredFailure(outputDir, 'stale or missing run ID')
  })

  it.each([recoveryName, batchName(0)])('rejects legacy evidence with no run ID in %s', (name) => {
    const outputDir = writeCompleteMatrix()
    editJson<{ runId?: string }>(outputDir, name, (artifact) => {
      delete artifact.runId
    })
    expectRequiredFailure(outputDir, 'stale or missing run ID')
  })

  it('requires an independently supplied current invocation ID', () => {
    const outputDir = writeCompleteMatrix()
    seedStaleFinals(outputDir)
    expect(() => mergeFastBootstrapArtifactOutputs({ outputDir, required: true, runId: '' })).toThrow(
      'missing current Fast-bootstrap artifact run ID',
    )
    expectNoFinals(outputDir)
  })

  it('does not promote a complete previous invocation during an optional focused rerun', () => {
    const outputDir = writeCompleteMatrix()
    seedStaleFinals(outputDir)
    expect(mergeFastBootstrapArtifactOutputs({ outputDir, runId: 'next-invocation' })).toBeNull()
    expectNoFinals(outputDir)
    expect(fs.existsSync(path.join(outputDir, recoveryName))).toBe(true)
  })

  it.each([recoveryName, batchName(0)])('rejects unreadable %s and clears stale final files', (name) => {
    const outputDir = writeCompleteMatrix()
    fs.writeFileSync(path.join(outputDir, name), '{')
    expectRequiredFailure(outputDir, `could not read ${name}`)
  })

  it('clears only integration outputs before a Playwright run', () => {
    const outputDir = temporaryOutputDir()
    const independentNames = ['startup-matrix.json', 'startup-matrix.txt', 'locale-startup.json', 'locale-startup.txt']
    for (const name of [...finalNames, recoveryName, batchName(0), ...independentNames])
      fs.writeFileSync(path.join(outputDir, name), '{}\n')
    resetFastBootstrapArtifactOutputs(outputDir)
    expect(fs.readdirSync(outputDir).sort()).toEqual(independentNames.sort())
  })

  it('global setup creates fresh provenance inherited by partial producers on every invocation', () => {
    const workspace = temporaryOutputDir()
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    vi.stubEnv('RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID', 'previous-invocation')
    globalSetup()
    const firstId = process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID
    expect(firstId).toBeTruthy()
    expect(firstId).not.toBe('previous-invocation')
    const firstOutput = JSON.parse(writeFastBootstrapRecoveryPartial(emptyFastBootstrapRecoveryArtifact()))
    expect(firstOutput.runId).toBe(firstId)
    globalSetup()
    expect(process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID).not.toBe(firstId)
    expect(fs.readdirSync(path.join(workspace, 'fast-bootstrap-results'))).toEqual([])
    const nextOutput = JSON.parse(
      writeFastBootstrapDirectLinkBatchPartial(completeBatchArtifact(directLinkBatches()[0]!)),
    )
    expect(nextOutput.runId).toBe(process.env.RISU_FAST_BOOTSTRAP_ARTIFACT_RUN_ID)
  })
})

const malformedRecoveryCases: Array<
  [
    string,
    keyof Omit<FastBootstrapRecoveryArtifact, 'schemaVersion'>,
    (artifact: FastBootstrapRecoveryArtifact) => void,
  ]
> = [
  [
    'null startup entry',
    'startupRollout',
    (artifact) => {
      Object.assign(artifact.startupRollout, { 0: null })
    },
  ],
  [
    'missing milestone durations',
    'startupRollout',
    (artifact) => {
      artifact.startupRollout[0]!.startup.durationsFromEntry = {}
    },
  ],
  [
    'missing startup attempts',
    'startupRollout',
    (artifact) => {
      artifact.startupRollout[0]!.startup.attempts = []
    },
  ],
  [
    'empty telemetry',
    'startupRollout',
    (artifact) => {
      artifact.startupRollout[0]!.telemetry = []
    },
  ],
  [
    'malformed telemetry',
    'startupRollout',
    (artifact) => {
      Object.assign(artifact.startupRollout[0]!.telemetry[0]!, { entryDurationMs: 'fast' })
    },
  ],
  [
    'wrong observer observation',
    'startupRollout',
    (artifact) => {
      artifact.startupRollout[0]!.observerVisibleBeforeWriter = true
    },
  ],
  [
    'missing coordinator capabilities',
    'startupRollout',
    (artifact) => {
      Object.assign(artifact.startupRollout[0]!.coordinator, { capabilities: {} })
    },
  ],
  [
    'malformed coordinator failure',
    'startupRollout',
    (artifact) => {
      Object.assign(artifact.startupRollout[0]!.coordinator, { failures: { canMutate: null } })
    },
  ],
  [
    'premature mutation',
    'startupRollout',
    (artifact) => {
      artifact.startupRollout[0]!.earlyRequests.mutationsBeforeWriterReady = 1
    },
  ],
  [
    'unknown recovery scenario',
    'recoveryJourneys',
    (artifact) => {
      Object.assign(artifact.recoveryJourneys[0]!, { scenario: 'invented' })
    },
  ],
  [
    'missing retained mutation',
    'recoveryJourneys',
    (artifact) => {
      delete artifact.recoveryJourneys[1]!.retainedMutationId
    },
  ],
  [
    'nonfinite revision',
    'recoveryJourneys',
    (artifact) => {
      artifact.recoveryJourneys[0]!.initialRevision = Number.NaN
    },
  ],
  [
    'unchanged recovery revision',
    'recoveryJourneys',
    (artifact) => {
      artifact.recoveryJourneys[0]!.finalRevision = 7
    },
  ],
  [
    'absent replay attempts',
    'recoveryJourneys',
    (artifact) => {
      artifact.recoveryJourneys[1]!.commandAttempts = 0
    },
  ],
  [
    'absent acknowledgement',
    'recoveryJourneys',
    (artifact) => {
      artifact.recoveryJourneys[1]!.receiptAcknowledgements = 0
    },
  ],
  [
    'absent event-gap refresh',
    'recoveryJourneys',
    (artifact) => {
      artifact.recoveryJourneys[0]!.resourceRefreshes = 0
    },
  ],
  [
    'observer command leak',
    'writerJourneys',
    (artifact) => {
      artifact.writerJourneys[0]!.observerCommandsBeforePromotion = 1
    },
  ],
  [
    'missing writer acceptance',
    'writerJourneys',
    (artifact) => {
      artifact.writerJourneys[0]!.newWriterMutationAccepted = false
    },
  ],
  [
    'blocked optional capability',
    'optionalRuntimeJourneys',
    (artifact) => {
      artifact.optionalRuntimeJourneys[0]!.canMutate = false
    },
  ],
  [
    'missing route-local retry',
    'optionalRuntimeJourneys',
    (artifact) => {
      artifact.optionalRuntimeJourneys[3]!.retrySucceeded = false
    },
  ],
]

describe('Fast-bootstrap nested recovery evidence', () => {
  it.each(malformedRecoveryCases)('rejects %s when reading and writing partials', (_label, field, mutate) => {
    const outputDir = writeCompleteMatrix()
    const invalid = completeRecoveryArtifact()
    mutate(invalid)
    expect(() => writeFastBootstrapRecoveryPartial(invalid, outputDir, currentRunId)).toThrow(`entry in ${field}`)
    // Readers must also reject tampered/older files that bypassed the writer.
    editJson<FastBootstrapRecoveryArtifact>(outputDir, recoveryName, mutate)
    expectRequiredFailure(outputDir, `entry in ${field}`)
  })
})

function temporaryOutputDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-fast-bootstrap-artifacts-'))
  temporaryDirectories.push(directory)
  return directory
}

function batchName(batchIndex: number): string {
  return `fast-bootstrap-integration.direct-links-${batchIndex + 1}-of-4.partial.json`
}

function writeCompleteMatrix(): string {
  const outputDir = temporaryOutputDir()
  writeFastBootstrapRecoveryPartial(completeRecoveryArtifact(), outputDir, currentRunId)
  for (const batch of directLinkBatches().reverse()) {
    writeFastBootstrapDirectLinkBatchPartial(completeBatchArtifact(batch), outputDir, currentRunId)
  }
  return outputDir
}

function completeBatchArtifact(
  batch: ReturnType<typeof directLinkBatches>[number],
): FastBootstrapDirectLinkBatchArtifact {
  return {
    schemaVersion: 1,
    batchIndex: batch.batchIndex,
    batchCount: batch.batchCount,
    totalCaseCount: directLinkCases().length,
    complete: true,
    directLinks: batch.cases.map(({ caseIndex, definition }) => ({
      caseIndex,
      result: {
        path: definition.path,
        requestedRouteKey: routeKey(definition.route),
        finalRouteKey: routeKey(definition.finalRoute ?? definition.route),
        surfaces: resourceSurfacesForRoute(definition.route),
        requiredPaths: requiredResourcePaths(definition.route),
        requestedPaths: ['/api/v1/resources/shell', ...requiredResourcePaths(definition.route)],
      },
    })),
  }
}

function completeRecoveryArtifact(): FastBootstrapRecoveryArtifact {
  return {
    schemaVersion: 1,
    startupRollout: (['small', 'large'] as const).flatMap((fixture) =>
      (['disabled', 'enabled'] as const).map((observerMode) => completeStartupCase(fixture, observerMode)),
    ),
    recoveryJourneys: [
      {
        scenario: 'event-gap',
        initialRevision: 7,
        finalRevision: 8,
        commandAttempts: 1,
        receiptAcknowledgements: 0,
        resourceRefreshes: 4,
      },
      {
        scenario: 'offline-before-send',
        initialRevision: 7,
        finalRevision: 8,
        retainedMutationId: 'offline-mutation',
        commandAttempts: 2,
        receiptAcknowledgements: 1,
        resourceRefreshes: 0,
      },
      {
        scenario: 'response-lost-after-commit',
        initialRevision: 7,
        finalRevision: 8,
        retainedMutationId: 'committed-mutation',
        commandAttempts: 3,
        receiptAcknowledgements: 1,
        resourceRefreshes: 0,
      },
    ],
    writerJourneys: [
      {
        scenario: 'denial-then-takeover',
        observerCommandsBeforePromotion: 0,
        oldWriterCommandsAfterTakeover: 0,
        newWriterMutationAccepted: true,
      },
    ],
    optionalRuntimeJourneys: [
      {
        runtime: 'background-resources',
        mode: 'slow',
        canRenderShell: true,
        canMutate: true,
        canGenerate: true,
        localizedFailure: false,
        retrySucceeded: true,
      },
      {
        runtime: 'background-resources',
        mode: 'failed',
        canRenderShell: true,
        canMutate: true,
        canGenerate: true,
        localizedFailure: true,
        retrySucceeded: false,
      },
      {
        runtime: 'inlay-catalog',
        mode: 'slow',
        canRenderShell: true,
        canMutate: true,
        canGenerate: false,
        localizedFailure: false,
        retrySucceeded: true,
      },
      {
        runtime: 'inlay-catalog',
        mode: 'failed',
        canRenderShell: true,
        canMutate: true,
        canGenerate: false,
        localizedFailure: true,
        retrySucceeded: true,
      },
    ],
  }
}

function completeStartupCase(
  fixture: RolloutStartupCase['fixture'],
  observerMode: RolloutStartupCase['observerMode'],
): RolloutStartupCase {
  const milestones = [
    'entry',
    'shell-mounted',
    'observer-ready',
    'writer-ready',
    'plugins-ready',
    'chat-ready',
    'background-ready',
  ] as const
  const durations = Object.fromEntries(milestones.map((milestone, index) => [milestone, index * 10]))
  const observerShellEnabled = observerMode === 'enabled'
  return {
    fixture,
    observerMode,
    observerVisibleBeforeWriter: observerShellEnabled,
    startup: {
      schemaVersion: 1,
      phase: 'background-ready',
      timestamps: durations,
      durationsFromEntry: durations,
      attempts: [{ attemptId: 1, startedAtMs: 10, completedAtMs: 60 }],
    },
    coordinator: {
      schemaVersion: 1,
      observerShellEnabled,
      writerCapabilitiesRevoked: false,
      capabilities: {
        canRenderShell: true,
        canApplyRoutes: true,
        canMutate: true,
        pluginsReady: true,
        canGenerate: true,
      },
      failures: {},
      completedSteps: ['writer-bootstrap', 'background-readiness'],
    },
    earlyRequests: { mutationsBeforeWriterReady: 0, generationsBeforeChatReady: 0 },
    telemetry: [
      ...milestones.map((milestone, index) => ({
        schemaVersion: 1,
        kind: 'phase-ready',
        milestone,
        attemptCount: 1,
        observerShellEnabled,
        entryDurationMs: index * 10,
      })),
      { schemaVersion: 1, kind: 'attempt-completed', attemptCount: 1, observerShellEnabled, attemptDurationMs: 50 },
    ],
  }
}

function editJson<T>(outputDir: string, name: string, mutate: (value: T) => unknown): void {
  const file = path.join(outputDir, name)
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as T
  mutate(value)
  fs.writeFileSync(file, JSON.stringify(value))
}

function seedStaleFinals(outputDir: string): void {
  for (const name of finalNames) fs.writeFileSync(path.join(outputDir, name), 'previous success')
}

function expectNoFinals(outputDir: string): void {
  for (const name of finalNames) expect(fs.existsSync(path.join(outputDir, name)), name).toBe(false)
}

function expectRequiredFailure(outputDir: string, issue: string): void {
  seedStaleFinals(outputDir)
  expect(() => mergeFastBootstrapArtifactOutputs({ outputDir, required: true, runId: currentRunId })).toThrow(issue)
  expectNoFinals(outputDir)
}
