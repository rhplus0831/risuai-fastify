import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { MASKED_PROVIDER_SECRET } from '../src/providerSecrets.js'
import { serializeScriptDefinitionCollectionDigestInput } from '@risuai/shared-core/mutation-certificates'
import { injectComposedResourceDatabase } from './helpers/resourceDatabase.js'
import { setupAuthedClient } from './helpers/auth.js'
import {
  type Harness,
  readAllDatabaseRows,
  startHarness,
  stopHarness,
  loadPersistedFromDir,
  importDatabase,
} from './helpers/commandHarness.js'

let harness: Harness

describe('scalar settings groups', () => {
  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await stopHarness(harness)
  })

  it('applies display settings through the grouped settings command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
      zoomsize: 100,
      chatScreenWidth: 900,
      desktopSidebarColumns: 1,
      mobileSidebarColumns: 1,
      autoTranslateNotificationDeferCapSeconds: 180,
      paragraphBreakBySentences: false,
      paragraphBreakSentenceCount: 3,
      greeting: 'hi',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          theme: 'light',
          zoomsize: 88,
          chatScreenWidth: 1240,
          desktopSidebarColumns: 4,
          mobileSidebarColumns: 2,
          autoTranslateNotificationDeferCapSeconds: 0,
          paragraphBreakBySentences: true,
          paragraphBreakSentenceCount: 5,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'display',
      },
      acknowledgedKeys: [
        'theme',
        'zoomsize',
        'chatScreenWidth',
        'desktopSidebarColumns',
        'mobileSidebarColumns',
        'autoTranslateNotificationDeferCapSeconds',
        'paragraphBreakBySentences',
        'paragraphBreakSentenceCount',
      ],
      settings: {},
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(2)
    expect(bootstrap.resourceDatabase).toMatchObject({
      theme: 'light',
      zoomsize: 88,
      chatScreenWidth: 1240,
      desktopSidebarColumns: 4,
      mobileSidebarColumns: 2,
      autoTranslateNotificationDeferCapSeconds: 0,
      paragraphBreakBySentences: true,
      paragraphBreakSentenceCount: 5,
      greeting: 'hi',
    })
  })

  it('rejects sidebar column values outside each exact integer range', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      desktopSidebarColumns: 1,
      mobileSidebarColumns: 1,
    })

    for (const [key, values, maximum] of [
      ['desktopSidebarColumns', [0, 1.5, 5], 4],
      ['mobileSidebarColumns', [0, 1.5, 3], 2],
    ] as const) {
      for (const value of values) {
        const res = await harness.app.inject({
          method: 'PATCH',
          url: '/api/v1/commands/settings/display',
          headers: { 'risu-auth': assertion },
          payload: { baseRevision: revision, patch: { [key]: value } },
        })

        expect(res.statusCode).toBe(400)
        expect(res.json().error).toBe(`${key} must be an integer from 1 to ${maximum}`)
      }
    }
  })

  it('omits a large verbatim setting value from the command response', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customCSS: '',
    })
    const customCSS = `/* large */${'x'.repeat(64 * 1024)}`

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { customCSS } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['customCSS'],
      settings: {},
    })
    expect(res.body).not.toContain(customCSS)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.customCSS).toBe(customCSS)
  })

  it('patches large settings objects by field without echoing or replacing untouched data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const thumbnail = `data:image/png;base64,${'x'.repeat(64 * 1024)}`
    const originalVibe = {
      identifier: 'novelai-vibe-transfer',
      version: 1,
      type: 'image',
      image: '',
      id: 'vibe-a',
      encodings: {},
      name: 'Large vibe',
      thumbnail,
      createdAt: 1,
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1 },
    }
    const revision = await importDatabase(harness.app, assertion, {
      NAIImgConfig: {
        width: 512,
        height: 768,
        sampler: 'k_euler',
        vibe_data: originalVibe,
      },
      seperateParameters: {
        memory: { temperature: 0.4 },
        emotion: { temperature: 0.2 },
        translate: {},
        otherAx: {},
        scriptMain: {},
        scriptAux: {},
        overrides: { 'openrouter/model': { top_k: 42 } },
      },
    })

    const imagePatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { width: 832 } },
    })

    expect(imagePatch.statusCode, imagePatch.body).toBe(200)
    expect(imagePatch.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'media',
      },
      group: 'media',
      key: 'NAIImgConfig',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['width'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })
    expect(imagePatch.body).not.toContain(thumbnail)

    const parametersPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime/objects/seperateParameters',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: imagePatch.json().revision,
        patch: { memory: { temperature: 0.8 } },
      },
    })

    expect(parametersPatch.statusCode, parametersPatch.body).toBe(200)
    expect(parametersPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['memory'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.NAIImgConfig).toMatchObject({
      width: 832,
      height: 768,
      sampler: 'k_euler',
      vibe_data: originalVibe,
    })
    expect(bootstrap.resourceDatabase.seperateParameters).toEqual({
      memory: { temperature: 0.8 },
      emotion: { temperature: 0.2 },
      translate: {},
      otherAx: {},
      scriptMain: {},
      scriptAux: {},
      overrides: { 'openrouter/model': { top_k: 42 } },
    })
  })

  it('returns only the masked override when a shallow settings patch changes a secret', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      wavespeedImage: {
        key: 'old-secret',
        model: 'old-model',
        loras: [{ path: 'owner/old', scale: 1 }],
      },
    })

    const modelPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/wavespeedImage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { model: 'flux' } },
    })
    expect(modelPatch.statusCode, modelPatch.body).toBe(200)
    expect(modelPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['model'],
      canonicalValues: {},
    })
    expect(modelPatch.body).not.toContain('old-secret')

    const secretPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/wavespeedImage',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: modelPatch.json().revision, patch: { key: 'new-secret' } },
    })
    expect(secretPatch.statusCode, secretPatch.body).toBe(200)
    expect(secretPatch.json()).toMatchObject({
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['key'],
      canonicalValues: { key: MASKED_PROVIDER_SECRET },
    })
    expect(secretPatch.body).not.toContain('new-secret')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.wavespeedImage).toMatchObject({
      key: MASKED_PROVIDER_SECRET,
      model: 'flux',
      loras: [{ path: 'owner/old', scale: 1 }],
    })
  })

  it('rejects malformed shallow settings updates without advancing the revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      NAIImgConfig: { width: 512, height: 768 },
    })
    const attempts = [
      {
        url: '/api/v1/commands/settings/runtime/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 } },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 }, deleteKeys: ['width'] },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: {} },
      },
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        payload: { baseRevision: revision, patch: { width: 832 }, attemptedObject: { width: 832 } },
      },
    ]

    for (const attempt of attempts) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: attempt.url,
        headers: { 'risu-auth': assertion },
        payload: attempt.payload,
      })
      expect(response.statusCode, response.body).toBe(400)
    }

    const valid = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { width: 832 } },
    })
    expect(valid.statusCode, valid.body).toBe(200)
    expect(valid.json().revision).toBe(revision + 1)
  })

  it('returns only a normalized settings override alongside the acknowledged keys', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      keepSessionAlive: 'off',
      showUnrecommended: false,
      regexOutputSizeLimitMiB: 16,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          keepSessionAlive: 'pip',
          showUnrecommended: true,
          regexOutputSizeLimitMiB: 32,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      acknowledgedKeys: ['keepSessionAlive', 'showUnrecommended', 'regexOutputSizeLimitMiB'],
      settings: { keepSessionAlive: 'sound' },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      keepSessionAlive: 'sound',
      showUnrecommended: true,
      regexOutputSizeLimitMiB: 32,
    })
  })

  it('rejects regex output limits outside the supported range', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { regexOutputSizeLimitMiB: 16 })

    for (const regexOutputSizeLimitMiB of [0, 65, 1.5]) {
      const res = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/advanced',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { regexOutputSizeLimitMiB } },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('regexOutputSizeLimitMiB must be an integer from 1 to 64')
    }
  })

  it('accepts grouped settings updates across resource families', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const customColorScheme = {
      bgcolor: '#111111',
      darkbg: '#222222',
      borderc: '#333333',
      selected: '#444444',
      draculared: '#555555',
      textcolor: '#eeeeee',
      textcolor2: '#dddddd',
      darkBorderc: '#666666',
      darkbutton: '#777777',
      type: 'dark',
    }
    const revision = await importDatabase(harness.app, assertion, {
      notification: false,
      useAutoSuggestions: false,
      useAutoTranslateInput: false,
      globalscript: [],
    })

    const display = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          notification: true,
          textScreenColor: null,
          promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
          customTextTheme: { FontColorStandard: '#ffffff' },
          customColorScheme,
        },
      },
    })
    expect(display.statusCode).toBe(200)

    const runtime = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: display.json().revision,
        patch: { useAutoSuggestions: true },
      },
    })
    expect(runtime.statusCode).toBe(200)

    const language = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/language',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: runtime.json().revision,
        patch: { useAutoTranslateInput: true },
      },
    })
    expect(language.statusCode).toBe(200)

    const advanced = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: language.json().revision,
        patch: {
          globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
          allowAllExtentionFiles: true,
          auxModelUnderModelSettings: true,
          pluginCompatibilityMode: true,
          strictScriptCheck: true,
          keepSessionAlive: 'pip',
        },
      },
    })
    expect(advanced.statusCode).toBe(200)

    const sidebar = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: advanced.json().revision,
        patch: {
          globalChatVariables: { toggle_mood: '1' },
          jailbreakToggle: true,
          chatGenerationTogglePresets: [
            {
              id: 'toggle-preset-a',
              name: 'Toggle Preset A',
              createdAt: 1,
              updatedAt: 2,
              jailbreakToggle: true,
              sidebarToggles: {
                mood: '1',
              },
            },
          ],
          customSidebarItems: [
            {
              id: 'sidebar-loadout',
              type: 'loadout',
              subType: 'none',
              label: 'Loadouts',
            },
          ],
          hotkeys: [{ key: 'a', ctrl: true, action: 'home' }],
        },
      },
    })
    expect(sidebar.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      notification: true,
      useAutoSuggestions: true,
      useAutoTranslateInput: true,
      textScreenColor: null,
      promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
      customTextTheme: { FontColorStandard: '#ffffff' },
      customColorScheme,
      globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
      allowAllExtentionFiles: true,
      auxModelUnderModelSettings: true,
      globalChatVariables: { toggle_mood: '1' },
      jailbreakToggle: true,
      keepSessionAlive: 'sound',
      chatGenerationTogglePresets: [
        {
          id: 'toggle-preset-a',
          name: 'Toggle Preset A',
          createdAt: 1,
          updatedAt: 2,
          sidebarToggles: {
            mood: '1',
          },
        },
      ],
      customSidebarItems: [
        {
          id: 'sidebar-loadout',
          type: 'loadout',
          subType: 'none',
          label: 'Loadouts',
        },
      ],
      hotkeys: [{ key: 'a', ctrl: true, action: 'home' }],
    })
  })

  it('applies compact global-script mutations without echoing the script corpus', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const largeBody = 'x'.repeat(64 * 1024)
    const scripts = [
      { id: 'script-a', comment: 'A', in: 'a', out: largeBody, type: 'editinput' },
      { id: 'script-b', comment: 'B', in: 'b', out: largeBody, type: 'editoutput' },
    ]
    const revision = await importDatabase(harness.app, assertion, { globalscript: scripts })
    const expectedScripts = [{ ...scripts[0], comment: 'Edited A' }, scripts[1]]

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced/global-scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        mutation: {
          op: 'update',
          id: 'script-a',
          patch: { comment: 'Edited A' },
          deleteKeys: [],
        },
      },
    })

    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toEqual({
      revision: revision + 1,
      event: {
        type: 'settings.updated',
        revision: revision + 1,
        resource: 'settings',
        id: 'advanced',
      },
      group: 'advanced',
      key: 'globalscript',
      certificate: 'global-script-mutation-v1',
      operation: 'update',
      globalScriptsDigest: createHash('sha256')
        .update(serializeScriptDefinitionCollectionDigestInput(expectedScripts), 'utf8')
        .digest('hex'),
      acknowledgedKeys: ['globalscript'],
      settings: {},
    })
    expect(updated.body).not.toContain(largeBody)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.globalscript).toEqual(expectedScripts)

    const unknown = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced/global-scripts',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision + 1,
        mutation: { op: 'delete', id: 'missing-script' },
      },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'Script definition not found: missing-script' })
  })

  it('rejects malformed custom sidebar setting rows before persistence', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'bad-setting',
              type: 'setting',
              label: 'Broken setting',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'customSidebarItems[0].subType must be a string',
    })
  })

  it('rejects unsupported legacy database-key sidebar rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'legacy-database-key',
              type: 'databaseKey',
              subType: 'temperature',
              label: 'Temperature',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: 'customSidebarItems[0].type is unsupported',
    })
  })

  it('sanitizes custom sidebar rows to the supported persisted shape', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { customSidebarItems: [] })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/sidebar',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customSidebarItems: [
            {
              id: 'theme-setting',
              type: 'setting',
              subType: 'display.theme',
              label: 'Theme',
              setting: undefined,
              nested: { unsafe: true },
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase.customSidebarItems).toEqual([
      {
        id: 'theme-setting',
        type: 'setting',
        subType: 'display.theme',
        label: 'Theme',
      },
    ])
  })

  it('allows provider scalar updates and masks them in bootstrap', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      openAIKey: 'old',
      aiModel: 'gpt4o-chatgpt',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { openAIKey: 'new-secret', aiModel: 'openrouter' },
      },
    })

    expect(res.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      openAIKey: MASKED_PROVIDER_SECRET,
      aiModel: 'openrouter',
    })
  })

  it('applies chat format settings through the provider settings command', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      instructChatTemplate: 'chatml',
      JinjaTemplate: '',
    })
    const jinjaTemplate = '{% for message in messages %}{{ message.content }}{% endfor %}'

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          instructChatTemplate: 'jinja',
          JinjaTemplate: jinjaTemplate,
        },
      },
    })

    expect(res.statusCode, res.body).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      instructChatTemplate: 'jinja',
      JinjaTemplate: jinjaTemplate,
    })
  })

  it('preserves masked provider placeholders while replacing explicit new secrets', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      openAIKey: 'old-openai',
      claudeAPIKey: 'old-claude',
      OaiCompAPIKeys: { deepseek: 'old-deepseek', deepinfra: 'old-deepinfra' },
      customModels: [{ id: 'xcustom:::a', name: 'Custom A', key: 'old-custom', url: 'https://old.example.com' }],
      authRefreshes: [
        {
          url: 'https://mcp.example.com',
          tokenUrl: 'https://mcp.example.com/token',
          refreshToken: 'old-refresh',
          clientId: 'client-id',
          clientSecret: 'old-client-secret',
        },
      ],
      aiModel: 'gpt4o-chatgpt',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          openAIKey: MASKED_PROVIDER_SECRET,
          claudeAPIKey: 'new-claude',
          OaiCompAPIKeys: {
            deepseek: MASKED_PROVIDER_SECRET,
            deepinfra: 'new-deepinfra',
          },
          customModels: [
            {
              id: 'xcustom:::a',
              name: 'Custom A renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://new.example.com',
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp.example.com',
              tokenUrl: 'https://mcp.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-id-new',
              clientSecret: 'new-client-secret',
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      openAIKey: 'old-openai',
      claudeAPIKey: 'new-claude',
      OaiCompAPIKeys: { deepseek: 'old-deepseek', deepinfra: 'new-deepinfra' },
      customModels: [
        {
          id: 'xcustom:::a',
          name: 'Custom A renamed',
          key: 'old-custom',
          url: 'https://new.example.com',
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp.example.com',
          tokenUrl: 'https://mcp.example.com/token',
          refreshToken: 'old-refresh',
          clientId: 'client-id-new',
          clientSecret: 'new-client-secret',
        },
      ],
      aiModel: 'gpt4o-chatgpt',
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      openAIKey: MASKED_PROVIDER_SECRET,
      claudeAPIKey: MASKED_PROVIDER_SECRET,
      OaiCompAPIKeys: { deepseek: MASKED_PROVIDER_SECRET, deepinfra: MASKED_PROVIDER_SECRET },
      customModels: [{ key: MASKED_PROVIDER_SECRET }],
      authRefreshes: [
        {
          refreshToken: MASKED_PROVIDER_SECRET,
          clientSecret: MASKED_PROVIDER_SECRET,
        },
      ],
    })
  })

  it('restores masked provider array secrets by stable row identity after reorder', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [
        { id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' },
        { id: 'xcustom:::b', name: 'Custom B', key: 'custom-b', url: 'https://b.example.com' },
      ],
      providerCredentials: [
        { id: 'credential-a', name: 'Credential A', type: 'apiKey', apiKey: 'credential-a-key' },
        {
          id: 'credential-b',
          name: 'Credential B',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'b@example.com', privateKey: 'credential-b-private-key' },
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a',
          clientSecret: 'secret-a',
        },
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::b',
              name: 'Custom B renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://b2.example.com',
            },
            {
              id: 'xcustom:::a',
              name: 'Custom A renamed',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://a2.example.com',
            },
          ],
          providerCredentials: [
            {
              id: 'credential-b',
              name: 'Credential B renamed',
              type: 'vertexServiceAccount',
              vertex: { clientEmail: 'b-renamed@example.com', privateKey: MASKED_PROVIDER_SECRET },
            },
            {
              id: 'credential-a',
              name: 'Credential A renamed',
              type: 'apiKey',
              apiKey: MASKED_PROVIDER_SECRET,
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp-b.example.com',
              tokenUrl: 'https://mcp-b.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-b-new',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
            {
              url: 'https://mcp-a.example.com',
              tokenUrl: 'https://mcp-a.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-a-new',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      customModels: [
        {
          id: 'xcustom:::b',
          name: 'Custom B renamed',
          key: 'custom-b',
          url: 'https://b2.example.com',
        },
        {
          id: 'xcustom:::a',
          name: 'Custom A renamed',
          key: 'custom-a',
          url: 'https://a2.example.com',
        },
      ],
      providerCredentials: [
        {
          id: 'credential-b',
          name: 'Credential B renamed',
          type: 'vertexServiceAccount',
          vertex: { clientEmail: 'b-renamed@example.com', privateKey: 'credential-b-private-key' },
        },
        {
          id: 'credential-a',
          name: 'Credential A renamed',
          type: 'apiKey',
          apiKey: 'credential-a-key',
        },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b-new',
          clientSecret: 'secret-b',
        },
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a-new',
          clientSecret: 'secret-a',
        },
      ],
    })
  })

  it('does not transplant masked provider array secrets after deleting earlier rows', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [
        { id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' },
        { id: 'xcustom:::b', name: 'Custom B', key: 'custom-b', url: 'https://b.example.com' },
      ],
      authRefreshes: [
        {
          url: 'https://mcp-a.example.com',
          tokenUrl: 'https://mcp-a.example.com/token',
          refreshToken: 'refresh-a',
          clientId: 'client-a',
          clientSecret: 'secret-a',
        },
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::b',
              name: 'Custom B kept',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://b.example.com',
            },
          ],
          authRefreshes: [
            {
              url: 'https://mcp-b.example.com',
              tokenUrl: 'https://mcp-b.example.com/token',
              refreshToken: MASKED_PROVIDER_SECRET,
              clientId: 'client-b',
              clientSecret: MASKED_PROVIDER_SECRET,
            },
          ],
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      customModels: [{ id: 'xcustom:::b', name: 'Custom B kept', key: 'custom-b', url: 'https://b.example.com' }],
      authRefreshes: [
        {
          url: 'https://mcp-b.example.com',
          tokenUrl: 'https://mcp-b.example.com/token',
          refreshToken: 'refresh-b',
          clientId: 'client-b',
          clientSecret: 'secret-b',
        },
      ],
    })
  })

  it('rejects masked provider array placeholders without matching row identity', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      customModels: [{ id: 'xcustom:::a', name: 'Custom A', key: 'custom-a', url: 'https://a.example.com' }],
    })

    const missingIdentity = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [{ name: 'Missing Id', key: MASKED_PROVIDER_SECRET, url: 'https://missing.example.com' }],
        },
      },
    })
    expect(missingIdentity.statusCode).toBe(400)
    expect(missingIdentity.json().error).toContain('without id')

    const unknownRow = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          customModels: [
            {
              id: 'xcustom:::missing',
              name: 'Missing',
              key: MASKED_PROVIDER_SECRET,
              url: 'https://missing.example.com',
            },
          ],
        },
      },
    })
    expect(unknownRow.statusCode).toBe(400)
    expect(unknownRow.json().error).toContain('unknown customModels row')
  })

  it('applies manual settings page scalar roots through grouped commands', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      aiModel: 'gpt4o-chatgpt',
      maxContext: 8000,
      sdProvider: 'webui',
      username: 'User',
    })

    const provider = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/providers',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          aiModel: 'openrouter',
          subModel: 'claude',
          forceReplaceUrl: 'https://proxy.example.test',
          proxyKey: 'proxy-secret',
          customProxyRequestModel: 'proxy-model',
          customAPIFormat: 1,
          customTokenizer: 'tik',
          google: { accessToken: 'google-secret', projectId: 'project-a' },
          vertexClientEmail: 'vertex@example.test',
          vertexPrivateKey: 'vertex-private',
          vertexAccessToken: '',
          vertexAccessTokenExpires: 0,
          vertexRegion: 'us-central1',
          novellistAPI: 'novellist-secret',
          mancerHeader: 'mancer-secret',
          claudeAPIKey: 'claude-secret',
          mistralKey: 'mistral-secret',
          novelai: { token: 'nai-secret', model: 'nai-model' },
          cohereAPIKey: 'cohere-secret',
          ollamaURL: 'https://ollama.example.test',
          ollamaInputMode: 'manual',
          ollamaCloudModel: 'cloud-model',
          ollamaModelSource: 'cloud',
          ollamaCloudModelName: 'Cloud Model',
          ollamaApiKey: 'ollama-secret',
          ollamaRequestFormat: 1,
          ollamaModel: 'local-model',
          ollamaModelName: '',
          ollamaThinkingMode: 'medium',
          nanogptKey: 'nanogpt-secret',
          nanogptUseSubscriptionEndpoint: true,
          nanogptSubscriptionState: 'active',
          nanogptRequestModel: 'nano-model',
          nanogptRequestModelName: 'Nano Model',
          nanogptProvider: '',
          openrouterKey: 'openrouter-secret',
          openrouterRequestModel: 'openrouter/model',
          openrouterFallback: true,
          openrouterMiddleOut: true,
          openrouterProvider: {
            order: ['OpenAI'],
            only: ['Anthropic'],
            ignore: ['Google'],
          },
          useInstructPrompt: true,
          openAIKey: 'openai-secret',
          OaiCompAPIKeys: { deepseek: 'deepseek-secret' },
          reverseProxyOobaMode: true,
          NAIadventure: true,
          NAIappendName: true,
          koboldURL: 'https://kobold.example.test',
          echoMessage: 'pong',
          echoDelay: 2,
          hordeConfig: { apiKey: 'horde-secret', model: '', softPrompt: '' },
          textgenWebUIStreamURL: 'wss://stream.example.test',
          textgenWebUIBlockingURL: 'https://blocking.example.test',
          ooba: { top_k: 50, top_p: 0.8, formating: { useName: true } },
          reverseProxyOobaArgs: { mode: 'chat', tokenizer: 'llama', top_k: 40 },
          NAIsettings: { topP: 0.75, topK: 80 },
          ainconfig: { top_p: 0.7, top_k: 90 },
          bias: [['token', -10]],
          additionalParams: [['stop', 'value']],
          applyAdditionalParamsToAll: true,
          huggingfaceKey: 'huggingface-secret',
        },
      },
    })
    expect(provider.statusCode, provider.body).toBe(200)

    const runtime = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/runtime',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: provider.json().revision,
        patch: {
          maxContext: 12000,
          epEnabled: true,
          doNotChangeSeperateModels: true,
          seperateParametersEnabled: true,
          seperateParametersByModel: true,
          disableSeperateParameterChangeOnPresetChange: true,
          seperateModels: { memory: 'mem', translate: '', emotion: '', otherAx: '' },
          seperateParameters: {
            memory: { temperature: 0.6 },
            translate: { top_p: 0.7 },
            emotion: {},
            otherAx: {},
            overrides: { 'openrouter/model': { top_k: 42 } },
          },
          localStopStrings: ['stop'],
          useStreaming: true,
          streamGeminiThoughts: true,
        },
      },
    })
    expect(runtime.statusCode).toBe(200)

    const media = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/media',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: runtime.json().revision,
        patch: {
          sdProvider: 'wavespeed',
          webUiUrl: 'https://webui.example.test',
          sdSteps: 24,
          sdCFG: 8,
          sdConfig: { width: 1024, height: 768, enable_hr: true },
          NAIImgUrl: 'https://image.novelai.net',
          NAIApiKey: 'nai-image-secret',
          NAIImgModel: 'nai-diffusion-4-5-full',
          NAII2I: true,
          NAIImgConfig: { width: 832, height: 1216, sampler: 'k_euler' },
          dallEQuality: 'hd',
          stabilityKey: 'stability-secret',
          stabilityModel: 'core',
          stabllityStyle: 'anime',
          comfyUiUrl: 'https://comfy.example.test',
          comfyConfig: { workflow: '{}', timeout: 60 },
          falToken: 'fal-secret',
          falModel: 'fal-ai/flux-lora',
          falLora: 'https://lora.example.test/model.safetensors',
          falLoraScale: 0.75,
          ImagenModel: 'imagen-4.0-generate-001',
          ImagenImageSize: '2K',
          ImagenAspectRatio: '16:9',
          ImagenPersonGeneration: 'allow_adult',
          openaiCompatImage: {
            url: 'https://images.example.test/v1/images/generations',
            key: 'compat-image-secret',
            model: 'image-model',
            size: '1024x1024',
            quality: 'high',
          },
          wavespeedImage: {
            key: 'wave-key',
            model: 'flux',
            loras: [{ path: 'owner/model', scale: 1.2 }],
          },
          ttsAutoSpeech: true,
          elevenLabKey: 'eleven-secret',
          voicevoxUrl: 'https://voicevox.example.test',
          fishSpeechKey: 'fish-secret',
          emotionProcesser: 'embedding',
        },
      },
    })
    expect(media.statusCode).toBe(200)

    const memory = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: media.json().revision,
        patch: {
          hypaV3: true,
          hypaV3PresetId: 0,
          selectedHypaV3PresetId: 'fastify-memory',
          hypaV3Presets: [
            {
              id: 'fastify-memory',
              name: 'Fastify memory',
              settings: {
                summarizationModel: 'subModel',
                summarizationPrompt: 'Summarize',
                recentMemoryRatio: 0.4,
                similarMemoryRatio: 0.5,
              },
            },
          ],
          hypaModel: 'custom',
          hypaV3Key: 'hypa-openai-secret',
          hypaCustomSettings: {
            url: 'https://embedding.example.test/v1/embeddings',
            key: 'custom-embedding-secret',
            model: 'embedding-model',
          },
          voyageApiKey: 'voyage-secret',
        },
      },
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().settings).toMatchObject({
      hypaV3Key: MASKED_PROVIDER_SECRET,
      hypaCustomSettings: {
        url: 'https://embedding.example.test/v1/embeddings',
        key: MASKED_PROVIDER_SECRET,
        model: 'embedding-model',
      },
      voyageApiKey: MASKED_PROVIDER_SECRET,
    })

    const account = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/account',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: memory.json().revision,
        patch: {
          username: 'Fastify User',
          didFirstSetup: true,
        },
      },
    })
    expect(account.statusCode).toBe(200)

    const advanced = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: account.json().revision,
        patch: {
          moduleIntergration: 'module-ns',
          enableCustomFlags: true,
          customFlags: [8, 21],
          pluginCompatibilityMode: true,
          strictScriptCheck: true,
        },
      },
    })
    expect(advanced.statusCode).toBe(200)

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      aiModel: 'openrouter',
      subModel: 'claude',
      forceReplaceUrl: 'https://proxy.example.test',
      proxyKey: MASKED_PROVIDER_SECRET,
      customProxyRequestModel: 'proxy-model',
      customAPIFormat: 1,
      customTokenizer: 'tik',
      google: { accessToken: MASKED_PROVIDER_SECRET, projectId: 'project-a' },
      vertexClientEmail: 'vertex@example.test',
      vertexPrivateKey: MASKED_PROVIDER_SECRET,
      vertexAccessToken: '',
      vertexAccessTokenExpires: 0,
      vertexRegion: 'us-central1',
      novellistAPI: MASKED_PROVIDER_SECRET,
      mancerHeader: MASKED_PROVIDER_SECRET,
      claudeAPIKey: MASKED_PROVIDER_SECRET,
      mistralKey: MASKED_PROVIDER_SECRET,
      novelai: { token: MASKED_PROVIDER_SECRET, model: 'nai-model' },
      cohereAPIKey: MASKED_PROVIDER_SECRET,
      ollamaURL: 'https://ollama.example.test',
      ollamaInputMode: 'manual',
      ollamaCloudModel: 'cloud-model',
      ollamaModelSource: 'cloud',
      ollamaCloudModelName: 'Cloud Model',
      ollamaApiKey: MASKED_PROVIDER_SECRET,
      ollamaRequestFormat: 1,
      ollamaModel: 'local-model',
      ollamaModelName: '',
      ollamaThinkingMode: 'medium',
      nanogptKey: MASKED_PROVIDER_SECRET,
      nanogptUseSubscriptionEndpoint: true,
      nanogptSubscriptionState: 'active',
      nanogptRequestModel: 'nano-model',
      nanogptRequestModelName: 'Nano Model',
      nanogptProvider: '',
      openrouterKey: MASKED_PROVIDER_SECRET,
      openrouterRequestModel: 'openrouter/model',
      openrouterFallback: true,
      openrouterMiddleOut: true,
      openrouterProvider: {
        order: ['OpenAI'],
        only: ['Anthropic'],
        ignore: ['Google'],
      },
      useInstructPrompt: true,
      openAIKey: MASKED_PROVIDER_SECRET,
      OaiCompAPIKeys: { deepseek: MASKED_PROVIDER_SECRET },
      reverseProxyOobaMode: true,
      NAIadventure: true,
      NAIappendName: true,
      koboldURL: 'https://kobold.example.test',
      echoMessage: 'pong',
      echoDelay: 2,
      hordeConfig: { apiKey: MASKED_PROVIDER_SECRET, model: '', softPrompt: '' },
      textgenWebUIStreamURL: 'wss://stream.example.test',
      textgenWebUIBlockingURL: 'https://blocking.example.test',
      ooba: { top_k: 50, top_p: 0.8, formating: { useName: true } },
      reverseProxyOobaArgs: { mode: 'chat', tokenizer: 'llama', top_k: 40 },
      NAIsettings: { topP: 0.75, topK: 80 },
      ainconfig: { top_p: 0.7, top_k: 90 },
      bias: [['token', -10]],
      additionalParams: [['stop', 'value']],
      applyAdditionalParamsToAll: true,
      huggingfaceKey: MASKED_PROVIDER_SECRET,
      maxContext: 12000,
      useStreaming: true,
      streamGeminiThoughts: true,
      epEnabled: true,
      doNotChangeSeperateModels: true,
      seperateParametersEnabled: true,
      seperateParametersByModel: true,
      disableSeperateParameterChangeOnPresetChange: true,
      seperateModels: { memory: 'mem', translate: '', emotion: '', otherAx: '' },
      seperateParameters: {
        memory: { temperature: 0.6 },
        translate: { top_p: 0.7 },
        emotion: {},
        otherAx: {},
        overrides: { 'openrouter/model': { top_k: 42 } },
      },
      localStopStrings: ['stop'],
      sdProvider: 'wavespeed',
      webUiUrl: 'https://webui.example.test',
      sdSteps: 24,
      sdCFG: 8,
      sdConfig: { width: 1024, height: 768, enable_hr: true },
      NAIImgUrl: 'https://image.novelai.net',
      NAIApiKey: MASKED_PROVIDER_SECRET,
      NAIImgModel: 'nai-diffusion-4-5-full',
      NAII2I: true,
      NAIImgConfig: { width: 832, height: 1216, sampler: 'k_euler' },
      dallEQuality: 'hd',
      stabilityKey: MASKED_PROVIDER_SECRET,
      stabilityModel: 'core',
      stabllityStyle: 'anime',
      comfyUiUrl: 'https://comfy.example.test',
      comfyConfig: { workflow: '{}', timeout: 60 },
      falToken: MASKED_PROVIDER_SECRET,
      falModel: 'fal-ai/flux-lora',
      falLora: 'https://lora.example.test/model.safetensors',
      falLoraScale: 0.75,
      ImagenModel: 'imagen-4.0-generate-001',
      ImagenImageSize: '2K',
      ImagenAspectRatio: '16:9',
      ImagenPersonGeneration: 'allow_adult',
      openaiCompatImage: {
        url: 'https://images.example.test/v1/images/generations',
        key: MASKED_PROVIDER_SECRET,
        model: 'image-model',
        size: '1024x1024',
        quality: 'high',
      },
      wavespeedImage: {
        key: MASKED_PROVIDER_SECRET,
        model: 'flux',
        loras: [{ path: 'owner/model', scale: 1.2 }],
      },
      ttsAutoSpeech: true,
      elevenLabKey: MASKED_PROVIDER_SECRET,
      voicevoxUrl: 'https://voicevox.example.test',
      fishSpeechKey: MASKED_PROVIDER_SECRET,
      emotionProcesser: 'embedding',
      hypaV3: true,
      hypaV3PresetId: 0,
      selectedHypaV3PresetId: 'fastify-memory',
      hypaV3Presets: [
        {
          id: 'fastify-memory',
          name: 'Fastify memory',
          settings: {
            summarizationModel: 'subModel',
            summarizationPrompt: 'Summarize',
            recentMemoryRatio: 0.4,
            similarMemoryRatio: 0.5,
          },
        },
      ],
      hypaModel: 'custom',
      hypaV3Key: MASKED_PROVIDER_SECRET,
      hypaCustomSettings: {
        url: 'https://embedding.example.test/v1/embeddings',
        key: MASKED_PROVIDER_SECRET,
        model: 'embedding-model',
      },
      voyageApiKey: MASKED_PROVIDER_SECRET,
      username: 'Fastify User',
      didFirstSetup: true,
      moduleIntergration: 'module-ns',
      enableCustomFlags: true,
      customFlags: [8, 21],
      pluginCompatibilityMode: true,
      strictScriptCheck: true,
    })
  })

  it('distinguishes settings-only memory patches from Hypa preset collection writes', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3: false,
      hypaV3Presets: [],
    })

    const settingsOnly = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: { hypaV3: true },
      },
    })
    expect(settingsOnly.statusCode).toBe(200)
    expect(settingsOnly.json()).toMatchObject({
      acknowledgedKeys: ['hypaV3'],
      settings: {},
    })
    expect(settingsOnly.json().event).toMatchObject({
      type: 'settings.updated',
      resource: 'settings',
      id: 'memory',
    })

    const withPresets = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: settingsOnly.json().revision,
        patch: {
          selectedHypaV3PresetId: 'cross-resource-memory',
          hypaV3Presets: [
            {
              id: 'cross-resource-memory',
              name: 'Cross-resource memory',
              settings: {
                summarizationModel: 'subModel',
                summarizationPrompt: 'Summarize',
                recentMemoryRatio: 0.4,
                similarMemoryRatio: 0.5,
              },
            },
          ],
        },
      },
    })
    expect(withPresets.statusCode).toBe(200)
    expect(withPresets.json()).toMatchObject({
      acknowledgedKeys: ['selectedHypaV3PresetId', 'hypaV3Presets'],
      settings: {},
    })
    expect(withPresets.json().event).toMatchObject({
      type: 'settings.updated',
      resource: 'settingsWithHypaV3Presets',
      id: 'memory',
    })
  })

  it('keeps stable Hypa selection authoritative and co-writes its numeric projection atomically', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    let revision = await importDatabase(harness.app, assertion, {
      hypaV3Presets: [
        { id: 'memory-a', name: 'A', settings: {} },
        { id: 'memory-b', name: 'B', settings: {} },
      ],
      selectedHypaV3PresetId: 'memory-a',
      hypaV3PresetId: 0,
    })

    const selected = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { selectedHypaV3PresetId: 'memory-b' } },
    })
    expect(selected.statusCode, selected.body).toBe(200)
    revision = selected.json().revision

    const reordered = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          hypaV3Presets: [
            { id: 'memory-b', name: 'B', settings: {} },
            { id: 'memory-a', name: 'A', settings: {} },
          ],
        },
      },
    })
    expect(reordered.statusCode, reordered.body).toBe(200)

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      const settings = JSON.parse(
        (db.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string }).data_json,
      ) as Record<string, unknown>
      expect(settings).toMatchObject({ selectedHypaV3PresetId: 'memory-b', hypaV3PresetId: 0 })
      const presets = db.prepare('SELECT data_json FROM hypa_v3_presets ORDER BY position').all() as Array<{
        data_json: string
      }>
      expect(presets.map(({ data_json }) => (JSON.parse(data_json) as { id: string }).id)).toEqual([
        'memory-b',
        'memory-a',
      ])
    } finally {
      db.close()
    }
  })

  it('rejects malformed Hypa identity patches and damaged stored rows without write or revision churn', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3Presets: [
        { id: 'memory-a', name: 'A', settings: {} },
        { id: 'memory-b', name: 'B', settings: {} },
      ],
      selectedHypaV3PresetId: 'memory-a',
      hypaV3PresetId: 0,
    })

    for (const patch of [
      { hypaV3PresetId: 1 },
      { selectedHypaV3PresetId: 'memory-b', hypaV3PresetId: 0 },
      {
        selectedHypaV3PresetId: 'missing',
        hypaV3Presets: [{ id: 'memory-a', name: 'A', settings: {} }],
      },
      {
        selectedHypaV3PresetId: 'memory-a',
        hypaV3Presets: [{ name: 'Missing id', settings: {} }],
      },
      {
        selectedHypaV3PresetId: 'duplicate',
        hypaV3Presets: [
          { id: 'duplicate', name: 'A', settings: {} },
          { id: 'duplicate', name: 'B', settings: {} },
        ],
      },
    ]) {
      const before = readAllDatabaseRows(harness.dataDir)
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/memory',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch },
      })
      expect(response.statusCode, response.body).toBe(400)
      expect(readAllDatabaseRows(harness.dataDir)).toEqual(before)
    }

    const db = new DatabaseSync(path.join(harness.dataDir, 'risu.db'))
    try {
      db.prepare('UPDATE hypa_v3_presets SET data_json = ? WHERE position = 1').run(
        JSON.stringify({ id: 'memory-a', name: 'Damaged duplicate', settings: {} }),
      )
    } finally {
      db.close()
    }
    const damagedRows = readAllDatabaseRows(harness.dataDir)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { selectedHypaV3PresetId: 'memory-b' } },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().error).toBe('Duplicate hypaV3Presets id: memory-a')
    expect(readAllDatabaseRows(harness.dataDir)).toEqual(damagedRows)
  })

  it('rejects legacy Hypa aliases while allowing canonical preset settings to remain authoritative', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      hypaV3Settings: { summarizationPrompt: 'stale flat prompt' },
      supaMemoryKey: 'stale-flat-key',
      hypaV3Presets: [
        {
          id: 'canonical-memory',
          name: 'Canonical memory',
          settings: { summarizationModel: 'subModel', summarizationPrompt: 'canonical prompt' },
        },
      ],
    })

    for (const [key, value] of [
      ['hypaV3Settings', { summarizationPrompt: 'attempted stale overwrite' }],
      ['supaMemoryKey', 'attempted stale key overwrite'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: '/api/v1/commands/settings/memory',
        headers: { 'risu-auth': assertion },
        payload: { baseRevision: revision, patch: { [key]: value } },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(`Unsupported memory setting: ${key}`)
    }

    const canonical = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          hypaV3Presets: [
            {
              id: 'canonical-memory',
              name: 'Canonical memory',
              settings: { summarizationModel: 'subModel', summarizationPrompt: 'updated canonical prompt' },
            },
          ],
        },
      },
    })
    expect(canonical.statusCode).toBe(200)
    expect(canonical.json().acknowledgedKeys).toEqual(['hypaV3Presets'])

    const memory = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/settings/memory',
      headers: { 'risu-auth': assertion },
    })
    expect(memory.statusCode).toBe(200)
    expect(memory.json().settings).not.toHaveProperty('hypaV3Settings')
    expect(memory.json().settings).not.toHaveProperty('supaMemoryKey')
    expect(loadPersistedFromDir(harness.dataDir).database).toMatchObject({
      hypaV3Settings: { summarizationPrompt: 'stale flat prompt' },
      supaMemoryKey: 'stale-flat-key',
      hypaV3Presets: [{ settings: { summarizationPrompt: 'updated canonical prompt' } }],
    })
  })

  it('rejects Hypa presets with client-only summary models', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, { hypaV3Presets: [] })

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/memory',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          selectedHypaV3PresetId: 'unsupported-gpu',
          hypaV3Presets: [
            {
              id: 'unsupported-gpu',
              name: 'Unsupported GPU preset',
              settings: { summarizationModel: 'Qwen3-4B-q4f32_1-MLC' },
            },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('hypaV3Presets[0].settings.summarizationModel must be subModel or memory')
    expect(JSON.stringify(loadPersistedFromDir(harness.dataDir).database)).not.toContain('Qwen3-4B-q4f32_1-MLC')
  })

  it('applies strict prompt settings with sparse normalized acknowledgements', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      outputImageModal: false,
      fallbackModels: {},
      fallbackWhenBlankResponse: false,
      doNotChangeFallbackModels: false,
    })
    const requestedFallbackModels = {
      model: ['fallback-main', '', 7],
      memory: ['fallback-memory'],
    }

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt',
      headers: { 'risu-auth': assertion },
      payload: {
        baseRevision: revision,
        patch: {
          outputImageModal: true,
          fallbackModels: requestedFallbackModels,
          fallbackWhenBlankResponse: true,
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      revision: 2,
      event: {
        type: 'settings.updated',
        revision: 2,
        resource: 'settings',
        id: 'prompt',
      },
      acknowledgedKeys: ['outputImageModal', 'fallbackModels', 'fallbackWhenBlankResponse'],
      settings: {
        fallbackModels: {
          model: ['fallback-main'],
          memory: ['fallback-memory'],
          emotion: [],
          translate: [],
          otherAx: [],
          scriptMain: [],
          scriptAux: [],
        },
      },
    })

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.resourceDatabase).toMatchObject({
      outputImageModal: true,
      fallbackModels: res.json().settings.fallbackModels,
      fallbackWhenBlankResponse: true,
      doNotChangeFallbackModels: false,
    })
  })

  it('rejects unknown setting keys without bumping revision', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      theme: 'dark',
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/display',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { openAIKey: 'wrong-group' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported display setting: openAIKey')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({ theme: 'dark' })
  })

  it('rejects retired Context Agent setting keys while preserving imported old-save data', async () => {
    const { assertion } = await setupAuthedClient(harness.app)
    const revision = await importDatabase(harness.app, assertion, {
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/advanced',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: revision, patch: { agentContextEnabled: false } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported advanced setting: agentContextEnabled')

    const bootstrap = await injectComposedResourceDatabase(harness.app, {
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { 'risu-auth': assertion },
    })
    expect(bootstrap.json().revision).toBe(1)
    expect(bootstrap.resourceDatabase).toMatchObject({
      agentContextEnabled: true,
      agentContextPrompt: 'legacy context prompt',
      agentContextMaxOutput: 999,
      agentContextMaxToolRounds: 2,
    })
  })

  it('rejects collection fields through the strict prompt settings group', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { promptTemplate: [] } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported prompt setting: promptTemplate')
  })

  it('rejects unsupported settings groups', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const res = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/prompt-template',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { mainPrompt: 'MAIN' } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Unsupported settings group: prompt-template')
  })

  it('keeps dedicated read-only settings groups command-owned', async () => {
    const { assertion } = await setupAuthedClient(harness.app)

    const agents = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/agents',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { agentPresets: [] } },
    })

    expect(agents.statusCode).toBe(400)
    expect(agents.json().error).toBe('Unsupported settings group: agents')

    const models = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/commands/settings/models',
      headers: { 'risu-auth': assertion },
      payload: { baseRevision: 0, patch: { modelProfiles: [] } },
    })

    expect(models.statusCode).toBe(400)
    expect(models.json().error).toBe('Unsupported settings group: models')
  })
})
