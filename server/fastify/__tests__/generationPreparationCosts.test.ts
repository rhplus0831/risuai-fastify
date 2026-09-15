import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentRecord, AgentPresetRecord } from '@risuai/shared-core/agent-preset-records'
import { openDatabase } from '../src/db.js'
import { assemblePrompt, type AssembleInput } from '../src/prompt/assemble.js'
import { buildEffectiveGenerationConfig } from '../src/prompt/effectiveGenerationConfig.js'
import { bootPromptVariables } from '../src/prompt/promptVariablesBoot.js'
import type { FastifyCharacter, FastifyChat, FastifyDatabase } from '../src/prompt/serverTypes.js'
import {
  insertAssetMetadataBatch,
  loadPersistedForGenerationAssembly,
  writePersistedWithMessages,
} from '../src/repository.js'
import {
  createGenerationAssemblyResources,
  preflightGenerationOperationSettings,
} from '../src/routes/generationChat.js'
import { decodeGenerationDatabase } from '../src/prompt/generationInputDecoder.js'

// Deterministic work counters, not a latency benchmark. These probes deliberately
// assert semantics instead of pinning the inefficient baseline as desired work.
// Phase 3 can add the recorded scope budgets to the same fixtures after cutover.
const unrelatedSizes = [0, 12, 48]
const historySizes = [4, 40, 160]
const payload = 'unrelated synthetic payload '.repeat(80)
const reportRows: unknown[] = []
const cpuProfileRequested = process.env.RISU_GENERATION_COST_CPU_PROFILE === '1'
let cpuProfileCaptured = false
const reportPath = fileURLToPath(
  new URL('../../../fast-bootstrap-results/maintainability/generation-costs.json', import.meta.url),
)
const input: AssembleInput = {
  characterId: 'target-character',
  chatId: 'target-chat',
  mode: 'preview_prompt',
}

afterAll(() => {
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runtime: process.version,
        architecture: process.arch,
        logicalCpus: cpus().length,
        cpu: cpus()[0]?.model,
        ...(cpuProfileRequested ? { diagnosticOnly: true, diagnosticKind: 'cpu-profile' } : {}),
        samples: reportRows,
      },
      null,
      2,
    ) + '\n',
  )
})

interface ReadCost {
  calls: number
  rows: number
  returnedBytes: number
  jsonColumnBytes: number
}

interface PhaseCost {
  cloneCalls: number
  cloneBytes: number
  databaseAggregateClones: number
  reads: Record<string, ReadCost>
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '')
}

function newChat(id: string, history: number, note = ''): FastifyChat {
  return {
    id,
    name: id,
    note,
    localLore: [],
    message: Array.from({ length: history }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'char',
      data: `Stored message ${index}: fixed target history text.`,
      chatId: `${id}-message-${index}`,
      time: 1_700_000_000_000 + index,
    })),
    generationSettings: {
      configured: true,
      personaId: 'selected-persona',
      modelPresetId: 'selected-model',
      promptPresetId: 'selected-prompt',
      jailbreakToggle: false,
      sidebarToggles: {},
    },
  }
}

function newCharacter(id: string, chats: FastifyChat[], desc: string): FastifyCharacter {
  return {
    type: 'character',
    chaId: id,
    name: id === input.characterId ? 'Tess' : id,
    firstMessage: 'Hello.',
    desc,
    notes: '',
    chats,
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'none',
    bias: [],
    emotionImages: [],
    globalLore: [],
    sdData: [],
    customscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: 0,
    replaceGlobalNote: '',
    additionalText: '',
    triggerscript: [],
  }
}

function fixtureDatabase(unrelated: number, targetHistory: number) {
  const extra = Array.from({ length: unrelated }, (_, index) => ({
    id: `unused-${index}`,
    name: `Unused ${index}`,
  }))
  return {
    currentChar: 0,
    characters: [
      newCharacter(input.characterId, [newChat(input.chatId, targetHistory)], 'Fixed selected character.'),
      ...extra.map(({ id }) =>
        newCharacter(
          id,
          Array.from({ length: 3 }, (_, index) => newChat(`${id}-chat-${index}`, 8, payload)),
          payload,
        ),
      ),
    ],
    personas: [
      { id: 'selected-persona', name: 'User', icon: '', personaPrompt: 'Fixed persona.', note: '' },
      ...extra.map((record) => ({ ...record, icon: '', personaPrompt: payload, note: payload })),
    ],
    selectedPersona: 0,
    selectedPersonaId: 'selected-persona',
    modelPresetsId: 0,
    promptPresetsId: 0,
    modelPresets: [
      { id: 'selected-model', name: 'Selected model', aiModel: 'gpt-4o-mini', maxContext: 32000, maxResponse: 256 },
      ...extra.map((record) => ({ ...record, aiModel: 'gpt-4o-mini', customFlags: [payload] })),
    ],
    promptPresets: [
      {
        id: 'selected-prompt',
        name: 'Selected prompt',
        mainPrompt: 'Fixed system prompt.',
        formatingOrder: ['main', 'description', 'personaPrompt', 'chats'],
      },
      ...extra.map((record) => ({ ...record, mainPrompt: payload })),
    ],
    modules: extra.map((record) => ({ ...record, lorebook: [{ content: payload }], regex: [], trigger: [] })),
    enabledModules: [],
    globalChatVariables: {},
    jailbreakToggle: false,
    aiModel: 'gpt-4o-mini',
    maxContext: 32000,
    maxResponse: 256,
    promptSettings: {
      assistantPrefill: '',
      postEndInnerFormat: '',
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    },
  }
}

