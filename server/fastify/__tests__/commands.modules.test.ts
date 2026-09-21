import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import { type Harness, startHarness, stopHarness, importDatabase } from './helpers/commandHarness.js'

let harness: Harness

describe('module record and enablement commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('creates MCP modules while rejecting malformed MCP identifiers', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [],
    })

    const invalid = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: {
          id: 'mcp-invalid',
          name: 'Invalid MCP',
          description: '',
          mcp: { url: 'http://remote.example/mcp' },
        },
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('module.mcp.url must be a supported MCP identifier')

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: {
          id: 'mcp-dice',
          name: 'Dice Tool',
          description: 'Imported MCP module',
          mcp: { url: 'internal:dice' },
          lorebook: [{ comment: 'MCP Info', content: '@@mcp', alwaysActive: true }],
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-dice',
      event: { type: 'module.created', id: 'mcp-dice' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision + 1)
    expect(bootstrap.resourceDatabase.modules).toContainEqual(
      expect.objectContaining({
        id: 'mcp-dice',
        mcp: { url: 'internal:dice' },
        lorebook: [expect.objectContaining({ comment: 'MCP Info' })],
      }),
    )
  })

  it('creates, patches, enables, reorders, relinks, and deletes modules', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mod-a'],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
        { id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } },
      ],
      personas: [
        { id: 'persona-a', name: 'Persona', icon: '', personaPrompt: '', note: '', modules: ['mod-a', 'mod-b'] },
      ],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mod-a', 'mod-b'],
          chats: [
            {
              id: 'chat-a',
              name: 'Chat',
              note: '',
              message: [],
              localLore: [],
              modules: ['mod-a', 'mod-b'],
            },
          ],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      loadouts: [{ id: 'loadout-a', name: 'L', modules: ['mod-a', 'mod-b'] }],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        module: { id: 'mod-c', name: 'C', description: 'Gamma', namespace: 'ns-c' },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      event: {
        type: 'module.created',
        revision: 2,
        resource: 'moduleCreated',
        id: 'mod-c',
      },
      moduleId: 'mod-c',
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 2,
        patch: {
          name: 'Renamed C',
          hideIcon: true,
          backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
          customModuleToggle: 'toggle',
          scriptModelOverrides: { llmProfileId: 'module-main-profile' },
        },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().event.type).toBe('module.updated')

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, moduleId: 'mod-b', enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 4,
      moduleId: 'mod-b',
      enabled: true,
      event: { type: 'module.enabled', id: 'mod-b' },
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-c', 'mod-b', 'mod-a', 'mcp-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event.type).toBe('module.reordered')

    const characterLinks = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, moduleIds: ['mod-b', 'mod-a'] },
    })
    expect(characterLinks.statusCode).toBe(200)
    expect(characterLinks.json()).toMatchObject({
      revision: 6,
      characterId: 'char-a',
      event: { type: 'character.modules.reordered', id: 'char-a' },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/modules/mod-b',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 6 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event.type).toBe('module.deleted')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(bootstrap.json().revision).toBe(7)
    expect(database.modules.map((module: { id: string }) => module.id)).toEqual(['mod-c', 'mod-a', 'mcp-a'])
    expect(database.modules[0]).toMatchObject({
      id: 'mod-c',
      name: 'Renamed C',
      hideIcon: true,
      backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
      customModuleToggle: 'toggle',
      scriptModelOverrides: { llmProfileId: 'module-main-profile' },
    })
    expect(database.enabledModules).toEqual(['mod-a'])
    expect(database.personas[0].modules).toEqual(['mod-a'])
    expect(database.characters[0].modules).toEqual(['mod-a'])
    expect(database.characters[0].chats[0].modules).toEqual(['mod-a'])
    expect(database.loadouts[0].modules).toEqual(['mod-a'])
    expect(
      harness.commandEvents
        .list()
        .slice(-6)
        .map((event) => event.type),
    ).toEqual([
      'module.created',
      'module.updated',
      'module.enabled',
      'module.reordered',
      'character.modules.reordered',
      'module.deleted',
    ])
  })

  it('creates, renames, reorders, assigns, and atomically deletes module folders', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      moduleFolders: [],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
      ],
    })

    const createdA = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, folder: { id: 'folder-a', name: 'Writing' } },
    })
    expect(createdA.statusCode).toBe(200)
    expect(createdA.json()).toMatchObject({
      revision: revision + 1,
      folderId: 'folder-a',
      event: { type: 'moduleFolder.created', resource: 'moduleFolders', id: 'folder-a' },
    })

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/module-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { name: 'Prompts' } },
    })
    expect(renamed.statusCode).toBe(200)

    const createdB = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 2, folder: { id: 'folder-b', name: 'Tools' } },
    })
    expect(createdB.statusCode).toBe(200)

    const reorderedFolders = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/module-folders/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 3, folderIds: ['folder-b', 'folder-a'] },
    })
    expect(reorderedFolders.statusCode).toBe(200)

    const organized = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 4,
        moduleIds: ['mod-b', 'mod-a'],
        folderByModuleId: { 'mod-a': 'folder-a', 'mod-b': 'folder-b' },
      },
    })
    expect(organized.statusCode).toBe(200)

    const incomplete = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 5,
        moduleIds: ['mod-b', 'mod-a'],
        folderByModuleId: { 'mod-a': 'folder-a' },
      },
    })
    expect(incomplete.statusCode).toBe(400)

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/module-folders/folder-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 5 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({
      type: 'moduleFolder.deleted',
      resource: 'moduleOrganization',
      id: 'folder-a',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.moduleFolders).toEqual([{ id: 'folder-b', name: 'Tools' }])
    expect(bootstrap.resourceDatabase.modules).toEqual([
      expect.objectContaining({ id: 'mod-b', folderId: 'folder-b' }),
      expect.not.objectContaining({ folderId: expect.anything() }),
    ])
  })

  it('deletes an MCP module and all of its references', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: ['mcp-a'],
      modules: [{ id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } }],
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          modules: ['mcp-a'],
          chats: [{ id: 'chat-a', name: 'Chat', note: '', message: [], localLore: [], modules: ['mcp-a'] }],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      loadouts: [{ id: 'loadout-a', name: 'L', modules: ['mcp-a'] }],
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/modules/mcp-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision },
    })

    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-a',
      event: { type: 'module.deleted', id: 'mcp-a' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(database.modules).toEqual([])
    expect(database.enabledModules).toEqual([])
    expect(database.characters[0].modules).toEqual([])
    expect(database.characters[0].chats[0].modules).toEqual([])
    expect(database.loadouts[0].modules).toEqual([])
  })

  it('globally enables an MCP module', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [{ id: 'mcp-a', name: 'MCP', description: 'Bridge', mcp: { url: 'internal:risuai' } }],
    })

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleId: 'mcp-a', enabled: true },
    })

    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: revision + 1,
      moduleId: 'mcp-a',
      enabled: true,
      event: { type: 'module.enabled', id: 'mcp-a' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.enabledModules).toEqual(['mcp-a'])
  })

  it('adds and removes character module links, not only reorders', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [
        { id: 'mod-a', name: 'A', description: 'Alpha' },
        { id: 'mod-b', name: 'B', description: 'Beta' },
        { id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } },
      ],
      characters: [{ chaId: 'char-a', name: 'A', modules: [], chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })

    // Add a previously unlinked module.
    const added = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleIds: ['mod-a'] },
    })
    expect(added.statusCode).toBe(200)
    expect(added.json()).toMatchObject({
      revision: 2,
      characterId: 'char-a',
      event: { type: 'character.modules.reordered', id: 'char-a' },
    })

    // Add a second module on top of the first.
    const addedSecond = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2, moduleIds: ['mod-a', 'mod-b'] },
    })
    expect(addedSecond.statusCode).toBe(200)

    let bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.characters[0].modules).toEqual(['mod-a', 'mod-b'])

    // Remove the first module, keeping the second.
    const removed = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, moduleIds: ['mod-b'] },
    })
    expect(removed.statusCode).toBe(200)

    bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(4)
    expect(bootstrap.resourceDatabase.characters[0].modules).toEqual(['mod-b'])

    // Unknown module ids are still rejected.
    const badAdd = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-b', 'mod-missing'] },
    })
    expect(badAdd.statusCode).toBe(400)
    expect(badAdd.json().error).toBe('Unknown module id in moduleIds: mod-missing')
    expect(bootstrap.json().revision).toBe(4)

    const badMcpAdd = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, moduleIds: ['mod-b', 'mcp-a'] },
    })
    expect(badMcpAdd.statusCode).toBe(400)
    expect(badMcpAdd.json().error).toBe('Unknown module id in moduleIds: mcp-a')
  })

  it('deletes optional module fields through null patch sentinels', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [
        {
          id: 'mod-a',
          name: 'A',
          description: '',
          namespace: 'old-namespace',
          backgroundEmbedding: 'old background',
          cjs: 'old cjs',
          assets: [],
        },
      ],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { namespace: null, backgroundEmbedding: null, cjs: null, assets: null },
      },
    })
    expect(patched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('namespace')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('backgroundEmbedding')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('cjs')
    expect(bootstrap.resourceDatabase.modules[0]).not.toHaveProperty('assets')

    const invalidPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { name: null } },
    })
    expect(invalidPatch.statusCode).toBe(400)
    expect(invalidPatch.json().error).toBe('patch.name cannot be deleted')

    const invalidCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        module: { id: 'mod-b', name: 'B', description: '', cjs: null },
      },
    })
    expect(invalidCreate.statusCode).toBe(400)
    expect(invalidCreate.json().error).toBe('module.cjs cannot be deleted')
  })

  it('rejects malformed module commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      enabledModules: [],
      modules: [{ id: 'mod-a', name: 'A', description: '' }],
      characters: [{ chaId: 'char-a', name: 'A', modules: ['mod-a'] }],
      characterOrder: ['char-a'],
    })

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { assets: [['bad.png', 'assets/bad.png', 'png']] },
      },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.assets[0][1] must be a server asset id')

    const badScriptModelOverrides = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { scriptModelOverrides: { modelId: 'raw-model' } },
      },
    })
    expect(badScriptModelOverrides.statusCode).toBe(400)
    expect(badScriptModelOverrides.json().error).toBe('patch.scriptModelOverrides.modelId is not supported')

    const badEnable = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleId: 'mod-a', enabled: 'yes' },
    })
    expect(badEnable.statusCode).toBe(400)
    expect(badEnable.json().error).toBe('enabled must be a boolean')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/char-a/modules/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, moduleIds: ['mod-a', 'mod-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate module id in moduleIds: mod-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.modules).toEqual([{ id: 'mod-a', name: 'A', description: '' }])
  })

  it('returns 404 for MCP module patches and 409 for stale module revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      modules: [{ id: 'mcp-a', name: 'MCP', description: '', mcp: { url: 'internal:risuai' } }],
    })

    const mcpPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mcp-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'Nope' } },
    })
    expect(mcpPatch.statusCode).toBe(404)
    expect(mcpPatch.json().error).toBe('Module not found: mcp-a')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/modules/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, moduleId: 'mcp-a', enabled: true },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
