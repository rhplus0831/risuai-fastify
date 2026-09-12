import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCommandEventSink } from '../src/commands/events.js'
import { createInitialDatabase } from '../src/databaseDefaults.js'
import { MessageTranslationJobRegistry } from '../src/messageTranslationJobs.js'
import { GreetingTranslationJobRegistry } from '../src/greetingTranslationJobs.js'
import { NON_DURABLE_REQUEST_DEADLINE_MS } from '../src/requestAbort.js'
import { runServerGreetingTranslation } from '../src/translation/serverGreetingTranslation.js'
import { getSchemaState } from '../src/db.js'
import { getDatabaseLineage } from '../src/databaseLineage.js'
import { openDatabase } from '../src/db.js'
import { resolveActiveMessageLocationById } from '../src/messageStore.js'
import {
  applyImport,
  createBackup,
  restoreBackup,
  loadPersistedWithMessages,
  loadCharacterSelectionRows,
  loadSettingsWithTranslatorPresetsFromSqlite,
  writePersistedWithMessages,
} from '../src/repository.js'
import { sourceHash, upsertGreetingTranslation } from '../src/translation/greetingTranslationStore.js'
import { resolveRawMessageTranslatorIdentity } from '../src/translation/rawMessageTranslation.js'

const serverTranslationMocks = vi.hoisted(() => ({
  dispatchChatProvider: vi.fn(),
}))

vi.mock('../src/prompt/chatDispatch.js', () => ({
  dispatchChatProvider: serverTranslationMocks.dispatchChatProvider,
}))

import { runServerMessageTranslation } from '../src/translation/serverMessageTranslation.js'

function textFrames(text: string) {
  return (async function* () {
    yield { kind: 'token' as const, content: text }
  })()
}

function historyBlock(role: 'user' | 'char', body: string): string {
  return `${role}: ${body}\n\n---\n\n`
}

let dataDir: string
let db: DatabaseSync

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'risu-server-message-translation-'))
  db = openDatabase(dataDir)
})

