import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const botSettingsMocks = vi.hoisted(() => {
  function deferredResult() {
    let resolve!: (value: Record<string, unknown>) => void
    const promise = new Promise<Record<string, unknown>>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }
  return {
    patchInputs: [] as Array<Record<string, unknown>>,
    patchTransportOptions: [] as Array<{ signal?: AbortSignal | null; keepalive?: boolean }>,
    runInputs: [] as Array<{ signal?: AbortSignal | null; keepalive?: boolean }>,
    failNextPatch: false,
    deferNextPatch: false,
    deferredPatchResults: [] as Array<ReturnType<typeof deferredResult>>,
    deferredResult,
    enableInputs: [] as Array<Record<string, unknown>>,
    failNextEnableTerminal: false,
    failNextEnableTransient: false,
    failNextPromptItemUpdateTransient: false,
    promptItemUpdateInputs: [] as Array<Record<string, unknown>>,
    promptPresetUpdateInputs: [] as Array<Record<string, unknown>>,
    replayInlineResults: [] as Array<Record<string, unknown>>,
    replayInlineInputs: [] as Array<{
      requests: Array<{ path?: string }>
      mutationId: string
      databaseLineage: string
    }>,
    networkOrder: [] as string[],
    ownerId: null as string | null,
    runTail: Promise.resolve() as Promise<unknown>,
    settingDraftInitialValues: new Map<string, unknown>(),
    settingDraftWrites: [] as Array<{ key: string; value: unknown }>,
    settingDrafts: new Map<string, { value: unknown; project?: (value: unknown) => void }>(),
  }
})

