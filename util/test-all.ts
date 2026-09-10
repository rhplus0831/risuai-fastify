import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { performanceTestFiles } from '../vitest.performance-tests.js'

export interface QualityLane {
  id: string
  label: string
  args: string[]
  env?: Record<string, string>
  after?: string[]
  isolated?: boolean
  priority?: number
}

export interface QualityLaneResult {
  finishedOffsetMs: number
  id: string
  exitCode: number
  elapsedMs: number
  startedOffsetMs: number
}

export interface TestAllCliOptions {
  dryRun: boolean
  jobs: number
  timingsJson: boolean
}

export interface QualityRunReport {
  aggregateElapsedMs: number
  jobs: number
  lanes: Array<QualityLaneResult & Pick<QualityLane, 'after' | 'isolated' | 'label'>>
  schemaVersion: 1
}

type LaneRunner = (lane: QualityLane) => Promise<QualityLaneResult>

export type QualityCommandName = 'test:agent' | 'test:all'

const defaultJobs = 2

export const qualityLanes: readonly QualityLane[] = [
  {
    id: 'server-check',
    label: 'server and browser-smoke typecheck',
    args: ['check:server'],
    priority: 0,
  },
  {
    id: 'test-topology',
    label: 'test topology validation',
    args: ['exec', 'tsx', 'util/test-topology.ts'],
    priority: 0,
  },
  {
    id: 'docs',
    label: 'current documentation validation',
    args: ['check:docs'],
    priority: 0,
  },
  {
    id: 'frontend-tests',
    label: 'frontend tests',
    args: ['exec', 'vitest', 'run'],
    after: ['test-topology'],
    // The coverage lane below executes these six files with its thresholds.
    env: { RISU_TEST_EXCLUDE_UI_MAP: 'true' },
    priority: 1,
  },
  {
    id: 'compat-registers',
    label: 'compatibility register validation',
    args: ['validate:compat-registers'],
    priority: 1,
  },
  {
    id: 'compat-current',
    label: 'current compatibility harness',
    args: ['exec', 'tsx', 'test/compat-harness/run.ts', '--current-only'],
    after: ['compat-registers'],
    isolated: true,
  },
  {
    id: 'server-tests',
    label: 'server tests',
    args: ['exec', 'vitest', 'run', '--config', 'server/fastify/vitest.config.ts'],
    isolated: true,
  },
  {
    id: 'realm-scale',
    label: 'Realm import scale gate',
    args: [
      'exec',
      'vitest',
      'run',
      '--config',
      'server/fastify/vitest.config.ts',
      'server/fastify/__tests__/realmImport.test.ts',
      '-t',
      'imports Realm charx packages with thousands of display assets',
      '--no-file-parallelism',
      '--maxWorkers=1',
    ],
    after: ['server-tests'],
    isolated: true,
  },
  {
    id: 'browser-smoke',
    label: 'browser smoke tests',
    args: ['smoke:fastify-browser'],
    // Keep full browser verification after static checks and outside the pool.
    after: ['server-check'],
    isolated: true,
  },
  {
    id: 'frontend-check',
    label: 'frontend check',
    args: ['check'],
    priority: 2,
  },
  {
    id: 'ui-coverage',
    label: 'UI coverage gate',
    args: ['coverage:ui-map'],
    // Keep coverage collection after the other frontend transforms have settled.
    after: ['frontend-tests'],
    priority: 3,
  },
  {
    id: 'format',
    label: 'format check',
    args: ['format:check'],
    priority: 4,
  },
  {
    id: 'performance-gates',
    label: 'frontend performance gates',
    args: ['exec', 'vitest', 'run', ...performanceTestFiles, '--no-file-parallelism', '--maxWorkers=1'],
    env: { RISU_TEST_INCLUDE_GATES: 'true' },
    isolated: true,
  },
]

function requiredQualityLane(id: string): QualityLane {
  const lane = qualityLanes.find((candidate) => candidate.id === id)
  if (!lane) throw new Error(`missing required quality lane: ${id}`)
  return lane
}

export const agentQualityLanes: readonly QualityLane[] = [
  requiredQualityLane('server-check'),
  requiredQualityLane('test-topology'),
  requiredQualityLane('docs'),
  {
    ...requiredQualityLane('frontend-tests'),
    // The agent profile runs the UI-map tests normally, without coverage, and
    // leaves the resource-sensitive performance probes to their explicit lane.
    env: {
      RISU_TEST_EXCLUDE_UI_MAP: 'false',
      RISU_TEST_INCLUDE_GATES: 'false',
    },
  },
  requiredQualityLane('frontend-check'),
  requiredQualityLane('server-tests'),
  {
    id: 'browser-smoke-build',
    label: 'browser-smoke build',
    args: ['build:smoke'],
    after: ['server-check'],
    // This build has no timing assertions, and all typechecks use noEmit.
    // Fill a free slot at lower priority while frontend tests are still running.
    // Actual browser/server tests retain their isolated phases.
    priority: 3,
  },
]