afterEach(() => {
  vi.useRealTimers()
  serverTranslationMocks.dispatchChatProvider.mockReset()
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('runServerMessageTranslation', () => {
  it('hydrates a persisted multi-step preset and stores the final chained LLM output', async () => {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        translator: 'ko',
        translatorInputLanguage: 'en',
        translatorType: 'llm',
        translatorSendTextAsIs: true,
        aiModel: 'echo_model',
        temperature: 50,
        top_p: 1,
        modelProfiles: [
          {
            id: 'persisted-translate-profile',
            name: 'Persisted Translate Profile',
            providerId: 'debug-echo',
            modelId: 'debug-echo',
            providerOptions: {
              baseUrl: 'debug://persisted-translate',
              requestModel: 'persisted-translate-model',
            },
            runtimeOptions: { temperature: 37, topP: 0.43, useStreaming: true },
          },
        ],
        modelRoleProfiles: {
          translate: { mode: 'profile', profileId: 'persisted-translate-profile' },
        },
        translatorPresetId: 'pipeline',
        // Deliberately stale compatibility fields; the canonical pipeline owns
        // prompt and response budget after reopen.
        translatorPrompt: 'stale scalar prompt',
        translatorMaxResponse: 7,
        translatorPresets: [
          {
            id: 'pipeline',
            name: 'Pipeline',
            prompt: 'Draft {{slot::content}}',
            maxResponse: 111,
            steps: [
              {
                id: 'draft',
                name: 'Draft',
                enabled: true,
                prompt: 'Draft {{slot::content}}',
                maxResponse: 111,
                model: { mode: 'inheritTranslate' },
              },
              {
                id: 'polish',
                name: 'Polish',
                enabled: true,
                prompt: 'Polish the previous translation',
                maxResponse: 222,
                model: { mode: 'inheritTranslate' },
              },
            ],
          },
        ],
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            chats: [
              {
                id: 'chat-a',
                name: 'Chat',
                note: '',
                localLore: [],
                message: [{ role: 'user', data: 'original source', chatId: 'message-a' }],
              },
            ],
            chatPage: 0,
            chatFolders: [],
          },
        ],
        characterOrder: ['char-a'],
      },
      assets: [],
    })

    db.close()
    db = openDatabase(dataDir)

    const settingsRow = db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }
    expect(JSON.parse(settingsRow.data_json)).not.toHaveProperty('translatorPresets')
    expect(db.prepare('SELECT COUNT(*) AS count FROM translator_presets').get()).toEqual({ count: 1 })

    serverTranslationMocks.dispatchChatProvider
      .mockImplementationOnce(async () => textFrames('draft output'))
      .mockImplementationOnce(async () => textFrames('final output'))

    const result = await runServerMessageTranslation({
      db,
      dataDir,
      eventSink: createCommandEventSink(),
      messageId: 'message-a',
    })

    expect(serverTranslationMocks.dispatchChatProvider).toHaveBeenCalledTimes(2)
    expect(serverTranslationMocks.dispatchChatProvider.mock.calls[0][0]).toMatchObject({
      outputTokens: 111,
      profile: {
        profileId: 'persisted-translate-profile',
        modelId: 'debug-echo',
        requestModel: 'persisted-translate-model',
        providerOptions: {
          baseUrl: 'debug://persisted-translate',
        },
      },
      database: {
        aiModel: 'debug-echo',
        temperature: 37,
        top_p: 0.43,
        useStreaming: false,
      },
      formated: [{ role: 'system', content: 'Draft original source' }],
    })
    expect(serverTranslationMocks.dispatchChatProvider.mock.calls[1][0]).toMatchObject({
      outputTokens: 222,
      profile: {
        profileId: 'persisted-translate-profile',
        modelId: 'debug-echo',
        requestModel: 'persisted-translate-model',
      },
      database: {
        aiModel: 'debug-echo',
        temperature: 37,
        top_p: 0.43,
        useStreaming: false,
      },
      formated: [
        { role: 'system', content: 'Polish the previous translation' },
        { role: 'user', content: 'draft output' },
      ],
    })
    expect(result.translation.text).toBe('final output')

    const persisted = resolveActiveMessageLocationById(db, 'message-a')
    expect(persisted.ok).toBe(true)
    if (persisted.ok) {
      expect(persisted.location.message.translation).toMatchObject({
        text: 'final output',
        source: 'raw',
        translatorType: 'llm',
      })
    }
  })

  it('supplies persisted message history and the chat-selected alternate greeting to raw translation', async () => {
    writePersistedWithMessages(db, dataDir, {
      _version: 1,
      database: {
        translator: 'ko',
        translatorInputLanguage: 'en',
        translatorType: 'llm',
        translatorSendTextAsIs: true,
        translatorHistoryMaxTokens: 2048,
        aiModel: 'echo_model',
        translatorPrompt:
          'History:\n{{slot::history::2}}\nTranslations:\n{{slot::historytrans::2}}\nSource={{slot::content}}',
        translatorMaxResponse: 111,
        translatorPresetId: 'history-pipeline',
        translatorPresets: [
          {
            id: 'history-pipeline',
            name: 'History pipeline',
            prompt:
              'History:\n{{slot::history::2}}\nTranslations:\n{{slot::historytrans::2}}\nSource={{slot::content}}',
            maxResponse: 111,
            steps: [
              {
                id: 'history-step',
                name: 'History',
                enabled: true,
                prompt:
                  'History:\n{{slot::history::2}}\nTranslations:\n{{slot::historytrans::2}}\nSource={{slot::content}}',
                maxResponse: 111,
                model: { mode: 'inheritTranslate' },
              },
            ],
          },
        ],
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            firstMessage: 'primary greeting',
            alternateGreetings: ['alternate greeting'],
            chats: [
              {
                id: 'chat-a',
                name: 'Chat',
                note: '',
                localLore: [],
                fmIndex: 0,
                message: [
                  {
                    role: 'user',
                    data: 'prior source',
                    chatId: 'message-prior',
                    translation: { text: 'prior translated' },
                  },
                  { role: 'char', data: 'current source', chatId: 'message-current' },
                ],
              },
            ],
            chatPage: 0,
            chatFolders: [],
          },
        ],
        characterOrder: ['char-a'],
      },
      assets: [],
    })
    const character = loadCharacterSelectionRows(db, 'char-a').character
    const settings = loadSettingsWithTranslatorPresetsFromSqlite(db)!
    const settingsHash = resolveRawMessageTranslatorIdentity({ settings, character }).settingsHash
    upsertGreetingTranslation(db, 'char-a', 0, {
      text: 'wrong settings translation',
      source: 'raw',
      sourceHash: sourceHash('alternate greeting'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'different-settings-hash',
      updatedAt: 122,
    })
    upsertGreetingTranslation(db, 'char-a', 0, {
      text: 'alternate translated',
      source: 'raw',
      sourceHash: sourceHash('alternate greeting'),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash,
      updatedAt: 123,
    })
    serverTranslationMocks.dispatchChatProvider.mockImplementation(async () => textFrames('translated'))

    await runServerMessageTranslation({
      db,
      dataDir,
      eventSink: createCommandEventSink(),
      messageId: 'message-current',
    })

    expect(serverTranslationMocks.dispatchChatProvider.mock.calls[0][0].formated).toEqual([
      {
        role: 'system',
        content:
          `History:\n${historyBlock('char', 'alternate greeting')}${historyBlock('user', 'prior source')}\n` +
          `Translations:\n${historyBlock('char', 'alternate translated')}${historyBlock('user', 'prior translated')}\n` +
          'Source=current source',
      },
    ])
  })
})

