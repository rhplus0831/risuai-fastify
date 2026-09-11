import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { StatementSync } from 'node:sqlite'
import type { FastifyInstance } from 'fastify'
import {
  serializeChatGenerationSettingsDigestInput,
  type ChatGenerationSettings,
} from '@risuai/shared-core/chat-generation-settings'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import {
  loadChatHydration,
  loadPersisted,
  loadPersistedForChatGenerationSettingsMutation,
  loadPersistedForChatMutation,
} from '../src/repository.js'
import { applyTargetedCommandMutation } from '../src/commands/mutations.js'
import { normalizeAllCharacterChats } from '../src/commands/chats.js'
import { subscribeProtocolMetrics } from '../src/protocolMetrics.js'
import { setupAuthedClient } from './helpers/auth.js'
import { assertCommandMetricGate, type CommandMutationMetric } from './helpers/commandMetricGates.js'
import { assertScopedLoadOnHotPath, withServerLoadInstrumentation } from './helpers/loadCostHarness.js'
import { buildLargeCorpusFixture } from '../../../test/fixtures/largeCorpusFixture.js'

// Command-mutation read narrowing: targeted message/scriptstate/generation
// command routes locate one chat row and mutate it (or write the message store
// through kit writers). Ordinary `chatScopedRead` loads the target and parent;
// generation-settings additionally loads its settings/collection validation
// owners. Both retain a broad fallback for unknown ids and pre-extraction state.

interface Harness {
  app: FastifyInstance
  dataDir: string
}

let harness: Harness
let assertion: string

async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent'
  const dataDir = mkdtempSync(path.join(tmpdir(), 'risu-cmd-read-'))
  const { app } = await buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      dataDir,
      bodyLimit: 20 * 1024 * 1024,
      importMaxBytes: Infinity,
      trustProxy: false,
      hubUrl: 'https://sv.risuai.xyz',
    },
    // Background DB consumers would pollute the process-global statement spy.
    assetGc: false,
    memoryWorker: false,
  })
  return { app, dataDir }
}

beforeEach(async () => {
  harness = await startHarness()
  ;({ assertion } = await setupAuthedClient(harness.app))
})

afterEach(async () => {
  await harness.app.close()
  rmSync(harness.dataDir, { recursive: true, force: true })
})

async function importDatabase(database: unknown): Promise<number> {
  const res = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/import/risusave',
    headers: { 'risu-auth': assertion },
    payload: { database },
  })
  expect(res.statusCode).toBe(200)
  return res.json().revision as number
}

function command(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload: Record<string, unknown>) {
  return harness.app.inject({ method, url, headers: { 'risu-auth': assertion }, payload })
}

function chatGenerationSettingsDigest(settings: ChatGenerationSettings | undefined): string {
  return createHash('sha256').update(serializeChatGenerationSettingsDigestInput(settings), 'utf8').digest('hex')
}

