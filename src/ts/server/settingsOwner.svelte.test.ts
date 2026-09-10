import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'
import type { ServerShellSettings } from '@risuai/protocol/shell-resource'

const recorded = vi.hoisted(() => ({
  patches: [] as Array<{
    patch: Record<string, unknown>
    acknowledgeOptimistic?: boolean
    optimisticProjectionEpochs?: Record<string, number>
    rollback?: () => void
    keepalive?: boolean
  }>,
  patchResults: [] as Array<unknown | Promise<unknown>>,
  objectPatches: [] as Array<{
    baseRevision: number
    group: string
    key: string
    update: { patch: Record<string, unknown>; deleteKeys?: string[] }
    attemptedObject: Record<string, unknown>
    optimisticProjectionEpoch: number
  }>,
  objectResults: [] as Array<unknown | Promise<unknown>>,
  groupReads: [] as unknown[],
  onboardingInputs: [] as Array<Record<string, unknown>>,
  onboardingResults: [] as Array<unknown | Promise<unknown>>,
}))
const alertMocks = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
}))
const durabilityMocks = vi.hoisted(() => ({
  acknowledged: [] as Array<{ mutationId: string }>,
  dispatched: [] as Array<{ key: string; mutationId: string; intent: unknown }>,
  nextId: 1,
  retainFailures: false,
  settlementListeners: new Map<string, Set<(settlement: 'accepted' | 'discarded') => void>>(),
  staged: [] as Array<{ key: string; mutationId: string; intent: unknown }>,
}))
const presetMocks = vi.hoisted(() => ({
  OAI: {
    mainPrompt: 'default main prompt',
    jailbreak: 'default jailbreak',
  },
  OAI2: {
    apiType: 'preset-api',
    temperature: 0.75,
    mainPrompt: 'preset prompt',
    maxContext: 16000,
    maxResponse: 1000,
  },
  setPreset: vi.fn((db: Record<string, unknown>, preset: Record<string, unknown>) => {
    db.apiType = preset.apiType
    db.temperature = preset.temperature
    db.mainPrompt = preset.mainPrompt
    db.maxContext = preset.maxContext
    db.maxResponse = preset.maxResponse
    return db
  }),
}))

const settingsGroupMocks = vi.hoisted(() => ({
  forKey(key: string): string | null {
    if (key === 'NAIImgConfig' || key === 'wavespeedImage' || key === 'sdConfig') return 'media'
    if (['maxContext', 'maxResponse', 'temperature', 'seperateParameters'].includes(key)) return 'runtime'
    if (key === 'notification' || key === 'textTheme') return 'display'
    if (key === 'useAutoSuggestions') return 'sidebar'
    if (['translator', 'translatorType', 'useAutoTranslateInput'].includes(key)) return 'language'
    if (['hypaV3PresetId', 'hypaV3Presets', 'selectedHypaV3PresetId'].includes(key)) return 'memory'
    if (key === 'didFirstSetup') return 'account'
    if (
      [
        'aiModel',
        'apiType',
        'claudeCachingExperimental',
        'customModels',
        'openrouterRequestModel',
        'subModel',
      ].includes(key)
    ) {
      return 'providers'
    }
    if (key === 'banCharacterset' || key === 'globalscript' || key === 'inputHooks') return 'advanced'
    return null
  },
}))

vi.mock('./commands', () => ({
  canUseServerCommands: () => true,
  completeOnboardingCommand: vi.fn(async (args: Record<string, unknown>) => {
    recorded.onboardingInputs.push(args)
    const queued = recorded.onboardingResults.shift()
    if (queued) return await queued
    return {
      status: 'ok',
      revision: Number(args.baseRevision) + 1,
      event: {
        type: 'onboarding.completed',
        revision: Number(args.baseRevision) + 1,
        resource: 'legacyBotPreset',
      },
      modelPresetId: args.modelPresetId,
      promptPresetId: args.promptPresetId,
    }
  }),
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
      const queued = recorded.objectResults.shift()
      if (queued) return await queued
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
  patchServerBackedSettings: vi.fn(
    async (args: {
      patch: Record<string, unknown>
      acknowledgeOptimistic?: boolean
      optimisticProjectionEpochs?: Record<string, number>
      rollback?: () => void
      keepalive?: boolean
      failureRollbackDisposition?: (result: { status: string }) => 'retain' | 'rollback'
    }) => {
      recorded.patches.push(args)
      const queued = recorded.patchResults.shift()
      const result = queued ? await queued : { status: 'ok', revision: 1 }
      if (
        (result as { status?: string }).status !== 'ok' &&
        (!args.failureRollbackDisposition ||
          args.failureRollbackDisposition(result as { status: string }) === 'rollback')
      ) {
        args.rollback?.()
      }
      return result
    },
  ),
  runServerCommand: vi.fn(
    async (args: {
      command: (baseRevision: number) => Promise<{ status: string }>
      rollback?: () => void
      failureRollbackDisposition?: (result: { status: string }) => 'retain' | 'rollback'
    }) => {
      const result = await args.command(1)
      if (
        result.status !== 'ok' &&
        (!args.failureRollbackDisposition || args.failureRollbackDisposition(result) === 'rollback')
      ) {
        args.rollback?.()
      }
      return result
    },
  ),
  subscribeServerCommandLocalEffectApplied: () => () => {},
  settingsGroupForKey: settingsGroupMocks.forKey,
}))

vi.mock('./pendingMutationOutbox', () => ({
  acknowledgePendingMutation: vi.fn(async (handle: { mutationId: string }) => {
    durabilityMocks.acknowledged.push(handle)
    return 'deleted'
  }),
  stagePendingMutation: vi.fn(
    (key: string, intent: unknown, previous?: { mutationId: string; phase: string } | null) => {
      if (previous?.phase === 'staged') previous.phase = 'superseded'
      const sequence = durabilityMocks.nextId++
      const mutationId = `settings-mutation-${sequence}`
      const handle = {
        key,
        mutationId,
        sequence,
        ownerWriterSessionId: 'writer-a',
        writerEpoch: 1,
        databaseLineage: 'database-a',
        phase: 'staged',
        ready: Promise.resolve('persisted'),
      }
      durabilityMocks.staged.push({ key, mutationId, intent })
      return handle
    },
  ),
}))

vi.mock('./durableMutationDispatch', () => ({
  registerDurableMutationSettlementListener: (
    mutationId: string,
    listener: (settlement: 'accepted' | 'discarded') => void,
  ) => {
    const listeners = durabilityMocks.settlementListeners.get(mutationId) ?? new Set()
    listeners.add(listener)
    durabilityMocks.settlementListeners.set(mutationId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) durabilityMocks.settlementListeners.delete(mutationId)
    }
  },
  dispatchDurableMutation: vi.fn(
    async (
      handle: { key: string; mutationId: string; phase: string },
      intent: unknown,
      dispatch: (options: Record<string, unknown>) => Promise<unknown>,
    ) => {
      handle.phase = 'dispatching'
      durabilityMocks.dispatched.push({ key: handle.key, mutationId: handle.mutationId, intent })
      return dispatch({
        mutationId: handle.mutationId,
        databaseLineage: 'database-a',
        failureRollbackDisposition: () => (durabilityMocks.retainFailures ? 'retain' : 'rollback'),
      })
    },
  ),
}))

