import { adaptServerCbsDatabase } from '../src/prompt/cbsAdapter.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  FastifyChat as Chat,
  FastifyCharacter as character,
  FastifyDatabase as PromptDatabase,
  ServerPromptPreset,
  FastifyLoreBook as loreBook,
  FastifyMessage as Message,
} from '../src/prompt/serverTypes.js'
import type { PromptMessage } from '../src/prompt/promptMessage.js'
import type { AgentPresetStepRecord } from '@risuai/shared-core/agent-preset-records'
import { openDatabase } from '../src/db.js'
import {
  createMemoryChunk,
  createMemoryEmbedding,
  createMemorySummary,
  listMemoryChunks,
  listMemoryJobs,
  listMemorySummaries,
  type MemoryJob,
} from '../src/memoryRepository.js'
import { LEGACY_HYPA_V3_SUMMARY_MODEL } from '../src/memorySummaryCompatibility.js'
import { EntityNotFoundError, listInlayCatalogEntries } from '../src/repository.js'
import {
  assemblePrompt,
  applyRequestTrigger,
  applyCurrentChatRunVars,
  beginAssembly,
  createEmptyUnformatedSlots,
  fillHistoryAndBias,
  fillLorebookSlots,
  fillMemoryAndPostHistory,
  fillStaticSlots,
  buildRestorationPayload,
  getAssemblyMessageCaptureInstrumentation,
  isRunVarParserFixedPoint,
  renderAndBudget,
  resetAssemblyMessageCaptureInstrumentation,
  runServerPostGeneration,
  type AssembleDeps,
  type AssembleInput,
} from '../src/prompt/assemble.js'
import { ChatGenerationSettingsIncompleteAssemblyError } from '../src/prompt/effectiveGenerationConfig.js'
import { applyDepthPrompts, buildHistoryWindow } from '../src/prompt/history.js'
import { buildAssetLookup } from '../src/prompt/assetLookup.js'
import { createRequestScopedStoredAssetResolver } from '../src/routes/generationChat.js'
import type { LoreEntryActive, LorebookActivationReport } from '../src/prompt/lorebook.js'
import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import * as promptVariables from '../src/prompt/variables.js'
import {
  bumpAssemblyCbsHistoryGeneration,
  getAssemblyCbsCallbackMemoInstrumentation,
  resetAssemblyCbsCallbackMemoInstrumentation,
} from '../src/prompt/cbsCallbackMemo.js'
import {
  getChatDispatchReformatInstrumentation,
  reformatMessages,
  resetChatDispatchReformatInstrumentation,
} from '../src/prompt/chatDispatch.js'
import {
  getHypaV3PrefixTokenMemoStatsForTests,
  resetHypaV3PrefixTokenMemoForTests,
} from '../src/prompt/prefixTokenMemo.js'
import { getPromptAssetTableInstrumentation, resetPromptAssetTableInstrumentation } from '../src/prompt/promptAssets.js'
import { promptSummaryMetricFields, summarizePromptRows } from '../src/prompt/promptSummary.js'
import { getTriggerCloneInstrumentation, resetTriggerCloneInstrumentation } from '../src/prompt/triggers.js'
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from '@risuai/shared-core/model-types'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { createBardWikiDocument } from '../src/bardWikiRepository.js'

beforeAll(() => {
  bootPromptVariables()
})

const dataDirs: string[] = []

function makeDataDir(): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-fastify-assemble-'))
  dataDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  vi.restoreAllMocks()
  resetHypaV3PrefixTokenMemoForTests()
  resetTriggerCloneInstrumentation()
  for (const dataDir of dataDirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

/** Legacy test import fields remain local to this compatibility fixture. */
type Database = PromptDatabase & {
  botPresets?: ServerPromptPreset[]
  botPresetsId?: number
  apiType?: string
  agentContextEnabled?: boolean
  agentContextPrompt?: string
  agentContextMaxOutput?: number
  agentContextMaxToolRounds?: number
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    message: [],
    note: '',
    name: 'Chat',
    localLore: [],
    ...overrides,
  } as unknown as Chat
}

function makeCharacter(overrides: Partial<character> = {}): character {
  return {
    type: 'character',
    name: 'Tess',
    chaId: 'char-tess',
    utilityBot: false,
    chatPage: 0,
    chats: [makeChat()],
    ...overrides,
  } as unknown as character
}

function makeDatabase(overrides: Partial<Database> = {}): Database {
  const database = {
    currentChar: 0,
    characters: [makeCharacter()],
    personas: [{ id: 'persona-default', name: 'User', icon: '', personaPrompt: '', note: '' }],
    selectedPersona: 0,
    botPresets: [{ id: 'preset-default', name: 'Default' }],
    botPresetsId: 0,
    modules: [],
    enabledModules: [],
    globalChatVariables: {},
    jailbreakToggle: false,
    formatingOrder: ['main', 'description', 'chats'],
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
    ...overrides,
  } as unknown as Database
  if (!overrides.personas) {
    database.personas = [
      {
        id: 'persona-default',
        name: database.username ?? 'User',
        icon: database.userIcon ?? '',
        personaPrompt: database.personaPrompt ?? '',
        note: database.userNote ?? '',
      },
    ]
  }
  if (!overrides.botPresets) {
    database.botPresets = [
      {
        id: 'preset-default',
        name: 'Default',
        mainPrompt: database.mainPrompt,
        jailbreak: database.jailbreak,
        globalNote: database.globalNote,
        promptTemplate: database.promptTemplate,
        customPromptTemplateToggle: database.customPromptTemplateToggle,
        moduleIntergration: database.moduleIntergration,
        formatingOrder: database.formatingOrder,
        promptSettings: database.promptSettings,
      },
    ] as unknown as Database['botPresets']
  }
  if (!overrides.modelPresets) {
    database.modelPresets = [
      {
        id: 'model-preset-default',
        name: 'Default Model',
        aiModel: database.aiModel,
        subModel: database.subModel,
        apiType: database.apiType,
        maxContext: database.maxContext,
        maxResponse: database.maxResponse,
        temperature: database.temperature,
      },
    ] as unknown as Database['modelPresets']
  }
  if (!overrides.promptPresets) {
    database.promptPresets = (database.botPresets ?? []).map((preset: Record<string, unknown>) =>
      structuredClone(preset),
    ) as unknown as Database['promptPresets']
  }
  database.modelPresetsId = Number.isInteger(database.modelPresetsId) ? database.modelPresetsId : 0
  database.promptPresetsId = Number.isInteger(database.promptPresetsId) ? database.promptPresetsId : 0
  for (const character of database.characters ?? []) {
    for (const chat of character.chats ?? []) {
      if (Object.prototype.hasOwnProperty.call(chat, 'generationSettings')) continue
      chat.generationSettings = {
        configured: true,
        personaId: database.personas?.[0]?.id ?? 'persona-default',
        modelPresetId: database.modelPresets?.[0]?.id ?? 'model-preset-default',
        promptPresetId: database.promptPresets?.[0]?.id ?? 'preset-default',
        jailbreakToggle: database.jailbreakToggle === true,
        sidebarToggles: {},
      }
    }
  }
  return database
}

function depsFor(db: Database | null, overrides: Partial<Omit<AssembleDeps, 'loadDatabase'>> = {}): AssembleDeps {
  return { loadDatabase: () => db, ...overrides }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeDeep(nested)
    }
    Object.freeze(value)
  }
  return value
}

const baseInput = (overrides: Partial<AssembleInput> = {}): AssembleInput => ({
  chatId: 'chat-1',
  characterId: 'char-tess',
  mode: 'send',
  userMessage: 'hi',
  ...overrides,
})

function agentPresetStep(overrides: Partial<AgentPresetStepRecord> = {}): AgentPresetStepRecord {
  return {
    id: 'aps_context',
    name: 'Gather Context',
    enabled: true,
    phase: 'beforeMain',
    dependencies: [],
    instruction: 'Gather useful context.',
    model: { mode: 'inheritMain' },
    runtime: { maxInputChars: 2_000, maxOutputChars: 200, timeoutMs: 5_000 },
    inputScopes: ['currentUserMessage'],
    outputKey: 'context',
    outputFormat: 'text',
    destination: 'promptOutput',
    failurePolicy: { mode: 'required' },
    ...overrides,
  }
}

function expectIncompleteAssembly(
  db: Database,
  expectedCodes: string[],
): ChatGenerationSettingsIncompleteAssemblyError {
  try {
    beginAssembly(baseInput(), depsFor(db))
  } catch (err) {
    expect(err).toBeInstanceOf(ChatGenerationSettingsIncompleteAssemblyError)
    const incomplete = err as ChatGenerationSettingsIncompleteAssemblyError
    expect(incomplete.body).toMatchObject({
      statusCode: 409,
      error: 'chat_generation_settings_incomplete',
      chatId: 'chat-1',
    })
    const actualCodes = incomplete.body.missing.map((reason) => reason.code)
    for (const code of expectedCodes) {
      expect(actualCodes).toContain(code)
    }
    return incomplete
  }
  throw new Error('Expected ChatGenerationSettingsIncompleteAssemblyError')
}

describe('prompt summary hashes', () => {
  it('produces a stable metadata-only summary without raw prompt strings', () => {
    const rows: PromptMessage[] = [
      {
        role: 'system',
        content: 'slice-2-secret-content',
        name: 'slice-2-secret-name',
        memo: 'slice-2-secret-memo',
        attr: ['slice-2-secret-attr'],
        thoughts: ['slice-2-secret-thought'],
        removable: true,
        cachePoint: true,
        multimodals: [
          {
            type: 'image',
            width: 64,
            height: 32,
            base64: 'slice-2-secret-base64',
          },
        ],
      },
      { role: 'user', content: { nested: 'slice-2-secret-object' } as unknown as string },
    ]

    const first = summarizePromptRows(rows)
    const second = summarizePromptRows(structuredClone(rows))

    expect(second).toEqual(first)
    expect(first.promptHash).toMatch(/^[a-f0-9]{64}$/)
    const metricFields = promptSummaryMetricFields(first)
    expect(metricFields).toMatchObject({
      promptHash: first.promptHash,
      promptRowCount: first.rowCount,
      promptRows: first.rows,
    })
    const json = JSON.stringify({ first, metricFields })
    for (const sentinel of [
      'slice-2-secret-content',
      'slice-2-secret-name',
      'slice-2-secret-memo',
      'slice-2-secret-attr',
      'slice-2-secret-thought',
      'slice-2-secret-base64',
      'slice-2-secret-object',
    ]) {
      expect(json).not.toContain(sentinel)
    }
  })

  it('changes the hash for content, name, memo, cachePoint, and multimodal metadata changes', () => {
    const base: PromptMessage[] = [
      {
        role: 'user',
        content: 'base prompt',
        name: 'base-name',
        memo: 'base-memo',
        cachePoint: true,
        multimodals: [{ type: 'image', width: 4, height: 5, base64: 'base64-a' }],
      },
    ]
    const baseHash = summarizePromptRows(base).promptHash
    const cases: Array<[string, PromptMessage[]]> = [
      ['content', [{ ...base[0], content: 'changed prompt' }]],
      ['name', [{ ...base[0], name: 'changed-name' }]],
      ['memo', [{ ...base[0], memo: 'changed-memo' }]],
      ['cachePoint', [{ ...base[0], cachePoint: false }]],
      ['multimodal', [{ ...base[0], multimodals: [{ type: 'image', width: 6, height: 5, base64: 'base64-b' }] }]],
    ]

    for (const [label, rows] of cases) {
      expect(summarizePromptRows(rows).promptHash, label).not.toBe(baseHash)
    }
  })

  it('attaches the final budgeted prompt summary to assembly results', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'assembly summary main',
      characters: [
        makeCharacter({
          chats: [makeChat({ id: 'chat-1', message: [{ role: 'user', data: 'history row' }] as Message[] })],
        }),
      ],
    })

    const result = await assemblePrompt(baseInput({ userMessage: 'assembly summary user' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.promptSummary).toEqual(summarizePromptRows(result.formated ?? []))
  })

  it('runs before-main Agent Preset steps and expands {{agent::name}}', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Agent context:\n{{agent::context}}',
      agentPresets: [
        {
          id: 'ap_research',
          name: 'Research Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep()],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_research',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'success' as const,
      stepId: 'aps_context',
      stepName: 'Gather Context',
      outputKey: 'context',
      outputText: 'source-backed agent context',
      outputTruncated: false,
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'promptOutput' as const,
        failurePolicy: 'required' as const,
        inputChars: 12,
        outputChars: 27,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const result = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(executeAgentPresetStep).toHaveBeenCalledTimes(1)
    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.map((row) => row.content).join('\n')).toContain('source-backed agent context')
  })

  it('preflights required inputs for every Agent phase before executing any step', async () => {
    const db = makeDatabase({
      agentPresets: [
        {
          id: 'ap_required_input',
          name: 'Required Input Agent',
          enabled: true,
          version: 1,
          steps: [
            agentPresetStep(),
            agentPresetStep({
              id: 'aps_after',
              name: 'After Main',
              phase: 'afterMain',
              instruction: 'Reference:\n{{agentInput::reference}}',
              lorebookInputs: [{ key: 'reference', displayName: 'Reference Notes', required: true }],
              outputKey: 'after',
              destination: 'intermediate',
            }),
          ],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_required_input',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn()

    await expect(assemblePrompt(baseInput(), depsFor(db, { executeAgentPresetStep }))).rejects.toThrow(
      'Required Agent lorebook input was not found: Reference Notes',
    )
    expect(executeAgentPresetStep).not.toHaveBeenCalled()
  })

  it('runs the global default Agent Preset when the chat has no explicit selection', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Agent context:\n{{agent::context}}',
      agentPresetDefaultId: 'ap_research',
      agentPresets: [
        {
          id: 'ap_research',
          name: 'Research Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep()],
        },
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'success' as const,
      stepId: 'aps_context',
      stepName: 'Gather Context',
      outputKey: 'context',
      outputText: 'global-default context',
      outputTruncated: false,
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'promptOutput' as const,
        failurePolicy: 'required' as const,
        inputChars: 12,
        outputChars: 22,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const result = await assemblePrompt(baseInput(), depsFor(db, { executeAgentPresetStep }))

    expect(executeAgentPresetStep).toHaveBeenCalledTimes(1)
    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.map((row) => row.content).join('\n')).toContain('global-default context')
  })

  it('lets the last before-main modifier replace the latest user input before prompt rendering', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      formatingOrder: ['main', 'description', 'chats', 'lastChat'],
      agentPresets: [
        {
          id: 'ap_input',
          name: 'Input Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep({ id: 'aps_input', outputKey: 'input', destination: 'userInput' })],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                { role: 'user', data: 'older user turn', chatId: 'older-user' },
                { role: 'char', data: 'older assistant turn', chatId: 'older-assistant' },
              ] as Message[],
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_input',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async (input) => {
      expect(input.currentUserMessage).toBe('raw latest user turn')
      return {
        status: 'success' as const,
        stepId: 'aps_input',
        stepName: 'Gather Context',
        outputKey: 'input',
        outputText: 'rewritten latest user turn',
        outputTruncated: false,
        diagnostics: {
          phase: 'beforeMain' as const,
          outputFormat: 'text' as const,
          destination: 'userInput' as const,
          failurePolicy: 'required' as const,
          inputChars: 20,
          outputChars: 26,
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          preparedInputSections: [],
          preparedInputDiagnostics: [],
          parseStatus: 'not_applicable' as const,
        },
      }
    })

    const result = await assemblePrompt(
      baseInput({ userMessage: 'raw latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.filter((row) => row.role === 'user').map((row) => row.content)).toEqual([
      'older user turn',
      'rewritten latest user turn',
    ])
    expect(result.state?.agentPreset?.promptOutputs).toEqual({})
    expect(result.state?.agentPreset?.userInputModified).toBe(true)
    expect(result.submitTranscriptChanged).toBe(true)
    expect(result.submitMessages?.at(-1)?.data).toBe('rewritten latest user turn')
    expect(result.mutations?.messageMutations.at(-1)).toMatchObject({
      type: 'replace_all',
      source: 'agent_preset',
    })
    expect(db.characters[0].chats[0].message?.at(-1)?.data).toBe('older assistant turn')
  })

  it('keeps the regenerate target in the authoritative submit snapshot after an Agent Preset input rewrite', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      formatingOrder: ['main', 'description', 'chats', 'lastChat'],
      agentPresets: [
        {
          id: 'ap_input',
          name: 'Input Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep({ id: 'aps_input', outputKey: 'input', destination: 'userInput' })],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                { role: 'user', data: 'raw latest user turn', chatId: 'latest-user' },
                { role: 'char', data: 'old assistant target', chatId: 'assistant-target', saying: 'char-1' },
              ] as Message[],
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_input',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'success' as const,
      stepId: 'aps_input',
      stepName: 'Rewrite Input',
      outputKey: 'input',
      outputText: 'rewritten latest user turn',
      outputTruncated: false,
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'userInput' as const,
        failurePolicy: 'required' as const,
        inputChars: 20,
        outputChars: 26,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const result = await assemblePrompt(
      baseInput({
        mode: 'regenerate',
        userMessage: undefined,
        regenerateMessageId: 'assistant-target',
      }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(result.submitTranscriptChanged).toBe(true)
    expect(result.submitMessages).toEqual([
      expect.objectContaining({ chatId: 'latest-user', data: 'rewritten latest user turn' }),
      expect.objectContaining({ chatId: 'assistant-target', data: 'old assistant target' }),
    ])
    expect(result.state?.currentChat.message.some((message) => message.chatId === 'assistant-target')).toBe(false)
  })

  it('blocks assembly on required before-main Agent Preset failure', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Agent context:\n{{agent::context}}',
      agentPresets: [
        {
          id: 'ap_research',
          name: 'Research Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep()],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_research',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'failed' as const,
      stepId: 'aps_context',
      stepName: 'Gather Context',
      outputKey: 'context',
      failureKind: 'provider_error' as const,
      failurePolicyOutcome: 'required_failure' as const,
      error: 'provider exploded',
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'promptOutput' as const,
        failurePolicy: 'required' as const,
        inputChars: 12,
        outputChars: 0,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    await expect(
      assemblePrompt(baseInput({ userMessage: 'latest user turn' }), depsFor(db, { executeAgentPresetStep })),
    ).rejects.toThrow(/Agent Preset step failed: Gather Context/)
    expect(executeAgentPresetStep).toHaveBeenCalledTimes(1)
  })

  it('continues assembly with an empty expansion after optional before-main failure', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Agent context:<{{agent::context}}>END',
      agentPresets: [
        {
          id: 'ap_research',
          name: 'Research Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep({ failurePolicy: { mode: 'optional' } })],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_research',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'failed' as const,
      stepId: 'aps_context',
      stepName: 'Gather Context',
      outputKey: 'context',
      failureKind: 'provider_error' as const,
      failurePolicyOutcome: 'optional_failure' as const,
      error: 'provider exploded',
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'promptOutput' as const,
        failurePolicy: 'optional' as const,
        inputChars: 12,
        outputChars: 0,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const result = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.map((row) => row.content).join('\n')).toContain('Agent context:<>END')
  })

  it('does not treat {{slot::agent}} as an Agent Preset alias', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Agent context:\n{{slot::agent}}',
      agentPresets: [
        {
          id: 'ap_research',
          name: 'Research Agent',
          enabled: true,
          version: 1,
          steps: [agentPresetStep()],
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_research',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'success' as const,
      stepId: 'aps_context',
      stepName: 'Gather Context',
      outputKey: 'context',
      outputText: 'slot alias should not appear',
      outputTruncated: false,
      diagnostics: {
        phase: 'beforeMain' as const,
        outputFormat: 'text' as const,
        destination: 'promptOutput' as const,
        failurePolicy: 'required' as const,
        inputChars: 12,
        outputChars: 28,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const result = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(executeAgentPresetStep).toHaveBeenCalledTimes(1)
    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.map((row) => row.content).join('\n')).not.toContain('slot alias should not appear')
  })

  it('does not run legacy Context Agent settings for {{agent}}', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'Legacy context:\n{{agent}}',
      agentContextEnabled: true,
      agentContextPrompt: 'Find relevant background.',
    })
    const executeAgentPresetStep = vi.fn()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )

    expect(executeAgentPresetStep).not.toHaveBeenCalled()
    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    expect(result.formated?.map((row) => row.content).join('\n')).not.toContain('Find relevant background')
  })

  it('runs after-main Agent Preset steps after editoutput and stores diagnostics', async () => {
    const afterStep = agentPresetStep({
      id: 'aps_after',
      name: 'Rewrite Output',
      phase: 'afterMain',
      outputKey: 'rewrite',
      destination: 'finalOutput',
      inputScopes: ['mainDraft'],
    })
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      agentPresets: [
        {
          id: 'ap_after',
          name: 'After Agent',
          enabled: true,
          version: 1,
          steps: [afterStep],
        },
      ],
      characters: [
        makeCharacter({
          customscript: [
            { in: 'assistant reply', out: 'edited reply', type: 'editoutput', flag: '', ableFlag: false },
          ] as never,
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_after',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async (input) => {
      expect(input.mainDraft).toBe('edited reply')
      return {
        status: 'success' as const,
        stepId: 'aps_after',
        stepName: 'Rewrite Output',
        outputKey: 'rewrite',
        outputText: `agent saw ${input.mainDraft}`,
        outputTruncated: false,
        diagnostics: {
          phase: 'afterMain' as const,
          outputFormat: 'text' as const,
          destination: 'finalOutput' as const,
          failurePolicy: 'required' as const,
          inputChars: 12,
          outputChars: 22,
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          preparedInputSections: [],
          preparedInputDiagnostics: [],
          parseStatus: 'not_applicable' as const,
        },
      }
    })

    const assembled = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )
    expect(assembled.stopSending).toBe(false)
    if (assembled.stopSending) return

    const generationInfo: Record<string, unknown> = {}
    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'assistant reply',
      generationId: 'generation-after',
      generationInfo,
    })

    expect(post.finalText).toBe('agent saw edited reply')
    expect(post.textChanged).toBe(true)
    expect(post.agentPresetError).toBeUndefined()
    expect(generationInfo.agentPreset).toMatchObject({
      status: 'ready',
      presetId: 'ap_after',
      finalTextModified: true,
      mainOutputPreview: 'edited reply',
    })
  })

  it('composes the final response from mainOutput and multiple named Agent outputs through CBS', async () => {
    const contextStep = agentPresetStep({
      id: 'aps_context',
      name: 'Context',
      outputKey: 'context',
      destination: 'intermediate',
    })
    const statusStep = agentPresetStep({
      id: 'aps_status',
      name: 'Status',
      phase: 'afterMain',
      outputKey: 'status',
      destination: 'intermediate',
      inputScopes: ['mainDraft'],
    })
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      agentPresets: [
        {
          id: 'ap_composed',
          name: 'Composed Agent',
          enabled: true,
          version: 1,
          finalOutputTemplate: 'Main:\n{{slot::mainOutput}}\nContext: {{agent::context}}\nStatus: {{agent::status}}',
          steps: [contextStep, statusStep],
        },
      ],
      characters: [
        makeCharacter({
          customscript: [
            { in: 'assistant reply', out: 'edited reply', type: 'editoutput', flag: '', ableFlag: false },
          ] as never,
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_composed',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async (input) => {
      const outputText = input.step.id === 'aps_context' ? 'source-backed context' : 'ready'
      return {
        status: 'success' as const,
        stepId: input.step.id,
        stepName: input.step.name,
        outputKey: input.step.outputKey,
        outputText,
        outputTruncated: false,
        diagnostics: {
          phase: input.step.phase,
          outputFormat: 'text' as const,
          destination: input.step.destination,
          failurePolicy: 'required' as const,
          inputChars: 0,
          outputChars: outputText.length,
          startedAt: 1,
          endedAt: 2,
          durationMs: 1,
          preparedInputSections: [],
          preparedInputDiagnostics: [],
          parseStatus: 'not_applicable' as const,
        },
      }
    })

    const assembled = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )
    expect(assembled.stopSending).toBe(false)
    if (assembled.stopSending) return

    const generationInfo: Record<string, unknown> = {}
    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'assistant reply',
      generationId: 'generation-composed',
      generationInfo,
    })

    expect(executeAgentPresetStep).toHaveBeenCalledTimes(2)
    expect(post.finalText).toBe('Main:\nedited reply\nContext: source-backed context\nStatus: ready')
    expect(generationInfo.agentPreset).toMatchObject({
      status: 'ready',
      presetId: 'ap_composed',
      finalOutputComposed: true,
      finalTextModified: true,
      mainOutputPreview: 'edited reply',
    })
  })

  it('preserves the post-editoutput text when required after-main fails', async () => {
    const afterStep = agentPresetStep({
      id: 'aps_after',
      name: 'Rewrite Output',
      phase: 'afterMain',
      outputKey: 'rewrite',
      destination: 'finalOutput',
      inputScopes: ['mainDraft'],
      failurePolicy: { mode: 'required' },
    })
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      agentPresets: [
        {
          id: 'ap_after',
          name: 'After Agent',
          enabled: true,
          version: 1,
          steps: [afterStep],
        },
      ],
      characters: [
        makeCharacter({
          customscript: [
            { in: 'assistant reply', out: 'edited reply', type: 'editoutput', flag: '', ableFlag: false },
          ] as never,
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'ap_after',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    const executeAgentPresetStep = vi.fn(async () => ({
      status: 'failed' as const,
      stepId: 'aps_after',
      stepName: 'Rewrite Output',
      outputKey: 'rewrite',
      failureKind: 'provider_error' as const,
      failurePolicyOutcome: 'required_failure' as const,
      error: 'provider exploded',
      diagnostics: {
        phase: 'afterMain' as const,
        outputFormat: 'text' as const,
        destination: 'finalOutput' as const,
        failurePolicy: 'required' as const,
        inputChars: 12,
        outputChars: 0,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        preparedInputSections: [],
        preparedInputDiagnostics: [],
        parseStatus: 'not_applicable' as const,
      },
    }))

    const assembled = await assemblePrompt(
      baseInput({ userMessage: 'latest user turn' }),
      depsFor(db, { executeAgentPresetStep }),
    )
    expect(assembled.stopSending).toBe(false)
    if (assembled.stopSending) return

    const generationInfo: Record<string, unknown> = {}
    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'assistant reply',
      generationId: 'generation-after',
      generationInfo,
    })

    expect(post.finalText).toBe('edited reply')
    expect(post.agentPresetError).toMatchObject({
      error: 'agent_preset_generation_failed',
      stepId: 'aps_after',
      failureKind: 'provider_error',
      failurePolicyOutcome: 'required_failure',
    })
    expect(generationInfo.agentPreset).toMatchObject({
      finalTextModified: false,
      mainOutputPreview: 'edited reply',
      failure: { stepId: 'aps_after' },
    })
  })

  it('makes Remove Incomplete Response authoritative in server post-generation', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      removeIncompleteResponse: true,
      characters: [makeCharacter({ chats: [makeChat({ id: 'chat-1' })] })],
    })
    const assembled = await assemblePrompt(baseInput({ userMessage: 'hello' }), depsFor(db))
    expect(assembled.stopSending).toBe(false)
    if (assembled.stopSending) return

    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'Complete sentence. unfinished fragment',
      generationId: 'generation-trim',
    })

    expect(post.finalText).toBe('Complete sentence. ')
    expect(assembled.state?.currentChat.message.at(-1)).toMatchObject({
      role: 'char',
      data: 'Complete sentence. ',
      chatId: 'generation-trim',
    })
  })
})

