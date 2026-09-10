import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

vi.mock('./fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'preset-rollback-token',
}))

vi.mock('../process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../process/modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import {
  clearCachedServerCommandRevision,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from '../server/commands'
import * as serverCommands from '../server/commands'
import { isCollectionAcknowledgementTainted, isSettingsAcknowledgementTainted } from '../server/resourceState.svelte'
import { captureDestructiveRefreshEpoch, hasDestructiveRefreshEpochChanged } from '../server/staleStateGuards'
import {
  applyModelPresetFieldsToDatabase,
  applyPromptPresetFieldsToDatabase,
  applyServerResourceDatabase,
  addImportedPromptPreset,
  botPresetIdsNeedNormalization,
  changeToPreset,
  copyPreset,
  createModelPreset,
  createPreset,
  createPromptPreset,
  deleteModelPreset,
  deletePromptPreset,
  deletePreset,
  ensureBotPresetHydrated,
  extractLegacyBotPresetByIndex,
  flushPendingSplitPresetPatch,
  flushPendingSplitPresetPatches,
  mergeServerResourceCharacterRow,
  mergeServerResourceFields,
  normalizePromptTemplateIds,
  presetTemplate,
  promptTemplateIdsNeedNormalization,
  reorderModelPresets,
  reorderPromptPresets,
  reorderPresets,
  resetPendingPresetMutationsForTests,
  saveCurrentPreset,
  setDatabase,
  setDatabaseLite,
  setPreset,
  selectModelPreset,
  selectPromptPreset,
  updatePreset,
  updateModelPreset,
  updatePromptPreset,
  type botPreset,
  type Database,
  type ModelPreset,
  type PromptPreset,
} from './database.svelte'
import { flushRegisteredPendingOwnerMutations } from '../server/pendingOwnerMutationRegistry'
import {
  beginPendingMutationDispatch,
  clearPendingMutationOutbox,
  listPendingMutations,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
  stagePendingMutation,
  type DurableMutationIntent,
} from '../server/pendingMutationOutbox'
import { markPromptTemplateProjectionApplied, resetPromptTemplateHydration } from '../server/promptTemplateHydration'
import {
  queuePromptItemProjectionUpdate,
  resetPromptTemplateSelectionDirtyState,
} from '../server/promptTemplateMutations.svelte'
import { replayPendingMutations } from '../server/pendingMutationReplay'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import { LLMFlags, LLMFormat, LLMTokenizer } from '../model/types'
import { awaitLanguageReady, changeLanguage, language as activeLanguage } from '../../lang'
import { SETTINGS_BRIDGE_MUTATION_KEY } from '../server/settingsMutationKey'
import { defaultColorScheme } from '../gui/colorscheme'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

interface CapturedFetch {
  url: string
  method: string
  body: any
  keepalive?: boolean
}

function seedDatabase(characters: Array<Record<string, unknown>>) {
  setDatabaseLite({
    characters,
    modules: [],
    personas: [],
    language: 'en',
  } as unknown as Database)
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizedModelRoleProfiles(overrides: Record<string, Record<string, unknown>> = {}) {
  return {
    ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function stubFailedPresetCommand(onCommand?: (call: CapturedFetch) => void): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      }
      calls.push(call)
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 100 })
      if (
        url.startsWith('/api/v1/commands/presets') ||
        url.startsWith('/api/v1/commands/legacy-bot-presets') ||
        url.startsWith('/api/v1/commands/model-presets') ||
        url.startsWith('/api/v1/commands/prompt-presets')
      ) {
        onCommand?.(call)
        return jsonResponse({ error: 'forced preset failure' }, 500)
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubSuccessfulSplitPresetCommands(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  let revision = 100
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        keepalive: init.keepalive === true,
      }
      calls.push(call)
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 100 })
      if (url.startsWith('/api/v1/commands/model-presets/')) {
        revision += 1
        const isSelection = url.endsWith('/select')
        const modelPresetId = isSelection
          ? call.body.modelPresetId
          : decodeURIComponent(url.slice('/api/v1/commands/model-presets/'.length))
        return jsonResponse({
          revision,
          event: {
            type: isSelection ? 'modelPreset.selected' : 'modelPreset.updated',
            revision,
            resource: 'preset',
            id: modelPresetId,
          },
          modelPresetId,
        })
      }
      if (url.startsWith('/api/v1/commands/prompt-presets/')) {
        revision += 1
        const isSelection = url.endsWith('/select')
        const promptPresetId = isSelection
          ? call.body.promptPresetId
          : decodeURIComponent(url.slice('/api/v1/commands/prompt-presets/'.length))
        return jsonResponse({
          revision,
          event: {
            type: isSelection ? 'promptPreset.selected' : 'promptPreset.updated',
            revision,
            resource: 'preset',
            id: promptPresetId,
          },
          promptPresetId,
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

function stubSuccessfulLegacyPresetCommands(
  canonicalReceipt: (call: CapturedFetch) => {
    canonicalValues?: Record<string, unknown>
    canonicalDeletedKeys?: string[]
  } = () => ({}),
): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  let revision = 100
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const call = {
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      }
      calls.push(call)
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 100 })
      if (url.startsWith('/api/v1/commands/presets/')) {
        revision += 1
        const presetId = decodeURIComponent(url.slice('/api/v1/commands/presets/'.length))
        const receipt = canonicalReceipt(call)
        return jsonResponse({
          revision,
          event: { type: 'preset.updated', revision, resource: 'presetRow', id: presetId },
          presetId,
          acknowledgedKeys: Object.keys(call.body.patch),
          canonicalValues: receipt.canonicalValues ?? {},
          canonicalDeletedKeys: receipt.canonicalDeletedKeys ?? [],
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForPresetCommand(calls: CapturedFetch[], path: string): Promise<CapturedFetch> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = calls.find((call) => call.url === `/api/v1/commands${path}`)
    if (match) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return match
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`preset command ${path} not dispatched; saw: ${JSON.stringify(calls)}`)
}

async function waitForState(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { interval: 1 })
}

async function captureFullLegacyPresetSavePayload(settings: Partial<Database> = {}): Promise<botPreset> {
  seedPresetDatabase({
    ...settings,
    botPresets: [{ id: 'preset-a', name: 'Alpha', image: 'img' } as botPreset],
    botPresetsId: 0,
  })
  setCachedServerCommandRevision(100)
  const calls = stubFailedPresetCommand()

  saveCurrentPreset()

  const command = await waitForPresetCommand(calls, '/presets/preset-a')
  return { ...clonePlain(command.body.patch), id: 'preset-a' } as botPreset
}

function makePreset(id: string, name: string, patch: Partial<botPreset> = {}): botPreset {
  return {
    ...clonePlain(presetTemplate),
    id,
    name,
    mainPrompt: `${name} prompt`,
    jailbreak: `${name} jailbreak`,
    globalNote: `${name} note`,
    temperature: patch.temperature ?? 30,
    promptTemplate: [
      {
        id: `${id}-prompt`,
        type: 'plain',
        text: `${name} prompt item`,
        role: 'system',
      },
    ] as any,
    NAISettings: { cfg_scale: 4, mirostat_tau: 5, mirostat_lr: 6 } as any,
    promptSettings: {
      assistantPrefill: `${name} prefill`,
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
      customChainOfThought: false,
      maxThoughtTagDepth: 3,
    },
    ...patch,
  }
}

describe('promptTemplateIdsNeedNormalization', () => {
  it('skips already-normalized prompt templates', () => {
    const data = {
      promptTemplate: [
        { id: 'prompt-a', type: 'plain', text: 'A' },
        { id: 'prompt-b', type: 'plain', text: 'B' },
      ],
    } as unknown as Pick<Database, 'promptTemplate'>

    expect(promptTemplateIdsNeedNormalization(data)).toBe(false)
  })

  it('detects missing, blank, and duplicate prompt template ids', () => {
    expect(
      promptTemplateIdsNeedNormalization({
        promptTemplate: [{ type: 'plain', text: 'A' }],
      } as unknown as Pick<Database, 'promptTemplate'>),
    ).toBe(true)
    expect(
      promptTemplateIdsNeedNormalization({
        promptTemplate: [{ id: ' ', type: 'plain', text: 'A' }],
      } as unknown as Pick<Database, 'promptTemplate'>),
    ).toBe(true)
    expect(
      promptTemplateIdsNeedNormalization({
        promptTemplate: [
          { id: 'prompt-a', type: 'plain', text: 'A' },
          { id: 'prompt-a', type: 'plain', text: 'B' },
        ],
      } as unknown as Pick<Database, 'promptTemplate'>),
    ).toBe(true)
  })

  it('returns false after normalization repairs prompt template ids', () => {
    const data = {
      promptTemplate: [
        { id: 'prompt-a', type: 'plain', text: 'A' },
        { id: 'prompt-a', type: 'plain', text: 'B' },
        { type: 'plain', text: 'C' },
      ],
    } as unknown as Pick<Database, 'promptTemplate'>

    normalizePromptTemplateIds(data)

    expect(promptTemplateIdsNeedNormalization(data)).toBe(false)
    expect(new Set(data.promptTemplate?.map((item) => item.id)).size).toBe(data.promptTemplate?.length ?? 0)
  })
})

describe('settings database normalization', () => {
  it('initializes the browser loadout name compatibility projection explicitly', () => {
    seedPresetDatabase()
    const database = clonePlain(getDatabase())
    delete (database as Partial<Database>).lastLoadedLoadoutName

    setDatabase(database)

    expect(getDatabase().loadouts).toEqual([])
    expect(getDatabase().lastLoadedLoadoutName).toBe('')
  })

  it('derives a missing stable persona selection only from one unique row id', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    legacyData.personas = [
      { id: 'persona-a', name: 'A', displayName: '', personaPrompt: '', icon: '' },
      { id: 'persona-b', name: 'B', displayName: '', personaPrompt: '', icon: '' },
    ]
    legacyData.selectedPersona = 1
    delete (legacyData as Partial<Database>).selectedPersonaId

    setDatabase(legacyData)
    expect(getDatabase().selectedPersonaId).toBe('persona-b')

    const ambiguous = clonePlain(getDatabase())
    ambiguous.personas[0].id = 'duplicate'
    ambiguous.personas[1].id = 'duplicate'
    delete (ambiguous as Partial<Database>).selectedPersonaId
    setDatabase(ambiguous)
    expect(getDatabase().selectedPersonaId).toBeNull()
    expect(ambiguous.personas.map(({ id }) => id)).toEqual(['duplicate', 'duplicate'])
  })

  it('prefers legacy Hypa settings over the stale Supa prompt during first-preset migration', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase()) as Database & { supaMemoryPrompt?: string }
    delete legacyData.hypaV3Presets
    legacyData.hypaV3Settings = {
      summarizationPrompt: 'canonical legacy Hypa prompt',
      recentMemoryRatio: 0.2,
    } as any
    legacyData.supaMemoryPrompt = 'stale legacy Supa prompt'

    setDatabase(legacyData)

    expect(getDatabase().hypaV3Presets).toEqual([
      expect.objectContaining({
        settings: expect.objectContaining({
          summarizationPrompt: 'canonical legacy Hypa prompt',
          recentMemoryRatio: 0.2,
        }),
      }),
    ])
  })

  it('repairs legacy Hypa V3 preset ids deterministically and preserves stable selection precedence', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    legacyData.hypaV3Presets = [
      { id: '', name: 'Missing', settings: {} },
      { id: 'owned', name: 'Owned', settings: {} },
      { id: 'duplicate', name: 'First duplicate', settings: {} },
      { id: 'duplicate', name: 'Second duplicate', settings: {} },
    ] as any
    legacyData.hypaV3PresetId = 3
    legacyData.selectedHypaV3PresetId = 'owned'

    setDatabase(legacyData)

    expect(getDatabase().hypaV3Presets.map(({ id }) => id)).toEqual([
      'hypa-v3-preset-1',
      'owned',
      'duplicate',
      'hypa-v3-preset-4',
    ])
    expect(getDatabase().selectedHypaV3PresetId).toBe('owned')
    expect(getDatabase().hypaV3PresetId).toBe(1)

    const reopened = clonePlain(getDatabase())
    setDatabase(reopened)
    expect(getDatabase().hypaV3Presets.map(({ id }) => id)).toEqual([
      'hypa-v3-preset-1',
      'owned',
      'duplicate',
      'hypa-v3-preset-4',
    ])
    expect(getDatabase().selectedHypaV3PresetId).toBe('owned')
    expect(getDatabase().hypaV3PresetId).toBe(1)
  })

  it('preserves a legacy custom palette separately and defaults presets to the standard palette', () => {
    seedPresetDatabase()
    const legacyCustomData = clonePlain(getDatabase())
    legacyCustomData.colorSchemeName = 'custom'
    legacyCustomData.colorScheme = { ...defaultColorScheme, bgcolor: '#123456' }
    delete (legacyCustomData as Partial<Database>).customColorScheme

    setDatabase(legacyCustomData)

    expect(getDatabase().customColorScheme).toEqual(legacyCustomData.colorScheme)
    expect(getDatabase().customColorScheme).not.toBe(getDatabase().colorScheme)

    const legacyPresetData = clonePlain(getDatabase())
    legacyPresetData.colorSchemeName = 'light'
    legacyPresetData.colorScheme = { ...defaultColorScheme, bgcolor: '#abcdef' }
    delete (legacyPresetData as Partial<Database>).customColorScheme

    setDatabase(legacyPresetData)

    expect(getDatabase().customColorScheme).toEqual(defaultColorScheme)
  })

  it('defaults OpenAI Flex processing off while preserving an explicit opt-in', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as Partial<Database>).openAIFlexProcessing

    setDatabase(legacyData)
    expect(getDatabase().openAIFlexProcessing).toBe(false)

    const enabledData = clonePlain(getDatabase())
    enabledData.openAIFlexProcessing = true
    setDatabase(enabledData)
    expect(getDatabase().openAIFlexProcessing).toBe(true)
  })

  it('defaults complex regex compatibility to 15-second worker timeouts', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as Partial<Database>).complexRegexCompatibilityMode
    delete (legacyData as Partial<Database>).complexRegexInputTimeoutMs
    delete (legacyData as Partial<Database>).complexRegexOutputTimeoutMs
    delete (legacyData as Partial<Database>).complexRegexDisplayTimeoutMs
    delete (legacyData as Partial<Database>).regexOutputSizeLimitMiB

    setDatabase(legacyData)

    expect(getDatabase()).toMatchObject({
      complexRegexCompatibilityMode: 'worker',
      complexRegexInputTimeoutMs: 15000,
      complexRegexOutputTimeoutMs: 15000,
      complexRegexDisplayTimeoutMs: 15000,
      regexOutputSizeLimitMiB: 16,
    })

    const configuredData = clonePlain(getDatabase())
    configuredData.complexRegexCompatibilityMode = 'strict'
    configuredData.complexRegexInputTimeoutMs = 1000
    configuredData.complexRegexOutputTimeoutMs = 2000
    configuredData.complexRegexDisplayTimeoutMs = 3000
    configuredData.regexOutputSizeLimitMiB = 32

    setDatabase(configuredData)

    expect(getDatabase()).toMatchObject({
      complexRegexCompatibilityMode: 'strict',
      complexRegexInputTimeoutMs: 1000,
      complexRegexOutputTimeoutMs: 2000,
      complexRegexDisplayTimeoutMs: 3000,
      regexOutputSizeLimitMiB: 32,
    })
  })

  it('normalizes chat load counts and migrates the fork legacy initial-tail setting', () => {
    seedPresetDatabase()
    const data = clonePlain(getDatabase())
    data.chatDisplayTailCount = 18
    delete data.chatLoadInitialPages
    data.chatLoadAdditionalPages = 7.9

    setDatabase(data)

    expect(getDatabase().chatLoadInitialPages).toBe(18)
    expect(getDatabase().chatLoadAdditionalPages).toBe(7)
  })

  it('normalizes prompt roles across top-level, legacy, and modern preset templates', () => {
    seedPresetDatabase()
    const data = clonePlain(getDatabase()) as unknown as Record<string, unknown>
    data.promptTemplate = [{ id: 'top-row', type: 'description', role2: 'assistant' }]
    ;(data.botPresets as Array<Record<string, unknown>>)[0].promptTemplate = [
      { id: 'legacy-row', type: 'authornote', role2: 'char' },
    ]
    data.promptPresets = [
      {
        id: 'modern-preset',
        name: 'Modern',
        promptTemplate: [{ id: 'modern-row', type: 'cache', role: 'bot', name: '', depth: 1 }],
      },
    ]
    data.promptPresetsId = 0

    setDatabase(data as unknown as Database)

    const normalized = getDatabase() as unknown as Record<string, unknown>
    expect((normalized.promptTemplate as Array<Record<string, unknown>>)[0].role2).toBe('bot')
    expect(((normalized.botPresets as Array<Record<string, unknown>>)[0].promptTemplate as any[])[0].role2).toBe('bot')
    expect(((normalized.promptPresets as Array<Record<string, unknown>>)[0].promptTemplate as any[])[0].role).toBe(
      'assistant',
    )
  })

  it('keeps a present null top-level prompt template null', () => {
    seedPresetDatabase()
    const data = clonePlain(getDatabase()) as unknown as Record<string, unknown>
    data.promptTemplate = null

    setDatabase(data as unknown as Database)

    const normalized = getDatabase() as unknown as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(normalized, 'promptTemplate')).toBe(true)
    expect(normalized.promptTemplate).toBeNull()
  })

  it('defaults popup editing to plain text while preserving explicit Monaco preferences', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete legacyData.useMonacoEditorOnDesktop
    delete legacyData.useMonacoEditorOnMobile

    setDatabase(legacyData)
    expect(getDatabase().useMonacoEditorOnDesktop).toBe(false)
    expect(getDatabase().useMonacoEditorOnMobile).toBe(false)

    const monacoData = clonePlain(getDatabase())
    monacoData.useMonacoEditorOnDesktop = true
    monacoData.useMonacoEditorOnMobile = true
    setDatabase(monacoData)
    expect(getDatabase().useMonacoEditorOnDesktop).toBe(true)
    expect(getDatabase().useMonacoEditorOnMobile).toBe(true)
  })

  it('defaults the saving icon on while preserving an explicit opt-out', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as Partial<Database>).showSavingIcon

    setDatabase(legacyData)
    expect(getDatabase().showSavingIcon).toBe(true)

    const optedOutData = clonePlain(getDatabase())
    optedOutData.showSavingIcon = false
    setDatabase(optedOutData)
    expect(getDatabase().showSavingIcon).toBe(false)
  })

  it('rejects unsupported group rows instead of silently deleting them', () => {
    seedPresetDatabase()
    const before = clonePlain(getDatabase())
    const data = clonePlain(getDatabase())
    data.characters = [
      {
        type: 'group',
        chaId: 'legacy-group-a',
        name: 'Legacy Party',
        chats: [],
      } as never,
    ]

    expect(() => setDatabase(data)).toThrow('refusing to load a lossy database')
    expect(clonePlain(getDatabase())).toEqual(before)
  })

  it('falls back retired PIP session keepalive to sound through setDatabase', () => {
    seedPresetDatabase({
      keepSessionAlive: 'pip' as any,
    })
    const data = clonePlain(getDatabase())

    setDatabase(data)

    expect(getDatabase().keepSessionAlive).toBe('sound')
  })

  it('removes retired hotkey rows while preserving supported custom bindings', () => {
    seedPresetDatabase({
      hotkeys: [
        { action: 'home', ctrl: true, key: 'j' },
        { action: 'modelSelect', ctrl: true, key: 'm' },
        { action: 'toggleVoice', ctrl: true, key: 'v' },
        { action: 'webcam', ctrl: true, key: 'w' },
        { action: 'popupEditor', ctrl: true, key: 'e' },
      ],
    })
    const data = clonePlain(getDatabase())

    setDatabase(data)

    const hotkeys = getDatabase().hotkeys
    expect(hotkeys.map((hotkey) => hotkey.action)).not.toEqual(
      expect.arrayContaining(['modelSelect', 'toggleVoice', 'webcam']),
    )
    expect(hotkeys.find((hotkey) => hotkey.action === 'home')).toMatchObject({ ctrl: true, key: 'j' })
    expect(hotkeys.find((hotkey) => hotkey.action === 'popupEditor')).toMatchObject({ ctrl: true, key: 'e' })
  })
})

