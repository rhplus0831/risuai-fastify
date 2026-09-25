import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const BUILD_ID_PATTERN = /^[a-f0-9]{40,64}$/
const GIT_TIMEOUT_MS = 3_000
const GIT_MAX_BUFFER_BYTES = 64 * 1024
const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const gitIdentityBySourceRoot = new Map<string, BuildIdentity>()

export interface BuildIdentity {
  build: string
  source: 'env' | 'git' | 'unknown'
  locationsTrusted: boolean
  dirty?: boolean
  commitTime?: number
}

export interface ResolveBuildIdentityOptions {
  sourceRoot?: string
  /** `null` explicitly disables the server environment-variable lookup. */
  configuredBuild?: string | null
}

function gitOutput(sourceRoot: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: sourceRoot,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }).trim()
  } catch {
    return undefined
  }
}

export function resolveBuildIdentity(options: ResolveBuildIdentityOptions = {}): BuildIdentity {
  const configuredBuild = options.configuredBuild === undefined ? process.env.RISU_BUILD_ID : options.configuredBuild
  if (typeof configuredBuild === 'string' && BUILD_ID_PATTERN.test(configuredBuild)) {
    return { build: configuredBuild, source: 'env', locationsTrusted: true }
  }

  const requestedSourceRoot = path.resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const requestedCached = gitIdentityBySourceRoot.get(requestedSourceRoot)
  if (requestedCached) return requestedCached
  let sourceRoot: string
  try {
    sourceRoot = realpathSync(requestedSourceRoot)
  } catch {
    const unknown = { build: 'unknown', source: 'unknown', locationsTrusted: false } as const
    gitIdentityBySourceRoot.set(requestedSourceRoot, unknown)
    return unknown
  }
  const cached = gitIdentityBySourceRoot.get(sourceRoot)
  if (cached) return cached

  const gitTopLevel = gitOutput(sourceRoot, ['rev-parse', '--show-toplevel'])
  let repositoryRoot: string
  try {
    if (!gitTopLevel) throw new Error('Git top level unavailable')
    repositoryRoot = realpathSync(path.resolve(sourceRoot, gitTopLevel))
  } catch {
    const unknown = { build: 'unknown', source: 'unknown', locationsTrusted: false } as const
    gitIdentityBySourceRoot.set(sourceRoot, unknown)
    return unknown
  }
  if (repositoryRoot !== sourceRoot) {
    const unknown = { build: 'unknown', source: 'unknown', locationsTrusted: false } as const
    gitIdentityBySourceRoot.set(sourceRoot, unknown)
    return unknown
  }

  const build = gitOutput(sourceRoot, ['rev-parse', 'HEAD'])
  if (!build || !BUILD_ID_PATTERN.test(build)) {
    const unknown = { build: 'unknown', source: 'unknown', locationsTrusted: false } as const
    gitIdentityBySourceRoot.set(sourceRoot, unknown)
    return unknown
  }

  const status = gitOutput(sourceRoot, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'])
  const commitSecondsOutput = gitOutput(sourceRoot, ['log', '-1', '--format=%ct'])
  const commitSeconds =
    commitSecondsOutput && /^\d+$/.test(commitSecondsOutput) ? Number(commitSecondsOutput) : undefined
  const commitTime = commitSeconds === undefined ? undefined : commitSeconds * 1_000

  const identity: BuildIdentity = {
    build,
    source: 'git',
    locationsTrusted: status === '',
    ...(status === undefined ? {} : { dirty: status.length > 0 }),
    ...(commitTime !== undefined && Number.isSafeInteger(commitTime) ? { commitTime } : {}),
  }
  gitIdentityBySourceRoot.set(sourceRoot, identity)
  return identity
}