describe('async asset reads', () => {
  it('repeated asset prompt refs share one async stored-asset read during assembly', async () => {
    const assetId = 'c'.repeat(64)
    const reads: string[] = []
    const resolveStoredAsset = createRequestScopedStoredAssetResolver(
      null as never,
      '/data',
      async (_db, _dataDir, id, purpose) => {
        await Promise.resolve()
        reads.push(`${purpose}:${id}`)
        return { type: 'image', base64: `data:${purpose}:${id}` }
      },
    )
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      characters: [
        makeCharacter({
          firstMessage: '',
          additionalAssets: [['hero', assetId, '']],
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                {
                  role: 'user',
                  data: 'show {{asset_prompt::hero}} and {{asset_prompt::hero}}',
                  chatId: 'repeated-asset-row',
                } as Message,
              ],
            }),
          ],
        } as Partial<character>),
      ],
    } as unknown as Partial<Database>)

    const currentChar = db.characters[0]
    const currentChat = currentChar.chats[0]
    const history = await buildHistoryWindow(
      { database: db },
      currentChar,
      currentChat,
      false,
      buildAssetLookup({
        database: db,
        currentChar,
        currentChat,
        inlayAssets: undefined,
        resolveStoredAsset,
      }),
    )

    const row = history.messages.find((entry) => entry.memo === 'repeated-asset-row')
    expect(row?.content).toBe('show  and ')
    expect(row?.multimodals).toEqual([
      { type: 'image', base64: `data:asset_prompt:${assetId}` },
      { type: 'image', base64: `data:asset_prompt:${assetId}` },
    ])
    expect(reads).toEqual([`asset_prompt:${assetId}`])
  })
})