vi.mock('./resourceReads', () => ({
  fetchServerSettingsGroup: vi.fn(async () => recorded.groupReads.shift() ?? { status: 'error', error: 'test' }),
}))

vi.mock('../alert', () => ({
  alertError: alertMocks.alertError,
  alertNormal: alertMocks.alertNormal,
}))

vi.mock('../process/templates/templates', () => ({
  prebuiltPresets: {
    OAI: presetMocks.OAI,
    OAI2: presetMocks.OAI2,
  },
}))

import type { HypaV3Preset } from '../process/memory/hypav3'
import { language } from '../../lang'
import {
  applyCollectionsResource,
  applySettingsResource,
  applySettingsGroupResource,
  applyShellSettingsResource,
  captureSettingsGroupProjectionEpoch,
  hasSettingsGroupProjectionEpochChanged,
  replaceResourceDatabase,
  settingsResourceState,
} from './resourceState.svelte'
import type { Database } from '../storage/database.svelte'
import '../stores.svelte'
import { notifyServerCommandLocalEffectApplied } from './commandLocalEffectEvents'
import { setSettingsRuntimeProjectionHook } from './settingsRuntimeProjectionHooks'
import type { SettingsGroup } from './settingsGroups'
import {
  applyOnboardingServerBackedSettings,
  applyServerBackedSettingsPatch,
  createServerBackedSettingDraft,
  flushPendingSettingsOwnerMutations,
  persistServerBackedSettingsPatch,
  persistServerBackedSettingsPatchWithSettlement,
  resetSettingsOwnerForDatabaseReplacement,
  type ServerBackedSettingDraft,
} from './settingsOwner.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

const DELAY = 50
let projectionRevision = 1_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function publishSettingsSettlement(mutationId: string, settlement: 'accepted' | 'discarded'): void {
  for (const listener of [...(durabilityMocks.settlementListeners.get(mutationId) ?? [])]) listener(settlement)
}

function sparseObjectAcceptedResult(input: (typeof recorded.objectPatches)[number]) {
  return {
    status: 'ok' as const,
    revision: input.baseRevision + 1,
    event: {
      type: 'settings.updated',
      revision: input.baseRevision + 1,
      resource: 'settings',
      id: input.group,
    },
    group: input.group,
    key: input.key,
    certificate: 'settings-object-patch-v1',
    patchedKeys: Object.keys(input.update.patch),
    deletedKeys: input.update.deleteKeys ?? [],
    canonicalValues: {},
    canonicalDeletedKeys: [],
  }
}

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

function hypaPreset(name: string, settings: Record<string, unknown> = {}): HypaV3Preset {
  return {
    id: name.toLocaleLowerCase(),
    name,
    settings: {
      summarizationPrompt: `${name} prompt`,
      alwaysToggleOn: false,
      ...settings,
    },
  } as unknown as HypaV3Preset
}

async function createSettingDraft<T>(
  key: string,
  fallback: T,
  onPersistenceStatus?: (status: import('./settingsOwner.svelte').SettingPersistenceStatus) => void,
): Promise<{ draft: ServerBackedSettingDraft<T>; stop: () => void }> {
  let draft: ServerBackedSettingDraft<T> | undefined
  const stop = $effect.root(() => {
    draft = createServerBackedSettingDraft(key, fallback, {
      delayMs: DELAY,
      onPersistenceStatus,
      retainFailedDraft: !!onPersistenceStatus,
    })
  })
  await flushAndSettle()
  if (!draft) {
    stop()
    throw new Error('setting draft was not initialized')
  }
  return { draft, stop }
}

async function flushAndSettle(): Promise<void> {
  flushSync()
  await Promise.resolve()
}

async function applyProjectionSetting(key: string, value: unknown): Promise<void> {
  ;(settingsResourceState.value as Record<string, unknown>)[key] = structuredClone(value)
  advanceProjectionForKey(key)
  await flushAndSettle()
}

function advanceProjectionForKey(key: string): void {
  const group = settingsGroupMocks.forKey(key)
  if (!group) throw new Error(`Missing test settings group for ${key}`)
  applySettingsGroupResource({ revision: ++projectionRevision, group: group as SettingsGroup, settings: {} }, [])
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.useFakeTimers()
  recorded.patches.length = 0
  recorded.patchResults.length = 0
  recorded.objectPatches.length = 0
  recorded.objectResults.length = 0
  recorded.groupReads.length = 0
  recorded.onboardingInputs.length = 0
  recorded.onboardingResults.length = 0
  projectionRevision = 1_000
  alertMocks.alertError.mockClear()
  alertMocks.alertNormal.mockClear()
  durabilityMocks.acknowledged.length = 0
  durabilityMocks.dispatched.length = 0
  durabilityMocks.nextId = 1
  durabilityMocks.retainFailures = false
  durabilityMocks.settlementListeners.clear()
  durabilityMocks.staged.length = 0
  presetMocks.setPreset.mockClear()
})

afterEach(async () => {
  for (const mutationId of [...durabilityMocks.settlementListeners.keys()]) {
    publishSettingsSettlement(mutationId, 'discarded')
  }
  await Promise.resolve()
  await Promise.resolve()
  durabilityMocks.settlementListeners.clear()
  setSettingsRuntimeProjectionHook(null)
  vi.useRealTimers()
  ;(testDatabaseState as { db: unknown }).db = {}
})