vi.mock('src/ts/server/commands', () => ({
  acknowledgeServerMutationReceipts: vi.fn(async () => true),
  canUseServerCommands: vi.fn(() => true),
  createPromptItemCommand: vi.fn(async (input: Record<string, unknown>) => ({
    status: 'ok',
    revision: Number(input.baseRevision) + 1,
  })),
  deletePromptItemCommand: vi.fn(async (input: Record<string, unknown>) => ({
    status: 'ok',
    revision: Number(input.baseRevision) + 1,
  })),
  settingsGroupForKey: vi.fn((key: string) => {
    if (key === 'guiHTML') return 'display'
    if (key === 'jsonSchemaEnabled' || key === 'mainPrompt') return 'prompt'
    return null
  }),
  enablePromptItemsCommand: vi.fn(async (input: Record<string, unknown>) => {
    botSettingsMocks.enableInputs.push(input)
    botSettingsMocks.networkOrder.push('toggle-live')
    if (botSettingsMocks.failNextEnableTerminal) {
      botSettingsMocks.failNextEnableTerminal = false
      return { status: 'error', error: 'invalid prompt owner', reason: 'invalid-request' }
    }
    if (botSettingsMocks.failNextEnableTransient) {
      botSettingsMocks.failNextEnableTransient = false
      return { status: 'error', error: 'temporarily offline' }
    }
    return { status: 'ok', revision: Number(input.baseRevision) + 1 }
  }),
  peekCachedServerCommandRevision: vi.fn(() => 100),
  patchPromptSettingsCommand: vi.fn(
    async (
      input: Record<string, unknown>,
      signal?: AbortSignal | null,
      keepalive?: boolean,
    ): Promise<Record<string, unknown>> => {
      botSettingsMocks.patchInputs.push(input)
      botSettingsMocks.patchTransportOptions.push({ signal, keepalive })
      if (botSettingsMocks.deferNextPatch) {
        botSettingsMocks.deferNextPatch = false
        const deferred = botSettingsMocks.deferredResult()
        botSettingsMocks.deferredPatchResults.push(deferred)
        return deferred.promise
      }
      if (botSettingsMocks.failNextPatch) {
        botSettingsMocks.failNextPatch = false
        return { status: 'error', error: 'forced prompt patch failure' }
      }
      return { status: 'ok', revision: Number(input.baseRevision) + 1 }
    },
  ),
  runServerCommand: vi.fn(
    (input: {
      command: (baseRevision: number) => Promise<Record<string, unknown>>
      rollback?: () => void
      signal?: AbortSignal | null
      keepalive?: boolean
      executionWrapper?: (execute: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
      failureRollbackDisposition?: (result: Record<string, unknown>) => 'retain' | 'rollback'
    }) => {
      botSettingsMocks.runInputs.push({ signal: input.signal, keepalive: input.keepalive })
      const execution = botSettingsMocks.runTail.then(async () => {
        const execute = () => input.command(100)
        const result = input.executionWrapper ? await input.executionWrapper(execute) : await execute()
        if (result.status !== 'ok' && input.failureRollbackDisposition?.(result) !== 'retain') input.rollback?.()
        return result
      })
      botSettingsMocks.runTail = execution.then(
        () => undefined,
        () => undefined,
      )
      return execution
    },
  ),
  enqueueDurableMutationReplay: vi.fn(async (execute: () => Promise<unknown>) => execute()),
  replayDurableMutationRequestsInline: vi.fn(
    async (requests: Array<{ path?: string }>, mutationId: string, databaseLineage: string) => {
      botSettingsMocks.replayInlineInputs.push({ requests, mutationId, databaseLineage })
      botSettingsMocks.networkOrder.push(`replay:${requests[0]?.path}`)
      return botSettingsMocks.replayInlineResults.shift() ?? { status: 'ok' }
    },
  ),
  runServerCommandWithoutMutationReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
  runServerCommandWithMutationReceipt: vi.fn(<T>(execute: () => Promise<T>) => execute()),
  reorderPromptItemsCommand: vi.fn(async (input: Record<string, unknown>) => ({
    status: 'ok',
    revision: Number(input.baseRevision) + 1,
  })),
  updatePromptPresetCommand: vi.fn(async (input: Record<string, unknown>) => {
    botSettingsMocks.promptPresetUpdateInputs.push(input)
    return {
      status: 'ok',
      revision: Number(input.baseRevision) + 1,
    }
  }),
  updatePromptItemCommand: vi.fn(async (input: Record<string, unknown>) => {
    botSettingsMocks.promptItemUpdateInputs.push(input)
    botSettingsMocks.networkOrder.push('row-live')
    if (botSettingsMocks.failNextPromptItemUpdateTransient) {
      botSettingsMocks.failNextPromptItemUpdateTransient = false
      return { status: 'error', error: 'temporarily offline' }
    }
    return { status: 'ok', revision: Number(input.baseRevision) + 1 }
  }),
}))

vi.mock('src/ts/server/settingsOwner.svelte', async () => {
  const { fromStore, writable } = await import('svelte/store')

  return {
    applyServerBackedSetting: vi.fn(),
    flushPendingSettingsOwnerMutations: vi.fn(),
    persistServerBackedSettingsPatchWithSettlement: vi.fn(async () => ({ status: 'accepted' as const })),
    createServerBackedSettingDraft: (key: string, fallback: unknown) => {
      const initialValue = botSettingsMocks.settingDraftInitialValues.has(key)
        ? botSettingsMocks.settingDraftInitialValues.get(key)
        : fallback

      if (key.startsWith('nanogpt')) {
        const valueStore = writable(initialValue)
        const reactiveValue = fromStore(valueStore)
        const draft = {
          get value() {
            return reactiveValue.current
          },
          set value(nextValue: unknown) {
            valueStore.set(nextValue)
            botSettingsMocks.settingDraftWrites.push({ key, value: nextValue })
          },
          project(nextValue: unknown) {
            valueStore.set(nextValue)
          },
        }
        botSettingsMocks.settingDrafts.set(key, draft)
        return draft
      }

      let value = initialValue
      const draft = Object.defineProperty({}, 'value', {
        enumerable: true,
        get: () => value,
        set: (nextValue: unknown) => {
          value = nextValue
          botSettingsMocks.settingDraftWrites.push({ key, value: nextValue })
        },
      }) as { value: unknown }
      botSettingsMocks.settingDrafts.set(key, draft)
      return draft
    },
  }
})

vi.mock('src/ts/server/commandLocalEffectEvents', () => ({
  subscribeServerCommandLocalEffectApplied: vi.fn(() => vi.fn()),
}))

vi.mock('src/ts/server/promptTemplateHydration', async () => {
  const { readable } = await import('svelte/store')
  return {
    capturePromptTemplateOwnerProjectionEpoch: vi.fn(() => 0),
    currentPromptTemplateOwnerId: vi.fn(() => botSettingsMocks.ownerId),
    ensurePromptTemplateHydrated: vi.fn(async () => true),
    hasPromptTemplateOwnerProjectionEpochChanged: vi.fn(() => false),
    isPromptTemplateHydrated: vi.fn(() => true),
    isPromptTemplateHydratedInState: vi.fn(() => true),
    markPromptTemplateOwnerAcknowledgementTainted: vi.fn(),
    peekPromptTemplateOwnerRevision: vi.fn(() => 100),
    promptTemplateHydrationStateStore: readable({ hydratedOwnerIds: new Set([null]), version: 0 }),
    promptTemplateOwnerUsesSelectedFallback: vi.fn(() => false),
  }
})

vi.mock('src/ts/promptPresetModelOverrides.svelte', () => ({
  createPromptPresetModelOverrideDraft: (_key: string, fallback: unknown) => ({ value: fallback }),
  currentPromptPresetModelOverrideValue: (_key: string, fallback: unknown) => fallback,
  mirrorPromptPresetModelOverrideField: vi.fn(() => false),
  promptPresetModelOverrideEnabled: vi.fn(() => false),
  setPromptPresetModelOverrideEnabled: vi.fn(),
}))

vi.mock('src/ts/pluginCommands', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/pluginCommands')>()
  return {
    ...actual,
    currentPluginStateSnapshot: vi.fn(() => ({})),
    currentPluginWatchSuppressionVersion: vi.fn(() => 0),
    dispatchSelectPluginProvider: vi.fn(),
  }
})

