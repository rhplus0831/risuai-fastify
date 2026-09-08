import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SUPPORT_DIAGNOSTICS_MAX_CREDENTIALS = 16
export const SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000
export const SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS = 24 * 60 * 60 * 1000
const MAX_VERIFIER_BYTES = 16 * 1024
const MAX_TIMESTAMP = 8_640_000_000_000_000
const CREDENTIAL_ID = /^[a-f0-9]{32}$/
const DIGEST = /^[a-f0-9]{64}$/
const EMPTY_DIGEST = Buffer.alloc(32)

export interface SupportDiagnosticsCredentialRecord {
  id: string
  digest: string
  createdAt: number
  expiresAt: number
  revokedAt: number | null
}

export interface SupportDiagnosticsVerifier {
  version: 1
  credentials: SupportDiagnosticsCredentialRecord[]
}

type CredentialErrorCode =
  | 'invalid-configuration'
  | 'invalid-verifier'
  | 'credential-limit'
  | 'credential-not-found'
  | 'credential-inactive'
  | 'credential-file-exists'
  | 'operation-in-progress'
  | 'storage-unavailable'

/** Only fixed categories cross the operator boundary; filesystem errors contain private paths. */
export class SupportDiagnosticsCredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code)
    this.name = 'SupportDiagnosticsCredentialError'
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
}

function validVerifier(value: unknown): value is SupportDiagnosticsVerifier {
  if (
    !hasExactKeys(value, ['version', 'credentials']) ||
    value.version !== 1 ||
    !Array.isArray(value.credentials) ||
    value.credentials.length > SUPPORT_DIAGNOSTICS_MAX_CREDENTIALS
  ) {
    return false
  }
  const ids = new Set<string>()
  const digests = new Set<string>()
  for (const record of value.credentials) {
    if (
      !hasExactKeys(record, ['id', 'digest', 'createdAt', 'expiresAt', 'revokedAt']) ||
      typeof record.id !== 'string' ||
      !CREDENTIAL_ID.test(record.id) ||
      typeof record.digest !== 'string' ||
      !DIGEST.test(record.digest) ||
      ids.has(record.id) ||
      digests.has(record.digest) ||
      !isTimestamp(record.createdAt) ||
      !isTimestamp(record.expiresAt) ||
      record.expiresAt <= record.createdAt ||
      record.expiresAt - record.createdAt > SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS ||
      (record.revokedAt !== null && (!isTimestamp(record.revokedAt) || record.revokedAt < record.createdAt))
    ) {
      return false
    }
    ids.add(record.id)
    digests.add(record.digest)
  }
  return true
}

function error(code: CredentialErrorCode): never {
  throw new SupportDiagnosticsCredentialError(code)
}

function filesystemCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined
}

function validatePath(file: string): void {
  if (!file || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file) || path.normalize(file) !== file) {
    error('invalid-configuration')
  }
}

async function requirePrivateParent(file: string): Promise<void> {
  validatePath(file)
  const parent = path.dirname(file)
  const info = await lstat(parent)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (await realpath(parent)) !== parent) {
    error('invalid-configuration')
  }
}

async function readVerifier(file: string, allowMissing = false): Promise<SupportDiagnosticsVerifier> {
  await requirePrivateParent(file)
  let handle
  try {
    // O_NONBLOCK avoids waiting on a FIFO before fstat can reject it.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (cause) {
    if (allowMissing && filesystemCode(cause) === 'ENOENT') return { version: 1, credentials: [] }
    throw cause
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > MAX_VERIFIER_BYTES || info.nlink !== 1) {
      error('invalid-verifier')
    }
    // Bound actual reads as well as fstat: a file could grow after the size check.
    const bytes = Buffer.alloc(MAX_VERIFIER_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_VERIFIER_BYTES) error('invalid-verifier')
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    } catch {
      error('invalid-verifier')
    }
    if (!validVerifier(parsed)) error('invalid-verifier')
    return parsed
  } finally {
    await handle.close()
  }
}

/** This verifier is intentionally independent of ordinary application authentication. */
export async function verifySupportDiagnosticsAuthorization(
  authorization: unknown,
  verifierFile: string,
  now = Date.now(),
): Promise<boolean> {
  if (typeof authorization !== 'string' || !isTimestamp(now)) return false
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization)
  if (!match) return false
  try {
    const verifier = await readVerifier(verifierFile)
    const candidate = createHash('sha256').update(match[1]).digest()
    let accepted = false
    // Always compare all slots, including inactive entries and padding. Neither
    // the matching record's index nor its lifecycle state short-circuits comparison.
    for (let index = 0; index < SUPPORT_DIAGNOSTICS_MAX_CREDENTIALS; index += 1) {
      const record = verifier.credentials[index]
      const matches = timingSafeEqual(candidate, record ? Buffer.from(record.digest, 'hex') : EMPTY_DIGEST)
      const active = record && record.revokedAt === null && record.createdAt <= now && record.expiresAt > now
      accepted = (matches && Boolean(active)) || accepted
    }
    return accepted
  } catch {
    return false
  }
}

export interface SupportDiagnosticsCredentialOptions {
  verifierFile: string
  credentialFile: string
  origin: string
  /** Defaults to 30 days; callers cannot exceed 90 days. */
  lifetimeMs?: number
  now?: number
}

