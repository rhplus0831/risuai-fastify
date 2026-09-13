import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import type { NAIImgConfig } from '../storage/database.svelte'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const durableSettingState = vi.hoisted(() => ({
  nextId: 0,
  retainFailures: false,
  stages: [] as Array<{ key: string; intent: Record<string, unknown>; handle: Record<string, any> }>,
  dispatches: [] as Array<{ handle: Record<string, any>; intent: Record<string, unknown> }>,
  acknowledgements: [] as Array<Record<string, any>>,
  settlementListeners: new Map<string, Set<(settlement: 'accepted' | 'discarded') => void>>(),
}))
const settingAlertMocks = vi.hoisted(() => ({
  alertError: vi.fn(),
}))
const writerAccessMocks = vi.hoisted(() => ({
  lost: false,
  report: vi.fn(() => writerAccessMocks.lost),
}))

vi.mock('../alert', async (importActual) => {
  const actual = await importActual<typeof import('../alert')>()
  return { ...actual, alertError: settingAlertMocks.alertError }
})

vi.mock('../server/activeWriterSession', async (importActual) => {
  const actual = await importActual<typeof import('../server/activeWriterSession')>()
  return { ...actual, reportWriterAccessLostMutation: writerAccessMocks.report }
})

vi.mock('../server/pendingMutationOutbox', () => ({
  stagePendingMutation: (key: string, intent: Record<string, unknown>, previous?: Record<string, any> | null) => {
    const reuse = previous?.phase === 'staged' && previous.key === key
    if (reuse) previous.phase = 'superseded'
    const handle = {
      key,
      mutationId: reuse ? previous!.mutationId : `renderer-mutation-${++durableSettingState.nextId}`,
      phase: 'staged',
      databaseLineage: 'renderer-test-lineage',
      ready: Promise.resolve('persisted'),
    }
    durableSettingState.stages.push({ key, intent: JSON.parse(JSON.stringify(intent)), handle })
    return handle
  },
  acknowledgePendingMutation: async (handle: Record<string, any>) => {
    durableSettingState.acknowledgements.push(handle)
    return 'deleted'
  },
}))

vi.mock('../server/durableMutationDispatch', () => ({
  registerDurableMutationSettlementListener: (
    mutationId: string,
    listener: (settlement: 'accepted' | 'discarded') => void,
  ) => {
    const listeners = durableSettingState.settlementListeners.get(mutationId) ?? new Set()
    listeners.add(listener)
    durableSettingState.settlementListeners.set(mutationId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) durableSettingState.settlementListeners.delete(mutationId)
    }
  },
  dispatchDurableMutation: async (
    handle: Record<string, any>,
    intent: Record<string, unknown>,
    dispatch: (transport: {
      mutationId: string
      databaseLineage: string
      failureRollbackDisposition: () => 'retain' | 'rollback'
    }) => Promise<unknown>,
  ) => {
    handle.phase = 'dispatching'
    durableSettingState.dispatches.push({ handle, intent: JSON.parse(JSON.stringify(intent)) })
    return dispatch({
      mutationId: handle.mutationId,
      databaseLineage: 'renderer-test-lineage',
      failureRollbackDisposition: () => (durableSettingState.retainFailures ? 'retain' : 'rollback'),
    })
  },
}))

vi.mock('../platform', async (importActual) => {
  const actual = await importActual<typeof import('../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'setting-auth-token',
}))

vi.mock('../process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../process/modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import {
  clearCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  settingsGroupForKey,
  type ServerCommandLocalEffect,
} from '../server/commands'
import {
  applySettingsResource,
  applySettingsGroupResource,
  applySettingsPatchLocalEffect,
  captureSettingsGroupProjectionEpoch,
  hasSettingsGroupProjectionEpochChanged,
  replaceResourceDatabase,
} from '../server/resourceState.svelte'

import { notifyServerCommandLocalEffectApplied } from '../server/commandLocalEffectEvents'
import { createDestructiveRefreshToken } from '../server/staleStateGuards'
import { language } from 'src/lang'
import { accessibilitySettingsItems } from './accessibilitySettingsData'
import { interactionSettingsItems } from './interactionSettingsData'
import { advancedSettingsItems } from './advancedSettingsData'
import {
  basicParameterItems,
  modelSpecificParameterItems,
  penaltyParameterItems,
  samplingParameterItems,
  seedSetting,
} from './botSettingsParamsData'
import { chatFormatSettingsItems } from './chatFormatSettingsData'
import {
  displayNonRendererServerSettingKeys,
  displayOtherSettingsItems,
  displaySettingsItems,
} from './displaySettingsData.svelte'
import { languageSettingsItems } from './languageSettingsData.svelte'
import { memorySettingsItems } from './memorySettingsData'
import { modelSupplementalSettingsItems } from './modelSupplementalSettingsData'
import { pluginSupplementalSettingsItems } from './pluginSupplementalSettingsData'
import { promptSupplementalSettingsItems } from './promptSupplementalSettingsData'
import type { SettingContext, SettingItem } from './types'
import {
  clearDeferredSettingWrites,
  DEFERRED_SETTING_INPUT_DELAY_MS,
  flushDeferredSettingWrites,
  setDeferredSettingValue,
  setSettingValue,
} from './utils'
import SettingInputDraftHarness from 'src/lib/Setting/testHarness/SettingInputDraftHarness.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

