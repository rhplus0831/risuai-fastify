import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
  projectedCharacterRow,
  uploadAsset,
} from './helpers/commandHarness.js'

let harness: Harness

describe('asset reference commands', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('persists uploaded asset ids through owning character, module, persona, settings, and folder commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const firstAsset = await uploadAsset(harness.app, assertion, Buffer.from('first'))
    const secondAsset = await uploadAsset(harness.app, assertion, Buffer.from('second'))
    const revision = await importDatabase(harness.app, assertion, {
      currentChar: 0,
      username: 'User',
      userIcon: '',
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          image: '',
          emotionImages: [],
          additionalAssets: [],
          ccAssets: [],
          chats: [],
          chatFolders: [],
          chatPage: 0,
        },
      ],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Module', description: '', assets: [] }],
    })

    const createdCharacter = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          vits: { files: { greeting: firstAsset.assetId } },
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
          },
          chats: [],
          chatFolders: [],
        },
      },
    })
    expect(createdCharacter.statusCode).toBe(200)
    expect(createdCharacter.json().event).toMatchObject({
      type: 'character.created',
      resource: 'character',
      id: 'char-b',
    })

    const character = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: createdCharacter.json().revision,
        patch: {
          image: firstAsset.assetId,
          emotionImages: [['happy', firstAsset.assetId]],
          additionalAssets: [['extra.png', secondAsset.assetId, 'png']],
          ccAssets: [{ type: 'icon', uri: secondAsset.assetId, name: 'alt', ext: 'png' }],
          prebuiltAssetExclude: [secondAsset.assetId],
          vits: { files: { greeting: firstAsset.assetId } },
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
          },
        },
      },
    })
    expect(character.statusCode).toBe(200)
    expect(character.json().event).toMatchObject({
      type: 'character.updated',
      resource: 'characterRow',
      id: 'char-a',
    })

    const module = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: character.json().revision,
        patch: { assets: [['module.png', firstAsset.assetId, 'png']] },
      },
    })
    expect(module.statusCode).toBe(200)
    expect(module.json().event).toMatchObject({ type: 'module.updated', id: 'mod-a' })

    const persona = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: module.json().revision,
        patch: { icon: secondAsset.assetId },
        mirrorLegacyProfile: true,
      },
    })
    expect(persona.statusCode).toBe(200)

    const settings = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: persona.json().revision,
        patch: { customBackground: firstAsset.assetId },
      },
    })
    expect(settings.statusCode).toBe(200)

    const reordered = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settings.json().revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: '',
            imgFile: secondAsset.assetId,
            img: `/api/v1/assets/${secondAsset.assetId}`,
            data: ['char-a', 'char-b'],
          },
        ],
      },
    })
    expect(reordered.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    const database = bootstrap.resourceDatabase
    expect(database.characters[0]).toMatchObject({
      image: firstAsset.assetId,
      emotionImages: [['happy', firstAsset.assetId]],
      additionalAssets: [['extra.png', secondAsset.assetId, 'png']],
      ccAssets: [{ type: 'icon', uri: secondAsset.assetId, name: 'alt', ext: 'png' }],
      prebuiltAssetExclude: [secondAsset.assetId],
      vits: { files: { greeting: firstAsset.assetId } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
      },
    })
    expect(await projectedCharacterRow(harness.app, assertion, 'char-b')).toMatchObject({
      chaId: 'char-b',
      vits: { files: { greeting: firstAsset.assetId } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: secondAsset.assetId },
      },
    })
    const persisted = loadPersistedFromDir(harness.dataDir).database as {
      modules: Array<{ assets?: unknown[] }>
    }
    expect(persisted.modules[0].assets).toEqual([['module.png', firstAsset.assetId, 'png']])
    expect(database.personas[0].icon).toBe(secondAsset.assetId)
    expect(database.customBackground).toBe(firstAsset.assetId)
    expect(database.characterOrder[0].imgFile).toBe(secondAsset.assetId)
  })

  it('rejects malformed and missing asset references without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const uploaded = await uploadAsset(harness.app, assertion, Buffer.from('valid-ref'))
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
      modules: [{ id: 'mod-a', name: 'Module', description: '' }],
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
      selectedPersona: 0,
    })
    const missingAssetId = '0'.repeat(64)

    const malformed = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { image: 'assets/not-server.png' } },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json().error).toBe('patch.image must be a server asset id')

    const missing = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/modules/mod-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { assets: [['missing.png', missingAssetId, 'png']] },
      },
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toBe('patch.assets[0][1] references a missing server asset')

    const missingOrderImage = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters/reorder',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        characterOrder: [
          {
            id: 'folder-a',
            name: 'Folder A',
            color: '',
            img: missingAssetId,
            data: ['char-a'],
          },
        ],
      },
    })
    expect(missingOrderImage.statusCode).toBe(400)
    expect(missingOrderImage.json().error).toBe('characterOrder[0].img references a missing server asset')

    const valid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/personas/persona-a',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { icon: uploaded.assetId } },
    })
    expect(valid.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision + 1)
    expect(bootstrap.resourceDatabase.characters[0].image).toBeUndefined()
    expect(bootstrap.resourceDatabase.modules[0].assets).toBeUndefined()
    expect(bootstrap.resourceDatabase.personas[0].icon).toBe(uploaded.assetId)
  })

  it('rejects malformed and missing character audio asset refs on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })
    const missingAssetId = '0'.repeat(64)

    const malformedCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          vits: { files: { greeting: 'assets/not-server.wav' } },
        },
      },
    })
    expect(malformedCreate.statusCode).toBe(400)
    expect(malformedCreate.json().error).toBe('character.vits.files.greeting must be a server asset id')

    const missingCreate = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/commands/characters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        character: {
          chaId: 'char-b',
          name: 'B',
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: missingAssetId },
          },
        },
      },
    })
    expect(missingCreate.statusCode).toBe(400)
    expect(missingCreate.json().error).toBe(
      'character.gptSoVitsConfig.ref_audio_data.assetId references a missing server asset',
    )

    const malformedPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          gptSoVitsConfig: {
            ref_audio_data: { fileName: 'ref.wav', assetId: 'assets/not-server.wav' },
          },
        },
      },
    })
    expect(malformedPatch.statusCode).toBe(400)
    expect(malformedPatch.json().error).toBe('patch.gptSoVitsConfig.ref_audio_data.assetId must be a server asset id')

    const missingPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/characters/char-a',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { vits: { files: { greeting: missingAssetId } } },
      },
    })
    expect(missingPatch.statusCode).toBe(400)
    expect(missingPatch.json().error).toBe('patch.vits.files.greeting references a missing server asset')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(revision)
    expect(bootstrap.resourceDatabase.characters).toHaveLength(1)
    expect(bootstrap.resourceDatabase.characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'A',
      chats: [],
      chatFolders: [],
    })
    expect(bootstrap.resourceDatabase.characters[0].vits).toBeUndefined()
    expect(bootstrap.resourceDatabase.characters[0].gptSoVitsConfig).toBeUndefined()
  })

  it('accepts optional character audio clear refs on create and patch', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      characters: [{ chaId: 'char-a', name: 'A', chats: [], chatFolders: [] }],
      characterOrder: ['char-a'],
    })
    const clearValues = [null, '', '-'] as const

    for (const [index, clearValue] of clearValues.entries()) {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/commands/characters',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          character: {
            chaId: `char-clear-${index}`,
            name: `Clear ${index}`,
            vits: { files: { greeting: clearValue } },
            gptSoVitsConfig: {
              ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
            },
          },
        },
      })
      expect(created.statusCode).toBe(200)
      revision = created.json().revision

      const patched = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/characters/char-a',
        headers: { 'risu-auth': assertion },
        payload: {
          baseRevision: revision,
          patch: {
            vits: { files: { greeting: clearValue } },
            gptSoVitsConfig: {
              ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
            },
          },
        },
      })
      expect(patched.statusCode).toBe(200)
      revision = patched.json().revision
    }

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.statusCode).toBe(200)
    for (const [index, clearValue] of clearValues.entries()) {
      expect(await projectedCharacterRow(harness.app, assertion, `char-clear-${index}`)).toMatchObject({
        vits: { files: { greeting: clearValue } },
        gptSoVitsConfig: {
          ref_audio_data: { fileName: 'ref.wav', assetId: clearValue },
        },
      })
    }
    expect(await projectedCharacterRow(harness.app, assertion, 'char-a')).toMatchObject({
      vits: { files: { greeting: '-' } },
      gptSoVitsConfig: {
        ref_audio_data: { fileName: 'ref.wav', assetId: '-' },
      },
    })
  })
})
