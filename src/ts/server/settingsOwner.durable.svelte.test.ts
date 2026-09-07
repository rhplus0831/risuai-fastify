import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import type { NAIImgConfig } from '../storage/database.svelte'

const recorded = vi.hoisted(() => ({
  dispatched: [] as Array<{ key: string; mutationId: string; intent: unknown }>,
  patches: [] as Array<Record<string, unknown>>,
  patchResults: [] as Array<{ status: 'ok'; revision: number } | { status: 'unavailable' }>,
  settlementListeners: new Map<string, Set<(settlement: 'accepted' | 'discarded') => void>>(),
  objectPatches: [] as Array<{
    baseRevision: number
    group: string
    key: string
    update: { patch: Record<string, unknown>; deleteKeys?: string[] }
    attemptedObject: Record<string, unknown>
    optimisticProjectionEpoch: number
  }>,
}))
vi.mock('./commands', () => ({
  canUseServerCommands: () => true,
  patchSettingsObjectFieldsCommand: vi.fn(
    async (args: {
      baseRevision: number
      group: string
      key: string
      update: { patch: Record<string, unknown>; deleteKeys?: string[] }
      attemptedObject: Record<string, unknown>
      optimisticProjectionEpoch: number
    }) => {
      recorded.objectPatches.push(args)
      return {
        status: 'ok',
        revision: args.baseRevision + 1,
        event: {
          type: 'settings.updated',
          revision: args.baseRevision + 1,
          resource: 'settings',
          id: args.group,
        },
        group: args.group,
        key: args.key,
        certificate: 'settings-object-patch-v1',
        patchedKeys: Object.keys(args.update.patch),
        deletedKeys: args.update.deleteKeys ?? [],
        canonicalValues: {},
        canonicalDeletedKeys: [],
      }
    },
  ),
  patchServerBackedSettings: vi.fn(async (args: { patch: Record<string, unknown> }) => {
    recorded.patches.push(args.patch)
    return recorded.patchResults.shift() ?? { status: 'ok', revision: 1 }
  }),
  runServerCommand: vi.fn(
    async (args: { command: (baseRevision: number) => Promise<{ status: string }>; rollback?: () => void }) => {
      const result = await args.command(1)
      if (result.status !== 'ok') args.rollback?.()
      return result
    },
  ),
  settingsGroupForKey: (key: string) => {
    if (key === 'NAIImgConfig') return 'media'
    if (key === 'notification') return 'display'
    if (key === 'textTheme') return 'display'
    if (key === 'useAutoSuggestions') return 'sidebar'
    if (key === 'authRefreshes') return 'providers'
    return null
  },
}))

vi.mock('./durableMutationDispatch', () => ({
  registerDurableMutationSettlementListener: vi.fn(
    (mutationId: string, listener: (settlement: 'accepted' | 'discarded') => void) => {
      const listeners = recorded.settlementListeners.get(mutationId) ?? new Set()
      listeners.add(listener)
      recorded.settlementListeners.set(mutationId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) recorded.settlementListeners.delete(mutationId)
      }
    },
  ),
  dispatchDurableMutation: vi.fn(
    async (
      handle: { key: string; mutationId: string },
      intent: unknown,
      dispatch: (options: Record<string, unknown>) => Promise<unknown>,
    ) => {
      recorded.dispatched.push({ key: handle.key, mutationId: handle.mutationId, intent })
      return dispatch({
        mutationId: handle.mutationId,
        databaseLineage: 'database-settings-bridge',
        failureRollbackDisposition: () => 'retain',
      })
    },
  ),
}))

vi.mock('./resourceReads', () => ({
  fetchServerSettingsGroup: vi.fn(async () => ({ status: 'error', error: 'test' })),
}))

vi.mock('../alert', () => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
}))

vi.mock('../process/templates/templates', () => ({
  prebuiltPresets: {
    OAI: {
      mainPrompt: 'default main prompt',
      jailbreak: 'default jailbreak',
    },
    OAI2: {
      apiType: 'preset-api',
      temperature: 0.75,
      mainPrompt: 'preset prompt',
      maxContext: 16_000,
      maxResponse: 1_000,
    },
  },
}))

