import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { openDatabase } from '../src/db.js'
import { getDatabaseOwnershipSnapshot } from '../src/databaseLineage.js'
import { createGenerationOperation } from '../src/generationOperations.js'
import { writePersistedWithMessages } from '../src/repository.js'

// Drives the operator-run replay utility as a child process over a data
// directory written by the real persistence layer, with legacy-shaped defects
// planted by raw SQL the way an original-RisuAI import leaves them.

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function directoryDigest(directory: string): string {
  const hash = createHash('sha256')
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else hash.update(path.relative(directory, file)).update(readFileSync(file))
    }
  }
  walk(directory)
  return hash.digest('hex')
}

function character(id: string, promptPresetId = 'prompt', modelPresetId = 'model') {
  return {
    chaId: `char-${id}`,
    name: `PRIVATE_CHARACTER_${id}`,
    type: 'character',
    desc: '',
    firstMessage: '',
    notes: '',
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
    firstMsgIndex: -1,
    replaceGlobalNote: '',
    additionalText: '',
    triggerscript: [],
    chats: [
      {
        id: `chat-${id}`,
        name: `PRIVATE_CHAT_${id}`,
        note: '',
        localLore: [],
        message: [{ role: 'user', data: `PRIVATE_MESSAGE_${id}`, chatId: `message-${id}` }],
        generationSettings: {
          configured: true,
          personaId: 'persona',
          modelPresetId,
          promptPresetId,
          jailbreakToggle: false,
          sidebarToggles: {},
        },
      },
    ],
  }
}