describe('settings owner mutations', () => {
  it.each(['accepted', 'discarded'] as const)(
    'settles an exact settings receipt as %s after writer loss without restoring its overlay',
    async (settlement) => {
      setupSettings({ textTheme: 'before' })
      enterClientWriter()
      durabilityMocks.retainFailures = true
      recorded.patchResults.push({ status: 'unavailable' })
      const receipt = await persistServerBackedSettingsPatchWithSettlement({ textTheme: 'old intent' })
      if (receipt.status !== 'queued') throw new Error('Expected queued settings intent')
      const listener = vi.fn()
      receipt.subscribeSettlement(listener)
      demoteClientSession()
      expect(applySettingsResource({ revision: 1, settings: { textTheme: 'old intent' } })).toBe(true)
      publishSettingsSettlement(receipt.mutationId, settlement)
      await expect(receipt.settlement).resolves.toBe(settlement === 'accepted' ? 'accepted' : 'failed')
      expect(listener).toHaveBeenCalledExactlyOnceWith(settlement === 'accepted' ? 'accepted' : 'failed')
      expect(testDatabaseState.db.textTheme).toBe('old intent')
      repromoteClientWriter()
      expect(
        applySettingsGroupResource({ revision: 2, group: 'display', settings: { textTheme: 'new server' } }, [
          'textTheme',
        ]),
      ).toBe(true)
      expect(testDatabaseState.db.textTheme).toBe('new server')
      expect(durabilityMocks.acknowledged).toEqual([])
    },
  )

  it.each(['patch', 'sparse'] as const)(
    'keeps held %s intent dormant across reader and repromoted resource reads',
    async (kind) => {
      const key = kind === 'patch' ? 'textTheme' : 'NAIImgConfig'
      const original = kind === 'patch' ? 'before' : { steps: 10 }
      const attempted = kind === 'patch' ? 'old intent' : { steps: 20 }
      const authoritative = kind === 'patch' ? 'server value' : { steps: 30 }
      setupSettings({ [key]: original })
      enterClientWriter()
      durabilityMocks.retainFailures = true
      const response = createDeferred<unknown>()
      if (kind === 'patch') recorded.patchResults.push(response.promise)
      else recorded.objectResults.push(response.promise)
      applyServerBackedSettingsPatch({ [key]: attempted })
      await flushAndSettle()
      expect(durabilityMocks.staged).toHaveLength(1)
      demoteClientSession()
      expect(applySettingsResource({ revision: 1, settings: { [key]: authoritative } })).toBe(true)
      expect(testDatabaseState.db[key]).toEqual(authoritative)
      repromoteClientWriter()
      expect(
        applySettingsGroupResource(
          { revision: 2, group: kind === 'patch' ? 'display' : 'media', settings: { [key]: authoritative } },
          [key],
        ),
      ).toBe(true)
      expect(testDatabaseState.db[key]).toEqual(authoritative)
      response.resolve({ status: 'unavailable' })
      await flushAndSettle()
      await flushAndSettle()
      if (kind === 'patch') {
        const shell: ServerShellSettings = {
          language: 'en',
          username: 'User',
          textTheme: 'server shell',
          colorSchemeName: 'custom',
          colorScheme: {
            bgcolor: '',
            darkbg: '',
            borderc: '',
            selected: '',
            draculared: '',
            textcolor: '',
            textcolor2: '',
            darkBorderc: '',
            darkbutton: '',
            type: 'dark',
          },
          customTextTheme: {
            FontColorStandard: '',
            FontColorBold: '',
            FontColorItalic: '',
            FontColorItalicBold: '',
            FontColorQuote1: '',
            FontColorQuote2: '',
          },
          font: 'default',
          customFont: '',
          customCSS: '',
          animationSpeed: 0.4,
          reducedMotion: false,
          heightMode: 'percent',
          sideBarSize: 0,
          desktopSidebarColumns: 1,
          mobileSidebarColumns: 1,
          roundIcons: false,
          menuSideBar: false,
          showFolderName: true,
          showSavingIcon: true,
          hamburgerButtonBottom: false,
          botSettingAtStart: false,
          enableDevTools: false,
          doNotWarnExternalServers: false,
          keepSessionAlive: 'off',
        }
        expect(applyShellSettingsResource({ revision: 3, settings: shell })).toBe(true)
        expect(testDatabaseState.db.textTheme).toBe('server shell')
      } else {
        expect(applySettingsResource({ revision: 3, settings: { [key]: authoritative } })).toBe(true)
        expect(testDatabaseState.db[key]).toEqual(authoritative)
      }
      expect(durabilityMocks.acknowledged).toEqual([])
      expect(durabilityMocks.staged).toHaveLength(1)
      publishSettingsSettlement(durabilityMocks.staged[0].mutationId, 'discarded')
      expect(testDatabaseState.db[key]).toEqual(kind === 'patch' ? 'server shell' : authoritative)
      resetSettingsOwnerForDatabaseReplacement()
    },
  )

  it('releases a dirty draft when replacement database ownership is adopted', async () => {
    setupSettings({ textTheme: 'before' })
    const { draft, stop } = await createSettingDraft('textTheme', '')

    draft.value = 'queued'
    await flushAndSettle()
    expect(testDatabaseState.db.textTheme).toBe('queued')

    resetSettingsOwnerForDatabaseReplacement()
    await applyProjectionSetting('textTheme', 'restored')

    expect(draft.value).toBe('restored')
    expect(testDatabaseState.db.textTheme).toBe('restored')
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches).toEqual([])
    stop()
  })

  it('persists stable Hypa selection drafts with their derived numeric projection', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })
    const { draft, stop } = await createSettingDraft<string | null>('selectedHypaV3PresetId', null)

    draft.value = 'beta'
    await flushAndSettle()

    expect(testDatabaseState.db.selectedHypaV3PresetId).toBe('beta')
    expect(testDatabaseState.db.hypaV3PresetId).toBe(1)
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([
      {
        selectedHypaV3PresetId: 'beta',
      },
    ])
    stop()
  })

  it('commits onboarding through the selected split-preset owners in one command', async () => {
    const persistence = createDeferred<{
      status: 'ok'
      revision: number
      event: { type: string; revision: number; resource: string }
      modelPresetId: string
      promptPresetId: string
    }>()
    recorded.onboardingResults.push(persistence.promise)
    setupSettings({
      language: 'cn',
      apiType: 'old-api',
      temperature: 0.2,
      mainPrompt: 'old prompt',
      maxContext: 4096,
      maxResponse: 256,
      textTheme: 'default',
      claudeCachingExperimental: false,
      aiModel: 'old-model',
      subModel: 'old-sub-model',
      openrouterRequestModel: 'old/openrouter',
      translator: 'en',
      translatorType: 'deepl',
      useAutoTranslateInput: false,
      didFirstSetup: false,
      modelPresetsId: 0,
      promptPresetsId: 0,
      modelPresets: [{ id: 'model-owner', name: 'Model owner', apiType: 'old-api', temperature: 0.2 }],
      promptPresets: [{ id: 'prompt-owner', name: 'Prompt owner', mainPrompt: 'old prompt' }],
      NAIsettings: {},
      seperateParameters: {
        emotion: {},
        memory: {},
        otherAx: {},
        overrides: {},
        scriptAux: {},
        scriptMain: {},
        translate: {},
      },
    })

    const setupResult = applyOnboardingServerBackedSettings({
      chatMemorySelection: 2,
      provider: 'openrouter',
      chatLang: 1,
    })
    await Promise.resolve()

    // The final screen remains pending while the single owner-aware command is
    // unresolved; it no longer exposes a settings-only optimistic projection.
    expect(testDatabaseState.db).toMatchObject({
      apiType: 'old-api',
      mainPrompt: 'old prompt',
      didFirstSetup: false,
    })
    expect(recorded.patches).toHaveLength(0)
    expect(recorded.onboardingInputs).toEqual([
      expect.objectContaining({
        baseRevision: 1,
        modelPresetId: 'model-owner',
        promptPresetId: 'prompt-owner',
        modelPatch: expect.objectContaining({
          apiType: 'preset-api',
          temperature: 0.75,
          maxContext: 12000,
          maxResponse: 800,
          aiModel: 'openrouter',
          subModel: 'openrouter',
          openrouterRequestModel: 'risu/free',
        }),
        promptPatch: expect.objectContaining({
          mainPrompt: 'preset prompt',
        }),
        settingsPatch: {
          textTheme: 'highcontrast',
          claudeCachingExperimental: true,
          translator: 'zh',
          translatorType: 'google',
          useAutoTranslateInput: true,
          didFirstSetup: true,
        },
      }),
    ])
    expect(recorded.onboardingInputs[0].modelPatch).not.toHaveProperty('openAIKey')

    persistence.resolve({
      status: 'ok',
      revision: 2,
      event: { type: 'onboarding.completed', revision: 2, resource: 'legacyBotPreset' },
      modelPresetId: 'model-owner',
      promptPresetId: 'prompt-owner',
    })
    expect(await setupResult).toBe(true)
  })

  it('skips immediate patches whose values already match the projection', async () => {
    setupSettings({
      notification: true,
      sdConfig: { steps: 20, sampler: 'euler' },
    })

    applyServerBackedSettingsPatch({
      notification: true,
      sdConfig: { steps: 20, sampler: 'euler' },
    })
    await Promise.resolve()

    expect(recorded.patches).toHaveLength(0)
    expect(testDatabaseState.db).toMatchObject({
      notification: true,
      sdConfig: { steps: 20, sampler: 'euler' },
    })
  })

  it('sends only changed keys from immediate mixed patches', async () => {
    setupSettings({
      notification: true,
      useAutoSuggestions: false,
    })

    applyServerBackedSettingsPatch({
      notification: true,
      useAutoSuggestions: true,
    })
    await Promise.resolve()

    expect(recorded.patches.map((entry) => entry.patch)).toEqual([{ useAutoSuggestions: true }])
    expect(testDatabaseState.db).toMatchObject({
      notification: true,
      useAutoSuggestions: true,
    })
  })

  it('reports an ordinary settings write failure once while preserving rollback', async () => {
    recorded.patchResults.push({ status: 'error', error: 'failed' })
    setupSettings({ notification: false })

    applyServerBackedSettingsPatch({ notification: true })
    await flushAndSettle()
    await flushAndSettle()

    expect(testDatabaseState.db.notification).toBe(false)
    expect(alertMocks.alertError).toHaveBeenCalledTimes(1)
    expect(alertMocks.alertError).toHaveBeenCalledWith(language.errors.settingsSaveFailed)

    recorded.patches[0].rollback?.()
    expect(alertMocks.alertError).toHaveBeenCalledTimes(1)
  })

  it('restores only still-attempted keys from a multi-key settings rollback', async () => {
    setupSettings({
      notification: false,
      textTheme: 'before',
    })

    applyServerBackedSettingsPatch({
      notification: true,
      textTheme: 'attempted',
    })
    await Promise.resolve()

    testDatabaseState.db.textTheme = 'newer local'
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.notification).toBe(false)
    expect(testDatabaseState.db.textTheme).toBe('newer local')
  })

  it('reapplies runtime effects only for setting fields actually rolled back', async () => {
    const projectedKeys: string[][] = []
    setSettingsRuntimeProjectionHook((keys) => projectedKeys.push([...keys]))
    setupSettings({
      notification: false,
      textTheme: 'before',
    })

    applyServerBackedSettingsPatch({
      notification: true,
      textTheme: 'attempted',
    })
    await Promise.resolve()

    testDatabaseState.db.textTheme = 'newer local'
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.notification).toBe(false)
    expect(testDatabaseState.db.textTheme).toBe('newer local')
    expect(projectedKeys).toEqual([['notification']])
  })

  it('overlays an in-flight direct setting across full and grouped authoritative reads', async () => {
    const persistence = createDeferred<unknown>()
    recorded.patchResults.push(persistence.promise)
    setupSettings({ notification: false })

    applyServerBackedSettingsPatch({ notification: true })
    await flushAndSettle()
    expect(testDatabaseState.db.notification).toBe(true)
    expect(alertMocks.alertError).not.toHaveBeenCalled()
    expect(alertMocks.alertNormal).not.toHaveBeenCalled()

    expect(applySettingsResource({ revision: 1, settings: { notification: false } })).toBe(true)
    expect(testDatabaseState.db.notification).toBe(true)
    expect(
      applySettingsGroupResource({ revision: 1, group: 'display', settings: { notification: false } }, [
        'notification',
      ]),
    ).toBe(true)
    expect(testDatabaseState.db.notification).toBe(true)

    persistence.resolve({ status: 'ok', revision: 2 })
    await flushAndSettle()
    expect(testDatabaseState.db.notification).toBe(true)
  })

  it('keeps a retained direct setting projected until replay acceptance is observed', async () => {
    durabilityMocks.retainFailures = true
    recorded.patchResults.push({ status: 'error', error: 'temporarily unavailable' })
    setupSettings({ notification: false })

    applyServerBackedSettingsPatch({ notification: true })
    await flushAndSettle()
    expect(testDatabaseState.db.notification).toBe(true)
    expect(alertMocks.alertError).not.toHaveBeenCalled()
    expect(alertMocks.alertNormal).toHaveBeenCalledOnce()
    expect(alertMocks.alertNormal).toHaveBeenCalledWith(language.settingsSaveQueued)

    expect(applySettingsResource({ revision: 1, settings: { notification: false } })).toBe(true)
    expect(testDatabaseState.db.notification).toBe(true)
    expect(
      applySettingsGroupResource({ revision: 1, group: 'display', settings: { notification: false } }, [
        'notification',
      ]),
    ).toBe(true)
    expect(testDatabaseState.db.notification).toBe(true)

    const mutationId = durabilityMocks.dispatched[0].mutationId
    publishSettingsSettlement(mutationId, 'accepted')
    expect(
      applySettingsGroupResource({ revision: 2, group: 'display', settings: { notification: true } }, ['notification']),
    ).toBe(true)
    expect(
      applySettingsGroupResource({ revision: 3, group: 'display', settings: { notification: false } }, [
        'notification',
      ]),
    ).toBe(true)
    expect(testDatabaseState.db.notification).toBe(false)
  })

  it('rolls back a retained direct setting after final durable discard', async () => {
    durabilityMocks.retainFailures = true
    recorded.patchResults.push({ status: 'error', error: 'temporarily unavailable' })
    setupSettings({ notification: false })

    applyServerBackedSettingsPatch({ notification: true })
    await flushAndSettle()
    expect(applySettingsResource({ revision: 1, settings: { notification: false } })).toBe(true)
    expect(testDatabaseState.db.notification).toBe(true)
    expect(alertMocks.alertError).not.toHaveBeenCalled()
    expect(alertMocks.alertNormal).toHaveBeenCalledWith(language.settingsSaveQueued)

    publishSettingsSettlement(durabilityMocks.dispatched[0].mutationId, 'discarded')
    expect(testDatabaseState.db.notification).toBe(false)
    expect(alertMocks.alertError).toHaveBeenCalledOnce()
    expect(
      applySettingsGroupResource({ revision: 2, group: 'display', settings: { notification: false } }, [
        'notification',
      ]),
    ).toBe(true)
    expect(testDatabaseState.db.notification).toBe(false)
  })

  it('overlays a retained collection-backed direct setting on collection refresh', async () => {
    durabilityMocks.retainFailures = true
    recorded.patchResults.push({ status: 'error', error: 'temporarily unavailable' })
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
      selectedHypaV3PresetId: 'imported',
      hypaV3PresetId: 1,
    })
    await flushAndSettle()

    expect(
      applyCollectionsResource(
        {
          revision: 1,
          collections: { hypaV3Presets: [hypaPreset('Alpha')] },
        } as never,
        'hypaV3Presets',
      ),
    ).toBe(true)
    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha'), hypaPreset('Imported')])
  })

  it('rebases a later same-key rollback after two immediate settings writes fail', async () => {
    const firstResult = createDeferred<unknown>()
    const secondResult = createDeferred<unknown>()
    recorded.patchResults.push(firstResult.promise, secondResult.promise)
    setupSettings({ textTheme: 'server baseline' })

    applyServerBackedSettingsPatch({ textTheme: 'first attempt' })
    applyServerBackedSettingsPatch({ textTheme: 'second attempt' })
    await flushAndSettle()

    expect(testDatabaseState.db.textTheme).toBe('second attempt')
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([
      { textTheme: 'first attempt' },
      { textTheme: 'second attempt' },
    ])

    firstResult.resolve({ status: 'error', error: 'first failed' })
    await flushAndSettle()
    expect(testDatabaseState.db.textTheme).toBe('second attempt')

    secondResult.resolve({ status: 'error', error: 'second failed' })
    await flushAndSettle()
    expect(testDatabaseState.db.textTheme).toBe('server baseline')
  })

  it('preserves the existing undefined/no-delete behavior when rolling back an added setting', async () => {
    setupSettings({})

    applyServerBackedSettingsPatch({ textTheme: 'attempted' })
    await Promise.resolve()

    expect(testDatabaseState.db.textTheme).toBe('attempted')

    recorded.patches[0].rollback?.()

    expect(Object.hasOwn(testDatabaseState.db, 'textTheme')).toBe(true)
    expect(testDatabaseState.db.textTheme).toBeUndefined()
  })

  it('awaits the exact durable Hypa import patch before resolving success', async () => {
    const persistence = createDeferred<unknown>()
    recorded.patchResults.push(persistence.promise)
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    let settled = false
    const result = persistServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
      selectedHypaV3PresetId: 'imported',
      hypaV3PresetId: 1,
    }).then((outcome) => {
      settled = true
      return outcome
    })
    await flushAndSettle()

    expect(settled).toBe(false)
    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha'), hypaPreset('Imported')])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(1)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([
      {
        hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
        selectedHypaV3PresetId: 'imported',
        hypaV3PresetId: 1,
      },
    ])

    persistence.resolve({ status: 'ok', revision: 1 })
    expect(await result).toBe('accepted')
  })

  it('rolls back and rejects a terminal durable Hypa import', async () => {
    recorded.patchResults.push({ status: 'error', error: 'failed' })
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    const outcome = await persistServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
      selectedHypaV3PresetId: 'imported',
      hypaV3PresetId: 1,
    })

    expect(outcome).toBe('failed')
    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha')])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(0)
    expect(alertMocks.alertError).toHaveBeenCalledTimes(1)
  })

  it('reports a retained durable Hypa import as queued without rolling back its pending projection', async () => {
    durabilityMocks.retainFailures = true
    recorded.patchResults.push({ status: 'error', error: 'temporarily unavailable' })
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    const outcome = await persistServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
      selectedHypaV3PresetId: 'imported',
      hypaV3PresetId: 1,
    })

    expect(outcome).toBe('queued')
    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha'), hypaPreset('Imported')])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(1)
    expect(alertMocks.alertError).not.toHaveBeenCalled()
    expect(alertMocks.alertNormal).not.toHaveBeenCalled()
  })

  it.each([
    { durableSettlement: 'accepted' as const, finalSettlement: 'accepted' as const, notification: false },
    { durableSettlement: 'discarded' as const, finalSettlement: 'failed' as const, notification: true },
  ])(
    'reports queued exact-setting replay as $finalSettlement',
    async ({ durableSettlement, finalSettlement, notification }) => {
      durabilityMocks.retainFailures = true
      recorded.patchResults.push({ status: 'error', error: 'temporarily unavailable' })
      setupSettings({ notification: true })

      const receipt = await persistServerBackedSettingsPatchWithSettlement({ notification: false })

      expect(receipt.status).toBe('queued')
      if (receipt.status !== 'queued') throw new Error('expected queued settings receipt')
      const subscriber = vi.fn()
      receipt.subscribeSettlement(subscriber)

      publishSettingsSettlement(receipt.mutationId, durableSettlement)

      expect(subscriber).toHaveBeenCalledWith(finalSettlement)
      await expect(receipt.settlement).resolves.toBe(finalSettlement)
      expect(testDatabaseState.db.notification).toBe(notification)
    },
  )

  it('returns a discarded exact-setting receipt while its old HTTP request remains pending', async () => {
    const command = createDeferred<unknown>()
    recorded.patchResults.push(command.promise)
    setupSettings({ notification: true })

    const receipt = persistServerBackedSettingsPatchWithSettlement({ notification: false })
    await vi.waitFor(() => expect(durabilityMocks.dispatched).toHaveLength(1))
    resetSettingsOwnerForDatabaseReplacement()
    publishSettingsSettlement(durabilityMocks.dispatched[0].mutationId, 'discarded')

    await expect(receipt).resolves.toEqual({ status: 'failed' })
  })

  it('removes only the failed Hypa V3 appended preset while preserving sibling edits and later appends', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta'), hypaPreset('Imported')],
    })
    await Promise.resolve()

    testDatabaseState.db.hypaV3Presets = [
      hypaPreset('Alpha', { summarizationPrompt: 'newer alpha prompt' }),
      hypaPreset('Beta'),
      hypaPreset('Imported'),
      hypaPreset('Later local'),
    ]
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([
      hypaPreset('Alpha', { summarizationPrompt: 'newer alpha prompt' }),
      hypaPreset('Beta'),
      hypaPreset('Later local'),
    ])
  })

  it('keeps a failed Hypa V3 appended preset when that row changed after dispatch', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Imported')],
    })
    await Promise.resolve()

    testDatabaseState.db.hypaV3Presets = [
      hypaPreset('Alpha'),
      hypaPreset('Imported', { summarizationPrompt: 'edited after dispatch' }),
      hypaPreset('Later local'),
    ]
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([
      hypaPreset('Alpha'),
      hypaPreset('Imported', { summarizationPrompt: 'edited after dispatch' }),
      hypaPreset('Later local'),
    ])
  })

  it('restores only the failed Hypa V3 renamed row while preserving sibling edits', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })
    const renamedAlpha = { ...hypaPreset('Alpha'), name: 'Alpha renamed' }

    applyServerBackedSettingsPatch({
      hypaV3Presets: [renamedAlpha, hypaPreset('Beta')],
    })
    await Promise.resolve()

    testDatabaseState.db.hypaV3Presets = [
      renamedAlpha,
      hypaPreset('Beta', { summarizationPrompt: 'newer beta prompt' }),
      hypaPreset('Later local'),
    ]
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([
      hypaPreset('Alpha'),
      hypaPreset('Beta', { summarizationPrompt: 'newer beta prompt' }),
      hypaPreset('Later local'),
    ])
  })

  it('reinserts a failed Hypa V3 deleted preset at its prior index and restores attempted-matching selection', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta'), hypaPreset('Gamma')],
      selectedHypaV3PresetId: 'beta',
      hypaV3PresetId: 1,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Gamma')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })
    await Promise.resolve()

    testDatabaseState.db.hypaV3Presets = [
      hypaPreset('Alpha', { summarizationPrompt: 'newer alpha prompt' }),
      hypaPreset('Gamma'),
      hypaPreset('Later local'),
    ]
    testDatabaseState.db.hypaV3PresetId = 0
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([
      hypaPreset('Alpha', { summarizationPrompt: 'newer alpha prompt' }),
      hypaPreset('Beta'),
      hypaPreset('Gamma'),
      hypaPreset('Later local'),
    ])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(1)
    expect(testDatabaseState.db.selectedHypaV3PresetId).toBe('beta')
  })

  it('rebases newer live Hypa V3 selection when a failed delete rollback reinserts before it', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta'), hypaPreset('Gamma'), hypaPreset('Delta')],
      selectedHypaV3PresetId: 'beta',
      hypaV3PresetId: 1,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Gamma'), hypaPreset('Delta')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })
    await Promise.resolve()

    testDatabaseState.db.selectedHypaV3PresetId = 'delta'
    testDatabaseState.db.hypaV3PresetId = 2
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([
      hypaPreset('Alpha'),
      hypaPreset('Beta'),
      hypaPreset('Gamma'),
      hypaPreset('Delta'),
    ])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(3)
    expect(testDatabaseState.db.selectedHypaV3PresetId).toBe('delta')
  })

  it('does not duplicate a failed Hypa V3 deleted preset when an equivalent row is already live', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta'), hypaPreset('Gamma')],
      selectedHypaV3PresetId: 'beta',
      hypaV3PresetId: 1,
    })

    applyServerBackedSettingsPatch({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Gamma')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })
    await Promise.resolve()

    testDatabaseState.db.hypaV3Presets = [hypaPreset('Alpha'), hypaPreset('Gamma'), hypaPreset('Beta')]
    testDatabaseState.db.hypaV3PresetId = 0
    recorded.patches[0].rollback?.()

    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha'), hypaPreset('Gamma'), hypaPreset('Beta')])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(0)
  })

  it('rejects numeric-only Hypa V3 selection patches', async () => {
    setupSettings({
      hypaV3Presets: [hypaPreset('Alpha'), hypaPreset('Beta')],
      selectedHypaV3PresetId: 'alpha',
      hypaV3PresetId: 0,
    })

    applyServerBackedSettingsPatch({ hypaV3PresetId: 1 })
    await Promise.resolve()

    expect(recorded.patches).toEqual([])
    expect(testDatabaseState.db.hypaV3PresetId).toBe(0)
    expect(testDatabaseState.db.selectedHypaV3PresetId).toBe('alpha')
    expect(testDatabaseState.db.hypaV3Presets).toEqual([hypaPreset('Alpha'), hypaPreset('Beta')])
  })

  it('preserves a dirty setting draft through a stale projection', async () => {
    setupSettings({
      globalscript: [{ id: 'script-a', in: 'server old', out: '', type: 'editinput' }],
    })
    const { draft, stop } = await createSettingDraft('globalscript', [] as Array<Record<string, string>>)

    draft.value = [{ id: 'script-a', in: 'local dirty', out: '', type: 'editinput' }]
    await flushAndSettle()

    await applyProjectionSetting('globalscript', [{ id: 'script-a', in: 'stale server', out: '', type: 'editinput' }])

    expect(draft.value).toEqual([{ id: 'script-a', in: 'local dirty', out: '', type: 'editinput' }])
    expect(testDatabaseState.db.globalscript).toEqual([
      { id: 'script-a', in: 'local dirty', out: '', type: 'editinput' },
    ])
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([
      {
        globalscript: [{ id: 'script-a', in: 'local dirty', out: '', type: 'editinput' }],
      },
    ])
    stop()
  })

  it('rebases an ID-addressable draft and its staged patch over an authoritative sibling edit', async () => {
    const baseline = [
      { id: 'model-a', name: 'Model A', url: 'https://old-a.example' },
      { id: 'model-b', name: 'Model B', url: 'https://old-b.example' },
    ]
    setupSettings({ customModels: baseline })
    const { draft, stop } = await createSettingDraft('customModels', [] as Array<Record<string, string>>)

    draft.value = [{ ...baseline[0], url: 'https://local-a.example' }, baseline[1]]
    await flushAndSettle()
    await applyProjectionSetting('customModels', [
      baseline[0],
      { ...baseline[1], url: 'https://authoritative-b.example' },
    ])

    const rebased = [
      { ...baseline[0], url: 'https://local-a.example' },
      { ...baseline[1], url: 'https://authoritative-b.example' },
    ]
    expect(draft.value).toEqual(rebased)
    expect(testDatabaseState.db.customModels).toEqual(rebased)

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([{ customModels: rebased }])
    expect(durabilityMocks.dispatched.at(-1)?.intent).toMatchObject({
      requests: [{ body: { patch: { customModels: rebased } } }],
    })
    stop()
  })

  it('rebases independent set additions before dispatch', async () => {
    setupSettings({ banCharacterset: ['baseline'] })
    const { draft, stop } = await createSettingDraft('banCharacterset', [] as string[])

    draft.value = ['baseline', 'local addition']
    await flushAndSettle()
    await applyProjectionSetting('banCharacterset', ['baseline', 'authoritative addition'])

    expect(draft.value).toEqual(['baseline', 'authoritative addition', 'local addition'])
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([
      { banCharacterset: ['baseline', 'authoritative addition', 'local addition'] },
    ])
    stop()
  })

  it('rebases a nested object field over authoritative sibling changes', async () => {
    const baseline = {
      provider: { endpoint: 'old endpoint', timeout: 30 },
      output: { width: 512, height: 768 },
    }
    setupSettings({ sdConfig: baseline })
    const { draft, stop } = await createSettingDraft('sdConfig', {} as Record<string, unknown>)

    draft.value = {
      ...baseline,
      provider: { ...baseline.provider, endpoint: 'local endpoint' },
    }
    await flushAndSettle()
    await applyProjectionSetting('sdConfig', {
      ...baseline,
      output: { width: 1024, height: 768 },
    })

    const rebased = {
      provider: { endpoint: 'local endpoint', timeout: 30 },
      output: { width: 1024, height: 768 },
    }
    expect(draft.value).toEqual(rebased)
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches.map((entry) => entry.patch)).toEqual([{ sdConfig: rebased }])
    stop()
  })

  it('rejects ambiguous concurrent row reorders before dispatch', async () => {
    const rowA = { id: 'a', name: 'A' }
    const rowB = { id: 'b', name: 'B' }
    const rowC = { id: 'c', name: 'C' }
    setupSettings({ customModels: [rowA, rowB, rowC] })
    const { draft, stop } = await createSettingDraft('customModels', [] as Array<Record<string, string>>)

    draft.value = [rowB, rowA, rowC]
    await flushAndSettle()
    await applyProjectionSetting('customModels', [rowA, rowC, rowB])

    expect(draft.value).toEqual([rowA, rowC, rowB])
    expect(testDatabaseState.db.customModels).toEqual([rowA, rowC, rowB])
    expect(alertMocks.alertError).toHaveBeenCalledWith(language.errors.settingsSaveFailed)
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.patches).toHaveLength(0)
    stop()
  })

  it('adopts a canonical value from the applied local effect for its own setting attempt', async () => {
    setupSettings({ textTheme: 'server initial' })
    const { draft, stop } = await createSettingDraft('textTheme', '')

    draft.value = 'attempted theme'
    await flushAndSettle()
    await vi.advanceTimersByTimeAsync(DELAY)

    testDatabaseState.db.textTheme = 'canonical theme'
    advanceProjectionForKey('textTheme')
    notifyServerCommandLocalEffectApplied(
      {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'display',
      },
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { textTheme: 'attempted theme' },
        settings: { textTheme: 'canonical theme' },
        settingsProjectionEpoch: 0,
      },
    )
    await flushAndSettle()

    expect(draft.value).toBe('canonical theme')
    expect(testDatabaseState.db.textTheme).toBe('canonical theme')
    stop()
  })

  it('preserves a dirty draft when an older receipt skipped its canonical field', async () => {
    setupSettings({ textTheme: 'server initial' })
    const { draft, stop } = await createSettingDraft('textTheme', '')

    draft.value = 'attempted theme'
    await flushAndSettle()
    await vi.advanceTimersByTimeAsync(DELAY)

    testDatabaseState.db.textTheme = 'newer resource value'
    advanceProjectionForKey('textTheme')
    notifyServerCommandLocalEffectApplied(
      {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'display',
      },
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { textTheme: 'attempted theme' },
        settings: { textTheme: 'canonical theme' },
        settingsProjectionEpoch: 0,
      },
    )
    await flushAndSettle()

    expect(draft.value).toBe('attempted theme')
    expect(testDatabaseState.db.textTheme).toBe('attempted theme')
    stop()
  })

  it('supports a normalized draft whose persistence is owned by a specialized mutation owner', async () => {
    setupSettings({ globalscript: [{ in: 'old', out: '', type: 'editinput' }] })
    let draft: ServerBackedSettingDraft<Array<Record<string, string>>> | undefined
    const stop = $effect.root(() => {
      draft = createServerBackedSettingDraft('globalscript', [], {
        delayMs: DELAY,
        dispatch: false,
        normalizeDraft: (scripts) => scripts.map((script) => ({ id: script.id ?? 'generated-id', ...script })),
      })
    })
    await flushAndSettle()

    expect(draft?.value).toEqual([{ id: 'generated-id', in: 'old', out: '', type: 'editinput' }])
    draft!.value = [{ id: 'generated-id', in: 'edited', out: '', type: 'editinput' }]
    await flushAndSettle()
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(testDatabaseState.db.globalscript).toEqual([
      { id: 'generated-id', in: 'edited', out: '', type: 'editinput' },
    ])
    expect(recorded.patches).toEqual([])
    stop()
  })

  it('does not clear dirty state from projection equality alone', async () => {
    setupSettings({
      globalscript: [{ id: 'script-a', in: 'server old', out: '', type: 'editinput' }],
    })
    const { draft, stop } = await createSettingDraft('globalscript', [] as Array<Record<string, string>>)

    draft.value = [{ id: 'script-a', in: 'local accepted', out: '', type: 'editinput' }]
    await flushAndSettle()

    await applyProjectionSetting('globalscript', [{ id: 'script-a', in: 'local accepted', out: '', type: 'editinput' }])
    await applyProjectionSetting('globalscript', [{ id: 'script-a', in: 'server later', out: '', type: 'editinput' }])

    expect(draft.value).toEqual([{ id: 'script-a', in: 'local accepted', out: '', type: 'editinput' }])
    expect(testDatabaseState.db.globalscript).toEqual([
      { id: 'script-a', in: 'local accepted', out: '', type: 'editinput' },
    ])
    stop()
  })

  it('keeps a newer dirty draft fenced after an older acknowledgement', async () => {
    setupSettings({ textTheme: 'A' })
    const { draft, stop } = await createSettingDraft('textTheme', '')

    draft.value = 'B'
    await flushAndSettle()
    draft.value = 'C'
    await flushAndSettle()

    advanceProjectionForKey('textTheme')
    notifyServerCommandLocalEffectApplied(
      {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'test',
      },
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { textTheme: 'B' },
        settings: { textTheme: 'B' },
        settingsProjectionEpoch: 0,
      },
    )
    await flushAndSettle()
    await applyProjectionSetting('textTheme', 'B')

    expect(draft.value).toBe('C')
    expect(testDatabaseState.db.textTheme).toBe('C')
    stop()
  })

  it('reseeds a clean setting draft from a later server projection', async () => {
    setupSettings({
      globalscript: [{ id: 'script-a', in: 'server old', out: '', type: 'editinput' }],
    })
    const { draft, stop } = await createSettingDraft('globalscript', [] as Array<Record<string, string>>)

    await applyProjectionSetting('globalscript', [{ id: 'script-a', in: 'clean server', out: '', type: 'editinput' }])

    expect(draft.value).toEqual([{ id: 'script-a', in: 'clean server', out: '', type: 'editinput' }])
    stop()
  })
})

