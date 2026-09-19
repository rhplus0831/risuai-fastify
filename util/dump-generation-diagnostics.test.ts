import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../server/fastify/src/db.js'
import { writePersistedWithMessages } from '../server/fastify/src/repository.js'
import { dumpGenerationDiagnostics, safeError, sizeProfile } from './dump-generation-diagnostics.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-diagnostic-test-'))
  dirs.push(dataDir)
  const db = openDatabase(dataDir)
  writePersistedWithMessages(db, dataDir, {
    _version: 1,
    assets: [],
    database: {
      currentChar: 0,
      characters: [
        {
          type: 'character',
          chaId: 'target-character',
          name: 'PRIVATE_CHARACTER',
          desc: 'PRIVATE_DESCRIPTION',
          utilityBot: false,
          notes: '',
          chatFolders: [],
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
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
          chatPage: 0,
          firstMessage: 'PRIVATE_GREETING',
          chats: [
            {
              id: 'target-chat',
              name: 'PRIVATE_CHAT',
              note: '',
              localLore: [],
              message: [{ role: 'user', chatId: 'PRIVATE_MESSAGE_ID', data: 'PRIVATE_MESSAGE_TEXT' }],
              hypaV3Data: { summaries: [{ text: 'PRIVATE_SUMMARY', chatMemos: [], isImportant: false }] },
              generationSettings: {
                configured: true,
                personaId: 'persona',
                modelPresetId: 'model',
                promptPresetId: 'prompt',
                jailbreakToggle: false,
                sidebarToggles: {},
              },
            },
          ],
        },
      ],
      personas: [{ id: 'persona', name: 'PRIVATE_PERSONA', personaPrompt: '', icon: '', note: '' }],
      modelPresets: [{ id: 'model', name: 'PRIVATE_MODEL', maxContext: 100000, maxResponse: 50 }],
      promptPresets: [
        { id: 'prompt', name: 'PRIVATE_PROMPT', mainPrompt: 'PRIVATE_PROMPT_TEXT', formatingOrder: ['main', 'chats'] },
      ],
      modelPresetsId: 0,
      promptPresetsId: 0,
      selectedPersona: 0,
      modules: [],
      enabledModules: [],
    },
  })
  db.close()
  return { dataDir, characterId: 'target-character', chatId: 'target-chat' }
}

describe('production generation diagnostics', () => {
  it('writes a private CLI report and refuses to overwrite an existing file', () => {
    const options = fixture()
    const output = path.join(options.dataDir, 'diagnostic.json')
    const args = [
      '--import',
      'tsx',
      fileURLToPath(new URL('./dump-generation-diagnostics.ts', import.meta.url)),
      '--data-dir',
      options.dataDir,
      '--character-id',
      options.characterId,
      '--chat-id',
      options.chatId,
      '--output',
      output,
    ]
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    const original = fs.readFileSync(output, 'utf8')
    expect(JSON.parse(original).effectiveConfiguration.status).toBe('ok')
    expect(original).not.toContain('PRIVATE')
    expect(fs.statSync(output).mode & 0o777).toBe(0o600)
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' })
    expect(second.status).toBe(1)
    expect(fs.readFileSync(output, 'utf8')).toBe(original)
  }, 30_000)

  it('reports UTF-8 sizes and hides values and user-defined keys', () => {
    const report = sizeProfile({
      mainPrompt: '한글',
      globalChatVariables: { PRIVATE_KEY: 'PRIVATE_VALUE'.repeat(200) },
    })
    expect(report.bytes).toBe(
      Buffer.byteLength(
        JSON.stringify({ mainPrompt: '한글', globalChatVariables: { PRIVATE_KEY: 'PRIVATE_VALUE'.repeat(200) } }),
      ),
    )
    expect(report.fields.find((f) => f.path === '$.mainPrompt')?.bytes).toBe(8)
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(report.fields.some((f) => f.path.includes('<field-'))).toBe(true)
  })

  it('captures the real oversized configuration, bootstrap probes, and does not write to the source', async () => {
    const options = fixture()
    const db = new DatabaseSync(path.join(options.dataDir, 'risu.db'))
    db.prepare("UPDATE prompt_presets SET data_json = json_set(data_json, '$.mainPrompt', ?)").run(
      'x'.repeat(9 * 1024 * 1024),
    )
    db.close()
    const before = createHash('sha256')
      .update(fs.readFileSync(path.join(options.dataDir, 'risu.db')))
      .digest('hex')
    const report = (await dumpGenerationDiagnostics(options)) as any
    expect(report.effectiveConfiguration.status, JSON.stringify(report.effectiveConfiguration)).toBe('ok')
    expect(report.effectiveConfiguration.result.exceedsLimit).toBe(true)
    expect(report.effectiveConfiguration.result.snapshotMessageCount).toBe(0)
    expect(report.effectiveConfiguration.result.snapshotHasHypa).toBe(false)
    expect(
      report.effectiveConfiguration.result.profile.fields.some(
        (f: any) => f.path.includes('mainPrompt') && f.bytes > 8 * 1024 * 1024,
      ),
    ).toBe(true)
    expect(report.bootstrap.operations.status).toBe('ok')
    expect(report.characterHydration.status).toBe('ok')
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(
      createHash('sha256')
        .update(fs.readFileSync(path.join(options.dataDir, 'risu.db')))
        .digest('hex'),
    ).toBe(before)
  })

  it('keeps raw size evidence when effective configuration validation fails', async () => {
    const options = fixture()
    const db = new DatabaseSync(path.join(options.dataDir, 'risu.db'))
    db.prepare("UPDATE prompt_presets SET data_json = json_set(data_json, '$.mainPrompt', json(?))").run(
      '{"PRIVATE_KEY":"PRIVATE_VALUE"}',
    )
    db.close()
    const report = (await dumpGenerationDiagnostics(options)) as any
    expect(report.effectiveConfiguration.status).toBe('error')
    expect(report.effectiveConfiguration.error.kind).toBe('GenerationInputValidationError')
    expect(report.sourceRows.settings.status).toBe('ok')
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
  })

  it('enforces read-only mode when a repository loader attempts a secret repair', async () => {
    const options = fixture()
    const db = new DatabaseSync(path.join(options.dataDir, 'risu.db'))
    db.prepare("UPDATE settings SET data_json = json_set(data_json, '$.modelProfiles', json(?))").run(
      JSON.stringify([{ id: 'private-profile', provider: 'openai', providerOptions: { apiKey: 'PRIVATE_API_KEY' } }]),
    )
    db.close()
    const before = createHash('sha256')
      .update(fs.readFileSync(path.join(options.dataDir, 'risu.db')))
      .digest('hex')
    const report = (await dumpGenerationDiagnostics(options)) as any
    expect(report.characterHydration.status).toBe('error')
    expect(report.characterHydration.error.sqliteCode).toBe(8)
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(
      createHash('sha256')
        .update(fs.readFileSync(path.join(options.dataDir, 'risu.db')))
        .digest('hex'),
    ).toBe(before)
  })

  it('does not expose error messages or arbitrary names', () => {
    const error = new Error('PRIVATE_ERROR')
    error.name = 'PRIVATE_NAME'
    expect(JSON.stringify(safeError(error))).not.toContain('PRIVATE')
  })
})
