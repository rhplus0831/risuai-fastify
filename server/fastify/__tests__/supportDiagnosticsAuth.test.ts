import { createHash, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintSupportDiagnosticsCredential,
  revokeSupportDiagnosticsCredential,
  rotateSupportDiagnosticsCredential,
  SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS,
  SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS,
  SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS,
  verifySupportDiagnosticsAuthorization,
  type SupportDiagnosticsVerifier,
} from '../src/supportDiagnosticsAuth.js'
import { runDiagnosticsCredentialCli } from '../../../util/diagnostics-credential.js'

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) }
})

const NOW = 1_700_000_000_000
const ORIGIN = 'https://diagnostics.example.invalid'
const PRIVATE_CANARY = 'PRIVATE_CHAT_PRESET_HEADER_ERROR_CANARY'
let directory: string
let verifierFile: string
let credentialFile: string

async function credential(file = credentialFile): Promise<{ version: 1; origin: string; token: string }> {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function verifier(): Promise<SupportDiagnosticsVerifier> {
  return JSON.parse(await readFile(verifierFile, 'utf8'))
}

async function mint(file = credentialFile, extra: { now?: number; lifetimeMs?: number } = {}) {
  const record = await mintSupportDiagnosticsCredential({
    verifierFile,
    credentialFile: file,
    origin: ORIGIN,
    now: NOW,
    ...extra,
  })
  return { record, token: (await credential(file)).token }
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'risu-support-auth-'))
  await chmod(directory, 0o700)
  verifierFile = path.join(directory, 'verifier.json')
  credentialFile = path.join(directory, 'remote.json')
  vi.mocked(timingSafeEqual).mockClear()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('dedicated support diagnostics credentials', () => {
  it('writes an exclusive private credential and only a digest with bounded lifecycle metadata in the verifier', async () => {
    const { record, token } = await mint()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(record.id).toMatch(/^[a-f0-9]{32}$/)
    expect(record).toEqual({
      id: record.id,
      digest: createHash('sha256').update(token).digest('hex'),
      createdAt: NOW,
      expiresAt: NOW + SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS,
      revokedAt: null,
    })
    expect(await credential()).toEqual({ version: 1, origin: ORIGIN, token })
    expect(await verifier()).toEqual({ version: 1, credentials: [record] })
    expect(await readFile(verifierFile, 'utf8')).not.toContain(token)
    expect(JSON.stringify(record)).not.toContain(token)
    expect((await stat(credentialFile)).mode & 0o777).toBe(0o600)
    expect((await stat(verifierFile)).mode & 0o777).toBe(0o600)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile, NOW)).toBe(true)
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['verifier.json', 'remote.json']))
    expect((await readdir(directory)).length).toBe(2)
  })

  it('denies before creation and at exact expiration, and re-reads revocation on the next authorization', async () => {
    const { record, token } = await mint()
    const authorization = `Bearer ${token}`
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW - 1)).toBe(false)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, record.expiresAt - 1)).toBe(true)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, record.expiresAt)).toBe(false)
    await revokeSupportDiagnosticsCredential(verifierFile, record.id, NOW + 1)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW + 1)).toBe(false)
    expect((await verifier()).credentials[0].revokedAt).toBe(NOW + 1)
    await revokeSupportDiagnosticsCredential(verifierFile, record.id, NOW + 2)
    expect((await verifier()).credentials[0].revokedAt).toBe(NOW + 1)
  })

  it('compares every fixed-size digest slot for valid, mismatched, and revoked well-formed tokens', async () => {
    const { record, token } = await mint()
    for (const candidate of [token, 'a'.repeat(64)]) {
      vi.mocked(timingSafeEqual).mockClear()
      await verifySupportDiagnosticsAuthorization(`Bearer ${candidate}`, verifierFile, NOW)
      expect(timingSafeEqual).toHaveBeenCalledTimes(16)
      for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls) {
        expect(left.byteLength).toBe(32)
        expect(right.byteLength).toBe(32)
      }
    }
    await revokeSupportDiagnosticsCredential(verifierFile, record.id, NOW)
    vi.mocked(timingSafeEqual).mockClear()
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile, NOW)).toBe(false)
    expect(timingSafeEqual).toHaveBeenCalledTimes(16)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    123,
    '',
    'Bearer',
    `Bearer ${PRIVATE_CANARY}`,
    `Bearer ${'a'.repeat(65)}`,
    `Bearer ${'a'.repeat(63)}`,
    `Bearer ${'g'.repeat(64)}`,
    `Bearer ${'a'.repeat(64)}\n`,
    'session.ordinary.application.token',
  ])('fails closed for malformed authorization %#', async (authorization) => {
    await mint()
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW)).toBe(false)
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })

  it('fails closed for missing verifier, invalid clock, malformed JSON and excessive file bytes', async () => {
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${'a'.repeat(64)}`, verifierFile, NOW)).toBe(false)
    const { token } = await mint()
    for (const now of [NaN, Infinity, -1, NOW + 0.5]) {
      expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile, now)).toBe(false)
    }
    for (const raw of [PRIVATE_CANARY, '[]', '{}', ' '.repeat(16 * 1024 + 1)]) {
      await writeFile(verifierFile, raw)
      expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile, NOW)).toBe(false)
    }
  })

  it('rejects extra fields, malformed metadata, duplicate identities, and overfull registries as a whole', async () => {
    const { record, token } = await mint()
    const bad = [
      { version: 2, credentials: [record] },
      { version: 1, credentials: [record], label: PRIVATE_CANARY },
      { version: 1, credentials: [{ ...record, token }] },
      { version: 1, credentials: [{ ...record, label: PRIVATE_CANARY }] },
      { version: 1, credentials: [{ ...record, id: PRIVATE_CANARY }] },
      { version: 1, credentials: [{ ...record, digest: 'a' }] },
      { version: 1, credentials: [{ ...record, createdAt: -1 }] },
      { version: 1, credentials: [{ ...record, expiresAt: NOW }] },
      { version: 1, credentials: [{ ...record, expiresAt: NOW + SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS + 1 }] },
      { version: 1, credentials: [{ ...record, revokedAt: NOW - 1 }] },
      { version: 1, credentials: [{ ...record, revokedAt: PRIVATE_CANARY }] },
      { version: 1, credentials: [record, record] },
      { version: 1, credentials: [record, { ...record, id: 'a'.repeat(32) }] },
      { version: 1, credentials: [record, { ...record, digest: 'a'.repeat(64) }] },
      { version: 1, credentials: Array.from({ length: 17 }, () => record) },
    ]
    for (const value of bad) {
      await writeFile(verifierFile, JSON.stringify(value))
      expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile, NOW)).toBe(false)
    }
    expect(timingSafeEqual).not.toHaveBeenCalled()
  })

  it('denies symlink, hardlink, insecure file and insecure parent verifier storage', async () => {
    const { token } = await mint()
    const authorization = `Bearer ${token}`
    const alias = path.join(directory, 'alias.json')
    await symlink(verifierFile, alias)
    expect(await verifySupportDiagnosticsAuthorization(authorization, alias, NOW)).toBe(false)
    await rm(alias)
    await link(verifierFile, alias)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW)).toBe(false)
    await rm(alias)
    await chmod(verifierFile, 0o644)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW)).toBe(false)
    await chmod(verifierFile, 0o600)
    await chmod(directory, 0o755)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW)).toBe(false)
    await chmod(directory, 0o700)
    expect(await verifySupportDiagnosticsAuthorization(authorization, verifierFile, NOW)).toBe(true)
  })

  it('rotates with at most 24 hours of overlap and a new independent full-lifetime credential', async () => {
    const first = await mint()
    const nextFile = path.join(directory, 'next.json')
    const next = await rotateSupportDiagnosticsCredential({
      verifierFile,
      credentialFile: nextFile,
      credentialId: first.record.id,
      origin: ORIGIN,
      now: NOW + 1000,
    })
    const nextToken = (await credential(nextFile)).token
    expect(next.id).not.toBe(first.record.id)
    expect(nextToken).not.toBe(first.token)
    expect(next.expiresAt).toBe(NOW + 1000 + SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS)
    const overlapEnd = NOW + 1000 + SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS
    expect((await verifier()).credentials[0].expiresAt).toBe(overlapEnd)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${first.token}`, verifierFile, overlapEnd - 1)).toBe(
      true,
    )
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${first.token}`, verifierFile, overlapEnd)).toBe(false)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${nextToken}`, verifierFile, overlapEnd)).toBe(true)
  })

  it('never extends the original expiry and permits immediate rotation without overlap', async () => {
    const first = await mint(credentialFile, { lifetimeMs: 5000 })
    const nextFile = path.join(directory, 'next.json')
    const next = await rotateSupportDiagnosticsCredential({
      verifierFile,
      credentialFile: nextFile,
      credentialId: first.record.id,
      origin: ORIGIN,
      now: NOW + 1000,
    })
    expect((await verifier()).credentials[0].expiresAt).toBe(NOW + 5000)
    await rotateSupportDiagnosticsCredential({
      verifierFile,
      credentialFile: path.join(directory, 'third.json'),
      credentialId: next.id,
      origin: ORIGIN,
      now: NOW + 2000,
      overlapMs: 0,
    })
    expect(
      await verifySupportDiagnosticsAuthorization(
        `Bearer ${(await credential(nextFile)).token}`,
        verifierFile,
        NOW + 2000,
      ),
    ).toBe(false)
  })

  it('cannot rotate expired, revoked or missing credentials back into authority', async () => {
    const first = await mint(credentialFile, { lifetimeMs: 5000 })
    const options = {
      verifierFile,
      credentialFile: path.join(directory, 'next.json'),
      credentialId: first.record.id,
      origin: ORIGIN,
    }
    await expect(rotateSupportDiagnosticsCredential({ ...options, now: NOW + 5000 })).rejects.toThrow(
      'credential-inactive',
    )
    await revokeSupportDiagnosticsCredential(verifierFile, first.record.id, NOW)
    await expect(rotateSupportDiagnosticsCredential({ ...options, now: NOW })).rejects.toThrow('credential-inactive')
    await expect(
      rotateSupportDiagnosticsCredential({ ...options, credentialId: 'f'.repeat(32), now: NOW }),
    ).rejects.toThrow('credential-not-found')
    expect(await readdir(directory)).not.toContain('next.json')
  })

  it('bounds lifecycle configuration and emits no input or filesystem details on failure', async () => {
    const options = { verifierFile, credentialFile, origin: ORIGIN, now: NOW }
    for (const extra of [
      { lifetimeMs: 0 },
      { lifetimeMs: Infinity },
      { lifetimeMs: SUPPORT_DIAGNOSTICS_MAX_LIFETIME_MS + 1 },
      { now: NaN },
      { origin: `https://${PRIVATE_CANARY}@example.invalid` },
      { origin: `https://example.invalid/${PRIVATE_CANARY}` },
      { origin: 'http://example.invalid' },
      { origin: `${ORIGIN}/` },
      { credentialFile: verifierFile },
      { credentialFile: `${verifierFile}.lock` },
      { verifierFile: PRIVATE_CANARY },
    ]) {
      await expect(mintSupportDiagnosticsCredential({ ...options, ...extra })).rejects.toThrow('invalid-configuration')
    }
    const { record } = await mint()
    for (const overlapMs of [-1, Infinity, SUPPORT_DIAGNOSTICS_MAX_OVERLAP_MS + 1]) {
      await expect(
        rotateSupportDiagnosticsCredential({ ...options, credentialId: record.id, overlapMs }),
      ).rejects.toThrow('invalid-configuration')
    }
    await expect(revokeSupportDiagnosticsCredential(verifierFile, PRIVATE_CANARY, NOW)).rejects.toThrow(
      'invalid-configuration',
    )
    await expect(revokeSupportDiagnosticsCredential(verifierFile, 'f'.repeat(32), NOW)).rejects.toThrow(
      'credential-not-found',
    )
  })

  it('does not overwrite plaintext files or change the verifier if output creation fails', async () => {
    const first = await mint()
    const previous = await readFile(verifierFile, 'utf8')
    await expect(mint()).rejects.toThrow('credential-file-exists')
    await expect(
      rotateSupportDiagnosticsCredential({
        verifierFile,
        credentialFile,
        origin: ORIGIN,
        credentialId: first.record.id,
        now: NOW,
      }),
    ).rejects.toThrow('credential-file-exists')
    expect(await readFile(verifierFile, 'utf8')).toBe(previous)
    expect((await credential()).token).toBe(first.token)
    const alias = path.join(directory, 'alias.json')
    await symlink(credentialFile, alias)
    await expect(mint(alias)).rejects.toThrow('credential-file-exists')
    expect((await credential()).token).toBe(first.token)
  })

  it('rejects symlinked credential parent directories', async () => {
    const actual = path.join(directory, 'actual')
    const alias = path.join(directory, 'alias')
    await mkdir(actual, { mode: 0o700 })
    await symlink(actual, alias)
    await expect(mint(path.join(alias, 'remote.json'))).rejects.toThrow('invalid-configuration')
    expect(await readdir(actual)).toEqual([])
  })

  it('caps stored records at 16 and reclaims expired or revoked slots only during operator provisioning', async () => {
    const entries = []
    for (let index = 0; index < 16; index += 1) {
      entries.push(await mint(path.join(directory, `remote-${index}.json`)))
    }
    await expect(mint()).rejects.toThrow('credential-limit')
    expect((await verifier()).credentials).toHaveLength(16)
    await revokeSupportDiagnosticsCredential(verifierFile, entries[0].record.id, NOW)
    const replacement = await mint()
    expect((await verifier()).credentials).toHaveLength(16)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${entries[0].token}`, verifierFile, NOW)).toBe(false)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${replacement.token}`, verifierFile, NOW)).toBe(true)
    await mint(path.join(directory, 'after-expiry.json'), { now: NOW + SUPPORT_DIAGNOSTICS_DEFAULT_LIFETIME_MS })
    expect((await verifier()).credentials).toHaveLength(1)
  })

  it('serializes operator mutations with an exclusive lock and never prints a locked-file canary', async () => {
    const results = await Promise.allSettled([
      mint(path.join(directory, 'first.json')),
      mint(path.join(directory, 'second.json')),
    ])
    const successes = results.filter((result) => result.status === 'fulfilled').length
    expect(successes).toBeGreaterThanOrEqual(1)
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.message).toBe('operation-in-progress')
    }
    expect((await verifier()).credentials).toHaveLength(successes)
    await writeFile(`${verifierFile}.lock`, PRIVATE_CANARY, { mode: 0o600 })
    await expect(mint()).rejects.toThrow('operation-in-progress')
    expect((await verifier()).credentials).toHaveLength(successes)
  })
})