describe('per-assembly asset table', () => {
  it('shares one char+module asset table across lookup and history without changing winners', async () => {
    resetPromptAssetTableInstrumentation()
    const resolved: string[] = []
    const resolveStoredAsset = async (reference: string) => {
      resolved.push(reference)
      return { type: 'image' as const, base64: `data:image/png;base64,${reference}` }
    }
    const db = makeDatabase({
      enabledModules: ['mod-assets'],
      modules: [
        {
          id: 'mod-assets',
          assets: [
            ['hero', 'module-loses', ''],
            ['moduleOnly', 'module-wins', ''],
          ],
        },
      ],
      characters: [
        makeCharacter({
          image: 'icon-ref',
          firstMessage: '',
          additionalAssets: [
            ['hero', 'char-wins', ''],
            ['hero', 'char-loses', ''],
          ],
          chats: [
            makeChat({
              message: [
                {
                  role: 'user',
                  data: [
                    'A',
                    '{{asset_prompt::hero}}',
                    '{{asset_prompt::moduleOnly}}',
                    '{{asset_prompt::icon}}',
                    '{{asset_prompt::missing}}',
                  ].join(' '),
                  chatId: 'asset-table-row',
                } as Message,
              ],
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)
    const currentChar = db.characters[0]
    const currentChat = currentChar.chats[0]
    const lookup = buildAssetLookup({
      database: db,
      currentChar,
      currentChat,
      inlayAssets: undefined,
      resolveStoredAsset,
    })

    const history = await buildHistoryWindow({ database: db }, currentChar, currentChat, false, lookup)

    const row = history.messages.find((entry) => entry.memo === 'asset-table-row')
    expect(row?.content).toBe('A    ')
    expect(row?.multimodals).toEqual([
      { type: 'image', base64: 'data:image/png;base64,char-wins' },
      { type: 'image', base64: 'data:image/png;base64,module-wins' },
      { type: 'image', base64: 'data:image/png;base64,icon-ref' },
    ])
    expect(resolved).toEqual(['char-wins', 'module-wins', 'icon-ref'])
    expect(getPromptAssetTableInstrumentation()).toEqual({ builds: 1 })
  })
})

describe('dispatch and restoration clone narrowing', () => {
  it('returns default OpenAI-flag rows by reference without mutation or prompt clones', () => {
    resetChatDispatchReformatInstrumentation()
    const rows = freezeDeep([
      {
        role: 'system',
        content: 'system row',
        multimodals: [{ type: 'image', base64: 'data:image/png;base64,AAAA' }],
      },
      { role: 'user', content: 'hello' },
    ] satisfies PromptMessage[]) as PromptMessage[]
    const before = JSON.stringify(rows)

    const result = reformatMessages(makeDatabase(), rows, [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming])

    expect(result).toBe(rows)
    expect(JSON.stringify(rows)).toBe(before)
    expect(getChatDispatchReformatInstrumentation().fullPromptClones).toBe(0)
  })

  it.each([
    {
      name: 'system role replacement',
      db: makeDatabase(),
      flags: [],
      rows: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ] satisfies PromptMessage[],
      expected: [
        { role: 'user', content: 'system: sys' },
        { role: 'user', content: 'hi' },
      ],
    },
    {
      name: 'empty system role replacement',
      db: makeDatabase({ systemRoleReplacement: '' as never }),
      flags: [],
      rows: [{ role: 'system', content: 'sys' }] satisfies PromptMessage[],
      expected: [{ role: 'user', content: 'system: sys' }],
    },
    {
      name: 'first system hoist',
      db: makeDatabase(),
      flags: [LLMFlags.hasFirstSystemPrompt],
      rows: [
        { role: 'system', content: 'sys one' },
        { role: 'system', content: 'sys two' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'inner' },
      ] satisfies PromptMessage[],
      expected: [
        { role: 'system', content: 'sys one\n\nsys two' },
        { role: 'user', content: 'hi' },
        { role: 'user', content: 'system: inner' },
      ],
    },
    {
      name: 'alternate role merge',
      db: makeDatabase(),
      flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.requiresAlternateRole],
      rows: [
        {
          role: 'user',
          content: 'one',
          multimodals: [{ type: 'image', base64: 'one' }],
          cachePoint: true,
        },
        {
          role: 'user',
          content: 'two',
          multimodals: [{ type: 'image', base64: 'two' }],
          thoughts: ['think'],
        },
        { role: 'assistant', content: 'reply' },
      ] satisfies PromptMessage[],
      expected: [
        {
          role: 'user',
          content: 'one\ntwo',
          multimodals: [
            { type: 'image', base64: 'one' },
            { type: 'image', base64: 'two' },
          ],
          cachePoint: true,
          thoughts: ['think'],
        },
        { role: 'assistant', content: 'reply' },
      ],
    },
    {
      name: 'must start with user',
      db: makeDatabase(),
      flags: [LLMFlags.hasFullSystemPrompt, LLMFlags.mustStartWithUserInput],
      rows: [{ role: 'assistant', content: 'prefill' }] satisfies PromptMessage[],
      expected: [
        { role: 'user', content: ' ' },
        { role: 'assistant', content: 'prefill' },
      ],
    },
  ])('preserves byte-identical output and isolation for $name', ({ db, flags, rows, expected }) => {
    resetChatDispatchReformatInstrumentation()
    const sourceRows = rows as PromptMessage[]
    const originalRows = structuredClone(sourceRows)

    const result = reformatMessages(db, sourceRows, flags)

    expect(result).not.toBe(sourceRows)
    expect(JSON.stringify(result)).toBe(JSON.stringify(expected))
    expect(sourceRows).toEqual(originalRows)
    expect(result.some((row) => sourceRows.includes(row))).toBe(false)
    expect(getChatDispatchReformatInstrumentation().fullPromptClones).toBe(1)
  })

  it('returns immutable initial restoration messages by reference and clones scriptstate', () => {
    const initialMessages = freezeDeep([
      { role: 'user', data: 'before', chatId: 'msg-1' },
    ] satisfies Message[]) as Message[]
    const initialScriptstate = { $mood: 'calm' }
    const state = {
      input: baseInput(),
      selectedCharID: 0,
      chatPage: 0,
      initialMessages,
      initialScriptstate,
    } as unknown as ReturnType<typeof beginAssembly>

    const restoration = buildRestorationPayload(state)

    expect(restoration.messages).toBe(initialMessages)
    expect(restoration.messages).toEqual([{ role: 'user', data: 'before', chatId: 'msg-1' }])
    expect(restoration.scriptstate).toEqual(initialScriptstate)
    expect(restoration.scriptstate).not.toBe(initialScriptstate)
    expect(() => restoration.messages.push({ role: 'char', data: 'mutate' } as Message)).toThrow()
  })
})

const startTrigger = (effect: unknown[]): never => ({ comment: '', type: 'start', conditions: [], effect }) as never

function memoryEnabledDatabase(overrides: Partial<Database> = {}): Database {
  const message = [
    { role: 'user', data: 'hello', chatId: 'chat-1' },
    { role: 'char', data: 'hi there', chatId: 'chat-1' },
  ] as never
  return makeDatabase({
    maxResponse: 10,
    maxContext: 100_000,
    hypaV3: true,
    hypaModel: 'embedding-model' as never,
    hypaV3Presets: [
      {
        id: 'test-memory',
        name: 'Test',
        settings: {
          summarizationModel: 'summary-model',
          memoryTokensRatio: 0.2,
          recentMemoryRatio: 0,
          similarMemoryRatio: 1,
        },
      },
    ] as never,
    selectedHypaV3PresetId: 'test-memory',
    hypaV3PresetId: 0,
    characters: [
      makeCharacter({
        supaMemory: true,
        firstMessage: 'Greetings.',
        chats: [makeChat({ id: 'chat-1', message })],
      } as Partial<character>),
    ],
    ...overrides,
  } as Partial<Database>)
}

describe('resolveScope (via beginAssembly)', () => {
  it('throws EntityNotFoundError when the database is missing', () => {
    expect(() => beginAssembly(baseInput(), depsFor(null))).toThrow(EntityNotFoundError)
  })

  it('throws EntityNotFoundError for an unknown characterId', () => {
    const db = makeDatabase()
    expect(() => beginAssembly(baseInput({ characterId: 'nope' }), depsFor(db))).toThrow(EntityNotFoundError)
  })

  it('throws EntityNotFoundError for an unknown chatId', () => {
    const db = makeDatabase()
    expect(() => beginAssembly(baseInput({ chatId: 'nope' }), depsFor(db))).toThrow(EntityNotFoundError)
  })

  it('resolves explicit character / chat IDs to their indices', () => {
    const db = makeDatabase({
      currentChar: 0,
      characters: [
        makeCharacter({ chaId: 'char-a', chats: [makeChat({ id: 'a0' })] }),
        makeCharacter({
          chaId: 'char-b',
          chatPage: 0,
          chats: [makeChat({ id: 'b0' }), makeChat({ id: 'b1', name: 'second' })],
        }),
      ],
    } as unknown as Partial<Database>)

    const state = beginAssembly(baseInput({ characterId: 'char-b', chatId: 'b1' }), depsFor(db))
    expect(state.selectedCharID).toBe(1)
    expect(state.chatPage).toBe(1)
    expect(state.currentChar.chaId).toBe('char-b')
    expect(state.currentChat.id).toBe('b1')
  })

  it('keeps CBS chat-history helpers aligned with the working send transcript', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [
        {
          type: 'plain',
          type2: 'main',
          role: 'system',
          text: 'last={{lastmessage}}\nprev={{previous_chat_log::{{lastmessageid}}}}',
        },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                { role: 'user', data: 'older user', chatId: 'msg-old-user' },
                { role: 'char', data: 'older assistant', chatId: 'msg-old-assistant' },
              ] as Message[],
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const result = await assemblePrompt(baseInput({ userMessage: 'latest user turn' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    const rendered = (result.formated ?? []).map((row) => row.content).join('\n')
    expect(rendered).toContain('last=latest user turn')
    expect(rendered).toContain('prev=latest user turn')
    expect(rendered).not.toContain('last=older assistant')
  })

  it('uses the requested chat as the active CBS history scope even when chatPage points elsewhere', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [
        {
          type: 'plain',
          type2: 'main',
          role: 'system',
          text: 'last={{lastmessage}}',
        },
      ],
      characters: [
        makeCharacter({
          chatPage: 0,
          chats: [
            makeChat({
              id: 'chat-a',
              message: [{ role: 'user', data: 'wrong active chat', chatId: 'msg-a' }] as Message[],
            }),
            makeChat({
              id: 'chat-b',
              message: [{ role: 'user', data: 'target chat prior', chatId: 'msg-b' }] as Message[],
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const result = await assemblePrompt(baseInput({ chatId: 'chat-b', userMessage: 'target chat latest' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    if (result.stopSending) return
    const rendered = (result.formated ?? []).map((row) => row.content).join('\n')
    expect(rendered).toContain('last=target chat latest')
    expect(rendered).not.toContain('wrong active chat')
  })

  it('returns the stable incomplete error for an imported chat with absent settings', () => {
    const db = makeDatabase({
      characters: [makeCharacter({ chats: [makeChat({ id: 'chat-1' })] })],
    } as unknown as Partial<Database>)
    delete db.characters[0].chats[0].generationSettings

    expectIncompleteAssembly(db, ['settings_missing', 'settings_not_configured'])
  })

  it('returns the stable incomplete error for an imported chat not marked configured', () => {
    const db = makeDatabase({
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: false,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    expectIncompleteAssembly(db, ['settings_not_configured'])
  })

  it('treats deleted preset and persona references as incomplete chat settings', () => {
    const deletedPresetDb = makeDatabase({
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'deleted-preset',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)
    expectIncompleteAssembly(deletedPresetDb, ['prompt_preset_missing'])

    const deletedPersonaDb = makeDatabase({
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'deleted-persona',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)
    expectIncompleteAssembly(deletedPersonaDb, ['persona_missing'])

    const deletedAgentPresetDb = makeDatabase({
      agentPresets: [{ id: 'agent-preset-default', name: 'Default Agent', enabled: true, version: 1, steps: [] }],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                agentPresetId: 'deleted-agent-preset',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)
    expectIncompleteAssembly(deletedAgentPresetDb, ['agent_preset_missing'])
  })

  it('requires displayed sidebar toggles and preserves explicit off values', () => {
    const baseWithToggle = {
      botPresets: [
        {
          id: 'preset-default',
          name: 'Default',
          mainPrompt: '{{#when::toggle::mode}}ON{{/when}}{{#when::mode::tis::0}}OFF{{/when}}',
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
    } as unknown as Partial<Database>
    const missingToggleDb = makeDatabase({
      ...baseWithToggle,
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    })
    expectIncompleteAssembly(missingToggleDb, ['sidebar_toggle_missing'])

    const explicitOffDb = makeDatabase({
      ...baseWithToggle,
      globalChatVariables: { toggle_mode: '1' },
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-default',
                jailbreakToggle: false,
                sidebarToggles: { mode: '0' },
              },
            }),
          ],
        }),
      ],
    })
    const state = beginAssembly(baseInput(), depsFor(explicitOffDb))
    fillStaticSlots(state)

    expect(state.database.globalChatVariables!.toggle_mode).toBe('0')
    expect(state.unformated.main.map((row) => row.content)).toEqual(['OFF'])
  })

  it('builds an effective prompt database from chat-owned preset, persona, and toggles', () => {
    const db = makeDatabase({
      mainPrompt: 'GLOBAL MAIN',
      jailbreak: 'GLOBAL JB',
      globalNote: 'GLOBAL NOTE',
      personaPrompt: 'GLOBAL PERSONA',
      jailbreakToggle: false,
      globalChatVariables: { toggle_mode: 'global', kept: 'yes' },
      personas: [
        {
          id: 'persona-global',
          name: 'Global User',
          icon: 'global-icon',
          personaPrompt: 'GLOBAL PERSONA',
          note: 'GLOBAL NOTE',
        },
        {
          id: 'persona-chat',
          name: 'Chat User',
          icon: 'chat-icon',
          personaPrompt: 'CHAT PERSONA',
          note: 'CHAT NOTE',
        },
      ],
      botPresets: [
        { id: 'preset-global', name: 'Global', mainPrompt: 'GLOBAL MAIN' },
        {
          id: 'preset-chat',
          name: 'Chat',
          mainPrompt: 'CHAT MAIN {{toggle::mode::Mode}}',
          jailbreak: 'CHAT JB',
          globalNote: 'CHAT GLOBAL NOTE',
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
      botPresetsId: 0,
      selectedPersona: 0,
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-chat',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-chat',
                jailbreakToggle: true,
                sidebarToggles: { mode: '1' },
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))

    expect(state.database).not.toBe(db)
    expect(state.ctx.database).toBe(state.database)
    expect(state.modelPresetId).toBe('model-preset-default')
    expect(state.promptPresetId).toBe('preset-chat')
    expect(state.database.promptPresetsId).toBe(1)
    expect(state.database.mainPrompt).toBe('CHAT MAIN {{toggle::mode::Mode}}')
    expect(state.database.jailbreak).toBe('CHAT JB')
    expect(state.database.globalNote).toBe('CHAT GLOBAL NOTE')
    expect(state.database.selectedPersonaId).toBe('persona-chat')
    expect(state.database.selectedPersona).toBe(1)
    expect(state.database.username).toBe('Chat User')
    expect(state.database.userIcon).toBe('chat-icon')
    expect(state.database.personaPrompt).toBe('CHAT PERSONA')
    expect(state.database.userNote).toBe('CHAT NOTE')
    expect(state.database.globalChatVariables).toMatchObject({ kept: 'yes', toggle_mode: '1' })
    expect(state.database.jailbreakToggle).toBe(true)

    expect(db.botPresetsId).toBe(0)
    expect(db.selectedPersona).toBe(0)
    expect(db.mainPrompt).toBe('GLOBAL MAIN')
    expect(db.globalChatVariables).toEqual({ toggle_mode: 'global', kept: 'yes' })
    expect(db.jailbreakToggle).toBe(false)
  })

  it('uses selected preset module integration when resolving required sidebar toggles', () => {
    const db = makeDatabase({
      modules: [
        {
          id: 'module-a',
          name: 'Module A',
          description: '',
          namespace: 'ns-a',
          customModuleToggle: 'moduleMode=Module Mode',
        },
      ] as Database['modules'],
      enabledModules: [],
      moduleIntergration: '',
      botPresets: [
        {
          id: 'preset-chat',
          name: 'Chat',
          moduleIntergration: 'ns-a',
        },
      ],
      characters: [
        makeCharacter({
          modules: [],
          chats: [
            makeChat({
              modules: [],
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-chat',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    expect(() => beginAssembly(baseInput(), depsFor(db))).toThrow(ChatGenerationSettingsIncompleteAssemblyError)
  })

  it('fails closed when the chat-selected prompt owner is duplicated', () => {
    const db = makeDatabase({
      promptPresets: [
        { id: 'prompt-duplicate', name: 'Prompt A' },
        { id: 'prompt-duplicate', name: 'Prompt B' },
      ],
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'prompt-duplicate',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    expect(() => beginAssembly(baseInput(), depsFor(db))).toThrow(ChatGenerationSettingsIncompleteAssemblyError)
  })

  it('adds effective Agent Preset module integration to the selected Prompt Preset', () => {
    const db = makeDatabase({
      modules: [
        {
          id: 'module-prompt',
          name: 'Prompt Module',
          description: '',
          namespace: 'prompt-space',
          customModuleToggle: 'promptMode=Prompt Mode',
        },
        {
          id: 'module-agent',
          name: 'Agent Module',
          description: '',
          namespace: 'agent-space',
          customModuleToggle: 'agentMode=Agent Mode',
        },
      ] as Database['modules'],
      enabledModules: [],
      moduleIntergration: '',
      botPresets: [
        {
          id: 'preset-chat',
          name: 'Chat',
          moduleIntergration: 'prompt-space',
        },
      ],
      agentPresets: [
        {
          id: 'ap_modules',
          name: 'Module Agent Preset',
          enabled: true,
          version: 1,
          moduleIntergration: 'agent-space',
          steps: [],
        },
      ],
      characters: [
        makeCharacter({
          modules: [],
          chats: [
            makeChat({
              modules: [],
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-chat',
                agentPresetId: 'ap_modules',
                jailbreakToggle: false,
                sidebarToggles: { promptMode: '1', agentMode: '1' },
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))

    expect(state.database.moduleIntergration).toBe('prompt-space, agent-space')
    expect(state.database.globalChatVariables).toMatchObject({ toggle_promptMode: '1', toggle_agentMode: '1' })
    expect(db.moduleIntergration).toBe('')
  })

  it('clears stale global module integration when the chat selected prompt has none', () => {
    const db = makeDatabase({
      moduleIntergration: 'global-space',
      presetRegex: [{ id: 'global-regex', type: 'editprocess', in: 'GLOBAL', out: 'global' }],
      botPresets: [
        {
          id: 'global-preset',
          name: 'Global',
          moduleIntergration: 'global-space',
          presetRegex: [{ id: 'global-regex', type: 'editprocess', in: 'GLOBAL', out: 'global' }],
        },
        {
          id: 'chat-preset',
          name: 'Chat',
        },
      ],
      botPresetsId: 0,
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              generationSettings: {
                configured: true,
                personaId: 'persona-default',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'chat-preset',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))

    expect(state.database.moduleIntergration).toBe('')
    expect(state.database.presetRegex).toEqual([])
    expect(db.moduleIntergration).toBe('global-space')
    expect(db.presetRegex).toEqual([{ id: 'global-regex', type: 'editprocess', in: 'GLOBAL', out: 'global' }])
  })

  it('lets two chats produce different persona, preset, and toggle prompt output without global changes', () => {
    const db = makeDatabase({
      mainPrompt: 'GLOBAL MAIN',
      personaPrompt: 'GLOBAL PERSONA',
      globalChatVariables: { toggle_mode: 'global' },
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'PERSONA A', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'PERSONA B', note: '' },
      ],
      botPresets: [
        {
          id: 'preset-a',
          name: 'Preset A',
          mainPrompt: 'MAIN A {{#when::toggle::mode}}TOGGLE A{{/when}}',
          customPromptTemplateToggle: 'mode=Mode',
        },
        {
          id: 'preset-b',
          name: 'Preset B',
          mainPrompt: 'MAIN B {{#when::mode::tis::0}}TOGGLE B OFF{{/when}}',
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
      botPresetsId: 0,
      selectedPersona: 0,
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-a',
              generationSettings: {
                configured: true,
                personaId: 'persona-a',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-a',
                jailbreakToggle: false,
                sidebarToggles: { mode: '1' },
              },
            }),
            makeChat({
              id: 'chat-b',
              generationSettings: {
                configured: true,
                personaId: 'persona-b',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-b',
                jailbreakToggle: false,
                sidebarToggles: { mode: '0' },
              },
            }),
          ],
        }),
      ],
    } as unknown as Partial<Database>)

    const chatA = beginAssembly(baseInput({ chatId: 'chat-a' }), depsFor(db))
    fillStaticSlots(chatA)
    const chatB = beginAssembly(baseInput({ chatId: 'chat-b' }), depsFor(db))
    fillStaticSlots(chatB)

    expect(chatA.unformated.main.map((row) => row.content)).toEqual(['MAIN A TOGGLE A'])
    expect(chatA.unformated.personaPrompt.map((row) => row.content)).toEqual(['PERSONA A'])
    expect(chatB.unformated.main.map((row) => row.content)).toEqual(['MAIN B TOGGLE B OFF'])
    expect(chatB.unformated.personaPrompt.map((row) => row.content)).toEqual(['PERSONA B'])
    expect(db.mainPrompt).toBe('GLOBAL MAIN')
    expect(db.personaPrompt).toBe('GLOBAL PERSONA')
    expect(db.globalChatVariables).toEqual({ toggle_mode: 'global' })
  })

  it.each([
    { legacy: true, modern: true, expected: 'modern' },
    { legacy: false, modern: true, expected: 'modern' },
    { legacy: true, modern: false, expected: 'legacy' },
    { legacy: false, modern: false, expected: undefined },
  ])('preserves selected preset regex precedence (legacy=$legacy, modern=$modern)', ({ legacy, modern, expected }) => {
    const legacyRegex = legacy ? [{ comment: 'legacy', in: 'value', out: 'legacy', type: 'editinput' }] : []
    const modernRegex = modern ? [{ comment: 'modern', in: 'value', out: 'modern', type: 'editinput' }] : []
    const db = freezeDeep(
      makeDatabase({
        promptPresets: [{ id: 'preset-default', name: 'Selected', regex: legacyRegex, presetRegex: modernRegex }],
      }),
    )
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.database.presetRegex?.map((script) => script.out)).toEqual(expected ? [expected] : [])
    if (expected) expect(state.database.presetRegex).not.toBe(expected === 'modern' ? modernRegex : legacyRegex)
    expect(legacyRegex.map((script) => script.out)).toEqual(legacy ? ['legacy'] : [])
    expect(modernRegex.map((script) => script.out)).toEqual(modern ? ['modern'] : [])
  })

  it('shares readonly configuration while isolating each selected working state', () => {
    const chat = makeChat({
      message: [{ role: 'user', data: 'original' }],
      scriptstate: { $owned: 'source' },
      localLore: [],
    })
    const untouchedSibling = makeChat({ id: 'sibling-chat', message: [{ role: 'char', data: 'sibling body' }] })
    const original = makeCharacter({ chats: [chat, untouchedSibling], globalLore: [] })
    const db = freezeDeep(
      makeDatabase({
        characters: [original],
        modules: [{ id: 'module', name: 'Module', description: 'configuration', regex: [] }],
        globalChatVariables: { owned: 'source' },
      }),
    )
    const before = JSON.stringify(db)
    const first = beginAssembly(baseInput(), depsFor(db))
    const second = beginAssembly(baseInput(), depsFor(db))
    expect(first.database.modules).toBe(db.modules)
    expect(first.database.personas).toBe(db.personas)
    expect(first.database.modelPresets).toBe(db.modelPresets)
    expect(first.currentChar).not.toBe(original)
    expect(first.currentChar.chats[1]).toBe(untouchedSibling)
    expect(first.currentChat).not.toBe(second.currentChat)
    expect(first.currentChat.message).not.toBe(chat.message)
    expect(first.currentChat.message).not.toBe(first.authoritativeMessages)
    first.currentChar.name = 'working name'
    first.currentChat.message[0].data = 'working text'
    first.currentChat.scriptstate!.$owned = 'working variable'
    first.database.globalChatVariables!.owned = 'working global variable'
    first.currentChat.localLore.push({
      key: '',
      secondkey: '',
      insertorder: 0,
      comment: 'working',
      content: 'working lore',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
    })
    expect(JSON.stringify(db)).toBe(before)
    expect(second.currentChat.message[0].data).toBe('original')
    expect(second.currentChat.scriptstate!.$owned).toBe('source')
    expect(second.database.globalChatVariables!.owned).toBe('source')
    expect(second.currentChat.localLore).toEqual([])
  })

  it('does not mutate a frozen input database while building the effective config', () => {
    const db = freezeDeep(
      makeDatabase({
        mainPrompt: 'GLOBAL MAIN',
        personaPrompt: 'GLOBAL PERSONA',
        botPresets: [{ id: 'preset-default', name: 'Default', mainPrompt: 'CHAT MAIN' }],
        personas: [
          {
            id: 'persona-default',
            name: 'Chat User',
            icon: '',
            personaPrompt: 'CHAT PERSONA',
            note: '',
          },
        ],
      } as unknown as Partial<Database>),
    )

    const state = beginAssembly(baseInput(), depsFor(db))

    expect(state.database).not.toBe(db)
    expect(state.database.mainPrompt).toBe('CHAT MAIN')
    expect(state.database.personaPrompt).toBe('CHAT PERSONA')
    expect(db.mainPrompt).toBe('GLOBAL MAIN')
    expect(db.personaPrompt).toBe('GLOBAL PERSONA')
  })
})

function seedPromptMemory(
  db: ReturnType<typeof openDatabase>,
  input: {
    summaryId: string
    chunkId: string
    text: string
    embeddingModel?: string
    rangeStartSeq?: number
    tokens?: number
    vector?: number[]
  },
): void {
  const rangeStartSeq = input.rangeStartSeq ?? 0
  createMemoryChunk(db, {
    id: input.chunkId,
    chatId: 'chat-1',
    rangeStartSeq,
    rangeEndSeq: rangeStartSeq + 1,
    text: input.text,
    status: 'summarized',
  })
  createMemorySummary(db, {
    id: input.summaryId,
    chatId: 'chat-1',
    chunkId: input.chunkId,
    model: 'summary-model',
    text: input.text,
    tokens: input.tokens ?? 5,
  })
  createMemoryEmbedding(db, {
    id: `embedding-${input.chunkId}`,
    chatId: 'chat-1',
    chunkId: input.chunkId,
    model: input.embeddingModel ?? 'embedding-model',
    vector: input.vector ?? [1, 0],
  })
}

function chunkPlanningHistory(): PromptMessage[] {
  return [
    {
      role: 'user',
      content: 'alpha '.repeat(80),
      memo: 'memo-a',
    },
    {
      role: 'assistant',
      content: 'bravo '.repeat(80),
      memo: 'memo-b',
    },
    {
      role: 'user',
      content: 'charlie '.repeat(80),
      memo: 'memo-c',
    },
  ]
}

describe('createEmptyUnformatedSlots', () => {
  it('returns all ten slot keys as empty arrays', () => {
    const slots = createEmptyUnformatedSlots()
    expect(Object.keys(slots).sort()).toEqual(
      [
        'authorNote',
        'chats',
        'description',
        'globalNote',
        'jailbreak',
        'lastChat',
        'lorebook',
        'main',
        'personaPrompt',
        'postEverything',
      ].sort(),
    )
    for (const value of Object.values(slots)) {
      expect(value).toEqual([])
    }
  })
})

describe('beginAssembly context + template normalization', () => {
  it('builds the ExpandContext and empty slots', () => {
    const db = makeDatabase()
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.ctx).toMatchObject({ database: state.database, selectedCharID: 0, chatPage: 0 })
    expect(state.database).not.toBe(db)
    expect(state.ctx.cbsCallbackMemo).toBe(state.cbsCallbackMemo)
    expect(state.unformated.chats).toEqual([])
    expect(state.unformated.description).toEqual([])
  })

  it('records the chat preset / loadout identity', () => {
    const db = makeDatabase()
    const state = beginAssembly(baseInput({ loadoutId: 'loadout-y' }), depsFor(db))
    expect(state.modelPresetId).toBe('model-preset-default')
    expect(state.promptPresetId).toBe('preset-default')
    expect(state.loadoutId).toBe('loadout-y')
  })

  it('normalizes a set prompt template and appends postEverything', () => {
    const db = makeDatabase({ promptTemplate: [{ type: 'description' }] } as Partial<Database>)
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.usingPromptTemplate).toBe(true)
    expect(state.promptTemplate?.at(-1)).toEqual({ type: 'postEverything' })
  })

  it('leaves promptTemplate null when none is set', () => {
    const db = makeDatabase({ promptTemplate: undefined } as Partial<Database>)
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.promptTemplate).toBeNull()
    expect(state.usingPromptTemplate).toBe(false)
  })

  it('builds the format order with postEverything appended', () => {
    const db = makeDatabase()
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.formatOrder).toEqual(['main', 'description', 'chats', 'postEverything'])
  })

  it('injects effective profile/request model metadata into CBS', () => {
    const profile = {
      id: 'prompt-metadata-profile',
      name: 'Prompt Metadata',
      providerId: 'debug-echo',
      modelId: 'debug-echo',
      providerOptions: {
        baseUrl: 'debug://prompt-metadata',
        requestModel: 'profile-request-model',
      },
      runtimeOptions: {
        maxContext: 12345,
      },
    }
    const auxiliaryProfile = {
      id: 'prompt-metadata-aux-profile',
      name: 'Prompt Metadata Aux',
      modelId: 'gpt-5-mini',
    }
    const roleBindings = {
      chatMain: { mode: 'profile' as const, profileId: 'prompt-metadata-profile' },
      chatAux: { mode: 'profile' as const, profileId: 'prompt-metadata-aux-profile' },
    }
    const db = makeDatabase({
      aiModel: 'echo_model',
      modelProfiles: [profile, auxiliaryProfile],
      modelRoleProfiles: roleBindings,
      modelPresets: [
        {
          id: 'model-preset-default',
          name: 'Default Model',
          modelProfiles: [profile, auxiliaryProfile],
          modelProfileOrder: ['prompt-metadata-profile', 'prompt-metadata-aux-profile'],
          modelRoleProfiles: roleBindings,
        },
      ],
    } as unknown as Partial<Database>)
    const state = beginAssembly(baseInput(), depsFor(db))

    const metadata = promptVariables.expandVariables(
      [
        '{{model}}',
        '{{axmodel}}',
        '{{maxcontext}}',
        '{{metadata::modelshortname}}',
        '{{metadata::modelname}}',
        '{{metadata::modelinternalid}}',
        '{{metadata::modelformat}}',
        '{{metadata::modelprovider}}',
        '{{metadata::modeltokenizer}}',
      ].join('|'),
      state.ctx,
    ).text

    expect(metadata).toBe(
      [
        'debug-echo',
        'gpt-5-mini',
        '12345',
        'Debug Echo',
        'Debug Echo',
        'profile-request-model',
        LLMFormat.Echo,
        LLMProvider.Echo,
        LLMTokenizer.Unknown,
      ].join('|'),
    )
  })
})

describe('assemblePrompt', () => {
  it('surfaces bad-ID errors early', async () => {
    const db = makeDatabase()
    await expect(assemblePrompt(baseInput({ characterId: 'nope' }), depsFor(db))).rejects.toThrow(EntityNotFoundError)
  })
})

describe('fillStaticSlots', () => {
  // A database whose static/plain leaves all produce content.
  const staticDb = (overrides: Partial<Database> = {}, charOverrides: Partial<character> = {}): Database =>
    makeDatabase({
      mainPrompt: 'MAIN',
      jailbreak: 'JB',
      jailbreakToggle: true,
      globalNote: 'GN',
      chainOfThought: true,
      personaPrompt: 'PERSONA',
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          chats: [makeChat({ id: 'chat-1', note: 'NOTE' })],
          ...charOverrides,
        }),
      ],
      ...overrides,
    } as Partial<Database>)

  const fill = (db: Database, input = baseInput()) => {
    const state = beginAssembly(input, depsFor(db))
    fillStaticSlots(state)
    return state.unformated
  }

  it('fills plain + static slots on the non-utility, null-template path', () => {
    const u = fill(staticDb())
    expect(u.main.map((r) => r.content)).toEqual(['MAIN'])
    expect(u.jailbreak.map((r) => r.content)).toEqual(['JB'])
    expect(u.globalNote.map((r) => r.content)).toEqual(['GN'])
    expect(u.authorNote.map((r) => r.content)).toEqual(['NOTE'])
    expect(u.description.map((r) => r.content)).toEqual(['DESC'])
    expect(u.personaPrompt.map((r) => r.content)).toEqual(['PERSONA'])
    // chain-of-thought lands in postEverything as a single system row.
    expect(u.postEverything).toHaveLength(1)
    expect(u.postEverything[0].role).toBe('system')
  })

  it('skips plain sections for a utility bot but keeps the static four', () => {
    const u = fill(staticDb({}, { utilityBot: true }))
    expect(u.main).toEqual([])
    expect(u.jailbreak).toEqual([])
    expect(u.globalNote).toEqual([])
    expect(u.description.map((r) => r.content)).toEqual(['DESC'])
    expect(u.personaPrompt.map((r) => r.content)).toEqual(['PERSONA'])
    expect(u.authorNote.map((r) => r.content)).toEqual(['NOTE'])
  })

  it('skips plain sections when a prompt template is set', () => {
    const u = fill(staticDb({ promptTemplate: [{ type: 'description' }] } as Partial<Database>))
    expect(u.main).toEqual([])
    expect(u.jailbreak).toEqual([])
    expect(u.globalNote).toEqual([])
    expect(u.description.map((r) => r.content)).toEqual(['DESC'])
  })

  it('omits jailbreak when the toggle is off', () => {
    const u = fill(staticDb({ jailbreakToggle: false } as Partial<Database>))
    expect(u.jailbreak).toEqual([])
    expect(u.main.map((r) => r.content)).toEqual(['MAIN'])
  })

  it('omits the cot instruction when chainOfThought is off', () => {
    const u = fill(staticDb({ chainOfThought: false } as Partial<Database>))
    expect(u.postEverything).toEqual([])
  })

  it('omits persona when no personaPrompt is set', () => {
    const u = fill(staticDb({ personaPrompt: '' } as Partial<Database>))
    expect(u.personaPrompt).toEqual([])
  })

  it('omits author note when the chat note and default are empty', () => {
    const u = fill(staticDb({}, { chats: [makeChat({ id: 'chat-1', note: '' })] }))
    expect(u.authorNote).toEqual([])
  })
})

describe('fillLorebookSlots', () => {
  // An always-on (constant) lorebook entry — lands in the `lorebook` slot.
  const constLore = (content: string) =>
    ({
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: '',
      content,
      mode: 'normal',
      alwaysActive: true,
      selective: false,
    }) as unknown

  const run = (db: Database) => {
    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    return state
  }

  it('activates the lorebook, distributes it, and sets the 7-11c state', () => {
    const db = makeDatabase({
      maxResponse: 100,
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          globalLore: [constLore('LOREBODY')],
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const state = run(db)
    expect(state.report).toBeDefined()
    expect(state.unformated.lorebook.map((r) => r.content)).toContain('LOREBODY')
    expect(typeof state.positionParser).toBe('function')
    expect(Array.isArray(state.depthPrompts)).toBe(true)
    // maxResponse (100) + 50 headroom + preflight tokens for the filled slots.
    expect(state.currentTokens).toBeGreaterThan(150)
    expect(state.memoryCardUsed).toBe(false)
    expect(state.hasCachePoint).toBe(false)
  })

  it('surfaces memoryCardUsed / hasCachePoint from the preflight', () => {
    const memState = run(makeDatabase({ promptTemplate: [{ type: 'memory' }] } as Partial<Database>))
    expect(memState.memoryCardUsed).toBe(true)
    expect(memState.hasCachePoint).toBe(false)

    const cacheState = run(
      makeDatabase({
        promptTemplate: [{ type: 'cache', name: 'c', depth: 1, role: 'all' }],
      } as Partial<Database>),
    )
    expect(cacheState.hasCachePoint).toBe(true)
  })
})

describe('fillHistoryAndBias', () => {
  // A `start` trigger whose first effect aborts the send.
  const stopTrigger = [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'stop' }] }] as never

  const run = async (db: Database) => {
    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    await fillHistoryAndBias(state)
    return state
  }

  it('captures history rows and threads tokens / chat / trigger result', async () => {
    const db = makeDatabase({
      maxResponse: 100,
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: 'Hello there.',
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    const beforeTokens = state.currentTokens ?? 0
    await fillHistoryAndBias(state)

    expect(state.stopSending).toBe(false)
    // The marker + first message are always emitted, so rows + tokens grow.
    expect(state.historyMessages?.length).toBeGreaterThan(0)
    expect(state.currentTokens ?? 0).toBeGreaterThan(beforeTokens)
    // No triggers declared → null result, unchanged chat, no var write.
    expect(state.triggerResult).toBeNull()
    expect(state.varChanged).toBe(false)
    expect(state.currentChat.id).toBe('chat-1')
  })

  it('expands and emits global plus character logit-bias rows', async () => {
    const db = makeDatabase({
      bias: [['line1\\nline2', 10]],
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          name: 'Tess',
          bias: [['{{char}}-bias', 2]],
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const state = await run(db)
    expect(state.biases).toEqual([
      ['line1\nline2', 10],
      ['Tess-bias', 2],
    ])
  })

  it('short-circuits on a stopSending start trigger', async () => {
    const db = makeDatabase({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: 'Hi.',
          triggerscript: stopTrigger,
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const state = await run(db)
    expect(state.stopSending).toBe(true)
    expect(state.abortReason).toBe('trigger_stop')
    // Incomplete history is not captured on abort.
    expect(state.historyMessages).toBeUndefined()
    expect('biases' in state).toBe(false)
    // The trigger still ran, so its result is threaded out.
    expect(state.triggerResult).not.toBeNull()
    expect(state.triggerResult?.stopSending).toBe(true)
  })
})

describe('fillMemoryAndPostHistory', () => {
  const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId }) as never

  const historyChar = (overrides: Partial<character> = {}): character =>
    makeCharacter({
      chaId: 'char-tess',
      firstMessage: 'Greetings.',
      chats: [
        makeChat({
          id: 'chat-1',
          message: [msg('user', 'hello', 'msg-1'), msg('char', 'hi there', 'msg-2')] as never,
        }),
      ],
      ...overrides,
    } as Partial<character>)

  const runAll = async (db: Database) => {
    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    await fillHistoryAndBias(state)
    fillMemoryAndPostHistory(state)
    return state
  }

  it('fills chats + promotes the trailing row to lastChat (non-template)', async () => {
    const db = makeDatabase({
      maxResponse: 10,
      maxContext: 100_000,
      characters: [historyChar()],
    } as Partial<Database>)

    const state = await runAll(db)
    expect(state.stopSending).toBe(false)
    expect(state.unformated.chats.length).toBeGreaterThan(0)
    expect(state.unformated.lastChat.length).toBe(1)
    // Non-memory rows are flagged removable for the 7-11f budget pass.
    expect(state.unformated.chats.every((r) => r.removable === true)).toBe(true)
    // This fixture has no server memory rows, so no memory cards are split out.
    expect(state.memories).toEqual([])
  })

  it('injects BardWiki through the same template memory card in preview and send assembly', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      memoryDb.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run('char-tess', '{}')
      memoryDb
        .prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)')
        .run('chat-1', 'char-tess', '{}')
      createBardWikiDocument(memoryDb, {
        id: 'document-alice',
        chatId: 'chat-1',
        kind: 'character',
        title: 'Alice',
        logicalPath: 'Characters/Alice',
        aliases: [],
        contextPolicy: 'relevant',
        reviewState: 'active',
        markdown: '## Alice\n\nAlice is a ranger.',
        commandRevision: 1,
      })
      const db = makeDatabase({
        maxResponse: 10,
        maxContext: 100_000,
        bardWiki: {
          ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
          enabledByDefault: true,
          memoryMode: 'bardwiki',
        },
        promptTemplate: [
          { type: 'memory', innerFormat: 'Memory card: {{slot}}' },
          { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
        ],
        characters: [historyChar()],
      } as unknown as Partial<Database>)
      const deps = depsFor(db, { loadMemoryDatabase: () => memoryDb })
      const preview = await assemblePrompt(baseInput({ mode: 'preview_prompt', userMessage: 'Where is Alice?' }), deps)
      const send = await assemblePrompt(baseInput({ mode: 'send', userMessage: 'Where is Alice?' }), deps)

      expect(preview.stopSending).toBe(false)
      expect(send.stopSending).toBe(false)
      const previewRows = preview.formated?.filter(({ memo }) => memo === 'bardWiki') ?? []
      const sendRows = send.formated?.filter(({ memo }) => memo === 'bardWiki') ?? []
      expect(previewRows).toEqual(sendRows)
      expect(previewRows).toEqual([
        expect.objectContaining({ content: expect.stringContaining('Memory card: <bardwiki-reference') }),
      ])
      expect(preview.state?.bardWikiPromptDiagnostics).toMatchObject({
        reason: 'selected',
        selectedCount: 1,
        consumedTokens: expect.any(Number),
      })
      expect(JSON.stringify(preview.state?.bardWikiPromptDiagnostics)).not.toContain('Alice is a ranger')
      expect(preview.state?.promptMemoryRows).toEqual([])
      expect(listMemoryJobs(memoryDb)).toEqual([])

      const trimDb = structuredClone(db)
      trimDb.maxContext = Math.max(1, (preview.inputTokens ?? 100) - 1)
      if (trimDb.modelPresets?.[0])
        trimDb.modelPresets = [
          { ...trimDb.modelPresets[0], maxContext: trimDb.maxContext },
          ...trimDb.modelPresets.slice(1),
        ]
      const trimmed = await assemblePrompt(
        baseInput({ mode: 'preview_prompt', userMessage: 'Where is Alice?' }),
        depsFor(trimDb, { loadMemoryDatabase: () => memoryDb }),
      )
      expect(trimmed.stopSending).toBe(false)
      expect(trimmed.formated?.some(({ memo }) => memo === 'bardWiki')).toBe(false)
      expect(trimmed.state?.bardWikiPromptDiagnostics).toMatchObject({
        selectedCount: 1,
        retainedCount: 0,
        trimmedCount: 1,
      })
    } finally {
      memoryDb.close()
    }
  })

  it('keeps disabled BardWiki assembly byte-compatible and partitions Hybrid memory', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      memoryDb.prepare('INSERT INTO characters (id, position, data_json) VALUES (?, 0, ?)').run('char-tess', '{}')
      memoryDb
        .prepare('INSERT INTO chats (id, character_id, position, data_json) VALUES (?, ?, 0, ?)')
        .run('chat-1', 'char-tess', '{}')
      createBardWikiDocument(memoryDb, {
        id: 'document-alice',
        chatId: 'chat-1',
        kind: 'character',
        title: 'Alice',
        logicalPath: 'Characters/Alice',
        aliases: [],
        contextPolicy: 'relevant',
        reviewState: 'active',
        markdown: 'Alice is a ranger.',
        commandRevision: 1,
      })
      const disabledDb = makeDatabase({
        maxResponse: 10,
        maxContext: 100_000,
        bardWiki: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
        characters: [historyChar()],
      } as Partial<Database>)
      const withoutSqlite = await assemblePrompt(baseInput({ userMessage: 'Alice?' }), depsFor(disabledDb))
      const withDisabledBardWiki = await assemblePrompt(
        baseInput({ userMessage: 'Alice?' }),
        depsFor(disabledDb, { loadMemoryDatabase: () => memoryDb }),
      )
      expect(withDisabledBardWiki.formated).toEqual(withoutSqlite.formated)

      seedPromptMemory(memoryDb, { summaryId: 'summary-a', chunkId: 'chunk-a', text: 'selected summary' })
      const hybridDb = memoryEnabledDatabase({
        bardWiki: {
          ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
          enabledByDefault: true,
          memoryMode: 'hybrid',
          totalTokenBudget: 1_000,
          hybridHypaTokenBudget: 800,
          hybridBardWikiTokenBudget: 800,
        },
      } as Partial<Database>)
      const hybrid = beginAssembly(
        baseInput({ userMessage: 'Alice?' }),
        depsFor(hybridDb, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(hybrid)
      fillLorebookSlots(hybrid)
      await fillHistoryAndBias(hybrid)
      fillMemoryAndPostHistory(hybrid)

      expect(hybrid.bardWikiPromptDiagnostics).toMatchObject({
        memoryMode: 'hybrid',
        hypaTokenBudget: 800,
        bardWikiTokenBudget: 200,
      })
      expect(hybrid.unformated.chats.some(({ memo }) => memo === 'bardWiki')).toBe(true)
      expect(hybrid.unformated.chats.some(({ memo }) => memo === 'hypaMemory')).toBe(true)
    } finally {
      memoryDb.close()
    }
  })

  it('captures assembled Hypa memory rows into template memory cards', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      seedPromptMemory(memoryDb, {
        summaryId: 'summary-a',
        chunkId: 'chunk-a',
        text: 'selected summary',
      })
      const db = memoryEnabledDatabase({
        promptTemplate: [{ type: 'memory', innerFormat: 'Mem: {{slot}}' }],
      } as Partial<Database>)

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.stopSending).toBe(false)
      expect(state.promptMemoryRows).toEqual([{ role: 'system', content: 'selected summary', memo: 'hypaMemory' }])
      expect(state.memories?.map((row) => row.content)).toEqual(['selected summary'])
      expect(state.unformated.chats.some((row) => row.memo === 'hypaMemory')).toBe(false)
      expect(state.unformated.main).toEqual([])
      expect(state.promptMemorySelectionDiagnostics?.hotPathWork).toEqual({
        generatedQueryEmbeddings: false,
        calledProviders: false,
        generatedSummaries: false,
        enqueuedJobs: false,
        assembledPromptRows: false,
      })
      expect(state.promptMemoryRowAssemblyDiagnostics?.hotPathWork).toEqual({
        generatedQueryEmbeddings: false,
        calledProviders: false,
        generatedSummaries: false,
        enqueuedJobs: false,
        assembledPromptRows: true,
      })
    } finally {
      memoryDb.close()
    }
  })

  it('selects retained memory from the shared post-cleanup summary snapshot', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'chunk-keep',
        chatId: 'chat-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'selected summary',
        status: 'summarized',
      })
      createMemoryChunk(memoryDb, {
        id: 'chunk-orphan',
        chatId: 'chat-1',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'orphan summary',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'summary-keep',
        chatId: 'chat-1',
        chunkId: 'chunk-keep',
        model: 'summary-model',
        text: 'selected summary',
        metadata: { chatMemos: ['chat-1'] },
        tokens: 5,
      })
      createMemorySummary(memoryDb, {
        id: 'summary-orphan',
        chatId: 'chat-1',
        chunkId: 'chunk-orphan',
        model: 'summary-model',
        text: 'orphan summary',
        metadata: { chatMemos: ['removed-memo'] },
        tokens: 5,
      })
      createMemoryEmbedding(memoryDb, {
        id: 'embedding-keep',
        chatId: 'chat-1',
        chunkId: 'chunk-keep',
        model: 'embedding-model',
        vector: [1, 0],
      })
      createMemoryEmbedding(memoryDb, {
        id: 'embedding-orphan',
        chatId: 'chat-1',
        chunkId: 'chunk-orphan',
        model: 'embedding-model',
        vector: [1, 0],
      })
      const db = memoryEnabledDatabase({
        promptTemplate: [{ type: 'memory', innerFormat: 'Mem: {{slot}}' }],
      } as Partial<Database>)

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryChunkPlanningDiagnostics?.cleanup).toEqual({
        summariesDeleted: 1,
        chunksDeleted: 1,
      })
      expect(state.promptMemoryRows).toEqual([{ role: 'system', content: 'selected summary', memo: 'hypaMemory' }])
      expect(listMemorySummaries(memoryDb, { chatId: 'chat-1' }).map((summary) => summary.id)).toEqual(['summary-keep'])
      expect(listMemoryChunks(memoryDb, { chatId: 'chat-1' }).map((chunk) => chunk.id)).toEqual(['chunk-keep'])
    } finally {
      memoryDb.close()
    }
  })

  it('wraps assembled Hypa memory rows inline when no memory card consumes them', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      seedPromptMemory(memoryDb, {
        summaryId: 'summary-a',
        chunkId: 'chunk-a',
        text: 'selected summary',
      })
      const db = memoryEnabledDatabase()

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.stopSending).toBe(false)
      expect(state.memories).toEqual([])
      expect(state.unformated.chats[0]).toMatchObject({
        role: 'system',
        memo: 'hypaMemory',
        content: '<Previous Conversation>selected summary</Previous Conversation>',
      })
      expect(state.unformated.lastChat.at(-1)?.content).toBe('hi there')
    } finally {
      memoryDb.close()
    }
  })

  it('selects prompt memory with the stable custom embedding model key', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      seedPromptMemory(memoryDb, {
        summaryId: 'summary-custom',
        chunkId: 'chunk-custom',
        text: 'selected custom summary',
        embeddingModel: 'custom',
      })
      const db = memoryEnabledDatabase({
        hypaModel: 'custom',
        hypaCustomSettings: {
          url: 'https://embeddings.example.test/v1',
          key: 'custom-key',
          model: 'custom-wire-model',
        },
      } as Partial<Database>)

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryRows).toEqual([
        {
          role: 'system',
          content: '<Previous Conversation>selected custom summary</Previous Conversation>',
          memo: 'hypaMemory',
        },
      ])
      expect(state.promptMemorySelectionDiagnostics?.missingMemory).toMatchObject({
        hasMissingMemory: false,
        chunkIdsMissingEmbeddings: [],
      })
      expect(state.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: false,
        jobsCreated: 0,
      })
    } finally {
      memoryDb.close()
    }
  })

  it('does not use numeric or stale flat Hypa settings when the stable selection is invalid', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      seedPromptMemory(memoryDb, {
        summaryId: 'summary-stale-flat',
        chunkId: 'chunk-stale-flat',
        text: 'stale flat summary',
      })
      const db = memoryEnabledDatabase({
        selectedHypaV3PresetId: 'missing-memory-preset',
        hypaV3PresetId: 0,
        hypaV3Settings: {
          summarizationModel: 'summary-model',
          recentMemoryRatio: 1,
          similarMemoryRatio: 0,
        },
      } as Partial<Database>)

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryRows).toEqual([])
    } finally {
      memoryDb.close()
    }
  })

  it('plans missing Hypa chunks and summarize jobs before prompt memory selection', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      const operationAuthority = {
        operationId: 'operation-memory-planning',
        operationAttemptNo: 2,
        generationScope: { admissionKind: 'legacy_owner' as const },
      }
      const db = memoryEnabledDatabase({
        maxContext: 100,
        maxResponse: 0,
        hypaV3Presets: [
          {
            id: 'test-memory',
            name: 'Test',
            settings: {
              summarizationModel: 'memory',
              memoryTokensRatio: 0.2,
              recentMemoryRatio: 0,
              similarMemoryRatio: 1,
              maxChatsPerSummary: 2,
              queryChatCount: 1,
            },
          },
        ] as never,
      })
      const history = chunkPlanningHistory()
      const visiblePendingJobs: MemoryJob[] = []

      const first = beginAssembly(
        baseInput(operationAuthority),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [],
          onPromptMemoryJobEnqueued: (job) => visiblePendingJobs.push(job),
        }),
      )
      first.historyMessages = structuredClone(history)
      first.currentTokens = 99
      fillMemoryAndPostHistory(first)

      expect(first.stopSending).not.toBe(true)
      expect(first.promptMemoryChunkPlanningDiagnostics).toMatchObject({
        attempted: true,
        chunksCreated: 1,
        jobsCreated: 1,
        plannedWindows: 1,
        plannerErrors: [],
        errors: [],
      })
      const chunks = listMemoryChunks(memoryDb, { chatId: 'chat-1' })
      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toMatchObject({
        chatId: 'chat-1',
        messageId: 'memo-b',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        status: 'pending',
      })
      expect(chunks[0].text).toContain('user: alpha')
      expect(chunks[0].text).toContain('assistant: bravo')

      const jobs = listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })
      expect(jobs).toHaveLength(1)
      expect(visiblePendingJobs).toMatchObject([{ id: jobs[0].id, instanceId: jobs[0].instanceId, status: 'pending' }])
      expect(jobs[0]).toMatchObject({
        chatId: 'chat-1',
        kind: 'summarize',
        status: 'pending',
        ...operationAuthority,
        payload: {
          chunkId: chunks[0].id,
          model: 'memory',
          rangeStartSeq: 0,
          rangeEndSeq: 1,
          messageIndexes: [0, 1],
          chatMemos: ['memo-a', 'memo-b'],
        },
      })

      const second = beginAssembly(
        baseInput(operationAuthority),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [],
        }),
      )
      second.historyMessages = structuredClone(history)
      second.currentTokens = 99
      fillMemoryAndPostHistory(second)

      expect(second.promptMemoryChunkPlanningDiagnostics).toMatchObject({
        attempted: true,
        chunksCreated: 0,
        jobsCreated: 0,
        plannedWindows: 1,
        errors: [],
      })
      expect(listMemoryChunks(memoryDb, { chatId: 'chat-1' })).toHaveLength(1)
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })).toHaveLength(1)
    } finally {
      memoryDb.close()
    }
  })

  it('clips stored-summary history from the provider prompt and its running token budget', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'legacy-chunk',
        chatId: 'chat-1',
        messageId: 'memo-b',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'imported legacy chunk',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'legacy-summary',
        chatId: 'chat-1',
        chunkId: 'legacy-chunk',
        model: LEGACY_HYPA_V3_SUMMARY_MODEL,
        text: 'Imported tagged memory.',
        metadata: {
          source: 'legacy-hypav3',
          chatMemos: ['memo-a', 'memo-b'],
          isImportant: true,
          categoryId: 'story',
          tags: ['imported'],
        },
        tokens: 0,
      })
      const db = memoryEnabledDatabase({
        maxContext: 1000,
        maxResponse: 0,
        promptTemplate: [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }],
        hypaV3Presets: [
          {
            id: 'test-memory',
            name: 'Test',
            settings: {
              summarizationModel: 'summary-model',
              memoryTokensRatio: 0.2,
              recentMemoryRatio: 1,
              similarMemoryRatio: 0,
              maxChatsPerSummary: 2,
              queryChatCount: 1,
            },
          },
        ] as never,
      })
      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [],
        }),
      )
      state.historyMessages = chunkPlanningHistory()
      state.currentTokens = 300
      const tokensBeforeMemory = state.currentTokens

      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryRows?.some((row) => row.content.includes('Imported tagged memory.'))).toBe(true)
      expect(state.promptMemoryHistoryStartIndex).toBe(2)
      expect(state.promptMemorySummarizedHistoryTokens).toBeGreaterThan(0)
      expect(state.currentTokens).toBe(tokensBeforeMemory - (state.promptMemorySummarizedHistoryTokens ?? 0))
      // Keep the full, already-scripted history available on state while only
      // the unsummarized suffix is handed to the final memory/provider window.
      expect(state.historyMessages?.map((row) => row.memo)).toEqual(['memo-a', 'memo-b', 'memo-c'])
      const providerHistoryMemos = [...state.unformated.chats, ...state.unformated.lastChat].map((row) => row.memo)
      expect(providerHistoryMemos).toContain('memo-c')
      expect(providerHistoryMemos).not.toContain('memo-a')
      expect(providerHistoryMemos).not.toContain('memo-b')
      expect(state.promptMemoryChunkPlanningDiagnostics).toMatchObject({
        summarizedPrefixStartIndex: 2,
        summarizedPrefixTokens: state.promptMemorySummarizedHistoryTokens,
        chunksCreated: 0,
        jobsCreated: 0,
        plannedWindows: 0,
      })
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'summarize' })).toEqual([])
      expect(listMemorySummaries(memoryDb, { chatId: 'chat-1' })).toMatchObject([
        {
          id: 'legacy-summary',
          model: LEGACY_HYPA_V3_SUMMARY_MODEL,
          metadata: {
            chatMemos: ['memo-a', 'memo-b'],
            isImportant: true,
            categoryId: 'story',
            tags: ['imported'],
          },
        },
      ])

      await renderAndBudget(state)
      expect(state.formated?.some((row) => row.content.includes('Imported tagged memory.'))).toBe(true)
      expect(state.formated?.some((row) => row.content.includes('charlie charlie'))).toBe(true)
      expect(state.formated?.some((row) => row.content.includes('alpha alpha'))).toBe(false)
      expect(state.formated?.some((row) => row.content.includes('bravo bravo'))).toBe(false)
    } finally {
      memoryDb.close()
    }
  })

  it('memoizes unchanged summarized-prefix token counts across assembly planning passes', () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'prefix-chunk',
        chatId: 'chat-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'already summarized prefix',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'prefix-summary',
        chatId: 'chat-1',
        chunkId: 'prefix-chunk',
        model: 'summary-model',
        text: 'already summarized prefix',
        metadata: { chatMemos: ['memo-a', 'memo-b'] },
        tokens: 5,
      })
      const db = memoryEnabledDatabase({
        maxContext: 1000,
        maxResponse: 0,
        hypaV3Presets: [
          {
            id: 'test-memory',
            name: 'Test',
            settings: {
              summarizationModel: 'summary-model',
              memoryTokensRatio: 0.2,
              recentMemoryRatio: 0,
              similarMemoryRatio: 1,
              maxChatsPerSummary: 2,
              queryChatCount: 1,
            },
          },
        ] as never,
      })
      const history = chunkPlanningHistory()
      const runAssemblyPlanning = () => {
        const state = beginAssembly(
          baseInput(),
          depsFor(db, {
            loadMemoryDatabase: () => memoryDb,
            loadPromptMemoryQueryVectors: () => [],
          }),
        )
        state.historyMessages = structuredClone(history)
        state.currentTokens = 300
        fillMemoryAndPostHistory(state)
        return state
      }

      resetHypaV3PrefixTokenMemoForTests()
      const first = runAssemblyPlanning()
      const firstStats = getHypaV3PrefixTokenMemoStatsForTests()
      const second = runAssemblyPlanning()
      const secondStats = getHypaV3PrefixTokenMemoStatsForTests()

      expect(first.promptMemoryChunkPlanningDiagnostics).toMatchObject({
        attempted: true,
        plannedWindows: 0,
        plannerErrors: [],
        errors: [],
      })
      expect(second.promptMemoryChunkPlanningDiagnostics).toEqual(first.promptMemoryChunkPlanningDiagnostics)
      expect(firstStats).toMatchObject({ entries: 2, hits: 0, misses: 2 })
      expect(secondStats.misses).toBe(firstStats.misses)
      expect(secondStats.hits - firstStats.hits).toBe(2)
    } finally {
      memoryDb.close()
    }
  })

  it('budgets tokens:0 prompt summaries with memory and category ratios', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      const texts = ['one', 'two', 'three', 'four'].map((label) => `${label} memory `.repeat(8))
      for (const [index, text] of texts.entries()) {
        seedPromptMemory(memoryDb, {
          summaryId: `summary-${index + 1}`,
          chunkId: `chunk-${index + 1}`,
          text,
          rangeStartSeq: index * 2,
          tokens: 0,
          vector: index === 0 ? [1, 0] : [0, 1],
        })
      }
      const dbFor = (memoryTokensRatio: number): Database =>
        memoryEnabledDatabase({
          maxContext: 100,
          maxResponse: 0,
          promptTemplate: [{ type: 'memory', innerFormat: 'Mem: {{slot}}' }],
          hypaV3Presets: [
            {
              id: 'test-memory',
              name: 'Test',
              settings: {
                summarizationModel: 'summary-model',
                memoryTokensRatio,
                recentMemoryRatio: 0.5,
                similarMemoryRatio: 0.5,
                maxChatsPerSummary: 2,
                queryChatCount: 1,
              },
            },
          ] as never,
        })
      const selectMemory = async (db: Database) => {
        const state = beginAssembly(
          baseInput(),
          depsFor(db, {
            loadMemoryDatabase: () => memoryDb,
            loadPromptMemoryQueryVectors: () => [[1, 0]],
          }),
        )
        fillStaticSlots(state)
        fillLorebookSlots(state)
        await fillHistoryAndBias(state)
        fillMemoryAndPostHistory(state)
        return state
      }

      const bounded = await selectMemory(dbFor(0.5))

      expect(bounded.promptMemoryRows?.map((row) => row.content)).toEqual([texts[0].trim(), texts[3].trim()])
      const boundedAllocation = bounded.promptMemorySelectionDiagnostics?.selection?.allocation
      expect(boundedAllocation).toMatchObject({
        availableTokens: 50,
        consumedTokens: 34,
        recentMemoryRatio: 0.5,
        similarMemoryRatio: 0.5,
      })
      expect(boundedAllocation?.categories.recent).toMatchObject({
        reservedTokens: 25,
        consumedTokens: 17,
        selectedCount: 1,
        skippedForBudget: [{ summaryId: 'summary-3', tokens: 17 }],
      })
      expect(boundedAllocation?.categories.similar).toMatchObject({
        reservedTokens: 33,
        consumedTokens: 17,
        selectedCount: 1,
        skippedForBudget: [{ summaryId: 'summary-2', tokens: 17 }],
      })

      const tighter = await selectMemory(dbFor(0.15))

      expect(tighter.promptMemoryRows).toEqual([])
      expect(tighter.promptMemorySelectionDiagnostics?.selection?.allocation).toMatchObject({
        availableTokens: 15,
        consumedTokens: 0,
        remainingTokens: 15,
      })
      expect(
        tighter.promptMemorySelectionDiagnostics?.selection?.allocation.categories.similar.skippedForBudget,
      ).toEqual([{ summaryId: 'summary-1', tokens: 17 }])
    } finally {
      memoryDb.close()
    }
  })

  it('caps tokens:0 Hypa memory before final budgeting so old summaries do not overflow', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      const labels = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
      for (const [index, label] of labels.entries()) {
        seedPromptMemory(memoryDb, {
          summaryId: `overflow-summary-${index + 1}`,
          chunkId: `overflow-chunk-${index + 1}`,
          text: `${label} memory `.repeat(8),
          rangeStartSeq: index * 2,
          tokens: 0,
          vector: [1, 0],
        })
      }
      const db = memoryEnabledDatabase({
        maxContext: 90,
        maxResponse: 0,
        hypaV3Presets: [
          {
            id: 'test-memory',
            name: 'Test',
            settings: {
              summarizationModel: 'summary-model',
              memoryTokensRatio: 0.3,
              recentMemoryRatio: 1,
              similarMemoryRatio: 0,
              maxChatsPerSummary: 2,
              queryChatCount: 1,
            },
          },
        ] as never,
      })
      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryRows).toHaveLength(1)
      expect(state.promptMemorySelectionDiagnostics?.selection?.allocation.categories.recent.skippedForBudget).toEqual([
        { summaryId: 'overflow-summary-7', tokens: 17 },
      ])

      await renderAndBudget(state)

      expect(state.stopSending).toBe(false)
      expect(state.abortReason).toBeUndefined()
      expect(state.formated?.filter((row) => row.memo === 'hypaMemory')).toHaveLength(1)
      expect(state.inputTokens).toBeLessThanOrEqual(db.maxContext!)
    } finally {
      memoryDb.close()
    }
  })

  it('keeps prompt assembly running when chunk planning reports validation errors', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      const db = memoryEnabledDatabase({
        maxContext: 100,
        maxResponse: 0,
        hypaV3Presets: [
          {
            id: 'test-memory',
            name: 'Invalid',
            settings: {
              summarizationModel: 'summary-model',
              memoryTokensRatio: 0.2,
              recentMemoryRatio: 0,
              similarMemoryRatio: 1,
              maxChatsPerSummary: 0,
              queryChatCount: 1,
            },
          },
        ] as never,
      })
      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [],
        }),
      )
      state.historyMessages = chunkPlanningHistory()
      state.currentTokens = 99

      fillMemoryAndPostHistory(state)

      expect(state.stopSending).not.toBe(true)
      expect(state.promptMemoryChunkPlanningDiagnostics).toMatchObject({
        attempted: true,
        chunksCreated: 0,
        jobsCreated: 0,
        plannedWindows: 0,
        errors: [],
      })
      expect(state.promptMemoryChunkPlanningDiagnostics?.plannerErrors).toEqual([
        'maxChatsPerSummary must be a positive integer.',
      ])
      expect(listMemoryChunks(memoryDb, { chatId: 'chat-1' })).toEqual([])
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1' })).toEqual([])
      expect(state.unformated.lastChat.at(-1)?.content).toBe('charlie '.repeat(80))
    } finally {
      memoryDb.close()
    }
  })

  it('enqueues custom embedding follow-ups with the stable model key', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'chunk-needs-custom-embed',
        chatId: 'chat-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'summary without custom embedding',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'summary-needs-custom-embed',
        chatId: 'chat-1',
        chunkId: 'chunk-needs-custom-embed',
        model: 'summary-model',
        text: 'summary without custom embedding',
        tokens: 5,
      })
      const db = memoryEnabledDatabase({
        hypaModel: 'custom',
        hypaCustomSettings: {
          url: 'https://embeddings.example.test/v1',
          key: 'custom-key',
          model: 'custom-wire-model',
        },
      } as Partial<Database>)

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemorySelectionDiagnostics?.missingMemory).toMatchObject({
        hasMissingMemory: true,
        summaryIdsMissingEmbeddings: ['summary-needs-custom-embed'],
        chunkIdsMissingEmbeddings: ['chunk-needs-custom-embed'],
      })
      expect(state.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: true,
        jobsCreated: 1,
        embedChunkIds: ['chunk-needs-custom-embed'],
        errors: [],
      })
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1', kind: 'embed' })).toMatchObject([
        {
          payload: {
            schemaVersion: 1,
            chunkId: 'chunk-needs-custom-embed',
            model: 'custom',
          },
        },
      ])
    } finally {
      memoryDb.close()
    }
  })

  it('enqueues missing Hypa memory summarize and embed follow-up jobs idempotently', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'chunk-needs-embed',
        chatId: 'chat-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'summary without embedding',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'summary-needs-embed',
        chatId: 'chat-1',
        chunkId: 'chunk-needs-embed',
        model: 'summary-model',
        text: 'summary without embedding',
        tokens: 5,
      })
      createMemoryChunk(memoryDb, {
        id: 'chunk-needs-summary',
        chatId: 'chat-1',
        messageId: 'memo-b',
        rangeStartSeq: 2,
        rangeEndSeq: 3,
        text: 'embedding without summary',
        status: 'pending',
      })
      createMemoryEmbedding(memoryDb, {
        id: 'embedding-needs-summary',
        chatId: 'chat-1',
        chunkId: 'chunk-needs-summary',
        model: 'embedding-model',
        vector: [1, 0],
      })
      createMemoryChunk(memoryDb, {
        id: 'chunk-needs-summary-without-embedding',
        chatId: 'chat-1',
        messageId: 'memo-c',
        rangeStartSeq: 4,
        rangeEndSeq: 5,
        text: 'chunk without summary or embedding',
        status: 'pending',
      })
      const db = memoryEnabledDatabase()
      const visiblePendingJobs: MemoryJob[] = []

      const first = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
          onPromptMemoryJobEnqueued: (job) => visiblePendingJobs.push(job),
        }),
      )
      fillStaticSlots(first)
      fillLorebookSlots(first)
      await fillHistoryAndBias(first)
      fillMemoryAndPostHistory(first)

      expect(first.promptMemorySelectionDiagnostics?.missingMemory).toEqual({
        emptySelection: true,
        hasMissingMemory: true,
        summaryIdsMissingChunks: [],
        summaryIdsMissingEmbeddings: ['summary-needs-embed'],
        chunkIdsMissingEmbeddings: ['chunk-needs-embed'],
        chunkIdsMissingSummaries: ['chunk-needs-summary', 'chunk-needs-summary-without-embedding'],
        followUpEligible: true,
      })
      expect(first.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: true,
        jobsCreated: 3,
        existingJobs: 0,
        summarizeChunkIds: ['chunk-needs-summary', 'chunk-needs-summary-without-embedding'],
        embedChunkIds: ['chunk-needs-embed'],
        errors: [],
      })
      expect(
        listMemoryJobs(memoryDb, { chatId: 'chat-1' })
          .map((job) => job.kind)
          .sort(),
      ).toEqual(['embed', 'summarize', 'summarize'])
      expect(visiblePendingJobs).toHaveLength(3)
      expect(visiblePendingJobs.every((job) => job.status === 'pending' && job.instanceId.length > 0)).toBe(true)

      const second = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
          onPromptMemoryJobEnqueued: (job) => visiblePendingJobs.push(job),
        }),
      )
      fillStaticSlots(second)
      fillLorebookSlots(second)
      await fillHistoryAndBias(second)
      fillMemoryAndPostHistory(second)

      expect(second.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: true,
        jobsCreated: 0,
        existingJobs: 3,
        errors: [],
      })
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1' })).toHaveLength(3)
      expect(visiblePendingJobs).toHaveLength(3)
    } finally {
      memoryDb.close()
    }
  })

  it('does not enqueue Hypa memory follow-up jobs when diagnostics are clean', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      seedPromptMemory(memoryDb, {
        summaryId: 'summary-a',
        chunkId: 'chunk-a',
        text: 'selected summary',
      })
      const db = memoryEnabledDatabase()

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      fillMemoryAndPostHistory(state)

      expect(state.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: false,
        jobsCreated: 0,
        existingJobs: 0,
        errors: [],
      })
      expect(listMemoryJobs(memoryDb, { chatId: 'chat-1' })).toEqual([])
    } finally {
      memoryDb.close()
    }
  })

  it('isolates Hypa memory follow-up enqueue failures from prompt assembly', async () => {
    const memoryDb = openDatabase(makeDataDir())
    try {
      createMemoryChunk(memoryDb, {
        id: 'chunk-needs-embed',
        chatId: 'chat-1',
        rangeStartSeq: 0,
        rangeEndSeq: 1,
        text: 'summary without embedding',
        status: 'summarized',
      })
      createMemorySummary(memoryDb, {
        id: 'summary-needs-embed',
        chatId: 'chat-1',
        chunkId: 'chunk-needs-embed',
        model: 'summary-model',
        text: 'summary without embedding',
        tokens: 5,
      })
      const db = memoryEnabledDatabase()

      const state = beginAssembly(
        baseInput(),
        depsFor(db, {
          loadMemoryDatabase: () => memoryDb,
          loadPromptMemoryQueryVectors: () => [[1, 0]],
          enqueuePromptMemoryFollowUpJob: () => {
            throw new Error('queue offline')
          },
        }),
      )
      fillStaticSlots(state)
      fillLorebookSlots(state)
      await fillHistoryAndBias(state)
      expect(() => fillMemoryAndPostHistory(state)).not.toThrow()

      expect(state.stopSending).toBe(false)
      expect(state.promptMemoryFollowUpDiagnostics).toMatchObject({
        attempted: true,
        jobsCreated: 0,
        existingJobs: 0,
        embedChunkIds: ['chunk-needs-embed'],
        errors: ['queue offline'],
      })
      expect(state.unformated.lastChat.at(-1)?.content).toBe('hi there')
    } finally {
      memoryDb.close()
    }
  })

  it('does not promote lastChat when a prompt template is in use', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      promptTemplate: [{ type: 'chat', rangeStart: 0, rangeEnd: 'end' }],
      characters: [historyChar()],
    } as Partial<Database>)

    const state = await runAll(db)
    expect(state.stopSending).toBe(false)
    expect(state.unformated.lastChat).toEqual([])
    expect(state.unformated.chats.length).toBeGreaterThan(0)
  })

  it('stops sending when the history cannot fit the context budget', async () => {
    const db = makeDatabase({
      maxResponse: 100,
      maxContext: 1,
      characters: [historyChar()],
    } as Partial<Database>)

    const state = await runAll(db)
    expect(state.stopSending).toBe(true)
    expect(state.abortReason).toBe('history_context_overflow')
    expect(state.inputTokens).toBeGreaterThan(1)
    // The slots are left for the root to discard on abort.
    expect(state.unformated.chats).toEqual([])
  })

  it('places the start trigger additonalSysPrompt into postEverything / lastChat', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      characters: [historyChar()],
    } as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    await fillHistoryAndBias(state)
    // Inject a trigger result; the placement logic only reads
    // `additonalSysPrompt`.
    state.triggerResult = {
      additonalSysPrompt: { start: 'S', historyend: 'H', promptend: 'P' },
    } as never
    fillMemoryAndPostHistory(state)

    expect(state.unformated.postEverything.map((r) => r.content)).toContain('P')
    // `start` unshifts to the front, `historyend` pushes to the back.
    expect(state.unformated.lastChat[0].content).toBe('S')
    expect(state.unformated.lastChat.at(-1)?.content).toBe('H')
  })

  it('short-circuits when a prior step already set stopSending', async () => {
    const db = makeDatabase({
      maxContext: 100_000,
      characters: [historyChar()],
    } as Partial<Database>)

    const state = beginAssembly(baseInput(), depsFor(db))
    fillStaticSlots(state)
    fillLorebookSlots(state)
    await fillHistoryAndBias(state)
    state.stopSending = true
    fillMemoryAndPostHistory(state)

    // The memory window never ran, so chats stay empty.
    expect(state.unformated.chats).toEqual([])
    expect(state.memories).toBeUndefined()
  })
})