vi.mock('src/ts/tokenizer', () => ({
  tokenizeAccurate: vi.fn(async () => 0),
}))

vi.mock('src/ts/model/nanogpt', () => ({
  getNanoGPTBalance: vi.fn(async () => null),
  getNanoGPTModelCatalog: vi.fn(async () => []),
  getNanoGPTModelProviders: vi.fn(async () => null),
  getNanoGPTSubscription: vi.fn(async () => null),
  toModelGridItem: vi.fn((item: unknown) => item),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

vi.mock('src/lib/UI/GUI/TextAreaInput.svelte', async () => {
  const mock = await import('../../SideBars/AuthorNoteEditor.testTextArea.svelte')
  return { default: mock.default }
})

import BotSettings from './BotSettings.svelte'
import { language } from 'src/lang'
import { customProviderStore } from 'src/ts/plugins/plugins.svelte'
import { dispatchSelectPluginProvider } from 'src/ts/pluginCommands'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { flushRegisteredPendingOwnerMutations } from 'src/ts/server/pendingOwnerMutationRegistry'
import { resetServerResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from 'src/ts/server/pendingMutationOutbox'
import { dispatchDurableMutationReplay } from 'src/ts/server/durableMutationDispatch'
import {
  queuePromptItemProjectionUpdate,
  reapplyPendingPromptTemplateStructuralProjections,
  resetPendingPromptTemplateStructuralMutationsForTests,
} from 'src/ts/server/promptTemplateMutations.svelte'
import type { PromptItem } from 'src/ts/process/prompt'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

beforeEach(() => {
  vi.useFakeTimers()
  botSettingsMocks.patchInputs.length = 0
  botSettingsMocks.patchTransportOptions.length = 0
  botSettingsMocks.runInputs.length = 0
  botSettingsMocks.failNextPatch = false
  botSettingsMocks.deferNextPatch = false
  botSettingsMocks.deferredPatchResults.length = 0
  botSettingsMocks.enableInputs.length = 0
  botSettingsMocks.failNextEnableTerminal = false
  botSettingsMocks.failNextEnableTransient = false
  botSettingsMocks.failNextPromptItemUpdateTransient = false
  botSettingsMocks.promptItemUpdateInputs.length = 0
  botSettingsMocks.promptPresetUpdateInputs.length = 0
  botSettingsMocks.replayInlineResults.length = 0
  botSettingsMocks.replayInlineInputs.length = 0
  botSettingsMocks.networkOrder.length = 0
  botSettingsMocks.ownerId = null
  botSettingsMocks.runTail = Promise.resolve()
  botSettingsMocks.settingDraftInitialValues.clear()
  botSettingsMocks.settingDraftWrites.length = 0
  vi.mocked(dispatchSelectPluginProvider).mockClear()
  customProviderStore.set([])
  botSettingsMocks.settingDrafts.clear()
  resetPendingPromptTemplateStructuralMutationsForTests()
  resetServerResourceState()
  setDatabaseLite({
    aiModel: 'gpt35',
    subModel: 'gpt35',
    promptPresets: [],
    promptPresetsId: -1,
    botPresets: [],
    useLegacyGUI: false,
    mainPrompt: 'old main prompt',
    guiHTML: 'old renderer value',
    jsonSchemaEnabled: true,
    jailbreak: 'old jailbreak',
    globalNote: 'old global note',
    formatingOrder: [],
  } as any)
  target = document.createElement('div')
  document.body.appendChild(target)
  component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })
})

afterEach(() => {
  resetPendingPromptTemplateStructuralMutationsForTests()
  if (component) {
    unmount(component)
    component = undefined
  }
  setDatabaseLite({} as any)
  target.remove()
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('BotSettings legacy layout synchronization', () => {
  it('uses explicit settings, collection, model, and prompt owners', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/Setting/Pages/BotSettings.svelte'), 'utf8')

    expect(source).toContain('settingsResourceState')
    expect(source).toContain('collectionsResourceState')
    expect(source).toContain('modelSettingsOwner')
    expect(source).toContain('capturePromptTemplateOwnerMutationFence')
    expect(source).not.toContain('getDatabase(')
    expect(source).not.toContain('withTrustedResourceWrite')
    expect(source).not.toContain('getServerResourceApplyEpoch')
    expect(source).not.toContain('captureSettingsGroupProjectionEpoch')
  })

  it('switches a mounted legacy page with authoritative useLegacyGUI updates', async () => {
    if (component) unmount(component)
    setDatabaseLite({ ...getDatabase({ snapshot: true }), useLegacyGUI: false } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'legacy' } })
    await tick()

    expect(target.querySelector('[data-risu-bot-settings-tabs]')).toBeTruthy()

    setDatabaseLite({ ...getDatabase({ snapshot: true }), useLegacyGUI: true } as any)
    await tick()
    expect(target.querySelector('[data-risu-bot-settings-tabs]')).toBeNull()

    setDatabaseLite({ ...getDatabase({ snapshot: true }), useLegacyGUI: false } as any)
    await tick()
    expect(target.querySelector('[data-risu-bot-settings-tabs]')).toBeTruthy()
  })
})

describe('BotSettings Ooba Legacy streaming compatibility', () => {
  it('renders buffered-only streaming controls as disabled with a localized notice', async () => {
    if (component) unmount(component)
    setDatabaseLite({
      ...getDatabase({ snapshot: true }),
      aiModel: 'mancer',
      subModel: '',
      textgenWebUIBlockingURL: 'http://localhost:5000/api/v1/blocking',
      useLegacyGUI: false,
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'legacy' } })
    await tick()

    const streaming = target.querySelector<HTMLInputElement>(`input[aria-label="Response ${language.streaming}"]`)
    const halfStreaming = target.querySelector<HTMLInputElement>(`input[aria-label="${language.halfStreaming}"]`)
    const notice = target.querySelector('[data-ooba-legacy-buffered-notice]')

    expect(streaming?.checked).toBe(false)
    expect(streaming?.disabled).toBe(true)
    expect(halfStreaming?.checked).toBe(false)
    expect(halfStreaming?.disabled).toBe(true)
    expect(notice?.textContent?.trim()).toBe(language.oobaLegacyBufferedOnlyNotice)
  })
})