function hydrationGet(chatId: string) {
  return harness.app.inject({
    method: 'GET',
    url: `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    headers: { 'risu-auth': assertion },
  })
}

type SqliteReadMethod = 'all' | 'get' | 'iterate'

async function withSqliteSelectReadInstrumentation<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; readCountByTable: Record<string, number> }> {
  const readCountByTable: Record<string, number> = {}
  const proto = StatementSync.prototype as unknown as Record<SqliteReadMethod, (...args: unknown[]) => unknown>
  const originals = {
    all: proto.all,
    get: proto.get,
    iterate: proto.iterate,
  }

  for (const method of ['all', 'get', 'iterate'] as const) {
    const original = originals[method]
    proto[method] = function tracked(this: StatementSync, ...args: unknown[]) {
      const normalized = this.sourceSQL.toLowerCase().replace(/\s+/g, ' ').trim()
      const match = normalized.startsWith('select') ? /\bfrom\s+([a-z0-9_]+)/.exec(normalized) : null
      if (match) {
        readCountByTable[match[1]] = (readCountByTable[match[1]] ?? 0) + 1
      }
      return original.apply(this, args)
    }
  }

  try {
    return { result: await fn(), readCountByTable }
  } finally {
    for (const method of ['all', 'get', 'iterate'] as const) proto[method] = originals[method]
  }
}

function expectSettingsCommandReadOnlySettings(readCountByTable: Record<string, number>): void {
  expect(readCountByTable).toEqual({ schema_version: 1, settings: 1 })
}

function expectCollectionCommandReadOnlyTables(
  readCountByTable: Record<string, number>,
  collectionTables: readonly string[],
): void {
  const expected: Record<string, number> = {
    schema_version: 1,
    settings: 1,
    ...Object.fromEntries(collectionTables.map((table) => [table, 1])),
  }
  expect(readCountByTable).toEqual(expected)
}

function expectCollectionLoadOnlyTables(
  loadCountByTable: Record<string, number>,
  collectionTables: readonly string[],
): void {
  const expected = Object.fromEntries(collectionTables.map((table) => [table, 1]))
  expect(loadCountByTable).toEqual(expected)
}

function readSettingsRecord(): Record<string, unknown> {
  const db = openDatabase(harness.dataDir)
  try {
    const row = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
      data_json: string
    }
    return JSON.parse(row.data_json) as Record<string, unknown>
  } finally {
    db.close()
  }
}

function readStoredChatGenerationSettings(chatId: string): ChatGenerationSettings | undefined {
  const db = openDatabase(harness.dataDir)
  try {
    const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(chatId) as { data_json: string }
    return (JSON.parse(row.data_json) as { generationSettings?: ChatGenerationSettings }).generationSettings
  } finally {
    db.close()
  }
}

describe('command-mutation read narrowing on the large-corpus fixture', () => {
  it('a scriptstate PATCH performs zero whole-corpus payload reads', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const res = await assertScopedLoadOnHotPath(() =>
      command('PATCH', `/api/v1/commands/chats/${fixture.hot.chatId}/scriptstate`, {
        baseRevision: revision,
        patch: { $flag: 'on' },
        deleteKeys: ['$corpusScore'],
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().revision).toBe(revision + 1)

    // The patched scriptstate persisted into the one chat row.
    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        data_json: string
      }
      expect((JSON.parse(row.data_json) as { scriptstate?: unknown }).scriptstate).toEqual({
        $flag: 'on',
      })
    } finally {
      db.close()
    }
  })

  it('script and trigger definition commands use exact character and module-scoped reads', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase(fixture.database)

    async function runExactCharacterDefinitionCommand(path: 'scripts' | 'triggers'): Promise<void> {
      const payload =
        path === 'scripts'
          ? { scripts: [{ id: 'scoped-script', comment: 'Scoped', in: 'a', out: 'b', type: 'editinput' }] }
          : {
              triggers: [{ id: 'scoped-trigger', comment: 'Scoped', type: 'start', conditions: [], effect: [] }],
            }
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() =>
          command('PUT', `/api/v1/commands/characters/${fixture.hot.characterId}/${path}`, {
            baseRevision: revision,
            ...payload,
          }),
        ),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expect(loadRun.corpusLoadCount).toBe(0)
      expect(loadRun.loadCountByTable).toEqual({})
      expect(readCountByTable).toEqual({ schema_version: 1, settings: 1, characters: 1 })
      revision = loadRun.result.json().revision
    }

    async function runScopedModuleDefinitionCommand(path: 'scripts' | 'triggers'): Promise<void> {
      const payload =
        path === 'scripts'
          ? { scripts: [{ id: 'module-script', comment: 'Scoped', in: 'a', out: 'b', type: 'editinput' }] }
          : {
              triggers: [{ id: 'module-trigger', comment: 'Scoped', type: 'start', conditions: [], effect: [] }],
            }
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() =>
          command('PUT', `/api/v1/commands/modules/corpus-module-0/${path}`, {
            baseRevision: revision,
            ...payload,
          }),
        ),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expectCollectionCommandReadOnlyTables(readCountByTable, ['modules'])
      expectCollectionLoadOnlyTables(loadRun.loadCountByTable, ['modules'])
      revision = loadRun.result.json().revision
    }

    await runExactCharacterDefinitionCommand('scripts')
    await runExactCharacterDefinitionCommand('triggers')
    await runScopedModuleDefinitionCommand('scripts')
    await runScopedModuleDefinitionCommand('triggers')
  })

  it('character module-link commands load only the exact character row and modules collection', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)
    const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
      withServerLoadInstrumentation(() =>
        command('POST', `/api/v1/commands/characters/${fixture.hot.characterId}/modules/reorder`, {
          baseRevision: revision,
          moduleIds: ['corpus-module-1'],
        }),
      ),
    )

    expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
    expect(loadRun.corpusLoads.map((load) => load.table)).toEqual(['modules'])
    expect(loadRun.loadCountByTable).toEqual({ modules: 1 })
    expect(readCountByTable).toEqual({ schema_version: 1, settings: 1, modules: 1, characters: 1 })
  })

  it('compact definition mutations retain exact character and module-scoped read budgets', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase(fixture.database)
    const rows = {
      scripts: { id: 'compact-script', comment: 'Compact', in: 'a', out: 'b', type: 'editinput' },
      triggers: { id: 'compact-trigger', comment: 'Compact', type: 'start', conditions: [], effect: [] },
    }

    async function runCharacterPatch(path: 'scripts' | 'triggers'): Promise<void> {
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() =>
          command('PATCH', `/api/v1/commands/characters/${fixture.hot.characterId}/${path}`, {
            baseRevision: revision,
            mutation: { op: 'create', row: rows[path], index: 0 },
          }),
        ),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expect(loadRun.corpusLoadCount).toBe(0)
      expect(loadRun.loadCountByTable).toEqual({})
      expect(readCountByTable).toEqual({ schema_version: 1, settings: 1, characters: 1 })
      revision = loadRun.result.json().revision
    }

    async function runModulePatch(path: 'scripts' | 'triggers'): Promise<void> {
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() =>
          command('PATCH', `/api/v1/commands/modules/corpus-module-0/${path}`, {
            baseRevision: revision,
            mutation: { op: 'create', row: { ...rows[path], id: `module-${rows[path].id}` }, index: 0 },
          }),
        ),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expectCollectionCommandReadOnlyTables(readCountByTable, ['modules'])
      expectCollectionLoadOnlyTables(loadRun.loadCountByTable, ['modules'])
      revision = loadRun.result.json().revision
    }

    await runCharacterPatch('scripts')
    await runCharacterPatch('triggers')
    await runModulePatch('scripts')
    await runModulePatch('triggers')
  })

  it('chat-create performs zero whole-corpus message/hypa reads while writing only the new transcript', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)
    const targetCharacterId = fixture.hot.characterId
    const existingHotMessages = (await hydrationGet(fixture.hot.chatId)).json().message as Array<{
      chatId: string
    }>
    const metrics: CommandMutationMetric[] = []
    const previousProtocolMetrics = process.env.RISU_PROTOCOL_METRICS
    process.env.RISU_PROTOCOL_METRICS = '1'
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const unsubscribe = subscribeProtocolMetrics((metric) => metrics.push(metric as CommandMutationMetric))
    const { result: created, loadCountByTable } = await (async () => {
      try {
        return await withServerLoadInstrumentation(() =>
          command('POST', `/api/v1/commands/characters/${targetCharacterId}/chats`, {
            baseRevision: revision,
            select: false,
            chat: {
              id: 'h2-created-chat',
              name: 'H2 created',
              note: '',
              localLore: [],
              message: [
                { role: 'user', data: 'targeted create 1', chatId: 'h2-created-msg-1' },
                { role: 'char', data: 'targeted create 2', chatId: 'h2-created-msg-2' },
              ],
            },
          }),
        )
      } finally {
        unsubscribe()
        infoSpy.mockRestore()
        if (previousProtocolMetrics === undefined) delete process.env.RISU_PROTOCOL_METRICS
        else process.env.RISU_PROTOCOL_METRICS = previousProtocolMetrics
      }
    })()

    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: revision + 1,
      chatId: 'h2-created-chat',
      // The hot fixture starts on chatPage 0; select:false keeps that selection
      // even though the new chat is inserted at position 0.
      selectedChatId: fixture.hot.chatId,
      event: {
        type: 'chat.created',
        resource: 'chatTranscript',
        id: 'h2-created-chat',
        parentId: targetCharacterId,
      },
    })
    // A regression to `loadPersistedWithMessages` would whole-table read both
    // message payload families. The targeted path only does id/scoped lookups.
    expect(loadCountByTable.messages ?? 0).toBe(0)
    expect(loadCountByTable.chat_hypa_v3 ?? 0).toBe(0)
    const metric = metrics.find((entry) => entry.metric === 'command_mutation' && entry.status === 'ok')
    expect(metric).toBeTruthy()
    expect(metric?.mutationPath).toBe('targeted-character-row')
    expect(metric?.writtenTables).toEqual(['characters', 'chats', 'messages'])
    assertCommandMetricGate(metric as CommandMutationMetric)

    const db = openDatabase(harness.dataDir)
    try {
      const chatRows = db
        .prepare('SELECT id FROM chats WHERE character_id = ? ORDER BY position')
        .all(targetCharacterId) as Array<{ id: string }>
      expect(chatRows.map((row) => row.id).slice(0, 4)).toEqual([
        'h2-created-chat',
        fixture.hot.chatId,
        `corpus-chat-0-1`,
        `corpus-chat-0-2`,
      ])
      const charRow = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(targetCharacterId) as {
        data_json: string
      }
      expect((JSON.parse(charRow.data_json) as { chatPage?: number }).chatPage).toBe(1)
    } finally {
      db.close()
    }

    const createdMessages = (await hydrationGet('h2-created-chat')).json().message as Array<{
      chatId: string
    }>
    expect(createdMessages.map((message) => message.chatId)).toEqual(['h2-created-msg-1', 'h2-created-msg-2'])
    const hotAfter = (await hydrationGet(fixture.hot.chatId)).json().message as Array<{
      chatId: string
    }>
    expect(hotAfter.map((message) => message.chatId)).toEqual(existingHotMessages.map((message) => message.chatId))
  })

  it('character PATCH writes the target row without filling unrelated legacy defaults', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const setupDb = openDatabase(harness.dataDir)
    try {
      const row = setupDb.prepare('SELECT data_json FROM characters WHERE id = ?').get(fixture.hot.characterId) as {
        data_json: string
      }
      const character = JSON.parse(row.data_json) as Record<string, unknown>
      delete character.creatorNotes
      character.opaqueOwnerField = { preserve: ['target', 1] }
      setupDb
        .prepare('UPDATE characters SET data_json = ? WHERE id = ?')
        .run(JSON.stringify(character), fixture.hot.characterId)
    } finally {
      setupDb.close()
    }

    const res = await assertScopedLoadOnHotPath(() =>
      command('PATCH', `/api/v1/commands/characters/${fixture.hot.characterId}`, {
        baseRevision: revision,
        patch: { name: 'M5 renamed character', desc: 'target row only' },
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      revision: revision + 1,
      characterId: fixture.hot.characterId,
      event: {
        type: 'character.updated',
        resource: 'characterRow',
        id: fixture.hot.characterId,
      },
    })

    const db = openDatabase(harness.dataDir)
    try {
      const target = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(fixture.hot.characterId) as {
        data_json: string
      }
      const patched = JSON.parse(target.data_json) as Record<string, unknown>
      expect(patched).toMatchObject({
        chaId: fixture.hot.characterId,
        name: 'M5 renamed character',
        desc: 'target row only',
        opaqueOwnerField: { preserve: ['target', 1] },
      })
      expect(patched).not.toHaveProperty('creatorNotes')
      const sibling = db.prepare('SELECT data_json FROM characters WHERE id = ?').get('corpus-char-1') as {
        data_json: string
      }
      expect(JSON.parse(sibling.data_json).name).toBe('Corpus Character 1')
    } finally {
      db.close()
    }
  })

  it('chat PATCH without modules uses chatScopedRead and preserves selected chat state', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const { result: res, corpusLoadCount } = await withServerLoadInstrumentation(() =>
      command('PATCH', `/api/v1/commands/chats/${fixture.noHypa.chatId}`, {
        baseRevision: revision,
        select: true,
        patch: { name: 'M5 renamed chat', note: 'scoped metadata' },
      }),
    )

    expect(corpusLoadCount).toBe(0)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      revision: revision + 1,
      chatId: fixture.noHypa.chatId,
      selectedChatId: fixture.noHypa.chatId,
      event: {
        type: 'chat.updated',
        resource: 'characterRow',
        id: fixture.noHypa.chatId,
        parentId: fixture.noHypa.characterId,
      },
    })

    const db = openDatabase(harness.dataDir)
    try {
      const chat = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.noHypa.chatId) as {
        data_json: string
      }
      expect(JSON.parse(chat.data_json)).toMatchObject({
        id: fixture.noHypa.chatId,
        name: 'M5 renamed chat',
        note: 'scoped metadata',
      })
      const sibling = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        data_json: string
      }
      expect(JSON.parse(sibling.data_json).name).toBe('Chat 0-0')
      const character = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(fixture.noHypa.characterId) as {
        data_json: string
      }
      expect(JSON.parse(character.data_json).chatPage).toBe(1)
    } finally {
      db.close()
    }
  })

  it('chat PATCH takes the explicit broad fallback only for patch.modules', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const {
      result: res,
      corpusLoadCount,
      loadCountByTable,
    } = await withServerLoadInstrumentation(() =>
      command('PATCH', `/api/v1/commands/chats/${fixture.hot.chatId}`, {
        baseRevision: revision,
        patch: { modules: ['corpus-module-1'] },
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(corpusLoadCount).toBeGreaterThan(0)
    expect(loadCountByTable.modules).toBeGreaterThanOrEqual(1)

    const scoped = await assertScopedLoadOnHotPath(() =>
      command('PATCH', `/api/v1/commands/chats/${fixture.hot.chatId}`, {
        baseRevision: res.json().revision,
        patch: { note: 'non-module patch stayed scoped after module edit' },
      }),
    )
    expect(scoped.statusCode).toBe(200)
  })

  it('sparse chat generation-settings save reads only its target and validation owners', async () => {
    const fixture = buildLargeCorpusFixture()
    const promptPresets = fixture.database.promptPresets as Array<Record<string, unknown>>
    promptPresets[0].customPromptTemplateToggle = 'mode=Mode'
    const revision = await importDatabase(fixture.database)
    const initialSettings = readStoredChatGenerationSettings(fixture.hot.chatId)

    const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
      withServerLoadInstrumentation(() =>
        command('PUT', `/api/v1/commands/chats/${fixture.hot.chatId}/generation-settings`, {
          baseRevision: revision,
          baseGenerationSettingsDigest: chatGenerationSettingsDigest(initialSettings),
          patch: { sidebarToggles: { mode: '1' } },
        }),
      ),
    )

    const { result: res, loadCountByTable } = loadRun
    expect(res.statusCode).toBe(200)
    expect(loadCountByTable).toEqual({ modules: 1, personas: 1 })
    expect(readCountByTable).toEqual({
      schema_version: 1,
      settings: 1,
      modules: 1,
      model_presets: 1,
      prompt_presets: 1,
      personas: 1,
      chats: 1,
      characters: 1,
    })

    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        data_json: string
      }
      expect(JSON.parse(row.data_json).generationSettings).toEqual({
        ...initialSettings,
        sidebarToggles: { mode: '1' },
      })
    } finally {
      db.close()
    }
  })

  it('single-key plugin-storage PUT/DELETE skip database loads while bulk merge still reads current storage', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase(fixture.database)

    const putRun = await withServerLoadInstrumentation(() =>
      command('PUT', '/api/v1/commands/plugin-storage/l13-delete-me', {
        baseRevision: revision,
        value: { mode: 'single-key' },
      }),
    )
    expect(putRun.result.statusCode).toBe(200)
    expect(putRun.corpusLoadCount).toBe(0)
    expect(putRun.loadCountByTable.plugin_custom_storage ?? 0).toBe(0)
    revision = putRun.result.json().revision

    const deleteRun = await withServerLoadInstrumentation(() =>
      command('DELETE', '/api/v1/commands/plugin-storage/l13-delete-me', {
        baseRevision: revision,
      }),
    )
    expect(deleteRun.result.statusCode).toBe(200)
    expect(deleteRun.corpusLoadCount).toBe(0)
    expect(deleteRun.loadCountByTable.plugin_custom_storage ?? 0).toBe(0)
    revision = deleteRun.result.json().revision

    const bulkRun = await withServerLoadInstrumentation(() =>
      command('POST', '/api/v1/commands/plugin-storage/bulk', {
        baseRevision: revision,
        values: { 'l13-bulk-added': { merged: true } },
      }),
    )
    expect(bulkRun.result.statusCode).toBe(200)
    expect(bulkRun.loadCountByTable.plugin_custom_storage ?? 0).toBeGreaterThanOrEqual(1)

    const db = openDatabase(harness.dataDir)
    try {
      const rows = db.prepare('SELECT key, value_json FROM plugin_custom_storage ORDER BY key').all() as Array<{
        key: string
        value_json: string
      }>
      expect(Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]))).toEqual({
        'corpus-plugin': { counter: 1 },
        'l13-bulk-added': { merged: true },
      })
    } finally {
      db.close()
    }
  })

  it('settings commands read only settings plus the explicitly owned Hypa collection', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase({
      ...fixture.database,
      theme: 'dark',
      mainPrompt: 'Old main prompt',
    })

    const settingsRun = await withSqliteSelectReadInstrumentation(() =>
      withServerLoadInstrumentation(() =>
        command('PATCH', '/api/v1/commands/settings/display', {
          baseRevision: revision,
          patch: { theme: 'light' },
        }),
      ),
    )
    expect(settingsRun.result.result.statusCode).toBe(200)
    expect(settingsRun.result.corpusLoadCount).toBe(0)
    expectSettingsCommandReadOnlySettings(settingsRun.readCountByTable)
    revision = settingsRun.result.result.json().revision

    const memoryRun = await withSqliteSelectReadInstrumentation(() =>
      withServerLoadInstrumentation(() =>
        command('PATCH', '/api/v1/commands/settings/memory', {
          baseRevision: revision,
          patch: {
            selectedHypaV3PresetId: 'request-preset',
            hypaV3Presets: [{ id: 'request-preset', name: 'request-preset', settings: {} }],
          },
        }),
      ),
    )
    expect(memoryRun.result.result.statusCode).toBe(200)
    expect(memoryRun.result.corpusLoadCount).toBe(1)
    expectCollectionLoadOnlyTables(memoryRun.result.loadCountByTable, ['hypa_v3_presets'])
    expectCollectionCommandReadOnlyTables(memoryRun.readCountByTable, ['hypa_v3_presets'])

    const db = openDatabase(harness.dataDir)
    try {
      const rows = db.prepare('SELECT data_json FROM hypa_v3_presets ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(rows.map((row) => JSON.parse(row.data_json))).toEqual([
        { id: 'request-preset', name: 'request-preset', settings: {} },
      ])
    } finally {
      db.close()
    }
    revision = memoryRun.result.result.json().revision

    const promptRun = await withSqliteSelectReadInstrumentation(() =>
      withServerLoadInstrumentation(() =>
        command('PATCH', '/api/v1/commands/prompt-settings', {
          baseRevision: revision,
          patch: { mainPrompt: 'Scoped main prompt' },
        }),
      ),
    )
    expect(promptRun.result.result.statusCode).toBe(200)
    expect(promptRun.result.corpusLoadCount).toBe(0)
    expectSettingsCommandReadOnlySettings(promptRun.readCountByTable)
  })

  it('settings scoped read falls back broad for legacy embedded settings rows', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const db = openDatabase(harness.dataDir)
    try {
      const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.characters = [
        {
          chaId: 'embedded-char',
          name: 'Embedded',
          chats: [{ id: 'embedded-chat', name: 'Embedded chat', message: [] }],
        },
      ]
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
      db.exec('DELETE FROM chats')
      db.exec('DELETE FROM characters')
    } finally {
      db.close()
    }

    const {
      result: res,
      corpusLoadCount,
      loadCountByTable,
    } = await withServerLoadInstrumentation(() =>
      command('PATCH', '/api/v1/commands/settings/display', {
        baseRevision: revision,
        patch: { theme: 'legacy-fallback' },
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(corpusLoadCount).toBeGreaterThan(0)
    expect(loadCountByTable.characters ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('keeps all five root prompt-item mutation reads scoped to settings and prompt templates', async () => {
    const fixture = buildLargeCorpusFixture()
    fixture.database.promptTemplate = [
      { id: 'root-prompt-item-a', type: 'plain', text: 'Root A' },
      { id: 'root-prompt-item-b', type: 'plain', text: 'Root B' },
    ]
    let revision = await importDatabase(fixture.database)

    async function runRootPromptItemCommand(
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload: Record<string, unknown>,
    ): Promise<void> {
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() => command(method, url, payload)),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expectCollectionCommandReadOnlyTables(readCountByTable, ['prompt_templates'])
      expectCollectionLoadOnlyTables(loadRun.loadCountByTable, ['prompt_templates'])
      revision = loadRun.result.json().revision
    }

    await runRootPromptItemCommand('POST', '/api/v1/commands/prompt-items', {
      baseRevision: revision,
      promptItem: { id: 'root-prompt-item-c', type: 'plain', text: 'Root C' },
    })
    await runRootPromptItemCommand('PATCH', '/api/v1/commands/prompt-items/root-prompt-item-a', {
      baseRevision: revision,
      patch: { text: 'Root A patched' },
    })
    await runRootPromptItemCommand('DELETE', '/api/v1/commands/prompt-items/root-prompt-item-b', {
      baseRevision: revision,
    })
    await runRootPromptItemCommand('POST', '/api/v1/commands/prompt-items/reorder', {
      baseRevision: revision,
      itemIds: ['root-prompt-item-c', 'root-prompt-item-a'],
    })
    await runRootPromptItemCommand('POST', '/api/v1/commands/prompt-items/enable', {
      baseRevision: revision,
      enabled: false,
    })
  })

  it('keeps all five preset-owned prompt-item mutation reads prompt-presets scoped', async () => {
    const fixture = buildLargeCorpusFixture()
    const promptPresets = fixture.database.promptPresets as Array<Record<string, unknown>>
    promptPresets[0] = {
      ...promptPresets[0],
      promptTemplate: [
        { id: 'preset-prompt-item-a', type: 'plain', text: 'Preset A' },
        { id: 'preset-prompt-item-b', type: 'plain', text: 'Preset B' },
      ],
    }
    let revision = await importDatabase(fixture.database)

    async function runPresetPromptItemCommand(
      method: 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload: Record<string, unknown>,
    ): Promise<void> {
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() => command(method, url, payload)),
      )

      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expectCollectionCommandReadOnlyTables(readCountByTable, ['prompt_presets'])
      expectCollectionLoadOnlyTables(loadRun.loadCountByTable, [])
      revision = loadRun.result.json().revision
    }

    const scoped = { promptPresetId: 'corpus-prompt-preset-0' }
    await runPresetPromptItemCommand('POST', '/api/v1/commands/prompt-items', {
      baseRevision: revision,
      ...scoped,
      promptItem: { id: 'preset-prompt-item-c', type: 'plain', text: 'Preset C' },
    })
    await runPresetPromptItemCommand('PATCH', '/api/v1/commands/prompt-items/preset-prompt-item-a', {
      baseRevision: revision,
      ...scoped,
      patch: { text: 'Preset A patched' },
    })
    await runPresetPromptItemCommand('DELETE', '/api/v1/commands/prompt-items/preset-prompt-item-b', {
      baseRevision: revision,
      ...scoped,
    })
    await runPresetPromptItemCommand('POST', '/api/v1/commands/prompt-items/reorder', {
      baseRevision: revision,
      ...scoped,
      itemIds: ['preset-prompt-item-c', 'preset-prompt-item-a'],
    })
    await runPresetPromptItemCommand('POST', '/api/v1/commands/prompt-items/enable', {
      baseRevision: revision,
      ...scoped,
      enabled: false,
    })
  })

  it('collection commands read only settings plus requested collection tables', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase(fixture.database)

    async function runScopedCollectionCommand(
      method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: string,
      payload: Record<string, unknown>,
      expectedTables: readonly string[],
      expectedLoadTables: readonly string[] = expectedTables,
    ): Promise<Record<string, unknown>> {
      const { result: loadRun, readCountByTable } = await withSqliteSelectReadInstrumentation(() =>
        withServerLoadInstrumentation(() => command(method, url, payload)),
      )
      expect(loadRun.result.statusCode, JSON.stringify(loadRun.result.json())).toBe(200)
      expectCollectionCommandReadOnlyTables(readCountByTable, expectedTables)
      expectCollectionLoadOnlyTables(loadRun.loadCountByTable, expectedLoadTables)
      const body = loadRun.result.json() as Record<string, unknown>
      revision = body.revision as number
      return body
    }

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/presets',
      { baseRevision: revision, preset: { id: 'l11-preset', name: 'L11 Preset' } },
      ['bot_presets'],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/presets/select',
      { baseRevision: revision, presetId: 'l11-preset' },
      ['bot_presets'],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/prompt-items',
      {
        baseRevision: revision,
        promptPresetId: 'corpus-prompt-preset-0',
        promptItem: { id: 'l11-prompt-item', type: 'plain', text: 'L11 prompt item' },
      },
      ['prompt_presets'],
      [],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/personas',
      { baseRevision: revision, persona: { id: 'l11-persona', name: 'L11 Persona' } },
      ['personas', 'modules'],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/translator-presets',
      {
        baseRevision: revision,
        select: true,
        preset: {
          id: 'l11-translator',
          name: 'L11 Translator',
          prompt: 'Translate narrowly',
          maxResponse: 777,
        },
      },
      ['translator_presets'],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/loadouts/corpus-loadout-1/touch',
      { baseRevision: revision, lastUsed: 4242 },
      ['loadouts'],
    )
    expect(readSettingsRecord().lastLoadedLoadoutName).toBe('Loadout 1')

    await runScopedCollectionCommand(
      'PATCH',
      '/api/v1/commands/lorebooks/corpus-lore-1',
      { baseRevision: revision, patch: { name: 'L11 Lore' } },
      ['lore_books'],
    )

    await runScopedCollectionCommand(
      'PATCH',
      '/api/v1/commands/modules/corpus-module-1',
      { baseRevision: revision, patch: { name: 'L11 Module' } },
      ['modules'],
    )

    await runScopedCollectionCommand(
      'PUT',
      '/api/v1/commands/modules/corpus-module-1/lorebooks',
      { baseRevision: revision, entries: [] },
      ['modules'],
    )

    await runScopedCollectionCommand(
      'POST',
      '/api/v1/commands/plugins',
      {
        baseRevision: revision,
        plugin: {
          name: 'l11-plugin',
          script: '',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
        },
      },
      ['plugins'],
    )
  })

  it('collection scoped reads fall back broad for unrelated embedded settings rows', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const db = openDatabase(harness.dataDir)
    try {
      const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as {
        data_json: string
      }
      const settings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      settings.characters = [{ chaId: 'embedded-char', name: 'Embedded' }]
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))
    } finally {
      db.close()
    }

    const {
      result: res,
      corpusLoadCount,
      loadCountByTable,
    } = await withServerLoadInstrumentation(() =>
      command('POST', '/api/v1/commands/presets', {
        baseRevision: revision,
        preset: { id: 'l11-fallback-preset', name: 'L11 Fallback' },
      }),
    )

    expect(res.statusCode).toBe(200)
    expect(corpusLoadCount).toBeGreaterThan(1)
    expect(loadCountByTable.characters ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('the full message lifecycle stays scoped (append, patch, delete, truncate, replace, generation-result)', async () => {
    const fixture = buildLargeCorpusFixture()
    let revision = await importDatabase(fixture.database)
    const chatId = fixture.hot.chatId

    // Append.
    const appended = await assertScopedLoadOnHotPath(() =>
      command('POST', `/api/v1/commands/chats/${chatId}/messages`, {
        baseRevision: revision,
        message: { role: 'user', data: 'scoped append', chatId: 'scoped-msg-1' },
      }),
    )
    expect(appended.statusCode).toBe(200)
    revision = appended.json().revision

    // Patch by message id (the loader resolves the chat from the uid index).
    const patched = await assertScopedLoadOnHotPath(() =>
      command('PATCH', '/api/v1/commands/messages/scoped-msg-1', {
        baseRevision: revision,
        patch: { data: 'scoped append (edited)' },
      }),
    )
    expect(patched.statusCode).toBe(200)
    expect(patched.json().chatId).toBe(chatId)
    revision = patched.json().revision

    // Delete by message id.
    const deleted = await assertScopedLoadOnHotPath(() =>
      command('DELETE', '/api/v1/commands/messages/scoped-msg-1', {
        baseRevision: revision,
      }),
    )
    expect(deleted.statusCode).toBe(200)
    revision = deleted.json().revision

    // Truncate after a fixture message.
    const keepUntil = `corpus-msg-0-0-${fixture.hot.messageCount - 3}`
    const truncated = await assertScopedLoadOnHotPath(() =>
      command('POST', `/api/v1/commands/chats/${chatId}/messages/truncate`, {
        baseRevision: revision,
        afterMessageId: keepUntil,
      }),
    )
    expect(truncated.statusCode).toBe(200)
    expect(truncated.json().removedCount).toBe(2)
    revision = truncated.json().revision

    // Replace the whole transcript.
    const replaced = await assertScopedLoadOnHotPath(() =>
      command('PUT', `/api/v1/commands/chats/${chatId}/messages`, {
        baseRevision: revision,
        messages: [
          { role: 'user', data: 'fresh start', chatId: 'scoped-msg-2' },
          { role: 'char', data: 'fresh reply', chatId: 'scoped-msg-3' },
        ],
      }),
    )
    expect(replaced.statusCode).toBe(200)
    revision = replaced.json().revision

    // Generation-result persistence.
    const generated = await assertScopedLoadOnHotPath(() =>
      command('POST', `/api/v1/commands/chats/${chatId}/generation-result`, {
        baseRevision: revision,
        generationResult: {
          message: {
            role: 'char',
            data: 'generated answer',
            chatId: 'scoped-gen-1',
            generationInfo: { generationId: 'scoped-gen-1' },
          },
        },
      }),
    )
    expect(generated.statusCode).toBe(200)
    revision = generated.json().revision

    // The chained writes landed: hydrate the chat (itself scoped, H1).
    const hydrated = await hydrationGet(chatId)
    expect(hydrated.statusCode).toBe(200)
    expect((hydrated.json().message as Array<{ chatId: string }>).map((m) => m.chatId)).toEqual([
      'scoped-msg-2',
      'scoped-msg-3',
      'scoped-gen-1',
    ])
  })

  it('returns identical rows to the broad loader for both chat-id and message-id targets', async () => {
    const fixture = buildLargeCorpusFixture()
    await importDatabase(fixture.database)

    const db = openDatabase(harness.dataDir)
    try {
      const broad = loadPersisted(db, harness.dataDir).database as {
        characters: Array<{ chaId?: string; chats: Array<{ id?: string }> }>
      }
      const broadChar = broad.characters.find((c) => c.chats.some((chat) => chat.id === fixture.hot.chatId))!
      const broadChat = broadChar.chats.find((chat) => chat.id === fixture.hot.chatId)!

      const scopedRun = await withServerLoadInstrumentation(() =>
        loadPersistedForChatMutation(db, harness.dataDir, { chatId: fixture.hot.chatId }),
      )
      // The scoped read performs zero whole-corpus payload reads of ANY table.
      expect(scopedRun.corpusLoadCount).toBe(0)

      const scoped = scopedRun.result.database as {
        characters: Array<{ chats: Array<{ id?: string }> }>
      }
      expect(scoped.characters).toHaveLength(1)
      expect(scoped.characters[0].chats).toHaveLength(broadChar.chats.length)
      // Identical payload parses: same character (modulo the chats narrowing)
      // and the same target chat record; sibling chats are id-only stubs so
      // chatPage/selectedChatId math stays correct without parsing them.
      expect(scoped.characters[0].chats[0]).toEqual(broadChat)
      expect(scoped.characters[0].chats.slice(1)).toEqual(broadChar.chats.slice(1).map((chat) => ({ id: chat.id })))
      expect({ ...scoped.characters[0], chats: broadChar.chats }).toEqual(broadChar)

      // Message-id targeting resolves the same chat through the uid index.
      const byMessage = await assertScopedLoadOnHotPath(() =>
        loadPersistedForChatMutation(db, harness.dataDir, {
          messageId: `corpus-msg-0-0-0`,
        }),
      )
      const byMessageChars = (byMessage.database as { characters: unknown[] }).characters
      expect(byMessageChars).toEqual(scoped.characters)
    } finally {
      db.close()
    }
  })

  it('can load an exact scoped chat row without repairing generation settings', async () => {
    const fixture = buildLargeCorpusFixture()
    await importDatabase(fixture.database)
    const degradedGenerationSettings = {
      configured: 'legacy',
      sidebarToggles: { keep: 'on', invalid: 17 },
      unknown: { nested: true },
    }

    const db = openDatabase(harness.dataDir)
    try {
      const row = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        data_json: string
      }
      const chat = JSON.parse(row.data_json) as Record<string, unknown>
      chat.generationSettings = degradedGenerationSettings
      db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(chat), fixture.hot.chatId)

      const repaired = loadPersistedForChatMutation(db, harness.dataDir, { chatId: fixture.hot.chatId })
      const repairedChat = (repaired.database as { characters: Array<{ chats: Array<Record<string, unknown>> }> })
        .characters[0].chats[0]
      expect(repairedChat.generationSettings).not.toStrictEqual(degradedGenerationSettings)

      const exact = loadPersistedForChatMutation(db, harness.dataDir, {
        chatId: fixture.hot.chatId,
        exactChatRow: true,
      })
      const exactChat = (exact.database as { characters: Array<{ chats: Array<Record<string, unknown>> }> })
        .characters[0].chats[0]
      expect(exactChat.generationSettings).toStrictEqual(degradedGenerationSettings)
    } finally {
      db.close()
    }
  })

  it('single-chat commands preserve noncanonical target metadata and sibling rows', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)
    const db = openDatabase(harness.dataDir)
    try {
      const siblingId = fixture.characters[0].chats[1].id
      const siblingBefore = db.prepare('SELECT rowid, data_json FROM chats WHERE id = ?').get(siblingId) as {
        rowid: number
        data_json: string
      }
      const sibling = JSON.parse(siblingBefore.data_json) as Record<string, unknown>
      sibling.folderId = 'orphan-folder'
      sibling.opaqueOwnerField = { keep: true }
      sibling.generationSettings = {
        configured: 'legacy',
        sidebarToggles: { keep: 'on', invalid: 17 },
        unknown: { nested: true },
      }
      const siblingJson = JSON.stringify(sibling)
      db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(siblingJson, siblingId)

      const targetBefore = db.prepare('SELECT rowid, data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        rowid: number
        data_json: string
      }
      const target = JSON.parse(targetBefore.data_json) as Record<string, unknown>
      target.folderId = 'orphan-target-folder'
      target.opaqueOwnerField = { keep: ['target', 2] }
      target.generationSettings = {
        configured: 'legacy',
        sidebarToggles: { keep: 'on', invalid: 17 },
        unknown: { nested: true },
      }
      target.scriptstate = {}
      db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(JSON.stringify(target), fixture.hot.chatId)

      const expectedTarget = {
        ...target,
        scriptstate: { '$sibling-proof': 'target-only' },
      }

      const assertSiblingStable = () => {
        const siblingAfter = db.prepare('SELECT rowid, data_json FROM chats WHERE id = ?').get(siblingId) as {
          rowid: number
          data_json: string
        }
        expect(siblingAfter.rowid).toBe(siblingBefore.rowid)
        expect(siblingAfter.data_json).toBe(siblingJson)
      }
      const assertTargetMetadataStable = () => {
        const targetAfter = db.prepare('SELECT rowid, data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
          rowid: number
          data_json: string
        }
        expect(targetAfter.rowid).toBe(targetBefore.rowid)
        expect(JSON.parse(targetAfter.data_json)).toStrictEqual(expectedTarget)
      }

      let response = await command('PATCH', `/api/v1/commands/chats/${fixture.hot.chatId}/scriptstate`, {
        baseRevision: revision,
        patch: { '$sibling-proof': 'target-only' },
      })
      expect(response.statusCode, response.body).toBe(200)
      let nextRevision = response.json().revision as number
      assertSiblingStable()
      assertTargetMetadataStable()

      response = await command('POST', `/api/v1/commands/chats/${fixture.hot.chatId}/messages`, {
        baseRevision: nextRevision,
        message: { role: 'user', data: 'target-only message', chatId: 'target-only-message' },
      })
      expect(response.statusCode, response.body).toBe(200)
      nextRevision = response.json().revision as number
      assertSiblingStable()
      assertTargetMetadataStable()

      response = await command('POST', `/api/v1/commands/chats/${fixture.hot.chatId}/generation-result`, {
        baseRevision: nextRevision,
        generationResult: {
          message: {
            role: 'char',
            data: 'target-only generation',
            chatId: 'target-only-generation',
            generationInfo: { generationId: 'target-only-generation' },
          },
        },
      })
      expect(response.statusCode, response.body).toBe(200)
      assertSiblingStable()
      assertTargetMetadataStable()
    } finally {
      db.close()
    }
  })

  it('ordinary scoped mutations reject damaged target rows instead of repairing them', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)
    const db = openDatabase(harness.dataDir)
    try {
      const characterRow = db.prepare('SELECT data_json FROM characters WHERE id = ?').get(fixture.hot.characterId) as {
        data_json: string
      }
      const character = JSON.parse(characterRow.data_json) as Record<string, unknown>
      const damagedCharacter = { ...character }
      delete damagedCharacter.chaId
      const damagedCharacterJson = JSON.stringify(damagedCharacter)
      db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(damagedCharacterJson, fixture.hot.characterId)

      const characterPatch = await command('PATCH', `/api/v1/commands/characters/${fixture.hot.characterId}`, {
        baseRevision: revision,
        patch: { name: 'must not repair' },
      })
      expect(characterPatch.statusCode).toBe(400)
      expect(characterPatch.json().error).toBe('character.chaId must be a non-empty string')
      expect(
        (
          db.prepare('SELECT data_json FROM characters WHERE id = ?').get(fixture.hot.characterId) as {
            data_json: string
          }
        ).data_json,
      ).toBe(damagedCharacterJson)
      db.prepare('UPDATE characters SET data_json = ? WHERE id = ?').run(
        characterRow.data_json,
        fixture.hot.characterId,
      )

      const chatRow = db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as {
        data_json: string
      }
      const damagedChat = JSON.parse(chatRow.data_json) as Record<string, unknown>
      delete damagedChat.note
      const damagedChatJson = JSON.stringify(damagedChat)
      db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(damagedChatJson, fixture.hot.chatId)

      const scriptstatePatch = await command('PATCH', `/api/v1/commands/chats/${fixture.hot.chatId}/scriptstate`, {
        baseRevision: revision,
        patch: { $flag: 'must not repair' },
      })
      expect(scriptstatePatch.statusCode).toBe(400)
      expect(scriptstatePatch.json().error).toBe('chat.note must be a string')
      expect(
        (db.prepare('SELECT data_json FROM chats WHERE id = ?').get(fixture.hot.chatId) as { data_json: string })
          .data_json,
      ).toBe(damagedChatJson)
      db.prepare('UPDATE chats SET data_json = ? WHERE id = ?').run(chatRow.data_json, fixture.hot.chatId)

      const messageId = `corpus-msg-0-0-0`
      const messageRow = db.prepare('SELECT json FROM messages WHERE uid = ? AND alternate = 0').get(messageId) as {
        json: string
      }
      const damagedMessage = JSON.parse(messageRow.json) as Record<string, unknown>
      damagedMessage.role = 'legacy-invalid'
      const damagedMessageJson = JSON.stringify(damagedMessage)
      db.prepare('UPDATE messages SET role = ?, json = ? WHERE uid = ? AND alternate = 0').run(
        'legacy-invalid',
        damagedMessageJson,
        messageId,
      )

      const messagePatch = await command('PATCH', `/api/v1/commands/messages/${messageId}`, {
        baseRevision: revision,
        patch: { data: 'must not coerce' },
      })
      expect(messagePatch.statusCode).toBe(400)
      expect(messagePatch.json().error).toBe('message.role must be user or char')
      expect(
        (db.prepare('SELECT json FROM messages WHERE uid = ? AND alternate = 0').get(messageId) as { json: string })
          .json,
      ).toBe(damagedMessageJson)
    } finally {
      db.close()
    }
  })

  it('ordinary collection and Agent commands leave malformed persisted owners byte-identical', async () => {
    const fixture = buildLargeCorpusFixture()
    fixture.database.botPresets = [
      { id: 'preset-a', name: 'Preset A' },
      { id: 'preset-b', name: 'Preset B' },
    ]
    fixture.database.botPresetsId = 0
    fixture.database.currentPluginProvider = ''
    fixture.database.plugins = [
      {
        name: 'plugin-a',
        script: '',
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        version: '3.0',
      },
      {
        name: 'plugin-b',
        script: '',
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        version: '3.0',
      },
    ]
    const revision = await importDatabase(fixture.database)
    const db = openDatabase(harness.dataDir)
    try {
      const eventCount = () =>
        (db.prepare('SELECT COUNT(*) AS count FROM command_events').get() as { count: number }).count
      const beforeEvents = eventCount()

      const presetRows = db
        .prepare('SELECT position, data_json FROM bot_presets ORDER BY position')
        .all() as unknown as Array<{
        position: number
        data_json: string
      }>
      const damagedPreset = { ...(JSON.parse(presetRows[1].data_json) as Record<string, unknown>), id: 'preset-a' }
      const damagedPresetJson = JSON.stringify(damagedPreset)
      db.prepare('UPDATE bot_presets SET data_json = ? WHERE position = 1').run(damagedPresetJson)
      const presetPatch = await command('PATCH', '/api/v1/commands/presets/preset-a', {
        baseRevision: revision,
        patch: { name: 'must not repair presets' },
      })
      expect(presetPatch.statusCode).toBe(400)
      expect(presetPatch.json().error).toBe('Duplicate botPresets id: preset-a')
      expect(
        (db.prepare('SELECT data_json FROM bot_presets WHERE position = 1').get() as { data_json: string }).data_json,
      ).toBe(damagedPresetJson)
      db.prepare('UPDATE bot_presets SET data_json = ? WHERE position = 1').run(presetRows[1].data_json)

      const promptRow = db.prepare('SELECT data_json FROM prompt_presets WHERE position = 0').get() as {
        data_json: string
      }
      const damagedPromptPreset = JSON.parse(promptRow.data_json) as Record<string, unknown>
      const damagedPromptItems = damagedPromptPreset.promptTemplate as Array<Record<string, unknown>>
      delete damagedPromptItems[0].id
      const damagedPromptJson = JSON.stringify(damagedPromptPreset)
      db.prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 0').run(damagedPromptJson)
      const promptCreate = await command('POST', '/api/v1/commands/prompt-items', {
        baseRevision: revision,
        promptPresetId: 'corpus-prompt-preset-0',
        promptItem: { id: 'must-not-create', type: 'plain', text: 'must not repair prompts' },
      })
      expect(promptCreate.statusCode).toBe(400)
      expect(promptCreate.json().error).toContain('promptTemplate[0].id must be a non-empty string')
      expect(
        (db.prepare('SELECT data_json FROM prompt_presets WHERE position = 0').get() as { data_json: string })
          .data_json,
      ).toBe(damagedPromptJson)
      db.prepare('UPDATE prompt_presets SET data_json = ? WHERE position = 0').run(promptRow.data_json)

      const pluginRows = db
        .prepare('SELECT position, data_json FROM plugins ORDER BY position')
        .all() as unknown as Array<{
        position: number
        data_json: string
      }>
      const damagedPlugin = { ...(JSON.parse(pluginRows[1].data_json) as Record<string, unknown>), name: 'plugin-a' }
      const damagedPluginJson = JSON.stringify(damagedPlugin)
      db.prepare('UPDATE plugins SET data_json = ? WHERE position = 1').run(damagedPluginJson)
      const pluginPatch = await command('PATCH', '/api/v1/commands/plugins/plugin-a', {
        baseRevision: revision,
        patch: { enabled: true },
      })
      expect(pluginPatch.statusCode).toBe(400)
      expect(pluginPatch.json().error).toBe('Duplicate plugins id: plugin-a')
      expect(
        (db.prepare('SELECT data_json FROM plugins WHERE position = 1').get() as { data_json: string }).data_json,
      ).toBe(damagedPluginJson)
      db.prepare('UPDATE plugins SET data_json = ? WHERE position = 1').run(pluginRows[1].data_json)

      const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
      const damagedSettings = JSON.parse(settingsRow.data_json) as Record<string, unknown>
      damagedSettings.agents = {}
      const damagedSettingsJson = JSON.stringify(damagedSettings)
      db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(damagedSettingsJson)
      const agentCreate = await command('POST', '/api/v1/commands/agents', {
        baseRevision: revision,
        agent: {},
      })
      expect(agentCreate.statusCode).toBe(400)
      expect(agentCreate.json().error).toBe('agents must be an array')
      expect((db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json).toBe(
        damagedSettingsJson,
      )

      expect(eventCount()).toBe(beforeEvents)
    } finally {
      db.close()
    }
  })

  it('prefers canonical character/chat/message rows over embedded payloads across reopen', async () => {
    const fixture = buildLargeCorpusFixture()
    await importDatabase(fixture.database)
    const staleMessage = { role: 'char', data: 'stale embedded', chatId: 'stale-message' }
    const staleHypa = { mainChunks: [{ text: 'stale embedded hypa' }] }
    const canonicalChat = fixture.characters
      .flatMap((character) => character.chats)
      .find((chat) => chat.id === fixture.hot.chatId)!
    const db = openDatabase(harness.dataDir)
    const staleDatabase = {
      characters: [
        {
          chaId: fixture.hot.characterId,
          chats: [
            {
              id: fixture.hot.chatId,
              message: [staleMessage],
              hypaV3Data: staleHypa,
            },
          ],
        },
      ],
    }
    const settings = JSON.parse(
      (db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
    ) as Record<string, unknown>
    settings.characters = staleDatabase.characters
    db.prepare('UPDATE settings SET data_json = ? WHERE id = 1').run(JSON.stringify(settings))

    const assertCanonicalWins = () => {
      const persisted = loadPersisted(db, harness.dataDir).database as {
        characters: Array<{ chats: Array<{ id: string; message?: unknown[] }> }>
      }
      const character = persisted.characters.find((candidate) =>
        candidate.chats.some((chat) => chat.id === fixture.hot.chatId),
      )!
      const chat = character.chats.find((candidate) => candidate.id === fixture.hot.chatId)!
      expect(chat.message).toBeUndefined()
      const hydration = loadChatHydration(db, harness.dataDir, fixture.hot.chatId)
      expect(hydration.message).toEqual(canonicalChat.message)
      expect(hydration.hypaV3Data).toEqual(canonicalChat.hypaV3Data)
    }

    try {
      assertCanonicalWins()
    } finally {
      db.close()
    }

    const reopened = openDatabase(harness.dataDir)
    try {
      const persisted = loadPersisted(reopened, harness.dataDir).database as {
        characters: Array<{ chats: Array<{ id: string }> }>
      }
      expect(persisted.characters.flatMap((character) => character.chats).map((chat) => chat.id)).toContain(
        fixture.hot.chatId,
      )
      const hydration = loadChatHydration(reopened, harness.dataDir, fixture.hot.chatId)
      expect(hydration.message).toEqual(canonicalChat.message)
      expect(hydration.hypaV3Data).toEqual(canonicalChat.hypaV3Data)
    } finally {
      reopened.close()
    }
  })

  it('falls back to the broad load for an unknown chat id — the 404 contract is unchanged', async () => {
    const fixture = buildLargeCorpusFixture()
    const revision = await importDatabase(fixture.database)

    const { result: res, corpusLoadCount } = await withServerLoadInstrumentation(() =>
      command('PATCH', '/api/v1/commands/chats/no-such-chat/scriptstate', {
        baseRevision: revision,
        patch: { $flag: 'on' },
      }),
    )
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Chat not found: no-such-chat')
    // The miss path engaged the documented broad fallback (and stayed correct).
    expect(corpusLoadCount).toBeGreaterThan(0)

    const missingMessage = await command('PATCH', '/api/v1/commands/messages/no-such-message', {
      baseRevision: revision,
      patch: { data: 'x' },
    })
    expect(missingMessage.statusCode).toBe(404)
    expect(missingMessage.json().error).toBe('Message not found: no-such-message')
  })

  it('pre-extraction embedded state: falls back broad and the global chat-id dedup still runs', async () => {
    const db = openDatabase(harness.dataDir)
    try {
      // Simulate the pre-extraction edge: characters/chats tables empty, the
      // settings blob still embeds characters — with a cross-character
      // duplicate chat id, the one state where the global dedup has work.
      db.exec('DELETE FROM chats')
      db.exec('DELETE FROM characters')
      const embeddedGenerationSettings = {
        configured: 'legacy',
        sidebarToggles: { keep: 'on', invalid: 17 },
        unknown: true,
      }
      const embedded = {
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            chats: [
              {
                id: 'dup-chat',
                name: 'A1',
                generationSettings: embeddedGenerationSettings,
              },
            ],
          },
          { chaId: 'char-b', name: 'B', chats: [{ id: 'dup-chat', name: 'B1' }] },
        ],
      }
      db.exec('DELETE FROM settings')
      db.prepare('INSERT INTO settings (id, data_json) VALUES (1, ?)').run(JSON.stringify(embedded))

      // The chats table has no row for the target → broad fallback returns the
      // embedded characters…
      const persisted = loadPersistedForChatMutation(db, harness.dataDir, {
        chatId: 'dup-chat',
      })
      const characters = (persisted.database as { characters: unknown[] }).characters
      expect(characters).toHaveLength(2)

      // Generation-settings uses a separate partial loader, so protect its
      // legacy fallback independently from the ordinary chat loader above.
      const generationSettingsFallback = loadPersistedForChatGenerationSettingsMutation(db, harness.dataDir, {
        chatId: 'dup-chat',
      })
      const generationSettingsCharacters = (generationSettingsFallback.database as { characters: unknown[] }).characters
      expect(generationSettingsCharacters).toHaveLength(2)

      const exactFallback = loadPersistedForChatMutation(db, harness.dataDir, {
        chatId: 'dup-chat',
        exactChatRow: true,
      })
      const exactChat = (exactFallback.database as { characters: Array<{ chats: Array<Record<string, unknown>> }> })
        .characters[0].chats[0]
      expect(exactChat.generationSettings).toStrictEqual(embeddedGenerationSettings)

      // …and `normalizeAllCharacterChats` still repairs the duplicate exactly
      // as on the never-narrowed path.
      const normalized = normalizeAllCharacterChats(persisted.database)
      const chatsA = normalized[0].chats as Array<{ id: string }>
      const chatsB = normalized[1].chats as Array<{ id: string }>
      expect(chatsA[0].id).toBe('dup-chat')
      expect(chatsB[0].id).not.toBe('dup-chat')
    } finally {
      db.close()
    }
  })

  it('rejects chat-scoped reads combined with writeDatabase (data-loss guard)', async () => {
    const db = openDatabase(harness.dataDir)
    try {
      expect(() =>
        applyTargetedCommandMutation({
          db,
          dataDir: harness.dataDir,
          baseRevision: 0,
          eventSink: { emit() {} } as never,
          mutationPath: 'targeted-chat-row',
          writeDatabase: true,
          chatScopedRead: { chatId: 'any' },
          mutate() {
            throw new Error('must not be reached')
          },
        }),
      ).toThrow('chatScopedRead cannot be combined with writeDatabase')
      expect(() =>
        applyTargetedCommandMutation({
          db,
          dataDir: harness.dataDir,
          baseRevision: 0,
          eventSink: { emit() {} } as never,
          mutationPath: 'targeted-chat-row',
          writeDatabase: true,
          chatGenerationSettingsScopedRead: { chatId: 'any' },
          mutate() {
            throw new Error('must not be reached')
          },
        }),
      ).toThrow('chatGenerationSettingsScopedRead cannot be combined with writeDatabase')
    } finally {
      db.close()
    }
  })
})