import type { Database } from '../storage/database.svelte'
import '../stores.svelte'
import { applySettingsResource, applySettingsGroupResource, replaceResourceDatabase } from './resourceState.svelte'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  registerPendingMutationDiscardListener,
  resetPendingMutationOutboxForTests,
  type PendingMutationOutboxEntry,
} from './pendingMutationOutbox'
import { SETTINGS_BRIDGE_MUTATION_KEY } from './settingsMutationKey'
import { resetRegisteredOwnerState } from './pendingOwnerMutationRegistry'
import {
  applyServerBackedSettingsPatch,
  createServerBackedSettingDraft,
  dispatchDurableServerBackedSettingsPatch,
  flushPendingSettingsOwnerMutations,
  resetSettingsOwnerForDatabaseReplacement,
  type ServerBackedSettingDraft,
} from './settingsOwner.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const LONG_DELAY = 60_000

function createSettingsOwnerDraft<T>(
  key: string,
  fallback: T,
): { draft: ServerBackedSettingDraft<T>; stop: () => void } {
  let draft: ServerBackedSettingDraft<T> | undefined
  const stop = $effect.root(() => {
    draft = createServerBackedSettingDraft(key, fallback, { delayMs: LONG_DELAY })
  })
  flushSync()
  if (!draft) {
    stop()
    throw new Error('setting owner draft was not initialized')
  }
  return { draft, stop }
}

registerPendingMutationDiscardListener((mutationId) => {
  for (const listener of [...(recorded.settlementListeners.get(mutationId) ?? [])]) listener('discarded')
})

const testDatabaseState = {
  get db() {
    return getResourceDatabase()
  },
  set db(value: Database) {
    replaceResourceDatabase(value)
  },
}

function setupSettings(settings: Record<string, unknown>): void {
  ;(testDatabaseState as { db: unknown }).db = { ...settings }
}

async function markOnlyPendingMutationAsRemotelyStarted(): Promise<PendingMutationOutboxEntry> {
  let pending: PendingMutationOutboxEntry[] = []
  await vi.waitFor(async () => {
    pending = await listPendingMutations()
    expect(pending).toHaveLength(1)
  })
  await expect(beginPendingMutationDispatch(pending[0].handle)).resolves.toBe('persisted')
  return pending[0]
}

async function expectMarkerWinnerAndSuccessor(
  predecessor: PendingMutationOutboxEntry,
): Promise<PendingMutationOutboxEntry[]> {
  let pending: PendingMutationOutboxEntry[] = []
  await vi.waitFor(async () => {
    pending = await listPendingMutations()
    expect(pending).toHaveLength(2)
  })
  expect(pending.map((entry) => entry.handle.key)).toEqual([SETTINGS_BRIDGE_MUTATION_KEY, SETTINGS_BRIDGE_MUTATION_KEY])
  expect(pending[0].handle.mutationId).toBe(predecessor.handle.mutationId)
  expect(pending[1].handle.mutationId).not.toBe(predecessor.handle.mutationId)
  return pending
}

beforeEach(async () => {
  resetClientSessionForTests()
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox({
    writerSessionId: 'writer-settings-bridge',
    writerEpoch: 7,
    databaseLineage: 'database-settings-bridge',
    requestedWriterWasActive: true,
  })
  recorded.dispatched.length = 0
  recorded.patches.length = 0
  recorded.patchResults.length = 0
  recorded.settlementListeners.clear()
  recorded.objectPatches.length = 0
})

afterEach(async () => {
  flushPendingSettingsOwnerMutations()
  await Promise.resolve()
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
  ;(testDatabaseState as { db: unknown }).db = {}
  resetClientSessionForTests()
  vi.unstubAllGlobals()
})

