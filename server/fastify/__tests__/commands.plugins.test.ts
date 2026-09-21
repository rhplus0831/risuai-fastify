import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import { type Harness, startHarness, stopHarness, importDatabase } from './helpers/commandHarness.js'

let harness: Harness

describe('plugin record and configuration commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it.each([2, '2.1'] as const)('rejects V%s-series plugin records without bumping revision', async (version) => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { plugins: [] })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        plugin: {
          name: 'unsupported-plugin',
          script: 'void 0',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version,
        },
      },
    })

    expect(created.statusCode).toBe(400)
    expect(created.json().error).toBe(`plugin.version must be "3.0"; Fastify does not support V2-series plugins`)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.plugins).toEqual([])
  })

  it('creates, patches, enables, selects provider, reorders, and deletes plugins', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      currentPluginProvider: 'plugin-a',
      plugins: [
        {
          name: 'plugin-a',
          script: 'Risuai.log("A")',
          arguments: { token: 'string' },
          realArg: { token: '' },
          customLink: [],
          argMeta: {},
          version: '3.0',
          enabled: true,
        },
        {
          name: 'plugin-b',
          script: 'Risuai.log("B")',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
          enabled: false,
        },
      ],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        plugin: {
          name: 'plugin-c',
          script: 'Risuai.log("C")',
          arguments: { mode: ['fast', 'slow'] },
          realArg: { mode: 'fast' },
          customLink: [{ link: 'https://example.com', hoverText: 'Docs' }],
          argMeta: { mode: { name: 'Mode' } },
          version: '3.0',
          enabled: true,
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      revision: 2,
      pluginId: 'plugin-c',
      event: { type: 'plugin.created', resource: 'pluginCollection', id: 'plugin-c' },
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-c',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 2,
        patch: { realArg: { mode: 'slow' }, displayName: 'Plugin C' },
      },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().event).toMatchObject({ type: 'plugin.updated', resource: 'pluginCollection' })

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-b/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 3, enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 4,
      pluginId: 'plugin-b',
      enabled: true,
      event: { type: 'plugin.enabled', resource: 'pluginCollection', id: 'plugin-b' },
    })

    const provider = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/provider',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 4, provider: 'provider-c' },
    })
    expect(provider.statusCode).toBe(200)
    expect(provider.json()).toMatchObject({
      revision: 5,
      provider: 'provider-c',
      event: { type: 'plugin.provider.selected', resource: 'pluginProvider', id: 'provider-c' },
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 5, pluginIds: ['plugin-c', 'plugin-b', 'plugin-a'] },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({ type: 'plugin.reordered', resource: 'pluginCollection' })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 6 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({ type: 'plugin.deleted', resource: 'pluginCollection' })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(bootstrap.json().revision).toBe(7)
    expect(database.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(['plugin-c', 'plugin-b'])
    expect(database.plugins[0]).toMatchObject({
      name: 'plugin-c',
      displayName: 'Plugin C',
      realArg: { mode: 'slow' },
    })
    expect(database.plugins[1].enabled).toBe(true)
    expect(database.currentPluginProvider).toBe('provider-c')
    expect(
      harness.commandEvents
        .list()
        .slice(-6)
        .map((event) => event.type),
    ).toEqual([
      'plugin.created',
      'plugin.updated',
      'plugin.enabled',
      'plugin.provider.selected',
      'plugin.reordered',
      'plugin.deleted',
    ])
  })

  it('deletes optional plugin fields through null patch sentinels', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: 'Risuai.log("A")',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
          displayName: 'Plugin A',
          updateURL: 'https://plugins.example/plugin-a.js',
          allowedIPC: ['channel-a'],
          enabled: true,
        },
      ],
    })

    const patched = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { displayName: null, updateURL: null, allowedIPC: null },
      },
    })
    expect(patched.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('displayName')
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('updateURL')
    expect(bootstrap.resourceDatabase.plugins[0]).not.toHaveProperty('allowedIPC')

    const invalid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision + 1, patch: { script: null } },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error).toBe('patch.script cannot be deleted')
  })

  it('rejects malformed plugin commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: '',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
        },
      ],
    })

    const badPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/plugin-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { name: 'renamed' } },
    })
    expect(badPatch.statusCode).toBe(400)
    expect(badPatch.json().error).toBe('patch.name cannot be changed by plugin commands')

    const badEnable = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-a/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, enabled: 'yes' },
    })
    expect(badEnable.statusCode).toBe(400)
    expect(badEnable.json().error).toBe('enabled must be a boolean')

    const badReorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/reorder',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, pluginIds: ['plugin-a', 'plugin-a'] },
    })
    expect(badReorder.statusCode).toBe(400)
    expect(badReorder.json().error).toBe('Duplicate plugin id in pluginIds: plugin-a')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.plugins[0].name).toBe('plugin-a')
  })

  it('returns 404 for missing plugins and 409 for stale plugin revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      plugins: [
        {
          name: 'plugin-a',
          script: '',
          arguments: {},
          realArg: {},
          customLink: [],
          argMeta: {},
          version: '3.0',
        },
      ],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/plugins/missing',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 1, patch: { enabled: true } },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Plugin not found: missing')

    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugins/plugin-a/enable',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, enabled: true },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})

describe('plugin-storage commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('puts, deletes, and bulk updates plugin custom storage', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      pluginCustomStorage: {
        old: 'value',
        keep: true,
      },
    })

    const put = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/theme',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, value: { mode: 'dark' } },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({
      revision: 2,
      key: 'theme',
      event: { type: 'pluginStorage.updated', resource: 'pluginStorage', id: 'theme' },
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/plugin-storage/old',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 2 },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      revision: 3,
      key: 'old',
      event: { type: 'pluginStorage.deleted', id: 'old' },
    })

    const bulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugin-storage/bulk',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 3,
        values: { score: 42, nested: { ok: true } },
        deleteKeys: ['keep'],
      },
    })
    expect(bulk.statusCode).toBe(200)
    expect(bulk.json()).toMatchObject({
      revision: 4,
      event: { type: 'pluginStorage.bulkUpdated', resource: 'pluginStorage' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(4)
    expect(bootstrap.resourceDatabase.pluginCustomStorage).toEqual({
      theme: { mode: 'dark' },
      score: 42,
      nested: { ok: true },
    })
    expect(
      harness.commandEvents
        .list()
        .slice(-3)
        .map((event) => event.type),
    ).toEqual(['pluginStorage.updated', 'pluginStorage.deleted', 'pluginStorage.bulkUpdated'])
  })

  it('rejects malformed plugin-storage commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      pluginCustomStorage: { existing: 'value' },
    })

    const badKey = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/%20',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, value: 'x' },
    })
    expect(badKey.statusCode).toBe(400)
    expect(badKey.json().error).toBe('key must be a non-empty string')

    const badBulk = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/plugin-storage/bulk',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, values: {}, deleteKeys: [] },
    })
    expect(badBulk.statusCode).toBe(400)
    expect(badBulk.json().error).toBe('bulk plugin storage command must change at least one key')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase.pluginCustomStorage).toEqual({ existing: 'value' })
  })

  it('returns 409 for stale plugin-storage revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    await importDatabase(harness.app, assertion, {
      pluginCustomStorage: {},
    })

    const stale = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/commands/plugin-storage/key',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, value: 'x' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