describe('BotSettings recommended model preset', () => {
  it('renders model presets for the selected prompt and persists a recommendation by id', async () => {
    if (component) unmount(component)
    setDatabaseLite({
      ...getDatabase({ snapshot: true }),
      modelPresets: [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ],
      modelPresetsId: 0,
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', mainPrompt: 'prompt' }],
      promptPresetsId: 0,
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })
    await tick()

    const select = target.querySelector<HTMLSelectElement>('[data-risu-recommended-model-preset] select')
    expect(select).toBeTruthy()
    expect(Array.from(select!.options).map((option) => [option.value, option.textContent])).toEqual([
      ['', language.none],
      ['model-a', 'Model A'],
      ['model-b', 'Model B'],
    ])

    select!.value = 'model-b'
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    expect(getDatabase().promptPresets[0].recommendedModelPresetId).toBe('model-b')

    await vi.advanceTimersByTimeAsync(250)
    await botSettingsMocks.runTail
    expect(botSettingsMocks.promptPresetUpdateInputs).toHaveLength(1)
    expect(botSettingsMocks.promptPresetUpdateInputs[0]).toMatchObject({
      promptPresetId: 'prompt-a',
      patch: { recommendedModelPresetId: 'model-b' },
    })
  })
})

describe('BotSettings NanoGPT authoritative synchronization', () => {
  it('does not apply local dependency resets to an authoritative model and provider projection', async () => {
    if (component) unmount(component)
    botSettingsMocks.settingDraftInitialValues.set('nanogptKey', 'saved-key')
    botSettingsMocks.settingDraftInitialValues.set('nanogptRequestModel', 'old-model')
    botSettingsMocks.settingDraftInitialValues.set('nanogptRequestModelName', 'Old model')
    botSettingsMocks.settingDraftInitialValues.set('nanogptProvider', 'old-provider')
    setDatabaseLite({
      ...getDatabase({ snapshot: true }),
      aiModel: 'nanogpt',
      nanogptKey: 'saved-key',
      nanogptRequestModel: 'old-model',
      nanogptRequestModelName: 'Old model',
      nanogptProvider: 'old-provider',
      nanogptUseSubscriptionEndpoint: false,
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'legacy' } })
    await tick()

    botSettingsMocks.settingDraftWrites.length = 0
    botSettingsMocks.settingDrafts.get('nanogptRequestModel')?.project?.('new-model')
    botSettingsMocks.settingDrafts.get('nanogptRequestModelName')?.project?.('New model')
    botSettingsMocks.settingDrafts.get('nanogptProvider')?.project?.('new-provider')
    await tick()

    expect(botSettingsMocks.settingDrafts.get('nanogptRequestModel')?.value).toBe('new-model')
    expect(botSettingsMocks.settingDrafts.get('nanogptRequestModelName')?.value).toBe('New model')
    expect(botSettingsMocks.settingDrafts.get('nanogptProvider')?.value).toBe('new-provider')
    expect(botSettingsMocks.settingDraftWrites.filter(({ key }) => key.startsWith('nanogpt'))).toEqual([])
  })
})