function parsePositiveInteger(raw: string, option: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer, received ${JSON.stringify(raw)}`)
  }
  return value
}

export function parseTestAllJobs(raw: string | undefined): number {
  return raw ? parsePositiveInteger(raw, 'RISU_TEST_ALL_JOBS') : defaultJobs
}

export function parseTestAllCli(args: string[], commandName: QualityCommandName = 'test:all'): TestAllCliOptions {
  let dryRun = false
  let jobs = parseTestAllJobs(process.env.RISU_TEST_ALL_JOBS?.trim())
  let timingsJson = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--jobs') {
      const value = args[index + 1]
      if (!value) throw new Error('--jobs requires a positive integer')
      jobs = parsePositiveInteger(value, '--jobs')
      index += 1
    } else if (arg.startsWith('--jobs=')) {
      jobs = parsePositiveInteger(arg.slice('--jobs='.length), '--jobs')
    } else if (arg === '--timings=json') {
      timingsJson = true
    } else if (arg === '--') {
      continue
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: pnpm ${commandName} [--jobs <count>] [--dry-run] [--timings=json]

Runs independent quality lanes with bounded concurrency, then runs dist- or load-sensitive
lanes in isolation. RISU_TEST_ALL_JOBS sets the default concurrency (${defaultJobs}).
--timings=json prints a final machine-readable critical-path record.`)
      process.exit(0)
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  return { dryRun, jobs, timingsJson }
}

function lanePriority(lane: QualityLane): number {
  return lane.priority ?? Number.MAX_SAFE_INTEGER
}

function validateLaneGraph(lanes: readonly QualityLane[]): void {
  const ids = new Set<string>()
  for (const lane of lanes) {
    if (ids.has(lane.id)) throw new Error(`duplicate quality lane id: ${lane.id}`)
    ids.add(lane.id)
  }
  for (const lane of lanes) {
    for (const dependency of lane.after ?? []) {
      if (!ids.has(dependency)) throw new Error(`quality lane ${lane.id} depends on unknown lane ${dependency}`)
      if (dependency === lane.id) throw new Error(`quality lane ${lane.id} cannot depend on itself`)
    }
  }
}

export function validateQualityLanePhases(lanes: readonly QualityLane[]): void {
  validateLaneGraph(lanes)
  const isolatedIds = new Set(lanes.filter((lane) => lane.isolated).map((lane) => lane.id))
  const completedBeforeIsolation = new Set(lanes.filter((lane) => !lane.isolated).map((lane) => lane.id))

  for (const lane of lanes.filter((candidate) => !candidate.isolated)) {
    const isolatedDependencies = (lane.after ?? []).filter((dependency) => isolatedIds.has(dependency))
    if (isolatedDependencies.length > 0) {
      throw new Error(
        `regular quality lane ${lane.id} cannot depend on isolated lane(s): ${isolatedDependencies.join(', ')}`,
      )
    }
  }

  for (const lane of lanes.filter((candidate) => candidate.isolated)) {
    const unavailable = (lane.after ?? []).filter((dependency) => !completedBeforeIsolation.has(dependency))
    if (unavailable.length > 0) {
      throw new Error(
        `isolated quality lane ${lane.id} must appear after its isolated dependency lane(s): ${unavailable.join(', ')}`,
      )
    }
    completedBeforeIsolation.add(lane.id)
  }
}

export async function runLanePool(
  lanes: readonly QualityLane[],
  jobs: number,
  runLane: LaneRunner,
): Promise<QualityLaneResult[]> {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error('jobs must be a positive integer')
  validateLaneGraph(lanes)
  const pending = new Map(lanes.map((lane) => [lane.id, lane]))
  const running = new Map<string, Promise<void>>()
  const completed = new Set<string>()
  const results = new Map<string, QualityLaneResult>()

  const startReadyLanes = (): void => {
    const ready = [...pending.values()]
      .filter((lane) => (lane.after ?? []).every((dependency) => completed.has(dependency)))
      .sort((left, right) => lanePriority(left) - lanePriority(right))

    for (const lane of ready) {
      if (running.size >= jobs) break
      pending.delete(lane.id)
      const promise = runLane(lane).then((result) => {
        results.set(lane.id, result)
        completed.add(lane.id)
        running.delete(lane.id)
      })
      running.set(lane.id, promise)
    }
  }

  while (pending.size > 0 || running.size > 0) {
    startReadyLanes()
    if (running.size === 0) {
      throw new Error(`quality lane dependency cycle: ${[...pending.keys()].join(', ')}`)
    }
    await Promise.race(running.values())
  }

  return lanes.map((lane) => results.get(lane.id) as QualityLaneResult)
}

function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.round(elapsedMs / 100) / 10
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = (totalSeconds - minutes * 60).toFixed(1)
  return `${minutes}m ${seconds}s`
}