for (const family of ['message', 'greeting'] as const) {
  describe(`${family} detached lifecycle`, () => {
    function setup() {
      const database = createInitialDatabase() as unknown as Record<string, unknown>
      Object.assign(database, {
        translator: 'ko',
        translatorInputLanguage: 'en',
        translatorType: 'llm',
        translatorSendTextAsIs: true,
        modelProfiles: [
          { id: 'translate-profile', name: 'Translate', providerId: 'debug-echo', modelId: 'debug-echo' },
        ],
        modelRoleProfiles: { translate: { mode: 'profile', profileId: 'translate-profile' } },
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            firstMessage: 'Source greeting',
            chatPage: 0,
            chatFolders: [],
            chats: [
              {
                id: 'chat-a',
                name: 'A chat',
                note: '',
                localLore: [],
                message: [{ chatId: 'msg-a', role: 'char', data: 'Source message' }],
              },
            ],
          },
        ],
      })
      writePersistedWithMessages(db, dataDir, { _version: 1, database, assets: [] })
      const messageJobs = new MessageTranslationJobRegistry(() => getDatabaseLineage(db))
      const greetingJobs = new GreetingTranslationJobRegistry(() => getDatabaseLineage(db))
      const eventSink = createCommandEventSink()
      return {
        jobs: () => (family === 'message' ? messageJobs.translations() : greetingJobs.translations()),
        run: (jobId: string) =>
          family === 'message'
            ? runServerMessageTranslation({
                db,
                dataDir,
                eventSink,
                messageTranslationJobs: messageJobs,
                messageId: 'msg-a',
                jobId,
              })
            : runServerGreetingTranslation({
                db,
                dataDir,
                eventSink,
                greetingTranslationJobs: greetingJobs,
                characterId: 'char-a',
                chatId: 'chat-a',
                greetingIndex: -1,
                jobId,
              }),
      }
    }

    it.each(['success', 'failure'] as const)(
      'settles its deadline before an abort-insensitive provider and ignores late %s after retry',
      async (late) => {
        vi.useFakeTimers()
        const harness = setup()
        let release!: () => void
        serverTranslationMocks.dispatchChatProvider.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          if (late === 'failure') throw new Error('old provider failure')
          return textFrames('Old translation')
        })
        let settled = false
        const old = harness.run('old-job').then(
          () => {
            settled = true
            return 'success'
          },
          () => {
            settled = true
            return 'failure'
          },
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(serverTranslationMocks.dispatchChatProvider).toHaveBeenCalledTimes(1)
        const revision = getSchemaState(db).revision
        await vi.advanceTimersByTimeAsync(NON_DURABLE_REQUEST_DEADLINE_MS)
        expect(settled).toBe(true)
        expect(await old).toBe('failure')
        expect(harness.jobs()).toMatchObject([{ jobId: 'old-job', status: 'failed' }])
        expect(getSchemaState(db).revision).toBe(revision)
        serverTranslationMocks.dispatchChatProvider.mockResolvedValueOnce(textFrames('Replacement translation'))
        await expect(harness.run('new-job')).resolves.toMatchObject({
          translation: { text: 'Replacement translation' },
        })
        release()
        await vi.advanceTimersByTimeAsync(0)
        expect(harness.jobs()).toMatchObject([{ jobId: 'new-job', status: 'succeeded' }])
        expect(getSchemaState(db).revision).toBe(revision + 1)
        expect(vi.getTimerCount()).toBe(0)
      },
    )

    it.each(['import', 'restore'] as const)(
      'rejects a result from the replaced database after %s even with identical source IDs',
      async (replacement) => {
        const harness = setup()
        const snapshot = loadPersistedWithMessages(db, dataDir).database
        const backup = replacement === 'restore' ? await createBackup(db, dataDir, 'before translation') : null
        let release!: () => void
        serverTranslationMocks.dispatchChatProvider.mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return textFrames('Obsolete lineage output')
        })
        const old = harness.run('old-lineage-job').then(
          () => 'success',
          () => 'failure',
        )
        try {
          await vi.waitFor(() => expect(serverTranslationMocks.dispatchChatProvider).toHaveBeenCalledTimes(1))
          if (backup) await restoreBackup(db, dataDir, backup.id)
          else await applyImport(db, dataDir, snapshot)
          const revision = getSchemaState(db).revision
          expect(harness.jobs()).toEqual([])
          release()
          expect(await old).toBe('failure')
          expect(getSchemaState(db).revision).toBe(revision)
          expect(JSON.stringify(db.prepare('SELECT json FROM messages').all())).not.toContain('Obsolete lineage output')
          expect(db.prepare('SELECT COUNT(*) AS count FROM greeting_translations').get()).toEqual({ count: 0 })
          serverTranslationMocks.dispatchChatProvider.mockResolvedValueOnce(textFrames('Current lineage output'))
          await expect(harness.run('current-lineage-job')).resolves.toMatchObject({
            translation: { text: 'Current lineage output' },
          })
        } finally {
          release?.()
          await old
        }
      },
    )

    it('does not persist after its target is deleted while the provider ignores abort', async () => {
      const harness = setup()
      let release!: () => void
      serverTranslationMocks.dispatchChatProvider.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return textFrames('Deleted target output')
      })
      const old = harness.run('deleted-job').then(
        () => 'success',
        () => 'failure',
      )
      await vi.waitFor(() => expect(serverTranslationMocks.dispatchChatProvider).toHaveBeenCalledTimes(1))
      const revision = getSchemaState(db).revision
      db.exec(
        family === 'message' ? "DELETE FROM messages WHERE uid = 'msg-a'" : "DELETE FROM chats WHERE id = 'chat-a'",
      )
      release()
      expect(await old).toBe('failure')
      expect(harness.jobs()).toMatchObject([{ jobId: 'deleted-job', status: 'failed' }])
      expect(getSchemaState(db).revision).toBe(revision)
      expect(db.prepare('SELECT COUNT(*) AS count FROM greeting_translations').get()).toEqual({ count: 0 })
    })

    it('retains committed output across SQLite reopen while process-local job history starts empty', async () => {
      const harness = setup()
      serverTranslationMocks.dispatchChatProvider.mockResolvedValueOnce(textFrames('Persisted across reopen'))
      await harness.run('completed-job')
      db.close()
      db = openDatabase(dataDir)
      expect(new MessageTranslationJobRegistry().translations()).toEqual([])
      expect(new GreetingTranslationJobRegistry().translations()).toEqual([])
      const rows = db
        .prepare(family === 'message' ? 'SELECT json FROM messages' : 'SELECT * FROM greeting_translations')
        .all()
      expect(JSON.stringify(rows)).toContain('Persisted across reopen')
    })

    it('rolls back provider success on storage failure and permits one explicit retry', async () => {
      const harness = setup()
      const revision = getSchemaState(db).revision
      db.exec(
        family === 'message'
          ? "CREATE TRIGGER fail_translation BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT, 'held storage failure'); END"
          : "CREATE TRIGGER fail_translation BEFORE INSERT ON greeting_translations BEGIN SELECT RAISE(ABORT, 'held storage failure'); END",
      )
      serverTranslationMocks.dispatchChatProvider.mockResolvedValueOnce(textFrames('Uncommitted translation'))
      await expect(harness.run('failed-job')).rejects.toThrow('held storage failure')
      expect(harness.jobs()).toMatchObject([{ jobId: 'failed-job', status: 'failed' }])
      expect(getSchemaState(db).revision).toBe(revision)
      db.exec('DROP TRIGGER fail_translation')
      serverTranslationMocks.dispatchChatProvider.mockResolvedValueOnce(textFrames('Committed retry'))
      await expect(harness.run('retry-job')).resolves.toMatchObject({ translation: { text: 'Committed retry' } })
      expect(getSchemaState(db).revision).toBe(revision + 1)
      expect(harness.jobs()).toMatchObject([{ jobId: 'retry-job', status: 'succeeded' }])
    })
  })
}