async function measure<T>(db: DatabaseSync, run: () => T | Promise<T>): Promise<{ result: T; cost: PhaseCost }> {
  const cost: PhaseCost = { cloneCalls: 0, cloneBytes: 0, databaseAggregateClones: 0, reads: {} }
  const clone = globalThis.structuredClone
  const cloneSpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    cost.cloneCalls += 1
    cost.cloneBytes += bytes(value)
    if (value && typeof value === 'object' && 'characters' in value) cost.databaseAggregateClones += 1
    return clone(value, options)
  })
  // Observe execution on StatementSync, including reused prepared programs.
  // Restore every spy before isolated timing; cached programs must never retain
  // the counter's serialization work or closures from a previous phase.
  const prototype: StatementSync = Object.getPrototypeOf(db.prepare('SELECT 1'))
  const originalAll = prototype.all
  const originalGet = prototype.get
  function capture(sql: string, value: Record<string, SQLOutputValue> | Record<string, SQLOutputValue>[] | undefined) {
    const table = /\bFROM\s+([a-z_]+)/i.exec(sql)?.[1] ?? 'other'
    const rows = Array.isArray(value) ? value : value ? [value] : []
    const read = (cost.reads[table] ??= { calls: 0, rows: 0, returnedBytes: 0, jsonColumnBytes: 0 })
    read.calls += 1
    read.rows += rows.length
    read.returnedBytes += bytes(value)
    for (const row of rows)
      for (const [key, item] of Object.entries(row)) {
        if (key.endsWith('_json') && typeof item === 'string') read.jsonColumnBytes += Buffer.byteLength(item)
      }
  }
  const allSpy = vi.spyOn(prototype, 'all').mockImplementation(function (
    this: StatementSync,
    ...parameters: Array<SQLInputValue | Record<string, SQLInputValue>>
  ) {
    const value = Reflect.apply(originalAll, this, parameters)
    capture(this.sourceSQL, value)
    return value
  })
  const getSpy = vi.spyOn(prototype, 'get').mockImplementation(function (
    this: StatementSync,
    ...parameters: Array<SQLInputValue | Record<string, SQLInputValue>>
  ) {
    const value = Reflect.apply(originalGet, this, parameters)
    capture(this.sourceSQL, value)
    return value
  })
  try {
    return { result: await run(), cost }
  } finally {
    cloneSpy.mockRestore()
    allSpy.mockRestore()
    getSpy.mockRestore()
  }
}

async function timings(db: DatabaseSync, dataDir: string) {
  if (process.env.RISU_GENERATION_COST_TIMING !== '1') return undefined
  // Keep these runs separate from SQL/clone spies: their JSON serialization
  // deliberately adds work and would otherwise distort the timing comparison.
  const samples = { warmup: 1, repetitions: 3, preflightMs: [] as number[], assemblyMs: [] as number[] }
  let profiler: import('node:inspector/promises').Session | undefined
  let profileSetupMs = 0
  if (cpuProfileRequested && !cpuProfileCaptured) {
    // The first probe is the zero-unrelated/four-message fixture. Profiling is
    // diagnostic only; it keeps the existing one warmup + three measured runs.
    cpuProfileCaptured = true
    const started = performance.now()
    const { Session } = await import('node:inspector/promises')
    profiler = new Session()
    try {
      profiler.connect()
      await profiler.post('Profiler.enable')
      await profiler.post('Profiler.setSamplingInterval', { interval: 100 })
      await profiler.post('Profiler.start')
      profileSetupMs = performance.now() - started
    } catch (error) {
      profiler.disconnect()
      throw error
    }
  }
  try {
    for (let repetition = -samples.warmup; repetition < samples.repetitions; repetition += 1) {
      let started = performance.now()
      preflightGenerationOperationSettings(input, dataDir, db)
      const preflightMs = performance.now() - started
      started = performance.now()
      const result = await assemblePrompt(input, createGenerationAssemblyResources(db, dataDir, input))
      const assemblyMs = performance.now() - started
      expect(result.stopSending).toBe(false)
      if (repetition >= 0) {
        samples.preflightMs.push(preflightMs)
        samples.assemblyMs.push(assemblyMs)
      }
    }
  } finally {
    if (profiler) {
      try {
        const started = performance.now()
        const { profile } = await profiler.post('Profiler.stop')
        const profileStopMs = performance.now() - started
        const profilePath =
          process.env.RISU_GENERATION_COST_CPU_PROFILE_PATH ??
          path.join(path.dirname(reportPath), 'generation-small.cpuprofile')
        mkdirSync(path.dirname(profilePath), { recursive: true })
        writeFileSync(profilePath, JSON.stringify(profile) + '\n')
        writeFileSync(
          profilePath + '.json',
          JSON.stringify(
            {
              diagnosticOnly: true,
              note: 'CPU sampling adds overhead; these timings are not acceptance evidence.',
              samplingIntervalUs: 100,
              profileSetupMs,
              profileStopMs,
              sampledDurationMs: (profile.endTime - profile.startTime) / 1000,
              sampleCount: profile.samples?.length ?? 0,
              timing: samples,
            },
            null,
            2,
          ) + '\n',
        )
      } finally {
        profiler.disconnect()
      }
    }
  }
  return samples
}

