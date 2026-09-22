import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  frontendVitestProjectForFile,
  isolatedCompatibilityTestFiles,
  type FrontendVitestProject,
} from '../vitest.frontend-routing.js'
import { performanceTestFiles as configuredPerformanceTestFiles } from '../vitest.performance-tests.js'
import { browserCoreTestFiles, frontendCoreTestFiles, serverCoreTestFiles } from './core-test-contract.js'

export interface ListedTestFile {
  file: string
  projectName?: string
}

export interface TestTopologySnapshot {
  defaultFrontend: ListedTestFile[]
  gatesFrontend: ListedTestFile[]
  server: ListedTestFile[]
  trackedTests: string[]
}

export interface ConfiguredTestFileGroup {
  files: readonly string[]
  label: string
}

export interface CoreTestMarkerGroup extends ConfiguredTestFileGroup {
  marker: RegExp
}

type ExpectedTestFiles = Map<string, FrontendVitestProject | undefined>

const performanceTestFiles = new Set<string>(configuredPerformanceTestFiles)

function normalizeRepoPath(file: string): string {
  return file.split(path.sep).join('/')
}

function expectedFrontendTests(trackedTests: readonly string[]): Map<string, FrontendVitestProject> {
  const expected = new Map<string, FrontendVitestProject>()
  for (const file of trackedTests) {
    if (file.startsWith('server/')) continue
    const project = frontendVitestProjectForFile(file)
    if (project) expected.set(file, project)
  }
  return expected
}

function withoutFiles(
  expected: ReadonlyMap<string, FrontendVitestProject>,
  excluded: ReadonlySet<string>,
): Map<string, FrontendVitestProject> {
  return new Map([...expected].filter(([file]) => !excluded.has(file)))
}

function validateListedFiles(label: string, entries: readonly ListedTestFile[], expected: ExpectedTestFiles): string[] {
  const errors: string[] = []
  const actual = new Map<string, ListedTestFile>()

  for (const entry of entries) {
    if (actual.has(entry.file)) {
      errors.push(`${label}: duplicate test discovery for ${entry.file}`)
      continue
    }
    actual.set(entry.file, entry)
  }

  for (const [file, expectedProject] of expected) {
    const entry = actual.get(file)
    if (!entry) {
      errors.push(`${label}: missing tracked test ${file}`)
      continue
    }
    if (expectedProject !== undefined && entry.projectName !== expectedProject) {
      errors.push(`${label}: ${file} routed to ${entry.projectName ?? 'no project'}; expected ${expectedProject}`)
    }
  }

  for (const file of actual.keys()) {
    if (!expected.has(file)) errors.push(`${label}: unexpected test discovery for ${file}`)
  }

  return errors
}

export function validateTestTopology(snapshot: TestTopologySnapshot): string[] {
  const frontend = expectedFrontendTests(snapshot.trackedTests)
  const defaultFrontend = withoutFiles(frontend, performanceTestFiles)
  const expectedServer: ExpectedTestFiles = new Map(
    snapshot.trackedTests
      .filter((file) => file.startsWith('server/fastify/__tests__/'))
      .map((file) => [file, undefined]),
  )

  return [
    ...validateListedFiles('frontend default', snapshot.defaultFrontend, defaultFrontend),
    ...validateListedFiles('frontend gates', snapshot.gatesFrontend, frontend),
    ...validateListedFiles('server', snapshot.server, expectedServer),
  ]
}

export function validateConfiguredTestFiles(
  trackedTests: readonly string[],
  groups: readonly ConfiguredTestFileGroup[] = [
    { label: 'performance tests', files: configuredPerformanceTestFiles },
    { label: 'isolated compatibility tests', files: isolatedCompatibilityTestFiles },
    { label: 'frontend core tests', files: frontendCoreTestFiles },
    { label: 'server core tests', files: serverCoreTestFiles },
    { label: 'browser core tests', files: browserCoreTestFiles },
  ],
): string[] {
  const tracked = new Set(trackedTests)
  return groups.flatMap(({ files, label }) =>
    files.filter((file) => !tracked.has(file)).map((file) => `${label}: configured test is missing: ${file}`),
  )
}

export function validateCoreTestMarkers(
  groups: readonly CoreTestMarkerGroup[] = [
    {
      label: 'Vitest core tests',
      files: [...frontendCoreTestFiles, ...serverCoreTestFiles],
      marker: /@module-tag\s+core|tags:\s*['"]core['"]|coreIt\(['"]/,
    },
    { label: 'browser core tests', files: browserCoreTestFiles, marker: /@core\b/ },
  ],
  readSource: (file: string) => string = (file) => readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8'),
): string[] {
  return groups.flatMap(({ files, label, marker }) =>
    files.filter((file) => !marker.test(readSource(file))).map((file) => `${label}: missing core marker: ${file}`),
  )
}

function runCommand(file: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(file, args, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${file} ${args.join(' ')} failed`
    throw new Error(detail)
  }
  return result.stdout
}

function parseListedTests(output: string): ListedTestFile[] {
  const lines = output.split(/\r?\n/)
  const jsonStart = lines.findIndex((line) => line.trim() === '[')
  if (jsonStart === -1) throw new Error('Vitest list output did not contain a JSON array')
  const value: unknown = JSON.parse(lines.slice(jsonStart).join('\n'))
  if (!Array.isArray(value)) throw new Error('Vitest list output was not an array')

  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { file?: unknown }).file !== 'string') {
      throw new Error('Vitest list output contained an invalid entry')
    }
    const listed = entry as { file: string; projectName?: unknown }
    const relative = path.relative(path.resolve(import.meta.dirname, '..'), listed.file)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Vitest discovered a test outside the repository: ${listed.file}`)
    }
    if (listed.projectName !== undefined && typeof listed.projectName !== 'string') {
      throw new Error(`Vitest reported an invalid project name for ${listed.file}`)
    }
    return { file: normalizeRepoPath(relative), projectName: listed.projectName }
  })
}

function frontendEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.RISU_TEST_INCLUDE_GATES
  return { ...env, ...overrides }
}

function listVitestFiles(args: string[], env?: NodeJS.ProcessEnv): ListedTestFile[] {
  return parseListedTests(
    runCommand('pnpm', ['exec', 'vitest', 'list', ...args, '--filesOnly', '--staticParse', '--json'], env),
  )
}

function loadTrackedTests(): string[] {
  const root = path.resolve(import.meta.dirname, '..')
  return runCommand('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '*.test.ts',
    '*.spec.ts',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((file) => existsSync(path.resolve(root, file)))
}

export function runTestTopologyCli(): number {
  const snapshot: TestTopologySnapshot = {
    defaultFrontend: listVitestFiles([], frontendEnvironment()),
    gatesFrontend: listVitestFiles([], frontendEnvironment({ RISU_TEST_INCLUDE_GATES: 'true' })),
    server: listVitestFiles(['--config', 'server/fastify/vitest.config.ts']),
    trackedTests: loadTrackedTests(),
  }
  const errors = [
    ...validateTestTopology(snapshot),
    ...validateConfiguredTestFiles(snapshot.trackedTests),
    ...validateCoreTestMarkers(),
  ]
  if (errors.length > 0) {
    console.error(`Test topology: FAIL\n${errors.map((error) => `- ${error}`).join('\n')}`)
    return 1
  }
  console.log(
    `Test topology: PASS (frontend=${snapshot.defaultFrontend.length}, gates=${snapshot.gatesFrontend.length}, server=${snapshot.server.length})`,
  )
  return 0
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) process.exitCode = runTestTopologyCli()
