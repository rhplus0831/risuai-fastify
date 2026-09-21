import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getSchemaState, openDatabase } from '../src/db.js'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  readJsonRow,
  writeJsonRow,
  updateSettingsRow,
} from './helpers/commandHarness.js'

let harness: Harness

describe('lorebook commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates, updates, reorders, and deletes global lorebooks with command events', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: { id: 'book-b', name: 'B', data: [] },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'lorebook.created',
        revision: 2,
        resource: 'globalLorebook',
        id: 'book-b',
      },
      lorebookId: 'book-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, patch: { name: 'Renamed' } },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event.type).toBe('lorebook.updated')

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, lorebookIds: ['book-b', 'book-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event.type).toBe('lorebook.reordered')

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/book-a/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4 },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json()).toMatchObject({
      revision: 5,
      event: {
        type: 'lorebook.selected',
        revision: 5,
        resource: 'globalLorebook',
        id: 'book-a',
      },
      selectedLorebookId: 'book-a',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event.type).toBe('lorebook.deleted')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(6)
    expect(
      bootstrap.resourceDatabase.loreBook.map((book: { id: string; name: string }) => ({
        id: book.id,
        name: book.name,
      })),
    ).toEqual([{ id: 'book-b', name: 'Renamed' }])
    expect(
      harness.commandEvents
        .list()
        .slice(-5)
        .map((event) => event.type),
    ).toEqual(['lorebook.created', 'lorebook.updated', 'lorebook.reordered', 'lorebook.selected', 'lorebook.deleted'])
  })

  it('rejects deleting the last global lorebook without minting a replacement id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(deleted.statusCode).toBe(400)
    expect(deleted.json().error).toBe('Cannot delete the last lorebook')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook).toEqual([{ id: 'book-a', name: 'A', data: [] }])
  })

  it('fails closed on malformed or duplicate persisted global and module target ids', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [
        { id: 'book-a', name: 'A', data: [] },
        { id: 'book-b', name: 'B', data: [] },
      ],
      loreBookPage: 0,
      modules: [
        { id: 'mod-a', name: 'A', description: '' },
        { id: 'mod-b', name: 'B', description: '' },
      ],
    })
    const rewriteRow = (
      table: 'lore_books' | 'modules',
      position: number,
      mutate: (row: Record<string, unknown>) => void,
    ): string => {
      const db = openDatabase(harness.dataDir)
      try {
        const stored = db.prepare(`SELECT data_json FROM ${table} WHERE position = ?`).get(position) as {
          data_json: string
        }
        const row = JSON.parse(stored.data_json) as Record<string, unknown>
        mutate(row)
        const dataJson = JSON.stringify(row)
        db.prepare(`UPDATE ${table} SET data_json = ? WHERE position = ?`).run(dataJson, position)
        return dataJson
      } finally {
        db.close()
      }
    }
    const expectStoredRow = (table: 'lore_books' | 'modules', position: number, dataJson: string): void => {
      const db = openDatabase(harness.dataDir)
      try {
        expect(
          (db.prepare(`SELECT data_json FROM ${table} WHERE position = ?`).get(position) as { data_json: string })
            .data_json,
        ).toBe(dataJson)
      } finally {
        db.close()
      }
    }

    const duplicateLorebook = rewriteRow('lore_books', 1, (row) => {
      row.id = 'book-a'
    })
    let response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate lorebook id: book-a')
    expectStoredRow('lore_books', 1, duplicateLorebook)
    rewriteRow('lore_books', 1, (row) => {
      row.id = 'book-b'
    })

    const malformedLorebook = rewriteRow('lore_books', 0, (row) => {
      delete row.id
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/lorebooks/book-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('loreBook[0].id must be a non-empty string')
    expectStoredRow('lore_books', 0, malformedLorebook)

    const duplicateModule = rewriteRow('modules', 1, (row) => {
      row.id = 'mod-a'
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Duplicate module id: mod-a')
    expectStoredRow('modules', 1, duplicateModule)
    rewriteRow('modules', 1, (row) => {
      row.id = 'mod-b'
    })

    const malformedModule = rewriteRow('modules', 0, (row) => {
      delete row.id
    })
    response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'must not write' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('module[0].id must be a non-empty string')
    expectStoredRow('modules', 0, malformedModule)

    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('replaces global, character, chat, and module lorebook entry collections', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })

    const global = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entries: [entry('entry-global', 'Global')] },
    })
    expect(global.statusCode).toBe(200)
    expect(global.json().event).toMatchObject({
      type: 'lorebook.entries.replaced',
      // The global lorebook entries edit ships only loreBook/loreBookPage.
      resource: 'globalLorebook',
      id: 'book-a',
    })

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [entry('entry-char', 'Character')] },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json()).toMatchObject({ revision: 3, characterId: 'char-a' })
    // The character globalLore edit ships only the changed character row.
    expect(character.json().event).toMatchObject({
      resource: 'characterLorebook',
      id: 'char-a',
    })

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, entries: [entry('entry-chat', 'Chat')] },
    })
    expect(chat.statusCode).toBe(200)
    // localLore lives in the chat row, so a foreign refresh ships its parent character only.
    expect(chat.json().event).toMatchObject({ resource: 'characterRow', id: 'chat-a', parentId: 'char-a' })

    const module = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, entries: [entry('entry-module', 'Module')] },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json()).toMatchObject({ revision: 5, moduleId: 'mod-a' })
    // One module's lorebook is a single `modules`-row edit.
    expect(module.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: Array<{ id: string }> }>
    }
    expect(database.loreBook[0].data[0].id).toBe('entry-global')
    expect(database.characters[0].globalLore[0].id).toBe('entry-char')
    expect(database.characters[0].chats[0].localLore[0].id).toBe('entry-chat')
    expect(persisted.modules[0].lorebook?.[0].id).toBe('entry-module')
  })

  it('upserts one lorebook entry through scoped routes without uploading sibling entries', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [entry('global-a', 'Global A'), entry('global-b', 'Global B')] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [entry('char-a', 'Character A'), entry('char-b', 'Character B')],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [entry('chat-a', 'Chat A'), entry('chat-b', 'Chat B')],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [
        { id: 'mod-a', name: 'Mod', lorebook: [entry('module-a', 'Module A'), entry('module-b', 'Module B')] },
        { id: 'mod-b', name: 'Untouched', lorebook: [] },
      ],
    })
    writeJsonRow(harness.dataDir, 'modules', 'mod-b', {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-b'),
      lorebook: undefined,
    })

    const global = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries/global-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entry: entry('global-b', 'Global B Updated') },
    })
    expect(global.statusCode).toBe(200)
    expect(global.json()).toMatchObject({
      revision: revision + 1,
      lorebookId: 'book-a',
      entryId: 'global-b',
      entryIndex: 1,
      created: false,
    })

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, entry: entry('char-b', 'Character B Updated') },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().event).toMatchObject({ resource: 'characterLorebook', id: 'char-a' })

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 2, entry: entry('chat-b', 'Chat B Updated') },
    })
    expect(chat.statusCode).toBe(200)
    expect(chat.json().event).toMatchObject({ resource: 'characterRow', id: 'chat-a', parentId: 'char-a' })

    const module = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/module-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 3, entry: entry('module-b', 'Module B Updated') },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/lorebooks/book-a/entries/global-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 4 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({ lorebookId: 'book-a', entryId: 'global-a', entryIndex: 0 })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 5, entryIds: ['module-b', 'module-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({ resource: 'moduleUpdated', id: 'mod-a' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: Array<{ comment: string }> }>
    }
    expect(database.loreBook[0].data.map((item: { comment: string }) => item.comment)).toEqual(['Global B Updated'])
    expect(database.characters[0].globalLore.map((item: { comment: string }) => item.comment)).toEqual([
      'Character A',
      'Character B Updated',
    ])
    expect(database.characters[0].chats[0].localLore.map((item: { comment: string }) => item.comment)).toEqual([
      'Chat A',
      'Chat B Updated',
    ])
    expect(persisted.modules[0].lorebook?.map((item: { comment: string }) => item.comment)).toEqual([
      'Module B Updated',
      'Module A',
    ])
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-b')).not.toHaveProperty('lorebook')
  })

  it('rejects degraded module lorebook ids before applying an entry command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, comment: string) => ({
      id,
      key: comment.toLowerCase(),
      secondkey: '',
      insertorder: 100,
      comment,
      content: `${comment} content`,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    const revision = await importDatabase(harness.app, assertion, {
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [entry('legacy-id', 'Legacy')] }],
    })
    const degraded = entry('legacy-id', 'Legacy') as Record<string, unknown>
    delete degraded.id
    const degradedModule = {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-a'),
      lorebook: [degraded],
    }
    writeJsonRow(harness.dataDir, 'modules', 'mod-a', degradedModule)

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/modules/mod-a/lorebooks/entries/new-entry',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entry: entry('new-entry', 'New') },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('module mod-a.lorebook[0].id must be a non-empty string')
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-a')).toStrictEqual(degradedModule)
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it(
    'applies sparse lorebook entry patches in every scope without replacing unchanged fields or siblings',
    { tags: 'core' },
    async () => {
      const { assertion } = await setupAuthedClient(harness.app)
      const entry = (id: string, label: string) => ({
        id,
        key: label.toLowerCase(),
        secondkey: '',
        insertorder: 100,
        comment: label,
        content: `${label}:${'large-content-'.repeat(200)}`,
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        activationPercent: 40,
        unknownExtension: { preserve: label },
      })
      let revision = await importDatabase(harness.app, assertion, {
        loreBook: [{ id: 'book-a', name: 'A', data: [entry('global-a', 'Global A'), entry('global-b', 'Global B')] }],
        loreBookPage: 0,
        characters: [
          {
            chaId: 'char-a',
            name: 'A',
            globalLore: [entry('char-a', 'Character A'), entry('char-b', 'Character B')],
            chats: [
              {
                id: 'chat-a',
                name: 'Chat',
                note: '',
                message: [],
                localLore: [entry('chat-a', 'Chat A'), entry('chat-b', 'Chat B')],
              },
            ],
            chatFolders: [],
            chatPage: 0,
          },
        ],
        characterOrder: ['char-a'],
        modules: [
          { id: 'mod-a', name: 'Mod', lorebook: [entry('module-a', 'Module A'), entry('module-b', 'Module B')] },
        ],
      })

      const cases = [
        { url: '/api/v1/commands/lorebooks/book-a/entries/global-a', targetKey: 'lorebookId', targetId: 'book-a' },
        {
          url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-a',
          targetKey: 'characterId',
          targetId: 'char-a',
        },
        { url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-a', targetKey: 'chatId', targetId: 'chat-a' },
        { url: '/api/v1/commands/modules/mod-a/lorebooks/entries/module-a', targetKey: 'moduleId', targetId: 'mod-a' },
      ]
      for (const testCase of cases) {
        const response = await harness.app.inject({
          method: 'PUT',
          url: testCase.url,
          headers: { 'risu-auth': assertion },
          payload: {
            baseRevision: revision,
            patch: { comment: 'Sparse update', nullableExtension: null },
            deleteKeys: ['activationPercent'],
          },
        })
        expect(response.statusCode, JSON.stringify(response.json())).toBe(200)
        expect(response.json()).toMatchObject({
          [testCase.targetKey]: testCase.targetId,
          created: false,
          patchedKeys: ['comment', 'nullableExtension'],
          deletedKeys: ['activationPercent'],
        })
        revision = response.json().revision
      }

      const bootstrap = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      const database = bootstrap.resourceDatabase
      const module = readJsonRow(harness.dataDir, 'modules', 'mod-a')
      const updatedEntries = [
        database.loreBook[0].data[0],
        database.characters[0].globalLore[0],
        database.characters[0].chats[0].localLore[0],
        (module.lorebook as Array<Record<string, unknown>>)[0],
      ]
      for (const updated of updatedEntries) {
        expect(updated.comment).toBe('Sparse update')
        expect(updated.nullableExtension).toBeNull()
        expect(updated).not.toHaveProperty('activationPercent')
        expect(updated.content).toContain('large-content-')
        expect(updated.unknownExtension).toHaveProperty('preserve')
      }
      expect(database.loreBook[0].data[1]).toMatchObject(entry('global-b', 'Global B'))
      expect(database.characters[0].globalLore[1]).toMatchObject(entry('char-b', 'Character B'))
      expect(database.characters[0].chats[0].localLore[1]).toMatchObject(entry('chat-b', 'Chat B'))
      expect((module.lorebook as Array<Record<string, unknown>>)[1]).toMatchObject(entry('module-b', 'Module B'))

      for (const testCase of cases) {
        const missingUrl = testCase.url.replace(/[^/]+$/, 'missing-entry')
        const missing = await harness.app.inject({
          method: 'PUT',
          url: missingUrl,
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: revision, patch: { comment: 'must not create' } },
        })
        expect(missing.statusCode).toBe(404)
      }
      const unchanged = await injectComposedResourceDatabase(harness.app, {
        method: 'GET',
        url: '/api/v1/bootstrap',
        headers: { 'risu-auth': assertion },
      })
      expect(unchanged.json().revision).toBe(revision)
    },
  )

  it('rejects malformed sparse lorebook entry writes without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const canonicalEntry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [canonicalEntry] }],
      loreBookPage: 0,
    })
    const bodies = [
      { entry: canonicalEntry, patch: { comment: 'mixed' } },
      { patch: {} },
      { patch: { id: 'entry-a' } },
      { patch: { comment: 'overlap' }, deleteKeys: ['comment'] },
      { deleteKeys: ['activationPercent', 'activationPercent'] },
      { deleteKeys: ['content'] },
    ]
    for (const body of bodies) {
      const response = await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, ...body },
      })
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400)
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook[0].data).toEqual([canonicalEntry])
  })

  it('rejects sparse character and chat lorebook writes when an untargeted sibling is malformed', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const entry = (id: string, label: string) => ({
      id,
      key: label,
      secondkey: '',
      insertorder: 100,
      comment: label,
      content: label,
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    })
    let revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [entry('char-target', 'target'), entry('char-sibling', 'sibling')],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [entry('chat-target', 'target'), entry('chat-sibling', 'sibling')],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
    })

    const characterRow = readJsonRow(harness.dataDir, 'characters', 'char-a')
    delete (characterRow.globalLore as Array<Record<string, unknown>>)[1].comment
    writeJsonRow(harness.dataDir, 'characters', 'char-a', characterRow)
    const chatRow = readJsonRow(harness.dataDir, 'chats', 'chat-a')
    delete (chatRow.localLore as Array<Record<string, unknown>>)[1].comment
    writeJsonRow(harness.dataDir, 'chats', 'chat-a', chatRow)

    const character = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/char-a/lorebooks/entries/char-target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { content: 'character update' } },
    })
    expect(character.statusCode).toBe(400)
    expect(character.json().error).toBe('character char-a.globalLore[1].comment must be a string')

    const chat = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/chats/chat-a/lorebooks/entries/chat-target',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { content: 'chat update' } },
    })
    expect(chat.statusCode).toBe(400)
    expect(chat.json().error).toBe('chat chat-a.localLore[1].comment must be a string')
    expect(
      (readJsonRow(harness.dataDir, 'characters', 'char-a').globalLore as Array<Record<string, unknown>>)[1],
    ).not.toHaveProperty('comment')
    expect(
      (readJsonRow(harness.dataDir, 'chats', 'chat-a').localLore as Array<Record<string, unknown>>)[1],
    ).not.toHaveProperty('comment')
    const db = openDatabase(harness.dataDir)
    try {
      expect(getSchemaState(db).revision).toBe(revision)
    } finally {
      db.close()
    }
  })

  it('rejects malformed lorebook commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const malformed = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 'bad',
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('entries[0].insertorder must be a finite number')

    const missingEntryId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(missingEntryId.statusCode).toBe(400)
    expect(missingEntryId.json().error).toBe('entries[0].id must be a non-empty string')

    const duplicateEntryId = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        entries: [
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
          {
            id: 'entry-a',
            key: '',
            secondkey: '',
            insertorder: 100,
            comment: '',
            content: '',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
      },
    })
    expect(duplicateEntryId.statusCode).toBe(400)
    expect(duplicateEntryId.json().error).toBe('Duplicate lorebook entry id: entry-a')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, lorebookIds: ['book-a', 'book-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate lorebook id in lorebookIds: book-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.loreBook[0].data).toEqual([])
  })

  it('rejects POST /lorebooks payloads that omit nested entry ids', async () => {
    // The create route uses the no-mint validator so missing entry ids are
    // rejected instead of being silently minted.
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
    })

    const missingId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: {
          id: 'book-c',
          name: 'C',
          data: [
            {
              key: 'k',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: 'c',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
          ],
        },
      },
    })
    expect(missingId.statusCode).toBe(400)
    expect(missingId.json().error).toBe('lorebook.data[0].id must be a non-empty string')

    const duplicateId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        lorebook: {
          id: 'book-c',
          name: 'C',
          data: [
            {
              id: 'dup-entry',
              key: '',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: '',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
            {
              id: 'dup-entry',
              key: '',
              secondkey: '',
              insertorder: 100,
              comment: '',
              content: '',
              mode: 'normal',
              alwaysActive: false,
              selective: false,
            },
          ],
        },
      },
    })
    expect(duplicateId.statusCode).toBe(400)
    expect(duplicateId.json().error).toBe('Duplicate lorebook entry id: dup-entry')

    // Persisted state unchanged: only book-a from the import remains.
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.loreBook.map((b: { id: string }) => b.id)).toEqual(['book-a'])
  })

  it('rejects PUT /characters /chats /modules lorebook payloads with missing or duplicate entry ids', async () => {
    // The replace routes use the no-mint validator so missing or duplicate entry
    // ids are rejected.
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const malformedEntry = {
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }

    const routes = [
      '/api/v1/commands/characters/char-a/lorebooks',
      '/api/v1/commands/chats/chat-a/lorebooks',
      '/api/v1/commands/modules/mod-a/lorebooks',
    ]

    for (const url of routes) {
      const missing = await harness.app.inject({
        method: 'PUT',
        url,
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, entries: [malformedEntry] },
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json().error).toBe('entries[0].id must be a non-empty string')

      const duplicate = await harness.app.inject({
        method: 'PUT',
        url,
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          entries: [
            { ...malformedEntry, id: 'dup-entry' },
            { ...malformedEntry, id: 'dup-entry' },
          ],
        },
      })
      expect(duplicate.statusCode).toBe(400)
      expect(duplicate.json().error).toBe('Duplicate lorebook entry id: dup-entry')
    }

    // Persisted state is untouched by the rejected requests; revision is
    // still the post-import baseline.
    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    const database = bootstrap.resourceDatabase
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ lorebook?: unknown[] }>
    }
    expect(database.characters[0].globalLore).toEqual([])
    expect(database.characters[0].chats[0].localLore).toEqual([])
    expect(persisted.modules[0].lorebook).toEqual([])
  })

  it('global lorebook commands skip unrelated child-lore validation and keep target payload checks strict', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [
        { id: 'book-a', name: 'A', data: [] },
        { id: 'book-b', name: 'B', data: [] },
      ],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          globalLore: [],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Mod', lorebook: [] }],
    })

    const invalidEntry = {
      id: 'bad-lore-entry',
      key: 1,
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    writeJsonRow(harness.dataDir, 'characters', 'char-a', {
      ...readJsonRow(harness.dataDir, 'characters', 'char-a'),
      globalLore: [invalidEntry],
    })
    writeJsonRow(harness.dataDir, 'chats', 'chat-a', {
      ...readJsonRow(harness.dataDir, 'chats', 'chat-a'),
      localLore: [invalidEntry],
    })
    writeJsonRow(harness.dataDir, 'modules', 'mod-a', {
      ...readJsonRow(harness.dataDir, 'modules', 'mod-a'),
      lorebook: [invalidEntry],
    })
    // Force the collection-scoped loader onto its documented broad fallback so
    // this proves the route, not only the loader, avoids child-lore repair.
    updateSettingsRow(harness.dataDir, (settings) => {
      settings.characters = []
    })

    const selected = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/lorebooks/book-b/select',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })
    expect(selected.statusCode, JSON.stringify(selected.json())).toBe(200)
    expect(selected.json()).toMatchObject({ revision: 2, selectedLorebookId: 'book-b' })

    const malformedTarget = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [invalidEntry] },
    })
    expect(malformedTarget.statusCode).toBe(400)
    expect(malformedTarget.json().error).toBe('entries[0].key must be a string')

    const arrayKeyTarget = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, entries: [{ ...invalidEntry, key: [] }] },
    })
    expect(arrayKeyTarget.statusCode).toBe(400)
    expect(arrayKeyTarget.json().error).toBe('entries[0].key must be a string')

    expect(readJsonRow(harness.dataDir, 'characters', 'char-a').globalLore).toEqual([invalidEntry])
    expect(readJsonRow(harness.dataDir, 'chats', 'chat-a').localLore).toEqual([invalidEntry])
    expect(readJsonRow(harness.dataDir, 'modules', 'mod-a').lorebook).toEqual([invalidEntry])
  })

  it('returns 404 and 409 for missing lorebook parents and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      loreBook: [{ id: 'book-a', name: 'A', data: [] }],
      loreBookPage: 0,
      characters: [],
    })

    const missing = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/characters/missing/lorebooks',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, entries: [] },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Character not found: missing')

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/lorebooks/book-a/entries',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, entries: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