async function probe(unrelated: number, targetHistory: number, unusedConfigurationRecords = 0, legacyEmbedded = false) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-generation-costs-'))
  const db = openDatabase(dataDir)
  try {
    const fixture = fixtureDatabase(unrelated, targetHistory)
    if (unusedConfigurationRecords > 0) {
      Object.assign(fixture, {
        agents: Array.from(
          { length: unusedConfigurationRecords },
          (_, index) =>
            ({
              id: `unused-config-agent-${index}`,
              name: `Unused Agent ${index}`,
              version: 1,
              instruction: payload,
              description: payload,
              modelDefaults: { mode: 'inheritMain' },
              runtimeDefaults: {},
              inputScopes: [],
              outputFormat: 'text',
            }) satisfies AgentRecord,
        ),
        agentPresets: Array.from(
          { length: unusedConfigurationRecords },
          (_, index) =>
            ({
              id: `unused-config-preset-${index}`,
              name: `Unused Agent Preset ${index}`,
              version: 1,
              enabled: true,
              description: payload,
              agentUses: [],
              steps: [],
            }) satisfies AgentPresetRecord,
        ),
      })
    }
    if (legacyEmbedded) {
      // The named compatibility path sees embedded unused modules too. Keep
      // those records valid at the real execution decoder, not just SQL JSON.
      fixture.modules = fixture.modules.map((module) => ({ ...module, description: payload, lorebook: [] }))
      fixture.modelPresets = fixture.modelPresets.map((preset) =>
        'customFlags' in preset ? { ...preset, name: payload, customFlags: [] } : preset,
      )
      db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(fixture))
    } else {
      writePersistedWithMessages(db, dataDir, {
        _version: 1,
        database: fixture,
        assets: [],
      })
    }
    insertAssetMetadataBatch(
      db,
      Array.from({ length: unrelated * 8 }, (_, index) => ({
        id: index.toString(16).padStart(64, '0'),
        ext: 'png',
        size: 4096,
        contentType: 'image/png',
      })),
    )

    const preflight = await measure(db, () => preflightGenerationOperationSettings(input, dataDir, db))
    expect(preflight.result).toEqual({ status: 'ready' })
    const load = await measure(db, () => loadPersistedForGenerationAssembly(db, dataDir, input))
    expect(load.result.generationScope).toBe(legacyEmbedded ? 'legacy' : 'selected')
    const database: FastifyDatabase = decodeGenerationDatabase(load.result.database)
    const currentChar: FastifyCharacter = database.characters.find(
      (character: FastifyCharacter) => character.chaId === input.characterId,
    )!
    const currentChat = currentChar.chats.find((chat) => chat.id === input.chatId)!
    expect(currentChat.message).toHaveLength(targetHistory)
    const originalTarget = JSON.stringify(currentChat)
    const effective = await measure(db, () =>
      buildEffectiveGenerationConfig({
        database,
        currentChar,
        currentChat,
        selectedCharID: database.characters.indexOf(currentChar),
        chatPage: currentChar.chats.indexOf(currentChat),
      }),
    )
    expect(effective.result.currentChat).not.toBe(currentChat)
    const assembly = await measure(db, () =>
      assemblePrompt(input, createGenerationAssemblyResources(db, dataDir, input)),
    )
    expect(assembly.result.stopSending).toBe(false)
    expect(assembly.result.formated?.length).toBeGreaterThan(0)
    expect(JSON.stringify(currentChat)).toBe(originalTarget)

    return {
      dimensions: {
        unrelatedCharacters: unrelated,
        unrelatedChats: unrelated * 3,
        unrelatedHistoryRows: unrelated * 24,
        unusedRowsPerCollection: unrelated,
        unrelatedAssets: unrelated * 8,
        targetHistory,
        unusedConfigurationRecords,
        legacyEmbedded,
      },
      snapshotBytes: bytes(load.result.database),
      assetSnapshotBytes: bytes(load.result.assets),
      preflight: preflight.cost,
      load: load.cost,
      effective: effective.cost,
      assembly: assembly.cost,
      timing: await timings(db, dataDir),
      prompt: assembly.result.formated,
    }
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