describe('renderAndBudget + assemblePrompt', () => {
  const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId }) as never

  const fullDb = (overrides: Partial<Database> = {}): Database =>
    makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'hello', 'msg-1'), msg('char', 'hi there', 'msg-2')] as never,
            }),
          ],
        } as Partial<character>),
      ],
      ...overrides,
    } as Partial<Database>)

  it('assembles a prompt payload end-to-end (non-template)', async () => {
    const result = await assemblePrompt(baseInput(), depsFor(fullDb()))

    expect(result.stopSending).toBe(false)
    expect(result.prompt?.messages?.length).toBeGreaterThan(0)
    expect(typeof result.inputTokens).toBe('number')
    expect(typeof result.outputTokens).toBe('number')
    expect(result.formated?.length).toBeGreaterThan(0)
    expect(result.biases).toEqual([])
    expect(result.prompt?.biases).toEqual([])
    expect(result.prompt?.promptInfo).toMatchObject({
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })
    // The lorebook activation report rides along on the prompt event.
    expect(result.prompt?.lorebookActivation).toBeDefined()
  })

  it('does not persist inactive Agent Preset diagnostics', async () => {
    const assembled = await assemblePrompt(baseInput(), depsFor(fullDb()))
    expect(assembled.stopSending).toBe(false)
    if (assembled.stopSending) return

    const generationInfo: Record<string, unknown> = {}
    await runServerPostGeneration(assembled.state!, {
      completionText: 'assistant reply',
      generationId: 'generation-without-agent-preset',
      generationInfo,
      promptInfo: assembled.prompt?.promptInfo,
    })

    expect(generationInfo).not.toHaveProperty('agentPreset')
    expect(assembled.state?.currentChat.message?.at(-1)?.promptInfo).toEqual({})
  })

  it('uses format order and produces prompt rows when promptTemplate is null', async () => {
    const db = fullDb({ promptTemplate: null } as unknown as Partial<Database>)
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.usingPromptTemplate).toBe(false)
    expect(state.promptTemplate).toBeNull()

    const result = await assemblePrompt(baseInput(), depsFor(db))
    expect(result.prompt?.messages?.length).toBeGreaterThan(0)
    expect(result.inputTokens).toBeGreaterThan(0)
  })

  it('keeps an empty promptTemplate array active, matching browser assembly', async () => {
    const db = fullDb({ promptTemplate: [] })
    const state = beginAssembly(baseInput(), depsFor(db))
    expect(state.usingPromptTemplate).toBe(true)
    expect(state.promptTemplate).toEqual([{ type: 'postEverything' }])

    const result = await assemblePrompt(baseInput(), depsFor(db))
    expect(result.prompt?.messages).toEqual([])
    expect(result.inputTokens).toBe(0)
  })

  it('captures template-path prompt-info (promptText) when the capture flags are on', async () => {
    // `promptText` is only populated when both prompt-info-inside-chat
    // flags are set; a `description` card then contributes a row.
    const db = fullDb({
      promptInfoInsideChat: true,
      promptTextInfoInsideChat: true,
      promptTemplate: [{ type: 'description' }, { type: 'chat', rangeStart: 0, rangeEnd: 'end' }],
    } as Partial<Database>)
    const result = await assemblePrompt(baseInput(), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.prompt?.promptInfo?.promptText).toBeDefined()
  })

  it('renders the submitted user turn after a Current Input prefix template card', async () => {
    const db = fullDb({
      promptTemplate: [
        { type: 'chat', rangeStart: -2, rangeEnd: -1 },
        { type: 'plain', text: '<Current Input>', role: 'user', type2: 'main' },
        { type: 'chat', rangeStart: -1, rangeEnd: 'end' },
      ],
    } as Partial<Database>)
    const result = await assemblePrompt(baseInput({ userMessage: 'latest submitted turn' }), depsFor(db))
    const contents = result.formated?.map((row) => row.content) ?? []

    expect(result.stopSending).toBe(false)
    expect(contents).toEqual(expect.arrayContaining(['hi there', '<Current Input>', 'latest submitted turn']))
    expect(contents.indexOf('<Current Input>')).toBeLessThan(contents.indexOf('latest submitted turn'))
  })

  it('captures prompt-info text from the chat-scoped preset, persona, and toggles', async () => {
    const db = fullDb({
      username: 'Global User',
      promptInfoInsideChat: true,
      promptTextInfoInsideChat: true,
      promptTemplate: [{ type: 'plain', type2: 'main', text: 'GLOBAL PLAIN', role: 'system' }],
      globalChatVariables: { toggle_mode: '0' },
      personas: [
        {
          id: 'persona-global',
          name: 'Global User',
          icon: '',
          personaPrompt: 'GLOBAL P',
          note: '',
        },
        { id: 'persona-chat', name: 'Chat User', icon: '', personaPrompt: 'CHAT P', note: '' },
      ],
      botPresets: [
        {
          id: 'preset-global',
          name: 'Global',
          promptTemplate: [{ type: 'plain', type2: 'main', text: 'GLOBAL PLAIN', role: 'system' }],
        },
        {
          id: 'preset-chat',
          name: 'Chat',
          promptTemplate: [
            {
              type: 'plain',
              type2: 'main',
              text: 'CHAT PLAIN {{#when::toggle::mode}}CHAT TOGGLE{{/when}}',
              role: 'system',
            },
            { type: 'persona', innerFormat: 'persona for {{user}}: {{slot}}' },
            { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
          ],
          customPromptTemplateToggle: 'mode=Mode',
        },
      ],
      botPresetsId: 0,
      selectedPersona: 0,
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'hello', 'msg-1')],
              generationSettings: {
                configured: true,
                personaId: 'persona-chat',
                modelPresetId: 'model-preset-default',
                promptPresetId: 'preset-chat',
                jailbreakToggle: false,
                sidebarToggles: { mode: '1' },
              },
            }),
          ],
        } as Partial<character>),
      ],
    } as unknown as Partial<Database>)

    const result = await assemblePrompt(baseInput(), depsFor(db))
    const promptText = result.prompt?.promptInfo?.promptText as PromptMessage[] | undefined

    expect(result.prompt?.promptInfo).toMatchObject({
      promptName: 'Chat',
      promptToggles: [{ key: 'Mode', value: 'ON' }],
    })
    expect(promptText?.map((row) => row.content)).toEqual(
      expect.arrayContaining(['CHAT PLAIN CHAT TOGGLE', 'persona for Chat User: {{slot}}']),
    )
    expect(promptText?.map((row) => row.content)).not.toContain('GLOBAL PLAIN')
  })

  it('pushes the continue marker when mode is continue under a continue-marker model', async () => {
    const db = fullDb({ aiModel: 'gpt-4' } as Partial<Database>)
    const result = await assemblePrompt(baseInput({ mode: 'continue' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.formated?.some((r) => r.content === '[Continue the last response]')).toBe(true)
  })

  it('truncates the latest assistant message before regenerate assembly', async () => {
    const db = fullDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                msg('user', 'first prompt', 'msg-user-1'),
                { ...(msg('char', 'old reply', 'msg-char-1') as any), saying: 'char-tess' },
              ] as never,
            }),
          ],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(
      baseInput({
        mode: 'regenerate',
        userMessage: undefined,
        regenerateMessageId: 'msg-char-1',
      }),
      depsFor(db),
    )

    expect(result.stopSending).toBe(false)
    expect(result.formated?.some((row) => row.content === 'old reply')).toBe(false)
    expect(result.mutations?.messageMutations).toEqual([
      {
        type: 'replace_all',
        source: 'regenerate',
        beforeLength: 2,
        afterLength: 1,
        messages: [msg('user', 'first prompt', 'msg-user-1')],
      },
    ])
  })

  it('rejects regenerate targets that are not the latest assistant message', async () => {
    const db = fullDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                msg('user', 'first prompt', 'msg-user-1'),
                msg('char', 'older reply', 'msg-char-1'),
                msg('user', 'new prompt', 'msg-user-2'),
              ] as never,
            }),
          ],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    await expect(
      assemblePrompt(
        baseInput({
          mode: 'regenerate',
          userMessage: undefined,
          regenerateMessageId: 'msg-char-1',
        }),
        depsFor(db),
      ),
    ).rejects.toThrow(/latest assistant message/)
  })

  it('rejects an already-truncated regenerate transcript with no authoritative target', async () => {
    const db = fullDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'first prompt', 'msg-user-1')] as never,
            }),
          ],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    await expect(
      assemblePrompt(
        baseInput({
          mode: 'regenerate',
          userMessage: undefined,
          regenerateMessageId: 'msg-char-1',
        }),
        depsFor(db),
      ),
    ).rejects.toThrow(/regenerate message not found/)
  })

  it('returns stopSending without a prompt when a start trigger aborts', async () => {
    const db = fullDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: 'Hi.',
          triggerscript: [{ comment: '', type: 'start', conditions: [], effect: [{ type: 'stop' }] }] as never,
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)
    const result = await assemblePrompt(baseInput(), depsFor(db))

    expect(result).toMatchObject({ stopSending: true, abortReason: 'trigger_stop' })
    expect(result.mutations?.messageMutations[0]).toMatchObject({
      type: 'append',
      source: 'user_message',
      message: { role: 'user', data: 'hi' },
    })
  })

  it('discards request-state output when a legacy whole-trigger guard aborts', async () => {
    const db = fullDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          triggerscript: [
            {
              comment: '',
              type: 'request',
              conditions: [],
              effect: [
                {
                  type: 'v2SetRequestState',
                  indexType: 'value',
                  index: '0',
                  valueType: 'value',
                  value: 'mutated request row',
                  indent: 0,
                },
                { type: 'v2MakeArrayVar', var: '[]', indent: 0 },
              ],
            },
          ] as never,
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput(), depsFor(db))
    const rows: PromptMessage[] = [{ role: 'user', content: 'original request row' }]

    await expect(applyRequestTrigger(state, rows)).resolves.toEqual(rows)
  })

  it('renderAndBudget aborts with overflow when pinned rows exceed maxContext', async () => {
    // Tiny budget + a non-removable (pinned) description row → finalize
    // cannot trim it, so the budget recheck overflows.
    const state = beginAssembly(baseInput(), depsFor(makeDatabase({ maxContext: 1 } as Partial<Database>)))
    state.unformated.description.push({ role: 'system', content: 'a pinned description row' })
    await renderAndBudget(state)

    expect(state.stopSending).toBe(true)
    expect(state.abortReason).toBe('overflow')
    expect(state.formated).toBeUndefined()
  })

  it('renderAndBudget short-circuits when a prior step set stopSending', async () => {
    const state = beginAssembly(baseInput(), depsFor(fullDb()))
    state.stopSending = true
    await renderAndBudget(state)

    expect(state.formated).toBeUndefined()
    expect(state.inputTokens).toBeUndefined()
  })
})

