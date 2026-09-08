import path from 'node:path'
import process from 'node:process'
import net from 'node:net'
import fs from 'node:fs'
import { DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES } from './generation/generationTraceSidecar.js'

export interface AppConfig {
  /** Client-visible content-free diagnostics; trace modes enable this by default. */
  clientDiagnostics?: boolean
  supportDiagnostics?: { enabled: boolean; verifierFile?: string }
  host: string
  port: number
  dataDir: string
  /** Explicitly accept creating risu.db when the data directory shows prior-use evidence. */
  allowMissingDatabase?: boolean
  bodyLimit: number
  /**
   * Max upload size for device backup imports (`.risu.zip` / legacy `.bin`).
   * Decoupled from `bodyLimit` because full backups (database + all assets) are
   * routinely far larger than ordinary request bodies; the import streams the
   * upload to disk and decodes it in bounded batches rather than buffering it.
   *
   * Defaults to unlimited (`Number.POSITIVE_INFINITY`) so multi-GB backups (large
   * assets push real backups well past 4 GiB) import without per-deployment
   * tuning — peak memory stays bounded regardless of file size. Set
   * `RISU_API_IMPORT_MAX_BYTES` to a positive byte count to impose a ceiling.
   */
  importMaxBytes: number
  /**
   * Maximum number of automatic safety snapshots retained before destructive
   * whole-database imports/restores. Manual backups are never counted.
   */
  automaticBackupRetention?: number
  realmImportMaxExpandedBytes?: number
  trustProxy: boolean | number | string
  staticRoot?: string | null
  hubUrl: string
  realmUrl?: string
  /**
   * Agent-only development escape hatch. When enabled, protected routes accept
   * requests without password setup/login so automated agents can inspect the
   * app without getting stuck at the first-run auth prompt.
   */
  agentDevAuthBypass?: boolean
  /**
   * Development-only request tracing. When enabled, every response gets a
   * request UID and API requests are appended to dataDir/trace/<mode>.jsonl.
   */
  requestTrace?: {
    mode: RequestTraceMode
    bodySidecarMaxGzipBytes?: number
    entryLimit?: number
  }
  generationTrace?: {
    fullPrompt: boolean
    maxGzipBytes: number
  }
}

export type RequestTraceMode = 'agent' | 'human'

export const DEFAULT_AUTOMATIC_BACKUP_RETENTION = 3
export const DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES = 310 * 1024 * 1024

function repoRoot(): string {
  return process.cwd()
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid RISU_API_PORT: ${raw}`)
  }
  return n
}

function parseBodyLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid RISU_API_BODY_LIMIT: ${raw}`)
  }
  return Math.floor(n)
}

function parsePositiveInteger(raw: string | undefined, fallback: number, envName: string): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${envName}: ${raw}`)
  }
  return n
}

function parseImportMaxBytes(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  // Explicit opt-out: the import streams to disk with bounded memory, so a
  // self-host owner can lift the ceiling entirely for very large backups.
  const normalized = raw.trim().toLowerCase()
  if (normalized === '0' || normalized === 'unlimited' || normalized === 'none' || normalized === 'infinity') {
    return Number.POSITIVE_INFINITY
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid RISU_API_IMPORT_MAX_BYTES: ${raw}`)
  }
  return Math.floor(n)
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw) return false
  const n = Number(raw)
  if (Number.isInteger(n)) return n
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

function parseStaticRoot(raw: string | undefined, fallback: string): string | null {
  if (raw === undefined) return fallback
  if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'off') {
    return null
  }
  return path.resolve(raw)
}

function parseHubUrl(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol must be http or https')
    }
    return raw.replace(/\/+$/, '')
  } catch (err) {
    throw new Error(`Invalid RISU_HUB_URL: ${raw} (${(err as Error).message})`)
  }
}

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function parseRequestTraceMode(raw: string | undefined): RequestTraceMode | undefined {
  if (!raw) return undefined
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'agent' || normalized === 'human') {
    return normalized
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'none') {
    return undefined
  }
  throw new Error(`Invalid RISU_API_TRACE_MODE: ${raw}`)
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (net.isIPv4(normalized)) return normalized.startsWith('127.')
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

export function assertAgentDevAuthBypassHost(config: Pick<AppConfig, 'agentDevAuthBypass' | 'host'>): void {
  if (config.agentDevAuthBypass === true && !isLoopbackHost(config.host)) {
    throw new Error('RISU_AGENT_DEV_AUTH_BYPASS requires a loopback RISU_API_HOST')
  }
}