function validateProvisioning(options: SupportDiagnosticsCredentialOptions): { now: number; lifetimeMs: number } {
  validatePath(options.verifierFile)
  validatePath(options.credentialFile)
  if (
    options.verifierFile === options.credentialFile ||
    options.credentialFile === `${options.verifierFile}.lock` ||
    typeof options.origin !== 'string' ||
    options.origin.length > 2048
  ) {
    error('invalid-configuration')
  }
  try {
    const origin = new URL(options.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.origin !== options.origin ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      error('invalid-configuration')
    }
  } catch {
    error('invalid-configuration')
  }
  const now = options.now ?? Date.now()
  const lifetimeMs = options.lifetimeMs ?? SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS
  if (
    !isTimestamp(now) ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS ||
    !isTimestamp(now + lifetimeMs)
  ) {
    error('invalid-configuration')
  }
  return { now, lifetimeMs }
}

async function createExclusiveFile(file: string, content: string): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.chmod(0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (cause) {
    await unlink(file).catch(() => undefined)
    throw cause
  } finally {
    await handle.close()
  }
}

async function writeVerifier(file: string, verifier: SupportDiagnosticsVerifier): Promise<void> {
  if (!validVerifier(verifier)) error('invalid-verifier')
  const temporary = path.join(path.dirname(file), `.diagnostics-verifier-${randomBytes(16).toString('hex')}.tmp`)
  await createExclusiveFile(temporary, `${JSON.stringify(verifier)}\n`)
  try {
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function withVerifierLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  try {
    await requirePrivateParent(file)
    const lockFile = `${file}.lock`
    let lock
    try {
      lock = await open(
        lockFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
    } catch (cause) {
      if (filesystemCode(cause) === 'EEXIST') error('operation-in-progress')
      throw cause
    }
    try {
      return await operation()
    } finally {
      await lock.close()
      await unlink(lockFile)
    }
  } catch (cause) {
    if (cause instanceof SupportDiagnosticsCredentialError) throw cause
    error('storage-unavailable')
  }
}

async function provisionCredential(
  options: SupportDiagnosticsCredentialOptions,
  rotate?: { credentialId: string; overlapMs: number },
): Promise<SupportDiagnosticsCredentialRecord> {
  const { now, lifetimeMs } = validateProvisioning(options)
  return withVerifierLock(options.verifierFile, async () => {
    await requirePrivateParent(options.credentialFile)
    const verifier = await readVerifier(options.verifierFile, !rotate)
    if (rotate) {
      const previous = verifier.credentials.find((record) => record.id === rotate.credentialId)
      if (!previous) error('credential-not-found')
      if (previous.revokedAt !== null || previous.createdAt > now || previous.expiresAt <= now) {
        error('credential-inactive')
      }
      // A zero-overlap rotation is revocation; preserve valid expiry metadata.
      if (rotate.overlapMs === 0) previous.revokedAt = now
      else previous.expiresAt = Math.min(previous.expiresAt, now + rotate.overlapMs)
    }
    verifier.credentials = verifier.credentials.filter((record) => record.revokedAt === null && record.expiresAt > now)
    if (verifier.credentials.length >= SUPPORT_DIAGNOSTICS_MAX_CREDENTIALS) error('credential-limit')
    const token = randomBytes(32).toString('hex')
    const record: SupportDiagnosticsCredentialRecord = {
      id: randomBytes(16).toString('hex'),
      digest: createHash('sha256').update(token).digest('hex'),
      createdAt: now,
      expiresAt: now + lifetimeMs,
      revokedAt: null,
    }
    verifier.credentials.push(record)
    try {
      await createExclusiveFile(
        options.credentialFile,
        `${JSON.stringify({ version: 1, origin: options.origin, token })}\n`,
      )
    } catch (cause) {
      if (filesystemCode(cause) === 'EEXIST') error('credential-file-exists')
      throw cause
    }
    try {
      await writeVerifier(options.verifierFile, verifier)
    } catch (cause) {
      await unlink(options.credentialFile).catch(() => undefined)
      throw cause
    }
    return { ...record }
  })
}

/** The original token is written only to a new private file, never returned. */
export async function mintSupportDiagnosticsCredential(
  options: SupportDiagnosticsCredentialOptions,
): Promise<SupportDiagnosticsCredentialRecord> {
  return provisionCredential(options)
}

export async function rotateSupportDiagnosticsCredential(
  options: SupportDiagnosticsCredentialOptions & { credentialId: string; overlapMs?: number },
): Promise<SupportDiagnosticsCredentialRecord> {
  const overlapMs = options.overlapMs ?? SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS
  if (
    !CREDENTIAL_ID.test(options.credentialId) ||
    !Number.isSafeInteger(overlapMs) ||
    overlapMs < 0 ||
    overlapMs > SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS
  ) {
    error('invalid-configuration')
  }
  return provisionCredential(options, { credentialId: options.credentialId, overlapMs })
}

export async function revokeSupportDiagnosticsCredential(
  verifierFile: string,
  credentialId: string,
  now = Date.now(),
): Promise<void> {
  if (!CREDENTIAL_ID.test(credentialId) || !isTimestamp(now)) error('invalid-configuration')
  return withVerifierLock(verifierFile, async () => {
    const verifier = await readVerifier(verifierFile)
    const record = verifier.credentials.find((entry) => entry.id === credentialId)
    if (!record) error('credential-not-found')
    if (now < record.createdAt) error('invalid-configuration')
    if (record.revokedAt === null) {
      record.revokedAt = now
      await writeVerifier(verifierFile, verifier)
    }
  })
}
