import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { setupAuthedClient } from './helpers/auth.js'

const dataDirs: string[] = []
const apps: FastifyInstance[] = []

async function build(enabled: boolean, existingDataDir?: string): Promise<{ app: FastifyInstance; dataDir: string }> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'risu-chat-occupancy-routes-'))
  if (existingDataDir === undefined) dataDirs.push(dataDir)
  const built = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    chatOccupancy: { enabled },
    memoryWorker: false,
    bardWikiWorker: false,
    assetGc: false,
    generationChat: { finalizationRetry: false },
  })
  apps.push(built.app)
  return { app: built.app, dataDir }
}

async function start(enabled: boolean): Promise<{ app: FastifyInstance; assertion: string; dataDir: string }> {
  const { app, dataDir } = await build(enabled)
  const { assertion } = await setupAuthedClient(app)
  return { app, assertion, dataDir }
}

async function closeApp(app: FastifyInstance): Promise<void> {
  const index = apps.indexOf(app)
  if (index >= 0) apps.splice(index, 1)
  await app.close()
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  for (const dataDir of dataDirs.splice(0)) rmSync(dataDir, { recursive: true, force: true })
})

async function seedChats(app: FastifyInstance, assertion: string): Promise<void> {
  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: {
      database: {
        characters: [
          {
            chaId: 'character-a',
            name: 'Ada',
            chats: [
              { id: 'chat-a', message: [] },
              { id: 'chat-b', message: [] },
              { id: 'chat-c', message: [] },
            ],
          },
        ],
      },
    },
  })
  expect(imported.statusCode).toBe(200)
}

