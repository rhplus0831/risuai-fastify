import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { get } from 'svelte/store'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const alertSpies = vi.hoisted(() => ({
  alertConfirm: vi.fn(async () => false),
  alertError: vi.fn(),
  alertInput: vi.fn(async () => ''),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(async () => '2'),
}))
const characterCommandSpies = vi.hoisted(() => ({
  setCharacterSupaMemoryWithOutcome: vi.fn(
    async (): Promise<{ status: 'accepted' | 'queued' | 'failed' }> => ({ status: 'accepted' }),
  ),
}))

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return {
    ...actual,
    alertConfirm: alertSpies.alertConfirm,
    alertError: alertSpies.alertError,
    alertInput: alertSpies.alertInput,
    alertNormal: alertSpies.alertNormal,
    alertSelect: alertSpies.alertSelect,
  }
})

vi.mock('src/ts/storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'sidebar-generation-settings-token',
}))

vi.mock('src/ts/process/modules', () => ({
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleMcps: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModuleToggles: vi.fn(() => ''),
  getModuleTriggers: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

vi.mock('src/ts/process/scripts', () => ({
  resetScriptCache: vi.fn(),
}))

vi.mock('src/ts/characterCommands', () => characterCommandSpies)

vi.mock('src/ts/setting/utils', () => ({
  getFullSettingsData: () => [],
}))

import Toggles from './Toggles.svelte'
import GenerationSettingsPickerHost from './GenerationSettingsPickerHost.testHarness.svelte'
import { language } from 'src/lang'
import {
  closePersonaListModal,
  closePresetListModal,
  closeChatGenerationTogglePresetListModal,
  openPersonaList,
  openPresetList,
  personaListModalStore,
  presetListModalStore,
  selectedCharID,
  type GenerationSettingsPickerMode,
} from 'src/ts/stores.svelte'
import { resolveActiveChatGenerationSettings } from 'src/ts/activeChatGenerationSettings'
import { currentRoute, navigate } from 'src/ts/router'
import { clearCachedServerCommandRevision, type ServerCommandResult } from 'src/ts/server/commands'
import { collectionsResourceState, replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'
import { mergeServerResourceCharacterRow } from 'src/ts/storage/database.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  body: unknown
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

let target: HTMLElement
let component: MountedComponent | undefined

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clonePlain<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function testDatabaseState() {
  return getResourceDatabase()
}

function stubCommandFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  let revision = 300
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision })
      if (url === '/api/v1/commands/settings/sidebar') {
        revision += 1
        return jsonResponse({
          status: 'ok',
          revision,
          event: {
            type: 'settings.updated',
            revision,
            resource: 'settings',
          },
        } satisfies ServerCommandResult & Record<string, unknown>)
      }
      if (url.endsWith('/generation-settings')) {
        const chatId = decodeURIComponent(url.match(/\/chats\/([^/]+)\/generation-settings$/)?.[1] ?? '')
        revision += 1
        return jsonResponse({
          status: 'ok',
          revision,
          event: {
            type: 'chat.updated',
            revision,
            resource: 'characterRow',
            id: chatId,
            parentId: 'char-a',
          },
          chatId,
          characterId: 'char-a',
          certificate: 'chat-generation-settings-sparse-v1',
          patchedKeys: Object.keys(body?.patch ?? {}).sort(),
          deletedKeys: [...(body?.deleteKeys ?? [])].sort(),
          sidebarTogglePatchedKeys: Object.keys(body?.patch?.sidebarToggles ?? {}).sort(),
          sidebarToggleDeletedKeys: [...(body?.sidebarToggleDeleteKeys ?? [])].sort(),
          prunedSidebarToggleKeys: [],
        } satisfies ServerCommandResult<{ chatId: string }> & Record<string, unknown>)
      }
      if (url === '/api/v1/commands/chats/chat-a') {
        revision += 1
        return jsonResponse({
          revision,
          event: {
            type: 'chat.updated',
            revision,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          selectedChatId: 'chat-a',
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred promise resolved before initialization')
  }
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
}

function stubDeferredFailedGenerationSettingsFetch(): {
  calls: CapturedFetch[]
  failGenerationSettingsSave: () => void
} {
  const calls: CapturedFetch[] = []
  let completeGenerationSettingsSave: () => void = () => {
    throw new Error('generation settings save was not requested')
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 300 })
      if (url.endsWith('/generation-settings')) {
        return new Promise<Response>((resolve) => {
          completeGenerationSettingsSave = () => {
            resolve(jsonResponse({ error: 'forced rollback' }, 500))
          }
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )

  return {
    calls,
    failGenerationSettingsSave: () => completeGenerationSettingsSave(),
  }
}

async function waitForFetchCount(calls: CapturedFetch[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(calls).toHaveLength(expected), { timeout: 2_000 })
}

function generationSettingsSaves(calls: CapturedFetch[]): CapturedFetch[] {
  return calls.filter((call) => call.url.endsWith('/generation-settings'))
}

async function waitForGenerationSettingsSaveCount(calls: CapturedFetch[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(generationSettingsSaves(calls).length).toBeGreaterThanOrEqual(expected), {
    timeout: 2_000,
  })
}

function seedDb(): void {
  selectedCharID.set(0)
  replaceResourceDatabase({
    username: 'Global User',
    currentChar: 0,
    selectedPersona: 0,
    modelPresetsId: 0,
    promptPresetsId: 0,
    jailbreakToggle: true,
    globalChatVariables: {
      toggle_flag: 'global-flag',
      toggle_mood: 'global-mood',
      toggle_note: 'global-note',
    },
    customPromptTemplateToggle: 'legacy=Legacy Toggle',
    customSidebarItems: [],
    chatGenerationTogglePresets: [],
    lastLoadedLoadoutName: '',
    hypaV3: false,
    translator: '',
    translatorType: 'llm',
    translatorPresetId: 'translator-a',
    translatorPresets: [
      {
        id: 'translator-a',
        name: 'Translator Alpha',
        prompt: 'Alpha',
        maxResponse: 128,
        steps: [
          {
            id: 'translator-a-step',
            name: 'Step 1',
            enabled: true,
            prompt: 'Alpha',
            maxResponse: 128,
            model: { mode: 'inheritTranslate' },
          },
        ],
      },
      {
        id: 'translator-b',
        name: 'Translator Beta',
        prompt: 'Beta',
        maxResponse: 256,
        steps: [
          {
            id: 'translator-b-step',
            name: 'Step 1',
            enabled: true,
            prompt: 'Beta',
            maxResponse: 256,
            model: { mode: 'inheritTranslate' },
          },
        ],
      },
    ],
    personas: [
      {
        id: 'persona-a',
        name: 'Persona Alpha',
        personaPrompt: '',
        icon: '',
        note: 'Alpha persona note',
      },
      {
        id: 'persona-b',
        name: 'Persona Beta',
        personaPrompt: '',
        icon: '',
        note: 'Beta persona note\nsecond line',
      },
    ],
    modelPresets: [{ id: 'model-preset-a', name: 'Model Prompt preset Alpha' }],
    agentPresets: [
      { id: 'agent-preset-a', name: 'Research Agent', enabled: true, version: 1, steps: [] },
      { id: 'agent-preset-b', name: 'Critique Agent', enabled: true, version: 1, steps: [] },
    ],
    promptPresets: [
      {
        id: 'preset-a',
        name: 'Prompt preset Alpha',
        jailbreak: 'Jailbreak',
        customPromptTemplateToggle: 'mood=Mood=select=Calm,Spicy\nflag=Flag\nnote=Note=text',
      },
      {
        id: 'preset-b',
        name: 'Prompt preset Beta',
        jailbreak: 'Jailbreak',
        customPromptTemplateToggle: 'mood=Mood=select=Calm,Spicy\nflag=Flag\nnote=Note=text',
      },
    ],
    modules: [{ id: 'module-a', customModuleToggle: 'moduleFlag=Module Flag' }],
    enabledModules: ['module-a'],
    characters: [
      {
        chaId: 'char-a',
        name: 'Character Alpha',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            name: 'Chat Alpha',
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-a',
              modelPresetId: 'model-preset-a',
              promptPresetId: 'preset-a',
              jailbreakToggle: true,
              sidebarToggles: {
                mood: '1',
                flag: '1',
                note: 'alpha-note',
                moduleFlag: '1',
              },
            },
          },
          {
            id: 'chat-b',
            name: 'Chat Beta',
            note: '',
            message: [],
            localLore: [],
            generationSettings: {
              configured: true,
              personaId: 'persona-b',
              modelPresetId: 'model-preset-a',
              promptPresetId: 'preset-b',
              jailbreakToggle: false,
              sidebarToggles: {
                mood: '0',
                flag: '0',
                note: 'beta-note',
                moduleFlag: '0',
              },
            },
          },
        ],
      },
    ],
  } as never)
}

function mountToggles(): void {
  component = mount(Toggles, {
    target,
    props: {
      chara: testDatabaseState().characters[0],
      noContainer: true,
    },
  })
}

function mountGenerationSettingsPickerHost(): void {
  component = mount(GenerationSettingsPickerHost, { target })
}

function elementBySelector<T extends Element>(selector: string, label: string): T {
  const element = target.querySelector<T>(selector)
  expect(element, label).toBeTruthy()
  return element!
}

function pickerControl(kind: 'model' | 'prompt' | 'persona' | 'agent-preset'): HTMLElement {
  return elementBySelector<HTMLElement>(
    `[data-risu-generation-picker-control][data-risu-picker-kind="${kind}"]`,
    `${kind} picker control`,
  )
}

function pickerButton(kind: 'model' | 'prompt' | 'persona'): HTMLButtonElement {
  const input = pickerControl(kind).querySelector<HTMLButtonElement>('button')
  expect(input, `${kind} picker button`).toBeTruthy()
  return input!
}

function personaNoteLine(): HTMLElement | null {
  return pickerControl('persona').querySelector<HTMLElement>('[data-risu-generation-picker-persona-note]')
}

function personaSettingsButton(): HTMLButtonElement | null {
  return pickerControl('persona').querySelector<HTMLButtonElement>(
    '[data-risu-generation-picker-persona-settings] button',
  )
}

function agentPresetSelect(): HTMLSelectElement {
  const select = pickerControl('agent-preset').querySelector<HTMLSelectElement>('select')
  expect(select, 'agent preset select').toBeTruthy()
  return select!
}

function resetDefaultsButton(): HTMLButtonElement {
  return elementBySelector<HTMLButtonElement>('[data-risu-generation-reset-defaults] button', 'reset defaults button')
}

function togglePresetRoot(): HTMLElement {
  return elementBySelector<HTMLElement>('[data-risu-generation-toggle-presets]', 'toggle preset control')
}

function togglePresetStateButton(): HTMLButtonElement {
  const button = togglePresetRoot().querySelector<HTMLButtonElement>('button')
  expect(button, 'toggle preset state button').toBeTruthy()
  return button!
}

function draftHookRoot(): HTMLElement {
  return elementBySelector<HTMLElement>('[data-risu-draft-hook-selector]', 'draft hook selector')
}

function draftHookButton(): HTMLButtonElement {
  const button = draftHookRoot().querySelector<HTMLButtonElement>('button')
  expect(button, 'draft hook selector button').toBeTruthy()
  return button!
}

function togglePresetDialog(): HTMLElement {
  return elementBySelector<HTMLElement>('[data-risu-toggle-preset-dialog]', 'toggle preset dialog')
}

function togglePresetDialogRow(id: string): HTMLElement {
  return elementBySelector<HTMLElement>(
    `[data-risu-toggle-preset-row][data-risu-row-id="${id}"]`,
    `toggle preset row ${id}`,
  )
}

function togglePresetAction(index: number): HTMLButtonElement {
  const button = togglePresetDialog().querySelectorAll<HTMLButtonElement>('[data-risu-toggle-preset-actions] button')[
    index
  ]
  expect(button, `toggle preset dialog action ${index}`).toBeTruthy()
  return button!
}

async function openTogglePresetDialog(): Promise<void> {
  togglePresetStateButton().click()
  await tick()
}

function pickerRoot(kind: 'model' | 'prompt' | 'persona', mode: GenerationSettingsPickerMode): HTMLElement {
  return elementBySelector<HTMLElement>(
    `[data-risu-generation-picker][data-risu-picker-kind="${kind}"][data-risu-picker-mode="${mode}"]`,
    `${kind} ${mode} picker root`,
  )
}

function pickerRow(kind: 'model' | 'prompt' | 'persona', id: string): HTMLElement {
  return elementBySelector<HTMLElement>(
    `[data-risu-generation-picker-row][data-risu-picker-kind="${kind}"][data-risu-row-id="${id}"]`,
    `${kind} picker row ${id}`,
  )
}

function pickerSelectionControl(kind: 'model' | 'prompt' | 'persona', id: string): HTMLElement {
  const row = pickerRow(kind, id)
  return row.querySelector<HTMLElement>('[data-risu-picker-select]') ?? row
}

function toggleControl(key: string): HTMLElement {
  return elementBySelector<HTMLElement>(
    `[data-risu-generation-toggle-control][data-risu-toggle-key="${key}"]`,
    `${key} toggle control`,
  )
}

function jailbreakControl(): HTMLElement {
  return elementBySelector<HTMLElement>('[data-risu-generation-jailbreak-control]', 'jailbreak toggle control')
}

function checkboxWithin(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(input, `${label} checkbox`).toBeTruthy()
  return input!
}

function toggleCheckbox(key: string): HTMLInputElement {
  const control = toggleControl(key)
  expect(control.dataset.risuInputKind).toBe('checkbox')
  return checkboxWithin(control, key)
}

function jailbreakCheckbox(): HTMLInputElement {
  const control = jailbreakControl()
  expect(control.dataset.risuInputKind).toBe('checkbox')
  return checkboxWithin(control, 'jailbreak')
}

function textToggleInput(key: string): HTMLInputElement {
  const control = toggleControl(key)
  expect(control.dataset.risuInputKind).toBe('text')
  const input = control.querySelector<HTMLInputElement>('input[type="text"]')
  expect(input, `${key} text toggle input`).toBeTruthy()
  return input!
}

function textareaToggleInput(key: string): HTMLElement {
  const control = toggleControl(key)
  expect(control.dataset.risuInputKind).toBe('textarea')
  const input = control.querySelector<HTMLElement>('textarea, [role="textbox"]')
  expect(input, `${key} textarea toggle input`).toBeTruthy()
  return input!
}

function selectToggleInput(key: string): HTMLSelectElement {
  const control = toggleControl(key)
  expect(control.dataset.risuInputKind).toBe('select')
  const select = control.querySelector<HTMLSelectElement>('select')
  expect(select, `${key} select toggle input`).toBeTruthy()
  return select!
}

function activeChat() {
  const character = testDatabaseState().characters[0]
  return character.chats[character.chatPage]
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  alertSpies.alertConfirm.mockReset()
  alertSpies.alertConfirm.mockResolvedValue(false)
  alertSpies.alertError.mockReset()
  alertSpies.alertInput.mockReset()
  alertSpies.alertInput.mockResolvedValue('')
  alertSpies.alertNormal.mockReset()
  alertSpies.alertSelect.mockReset()
  alertSpies.alertSelect.mockResolvedValue('2')
  characterCommandSpies.setCharacterSupaMemoryWithOutcome.mockReset()
  characterCommandSpies.setCharacterSupaMemoryWithOutcome.mockResolvedValue({ status: 'accepted' })
  clearCachedServerCommandRevision()
  seedDb()
  navigate('/', { replace: true })
})

afterEach(async () => {
  if (component) {
    await unmount(component)
    component = undefined
  }
  // Click handlers persist/refresh asynchronously after the first command
  // response. Drain that work while this test's fetch stub and resource state
  // are still installed so it cannot mutate the next test's DOM or call log.
  await flushAsyncWork()
  await flushAsyncWork()
  closePresetListModal()
  closePersonaListModal()
  closeChatGenerationTogglePresetListModal()
  target.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  selectedCharID.set(-1)
  replaceResourceDatabase({} as never)
  navigate('/', { replace: true })
})

describe('sidebar chat generation settings controls', () => {
  it('always shows chat setup controls without custom sidebar configuration', async () => {
    testDatabaseState().customSidebarItems = []
    testDatabaseState().characters[0].chats[0].generationSettings = {
      configured: false,
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    mountToggles()
    await tick()

    expect(pickerControl('prompt').textContent).toContain('Select prompt preset')
    expect(pickerControl('persona').textContent).toContain('Select chat persona')
  })

  it('does not duplicate chat setup controls from legacy custom sidebar items', async () => {
    const legacyDb = testDatabaseState() as { customSidebarItems: unknown }
    legacyDb.customSidebarItems = [
      { id: 'preset-control', type: 'preset', subType: '', label: '' },
      { id: 'persona-control', type: 'persona', subType: '', label: '' },
    ]

    mountToggles()
    await tick()

    expect(
      target.querySelectorAll('[data-risu-generation-picker-control][data-risu-picker-kind="model"]'),
    ).toHaveLength(1)
    expect(
      target.querySelectorAll('[data-risu-generation-picker-control][data-risu-picker-kind="prompt"]'),
    ).toHaveLength(1)
    expect(
      target.querySelectorAll('[data-risu-generation-picker-control][data-risu-picker-kind="persona"]'),
    ).toHaveLength(1)
    expect(
      target.querySelectorAll('[data-risu-generation-picker-control][data-risu-picker-kind="agent-preset"]'),
    ).toHaveLength(1)
  })

  it('shows clear chat setup labels when preset and persona are not configured', async () => {
    testDatabaseState().characters[0].chats[0].generationSettings = {
      configured: false,
      jailbreakToggle: false,
      sidebarToggles: {},
    }

    mountToggles()
    await tick()

    expect(pickerControl('prompt').dataset.risuPickerMode).toBe('active-chat-generation-settings')
    expect(pickerControl('prompt').textContent).toContain('Select prompt preset')
    expect(pickerControl('persona').dataset.risuPickerMode).toBe('active-chat-generation-settings')
    expect(pickerControl('persona').textContent).toContain('Select chat persona')
    expect(personaSettingsButton()).toBeNull()
    expect(pickerControl('agent-preset').dataset.risuPickerMode).toBe('active-chat-generation-settings')
    expect(pickerControl('agent-preset').textContent).toContain(language.agentPresets.noSelected)
  })

  it('highlights a model preset that differs from the active prompt recommendation', async () => {
    testDatabaseState().modelPresets.push({ id: 'model-preset-b', name: 'Recommended Model' } as never)
    testDatabaseState().promptPresets[0].recommendedModelPresetId = 'model-preset-b'

    mountGenerationSettingsPickerHost()
    await tick()

    const modelControl = pickerControl('model')
    expect(modelControl.dataset.risuModelPresetRecommendationState).toBe('mismatch')
    expect(modelControl.classList.contains('bg-red-900')).toBe(true)
    expect(pickerButton('model').getAttribute('aria-label')).toBe(
      language.chatGenerationModelPresetRecommendationMismatch('Recommended Model'),
    )
  })

  it('does not highlight a model preset that matches the active prompt recommendation', async () => {
    testDatabaseState().promptPresets[0].recommendedModelPresetId = 'model-preset-a'

    mountGenerationSettingsPickerHost()
    await tick()

    const modelControl = pickerControl('model')
    expect(modelControl.dataset.risuModelPresetRecommendationState).toBe('matched')
    expect(modelControl.classList.contains('bg-red-900')).toBe(false)
  })

  it('opens the selected chat persona directly in persona settings', async () => {
    navigate('/character/char-a/chat-a', { replace: true })
    mountGenerationSettingsPickerHost()
    await tick()

    const settingsButton = personaSettingsButton()
    expect(settingsButton).toBeTruthy()
    expect(settingsButton?.getAttribute('aria-label')).toBe(`${language.edit} Persona Alpha`)

    settingsButton?.click()
    await tick()

    expect(window.location.pathname).toBe('/settings/persona/persona-a')
    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      index: 12,
      personaId: 'persona-a',
    })
    expect(window.history.state).toEqual({
      __risuSettingsNavigation: {
        originPath: '/character/char-a/chat-a',
        version: 1,
      },
    })
  })

  it('shows the global Agent Preset default until the chat explicitly opts out', async () => {
    testDatabaseState().agentPresetDefaultId = 'agent-preset-a'

    mountGenerationSettingsPickerHost()
    await tick()

    expect(resolveActiveChatGenerationSettings()).toMatchObject({
      effectiveAgentPresetId: 'agent-preset-a',
      agentPreset: { id: 'agent-preset-a' },
    })
    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('agent-preset-a')
    expect(pickerControl('agent-preset').textContent).toContain('Research Agent')

    activeChat().generationSettings = {
      ...activeChat().generationSettings,
      agentPresetId: '',
    }
    await tick()

    expect(resolveActiveChatGenerationSettings().effectiveAgentPresetId).toBeUndefined()
    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('')
    expect(pickerControl('agent-preset').textContent).toContain(language.agentPresets.noSelected)
  })

  it('saves and clears Agent Preset selection through active-chat controls', async () => {
    const calls = stubCommandFetch()
    mountGenerationSettingsPickerHost()
    await tick()

    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('')
    expect(pickerControl('agent-preset').textContent).toContain(language.agentPresets.noSelected)

    const select = agentPresetSelect()
    select.value = 'agent-preset-a'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(activeChat().generationSettings?.agentPresetId).toBe('agent-preset-a')
    expect(resolveActiveChatGenerationSettings().agentPreset?.id).toBe('agent-preset-a')
    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(true)
    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('agent-preset-a')
    expect(pickerControl('agent-preset').textContent).toContain('Research Agent')
    expect(generationSettingsSaves(calls)[0]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(generationSettingsSaves(calls)[0].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: { agentPresetId: 'agent-preset-a' },
    })

    const savesBeforeClear = generationSettingsSaves(calls).length
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForGenerationSettingsSaveCount(calls, savesBeforeClear + 1)

    expect(activeChat().generationSettings?.agentPresetId).toBe('')
    expect(resolveActiveChatGenerationSettings().agentPreset).toBeUndefined()
    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(true)
    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('')
    expect(pickerControl('agent-preset').textContent).toContain(language.agentPresets.noSelected)
    expect(generationSettingsSaves(calls).at(-1)?.body).toEqual({
      baseRevision: 301,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: { agentPresetId: '' },
    })
  })

  it('marks Agent Preset selection pending and reports its exact failed save', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    mountGenerationSettingsPickerHost()
    await tick()

    const select = agentPresetSelect()
    select.value = 'agent-preset-a'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(pickerControl('agent-preset').dataset.risuPersistenceStatus).toBe('pending')
    expect(agentPresetSelect().disabled).toBe(true)

    failGenerationSettingsSave()
    await vi.waitFor(() => {
      expect(pickerControl('agent-preset').dataset.risuPersistenceStatus).toBe('failed')
    })
    expect(agentPresetSelect().disabled).toBe(false)
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.chatGenerationSettingsSaveFailed('forced rollback'))
  })

  it('shows missing selected Agent Preset as an actionable error', async () => {
    activeChat().generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      agentPresetId: 'deleted-agent-preset',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'alpha-note',
        moduleFlag: '1',
      },
    }

    mountGenerationSettingsPickerHost()
    await tick()

    const state = resolveActiveChatGenerationSettings()
    expect(state.agentPreset).toBeUndefined()
    expect(state.readiness.ready).toBe(false)
    expect(state.readiness.missing.map((reason) => reason.code)).toContain('agent_preset_missing')
    expect(state.missingLabels).toContain('Agent preset')
    expect(pickerControl('agent-preset').dataset.risuPickerSelectedId).toBe('deleted-agent-preset')
    expect(pickerControl('agent-preset').textContent).toContain(
      language.agentPresets.missingSelected('deleted-agent-preset'),
    )
    expect(target.querySelector('[data-risu-generation-picker-agent-preset-error]')).toBeTruthy()
  })

  it('keeps deleted preset and persona ids unconfigured without selecting global rows', async () => {
    const missingPresetId = 'deleted-preset'
    const missingPersonaId = 'deleted-persona'
    activeChat().generationSettings = {
      configured: true,
      personaId: missingPersonaId,
      modelPresetId: 'model-preset-a',
      promptPresetId: missingPresetId,
      jailbreakToggle: false,
      sidebarToggles: {
        moduleFlag: '1',
      },
    }

    mountGenerationSettingsPickerHost()
    await tick()

    const state = resolveActiveChatGenerationSettings()
    expect(state.persona).toBeUndefined()
    expect(state.promptPreset).toBeUndefined()
    expect(state.readiness.ready).toBe(false)
    expect(state.readiness.missing.map((reason) => reason.code)).toEqual(['persona_missing', 'prompt_preset_missing'])
    expect(state.missingLabels).toEqual(['Persona', 'Prompt preset'])
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe(missingPresetId)
    expect(pickerControl('prompt').textContent).toContain('Select prompt preset')
    expect(pickerControl('prompt').textContent).not.toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe(missingPersonaId)
    expect(pickerControl('persona').textContent).toContain('Select chat persona')
    expect(pickerControl('persona').textContent).not.toContain('Persona Alpha')
    expect(activeChat().generationSettings).toMatchObject({
      personaId: missingPersonaId,
      promptPresetId: missingPresetId,
    })
    expect(testDatabaseState().promptPresetsId).toBe(0)
    expect(testDatabaseState().selectedPersona).toBe(0)

    pickerButton('prompt').click()
    await tick()

    expect(get(openPresetList)).toBe(true)
    expect(presetListModalStore.mode).toBe('active-chat-generation-settings')
    expect(pickerRow('prompt', 'preset-a').dataset.risuSelected).toBe('false')
    expect(pickerRow('prompt', 'preset-a').getAttribute('aria-current')).toBeNull()
    expect(pickerRow('prompt', 'preset-b').dataset.risuSelected).toBe('false')
    expect(pickerRow('prompt', 'preset-b').getAttribute('aria-current')).toBeNull()

    closePresetListModal()
    await tick()

    pickerButton('persona').click()
    await tick()

    expect(get(openPersonaList)).toBe(true)
    expect(personaListModalStore.mode).toBe('active-chat-generation-settings')
    expect(pickerRow('persona', 'persona-a').dataset.risuSelected).toBe('false')
    expect(pickerRow('persona', 'persona-a').getAttribute('aria-current')).toBeNull()
    expect(pickerRow('persona', 'persona-b').dataset.risuSelected).toBe('false')
    expect(pickerRow('persona', 'persona-b').getAttribute('aria-current')).toBeNull()

    closePersonaListModal()
    await tick()

    expect(activeChat().generationSettings).toMatchObject({
      personaId: missingPersonaId,
      promptPresetId: missingPresetId,
    })
    expect(testDatabaseState().promptPresetsId).toBe(0)
    expect(testDatabaseState().selectedPersona).toBe(0)
  })

  it('remediates a prefilled incomplete chat through visible generation-settings controls', async () => {
    const calls = stubCommandFetch()
    activeChat().generationSettings = {
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'imported-note',
        moduleFlag: '1',
      },
    }

    mountToggles()
    await tick()

    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(false)
    expect(resolveActiveChatGenerationSettings().missingLabels).toEqual(['Configuration confirmation'])
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(selectToggleInput('mood').value).toBe('1')
    expect(textToggleInput('note').value).toBe('imported-note')
    expect(toggleCheckbox('flag').checked).toBe(true)
    expect(jailbreakControl().dataset.risuSelected).toBe('true')

    jailbreakCheckbox().click()
    await tick()
    await waitForFetchCount(calls, 2)

    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'imported-note',
        moduleFlag: '1',
      },
    })
    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(true)
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(jailbreakControl().dataset.risuSelected).toBe('false')
    expect(target.textContent).not.toContain('Select prompt preset')
    expect(target.textContent).not.toContain('Select chat persona')
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(calls[1].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: {
        configured: true,
        jailbreakToggle: false,
      },
    })
  })

  it('restores visible active-chat controls when a generation settings save fails', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    mountToggles()
    await tick()

    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(jailbreakCheckbox().checked).toBe(true)
    expect(jailbreakControl().dataset.risuSelected).toBe('true')

    jailbreakCheckbox().click()
    await tick()
    await waitForFetchCount(calls, 2)

    expect(activeChat().generationSettings?.jailbreakToggle).toBe(false)
    expect(jailbreakCheckbox().checked).toBe(false)
    expect(jailbreakControl().dataset.risuSelected).toBe('false')
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('pending')
    expect(jailbreakCheckbox().disabled).toBe(true)

    failGenerationSettingsSave()
    await vi.waitFor(() => {
      expect(activeChat().generationSettings?.jailbreakToggle).toBe(true)
    })
    await tick()

    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'alpha-note',
        moduleFlag: '1',
      },
    })
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(jailbreakCheckbox().checked).toBe(true)
    expect(jailbreakControl().dataset.risuSelected).toBe('true')
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('failed')
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.chatGenerationSettingsSaveFailed('forced rollback'))
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(calls[1].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: { jailbreakToggle: false },
    })
  })

  it('does not apply a pending or failed field status to a newly selected chat', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    mountToggles()
    await tick()

    jailbreakCheckbox().click()
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('pending')

    testDatabaseState().characters[0].chatPage = 1
    await tick()
    expect(activeChat().id).toBe('chat-b')
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('idle')
    expect(jailbreakCheckbox().disabled).toBe(false)

    failGenerationSettingsSave()
    await vi.waitFor(() => expect(alertSpies.alertError).toHaveBeenCalledTimes(1))
    await tick()
    expect(activeChat().id).toBe('chat-b')
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('idle')
    expect(jailbreakCheckbox().disabled).toBe(false)

    testDatabaseState().characters[0].chatPage = 0
    await tick()
    expect(jailbreakControl().dataset.risuPersistenceStatus).toBe('failed')
  })

  it('renders preset, persona, and toggle values from the active chat while switching chats', async () => {
    mountToggles()
    await tick()

    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(personaNoteLine()?.textContent).toBe('Alpha persona note')
    expect(selectToggleInput('mood').value).toBe('1')
    expect(textToggleInput('note').value).toBe('alpha-note')
    expect(toggleCheckbox('flag').checked).toBe(true)
    expect(toggleControl('flag').dataset.risuSelected).toBe('true')
    expect(toggleCheckbox('moduleFlag').checked).toBe(true)
    expect(toggleControl('moduleFlag').dataset.risuSelected).toBe('true')
    expect(target.textContent).not.toContain('Legacy Toggle')

    testDatabaseState().characters[0].chatPage = 1
    await tick()

    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-b')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Beta')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-b')
    expect(pickerControl('persona').textContent).toContain('Persona Beta')
    expect(personaNoteLine()?.textContent).toBe('Beta persona note\nsecond line')
    expect(selectToggleInput('mood').value).toBe('0')
    expect(textToggleInput('note').value).toBe('beta-note')
    expect(toggleCheckbox('flag').checked).toBe(false)
    expect(toggleControl('flag').dataset.risuSelected).toBe('false')
    expect(toggleCheckbox('moduleFlag').checked).toBe(false)
    expect(toggleControl('moduleFlag').dataset.risuSelected).toBe('false')
  })

  it('waits for module hydration before filling defaults and preserves Persona-module values', async () => {
    const calls = stubCommandFetch()
    testDatabaseState().enabledModules = []
    testDatabaseState().personas[0].modules = ['module-a']
    activeChat().generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        note: 'alpha-note',
        moduleFlag: '1',
      },
    }
    collectionsResourceState.statuses.modules = 'loading'

    mountToggles()
    await tick()
    await flushAsyncWork()

    expect(generationSettingsSaves(calls)).toHaveLength(0)
    expect(activeChat().generationSettings?.sidebarToggles).toEqual({
      mood: '1',
      note: 'alpha-note',
      moduleFlag: '1',
    })
    expect(target.querySelector('[data-risu-toggle-key="moduleFlag"]')).toBeNull()

    collectionsResourceState.statuses.modules = 'ready'
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(activeChat().generationSettings?.sidebarToggles).toEqual({
      mood: '1',
      flag: '0',
      note: 'alpha-note',
      moduleFlag: '1',
    })
    expect(toggleCheckbox('moduleFlag').checked).toBe(true)
    expect(generationSettingsSaves(calls)[0].body).toMatchObject({
      patch: { sidebarToggles: { flag: '0' } },
    })
    expect(generationSettingsSaves(calls)[0].body).not.toHaveProperty('sidebarToggleDeleteKeys')
  })

  it('renders preset-owned toggles from bootstrap-shaped preset stubs', async () => {
    testDatabaseState().customPromptTemplateToggle = 'fallback=Fallback'
    testDatabaseState().promptPresets = [
      {
        id: 'preset-a',
        name: 'Prompt preset Alpha',
        image: 'preset-alpha.png',
        customPromptTemplateToggle: 'stubFlag=Stub Flag',
      },
    ] as any
    activeChat().generationSettings = {
      configured: true,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: false,
      sidebarToggles: {
        stubFlag: '1',
        moduleFlag: '0',
      },
    }

    mountToggles()
    await tick()

    expect(toggleCheckbox('stubFlag').checked).toBe(true)
    expect(toggleCheckbox('moduleFlag').checked).toBe(false)
    expect(target.textContent).toContain('Stub Flag')
    expect(target.textContent).not.toContain('Fallback')
  })

  it('renders custom toggle group and groupEnd rows as an accordion', async () => {
    testDatabaseState().promptPresets[0].customPromptTemplateToggle =
      '=Prompt preset Group=group\nmood=Mood=select=Calm,Spicy\nflag=Flag\n==groupend\nnote=Note=text'

    mountToggles()
    await tick()

    const group = elementBySelector<HTMLElement>(
      '[data-risu-generation-toggle-group][data-risu-toggle-label="Prompt preset Group"]',
      'preset toggle group',
    )
    expect(group.textContent).toContain('Prompt preset Group')
    expect(target.querySelector('[data-risu-generation-toggle-control][data-risu-toggle-key="mood"]')).toBeNull()
    expect(textToggleInput('note').value).toBe('alpha-note')

    const groupButton = group.querySelector<HTMLButtonElement>('button')
    expect(groupButton, 'preset toggle group button').toBeTruthy()
    groupButton!.click()
    await tick()

    expect(selectToggleInput('mood').value).toBe('1')
    expect(toggleCheckbox('flag').checked).toBe(true)
  })

  it('does not transfer an open generated group to a different active chat layout', async () => {
    testDatabaseState().promptPresets[0].customPromptTemplateToggle =
      '=Alpha Group=group\nalphaFlag=Alpha Flag\n==groupEnd'
    testDatabaseState().promptPresets[1].customPromptTemplateToggle =
      '=Beta Group=group\nbetaFlag=Beta Flag\n==groupEnd'
    testDatabaseState().characters[0].chats[0].generationSettings!.sidebarToggles = {
      alphaFlag: '1',
      moduleFlag: '1',
    }
    testDatabaseState().characters[0].chats[1].generationSettings!.sidebarToggles = {
      betaFlag: '0',
      moduleFlag: '0',
    }

    mountToggles()
    await tick()

    const alphaGroup = elementBySelector<HTMLElement>(
      '[data-risu-generation-toggle-group][data-risu-toggle-label="Alpha Group"]',
      'alpha toggle group',
    )
    const alphaButton = alphaGroup.querySelector<HTMLButtonElement>('button')
    expect(alphaButton).toBeTruthy()
    alphaButton!.click()
    await tick()
    expect(alphaButton!.getAttribute('aria-expanded')).toBe('true')
    expect(toggleCheckbox('alphaFlag').checked).toBe(true)

    activeChat().generationSettings!.sidebarToggles!.alphaFlag = '0'
    await tick()
    expect(alphaGroup.querySelector<HTMLButtonElement>('button')).toBe(alphaButton)
    expect(alphaButton!.getAttribute('aria-expanded')).toBe('true')
    expect(toggleCheckbox('alphaFlag').checked).toBe(false)

    testDatabaseState().characters[0].chatPage = 1
    await tick()

    const betaGroup = elementBySelector<HTMLElement>(
      '[data-risu-generation-toggle-group][data-risu-toggle-label="Beta Group"]',
      'beta toggle group',
    )
    const betaButton = betaGroup.querySelector<HTMLButtonElement>('button')
    expect(betaButton).toBeTruthy()
    expect(betaButton!.getAttribute('aria-expanded')).toBe('false')
    expect(target.querySelector('[data-risu-generation-toggle-control][data-risu-toggle-key="betaFlag"]')).toBeNull()
  })

  it('programmatically names generated select, text, and textarea controls', async () => {
    testDatabaseState().promptPresets[0].customPromptTemplateToggle =
      'mood=Mood=select=Calm,Spicy\nnote=Note=text\ndetails=Details=textarea'
    testDatabaseState().characters[0].chats[0].generationSettings!.sidebarToggles = {
      mood: '1',
      note: 'alpha-note',
      details: 'alpha-details',
      moduleFlag: '1',
    }

    mountToggles()
    await tick()

    expect(selectToggleInput('mood').getAttribute('aria-label')).toBe('Mood')
    expect(textToggleInput('note').getAttribute('aria-label')).toBe('Note')
    expect(textareaToggleInput('details').getAttribute('aria-label')).toBe('Details')
  })

  it('keeps a textarea toggle enabled while its change save is pending', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    testDatabaseState().promptPresets[0].customPromptTemplateToggle = 'details=Details=textarea'
    activeChat().generationSettings!.sidebarToggles = { details: 'before', moduleFlag: '1' }

    mountToggles()
    await tick()

    const textarea = textareaToggleInput('details') as HTMLTextAreaElement
    textarea.value = 'after'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(generationSettingsSaves(calls)).toHaveLength(0)

    textarea.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await vi.waitFor(() => expect(activeChat().generationSettings?.sidebarToggles?.details).toBe('after'))
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(toggleControl('details').dataset.risuPersistenceStatus).toBe('pending')
    expect((textareaToggleInput('details') as HTMLTextAreaElement).disabled).toBe(false)

    failGenerationSettingsSave()
    await vi.waitFor(() => expect(toggleControl('details').dataset.risuPersistenceStatus).toBe('failed'))
    expect((textareaToggleInput('details') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('keeps a text toggle draft intact across keystrokes and saves only on change', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    mountToggles()
    await tick()

    const input = textToggleInput('note')
    input.focus()
    for (const value of ['a', 'ab', 'abc']) {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
      expect(input.disabled).toBe(false)
      expect(input.value).toBe(value)
      expect(generationSettingsSaves(calls)).toHaveLength(0)
    }

    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(toggleControl('note').dataset.risuPersistenceStatus).toBe('pending')
    expect(input.disabled).toBe(false)
    expect(input.value).toBe('abc')
    expect(document.activeElement).toBe(input)
    expect(generationSettingsSaves(calls)).toHaveLength(1)

    failGenerationSettingsSave()
    await vi.waitFor(() => expect(toggleControl('note').dataset.risuPersistenceStatus).toBe('failed'))
  })

  it('updates mounted active-chat controls after a character-row projection changes generation settings', async () => {
    mountToggles()
    await tick()

    const mountedControls = elementBySelector<HTMLElement>(
      '[data-risu-generation-settings-picker-controls]',
      'mounted generation settings controls',
    )
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-a')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Alpha')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-a')
    expect(pickerControl('persona').textContent).toContain('Persona Alpha')
    expect(selectToggleInput('mood').value).toBe('1')
    expect(textToggleInput('note').value).toBe('alpha-note')
    expect(toggleControl('flag').dataset.risuSelected).toBe('true')
    expect(jailbreakControl().dataset.risuSelected).toBe('true')

    const applied = mergeServerResourceCharacterRow({
      ...testDatabaseState().characters[0],
      name: 'Character Alpha Projected',
      chats: testDatabaseState().characters[0].chats.map((chat) => ({
        ...chat,
        message: [],
        generationSettings:
          chat.id === 'chat-a'
            ? {
                configured: true,
                personaId: 'persona-b',
                modelPresetId: 'model-preset-a',
                promptPresetId: 'preset-b',
                jailbreakToggle: false,
                sidebarToggles: {
                  mood: '0',
                  flag: '0',
                  note: 'projected-note',
                  moduleFlag: '0',
                },
              }
            : chat.generationSettings,
      })),
    })
    expect(applied).toBe(true)
    await tick()

    expect(mountedControls.isConnected).toBe(true)
    expect(target.contains(mountedControls)).toBe(true)
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-b')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Beta')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-b')
    expect(pickerControl('persona').textContent).toContain('Persona Beta')
    expect(selectToggleInput('mood').value).toBe('0')
    expect(textToggleInput('note').value).toBe('projected-note')
    expect(toggleCheckbox('flag').checked).toBe(false)
    expect(toggleControl('flag').dataset.risuSelected).toBe('false')
    expect(toggleCheckbox('moduleFlag').checked).toBe(false)
    expect(toggleControl('moduleFlag').dataset.risuSelected).toBe('false')
    expect(jailbreakCheckbox().checked).toBe(false)
    expect(jailbreakControl().dataset.risuSelected).toBe('false')
  })

  it('opens preset and persona pickers in active-chat generation-settings mode', async () => {
    mountToggles()
    await tick()

    pickerButton('prompt').click()
    await tick()

    expect(get(openPresetList)).toBe(true)
    expect(presetListModalStore.mode).toBe('active-chat-generation-settings')
    expect(presetListModalStore.target?.chatId).toBe('chat-a')
    expect(presetListModalStore.target?.characterId).toBe('char-a')

    closePresetListModal()
    await tick()
    expect(presetListModalStore.target).toBeNull()

    pickerButton('persona').click()
    await tick()

    expect(get(openPersonaList)).toBe(true)
    expect(personaListModalStore.mode).toBe('active-chat-generation-settings')
    expect(personaListModalStore.target?.chatId).toBe('chat-a')
    expect(personaListModalStore.target?.characterId).toBe('char-a')

    closePersonaListModal()
    await tick()
    expect(personaListModalStore.target).toBeNull()
  })

  it('selects preset and persona through composed sidebar pickers without retargeting globals', async () => {
    const calls = stubCommandFetch()
    activeChat().generationSettings = {
      configured: false,
      modelPresetId: 'model-preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'ready-note',
        moduleFlag: '1',
      },
    }

    mountGenerationSettingsPickerHost()
    await tick()

    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(false)
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('')
    expect(pickerControl('prompt').textContent).toContain('Select prompt preset')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('')
    expect(pickerControl('persona').textContent).toContain('Select chat persona')

    pickerButton('prompt').click()
    await tick()

    expect(get(openPresetList)).toBe(true)
    expect(presetListModalStore.mode).toBe('active-chat-generation-settings')
    expect(pickerRoot('prompt', 'active-chat-generation-settings')).toBeTruthy()
    expect(pickerRow('prompt', 'preset-b').textContent).toContain('Prompt preset Beta')
    expect(pickerRow('prompt', 'preset-b').dataset.risuSelected).toBe('false')

    const promptSelection = pickerSelectionControl('prompt', 'preset-b')
    expect(promptSelection).toBeInstanceOf(HTMLButtonElement)
    promptSelection.click()
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(get(openPresetList)).toBe(false)
    expect(activeChat().generationSettings?.promptPresetId).toBe('preset-b')
    expect(activeChat().generationSettings?.personaId).toBeUndefined()
    expect(testDatabaseState().promptPresetsId).toBe(0)
    expect(testDatabaseState().selectedPersona).toBe(0)
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-b')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Beta')
    expect(pickerControl('persona').textContent).toContain('Select chat persona')

    pickerButton('persona').click()
    await tick()

    expect(get(openPersonaList)).toBe(true)
    expect(personaListModalStore.mode).toBe('active-chat-generation-settings')
    expect(pickerRoot('persona', 'active-chat-generation-settings')).toBeTruthy()
    expect(pickerRow('persona', 'persona-b').textContent).toContain('Persona Beta')
    expect(pickerRow('persona', 'persona-b').dataset.risuSelected).toBe('false')

    pickerSelectionControl('persona', 'persona-b').click()
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 2)

    expect(get(openPersonaList)).toBe(false)
    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      promptPresetId: 'preset-b',
      personaId: 'persona-b',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '1',
        flag: '1',
        note: 'ready-note',
        moduleFlag: '1',
      },
    })
    expect(resolveActiveChatGenerationSettings().readiness.ready).toBe(true)
    expect(testDatabaseState().promptPresetsId).toBe(0)
    expect(testDatabaseState().selectedPersona).toBe(0)
    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('preset-b')
    expect(pickerControl('prompt').textContent).toContain('Prompt preset Beta')
    expect(pickerControl('persona').dataset.risuPickerSelectedId).toBe('persona-b')
    expect(pickerControl('persona').textContent).toContain('Persona Beta')
    expect(target.textContent).not.toContain('Select prompt preset')
    expect(target.textContent).not.toContain('Select chat persona')
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(calls[1].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: {
        configured: true,
        promptPresetId: 'preset-b',
      },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(calls[2].body).toEqual({
      baseRevision: 301,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: { personaId: 'persona-b' },
    })
  })

  it('does not save preset or persona picker choices after the picker target goes stale', async () => {
    const calls = stubCommandFetch()
    const originalChatASettings = clonePlain(testDatabaseState().characters[0].chats[0].generationSettings)
    const originalChatBSettings = clonePlain(testDatabaseState().characters[0].chats[1].generationSettings)

    mountGenerationSettingsPickerHost()
    await tick()

    pickerButton('prompt').click()
    await tick()

    expect(get(openPresetList)).toBe(true)
    expect(presetListModalStore.target?.chatId).toBe('chat-a')
    expect(pickerRoot('prompt', 'active-chat-generation-settings')).toBeTruthy()

    testDatabaseState().characters[0].chatPage = 1
    await tick()

    pickerSelectionControl('prompt', 'preset-a').click()
    await flushAsyncWork()

    expect(get(openPresetList)).toBe(true)
    expect(calls.filter((call) => call.url.endsWith('/generation-settings'))).toEqual([])
    expect(testDatabaseState().characters[0].chats[0].generationSettings).toEqual(originalChatASettings)
    expect(testDatabaseState().characters[0].chats[1].generationSettings).toEqual(originalChatBSettings)
    expect(testDatabaseState().characters[0].chats[1].generationSettings?.promptPresetId).toBe('preset-b')

    closePresetListModal()
    testDatabaseState().characters[0].chatPage = 0
    await tick()

    pickerButton('persona').click()
    await tick()

    expect(get(openPersonaList)).toBe(true)
    expect(personaListModalStore.target?.chatId).toBe('chat-a')
    expect(pickerRoot('persona', 'active-chat-generation-settings')).toBeTruthy()

    testDatabaseState().characters[0].chatPage = 1
    await tick()

    pickerSelectionControl('persona', 'persona-a').click()
    await flushAsyncWork()

    expect(get(openPersonaList)).toBe(true)
    expect(calls.filter((call) => call.url.endsWith('/generation-settings'))).toEqual([])
    expect(testDatabaseState().characters[0].chats[0].generationSettings).toEqual(originalChatASettings)
    expect(testDatabaseState().characters[0].chats[1].generationSettings).toEqual(originalChatBSettings)
    expect(testDatabaseState().characters[0].chats[1].generationSettings?.personaId).toBe('persona-b')
  })

  it('prefills preset toggle defaults after selecting a chat preset', async () => {
    const calls = stubCommandFetch()
    activeChat().generationSettings = {
      configured: false,
      personaId: 'persona-a',
      modelPresetId: 'model-preset-a',
      jailbreakToggle: false,
    }

    mountGenerationSettingsPickerHost()
    await tick()

    expect(pickerControl('prompt').dataset.risuPickerSelectedId).toBe('')
    expect(target.querySelector('[data-risu-generation-toggle-control][data-risu-toggle-key="mood"]')).toBeNull()

    pickerButton('prompt').click()
    await tick()

    pickerSelectionControl('prompt', 'preset-a').click()
    await tick()
    await waitForGenerationSettingsSaveCount(calls, 1)

    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      promptPresetId: 'preset-a',
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mood: '0',
        flag: '0',
        note: '',
        moduleFlag: '0',
      },
    })
    expect(selectToggleInput('mood').value).toBe('0')
    expect(toggleCheckbox('flag').checked).toBe(false)
    expect(textToggleInput('note').value).toBe('')
    expect(resolveActiveChatGenerationSettings().readiness.missing.map((reason) => reason.code)).not.toContain(
      'sidebar_toggle_missing',
    )
    expect(generationSettingsSaves(calls)[0]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(generationSettingsSaves(calls)[0].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: {
        configured: true,
        promptPresetId: 'preset-a',
        sidebarToggles: {
          mood: '0',
          flag: '0',
          note: '',
          moduleFlag: '0',
        },
      },
    })
  })

  it('asks before resetting chat toggle controls to their defaults', async () => {
    const calls = stubCommandFetch()
    activeChat().generationSettings = {
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '',
        flag: '1',
        note: 'legacy-note',
        moduleFlag: '1',
        stale: '1',
      },
    }

    mountGenerationSettingsPickerHost()
    await tick()

    expect(resetDefaultsButton().textContent).toContain('Reset toggle defaults')
    expect(selectToggleInput('mood').value).toBe('')
    expect(toggleCheckbox('flag').checked).toBe(true)
    expect(textToggleInput('note').value).toBe('legacy-note')
    expect(jailbreakControl().dataset.risuSelected).toBe('true')

    resetDefaultsButton().click()
    await tick()

    expect(alertSpies.alertConfirm).toHaveBeenCalledWith('Are you sure you want to reset toggle defaults?')
    expect(calls).toHaveLength(0)
    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      promptPresetId: 'preset-a',
      personaId: 'persona-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '',
        flag: '1',
        note: 'legacy-note',
        moduleFlag: '1',
        stale: '1',
      },
    })
    expect(selectToggleInput('mood').value).toBe('')
    expect(toggleCheckbox('flag').checked).toBe(true)
    expect(textToggleInput('note').value).toBe('legacy-note')
    expect(jailbreakControl().dataset.risuSelected).toBe('true')

    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    resetDefaultsButton().click()
    await tick()
    await waitForFetchCount(calls, 2)

    expect(activeChat().generationSettings).toMatchObject({
      configured: true,
      promptPresetId: 'preset-a',
      personaId: 'persona-a',
      jailbreakToggle: false,
      sidebarToggles: {
        mood: '0',
        flag: '0',
        note: '',
        moduleFlag: '0',
      },
    })
    expect(activeChat().generationSettings?.sidebarToggles).not.toHaveProperty('stale')
    expect(selectToggleInput('mood').value).toBe('0')
    expect(toggleCheckbox('flag').checked).toBe(false)
    expect(textToggleInput('note').value).toBe('')
    expect(jailbreakControl().dataset.risuSelected).toBe('false')
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a/generation-settings',
      method: 'PUT',
      authHeader: 'sidebar-generation-settings-token',
    })
    expect(calls[1].body).toEqual({
      baseRevision: 300,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: {
        jailbreakToggle: false,
        sidebarToggles: {
          mood: '0',
          flag: '0',
          note: '',
          moduleFlag: '0',
        },
      },
      sidebarToggleDeleteKeys: ['stale'],
    })
  })

  it('does not reset chat toggle defaults after confirmation resolves for a stale active chat', async () => {
    const calls = stubCommandFetch()
    activeChat().generationSettings = {
      configured: true,
      personaId: 'persona-a',
      promptPresetId: 'preset-a',
      jailbreakToggle: true,
      sidebarToggles: {
        mood: '',
        flag: '1',
        note: 'legacy-note',
        moduleFlag: '1',
        stale: '1',
      },
    }
    const chatASettings = clonePlain(testDatabaseState().characters[0].chats[0].generationSettings)
    const chatBSettings = clonePlain(testDatabaseState().characters[0].chats[1].generationSettings)
    const confirmation = deferred<boolean>()
    alertSpies.alertConfirm.mockReturnValueOnce(confirmation.promise)

    mountGenerationSettingsPickerHost()
    await tick()

    resetDefaultsButton().click()
    await tick()
    expect(alertSpies.alertConfirm).toHaveBeenCalledWith('Are you sure you want to reset toggle defaults?')

    testDatabaseState().characters[0].chatPage = 1
    await tick()

    confirmation.resolve(true)
    await flushAsyncWork()

    expect(calls).toEqual([])
    expect(testDatabaseState().characters[0].chats[0].generationSettings).toEqual(chatASettings)
    expect(testDatabaseState().characters[0].chats[1].generationSettings).toEqual(chatBSettings)
    expect(activeChat().id).toBe('chat-b')
    expect(activeChat().generationSettings?.jailbreakToggle).toBe(false)
    expect(activeChat().generationSettings?.sidebarToggles?.note).toBe('beta-note')
  })

  it('marks reset-to-defaults pending and reports its failed save', async () => {
    const { calls, failGenerationSettingsSave } = stubDeferredFailedGenerationSettingsFetch()
    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    mountGenerationSettingsPickerHost()
    await tick()

    resetDefaultsButton().click()
    await vi.waitFor(() => expect(alertSpies.alertConfirm).toHaveBeenCalled())
    await flushAsyncWork()
    await waitForGenerationSettingsSaveCount(calls, 1)
    const reset = elementBySelector<HTMLElement>('[data-risu-generation-reset-defaults]', 'reset defaults')
    expect(reset.dataset.risuPersistenceStatus).toBe('pending')
    expect(resetDefaultsButton().disabled).toBe(true)

    failGenerationSettingsSave()
    await vi.waitFor(() => expect(reset.dataset.risuPersistenceStatus).toBe('failed'))
    expect(resetDefaultsButton().disabled).toBe(false)
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.chatGenerationSettingsSaveFailed('forced rollback'))
  })

  it('renders reset toggle defaults below Toggle HypaMemory in the chat sidebar controls', async () => {
    testDatabaseState().hypaV3 = true

    mountGenerationSettingsPickerHost()
    await tick()

    const hypaMemoryToggle = elementBySelector<HTMLElement>('[data-risu-hypa-memory-toggle]', 'hypa memory toggle')
    const resetDefaults = elementBySelector<HTMLElement>('[data-risu-generation-reset-defaults]', 'reset defaults')

    expect(hypaMemoryToggle.compareDocumentPosition(resetDefaults) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('selects a draft hook for a fresh chat from beside Saved Toggles in the sidebar', async () => {
    const calls = stubCommandFetch()
    const hook = { id: 'draft-hook', name: 'Draft Hook', type: 'draft' as const, prompt: 'prompt' }
    testDatabaseState().inputHooks = [hook]

    mountToggles()
    await tick()

    expect(togglePresetRoot().compareDocumentPosition(draftHookRoot()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(draftHookButton().textContent).toContain(language.inputHookNone)

    draftHookButton().click()
    await tick()
    elementBySelector<HTMLButtonElement>(
      '[data-testid="default-chat-input-hook-option-draft-hook"]',
      'draft hook picker option',
    ).click()

    await vi.waitFor(() => expect(activeChat().selectedDraftHookId).toBe(hook.id))
    await vi.waitFor(() => expect(draftHookButton().textContent).toContain(hook.name))
    await waitForFetchCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        patch: { selectedDraftHookId: hook.id },
        select: false,
      },
    })
  })

  it('shows and persists the active-chat translation settings only when translation is configured', async () => {
    const calls = stubCommandFetch()
    mountToggles()
    await tick()
    expect(target.querySelector('[data-risu-chat-translation-settings]')).toBeNull()
    await unmount(component!)
    component = undefined

    testDatabaseState().translator = 'ko'
    mountToggles()
    await tick()

    const settings = elementBySelector<HTMLElement>(
      '[data-risu-chat-translation-settings]',
      'chat translation settings',
    )
    expect(settings.querySelectorAll('[data-risu-chat-translation-setting]')).toHaveLength(4)
    const autoTranslate = elementBySelector<HTMLElement>(
      '[data-risu-chat-translation-setting="autoTranslate"]',
      'auto-translate setting',
    )
    autoTranslate.querySelector<HTMLInputElement>('input')!.click()

    await vi.waitFor(() => expect(activeChat().autoTranslate).toBe(true))
    await waitForFetchCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: {
        patch: { autoTranslate: true },
        select: false,
      },
    })
    await vi.waitFor(() => expect(autoTranslate.dataset.risuPersistenceStatus).toBe('idle'))
  })

  it('binds and clears an LLM translator preset for the active chat', async () => {
    const calls = stubCommandFetch()
    testDatabaseState().translator = 'ko'
    mountToggles()
    await tick()

    const control = elementBySelector<HTMLElement>(
      '[data-risu-chat-translation-setting="translatorPresetId"]',
      'chat translator preset setting',
    )
    const select = control.querySelector<HTMLSelectElement>('select')!
    expect(select.value).toBe('')
    expect(select.options[0].textContent).toContain(`${language.useGlobalSettings} (Translator Alpha)`)

    select.value = 'translator-b'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(activeChat().translatorPresetId).toBe('translator-b'))
    await waitForFetchCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: { patch: { translatorPresetId: 'translator-b' }, select: false },
    })

    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(activeChat()).not.toHaveProperty('translatorPresetId'))
    await waitForFetchCount(calls, 3)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/chats/chat-a',
      method: 'PATCH',
      body: { patch: { translatorPresetId: null }, select: false },
    })
  })

  it('derives the Saved Toggles button label with unlinked and mismatch precedence', async () => {
    activeChat().generationSettings!.togglePresetId = ''
    mountGenerationSettingsPickerHost()
    await tick()

    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('unused')
    expect(togglePresetStateButton().textContent).toContain(language.chatGenerationTogglePresetUnused)

    activeChat().generationSettings!.togglePresetId = 'missing'
    await tick()
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('unlinked')
    expect(togglePresetStateButton().textContent).toContain(language.chatGenerationTogglePresetUnlinked)

    testDatabaseState().chatGenerationTogglePresets = [
      {
        id: 'saved-alpha',
        name: 'Saved Alpha',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { mood: '0' },
        sidebarToggleKinds: { mood: 'select' },
      },
    ]
    activeChat().generationSettings!.togglePresetId = 'saved-alpha'
    await tick()
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('mismatch')
    expect(togglePresetStateButton().textContent).toContain(language.chatGenerationTogglePresetMismatch)

    testDatabaseState().chatGenerationTogglePresets[0].sidebarToggles = {
      mood: '0',
      flag: '1',
      note: 'alpha-note',
      moduleFlag: '1',
    }
    testDatabaseState().chatGenerationTogglePresets[0].sidebarToggleKinds = {
      mood: 'select',
      flag: 'boolean',
      note: 'text',
      moduleFlag: 'boolean',
    }
    await tick()
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('edited')
    expect(togglePresetStateButton().textContent).toContain(language.chatGenerationTogglePresetEdited('Saved Alpha'))

    testDatabaseState().chatGenerationTogglePresets[0].sidebarToggles.mood = '1'
    await tick()
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('matched')
    expect(togglePresetStateButton().textContent).toContain('Saved Alpha')
  })

  it('renders the localized toggle preset caption', async () => {
    mountGenerationSettingsPickerHost()
    await tick()

    const caption = elementBySelector<HTMLElement>(
      '[data-risu-generation-toggle-preset-caption]',
      'toggle preset caption',
    )
    expect(caption.textContent).toContain(language.chatGenerationTogglePresetCaption)
  })

  it('selects a preset row without applying values and explicitly unselects it', async () => {
    const calls = stubCommandFetch()
    testDatabaseState().chatGenerationTogglePresets = [
      {
        id: 'saved-opposite',
        name: 'Opposite',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { mood: '0', flag: '0', note: '', moduleFlag: '0' },
        sidebarToggleKinds: { mood: 'select', flag: 'boolean', note: 'text', moduleFlag: 'boolean' },
      },
    ]
    const valuesBefore = clonePlain(activeChat().generationSettings?.sidebarToggles)
    mountGenerationSettingsPickerHost()
    await tick()
    await openTogglePresetDialog()

    togglePresetDialogRow('saved-opposite').click()
    await waitForGenerationSettingsSaveCount(calls, 1)
    await flushAsyncWork()
    expect(activeChat().generationSettings?.togglePresetId).toBe('saved-opposite')
    expect(activeChat().generationSettings?.sidebarToggles).toEqual(valuesBefore)
    expect(togglePresetDialogRow('saved-opposite').dataset.risuSelected).toBe('true')
    expect(togglePresetDialog()).toBeTruthy()

    togglePresetAction(2).click()
    await waitForGenerationSettingsSaveCount(calls, 2)
    await flushAsyncWork()
    expect(activeChat().generationSettings?.togglePresetId).toBe('')
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('unused')
  })

  it('leaves a loaded preset association unlinked after deleting its row', async () => {
    stubCommandFetch()
    activeChat().generationSettings!.togglePresetId = 'saved-alpha'
    testDatabaseState().chatGenerationTogglePresets = [
      {
        id: 'saved-alpha',
        name: 'Saved Alpha',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { mood: '1', flag: '1', note: 'alpha-note', moduleFlag: '1' },
        sidebarToggleKinds: { mood: 'select', flag: 'boolean', note: 'text', moduleFlag: 'boolean' },
      },
    ]
    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    mountGenerationSettingsPickerHost()
    await tick()
    await openTogglePresetDialog()

    togglePresetDialogRow('saved-alpha').querySelectorAll<HTMLButtonElement>('button')[1].click()
    await flushAsyncWork()
    expect(testDatabaseState().chatGenerationTogglePresets).toEqual([])
    expect(activeChat().generationSettings?.togglePresetId).toBe('saved-alpha')
    expect(togglePresetRoot().dataset.risuTogglePresetState).toBe('unlinked')
  })

  it('warns before overwriting a loaded preset whose toggle structure mismatches', async () => {
    stubCommandFetch()
    activeChat().generationSettings!.togglePresetId = 'saved-alpha'
    testDatabaseState().chatGenerationTogglePresets = [
      {
        id: 'saved-alpha',
        name: 'Saved Alpha',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { mood: '0' },
        sidebarToggleKinds: { mood: 'select' },
      },
    ]
    alertSpies.alertSelect.mockResolvedValueOnce('0')
    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    mountGenerationSettingsPickerHost()
    await tick()
    await openTogglePresetDialog()

    togglePresetAction(0).click()
    await flushAsyncWork()
    expect(alertSpies.alertConfirm).toHaveBeenCalledWith(language.chatGenerationTogglePresetMismatchOverwriteConfirm)
    expect(testDatabaseState().chatGenerationTogglePresets[0].sidebarToggles).toEqual({
      mood: '1',
      flag: '1',
      note: 'alpha-note',
      moduleFlag: '1',
    })
    expect(testDatabaseState().chatGenerationTogglePresets[0]).not.toHaveProperty('jailbreakToggle')
  })

  it('shows Pick ineligibility and writes exactly the chosen source values without linking the preset', async () => {
    const calls = stubCommandFetch()
    testDatabaseState().chatGenerationTogglePresets = [
      {
        id: 'missing-module-key',
        name: 'Missing Module',
        createdAt: 1,
        updatedAt: 2,
        sidebarToggles: { flag: '0' },
        sidebarToggleKinds: { flag: 'boolean' },
      },
      {
        id: 'module-values',
        name: 'Module Values',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { moduleFlag: '0' },
        sidebarToggleKinds: { moduleFlag: 'boolean' },
      },
    ]
    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    mountGenerationSettingsPickerHost()
    await tick()
    await openTogglePresetDialog()
    togglePresetAction(3).click()
    await tick()

    elementBySelector<HTMLButtonElement>(
      '[data-risu-toggle-preset-source-row][data-risu-source-id="module:module-a"]',
      'module Pick source',
    ).click()
    await tick()
    const ineligible = elementBySelector<HTMLButtonElement>(
      '[data-risu-toggle-preset-pick-row][data-risu-row-id="missing-module-key"]',
      'ineligible Pick preset',
    )
    expect(ineligible.disabled).toBe(true)
    expect(ineligible.dataset.risuIneligibleReason).toBe(language.chatGenerationTogglePresetPickMissingKeys(1))

    elementBySelector<HTMLButtonElement>(
      '[data-risu-toggle-preset-pick-row][data-risu-row-id="module-values"]',
      'eligible Pick preset',
    ).click()
    await waitForGenerationSettingsSaveCount(calls, 1)
    await flushAsyncWork()
    expect(alertSpies.alertConfirm).toHaveBeenCalledWith(
      language.chatGenerationTogglePresetPickConfirm(
        language.chatGenerationTogglePresetPickModuleSource('module-a'),
        1,
      ),
    )
    expect(activeChat().generationSettings?.sidebarToggles).toEqual({
      mood: '1',
      flag: '1',
      note: 'alpha-note',
      moduleFlag: '0',
    })
    expect(activeChat().generationSettings?.togglePresetId).toBeUndefined()
    expect(generationSettingsSaves(calls)[0].body).toMatchObject({
      patch: { sidebarToggles: { moduleFlag: '0' } },
    })
  })

  it('lists namespaced Agent toggles as their own Pick source', async () => {
    const database = testDatabaseState()
    database.agents = [
      {
        id: 'agent-a',
        name: 'Research Helper',
        version: 1,
        instruction: 'Tone: {{agentToggle::tone}}',
        modelDefaults: { mode: 'inheritMain' },
        runtimeDefaults: {},
        inputScopes: [],
        toggles: [{ key: 'tone', label: 'Tone', kind: 'select', options: ['Warm', 'Formal'] }],
        outputFormat: 'text',
      },
    ]
    database.agentPresets[0].agentUses = [
      {
        id: 'use-agent-a',
        agentId: 'agent-a',
        enabled: true,
        phase: 'beforeMain',
        dependencies: [],
        outputKey: 'research',
        destination: 'intermediate',
        failurePolicy: { mode: 'required' },
      },
    ]
    activeChat().generationSettings!.agentPresetId = 'agent-preset-a'
    activeChat().generationSettings!.sidebarToggles!['agent:agent-a:tone'] = '1'
    database.chatGenerationTogglePresets = [
      {
        id: 'agent-values',
        name: 'Agent Values',
        createdAt: 1,
        updatedAt: 1,
        sidebarToggles: { 'agent:agent-a:tone': '0' },
        sidebarToggleKinds: { 'agent:agent-a:tone': 'select' },
      },
    ]

    mountGenerationSettingsPickerHost()
    await tick()
    await openTogglePresetDialog()
    togglePresetAction(3).click()
    await tick()

    const source = elementBySelector<HTMLButtonElement>(
      '[data-risu-toggle-preset-source-row][data-risu-source-id="agent:agent-a"]',
      'Agent Pick source',
    )
    expect(source.textContent).toContain(language.chatGenerationTogglePresetPickAgentSource('Research Helper'))
  })

  it('writes jailbreak and sidebar toggles to active chat settings without touching global state', async () => {
    const calls = stubCommandFetch()
    mountToggles()
    await tick()

    jailbreakCheckbox().click()
    await tick()
    await waitForFetchCount(calls, 2)

    expect(activeChat().generationSettings?.jailbreakToggle).toBe(false)
    expect(jailbreakControl().dataset.risuSelected).toBe('false')
    expect(testDatabaseState().jailbreakToggle).toBe(true)

    toggleCheckbox('flag').click()
    await tick()
    await waitForFetchCount(calls, 3)

    expect(activeChat().generationSettings?.sidebarToggles?.flag).toBe('0')
    expect(toggleControl('flag').dataset.risuSelected).toBe('false')
    expect(testDatabaseState().globalChatVariables.toggle_flag).toBe('global-flag')

    const moodSelect = selectToggleInput('mood')
    moodSelect.value = '0'
    moodSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForFetchCount(calls, 4)

    expect(activeChat().generationSettings?.sidebarToggles?.mood).toBe('0')
    expect(testDatabaseState().globalChatVariables.toggle_mood).toBe('global-mood')

    const noteInput = textToggleInput('note')
    noteInput.value = 'updated-note'
    noteInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    noteInput.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    await waitForFetchCount(calls, 5)

    expect(activeChat().generationSettings?.sidebarToggles?.note).toBe('updated-note')
    expect(testDatabaseState().globalChatVariables.toggle_note).toBe('global-note')
  })
})

it('captures textarea toggle input before its change event commits', async () => {
  await beginWriterDraftCaptureTest()
  try {
    const calls = stubCommandFetch()
    testDatabaseState().promptPresets[0].customPromptTemplateToggle = 'details=Details=textarea'
    activeChat().generationSettings!.sidebarToggles = { details: 'before', moduleFlag: '1' }
    mountToggles()
    await tick()
    const input = textareaToggleInput('details') as HTMLTextAreaElement
    input.value = 'Unsubmitted toggle detail'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(
      capturedWriterDrafts()
        .find((draft) => draft.key.startsWith('sidebar-toggles:'))
        ?.fields.some((field) => field.value === 'Unsubmitted toggle detail'),
    ).toBe(true)
    expect(generationSettingsSaves(calls)).toHaveLength(0)
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