it.each([false, true])(
  'retains settings draft intent without dispatch after demotion (repromoted: %s)',
  async (repromoted) => {
    setupSettings({ notification: false, NAIImgConfig: { steps: 20 } })
    enterClientWriter()
    const normal = await createSettingDraft('notification', false)
    const sparse = await createSettingDraft('NAIImgConfig', { steps: 20 })
    try {
      normal.draft.value = true
      sparse.draft.value = { steps: 30 }
      await flushAndSettle()
      const staged = [...durabilityMocks.staged]
      expect(JSON.stringify(staged)).toContain('notification')
      expect(JSON.stringify(staged)).toContain('NAIImgConfig')
      demoteClientSession()
      if (repromoted) repromoteClientWriter()
      await vi.advanceTimersByTimeAsync(DELAY * 2)
      flushPendingSettingsOwnerMutations()
      expect(durabilityMocks.staged).toEqual(staged)
      expect(durabilityMocks.dispatched).toEqual([])
      expect(durabilityMocks.acknowledged).toEqual([])
      expect(recorded.patches).toEqual([])
      expect(recorded.objectPatches).toEqual([])
      expect(normal.draft.value).toBe(true)
      expect(sparse.draft.value).toEqual({ steps: 30 })
    } finally {
      normal.stop()
      sparse.stop()
      resetSettingsOwnerForDatabaseReplacement()
      resetClientSessionForTests()
    }
  },
)