describe('credential operator CLI', () => {
  function capture() {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
      stdout,
      stderr,
      output: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) },
    }
  }

  it('invokes the real CLI entrypoint without placing its generated credential on stdout or stderr', async () => {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../../../util/diagnostics-credential.ts', import.meta.url)), 'mint'],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: {
          PATH: process.env.PATH,
          RISU_SUPPORT_DIAGNOSTICS_VERIFIER: verifierFile,
          RISU_DIAGNOSTICS_REMOTE_CONFIG: credentialFile,
          RISU_DIAGNOSTICS_REMOTE_ORIGIN: ORIGIN,
        },
        timeout: 10_000,
        maxBuffer: 4096,
      },
    )
    expect(stdout).toBe('diagnostics-credential: created\n')
    expect(stderr).toBe('')
    const { token } = await credential()
    expect(`${stdout}${stderr}`).not.toContain(token)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${token}`, verifierFile)).toBe(true)
  })

  it('runs mint, rotate and revoke with fixed success output and keeps all tokens in private files', async () => {
    const env = {
      RISU_SUPPORT_DIAGNOSTICS_VERIFIER: verifierFile,
      RISU_DIAGNOSTICS_REMOTE_CONFIG: credentialFile,
      RISU_DIAGNOSTICS_REMOTE_ORIGIN: ORIGIN,
    }
    const { stdout, stderr, output } = capture()
    expect(await runDiagnosticsCredentialCli(['mint'], env, output)).toBe(0)
    const first = (await verifier()).credentials[0]
    const firstToken = (await credential()).token
    const nextFile = path.join(directory, 'next.json')
    expect(
      await runDiagnosticsCredentialCli(
        ['rotate', first.id],
        { ...env, RISU_DIAGNOSTICS_REMOTE_CONFIG: nextFile },
        output,
      ),
    ).toBe(0)
    expect(
      await runDiagnosticsCredentialCli(
        ['revoke', first.id],
        { RISU_SUPPORT_DIAGNOSTICS_VERIFIER: verifierFile },
        output,
      ),
    ).toBe(0)
    expect(stdout).toEqual([
      'diagnostics-credential: created\n',
      'diagnostics-credential: rotated\n',
      'diagnostics-credential: revoked\n',
    ])
    expect(stderr).toEqual([])
    expect(stdout.join('')).not.toContain(firstToken)
    expect(stdout.join('')).not.toContain((await credential(nextFile)).token)
    expect(stdout.join('')).not.toContain(directory)
    expect(await verifySupportDiagnosticsAuthorization(`Bearer ${firstToken}`, verifierFile)).toBe(false)
  })

  it('reports fixed errors without echoing invalid command arguments, origins, paths or credential canaries', async () => {
    const { stdout, stderr, output } = capture()
    for (const args of [[], ['mint', PRIVATE_CANARY], [PRIVATE_CANARY], ['rotate', PRIVATE_CANARY], ['revoke']]) {
      expect(await runDiagnosticsCredentialCli(args, {}, output)).toBe(1)
    }
    expect(await runDiagnosticsCredentialCli(['mint'], {}, output)).toBe(1)
    expect(
      await runDiagnosticsCredentialCli(
        ['mint'],
        {
          RISU_SUPPORT_DIAGNOSTICS_VERIFIER: path.join(directory, PRIVATE_CANARY, 'verifier.json'),
          RISU_DIAGNOSTICS_REMOTE_CONFIG: credentialFile,
          RISU_DIAGNOSTICS_REMOTE_ORIGIN: ORIGIN,
        },
        output,
      ),
    ).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr.slice(0, 5)).toEqual(Array(5).fill('diagnostics-credential: invalid-command\n'))
    expect(stderr.slice(5)).toEqual([
      'diagnostics-credential: invalid-configuration\n',
      'diagnostics-credential: storage-unavailable\n',
    ])
    expect(stderr.join('')).not.toContain(PRIVATE_CANARY)
    expect(stderr.join('')).not.toContain(directory)
  })

  it('rejects both verifier and plaintext destinations inside repository, data, and static roots', async () => {
    const base = {
      RISU_SUPPORT_DIAGNOSTICS_VERIFIER: verifierFile,
      RISU_DIAGNOSTICS_REMOTE_CONFIG: credentialFile,
      RISU_DIAGNOSTICS_REMOTE_ORIGIN: ORIGIN,
    }
    const { stdout, stderr, output } = capture()
    const forbidden = [
      { RISU_SUPPORT_DIAGNOSTICS_VERIFIER: path.join(process.cwd(), PRIVATE_CANARY, 'verifier.json') },
      { RISU_DIAGNOSTICS_REMOTE_CONFIG: path.join(process.cwd(), PRIVATE_CANARY, 'remote.json') },
      { RISU_API_DATA_DIR: directory },
      { RISU_API_STATIC_ROOT: directory },
    ]
    for (const env of forbidden) {
      expect(await runDiagnosticsCredentialCli(['mint'], { ...base, ...env }, output)).toBe(1)
    }
    expect(stdout).toEqual([])
    expect(stderr).toEqual(Array(4).fill('diagnostics-credential: invalid-configuration\n'))
    expect(await readdir(directory)).toEqual([])
    expect(stderr.join('')).not.toContain(PRIVATE_CANARY)
  })
})