/** Reject secret locations that application file/static/backup surfaces can own. */
export function assertSupportDiagnosticsConfig(
  config: Pick<AppConfig, 'supportDiagnostics' | 'dataDir' | 'staticRoot'>,
): void {
  const support = config.supportDiagnostics
  if (!support?.enabled) return
  if (!support.verifierFile || !path.isAbsolute(support.verifierFile))
    throw new Error('Invalid support diagnostics configuration')
  const canonical = (input: string): string => {
    const absolute = path.resolve(input)
    if (fs.existsSync(absolute)) return fs.realpathSync(absolute)
    const parent = path.dirname(absolute)
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute))
  }
  const verifier = canonical(support.verifierFile)
  for (const root of [process.cwd(), config.dataDir, config.staticRoot].filter((root): root is string =>
    Boolean(root),
  )) {
    const relative = path.relative(canonical(root), verifier)
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Invalid support diagnostics configuration')
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.RISU_API_DATA_DIR ? path.resolve(env.RISU_API_DATA_DIR) : path.join(repoRoot(), 'data')
  const requestTraceMode = parseRequestTraceMode(env.RISU_API_TRACE_MODE)
  const generationTraceFullPrompt = env.RISU_GENERATION_TRACE_FULL_PROMPT === '1'
  const generationTraceMaxGzipBytes = parsePositiveInteger(
    env.RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES,
    DEFAULT_GENERATION_TRACE_MAX_GZIP_BYTES,
    'RISU_GENERATION_TRACE_FULL_PROMPT_MAX_GZIP_BYTES',
  )

  const config: AppConfig = {
    host: env.RISU_API_HOST ?? '0.0.0.0',
    port: parsePort(env.RISU_API_PORT, 6002),
    dataDir,
    allowMissingDatabase: parseBoolean(env.RISU_API_ALLOW_MISSING_DATABASE),
    bodyLimit: parseBodyLimit(env.RISU_API_BODY_LIMIT, 100 * 1024 * 1024),
    importMaxBytes: parseImportMaxBytes(env.RISU_API_IMPORT_MAX_BYTES, Number.POSITIVE_INFINITY),
    automaticBackupRetention: parsePositiveInteger(
      env.RISU_API_AUTOMATIC_BACKUP_RETENTION,
      DEFAULT_AUTOMATIC_BACKUP_RETENTION,
      'RISU_API_AUTOMATIC_BACKUP_RETENTION',
    ),
    realmImportMaxExpandedBytes: parsePositiveInteger(
      env.RISU_REALM_IMPORT_MAX_EXPANDED_BYTES,
      DEFAULT_REALM_IMPORT_MAX_EXPANDED_BYTES,
      'RISU_REALM_IMPORT_MAX_EXPANDED_BYTES',
    ),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    staticRoot: parseStaticRoot(env.RISU_API_STATIC_ROOT, path.join(repoRoot(), 'dist')),
    hubUrl: parseHubUrl(env.RISU_HUB_URL, 'https://sv.risuai.xyz'),
    realmUrl: parseHubUrl(env.RISU_REALM_URL, 'https://realm.risuai.net'),
    agentDevAuthBypass: parseBoolean(env.RISU_AGENT_DEV_AUTH_BYPASS),
    requestTrace: requestTraceMode ? { mode: requestTraceMode } : undefined,
    clientDiagnostics:
      env.RISU_CLIENT_DIAGNOSTICS === undefined ? Boolean(requestTraceMode) : parseBoolean(env.RISU_CLIENT_DIAGNOSTICS),
    supportDiagnostics: {
      enabled: env.RISU_SUPPORT_DIAGNOSTICS === '1',
      verifierFile: env.RISU_SUPPORT_DIAGNOSTICS_VERIFIER,
    },
    generationTrace: {
      fullPrompt: generationTraceFullPrompt,
      maxGzipBytes: generationTraceMaxGzipBytes,
    },
  }
  assertAgentDevAuthBypassHost(config)
  if (env.RISU_SUPPORT_DIAGNOSTICS !== undefined && !['0', '1'].includes(env.RISU_SUPPORT_DIAGNOSTICS))
    throw new Error('Invalid support diagnostics configuration')
  assertSupportDiagnosticsConfig(config)
  return config
}
