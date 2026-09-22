import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { frontendVitestProjectForFile, isolatedCompatibilityTestFiles } from '../vitest.frontend-routing.js'
import { performanceTestFiles } from '../vitest.performance-tests.js'

export interface FocusedTestCommand {
  args: string[]
  env?: Record<string, string>
  label: string
}

export interface FocusedTestPlan {
  commands: FocusedTestCommand[]
  file: string
}

const serverConfig = 'server/fastify/vitest.config.ts'
const browserConfig = 'playwright.fastify-smoke.config.ts'
const serverTestPattern = /^server\/fastify\/__tests__\/.+\.test\.ts$/
const browserSpecPattern = /^server\/fastify\/browser-smoke\/.+\.spec\.ts$/
const sourceFilePattern = /\.(?:[cm]?[jt]sx?|svelte)$/
const performanceTestFileSet = new Set<string>(performanceTestFiles)
const isolatedCompatibilityTestFileSet = new Set<string>(isolatedCompatibilityTestFiles)
const sharedSourcePrefixes = ['packages/protocol/src/', 'packages/shared-core/src/'] as const
const frontendSourcePrefixes = ['src/', 'util/', 'test/compat-harness/'] as const
const serverSourcePrefixes = [
  'server/fastify/src/',
  'server/fastify/__fixtures__/',
  'server/fastify/__tests__/',
] as const
const blockedRunnerFiles = new Set([
  'playwright.fastify-smoke.config.ts',
  'server/fastify/vitest.config.ts',
  'vite.config.ts',
  'vitest.config.ts',
  'vitest.dom.config.ts',
  'vitest.dom.setup.ts',
  'vitest.fetchGuard.ts',
  'vitest.frontend-routing.ts',
  'vitest.node.config.ts',
  'vitest.performance-tests.ts',
  'vitest.setup.ts',
  'vitest.svelte-node.config.ts',
  'vitest.svelte-node.environment.ts',
])

function normalizeRepoPath(file: string): string {
  return file.split(path.sep).join('/').replace(/^\.\//, '')
}

function startsWithAny(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix))
}

export function parseFocusedTestArgument(args: readonly string[]): string {
  const positional = args.filter((arg) => arg !== '--')
  if (positional.length !== 1) {
    throw new Error('expected exactly one test or source file: pnpm test -- <test-or-source-file>')
  }
  const [file] = positional
  if (!file || file.startsWith('-')) throw new Error('the focused test target must be a file, not a runner option')
  if (/[*?\[\]{}]/.test(file)) throw new Error('the focused test target must be one file; globs are not supported')
  return file
}

export function resolveFocusedTestFile(file: string, repositoryRoot = process.cwd()): string {
  const root = path.resolve(repositoryRoot)
  const absolute = path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('the focused test target must be a file inside the repository')
  }
  if (!existsSync(absolute)) throw new Error(`focused test target does not exist: ${normalizeRepoPath(relative)}`)
  if (!statSync(absolute).isFile()) throw new Error(`focused test target is not a file: ${normalizeRepoPath(relative)}`)
  return normalizeRepoPath(relative)
}

function frontendTestCommand(file: string): FocusedTestCommand {
  const project = frontendVitestProjectForFile(file)
  if (!project) {
    if (isolatedCompatibilityTestFileSet.has(file)) {
      throw new Error(`${file} belongs to the user-owned pinned compatibility suite`)
    }
    throw new Error(`unsupported frontend test file: ${file}`)
  }
  const performance = performanceTestFileSet.has(file)
  return {
    label: `focused ${project} test`,
    args: [
      'exec',
      'vitest',
      'run',
      file,
      '--bail=1',
      ...(performance ? ['--no-file-parallelism', '--maxWorkers=1'] : []),
    ],
    env: performance ? { RISU_TEST_INCLUDE_GATES: 'true' } : undefined,
  }
}

function frontendRelatedCommand(file: string): FocusedTestCommand {
  return {
    label: 'frontend tests related to source',
    args: ['exec', 'vitest', 'related', file, '--run', '--passWithNoTests', '--bail=1'],
  }
}

