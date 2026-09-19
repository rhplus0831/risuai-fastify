import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export interface ServerCheck {
  id: 'protocol' | 'shared-core' | 'architecture-inventory' | 'server' | 'browser-smoke'
  label: string
  args: string[]
}

export type ServerCheckRunner = (check: ServerCheck) => Promise<number>

export interface RunServerChecksOptions {
  includeArchitectureInventory?: boolean
}

export const protocolCheck: ServerCheck = {
  id: 'protocol',
  label: 'protocol typecheck',
  args: ['check:protocol'],
}

export const sharedCoreCheck: ServerCheck = {
  id: 'shared-core',
  label: 'shared-core typecheck',
  args: ['check:shared-core'],
}

export const architectureInventoryCheck: ServerCheck = {
  id: 'architecture-inventory',
  label: 'architecture inventory',
  args: ['exec', 'tsx', 'util/architecture-inventory.ts'],
}

export const downstreamServerChecks: readonly ServerCheck[] = [
  {
    id: 'server',
    label: 'Fastify typecheck',
    args: ['exec', 'tsc', '-p', 'server/fastify/tsconfig.json', '--noEmit'],
  },
  {
    id: 'browser-smoke',
    label: 'browser-smoke typecheck',
    args: ['exec', 'tsc', '-p', 'tsconfig.browser-smoke.json', '--noEmit'],
  },
]

/** Check shared prerequisites, then check the independent consumers concurrently. */
export async function runServerChecks(
  runCheck: ServerCheckRunner,
  { includeArchitectureInventory = true }: RunServerChecksOptions = {},
): Promise<number> {
  if ((await runCheck(protocolCheck)) !== 0) return 1
  if ((await runCheck(sharedCoreCheck)) !== 0) return 1
  if (includeArchitectureInventory && (await runCheck(architectureInventoryCheck)) !== 0) return 1
  const exitCodes = await Promise.all(downstreamServerChecks.map(runCheck))
  return exitCodes.every((exitCode) => exitCode === 0) ? 0 : 1
}

async function run(): Promise<void> {
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const children = new Set<ChildProcess>()
  let interruptedSignal: NodeJS.Signals | undefined

  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal
    for (const child of children) child.kill(signal)
  }
  process.once('SIGINT', () => interrupt('SIGINT'))
  process.once('SIGTERM', () => interrupt('SIGTERM'))

  const runCheck: ServerCheckRunner = async (check) => {
    if (interruptedSignal) return 1
    const startedAt = performance.now()
    console.log(`[check:server] starting ${check.label}`)
    const exitCode = await new Promise<number>((resolve) => {
      const options: SpawnOptions = { cwd: process.cwd(), env: process.env, stdio: 'inherit' }
      const child = spawn(pnpmCommand, check.args, options)
      children.add(child)
      child.once('error', (error) => {
        children.delete(child)
        console.error(`[check:server] could not start ${check.label}: ${error.message}`)
        resolve(1)
      })
      child.once('exit', (code) => {
        children.delete(child)
        resolve(code ?? 1)
      })
    })
    const elapsedSeconds = ((performance.now() - startedAt) / 1_000).toFixed(1)
    console.log(`[check:server] ${check.label} ${exitCode === 0 ? 'passed' : 'failed'} in ${elapsedSeconds}s`)
    return exitCode
  }

  const exitCode = await runServerChecks(runCheck, {
    includeArchitectureInventory: !process.argv.includes('--typechecks-only'),
  })
  if (interruptedSignal) {
    process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  } else {
    process.exitCode = exitCode
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath && existsSync(invokedPath)) {
  run().catch((error) => {
    console.error(`[check:server] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
