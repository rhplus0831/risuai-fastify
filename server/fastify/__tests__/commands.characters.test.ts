import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/db.js'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { assertOnlyRowsWritten, tableRowidsById } from './helpers/rowStability.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import {
  getGreetingTranslation,
  sourceHash,
  upsertGreetingTranslation,
} from '../src/translation/greetingTranslationStore.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  readJsonRow,
} from './helpers/commandHarness.js'

let harness: Harness

describe('character commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('adds writer origin only to live command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        { chaId: 'char-a', name: 'A', chats: [] },
        { chaId: 'char-b', name: 'B', chats: [] },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    harness.commandEvents.clear()

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion, 'risu-writer-session': 'writer-a' },
      payload: {
        baseRevision: revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })

    expect(selected.statusCode).toBe(200)
    expect(selected.json().event).toEqual({
      type: 'character.selected',
      revision: revision + 1,
      resource: 'characterSelection',
      id: 'char-b',
    })
    expect(harness.commandEvents.list()).toEqual([
      {
        ...selected.json().event,
        origin: { writerSessionId: 'writer-a' },
      },
    ])
  })

  it('selects a character without rewriting unrelated character or chat rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [
            { id: 'chat-a-1', name: 'A1', message: [] },
            { id: 'chat-a-2', name: 'A2', message: [] },
          ],
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [{ id: 'chat-b-1', name: 'B1', message: [] }],
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })
    const characterRowsBefore = tableRowidsById(harness.dataDir, 'characters')
    const chatRowsBefore = tableRowidsById(harness.dataDir, 'chats')

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })

    expect(selected.statusCode).toBe(200)
    // Targeted selection UPDATEs only char-b's row + settings, so no character
    // or chat row is rewritten (every rowid stays put).
    assertOnlyRowsWritten(characterRowsBefore, tableRowidsById(harness.dataDir, 'characters'))
    assertOnlyRowsWritten(chatRowsBefore, tableRowidsById(harness.dataDir, 'chats'))
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      currentChar: 1,
      characters: [{ chaId: 'char-a' }, { chaId: 'char-b', lastInteraction: 4321 }],
    })
  })

  it('atomically cascades alternate greeting deletion and reordering through every child chat', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          alternateGreetings: ['zero', 'one', 'two'],
          chats: [
            { id: 'chat-primary', name: 'Primary', message: [], fmIndex: -1 },
            { id: 'chat-before', name: 'Before', message: [], fmIndex: 0 },
            { id: 'chat-deleted', name: 'Deleted', message: [], fmIndex: 1 },
            { id: 'chat-after', name: 'After', message: [], fmIndex: 2 },
            { id: 'chat-fractional', name: 'Fractional', message: [], fmIndex: 1.5 },
            { id: 'chat-invalid', name: 'Invalid', message: [], fmIndex: 9 },
          ],
        },
      ],
      characterOrder: ['char-a'],
    })
    {
      const db = openDatabase(harness.dataDir)
      try {
        for (const [greetingIndex, source] of [
          [-1, 'primary'],
          [0, 'zero'],
          [1, 'one'],
          [2, 'two'],
        ] as const) {
          upsertGreetingTranslation(db, 'char-a', greetingIndex, {
            text: `${source} translated`,
            source: 'raw',
            sourceHash: sourceHash(source),
            targetLanguage: 'ko',
            inputLanguage: 'en',
            translatorType: 'google',
            settingsHash: 'settings-a',
            updatedAt: 123,
          })
        }
      } finally {
        db.close()
      }
    }

    const deleted = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/alternate-greetings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        alternateGreetings: ['zero', 'two'],
        operation: { type: 'delete', index: 1 },
      },
    })

    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      event: {
        type: 'character.alternateGreetings.updated',
        resource: 'characterRow',
        id: 'char-a',
      },
      characterId: 'char-a',
      certificate: 'alternate-greeting-index-cascade-v1',
      chatGreetingIndices: [
        { chatId: 'chat-primary', fmIndex: -1 },
        { chatId: 'chat-before', fmIndex: 0 },
        { chatId: 'chat-deleted', fmIndex: -1 },
        { chatId: 'chat-after', fmIndex: 1 },
        { chatId: 'chat-fractional', fmIndex: -1 },
        { chatId: 'chat-invalid', fmIndex: -1 },
      ],
    })
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a').alternateGreetings).toEqual(['zero', 'two'])
    expect(
      ['chat-primary', 'chat-before', 'chat-deleted', 'chat-after', 'chat-fractional', 'chat-invalid'].map(
        (chatId) => readJsonRow(harness.dataDir, 'chats', chatId).fmIndex,
      ),
    ).toEqual([-1, 0, -1, 1, -1, -1])
    {
      const db = openDatabase(harness.dataDir)
      try {
        expect(getGreetingTranslation(db, 'char-a', -1, 'settings-a')?.translation.text).toBe('primary translated')
        expect(getGreetingTranslation(db, 'char-a', 0, 'settings-a')?.translation.text).toBe('zero translated')
        expect(getGreetingTranslation(db, 'char-a', 1, 'settings-a')?.translation.text).toBe('two translated')
        expect(getGreetingTranslation(db, 'char-a', 2, 'settings-a')).toBeNull()
      } finally {
        db.close()
      }
    }

    const swapped = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a/alternate-greetings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: deleted.json().revision,
        alternateGreetings: ['two', 'zero'],
        operation: { type: 'swap', firstIndex: 0, secondIndex: 1 },
      },
    })

    expect(swapped.statusCode).toBe(200)
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a').alternateGreetings).toEqual(['two', 'zero'])
    expect(readJsonRow(harness.dataDir, 'chats', 'chat-before').fmIndex).toBe(1)
    expect(readJsonRow(harness.dataDir, 'chats', 'chat-after').fmIndex).toBe(0)
    {
      const db = openDatabase(harness.dataDir)
      try {
        expect(getGreetingTranslation(db, 'char-a', 0, 'settings-a')?.translation.text).toBe('two translated')
        expect(getGreetingTranslation(db, 'char-a', 1, 'settings-a')?.translation.text).toBe('zero translated')
        expect(getGreetingTranslation(db, 'char-a', -1, 'settings-a')?.translation.text).toBe('primary translated')
      } finally {
        db.close()
      }
    }
  })

  it('invalidates only greeting rows whose ordinary character patch changes their source', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          firstMessage: 'primary',
          alternateGreetings: ['zero', 'one'],
          chats: [],
        },
      ],
      characterOrder: ['char-a'],
    })
    const db = openDatabase(harness.dataDir)
    try {
      for (const [greetingIndex, source] of [
        [-1, 'primary'],
        [0, 'zero'],
        [1, 'one'],
      ] as const) {
        upsertGreetingTranslation(db, 'char-a', greetingIndex, {
          text: `${source} translated`,
          source: 'raw',
          sourceHash: sourceHash(source),
          targetLanguage: 'ko',
          inputLanguage: 'en',
          translatorType: 'google',
          settingsHash: 'settings-a',
          updatedAt: 123,
        })
      }
    } finally {
      db.close()
    }

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { firstMessage: 'primary edited', alternateGreetings: ['zero', 'one edited'] },
      },
    })
    expect(patched.statusCode).toBe(200)
    const after = openDatabase(harness.dataDir)
    try {
      expect(getGreetingTranslation(after, 'char-a', -1, 'settings-a')).toBeNull()
      expect(getGreetingTranslation(after, 'char-a', 0, 'settings-a')?.translation.text).toBe('zero translated')
      expect(getGreetingTranslation(after, 'char-a', 1, 'settings-a')).toBeNull()
    } finally {
      after.close()
    }
  })

  it('persists and validates character script model overrides as profile ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          scriptModelOverrides: {
            llmProfileId: 'character-main-profile',
            axLlmProfileId: 'character-aux-profile',
          },
        },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(readJsonRow(harness.dataDir, 'characters', 'char-a').scriptModelOverrides).toEqual({
      llmProfileId: 'character-main-profile',
      axLlmProfileId: 'character-aux-profile',
    })

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        patch: { scriptModelOverrides: { llmProfileId: '' } },
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('patch.scriptModelOverrides.llmProfileId must be a non-empty string')
  })

  it('creates, updates, selects, reorders, and deletes characters by chaId', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          firstMessage: 'hello',
          desc: 'desc a',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
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
        },
      ],
      characterOrder: ['char-a'],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          firstMessage: 'hi',
          desc: 'desc b',
          chats: [],
          chatFolders: [],
          chatPage: 0,
          viewScreen: 'none',
          bias: [],
          emotionImages: [],
          globalLore: [],
          sdData: [],
          customscript: [],
          triggerscript: [],
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
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'character.created',
        revision: 2,
        resource: 'character',
        id: 'char-b',
      },
      characterId: 'char-b',
      selectedCharacterId: 'char-a',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          name: 'B renamed',
          displayName: 'Localized B',
          desc: 'new desc',
          systemPrompt: 'new system prompt',
          ttsMode: 'openai',
          oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
          depth_prompt: { depth: 2, prompt: 'stay close' },
          trashTime: 1000,
        },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'character.updated',
      // trashTime also rewrites characterOrder, so it invalidates the full character resource.
      resource: 'character',
      id: 'char-b',
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      name: 'B renamed',
      displayName: 'Localized B',
      systemPrompt: 'new system prompt',
      ttsMode: 'openai',
      oaiTTSConfig: { enabled: true, voice: 'alloy', model: 'tts-1', format: 'mp3' },
      depth_prompt: { depth: 2, prompt: 'stay close' },
    })

    const restored = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        patch: {
          trashTime: null,
        },
      },
    })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().event).toMatchObject({
      type: 'character.updated',
      resource: 'character',
      id: 'char-b',
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: restored.json().revision,
        characterId: 'char-b',
        lastInteraction: 4321,
      },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toEqual({
      revision: 5,
      event: {
        type: 'character.selected',
        revision: 5,
        resource: 'characterSelection',
        id: 'char-b',
      },
      characterId: 'char-b',
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      lastInteraction: 4321,
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: selected.json().revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: 'blue',
            data: ['char-b'],
            askBeforeOpening: true,
          },
          'char-a',
        ],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json()).toEqual({
      revision: 6,
      event: {
        type: 'character.reordered',
        revision: 6,
        resource: 'characterOrder',
      },
      selectedCharacterId: 'char-b',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({
      revision: 7,
      event: {
        type: 'character.deleted',
        revision: 7,
        resource: 'character',
        id: 'char-a',
      },
      characterId: 'char-a',
      selectedCharacterId: 'char-b',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.currentChar).toBe(0)
    expect(bootstrap.resourceDatabase.characters).toMatchObject([
      {
        chaId: 'char-b',
        name: 'B renamed',
        desc: 'new desc',
      },
    ])
    expect(bootstrap.resourceDatabase.characterOrder).toEqual([
      {
        id: 'folder-a',
        name: 'Folder A',
        color: 'blue',
        data: ['char-b'],
        askBeforeOpening: true,
      },
    ])
  })

  it('preserves a stored character TTS key when a sibling patch carries the mask', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-tts',
          name: 'TTS Character',
          oaiTTSConfig: {
            enabled: true,
            apiKey: 'stored-tts-secret',
            voice: 'alloy',
            model: 'tts-1',
            format: 'mp3',
          },
        },
      ],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-tts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          oaiTTSConfig: {
            enabled: true,
            apiKey: MASKED_PROVIDER_SECRET,
            voice: 'nova',
            model: 'tts-1-hd',
            format: 'opus',
          },
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(readJsonRow(harness.dataDir, 'characters', 'char-tts').oaiTTSConfig).toEqual({
      enabled: true,
      apiKey: 'stored-tts-secret',
      voice: 'nova',
      model: 'tts-1-hd',
      format: 'opus',
    })
  })

  it('persists the character lore settings deletion sentinel as a removed field', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-lore-settings',
          name: 'Lore Character',
          loreSettings: {
            scanDepth: 4,
            tokenBudget: 800,
            recursiveScanning: true,
          },
        },
      ],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-lore-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { loreSettings: null },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(readJsonRow(harness.dataDir, 'characters', 'char-lore-settings')).not.toHaveProperty('loreSettings')
  })

  it('creates and selects a character in one command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
        },
      ],
      characterOrder: ['char-a'],
    })

    const createdAndSelected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          chats: [],
          chatFolders: [],
        },
        initialChat: {
          id: 'chat-b-initial',
          name: 'Chat 1',
          note: '',
          message: [],
          localLore: [],
        },
        lastInteraction: 9876,
      },
    })

    expect(createdAndSelected.statusCode).toBe(200)
    expect(createdAndSelected.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'character.createdAndSelected',
        revision: revision + 1,
        resource: 'character',
        id: 'char-b',
      },
      characterId: 'char-b',
      selectedCharacterId: 'char-b',
    })
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      currentChar: 1,
      characterOrder: ['char-a', 'char-b'],
    })
    expect(
      ((loadPersistedFromDir(harness.dataDir).database as any).characters as Array<Record<string, unknown>>).find(
        (character) => character.chaId === 'char-b',
      ),
    ).toMatchObject({
      name: 'B',
      lastInteraction: 9876,
      chatPage: 0,
      chats: [
        {
          id: 'chat-b-initial',
          name: 'Chat 1',
          note: '',
          localLore: [],
        },
      ],
    })
  })

  it('rejects malformed character commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chats: [],
          chatFolders: [],
          trashTime: undefined,
        },
        {
          chaId: 'char-b',
          name: 'B',
          chats: [],
          chatFolders: [],
        },
      ],
      characterOrder: ['char-a', 'char-b'],
    })

    const update = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { chats: [] },
      },
    })
    expect(update.statusCode).toBe(400)
    expect(update.json().error).toBe('patch.chats is owned by a later command slice')

    const invalidDisplayName = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: 123 },
      },
    })
    expect(invalidDisplayName.statusCode).toBe(400)
    expect(invalidDisplayName.json().error).toBe('patch.displayName must be a string')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: ['char-a', 'char-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate character id in characterOrder: char-a')

    const invalidFolderOpeningPreference = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: 'blue',
            data: ['char-a'],
            askBeforeOpening: 'yes',
          },
          'char-b',
        ],
      },
    })
    expect(invalidFolderOpeningPreference.statusCode).toBe(400)
    expect(invalidFolderOpeningPreference.json().error).toBe('characterOrder[0].askBeforeOpening must be a boolean')

    const embeddedChatCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
          chats: [
            {
              id: 'chat-c',
              name: 'C chat',
              message: [{ chatId: 'msg-c', role: 'user', data: 'embedded transcript' }],
            },
          ],
        },
      },
    })
    expect(embeddedChatCreate.statusCode).toBe(400)
    expect(embeddedChatCreate.json().error).toBe('character.chats must be empty; create chats with chat commands')

    const embeddedHypaCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
          chats: [
            {
              id: 'chat-c',
              name: 'C chat',
              hypaV3Data: { version: 3, summaries: [] },
            },
          ],
        },
      },
    })
    expect(embeddedHypaCreate.statusCode).toBe(400)
    expect(embeddedHypaCreate.json().error).toBe('character.chats must be empty; create chats with chat commands')

    const initialChatWithTranscript = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/create-and-select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-c',
          name: 'C',
        },
        initialChat: {
          id: 'chat-c',
          name: 'Chat 1',
          message: [{ chatId: 'message-c', role: 'user', data: 'not message-free' }],
        },
      },
    })
    expect(initialChatWithTranscript.statusCode).toBe(400)
    expect(initialChatWithTranscript.json().error).toBe(
      'initialChat.message must be empty; create transcript messages with message commands',
    )

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.characterOrder).toEqual(['char-a', 'char-b'])
  })

  it('returns 404 and 409 for missing characters and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { name: 'Nope' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Character not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/select',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
        characterId: 'char-a',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