function displayCommand(lane: QualityLane): string {
  const env = lane.env
    ? `${Object.entries(lane.env)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')} `
    : ''
  return `${env}pnpm ${lane.args.join(' ')}`
}

function printPlan(commandName: QualityCommandName, lanes: readonly QualityLane[], jobs: number): void {
  console.log(`[${commandName}] up to ${jobs} regular lanes will run concurrently`)
  for (const lane of lanes) {
    const details = [
      lane.isolated ? 'isolated' : undefined,
      lane.after?.length ? `after ${lane.after.join(', ')}` : undefined,
    ].filter(Boolean)
    console.log(`  ${lane.label}${details.length ? ` (${details.join('; ')})` : ''}: ${displayCommand(lane)}`)
  }
}

export function createQualityRunReport(
  lanes: readonly QualityLane[],
  results: readonly QualityLaneResult[],
  jobs: number,
  aggregateElapsedMs: number,
): QualityRunReport {
  const byId = new Map(results.map((result) => [result.id, result]))
  return {
    aggregateElapsedMs,
    jobs,
    lanes: lanes.map((lane) => {
      const result = byId.get(lane.id)
      if (!result) throw new Error(`missing quality result for ${lane.id}`)
      return {
        after: lane.after,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        finishedOffsetMs: result.finishedOffsetMs,
        id: lane.id,
        isolated: lane.isolated,
        label: lane.label,
        startedOffsetMs: result.startedOffsetMs,
      }
    }),
    schemaVersion: 1,
  }
}

export async function runQualityCommand(
  commandName: QualityCommandName,
  lanes: readonly QualityLane[],
  args = process.argv.slice(2),
): Promise<void> {
  const options = parseTestAllCli(args, commandName)
  validateQualityLanePhases(lanes)
  printPlan(commandName, lanes, options.jobs)
  if (options.dryRun) return

  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const children = new Set<ChildProcess>()
  let interruptedSignal: NodeJS.Signals | undefined
  const startedAt = performance.now()

  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal
    for (const child of children) child.kill(signal)
  }
  process.once('SIGINT', () => interrupt('SIGINT'))
  process.once('SIGTERM', () => interrupt('SIGTERM'))

  const runLane: LaneRunner = async (lane) => {
    if (interruptedSignal) {
      const offset = performance.now() - startedAt
      return { id: lane.id, exitCode: 1, elapsedMs: 0, finishedOffsetMs: offset, startedOffsetMs: offset }
    }
    const laneStartedAt = performance.now()
    console.log(`\n[${commandName}] starting ${lane.label}: ${displayCommand(lane)}`)

    const exitCode = await new Promise<number>((resolve) => {
      const spawnOptions: SpawnOptions = {
        cwd: process.cwd(),
        env: { ...process.env, ...lane.env },
        stdio: 'inherit',
      }
      const child = spawn(pnpmCommand, lane.args, spawnOptions)
      children.add(child)
      child.once('error', (error) => {
        children.delete(child)
        console.error(`[${commandName}] could not start ${lane.label}: ${error.message}`)
        resolve(1)
      })
      child.once('exit', (code) => {
        children.delete(child)
        resolve(code ?? 1)
      })
    })

    const finishedAt = performance.now()
    const elapsedMs = finishedAt - laneStartedAt
    const status = exitCode === 0 ? 'passed' : `failed (exit ${exitCode})`
    console.log(`\n[${commandName}] ${lane.label} ${status} in ${formatDuration(elapsedMs)}`)
    return {
      id: lane.id,
      exitCode,
      elapsedMs,
      finishedOffsetMs: finishedAt - startedAt,
      startedOffsetMs: laneStartedAt - startedAt,
    }
  }

  const regularLanes = lanes.filter((lane) => !lane.isolated)
  const isolatedLanes = lanes.filter((lane) => lane.isolated)
  const results = await runLanePool(regularLanes, options.jobs, runLane)
  for (const lane of isolatedLanes) {
    results.push(await runLane(lane))
  }

  if (interruptedSignal) {
    console.error(`[${commandName}] interrupted by ${interruptedSignal}`)
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
    return
  }

  const aggregateElapsedMs = performance.now() - startedAt
  console.log(`\n[${commandName}] completed in ${formatDuration(aggregateElapsedMs)}`)
  for (const lane of lanes) {
    const result = results.find((candidate) => candidate.id === lane.id)
    const status = result?.exitCode === 0 ? 'PASS' : 'FAIL'
    console.log(`  ${status}  ${lane.label} (${formatDuration(result?.elapsedMs ?? 0)})`)
  }
  if (options.timingsJson)
    console.log(JSON.stringify(createQualityRunReport(lanes, results, options.jobs, aggregateElapsedMs)))
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1
}

export function runQualityCommandCli(commandName: QualityCommandName, lanes: readonly QualityLane[]): void {
  runQualityCommand(commandName, lanes).catch((error) => {
    console.error(`[${commandName}] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath && existsSync(invokedPath)) {
  runQualityCommandCli('test:all', qualityLanes)
}
