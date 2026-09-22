/** @module-tag core */
// @vitest-environment happy-dom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeClientWriterRecovery,
  beginClientSession,
  completeClientWriterRecovery,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
} from '../clientSession'
import { currentPluginDatabaseSnapshot } from '../pluginCommands'
import {
  clearPendingMutationOutbox,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from '../server/pendingMutationOutbox'
import { clearCachedServerCommandRevision, setCachedServerCommandRevision, type CommandEvent } from '../server/commands'
import { setDatabaseLite, type Database } from '../storage/database.svelte'
import { getV2PluginAPIs } from './plugins.svelte'

interface CapturedRequest {
  url: string
  method: string
  body: Record<string, unknown> | null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function captureCommandRequests(): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      if (url === '/api/v1/auth/status') return jsonResponse({ authorized: true })
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      })
      const event: CommandEvent = {
        type: 'plugin.compat.updated',
        revision: 11,
        resource: 'plugin',
      } as CommandEvent
      return jsonResponse({ revision: 11, event })
    }) as unknown as typeof fetch,
  )
  return requests
}

beforeEach(async () => {
  resetClientSessionForTests()
  const operation = beginClientSession('h42-writer')
  expect(
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'h42-lineage',
      writer: { sessionId: 'h42-writer', epoch: 1 },
    }),
  ).toBe(true)
  setClientConnectionState('live')
  setClientProjectionReady(true)
  expect(completeClientWriterRecovery(operation)).toBe(true)
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'h42-writer',
    writerEpoch: 1,
    databaseLineage: 'h42-lineage',
    requestedWriterWasActive: true,
  })
  clearCachedServerCommandRevision()
  setCachedServerCommandRevision(10)
  setDatabaseLite(
    {
      characters: [],
      characterOrder: [],
      currentChar: -1,
      plugins: [],
      pluginCustomStorage: {},
      modules: [],
      enabledModules: [],
      currentPluginProvider: '',
    } as unknown as Database,
    10,
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  clearCachedServerCommandRevision()
  resetClientSessionForTests()
})

describe('plugin database bridge', () => {
  it('blocks protected server-mode keys while persisting an unprotected plugin key', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const requests = captureCommandRequests()
    const apis = getV2PluginAPIs()

    await expect(
      apis.setDatabaseLite({ pluginV2: [{ name: 'H42_PROTECTED_PLUGIN_SENTINEL' }] }),
    ).resolves.toBeUndefined()

    const protectedProjection = currentPluginDatabaseSnapshot()
    expect(protectedProjection).not.toHaveProperty('pluginV2')
    expect(protectedProjection.pluginCustomStorage).not.toHaveProperty('pluginV2')
    expect(requests).toEqual([])
    expect(warning).toHaveBeenCalledWith(
      '[plugin db bridge] Ignored unsupported database keys in server-backed mode: ' +
        'pluginV2. Use the dedicated plugin/module/storage APIs or settings instead.',
    )

    const persistence = apis.setDatabaseLite({ h42PluginKey: { value: 'H42_UNPROTECTED_VALUE_SENTINEL' } })
    void persistence.catch(() => undefined)

    await vi.waitFor(() => {
      expect(requests.some(({ url }) => url === '/api/v1/commands/plugin-storage/bulk')).toBe(true)
    })
    await expect(persistence).resolves.toBeUndefined()

    expect(currentPluginDatabaseSnapshot().pluginCustomStorage).toMatchObject({
      h42PluginKey: { value: 'H42_UNPROTECTED_VALUE_SENTINEL' },
    })
    expect(requests).toContainEqual({
      url: '/api/v1/commands/plugin-storage/bulk',
      method: 'POST',
      body: expect.objectContaining({
        baseRevision: 10,
        values: { h42PluginKey: { value: 'H42_UNPROTECTED_VALUE_SENTINEL' } },
      }),
    })
  })
})
