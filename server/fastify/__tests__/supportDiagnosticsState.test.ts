import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import {
  isSupportDiagnosticsStateResponse,
  SUPPORT_DIAGNOSTICS_STATE_ENDPOINT,
} from '@risuai/protocol/remote-diagnostics'
import { buildApp, type BuiltApp } from '../src/app.js'
import { mintSupportDiagnosticsCredential } from '../src/supportDiagnosticsAuth.js'
import { readRemoteDiagnosticsConfig } from '../../../util/diagnostics-remote.js'
import { setupAuthedClient } from './helpers/auth.js'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const resolverPath = path.join(repositoryRoot, 'util/diagnostics-resolve-reference.ts')
const head = 'd'.repeat(40)
const canaries = {
  chatId: 'private-state-chat-7f3a',
  characterId: 'private-state-character-91b0',
  session: 'private-state-session-c4d2',
  hub: 'https://private-state-hub.invalid',
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})

async function start(): Promise<{ built: BuiltApp; token: string; dataDir: string; root: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'risu-support-state-'))
  const privateDir = path.join(root, 'private')
  mkdirSync(privateDir, { mode: 0o700 })
  const verifierFile = path.join(privateDir, 'verifier.json')
  const credentialFile = path.join(privateDir, 'remote.json')
  await mintSupportDiagnosticsCredential({ verifierFile, credentialFile, origin: 'https://synthetic.invalid' })
  const dataDir = path.join(root, 'data')
  const built = await buildApp({
    buildIdentity: { build: head, source: 'git', locationsTrusted: false, dirty: true, commitTime: 1_790_000_000_000 },
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: canaries.hub,
      staticRoot: null,
      clientDiagnostics: true,
      supportDiagnostics: { enabled: true, verifierFile },
    },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    // The maintenance sweep would settle the expired claims this test seeds.
    generationEffectMaintenance: false,
  })
  cleanup.push(async () => {
    await built.app.close()
    rmSync(root, { recursive: true, force: true })
  })
  await built.app.ready()
  await built.diagnostics.ready
  return { built, token: readRemoteDiagnosticsConfig(credentialFile).token, dataDir, root }
}

function resolveReference(dataDir: string, ref: string, kind?: string) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolveResult) => {
    execFile(
      process.execPath,
      ['--import', 'tsx/esm', resolverPath, '--data-dir', dataDir, '--ref', ref, ...(kind ? ['--kind', kind] : [])],
      { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, stdout, stderr }),
    )
  })
}