function serverRelatedCommand(file: string): FocusedTestCommand {
  return {
    label: 'server tests related to source',
    args: ['exec', 'vitest', 'related', file, '--run', '--config', serverConfig, '--passWithNoTests', '--bail=1'],
  }
}

export function planFocusedTest(file: string): FocusedTestPlan {
  const normalized = normalizeRepoPath(file)

  if (browserSpecPattern.test(normalized)) {
    return {
      file: normalized,
      commands: [
        { label: 'browser-smoke build', args: ['build:smoke'] },
        {
          label: 'focused browser-smoke spec',
          args: ['exec', 'playwright', 'test', '-c', browserConfig, normalized],
          env: { VITE_FASTIFY_BROWSER_SMOKE: 'TRUE' },
        },
      ],
    }
  }

  if (serverTestPattern.test(normalized)) {
    return {
      file: normalized,
      commands: [
        {
          label: 'focused server test',
          args: ['exec', 'vitest', 'run', '--config', serverConfig, normalized, '--bail=1'],
        },
      ],
    }
  }

  if (normalized.endsWith('.test.ts')) {
    return { file: normalized, commands: [frontendTestCommand(normalized)] }
  }
  if (normalized.endsWith('.spec.ts')) throw new Error(`unsupported browser spec location: ${normalized}`)
  if (!sourceFilePattern.test(normalized)) throw new Error(`unsupported focused test target: ${normalized}`)
  if (blockedRunnerFiles.has(normalized) || normalized.endsWith('.vitest.config.ts')) {
    throw new Error(`${normalized} is test infrastructure owned by the user/CI full suite`)
  }
  if (normalized.startsWith('server/fastify/browser-smoke/')) {
    throw new Error('browser-smoke support files cannot select related specs; pass one owning .spec.ts file instead')
  }
  if (sharedSourcePrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return {
      file: normalized,
      commands: [frontendRelatedCommand(normalized), serverRelatedCommand(normalized)],
    }
  }
  if (startsWithAny(normalized, serverSourcePrefixes)) {
    return { file: normalized, commands: [serverRelatedCommand(normalized)] }
  }
  if (startsWithAny(normalized, frontendSourcePrefixes)) {
    return { file: normalized, commands: [frontendRelatedCommand(normalized)] }
  }
  throw new Error(`unsupported focused test target: ${normalized}`)
}

function displayCommand(command: FocusedTestCommand): string {
  const env = command.env
    ? `${Object.entries(command.env)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')} `
    : ''
  return `${env}pnpm ${command.args.map((arg) => JSON.stringify(arg)).join(' ')}`
}

async function run(): Promise<void> {
  const requestedFile = parseFocusedTestArgument(process.argv.slice(2))
  const file = resolveFocusedTestFile(requestedFile)
  const plan = planFocusedTest(file)
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const children = new Set<ChildProcess>()
  let interruptedSignal: NodeJS.Signals | undefined

  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal
    for (const child of children) child.kill(signal)
  }
  process.once('SIGINT', () => interrupt('SIGINT'))
  process.once('SIGTERM', () => interrupt('SIGTERM'))

  console.log(`[test] focused target: ${plan.file}`)
  for (const command of plan.commands) {
    if (interruptedSignal) break
    console.log(`[test] ${command.label}: ${displayCommand(command)}`)
    const exitCode = await new Promise<number>((resolve) => {
      const env = { ...process.env }
      delete env.RISU_TEST_INCLUDE_GATES
      Object.assign(env, command.env)
      const options: SpawnOptions = { cwd: process.cwd(), env, stdio: 'inherit' }
      const child = spawn(pnpmCommand, command.args, options)
      children.add(child)
      child.once('error', (error) => {
        children.delete(child)
        console.error(`[test] could not start ${command.label}: ${error.message}`)
        resolve(1)
      })
      child.once('exit', (code) => {
        children.delete(child)
        resolve(code ?? 1)
      })
    })
    if (exitCode !== 0) {
      process.exitCode = exitCode
      return
    }
  }

  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath && existsSync(invokedPath)) {
  run().catch((error) => {
    console.error(`[test] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