describe('assemble mutation contract', () => {
  const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId }) as never

  const mutationDb = (overrides: Partial<Database> = {}): Database =>
    makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          triggerscript: [
            startTrigger([
              { type: 'modifychat', index: '0', value: 'edited by trigger' },
              { type: 'impersonate', role: 'char', value: 'added by trigger' },
              { type: 'setvar', operator: '=', var: 'score', value: '9' },
              { type: 'systemprompt', location: 'start', value: 'SYS' },
            ]),
          ],
          chats: [
            makeChat({
              id: 'chat-1',
              scriptstate: { $old: '1' },
              message: [msg('user', 'before {{setvar::mood::bright}}after', 'msg-1')],
            }),
          ],
        } as Partial<character>),
      ],
      ...overrides,
    } as Partial<Database>)

  it('captures user append, run-var deltas, start-trigger edits, and system prompt rows', async () => {
    const db = mutationDb()
    const result = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.mutations).toBeDefined()
    expect(result.mutations).toMatchObject({
      chatId: 'chat-1',
      characterId: 'char-tess',
      selectedCharID: 0,
      chatPage: 0,
      varChanged: true,
    })

    const mutations = result.mutations!
    expect(mutations.messageMutations[0]).toMatchObject({
      type: 'append',
      source: 'user_message',
      index: 1,
      message: { role: 'user', data: 'new user' },
    })
    expect(typeof (mutations.messageMutations[0] as { message: { chatId: unknown } }).message.chatId).toBe('string')
    expect(typeof (mutations.messageMutations[0] as { message: { time: unknown } }).message.time).toBe('number')

    const runVarPatch = mutations.messageMutations.find((m) => m.source === 'run_var')
    expect(runVarPatch).toMatchObject({
      type: 'replace_all',
      source: 'run_var',
      beforeLength: 2,
      afterLength: 2,
    })
    expect((runVarPatch as { messages: Array<{ data: string }> }).messages[0].data).toBe('before after')

    const startPatch = mutations.messageMutations.find((m) => m.source === 'start_trigger')
    expect(startPatch).toMatchObject({
      type: 'replace_all',
      source: 'start_trigger',
      afterLength: 3,
    })
    expect((startPatch as { messages: Array<{ data: string }> }).messages.map((m) => m.data)).toEqual([
      'edited by trigger',
      'new user',
      'added by trigger',
    ])

    expect(mutations.chatVarMutations).toEqual([
      { key: '$mood', before: null, after: 'bright' },
      { key: '$score', before: null, after: '9' },
    ])
    expect(mutations.additionalSystemPrompt).toEqual([
      {
        type: 'insert_prompt_row',
        source: 'additional_sys_prompt',
        origin: 'start',
        slot: 'lastChat',
        placement: 'unshift',
        row: { role: 'system', content: 'SYS\n\n' },
      },
    ])
  })

  it('returns mutations even when a start trigger stops prompt assembly', async () => {
    const db = mutationDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: 'Hi.',
          triggerscript: [
            startTrigger([{ type: 'setvar', operator: '=', var: 'halted', value: 'yes' }, { type: 'stop' }]),
          ],
          chats: [makeChat({ id: 'chat-1' })],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput(), depsFor(db))

    expect(result.stopSending).toBe(true)
    expect(result.prompt).toBeUndefined()
    expect(result.mutations?.varChanged).toBe(true)
    expect(result.mutations?.chatVarMutations).toEqual([{ key: '$halted', before: null, after: 'yes' }])
  })

  it('does not duplicate a user message that the persisted chat already contains', async () => {
    const db = mutationDb({
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: 'Hi.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'new user', 'msg-1')],
            }),
          ],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations).toHaveLength(1)
    expect(result.mutations?.messageMutations[0]).toMatchObject({
      type: 'append',
      source: 'user_message',
      index: 0,
      message: { role: 'user', data: 'new user', chatId: 'msg-1' },
    })
  })
})

