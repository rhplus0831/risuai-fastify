import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import { type Harness, startHarness, stopHarness, importDatabase } from './helpers/commandHarness.js'

async function projectedPromptItems(
  app: FastifyInstance,
  assertion: string,
): Promise<{ revision: number; promptTemplate?: Array<Record<string, unknown>> }> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/collections/promptTemplate',
    headers: { 'risu-auth': assertion },
  })
  expect(res.statusCode).toBe(200)
  const body = res.json() as {
    revision: number
    collections: { promptTemplate?: Array<Record<string, unknown>> }
  }
  return { revision: body.revision, promptTemplate: body.collections.promptTemplate }
}

let harness: Harness

describe('prompt template and item commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('patches prompt settings and emits the prompt settings event', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptSettings: { sendName: false, maxThoughtTagDepth: -1 },
      jsonSchemaEnabled: false,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          mainPrompt: 'MAIN',
          jailbreak: 'JB',
          globalNote: 'GN',
          formatingOrder: ['main', 'jailbreak', 'globalNote'],
          promptPreprocess: true,
          presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
          promptSettings: { sendName: true, maxThoughtTagDepth: 4 },
          jsonSchemaEnabled: true,
          jsonSchema: '{"type":"object"}',
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.settings.updated',
        revision: 2,
        resource: 'prompt',
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      mainPrompt: 'MAIN',
      jailbreak: 'JB',
      globalNote: 'GN',
      formatingOrder: ['main', 'jailbreak', 'globalNote'],
      promptPreprocess: true,
      presetRegex: [{ id: 'regex-a', type: 'editinput', in: 'hello', out: 'hi' }],
      promptSettings: { sendName: true, maxThoughtTagDepth: 4 },
      jsonSchemaEnabled: true,
      jsonSchema: '{"type":"object"}',
    })
  })

  it('creates, updates, deletes, and reorders prompt items by stable id', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptTemplate: [{ id: 'item-a', type: 'description' }],
    })

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: {
          id: 'item-b',
          type: 'plain',
          type2: 'normal',
          text: 'hello',
          role: 'system',
          innerFormat: 'legacy format',
          removable: 'drop me',
          largeMetadata: 'x'.repeat(20_000),
        },
      },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.item.created',
        revision: 2,
        resource: 'promptItem',
        id: 'item-b',
      },
      itemId: 'item-b',
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/item-b',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: created.json().revision,
        patch: {
          text: 'updated',
          role: 'user',
          innerFormat: null,
        },
        deleteKeys: ['removable'],
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().event).toMatchObject({
      type: 'prompt.item.updated',
      resource: 'promptItem',
      id: 'item-b',
    })

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: updated.json().revision,
        itemIds: ['item-b', 'item-a'],
      },
    })
    expect(reordered.statusCode).toBe(200)
    expect(reordered.json().event).toMatchObject({
      type: 'prompt.item.reordered',
      resource: 'promptItem',
    })

    const deleted = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: reordered.json().revision,
      },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().event).toMatchObject({
      type: 'prompt.item.deleted',
      resource: 'promptItem',
      id: 'item-a',
    })

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(deleted.json().revision)
    expect(projected.promptTemplate).toEqual([
      {
        id: 'item-b',
        type: 'plain',
        type2: 'normal',
        text: 'updated',
        role: 'user',
        innerFormat: null,
        largeMetadata: 'x'.repeat(20_000),
      },
    ])
  })

  it('applies sparse prompt item fields and deletions to a selected prompt preset only', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          promptTemplate: [
            {
              id: 'item-a',
              type: 'description',
              text: 'before',
              role2: 'assistant',
              innerFormat: 'legacy format',
              removable: 'drop me',
              largeMetadata: 'x'.repeat(20_000),
            },
          ],
        },
      ],
      promptTemplate: [{ id: 'root-item', type: 'memory', untouched: true }],
    })

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptPresetId: 'prompt-a',
        patch: { id: 'item-a', text: 'after', innerFormat: null, role2: 'char' },
        deleteKeys: ['removable'],
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: 2,
      event: {
        type: 'prompt.item.updated',
        revision: 2,
        resource: 'promptItem',
        id: 'item-a',
        parentId: 'prompt-a',
      },
      itemId: 'item-a',
    })

    const presetTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: { 'risu-auth': assertion },
    })
    expect(presetTemplate.statusCode).toBe(200)
    expect(presetTemplate.json().promptTemplate).toEqual([
      {
        id: 'item-a',
        type: 'description',
        text: 'after',
        role2: 'bot',
        innerFormat: null,
        largeMetadata: 'x'.repeat(20_000),
      },
    ])

    const rootTemplate = await projectedPromptItems(harness.app, assertion)
    expect(rootTemplate.promptTemplate).toEqual([{ id: 'root-item', type: 'memory', untouched: true }])
  })

  it('rejects malformed prompt commands without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptPresetsId: 0,
      promptPresets: [
        {
          id: 'prompt-a',
          name: 'Prompt A',
          promptTemplate: [{ id: 'preset-item', type: 'plain', text: 'preset text' }],
        },
      ],
      promptTemplate: [
        { id: 'item-a', type: 'description' },
        { id: 'item-b', type: 'memory' },
      ],
    })

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { jsonSchemaEnabled: 'yes' },
      },
    })
    expect(settings.statusCode).toBe(400)
    expect(settings.json().error).toBe('jsonSchemaEnabled must be a boolean')

    const promptTemplateSettings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-settings',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { promptTemplate: [] },
      },
    })
    expect(promptTemplateSettings.statusCode).toBe(400)
    expect(promptTemplateSettings.json().error).toBe('Unsupported prompt setting: promptTemplate')

    const missingId = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: { type: 'memory' },
      },
    })
    expect(missingId.statusCode).toBe(400)
    expect(missingId.json().error).toBe('promptItem.id must be a non-empty string')

    const duplicateCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptItem: { id: 'item-a', type: 'memory' },
      },
    })
    expect(duplicateCreate.statusCode).toBe(400)
    expect(duplicateCreate.json().error).toBe('Duplicate prompt item id: item-a')

    const reorder = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        itemIds: ['item-a', 'item-a'],
      },
    })
    expect(reorder.statusCode).toBe(400)
    expect(reorder.json().error).toBe('Duplicate prompt item id: item-a')

    const invalidUpdates = [
      {
        payload: { patch: {}, deleteKeys: 'text' },
        error: 'deleteKeys must be an array',
      },
      {
        payload: { patch: {}, deleteKeys: [''] },
        error: 'deleteKeys must contain non-empty strings',
      },
      {
        payload: { patch: {}, deleteKeys: ['text', 'text'] },
        error: 'Duplicate delete key: text',
      },
      {
        payload: { patch: {}, deleteKeys: ['id'] },
        error: 'deleteKeys must not contain id',
      },
      {
        payload: { patch: { id: 'item-b', text: 'changed' } },
        error: 'patch.id must match itemId',
      },
      {
        payload: { patch: { text: 'changed' }, deleteKeys: ['text'] },
        error: 'patch and deleteKeys must not overlap: text',
      },
      {
        payload: { patch: {} },
        error: 'prompt item update must include at least one field',
      },
      {
        payload: { patch: { id: 'item-a' } },
        error: 'prompt item update must include at least one field',
      },
      {
        payload: { patch: { ' ': true } },
        error: 'patch keys must be non-empty strings',
      },
    ]

    for (const invalid of invalidUpdates) {
      const update = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/prompt-items/item-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          ...invalid.payload,
        },
      })
      expect(update.statusCode).toBe(400)
      expect(update.json().error).toBe(invalid.error)
    }

    const invalidPresetUpdate = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/preset-item',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        promptPresetId: 'prompt-a',
        patch: { text: 'changed' },
        deleteKeys: ['text'],
      },
    })
    expect(invalidPresetUpdate.statusCode).toBe(400)
    expect(invalidPresetUpdate.json().error).toBe('patch and deleteKeys must not overlap: text')

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(1)
    expect(projected.promptTemplate?.map((item) => item.id)).toEqual(['item-a', 'item-b'])

    const presetTemplate = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/prompt-presets/prompt-a/template',
      headers: { 'risu-auth': assertion },
    })
    expect(presetTemplate.json()).toMatchObject({
      revision: 1,
      promptTemplate: [{ id: 'preset-item', type: 'plain', text: 'preset text' }],
    })
  })

  it('enables and disables prompt items through prompt-item commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {})

    const enabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/enable',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        enabled: true,
      },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json()).toMatchObject({
      revision: 2,
      event: { type: 'prompt.item.enabled', resource: 'promptItem' },
      enabled: true,
    })

    const disabled = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/prompt-items/enable',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: enabled.json().revision,
        enabled: false,
      },
    })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({ revision: 3, enabled: false })

    const projected = await projectedPromptItems(harness.app, assertion)
    expect(projected.revision).toBe(disabled.json().revision)
    expect(projected.promptTemplate).toEqual([])
  })

  it('returns 404 and 409 for missing prompt items and stale revisions', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      promptTemplate: [{ id: 'item-a', type: 'description' }],
    })

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/prompt-items/missing',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { type: 'memory' },
      },
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error).toBe('Prompt item not found: missing')

    const stale = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/commands/prompt-items/item-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: 0,
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ error: 'revision_conflict', currentRevision: 1 })
  })
})