describe('chat occupancy routes', () => {
  it('advertises v1 disabled by default and fails closed for new claims', async () => {
    const { app, assertion } = await start(false)
    await seedChats(app, assertion)
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    const body = bootstrap.json()

    expect(body.chatOccupancyProtocol).toEqual({ version: 1, enabled: false, leaseMs: 90_000, renewAfterMs: 30_000 })
    expect(body.chatOccupancies).toEqual({ version: 1, databaseLineage: body.databaseLineage, occupancies: [] })

    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'reader-a',
        'risu-database-lineage': body.databaseLineage,
        'risu-chat-occupancy-epoch': '0',
      },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    expect(claim.statusCode).toBe(426)
    expect(claim.json()).toMatchObject({
      error: 'chat_occupancy_protocol_required',
      supportedVersion: 1,
      enabled: false,
    })
  })

  it('admits owner and chat-only sessions without granting the reader active-writer authority', async () => {
    const { app, assertion } = await start(true)
    await seedChats(app, assertion)
    const ownerBootstrap = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'owner-a' },
    })
    const { databaseLineage, revision } = ownerBootstrap.json()
    const baseHeaders = { 'risu-auth': assertion, 'risu-database-lineage': databaseLineage }

    const ownerA = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: { ...baseHeaders, 'risu-writer-session': 'owner-a', 'risu-chat-occupancy-epoch': '0' },
      payload: { version: 1, claimClass: 'owner' },
    })
    const ownerB = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-b/claim',
      headers: { ...baseHeaders, 'risu-writer-session': 'owner-a', 'risu-chat-occupancy-epoch': '0' },
      payload: { version: 1, claimClass: 'owner' },
    })
    const reader = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-c/claim',
      headers: { ...baseHeaders, 'risu-writer-session': 'reader-a', 'risu-chat-occupancy-epoch': '0' },
      payload: { version: 1, claimClass: 'chat_only' },
    })

    expect([ownerA.statusCode, ownerB.statusCode, reader.statusCode]).toEqual([200, 200, 200])
    expect(reader.json()).toMatchObject({ chatId: 'chat-c', occupantSessionId: 'reader-a', claimClass: 'chat_only' })

    const releasedOwnerB = await app.inject({
      method: 'DELETE',
      url: '/api/v1/chat-occupancies/chat-b',
      headers: {
        ...baseHeaders,
        'risu-writer-session': 'owner-a',
        'risu-chat-occupancy-epoch': String(ownerB.json().occupancyEpoch),
      },
      payload: { version: 1 },
    })
    expect(releasedOwnerB.json()).toMatchObject({ chatId: 'chat-b', state: 'released' })

    const renewedReader = await app.inject({
      method: 'PUT',
      url: '/api/v1/chat-occupancies/chat-c/lease',
      headers: {
        ...baseHeaders,
        'risu-writer-session': 'reader-a',
        'risu-chat-occupancy-epoch': String(reader.json().occupancyEpoch),
      },
      payload: { version: 1 },
    })
    expect(renewedReader.statusCode).toBe(200)
    expect(renewedReader.json().occupancyEpoch).toBe(reader.json().occupancyEpoch)

    const switchedReader = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/switch',
      headers: {
        ...baseHeaders,
        'risu-writer-session': 'reader-a',
        'risu-chat-occupancy-epoch': String(reader.json().occupancyEpoch),
      },
      payload: { version: 1, sourceChatId: 'chat-c', targetChatId: 'chat-b' },
    })
    expect(switchedReader.statusCode).toBe(200)
    expect(switchedReader.json()).toMatchObject({ chatId: 'chat-b', occupantSessionId: 'reader-a' })

    const after = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    expect(after.json().revision).toBe(revision)
    expect(after.json().writer.sessionId).toBe('owner-a')
    expect(after.json().chatOccupancies.occupancies).toHaveLength(3)
  })

  it('returns exact occupied and stale tuple envelopes', async () => {
    const { app, assertion } = await start(true)
    await seedChats(app, assertion)
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    const databaseLineage = bootstrap.json().databaseLineage
    const headers = { 'risu-auth': assertion, 'risu-database-lineage': databaseLineage }
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: { ...headers, 'risu-writer-session': 'reader-a', 'risu-chat-occupancy-epoch': '0' },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    const occupancyEpoch = claimed.json().occupancyEpoch

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: {
        ...headers,
        'risu-writer-session': 'reader-b',
        'risu-chat-occupancy-epoch': String(occupancyEpoch),
      },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    expect(foreign.statusCode).toBe(423)
    expect(foreign.json()).toMatchObject({ error: 'chat_occupied', chatId: 'chat-a', safeRelease: expect.any(String) })

    const staleRelease = await app.inject({
      method: 'DELETE',
      url: '/api/v1/chat-occupancies/chat-a',
      headers: {
        ...headers,
        'risu-writer-session': 'reader-a',
        'risu-chat-occupancy-epoch': String(occupancyEpoch + 1),
      },
      payload: { version: 1 },
    })
    expect(staleRelease.statusCode).toBe(409)
    expect(staleRelease.json()).toMatchObject({
      error: 'chat_occupancy_stale',
      current: { chatId: 'chat-a', occupancyEpoch },
    })
  })

  it('does not renew or release retained authority after authentication is lost', async () => {
    const { app, assertion } = await start(true)
    await seedChats(app, assertion)
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    const databaseLineage = bootstrap.json().databaseLineage
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: {
        'risu-auth': assertion,
        'risu-writer-session': 'reader-a',
        'risu-database-lineage': databaseLineage,
        'risu-chat-occupancy-epoch': '0',
      },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    expect(claimed.statusCode).toBe(200)
    const occupancyEpoch = claimed.json().occupancyEpoch
    const unauthenticatedHeaders = {
      'risu-writer-session': 'reader-a',
      'risu-database-lineage': databaseLineage,
      'risu-chat-occupancy-epoch': String(occupancyEpoch),
    }

    const [renewed, released] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/api/v1/chat-occupancies/chat-a/lease',
        headers: unauthenticatedHeaders,
        payload: { version: 1 },
      }),
      app.inject({
        method: 'DELETE',
        url: '/api/v1/chat-occupancies/chat-a',
        headers: unauthenticatedHeaders,
        payload: { version: 1 },
      }),
    ])
    expect([renewed.statusCode, released.statusCode]).toEqual([401, 401])

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/chat-occupancies',
      headers: { 'risu-auth': assertion },
    })
    expect(snapshot.json().occupancies).toContainEqual(
      expect.objectContaining({
        chatId: 'chat-a',
        occupantSessionId: 'reader-a',
        occupancyEpoch,
        state: 'occupied',
      }),
    )
  })

  it('serializes simultaneous claims to one winner without changing domain revision', async () => {
    const { app, assertion } = await start(true)
    await seedChats(app, assertion)
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    const { databaseLineage, revision } = bootstrap.json()
    const claim = (sessionId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/chat-occupancies/chat-a/claim',
        headers: {
          'risu-auth': assertion,
          'risu-writer-session': sessionId,
          'risu-database-lineage': databaseLineage,
          'risu-chat-occupancy-epoch': '0',
        },
        payload: { version: 1, claimClass: 'chat_only' },
      })

    const responses = await Promise.all([claim('reader-a'), claim('reader-b')])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/chat-occupancies',
      headers: { 'risu-auth': assertion },
    })
    expect(snapshot.json()).toMatchObject({
      version: 1,
      databaseLineage,
      occupancies: [{ chatId: 'chat-a', state: 'occupied', occupancyEpoch: 1 }],
    })
    const after = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    expect(after.json().revision).toBe(revision)
  })

  it('serializes a release racing a foreign claim and requires the loser to refresh the tombstone epoch', async () => {
    const { app, assertion } = await start(true)
    await seedChats(app, assertion)
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    const { databaseLineage, revision } = bootstrap.json()
    const baseHeaders = { 'risu-auth': assertion, 'risu-database-lineage': databaseLineage }
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: {
        ...baseHeaders,
        'risu-writer-session': 'reader-a',
        'risu-chat-occupancy-epoch': '0',
      },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    const firstEpoch = first.json().occupancyEpoch

    const [released, racedClaim] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: '/api/v1/chat-occupancies/chat-a',
        headers: {
          ...baseHeaders,
          'risu-writer-session': 'reader-a',
          'risu-chat-occupancy-epoch': String(firstEpoch),
        },
        payload: { version: 1 },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/chat-occupancies/chat-a/claim',
        headers: {
          ...baseHeaders,
          'risu-writer-session': 'reader-b',
          'risu-chat-occupancy-epoch': String(firstEpoch),
        },
        payload: { version: 1, claimClass: 'chat_only' },
      }),
    ])
    expect(released.statusCode).toBe(200)
    expect([409, 423]).toContain(racedClaim.statusCode)

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/chat-occupancies',
      headers: { 'risu-auth': assertion },
    })
    const tombstone = snapshot.json().occupancies.find((row: { chatId: string }) => row.chatId === 'chat-a')
    expect(tombstone).toMatchObject({
      occupantSessionId: null,
      occupancyEpoch: firstEpoch + 1,
      state: 'released',
    })

    const retried = await app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-a/claim',
      headers: {
        ...baseHeaders,
        'risu-writer-session': 'reader-b',
        'risu-chat-occupancy-epoch': String(tombstone.occupancyEpoch),
      },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    expect(retried.statusCode).toBe(200)
    expect(retried.json()).toMatchObject({
      occupantSessionId: 'reader-b',
      occupancyEpoch: firstEpoch + 2,
    })
    const after = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { 'risu-auth': assertion } })
    expect(after.json().revision).toBe(revision)
  })

  it('drains existing authority after an enabled-to-disabled restart while refusing new claims', async () => {
    const started = await start(true)
    await seedChats(started.app, started.assertion)
    const ownerBootstrap = await started.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': started.assertion, 'risu-writer-session': 'owner-a' },
    })
    const { databaseLineage, revision } = ownerBootstrap.json()
    const headers = { 'risu-auth': started.assertion, 'risu-database-lineage': databaseLineage }
    const claimOwner = (chatId: string) =>
      started.app.inject({
        method: 'POST',
        url: `/api/v1/chat-occupancies/${chatId}/claim`,
        headers: { ...headers, 'risu-writer-session': 'owner-a', 'risu-chat-occupancy-epoch': '0' },
        payload: { version: 1, claimClass: 'owner' },
      })
    const [ownerA, ownerB] = await Promise.all([claimOwner('chat-a'), claimOwner('chat-b')])
    expect([ownerA.statusCode, ownerB.statusCode]).toEqual([200, 200])
    const demotion = await started.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': started.assertion, 'risu-writer-session': 'owner-b' },
    })
    expect(demotion.statusCode).toBe(200)

    await closeApp(started.app)
    const restarted = await build(false, started.dataDir)
    const exactHeaders = {
      ...headers,
      'risu-writer-session': 'owner-a',
      'risu-chat-occupancy-epoch': String(ownerB.json().occupancyEpoch),
    }
    const renewed = await restarted.app.inject({
      method: 'PUT',
      url: '/api/v1/chat-occupancies/chat-b/lease',
      headers: exactHeaders,
      payload: { version: 1 },
    })
    expect(renewed.statusCode).toBe(200)

    const normalized = await restarted.app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/normalize',
      headers: exactHeaders,
      payload: { version: 1, selectedChatId: 'chat-b' },
    })
    expect(normalized.statusCode).toBe(200)
    expect(normalized.json()).toMatchObject({ claimClass: 'chat_only', occupancyEpoch: ownerB.json().occupancyEpoch })

    const released = await restarted.app.inject({
      method: 'DELETE',
      url: '/api/v1/chat-occupancies/chat-b',
      headers: exactHeaders,
      payload: { version: 1 },
    })
    expect(released.statusCode).toBe(200)
    expect(released.json().state).toBe('released')

    const refused = await restarted.app.inject({
      method: 'POST',
      url: '/api/v1/chat-occupancies/chat-c/claim',
      headers: { ...headers, 'risu-writer-session': 'owner-a', 'risu-chat-occupancy-epoch': '0' },
      payload: { version: 1, claimClass: 'chat_only' },
    })
    expect(refused.statusCode).toBe(426)
    expect(refused.json()).toMatchObject({ error: 'chat_occupancy_protocol_required', enabled: false })

    const after = await restarted.app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': started.assertion },
    })
    expect(after.json().revision).toBe(revision)
    expect(after.json().chatOccupancyProtocol.enabled).toBe(false)
    expect(after.json().chatOccupancies.occupancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: 'chat-a', state: 'released' }),
        expect.objectContaining({ chatId: 'chat-b', state: 'released' }),
      ]),
    )
  })
})