function seedDataDirectory(): string {
  const dataDir = temporaryDirectory('risu-replay-test-')
  const db = openDatabase(dataDir)
  writePersistedWithMessages(db, dataDir, {
    _version: 1,
    database: {
      aiModel: 'gpt35',
      maxContext: 4096,
      maxResponse: 128,
      temperature: 100,
      modelRoleProfiles: { chatMain: { mode: 'legacy' } },
      personas: [{ id: 'persona', name: 'PRIVATE_PERSONA', personaPrompt: '' }],
      modelPresets: [
        { id: 'model', name: 'PRIVATE_MODEL', aiModel: 'gpt35', maxContext: 4096, maxResponse: 128 },
        { id: 'numeric-model', name: 'PRIVATE_MODEL_NUMERIC', aiModel: 'gpt35', top_p: 0.9 },
      ],
      promptPresets: [
        {
          id: 'prompt',
          name: 'PRIVATE_PROMPT',
          promptTemplate: [
            { type: 'plain', type2: 'main', text: 'hello', role: 'system' },
            { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
          ],
        },
        { id: 'empty-prompt', name: 'PRIVATE_PROMPT_EMPTY', thinkingType: 'budget' },
      ],
      characters: [
        character('clean'),
        character('empty-thinking', 'empty-prompt'),
        character('numeric', 'prompt', 'numeric-model'),
        character('message'),
        character('retryable'),
        character('defer'),
      ],
    },
    assets: [],
  } as never)
  const update = (table: string, condition: string, mutate: (value: Record<string, unknown>) => void) => {
    const row = db.prepare(`SELECT data_json FROM ${table} WHERE ${condition}`).get() as { data_json: string }
    const value = JSON.parse(row.data_json) as Record<string, unknown>
    mutate(value)
    db.prepare(`UPDATE ${table} SET data_json = ? WHERE ${condition}`).run(JSON.stringify(value))
  }
  // Exact empty string: repaired by the canonicalizer, so this chat stays ready.
  update('prompt_presets', "json_extract(data_json,'$.id') = 'empty-prompt'", (value) => {
    value.thinkingType = ''
  })
  // Numeric string: still strict, rejected at preflight.
  update('model_presets', "json_extract(data_json,'$.id') = 'numeric-model'", (value) => {
    value.top_p = '0.9'
  })
  // Message-level defect: only the acceptance capture decodes the transcript.
  db.prepare("UPDATE messages SET json = json_set(json, '$.data', 123) WHERE chat_id = 'chat-message'").run()
  // A legacy-origin operation left retryable by an older server pins the chat.
  createGenerationOperation(db, {
    databaseLineage: getDatabaseOwnershipSnapshot(db).databaseLineage,
    operationId: 'PRIVATE_OPERATION',
    protocolVersion: 0,
    requestOrigin: 'legacy',
    creatorWriterSessionId: 'PRIVATE_WRITER',
    creatorWriterEpoch: 0,
    characterId: 'char-retryable',
    chatId: 'chat-retryable',
    mode: 'send',
    state: 'accepted',
    createdAt: '2026-09-20T00:00:00.000Z',
  } as never)
  db.prepare("UPDATE generation_operations SET state = 'retryable' WHERE operation_id = 'PRIVATE_OPERATION'").run()
  // A chat whose character row is gone must be reported as defer, never ready.
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare("DELETE FROM characters WHERE id = 'char-defer'").run()
  db.close()
  return dataDir
}

it('reports each chat at its first failing stage without touching or leaking the source data', () => {
  const dataDir = seedDataDirectory()
  const before = directoryDigest(dataDir)
  const output = temporaryDirectory('risu-replay-report-')
  const reportPath = path.join(output, 'report.json')
  const stdout = execFileSync(
    path.join(repoRoot, 'node_modules/.bin/tsx'),
    ['util/generation-rejection-replay.ts', '--data-dir', dataDir, '--json', reportPath],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  )
  const reportText = readFileSync(reportPath, 'utf8')
  const report = JSON.parse(reportText) as {
    outcome: string
    fetchAttempts: unknown[]
    chats: Array<{
      chatId: string
      outcome: string
      code: string
      firstFailingStage: string | null
      stagesRun: string[]
      details?: { validation?: { domain: string; instancePath: string; field?: string; valueKind: string } }
    }>
    aggregates: { outcomes: Record<string, number> }
  }

  expect(directoryDigest(dataDir)).toBe(before)
  expect(statSync(reportPath).mode & 0o777).toBe(0o600)
  expect(stdout).not.toContain('PRIVATE_')
  expect(reportText).not.toContain('PRIVATE_')
  expect(report.outcome).toBe('completed')
  expect(report.fetchAttempts).toEqual([])
  expect(report.aggregates.outcomes).toEqual({ ready: 2, rejected: 2, defer: 1, pinned: 1 })

  const byChat = Object.fromEntries(report.chats.map((chat) => [chat.chatId, chat]))
  expect(byChat['chat-clean']).toMatchObject({
    outcome: 'ready',
    firstFailingStage: null,
    stagesRun: ['P', 'B', 'K', 'C', 'D'],
  })
  expect(byChat['chat-empty-thinking']).toMatchObject({ outcome: 'ready', stagesRun: ['P', 'B', 'K', 'C', 'D'] })
  expect(byChat['chat-numeric']).toMatchObject({
    outcome: 'rejected',
    code: 'generation_input_validation_failed',
    firstFailingStage: 'B',
    details: {
      validation: { domain: 'preflight', instancePath: '/database/top_p', field: 'top_p', valueKind: 'string' },
    },
  })
  expect(byChat['chat-message']).toMatchObject({
    outcome: 'rejected',
    code: 'generation_input_validation_failed',
    firstFailingStage: 'K',
    details: {
      validation: {
        domain: 'database',
        instancePath: '/characters/*/chats/*/message/*/data',
        field: 'data',
        valueKind: 'number',
      },
    },
  })
  expect(byChat['chat-retryable']).toMatchObject({
    outcome: 'pinned',
    code: 'chat_occupancy_recovery_blocked',
    firstFailingStage: 'P',
    stagesRun: ['P'],
  })
  expect(byChat['chat-defer']).toMatchObject({ outcome: 'defer', firstFailingStage: 'B' })
}, 120_000)