it('does not apply a settings draft effect that runs after demotion and re-promotion', async () => {
  setupSettings({ notification: false })
  enterClientWriter()
  const mounted = await createSettingDraft('notification', false)
  try {
    mounted.draft.value = true
    demoteClientSession()
    repromoteClientWriter()
    await flushAndSettle()
    expect(testDatabaseState.db.notification).toBe(false)
    expect(mounted.draft.value).toBe(true)
    expect(durabilityMocks.staged).toEqual([])
    expect(recorded.patches).toEqual([])
  } finally {
    mounted.stop()
    resetClientSessionForTests()
  }
})

it('captures pre-effect typing against the same normalized baseline that seeded the editor', async () => {
  setupSettings({ globalscript: [{ in: 'Original' }] })
  let nextId = 0
  let draft!: ReturnType<typeof createServerBackedSettingDraft<Array<{ id?: string; in: string }>>>
  const stop = $effect.root(() => {
    draft = createServerBackedSettingDraft<Array<{ id?: string; in: string }>>('globalscript', [{ in: 'Original' }], {
      dispatch: false,
      normalizeDraft: (rows) => rows.map((row) => ({ ...row, id: row.id ?? `normalized-${++nextId}` })),
    })
  })
  try {
    await flushAndSettle()
    expect(draft.captureRecoveryDraft()).toBeNull()
    draft.value[0].in = 'Unsubmitted input'
    expect(draft.captureRecoveryDraft()).toMatchObject({
      value: [{ in: 'Unsubmitted input' }],
      baseline: [{ in: 'Original' }],
    })
  } finally {
    stop()
  }
})