describe('generation preparation work counters', () => {
  it('keeps selected prompt bytes stable while reporting unrelated corpus work', async () => {
    bootPromptVariables()
    const results = []
    for (const unrelated of unrelatedSizes) results.push(await probe(unrelated, 4))
    for (const result of results) {
      expect(result.prompt).toEqual(results[0].prompt)
      // Includes chat-owned preset fields projected before generation decoding.
      expect(result.snapshotBytes).toBeLessThanOrEqual(2_821)
      expect(result.snapshotBytes).toBe(results[0].snapshotBytes)
      expect(result.assetSnapshotBytes).toBe(2)
      expect(result.preflight.reads.messages?.rows ?? 0).toBe(0)
      expect(Object.values(result.preflight.reads).reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(6)
      expect(Object.values(result.assembly.reads).reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(10)
      expect(result.preflight.cloneBytes).toBeLessThanOrEqual(4_308)
      expect(result.effective.cloneBytes).toBeLessThanOrEqual(3_550)
      expect(result.assembly.cloneBytes).toBeLessThanOrEqual(5_368)
      for (const cost of [result.preflight, result.load, result.effective, result.assembly]) {
        expect(cost.databaseAggregateClones).toBe(0)
        expect(cost.reads.assets?.rows ?? 0).toBe(0)
      }
      reportRows.push({ axis: 'unrelated', ...result, prompt: undefined })
    }
  })

  it('reports necessary target-history work separately from unrelated corpus work', async () => {
    bootPromptVariables()
    const results = []
    for (const history of historySizes) results.push(await probe(0, history))
    expect(results[2].snapshotBytes).toBeGreaterThan(results[0].snapshotBytes)
    expect(bytes(results[2].prompt)).toBeGreaterThan(bytes(results[0].prompt))
    expect(results[2].assembly.cloneBytes).toBeLessThanOrEqual(104_188)
    expect(Object.values(results[2].assembly.reads).reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(166)
    for (const result of results) {
      expect(result.preflight.reads.messages?.rows ?? 0).toBe(0)
      expect(result.preflight.databaseAggregateClones).toBe(0)
      expect(result.assembly.databaseAggregateClones).toBe(0)
      reportRows.push({ axis: 'history', ...result, prompt: undefined })
    }
  })
  it('records retained configuration-row parsing separately from selected captured data', async () => {
    bootPromptVariables()
    const results = []
    for (const count of unrelatedSizes) results.push(await probe(0, 4, count))
    for (const result of results) {
      expect(result.prompt).toEqual(results[0].prompt)
      expect(result.snapshotBytes).toBe(results[0].snapshotBytes)
      expect(result.preflight.cloneBytes).toBe(results[0].preflight.cloneBytes)
      expect(result.assembly.cloneBytes).toBe(results[0].assembly.cloneBytes)
      expect(result.preflight.databaseAggregateClones).toBe(0)
      expect(result.assembly.databaseAggregateClones).toBe(0)
      reportRows.push({ axis: 'configuration-row', ...result, prompt: undefined })
    }
    // This audit counter deliberately exposes the remaining settings-row parse
    // instead of claiming that constant selected output bytes imply constant IO.
    expect(results[2].load.reads.settings.jsonColumnBytes).toBeGreaterThan(
      results[0].load.reads.settings.jsonColumnBytes,
    )
  })

  it('measures the named embedded-character compatibility path separately', async () => {
    bootPromptVariables()
    const results = []
    for (const unrelated of unrelatedSizes) results.push(await probe(unrelated, 4, 0, true))
    for (const result of results) {
      expect(result.prompt).toEqual(results[0].prompt)
      expect(result.preflight.reads.messages?.rows ?? 0).toBe(0)
      expect(result.preflight.databaseAggregateClones).toBe(0)
      expect(result.assembly.databaseAggregateClones).toBe(0)
      expect(result.assembly.reads.assets?.rows ?? 0).toBe(0)
      reportRows.push({ axis: 'legacy-embedded', ...result, prompt: undefined })
    }
    expect(results[2].load.reads.settings.jsonColumnBytes).toBeGreaterThan(
      results[0].load.reads.settings.jsonColumnBytes,
    )
    expect(results[2].snapshotBytes).toBeGreaterThan(results[0].snapshotBytes)
  })
})