describe('model profile database normalization', () => {
  it('normalizes durable profile scaffold fields through setDatabase', () => {
    seedPresetDatabase({
      providerCredentials: [
        { id: ' credential-a ', name: ' Primary key ', type: 'apiKey', apiKey: ' profile-secret ' },
      ],
      modelProfiles: [
        {
          id: ' profile-a ',
          name: ' Primary ',
          providerId: ' openai ',
          modelId: ' gpt-5 ',
          providerOptions: {
            credentialId: ' credential-a ',
            requestModel: ' wire-model ',
            baseUrl: ' https://profile.example.com/v1 ',
            apiKey: ' profile-secret ',
            extraHeaders: { 'X-Test': ' yes ' },
            additionalParams: [[' header::X-Test ', ' true ']],
            openAIKey: 'must-drop',
            openrouter: {
              fallback: false,
              middleOut: true,
              provider: { order: [' ProfileProvider '], only: [' profile-only '], ignore: [''] },
            },
            nanogpt: { providerHint: ' profile-nano ', useSubscriptionEndpoint: true },
            ollama: { url: ' http://localhost:11434 ', requestFormat: LLMFormat.OpenAIResponseAPI },
            vertex: {
              projectId: ' project-a ',
              region: ' us-central1 ',
              clientEmail: ' svc@example.iam.gserviceaccount.com ',
              privateKey: ' private-key ',
            },
            customApi: { tokenizer: LLMTokenizer.Mistral, flags: [LLMFlags.hasStreaming] },
          },
        } as any,
        { id: 'profile-a', name: 'Duplicate' },
        { id: 'profile-b', name: 'Identity Only', modelId: '   ' } as any,
        { id: 'profile-c' } as any,
      ],
      modelProfileOrder: [
        { kind: 'profile', profileId: 'profile-b' },
        { kind: 'divider', id: ' divider-a ' },
        { kind: 'profile', profileId: 'missing' },
        { kind: 'profile', profileId: 'profile-a' },
      ],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: 'profile-a' },
        translate: { mode: 'legacy' },
      } as any,
      modelRuntimeDefaults: {
        maxContext: 8192,
        temperature: 55,
        modelTools: [' tool-a ', ''],
        customFlags: [LLMFlags.hasImageInput],
        unsupportedRuntimeField: true,
      } as any,
    })
    const data = clonePlain(getDatabase())

    setDatabase(data)

    expect(getDatabase().providerCredentials).toEqual([
      { id: 'credential-a', name: 'Primary key', type: 'apiKey', apiKey: 'profile-secret' },
    ])
    expect(getDatabase().modelProfiles).toEqual([
      {
        id: 'profile-a',
        name: 'Primary',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: {
          credentialId: 'credential-a',
          requestModel: 'wire-model',
          baseUrl: 'https://profile.example.com/v1',
          extraHeaders: { 'X-Test': 'yes' },
          additionalParams: [['header::X-Test', 'true']],
          openrouter: {
            fallback: false,
            middleOut: true,
            provider: { order: ['ProfileProvider'], only: ['profile-only'] },
          },
          nanogpt: { providerHint: 'profile-nano', useSubscriptionEndpoint: true },
          ollama: { url: 'http://localhost:11434', requestFormat: LLMFormat.OpenAIResponseAPI },
          vertex: {
            projectId: 'project-a',
            region: 'us-central1',
          },
          customApi: { tokenizer: LLMTokenizer.Mistral, flags: [LLMFlags.hasStreaming] },
        },
      },
      { id: 'profile-b', name: 'Identity Only' },
      { id: 'profile-c', name: 'profile-c' },
    ])
    expect(getDatabase().modelProfileOrder).toEqual([
      { kind: 'profile', profileId: 'profile-b' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-c' },
    ])
    expect(getDatabase().modelRoleProfiles).toEqual({
      ...Object.fromEntries(MODEL_ROLES.map((role) => [role, { mode: 'legacy' }])),
      memory: { mode: 'profile', profileId: 'profile-a' },
    })
    expect(getDatabase().modelRuntimeDefaults).toEqual({
      maxContext: 8192,
      temperature: 55,
      modelTools: ['tool-a'],
      customFlags: [LLMFlags.hasImageInput],
    })
  })

  it('saves durable profile fields into legacy bot preset snapshots', async () => {
    seedPresetDatabase({
      modelProfiles: [
        { id: 'profile-a', name: 'Profile A', modelId: 'gpt-5', providerOptions: { requestModel: 'wire-model' } },
      ],
      modelProfileOrder: [
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-a' },
      ],
      modelRoleProfiles: normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'profile-a' },
      }) as Database['modelRoleProfiles'],
      modelRuntimeDefaults: { maxContext: 8192, temperature: 55 },
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent A', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'agent-preset-a',
    })
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).toMatchObject({
      modelProfiles: [
        { id: 'profile-a', name: 'Profile A', modelId: 'gpt-5', providerOptions: { requestModel: 'wire-model' } },
      ],
      modelProfileOrder: [
        { kind: 'divider', id: 'divider-a' },
        { kind: 'profile', profileId: 'profile-a' },
      ],
      modelRoleProfiles: expect.objectContaining({
        memory: { mode: 'profile', profileId: 'profile-a' },
      }),
      modelRuntimeDefaults: { maxContext: 8192, temperature: 55 },
      agentPresets: [{ id: 'agent-preset-a', name: 'Agent A', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'agent-preset-a',
    })
  })

  it('applies durable profile fields from legacy bot presets with normalization', () => {
    seedPresetDatabase({
      modelProfiles: [{ id: 'base-profile', name: 'Base Profile' }],
      modelRoleProfiles: normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'base-profile' },
      }) as Database['modelRoleProfiles'],
      modelRuntimeDefaults: { maxContext: 4096 },
    })

    setPreset(
      getDatabase(),
      makePreset('preset-c', 'Gamma', {
        modelProfiles: [
          {
            id: ' target-profile ',
            name: ' Target Profile ',
            modelId: ' target-model ',
            providerOptions: { requestModel: ' target-wire ' },
          } as never,
          { id: 'target-profile', name: 'Duplicate' } as never,
        ],
        modelProfileOrder: [
          { kind: 'divider', id: 'target-divider' },
          { kind: 'profile', profileId: 'target-profile' },
        ],
        modelRoleProfiles: {
          memory: { mode: 'profile', profileId: ' target-profile ' },
          translate: { mode: 'legacy' },
        } as never,
        modelRuntimeDefaults: {
          temperature: 66,
          modelTools: [' preset-tool ', ''],
        } as never,
        agentPresets: [
          { id: ' agent-target ', name: ' Target Agent ', enabled: true, steps: [] },
          { id: 'agent-target', name: 'Duplicate Agent', enabled: true, steps: [] },
        ] as never,
        agentPresetDefaultId: 'agent-target',
      }),
    )

    expect(getDatabase().modelProfiles).toEqual([
      {
        id: 'target-profile',
        name: 'Target Profile',
        modelId: 'target-model',
        providerOptions: { requestModel: 'target-wire' },
      },
    ])
    expect(getDatabase().modelProfileOrder).toEqual([
      { kind: 'divider', id: 'target-divider' },
      { kind: 'profile', profileId: 'target-profile' },
    ])
    expect(getDatabase().modelRoleProfiles).toEqual(
      normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'target-profile' },
      }),
    )
    expect(getDatabase().modelRuntimeDefaults).toEqual({
      temperature: 66,
      modelTools: ['preset-tool'],
    })
    expect(getDatabase().agentPresets).toEqual([
      { id: 'agent-target', name: 'Target Agent', enabled: true, version: 1, agentUses: [], steps: [] },
    ])
    expect(getDatabase().agents).toEqual([])
    expect(getDatabase().agentPresetDefaultId).toBe('agent-target')
  })

  it('does not apply legacy bot preset promptTemplate into top-level promptTemplate', () => {
    seedPresetDatabase()
    const beforePromptTemplate = clonePlain(getDatabase().promptTemplate)

    setPreset(
      getDatabase(),
      makePreset('preset-c', 'Gamma', {
        promptTemplate: [{ id: 'gamma-prompt', type: 'plain', text: 'gamma prompt item' }] as any,
      }),
    )

    expect(getDatabase().mainPrompt).toBe('Gamma prompt')
    expect(getDatabase().promptTemplate).toEqual(beforePromptTemplate)
  })
})

describe('agent preset database normalization', () => {
  it('normalizes Agent Preset records and clears stale defaults through setDatabase', () => {
    seedPresetDatabase({
      agentPresets: [
        {
          id: ' ap_research ',
          name: ' Research ',
          enabled: true,
          steps: [{ id: ' aps_context ', outputKey: ' context ' }],
        } as any,
      ],
      agentPresetDefaultId: 'missing-agent-preset',
    })
    const data = clonePlain(getDatabase())

    setDatabase(data)

    expect(getDatabase().agentPresets).toEqual([
      {
        id: 'ap_research',
        name: 'Research',
        enabled: true,
        version: 1,
        agentUses: [
          {
            id: 'aps_context',
            agentId: 'aps_context',
            enabled: true,
            phase: 'beforeMain',
            dependencies: [],
            outputKey: 'context',
            destination: 'promptOutput',
            failurePolicy: { mode: 'required' },
          },
        ],
        steps: [],
      },
    ])
    expect(getDatabase().agents).toEqual([
      {
        id: 'aps_context',
        name: 'aps_context',
        version: 1,
        instruction: '',
        modelDefaults: { mode: 'inheritMain' },
        runtimeDefaults: {},
        inputScopes: [],
        outputFormat: 'text',
      },
    ])
    expect(getDatabase().agentPresetDefaultId).toBeUndefined()
  })
})

describe('accessibility database normalization', () => {
  it('defaults reduced motion to false and preserves an enabled preference', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as unknown as Record<string, unknown>).reducedMotion

    setDatabase(legacyData)
    expect(getDatabase().reducedMotion).toBe(false)

    const enabledData = clonePlain(getDatabase())
    enabledData.reducedMotion = true
    setDatabase(enabledData)
    expect(getDatabase().reducedMotion).toBe(true)
  })

  it('defaults the floating chat input to enabled and preserves an opt-out', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as unknown as Record<string, unknown>).floatingChatInput

    setDatabase(legacyData)
    expect(getDatabase().floatingChatInput).toBe(true)

    const disabledData = clonePlain(getDatabase())
    disabledData.floatingChatInput = false
    setDatabase(disabledData)
    expect(getDatabase().floatingChatInput).toBe(false)
  })

  it('defaults the all-model additional-parameters opt-in to false and preserves true', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as unknown as Record<string, unknown>).applyAdditionalParamsToAll

    setDatabase(legacyData)
    expect(getDatabase().applyAdditionalParamsToAll).toBe(false)

    const enabledData = clonePlain(getDatabase())
    enabledData.applyAdditionalParamsToAll = true
    setDatabase(enabledData)
    expect(getDatabase().applyAdditionalParamsToAll).toBe(true)
  })
})

describe('sentence paragraph database normalization', () => {
  it('defaults legacy databases and preserves existing display preferences', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete legacyData.paragraphBreakBySentences
    delete legacyData.paragraphBreakSentenceCount

    setDatabase(legacyData)
    expect(getDatabase().paragraphBreakBySentences).toBe(false)
    expect(getDatabase().paragraphBreakSentenceCount).toBe(3)

    const configuredData = clonePlain(getDatabase())
    configuredData.paragraphBreakBySentences = true
    configuredData.paragraphBreakSentenceCount = 6
    setDatabase(configuredData)
    expect(getDatabase().paragraphBreakBySentences).toBe(true)
    expect(getDatabase().paragraphBreakSentenceCount).toBe(6)
  })
})

describe('model parameter database normalization', () => {
  it('defaults missing reasoning effort and verbosity without replacing configured values', () => {
    seedPresetDatabase()
    const legacyData = clonePlain(getDatabase())
    delete (legacyData as unknown as Record<string, unknown>).reasoningEffort
    delete (legacyData as unknown as Record<string, unknown>).verbosity

    setDatabase(legacyData)
    expect(getDatabase().reasoningEffort).toBe(0)
    expect(getDatabase().verbosity).toBe(1)

    const configuredData = clonePlain(getDatabase())
    configuredData.reasoningEffort = 3
    configuredData.verbosity = 2
    setDatabase(configuredData)
    expect(getDatabase().reasoningEffort).toBe(3)
    expect(getDatabase().verbosity).toBe(2)
  })
})

function seedPresetDatabase(patch: Partial<Database> = {}): void {
  setDatabaseLite({
    characters: [],
    modules: [],
    personas: [],
    language: 'en',
    botPresets: [
      makePreset('preset-a', 'Alpha', { temperature: 11 }),
      makePreset('preset-b', 'Beta', { temperature: 22 }),
    ],
    botPresetsId: 0,
    apiType: 'live-api',
    openAIKey: '',
    proxyKey: 'live-proxy-key',
    mainPrompt: 'live main',
    jailbreak: 'live jailbreak',
    globalNote: 'live note',
    temperature: 44,
    maxContext: 4096,
    maxResponse: 512,
    frequencyPenalty: 10,
    PresensePenalty: 12,
    formatingOrder: ['main'] as any,
    aiModel: 'live-model',
    subModel: 'live-submodel',
    currentPluginProvider: 'live-provider',
    textgenWebUIStreamURL: 'wss://live',
    textgenWebUIBlockingURL: 'https://live',
    forceReplaceUrl: 'live-force',
    promptPreprocess: false,
    bias: [['token', 1]],
    koboldURL: 'https://kobold',
    ooba: {} as any,
    ainconfig: {} as any,
    openrouterRequestModel: 'live-openrouter',
    proxyRequestModel: 'live-proxy-model',
    NAIsettings: { cfg_scale: 7, mirostat_tau: 8, mirostat_lr: 9 } as any,
    autoSuggestPrompt: 'live autosuggest',
    autoSuggestPrefix: 'live prefix',
    autoSuggestClean: true,
    promptTemplate: [{ id: 'live-prompt', type: 'plain', text: 'live prompt row' }] as any,
    NAIadventure: false,
    NAIappendName: true,
    localStopStrings: ['live stop'],
    customProxyRequestModel: 'live-custom-proxy',
    reverseProxyOobaArgs: { mode: 'instruct' } as any,
    top_p: 0.8,
    promptSettings: {
      assistantPrefill: 'live prefill',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
      customChainOfThought: false,
      maxThoughtTagDepth: 7,
    },
    repetition_penalty: 1.1,
    min_p: 0.2,
    top_a: 0.3,
    openrouterProvider: { order: ['provider-a'], only: [], ignore: [] },
    useInstructPrompt: true,
    customPromptTemplateToggle: 'live-toggle',
    templateDefaultVariables: 'live vars',
    moduleIntergration: 'live-module',
    top_k: 40,
    instructChatTemplate: 'live-template',
    JinjaTemplate: 'live-jinja',
    jsonSchemaEnabled: true,
    jsonSchema: '{"type":"object"}',
    strictJsonSchema: true,
    extractJson: 'live-json',
    seperateParametersEnabled: true,
    customAPIFormat: 'openai' as any,
    systemContentReplacement: 'system: {{slot}}',
    systemRoleReplacement: 'user',
    customFlags: [],
    enableCustomFlags: false,
    presetRegex: [],
    reasoningEffort: 4,
    thinkingTokens: 128,
    thinkingType: 'budget',
    deepseekThinkingType: 'off',
    adaptiveThinkingEffort: 'high',
    deepseekReasoningEffort: 'high',
    outputImageModal: false,
    doNotChangeSeperateModels: false,
    modelRoles: {
      chatMain: '',
      chatAux: '',
      memory: '',
      emotion: '',
      translate: '',
      otherAx: '',
      scriptMain: '',
      scriptAux: '',
    },
    seperateModelsForAxModels: true,
    seperateModels: { memory: 'm', emotion: 'e', translate: 't', otherAx: 'o', scriptMain: '', scriptAux: '' },
    doNotChangeFallbackModels: false,
    fallbackModels: {
      memory: ['m1'],
      emotion: ['e1'],
      translate: ['t1'],
      otherAx: ['o1'],
      model: ['x1'],
      scriptMain: [],
      scriptAux: [],
    },
    fallbackWhenBlankResponse: true,
    disableSeperateParameterChangeOnPresetChange: false,
    seperateParameters: {
      memory: {},
      emotion: {},
      translate: {},
      otherAx: {},
      scriptMain: {},
      scriptAux: {},
      overrides: {},
    },
    modelTools: ['tool-a'],
    verbosity: 2,
    dynamicOutput: null,
    customBackground: 'live background',
    ...patch,
  } as unknown as Database)
}

beforeEach(() => {
  clearCachedServerCommandRevision()
  setServerCommandSuccessReconciler(null)
  resetPendingPresetMutationsForTests()
})

afterEach(() => {
  resetPendingPresetMutationsForTests()
  setServerCommandSuccessReconciler(null)
  setDatabaseLite({
    characters: [],
    modules: [],
    personas: [],
    language: 'en',
  } as unknown as Database)
  vi.unstubAllGlobals()
})

describe('mergeServerResourceCharacterRow', () => {
  it('advances destructive refresh epoch for full database replacement but not partial merges', () => {
    seedDatabase([])
    const beforeFullReplace = captureDestructiveRefreshEpoch()

    applyServerResourceDatabase({
      characters: [],
      modules: [],
      personas: [],
      language: 'ko',
    } as unknown as Database)

    expect(hasDestructiveRefreshEpochChanged(beforeFullReplace)).toBe(true)
    expect(getDatabase().language).toBe('ko')

    const afterFullReplace = captureDestructiveRefreshEpoch()
    mergeServerResourceFields({ language: 'en' } as Partial<Database>)

    expect(getDatabase().language).toBe('en')
    expect(captureDestructiveRefreshEpoch()).toBe(afterFullReplace)
  })

  it('applies the runtime language side effect when a targeted projection merges language', async () => {
    seedDatabase([])
    changeLanguage('en')
    expect(activeLanguage.showHelp).toBe('Show Help')

    mergeServerResourceFields({ language: 'ko' } as Partial<Database>)

    expect(getDatabase().language).toBe('ko')
    await awaitLanguageReady()
    expect(activeLanguage.showHelp).toBe('도움말 보기')
  })

  it('applies null deletion sentinels without clearing unrelated projected fields', () => {
    seedPresetDatabase({
      agentPresetDefaultId: 'agent-old',
      promptTemplate: [{ id: 'prompt-live', type: 'plain', text: 'keep me' }] as any,
    })

    mergeServerResourceFields({ agentPresetDefaultId: null } as unknown as Partial<Database>)

    expect(getDatabase().agentPresetDefaultId).toBeUndefined()
    expect(getDatabase().promptTemplate).toEqual([{ id: 'prompt-live', type: 'plain', text: 'keep me' }])
  })

  it('preserves hydrated hypaV3Data on message-empty chat stubs', () => {
    const hypaV3Data = {
      memories: [{ id: 'memory-1', text: 'remember this' }],
    }
    seedDatabase([
      {
        chaId: 'char-a',
        name: 'Ada',
        chats: [{ id: 'chat-a', message: [], hypaV3Data }],
      },
    ])

    const applied = mergeServerResourceCharacterRow({
      chaId: 'char-a',
      name: 'Ada Lovelace',
      chats: [{ id: 'chat-a', message: [] }],
    })

    expect(applied).toBe(true)
    expect(getDatabase().characters[0].name).toBe('Ada Lovelace')
    expect(getDatabase().characters[0].chats[0].message).toEqual([])
    expect(getDatabase().characters[0].chats[0].hypaV3Data).toEqual(hypaV3Data)
  })

  it('keeps non-empty hydrated messages on incoming chat stubs', () => {
    const priorMessages = [{ role: 'user' as const, data: 'hi' }]
    seedDatabase([
      {
        chaId: 'char-a',
        name: 'Ada',
        chats: [{ id: 'chat-a', message: priorMessages }],
      },
    ])

    const applied = mergeServerResourceCharacterRow({
      chaId: 'char-a',
      name: 'Ada Lovelace',
      chats: [{ id: 'chat-a', message: [] }],
    })

    expect(applied).toBe(true)
    expect(getDatabase().characters[0].name).toBe('Ada Lovelace')
    expect(getDatabase().characters[0].chats[0].message).toEqual(priorMessages)
    expect(getDatabase().characters[0].chats[0].hypaV3Data).toBeUndefined()
  })

  it('clears the bootstrap shell marker when a full character row hydrates', () => {
    seedDatabase([
      {
        __serverCharacterShell: true,
        chaId: 'char-a',
        name: 'Ada shell',
        chats: [{ id: 'chat-a', message: [] }],
      },
    ])

    const applied = mergeServerResourceCharacterRow({
      __serverCharacterShell: true,
      chaId: 'char-a',
      name: 'Ada full',
      desc: 'Hydrated description',
      chats: [{ id: 'chat-a', message: [] }],
    })

    expect(applied).toBe(true)
    expect(getDatabase().characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'Ada full',
      desc: 'Hydrated description',
    })
    expect(getDatabase().characters[0]).not.toHaveProperty('__serverCharacterShell')
  })

  it('returns false for unknown characters without mutating the corpus', () => {
    seedDatabase([
      {
        chaId: 'char-a',
        name: 'Ada',
        chats: [{ id: 'chat-a', message: [] }],
      },
    ])
    const characters = getDatabase().characters
    const before = JSON.stringify(characters)

    const applied = mergeServerResourceCharacterRow({
      chaId: 'char-missing',
      name: 'Missing',
      chats: [{ id: 'chat-missing', message: [] }],
    })

    expect(applied).toBe(false)
    expect(getDatabase().characters).toBe(characters)
    expect(JSON.stringify(getDatabase().characters)).toBe(before)
  })
})