describe('assembly message capture dirty flags', () => {
  const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId }) as never

  const m1Db = (
    messages: Message[] = [],
    overrides: { db?: Partial<Database>; char?: Partial<character>; chat?: Partial<Chat> } = {},
  ): Database =>
    makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          name: 'Tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: messages as never,
              ...overrides.chat,
            }),
          ],
          ...overrides.char,
        } as Partial<character>),
      ],
      ...overrides.db,
    } as Partial<Database>)

  const captureCount = (
    source: keyof ReturnType<typeof getAssemblyMessageCaptureInstrumentation>['messageReplacementCaptures'],
  ): number => getAssemblyMessageCaptureInstrumentation().messageReplacementCaptures[source] ?? 0

  function expectNoFullTranscriptStringify(): void {
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptStringifies).toBe(0)
  }

  it('does not clone or stringify unchanged capture stages for a plain send', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'plain user text' }),
      depsFor(m1Db([msg('user', 'plain history text', 'msg-1')])),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message'])
    const metrics = getAssemblyMessageCaptureInstrumentation()
    expect(metrics.fullTranscriptClones.messageReplacement).toBe(0)
    expect(metrics.fullTranscriptClones.submitTranscript).toBe(0)
    expect(metrics.messageReplacementComparisons).toBe(0)
    expect(metrics.messageReplacementCaptures).toEqual({})
    expectNoFullTranscriptStringify()
  })

  it('keeps run-var fixed-point rows out of message capture but captures a real rewrite once', async () => {
    resetAssemblyMessageCaptureInstrumentation()
    const fixed = await assemblePrompt(
      baseInput({ mode: 'preview', userMessage: undefined }),
      depsFor(m1Db([msg('user', 'marker-free history', 'msg-1')])),
    )

    expect(fixed.stopSending).toBe(false)
    expect(fixed.mutations?.messageMutations).toEqual([])
    expect(captureCount('run_var')).toBe(0)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(0)
    expectNoFullTranscriptStringify()

    resetAssemblyMessageCaptureInstrumentation()
    const rewritten = await assemblePrompt(
      baseInput({ mode: 'preview', userMessage: undefined }),
      depsFor(m1Db([msg('char', 'I am <bot>. {{setvar::mood::bright}}', 'msg-1')])),
    )

    expect(rewritten.stopSending).toBe(false)
    expect(captureCount('run_var')).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(1)
    const runVarPatch = rewritten.mutations?.messageMutations.find((mutation) => mutation.source === 'run_var')
    expect(runVarPatch).toMatchObject({
      type: 'replace_all',
      source: 'run_var',
      beforeLength: 1,
      afterLength: 1,
      messages: [{ role: 'char', data: 'I am Tess. ', chatId: 'msg-1' }],
    })
    expect(rewritten.mutations?.chatVarMutations).toEqual([{ key: '$mood', before: null, after: 'bright' }])
    expectNoFullTranscriptStringify()
  })

  it('captures only @@inject history rewrites by row identity and keeps stripped text prompt-local', async () => {
    const result = await assemblePrompt(
      baseInput({ mode: 'preview', userMessage: undefined }),
      depsFor(
        m1Db(
          [
            { role: 'user', data: 'disabled SECRET', chatId: 'disabled-row', disabled: true } as never,
            msg('user', 'hello {{char}} SECRET', 'inject-row'),
          ],
          {
            db: { formatingOrder: ['main', 'description', 'chats', 'lastChat'] },
            char: {
              customscript: [
                { in: 'SECRET', out: '@@inject', type: 'editprocess', flag: '', ableFlag: false },
              ] as never,
            },
          },
        ),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.formated?.find((row) => row.memo === 'inject-row')?.content).toBe('hello Tess')
    expect(result.submitTranscriptChanged).toBe(true)
    expect(result.submitMessages).toBeUndefined()
    expect(result.state?.currentChat.message.find((message) => message.chatId === 'inject-row')?.data).toBe(
      'hello Tess SECRET',
    )
    expect(result.state?.currentChat.message.find((message) => message.chatId === 'disabled-row')?.data).toBe(
      'disabled SECRET',
    )
    expect(result.mutations?.messageMutations).toContainEqual({
      type: 'replace_by_id',
      source: 'history_inject',
      messageId: 'inject-row',
      before: expect.objectContaining({ chatId: 'inject-row', data: 'hello {{char}} SECRET' }),
      message: expect.objectContaining({ chatId: 'inject-row', data: 'hello Tess SECRET' }),
    })
  })

  it('keeps plain editprocess regex history transforms prompt-local', async () => {
    const result = await assemblePrompt(
      baseInput({ mode: 'preview', userMessage: undefined }),
      depsFor(
        m1Db([msg('user', 'plain SECRET', 'plain-row')], {
          db: { formatingOrder: ['main', 'description', 'chats', 'lastChat'] },
          char: {
            customscript: [{ in: 'SECRET', out: 'VISIBLE', type: 'editprocess', flag: '', ableFlag: false }] as never,
          },
        }),
      ),
    )

    expect(result.formated?.find((row) => row.memo === 'plain-row')?.content).toBe('plain VISIBLE')
    expect(result.submitTranscriptChanged).toBe(false)
    expect(result.submitMessages).toBeUndefined()
    expect(result.mutations?.messageMutations).toEqual([])
    expect(result.state?.currentChat.message[0].data).toBe('plain SECRET')
  })

  it('persists chat-var-only dirty state without forcing a message replacement capture', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'new user' }),
      depsFor(
        m1Db([], {
          char: {
            triggerscript: [startTrigger([{ type: 'setvar', operator: '=', var: 'score', value: '9' }])] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.varChanged).toBe(true)
    expect(result.mutations?.chatVarMutations).toEqual([{ key: '$score', before: null, after: '9' }])
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message'])
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(0)
    expect(captureCount('start_trigger')).toBe(0)
    expectNoFullTranscriptStringify()
  })

  it('input, start, and output chat-var triggers avoid full trigger transcript clones', async () => {
    resetTriggerCloneInstrumentation()
    const db = m1Db([msg('user', 'before triggers', 'msg-1')], {
      char: {
        triggerscript: [
          {
            comment: '',
            type: 'input',
            conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'l8Input', value: '1' }],
          },
          startTrigger([{ type: 'setvar', operator: '=', var: 'l8Start', value: '1' }]),
          {
            comment: '',
            type: 'output',
            conditions: [],
            effect: [{ type: 'v2GetMessageCount', outputVar: 'l8OutputCount', indent: 0 }],
          },
        ] as never,
      },
    })

    const assembled = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))
    expect(assembled.stopSending).toBe(false)
    expect(assembled.mutations?.chatVarMutations).toEqual([
      { key: '$l8Input', before: null, after: '1' },
      { key: '$l8Start', before: null, after: '1' },
    ])

    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'assistant reply',
      generationId: 'generation-l8',
    })

    expect(post.finalText).toBe('assistant reply')
    expect(post.mutations.chatVarMutations).toEqual([{ key: '$l8OutputCount', before: null, after: '3' }])
    const cloneMetrics = getTriggerCloneInstrumentation()
    expect(cloneMetrics.fullTranscriptClones.input).toBe(0)
    expect(cloneMetrics.fullTranscriptClones.start).toBe(0)
    expect(cloneMetrics.fullTranscriptClones.output).toBe(0)
    expect(cloneMetrics.messageSharingEnvelopeClones.input).toBe(1)
    expect(cloneMetrics.messageSharingEnvelopeClones.start).toBe(1)
    expect(cloneMetrics.messageSharingEnvelopeClones.output).toBe(1)
  })

  it('keeps configured Lua image generation inside the accepted asset-publication scope', async () => {
    const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8Z0AAAAASUVORK5CYII='
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: imageBase64 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const triggerCode = `
      onInput = async(function(id)
        local image = generateImage(id, 'a lighthouse'):await()
        setChatVar(id, 'inputAsset', image)
      end)

      onStart = async(function(id)
        local image = generateImage(id, 'a lighthouse'):await()
        setChatVar(id, 'startAsset', image)
      end)

      onOutput = async(function(id)
        local image = generateImage(id, 'a lighthouse'):await()
        setChatVar(id, 'outputAsset', image)
      end)
    `
    const makeImageDatabase = () =>
      m1Db([], {
        db: {
          sdProvider: 'dalle',
          dallEQuality: 'standard',
          openAIKey: 'test-openai-key',
        },
        char: {
          lowLevelAccess: true,
          triggerscript: [
            {
              comment: '',
              type: 'output',
              conditions: [],
              effect: [{ type: 'triggerlua', code: triggerCode }],
            },
          ] as never,
        },
      })
    const run = async (admissionKind: 'chat_only' | 'owner_occupancy') => {
      const dataDir = makeDataDir()
      const assetDb = openDatabase(dataDir)
      try {
        const assembled = await assemblePrompt(
          baseInput({ generationScope: { admissionKind } }),
          depsFor(makeImageDatabase(), {
            loadMemoryDatabase: () => assetDb,
            assetDataDir: dataDir,
          }),
        )
        const post = await runServerPostGeneration(assembled.state!, {
          completionText: 'assistant reply',
          generationId: `generation-${admissionKind}`,
        })
        return {
          assembled,
          post,
          catalog: listInlayCatalogEntries(assetDb),
        }
      } finally {
        assetDb.close()
      }
    }

    const restricted = await run('chat_only')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(restricted.catalog).toEqual([])
    expect(restricted.post.finalText).toBe('assistant reply')
    expect(restricted.assembled.state?.currentChat.message.at(-1)?.data).toBe('assistant reply')
    expect(restricted.assembled.mutations?.chatVarMutations).toEqual(
      expect.arrayContaining([
        { key: '$inputAsset', before: null, after: 'Error: Image generation failed' },
        { key: '$startAsset', before: null, after: 'Error: Image generation failed' },
      ]),
    )
    expect(restricted.post.mutations.chatVarMutations).toEqual([
      { key: '$outputAsset', before: null, after: 'Error: Image generation failed' },
    ])

    const owner = await run('owner_occupancy')

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(owner.catalog).toHaveLength(1)
    expect(owner.post.finalText).toBe('assistant reply')
    expect(owner.assembled.state?.currentChat.message.at(-1)?.data).toBe('assistant reply')
    expect(owner.assembled.mutations?.chatVarMutations).toEqual(
      expect.arrayContaining([
        { key: '$inputAsset', before: null, after: expect.stringMatching(/^\{\{inlay::[a-f0-9]{64}\}\}$/) },
        { key: '$startAsset', before: null, after: expect.stringMatching(/^\{\{inlay::[a-f0-9]{64}\}\}$/) },
      ]),
    )
    expect(owner.post.mutations.chatVarMutations).toEqual([
      { key: '$outputAsset', before: null, after: expect.stringMatching(/^\{\{inlay::[a-f0-9]{64}\}\}$/) },
    ])
  })

  it('captures input-trigger transcript rewrites once and keeps restoration at the original transcript', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'new user' }),
      depsFor(
        m1Db([], {
          char: {
            triggerscript: [
              {
                comment: '',
                type: 'input',
                conditions: [],
                effect: [{ type: 'impersonate', role: 'char', value: 'input row' }],
              },
            ] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual([
      'input_trigger',
      'user_message',
    ])
    expect(captureCount('input_trigger')).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.submitTranscript).toBe(1)
    expect(result.submitTranscriptChanged).toBe(true)
    expect(result.submitMessages?.map((message) => ({ role: message.role, data: message.data }))).toEqual([
      { role: 'char', data: 'input row' },
      { role: 'user', data: 'new user' },
    ])
    expect(result.restoration?.messages).toEqual([])
    expectNoFullTranscriptStringify()
  })

  it('emits input-trigger local lore writes without marking the transcript rewritten', async () => {
    const result = await assemblePrompt(
      baseInput({ userMessage: 'new user' }),
      depsFor(
        m1Db([], {
          char: {
            triggerscript: [
              {
                comment: '',
                type: 'input',
                conditions: [],
                effect: [
                  {
                    type: 'triggerlua',
                    code: `
                      function onInput(triggerId)
                        upsertLocalLoreBook(triggerId, 'input-lore', 'INPUT LORE', { key = 'input-key' })
                      end
                    `,
                  },
                ],
              },
            ] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.submitTranscriptChanged).toBe(false)
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message'])
    expect(result.mutations?.localLoreMutation).toEqual({
      before: [],
      after: [
        expect.objectContaining({
          id: expect.any(String),
          comment: 'input-lore',
          content: 'INPUT LORE',
          key: 'input-key',
        }),
      ],
    })
  })

  it('bypasses input trigger and editinput only for the synthetic say-nothing send', async () => {
    const database = () =>
      m1Db([], {
        char: {
          triggerscript: [
            {
              comment: '',
              type: 'input',
              conditions: [],
              effect: [{ type: 'setvar', operator: '=', var: 'inputSeen', value: '1' }],
            },
          ] as never,
          customscript: [{ in: '.+', out: 'EDITED', type: 'editinput', flag: '', ableFlag: false }] as never,
        },
      })

    const synthetic = await assemblePrompt(
      baseInput({ userMessage: '*says nothing*', syntheticSayNothing: true }),
      depsFor(database()),
    )
    const normal = await assemblePrompt(baseInput({ userMessage: 'ordinary send' }), depsFor(database()))

    expect(synthetic.stopSending).toBe(false)
    expect(synthetic.state?.currentChat.message.at(-1)?.data).toBe('*says nothing*')
    expect(synthetic.mutations?.chatVarMutations).toEqual([])
    expect(synthetic.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message'])

    expect(normal.stopSending).toBe(false)
    expect(normal.state?.currentChat.message.at(-1)?.data).toBe('EDITED')
    expect(normal.mutations?.chatVarMutations).toEqual([{ key: '$inputSeen', before: null, after: '1' }])
    expect(normal.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message', 'editinput'])
  })

  it('dispatches an empty send from an assistant tail without input hooks or a user row', async () => {
    const database = m1Db([msg('user', 'first turn', 'msg-user-1'), msg('char', 'first reply', 'msg-char-1')], {
      char: {
        triggerscript: [
          {
            comment: '',
            type: 'input',
            conditions: [],
            effect: [{ type: 'setvar', operator: '=', var: 'inputSeen', value: '1' }],
          },
        ] as never,
        customscript: [{ in: '.+', out: 'EDITED', type: 'editinput', flag: '', ableFlag: false }] as never,
      },
    })

    const assembled = await assemblePrompt(baseInput({ userMessage: undefined, emptySend: true }), depsFor(database))

    expect(assembled.stopSending).toBe(false)
    expect(assembled.mutations?.chatVarMutations).toEqual([])
    expect(assembled.mutations?.messageMutations).toEqual([])
    expect(assembled.state?.currentChat.message.map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'user', data: 'first turn' },
      { role: 'char', data: 'first reply' },
    ])

    const post = await runServerPostGeneration(assembled.state!, {
      completionText: 'second reply',
      generationId: 'generation-empty-send',
    })

    expect(post.finalText).toBe('second reply')
    expect(assembled.state?.currentChat.message.map(({ role, data }) => ({ role, data }))).toEqual([
      { role: 'user', data: 'first turn' },
      { role: 'char', data: 'first reply' },
      { role: 'char', data: 'second reply' },
    ])
  })

  it('captures editinput rewrites once after the appended user checkpoint', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'hi' }),
      depsFor(
        m1Db([], {
          char: {
            customscript: [{ in: 'hi', out: 'HELLO', type: 'editinput', flag: '', ableFlag: false }] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual(['user_message', 'editinput'])
    expect(captureCount('editinput')).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.submitTranscript).toBe(1)
    expect(result.submitMessages?.map((message) => ({ role: message.role, data: message.data }))).toEqual([
      { role: 'user', data: 'HELLO' },
    ])
    expect(result.restoration?.messages).toEqual([])
    expectNoFullTranscriptStringify()
  })

  it('runs editinput CBS with the appended user row as the current message', async () => {
    const currentMessageOnly =
      '{{#if {{equal::{{chat_index}}::{{lastmessageid}}}}}}CURRENT{{/if}}' +
      '{{#if {{not_equal::{{chat_index}}::{{lastmessageid}}}}}}STALE{{/if}}'
    const result = await assemblePrompt(
      baseInput({ userMessage: 'current request' }),
      depsFor(
        m1Db([msg('char', 'previous response', 'msg-1')], {
          char: {
            customscript: [
              {
                in: '^current request$',
                out: currentMessageOnly,
                type: 'editinput',
                flag: '',
                ableFlag: false,
              },
            ] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.submitMessages?.map((message) => ({ role: message.role, data: message.data }))).toEqual([
      { role: 'char', data: 'previous response' },
      { role: 'user', data: 'CURRENT' },
    ])
  })

  it('valid customscript script.in output remains unchanged under bounds', async () => {
    const result = await assemblePrompt(
      baseInput({ userMessage: 'hi' }),
      depsFor(
        m1Db([], {
          char: {
            customscript: [{ in: 'h(i)', out: 'H$1', type: 'editinput', flag: '', ableFlag: false }] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.submitMessages?.map((message) => ({ role: message.role, data: message.data }))).toEqual([
      { role: 'user', data: 'Hi' },
    ])
  })

  it('customscript script.in rejects unsafe imported regex during assembly', async () => {
    await expect(
      assemblePrompt(
        baseInput({ userMessage: 'a'.repeat(32) + '!' }),
        depsFor(
          m1Db([], {
            char: {
              customscript: [{ in: '(a+)+$', out: 'blocked', type: 'editinput', flag: '', ableFlag: false }] as never,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/bounded regex rejected: customscript script\.in pattern: complexity screen/)
  })

  it('runs complexity-screened customscript regexes in worker compatibility mode', async () => {
    const result = await assemblePrompt(
      baseInput({ userMessage: 'aaa' }),
      depsFor(
        m1Db([], {
          db: {
            complexRegexCompatibilityMode: 'worker',
            complexRegexInputTimeoutMs: 10000,
          } as never,
          char: {
            customscript: [{ in: '(a+)+$', out: 'OK', type: 'editinput', flag: '', ableFlag: false }] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.submitMessages?.map((message) => ({ role: message.role, data: message.data }))).toEqual([
      { role: 'user', data: 'OK' },
    ])
  })

  it('captures start-trigger chat edits once and preserves stop/error restoration baseline', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({ userMessage: 'new user' }),
      depsFor(
        m1Db([msg('user', 'before start trigger', 'msg-1')], {
          char: {
            triggerscript: [
              startTrigger([
                { type: 'modifychat', index: '0', value: 'edited by trigger' },
                { type: 'impersonate', role: 'char', value: 'added by trigger' },
              ]),
            ] as never,
          },
        }),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations.map((mutation) => mutation.source)).toEqual([
      'user_message',
      'start_trigger',
    ])
    expect(captureCount('start_trigger')).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(1)
    const startPatch = result.mutations?.messageMutations.find((mutation) => mutation.source === 'start_trigger')
    expect(startPatch).toMatchObject({
      type: 'replace_all',
      source: 'start_trigger',
      beforeLength: 2,
      afterLength: 3,
      messages: [
        { role: 'user', data: 'edited by trigger', chatId: 'msg-1' },
        { role: 'user', data: 'new user' },
        { role: 'char', data: 'added by trigger' },
      ],
    })
    expect(result.restoration?.messages).toEqual([{ role: 'user', data: 'before start trigger', chatId: 'msg-1' }])
    expectNoFullTranscriptStringify()
  })

  it('captures regenerate truncation once and leaves the restoration transcript intact', async () => {
    resetAssemblyMessageCaptureInstrumentation()

    const result = await assemblePrompt(
      baseInput({
        mode: 'regenerate',
        userMessage: undefined,
        regenerateMessageId: 'msg-char-1',
      }),
      depsFor(
        m1Db([
          msg('user', 'try again', 'msg-user-1'),
          { ...(msg('char', 'old reply', 'msg-char-1') as any), saying: 'char-tess' } as never,
        ]),
      ),
    )

    expect(result.stopSending).toBe(false)
    expect(result.mutations?.messageMutations).toEqual([
      {
        type: 'replace_all',
        source: 'regenerate',
        beforeLength: 2,
        afterLength: 1,
        messages: [msg('user', 'try again', 'msg-user-1')],
      },
    ])
    expect(captureCount('regenerate')).toBe(1)
    expect(getAssemblyMessageCaptureInstrumentation().fullTranscriptClones.messageReplacement).toBe(1)
    expect(result.restoration?.messages).toEqual([
      { role: 'user', data: 'try again', chatId: 'msg-user-1' },
      { role: 'char', data: 'old reply', chatId: 'msg-char-1', saying: 'char-tess' },
    ])
    expectNoFullTranscriptStringify()
  })
})

describe('run-var fixed-point skip', () => {
  const msg = (role: string, data: string, chatId: string) => ({ role, data, chatId }) as never

  it('only skips bodies risuChatParser provably returns unchanged (ground truth)', async () => {
    const { risuChatParser } = await import('@risuai/shared-core/risuchat-parser')
    const db = makeDatabase({ maxContext: 100_000, maxResponse: 50 } as Partial<Database>)

    // Marker-free prose — including bare `}` / `#}` / `<` text the parser
    // passes through — is a fixed point: skippable AND byte-identical.
    const fixedPoints = [
      '',
      'plain prose with punctuation. And a second sentence!',
      'closing brace } alone and even a #} pair',
      'angle brackets <notatag> <users> <charset> stay untouched',
      'unicode 한국어 텍스트 with emoji 🙂 and newline\nsecond line',
    ]
    for (const text of fixedPoints) {
      expect(isRunVarParserFixedPoint(text), `should skip: ${JSON.stringify(text)}`).toBe(true)
      expect(risuChatParser(text, { db: adaptServerCbsDatabase(db), runVar: true })).toBe(text)
    }

    // Anything the parser can rewrite must NOT be skipped.
    const expandable = [
      '{{user}}',
      'before {{setvar::mood::bright}}after',
      'legacy {#if block',
      'a lone { opener is conservatively kept',
      'tag <bot> expands',
      'tag <USER> expands case-insensitively',
      '<Char> too',
    ]
    for (const text of expandable) {
      expect(isRunVarParserFixedPoint(text), `must not skip: ${JSON.stringify(text)}`).toBe(false)
    }
  })

  it('keeps marker-free rows byte-identical while marker rows still expand', async () => {
    const prose = 'Marker-free prose row. } and #} and <notatag> included.'
    const db = makeDatabase({
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          desc: 'DESC',
          firstMessage: 'Greetings.',
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', prose, 'msg-1'), msg('char', 'I am <bot>. {{setvar::mood::bright}}', 'msg-2')],
            }),
          ],
        } as Partial<character>),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))
    expect(result.stopSending).toBe(false)

    const runVarPatch = result.mutations!.messageMutations.find((m) => m.source === 'run_var')
    expect(runVarPatch).toMatchObject({ type: 'replace_all', source: 'run_var' })
    const rows = (runVarPatch as { messages: Array<{ data: string }> }).messages
    // The skipped row is byte-identical; the marker row expanded its tag and
    // stripped the var write, which still landed in the chat-var delta.
    expect(rows[0].data).toBe(prose)
    expect(rows[1].data).toBe('I am Tess. ')
    expect(result.mutations!.chatVarMutations).toEqual([{ key: '$mood', before: null, after: 'bright' }])
  })

  it('resolves the baseline run-var plus history second-pass indirection chain', async () => {
    const db = makeDatabase({
      username: 'Alex',
      maxContext: 100_000,
      maxResponse: 50,
      characters: [
        makeCharacter({
          chaId: 'char-tess',
          firstMessage: '',
          chats: [
            makeChat({
              id: 'chat-1',
              scriptstate: {
                $outer: '{{getvar::inner}}',
                $inner: '{{user}}',
              },
              message: [msg('user', '{{getvar::outer}}', 'nested-cbs')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput({ userMessage: 'latest user' }), depsFor(db))

    expect(result.formated?.find((row) => row.memo === 'nested-cbs')?.content).toBe('Alex')
  })
})

describe('history expansion cost', () => {
  const msg = (role: Message['role'], data: string, chatId: string): Message => ({ role, data, chatId }) as Message

  const active = (overrides: Partial<LoreEntryActive> = {}): LoreEntryActive => ({
    depth: 0,
    pos: '',
    prompt: '',
    role: 'system',
    order: 100,
    priority: 100,
    tokens: 0,
    source: '',
    inject: null,
    ...overrides,
  })

  const report = (actives: LoreEntryActive[]): LorebookActivationReport => ({
    actives,
    disabledUIPrompts: [],
    matchLog: [],
  })

  it('skips expandVariables for marker-free history rows but expands markers and legacy tags', async () => {
    const prose = 'Marker-free prose row. } #} <notatag> stay byte-identical.'
    const db = makeDatabase({
      username: 'Alex',
      aiModel: 'gpt4',
      characters: [
        makeCharacter({
          name: 'Lyra',
          firstMessage: '',
          chats: [
            makeChat({
              message: [
                msg('user', prose, 'plain-row'),
                msg('user', 'hello {{user}}', 'macro-row'),
                msg('char', '<bot> answers <user>', 'tag-row'),
              ],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const spy = vi.spyOn(promptVariables, 'expandVariables')

    const result = await buildHistoryWindow({ database: db }, db.characters[0], db.characters[0].chats[0])

    expect(result.messages.find((m) => m.memo === 'plain-row')?.content).toBe(prose)
    expect(result.messages.find((m) => m.memo === 'macro-row')?.content).toBe('hello Alex')
    expect(result.messages.find((m) => m.memo === 'tag-row')?.content).toBe('Lyra answers Alex')
    expect(spy.mock.calls.filter(([input]) => input === prose)).toHaveLength(0)
    expect(spy.mock.calls.filter(([input]) => input === 'hello {{user}}')).toHaveLength(1)
    expect(spy.mock.calls.filter(([input]) => input === '<bot> answers <user>')).toHaveLength(1)
  })

  it('expands SEND_NAME_WRAPPER once per history window and reuses it for rows', async () => {
    const db = makeDatabase({
      aiModel: 'gpt4',
      promptSettings: {
        assistantPrefill: '',
        postEndInnerFormat: '',
        sendChatAsSystem: false,
        sendName: true,
        utilOverride: false,
      },
      characters: [
        makeCharacter({
          name: 'Lyra',
          firstMessage: '',
          chats: [
            makeChat({
              message: [msg('user', 'one', 'one'), msg('char', 'two', 'two'), msg('user', 'three', 'three')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const spy = vi.spyOn(promptVariables, 'expandVariables')

    const result = await buildHistoryWindow({ database: db }, db.characters[0], db.characters[0].chats[0], true)

    expect(result.messages.find((m) => m.memo === 'one')?.content).toBe("<Lyra's Message>\none\n</Lyra's Message>")
    expect(result.messages.find((m) => m.memo === 'two')?.content).toBe("<Lyra's Message>\ntwo\n</Lyra's Message>")
    expect(result.messages.find((m) => m.memo === 'three')?.content).toBe("<Lyra's Message>\nthree\n</Lyra's Message>")
    expect(spy.mock.calls.filter(([input]) => String(input).startsWith("<{{char}}'s Message>\n{{slot}}"))).toHaveLength(
      1,
    )
  })

  it('expands depth-prompt bodies once for preflight and reuses them for final splice', async () => {
    const db = makeDatabase({
      username: 'Alex',
      aiModel: 'gpt4',
      characters: [makeCharacter({ firstMessage: '' })],
    } as Partial<Database>)
    const activationReport = report([
      active({
        pos: 'reverse_depth',
        depth: 1,
        prompt: 'tail says {{user}}',
        source: 'reverse-depth-cbs',
      }),
      active({
        pos: 'depth',
        depth: 1,
        prompt: 'depth says {{user}}',
        source: 'depth-cbs',
      }),
    ])
    const spy = vi.spyOn(promptVariables, 'expandVariables')

    const history = await buildHistoryWindow(
      { database: db },
      db.characters[0],
      db.characters[0].chats[0],
      false,
      undefined,
      activationReport,
    )
    expect(spy.mock.calls.filter(([input]) => input === 'depth says {{user}}')).toHaveLength(1)
    expect(spy.mock.calls.filter(([input]) => input === 'tail says {{user}}')).toHaveLength(1)

    const messages: PromptMessage[] = [
      { role: 'system', content: 'NewChat' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]
    applyDepthPrompts(messages, { database: db }, db.characters[0], activationReport, history.preparedDepthPrompts)

    expect(messages.map((m) => m.content)).toEqual(['NewChat', 'depth says Alex', 'first', 'tail says Alex', 'reply'])
    expect(spy.mock.calls.filter(([input]) => input === 'depth says {{user}}')).toHaveLength(1)
    expect(spy.mock.calls.filter(([input]) => input === 'tail says {{user}}')).toHaveLength(1)
  })
})

describe('stable card cache', () => {
  it('persists stable-card setvar once through assembly mutations', async () => {
    const db = makeDatabase({
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [
        {
          type: 'plain',
          type2: 'main',
          text: 'stable {{setvar::score::9}}body',
          role: 'system',
        },
      ],
      characters: [
        makeCharacter({
          firstMessage: '',
          chats: [makeChat({ id: 'chat-1', message: [] })],
        }),
      ],
    } as Partial<Database>)
    const spy = vi.spyOn(promptVariables, 'expandVariables')

    const result = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.formated?.map((r) => r.content)).toContain('stable body')
    expect(result.mutations?.chatVarMutations).toEqual([{ key: '$score', before: null, after: '9' }])
    expect(
      spy.mock.calls.filter(
        ([input, expandCtx]) =>
          input === 'stable {{setvar::score::9}}body' &&
          (expandCtx as { runVar?: boolean } | undefined)?.runVar === true,
      ),
    ).toHaveLength(1)
  })

  it('re-expands stable cards after a start-trigger write without double-applying run-var CBS', async () => {
    const card = 'Mood={{getvar::mood}} {{addvar::count::1}}Count={{getvar::count}}'
    const db = makeDatabase({
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [{ type: 'plain', type2: 'main', text: card, role: 'system' }],
      characters: [
        makeCharacter({
          firstMessage: '',
          triggerscript: [startTrigger([{ type: 'setvar', operator: '=', var: 'mood', value: 'after' }])] as never,
          chats: [
            makeChat({
              id: 'chat-1',
              message: [],
              scriptstate: { $mood: 'before', $count: '0' },
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const spy = vi.spyOn(promptVariables, 'expandVariables')

    const result = await assemblePrompt(baseInput({ userMessage: 'new user' }), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.formated?.map((row) => row.content)).toContain('Mood=after Count=1')
    expect(result.mutations?.chatVarMutations).toEqual([
      { key: '$count', before: '0', after: '1' },
      { key: '$mood', before: 'before', after: 'after' },
    ])
    // Preflight executes speculatively and rolls back. The invalidated final
    // render executes against post-trigger state, so addvar persists only once.
    expect(
      spy.mock.calls.filter(
        ([input, expandCtx]) => input === card && (expandCtx as { runVar?: boolean } | undefined)?.runVar === true,
      ),
    ).toHaveLength(2)
  })
})

describe('Fastify lorebook template injection', () => {
  it('keeps before_desc lore system-authored when description role2 changes the base row', async () => {
    const beforeDescription = {
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: 'Before description',
      content: '@@position before_desc\nLORE BEFORE',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
    } as loreBook
    const db = makeDatabase({
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [{ type: 'description', role2: 'user' }],
      characters: [
        makeCharacter({
          desc: 'BASE DESCRIPTION',
          globalLore: [beforeDescription],
          chats: [makeChat({ id: 'chat-1', message: [] })],
        }),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput(), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.formated).toEqual([
      { role: 'system', content: 'LORE BEFORE' },
      { role: 'user', content: 'BASE DESCRIPTION' },
    ])
  })

  it('applies @@inject_at globalNote once through async activation, preflight, cache, and final render', async () => {
    const injector = {
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: 'Global Note injection',
      content: '@@inject_at globalNote\nINJECTED',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
    } as loreBook
    const db = makeDatabase({
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [{ type: 'plain', type2: 'globalNote', text: 'BASE', role: 'system' }],
      characters: [
        makeCharacter({
          replaceGlobalNote: '[[{{original}}]]',
          globalLore: [injector],
          chats: [makeChat({ id: 'chat-1', message: [] })],
        }),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput(), depsFor(db))

    expect(result.stopSending).toBe(false)
    expect(result.formated).toEqual([{ role: 'system', content: '[[BASE]] INJECTED' }])
    expect(result.state?.report?.actives).toEqual([
      expect.objectContaining({
        source: 'Global Note injection',
        prompt: 'INJECTED',
        inject: { operation: 'append', location: 'globalNote', param: '', lore: false },
      }),
    ])
  })
})

describe('lorebook sticky chat-var persistence', () => {
  const stickyLore = (content: string): loreBook =>
    ({
      id: 'lore-dont',
      key: 'cat',
      secondkey: '',
      insertorder: 100,
      comment: 'One-shot',
      content,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }) as loreBook

  const stickyDb = (): Database =>
    makeDatabase({
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          firstMessage: '',
          globalLore: [stickyLore('@@dont_activate_after_match\nOne-shot lore.')],
          chats: [makeChat({ id: 'chat-1', message: [] })],
        }),
      ],
    } as Partial<Database>)

  it('persists @@dont_activate_after_match through assembly mutations and suppresses the next send', async () => {
    const db = stickyDb()

    const first = await assemblePrompt(baseInput({ userMessage: 'cat' }), depsFor(db))

    expect(first.stopSending).toBe(false)
    const firstLorebookActivation = first.prompt?.lorebookActivation as LorebookActivationReport | undefined
    expect(firstLorebookActivation?.actives.map((a) => a.prompt)).toContain('One-shot lore.')
    expect(first.mutations?.varChanged).toBe(true)
    expect(first.mutations?.chatVarMutations).toEqual([
      { key: '$__internal_da_lore-dont', before: null, after: 'true' },
    ])
    expect(first.state?.database.characters[0].chats[0].scriptstate).toEqual({
      '$__internal_da_lore-dont': 'true',
    })
    expect(first.state?.currentChat.scriptstate).toBe(first.state?.database.characters[0].chats[0].scriptstate)
    expect(db.characters[0].chats[0].scriptstate).toBeUndefined()

    db.characters[0].chats[0].scriptstate = structuredClone(first.state?.currentChat.scriptstate)

    const second = await assemblePrompt(baseInput({ userMessage: 'cat' }), depsFor(db))

    expect(second.stopSending).toBe(false)
    const secondLorebookActivation = second.prompt?.lorebookActivation as LorebookActivationReport | undefined
    expect(secondLorebookActivation?.actives.map((a) => a.prompt)).not.toContain('One-shot lore.')
    expect(second.mutations?.chatVarMutations).toEqual([])
  })
})

describe('CBS callback memo', () => {
  const msg = (role: Message['role'], data: string, chatId: string): Message => ({ role, data, chatId }) as Message

  const lore = (overrides: Partial<loreBook> = {}): loreBook =>
    ({
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'Lore body',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
      ...overrides,
    }) as loreBook

  const payload = (content: string, label: string): string => {
    const line = content.split('\n').find((candidate) => candidate.startsWith(label))
    expect(line, `missing ${label}`).toBeDefined()
    return line!.slice(label.length)
  }
  const readUserHistory = (state: ReturnType<typeof beginAssembly>): string =>
    promptVariables.expandVariables('{{userhistory}}', {
      ...state.ctx,
      chara: state.currentChar,
    }).text
  const firstHistoryData = (history: string): string => {
    const rows = JSON.parse(history) as string[]
    expect(rows).toHaveLength(1)
    const row = JSON.parse(rows[0]) as { data: string }
    return row.data
  }

  it('evaluates repeated charhistory, userhistory, and lorebook callbacks once per assembly signature', async () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      promptTemplate: [
        {
          type: 'plain',
          type2: 'main',
          role: 'system',
          text: [
            'U1 {{userhistory}}',
            'U2 {{usermessages}}',
            'C1 {{charhistory}}',
            'C2 {{charmessages}}',
            'L1 {{lorebook}}',
            'L2 {{worldinfo}}',
          ].join('\n'),
        },
      ],
      characters: [
        makeCharacter({
          name: 'Tess',
          chaId: 'char-tess',
          firstMessage: '',
          globalLore: [lore({ id: 'global-lore', content: 'Global lore' })],
          chats: [
            makeChat({
              id: 'chat-1',
              localLore: [lore({ id: 'local-lore', content: 'Local lore' })],
              message: [msg('user', 'user sees {{user}}', 'msg-user'), msg('char', 'char sees {{char}}', 'msg-char')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)

    const result = await assemblePrompt(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))

    expect(result.stopSending).toBe(false)
    const content = result.formated?.find((row) => row.content.includes('U1 '))?.content ?? ''
    expect(payload(content, 'U1 ')).toBe(payload(content, 'U2 '))
    expect(payload(content, 'C1 ')).toBe(payload(content, 'C2 '))
    expect(payload(content, 'L1 ')).toBe(payload(content, 'L2 '))
    expect(payload(content, 'U1 ')).toContain('user sees Alex')
    expect(payload(content, 'C1 ')).toContain('char sees Tess')
    expect(payload(content, 'L1 ')).toContain('Global lore')
    expect(payload(content, 'L1 ')).toContain('Local lore')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses).toEqual({
      userhistory: 1,
      charhistory: 1,
      lorebook: 1,
    })
  })

  it('does not return stale history output after the assembly history generation changes', () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'first {{user}}', 'msg-1')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))
    const read = () =>
      promptVariables.expandVariables('{{userhistory}}\n{{userhistory}}', {
        ...state.ctx,
        chara: state.currentChar,
      }).text

    const first = read()
    expect(first).toContain('first Alex')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(1)

    state.database.characters[0].chats[0].message.push(msg('user', 'second {{user}}', 'msg-2'))
    bumpAssemblyCbsHistoryGeneration(state.cbsCallbackMemo)

    const second = read()
    expect(second).toContain('first Alex')
    expect(second).toContain('second Alex')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(2)
  })

  it('does not return stale lorebook output after lore identities change', () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      characters: [
        makeCharacter({
          globalLore: [lore({ id: 'global-one', content: 'Global one' })],
          chats: [
            makeChat({
              id: 'chat-1',
              localLore: [lore({ id: 'local-one', content: 'Local one' })],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))
    const read = () =>
      promptVariables.expandVariables('{{lorebook}}\n{{worldinfo}}', {
        ...state.ctx,
        chara: state.currentChar,
      }).text

    const first = read()
    expect(first).toContain('Global one')
    expect(first).toContain('Local one')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.lorebook).toBe(1)

    state.currentChar.globalLore.push(lore({ id: 'global-two', content: 'Global two' }))
    state.database.characters[0].chats[0].localLore.push(lore({ id: 'local-two', content: 'Local two' }))
    state.currentChat.localLore.push(lore({ id: 'local-two', content: 'Local two' }))

    const second = read()
    expect(second).toContain('Global one')
    expect(second).toContain('Global two')
    expect(second).toContain('Local one')
    expect(second).toContain('Local two')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.lorebook).toBe(2)
  })

  it('sticky-lorebook chat-var writes invalidate cached history output', () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      personaPrompt: '{{userhistory}}',
      maxContext: 100_000,
      maxResponse: 50,
      characters: [
        makeCharacter({
          globalLore: [
            lore({
              id: 'lore-keep',
              key: 'cat',
              alwaysActive: false,
              content: '@@keep_activate_after_match\nSticky lore.',
            }),
          ],
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'cat marker {{getvar::__internal_ka_lore-keep}}', 'msg-1')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))

    fillStaticSlots(state)
    expect(firstHistoryData(state.unformated.personaPrompt[0].content)).toBe('cat marker null')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(1)

    fillLorebookSlots(state)
    const second = readUserHistory(state)

    expect(firstHistoryData(second)).toBe('cat marker true')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(2)
    expect(state.database.characters[0].chats[0].scriptstate?.['$__internal_ka_lore-keep']).toBe('true')
    expect(db.characters[0].chats[0].scriptstate).toBeUndefined()
  })

  it('run-var chat-var-only writes invalidate cached history output', () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [
                msg('user', 'run marker {{getvar::runMemo}}', 'msg-1'),
                msg('char', '{{mockRunVarWrite}}', 'msg-2'),
              ],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))

    expect(firstHistoryData(readUserHistory(state))).toBe('run marker null')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(1)

    applyCurrentChatRunVars(state, {
      expandVariablesForRunVar: (text, expandCtx) => {
        if (text === '{{mockRunVarWrite}}') {
          const chat = expandCtx.database.characters[0].chats[0]
          chat.scriptstate ??= {}
          chat.scriptstate.$runMemo = 'fresh'
          return { text, dirty: true }
        }
        return { text, dirty: false }
      },
    })
    const second = readUserHistory(state)

    expect(firstHistoryData(second)).toBe('run marker fresh')
    expect(state.messageMutations).toEqual([])
    expect(state.varChanged).toBe(true)
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(2)
  })

  it('Lua editRequest chat-var writes invalidate cached history output', async () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      aiModel: 'gpt4',
      maxContext: 100_000,
      maxResponse: 50,
      mainPrompt: 'MAIN',
      characters: [
        makeCharacter({
          triggerscript: [
            {
              comment: '',
              type: 'request',
              conditions: [],
              effect: [
                {
                  type: 'triggerlua',
                  code: `
                    listenEdit('editRequest', function(id, data, meta)
                      setChatVar(id, 'luaMemo', 'fresh')
                      return data
                    end)
                  `,
                },
              ],
            },
          ] as never,
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'lua marker {{getvar::luaMemo}}', 'msg-1')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))
    state.unformated.main.push({ role: 'system', content: 'MAIN' })

    expect(firstHistoryData(readUserHistory(state))).toBe('lua marker null')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(1)

    await renderAndBudget(state)
    const second = readUserHistory(state)

    expect(state.stopSending).not.toBe(true)
    expect(firstHistoryData(second)).toBe('lua marker fresh')
    expect(state.varChanged).toBe(true)
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(2)
  })

  it('unchanged history references still hit the memo', () => {
    resetAssemblyCbsCallbackMemoInstrumentation()
    const db = makeDatabase({
      username: 'Alex',
      characters: [
        makeCharacter({
          chats: [
            makeChat({
              id: 'chat-1',
              message: [msg('user', 'steady {{getvar::missing}}', 'msg-1')],
            }),
          ],
        }),
      ],
    } as Partial<Database>)
    const state = beginAssembly(baseInput({ mode: 'preview', userMessage: undefined }), depsFor(db))

    const first = readUserHistory(state)
    applyCurrentChatRunVars(state, {
      expandVariablesForRunVar: (text) => ({ text, dirty: false }),
    })
    const second = readUserHistory(state)

    expect(second).toBe(first)
    expect(firstHistoryData(second)).toBe('steady null')
    expect(getAssemblyCbsCallbackMemoInstrumentation().callbackMisses.userhistory).toBe(1)
  })
})