describe('whole-field autosave feedback', () => {
  it('preserves failed hook records and saves newer input without replaying the failed snapshot', async () => {
    const original = [{ id: 'hook', name: 'Draft', type: 'draft', prompt: 'Original prompt' }]
    setupSettings({ inputHooks: original })
    recorded.patchResults.push({ status: 'error', error: 'failed' })
    const report = vi.fn()
    const { draft, stop } = await createSettingDraft('inputHooks', original, report)
    try {
      draft.value = [{ ...original[0], prompt: 'Failed edit' }]
      await flushAndSettle()
      await vi.advanceTimersByTimeAsync(DELAY)
      await flushAndSettle()
      expect(report).toHaveBeenLastCalledWith('failed')
      expect(draft.value[0].prompt).toBe('Failed edit')
      expect(recorded.patches).toHaveLength(1)
      draft.value = [{ ...draft.value[0], prompt: 'Newer edit' }]
      await flushAndSettle()
      await vi.advanceTimersByTimeAsync(DELAY)
      expect(recorded.patches.at(-1)?.patch.inputHooks).toEqual([{ ...original[0], prompt: 'Newer edit' }])
      expect(report).toHaveBeenLastCalledWith('accepted')
    } finally {
      stop()
    }
  })

  it('waits for the latest edit receipt before reporting accepted', async () => {
    setupSettings({ textTheme: 'original' })
    const first = createDeferred<unknown>()
    const second = createDeferred<unknown>()
    recorded.patchResults.push(first.promise, second.promise)
    const report = vi.fn()
    const { draft, stop } = await createSettingDraft('textTheme', 'original', report)
    try {
      expect(report).not.toHaveBeenCalled()
      draft.value = 'first edit'
      await flushAndSettle()
      expect(report).toHaveBeenLastCalledWith('saving')
      await vi.advanceTimersByTimeAsync(DELAY)
      draft.value = 'second edit'
      await flushAndSettle()
      await vi.advanceTimersByTimeAsync(DELAY)
      first.resolve({ status: 'ok', revision: 2 })
      await vi.advanceTimersByTimeAsync(0)
      expect(report).toHaveBeenLastCalledWith('saving')
      second.resolve({ status: 'ok', revision: 3 })
      await vi.advanceTimersByTimeAsync(0)
      expect(report).toHaveBeenLastCalledWith('accepted')
      expect(draft.value).toBe('second edit')
    } finally {
      stop()
    }
  })

  it.each(['accepted', 'discarded'] as const)(
    'reports queued saves until their final %s receipt',
    async (settlement) => {
      setupSettings({ textTheme: 'original' })
      durabilityMocks.retainFailures = true
      recorded.patchResults.push({ status: 'unavailable' })
      const report = vi.fn()
      const { draft, stop } = await createSettingDraft('textTheme', 'original', report)
      try {
        draft.value = 'queued edit'
        await flushAndSettle()
        await vi.advanceTimersByTimeAsync(DELAY)
        expect(report).toHaveBeenLastCalledWith('queued')
        expect(report).not.toHaveBeenCalledWith('accepted')
        publishSettingsSettlement(durabilityMocks.dispatched[0].mutationId, settlement)
        await flushAndSettle()
        expect(report).toHaveBeenLastCalledWith(settlement === 'accepted' ? 'accepted' : 'failed')
        expect(draft.value).toBe('queued edit')
      } finally {
        stop()
      }
    },
  )

  it('retains failed input and retries the current draft through the durable queue', async () => {
    setupSettings({ textTheme: 'original' })
    recorded.patchResults.push({ status: 'error', error: 'failed' })
    const report = vi.fn()
    const { draft, stop } = await createSettingDraft('textTheme', 'original', report)
    try {
      draft.value = 'keep my edit'
      await flushAndSettle()
      await vi.advanceTimersByTimeAsync(DELAY)
      await flushAndSettle()
      expect(report).toHaveBeenLastCalledWith('failed')
      expect(draft.value).toBe('keep my edit')
      draft.retryPersistence()
      expect(report).toHaveBeenLastCalledWith('saving')
      await vi.advanceTimersByTimeAsync(0)
      expect(recorded.patches.at(-1)?.patch).toEqual({ textTheme: 'keep my edit' })
      expect(report).toHaveBeenLastCalledWith('accepted')
    } finally {
      stop()
    }
  })

  it('ignores a queued predecessor settlement after a newer edit and stops notifying after unmount', async () => {
    setupSettings({ textTheme: 'original' })
    durabilityMocks.retainFailures = true
    recorded.patchResults.push({ status: 'unavailable' }, { status: 'unavailable' })
    const report = vi.fn()
    const { draft, stop } = await createSettingDraft('textTheme', 'original', report)
    draft.value = 'first edit'
    await flushAndSettle()
    await vi.advanceTimersByTimeAsync(DELAY)
    const firstId = durabilityMocks.dispatched[0].mutationId
    draft.value = 'latest edit'
    await flushAndSettle()
    await vi.advanceTimersByTimeAsync(DELAY)
    publishSettingsSettlement(firstId, 'accepted')
    expect(report).toHaveBeenLastCalledWith('queued')
    const count = report.mock.calls.length
    stop()
    publishSettingsSettlement(durabilityMocks.dispatched[1].mutationId, 'accepted')
    expect(report).toHaveBeenCalledTimes(count)
  })
})