describe('preset command rollback', () => {
  it.each([
    {
      kind: 'model' as const,
      presetId: 'model-a',
      presetPath: '/model-presets/model-a',
    },
    {
      kind: 'prompt' as const,
      presetId: 'prompt-a',
      presetPath: '/prompt-presets/prompt-a',
    },
  ])('preserves masked projected credentials when updating the selected $kind preset', async (testCase) => {
    seedPresetDatabase({
      providerCredentials: [
        {
          id: 'credential-api',
          name: 'OpenAI',
          type: 'apiKey',
          apiKey: MASKED_PROVIDER_SECRET,
        },
      ],
      modelPresets: [makePreset('model-a', 'Model A') as unknown as ModelPreset],
      modelPresetsId: 0,
      promptPresets: [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset],
      promptPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    if (testCase.kind === 'model') updateModelPreset(0, { temperature: 22 })
    else updatePromptPreset(0, { mainPrompt: 'edited prompt' })

    expect(getDatabase().providerCredentials).toEqual([
      {
        id: 'credential-api',
        name: 'OpenAI',
        type: 'apiKey',
        apiKey: MASKED_PROVIDER_SECRET,
      },
    ])

    flushPendingSplitPresetPatch(testCase.kind, testCase.presetId)
    await waitForPresetCommand(calls, testCase.presetPath)
    expect(getDatabase().providerCredentials).toHaveLength(1)
  })

  it('applies a prompt preset legacy regex alias when presetRegex is empty', async () => {
    const liveRegex = [{ id: 'live-regex', in: 'hi', out: 'LIVE', type: 'editinput' }]
    const selectedRegex = [{ id: 'selected-regex', in: 'hi', out: 'SELECTED', type: 'editinput' }]
    seedPresetDatabase({
      presetRegex: liveRegex as any,
      promptPresets: [
        { id: 'prompt-a', name: 'Prompt A', presetRegex: liveRegex },
        { id: 'prompt-b', name: 'Prompt B', regex: selectedRegex, presetRegex: [] },
      ] as any,
      promptPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toBe('/api/v1/commands/prompt-presets/select')
      expect(init.method).toBe('POST')
      return jsonResponse({
        revision: 101,
        event: {
          type: 'promptPreset.selected',
          revision: 101,
          resource: 'preset',
          id: 'prompt-b',
        },
        promptPresetId: 'prompt-b',
      })
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    selectPromptPreset(1)

    expect(getDatabase().promptPresetsId).toBe(1)
    expect(getDatabase().presetRegex).toEqual(selectedRegex)
    await waitForState(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })

  it('clears stale legacy regex when updating canonical prompt preset regex', async () => {
    const staleRegex = [{ id: 'stale-regex', in: 'hi', out: 'STALE', type: 'editinput' }]
    seedPresetDatabase({
      presetRegex: staleRegex as any,
      promptPresets: [{ id: 'prompt-a', name: 'Prompt A', regex: staleRegex, presetRegex: [] }] as any,
      promptPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      expect(String(input)).toBe('/api/v1/commands/prompt-presets/prompt-a')
      expect(init.method).toBe('PATCH')
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      expect(body.patch).toEqual({ name: 'Prompt A final', regex: [] })
      return jsonResponse({
        revision: 101,
        event: {
          type: 'promptPreset.updated',
          revision: 101,
          resource: 'preset',
          id: 'prompt-a',
        },
        promptPresetId: 'prompt-a',
      })
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    updatePromptPreset(0, { name: 'Prompt A draft' })
    updatePromptPreset(0, { name: 'Prompt A final' })
    updatePromptPreset(0, { presetRegex: [] } as any)
    flushPendingSplitPresetPatches()

    expect(getDatabase().promptPresets[0]).toMatchObject({ regex: [], presetRegex: [] })
    expect(getDatabase().presetRegex).toEqual([])
    await waitForState(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
  })

  it('skips projection refreeze when hydrated bot preset ids are already normalized', async () => {
    const preset = makePreset('preset-a', 'Alpha')
    delete preset.promptTemplate
    seedPresetDatabase({
      botPresets: [preset],
      botPresetsId: 0,
    })
    const before = getDatabase()

    expect(botPresetIdsNeedNormalization(getDatabase())).toBe(false)
    await expect(ensureBotPresetHydrated(0)).resolves.toBe(true)

    expect(getDatabase()).toBe(before)
  })

  it('fails closed without repairing, refreezing, or fetching when projected preset ids are invalid', async () => {
    const cases: Array<{ name: string; botPresets: botPreset[] }> = [
      {
        name: 'missing id',
        botPresets: [{ name: 'Alpha', promptTemplate: [] } as botPreset],
      },
      {
        name: 'duplicate id',
        botPresets: [
          { id: 'preset-dupe', name: 'Alpha', image: 'img' } as botPreset,
          { id: 'preset-dupe', name: 'Beta', image: 'img' } as botPreset,
        ],
      },
    ]

    for (const scenario of cases) {
      seedPresetDatabase({
        botPresets: scenario.botPresets,
        botPresetsId: 0,
      })
      const fetchSpy = vi.fn(async () => {
        throw new Error(`unexpected preset hydration fetch for ${scenario.name}`)
      })
      vi.stubGlobal('fetch', fetchSpy)
      const before = getDatabase()
      const beforeJson = JSON.stringify(getDatabase())

      expect(botPresetIdsNeedNormalization(getDatabase())).toBe(true)
      await expect(ensureBotPresetHydrated(0)).resolves.toBe(false)

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(getDatabase()).toBe(before)
      expect(JSON.stringify(getDatabase())).toBe(beforeJson)
      vi.unstubAllGlobals()
    }
  })

  it('fails closed without fetching when preset hydration is asked for an invalid index', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    const fetchSpy = vi.fn(async () => {
      throw new Error('unexpected preset hydration fetch for invalid index')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const before = getDatabase()

    await expect(ensureBotPresetHydrated(-1)).resolves.toBe(false)
    await expect(ensureBotPresetHydrated(1)).resolves.toBe(false)
    await expect(ensureBotPresetHydrated(0.5)).resolves.toBe(false)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getDatabase()).toBe(before)
  })

  it('hydrates a stubbed preset from the server projection before full-preset consumers read it', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('/api/v1/legacy-presets/preset-stub')
        return jsonResponse({
          revision: 7,
          preset: makePreset('preset-stub', 'Hydrated', {
            promptTemplate: [{ id: 'hydrated-prompt', type: 'plain', text: 'hydrated prompt' }] as any,
          }),
        })
      }) as unknown as typeof fetch,
    )

    await expect(ensureBotPresetHydrated(0)).resolves.toBe(true)

    expect(getDatabase().botPresets[0]).toMatchObject({
      id: 'preset-stub',
      name: 'Hydrated',
      mainPrompt: 'Hydrated prompt',
      promptTemplate: [{ id: 'hydrated-prompt', type: 'plain', text: 'hydrated prompt' }],
    })
  })

  it('does not refetch an authoritative legacy preset with no optional settings fields', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-minimal', name: 'Minimal', image: 'minimal.png' } as botPreset],
      botPresetsId: 0,
    })
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        revision: 7,
        preset: {
          id: 'preset-minimal',
          name: 'Minimal',
          image: 'minimal.png',
          localNetworkMode: false,
          localNetworkTimeoutSec: 600,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(ensureBotPresetHydrated(0)).resolves.toBe(true)
    withTestDatabaseWrite(() => {
      getDatabase().botPresets[0] = clonePlain(getDatabase().botPresets[0])
    })
    await expect(ensureBotPresetHydrated(0)).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getDatabase().botPresets[0]).toEqual({
      id: 'preset-minimal',
      name: 'Minimal',
      image: 'minimal.png',
      localNetworkMode: false,
      localNetworkTimeoutSec: 600,
    })
  })

  it('rejects a legacy hydration body that omits the requested stable id', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          revision: 7,
          preset: { name: 'Malformed', mainPrompt: 'must not apply' },
        }),
      ) as unknown as typeof fetch,
    )

    await expect(ensureBotPresetHydrated(0)).resolves.toBe(false)
    expect(getDatabase().botPresets[0]).toEqual({ id: 'preset-stub', name: 'Stub', image: 'img' })
  })

  it('waits for stable-id hydration before selecting a legacy preset', async () => {
    const alpha = makePreset('preset-a', 'Alpha')
    const betaShell = { id: 'preset-b', name: 'Beta', image: 'beta.png' } as botPreset
    seedPresetDatabase({ botPresets: [alpha, betaShell], botPresetsId: 0 })
    setCachedServerCommandRevision(100)
    const hydration = deferred<Response>()
    const command = deferred<Response>()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = {
          url: String(input),
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        }
        calls.push(call)
        return call.url === '/api/v1/legacy-presets/preset-b' ? hydration.promise : command.promise
      }) as unknown as typeof fetch,
    )

    changeToPreset(1, false)
    await vi.waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/v1/legacy-presets/preset-b']))
    expect(getDatabase().botPresetsId).toBe(0)
    expect(getDatabase().mainPrompt).toBe('live main')

    mergeServerResourceFields({
      botPresets: [betaShell, alpha],
      botPresetsId: 1,
    } as Partial<Database>)
    hydration.resolve(jsonResponse({ revision: 100, preset: makePreset('preset-b', 'Beta') }))
    const selection = await waitForPresetCommand(calls, '/presets/select')

    expect(selection.body).toMatchObject({ presetId: 'preset-b', apply: true, saveCurrent: false })
    expect(getDatabase().botPresetsId).toBe(0)
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    command.resolve(
      jsonResponse({
        revision: 101,
        event: { type: 'preset.selected', revision: 101, resource: 'revisionOnly', id: 'preset-b' },
        presetId: 'preset-b',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('waits for the stable-id replacement body before deleting and applying', async () => {
    const alpha = makePreset('preset-a', 'Alpha')
    const betaShell = { id: 'preset-b', name: 'Beta', image: 'beta.png' } as botPreset
    seedPresetDatabase({ botPresets: [alpha, betaShell], botPresetsId: 0 })
    setCachedServerCommandRevision(100)
    const hydration = deferred<Response>()
    const command = deferred<Response>()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = {
          url: String(input),
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        }
        calls.push(call)
        return call.url === '/api/v1/legacy-presets/preset-b' ? hydration.promise : command.promise
      }) as unknown as typeof fetch,
    )

    deletePreset(0, 1, true)
    await vi.waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/v1/legacy-presets/preset-b']))
    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b'])
    expect(getDatabase().mainPrompt).toBe('live main')

    mergeServerResourceFields({
      botPresets: [betaShell, alpha],
      botPresetsId: 1,
    } as Partial<Database>)
    hydration.resolve(jsonResponse({ revision: 100, preset: makePreset('preset-b', 'Beta') }))
    const deletion = await waitForPresetCommand(calls, '/presets/preset-a')

    expect(deletion.body).toMatchObject({ presetId: 'preset-b', apply: true, saveCurrent: false })
    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b'])
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    command.resolve(jsonResponse({ error: 'finish pending delete' }, 500))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('hydrates and re-resolves a legacy extraction target by stable id', async () => {
    const alphaShell = { id: 'preset-a', name: 'Alpha', image: 'alpha.png' } as botPreset
    const beta = makePreset('preset-b', 'Beta')
    seedPresetDatabase({
      botPresets: [alphaShell, beta],
      botPresetsId: 0,
      modelPresets: [],
      promptPresets: [],
    })
    setCachedServerCommandRevision(100)
    const hydration = deferred<Response>()
    const command = deferred<Response>()
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = {
          url: String(input),
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        }
        calls.push(call)
        return call.url === '/api/v1/legacy-presets/preset-a' ? hydration.promise : command.promise
      }) as unknown as typeof fetch,
    )

    extractLegacyBotPresetByIndex(0, 'all')
    await vi.waitFor(() => expect(calls.map((call) => call.url)).toEqual(['/api/v1/legacy-presets/preset-a']))
    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b'])
    expect(getDatabase().modelPresets).toEqual([])
    expect(getDatabase().promptPresets).toEqual([])

    mergeServerResourceFields({
      botPresets: [beta, alphaShell],
      botPresetsId: 1,
    } as Partial<Database>)
    hydration.resolve(jsonResponse({ revision: 100, preset: makePreset('preset-a', 'Alpha') }))
    await waitForPresetCommand(calls, '/legacy-bot-presets/preset-a/extract')

    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b'])
    expect(getDatabase().modelPresets.some((preset) => preset.name === 'Alpha Model')).toBe(true)
    expect(getDatabase().promptPresets.some((preset) => preset.name === 'Alpha Prompt')).toBe(true)
    command.resolve(jsonResponse({ error: 'finish pending extract' }, 500))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('hydrates a stubbed preset after an unrelated projection advances the known revision', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(5)
    const response = deferred<Response>()
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      expect(String(input)).toBe('/api/v1/legacy-presets/preset-stub')
      return response.promise
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const pending = ensureBotPresetHydrated(0)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    setCachedServerCommandRevision(6)
    mergeServerResourceFields({ language: 'ko' } as Partial<Database>)
    response.resolve(
      jsonResponse({
        revision: 5,
        preset: makePreset('preset-stub', 'Hydrated after settings'),
      }),
    )

    await expect(pending).resolves.toBe(true)

    expect(getDatabase().botPresets[0]).toMatchObject({
      id: 'preset-stub',
      name: 'Hydrated after settings',
      mainPrompt: 'Hydrated after settings prompt',
    })
    expect(getDatabase().language).toBe('ko')
  })

  it('rejects a preset hydration response after the target preset changes', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(5)
    const response = deferred<Response>()
    const fetchSpy = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const pending = ensureBotPresetHydrated(0)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    setCachedServerCommandRevision(6)
    mergeServerResourceFields({
      botPresets: [{ id: 'preset-stub', name: 'Newer projection', image: 'img' } as botPreset],
      botPresetsId: 0,
    } as Partial<Database>)
    response.resolve(
      jsonResponse({
        revision: 5,
        resource: 'preset',
        mode: 'preset',
        presetId: 'preset-stub',
        preset: makePreset('preset-stub', 'Stale hydration'),
      }),
    )

    await expect(pending).resolves.toBe(false)

    expect(getDatabase().botPresets[0]).toEqual({
      id: 'preset-stub',
      name: 'Newer projection',
      image: 'img',
    })
  })

  it('sends only changed fields when saving a large hydrated legacy preset', async () => {
    const modelProfiles = Array.from({ length: 80 }, (_, index) => ({
      id: `profile-${index}`,
      name: `Large unchanged profile ${index}`,
      modelId: `model-${index}`,
    }))
    const settings = { modelProfiles } as Partial<Database>
    const baseline = await captureFullLegacyPresetSavePayload(settings)
    seedPresetDatabase({
      ...settings,
      botPresets: [baseline, makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
      temperature: 45,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).toEqual({ temperature: 45 })
    expect(JSON.stringify(command.body)).not.toContain('Large unchanged profile')
  })

  it('attaches a client-only local acknowledgement to an exact legacy preset PATCH', async () => {
    seedPresetDatabase()
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulLegacyPresetCommands(() => ({ canonicalValues: { temperature: 43 } }))
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    updatePreset(0, { temperature: 45 })

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => expect(observedEffects).toHaveLength(1))
    expect(command.body).toEqual({
      baseRevision: 100,
      patch: { temperature: 45 },
    })
    expect(command.body).not.toHaveProperty('optimisticAcknowledgement')
    expect(observedEffects).toEqual([
      {
        kind: 'legacyPresetPatch',
        presetId: 'preset-a',
        collectionProjectionEpoch: expect.any(Number),
        fields: {
          temperature: {
            attempted: { present: true, value: 45 },
            canonical: { present: true, value: 43 },
          },
        },
      },
    ])
  })

  it('attaches a local acknowledgement to an exact hydrated sparse current-preset save', async () => {
    const agentSettings = {
      agentPresets: [{ id: 'agent-a', name: 'Agent A', enabled: true, version: 1, steps: [] }],
      agentPresetDefaultId: 'agent-a',
    } as Partial<Database>
    const baseline = await captureFullLegacyPresetSavePayload(agentSettings)
    seedPresetDatabase({
      ...agentSettings,
      botPresets: [baseline, makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
      temperature: 45,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulLegacyPresetCommands()
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => expect(observedEffects).toHaveLength(1))
    expect(command.body.patch).toEqual({ temperature: 45 })
    expect(observedEffects).toEqual([
      {
        kind: 'legacyPresetPatch',
        presetId: 'preset-a',
        collectionProjectionEpoch: expect.any(Number),
        fields: {},
      },
    ])
  })

  it('retains authoritative reconciliation for an unhydrated full current-preset save fallback', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-a', name: 'Alpha', image: 'img' } as botPreset],
      botPresetsId: 0,
      temperature: 45,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulLegacyPresetCommands()
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => expect(observedEffectCounts).toEqual([0]))
    expect(Object.keys(command.body.patch).length).toBeGreaterThan(20)
  })

  it('retains authoritative reconciliation when a shell gains a hydration sentinel through updatePreset', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-a', name: 'Alpha', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulLegacyPresetCommands()
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    updatePreset(0, { temperature: 45 })

    await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => expect(observedEffectCounts).toEqual([0]))
  })

  it('retains authoritative reconciliation when legacy preset ids needed optimistic repair', async () => {
    const repaired = makePreset('temporary', 'Alpha')
    delete repaired.id
    seedPresetDatabase({ botPresets: [repaired], botPresetsId: 0 })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulLegacyPresetCommands()
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    updatePreset(0, { temperature: 45 })

    await waitForState(() => expect(calls.some((call) => call.url.startsWith('/api/v1/commands/presets/'))).toBe(true))
    await waitForState(() => expect(observedEffectCounts).toEqual([0]))
  })

  it.each([
    ['field update', () => updatePreset(0, { temperature: 45 })],
    ['current save', () => saveCurrentPreset()],
  ])('taints the legacy preset projection before rolling back a failed %s', async (_label, mutate) => {
    seedPresetDatabase({ temperature: 45 })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()
    expect(isCollectionAcknowledgementTainted('botPresets')).toBe(false)

    mutate()

    await waitForState(() => expect(calls.some((call) => call.url.startsWith('/api/v1/commands/presets/'))).toBe(true))
    await waitForState(() => expect(isCollectionAcknowledgementTainted('botPresets')).toBe(true))
  })

  it('keeps legacy preset ids immutable across a mismatched-id update failure', async () => {
    seedPresetDatabase()
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()

    updatePreset(0, { id: 'renamed-on-client', temperature: 45 })

    expect(getDatabase().botPresets[0].id).toBe('preset-a')
    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).toEqual({ temperature: 45 })
    await waitForState(() => {
      expect(getDatabase().botPresets[0]).toMatchObject({ id: 'preset-a', temperature: 11 })
    })
  })

  it('suppresses legacy preset updates whose mutable fields are unchanged', async () => {
    seedPresetDatabase()
    setCachedServerCommandRevision(100)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    updatePreset(0, { id: 'ignored-id', temperature: 11 })

    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getDatabase().botPresets[0]).toMatchObject({ id: 'preset-a', temperature: 11 })
    expect(isCollectionAcknowledgementTainted('botPresets')).toBe(false)
  })

  it('preserves explicit null, empty collection, and empty string clears in sparse save patches', async () => {
    const settings = {
      additionalParams: [['header::X-Legacy', 'enabled']],
      bias: [['token', 1]],
      customPromptTemplateToggle: 'enabled',
      dynamicOutput: { mode: 'legacy' } as any,
    } as Partial<Database>
    const baseline = await captureFullLegacyPresetSavePayload(settings)
    seedPresetDatabase({
      ...settings,
      botPresets: [baseline, makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
    })
    getDatabase().additionalParams = []
    getDatabase().bias = []
    getDatabase().customPromptTemplateToggle = ''
    getDatabase().dynamicOutput = null
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).toEqual({
      additionalParams: [],
      bias: [],
      customPromptTemplateToggle: '',
      dynamicOutput: null,
    })
  })

  it('suppresses an exact hydrated save no-op and preserves the local preset row', async () => {
    const baseline = await captureFullLegacyPresetSavePayload()
    seedPresetDatabase({
      botPresets: [baseline, makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()
    const before = getDatabase().botPresets[0]
    const beforeJson = JSON.stringify(before)

    saveCurrentPreset()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls).toHaveLength(0)
    expect(getDatabase().botPresets[0]).toBe(before)
    expect(JSON.stringify(getDatabase().botPresets[0])).toBe(beforeJson)
  })

  it('falls back to the full save payload for unhydrated and id-repaired baselines', async () => {
    const modelProfiles = [{ id: 'profile-large', name: 'Large unchanged fallback profile', modelId: 'model-a' }]
    const cases: Array<{ name: string; preset: botPreset }> = [
      {
        name: 'unhydrated',
        preset: { id: 'preset-a', name: 'Alpha', image: 'img' } as botPreset,
      },
      {
        name: 'id-repaired',
        preset: makePreset('temporary', 'Alpha', { modelProfiles }) as botPreset,
      },
    ]
    delete cases[1].preset.id

    for (const scenario of cases) {
      seedPresetDatabase({
        botPresets: [scenario.preset],
        botPresetsId: 0,
        modelProfiles,
      })
      setCachedServerCommandRevision(100)
      const calls = stubFailedPresetCommand()

      saveCurrentPreset()

      await waitForState(() =>
        expect(calls.some((call) => call.url.startsWith('/api/v1/commands/presets/'))).toBe(true),
      )
      const command = calls.find((call) => call.url.startsWith('/api/v1/commands/presets/'))!
      expect(command.body.patch.modelProfiles, scenario.name).toEqual(modelProfiles)
      expect(Object.keys(command.body.patch).length, scenario.name).toBeGreaterThan(20)
      expect(command.body.patch, scenario.name).not.toHaveProperty('id')

      vi.unstubAllGlobals()
    }
  })

  it('uses the historical full payload fallback when a hydrated baseline field is absent from the save snapshot', async () => {
    const modelProfiles = [{ id: 'profile-large', name: 'Large unchanged fallback profile', modelId: 'model-a' }]
    const settings = { modelProfiles } as Partial<Database>
    const baseline = await captureFullLegacyPresetSavePayload(settings)
    const baselineRecord = baseline as unknown as Record<string, unknown>
    baselineRecord.legacyOnlyField = 'cannot-delete-with-merge-patch'
    seedPresetDatabase({
      ...settings,
      botPresets: [baseline, makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch.modelProfiles).toEqual(modelProfiles)
    expect(command.body.patch).not.toHaveProperty('legacyOnlyField')
    expect(Object.keys(command.body.patch).length).toBeGreaterThan(20)
  })

  it('does not save an unloaded promptTemplate as null when snapshotting the current preset', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-a', name: 'Alpha', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    delete (getDatabase() as unknown as { promptTemplate?: unknown }).promptTemplate
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).toMatchObject({
      name: 'Alpha',
      mainPrompt: 'live main',
    })
    expect(command.body.patch).not.toHaveProperty('promptTemplate')
  })

  it('does not snapshot top-level promptTemplate into legacy bot presets', async () => {
    seedPresetDatabase({
      promptTemplate: [{ id: 'live-only-prompt', type: 'plain', text: 'live only prompt row' }] as any,
    })
    const beforePresetTemplate = clonePlain(getDatabase().botPresets[0].promptTemplate)
    const calls = stubFailedPresetCommand()

    saveCurrentPreset()

    const command = await waitForPresetCommand(calls, '/presets/preset-a')
    expect(command.body.patch).not.toHaveProperty('promptTemplate')
    expect(getDatabase().botPresets[0].promptTemplate).toEqual(beforePresetTemplate)
  })

  it('ignores stale preset hydration responses older than the applied revision', async () => {
    seedPresetDatabase({
      botPresets: [{ id: 'preset-stub', name: 'Stub', image: 'img' } as botPreset],
      botPresetsId: 0,
    })
    setCachedServerCommandRevision(9)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('/api/v1/legacy-presets/preset-stub')
        return jsonResponse({
          revision: 8,
          preset: makePreset('preset-stub', 'Stale', {
            promptTemplate: [{ id: 'stale-prompt', type: 'plain', text: 'stale prompt' }] as any,
          }),
        })
      }) as unknown as typeof fetch,
    )

    await expect(ensureBotPresetHydrated(0)).resolves.toBe(false)

    expect(getDatabase().botPresets[0]).toEqual({ id: 'preset-stub', name: 'Stub', image: 'img' })
  })

  it('failed save restores the saved preset collection and selected index', async () => {
    seedPresetDatabase({ temperature: 91 })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().botPresets[0].name = 'Alpha edited after dispatch'
      getDatabase().botPresets.push(makePreset('preset-c', 'Gamma appended after dispatch'))
      getDatabase().botPresetsId = 1
    })

    saveCurrentPreset()

    expect(getDatabase().botPresets[0].temperature).toBe(91)
    await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[0]).toMatchObject({
        name: 'Alpha edited after dispatch',
        temperature: 11,
      })
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma appended after dispatch' })
      expect(getDatabase().botPresetsId).toBe(1)
      expect(getDatabase().temperature).toBe(91)
    })
  })

  it('coalesces same-owner rapid and disjoint field edits into one final sparse patch', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
      temperature: 11,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    updateModelPreset(0, { name: 'Alph' })
    updateModelPreset(0, { temperature: 22 })
    updateModelPreset(0, { name: 'Alp' })

    expect(getDatabase().modelPresets[0].name).toBe('Alp')
    expect(getDatabase().modelPresets[0].temperature).toBe(22)
    expect(getDatabase().temperature).toBe(22)
    expect(calls).toHaveLength(0)

    flushPendingSplitPresetPatch('model', 'model-a')

    const command = await waitForPresetCommand(calls, '/model-presets/model-a')
    expect(command.body.patch).toEqual({ name: 'Alp', temperature: 22 })
    expect(command.body.patch).not.toHaveProperty('id')
    await waitForState(() => {
      expect(calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-a')).toHaveLength(1)
      expect(getDatabase().modelPresets[0].name).toBe('Alp')
    })
  })

  it.each([
    {
      kind: 'model' as const,
      presetId: 'model-created-durable',
      ownerKey: 'split-preset:model:model-created-durable',
      createPath: '/model-presets',
      updatePath: '/model-presets/model-created-durable',
    },
    {
      kind: 'prompt' as const,
      presetId: 'prompt-created-durable',
      ownerKey: 'prompt-template-owner:prompt-created-durable',
      createPath: '/prompt-presets',
      updatePath: '/prompt-presets/prompt-created-durable',
    },
  ])('keeps an immediate $kind preset edit behind its retained durable create', async (testCase) => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: `writer-${testCase.kind}-create-edit`,
      writerEpoch: 6,
      databaseLineage: `lineage-${testCase.kind}-create-edit`,
      requestedWriterWasActive: true,
    })
    seedPresetDatabase(
      testCase.kind === 'model'
        ? {
            modelPresets: [makePreset('model-existing', 'Existing Model') as unknown as ModelPreset],
            modelPresetsId: 0,
          }
        : {
            promptPresets: [makePreset('prompt-existing', 'Existing Prompt') as unknown as PromptPreset],
            promptPresetsId: 0,
          },
    )
    setCachedServerCommandRevision(100)
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
      testCase.presetId as `${string}-${string}-${string}-${string}-${string}`,
    )

    const firstCreate = deferred<Response>()
    let createAttempts = 0
    let recover = false
    let revision = 100
    let serverPreset: Record<string, unknown> | null = null
    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ url, method, body })
        if (url === `/api/v1/commands${testCase.createPath}` && method === 'POST') {
          createAttempts += 1
          if (createAttempts === 1) return firstCreate.promise
          if (!recover) return jsonResponse({ error: 'create temporarily unavailable' }, 500)
          serverPreset = clonePlain(body.preset)
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: `${testCase.kind}Preset.created`,
              revision,
              resource: 'preset',
              id: testCase.presetId,
            },
            [`${testCase.kind}PresetId`]: testCase.presetId,
          })
        }
        if (url === `/api/v1/commands${testCase.updatePath}` && method === 'PATCH') {
          if (!recover) throw new Error(`${testCase.kind} edit overtook its retained create`)
          if (!serverPreset) return jsonResponse({ error: 'preset does not exist' }, 404)
          Object.assign(serverPreset, clonePlain(body.patch))
          revision += 1
          return jsonResponse({
            revision,
            event: {
              type: `${testCase.kind}Preset.updated`,
              revision,
              resource: 'preset',
              id: testCase.presetId,
            },
            [`${testCase.kind}PresetId`]: testCase.presetId,
          })
        }
        return jsonResponse({ error: `unexpected ${method} ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const initialPreset = makePreset(testCase.presetId, `${testCase.kind} initial`) as unknown as
        | ModelPreset
        | PromptPreset
      delete initialPreset.id
      if (testCase.kind === 'model') {
        createModelPreset(initialPreset as ModelPreset)
        updateModelPreset(1, { name: 'Renamed immediately' })
      } else {
        createPromptPreset(initialPreset as PromptPreset)
        updatePromptPreset(1, { name: 'Renamed immediately' })
      }
      flushPendingSplitPresetPatch(testCase.kind, testCase.presetId)

      const livePresets = testCase.kind === 'model' ? getDatabase().modelPresets : getDatabase().promptPresets
      expect(livePresets[1]).toMatchObject({ id: testCase.presetId, name: 'Renamed immediately' })
      await waitForState(() => expect(calls).toHaveLength(1))
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(2))

      firstCreate.resolve(jsonResponse({ error: 'create temporarily unavailable' }, 500))
      await waitForState(() => expect(calls).toHaveLength(2))
      expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST /api/v1/commands${testCase.createPath}`,
        `POST /api/v1/commands${testCase.createPath}`,
      ])

      const retained = await listPendingMutations()
      expect(retained.map((entry) => entry.handle.key)).toEqual([testCase.ownerKey, testCase.ownerKey])
      expect(retained[0]?.intent).toMatchObject({
        version: 1,
        requests: [
          {
            method: 'POST',
            path: testCase.createPath,
            body: {
              preset: {
                id: testCase.presetId,
                name: `${testCase.kind} initial`,
              },
            },
          },
        ],
      })
      expect(retained[1]?.intent).toEqual({
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: testCase.updatePath,
            body: { patch: { name: 'Renamed immediately' } },
          },
        ],
      })

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(calls.slice(recoveryStart).map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST /api/v1/commands${testCase.createPath}`,
        `PATCH /api/v1/commands${testCase.updatePath}`,
      ])
      expect(serverPreset).toMatchObject({ id: testCase.presetId, name: 'Renamed immediately' })
      expect(await listPendingMutations()).toEqual([])
    } finally {
      firstCreate.resolve(jsonResponse({ error: 'test cleanup' }, 500))
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('persists the exact split-preset PATCH before dispatch and binds it to the database lineage', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-split-preset',
      writerEpoch: 4,
      databaseLineage: 'lineage-split-preset',
      requestedWriterWasActive: true,
    })
    seedPresetDatabase({
      modelPresets: [makePreset('model-durable', 'Before', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
      temperature: 11,
    })
    setCachedServerCommandRevision(100)
    const calls: Array<CapturedFetch & { headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          headers: init.headers as Record<string, string>,
        })
        if (url === '/api/v1/commands/model-presets/model-durable') {
          return jsonResponse({
            revision: 101,
            event: { type: 'modelPreset.updated', revision: 101, resource: 'preset', id: 'model-durable' },
            modelPresetId: 'model-durable',
          })
        }
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      updateModelPreset(0, { name: 'Crash-safe', temperature: 22 })
      await vi.waitFor(async () => {
        expect((await listPendingMutations()).map((entry) => entry.intent)).toEqual([
          {
            version: 1,
            requests: [
              {
                method: 'PATCH',
                path: '/model-presets/model-durable',
                body: { patch: { name: 'Crash-safe', temperature: 22 } },
              },
            ],
          },
        ])
      })

      flushPendingSplitPresetPatch('model', 'model-durable')
      await waitForState(() => expect(calls.some((call) => call.url.endsWith('/mutation-receipts/ack'))).toBe(true))

      const command = calls.find((call) => call.url === '/api/v1/commands/model-presets/model-durable')
      expect(command?.headers['risu-mutation-id']).toMatch(/^[a-zA-Z0-9._:-]+$/)
      expect(command?.headers['risu-database-lineage']).toBe('lineage-split-preset')
      expect(command?.body).toEqual({
        baseRevision: 100,
        patch: { name: 'Crash-safe', temperature: 22 },
      })
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it.each([
    { kind: 'model' as const, revert: 'total' as const, mutationKey: 'split-preset:model:model-marker' },
    { kind: 'model' as const, revert: 'partial' as const, mutationKey: 'split-preset:model:model-marker' },
    { kind: 'prompt' as const, revert: 'total' as const, mutationKey: 'prompt-template-owner:prompt-marker' },
    { kind: 'prompt' as const, revert: 'partial' as const, mutationKey: 'prompt-template-owner:prompt-marker' },
  ])('keeps a marked $kind predecessor ahead of its $revert-revert absolute closure', async (testCase) => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: `writer-${testCase.kind}-${testCase.revert}-revert`,
      writerEpoch: 5,
      databaseLineage: `lineage-${testCase.kind}-${testCase.revert}-revert`,
      requestedWriterWasActive: true,
    })

    const presetId = `${testCase.kind}-marker`
    const baselineName = `${testCase.kind} baseline`
    const preset = {
      ...(makePreset(presetId, baselineName, { temperature: 11 }) as unknown as ModelPreset & PromptPreset),
      ...(testCase.kind === 'prompt' ? { overrideModelParameters: true } : {}),
    }
    seedPresetDatabase({
      ...(testCase.kind === 'model'
        ? {
            modelPresets: [preset as ModelPreset],
            modelPresetsId: 0,
          }
        : {
            promptPresets: [preset as PromptPreset],
            promptPresetsId: 0,
            promptTemplate: clonePlain(preset.promptTemplate),
          }),
      temperature: 11,
    })
    setCachedServerCommandRevision(100)

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    const firstResponse = deferred<Response>()
    const calls: CapturedFetch[] = []
    let revision = 100
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const commandUrl = `/api/v1/commands/${testCase.kind}-presets/${presetId}`
        if (url !== commandUrl) return jsonResponse({ error: `unexpected ${url}` }, 404)
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        revision += 1
        if (calls.length === 1) return firstResponse.promise
        return jsonResponse({
          revision,
          event: {
            type: `${testCase.kind}Preset.updated`,
            revision,
            resource: 'preset',
            id: presetId,
          },
          [`${testCase.kind}PresetId`]: presetId,
        })
      }) as unknown as typeof fetch,
    )

    const update = (patch: Partial<ModelPreset & PromptPreset>) => {
      if (testCase.kind === 'model') updateModelPreset(0, patch as Partial<ModelPreset>)
      else updatePromptPreset(0, patch as Partial<PromptPreset>)
    }

    try {
      update({ name: `${testCase.kind} predecessor`, temperature: 22 })
      let entries: Awaited<ReturnType<typeof listPendingMutations>> = []
      await vi.waitFor(async () => {
        entries = await listPendingMutations()
        expect(entries).toHaveLength(1)
      })
      const predecessor = entries[0]!
      await expect(beginPendingMutationDispatch(predecessor.handle)).resolves.toBe('persisted')

      const finalName = testCase.revert === 'total' ? baselineName : `${testCase.kind} final`
      const debouncesBeforeFinal = timeoutSpy.mock.calls.filter(([, delay]) => delay === 250).length
      update({ name: finalName, temperature: 11 })
      const debouncesAfterFinal = timeoutSpy.mock.calls.filter(([, delay]) => delay === 250).length
      expect(debouncesAfterFinal - debouncesBeforeFinal).toBe(testCase.revert === 'total' ? 0 : 1)
      if (testCase.revert === 'partial') flushPendingSplitPresetPatch(testCase.kind, presetId)

      await waitForState(() => expect(calls).toHaveLength(1))
      entries = await listPendingMutations()
      expect(entries.map((entry) => entry.handle.key)).toEqual([testCase.mutationKey, testCase.mutationKey])
      expect(entries[0]?.handle.mutationId).toBe(predecessor.handle.mutationId)
      expect(entries[1]?.handle.mutationId).not.toBe(predecessor.handle.mutationId)
      expect(entries.map((entry) => entry.intent.requests[0]?.body)).toEqual([
        { patch: { name: `${testCase.kind} predecessor`, temperature: 22 } },
        { patch: { name: finalName, temperature: 11 } },
      ])

      firstResponse.resolve(
        jsonResponse({
          revision: 101,
          event: {
            type: `${testCase.kind}Preset.updated`,
            revision: 101,
            resource: 'preset',
            id: presetId,
          },
          [`${testCase.kind}PresetId`]: presetId,
        }),
      )
      await waitForState(() => expect(calls).toHaveLength(2))
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))

      expect(calls.map((call) => call.body.patch)).toEqual([
        { name: `${testCase.kind} predecessor`, temperature: 22 },
        { name: finalName, temperature: 11 },
      ])
      const livePreset = testCase.kind === 'model' ? getDatabase().modelPresets[0] : getDatabase().promptPresets[0]
      expect(livePreset).toMatchObject({ name: finalName, temperature: 11 })
      expect(getDatabase().temperature).toBe(11)
    } finally {
      firstResponse.resolve(jsonResponse({ error: 'test cleanup' }, 500))
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('dispatches a baseline correction immediately and omits undefined values from patches', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha') as unknown as ModelPreset],
      modelPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    updateModelPreset(0, { name: 'Alph' })
    updateModelPreset(0, { name: 'Alpha' })
    updateModelPreset(0, {
      optionalUnsetField: undefined,
      temperature: undefined,
    } as unknown as Partial<ModelPreset>)

    const command = await waitForPresetCommand(calls, '/model-presets/model-a')

    expect(getDatabase().modelPresets[0].name).toBe('Alpha')
    expect(getDatabase().modelPresets[0].temperature).toBe(30)
    expect(getDatabase().modelPresets[0]).not.toHaveProperty('optionalUnsetField')
    expect(command.body.patch).toEqual({ name: 'Alpha' })
    expect(calls.filter((call) => call.url === '/api/v1/commands/model-presets/model-a')).toHaveLength(1)
  })

  it('drops a reverted projected field while retaining a metadata-only collection patch', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
      temperature: 11,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    updateModelPreset(0, { temperature: 22 })
    updateModelPreset(0, { temperature: 11, name: 'Alpha renamed' })
    flushPendingSplitPresetPatches()

    const command = await waitForPresetCommand(calls, '/model-presets/model-a')
    expect(command.body.patch).toEqual({ temperature: 11, name: 'Alpha renamed' })
    expect(getDatabase().temperature).toBe(11)
  })

  it('keeps unrelated owners on independent debounce timers', async () => {
    vi.useFakeTimers()
    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Alpha') as unknown as ModelPreset,
          makePreset('model-b', 'Beta') as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
      })
      setCachedServerCommandRevision(100)
      const calls = stubSuccessfulSplitPresetCommands()

      updateModelPreset(0, { name: 'Alpha queued' })
      await vi.advanceTimersByTimeAsync(100)
      updateModelPreset(1, { name: 'Beta queued' })

      await vi.advanceTimersByTimeAsync(150)
      expect(calls.map((call) => call.url)).toEqual(['/api/v1/commands/model-presets/model-a'])

      await vi.advanceTimersByTimeAsync(100)
      expect(calls.map((call) => call.url)).toEqual([
        '/api/v1/commands/model-presets/model-a',
        '/api/v1/commands/model-presets/model-b',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rolls a failed coalesced patch back to the first baseline field by field', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand(() => {
      getDatabase().modelPresets[0].temperature = 77
      getDatabase().temperature = 77
    })

    updateModelPreset(0, { name: 'Alph', temperature: 22 })
    updateModelPreset(0, { name: 'Alp', temperature: 33 })
    flushPendingSplitPresetPatches()

    const command = await waitForPresetCommand(calls, '/model-presets/model-a')
    expect(command.body.patch).toEqual({ name: 'Alp', temperature: 33 })
    await waitForState(() => {
      expect(getDatabase().modelPresets[0]).toMatchObject({ name: 'Alpha', temperature: 77 })
      expect(getDatabase().temperature).toBe(77)
    })
  })

  it('restores a selected preset projection when its deferred patch fails', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
      temperature: 11,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand()

    updateModelPreset(0, { temperature: 44 })
    expect(getDatabase().temperature).toBe(44)
    flushPendingSplitPresetPatches()

    await waitForPresetCommand(calls, '/model-presets/model-a')
    await waitForState(() => {
      expect(getDatabase().modelPresets[0].temperature).toBe(11)
      expect(getDatabase().temperature).toBe(11)
    })
  })

  it('does not roll a failed model projection over a newer prompt selection', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset],
      modelPresetsId: 0,
      promptPresets: [
        makePreset('prompt-a', 'Prompt A', { temperature: 11 }) as unknown as PromptPreset,
        {
          ...(makePreset('prompt-b', 'Prompt B', { temperature: 77 }) as unknown as PromptPreset),
          overrideModelParameters: true,
        },
      ],
      promptPresetsId: 0,
      temperature: 11,
    })
    setCachedServerCommandRevision(100)
    const calls = stubFailedPresetCommand(() => {
      getDatabase().promptPresetsId = 1
      applyPromptPresetFieldsToDatabase(getDatabase(), getDatabase().promptPresets[1])
    })

    updateModelPreset(0, { temperature: 44 })
    flushPendingSplitPresetPatches()

    await waitForPresetCommand(calls, '/model-presets/model-a')
    await waitForState(() => {
      expect(getDatabase().modelPresets[0].temperature).toBe(11)
      expect(getDatabase().promptPresetsId).toBe(1)
      expect(getDatabase().temperature).toBe(77)
    })
  })

  it('queues a pending owner patch before a structural selection command', async () => {
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Alpha') as unknown as ModelPreset,
        makePreset('model-b', 'Beta') as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
      promptPresets: [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset],
      promptPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    updateModelPreset(0, { name: 'Alpha before select' })
    updatePromptPreset(0, { name: 'Prompt before model select' })
    selectModelPreset(1)

    await waitForState(() => expect(calls).toHaveLength(3))
    expect(calls.map((call) => call.url)).toEqual([
      '/api/v1/commands/model-presets/model-a',
      '/api/v1/commands/prompt-presets/prompt-a',
      '/api/v1/commands/model-presets/select',
    ])
    expect(calls[0].body.patch).toEqual({ name: 'Alpha before select' })
    expect(calls[1].body.patch).toEqual({ name: 'Prompt before model select' })
  })

  it('drains a retained settings projection before selecting a model preset', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-select-settings',
      writerEpoch: 3,
      databaseLineage: 'lineage-model-select-settings',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Model A', { proxyRequestModel: 'proxy-a' }) as unknown as ModelPreset,
          makePreset('model-b', 'Model B', { proxyRequestModel: 'proxy-b' }) as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
        proxyRequestModel: 'proxy-a',
      })
      setCachedServerCommandRevision(100)
      const predecessorIntent: DurableMutationIntent = {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/model',
            body: { patch: { proxyRequestModel: 'proxy-a-latest' } },
          },
        ],
      }
      const predecessor = stagePendingMutation(SETTINGS_BRIDGE_MUTATION_KEY, predecessorIntent)
      await predecessor.ready

      let revision = 100
      const calls: Array<CapturedFetch & { mutationId: string | null }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const headers = init.headers as Record<string, string> | undefined
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({
            url,
            method: init.method ?? 'GET',
            body,
            mutationId: headers?.['risu-mutation-id'] ?? null,
          })
          revision += 1
          if (url === '/api/v1/commands/settings/model') {
            return jsonResponse({
              revision,
              event: { type: 'settings.updated', revision, resource: 'settings', id: 'model' },
            })
          }
          if (url === '/api/v1/commands/model-presets/select') {
            return jsonResponse({
              revision,
              event: { type: 'modelPreset.selected', revision, resource: 'preset', id: 'model-b' },
              modelPresetId: 'model-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      selectModelPreset(1)

      await waitForState(() => expect(calls).toHaveLength(2))
      expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        'PATCH /api/v1/commands/settings/model',
        'POST /api/v1/commands/model-presets/select',
      ])
      expect(calls.map(({ body }) => body)).toEqual([
        { baseRevision: 100, patch: { proxyRequestModel: 'proxy-a-latest' } },
        { baseRevision: 101, modelPresetId: 'model-b' },
      ])
      expect(new Set(calls.map(({ mutationId }) => mutationId)).size).toBe(2)
      expect(getDatabase().modelPresetsId).toBe(1)
      expect(getDatabase().proxyRequestModel).toBe('proxy-b')
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('drains retained legacy settings before save-current selection applies the target preset', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-legacy-select-settings',
      writerEpoch: 4,
      databaseLineage: 'lineage-legacy-select-settings',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase()
      setCachedServerCommandRevision(200)
      const predecessorIntent: DurableMutationIntent = {
        version: 1,
        requests: [
          {
            method: 'PATCH',
            path: '/settings/model',
            body: { patch: { temperature: 77 } },
          },
        ],
      }
      const predecessor = stagePendingMutation(SETTINGS_BRIDGE_MUTATION_KEY, predecessorIntent)
      await predecessor.ready

      let revision = 200
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({ url, method: init.method ?? 'GET', body })
          revision += 1
          if (url === '/api/v1/commands/settings/model') {
            return jsonResponse({
              revision,
              event: { type: 'settings.updated', revision, resource: 'settings', id: 'model' },
            })
          }
          if (url === '/api/v1/commands/presets/select') {
            return jsonResponse({
              revision,
              event: { type: 'preset.selected', revision, resource: 'preset', id: 'preset-b' },
              presetId: 'preset-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      changeToPreset(1, true)

      await waitForState(() => expect(calls).toHaveLength(2))
      expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        'PATCH /api/v1/commands/settings/model',
        'POST /api/v1/commands/presets/select',
      ])
      expect(calls[1].body).toEqual({
        baseRevision: 201,
        presetId: 'preset-b',
        apply: true,
        saveCurrent: true,
      })
      expect(getDatabase().botPresetsId).toBe(1)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('flushes a pending prompt row edit before switching owners and preserves the edited owner', async () => {
    resetPromptTemplateHydration()
    resetPromptTemplateSelectionDirtyState()
    try {
      const promptA = makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset
      const promptB = makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset
      const previousItem = clonePlain(promptA.promptTemplate[0])
      let draftItems = clonePlain(promptA.promptTemplate)
      ;(draftItems[0] as { text?: string }).text = 'Prompt A edited before switch'
      seedPresetDatabase({
        promptPresets: [promptA, promptB],
        promptPresetsId: 0,
        promptTemplate: clonePlain(promptA.promptTemplate),
      })
      withTestDatabaseWrite(() => {
        getDatabase().promptPresets[0].promptTemplate = clonePlain(draftItems)
      })
      markPromptTemplateProjectionApplied('prompt-a', 100)
      setCachedServerCommandRevision(100)

      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({ url, method: init.method ?? 'GET', body })
          if (url === '/api/v1/commands/prompt-items/prompt-a-prompt') {
            return jsonResponse({
              revision: 101,
              event: {
                type: 'prompt.item.updated',
                revision: 101,
                resource: 'promptItem',
                id: 'prompt-a-prompt',
                parentId: 'prompt-a',
              },
              itemId: 'prompt-a-prompt',
            })
          }
          if (url === '/api/v1/commands/prompt-presets/select') {
            return jsonResponse({
              revision: 102,
              event: {
                type: 'promptPreset.selected',
                revision: 102,
                resource: 'preset',
                id: 'prompt-b',
              },
              promptPresetId: 'prompt-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      let reconciledEffects: ReadonlyMap<number, ServerCommandLocalEffect> | null = null
      setServerCommandSuccessReconciler((_event, _events, localEffects) => {
        reconciledEffects = new Map(localEffects)
      })

      queuePromptItemProjectionUpdate(
        {
          getItems: () => draftItems,
          setItems: (items) => {
            draftItems = items
          },
        },
        'prompt-a-prompt',
        previousItem,
        60_000,
        'prompt-a',
      )
      selectPromptPreset(1)

      await waitForState(() => expect(calls).toHaveLength(2))
      expect(calls.map((call) => call.url)).toEqual([
        '/api/v1/commands/prompt-items/prompt-a-prompt',
        '/api/v1/commands/prompt-presets/select',
      ])
      expect(calls[0].body).toMatchObject({
        baseRevision: 100,
        promptPresetId: 'prompt-a',
        patch: { text: 'Prompt A edited before switch' },
      })
      expect(calls[1].body).toMatchObject({ baseRevision: 101, promptPresetId: 'prompt-b' })
      await waitForState(() => expect(reconciledEffects).not.toBeNull())
      expect(reconciledEffects?.get(101)).toMatchObject({
        kind: 'promptItemMutation',
        operation: 'update',
        promptPresetId: 'prompt-a',
        itemId: 'prompt-a-prompt',
        ownerState: {
          enabled: true,
          items: [expect.objectContaining({ id: 'prompt-a-prompt', text: 'Prompt A edited before switch' })],
        },
      })
      expect(getDatabase().promptPresetsId).toBe(1)
      expect(getDatabase().promptPresets[0].promptTemplate[0]).toMatchObject({
        id: 'prompt-a-prompt',
        text: 'Prompt A edited before switch',
      })
      expect(getDatabase().promptTemplate).toEqual(promptB.promptTemplate)
    } finally {
      resetPromptTemplateSelectionDirtyState()
      resetPromptTemplateHydration()
    }
  })

  it('retains prompt selection behind a transient flushed edit from the outgoing owner', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-prompt-select-owner-order',
      writerEpoch: 5,
      databaseLineage: 'lineage-prompt-select-owner-order',
      requestedWriterWasActive: true,
    })
    resetPromptTemplateHydration()
    resetPromptTemplateSelectionDirtyState()

    try {
      const promptA = makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset
      const promptB = makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset
      const previousItem = clonePlain(promptA.promptTemplate[0])
      let draftItems = clonePlain(promptA.promptTemplate)
      ;(draftItems[0] as { text?: string }).text = 'Prompt A retained edit'
      seedPresetDatabase({
        promptPresets: [promptA, promptB],
        promptPresetsId: 0,
        promptTemplate: clonePlain(promptA.promptTemplate),
      })
      markPromptTemplateProjectionApplied('prompt-a', 100)
      setCachedServerCommandRevision(100)

      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({ url, method: init.method ?? 'GET', body })
          if (url === '/api/v1/commands/prompt-items/prompt-a-prompt') {
            if (!recover) return jsonResponse({ error: 'prompt row temporarily unavailable' }, 500)
            revision += 1
            return jsonResponse({
              revision,
              event: {
                type: 'prompt.item.updated',
                revision,
                resource: 'promptItem',
                id: 'prompt-a-prompt',
                parentId: 'prompt-a',
              },
              itemId: 'prompt-a-prompt',
            })
          }
          if (url === '/api/v1/commands/prompt-presets/select') {
            revision += 1
            return jsonResponse({
              revision,
              event: {
                type: 'promptPreset.selected',
                revision,
                resource: 'preset',
                id: 'prompt-b',
              },
              promptPresetId: 'prompt-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      queuePromptItemProjectionUpdate(
        {
          getItems: () => draftItems,
          setItems: (items) => {
            draftItems = items
          },
        },
        'prompt-a-prompt',
        previousItem,
        60_000,
        'prompt-a',
      )
      selectPromptPreset(1)

      await waitForState(() => {
        expect(calls.filter((call) => call.url.includes('/prompt-items/'))).toHaveLength(2)
      })
      expect(calls.some((call) => call.url === '/api/v1/commands/prompt-presets/select')).toBe(false)
      expect((await listPendingMutations()).map((entry) => ({ key: entry.handle.key, intent: entry.intent }))).toEqual([
        {
          key: 'prompt-template-owner:prompt-a',
          intent: {
            version: 1,
            requests: [
              {
                method: 'PATCH',
                path: '/prompt-items/prompt-a-prompt',
                body: { promptPresetId: 'prompt-a', patch: { text: 'Prompt A retained edit' } },
              },
            ],
          },
        },
        {
          key: SETTINGS_BRIDGE_MUTATION_KEY,
          intent: {
            version: 1,
            dependencyKeys: ['preset-operations', 'prompt-template-owner:prompt-a', 'prompt-template-owner:prompt-b'],
            requests: [
              {
                method: 'POST',
                path: '/prompt-presets/select',
                body: { promptPresetId: 'prompt-b' },
              },
            ],
          },
        },
      ])
      // The selection has its own durable successor row, so it stays visible
      // while the outgoing prompt edit remains retryable.
      expect(getDatabase().promptPresetsId).toBe(1)

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(calls.slice(recoveryStart).map(({ method, url }) => `${method} ${url}`)).toEqual([
        'PATCH /api/v1/commands/prompt-items/prompt-a-prompt',
        'POST /api/v1/commands/prompt-presets/select',
      ])
      expect(await listPendingMutations()).toEqual([])
    } finally {
      resetPromptTemplateSelectionDirtyState()
      resetPromptTemplateHydration()
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps model-preset DELETE behind a transient row PATCH and replays both in order', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-delete-order',
      writerEpoch: 2,
      databaseLineage: 'lineage-model-delete-order',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Model A', { temperature: 11 }) as unknown as ModelPreset,
          makePreset('model-b', 'Model B', { temperature: 22 }) as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
        temperature: 11,
      })
      setCachedServerCommandRevision(100)

      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          const method = init.method ?? 'GET'
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url !== '/api/v1/commands/model-presets/model-a') {
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }
          calls.push({
            url,
            method,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          if (!recover) return jsonResponse({ error: 'model preset temporarily unavailable' }, 500)
          revision += 1
          if (method === 'PATCH') {
            return jsonResponse({
              revision,
              event: { type: 'modelPreset.updated', revision, resource: 'preset', id: 'model-a' },
              modelPresetId: 'model-a',
            })
          }
          return jsonResponse({
            revision,
            event: { type: 'modelPreset.deleted', revision, resource: 'preset', id: 'model-a' },
            modelPresetId: 'model-a',
            selectedModelPresetId: 'model-b',
          })
        }) as unknown as typeof fetch,
      )

      updateModelPreset(0, { name: 'Model A edited before delete', temperature: 44 })
      deleteModelPreset(0, 1)

      await waitForState(() => {
        expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2)
      })
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
      expect(
        (await listPendingMutations()).map((entry) => ({ key: entry.handle.key, request: entry.intent.requests[0] })),
      ).toEqual([
        {
          key: 'split-preset:model:model-a',
          request: {
            method: 'PATCH',
            path: '/model-presets/model-a',
            body: { patch: { name: 'Model A edited before delete', temperature: 44 } },
          },
        },
        {
          key: 'settings:bridge',
          request: {
            method: 'DELETE',
            path: '/model-presets/model-a',
            body: { modelPresetId: 'model-b' },
          },
        },
      ])

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })

      expect(calls.slice(recoveryStart).map((call) => `${call.method} ${call.url}`)).toEqual([
        'PATCH /api/v1/commands/model-presets/model-a',
        'DELETE /api/v1/commands/model-presets/model-a',
      ])
      expect(await listPendingMutations()).toEqual([])
      // Both exact rows were accepted in order, so the newer deletion remains
      // the visible projection until authoritative hydration confirms it.
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-b'])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps a later model selection behind a retained delete so the latest target wins', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-delete-select',
      writerEpoch: 5,
      databaseLineage: 'lineage-model-delete-select',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Model A') as unknown as ModelPreset,
          makePreset('model-b', 'Model B') as unknown as ModelPreset,
          makePreset('model-c', 'Model C') as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
      })
      setCachedServerCommandRevision(300)

      let recover = false
      let revision = 300
      const calls: Array<{ method: string; url: string; body: Record<string, unknown>; mutationId: string | null }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const method = init.method ?? 'GET'
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          const headers = init.headers as Record<string, string> | undefined
          calls.push({ method, url, body, mutationId: headers?.['risu-mutation-id'] ?? null })
          if (!recover) return jsonResponse({ error: 'temporarily unavailable' }, 500)
          revision += 1
          if (method === 'DELETE') {
            return jsonResponse({
              revision,
              event: { type: 'modelPreset.deleted', revision, resource: 'preset', id: 'model-a' },
              modelPresetId: 'model-a',
              selectedModelPresetId: 'model-b',
            })
          }
          return jsonResponse({
            revision,
            event: { type: 'modelPreset.selected', revision, resource: 'preset', id: 'model-c' },
            modelPresetId: 'model-c',
          })
        }) as unknown as typeof fetch,
      )

      deleteModelPreset(0, 1)
      selectModelPreset(1)

      await waitForState(() => expect(calls).toHaveLength(2))
      expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        'DELETE /api/v1/commands/model-presets/model-a',
        'DELETE /api/v1/commands/model-presets/model-a',
      ])
      expect((await listPendingMutations()).map((entry) => entry.handle.key)).toEqual([
        SETTINGS_BRIDGE_MUTATION_KEY,
        SETTINGS_BRIDGE_MUTATION_KEY,
      ])

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(calls.slice(recoveryStart).map(({ method, url }) => `${method} ${url}`)).toEqual([
        'DELETE /api/v1/commands/model-presets/model-a',
        'POST /api/v1/commands/model-presets/select',
      ])
      expect(calls.at(-1)?.body).toMatchObject({ modelPresetId: 'model-c' })
      expect(new Set(calls.slice(recoveryStart).map(({ mutationId }) => mutationId)).size).toBe(2)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('retains the optimistic model deletion and selection when its durable delete is retryable', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-delete-rollback',
      writerEpoch: 3,
      databaseLineage: 'lineage-model-delete-rollback',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Model A', { temperature: 11 }) as unknown as ModelPreset,
          makePreset('model-b', 'Model B', { temperature: 22 }) as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
        temperature: 11,
      })
      setCachedServerCommandRevision(100)
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          const method = init.method ?? 'GET'
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push({
            url,
            method,
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          if (method === 'DELETE') return jsonResponse({ error: 'forced model delete failure' }, 500)
          return jsonResponse({
            revision: 101,
            event: { type: 'modelPreset.updated', revision: 101, resource: 'preset', id: 'model-a' },
            modelPresetId: 'model-a',
          })
        }) as unknown as typeof fetch,
      )

      updateModelPreset(0, { name: 'Model A latest optimistic', temperature: 44 })
      deleteModelPreset(0, 1)

      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-b'])
      expect(getDatabase().temperature).toBe(22)
      await waitForState(() => {
        expect(calls.map((call) => call.method)).toEqual(['PATCH', 'DELETE'])
      })

      expect(getDatabase().modelPresetsId).toBe(0)
      expect(getDatabase().modelPresets[0]).toMatchObject({
        id: 'model-b',
        name: 'Model B',
        temperature: 22,
      })
      expect(getDatabase().temperature).toBe(22)
      expect((await listPendingMutations()).map((entry) => entry.intent.requests[0]?.method)).toEqual(['DELETE'])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rehomes model references immediately and restores them when model deletion fails', async () => {
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Model A') as unknown as ModelPreset,
        makePreset('model-b', 'Model B') as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
      promptPresets: [
        {
          ...(makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset),
          recommendedModelPresetId: 'model-a',
        },
      ],
      promptPresetsId: 0,
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            {
              id: 'chat-a',
              message: [],
              generationSettings: {
                configured: true,
                modelPresetId: 'model-a',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        } as any,
      ],
      loadouts: [
        {
          id: 'loadout-a',
          name: 'Loadout A',
          lastUsed: 0,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          modelPresetId: 'model-a',
          modelPresetName: 'Model A',
          promptPresetId: '',
          promptPresetName: '',
          personaId: '',
        },
      ],
    })
    const calls = stubFailedPresetCommand()

    deleteModelPreset(0, 1)

    expect(getDatabase().characters[0].chats[0].generationSettings?.modelPresetId).toBe('model-b')
    expect(getDatabase().loadouts[0]).toMatchObject({ modelPresetId: 'model-b', modelPresetName: 'Model B' })
    expect(getDatabase().promptPresets[0].recommendedModelPresetId).toBeNull()

    await waitForPresetCommand(calls, '/model-presets/model-a')
    await waitForState(() => {
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-b'])
      expect(getDatabase().characters[0].chats[0].generationSettings?.modelPresetId).toBe('model-a')
      expect(getDatabase().loadouts[0]).toMatchObject({ modelPresetId: 'model-a', modelPresetName: 'Model A' })
      expect(getDatabase().promptPresets[0].recommendedModelPresetId).toBe('model-a')
    })
  })

  it('rehomes prompt references immediately and restores them when prompt deletion fails', async () => {
    seedPresetDatabase({
      promptPresets: [
        makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
        makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
      ],
      promptPresetsId: 0,
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            {
              id: 'chat-a',
              message: [],
              generationSettings: {
                configured: true,
                promptPresetId: 'prompt-a',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        } as any,
      ],
      loadouts: [
        {
          id: 'loadout-a',
          name: 'Loadout A',
          lastUsed: 0,
          favorite: false,
          characterIds: [],
          modules: [],
          globalVariables: {},
          presetName: '',
          modelPresetId: '',
          modelPresetName: '',
          promptPresetId: 'prompt-a',
          promptPresetName: 'Prompt A',
          personaId: '',
        },
      ],
    })
    const calls = stubFailedPresetCommand()

    deletePromptPreset(0, 1)

    expect(getDatabase().characters[0].chats[0].generationSettings?.promptPresetId).toBe('prompt-b')
    expect(getDatabase().loadouts[0]).toMatchObject({ promptPresetId: 'prompt-b', promptPresetName: 'Prompt B' })

    await waitForPresetCommand(calls, '/prompt-presets/prompt-a')
    await waitForState(() => {
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-b'])
      expect(getDatabase().characters[0].chats[0].generationSettings?.promptPresetId).toBe('prompt-a')
      expect(getDatabase().loadouts[0]).toMatchObject({ promptPresetId: 'prompt-a', promptPresetName: 'Prompt A' })
    })
  })

  it('keeps prompt-preset DELETE behind a transient row PATCH and replays both in order', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-prompt-delete',
      writerEpoch: 2,
      databaseLineage: 'lineage-prompt-delete',
      requestedWriterWasActive: true,
    })
    resetPromptTemplateHydration()
    resetPromptTemplateSelectionDirtyState()

    try {
      const promptA = makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset
      const promptB = makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset
      const previousItem = clonePlain(promptA.promptTemplate[0])
      let draftItems = clonePlain(promptA.promptTemplate)
      ;(draftItems[0] as { text?: string }).text = 'Edited immediately before delete'
      seedPresetDatabase({
        promptPresets: [promptA, promptB],
        promptPresetsId: 0,
        promptTemplate: clonePlain(promptA.promptTemplate),
      })
      withTestDatabaseWrite(() => {
        getDatabase().promptPresets[0].promptTemplate = clonePlain(draftItems)
      })
      markPromptTemplateProjectionApplied('prompt-a', 100)
      setCachedServerCommandRevision(100)

      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
          calls.push({ url, method: init.method ?? 'GET', body })
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          if (url === '/api/v1/commands/prompt-items/prompt-a-prompt') {
            if (!recover) return jsonResponse({ error: 'row temporarily unavailable' }, 500)
            revision += 1
            return jsonResponse({
              revision,
              event: {
                type: 'prompt.item.updated',
                revision,
                resource: 'promptItem',
                id: 'prompt-a-prompt',
                parentId: 'prompt-a',
              },
              itemId: 'prompt-a-prompt',
            })
          }
          if (url === '/api/v1/commands/prompt-presets/prompt-a') {
            if (!recover) throw new Error('Prompt preset mutation overtook its row predecessor')
            revision += 1
            if ((init.method ?? 'GET') === 'PATCH') {
              return jsonResponse({
                revision,
                event: {
                  type: 'promptPreset.updated',
                  revision,
                  resource: 'preset',
                  id: 'prompt-a',
                },
                promptPresetId: 'prompt-a',
              })
            }
            return jsonResponse({
              revision,
              event: {
                type: 'promptPreset.deleted',
                revision,
                resource: 'preset',
                id: 'prompt-a',
              },
              promptPresetId: 'prompt-a',
              selectedPromptPresetId: 'prompt-b',
            })
          }
          return jsonResponse({ error: `unexpected ${url}` }, 404)
        }) as unknown as typeof fetch,
      )

      queuePromptItemProjectionUpdate(
        {
          getItems: () => draftItems,
          setItems: (items) => {
            draftItems = items
          },
        },
        'prompt-a-prompt',
        previousItem,
        60_000,
        'prompt-a',
      )
      updatePromptPreset(0, { name: 'Prompt A edited before delete' })
      deletePromptPreset(0)

      await waitForState(() => {
        expect(calls.filter((call) => call.url.includes('/prompt-items/'))).toHaveLength(3)
      })
      expect(calls.some((call) => call.url === '/api/v1/commands/prompt-presets/prompt-a')).toBe(false)
      expect(
        (await listPendingMutations()).map((entry) => ({ key: entry.handle.key, request: entry.intent.requests[0] })),
      ).toEqual([
        {
          key: 'prompt-template-owner:prompt-a',
          request: {
            method: 'PATCH',
            path: '/prompt-items/prompt-a-prompt',
            body: { promptPresetId: 'prompt-a', patch: { text: 'Edited immediately before delete' } },
          },
        },
        {
          key: 'prompt-template-owner:prompt-a',
          request: {
            method: 'PATCH',
            path: '/prompt-presets/prompt-a',
            body: { patch: { name: 'Prompt A edited before delete' } },
          },
        },
        {
          key: 'settings:bridge',
          request: {
            method: 'DELETE',
            path: '/prompt-presets/prompt-a',
            body: { promptPresetId: 'prompt-b' },
          },
        },
      ])

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 3 })

      expect(
        calls
          .slice(recoveryStart)
          .filter((call) => call.url.includes('/prompt-items/') || call.url.includes('/prompt-presets/'))
          .map((call) => `${call.method} ${call.url}`),
      ).toEqual([
        'PATCH /api/v1/commands/prompt-items/prompt-a-prompt',
        'PATCH /api/v1/commands/prompt-presets/prompt-a',
        'DELETE /api/v1/commands/prompt-presets/prompt-a',
      ])
      expect(await listPendingMutations()).toEqual([])
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-b'])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
      resetPromptTemplateSelectionDirtyState()
      resetPromptTemplateHydration()
    }
  })

  it('flushes pending split-preset patches through the central registry with keepalive', async () => {
    seedPresetDatabase({
      promptPresets: [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset],
      promptPresetsId: 0,
    })
    setCachedServerCommandRevision(100)
    const calls = stubSuccessfulSplitPresetCommands()

    updatePromptPreset(0, { name: 'Prompt before pagehide' })
    flushRegisteredPendingOwnerMutations({ keepalive: true })

    const command = await waitForPresetCommand(calls, '/prompt-presets/prompt-a')
    expect(command.body.patch).toEqual({ name: 'Prompt before pagehide' })
    expect(command.keepalive).toBe(true)
  })

  it('rebases a later same-owner rollback after an unsettled earlier patch fails', async () => {
    vi.useFakeTimers()
    try {
      seedPresetDatabase({
        modelPresets: [makePreset('model-a', 'Alpha', { temperature: 30 }) as unknown as ModelPreset],
        modelPresetsId: 0,
        temperature: 30,
      })
      setCachedServerCommandRevision(100)
      const firstResponse = deferred<Response>()
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          calls.push({
            url: String(input),
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          if (calls.length === 1) return firstResponse.promise
          return jsonResponse({ error: 'forced second patch failure' }, 500)
        }) as unknown as typeof fetch,
      )

      updateModelPreset(0, { temperature: 40 })
      await vi.advanceTimersByTimeAsync(250)
      expect(calls).toHaveLength(1)

      updateModelPreset(0, { temperature: 30 })
      await vi.advanceTimersByTimeAsync(250)
      expect(calls).toHaveLength(1)

      firstResponse.resolve(jsonResponse({ error: 'forced first patch failure' }, 500))
      await vi.runAllTimersAsync()
      for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) {
        await Promise.resolve()
      }

      expect(calls).toHaveLength(2)
      expect(getDatabase().modelPresets[0].temperature).toBe(30)
      expect(getDatabase().temperature).toBe(30)
    } finally {
      vi.useRealTimers()
    }
  })

  it('immediately preserves a change away and back to an in-flight attempt when its predecessor fails', async () => {
    vi.useFakeTimers()
    try {
      seedPresetDatabase({
        modelPresets: [makePreset('model-a', 'Alpha', { temperature: 30 }) as unknown as ModelPreset],
        modelPresetsId: 0,
        temperature: 30,
      })
      setCachedServerCommandRevision(100)
      const firstResponse = deferred<Response>()
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          calls.push({
            url: String(input),
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          if (calls.length === 1) return firstResponse.promise
          return jsonResponse({ error: 'forced correction failure' }, 500)
        }) as unknown as typeof fetch,
      )

      updateModelPreset(0, { temperature: 40 })
      await vi.advanceTimersByTimeAsync(250)
      expect(calls).toHaveLength(1)

      updateModelPreset(0, { temperature: 50 })
      expect(vi.getTimerCount()).toBe(1)
      updateModelPreset(0, { temperature: 40 })

      expect(vi.getTimerCount()).toBe(0)
      expect(calls).toHaveLength(1)
      firstResponse.resolve(jsonResponse({ error: 'forced predecessor failure' }, 500))
      for (let attempt = 0; attempt < 20 && calls.length < 2; attempt += 1) {
        await Promise.resolve()
      }

      expect(calls).toHaveLength(2)
      expect(calls[1]?.body.patch).toEqual({ temperature: 40 })
      expect(getDatabase().modelPresets[0].temperature).toBe(30)
      expect(getDatabase().temperature).toBe(30)
    } finally {
      vi.useRealTimers()
    }
  })

  it('failed prompt create removes only the unchanged attempted row and preserves split siblings', async () => {
    seedPresetDatabase({
      modelPresets: [makePreset('model-a', 'Model A') as unknown as ModelPreset],
      modelPresetsId: 0,
      promptPresets: [
        makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
        makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
      ],
      promptPresetsId: 0,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().modelPresets[0] = {
        ...getDatabase().modelPresets[0],
        name: 'Model A edited after dispatch',
      }
      getDatabase().promptPresets[1] = {
        ...getDatabase().promptPresets[1],
        name: 'Prompt B edited after dispatch',
      }
    })

    createPromptPreset(makePreset('prompt-created', 'Prompt Created') as unknown as PromptPreset)

    expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-b', 'prompt-created'])
    await waitForPresetCommand(calls, '/prompt-presets')
    await waitForState(() => {
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-b'])
      expect(getDatabase().promptPresets[1]).toMatchObject({ name: 'Prompt B edited after dispatch' })
      expect(getDatabase().modelPresets).toEqual([
        expect.objectContaining({ id: 'model-a', name: 'Model A edited after dispatch' }),
      ])
    })
  })

  it('failed prompt create keeps the attempted row when it changed after dispatch', async () => {
    seedPresetDatabase({
      promptPresets: [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset],
      promptPresetsId: 0,
    })
    let createdId: string | undefined
    const calls = stubFailedPresetCommand(() => {
      const created = getDatabase().promptPresets.find((preset) => preset.name === 'Prompt Created')
      createdId = created?.id
      if (created) {
        created.name = 'Prompt Created edited after dispatch'
      }
    })

    createPromptPreset(makePreset('prompt-created', 'Prompt Created') as unknown as PromptPreset)

    await waitForPresetCommand(calls, '/prompt-presets')
    await waitForState(() => {
      expect(createdId).toBe('prompt-created')
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-created'])
      expect(getDatabase().promptPresets[1]).toMatchObject({ name: 'Prompt Created edited after dispatch' })
    })
  })

  it('failed model delete reinserts only missing rows and skips a newer same-id row', async () => {
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Model A') as unknown as ModelPreset,
        makePreset('model-b', 'Model B') as unknown as ModelPreset,
        makePreset('model-c', 'Model C') as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().modelPresets[0] = {
        ...getDatabase().modelPresets[0],
        name: 'Model A edited after dispatch',
      }
      getDatabase().modelPresets.push(
        makePreset('model-d', 'Model D appended after dispatch') as unknown as ModelPreset,
      )
    })

    deleteModelPreset(1, 0)

    expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-c'])
    await waitForPresetCommand(calls, '/model-presets/model-b')
    await waitForState(() => {
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual([
        'model-a',
        'model-b',
        'model-c',
        'model-d',
      ])
      expect(getDatabase().modelPresets[0]).toMatchObject({ name: 'Model A edited after dispatch' })
      expect(getDatabase().modelPresets[1]).toMatchObject({ name: 'Model B' })
      expect(getDatabase().modelPresets[3]).toMatchObject({ name: 'Model D appended after dispatch' })
    })

    clearCachedServerCommandRevision()
    vi.unstubAllGlobals()
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Model A') as unknown as ModelPreset,
        makePreset('model-b', 'Model B') as unknown as ModelPreset,
        makePreset('model-c', 'Model C') as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
    })
    const secondCalls = stubFailedPresetCommand(() => {
      getDatabase().modelPresets.push(makePreset('model-b', 'Model B newer same id') as unknown as ModelPreset)
    })

    deleteModelPreset(1, 0)

    await waitForPresetCommand(secondCalls, '/model-presets/model-b')
    await waitForState(() => {
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-c', 'model-b'])
      expect(getDatabase().modelPresets[2]).toMatchObject({ name: 'Model B newer same id' })
    })
  })

  it('captures client-only legacy/model reorder proofs from the optimistic projection', async () => {
    seedPresetDatabase({
      botPresets: [makePreset('preset-a', 'A'), makePreset('preset-b', 'B'), makePreset('preset-c', 'C')],
      botPresetsId: 1,
      modelPresets: [
        makePreset('model-a', 'Model A') as unknown as ModelPreset,
        makePreset('model-b', 'Model B') as unknown as ModelPreset,
        makePreset('model-c', 'Model C') as unknown as ModelPreset,
        makePreset('model-d', 'Model D') as unknown as ModelPreset,
      ],
      modelPresetsId: 1,
    })
    setCachedServerCommandRevision(100)
    const calls: CapturedFetch[] = []
    let revision = 100
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const call = {
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        }
        calls.push(call)
        revision += 1
        if (url.endsWith('/presets/reorder')) {
          return jsonResponse({
            revision,
            event: {
              type: 'preset.reordered',
              revision,
              resource: 'presetCollectionWithPointer',
            },
            presetReorderCertificate: 'preset-reorder-v1',
            presetKind: 'legacy',
            presetIds: ['preset-b', 'preset-c', 'preset-a'],
            selectedPresetId: 'preset-b',
            settingsWritten: true,
          })
        }
        if (url.endsWith('/model-presets/reorder')) {
          return jsonResponse({
            revision,
            event: { type: 'modelPreset.reordered', revision, resource: 'modelPreset' },
            presetReorderCertificate: 'preset-reorder-v1',
            presetKind: 'model',
            presetIds: ['model-a', 'model-b', 'model-d', 'model-c'],
            selectedModelPresetId: 'model-b',
            settingsWritten: false,
          })
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    reorderPresets(0, 3)
    await waitForState(() => expect(observedEffects).toHaveLength(1))
    reorderModelPresets(2, 4)
    await waitForState(() => expect(observedEffects).toHaveLength(2))

    expect(observedEffects).toEqual([
      {
        kind: 'presetReorder',
        presetKind: 'legacy',
        collectionProjectionEpoch: expect.any(Number),
        settingsProjectionEpoch: expect.any(Number),
        presetIds: ['preset-b', 'preset-c', 'preset-a'],
        selectedPresetId: 'preset-b',
        settingsWritten: true,
      },
      {
        kind: 'presetReorder',
        presetKind: 'model',
        collectionProjectionEpoch: expect.any(Number),
        settingsProjectionEpoch: expect.any(Number),
        presetIds: ['model-a', 'model-b', 'model-d', 'model-c'],
        selectedPresetId: 'model-b',
        settingsWritten: false,
      },
    ])
    expect(calls.map((call) => call.body)).toEqual([
      { baseRevision: 100, presetIds: ['preset-b', 'preset-c', 'preset-a'] },
      { baseRevision: 101, modelPresetIds: ['model-a', 'model-b', 'model-d', 'model-c'] },
    ])
  })

  it('taints collection and full settings before rolling back a failed model reorder', async () => {
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Model A') as unknown as ModelPreset,
        makePreset('model-b', 'Model B') as unknown as ModelPreset,
        makePreset('model-c', 'Model C') as unknown as ModelPreset,
      ],
      modelPresetsId: 1,
    })
    const calls = stubFailedPresetCommand()

    expect(isCollectionAcknowledgementTainted('modelPresets')).toBe(false)
    expect(isSettingsAcknowledgementTainted()).toBe(false)
    reorderModelPresets(0, 3)

    await waitForPresetCommand(calls, '/model-presets/reorder')
    await waitForState(() => {
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-a', 'model-b', 'model-c'])
      expect(getDatabase().modelPresetsId).toBe(1)
      expect(isCollectionAcknowledgementTainted('modelPresets')).toBe(true)
      expect(isSettingsAcknowledgementTainted()).toBe(true)
    })
  })

  it('failed prompt reorder restores only the prior id order and preserves row edits', async () => {
    seedPresetDatabase({
      promptPresets: [
        makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
        makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
        makePreset('prompt-c', 'Prompt C') as unknown as PromptPreset,
      ],
      promptPresetsId: 1,
    })
    const calls = stubFailedPresetCommand(() => {
      const promptC = getDatabase().promptPresets.find((preset) => preset.id === 'prompt-c')
      if (promptC) {
        promptC.name = 'Prompt C edited after dispatch'
      }
    })

    reorderPromptPresets(0, 3)

    expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-b', 'prompt-c', 'prompt-a'])
    expect(getDatabase().promptPresetsId).toBe(0)
    await waitForPresetCommand(calls, '/prompt-presets/reorder')
    await waitForState(() => {
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-b', 'prompt-c'])
      expect(getDatabase().promptPresets[2]).toMatchObject({ name: 'Prompt C edited after dispatch' })
      expect(getDatabase().promptPresetsId).toBe(1)
    })
  })

  it('failed older prompt reorder skips rollback when a newer order changed live ids', async () => {
    seedPresetDatabase({
      promptPresets: [
        makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
        makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
        makePreset('prompt-c', 'Prompt C') as unknown as PromptPreset,
      ],
      promptPresetsId: 1,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().promptPresets = [
        getDatabase().promptPresets[1],
        getDatabase().promptPresets[2],
        getDatabase().promptPresets[0],
      ]
      getDatabase().promptPresetsId = 0
    })

    reorderPromptPresets(0, 3)

    await waitForPresetCommand(calls, '/prompt-presets/reorder')
    await waitForState(() => {
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-c', 'prompt-a', 'prompt-b'])
      expect(getDatabase().promptPresetsId).toBe(0)
    })
  })

  it('failed model select restores only attempted-matching selection and settings', async () => {
    seedPresetDatabase({
      modelPresets: [
        makePreset('model-a', 'Model A', { aiModel: 'model-a-api', temperature: 11 }) as unknown as ModelPreset,
        makePreset('model-b', 'Model B', { aiModel: 'model-b-api', temperature: 22 }) as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().temperature = 123
    })

    selectModelPreset(1)

    expect(getDatabase().modelPresetsId).toBe(1)
    expect(getDatabase().aiModel).toBe('model-b-api')
    expect(getDatabase().temperature).toBe(22)
    await waitForPresetCommand(calls, '/model-presets/select')
    await waitForState(() => {
      expect(getDatabase().modelPresetsId).toBe(0)
      expect(getDatabase().aiModel).toBe('live-model')
      expect(getDatabase().temperature).toBe(123)
    })
  })

  it('failed prompt select restores only attempted-matching selection and settings', async () => {
    seedPresetDatabase({
      promptPresets: [
        makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
        makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
      ],
      promptPresetsId: 0,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().globalNote = 'newer note after dispatch'
    })

    selectPromptPreset(1)

    expect(getDatabase().promptPresetsId).toBe(1)
    expect(getDatabase().mainPrompt).toBe('Prompt B prompt')
    expect(getDatabase().globalNote).toBe('Prompt B note')
    await waitForPresetCommand(calls, '/prompt-presets/select')
    await waitForState(() => {
      expect(getDatabase().promptPresetsId).toBe(0)
      expect(getDatabase().mainPrompt).toBe('live main')
      expect(getDatabase().globalNote).toBe('newer note after dispatch')
    })
  })

  it('applies split presets as base, selected model preset, then selected prompt preset overrides', () => {
    const modelPreset = {
      id: 'model-a',
      name: 'Model A',
      aiModel: 'model-ai',
      subModel: 'model-sub',
      temperature: 31,
      modelRoles: { memory: 'model-memory', scriptAux: 'model-script-aux' },
      modelProfiles: [
        {
          id: ' model-profile ',
          name: ' Model Profile ',
          modelId: ' model-ai ',
          providerOptions: { requestModel: ' model-wire ', apiKey: ' model-secret ', openAIKey: 'must-drop' },
        },
      ],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: ' model-profile ' },
      },
      modelRuntimeDefaults: {
        maxContext: 7777,
        modelTools: [' model-tool ', ''],
      },
      seperateModelsForAxModels: true,
      seperateModels: {
        memory: 'model-separate-memory',
        emotion: '',
        translate: '',
        otherAx: '',
        scriptMain: '',
        scriptAux: 'model-separate-script-aux',
      },
      fallbackModels: {
        model: ['model-fallback-main'],
        memory: ['model-fallback-memory'],
        emotion: [],
        translate: [],
        otherAx: [],
        scriptMain: [],
        scriptAux: ['model-fallback-script-aux'],
      },
    } as unknown as ModelPreset
    const promptPreset = {
      id: 'prompt-a',
      name: 'Prompt A',
      mainPrompt: 'prompt main',
      temperature: 88,
      overrideModelParameters: false,
      modelRoles: { memory: 'prompt-memory', scriptAux: 'prompt-script-aux' },
      modelProfiles: [{ id: 'prompt-profile', name: 'Prompt Profile' }],
      modelRoleProfiles: {
        memory: { mode: 'profile', profileId: 'prompt-profile' },
      },
      modelRuntimeDefaults: {
        maxContext: 9999,
      },
      seperateModelsForAxModels: true,
      seperateModels: {
        memory: 'prompt-separate-memory',
        emotion: '',
        translate: '',
        otherAx: '',
        scriptMain: '',
        scriptAux: 'prompt-separate-script-aux',
      },
      fallbackModels: {
        model: ['prompt-fallback-main'],
        memory: ['prompt-fallback-memory'],
        emotion: [],
        translate: [],
        otherAx: [],
        scriptMain: [],
        scriptAux: ['prompt-fallback-script-aux'],
      },
      fallbackWhenBlankResponse: true,
    } as unknown as PromptPreset

    seedPresetDatabase({
      aiModel: 'base-ai',
      subModel: 'base-sub',
      temperature: 12,
      modelRoles: { memory: 'base-memory', scriptAux: 'base-script-aux' } as Database['modelRoles'],
      modelProfiles: [{ id: 'base-profile', name: 'Base Profile', modelId: 'base-ai' }],
      modelRoleProfiles: normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'base-profile' },
      }) as Database['modelRoleProfiles'],
      modelRuntimeDefaults: { maxContext: 1111 },
      seperateModelsForAxModels: false,
      seperateModels: {
        memory: 'base-separate-memory',
        emotion: '',
        translate: '',
        otherAx: '',
        scriptMain: '',
        scriptAux: 'base-separate-script-aux',
      },
      fallbackModels: {
        model: ['base-fallback-main'],
        memory: ['base-fallback-memory'],
        emotion: [],
        translate: [],
        otherAx: [],
        scriptMain: [],
        scriptAux: ['base-fallback-script-aux'],
      },
      modelPresets: [modelPreset],
      modelPresetsId: 0,
      promptPresets: [promptPreset],
      promptPresetsId: 0,
    })

    applyModelPresetFieldsToDatabase(getDatabase(), getDatabase().modelPresets[0])

    expect(getDatabase().aiModel).toBe('model-ai')
    expect(getDatabase().subModel).toBe('model-sub')
    expect(getDatabase().temperature).toBe(31)
    expect(getDatabase().modelRoles).toMatchObject({
      memory: 'prompt-memory',
      scriptAux: 'prompt-script-aux',
    })
    expect(getDatabase().modelProfiles).toEqual([
      {
        id: 'model-profile',
        name: 'Model Profile',
        modelId: 'model-ai',
        providerOptions: { requestModel: 'model-wire' },
      },
    ])
    expect(getDatabase().modelRoleProfiles).toEqual(
      normalizedModelRoleProfiles({
        memory: { mode: 'profile', profileId: 'prompt-profile' },
      }),
    )
    expect(getDatabase().modelRuntimeDefaults).toEqual({
      maxContext: 7777,
      modelTools: ['model-tool'],
    })
    expect(getDatabase().seperateModelsForAxModels).toBe(true)
    expect(getDatabase().seperateModels).toMatchObject({
      memory: 'prompt-separate-memory',
      scriptAux: 'prompt-separate-script-aux',
    })
    expect(getDatabase().fallbackModels).toMatchObject({
      model: ['prompt-fallback-main'],
      memory: ['prompt-fallback-memory'],
      scriptAux: ['prompt-fallback-script-aux'],
    })
    expect(getDatabase().fallbackWhenBlankResponse).toBe(true)

    getDatabase().promptPresets[0] = {
      ...getDatabase().promptPresets[0],
      overrideModelParameters: true,
      temperature: 88,
    }
    applyPromptPresetFieldsToDatabase(getDatabase(), getDatabase().promptPresets[0])

    expect(getDatabase().temperature).toBe(88)
  })

  it('failed copy restores the original collection after save-current and generated copy id', async () => {
    seedPresetDatabase({ temperature: 88 })
    let generatedCopyId: string | undefined
    const calls = stubFailedPresetCommand(() => {
      generatedCopyId = getDatabase().botPresets.find((preset) => preset.name === 'Alpha Copy')?.id
      getDatabase().botPresets[0].name = 'Alpha source edited after dispatch'
      getDatabase().botPresets.push(makePreset('preset-c', 'Gamma appended after dispatch'))
    })

    copyPreset(0)

    expect(getDatabase().botPresets).toHaveLength(3)
    expect(getDatabase().botPresets[0].temperature).toBe(88)
    await waitForPresetCommand(calls, '/presets/preset-a/copy')
    await waitForState(() => {
      expect(generatedCopyId).toBeTruthy()
      expect(getDatabase().botPresets.some((preset) => preset.id === generatedCopyId)).toBe(false)
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[0]).toMatchObject({
        name: 'Alpha source edited after dispatch',
        temperature: 11,
      })
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma appended after dispatch' })
      expect(getDatabase().botPresetsId).toBe(0)
    })
  })

  it('shared preset boundary keeps copy as one rollback-safe command', async () => {
    seedPresetDatabase({ temperature: 77 })
    const beforeSourceTemperature = getDatabase().botPresets[0].temperature
    const beforeSelected = getDatabase().botPresetsId
    const calls = stubFailedPresetCommand()

    copyPreset(0)

    await waitForPresetCommand(calls, '/presets/preset-a/copy')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b'])
      expect(getDatabase().botPresets.some((preset) => preset.name === 'Alpha Copy')).toBe(false)
      expect(getDatabase().botPresets[0].temperature).toBe(beforeSourceTemperature)
      expect(getDatabase().botPresetsId).toBe(beforeSelected)
    })

    // Public preset operations currently stay one server command each; copy
    // folds save-current into the copy payload instead of dispatching fanout.
    const presetCommands = calls.filter((call) => call.url.startsWith('/api/v1/commands/presets'))
    expect(presetCommands).toHaveLength(1)
    expect(presetCommands[0].body).toMatchObject({
      baseRevision: 100,
      name: 'Alpha Copy',
      saveCurrent: true,
    })
    expect(presetCommands[0].body.newPresetId).toBeTruthy()
  })

  it('failed create removes the optimistic preset and generated id', async () => {
    seedPresetDatabase()
    let optimisticPresetId: string | undefined
    const calls = stubFailedPresetCommand(() => {
      optimisticPresetId = getDatabase().botPresets.find((preset) => preset.name === 'Created')?.id
      getDatabase().botPresets[0].name = 'Alpha edited after dispatch'
      getDatabase().botPresets.push(makePreset('preset-c', 'Gamma appended after dispatch'))
      getDatabase().botPresetsId = 1
    })
    const newPreset = makePreset('preset-created', 'Created')
    delete newPreset.id

    createPreset(newPreset)

    const optimisticPreset = getDatabase().botPresets.find((preset) => preset.name === 'Created')
    expect(optimisticPreset?.id).toBeTruthy()
    await waitForPresetCommand(calls, '/presets')
    await waitForState(() => {
      expect(optimisticPresetId).toBe(optimisticPreset?.id)
      expect(getDatabase().botPresets.some((preset) => preset.id === optimisticPreset?.id)).toBe(false)
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Alpha edited after dispatch' })
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma appended after dispatch' })
      expect(getDatabase().botPresetsId).toBe(1)
    })
  })

  it('failed update restores the patched preset row', async () => {
    seedPresetDatabase()
    const calls = stubFailedPresetCommand(() => {
      getDatabase().botPresets[1].name = 'Newer Beta edit after dispatch'
      getDatabase().botPresets.push(makePreset('preset-c', 'Gamma appended after dispatch'))
    })

    updatePreset(1, { name: 'Broken Update', temperature: 99 })

    expect(getDatabase().botPresets[1]).toMatchObject({ name: 'Broken Update', temperature: 99 })
    await waitForPresetCommand(calls, '/presets/preset-b')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[1]).toMatchObject({
        name: 'Newer Beta edit after dispatch',
        temperature: 22,
      })
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma appended after dispatch' })
      expect(getDatabase().botPresetsId).toBe(0)
    })
  })

  it('failed delete restores collection, selection, and setPreset scalars', async () => {
    seedPresetDatabase()
    const calls = stubFailedPresetCommand(() => {
      getDatabase().botPresets.push(makePreset('preset-c', 'Gamma appended after dispatch'))
      getDatabase().botPresetsId = 1
      getDatabase().mainPrompt = 'newer prompt after dispatch'
    })

    deletePreset(0, 1, true)

    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b'])
    expect(getDatabase().botPresetsId).toBe(0)
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    await waitForPresetCommand(calls, '/presets/preset-a')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Alpha' })
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma appended after dispatch' })
      expect(getDatabase().botPresetsId).toBe(2)
      expect(getDatabase().mainPrompt).toBe('newer prompt after dispatch')
    })
  })

  it('legacy delete with apply does not change top-level promptTemplate', async () => {
    seedPresetDatabase()
    const beforePromptTemplate = clonePlain(getDatabase().promptTemplate)
    const calls = stubFailedPresetCommand()

    deletePreset(0, 1, true)

    expect(getDatabase().botPresetsId).toBe(0)
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    expect(getDatabase().promptTemplate).toEqual(beforePromptTemplate)
    await waitForPresetCommand(calls, '/presets/preset-a')
  })

  it('failed reorder restores collection order and selected index', async () => {
    seedPresetDatabase({
      botPresets: [makePreset('preset-a', 'Alpha'), makePreset('preset-b', 'Beta'), makePreset('preset-c', 'Gamma')],
      botPresetsId: 1,
    })
    const calls = stubFailedPresetCommand(() => {
      const gamma = getDatabase().botPresets.find((preset) => preset.id === 'preset-c')
      if (gamma) {
        gamma.name = 'Gamma edited after dispatch'
      }
    })

    expect(isCollectionAcknowledgementTainted('botPresets')).toBe(false)
    expect(isSettingsAcknowledgementTainted()).toBe(false)
    reorderPresets(0, 3)

    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b', 'preset-c', 'preset-a'])
    expect(getDatabase().botPresetsId).toBe(0)
    await waitForPresetCommand(calls, '/presets/reorder')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b', 'preset-c'])
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Gamma edited after dispatch' })
      expect(getDatabase().botPresetsId).toBe(1)
      expect(isCollectionAcknowledgementTainted('botPresets')).toBe(true)
      expect(isSettingsAcknowledgementTainted()).toBe(true)
    })
  })

  it('failed older legacy reorder skips rollback after a newer reorder changes live ids', async () => {
    seedPresetDatabase({
      botPresets: [makePreset('preset-a', 'Alpha'), makePreset('preset-b', 'Beta'), makePreset('preset-c', 'Gamma')],
      botPresetsId: 1,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().botPresets = [getDatabase().botPresets[1], getDatabase().botPresets[2], getDatabase().botPresets[0]]
      getDatabase().botPresetsId = 0
    })

    reorderPresets(0, 3)

    await waitForPresetCommand(calls, '/presets/reorder')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-c', 'preset-a', 'preset-b'])
      expect(getDatabase().botPresetsId).toBe(0)
    })
  })

  it('failed select restores setPreset scalars without overwriting unrelated fields', async () => {
    seedPresetDatabase()
    const beforePresets = clonePlain(getDatabase().botPresets)
    const beforePrompt = getDatabase().mainPrompt
    const beforePromptTemplate = clonePlain(getDatabase().promptTemplate)
    const beforeNaiSettings = clonePlain(getDatabase().NAIsettings)
    const calls = stubFailedPresetCommand(() => {
      getDatabase().temperature = 123
      getDatabase().customBackground = 'changed while preset command was in flight'
    })

    changeToPreset(1, false)

    expect(getDatabase().botPresetsId).toBe(1)
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    expect(getDatabase().temperature).toBe(22)
    await waitForPresetCommand(calls, '/presets/select')
    await waitForState(() => {
      expect(getDatabase().botPresets).toEqual(beforePresets)
      expect(getDatabase().botPresetsId).toBe(0)
      expect(getDatabase().mainPrompt).toBe(beforePrompt)
      expect(getDatabase().temperature).toBe(123)
      expect(getDatabase().promptTemplate).toEqual(beforePromptTemplate)
      expect(getDatabase().NAIsettings).toEqual(beforeNaiSettings)
      expect(getDatabase().customBackground).toBe('changed while preset command was in flight')
    })
  })

  it('legacy select does not change top-level promptTemplate', async () => {
    seedPresetDatabase()
    const beforePromptTemplate = clonePlain(getDatabase().promptTemplate)
    const calls = stubFailedPresetCommand()

    changeToPreset(1, false)

    expect(getDatabase().botPresetsId).toBe(1)
    expect(getDatabase().mainPrompt).toBe('Beta prompt')
    expect(getDatabase().promptTemplate).toEqual(beforePromptTemplate)
    await waitForPresetCommand(calls, '/presets/select')
  })

  it('failed legacy extract preserves split preset edits while removing unchanged generated rows', async () => {
    seedPresetDatabase({
      botPresets: [makePreset('preset-a', 'Alpha'), makePreset('preset-b', 'Beta')],
      botPresetsId: 0,
      modelPresets: [
        makePreset('model-existing', 'Existing Model', {
          aiModel: 'existing-model-api',
          temperature: 77,
        }) as unknown as ModelPreset,
      ],
      modelPresetsId: 0,
      promptPresets: [makePreset('prompt-existing', 'Existing Prompt') as unknown as PromptPreset],
      promptPresetsId: 0,
    })
    const calls = stubFailedPresetCommand(() => {
      getDatabase().modelPresets[0].name = 'Existing Model edited after dispatch'
      getDatabase().modelPresets.push(
        makePreset('model-newer', 'Newer Model appended after dispatch', {
          aiModel: 'newer-model-api',
        }) as unknown as ModelPreset,
      )
      getDatabase().promptPresets[0].name = 'Existing Prompt edited after dispatch'
      getDatabase().promptPresets.push(
        makePreset('prompt-newer', 'Newer Prompt appended after dispatch') as unknown as PromptPreset,
      )
    })

    extractLegacyBotPresetByIndex(0, 'all')

    expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b'])
    expect(getDatabase().modelPresets.some((preset) => preset.name === 'Alpha Model')).toBe(true)
    expect(getDatabase().promptPresets.some((preset) => preset.name === 'Alpha Prompt')).toBe(true)
    expect(getDatabase().promptPresets.find((preset) => preset.name === 'Alpha Prompt')?.promptTemplate).toEqual([
      { id: 'preset-a-prompt', type: 'plain', text: 'Alpha prompt item', role: 'system' },
    ])
    await waitForPresetCommand(calls, '/legacy-bot-presets/preset-a/extract')
    await waitForState(() => {
      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-a', 'preset-b'])
      expect(getDatabase().botPresetsId).toBe(0)
      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-existing', 'model-newer'])
      expect(getDatabase().modelPresets[0]).toMatchObject({ name: 'Existing Model edited after dispatch' })
      expect(getDatabase().modelPresets[1]).toMatchObject({ name: 'Newer Model appended after dispatch' })
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-existing', 'prompt-newer'])
      expect(getDatabase().promptPresets[0]).toMatchObject({ name: 'Existing Prompt edited after dispatch' })
      expect(getDatabase().promptPresets[1]).toMatchObject({ name: 'Newer Prompt appended after dispatch' })
    })
  })
})

describe('durable preset mutation projections', () => {
  it.each([
    { operation: 'create' as const, refresh: 'targeted' as const },
    { operation: 'update' as const, refresh: 'full' as const },
    { operation: 'delete' as const, refresh: 'targeted' as const },
    { operation: 'reorder' as const, refresh: 'full' as const },
  ])('keeps a retained legacy $operation visible across a $refresh resource replacement', async (testCase) => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: `writer-preset-${testCase.operation}-refresh`,
      writerEpoch: 1,
      databaseLineage: `lineage-preset-${testCase.operation}-refresh`,
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase()
      setCachedServerCommandRevision(100)
      const authoritative = clonePlain(getDatabase())
      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const call: CapturedFetch = {
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          }
          calls.push(call)
          if (!recover) return jsonResponse({ error: 'preset temporarily unavailable' }, 500)
          revision += 1
          const eventBase = { revision, resource: 'preset' }
          if (url === '/api/v1/commands/presets' && call.method === 'POST') {
            return jsonResponse({
              revision,
              event: { ...eventBase, type: 'preset.created', id: call.body.preset.id },
              presetId: call.body.preset.id,
            })
          }
          if (url === '/api/v1/commands/presets/reorder') {
            return jsonResponse({
              revision,
              event: { ...eventBase, type: 'preset.reordered' },
              selectedPresetId: 'preset-a',
            })
          }
          const presetId = decodeURIComponent(url.slice('/api/v1/commands/presets/'.length))
          if (call.method === 'DELETE') {
            return jsonResponse({
              revision,
              event: { ...eventBase, type: 'preset.deleted', id: presetId },
              presetId,
              selectedPresetId: call.body.presetId,
            })
          }
          return jsonResponse({
            revision,
            event: { ...eventBase, type: 'preset.updated', id: presetId },
            presetId,
          })
        }) as unknown as typeof fetch,
      )

      if (testCase.operation === 'create') {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValueOnce(
          'preset-retained-create' as `${string}-${string}-${string}-${string}-${string}`,
        )
        const preset = makePreset('placeholder', 'Retained Create')
        delete preset.id
        createPreset(preset)
      } else if (testCase.operation === 'update') {
        updatePreset(0, { name: 'Retained Update', temperature: 77 })
      } else if (testCase.operation === 'delete') {
        deletePreset(0, 1, false)
      } else {
        reorderPresets(0, 2)
      }

      await waitForState(() => expect(calls).toHaveLength(1))
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))

      if (testCase.refresh === 'full') {
        applyServerResourceDatabase(clonePlain(authoritative), 100)
      } else {
        mergeServerResourceFields({
          botPresets: clonePlain(authoritative.botPresets),
          botPresetsId: authoritative.botPresetsId,
        } as Partial<Database>)
      }

      if (testCase.operation === 'create') {
        expect(getDatabase().botPresets.find((preset) => preset.id === 'preset-retained-create')).toMatchObject({
          name: 'Retained Create',
        })
      } else if (testCase.operation === 'update') {
        expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Retained Update', temperature: 77 })
      } else if (testCase.operation === 'delete') {
        expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b'])
        expect(getDatabase().botPresetsId).toBe(0)
      } else {
        expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b', 'preset-a'])
      }

      recover = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
      expect(await listPendingMutations()).toEqual([])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('retires and rolls back a retained projection when replay is terminally rejected', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-preset-terminal-replay',
      writerEpoch: 7,
      databaseLineage: 'lineage-preset-terminal-replay',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase()
      setCachedServerCommandRevision(100)
      let replaying = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          return replaying
            ? jsonResponse({ error: 'preset no longer exists' }, 404)
            : jsonResponse({ error: 'preset temporarily unavailable' }, 500)
        }) as unknown as typeof fetch,
      )

      updatePreset(0, { name: 'Retained but invalid' })
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))
      mergeServerResourceFields({
        botPresets: [makePreset('preset-a', 'Alpha', { temperature: 11 }), makePreset('preset-b', 'Beta')],
        botPresetsId: 0,
      } as Partial<Database>)
      expect(getDatabase().botPresets[0].name).toBe('Retained but invalid')

      replaying = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1 })
      expect(getDatabase().botPresets[0].name).toBe('Alpha')

      mergeServerResourceFields({
        botPresets: [makePreset('preset-a', 'Alpha', { temperature: 11 }), makePreset('preset-b', 'Beta')],
        botPresetsId: 0,
      } as Partial<Database>)
      expect(getDatabase().botPresets[0].name).toBe('Alpha')
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rebases two terminal legacy updates back to the original row', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-preset-rapid-update-failure',
      writerEpoch: 2,
      databaseLineage: 'lineage-preset-rapid-update-failure',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase()
      setCachedServerCommandRevision(100)
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push({
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          return jsonResponse({ error: 'invalid preset update' }, 400)
        }) as unknown as typeof fetch,
      )

      updatePreset(0, { name: 'First attempted name', temperature: 33 })
      updatePreset(0, { name: 'Second attempted name', temperature: 44 })

      expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Second attempted name', temperature: 44 })
      await waitForState(() => {
        expect(calls).toHaveLength(2)
        expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Alpha', temperature: 11 })
      })
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('does not retain inherited fields from an earlier failed partial update', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-preset-partial-successor-rebase',
      writerEpoch: 8,
      databaseLineage: 'lineage-preset-partial-successor-rebase',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase()
      setCachedServerCommandRevision(100)
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const call = {
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          }
          calls.push(call)
          return calls.length === 1
            ? jsonResponse({ error: 'first update is invalid' }, 400)
            : jsonResponse({ error: 'second update is temporarily unavailable' }, 500)
        }) as unknown as typeof fetch,
      )

      updatePreset(0, { name: 'Failed inherited name', temperature: 33 })
      updatePreset(0, { temperature: 44 })

      await waitForState(() => {
        expect(calls).toHaveLength(2)
        expect(calls[1]?.body.patch).toEqual({ temperature: 44 })
        expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Alpha', temperature: 44 })
      })
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))

      mergeServerResourceFields({
        botPresets: [
          makePreset('preset-a', 'Alpha', { temperature: 11 }),
          makePreset('preset-b', 'Beta', { temperature: 22 }),
        ],
        botPresetsId: 0,
      } as Partial<Database>)

      expect(getDatabase().botPresets[0]).toMatchObject({ name: 'Alpha', temperature: 44 })
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps converted preset mutations local when server commands are unavailable', () => {
    const canUseCommands = vi.spyOn(serverCommands, 'canUseServerCommands').mockReturnValue(false)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    try {
      seedPresetDatabase()
      createPreset(makePreset('preset-local', 'Local Create'))
      updatePreset(0, { name: 'Local Update', temperature: 66 })
      reorderPresets(0, 3)

      expect(getDatabase().botPresets.map((preset) => preset.id)).toEqual(['preset-b', 'preset-local', 'preset-a'])
      expect(getDatabase().botPresets[2]).toMatchObject({ name: 'Local Update', temperature: 66 })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      canUseCommands.mockRestore()
    }
  })

  it.each(['legacy', 'model', 'prompt'] as const)(
    'keeps a retained %s selection visible across refresh and retires it after replay',
    async (kind) => {
      vi.stubGlobal('indexedDB', new IDBFactory())
      resetPendingMutationOutboxForTests()
      await preparePendingMutationOutbox({
        writerSessionId: `writer-${kind}-selection-refresh`,
        writerEpoch: 9,
        databaseLineage: `lineage-${kind}-selection-refresh`,
        requestedWriterWasActive: true,
      })

      try {
        const legacyPresets = [
          makePreset('preset-a', 'Legacy A', { temperature: 11 }),
          makePreset('preset-b', 'Legacy B', { temperature: 22 }),
        ]
        const modelPresets = [
          makePreset('model-a', 'Model A', { aiModel: 'model-a-api', temperature: 31 }) as unknown as ModelPreset,
          makePreset('model-b', 'Model B', { aiModel: 'model-b-api', temperature: 42 }) as unknown as ModelPreset,
        ]
        const promptPresets = [
          makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset,
          makePreset('prompt-b', 'Prompt B') as unknown as PromptPreset,
        ]
        seedPresetDatabase({
          botPresets: legacyPresets,
          botPresetsId: 0,
          modelPresets,
          modelPresetsId: 0,
          promptPresets,
          promptPresetsId: 0,
        })
        setCachedServerCommandRevision(100)
        let replaying = false
        const calls: CapturedFetch[] = []
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const url = String(input)
            if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
            const call = {
              url,
              method: init.method ?? 'GET',
              body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
            }
            calls.push(call)
            if (!replaying) return jsonResponse({ error: 'selection temporarily unavailable' }, 500)
            const revision = 101
            if (url.endsWith('/presets/select')) {
              return jsonResponse({
                revision,
                event: { type: 'preset.selected', revision, resource: 'preset', id: 'preset-b' },
                presetId: 'preset-b',
              })
            }
            if (url.endsWith('/model-presets/select')) {
              return jsonResponse({
                revision,
                event: { type: 'modelPreset.selected', revision, resource: 'preset', id: 'model-b' },
                modelPresetId: 'model-b',
              })
            }
            if (url.endsWith('/prompt-presets/select')) {
              return jsonResponse({
                revision,
                event: { type: 'promptPreset.selected', revision, resource: 'preset', id: 'prompt-b' },
                promptPresetId: 'prompt-b',
              })
            }
            return jsonResponse({ error: `unexpected ${url}` }, 404)
          }) as unknown as typeof fetch,
        )

        if (kind === 'legacy') changeToPreset(1, false)
        else if (kind === 'model') selectModelPreset(1)
        else selectPromptPreset(1)

        await waitForState(() => expect(calls).toHaveLength(1))
        await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))

        if (kind === 'legacy') {
          mergeServerResourceFields({
            botPresets: clonePlain(legacyPresets),
            botPresetsId: 0,
            mainPrompt: 'authoritative legacy prompt',
            temperature: 11,
          } as Partial<Database>)
          expect(getDatabase().botPresetsId).toBe(1)
          expect(getDatabase()).toMatchObject({ mainPrompt: 'Legacy B prompt', temperature: 22 })
        } else if (kind === 'model') {
          mergeServerResourceFields({
            modelPresets: clonePlain(modelPresets),
            modelPresetsId: 0,
            aiModel: 'authoritative-model',
            temperature: 31,
          } as Partial<Database>)
          expect(getDatabase().modelPresetsId).toBe(1)
          expect(getDatabase()).toMatchObject({ aiModel: 'model-b-api', temperature: 42 })
        } else {
          mergeServerResourceFields({
            promptPresets: clonePlain(promptPresets),
            promptPresetsId: 0,
            mainPrompt: 'authoritative prompt',
            globalNote: 'authoritative note',
          } as Partial<Database>)
          expect(getDatabase().promptPresetsId).toBe(1)
          expect(getDatabase()).toMatchObject({ mainPrompt: 'Prompt B prompt', globalNote: 'Prompt B note' })
        }

        replaying = true
        await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 1 })
        expect(await listPendingMutations()).toEqual([])

        if (kind === 'legacy') {
          mergeServerResourceFields({ botPresets: clonePlain(legacyPresets), botPresetsId: 0 } as Partial<Database>)
          expect(getDatabase().botPresetsId).toBe(0)
        } else if (kind === 'model') {
          mergeServerResourceFields({ modelPresets: clonePlain(modelPresets), modelPresetsId: 0 } as Partial<Database>)
          expect(getDatabase().modelPresetsId).toBe(0)
        } else {
          mergeServerResourceFields({
            promptPresets: clonePlain(promptPresets),
            promptPresetsId: 0,
          } as Partial<Database>)
          expect(getDatabase().promptPresetsId).toBe(0)
        }
      } finally {
        await clearPendingMutationOutbox()
        resetPendingMutationOutboxForTests()
      }
    },
  )

  it('rebases two terminal model selections back to the original selection and settings', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-rapid-selection-failure',
      writerEpoch: 11,
      databaseLineage: 'lineage-model-rapid-selection-failure',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Model A', { aiModel: 'model-a-api', temperature: 11 }) as unknown as ModelPreset,
          makePreset('model-b', 'Model B', { aiModel: 'model-b-api', temperature: 22 }) as unknown as ModelPreset,
          makePreset('model-c', 'Model C', { aiModel: 'model-c-api', temperature: 33 }) as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
        aiModel: 'model-a-api',
        temperature: 11,
      })
      setCachedServerCommandRevision(100)
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push({
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          return jsonResponse({ error: 'invalid model selection' }, 400)
        }) as unknown as typeof fetch,
      )

      selectModelPreset(1)
      selectModelPreset(2)

      expect(getDatabase()).toMatchObject({ modelPresetsId: 2, aiModel: 'model-c-api', temperature: 33 })
      await waitForState(() => {
        expect(calls).toHaveLength(2)
        expect(getDatabase()).toMatchObject({ modelPresetsId: 0, aiModel: 'model-a-api', temperature: 11 })
      })
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('reapplies a retained imported prompt preset after refresh and removes it after terminal replay', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-imported-prompt-refresh',
      writerEpoch: 10,
      databaseLineage: 'lineage-imported-prompt-refresh',
      requestedWriterWasActive: true,
    })

    try {
      const authoritativePrompts = [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset]
      seedPresetDatabase({ promptPresets: authoritativePrompts, promptPresetsId: 0 })
      setCachedServerCommandRevision(100)
      let replaying = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          return replaying
            ? jsonResponse({ error: 'imported prompt is invalid' }, 404)
            : jsonResponse({ error: 'prompt import temporarily unavailable' }, 500)
        }) as unknown as typeof fetch,
      )

      await expect(
        addImportedPromptPreset(makePreset('prompt-imported', 'Imported Prompt') as unknown as PromptPreset),
      ).resolves.toBe('queued')
      await vi.waitFor(async () => expect(await listPendingMutations()).toHaveLength(1))
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-imported'])

      mergeServerResourceFields({
        promptPresets: clonePlain(authoritativePrompts),
        promptPresetsId: 0,
      } as Partial<Database>)
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a', 'prompt-imported'])

      replaying = true
      await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1 })
      expect(await listPendingMutations()).toEqual([])
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a'])

      mergeServerResourceFields({
        promptPresets: clonePlain(authoritativePrompts),
        promptPresetsId: 0,
      } as Partial<Database>)
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a'])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('retires a gated imported preset batch when database ownership is replaced', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-imported-prompt-restore',
      writerEpoch: 10,
      databaseLineage: 'lineage-imported-prompt-restore',
      requestedWriterWasActive: true,
    })
    const response = deferred<Response>()

    try {
      const authoritativePrompts = [makePreset('prompt-a', 'Prompt A') as unknown as PromptPreset]
      seedPresetDatabase({ promptPresets: authoritativePrompts, promptPresetsId: 0 })
      setCachedServerCommandRevision(100)
      const calls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push(url)
          return response.promise
        }) as unknown as typeof fetch,
      )

      const importing = addImportedPromptPreset(
        makePreset('prompt-imported', 'Imported Prompt') as unknown as PromptPreset,
      )
      await vi.waitFor(() => expect(calls).toHaveLength(1))

      resetPendingPresetMutationsForTests()
      mergeServerResourceFields({
        promptPresets: clonePlain(authoritativePrompts),
        promptPresetsId: 0,
      } as Partial<Database>)

      await expect(importing).resolves.toBe('failed')
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a'])

      response.resolve(jsonResponse({ error: 'old database request failed' }, 500))
      await Promise.resolve()
      await Promise.resolve()
      expect(getDatabase().promptPresets.map((preset) => preset.id)).toEqual(['prompt-a'])
    } finally {
      response.resolve(jsonResponse({ error: 'test cleanup' }, 500))
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it.each([
    { kind: 'legacy' as const, path: '/presets/reorder' },
    { kind: 'model' as const, path: '/model-presets/reorder' },
    { kind: 'prompt' as const, path: '/prompt-presets/reorder' },
  ])('rebases two terminal $kind reorder attempts back to the original order', async (testCase) => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: `writer-${testCase.kind}-rapid-reorder-failure`,
      writerEpoch: 3,
      databaseLineage: `lineage-${testCase.kind}-rapid-reorder-failure`,
      requestedWriterWasActive: true,
    })

    try {
      const rows = [
        makePreset(`${testCase.kind}-a`, 'Alpha'),
        makePreset(`${testCase.kind}-b`, 'Beta'),
        makePreset(`${testCase.kind}-c`, 'Gamma'),
      ]
      seedPresetDatabase(
        testCase.kind === 'legacy'
          ? { botPresets: rows, botPresetsId: 1 }
          : testCase.kind === 'model'
            ? { modelPresets: rows as unknown as ModelPreset[], modelPresetsId: 1 }
            : { promptPresets: rows as unknown as PromptPreset[], promptPresetsId: 1 },
      )
      setCachedServerCommandRevision(100)
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push({
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          return jsonResponse({ error: 'invalid preset reorder' }, 400)
        }) as unknown as typeof fetch,
      )

      const reorder =
        testCase.kind === 'legacy'
          ? reorderPresets
          : testCase.kind === 'model'
            ? reorderModelPresets
            : reorderPromptPresets
      reorder(0, 3)
      reorder(0, 3)

      await waitForState(() => {
        expect(calls.map((call) => call.url)).toEqual([
          `/api/v1/commands${testCase.path}`,
          `/api/v1/commands${testCase.path}`,
        ])
        const liveRows =
          testCase.kind === 'legacy'
            ? getDatabase().botPresets
            : testCase.kind === 'model'
              ? getDatabase().modelPresets
              : getDatabase().promptPresets
        expect(liveRows.map((preset) => preset.id)).toEqual([
          `${testCase.kind}-a`,
          `${testCase.kind}-b`,
          `${testCase.kind}-c`,
        ])
      })
      await vi.waitFor(async () => expect(await listPendingMutations()).toEqual([]))
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('rolls back a generated split preset when durable staging throws synchronously', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-create-stage-failure',
      writerEpoch: 6,
      databaseLineage: 'lineage-model-create-stage-failure',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [makePreset('model-existing', 'Existing') as unknown as ModelPreset],
        modelPresetsId: 0,
      })
      setCachedServerCommandRevision(100)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementationOnce(() => {
        throw new Error('mutation id generation failed')
      })

      await expect(
        createModelPreset(makePreset('model-stage-failure', 'Must Roll Back') as unknown as ModelPreset),
      ).resolves.toEqual({ status: 'failed' })

      expect(getDatabase().modelPresets.map((preset) => preset.id)).toEqual(['model-existing'])
      expect(await listPendingMutations()).toEqual([])
      expect(consoleError).toHaveBeenCalledWith(
        'Unable to stage durable preset mutation:',
        expect.objectContaining({ message: 'mutation id generation failed' }),
      )
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps model reorder behind a retained split row patch', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-patch-reorder',
      writerEpoch: 4,
      databaseLineage: 'lineage-model-patch-reorder',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Alpha') as unknown as ModelPreset,
          makePreset('model-b', 'Beta') as unknown as ModelPreset,
          makePreset('model-c', 'Gamma') as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
      })
      setCachedServerCommandRevision(100)
      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const call = {
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          }
          calls.push(call)
          if (!recover) return jsonResponse({ error: 'model preset temporarily unavailable' }, 500)
          revision += 1
          return url.endsWith('/reorder')
            ? jsonResponse({
                revision,
                event: { type: 'modelPreset.reordered', revision, resource: 'preset' },
                selectedModelPresetId: 'model-a',
              })
            : jsonResponse({
                revision,
                event: { type: 'modelPreset.updated', revision, resource: 'preset', id: 'model-a' },
                modelPresetId: 'model-a',
              })
        }) as unknown as typeof fetch,
      )

      const renameOutcomePromise = updateModelPreset(0, { name: 'Alpha retained edit' })
      reorderModelPresets(0, 3)

      await waitForState(() => expect(calls.filter((call) => call.url.endsWith('/model-a'))).toHaveLength(2))
      const renameOutcome = await renameOutcomePromise
      expect(renameOutcome.status).toBe('queued')
      expect(calls.some((call) => call.url.endsWith('/reorder'))).toBe(false)
      const queued = await listPendingMutations()
      expect(queued).toHaveLength(2)
      expect(queued[1]?.intent.dependencyKeys).toContain('split-preset:model:model-a')

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(calls.slice(recoveryStart).map((call) => `${call.method} ${call.url}`)).toEqual([
        'PATCH /api/v1/commands/model-presets/model-a',
        'POST /api/v1/commands/model-presets/reorder',
      ])
      if (renameOutcome.status === 'queued') await expect(renameOutcome.settlement).resolves.toBe('accepted')
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('retires an in-flight preset selection before a restored database is applied', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-preset-restore-race',
      writerEpoch: 4,
      databaseLineage: 'lineage-before-restore',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Alpha', { temperature: 11 }) as unknown as ModelPreset,
          makePreset('model-b', 'Beta', { temperature: 22 }) as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
        temperature: 11,
      })
      setCachedServerCommandRevision(100)
      const response = deferred<Response>()
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          calls.push({
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          })
          return response.promise
        }) as unknown as typeof fetch,
      )

      const selection = selectModelPreset(1)
      await waitForState(() => expect(calls).toHaveLength(1))
      const restoredDatabase = clonePlain(getDatabase())

      resetPendingPresetMutationsForTests()
      applyServerResourceDatabase(restoredDatabase, 200)
      await expect(selection).resolves.toEqual({ status: 'failed' })

      response.resolve(jsonResponse({ error: 'old database request failed' }, 500))
      await waitForState(() => {
        expect(getDatabase()).toMatchObject({ modelPresetsId: 1, temperature: 22 })
      })
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('settles a queued preset row mutation when database ownership is replaced', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-preset-queued-restore',
      writerEpoch: 4,
      databaseLineage: 'lineage-before-restore',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        modelPresets: [
          makePreset('model-a', 'Alpha') as unknown as ModelPreset,
          makePreset('model-b', 'Beta') as unknown as ModelPreset,
        ],
        modelPresetsId: 0,
      })
      setCachedServerCommandRevision(100)
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
          String(input) === '/api/v1/commands/mutation-receipts/ack'
            ? jsonResponse({ acknowledged: true })
            : jsonResponse({ error: 'temporarily unavailable' }, 500),
        ) as unknown as typeof fetch,
      )

      const outcome = await selectModelPreset(1)
      expect(outcome.status).toBe('queued')
      if (outcome.status !== 'queued') throw new Error('Expected a retained preset mutation')

      resetPendingPresetMutationsForTests()

      await expect(outcome.settlement).resolves.toBe('failed')
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })

  it('keeps legacy extraction behind a retained split row patch', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-model-patch-extract',
      writerEpoch: 5,
      databaseLineage: 'lineage-model-patch-extract',
      requestedWriterWasActive: true,
    })

    try {
      seedPresetDatabase({
        botPresets: [makePreset('preset-a', 'Legacy Alpha'), makePreset('preset-b', 'Legacy Beta')],
        botPresetsId: 0,
        modelPresets: [makePreset('model-a', 'Model Alpha') as unknown as ModelPreset],
        modelPresetsId: 0,
        promptPresets: [makePreset('prompt-a', 'Prompt Alpha') as unknown as PromptPreset],
        promptPresetsId: 0,
      })
      setCachedServerCommandRevision(100)
      let recover = false
      let revision = 100
      const calls: CapturedFetch[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input)
          if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          const call = {
            url,
            method: init.method ?? 'GET',
            body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
          }
          calls.push(call)
          if (!recover) return jsonResponse({ error: 'preset temporarily unavailable' }, 500)
          revision += 1
          return url.includes('/legacy-bot-presets/')
            ? jsonResponse({
                revision,
                event: { type: 'preset.extracted', revision, resource: 'preset', id: 'preset-a' },
                legacyPresetId: 'preset-a',
                modelPresetId: 'model-extracted',
              })
            : jsonResponse({
                revision,
                event: { type: 'modelPreset.updated', revision, resource: 'preset', id: 'model-a' },
                modelPresetId: 'model-a',
              })
        }) as unknown as typeof fetch,
      )

      updateModelPreset(0, { name: 'Model Alpha retained edit' })
      extractLegacyBotPresetByIndex(0, 'model')

      await waitForState(() => expect(calls.filter((call) => call.url.endsWith('/model-a'))).toHaveLength(2))
      expect(calls.some((call) => call.url.includes('/legacy-bot-presets/'))).toBe(false)
      const queued = await listPendingMutations()
      expect(queued).toHaveLength(2)
      expect(queued[1]?.intent.dependencyKeys).toContain('split-preset:model:model-a')

      recover = true
      const recoveryStart = calls.length
      await expect(replayPendingMutations()).resolves.toMatchObject({ succeeded: 2 })
      expect(calls.slice(recoveryStart).map((call) => `${call.method} ${call.url}`)).toEqual([
        'PATCH /api/v1/commands/model-presets/model-a',
        'POST /api/v1/commands/legacy-bot-presets/preset-a/extract',
      ])
    } finally {
      await clearPendingMutationOutbox()
      resetPendingMutationOutboxForTests()
    }
  })
})