describe('BotSettings pending prompt persistence', () => {
  async function editPromptTextarea(label: string, value: string): Promise<void> {
    await tick()
    const textarea = Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
      (candidate) => candidate.getAttribute('aria-label') === label,
    )
    expect(textarea).toBeTruthy()
    textarea!.value = value
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  }

  async function editMainPrompt(value: string): Promise<void> {
    await editPromptTextarea(language.mainPrompt, value)
  }

  async function openOtherPromptSettings(): Promise<void> {
    const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === language.others,
    )
    expect(button).toBeTruthy()
    button!.click()
    await tick()
    const promptTemplateAccordion = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === language.promptTemplate,
    )
    expect(promptTemplateAccordion).toBeTruthy()
    promptTemplateAccordion!.click()
    await tick()
  }

  function promptTemplateToggle(): HTMLInputElement | undefined {
    return Array.from(target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (candidate) => candidate.getAttribute('aria-label') === language.usePromptTemplate,
    )
  }

  it('displays selected prompt-owner fields when the flat projection is stale', async () => {
    if (component) {
      unmount(component)
      component = undefined
    }

    setDatabaseLite({
      aiModel: 'gpt35',
      subModel: 'gpt35',
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', mainPrompt: 'canonical prompt owner' }],
      promptPresetsId: 0,
      promptTemplate: [],
      mainPrompt: 'stale flat projection',
      botPresets: [],
      useLegacyGUI: false,
      formatingOrder: [],
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })

    await tick()

    expect(target.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${language.mainPrompt}"]`)?.value).toBe(
      'canonical prompt owner',
    )
  })

  it('persists a selection that matches the provider from before an authoritative update', async () => {
    if (component) {
      unmount(component)
      component = undefined
    }
    customProviderStore.set(['provider-a', 'provider-b'])
    setDatabaseLite({
      aiModel: 'custom',
      subModel: 'custom',
      promptPresets: [],
      promptPresetsId: -1,
      botPresets: [],
      currentPluginProvider: 'provider-a',
      useLegacyGUI: false,
      formatingOrder: [],
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'legacy' } })
    await tick()

    const providerSelect = Array.from(target.querySelectorAll<HTMLSelectElement>('select')).find(
      (candidate) => candidate.getAttribute('aria-label') === language.plugin,
    )
    expect(providerSelect?.value).toBe('provider-a')

    settingsResourceState.value.currentPluginProvider = 'provider-b'
    await tick()
    expect(providerSelect?.value).toBe('provider-b')

    customProviderStore.set(['provider-a', 'provider-b'])
    await tick()
    settingsResourceState.value.currentPluginProvider = 'provider-b'
    await tick()
    vi.mocked(dispatchSelectPluginProvider).mockClear()
    const liveProviderSelect = Array.from(target.querySelectorAll<HTMLSelectElement>('select')).find(
      (candidate) => candidate.getAttribute('aria-label') === language.plugin,
    )
    expect(Array.from(liveProviderSelect?.options ?? [], (option) => option.value)).toEqual([
      '',
      'provider-a',
      'provider-b',
    ])
    liveProviderSelect!.value = 'provider-a'
    expect(liveProviderSelect!.value).toBe('provider-a')
    liveProviderSelect!.dispatchEvent(new Event('input', { bubbles: true }))
    liveProviderSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(dispatchSelectPluginProvider).toHaveBeenCalledOnce()
    expect(dispatchSelectPluginProvider).toHaveBeenCalledWith(
      'provider-a',
      expect.objectContaining({ currentPluginProvider: 'provider-b' }),
    )
    expect(getDatabase().currentPluginProvider).toBe('provider-a')
  })

  it('flushes a pending prompt edit with keepalive through the lifecycle registry', async () => {
    await editMainPrompt('draft before pagehide')

    expect(botSettingsMocks.patchInputs).toHaveLength(0)

    flushRegisteredPendingOwnerMutations({ keepalive: true })
    await Promise.resolve()

    expect(botSettingsMocks.patchInputs).toEqual([
      expect.objectContaining({
        baseRevision: 100,
        patch: { mainPrompt: 'draft before pagehide' },
      }),
    ])
    expect(botSettingsMocks.patchTransportOptions).toEqual([{ signal: undefined, keepalive: true }])
    expect(botSettingsMocks.runInputs).toEqual([{ signal: undefined, keepalive: true }])

    await vi.advanceTimersByTimeAsync(250)
    expect(botSettingsMocks.patchInputs).toHaveLength(1)
  })

  it('keeps a reverted Bot prompt field in the absolute closure while a sibling remains dirty', async () => {
    await editMainPrompt('temporary main prompt')
    await editPromptTextarea(language.jailbreakPrompt, 'final jailbreak')
    await editMainPrompt('old main prompt')

    expect(botSettingsMocks.patchInputs).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(250)
    await Promise.resolve()

    expect(botSettingsMocks.patchInputs).toEqual([
      expect.objectContaining({
        patch: {
          jailbreak: 'final jailbreak',
          mainPrompt: 'old main prompt',
        },
      }),
    ])
  })

  it('dispatches a Bot prompt correction immediately on a total revert', async () => {
    await editMainPrompt('temporary main prompt')
    await editMainPrompt('old main prompt')
    await Promise.resolve()

    expect(botSettingsMocks.patchInputs).toEqual([
      expect.objectContaining({ patch: { mainPrompt: 'old main prompt' } }),
    ])
    await vi.advanceTimersByTimeAsync(250)
    expect(botSettingsMocks.patchInputs).toHaveLength(1)
  })

  it('retains a remotely marked Bot prompt write ahead of its immediate baseline correction', async () => {
    vi.useRealTimers()
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-bot-prompt',
      writerEpoch: 6,
      databaseLineage: 'lineage-bot-prompt',
      requestedWriterWasActive: true,
    })

    try {
      await editMainPrompt('durable main prompt')
      let pending = await listPendingMutations()
      await vi.waitFor(async () => {
        pending = await listPendingMutations()
        expect(pending.map((entry) => entry.intent)).toEqual([
          {
            version: 1,
            requests: [
              {
                method: 'PATCH',
                path: '/settings/prompt',
                body: { patch: { mainPrompt: 'durable main prompt' } },
              },
            ],
          },
        ])
      })
      expect(pending[0].handle.key).toBe('settings:bridge')
      await expect(beginPendingMutationDispatch(pending[0].handle)).resolves.toBe('persisted')

      const commandGate = botSettingsMocks.deferredResult()
      botSettingsMocks.runTail = commandGate.promise
      await editMainPrompt('old main prompt')
      await vi.waitFor(async () => {
        pending = await listPendingMutations()
        expect(pending).toHaveLength(2)
      })
      expect(botSettingsMocks.patchInputs).toEqual([])
      expect(pending.map((entry) => entry.handle.key)).toEqual(['settings:bridge', 'settings:bridge'])
      expect(pending.map((entry) => entry.intent.requests[0])).toEqual([
        {
          method: 'PATCH',
          path: '/settings/prompt',
          body: { patch: { mainPrompt: 'durable main prompt' } },
        },
        {
          method: 'PATCH',
          path: '/settings/prompt',
          body: { patch: { mainPrompt: 'old main prompt' } },
        },
      ])
      await clearPendingMutationOutbox()
      commandGate.resolve({ status: 'ok' })
      await botSettingsMocks.runTail
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      vi.useFakeTimers()
    }
  })

  it('keeps a delayed prompt row ahead of disable across transient replay and recovery', async () => {
    vi.useRealTimers()
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-bot-toggle-order',
      writerEpoch: 8,
      databaseLineage: 'lineage-bot-toggle-order',
      requestedWriterWasActive: true,
    })

    if (component) {
      unmount(component)
      component = undefined
    }
    botSettingsMocks.ownerId = 'prompt-a'
    const originalRow = {
      id: 'row-a',
      type: 'plain',
      type2: 'normal',
      role: 'system',
      text: 'original row',
    } as PromptItem
    setDatabaseLite({
      aiModel: 'gpt35',
      subModel: 'gpt35',
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', promptTemplate: [originalRow] }],
      promptPresetsId: 0,
      promptTemplate: [originalRow],
      botPresets: [],
      useLegacyGUI: false,
      mainPrompt: 'old main prompt',
      guiHTML: 'old renderer value',
      jsonSchemaEnabled: true,
      jailbreak: 'old jailbreak',
      globalNote: 'old global note',
      formatingOrder: [],
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })

    try {
      await tick()
      await openOtherPromptSettings()
      let draftRows = [{ ...originalRow, text: 'edited row' }] as PromptItem[]
      queuePromptItemProjectionUpdate(
        {
          getItems: () => draftRows,
          setItems: (items) => {
            draftRows = items
          },
        },
        'row-a',
        originalRow,
        500,
        'prompt-a',
      )
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))

      botSettingsMocks.failNextPromptItemUpdateTransient = true
      botSettingsMocks.replayInlineResults.push({ status: 'error', error: 'still offline' })
      let toggle = promptTemplateToggle()
      expect(toggle?.checked).toBe(true)
      toggle!.checked = false
      toggle!.dispatchEvent(new Event('change', { bubbles: true }))

      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(2))
      await botSettingsMocks.runTail
      await tick()

      let pending = await listPendingMutations()
      expect(pending.map((entry) => entry.handle.key)).toEqual([
        'prompt-template-owner:prompt-a',
        'prompt-template-owner:prompt-a',
      ])
      expect(pending.map((entry) => entry.intent.requests[0])).toEqual([
        {
          method: 'PATCH',
          path: '/prompt-items/row-a',
          body: { promptPresetId: 'prompt-a', patch: { text: 'edited row' } },
        },
        {
          method: 'POST',
          path: '/prompt-items/enable',
          body: { promptPresetId: 'prompt-a', enabled: false },
        },
      ])
      expect(botSettingsMocks.networkOrder).toEqual(['row-live', 'replay:/prompt-items/row-a'])
      expect(botSettingsMocks.enableInputs).toEqual([])
      expect(getDatabase().promptPresets[0]).toHaveProperty('promptTemplate')

      toggle = promptTemplateToggle()
      expect(toggle?.checked).toBe(false)
      toggle!.checked = false
      toggle!.dispatchEvent(new Event('change', { bubbles: true }))

      await vi.waitFor(() => expect(botSettingsMocks.enableInputs).toHaveLength(1))
      await botSettingsMocks.runTail
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
      pending = await listPendingMutations()
      expect(pending).toEqual([])
      expect(botSettingsMocks.networkOrder).toEqual([
        'row-live',
        'replay:/prompt-items/row-a',
        'replay:/prompt-items/row-a',
        'replay:/prompt-items/enable',
        'toggle-live',
      ])
      await tick()
      expect(getDatabase().promptPresets[0].promptTemplate).toBeUndefined()
      expect(promptTemplateToggle()?.checked).toBe(false)
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      botSettingsMocks.ownerId = null
      vi.useFakeTimers()
    }
  })

  it('rolls back a disabled prompt template and explicitly discards its terminal durable mutation', async () => {
    vi.useRealTimers()
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-bot-toggle-terminal',
      writerEpoch: 7,
      databaseLineage: 'lineage-bot-toggle-terminal',
      requestedWriterWasActive: true,
    })

    if (component) {
      unmount(component)
      component = undefined
    }
    botSettingsMocks.ownerId = 'prompt-a'
    const originalTemplate = [{ id: 'row-a', type: 'plain', type2: 'normal', role: 'system', text: 'retained' }]
    setDatabaseLite({
      aiModel: 'gpt35',
      subModel: 'gpt35',
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', promptTemplate: originalTemplate }],
      promptPresetsId: 0,
      promptTemplate: originalTemplate,
      botPresets: [],
      useLegacyGUI: false,
      mainPrompt: 'old main prompt',
      guiHTML: 'old renderer value',
      jsonSchemaEnabled: true,
      jailbreak: 'old jailbreak',
      globalNote: 'old global note',
      formatingOrder: [],
    } as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })

    try {
      await tick()
      await openOtherPromptSettings()
      const toggle = promptTemplateToggle()
      expect(toggle?.checked).toBe(true)

      botSettingsMocks.failNextEnableTerminal = true
      toggle!.checked = false
      toggle!.dispatchEvent(new Event('change', { bubbles: true }))

      await vi.waitFor(() => expect(botSettingsMocks.enableInputs).toHaveLength(1))
      await botSettingsMocks.runTail
      await tick()

      expect(botSettingsMocks.enableInputs[0]).toMatchObject({
        promptPresetId: 'prompt-a',
        enabled: false,
      })
      expect(getDatabase().promptPresets[0].promptTemplate).toEqual(originalTemplate)
      expect(getDatabase().promptTemplate).toEqual(originalTemplate)
      expect(promptTemplateToggle()?.checked).toBe(true)
      expect(target.querySelector('[data-testid="prompt-template-toggle-mutation-status"]')?.textContent).toContain(
        'invalid prompt owner',
      )
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      botSettingsMocks.ownerId = null
      vi.useFakeTimers()
    }
  })

  it('keeps a retained prompt-template toggle projected and reports replay discard', async () => {
    vi.useRealTimers()
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-bot-toggle-retained',
      writerEpoch: 9,
      databaseLineage: 'lineage-bot-toggle-retained',
      requestedWriterWasActive: true,
    })

    if (component) {
      unmount(component)
      component = undefined
    }
    botSettingsMocks.ownerId = 'prompt-a'
    const originalTemplate = [{ id: 'row-a', type: 'plain', type2: 'normal', role: 'system', text: 'retained' }]
    const database = () => ({
      aiModel: 'gpt35',
      subModel: 'gpt35',
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', promptTemplate: structuredClone(originalTemplate) }],
      promptPresetsId: 0,
      promptTemplate: structuredClone(originalTemplate),
      botPresets: [],
      useLegacyGUI: false,
      mainPrompt: 'old main prompt',
      guiHTML: 'old renderer value',
      jsonSchemaEnabled: true,
      jailbreak: 'old jailbreak',
      globalNote: 'old global note',
      formatingOrder: [],
    })
    setDatabaseLite(database() as any)
    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })

    try {
      await tick()
      await openOtherPromptSettings()
      const toggle = promptTemplateToggle()!
      botSettingsMocks.failNextEnableTransient = true
      toggle.checked = false
      toggle.dispatchEvent(new Event('change', { bubbles: true }))

      await vi.waitFor(() => expect(botSettingsMocks.enableInputs).toHaveLength(1))
      await botSettingsMocks.runTail
      await tick()
      expect(target.querySelector('[data-testid="prompt-template-toggle-mutation-status"]')).toBeNull()
      expect(getDatabase().promptPresets[0].promptTemplate).toBeUndefined()

      setDatabaseLite(database() as any)
      reapplyPendingPromptTemplateStructuralProjections('prompt-a')
      await tick()
      expect(getDatabase().promptPresets[0].promptTemplate).toBeUndefined()
      expect(promptTemplateToggle()?.checked).toBe(false)

      const [entry] = await listPendingMutations()
      expect(entry).toBeTruthy()
      botSettingsMocks.replayInlineResults.push({
        status: 'error',
        error: 'queued toggle rejected',
        reason: 'invalid-request',
      })
      await expect(dispatchDurableMutationReplay(entry.handle, entry.intent)).resolves.toMatchObject({
        disposition: 'discarded',
      })
      await tick()

      expect(getDatabase().promptPresets[0].promptTemplate).toEqual(originalTemplate)
      expect(getDatabase().promptTemplate).toEqual(originalTemplate)
      expect(promptTemplateToggle()?.checked).toBe(true)
      expect(target.querySelector('[data-testid="prompt-template-toggle-mutation-status"]')?.textContent).toContain(
        language.promptTemplateMutation.replayDiscarded,
      )
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      botSettingsMocks.ownerId = null
      vi.useFakeTimers()
    }
  })

  it('rebases a queued prompt rollback when the earlier optimistic patch fails', async () => {
    botSettingsMocks.deferNextPatch = true
    await editMainPrompt('first optimistic prompt')
    await vi.advanceTimersByTimeAsync(250)
    expect(botSettingsMocks.patchInputs).toHaveLength(1)

    await editMainPrompt('second optimistic prompt')
    botSettingsMocks.failNextPatch = true
    await vi.advanceTimersByTimeAsync(250)
    expect(botSettingsMocks.patchInputs).toHaveLength(1)

    botSettingsMocks.deferredPatchResults.shift()?.resolve({ status: 'error', error: 'forced first failure' })
    for (let attempt = 0; attempt < 10 && botSettingsMocks.patchInputs.length < 2; attempt += 1) {
      await Promise.resolve()
    }
    await botSettingsMocks.runTail
    await tick()

    expect(botSettingsMocks.patchInputs).toHaveLength(2)
    expect(getDatabase().mainPrompt).toBe('old main prompt')
  })
})

describe('BotSettings streaming persistence', () => {
  it.each([
    { useStreaming: false, streamUrl: 'wss://stream.example.test/api/' },
    { useStreaming: true, streamUrl: 'ws://localhost:5005/api/' },
  ])('does not rewrite $useStreaming from $streamUrl without user input', async ({ useStreaming, streamUrl }) => {
    if (component) {
      unmount(component)
      component = undefined
    }
    target.replaceChildren()
    setDatabaseLite({
      aiModel: 'textgen_webui',
      subModel: 'gpt35',
      promptPresets: [],
      promptPresetsId: -1,
      botPresets: [],
      useLegacyGUI: false,
      mainPrompt: '',
      jailbreak: '',
      globalNote: '',
      formatingOrder: [],
    } as any)
    botSettingsMocks.settingDraftInitialValues.set('useStreaming', useStreaming)
    botSettingsMocks.settingDraftInitialValues.set('textgenWebUIStreamURL', streamUrl)
    botSettingsMocks.settingDraftWrites.length = 0

    component = mount(BotSettings, { target, props: { settingsKind: 'prompt' } })
    await tick()

    expect(botSettingsMocks.settingDraftWrites).toEqual([])
  })
})