describe('settings owner durable marker ordering', () => {
  it.each(['patch', 'sparse'] as const)(
    'preserves the dormant encrypted %s row while a new writer starts a separate edit',
    async (kind) => {
      await preparePendingMutationOutbox({
        writerSessionId: 'draft-test-session',
        writerEpoch: 1,
        databaseLineage: 'draft-test-lineage',
        requestedWriterWasActive: true,
      })
      setupSettings({ textTheme: 'before', notification: false, NAIImgConfig: { steps: 10, scale: 1 } })
      enterClientWriter()
      const old = createSettingsOwnerDraft<unknown>(kind === 'patch' ? 'textTheme' : 'NAIImgConfig', null)
      let current: ReturnType<typeof createSettingsOwnerDraft<unknown>> | undefined
      try {
        old.draft.value = kind === 'patch' ? 'old intent' : { steps: 20, scale: 1 }
        flushSync()
        let original: PendingMutationOutboxEntry[] = []
        await vi.waitFor(async () => {
          original = await listPendingMutations()
          expect(original).toHaveLength(1)
        })
        demoteClientSession()
        const authoritative = {
          textTheme: 'server text',
          notification: false,
          NAIImgConfig: { steps: 30, scale: 1 } as NAIImgConfig,
        }
        expect(applySettingsResource({ revision: 1, settings: authoritative })).toBe(true)
        flushSync()
        expect(testDatabaseState.db.textTheme).toBe('server text')
        expect(testDatabaseState.db.NAIImgConfig).toEqual({ steps: 30, scale: 1 })
        repromoteClientWriter()
        expect(
          applySettingsGroupResource(
            { revision: 2, group: kind === 'patch' ? 'display' : 'media', settings: authoritative },
            kind === 'patch' ? ['textTheme', 'notification'] : ['NAIImgConfig'],
          ),
        ).toBe(true)
        current = createSettingsOwnerDraft<unknown>(kind === 'patch' ? 'notification' : 'NAIImgConfig', null)
        current.draft.value = kind === 'patch' ? true : { steps: 30, scale: 2 }
        flushSync()
        let pending: PendingMutationOutboxEntry[] = []
        await vi.waitFor(async () => {
          pending = await listPendingMutations()
          expect(pending).toHaveLength(2)
        })
        expect(pending.find(({ handle }) => handle.mutationId === original[0].handle.mutationId)?.intent).toEqual(
          original[0].intent,
        )
        const newIntent = pending.find(({ handle }) => handle.mutationId !== original[0].handle.mutationId)!.intent
        expect(newIntent.requests[0].body).toEqual(
          kind === 'patch' ? { patch: { notification: true } } : { patch: { scale: 2 } },
        )
        expect(testDatabaseState.db.textTheme).toBe('server text')
        expect(recorded.dispatched).toEqual([])
      } finally {
        old.stop()
        current?.stop()
        resetSettingsOwnerForDatabaseReplacement()
      }
    },
  )

  it('drops a queued old-lineage overlay before applying restored settings', async () => {
    setupSettings({ textTheme: 'before' })
    recorded.patchResults.push({ status: 'unavailable' })

    applyServerBackedSettingsPatch({ textTheme: 'queued' })
    await vi.waitFor(() => expect(recorded.dispatched).toHaveLength(1))
    await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))
    await vi.waitFor(() => expect(recorded.settlementListeners.size).toBe(1))

    expect(applySettingsResource({ revision: 1, settings: { textTheme: 'server-before' } })).toBe(true)
    expect(testDatabaseState.db.textTheme).toBe('queued')

    await expect(
      preparePendingMutationOutbox({
        writerSessionId: 'writer-settings-bridge',
        writerEpoch: 7,
        databaseLineage: 'database-restored',
        requestedWriterWasActive: true,
        onOwnershipChange: resetRegisteredOwnerState,
      }),
    ).resolves.toEqual({ discarded: 1 })

    expect(recorded.settlementListeners.size).toBe(0)
    expect(await listPendingMutations()).toEqual([])
    expect(applySettingsResource({ revision: 2, settings: { textTheme: 'restored' } })).toBe(true)
    expect(testDatabaseState.db.textTheme).toBe('restored')
  })

  it('stages caller-owned optimistic settings patches before dispatch', async () => {
    const authRefreshes = [
      {
        url: 'https://mcp.example/messages',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        tokenUrl: 'https://mcp.example/token',
      },
    ]

    await dispatchDurableServerBackedSettingsPatch({
      patch: { authRefreshes },
      acknowledgeOptimistic: true,
    })

    expect(recorded.dispatched).toHaveLength(1)
    expect(recorded.dispatched[0]).toMatchObject({
      key: SETTINGS_BRIDGE_MUTATION_KEY,
      intent: {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/providers',
            body: { patch: { authRefreshes } },
          },
        ],
      },
    })
    expect(recorded.patches).toEqual([{ authRefreshes }])
  })

  it('retains a remotely marked scalar edit ahead of an immediate total-revert correction', async () => {
    setupSettings({ notification: false })
    const { draft, stop } = createSettingsOwnerDraft('notification', false)
    try {
      draft.value = true
      flushSync()
      const predecessor = await markOnlyPendingMutationAsRemotelyStarted()

      draft.value = false
      flushSync()
      expect(recorded.dispatched).toHaveLength(1)

      const pending = await expectMarkerWinnerAndSuccessor(predecessor)
      expect(pending.map((entry) => entry.intent)).toEqual([
        {
          version: 1,
          requests: [
            {
              method: 'PATCH',
              path: '/settings/display',
              body: { patch: { notification: true } },
            },
          ],
        },
        {
          version: 1,
          requests: [
            {
              method: 'PATCH',
              path: '/settings/display',
              body: { patch: { notification: false } },
            },
          ],
        },
      ])
      expect(recorded.patches).toEqual([{ notification: false }])
    } finally {
      stop()
    }
  })

  it('retains a remotely marked scalar edit ahead of a partial-revert absolute closure', async () => {
    setupSettings({ notification: false, useAutoSuggestions: false })
    const notification = createSettingsOwnerDraft('notification', false)
    try {
      notification.draft.value = true
      flushSync()
      const predecessor = await markOnlyPendingMutationAsRemotelyStarted()

      applyServerBackedSettingsPatch({ notification: false, useAutoSuggestions: true })
      await vi.waitFor(() => expect(recorded.dispatched).toHaveLength(1))

      const pending = await expectMarkerWinnerAndSuccessor(predecessor)
      expect(pending[1].intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/sidebar',
            body: { patch: { useAutoSuggestions: true } },
          },
          {
            method: 'PATCH',
            path: '/settings/display',
            body: { patch: { notification: false } },
          },
        ],
      })
      expect(recorded.patches).toEqual([{ useAutoSuggestions: true, notification: false }])
    } finally {
      notification.stop()
    }
  })

  it('retains a remotely marked sparse edit ahead of an immediate total-revert correction', async () => {
    const original = { width: 512, height: 768 }
    setupSettings({ NAIImgConfig: original })
    const { draft, stop } = createSettingsOwnerDraft('NAIImgConfig', original)
    try {
      draft.value = { ...original, width: 832 }
      flushSync()
      const predecessor = await markOnlyPendingMutationAsRemotelyStarted()

      draft.value = original
      flushSync()
      expect(recorded.dispatched).toHaveLength(1)

      const pending = await expectMarkerWinnerAndSuccessor(predecessor)
      expect(pending.map((entry) => entry.intent)).toEqual([
        {
          version: 1,
          requests: [
            {
              method: 'PATCH',
              path: '/settings/media/objects/NAIImgConfig',
              body: { patch: { width: 832 } },
            },
          ],
        },
        {
          version: 1,
          requests: [
            {
              method: 'PATCH',
              path: '/settings/media/objects/NAIImgConfig',
              body: { patch: { width: 512 } },
            },
          ],
        },
      ])
      expect(recorded.objectPatches.at(-1)).toMatchObject({
        update: { patch: { width: 512 } },
        attemptedObject: original,
      })
    } finally {
      stop()
    }
  })

  it('retains a marked sparse edit ahead of a partial closure with an explicit delete correction', async () => {
    const original = { width: 512, height: 768 }
    setupSettings({ NAIImgConfig: original })
    const { draft, stop } = createSettingsOwnerDraft('NAIImgConfig', original)
    try {
      draft.value = {
        ...original,
        width: 832,
        temporary: 'staged value',
      } as any
      flushSync()
      const predecessor = await markOnlyPendingMutationAsRemotelyStarted()

      draft.value = {
        ...original,
        width: 832,
        height: 1024,
      }
      flushSync()
      expect(recorded.dispatched).toHaveLength(0)
      flushPendingSettingsOwnerMutations()

      const pending = await expectMarkerWinnerAndSuccessor(predecessor)
      expect(pending[1].intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/media/objects/NAIImgConfig',
            body: {
              patch: { width: 832, height: 1024 },
              deleteKeys: ['temporary'],
            },
          },
        ],
      })
      expect(recorded.objectPatches.at(-1)).toMatchObject({
        update: {
          patch: { width: 832, height: 1024 },
          deleteKeys: ['temporary'],
        },
        attemptedObject: { ...original, width: 832, height: 1024 },
      })
    } finally {
      stop()
    }
  })
})