interface CapturedFetch {
  url: string
  method: string
  body: unknown
  keepalive?: boolean
}

const settingRendererItemSets: SettingItem[][] = [
  accessibilitySettingsItems,
  interactionSettingsItems,
  advancedSettingsItems,
  basicParameterItems,
  [seedSetting],
  samplingParameterItems,
  penaltyParameterItems,
  modelSpecificParameterItems,
  chatFormatSettingsItems,
  displaySettingsItems,
  languageSettingsItems,
  memorySettingsItems,
  modelSupplementalSettingsItems,
  pluginSupplementalSettingsItems,
  promptSupplementalSettingsItems,
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubSettingsFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        body,
        ...(init.keepalive ? { keepalive: true } : {}),
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
      if (url === '/api/v1/commands/settings/display') {
        return jsonResponse({ error: 'revision_conflict', currentRevision: 8 }, 409)
      }
      return jsonResponse({ revision: 9, event: { type: 'settings.updated' } })
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubSuccessfulSettingsFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        body,
        ...(init.keepalive ? { keepalive: true } : {}),
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
      return jsonResponse({ revision: 5, event: { type: 'settings.updated' } })
    }) as unknown as typeof fetch,
  )
  return calls
}

function deferredResponse(): {
  promise: Promise<Response>
  resolve: (response: Response) => void
} {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function collectSettingItems(items: SettingItem[]): SettingItem[] {
  const collected: SettingItem[] = []

  for (const item of items) {
    collected.push(item)
    if (item.options?.children) {
      collected.push(...collectSettingItems(item.options.children))
    }
  }

  return collected
}

function publishDurableSettingSettlement(mutationId: string, settlement: 'accepted' | 'discarded'): void {
  for (const listener of [...(durableSettingState.settlementListeners.get(mutationId) ?? [])]) listener(settlement)
}

function serverCommandKeyForSetting(item: SettingItem): string | null {
  if (item.bindPath) return item.bindPath.split('.')[0] ?? null
  return item.bindKey ? String(item.bindKey) : null
}

beforeEach(() => {
  resetClientSessionForTests()
  durableSettingState.nextId = 0
  durableSettingState.retainFailures = false
  durableSettingState.stages.length = 0
  durableSettingState.dispatches.length = 0
  durableSettingState.acknowledgements.length = 0
  durableSettingState.settlementListeners.clear()
  settingAlertMocks.alertError.mockReset()
  writerAccessMocks.lost = false
  writerAccessMocks.report.mockClear()
  clearCachedServerCommandRevision()
  setServerCommandSuccessReconciler(null)
  replaceResourceDatabase({ notification: false } as any)
})

afterEach(() => {
  resetClientSessionForTests()
  clearDeferredSettingWrites()
  setServerCommandSuccessReconciler(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('server-backed data-driven settings', () => {
  it('starts a fresh deferred root edit after repromotion without adopting old path edits or deleting their intent', () => {
    vi.useFakeTimers()
    replaceResourceDatabase({ NAIImgConfig: { steps: 10, scale: 1 } } as any)
    enterClientWriter()
    const context = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    setDeferredSettingValue(
      { id: 'steps', type: 'number', bindPath: 'NAIImgConfig.steps' } as SettingItem,
      20,
      context,
      { delayMs: 60_000 },
    )
    const original = durableSettingState.stages[0]
    demoteClientSession()
    expect(
      applySettingsResource({ revision: 1, settings: { NAIImgConfig: { steps: 30, scale: 1 } as NAIImgConfig } }),
    ).toBe(true)
    repromoteClientWriter()
    setDeferredSettingValue(
      { id: 'scale', type: 'number', bindPath: 'NAIImgConfig.scale' } as SettingItem,
      2,
      context,
      { delayMs: 60_000 },
    )
    expect(durableSettingState.stages).toHaveLength(2)
    const current = durableSettingState.stages[1]
    expect(current.handle.mutationId).not.toBe(original.handle.mutationId)
    expect(current.intent.requests).toEqual([
      { method: 'PATCH', path: '/settings/media', body: { patch: { NAIImgConfig: { steps: 30, scale: 2 } } } },
    ])
    expect(getResourceDatabase().NAIImgConfig).toEqual({ steps: 30, scale: 2 })
    expect(durableSettingState.acknowledgements).toEqual([])
    expect(durableSettingState.dispatches).toEqual([])
  })

  it.each(['immediate', 'delayed'] as const)(
    'keeps %s renderer intent dormant through reader and repromoted authoritative reads',
    async (mode) => {
      replaceResourceDatabase({ textTheme: 'before' } as any)
      enterClientWriter()
      durableSettingState.retainFailures = true
      const response = deferredResponse()
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          calls.push({ url, method: init.method ?? 'GET', body: null })
          if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
          if (url === '/api/v1/commands/settings/display') return response.promise
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }),
      )
      const item = { id: 'textTheme', type: 'text', bindKey: 'textTheme' } as SettingItem
      const context = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
      if (mode === 'delayed') {
        vi.useFakeTimers()
        setDeferredSettingValue(item, 'old intent', context, { delayMs: 50 })
      } else {
        setSettingValue(item, 'old intent', context)
        await vi.waitFor(() => expect(calls.some((call) => call.url.endsWith('/settings/display'))).toBe(true))
      }
      const staged = [...durableSettingState.stages]
      expect(staged).toHaveLength(1)
      demoteClientSession()
      expect(applySettingsResource({ revision: 4, settings: { textTheme: 'reader server' } })).toBe(true)
      expect(getResourceDatabase().textTheme).toBe('reader server')
      repromoteClientWriter()
      expect(
        applySettingsGroupResource({ revision: 5, group: 'display', settings: { textTheme: 'repromoted server' } }, [
          'textTheme',
        ]),
      ).toBe(true)
      expect(getResourceDatabase().textTheme).toBe('repromoted server')
      if (mode === 'delayed') await vi.advanceTimersByTimeAsync(100)
      else {
        response.resolve(jsonResponse({ error: 'temporarily unavailable' }, 503))
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(applySettingsResource({ revision: 6, settings: { textTheme: 'old intent' } })).toBe(true)
      publishDurableSettingSettlement(staged[0].handle.mutationId, 'discarded')
      expect(getResourceDatabase().textTheme).toBe('old intent')
      expect(durableSettingState.stages).toEqual(staged)
      expect(durableSettingState.acknowledgements).toEqual([])
      if (mode === 'delayed') expect(durableSettingState.dispatches).toEqual([])
    },
  )

  it('rejects immediate and deferred renderer writes after writer access is lost', () => {
    replaceResourceDatabase({ notification: false } as any)
    const item: SettingItem = {
      id: 'notification',
      type: 'check',
      bindKey: 'notification' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    writerAccessMocks.lost = true

    setSettingValue(item, true, ctx)
    const deferred = setDeferredSettingValue(item, true, ctx)

    expect(getResourceDatabase().notification).toBe(false)
    expect(deferred.queued).toBe(false)
    expect(durableSettingState.stages).toEqual([])
    expect(durableSettingState.dispatches).toEqual([])
    expect(writerAccessMocks.report).toHaveBeenCalledTimes(2)
  })

  it('maps every data-driven SettingRenderer binding to a server command group', () => {
    const missing = settingRendererItemSets.flatMap(collectSettingItems).flatMap((item) => {
      const key = serverCommandKeyForSetting(item)
      if (!key || settingsGroupForKey(key)) return []
      return [`${item.id} -> ${key}`]
    })

    expect(missing).toEqual([])
  })

  it('does not expose the legacy API-key visibility toggle', () => {
    const displayItems = collectSettingItems(displayOtherSettingsItems)

    expect(displayItems.some((item) => item.id === 'display.hideApiKey')).toBe(false)
    expect(displayItems.some((item) => item.bindKey === 'hideApiKey')).toBe(false)
  })

  it('does not expose unsupported Claude batching', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'claudeBatching')).toBe(false)
  })

  it('does not expose unsupported Claude cache retrieval', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'claudeRetrivalCaching')).toBe(false)
  })

  it('does not expose the redundant force-proxy-format setting', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'forceProxyAsOpenAI')).toBe(false)
  })

  it('does not expose legacy punctuation normalization for Hypa V3', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'removePunctuationHypa')).toBe(false)
  })

  it('does not expose the superseded overload retry toggle', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'antiServerOverloads')).toBe(false)
  })

  it('does not expose browser-only local-network routing settings', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'localNetworkMode')).toBe(false)
    expect(advancedSettingsItems.some((item) => item.bindKey === 'localNetworkTimeoutSec')).toBe(false)
  })

  it('does not expose unsupported Google Cloud token counting', () => {
    expect(advancedSettingsItems.some((item) => item.bindKey === 'googleClaudeTokenizing')).toBe(false)
  })

  it('exposes the app-owned reduced-motion toggle under Accessibility', () => {
    expect(accessibilitySettingsItems.find((item) => item.id === 'acc.reducedMotion')).toMatchObject({
      type: 'check',
      labelKey: 'reducedMotion',
      helpKey: 'reducedMotion',
      bindKey: 'reducedMotion',
    })
  })

  it('exposes open-chat-only memory progress under Memory', () => {
    expect(memorySettingsItems.find((item) => item.id === 'acc.hypaV3ProgressOpenChatOnly')).toMatchObject({
      type: 'check',
      labelKey: 'hypaV3ProgressOpenChatOnly',
      helpKey: 'hypaV3ProgressOpenChatOnly',
      bindKey: 'hypaV3ProgressOpenChatOnly',
    })
  })

  it('exposes fixed and default-on floating composer positioning under Accessibility', () => {
    expect(accessibilitySettingsItems.find((candidate) => candidate.id === 'acc.fixedChatTextarea')).toMatchObject({
      type: 'check',
      labelKey: 'fixedChatTextarea',
      bindKey: 'fixedChatTextarea',
    })
    const floatingInput = accessibilitySettingsItems.find((candidate) => candidate.id === 'acc.floatingChatInput')
    expect(floatingInput).toMatchObject({
      type: 'check',
      labelKey: 'floatingChatInput',
      helpKey: 'floatingChatInput',
      bindKey: 'floatingChatInput',
    })
    expect(floatingInput?.getValue?.({ floatingChatInput: undefined } as never)).toBe(true)
    expect(floatingInput?.getValue?.({ floatingChatInput: false } as never)).toBe(false)
    expect(floatingInput?.condition?.({ db: { fixedChatTextarea: false } } as never)).toBe(true)
    expect(floatingInput?.condition?.({ db: { fixedChatTextarea: true } } as never)).toBe(false)
  })

  it('exposes the default-off global additional-parameters opt-in under Model settings', () => {
    const item = modelSupplementalSettingsItems.find((candidate) => candidate.id === 'acc.applyAdditionalParamsToAll')

    expect(item).toMatchObject({
      type: 'check',
      labelKey: 'applyAdditionalParamsToAll',
      bindKey: 'applyAdditionalParamsToAll',
    })
    expect(item?.getValue?.({ applyAdditionalParamsToAll: undefined } as never)).toBe(false)
    expect(item?.getValue?.({ applyAdditionalParamsToAll: true } as never)).toBe(true)
  })

  it('keeps Display custom-control watchers disjoint from renderer-owned bindings', () => {
    const rendererKeys = new Set(
      collectSettingItems(displaySettingsItems).flatMap((item) =>
        item.bindPath ? [item.bindPath.split('.')[0]] : item.bindKey ? [String(item.bindKey)] : [],
      ),
    )

    expect(displayNonRendererServerSettingKeys.filter((key) => rendererKeys.has(key))).toEqual([])
  })

  it('renders data-driven translator secrets as hidden text fields', () => {
    const languageItems = collectSettingItems(languageSettingsItems)

    expect(languageItems.find((item) => item.bindPath === 'deeplOptions.key')?.options?.hideText).toBe(true)
    expect(languageItems.find((item) => item.bindPath === 'deeplXOptions.token')?.options?.hideText).toBe(true)
  })

  it('surfaces conflicts without replaying the same setting patch', async () => {
    const calls = stubSettingsFetch()
    const item: SettingItem = {
      id: 'notification',
      type: 'check',
      bindKey: 'notification' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, true, ctx)

    await vi.waitFor(() => {
      expect(getResourceDatabase().notification).toBe(false)
    })

    expect(calls).toEqual([
      { url: '/api/v1/bootstrap', method: 'GET', body: null },
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        body: { baseRevision: 4, patch: { notification: true } },
      },
    ])
    expect(settingAlertMocks.alertError).toHaveBeenCalledOnce()
    expect(settingAlertMocks.alertError).toHaveBeenCalledWith(language.errors.settingsSaveFailed)
  })

  it('reapplies runtime side effects when an immediate setting patch rolls back', async () => {
    const calls = stubSettingsFetch()
    replaceResourceDatabase({ animationSpeed: 1 } as any)
    const appliedRuntimeValues: Array<{ stored: unknown; value: unknown }> = []
    const item: SettingItem = {
      id: 'display.animationSpeed',
      type: 'slider',
      bindKey: 'animationSpeed' as keyof ReturnType<typeof getResourceDatabase>,
      onChange: (value) => {
        appliedRuntimeValues.push({ stored: getResourceDatabase().animationSpeed, value })
      },
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, 0.25, ctx)

    await vi.waitFor(() => {
      expect(getResourceDatabase().animationSpeed).toBe(1)
    })

    expect(appliedRuntimeValues).toEqual([
      { stored: 0.25, value: 0.25 },
      { stored: 1, value: 1 },
    ])
    expect(calls).toEqual([
      { url: '/api/v1/bootstrap', method: 'GET', body: null },
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        body: { baseRevision: 4, patch: { animationSpeed: 0.25 } },
      },
    ])
  })

  it('reapplies runtime side effects when a deferred setting patch rolls back', async () => {
    vi.useFakeTimers()
    const calls = stubSettingsFetch()
    replaceResourceDatabase({ animationSpeed: 1 } as any)
    const appliedRuntimeValues: Array<{ stored: unknown; value: unknown }> = []
    const item: SettingItem = {
      id: 'display.animationSpeed',
      type: 'slider',
      bindKey: 'animationSpeed' as keyof ReturnType<typeof getResourceDatabase>,
      onChange: (value) => {
        appliedRuntimeValues.push({ stored: getResourceDatabase().animationSpeed, value })
      },
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 0.25, ctx)

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await vi.waitFor(() => {
      expect(getResourceDatabase().animationSpeed).toBe(1)
    })

    expect(appliedRuntimeValues).toEqual([
      { stored: 0.25, value: 0.25 },
      { stored: 1, value: 1 },
    ])
    expect(calls).toEqual([
      { url: '/api/v1/bootstrap', method: 'GET', body: null },
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        body: { baseRevision: 4, patch: { animationSpeed: 0.25 } },
      },
    ])
    expect(settingAlertMocks.alertError).toHaveBeenCalledOnce()
    expect(settingAlertMocks.alertError).toHaveBeenCalledWith(language.errors.settingsSaveFailed)
  })

  it('patches one custom quote as an array field and restores it when persistence fails', async () => {
    vi.useFakeTimers()
    const calls = stubSettingsFetch()
    replaceResourceDatabase({
      customQuotes: true,
      customQuotesData: ['"', '"', "'", "'"],
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item = displaySettingsItems.find((candidate) => candidate.id === 'display.leadingDoubleQuote')!
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, '«', ctx)
    expect(getResourceDatabase().customQuotesData).toEqual(['«', '"', "'", "'"])

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await vi.waitFor(() => {
      expect(getResourceDatabase().customQuotesData).toEqual(['"', '"', "'", "'"])
    })

    expect(calls).toEqual([
      { url: '/api/v1/bootstrap', method: 'GET', body: null },
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        body: {
          baseRevision: 4,
          patch: { customQuotesData: ['«', '"', "'", "'"] },
        },
      },
    ])
  })

  it('restores local state when a number clear would produce an undefined server patch', async () => {
    const calls = stubSettingsFetch()
    replaceResourceDatabase({ maxResponse: 100 } as any)
    const item: SettingItem = {
      id: 'maxResponse',
      type: 'number',
      bindKey: 'maxResponse' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, undefined, ctx)

    await vi.waitFor(() => {
      expect(getResourceDatabase().maxResponse).toBe(100)
    })

    expect(calls).toEqual([])
  })

  it('skips rollback when a destructive refresh lands before a setting patch failure', async () => {
    const patchResponse = deferredResponse()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
        if (url === '/api/v1/commands/settings/display') return patchResponse.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    const item: SettingItem = {
      id: 'notification',
      type: 'check',
      bindKey: 'notification' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, true, ctx)
    await vi.waitFor(() => {
      expect(calls.some((call) => call.url === '/api/v1/commands/settings/display')).toBe(true)
    })
    expect(getResourceDatabase().notification).toBe(true)

    createDestructiveRefreshToken('setting-renderer-test-refresh')
    patchResponse.resolve(jsonResponse({ error: 'nope' }, 500))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getResourceDatabase().notification).toBe(true)
  })

  it('keeps the latest rapid text draft through an intermediate projection and sends only the final value', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      guiHTML: 'server initial',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'text' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    for (const value of ['l', 'lo', 'local final']) {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      flushSync()
    }

    expect(getResourceDatabase().guiHTML).toBe('local final')
    expect(calls).toEqual([])

    applySettingsGroupResource({ revision: 1, group: 'display', settings: { guiHTML: 'server intermediate' } }, [
      'guiHTML',
    ])
    flushSync()

    expect(input.value).toBe('local final')
    expect(getResourceDatabase().guiHTML).toBe('local final')

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await Promise.resolve()

    const patches = calls.filter((call) => call.url === '/api/v1/commands/settings/display')
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toMatchObject({ patch: { guiHTML: 'local final' } })
    unmount(component)
  })

  it('renders the restored value after database replacement clears a deferred input draft', async () => {
    vi.useFakeTimers()
    replaceResourceDatabase({
      guiHTML: 'before',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'text' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    input.value = 'queued'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(getResourceDatabase().guiHTML).toBe('queued')

    clearDeferredSettingWrites()
    applySettingsResource({ revision: 1, settings: { guiHTML: 'restored' } })
    flushSync()

    expect(input.value).toBe('restored')
    expect(getResourceDatabase().guiHTML).toBe('restored')
    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(durableSettingState.dispatches).toEqual([])
    unmount(component)
  })

  it('overlays an in-flight immediate setting across full and grouped authoritative reads', async () => {
    const patchResponse = deferredResponse()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
        if (url === '/api/v1/commands/settings/display') return patchResponse.promise
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    replaceResourceDatabase({ notification: false } as any)
    const item: SettingItem = {
      id: 'notification',
      type: 'check',
      bindKey: 'notification' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, true, ctx)
    await vi.waitFor(() => expect(calls.some((call) => call.url === '/api/v1/commands/settings/display')).toBe(true))

    applySettingsResource({ revision: 4, settings: { notification: false } })
    expect(getResourceDatabase().notification).toBe(true)

    applySettingsGroupResource({ revision: 4, group: 'display', settings: { notification: false } }, ['notification'])
    expect(getResourceDatabase().notification).toBe(true)

    patchResponse.resolve(
      jsonResponse({
        revision: 5,
        event: {
          type: 'settings.updated',
          revision: 5,
          resource: 'settings',
          id: 'display',
        },
        acknowledgedKeys: ['notification'],
        settings: {},
      }),
    )
    await vi.waitFor(() => expect(getResourceDatabase().notification).toBe(true))
  })

  it('keeps a retained immediate setting projected until replay acceptance converges', async () => {
    durableSettingState.retainFailures = true
    stubSettingsFetch()
    replaceResourceDatabase({ roundIcons: false } as any)
    const item: SettingItem = {
      id: 'display.roundIcons',
      type: 'check',
      bindKey: 'roundIcons' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, true, ctx)
    await vi.waitFor(() => expect(durableSettingState.dispatches).toHaveLength(1))
    await Promise.resolve()
    expect(getResourceDatabase().roundIcons).toBe(true)
    expect(settingAlertMocks.alertError).not.toHaveBeenCalled()

    applySettingsResource({ revision: 4, settings: { roundIcons: false } })
    expect(getResourceDatabase().roundIcons).toBe(true)
    applySettingsGroupResource({ revision: 4, group: 'display', settings: { roundIcons: false } }, ['roundIcons'])
    expect(getResourceDatabase().roundIcons).toBe(true)

    const mutationId = durableSettingState.dispatches[0].handle.mutationId
    publishDurableSettingSettlement(mutationId, 'accepted')
    applySettingsGroupResource({ revision: 5, group: 'display', settings: { roundIcons: true } }, ['roundIcons'])
    applySettingsGroupResource({ revision: 6, group: 'display', settings: { roundIcons: false } }, ['roundIcons'])
    expect(getResourceDatabase().roundIcons).toBe(false)
  })

  it('rolls back and reports a retained immediate setting when replay discards it', async () => {
    durableSettingState.retainFailures = true
    stubSettingsFetch()
    replaceResourceDatabase({ roundIcons: false } as any)
    const item: SettingItem = {
      id: 'display.roundIcons',
      type: 'check',
      bindKey: 'roundIcons' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setSettingValue(item, true, ctx)
    await vi.waitFor(() => expect(durableSettingState.dispatches).toHaveLength(1))
    await Promise.resolve()
    expect(getResourceDatabase().roundIcons).toBe(true)

    publishDurableSettingSettlement(durableSettingState.dispatches[0].handle.mutationId, 'discarded')

    expect(getResourceDatabase().roundIcons).toBe(false)
    expect(settingAlertMocks.alertError).toHaveBeenCalledOnce()
    expect(settingAlertMocks.alertError).toHaveBeenCalledWith(language.errors.settingsSaveFailed)
  })

  it('keeps a newer input dirty after an older acknowledgement advances the resource epoch', () => {
    vi.useFakeTimers()
    replaceResourceDatabase({
      guiHTML: 'A',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'text' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    input.value = 'B'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    input.value = 'C'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()

    notifyServerCommandLocalEffectApplied(
      {
        type: 'settings.updated',
        revision: 5,
        resource: 'settings',
        id: 'display',
      },
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { guiHTML: 'B' },
        settings: { guiHTML: 'B' },
        settingsProjectionEpoch: 0,
      },
    )
    flushSync()
    applySettingsGroupResource({ revision: 5, group: 'display', settings: { guiHTML: 'B' } }, ['guiHTML'])
    flushSync()

    expect(input.value).toBe('C')
    expect(getResourceDatabase().guiHTML).toBe('C')
    unmount(component)
  })

  it('shows a canonical settings receipt in the input that produced the accepted attempt', () => {
    replaceResourceDatabase({
      deeplOptions: { key: 'server initial', freeApi: false },
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'language.deepl.key',
      type: 'text',
      bindPath: 'deeplOptions.key',
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'text' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    input.value = 'attempted key'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()

    applySettingsPatchLocalEffect({
      revision: 5,
      group: 'language',
      attemptedPatch: { deeplOptions: { key: 'attempted key', freeApi: false } },
      settings: { deeplOptions: { key: 'canonical key', freeApi: false } },
    })
    notifyServerCommandLocalEffectApplied(
      {
        type: 'settings.updated',
        revision: 5,
        resource: 'settings',
        id: 'language',
      },
      {
        kind: 'settingsPatch',
        group: 'language',
        attemptedPatch: { deeplOptions: { key: 'attempted key', freeApi: false } },
        settings: { deeplOptions: { key: 'canonical key', freeApi: false } },
        settingsProjectionEpoch: 0,
      },
    )
    flushSync()

    expect(input.value).toBe('canonical key')
    expect(getResourceDatabase().deeplOptions).toEqual({ key: 'canonical key', freeApi: false })
    unmount(component)
  })

  it('keeps a destroyed input intent over a newer projection while fencing its acknowledgement', async () => {
    vi.useFakeTimers()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ url, method: init.method ?? 'GET', body })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
        if (url === '/api/v1/commands/settings/display') {
          return jsonResponse({
            revision: 5,
            event: {
              type: 'settings.updated',
              revision: 5,
              resource: 'settings',
              id: 'display',
            },
            acknowledgedKeys: ['guiHTML'],
            settings: {},
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    replaceResourceDatabase({
      guiHTML: 'server initial',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const observedEffects: ServerCommandLocalEffect[] = []
    let finishReconciliation!: () => void
    const reconciliationFinished = new Promise<void>((resolve) => {
      finishReconciliation = resolve
    })
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
      finishReconciliation()
    })
    const intentEpoch = captureSettingsGroupProjectionEpoch('display')
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'text' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    input.value = 'local final'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    unmount(component)
    applySettingsGroupResource(
      {
        revision: 4,
        group: 'display',
        settings: { guiHTML: 'server intermediate' },
      },
      ['guiHTML'],
    )
    expect(hasSettingsGroupProjectionEpochChanged('display', intentEpoch)).toBe(true)
    expect(getResourceDatabase().guiHTML).toBe('local final')

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await reconciliationFinished

    expect(calls.filter((call) => call.url === '/api/v1/commands/settings/display')).toHaveLength(1)
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { guiHTML: 'local final' },
        settings: { guiHTML: 'local final' },
        settingsProjectionEpoch: intentEpoch,
      },
    ])
    expect(getResourceDatabase().guiHTML).toBe('local final')
  })

  it('bounds rapid slider persistence to one dispatch with the final value', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
      zoomsize: 50,
    } as any)
    const item: SettingItem = {
      id: 'display.zoomsize',
      type: 'slider',
      bindKey: 'zoomsize' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    const target = document.createElement('div')
    const component = mount(SettingInputDraftHarness, { target, props: { ctx, item, kind: 'slider' } })
    flushSync()
    const input = target.querySelector<HTMLInputElement>('[data-setting-input-draft]')!

    for (let value = 51; value <= 150; value += 1) {
      input.value = String(value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      flushSync()
    }

    expect(getResourceDatabase().zoomsize).toBe(150)
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await Promise.resolve()

    const patches = calls.filter((call) => call.url === '/api/v1/commands/settings/display')
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toMatchObject({ patch: { zoomsize: 150 } })
    unmount(component)
  })

  it('coalesces sibling bind paths into one effective-root patch', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      deeplOptions: { key: 'old key', proxy: 'old proxy' },
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const keyItem: SettingItem = {
      id: 'language.deepl.key',
      type: 'text',
      bindPath: 'deeplOptions.key',
    }
    const proxyItem: SettingItem = {
      id: 'language.deepl.proxy',
      type: 'text',
      bindPath: 'deeplOptions.proxy',
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(keyItem, 'final key', ctx)
    setDeferredSettingValue(proxyItem, 'final proxy', ctx)

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await Promise.resolve()

    const patches = calls.filter((call) => call.url.startsWith('/api/v1/commands/settings/'))
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toMatchObject({
      patch: { deeplOptions: { key: 'final key', proxy: 'final proxy' } },
    })
  })

  it('stages the exact deferred root-settings request before its debounce fires', async () => {
    vi.useFakeTimers()
    stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      guiHTML: 'before',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 'crash-durable draft', ctx)

    expect(durableSettingState.stages).toHaveLength(1)
    expect(durableSettingState.stages[0]).toMatchObject({
      key: 'settings:bridge',
      intent: {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/display',
            body: { patch: { guiHTML: 'crash-durable draft' } },
          },
        ],
      },
    })
    expect(durableSettingState.dispatches).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    await Promise.resolve()

    expect(durableSettingState.dispatches).toEqual([
      {
        handle: durableSettingState.stages[0].handle,
        intent: durableSettingState.stages[0].intent,
      },
    ])
  })

  it('dispatches a deferred root correction immediately when it returns to baseline', async () => {
    vi.useFakeTimers()
    stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      guiHTML: 'server baseline',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 'staged intermediate', ctx)
    setDeferredSettingValue(item, 'server baseline', ctx)

    expect(durableSettingState.stages.at(-1)).toMatchObject({
      key: 'settings:bridge',
      intent: {
        requests: [
          {
            path: '/settings/display',
            body: { patch: { guiHTML: 'server baseline' } },
          },
        ],
      },
    })
    expect(durableSettingState.dispatches.at(-1)?.intent).toMatchObject({
      requests: [
        {
          body: { patch: { guiHTML: 'server baseline' } },
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(durableSettingState.dispatches).toHaveLength(1)
  })

  it('keeps the full desired root when one nested field reverts and a sibling remains dirty', async () => {
    vi.useFakeTimers()
    stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      deeplOptions: { key: 'old key', proxy: 'old proxy' },
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const keyItem: SettingItem = {
      id: 'language.deepl.key',
      type: 'text',
      bindPath: 'deeplOptions.key',
    }
    const proxyItem: SettingItem = {
      id: 'language.deepl.proxy',
      type: 'text',
      bindPath: 'deeplOptions.proxy',
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(keyItem, 'intermediate key', ctx)
    setDeferredSettingValue(proxyItem, 'final proxy', ctx)
    setDeferredSettingValue(keyItem, 'old key', ctx)

    expect(durableSettingState.stages.at(-1)?.intent).toMatchObject({
      requests: [
        {
          body: {
            patch: {
              deeplOptions: { key: 'old key', proxy: 'final proxy' },
            },
          },
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(durableSettingState.dispatches.at(-1)?.intent).toMatchObject({
      requests: [
        {
          body: {
            patch: {
              deeplOptions: { key: 'old key', proxy: 'final proxy' },
            },
          },
        },
      ],
    })
  })

  it('merges an immediate write into pending deferred work for the same server root', async () => {
    vi.useFakeTimers()
    stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      guiHTML: 'server baseline',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 'deferred intermediate', ctx)
    setSettingValue(item, 'immediate final', ctx)

    expect(durableSettingState.dispatches).toHaveLength(1)
    expect(durableSettingState.dispatches[0].intent).toMatchObject({
      requests: [
        {
          body: { patch: { guiHTML: 'immediate final' } },
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(durableSettingState.dispatches).toHaveLength(1)
  })

  it('rebases a queued deferred root rollback after the older save fails', async () => {
    const firstResponse = deferredResponse()
    const secondResponse = deferredResponse()
    let patchRequest = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 4 })
        if (url === '/api/v1/commands/settings/display') {
          patchRequest += 1
          return patchRequest === 1 ? firstResponse.promise : secondResponse.promise
        }
        return jsonResponse({ error: `unexpected ${url} ${init.method ?? 'GET'}` }, 404)
      }) as unknown as typeof fetch,
    )
    replaceResourceDatabase({
      guiHTML: 'server baseline',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 'first attempted value', ctx)
    flushDeferredSettingWrites()
    await vi.waitFor(() => expect(patchRequest).toBe(1))

    setDeferredSettingValue(item, 'second attempted value', ctx)
    flushDeferredSettingWrites()
    firstResponse.resolve(jsonResponse({ error: 'first failed' }, 500))
    await vi.waitFor(() => expect(patchRequest).toBe(2))

    secondResponse.resolve(jsonResponse({ error: 'second failed' }, 500))
    await vi.waitFor(() => expect(getResourceDatabase().guiHTML).toBe('server baseline'))
  })

  it('flushes the final deferred input with keepalive before its timer fires', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      guiHTML: 'before',
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'display.guiHTML',
      type: 'textarea',
      bindKey: 'guiHTML' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 'last keystroke', ctx)
    flushDeferredSettingWrites({ keepalive: true })
    await vi.advanceTimersByTimeAsync(0)

    const patches = calls.filter((call) => call.url === '/api/v1/commands/settings/display')
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      body: { patch: { guiHTML: 'last keystroke' } },
      keepalive: true,
    })

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(calls.filter((call) => call.url === '/api/v1/commands/settings/display')).toHaveLength(1)
  })

  it('preserves a durable model-preset correction when a deferred input returns to its baseline', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      temperature: 0.5,
      modelPresets: [{ id: 'model-revert', name: 'Model Revert', temperature: 0.5 }],
      modelPresetsId: 0,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'model.temperature',
      type: 'slider',
      bindKey: 'temperature' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 0.8, ctx)
    const staged = durableSettingState.stages.find(({ key }) => key === 'split-preset:model:model-revert')
    expect(staged?.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/model-presets/model-revert',
          body: { patch: { temperature: 0.8 } },
        },
      ],
    })

    setDeferredSettingValue(item, 0.5, ctx)

    expect(getResourceDatabase().modelPresets[0].temperature).toBe(0.5)
    expect(durableSettingState.acknowledgements).not.toContain(staged?.handle)
    expect(durableSettingState.stages.at(-1)).toMatchObject({
      key: 'split-preset:model:model-revert',
      intent: {
        requests: [
          {
            method: 'PATCH',
            path: '/model-presets/model-revert',
            body: { patch: { temperature: 0.5 } },
          },
        ],
      },
    })
    expect(durableSettingState.dispatches.at(-1)?.intent).toMatchObject({
      requests: [{ body: { patch: { temperature: 0.5 } } }],
    })
    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-revert')).toHaveLength(1)
  })

  it('preserves a durable prompt override correction when a deferred input returns to its baseline', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      temperature: 0.5,
      modelPresets: [],
      modelPresetsId: -1,
      promptPresets: [{ id: 'prompt-revert', name: 'Prompt Revert', temperature: 0.5 }],
      promptPresetsId: 0,
    } as any)
    const item: SettingItem = {
      id: 'model.temperature',
      type: 'slider',
      bindKey: 'temperature' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = {
      db: getResourceDatabase(),
      modelInfo: {},
      subModelInfo: {},
      presetMirrorTarget: 'promptModelOverrides',
    } as SettingContext

    setDeferredSettingValue(item, 0.8, ctx)
    const staged = durableSettingState.stages.find(({ key }) => key === 'prompt-template-owner:prompt-revert')
    expect(staged?.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/prompt-presets/prompt-revert',
          body: { patch: { temperature: 0.8 } },
        },
      ],
    })

    setDeferredSettingValue(item, 0.5, ctx)

    expect(getResourceDatabase().promptPresets[0].temperature).toBe(0.5)
    expect(durableSettingState.acknowledgements).not.toContain(staged?.handle)
    expect(durableSettingState.stages.at(-1)).toMatchObject({
      key: 'prompt-template-owner:prompt-revert',
      intent: {
        requests: [
          {
            method: 'PATCH',
            path: '/prompt-presets/prompt-revert',
            body: { patch: { temperature: 0.5 } },
          },
        ],
      },
    })
    expect(durableSettingState.dispatches.at(-1)?.intent).toMatchObject({
      requests: [{ body: { patch: { temperature: 0.5 } } }],
    })
    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS)
    expect(calls.filter((call) => call.url === '/api/v1/commands/prompt-presets/prompt-revert')).toHaveLength(1)
  })

  it('cascades a lifecycle-flushed preset input into its split-preset command', async () => {
    vi.useFakeTimers()
    const calls = stubSuccessfulSettingsFetch()
    replaceResourceDatabase({
      temperature: 0.5,
      modelPresets: [{ id: 'model-a', name: 'Model A', temperature: 0.5 }],
      modelPresetsId: 0,
      promptPresets: [],
      promptPresetsId: -1,
    } as any)
    const item: SettingItem = {
      id: 'model.temperature',
      type: 'slider',
      bindKey: 'temperature' as keyof ReturnType<typeof getResourceDatabase>,
    }
    const ctx = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext

    setDeferredSettingValue(item, 0.8, ctx)
    const presetStage = durableSettingState.stages.find(({ key }) => key === 'split-preset:model:model-a')
    expect(presetStage?.intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PATCH',
          path: '/model-presets/model-a',
          body: { patch: { temperature: 0.8 } },
        },
      ],
    })
    flushDeferredSettingWrites({ keepalive: true })
    await vi.advanceTimersByTimeAsync(0)

    const patches = calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-a')
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      body: { patch: { temperature: 0.8 } },
      keepalive: true,
    })

    await vi.advanceTimersByTimeAsync(DEFERRED_SETTING_INPUT_DELAY_MS + 500)
    expect(calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-a')).toHaveLength(1)
  })
})

it.each([false, true])(
  'preserves deferred renderer intent without a stale dispatch after demotion (repromoted: %s)',
  async (repromoted) => {
    vi.useFakeTimers()
    enterClientWriter()
    const item = { id: 'notification', type: 'check', bindKey: 'notification' } as SettingItem
    const context = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    expect(setDeferredSettingValue(item, true, context, { delayMs: 50 }).queued).toBe(true)
    const staged = [...durableSettingState.stages]
    expect(staged).toHaveLength(1)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(100)
    flushDeferredSettingWrites()
    expect(durableSettingState.stages).toEqual(staged)
    expect(durableSettingState.dispatches).toEqual([])
    expect(durableSettingState.acknowledgements).toEqual([])
    expect(getResourceDatabase().notification).toBe(true)
  },
)