it('serves a validated content-free state snapshot whose opaque references resolve only on the host', async () => {
  vi.stubEnv('LOG_LEVEL', 'silent')
  vi.stubEnv('RISU_PROTOCOL_METRICS', '0')
  const { built, token, dataDir } = await start()
  const authorization = { authorization: `Bearer ${token}` }

  const unauthenticated = await built.app.inject({ url: SUPPORT_DIAGNOSTICS_STATE_ENDPOINT })
  expect(unauthenticated.statusCode).toBe(401)
  expect(unauthenticated.headers['cache-control']).toBe('no-store')
  expect(unauthenticated.json()).toEqual({ error: 'unauthorized' })
  const queried = await built.app.inject({
    url: `${SUPPORT_DIAGNOSTICS_STATE_ENDPOINT}?limit=1`,
    headers: authorization,
  })
  expect(queried.statusCode).toBe(400)
  expect(queried.json()).toEqual({ error: 'invalid-query' })

  // A lease row is persisted state the snapshot must describe without naming the chat.
  const db = new DatabaseSync(path.join(dataDir, 'risu.db'))
  try {
    const lineage = (db.prepare('SELECT lineage FROM database_metadata WHERE id = 1').get() as { lineage: string })
      .lineage
    const now = Date.now()
    db.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, ?, ?)').run(canaries.characterId, 0, '{}')
    db.prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, ?, ?)').run(
      canaries.chatId,
      canaries.characterId,
      0,
      '{}',
    )
    db.prepare(
      `INSERT INTO chat_occupancies (chat_id, database_lineage, occupant_session_id, occupancy_epoch, claim_class,
         claimed_at_ms, lease_expires_at_ms, updated_at_ms, released_at_ms)
       VALUES (?, ?, ?, 1, 'owner', ?, ?, ?, NULL)`,
    ).run(canaries.chatId, lineage, canaries.session, now, now + 3_600_000, now)
    // Claimed effect rows: a live durable lease, an expired durable lease that
    // can pin the chat, an abandoned ephemeral claim, and one pending row.
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
    const insertEffect = db.prepare(
      `INSERT INTO generation_effects (database_lineage, key_type, key_id, effect_kind, effect_class, generation_id,
         character_id, chat_id, message_id, status, claim_id, delivery, created_at, claimed_at, lease_expires_at, updated_at)
       VALUES (?, 'generation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const effectRows: Array<[string, string, string, string | null, string | null, string | null]> = [
      ['igp', 'durable', 'claimed', 'claim-igp', 'live_terminal', iso(300_000)],
      ['plugin_output', 'durable', 'claimed', 'claim-plugin', 'live_terminal', iso(300_000)],
      ['generated_translation', 'durable', 'claimed', 'claim-translation', 'server', iso(-1)],
      ['notification', 'ephemeral', 'claimed', 'claim-notification', 'live_terminal', iso(-60_000)],
      ['tts', 'ephemeral', 'pending', null, null, null],
    ]
    for (const [kind, effectClass, status, claimId, delivery, leaseExpiresAt] of effectRows) {
      insertEffect.run(
        lineage,
        'private-state-generation-2c1e',
        kind,
        effectClass,
        'private-state-generation-2c1e',
        canaries.characterId,
        canaries.chatId,
        'private-state-message-5d9f',
        status,
        claimId,
        delivery,
        iso(-120_000),
        claimId === null ? null : iso(-120_000),
        leaseExpiresAt,
        iso(-120_000),
      )
    }
  } finally {
    db.close()
  }

  const { assertion } = await setupAuthedClient(built.app)
  const missingJob = await built.app.inject({
    url: '/api/v1/generate/chat/private-missing-job/stream',
    headers: { 'risu-auth': assertion },
  })
  expect(missingJob.statusCode).toBe(404)
  expect(missingJob.json()).toMatchObject({ error: 'generation_job_not_found' })

  const response = await built.app.inject({ url: SUPPORT_DIAGNOSTICS_STATE_ENDPOINT, headers: authorization })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  for (const secret of [...Object.values(canaries), dataDir, token]) expect(response.body).not.toContain(secret)
  const state: unknown = response.json()
  if (!isSupportDiagnosticsStateResponse(state)) throw new Error('expected a validated state snapshot')
  expect(state.identity).toEqual({ build: head, instanceId: state.identity.instanceId })
  expect(state.deployment).toMatchObject({
    buildSource: 'git',
    locationsTrusted: false,
    dirty: true,
    commitTime: 1_790_000_000_000,
  })
  expect(state.config).toMatchObject({
    hub: 'custom',
    supportDiagnostics: true,
    diagnostics: true,
    trustProxy: 'disabled',
  })
  expect(state.journal).toMatchObject({ source: 'journal', available: true })
  expect(state.rejections.byCode.generation_job_not_found).toBeGreaterThanOrEqual(1)
  expect(state.generation.effects).toEqual({ pending: 1, claimed: 4, completed: 0, skipped: 0, failed: 0 })
  expect(state.generation.effectClaims).toEqual({
    durableLive: 2,
    durableExpired: 1,
    nonDurable: 1,
    byKind: {
      igp: 1,
      plugin_output: 1,
      generated_translation: 1,
      notification: 1,
      tts: 0,
      completion_sound: 0,
      emotion_image_state: 0,
    },
  })
  expect(state.occupancy.counts).toEqual({ occupied: 1, expired: 0, released: 0 })
  expect(state.occupancy.leases).toHaveLength(1)
  const lease = state.occupancy.leases[0]
  expect(lease).toMatchObject({ state: 'occupied', claimClass: 'owner', epoch: 1 })
  expect(lease.chat).toMatch(/^[a-f0-9]{32}$/)

  const resolved = await resolveReference(dataDir, lease.chat, 'chat')
  expect(resolved).toEqual({
    code: 0,
    stderr: '',
    stdout: `${JSON.stringify({ kind: 'chat', id: canaries.chatId })}\n`,
  })
  const unknown = await resolveReference(dataDir, '0'.repeat(32))
  expect(unknown).toEqual({ code: 0, stderr: '', stdout: 'not-found\n' })
})
